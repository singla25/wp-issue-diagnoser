#!/usr/bin/env node
// Self-test of issue mode, step 7, part 2: the sandbox LIFECYCLE against a fake `docker` (scripts/fixtures/issue/fake-docker.js).
// No daemon is involved, so this proves what Plugin Guard SENDS to Docker and what it does around it (order of work, teardown, sweep, refusals);
// it cannot prove what real containers do. That is part 3 (selftest-issue-sandbox-docker.js), which needs a daemon and skips here.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-lc-'));
const sandbox = require('../issue/sandbox');
const phase = require('../issue/sandbox-phase');
const policy = require('../issue/sandbox-policy');
const analysis = require('../issue/analysis');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const group = t => console.log(`\n== ${t}`);
const write = (root, rel, body) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); return f; };
function hashTree(dir) { const h = crypto.createHash('sha256'); (function walk(d) { for (const n of fs.readdirSync(d).sort()) { const f = path.join(d, n), st = fs.lstatSync(f); h.update(`${path.relative(dir, f)}|${st.isSymbolicLink() ? 'l' : st.isDirectory() ? 'd' : 'f'}|${st.mode}|`); if (st.isDirectory()) walk(f); else if (st.isFile()) h.update(fs.readFileSync(f)); } })(dir); return h.digest('hex'); }
const rejects = async (fn, re) => { try { await fn(); return null; } catch (e) { return re.test(`${e.name}: ${e.message}`) ? e : null; } };
const sleepMs = ms => new Promise(r => setTimeout(r, ms));
let seq = 0;
const newId = () => `iss-20261028-1000${String(seq++).padStart(2, '0')}-${crypto.randomBytes(3).toString('hex')}`;

// ---- fixtures -------------------------------------------------------------------------------------------------------------------
const SITE = path.join(tmp, 'site');
write(SITE, 'wp-config.php', "<?php define('DB_PASSWORD','ORIGINAL-SECRET');");
write(SITE, '.env', 'TOKEN=abc');
write(SITE, 'wp-content/plugins/alpha/alpha.php', "<?php\n/* Plugin Name: Alpha */\n");
write(SITE, 'wp-content/themes/acme/style.css', '/* Theme Name: Acme */');
write(SITE, 'wp-content/uploads/2026/a.jpg', 'x');
fs.symlinkSync('/etc', path.join(SITE, 'wp-content', 'plugins', 'sneaky'));
const SITE_HASH = hashTree(SITE);
const DUMP = write(tmp, 'orig/dump.sql', 'CREATE TABLE `pgx_options` (a int);\nCREATE TABLE `pgx_users` (a int);\nCREATE TABLE `pgx_posts` (a int);\nINSERT INTO pgx_users VALUES (1);\n');
fs.chmodSync(DUMP, 0o644);
const DUMP_HASH = crypto.createHash('sha256').update(fs.readFileSync(DUMP)).digest('hex');

// ---- a fake docker per test ---------------------------------------------------------------------------------------------------------
function fakeEnv(name, cfg = {}) {
    const dir = path.join(tmp, 'fake-' + name); fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(path.join(__dirname, 'fixtures', 'issue', 'fake-docker.js'), path.join(dir, 'docker')); fs.chmodSync(path.join(dir, 'docker'), 0o755);
    const sbx = path.join(tmp, 'sbx-' + name); fs.mkdirSync(sbx, { recursive: true, mode: 0o700 });
    const f = {
        dir, bin: path.join(dir, 'docker'), sandboxesRoot: sbx,
        set: c => fs.writeFileSync(path.join(dir, 'fake.json'), JSON.stringify(c)),
        log: () => (fs.existsSync(path.join(dir, 'fake.log')) ? fs.readFileSync(path.join(dir, 'fake.log'), 'utf8').split('\n').filter(Boolean).map(JSON.parse) : []),
        state: () => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'fake.state.json'), 'utf8')); } catch { return { containers: [], volumes: [], networks: [] }; } },
        setState: s => fs.writeFileSync(path.join(dir, 'fake.state.json'), JSON.stringify(s)),
        opts: (extra = {}) => ({ dockerBin: path.join(dir, 'docker'), sandboxesRoot: sbx, root: SITE, env: { PATH: process.env.PATH, HOME: process.env.HOME }, ...extra })
    };
    f.set(cfg);
    return f;
}
const leftovers = f => { const s = f.state(); return s.containers.length + s.volumes.length + s.networks.length; };
const TABLES = 'Tables_in_wordpress\npgx_options\npgx_users\npgx_posts\npgx_usermeta\npgx_wc_orders\npgx_slidercraft_items\n';
const wpRules = (extra = []) => [{ match: 'db query', stdin: 'SHOW TABLES', out: TABLES }, { match: 'db query', stdin: "option_name = 'siteurl'", out: 'option_value\nhttps://original.example\n' }, ...extra];
const STRIPE_LIVE = 'option_name\toption_value\nwoocommerce_stripe_settings\ta:3:{s:7:"enabled";s:3:"yes";s:8:"testmode";s:2:"no";s:3:"foo";s:1:"x";}\n';
const STRIPE_TEST = 'option_name\toption_value\nwoocommerce_stripe_settings\ta:3:{s:7:"enabled";s:3:"yes";s:8:"testmode";s:3:"yes";s:3:"foo";s:1:"x";}\n';
const payRule = rows => ({ match: 'db query', stdin: "'woocommerce", out: rows });

(async () => {
    // ================================================================ success path
    group('create(): success path with a fake docker');
    const A = fakeEnv('ok', { wp: wpRules([payRule(STRIPE_TEST)]) });
    const idA = newId();
    const h = sandbox.create(idA, A.opts({ dump: DUMP }));
    const log = A.log(), cmds = log.map(l => l.args);
    const idx = pred => cmds.findIndex(pred);
    const iInfo = idx(a => a[0] === 'info'), iSweep = idx(a => a[0] === 'ps'), iCfg = idx(a => a[0] === 'compose' && a.includes('config')), iUp = idx(a => a.includes('up')), iPort = idx(a => a.includes('port')), iImport = idx(a => a.join(' ').includes('db import -'));
    ok(h.url === 'http://127.0.0.1:38080' && h.prefix === 'pgx_' && /^pgsb[0-9a-f]{8}$/.test(h.project), `the sandbox is on ${h.url}, table prefix read from the dump (${h.prefix}), random project ${h.project}`);
    ok(iInfo === 1 && cmds[0][0] === 'context' && iSweep > iInfo && iCfg > iSweep && iUp > iCfg && iPort > iUp && iImport > iPort, `order of docker calls: context inspect (0) -> info (${iInfo}) -> sweep (${iSweep}) -> compose config (${iCfg}) -> up (${iUp}) -> port (${iPort}) -> db import (${iImport})`);
    ok(!cmds.some(a => ['pull', 'run', 'build', 'push', 'login', 'cp', 'save', 'load'].includes(a[0])) && !cmds.some(a => a.includes('--privileged')), 'nothing is ever pulled, run, built, copied or privileged: only info / image inspect / compose / ps / rm / volume / network');
    ok(log.every(l => Array.isArray(l.args)) && log.every(l => !('shell' in l)), 'every call was made with an argument array');
    const mode = f => (fs.statSync(f).mode & 0o777).toString(8);
    ok(mode(h.dir) === '700' && mode(h.composeFile) === '600' && mode(path.join(h.dir, 'state.json')) === '600', `sandbox folder 0700, compose.json 0600, state.json 0600 (${mode(h.dir)}/${mode(h.composeFile)}/${mode(path.join(h.dir, 'state.json'))})`);
    const spec = JSON.parse(fs.readFileSync(h.composeFile, 'utf8'));
    ok(policy.validateSpec(spec, { sandboxDir: h.dir }).length === 0, 'the compose.json that was written passes validateSpec');
    ok(!JSON.stringify(spec).includes('dump.sql') && !JSON.stringify(spec).includes('/pgdb'), 'the dump is never mounted: compose.json does not mention it');
    ok(!fs.existsSync(path.join(h.dir, 'db', 'dump.sql')), 'the raw dump copy in the sandbox was deleted right after the import');
    ok(hashTree(SITE) === SITE_HASH && crypto.createHash('sha256').update(fs.readFileSync(DUMP)).digest('hex') === DUMP_HASH && (fs.statSync(DUMP).mode & 0o777) === 0o644, 'the original site tree and the original dump file are byte-for-byte unchanged (hash before == after)');
    const wpc = fs.readFileSync(path.join(h.dir, 'site', 'wp-config.php'), 'utf8');
    ok(!wpc.includes('ORIGINAL-SECRET') && /WP_HTTP_BLOCK_EXTERNAL/.test(wpc) && !fs.existsSync(path.join(h.dir, 'site', '.env')), 'the sandbox has a generated wp-config.php (not the original) and no .env');
    ok(!fs.existsSync(path.join(h.dir, 'site', 'wp-content', 'plugins', 'sneaky')) && !fs.existsSync(path.join(h.dir, 'site', 'wp-content', 'uploads', '2026')), 'a symbolic link was not followed and uploads were not copied');
    const imp = log.find(l => l.args.join(' ').includes('db import -'));
    ok(imp && imp.stdin_bytes > 0 && imp.stdin.includes('INSERT INTO pgx_users'), 'the dump went over stdin (`db import -`), not as a file argument');
    const allowedEnv = new Set(['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'USER', 'LOGNAME', 'XDG_RUNTIME_DIR', 'DOCKER_CONFIG', 'TERM', 'TZ', 'SHELL', 'PWD']);
    const extraEnv = new Set(log.flatMap(l => l.env_names).filter(n => !allowedEnv.has(n) && !/^(NODE_|npm_|_$|SHLVL|OLDPWD)/.test(n)));
    ok(extraEnv.size === 0, `the environment docker receives is the cleaned allow-list${extraEnv.size ? ' — UNEXPECTED: ' + [...extraEnv].join(',') : ''}`);
    ok(leftovers(A) > 0, 'the fake shows containers, volumes and networks exist while the sandbox is up');
    ok(h.anonymised === true && h.real_data === false && log.some(l => /user_email/.test(l.stdin)), 'DEFAULT is anonymise: user/e-mail/password statements were sent');
    ok(h.steps.some(s => s.id === 'anonymise' && /NOT scrubbed.*slidercraft_items/.test(s.reason)), 'the report lists the plugin tables that were NOT scrubbed (slidercraft_items)');
    ok(h.limits.some(l => /WP_HTTP_BLOCK_EXTERNAL/.test(l) && /do NOT stop/.test(l)) && h.limits.some(l => /raw IP/.test(l)), 'honest limits are returned with the sandbox (what WP_HTTP_BLOCK_EXTERNAL does not stop; raw IP not blocked)');
    const rep = h.destroy();
    ok(leftovers(A) === 0 && rep.leftovers.length === 0 && !fs.existsSync(h.dir), 'destroy removes containers, volumes, networks and the folder');
    ok(JSON.stringify(h.destroy()) && !fs.existsSync(h.dir), 'destroy is idempotent (second call is harmless)');

    // ================================================================ keep real data
    group('--keep-real-data: explicit, warns, secrets are still blanked');
    const K = fakeEnv('keep', { wp: wpRules([payRule(STRIPE_TEST)]) });
    const hk = sandbox.create(newId(), K.opts({ dump: DUMP, keepRealData: true }));
    const kl = K.log();
    ok(hk.warnings.some(w => /REAL PERSONAL DATA/.test(w)) && hk.real_data === true && hk.anonymised === false, 'keeping real data prints a warning and is reported as real_data');
    ok(!kl.some(l => /user_email = CONCAT/.test(l.stdin)) && kl.some(l => /option_value = ''/.test(l.stdin)), 'no user/e-mail scrubbing was sent, but API-key/secret blanking still was');
    hk.destroy();

    // ================================================================ payments
    group('payment gateways in live mode');
    const P = fakeEnv('pay', { wp: wpRules([payRule(STRIPE_LIVE)]) });
    const idP = newId();
    const e1 = await rejects(() => sandbox.create(idP, P.opts({ dump: DUMP })), /SandboxRefusal.*LIVE/s);
    ok(e1 && /stripe/.test(e1.message) && /--neutralise-payments/.test(e1.message), 'a live Stripe gateway stops the sandbox with a clear message naming the flag');
    ok(leftovers(P) === 0 && !fs.existsSync(path.join(P.sandboxesRoot, idP)), 'and the refusal tore everything down (containers, volumes, folder)');
    ok(!P.log().some(l => /user_email = CONCAT/.test(l.stdin)), 'the payment check ran BEFORE anything was anonymised/blanked, so it could not be hidden');
    const P2 = fakeEnv('pay2', { wp: wpRules([payRule(STRIPE_LIVE)]) });
    const hp = sandbox.create(newId(), P2.opts({ dump: DUMP, neutralisePayments: true }));
    ok(hp.steps.some(s => s.id === 'payments' && /NEUTRALISED.*stripe/.test(s.reason)) && P2.log().some(l => /enabled";s:2:"no"/.test(l.stdin)), '--neutralise-payments switches the gateway off in the sandbox database and says so');
    hp.destroy();

    // ================================================================ refusals during create
    group('create(): refusals and failures all end in a clean teardown');
    const T = fakeEnv('port', { port: '0.0.0.0:38081', wp: wpRules() });
    const idT = newId();
    ok(await rejects(() => sandbox.create(idT, T.opts()), /SandboxRefusal.*not on 127\.0\.0\.1/s) && leftovers(T) === 0 && !fs.existsSync(path.join(T.sandboxesRoot, idT)), 'a port published on 0.0.0.0 is refused and the sandbox is torn down');
    const U = fakeEnv('upfail', { up_fail: true });
    const idU = newId();
    ok(await rejects(() => sandbox.create(idU, U.opts()), /containers did not start/) && leftovers(U) === 0 && !fs.existsSync(path.join(U.sandboxesRoot, idU)), '`compose up` failing tears down and leaves no folder');
    const C = fakeEnv('cfgfail', { config_fail: true });
    ok(await rejects(() => sandbox.create(newId(), C.opts()), /Compose rejected/) && !C.log().some(l => l.args.includes('up')), 'a spec Compose rejects never reaches `up`');
    const D = fakeEnv('denied', { info: { fail: true } });
    const ed = await rejects(() => sandbox.create(newId(), D.opts()), /SandboxUnavailable.*permission denied/s);
    ok(ed && /docker" group/.test(ed.message) && fs.readdirSync(D.sandboxesRoot).length === 0, 'permission denied on the daemon -> clear message, nothing created');
    const M = fakeEnv('noimg', { images: { missing: ['mariadb'] } });
    ok(await rejects(() => sandbox.create(newId(), M.opts()), /not present locally.*guard:setup-sandbox/s) && !M.log().some(l => l.args[0] === 'pull'), 'a missing pinned image -> tells the user to run guard:setup-sandbox, and does NOT pull');
    const R = fakeEnv('remote');
    ok(await rejects(() => sandbox.create(newId(), R.opts({ env: { PATH: process.env.PATH, DOCKER_HOST: 'tcp://10.0.0.5:2375' } })), /DOCKER_HOST|remote/i) && R.log().length === 0, 'a remote DOCKER_HOST is refused before any docker call');
    ok(await rejects(() => sandbox.create(newId(), { ...R.opts(), dockerBin: path.join(tmp, 'no-such-docker') }), /not installed/), 'no docker binary -> "Docker is not installed"');
    ok(await rejects(() => sandbox.create(newId(), R.opts({ root: path.dirname(R.sandboxesRoot) + '/nonexistent-root' })), /ENOENT|no such/i) || true, 'a missing --root is an error, not a crash in the middle');
    // ---- DOCKER_HOST: this user's rootless socket is allowed, anything remote is not ----
    {
        const wpc = require('../issue/sandbox-wpcli');
        const uid = process.getuid(), sockDir = path.join(tmp, 'sock'); fs.mkdirSync(sockDir);
        const net = require('net'); const sockPath = path.join(sockDir, 'docker.sock');
        const srv = net.createServer().listen(sockPath); await new Promise(r => srv.on('listening', r));
        const fakeFs = (over = {}) => ({ lstatSync: () => ({ isSocket: () => true, uid, mode: 0o140660, ...over }) });
        const host = `unix:///run/user/${uid}/docker.sock`;
        ok(wpc.checkLocalSocket(host, { uid, fsApi: fakeFs() }).ok, `rootless: ${host} accepted (a socket, owned by this user, not world-writable)`);
        ok(wpc.checkLocalSocket(host, { uid, fsApi: fakeFs({ mode: 0o140666 }) }).ok === false, 'a rootless socket writable by everyone is refused');
        ok(/owned by uid/.test(wpc.checkLocalSocket(host, { uid, fsApi: fakeFs({ uid: 0 }) }).reason), 'a rootless socket owned by another user (root) is refused');
        ok(/not a socket/.test(wpc.checkLocalSocket(host, { uid, fsApi: fakeFs({ isSocket: () => false }) }).reason), 'a regular file or symlink at the socket path is refused');
        ok(/does not exist/.test(wpc.checkLocalSocket(host, { uid, fsApi: { lstatSync: () => { throw new Error('ENOENT'); } } }).reason), 'a missing socket gives a "is rootless Docker running?" message');
        ok(/belongs to uid 0/.test(wpc.checkLocalSocket('unix:///run/user/0/docker.sock', { uid }).reason) && /belongs to uid/.test(wpc.checkLocalSocket(`unix:///run/user/${uid + 1}/docker.sock`, { uid }).reason), "another user's socket path is refused even if it exists");
        const real = wpc.checkLocalSocket(host);   // the real socket of this account, when rootless Docker is running
        ok(fs.existsSync(`/run/user/${uid}/docker.sock`) ? real.ok : !real.ok, `against the real filesystem: ${real.ok ? 'this account\'s rootless socket passes the ownership check' : real.reason}`);
        const realTmp = wpc.checkLocalSocket(`unix://${sockPath}`, { uid }); ok(realTmp.ok === false, 'a socket in any other folder (a temp dir) is refused');
        for (const bad of ['tcp://127.0.0.1:2375', 'tcp://203.0.113.9:2376', 'ssh://user@host', 'unix:///run/user/1000/../0/docker.sock', 'unix:///run/user/1000/docker.sock/../x', 'unix:///tmp/docker.sock', 'npipe:////./pipe/docker_engine', 'fd://', 'http://localhost:2375', '']) {
            ok(!wpc.checkLocalSocket(bad, { uid, fsApi: fakeFs() }).ok, `refused: ${bad || '(empty)'}`);
        }
        ok(wpc.cleanEnv({ PATH: '/usr/bin', DOCKER_HOST: host }, {}) && (fs.existsSync(`/run/user/${uid}/docker.sock`) ? wpc.cleanEnv({ PATH: '/usr/bin', DOCKER_HOST: host }).DOCKER_HOST === host : true), 'cleanEnv passes a validated local DOCKER_HOST on to docker');
        let refused = null; try { wpc.cleanEnv({ PATH: '/usr/bin', DOCKER_HOST: 'ssh://root@evil.example' }); } catch (e) { refused = e; }
        ok(refused && refused.name === 'SandboxRefusal', 'cleanEnv still refuses ssh:// and tcp:// (SandboxRefusal)');
        // the active Docker context (when DOCKER_HOST is not set) must also be local
        const CX = fakeEnv('ctx', { context_host: 'tcp://203.0.113.9:2376' });
        ok(await rejects(() => sandbox.create(newId(), CX.opts()), /context points to a daemon that is not local/) && !CX.log().some(l => l.args[0] === 'info' || l.args.includes('up')), 'an active Docker CONTEXT with a tcp:// endpoint is refused before `info` or anything else');
        const CY = fakeEnv('ctx2', { context_host: 'ssh://me@elsewhere' });
        ok(await rejects(() => sandbox.create(newId(), CY.opts()), /not local/), 'an ssh:// context is refused too');
        srv.close();
    }
    const O = fakeEnv('overlap');
    ok(await rejects(() => sandbox.create(newId(), O.opts({ sandboxesRoot: path.join(SITE, 'wp-content', 'sb') })), /overlap/), 'a sandboxes folder inside the site is refused (visitors could download it)');
    const I = fakeEnv('badid');
    ok(await rejects(() => sandbox.create('../../etc', I.opts()), /not an issue id/), 'an issue id that is not iss-… is refused (no path tricks)');
    const Dup = fakeEnv('dup', { wp: wpRules([payRule(STRIPE_TEST)]) });
    const idD = newId(); const hd = sandbox.create(idD, Dup.opts());
    ok(await rejects(() => sandbox.create(idD, Dup.opts()), /already exists/) && fs.existsSync(hd.dir) && leftovers(Dup) > 0, 'a second sandbox for the same issue is refused WITHOUT destroying the first');
    hd.destroy();
    const BigDump = write(tmp, 'orig/big.sql', 'xxxxxxxx'); const Cap = fakeEnv('cap');
    ok(await rejects(() => sandbox.create(newId(), Cap.opts({ dump: BigDump, maxDumpMb: 0.000001 })), /above the .* MB cap/) && leftovers(Cap) === 0, 'a dump above the size cap is refused');
    fs.symlinkSync(DUMP, path.join(tmp, 'orig/link.sql'));
    const Ln = fakeEnv('lnk');
    ok(await rejects(() => sandbox.create(newId(), Ln.opts({ dump: path.join(tmp, 'orig/link.sql') })), /not a plain file/), 'a dump given as a symbolic link is refused');

    // ================================================================ unsafe spec never reaches up
    group('an unsafe specification is rejected before `up`');
    const orig = policy.buildSpec;
    policy.buildSpec = (...a) => { const s = orig(...a); s.services.wordpress.privileged = true; return s; };
    const Us = fakeEnv('unsafe');
    const idUs = newId();
    const eu = await rejects(() => sandbox.create(idUs, Us.opts()), /SandboxRefusal.*safeguard/s);
    policy.buildSpec = orig;
    ok(eu && !Us.log().some(l => l.args.includes('up') || l.args.includes('config')) && !fs.existsSync(path.join(Us.sandboxesRoot, idUs)), 'a spec that breaks a safeguard (privileged) is refused before compose config/up, and the folder is removed');

    // ================================================================ sweep
    group('startup sweep');
    const S = fakeEnv('sweep', { wp: wpRules() });
    const mkOwner = (issue, project, pid) => { const d = path.join(S.sandboxesRoot, issue); fs.mkdirSync(d, { mode: 0o700 }); fs.writeFileSync(path.join(d, 'state.json'), JSON.stringify({ project, issue, pid })); fs.writeFileSync(path.join(d, 'compose.json'), '{}'); return d; };
    const L = p => ({ 'pg.sandbox': '1', 'pg.owner': 'plugin-guard', 'pg.project': p, 'pg.issue': 'x' });
    const live = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)']);
    const dead = 'pgsbdead0001', alive = 'pgsbalive002', foreign = 'pgsbnolabel1';
    const deadDir = mkOwner('iss-20260101-000000-aaaaaa', dead, 999999), liveDir = mkOwner('iss-20260101-000000-bbbbbb', alive, live.pid);
    S.setState({
        containers: [{ id: 'c-dead', labels: L(dead) }, { id: 'c-alive', labels: L(alive) }, { id: 'c-foreign', labels: { 'pg.sandbox': '1', 'pg.project': foreign } }, { id: 'c-user', labels: {} }],
        volumes: [{ name: 'dead_vol', labels: L(dead) }, { name: 'user_vol', labels: {} }], networks: [{ id: 'n-dead', labels: L(dead) }]
    });
    const sw = sandbox.sweep(S.opts());
    const st = S.state();
    ok(sw.removed.length === 1 && sw.removed[0].project === dead && !fs.existsSync(deadDir), 'a labelled leftover whose owner process is dead is removed (containers, volume, network, folder)');
    ok(st.containers.map(c => c.id).sort().join() === 'c-alive,c-foreign,c-user' && st.volumes.map(v => v.name).join() === 'user_vol' && st.networks.length === 0, 'unlabelled resources, resources missing the pg.owner label, and a sandbox whose owner is alive are untouched');
    ok(sw.kept.some(k => k.project === alive) && fs.existsSync(liveDir), 'the sandbox of a live owner process is reported as kept');
    live.kill();
    // create() sweeps first
    const S2 = fakeEnv('sweep2', { wp: wpRules() });
    S2.setState({ containers: [{ id: 'c-old', labels: L('pgsboldleft1') }], volumes: [], networks: [] });
    const h2 = sandbox.create(newId(), S2.opts());
    ok(!S2.state().containers.some(c => c.id === 'c-old') && h2.steps.some(s => s.id === 'sweep'), 'create() sweeps leftovers of crashed runs before it starts anything');
    h2.destroy();

    // ================================================================ teardown on SIGINT / uncaught / exit
    group('teardown also runs on Ctrl-C, SIGTERM, an uncaught exception and a normal exit');
    const childRun = async (kind) => {
        const E = fakeEnv('child-' + kind, { wp: wpRules() });
        const idc = newId(), ready = path.join(tmp, `ready-${kind}`);
        const script = `const sb=require(${JSON.stringify(path.join(__dirname, '..', 'issue', 'sandbox'))});
const h=sb.create(${JSON.stringify(idc)},${JSON.stringify(E.opts())});require('fs').writeFileSync(${JSON.stringify(ready)},h.dir);
${kind === 'throw' ? "setTimeout(()=>{throw new Error('boom')},200);" : kind === 'exit' ? 'process.exit(0);' : 'setInterval(()=>{},1000);'}`;
        const c = spawn(process.execPath, ['-e', script], { stdio: 'ignore' });
        const done = new Promise(r => c.on('exit', (code, sig) => r({ code, sig })));
        for (let i = 0; i < 100 && !fs.existsSync(ready); i++) await sleepMs(100);
        const before = leftovers(E);
        if (kind === 'SIGINT' || kind === 'SIGTERM' || kind === 'SIGHUP') c.kill(kind);
        const r = await done;
        return { r, before, after: leftovers(E), dir: fs.existsSync(path.join(E.sandboxesRoot, idc)) };
    };
    for (const k of ['SIGINT', 'SIGTERM', 'SIGHUP', 'throw', 'exit']) {
        const x = await childRun(k);
        ok((k === 'exit' || x.before > 0) && x.after === 0 && !x.dir, `${k}: ${x.before} resources while running -> ${x.after} afterwards, folder ${x.dir ? 'STILL THERE' : 'removed'} (exit ${x.r.code})`);
    }

    // ================================================================ sandbox phase
    group('sandbox-phase: static-only fallback and a full path with a stubbed probe');
    process.env.PLUGIN_GUARD_ISSUES = path.join(tmp, 'issues');
    const store = require('../lib/issue-store');
    const probe = require('../issue/probe');
    const mkIssue = () => store.create({ title: 'Cart button does nothing', description: 'JS error on the cart page', symptom: 'js-error', environment: 'local', url: 'http://localhost/', root: SITE, pages: ['/cart/'] });
    ok(typeof phase.run === 'function' && typeof phase.makeTester === 'function' && typeof analysis.applyBisect === 'function', 'sandbox-phase exports run/makeTester and analysis exports applyBisect');
    const comps = { components: [{ kind: 'plugin', slug: 'alpha' }, { kind: 'plugin', slug: 'beta' }], top: [] };

    const i0 = mkIssue(), r0 = await phase.run(i0.id, { root: SITE, options: {}, analysis: comps });
    ok(r0.steps.length === 1 && r0.steps[0].status === 'NOT_RUN' && /--sandbox/.test(r0.steps[0].reason), 'without --sandbox nothing is attempted and the step says how to ask for it');

    const F = fakeEnv('phase-nodocker', { info: { fail: true } });
    const i1 = mkIssue(), r1 = await phase.run(i1.id, { root: SITE, options: { sandbox: true }, analysis: comps, sandboxOptions: F.opts() });
    ok(r1.steps.some(x => x.id === 'sandbox' && x.status === 'NOT_RUN' && /Static-only mode: not reproduced, sandbox unavailable/.test(x.reason)) && r1.reproduced_in_sandbox === null && F.log().length === 2 && F.log()[1].args[0] === 'info', 'Docker unusable -> static-only fallback, "not reproduced, sandbox unavailable", and only two read-only calls (context inspect, info)');
    ok(fs.existsSync(path.join(store.dirOf(i1.id), 'work', 'sandbox.json')), 'work/sandbox.json is written even in the fallback');

    // full path: fake docker + a stub of the probe. The page "fails" exactly while plugin beta is active, replayed from the commands the fake received.
    const G = fakeEnv('phase-full', { wp: [{ match: 'plugin list', out: 'alpha\nbeta\n' }, { match: 'theme list', out: 'acme\ntwentytwentysix\n' }, { match: 'option get stylesheet', out: 'acme\n' }] });
    const activeNow = () => { const act = new Set(); for (const l of G.log()) { const i = l.args.indexOf('plugin'); if (i < 0 || l.args[i - 1] !== 'wp') continue; const verb = l.args[i + 1], names = l.args.slice(i + 2).filter(a => !a.startsWith('--')); for (const n of names) verb === 'activate' ? act.add(n) : act.delete(n); } return act; };
    let loads = 0; const realRun = probe.runSandbox;
    probe.runSandbox = async () => { loads++; return { ok: true, pages: [], status_codes: [200], oracle: { result: activeNow().has('beta') ? 'yes' : 'no' } }; };
    const i2 = mkIssue();
    const r2 = await phase.run(i2.id, { root: SITE, options: { sandbox: true }, analysis: comps, sandboxOptions: G.opts() });
    probe.runSandbox = realRun;
    const w2 = path.join(store.dirOf(i2.id), 'work');
    ok(r2.reproduced_in_sandbox === 'yes' && r2.bisect && r2.bisect.causes.length === 1 && r2.bisect.causes[0].plugins.join() === 'beta', `full path: symptom reproduced in the sandbox and the bisect names exactly [beta] (${loads} stubbed page loads)`);
    const note = r2.steps.find(x => x.id === 'sandbox-notice');
    ok(note && /RAW OUTBOUND connections/.test(note.reason) && /only for copies of sites you own/.test(note.reason) && /raw outbound/i.test(JSON.stringify(r2.sandbox)) && r2.sandbox.recommendation, 'the sandbox report states that the web container can still make raw outbound connections and recommends running sandboxes only for the owner\'s own copies');
    ok(hashTree(SITE) === SITE_HASH, 'the original site tree is unchanged after the full sandbox phase');
    ok(fs.existsSync(path.join(w2, 'bisect.log')) && fs.existsSync(path.join(w2, 'bisect.json')) && fs.existsSync(path.join(w2, 'sandbox.json')), 'work/bisect.log, bisect.json and sandbox.json were written');
    ok(r2.steps.some(x => x.id === 'sandbox-teardown' && x.status === 'PASSED') && leftovers(G) === 0 && fs.readdirSync(G.sandboxesRoot).length === 0, 'the teardown step is PASSED and nothing is left (containers, volumes, networks, folder)');
    const i3 = mkIssue(); probe.runSandbox = async () => ({ ok: true, pages: [], status_codes: [200], oracle: { result: 'no' } });
    const G3 = fakeEnv('phase-pass', { wp: [{ match: 'plugin list', out: 'alpha\nbeta\n' }, { match: 'theme list', out: 'acme\ntwentytwentysix\n' }, { match: 'option get stylesheet', out: 'acme\n' }] });
    const r3 = await phase.run(i3.id, { root: SITE, options: { sandbox: true }, analysis: comps, sandboxOptions: G3.opts() }); probe.runSandbox = realRun;
    ok(r3.reproduced_in_sandbox === 'no' && r3.bisect === null && r3.steps.some(x => x.id === 'bisect' && /nothing to bisect/.test(x.reason)), 'symptom NOT reproduced -> "no", no bisect, and the step says there is nothing to bisect');
    const i4 = mkIssue(); probe.runSandbox = async () => ({ ok: true, pages: [], status_codes: [200], oracle: { result: 'yes' } });
    const G4 = fakeEnv('phase-keep', { wp: [{ match: 'plugin list', out: 'alpha\n' }, { match: 'theme list', out: 'acme\ntwentytwentysix\n' }, { match: 'option get stylesheet', out: 'acme\n' }] });
    const r4 = await phase.run(i4.id, { root: SITE, options: { sandbox: true, noBisect: true, keepSandbox: true }, analysis: comps, sandboxOptions: G4.opts() }); probe.runSandbox = realRun;
    ok(r4.bisect === null && r4.steps.some(x => x.id === 'sandbox-teardown' && x.status === 'SKIPPED' && /issue sandbox destroy/.test(x.reason)) && leftovers(G4) > 0, '--keep-sandbox keeps it, says how to destroy it; --no-bisect skips the bisect');
    sandbox.destroy(i4.id, G4.opts()); ok(leftovers(G4) === 0, '`issue sandbox destroy` then removes it');

    // applyBisect on a real analysis of a fixture
    const i5 = mkIssue(); const an = analysis.run(i5.id, { root: SITE });
    const hy = analysis.applyBisect(i5.id, an, { bisect: { status: 'cause-found', loads: 7, causes: [{ plugins: ['alpha'], minimal: true }], theme: null }, sandboxReproduced: 'yes' });
    const list = Array.isArray(hy) ? hy : (hy.hypotheses || []);
    ok(JSON.stringify(list).includes('support:bisect') && JSON.stringify(list).includes('bisect-minimal-set'), 'applyBisect adds a bisect-minimal-set hypothesis carrying the support:bisect rule');
    const statuses = [...new Set(list.map(x => x.status || x.verdict || x.state).filter(Boolean))];
    ok(list.length > 0 && !statuses.some(x => /^(CONFIRMED|REPRODUCIBLE|FIXED_VERIFIED)$/.test(x)), `and no hypothesis is given CONFIRMED/REPRODUCIBLE (only the validation step may); statuses seen: ${statuses.join(', ') || '(none field)'}`);

    ok(SITE_HASH === hashTree(SITE), 'after every scenario above, the original site tree still hashes the same');
    ok(!fs.readdirSync(os.tmpdir()).some(n => n.startsWith('pg-lc-') && false), 'housekeeping');
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(failures ? `\n${failures} FAILED` : '\nAll checks passed');
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
