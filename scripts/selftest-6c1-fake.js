#!/usr/bin/env node
// Self-test of TEST-COPY-SPEC Part 6c-1, offline: the front proxy of a sandbox built from a database file. The web container is then on the
// internal network only (no route out, no port) and the `proxy` service (issue/sandbox-proxy.js, the same pinned WordPress image running a
// fixed Apache reverse-proxy config) is the only container with a route out. Checked here without a daemon (fake docker,
// scripts/fixtures/issue/fake-docker.js): the generated specification and config, every refusal of a forged one, the start order with the
// proxy, the port read from the proxy, a build without a dump keeping the old topology, the wording, and teardown when `mysqladmin shutdown`
// fails (directly and under SIGINT / SIGTERM). The real-container proof (no route out from the web container) is selftest-6c1-docker.js.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-6c1-'));
process.env.PLUGIN_GUARD_SANDBOXES = path.join(tmp, 'sbx-default');
process.env.PLUGIN_GUARD_ISSUES = path.join(tmp, 'issues');
fs.mkdirSync(process.env.PLUGIN_GUARD_SANDBOXES, { mode: 0o700 }); fs.mkdirSync(process.env.PLUGIN_GUARD_ISSUES, { mode: 0o700 });
const policy = require('../issue/sandbox-policy');
const proxy = require('../issue/sandbox-proxy');
const sandbox = require('../issue/sandbox');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const group = t => console.log(`\n== ${t}`);
const write = (root, rel, body) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); return f; };
const clone = o => JSON.parse(JSON.stringify(o));
const sleepMs = ms => new Promise(r => setTimeout(r, ms));
let seq = 0;
const newId = () => `iss-20261105-61${String(seq++).padStart(4, "0")}-${crypto.randomBytes(3).toString('hex')}`;

// ---- fixtures ----
const SITE = path.join(tmp, 'site');
write(SITE, 'wp-config.php', "<?php define('DB_NAME','x');");
write(SITE, 'wp-content/plugins/alpha/alpha.php', "<?php\n/* Plugin Name: Alpha */\n");
write(SITE, 'wp-content/themes/acme/style.css', '/* Theme Name: Acme */');
const TINY = fs.readFileSync(path.join(__dirname, 'fixtures', 'issue', 'dump', 'tiny.sql.txt'), 'utf8');
const SQL = write(tmp, 'in/site.sql', TINY);
const VX = path.join(__dirname, 'fixtures', 'issue', 'versions');
const MYSQL_DUMP = write(tmp, 'in/mysql.sql', fs.readFileSync(path.join(VX, 'mysqldump-8.0.46.head.sql.txt'), 'utf8').replace(/CREATE TABLE `wp_options`[\s\S]*?;\n/, '') + TINY.split('\n').filter(l => !/MariaDB dump/.test(l)).join('\n'));
// the shipped pins plus a pinned MySQL 8.0 entry (fake digest; the fake docker reports every image present)
const dg = c => `sha256:${c.repeat(64)}`;
const pins = clone(policy.images());
pins.matrix = { ...(pins.matrix || {}), db: { ...((pins.matrix || {}).db || {}), mysql: { repo: 'mysql', tag: '8.0.46', digest: dg('c'), ref: `mysql@${dg('c')}`, status: 'pinned', tag_verified: true, family: 'MySQL', version: '8.0.46' } } };
const PINS = write(tmp, 'pins/mysql.json', JSON.stringify(pins));

function fakeEnv(name, cfg = {}) {
    const dir = path.join(tmp, 'fake-' + name); fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(path.join(__dirname, 'fixtures', 'issue', 'fake-docker.js'), path.join(dir, 'docker')); fs.chmodSync(path.join(dir, 'docker'), 0o755);
    const sbx = path.join(tmp, 'sbx-' + name); fs.mkdirSync(sbx, { recursive: true, mode: 0o700 });
    const f = {
        dir, sandboxesRoot: sbx, pages: [],
        log: () => (fs.existsSync(path.join(dir, 'fake.log')) ? fs.readFileSync(path.join(dir, 'fake.log'), 'utf8').split('\n').filter(Boolean).map(JSON.parse) : []),
        state: () => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'fake.state.json'), 'utf8')); } catch { return { containers: [], volumes: [], networks: [] }; } },
        setCfg: c => fs.writeFileSync(path.join(dir, 'fake.json'), JSON.stringify(c)),
        jsonOpts: (extra = {}) => ({ dockerBin: path.join(dir, 'docker'), sandboxesRoot: sbx, root: SITE, env: { PATH: process.env.PATH, HOME: process.env.HOME }, ...extra })
    };
    f.opts = (extra = {}) => f.jsonOpts({ pageCheck: u => { f.pages.push(u); return { status: 200 }; }, ...extra });
    f.setCfg(cfg);
    return f;
}
const leftovers = f => { const s = f.state(); return s.containers.length + s.volumes.length + s.networks.length; };
const TABLES = 'Tables_in_wordpress\npgf_options\npgf_users\npgf_posts\npgf_usermeta\n';
const wpRules = (extra = []) => [...extra, { match: 'db query', stdin: 'SHOW TABLES', out: TABLES }, { match: 'db query', stdin: "option_name = 'siteurl'", out: 'option_value\nhttps://shop.example.com\n' }, { match: 'db query', stdin: "option_name = 'home'", out: 'option_value\nhttps://shop.example.com\n' }];
const sub = (l, s, svc) => l.args[0] === 'compose' && l.args[5] === s && (!svc || l.args.includes(svc));
const isImport = l => l.args.join(' ').includes('wp db import -');
const noDumpLeft = root => { let found = false; (function w(d) { let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory()) w(p); else if (e.name === 'dump.sql') found = true; } })(root); return !found; };

(async () => {
    // ================================================================ the generated specification
    group('specification with a database file: web container internal only, the proxy the only way in or out');
    const SB = path.join(tmp, 'sb');
    const CONF = path.join(SB, 'proxy', 'proxy.conf');
    const creds = { root: 'R', user: 'wp', pass: 'P', name: 'wordpress' };
    const base = { project: 'pgsb0a1b2c3d', issueId: 'iss-20261105-100000-abcdef', siteDir: path.join(SB, 'site'), logDir: path.join(SB, 'logs'), themes: ['acme'], hasLanguages: true, creds };
    const good = policy.buildSpec({ ...base, proxyConfFile: CONF });
    const conf = proxy.conf();
    const vopt = { sandboxDir: SB, proxyConf: conf, requireProxy: true };
    ok(policy.validateSpec(good, vopt).length === 0, `the proxied specification passes every check (${policy.validateSpec(good, vopt).join('; ') || 'no violation'})`);
    const w = good.services.wordpress, p = good.services.proxy;
    ok(JSON.stringify(w.networks) === '["back"]' && !('ports' in w) && good.networks.back.internal === true, 'wordpress: on the internal network "back" only, and no published port');
    ok(JSON.stringify(Object.keys(good.services)) === '["db","wordpress","cli","proxy"]' && JSON.stringify(good.services.db.networks) === '["back"]' && JSON.stringify(good.services.cli.networks) === '["back"]', 'db and cli are unchanged (internal only); one new service, proxy');
    ok(p.image === w.image && JSON.stringify(p.entrypoint) === JSON.stringify(['apache2', '-DFOREGROUND', '-f', '/etc/pg-proxy/proxy.conf']), 'proxy: exactly the wordpress image ref (no new image) and the fixed entrypoint');
    ok(JSON.stringify(p.cap_drop) === '["ALL"]' && JSON.stringify(p.cap_add) === '[]' && p.user === '33:33' && p.read_only === true && JSON.stringify(p.tmpfs) === '["/run/apache2:size=1m,mode=0700,uid=33,gid=33"]' && JSON.stringify(p.security_opt) === '["no-new-privileges:true"]', 'proxy: cap_drop ALL, cap_add [], user 33:33, read-only root file system, tmpfs only /run/apache2 (1 MB, 0700, 33:33), no-new-privileges');
    ok(JSON.stringify(p.dns) === '["192.0.2.1"]' && JSON.stringify(p.ports) === '["127.0.0.1::80"]' && JSON.stringify(p.networks) === '["back","front"]' && p.depends_on.wordpress.condition === 'service_started', 'proxy: dns 192.0.2.1, port 127.0.0.1::80, networks back + front, starts after wordpress');
    ok(p.mem_limit === '128m' && p.cpus === 0.5 && p.pids_limit === 128 && p.labels['pg.role'] === 'proxy' && p.labels['pg.sandbox'] === '1' && p.labels['pg.project'] === good.name && !('environment' in p) && !('command' in p), 'proxy: 128m, 0.5 CPU, 128 processes, labelled pg.role=proxy, no environment, no command');
    ok(JSON.stringify(p.volumes) === JSON.stringify([`${CONF}:/etc/pg-proxy/proxy.conf:ro`, 'proxyhtml:/var/www/html:ro']) && good.volumes.proxyhtml && good.volumes.proxyhtml.labels['pg.sandbox'] === '1' && good.volumes.proxyhtml.labels['pg.project'] === good.name, 'proxy: ONE read-only bind (the generated config) and an empty, labelled named volume at the image\'s declared VOLUME /var/www/html (no anonymous volume)');

    group('specification without a database file: exactly as before 6c-1');
    const plain = policy.buildSpec(base);
    ok(JSON.stringify(plain) === JSON.stringify(policy.buildSpec({ ...base, proxyConfFile: null })) && !plain.services.proxy && !plain.volumes.proxyhtml, 'no proxy service and no proxy volume');
    ok(JSON.stringify(plain.services.wordpress.networks) === '["back","front"]' && JSON.stringify(plain.services.wordpress.ports) === '["127.0.0.1::80"]' && policy.validateSpec(plain, { sandboxDir: SB }).length === 0, 'the web container keeps its normal network and its 127.0.0.1 port, and the spec still passes');
    const noProxyNeeded = policy.validateSpec(plain, { sandboxDir: SB, requireProxy: true });
    ok(noProxyNeeded.some(x => /must sit behind the front proxy/.test(x)), `a build that imports a database file without the proxy is refused (${noProxyNeeded[0]})`);

    group('a forged proxied specification is refused');
    const bad = (mut, re, msg, o = vopt) => { const s = clone(good); mut(s); const v = policy.validateSpec(s, o); ok(v.some(x => re.test(x)), `${msg} -> refused (${(v.find(x => re.test(x)) || 'NOT CAUGHT').slice(0, 110)})`); };
    bad(s => { s.services.wordpress.ports = ['127.0.0.1::80']; }, /wordpress: (only the proxy service may publish a port|behind the proxy the web container must publish no port)/, 'wordpress publishing a port next to the proxy');
    bad(s => { s.services.wordpress.networks = ['back', 'front']; }, /wordpress: only the proxy service may use a network with a route out/, 'wordpress on the network with a route out');
    bad(s => { s.networks.inner2 = { labels: s.networks.back.labels }; s.services.wordpress.networks = ['back', 'inner2']; }, /wordpress: (only the proxy service|behind the proxy the web container must be on internal networks only)/, 'wordpress on a second network that is not internal');
    bad(s => { s.services.cli.networks = ['front']; }, /cli: only the proxy service may use a network with a route out/, 'WP-CLI on the network with a route out');
    bad(s => { s.services.db.ports = ['127.0.0.1::3306']; }, /db: only the proxy service may publish a port/, 'the database publishing a port');
    bad(s => { s.services.proxy.cap_add = ['NET_BIND_SERVICE']; }, /capability NET_BIND_SERVICE|cap_add must be \[\]/, 'proxy with NET_BIND_SERVICE');
    bad(s => { s.services.proxy.cap_add = ['CHOWN']; }, /proxy: cap_add must be \[\]/, 'proxy with an allowed-elsewhere capability (CHOWN)');
    bad(s => { s.services.proxy.volumes.push(`${path.join(SB, 'site', 'wp-config.php')}:/x/wp-config.php:ro`); }, /exactly one bind mount/, 'a second proxy bind (inside the sandbox)');
    bad(s => { s.services.proxy.volumes.push('/var/run/docker.sock:/var/run/docker.sock'); }, /docker socket/i, 'docker.sock mounted into the proxy');
    bad(s => { s.services.proxy.network_mode = 'host'; }, /proxy: "network_mode" is not an allowed/, 'proxy on the host network');
    bad(s => { s.services.proxy.privileged = true; }, /proxy: .*privileged/, 'privileged proxy');
    bad(s => { s.services.proxy.volumes[0] = `${CONF}:/etc/pg-proxy/proxy.conf`; }, /one bind mount must be .*:ro/, 'the config bind writable (no :ro)');
    bad(s => { s.services.proxy.volumes[0] = `${path.join(SB, 'site', 'other.conf')}:/etc/pg-proxy/proxy.conf:ro`; }, /one bind mount must be/, 'a config from another place in the sandbox');
    bad(s => { s.services.proxy.volumes[0] = '/etc/apache2/apache2.conf:/etc/pg-proxy/proxy.conf:ro'; }, /outside the sandbox folder/, 'a config from outside the sandbox');
    bad(s => { s.services.proxy.volumes[1] = 'wpcore:/var/www/html:ro'; }, /only named volume allowed is "proxyhtml/, 'the site\'s core volume mounted into the proxy');
    bad(s => { delete s.volumes.proxyhtml.labels; }, /"proxyhtml" must carry the Plugin Guard labels/, 'the proxy volume without labels');
    bad(s => { s.services.wordpress.volumes.push('proxyhtml:/srv'); }, /wordpress may not mount it/, 'the proxy volume mounted by another service');
    bad(s => { s.services.proxy.image = 'httpd@' + dg('d'); }, /image must be exactly the wordpress image/, 'another image for the proxy (pinned, but not the wordpress ref)');
    bad(s => { s.services.proxy.image = 'wordpress:7.1.3-php8.3-apache'; }, /not pinned by digest/, 'the proxy image by tag');
    bad(s => { s.services.proxy.entrypoint = ['apache2', '-DFOREGROUND']; }, /entrypoint must be exactly/, 'another entrypoint (the image\'s own config)');
    bad(s => { s.services.proxy.entrypoint = ['sh', '-c', 'apache2 -DFOREGROUND -f /etc/pg-proxy/proxy.conf']; }, /entrypoint must be exactly/, 'a shell entrypoint');
    bad(s => { s.services.proxy.command = ['-DX']; }, /no command/, 'a command added to the proxy');
    bad(s => { s.services.proxy.environment = { A: 'b' }; }, /no environment/, 'environment for the proxy');
    bad(s => { s.services.proxy.user = '0:0'; }, /user must be 33:33/, 'proxy as root');
    bad(s => { delete s.services.proxy.user; }, /user must be 33:33/, 'proxy without a user');
    bad(s => { s.services.proxy.read_only = false; }, /read_only must be true/, 'a writable root file system');
    bad(s => { s.services.proxy.tmpfs.push('/tmp'); }, /tmpfs must be exactly/, 'a second tmpfs');
    bad(s => { s.services.proxy.tmpfs = ['/run/apache2:size=1g,mode=0777']; }, /tmpfs must be exactly/, 'a larger, world-writable tmpfs');
    bad(s => { s.services.proxy.ports = ['127.0.0.1:8080:80']; }, /must be exactly 127\.0\.0\.1::80/, 'a fixed host port for the proxy');
    bad(s => { s.services.proxy.ports = ['0.0.0.0::80']; }, /127\.0\.0\.1 only/, 'the proxy port on 0.0.0.0');
    bad(s => { s.services.proxy.dns = ['1.1.1.1']; }, /proxy: dns must point at an unroutable address/, 'the proxy with a real resolver');
    bad(s => { s.services.proxy.labels['pg.role'] = 'web'; }, /pg\.role must be "proxy"/, 'the proxy without its role label');
    bad(s => { s.services.proxy.networks = ['front']; }, /must be on the internal network "back"/, 'the proxy not on the internal network');
    bad(s => { s.services.proxy.healthcheck = { test: ['CMD', 'true'] }; }, /no healthcheck/, 'a healthcheck command for the proxy');
    bad(s => { s.services.proxy.mem_limit = '4g'; }, /mem_limit must be set and at most/, 'the proxy without a sane memory limit');
    bad(s => { delete s.services.wordpress; }, /no wordpress service/, 'a proxy with no wordpress behind it');
    // read_only and tmpfs are allowed for the proxy ONLY
    bad(s => { s.services.wordpress.read_only = true; }, /wordpress: "read_only" is not an allowed service setting/, 'read_only on the wordpress service');
    bad(s => { s.services.cli.tmpfs = ['/tmp']; }, /cli: "tmpfs" is not an allowed service setting/, 'tmpfs on the WP-CLI service');
    bad(s => { s.services.db.tmpfs = ['/var/lib/mysql']; }, /db: "tmpfs" is not an allowed service setting/, 'tmpfs on the database service');
    { const s = clone(plain); s.services.wordpress.tmpfs = ['/tmp']; ok(policy.validateSpec(s, { sandboxDir: SB }).some(x => /wordpress: "tmpfs" is not an allowed/.test(x)), 'tmpfs on wordpress in a build without a dump is still refused'); }
    // a service named proxy cannot widen the old topology
    { const s = clone(plain); s.services.proxy = clone(good.services.proxy); s.volumes.proxyhtml = clone(good.volumes.proxyhtml); const v = policy.validateSpec(s, vopt); ok(v.some(x => /wordpress: only the proxy service may use a network with a route out/.test(x)) && v.some(x => /wordpress: (only the proxy service may publish|behind the proxy the web container must publish no port)/.test(x)), 'adding a proxy next to a web container that still has its port and route out is refused'); }

    group('the generated proxy config, and refusals of a changed one');
    ok(conf === proxy.conf() && proxy.checkConf(conf).length === 0, 'the generated config passes checkConf and is the same on every call (deterministic)');
    const body = conf.split('\n').filter(l => l.trim() && !l.trim().startsWith('#')).join('\n');
    ok(/^ProxyRequests Off$/m.test(body) && /^ProxyPass "\/" "http:\/\/wordpress:80\/" retry=0 addressttl=5$/m.test(body) && /^ProxyPassReverse "\/" "http:\/\/wordpress:80\/"$/m.test(body) && /^ProxyPreserveHost On$/m.test(body), 'ProxyRequests Off; ProxyPreserveHost On; ProxyPass / -> http://wordpress:80/ (retry=0 addressttl=5); ProxyPassReverse');
    ok(JSON.stringify((body.match(/^LoadModule (\S+)_module/gm) || []).map(l => l.split(' ')[1].replace(/_module$/, ''))) === JSON.stringify(['mpm_event', 'authz_core', 'headers', 'reqtimeout', 'proxy', 'proxy_http']) && !/php|proxy_connect|AllowCONNECT|Include|DocumentRoot/i.test(body), 'exactly six modules (mpm_event, authz_core, headers, reqtimeout, proxy, proxy_http); no PHP, no CONNECT module, no Include, no DocumentRoot');
    ok(/^ErrorLog \/dev\/stderr$/m.test(body) && /^CustomLog \/dev\/stdout pg$/m.test(body) && /^Listen 80$/m.test(body) && /^PidFile \/run\/apache2\/proxy\.pid$/m.test(body), 'logs to stdout/stderr (nothing written to the read-only file system); listens on 80; pid file in the tmpfs');
    const badConf = (mut, re, msg) => { const t = mut(conf); const v = proxy.checkConf(t); const v2 = policy.validateSpec(good, { ...vopt, proxyConf: t }); ok(v.some(x => re.test(x)) && v2.some(x => re.test(x)), `${msg} -> refused (${(v.find(x => re.test(x)) || 'NOT CAUGHT').slice(0, 100)})`); };
    badConf(t => t.replace('ProxyRequests Off', 'ProxyRequests On'), /ProxyRequests Off" is required/, 'ProxyRequests On (a forward proxy)');
    badConf(t => t.replace('ProxyRequests Off\n', ''), /ProxyRequests Off" is required/, 'ProxyRequests line removed');
    badConf(t => t.replace('LoadModule proxy_http_module', 'LoadModule proxy_connect_module /usr/lib/apache2/modules/mod_proxy_connect.so\nLoadModule proxy_http_module'), /proxy_connect/, 'mod_proxy_connect loaded');
    badConf(t => t.replace('ProxyTimeout 120', 'ProxyTimeout 120\nAllowCONNECT 443'), /AllowCONNECT/, 'AllowCONNECT');
    badConf(t => t.replace('LoadModule headers_module', 'LoadModule php_module /usr/lib/apache2/modules/libphp.so\nLoadModule headers_module'), /no PHP/, 'the PHP module');
    badConf(t => t + 'AddHandler application/x-httpd-php .php\n', /no PHP|AddHandler/, 'a PHP handler');
    badConf(t => t + 'SetHandler server-status\n', /SetHandler/, 'a handler (server-status)');
    badConf(t => t.replace('http://wordpress:80/" retry=0', 'http://1.1.1.1/" retry=0'), /exactly one ProxyPass, from "\/" to http:\/\/wordpress:80\//, 'ProxyPass to a public address');
    badConf(t => t + 'ProxyPass "/x" "http://db:3306/"\n', /exactly one ProxyPass/, 'a second ProxyPass (to the database)');
    badConf(t => t.replace('ProxyPassReverse "/" "http://wordpress:80/"', 'ProxyPassReverse "/" "http://evil.example/"'), /must point at http:\/\/wordpress:80\//, 'ProxyPassReverse elsewhere');
    badConf(t => t + 'ProxyRemote * http://upstream.example:3128\n', /directive "ProxyRemote" is refused/, 'ProxyRemote (chaining to another proxy)');
    badConf(t => t + 'ProxyPassMatch "^/(.*)$" "http://1.1.1.1/$1"\n', /directive "ProxyPassMatch" is refused/, 'ProxyPassMatch');
    badConf(t => t + '<Proxy "*">\nRequire all granted\n</Proxy>\n', /directive "Proxy" is refused/, 'a <Proxy> section');
    badConf(t => t + 'Include /etc/apache2/apache2.conf\n', /directive "Include" is refused/, 'Include of the image\'s own config');
    badConf(t => t + 'DocumentRoot /var/www/html\n', /directive "DocumentRoot" is refused/, 'a DocumentRoot (serving files)');
    badConf(t => t.replace('Listen 80', 'Listen 0.0.0.0:8080'), /listens on port 80 only/, 'another Listen');
    badConf(t => t.replace('ServerTokens Prod', 'ServerTokens Full'), /not the configuration Plugin Guard generates/, 'any other change');
    ok(proxy.checkConf('').length === 1 && proxy.checkConf(null).length === 1, 'an empty or missing config is refused');
    // validateSpec reads the config from the bind source when no text is given
    fs.mkdirSync(path.dirname(CONF), { recursive: true }); fs.writeFileSync(CONF, conf);
    ok(policy.validateSpec(good, { sandboxDir: SB, requireProxy: true }).length === 0, 'without a text, validateSpec reads the config file the proxy mounts (inside the sandbox) and accepts the generated one');
    fs.writeFileSync(CONF, conf.replace('ProxyRequests Off', 'ProxyRequests On'));
    ok(policy.validateSpec(good, { sandboxDir: SB }).some(x => /ProxyRequests Off" is required/.test(x)), 'and refuses that file once it is changed');
    fs.rmSync(CONF); fs.symlinkSync(path.join(tmp, 'nowhere'), CONF);
    ok(policy.validateSpec(good, { sandboxDir: SB }).some(x => /could not be read to check it/.test(x)), 'a config that is a symbolic link or missing cannot be checked, so it is refused');
    fs.rmSync(CONF);
    ok(!/require\(['"](child_process|net|http|https|dns)['"]\)/.test(fs.readFileSync(path.join(__dirname, '..', 'issue', 'sandbox-proxy.js'), 'utf8')), 'sandbox-proxy.js is pure text: no process, network or DNS module');

    // ================================================================ the flow (fake docker)
    group('a build from a database file: proxy written, checked, port read from the proxy, both started after the anonymisation');
    const A = fakeEnv('order', { ports: ['127.0.0.1:38080', '127.0.0.1:38080'], wp: wpRules() });
    const h = sandbox.create(newId(), A.opts({ dump: SQL }));
    const L = A.log(), at = pred => L.findIndex(pred);
    const compose = JSON.parse(fs.readFileSync(h.composeFile, 'utf8'));
    const confFile = path.join(h.dir, 'proxy', 'proxy.conf');
    ok(compose.services.proxy && JSON.stringify(compose.services.wordpress.networks) === '["back"]' && !compose.services.wordpress.ports && compose.services.proxy.volumes[0] === `${confFile}:/etc/pg-proxy/proxy.conf:ro`, 'compose.json: the web container internal only, the proxy mounting <sandbox>/proxy/proxy.conf read-only');
    ok(fs.readFileSync(confFile, 'utf8') === proxy.conf() && (fs.statSync(confFile).mode & 0o777) === 0o644 && policy.validateSpec(compose, { sandboxDir: h.dir, requireProxy: true }).length === 0, 'the config file is the generated text (0644, read by www-data in the proxy) and the written compose.json passes validateSpec');
    const portCalls = L.filter(l => sub(l, 'port'));
    ok(portCalls.length === 2 && portCalls.every(l => l.args.slice(-2).join(' ') === 'proxy 80') && !L.some(l => sub(l, 'port', 'wordpress')), 'the port is read with `compose port proxy 80` (after up and after the start), never from the web container');
    const iStop = at(l => sub(l, 'stop')), iImp = at(isImport), iStart = at(l => sub(l, 'start')), iReady = at(l => sub(l, 'exec', 'proxy') && l.args.includes('php'));
    ok(L[iStop].args.slice(6).filter(a => !a.startsWith('-') && !/^\d+$/.test(a)).join() === 'wordpress' && iStop < iImp && iImp < iStart, 'only the web container is stopped for the import (the proxy keeps its port), and nothing starts before the anonymisation');
    ok(L[iStart].args.slice(6).join() === 'wordpress,proxy' && L.filter(l => sub(l, 'start')).length === 1, 'after the anonymisation ONE start brings up both wordpress and proxy');
    ok(L.slice(iImp, iStart).every(l => l.web_running === false), 'the web container was not running between the import and the start (unchanged 6a order)');
    ok(iReady > iStart && iReady < at(l => l.args.includes('search-replace')), 'after the start, a request through the proxy (from inside the proxy container) is waited for before the address is rewritten');
    ok(h.url === 'http://127.0.0.1:38080' && h.topology === 'proxied' && JSON.parse(fs.readFileSync(path.join(h.dir, 'state.json'), 'utf8')).topology === 'proxied' && h.steps.some(s => s.id === 'topology' && /no route out/.test(s.reason)), 'the handle and state.json say "proxied"; a topology step explains it');
    ok(h.limits === policy.LIMITS_PROXIED && A.pages.join() === 'http://127.0.0.1:38080', 'the handle carries the proxied limits; the front page is checked on the proxy address');
    const st = A.state();
    ok(st.containers.some(c => c.id.endsWith('-proxy')) && st.volumes.some(v => v.name.endsWith('_proxyhtml')), 'the fake shows the proxy container and its labelled volume while the sandbox is up');
    h.destroy();
    ok(leftovers(A) === 0 && !fs.existsSync(h.dir), 'destroy removes every container (proxy included), volume and network, and the folder');

    group('a build without a database file keeps the old topology');
    const N = fakeEnv('nodump', { wp: wpRules() });
    const hn = sandbox.create(newId(), N.opts());
    const NL = N.log(), cn = JSON.parse(fs.readFileSync(hn.composeFile, 'utf8'));
    ok(!cn.services.proxy && !cn.volumes.proxyhtml && JSON.stringify(cn.services.wordpress.ports) === '["127.0.0.1::80"]' && JSON.stringify(cn.services.wordpress.networks) === '["back","front"]' && !fs.existsSync(path.join(hn.dir, 'proxy')), 'no proxy, no proxy folder; the web container publishes 127.0.0.1::80 itself');
    ok(NL.filter(l => sub(l, 'port')).length === 1 && NL.filter(l => sub(l, 'port')).every(l => l.args.slice(-2).join(' ') === 'wordpress 80') && hn.topology === 'direct' && hn.limits === policy.LIMITS && !hn.steps.some(s => s.id === 'topology'), 'the port is read from wordpress; limits and steps are those of before');
    hn.destroy();

    group('a forged proxy config on disk stops the build before anything starts');
    {
        const F = fakeEnv('forged', { wp: wpRules() });
        const orig = proxy.conf;
        proxy.conf = () => orig().replace('ProxyRequests Off', 'ProxyRequests On');
        let err = null; try { sandbox.create(newId(), F.opts({ dump: SQL })); } catch (e) { err = e; } finally { proxy.conf = orig; }
        ok(err && /SandboxRefusal/.test(err.name) && /ProxyRequests Off/.test(err.message) && !F.log().some(l => sub(l, 'up')) && leftovers(F) === 0 && fs.readdirSync(F.sandboxesRoot).length === 0 && noDumpLeft(F.sandboxesRoot), `refused (${err ? err.message.split('\n')[1] : 'NOT refused'}); nothing was started and the folder and dump copy are gone`);
    }

    // ================================================================ teardown when mysqladmin shutdown fails
    group('teardown when `mysqladmin shutdown` fails: compose down, volumes and the dump copy are still removed');
    {
        const M = fakeEnv('mysql-fail', { wp: wpRules() });
        const hm = sandbox.create(newId(), M.opts({ dump: MYSQL_DUMP, pinFile: PINS }));
        const cm = JSON.parse(fs.readFileSync(hm.composeFile, 'utf8'));
        ok('MYSQL_ROOT_PASSWORD' in cm.services.db.environment && cm.services.proxy, 'control: a MySQL sandbox behind the proxy');
        fs.writeFileSync(path.join(hm.dir, 'db', 'dump.sql'), 'stand-in for a dump copy', { mode: 0o600 });
        M.setCfg({ wp: wpRules(), mysqladmin_fail: true });
        const n0 = M.log().length, rep = hm.destroy(), tail = M.log().slice(n0);
        const iShut = tail.findIndex(l => l.args.join(' ').includes('mysqladmin')), iDown = tail.findIndex(l => sub(l, 'down'));
        ok(rep.mysql_shutdown === false && iShut >= 0 && iDown > iShut && rep.compose_down === true, `the shutdown was tried and failed (mysql_shutdown=${rep.mysql_shutdown}); compose down -v still ran after it`);
        ok(leftovers(M) === 0 && rep.leftovers.length === 0 && !fs.existsSync(hm.dir) && noDumpLeft(M.sandboxesRoot), 'no container (proxy included), volume (database, core, proxy) or network is left; the folder and the dump copy are gone');
    }
    {
        // no compose file left (a crashed run): the label sweep removes the proxy too, and the failing shutdown does not stop it
        const S = fakeEnv('sweep', { mysqladmin_fail: true });
        const L2 = pr => ({ 'pg.sandbox': '1', 'pg.owner': 'plugin-guard', 'pg.project': pr, 'pg.issue': 'iss-20261105-000000-dead00' });
        fs.writeFileSync(path.join(S.dir, 'fake.state.json'), JSON.stringify({ containers: ['db', 'wordpress', 'cli', 'proxy'].map(r => ({ id: `c-pgsbdead0001-${r}`, labels: { ...L2('pgsbdead0001'), 'pg.role': r } })), volumes: ['dbdata', 'wpcore', 'proxyhtml'].map(v => ({ name: `pgsbdead0001_${v}`, labels: L2('pgsbdead0001') })), networks: ['back', 'front'].map(n => ({ id: `n-pgsbdead0001-${n}`, labels: L2('pgsbdead0001') })) }));
        const r = sandbox.sweep(S.jsonOpts());
        ok(r.removed.some(x => x.project === 'pgsbdead0001' && x.containers === 4 && x.volumes === 3) && leftovers(S) === 0, 'a leftover project with a proxy container: the label sweep removes all four containers, the three volumes and the networks');
    }
    const childRun = async sig => {
        const E = fakeEnv('int-' + sig, { mysqladmin_fail: true, wp: wpRules([{ match: 'db import', marker: 'importing', sleep_ms: 8000 }]) });
        const idc = newId();
        const script = `const sb=require(${JSON.stringify(path.join(__dirname, '..', 'issue', 'sandbox'))});sb.create(${JSON.stringify(idc)},${JSON.stringify(E.jsonOpts({ dump: MYSQL_DUMP, pinFile: PINS }))});setInterval(()=>{},1000);`;
        const c = spawn(process.execPath, ['-e', script], { stdio: 'ignore', detached: true, env: { ...process.env } });
        const done = new Promise(r => c.on('exit', (code, s) => r({ code, s })));
        for (let i = 0; i < 150 && !fs.existsSync(path.join(E.dir, 'importing')); i++) await sleepMs(100);
        const before = leftovers(E), copyThere = fs.existsSync(path.join(E.sandboxesRoot, idc, 'db', 'dump.sql'));
        const hadProxy = E.state().containers.some(x => x.id.endsWith('-proxy'));
        process.kill(-c.pid, sig);
        const r = await done;
        return { E, idc, r, before, copyThere, hadProxy };
    };
    for (const sig of ['SIGINT', 'SIGTERM']) {
        const x = await childRun(sig);
        const XL = x.E.log(), iShut = XL.findIndex(l => l.args.join(' ').includes('mysqladmin')), iDown = XL.findIndex(l => sub(l, 'down'));
        ok(x.before > 0 && x.copyThere && x.hadProxy, `${sig}: interrupted while importing into MySQL (${x.before} resources, the proxy among them, the dump copy present)`);
        ok(iShut >= 0 && iDown > iShut && leftovers(x.E) === 0 && !fs.existsSync(path.join(x.E.sandboxesRoot, x.idc)) && noDumpLeft(x.E.sandboxesRoot), `${sig}: mysqladmin shutdown failed, compose down still ran, and nothing is left (containers, volumes, networks, folder, dump copy; exit ${x.r.code ?? x.r.s})`);
    }

    // ================================================================ the notice in the report (sandbox-phase.js, sandbox-many.js)
    group('the report notice: NOTICE_DUMP for a build from a database file, NOTICE otherwise');
    {
        const store = require('../lib/issue-store');
        const probe = require('../issue/probe');
        const phase = require('../issue/sandbox-phase');
        const many = require('../issue/sandbox-many');
        const mkIssue = () => store.create({ title: 'Front page blank', description: 'white screen', symptom: 'white-screen', environment: 'local', url: 'http://localhost/', root: SITE, pages: ['/'] });
        const comps = { components: [{ kind: 'plugin', slug: 'alpha' }], top: [] };
        const realRun = probe.runSandbox;
        probe.runSandbox = async () => ({ ok: true, pages: [], status_codes: [200], oracle: { result: 'no' } });
        const noteOf = r => (r.steps.find(x => x.id === 'sandbox-notice') || {}).reason || '';
        try {
            const D = fakeEnv('notice-dump', { wp: wpRules([{ match: 'plugin list', out: 'alpha\n' }, { match: 'theme list', out: 'acme\n' }, { match: 'option get stylesheet', out: 'acme\n' }]) });
            const rd = await phase.run(mkIssue().id, { root: SITE, options: { sandbox: true, dump: SQL }, analysis: comps, sandboxOptions: D.opts() });
            const nd = noteOf(rd);
            ok(nd.startsWith(`NOTICE: ${policy.NOTICE_DUMP} `) && nd.includes(policy.RECOMMENDATION) && !nd.includes(policy.NOTICE), `issue mode, dump build: the notice step carries NOTICE_DUMP (${nd.slice(0, 70)}...)`);
            ok(!/personal data|anonymis/i.test(nd), 'and it makes no claim about personal data or anonymisation');
            const N2 = fakeEnv('notice-nodump', { wp: wpRules([{ match: 'plugin list', out: 'alpha\n' }, { match: 'theme list', out: 'acme\n' }, { match: 'option get stylesheet', out: 'acme\n' }]) });
            const rn = await phase.run(mkIssue().id, { root: SITE, options: { sandbox: true }, analysis: comps, sandboxOptions: N2.opts() });
            ok(noteOf(rn) === `NOTICE: ${policy.NOTICE} ${policy.RECOMMENDATION}`, 'issue mode, no dump: the notice step is NOTICE, unchanged');
            ok(leftovers(D) === 0 && leftovers(N2) === 0, 'both sandboxes were torn down');
            ok(typeof many.runMany === 'function' && /handle\.topology === 'proxied' \? policy\.NOTICE_DUMP : policy\.NOTICE/.test(fs.readFileSync(path.join(__dirname, '..', 'issue', 'sandbox-many.js'), 'utf8')) && /handle\.topology === 'proxied' \? policy\.NOTICE_DUMP : policy\.NOTICE/.test(fs.readFileSync(path.join(__dirname, '..', 'issue', 'sandbox-phase.js'), 'utf8')), 'guard:auto (sandbox-many.js) chooses the notice by the same rule (source check; sandbox-phase.js too)');
        } finally { probe.runSandbox = realRun; }
        ok(policy.NOTICE_DUMP === 'A database file was used for this test copy. It stays on this computer. The raw file copy is deleted right after the import, and the test copy is deleted when the test ends unless the sandbox was kept on request. With a database file the web container has no route out (raw IP connections, SMTP and host-name lookups failed in the test); a small front proxy running only a fixed reverse-proxy configuration is the only container with a route out.', 'NOTICE_DUMP is exactly the owner-approved text');
    }

    // ================================================================ golden: the no-dump specification frozen from d1a2185
    group('golden: the specification of a build without a database file is byte-identical to the one before 6c-1');
    {
        const GOLD = path.join(__dirname, 'fixtures', 'issue', 'golden', 'no-dump-spec.json');
        const gdg = c => `sha256:${c.repeat(64)}`;
        const gin = { project: 'pgsb0a1b2c3d', issueId: 'iss-20261105-100000-abcdef', siteDir: '/golden/sandboxes/iss-20261105-100000-abcdef/site', logDir: '/golden/sandboxes/iss-20261105-100000-abcdef/logs', themes: ['acme', 'twentytwentyfive'], hasLanguages: true, images: { images: { wordpress: { ref: `wordpress@${gdg('1')}` }, cli: { ref: `wordpress@${gdg('2')}` }, db: { ref: `mariadb@${gdg('3')}`, family: 'MariaDB' } } }, creds: { root: 'GoldenRootPass', user: 'wp', pass: 'GoldenUserPass', name: 'wordpress' } };
        const golden = fs.readFileSync(GOLD, 'utf8');
        const now = JSON.stringify(policy.buildSpec(gin), null, 2) + '\n';
        ok(now === golden, `the current buildSpec (no dump) equals the golden file generated from commit d1a2185, byte for byte (${golden.length} bytes)`);
        const changed = policy.buildSpec(gin); changed.services.wordpress.mem_limit = '769m';
        const reordered = policy.buildSpec(gin); const { ports, ...restW } = reordered.services.wordpress; reordered.services.wordpress = { ...restW, ports };
        ok(JSON.stringify(changed, null, 2) + '\n' !== golden && JSON.stringify(reordered, null, 2) + '\n' !== golden, 'negative control: one changed field, or one moved key, makes the comparison fail');
    }

    // ================================================================ wording
    group('what the reports say');
    ok(/Without a database file, the WordPress \(web\) container can still make RAW OUTBOUND connections/.test(policy.NOTICE) && /With a database file, the web container has no route out at all \(raw IP connections, SMTP and host-name lookups fail\)/.test(policy.NOTICE) && /front proxy is then the only container with a route out, and it runs only a fixed reverse-proxy configuration/.test(policy.NOTICE), 'NOTICE: without a database file the old limit stands; with one the web container has no route out and the proxy is the only container with one');
    ok(policy.LIMITS.length === 5 && /raw IP address is NOT blocked/.test(policy.LIMITS[1]), 'the limits of a build without a database file are the text of before');
    const LP = policy.LIMITS_PROXIED.join('\n');
    ok(/internal network only and has no route out: raw IP connections, SMTP and host-name lookups fail/.test(LP) && /front proxy is the only container with a route out/.test(LP) && /fixed reverse-proxy configuration/.test(LP) && /Site Health/.test(LP) && /loopback/.test(LP) && /mail\(\) function fails/.test(LP), 'the proxied limits: no route out (raw IP, SMTP, DNS), the proxy is the only way out with a fixed config, mail() fails, Site Health loopback fails');
    ok(!/[—]/.test(policy.NOTICE + LP), 'plain text (no long dashes)');

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(failures ? `\n${failures} FAILED` : '\nAll checks passed');
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
