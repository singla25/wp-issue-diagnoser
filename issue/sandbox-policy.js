// The sandbox is a throwaway copy of a site in Docker. This file is the single place that says WHAT a sandbox container is allowed to be:
// buildSpec() produces the Docker Compose project (as JSON, which Compose reads natively) and validateSpec() checks any spec against the
// safeguards. sandbox.js refuses to start a project that fails validateSpec(), so a future edit that weakens a container cannot slip through.
//
//   not privileged · no docker.sock · no host network/pid/ipc · cap_drop ALL (plus a short, tested allow-list added back so Apache and
//   MariaDB can start) · no-new-privileges · memory, CPU and process limits · ports bound to 127.0.0.1 only · images pinned by digest ·
//   random project name + labels · bind mounts only from inside the sandbox folder · no host environment passed through
//
// Network: the database and the WP-CLI container live on an INTERNAL network (no route out). Without a database file, the WordPress container
// is also on a normal network, because Docker cannot publish a port on an internal-only network. Its DNS is pointed at an unroutable address,
// so raw cURL / fsockopen to a HOST NAME fails too; a raw connection to an IP address is NOT blocked at the network level. See LIMITS.
// With a database file (TEST-COPY-SPEC 6c-1), the WordPress container is on the internal network ONLY, with no published port, and a front
// proxy (issue/sandbox-proxy.js: the same pinned WordPress image running a fixed Apache reverse-proxy config, as 33:33, no capability, read-only
// root file system) is the only container with a route out and the only one that publishes a port. See LIMITS_PROXIED.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const proxy = require('./sandbox-proxy');

const PIN_FILE = path.join(__dirname, '..', 'data', 'sandbox-images.json');
const PROJECT_RE = /^pgsb[0-9a-f]{8}$/;
const DIGEST_REF = /^[a-z0-9][a-z0-9._\/-]*@sha256:[0-9a-f]{64}$/;
// What Apache (www-data via setuid) and MariaDB (gosu) need to start after "drop everything". Anything outside this list is a violation.
const ALLOWED_CAPS = ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETGID', 'SETUID'];
const MAX = { mem_mb: 1024, cpus: 2, pids: 1024 };
const WP_UID = '33:33'; // www-data in the official images

// Shown in every sandbox report, first, in plain words.
const NOTICE = 'Without a database file, the WordPress (web) container can still make RAW OUTBOUND connections: code in the copied plugins or theme that opens its own socket to an IP address (cURL, fsockopen, file_get_contents on a URL with an IP) is not blocked, because Docker cannot publish a port on a network with no route out and a firewall inside the container would need extra privileges. WordPress\'s own HTTP API, host-name lookups and mail ARE blocked. With a database file, the web container has no route out at all (raw IP connections, SMTP and host-name lookups fail); a small front proxy is then the only container with a route out, and it runs only a fixed reverse-proxy configuration. The database and WP-CLI containers never have a route out.';
// Shown instead of NOTICE when the test copy was built from a database file (topology "proxied", TEST-COPY-SPEC 6c-1). Owner-approved text.
const NOTICE_DUMP = 'A database file was used for this test copy. It stays on this computer. The raw file copy is deleted right after the import, and the test copy is deleted when the test ends unless the sandbox was kept on request. With a database file the web container has no route out (raw IP connections, SMTP and host-name lookups failed in the test); a small front proxy running only a fixed reverse-proxy configuration is the only container with a route out.';
const RECOMMENDATION = 'Recommendation: run sandboxes only for copies of sites you own or are explicitly authorised to test, and whose plugin code you trust. Do not run a sandbox on untrusted or third-party code.';
const LIMITS = [
    'WP_HTTP_BLOCK_EXTERNAL and the pre_http_request filter stop WordPress\'s own HTTP API (wp_remote_get, wp_remote_post, ...). They do NOT stop code that opens its own connection: raw cURL, fsockopen, file_get_contents on a URL, exec/shell_exec.',
    'To cover that, the WordPress container\'s DNS points at an unroutable address, so such code fails when it uses a host name. A connection to a raw IP address is NOT blocked at the network level (Docker cannot publish a port on an internal-only network, and a firewall inside the container would need extra privileges).',
    'The database and WP-CLI containers are on an internal network with no route out at all.',
    'Mail is switched off by a must-use plugin (pre_wp_mail) and cron is disabled; code that talks SMTP itself, or sends mail with the PHP mail() function, is not intercepted (the image has no mail transport, so it fails).',
    'Payment gateways found in live mode stop the sandbox from starting unless you pass --neutralise-payments, which switches them off; API keys and webhook secrets in options are blanked, but keys stored anywhere else (a custom table, a file) are not found.'
];
// The limits of a test copy built from a database file: the web container sits behind the front proxy (TEST-COPY-SPEC 6c-1).
const LIMITS_PROXIED = [
    'WP_HTTP_BLOCK_EXTERNAL and the pre_http_request filter stop WordPress\'s own HTTP API (wp_remote_get, wp_remote_post, ...). They do NOT stop code that opens its own connection (raw cURL, fsockopen, file_get_contents on a URL, exec/shell_exec); in this test copy the network stops that instead (next line).',
    'The web container is on an internal network only and has no route out: raw IP connections, SMTP and host-name lookups fail. It publishes no port.',
    'A small front proxy is the only container with a route out. It is the same pinned WordPress image running only a fixed reverse-proxy configuration (no PHP, no files served, not usable as a forward proxy), as an unprivileged user with no extra rights and a read-only file system; it publishes the one port, on 127.0.0.1. The database and WP-CLI containers are on the internal network with no route out at all.',
    'Mail is switched off by a must-use plugin (pre_wp_mail) and cron is disabled; the PHP mail() function fails (the image has no mail transport) and SMTP cannot leave the web container.',
    'Site Health\'s loopback test (WordPress asking its own address) fails in the sandbox, as it does without a database file: the address belongs to this computer, not to the container.',
    'Payment gateways found in live mode stop the sandbox from starting unless you pass --neutralise-payments, which switches them off; API keys and webhook secrets in options are blanked, but keys stored anywhere else (a custom table, a file) are not found.'
];

function images(file = PIN_FILE) {
    const p = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const k of ['wordpress', 'cli', 'db']) if (!p.images[k] || !DIGEST_REF.test(p.images[k].ref)) throw Object.assign(new Error(`data/sandbox-images.json: image "${k}" is missing or not pinned by digest. Run: npm run guard:setup-sandbox -- --repin`), { exitCode: 2 });
    return p;
}
// An entry of the version matrix (data/sandbox-images.json "matrix") may be USED only when it is pinned: status "pinned", a sha256 digest, and a
// ref repo@<that digest>. Unpinned entries (no digest yet, tag not confirmed) are listed by guard:setup-sandbox but never started.
function usable(entry) {
    // tag_verified must be exactly true: --repin sets it when the registry resolved the tag; a missing field counts as NOT verified
    return !!(entry && entry.status === 'pinned' && entry.tag_verified === true && /^sha256:[0-9a-f]{64}$/.test(String(entry.digest || '')) && DIGEST_REF.test(String(entry.ref || '')) && entry.ref.endsWith(`@${entry.digest}`));
}
// the PHP minor an image entry itself records (its "php" field, else the php<x.y> in its tag); never taken from matrix.default_php
function phpOf(entry) {
    const v = entry && (entry.php || (/php(\d{1,2}\.\d{1,2})/.exec(String(entry.tag || '')) || [])[1]);
    return /^\d{1,2}\.\d{1,2}$/.test(String(v || '')) ? String(v) : null;
}
// -> { default_php, default_entry, default_db, php: { '8.2': { wordpress, cli } }, db: { mariadb, mysql } }. A pin file without a matrix (schema of
// before 6b) gives the three default images as the only entries, so every earlier flow keeps working unchanged. The default entry is always the
// "images" block (validated by images()); default_php is what that image records, so an edited or missing matrix.default_php changes nothing.
function matrix(pins = images()) {
    const m = pins.matrix || {};
    const defEntry = { wordpress: { ...pins.images.wordpress, status: 'pinned', tag_verified: true }, cli: { ...pins.images.cli, status: 'pinned', tag_verified: true } };
    const defPhp = phpOf(pins.images.wordpress);
    const php = {}, db = {};
    for (const [k, v] of Object.entries(m.php || {})) if (/^\d{1,2}\.\d{1,2}$/.test(k) && v && typeof v === 'object') php[k] = { wordpress: v.wordpress || null, cli: v.cli || null };
    if (defPhp && !php[defPhp]) php[defPhp] = defEntry;
    for (const [k, v] of Object.entries(m.db || {})) if (DB_FAMILIES[k] && v && typeof v === 'object') db[k] = { ...v, family: DB_FAMILIES[k] };
    const defDb = { ...pins.images.db, family: 'MariaDB', status: 'pinned', tag_verified: true, version: pins.images.db.version || (/^\d+\.\d+(?:\.\d+)?$/.test(String(pins.images.db.tag)) ? pins.images.db.tag : null) };
    if (!db.mariadb || !usable(db.mariadb)) db.mariadb = defDb;
    return { default_php: defPhp, default_entry: defEntry, default_db: 'mariadb', php, db };
}
const DB_FAMILIES = { mariadb: 'MariaDB', mysql: 'MySQL' };

const rand = (n = 24) => crypto.randomBytes(n).toString('base64url').replace(/[^A-Za-z0-9]/g, '').slice(0, n);
const newProject = () => `pgsb${crypto.randomBytes(4).toString('hex')}`;

// siteDir: the sandbox's own copy (…/sandboxes/<id>/site). Everything bind-mounted comes from inside it.
// The database service, per family. MariaDB is the default and is exactly what it was before Part 6b. MySQL (the official mysql image, 8.0):
//   - the same hardening and the SAME capability allow-list (ALLOWED_CAPS): its entrypoint, like MariaDB's, starts as root, fixes the owner of the
//     data folder (CHOWN, DAC_OVERRIDE, FOWNER) and drops to the mysql user with gosu (SETUID, SETGID). Nothing is added for MySQL;
//   - --default-authentication-plugin=mysql_native_password: MySQL 8.0 creates users with caching_sha2_password by default, and the MariaDB client in
//     the WP-CLI image (used by `wp db import` / `wp db query`) has no caching_sha2_password plugin (its plugin folder is empty), so it could not log
//     in. This server flag changes only how the throwaway users of THIS container store their password; no capability, no mount, no client change.
//     (Valid for 8.0; MySQL 8.4 removed it, and no 8.4 image is in the matrix.)
//   - healthcheck: `mysqladmin ping` over TCP to 127.0.0.1 (the image has no healthcheck.sh). It exits 0 once the server answers, even with
//     "access denied", so no password is needed in the check; TCP is refused during the entrypoint's first, socket-only start, so "healthy" means
//     the final server is up.
function dbService(family, ref, creds) {
    if (family === 'MySQL') return {
        environment: { MYSQL_ROOT_PASSWORD: creds.root, MYSQL_DATABASE: creds.name, MYSQL_USER: creds.user, MYSQL_PASSWORD: creds.pass },
        // --default-authentication-plugin was REMOVED in MySQL 8.4: the server would refuse to start. Only 8.0 is pinned (WANT_DB in
        // scripts/setup-sandbox.js); re-pinning to 8.4 or later needs a different fix (e.g. --mysql-native-password=ON plus
        // --authentication-policy=mysql_native_password). selftest-6b.js fails if the mysql pin is 8.4+ while this flag is still used.
        command: ['--skip-name-resolve', '--max-connections=50', '--default-authentication-plugin=mysql_native_password'],
        healthcheck: { test: ['CMD', 'mysqladmin', 'ping', '-h', '127.0.0.1', '--silent'], interval: '3s', timeout: '3s', retries: 60, start_period: '10s' }
    };
    if (family !== undefined && family !== null && family !== 'MariaDB') throw new Error(`database family "${family}" is not supported (MariaDB or MySQL)`);
    return {
        environment: { MARIADB_ROOT_PASSWORD: creds.root, MARIADB_DATABASE: creds.name, MARIADB_USER: creds.user, MARIADB_PASSWORD: creds.pass },
        command: ['--skip-name-resolve', '--max-connections=50'],
        healthcheck: { test: ['CMD', 'healthcheck.sh', '--connect', '--innodb_initialized'], interval: '3s', timeout: '3s', retries: 40, start_period: '5s' }
    };
}

// proxyConfFile (TEST-COPY-SPEC 6c-1): the host path of the generated proxy config (<sandbox>/proxy/proxy.conf). Given for every build that
// imports a database file: the web container then goes on the internal network only, without a port, behind the `proxy` service. Without it
// the specification is exactly what it was before.
function buildSpec({ project, issueId, siteDir, logDir, themes = [], images: pins = images(), hasLanguages = false, creds = { root: rand(), user: 'wp', pass: rand(), name: 'wordpress' }, proxyConfFile = null }) {
    if (!PROJECT_RE.test(project)) throw new Error(`project name "${project}" must be pgsb + 8 hex digits`);
    const dbv = dbService(pins.images.db.family, pins.images.db.ref, creds);
    const label = extra => ({ 'pg.sandbox': '1', 'pg.owner': 'plugin-guard', 'pg.project': project, 'pg.issue': String(issueId), ...extra });
    const hardened = { cap_drop: ['ALL'], security_opt: ['no-new-privileges:true'], restart: 'no', stop_grace_period: '5s' };
    const wpBinds = [
        `${path.join(siteDir, 'wp-config.php')}:/var/www/html/wp-config.php:ro`,
        `${path.join(siteDir, 'wp-content', 'plugins')}:/var/www/html/wp-content/plugins`,
        `${path.join(siteDir, 'wp-content', 'mu-plugins')}:/var/www/html/wp-content/mu-plugins`,
        `${path.join(siteDir, 'wp-content', 'uploads')}:/var/www/html/wp-content/uploads`,
        ...(hasLanguages ? [`${path.join(siteDir, 'wp-content', 'languages')}:/var/www/html/wp-content/languages`] : []),
        // themes one by one, so the default themes that ship in the image stay available for the theme swap
        ...themes.map(t => `${path.join(siteDir, 'wp-content', 'themes', t)}:/var/www/html/wp-content/themes/${t}`),
        `${logDir}:/var/log/pg`
    ];
    const spec = {
        name: project,
        services: {
            db: {
                image: pins.images.db.ref, ...hardened, cap_add: [...ALLOWED_CAPS],
                environment: dbv.environment,
                command: dbv.command,
                healthcheck: dbv.healthcheck,
                volumes: ['dbdata:/var/lib/mysql'], networks: ['back'],
                mem_limit: '512m', cpus: 1, pids_limit: 256, labels: label({ 'pg.role': 'db' })
            },
            wordpress: {
                image: pins.images.wordpress.ref, ...hardened, cap_add: [...ALLOWED_CAPS],
                environment: { WORDPRESS_DB_HOST: 'db:3306', WORDPRESS_DB_USER: creds.user, WORDPRESS_DB_PASSWORD: creds.pass, WORDPRESS_DB_NAME: creds.name },
                depends_on: { db: { condition: 'service_healthy' } },
                volumes: ['wpcore:/var/www/html', ...wpBinds],
                ports: ['127.0.0.1::80'], networks: ['back', 'front'], dns: ['192.0.2.1'],
                mem_limit: '768m', cpus: 1, pids_limit: 512, labels: label({ 'pg.role': 'wordpress' })
            },
            cli: {
                image: pins.images.cli.ref, ...hardened, cap_add: [],
                entrypoint: ['tail', '-f', '/dev/null'], user: WP_UID,
                environment: { WORDPRESS_DB_HOST: 'db:3306', WORDPRESS_DB_USER: creds.user, WORDPRESS_DB_PASSWORD: creds.pass, WORDPRESS_DB_NAME: creds.name },
                depends_on: { wordpress: { condition: 'service_started' } },
                volumes: ['wpcore:/var/www/html', ...wpBinds],
                networks: ['back'], mem_limit: '256m', cpus: 0.5, pids_limit: 128, labels: label({ 'pg.role': 'cli' })
            }
        },
        volumes: { dbdata: { labels: label({}) }, wpcore: { labels: label({}) } },
        networks: { back: { internal: true, labels: label({}) }, front: { labels: label({}) } }
    };
    if (proxyConfFile) {
        const w = spec.services.wordpress;
        w.networks = ['back'];   // internal only: no route out
        delete w.ports;          // nothing published by the web container
        spec.services.proxy = {
            image: w.image, ...hardened, cap_add: [],
            entrypoint: [...proxy.ENTRYPOINT], user: WP_UID, read_only: true, tmpfs: [proxy.TMPFS],
            depends_on: { wordpress: { condition: 'service_started' } },
            // the image declares VOLUME /var/www/html: an empty, labelled named volume there, so Docker creates no anonymous, unlabelled one
            volumes: [`${proxyConfFile}:${proxy.CONF_PATH}:ro`, 'proxyhtml:/var/www/html:ro'],
            ports: ['127.0.0.1::80'], networks: ['back', 'front'], dns: ['192.0.2.1'],
            mem_limit: '128m', cpus: 0.5, pids_limit: 128, labels: label({ 'pg.role': 'proxy' })
        };
        spec.volumes.proxyhtml = { labels: label({}) };
    }
    return spec;
}

// -> list of violations (empty = the spec satisfies every safeguard). Pure; no Docker needed.
// proxyConf: the text of the generated proxy config (when absent it is read from the proxy's bind source inside the sandbox folder);
// requireProxy: true for a build that imports a database file (the web container must then sit behind the proxy).
function validateSpec(spec, { sandboxDir, proxyConf, requireProxy = false } = {}) {
    const v = [], push = m => v.push(m);
    if (!spec || typeof spec !== 'object') return ['spec is not an object'];
    if (!PROJECT_RE.test(String(spec.name))) push(`project name "${spec.name}" is not pgsb + 8 hex digits (a random prefix is required)`);
    const text = JSON.stringify(spec);
    if (/docker\.sock|\/var\/run\/docker/i.test(text)) push('the Docker socket must never be mounted or referenced');
    if (/\$\{|\$\(/.test(text)) push('no variable interpolation: nothing may be pulled from the host environment');
    const nets = spec.networks || {};
    for (const [n, def] of Object.entries(nets)) if (def && (def.external || def.driver === 'host')) push(`network "${n}" is external or host`);
    const services = spec.services || {};
    if (!Object.keys(services).length) push('no services');
    const ALLOWED_SERVICE_KEYS = new Set(['image', 'cap_drop', 'cap_add', 'security_opt', 'restart', 'stop_grace_period', 'environment', 'command', 'entrypoint', 'user', 'healthcheck', 'volumes', 'networks', 'depends_on', 'ports', 'dns', 'mem_limit', 'cpus', 'pids_limit', 'labels']);
    const PROXY_ONLY_KEYS = new Set(['read_only', 'tmpfs']);   // allowed for the `proxy` service alone
    const hasProxy = Object.prototype.hasOwnProperty.call(services, 'proxy');
    const routeOut = hasProxy ? 'proxy' : 'wordpress';          // the one service that may use a network with a route out and publish a port
    if (requireProxy && !hasProxy) push('a database file is imported, so the web container must sit behind the front proxy: the "proxy" service is missing');
    for (const [name, s] of Object.entries(services)) {
        const at = m => push(`${name}: ${m}`);
        for (const k of Object.keys(s)) if (!ALLOWED_SERVICE_KEYS.has(k) && !(name === 'proxy' && PROXY_ONLY_KEYS.has(k))) at(`"${k}" is not an allowed service setting (privileged, network_mode, pid, ipc, devices, sysctls, ... are all refused)`);
        if (s.privileged) at('must not be privileged');
        if (!s.image || !DIGEST_REF.test(s.image)) at(`image "${s.image}" is not pinned by digest (repo@sha256:...)`);
        if (!Array.isArray(s.cap_drop) || !s.cap_drop.includes('ALL')) at('cap_drop must include ALL');
        for (const c of s.cap_add || []) if (!ALLOWED_CAPS.includes(c)) at(`capability ${c} is not in the allowed set (${ALLOWED_CAPS.join(', ')})`);
        // exactly this and nothing else: seccomp=unconfined, apparmor=unconfined, label=disable and the like would switch protections OFF
        if (!Array.isArray(s.security_opt) || s.security_opt.length !== 1 || s.security_opt[0] !== 'no-new-privileges:true') at('security_opt must be exactly ["no-new-privileges:true"]: no other option (seccomp=unconfined, apparmor=unconfined, label=disable, ...) is allowed');
        if (s.restart !== 'no') at('restart must be "no" (nothing keeps running after teardown)');
        const mem = String(s.mem_limit || ''), memMb = /^(\d+)m$/.test(mem) ? Number(mem.slice(0, -1)) : /^(\d+)g$/.test(mem) ? Number(mem.slice(0, -1)) * 1024 : NaN;
        if (!(memMb > 0 && memMb <= MAX.mem_mb)) at(`mem_limit must be set and at most ${MAX.mem_mb}m (got "${mem}")`);
        if (!(Number(s.cpus) > 0 && Number(s.cpus) <= MAX.cpus)) at(`cpus must be set and at most ${MAX.cpus} (got ${s.cpus})`);
        if (!(Number(s.pids_limit) > 0 && Number(s.pids_limit) <= MAX.pids)) at(`pids_limit must be set and at most ${MAX.pids} (got ${s.pids_limit})`);
        for (const p of s.ports || []) if (!/^127\.0\.0\.1:/.test(String(p))) at(`port "${p}" must be bound to 127.0.0.1 only`);
        const L = s.labels || {};
        if (L['pg.sandbox'] !== '1' || L['pg.owner'] !== 'plugin-guard' || L['pg.project'] !== spec.name || !L['pg.issue']) at('labels pg.sandbox, pg.owner, pg.project and pg.issue are required (teardown and the leftover sweep find containers by them)');
        for (const m of s.volumes || []) {
            const src = String(m).split(':')[0];
            if (src.startsWith('/') || src.startsWith('.') || src.startsWith('~')) {
                if (!sandboxDir) at(`bind mount "${m}": no sandbox folder given to check it against`);
                else { const real = path.resolve(src); if (real !== path.resolve(sandboxDir) && !real.startsWith(path.resolve(sandboxDir) + path.sep)) at(`bind mount source "${src}" is outside the sandbox folder`); }
            } else if (!(spec.volumes && spec.volumes[src])) at(`volume "${src}" is not a declared named volume`);
        }
        for (const [k, val] of Object.entries(s.environment || {})) if (val === null || val === undefined || typeof val !== 'string') at(`environment ${k} must be a literal string (a null value would be taken from the host)`);
        for (const n of s.networks || []) {
            if (!nets[n]) at(`network "${n}" is not declared`);
            else if (name !== routeOut && !nets[n].internal) at(`only the ${routeOut} service may use a network with a route out ("${n}" is not internal)`);
        }
        if ((name === 'wordpress' || name === 'proxy') && !(s.dns && s.dns.length && s.dns.every(d => /^192\.0\.2\./.test(d)))) at('dns must point at an unroutable address (192.0.2.0/24) so host-name lookups made by raw sockets fail');
    }
    for (const [name, s] of Object.entries(services)) if (name !== routeOut && (s.ports || []).length) push(`${name}: only the ${routeOut} service may publish a port`);
    if (hasProxy) for (const m of proxyViolations(spec, { sandboxDir, proxyConf })) push(m);
    return v;
}

// TEST-COPY-SPEC 6c-1: the front proxy and the web container behind it. Every rule here is in ADDITION to the general ones above.
function proxyViolations(spec, { sandboxDir, proxyConf } = {}) {
    const v = [], services = spec.services || {}, nets = spec.networks || {};
    const p = services.proxy || {}, w = services.wordpress, at = m => v.push(`proxy: ${m}`);
    if (!w) v.push('proxy: there is no wordpress service to pass requests to');
    else {
        if ((w.ports || []).length) v.push('wordpress: behind the proxy the web container must publish no port');
        if (!Array.isArray(w.networks) || !w.networks.length || w.networks.some(n => !nets[n] || !nets[n].internal)) v.push('wordpress: behind the proxy the web container must be on internal networks only (no route out)');
        if (p.image !== w.image) at(`image must be exactly the wordpress image (${w.image}); no other image is allowed for the proxy`);
    }
    if (JSON.stringify(p.entrypoint) !== JSON.stringify(proxy.ENTRYPOINT)) at(`entrypoint must be exactly ${JSON.stringify(proxy.ENTRYPOINT)}`);
    if ('command' in p) at('no command: the entrypoint is fixed');
    if ('environment' in p) at('no environment: the proxy gets no variables');
    if ('healthcheck' in p) at('no healthcheck setting');
    if (!Array.isArray(p.cap_add) || p.cap_add.length) at('cap_add must be [] (the proxy needs no capability)');
    if (p.user !== WP_UID) at(`user must be ${WP_UID} (www-data)`);
    if (p.read_only !== true) at('read_only must be true');
    if (!Array.isArray(p.tmpfs) || p.tmpfs.length !== 1 || p.tmpfs[0] !== proxy.TMPFS) at(`tmpfs must be exactly ["${proxy.TMPFS}"]`);
    if ((p.labels || {})['pg.role'] !== 'proxy') at('label pg.role must be "proxy"');
    if (!Array.isArray(p.networks) || !p.networks.includes('back')) at('must be on the internal network "back" to reach the web container');
    for (const port of p.ports || []) if (String(port) !== '127.0.0.1::80') at(`port "${port}" must be exactly 127.0.0.1::80`);
    const vols = Array.isArray(p.volumes) ? p.volumes.map(String) : [];
    const binds = vols.filter(m => /^[/.~]/.test(m)), named = vols.filter(m => !/^[/.~]/.test(m));
    const want = sandboxDir ? path.join(path.resolve(sandboxDir), 'proxy', 'proxy.conf') : null;
    if (binds.length !== 1) at(`exactly one bind mount is allowed, the config file (found ${binds.length})`);
    else if (!want || binds[0] !== `${want}:${proxy.CONF_PATH}:ro`) at(`the one bind mount must be "${want || '<sandbox>/proxy/proxy.conf'}:${proxy.CONF_PATH}:ro" (read-only)`);
    if (named.length > 1 || (named.length === 1 && named[0] !== 'proxyhtml:/var/www/html:ro')) at('the only named volume allowed is "proxyhtml:/var/www/html:ro" (an empty volume where the image declares one)');
    const pv = (spec.volumes || {}).proxyhtml;
    if (named.length === 1 && !(pv && pv.labels && pv.labels['pg.sandbox'] === '1' && pv.labels['pg.owner'] === 'plugin-guard' && pv.labels['pg.project'] === spec.name)) at('the volume "proxyhtml" must carry the Plugin Guard labels');
    for (const [n, s] of Object.entries(services)) if (n !== 'proxy' && (s.volumes || []).some(m => String(m).split(':')[0] === 'proxyhtml')) at(`the volume "proxyhtml" is the proxy's own; ${n} may not mount it`);
    let text = proxyConf;
    if (typeof text !== 'string' && want) { try { const st = fs.lstatSync(want); if (st.isFile()) text = fs.readFileSync(want, 'utf8'); } catch { /* reported below */ } }
    if (typeof text !== 'string') at('the proxy configuration could not be read to check it');
    else for (const m of proxy.checkConf(text)) v.push(`proxy: ${m}`);
    return v;
}

module.exports = { NOTICE, NOTICE_DUMP, RECOMMENDATION, buildSpec, validateSpec, proxyViolations, LIMITS_PROXIED, images, usable, phpOf, matrix, dbService, DB_FAMILIES, newProject, rand, ALLOWED_CAPS, MAX, LIMITS, PROJECT_RE, DIGEST_REF, WP_UID, PIN_FILE };
