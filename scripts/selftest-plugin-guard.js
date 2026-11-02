#!/usr/bin/env node
// Step 8: the `plugin-guard` command (scripts/plugin-guard.js) and its question flow (lib/wizard.js, lib/site-intake.js, lib/wp-config-redact.js).
// Offline: no URL is ever visited (the probe is off or no address is given). The command is run as a child process (no terminal) or in-process with scripted input.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { PassThrough } = require('stream');
const { spawnSync } = require('child_process');

const PG = path.join(__dirname, '..');
const BIN = path.join(PG, 'scripts', 'plugin-guard.js');
const intake = require('../lib/site-intake');
const redactCfg = require('../lib/wp-config-redact');
const wizard = require('../lib/wizard');
const store = require('../lib/issue-store');
const Q = require('../issue/questions');
const ocrData = require('../lib/ocr-data');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const group = t => console.log(`\n== ${t}`);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-wiz-'));
const w = (root, rel, body) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); };
const head = (n) => `<?php\n/**\n * Plugin Name: ${n}\n * Version: 1.0.0\n */\n`;

// a WordPress tree with two plugins declaring the same function, secrets in wp-config.php, a debug.log that names the clash
function makeSite(name, { config = true, ownLog = true } = {}) {
    const root = path.join(tmp, name, 'wp');
    for (const n of ['a', 'b']) w(root, `wp-content/plugins/plugin-${n}/plugin-${n}.php`, head('Plugin ' + n.toUpperCase()) + "defined( 'ABSPATH' ) || exit;\nfunction my_helper( $x ) {\n\treturn $x;\n}\n");
    fs.mkdirSync(path.join(root, 'wp-content/themes'), { recursive: true });
    w(root, 'wp-includes/version.php', "<?php\n$wp_version = '6.8.1';\n");
    if (config) w(root, 'wp-config.php', "<?php\ndefine( 'DB_PASSWORD', 'hunter2secret' );\ndefine( 'AUTH_KEY', 'abcdefghijklmnop' );\ndefine( 'WP_DEBUG', true );\ndefine( 'WP_HOME', 'http://user:pw@example.test' );\n$table_prefix = 'wp_';\n");
    if (ownLog) w(root, 'wp-content/debug.log', "[01-Nov-2026 10:00:00 UTC] PHP Fatal error:  Cannot redeclare my_helper() (previously declared in " + root + "/wp-content/plugins/plugin-a/plugin-a.php:4) in " + root + "/wp-content/plugins/plugin-b/plugin-b.php on line 4\n");
    return root;
}
function fingerprint(root) {
    const h = crypto.createHash('sha256');
    (function walk(d) {
        for (const n of fs.readdirSync(d).sort()) {
            const f = path.join(d, n), st = fs.lstatSync(f);
            h.update(`${path.relative(root, f)}|${st.isDirectory() ? 'd' : st.size}|${st.mode}|${Math.round(st.mtimeMs)}\n`);
            if (st.isDirectory()) walk(f); else if (st.isFile()) h.update(fs.readFileSync(f));
        }
    })(root);
    return h.digest('hex');
}
const cli = (args, { input = '' } = {}) => spawnSync(process.execPath, [BIN, ...args], { input, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', PLUGIN_GUARD_ISSUES: '' }, cwd: tmp, timeout: 180000 });
const jl = (d, id) => JSON.parse(fs.readFileSync(path.join(d, id, 'issue.json'), 'utf8'));
const issuesOf = d => (fs.existsSync(d) ? fs.readdirSync(d).filter(x => store.ISSUE_RE.test(x)) : []);
const grepTree = (dir, needle) => { let hit = false; (function walk(d) { for (const n of fs.readdirSync(d)) { const f = path.join(d, n), st = fs.lstatSync(f); if (st.isDirectory()) walk(f); else if (st.isFile() && fs.readFileSync(f).includes(needle)) hit = true; } })(dir); return hit; };

// in-process run with scripted answers and a pretend terminal
async function wiz(answers, flags, extra = {}) {
    const input = new PassThrough(), output = new PassThrough();
    let text = ''; output.on('data', d => { text += d; });
    input.end(answers.join('\n') + (answers.length ? '\n' : ''));
    const saved = process.env.PLUGIN_GUARD_ISSUES, log = console.log; let logged = ''; console.log = (...a) => { logged += a.join(' ') + '\n'; };
    let error = null, code = null;
    try { code = await wizard.run({ _: [], ...flags }, { input, output, tty: true, cwd: tmp, env: { HOME: tmp }, preflight: () => ({ ok: false }), ...extra }); }
    catch (e) { error = e; } finally { console.log = log; if (saved === undefined) delete process.env.PLUGIN_GUARD_ISSUES; else process.env.PLUGIN_GUARD_ISSUES = saved; }
    return { text: text + logged, error, code };
}

(async () => {
    group('the bin entry, the shebang and what a package contains');
    const pkg = JSON.parse(fs.readFileSync(path.join(PG, 'package.json'), 'utf8'));
    ok(pkg.bin && pkg.bin['plugin-guard'] === 'scripts/plugin-guard.js', 'package.json: bin.plugin-guard -> scripts/plugin-guard.js');
    ok(fs.readFileSync(BIN, 'utf8').split('\n')[0] === '#!/usr/bin/env node', 'the first line is a node shebang');
    ok((fs.statSync(BIN).mode & 0o111) === 0o111, 'the file is executable');
    ok(Array.isArray(pkg.files) && !pkg.files.some(f => /selftest|fixtures|issues|projects|sandboxes|state/.test(f)), 'files: lists no tests, fixtures, issues, projects, sandboxes or state');
    const help = cli(['--help']);
    ok(help.status === 0 && /--description/.test(help.stdout) && /--yes/.test(help.stdout), '--help works and lists the options');
    const pk = spawnSync('npm', ['pack', '--json', '--pack-destination', tmp], { cwd: PG, encoding: 'utf8', timeout: 120000 });
    let packed = null; try { packed = JSON.parse(pk.stdout)[0]; } catch { /* reported below */ }
    ok(!!packed, 'npm pack builds a tarball');
    if (packed) {
        const names = packed.files.map(f => f.path);
        ok(['scripts/plugin-guard.js', 'lib/wizard.js', 'lib/site-intake.js', 'issue/validate.js', 'probe/worker.js', 'package.json'].every(f => names.includes(f)), 'the tarball has the command and the pipeline');
        ok(!names.some(n => /selftest|fixtures\/|^issues\/|^projects\/|^sandboxes\/|^state\/|\.traineddata$|node_modules/.test(n)), 'the tarball has no tests, fixtures, projects, issues, sandboxes, state, OCR data or node_modules');
        const ex = path.join(tmp, 'unpacked'); fs.mkdirSync(ex);
        const tar = spawnSync('tar', ['-xzf', path.join(tmp, packed.filename), '-C', ex], { encoding: 'utf8' });
        const run = spawnSync(process.execPath, [path.join(ex, 'package', 'scripts', 'plugin-guard.js'), '--help'], { encoding: 'utf8', cwd: ex });
        ok(tar.status === 0 && run.status === 0 && /plugin-guard/.test(run.stdout), 'the unpacked tarball runs --help on its own');
    }

    group('prompt order, and a bad folder is asked for again');
    const siteA = makeSite('prompts');
    const outA = path.join(tmp, 'outA');
    const pr = await wiz(['The site shows a critical error', '', '', '', path.join(tmp, 'no-such-folder'), tmp, siteA, ''], { out: outA, 'no-probe': true, 'no-questions': true });
    const idx = ['1/7', '2/7', '3/7', '4/7', '5/7', '7/7'].map(k => pr.text.indexOf(k));
    ok(!pr.error && idx.every((v, i) => v >= 0 && (i === 0 || v > idx[i - 1])), 'the questions come in order: problem, screenshots, log, address, folder, PHP version');
    ok((pr.text.match(/5\/7/g) || []).length === 3 && /is not a WordPress folder/.test(pr.text) && /no-such-folder does not exist/.test(pr.text), 'a missing folder and a folder that is not WordPress are each explained and the folder is asked for again');
    ok(!/6\/7/.test(pr.text), 'with no website address the site kind is not asked (nothing is visited)');
    ok(/VERDICT/.test(pr.text) && /Report folder:/.test(pr.text), 'the summary and the report location are printed');

    group('the site folder is never written to, and the copy holds no secrets');
    const siteB = makeSite('fingerprint');
    const before = fingerprint(siteB), outB = path.join(tmp, 'outB');
    const rb = cli(['--description', 'Critical error after update', '--root', siteB, '--out', outB]);
    ok(rb.status === 0, `flags-only run (no terminal, nothing asked) exits 0 (got ${rb.status})${rb.status ? '\n' + rb.stderr : ''}`);
    ok(fingerprint(siteB) === before, 'the site folder is byte-identical before and after (files, folders, modes, times)');
    const id = issuesOf(outB)[0], idir = path.join(outB, id || 'none');
    ok(!!id && fs.existsSync(path.join(idir, 'result', 'findings.json')), 'the report files are in the reports folder');
    ok(!grepTree(idir, 'hunter2secret') && !grepTree(idir, 'abcdefghijklmnop') && !grepTree(idir, 'user:pw@'), 'no database password, key or address credential reached the issue folder');
    const cfg = fs.readFileSync(path.join(idir, 'site-copy', 'wp-config.php'), 'utf8');
    ok(/WP_DEBUG/.test(cfg) && /WP_HOME', 'http:\/\/example\.test'/.test(cfg) && !/DB_|AUTH_/.test(cfg), 'the copy has a redacted wp-config.php with only the safe settings');
    const fj = JSON.parse(fs.readFileSync(path.join(idir, 'result', 'findings.json'), 'utf8'));
    ok(fj.timeline.some(s => s.id === 'intake-wp-config' && /non-secret/.test(s.reason)) && fj.timeline.some(s => s.id === 'intake-log'), 'the report says wp-config was read read-only and the log was used');
    ok(jl(outB, id).root === path.join(idir, 'site-copy'), 'the analysis ran on the copy, not on your folder');

    group('wp-config.php missing: the report says so');
    const siteC = makeSite('noconfig', { config: false, ownLog: false });
    const outC = path.join(tmp, 'outC');
    const rc = cli(['--description', 'Slow pages', '--root', siteC, '--out', outC, '--yes']);
    const fc = JSON.parse(fs.readFileSync(path.join(outC, issuesOf(outC)[0], 'result', 'findings.json'), 'utf8'));
    ok(rc.status === 0 && fc.timeline.some(s => s.id === 'intake-wp-config' && /wp-config was not read/.test(s.reason)) && fc.timeline.some(s => s.id === 'intake-log' && s.status === 'NOT_RUN'), 'the report says "wp-config was not read" and that no log was given');

    group('redaction (pure)');
    const r = redactCfg.redact("<?php\ndefine('DB_NAME','x');define( \"DB_PASSWORD\", \"p\" );\ndefine('WP_DEBUG_LOG', true);\ndefine('WP_HOME', getenv('H'));\ndefine('WP_SITEURL','https://u:p@site.test/wp');\n// define('WP_DEBUG', false);\n$table_prefix='wp7_';\n");
    ok(r.kept.join() === 'WP_DEBUG_LOG,WP_SITEURL,table_prefix' && !/DB_|getenv|u:p@/.test(r.text) && /https:\/\/site\.test/.test(r.text), 'only allow-listed literal settings stay; DB_*, non-literal values and address credentials go');

    group('the live-site rule: the reporter types the domain, or --authorized');
    const siteD = makeSite('live', { ownLog: false });
    const outD = path.join(tmp, 'outD');
    const wrong = await wiz(['Pages break', '', '', 'https://shop.example.net/', siteD, 'live', 'wrong.example.org'], { out: outD, 'no-probe': true, 'no-questions': true });
    ok(wrong.error && wrong.error.exitCode === 3 && /was NOT visited/.test(wrong.error.message) && issuesOf(outD).length === 0, 'a wrong domain: refused (exit 3), nothing created');
    ok(/type the site's domain exactly \(shop\.example\.net\)/.test(wrong.text), 'the prompt names the domain to type');
    const right = await wiz(['Pages break', '', '', 'https://shop.example.net/', siteD, 'live', 'SHOP.example.net', ''], { out: outD, 'no-probe': true, 'no-questions': true });
    const rid = issuesOf(outD)[0];
    ok(!right.error && rid && jl(outD, rid).authorized_live === true && jl(outD, rid).environment === 'live', 'the right domain: the run goes on and the issue is recorded as authorised live');
    const noTty = cli(['--description', 'Pages break', '--root', siteD, '--url', 'https://shop.example.net/', '--env', 'live', '--out', path.join(tmp, 'outD2'), '--no-probe']);
    ok(noTty.status === 3 && /not visited unless you pass --authorized/.test(noTty.stderr) && issuesOf(path.join(tmp, 'outD2')).length === 0, 'no terminal and no --authorized: a live site is refused (exit 3)');
    const withAuth = cli(['--description', 'Pages break', '--root', siteD, '--url', 'https://shop.example.net/', '--env', 'live', '--authorized', '--no-probe', '--out', path.join(tmp, 'outD3')]);
    ok(withAuth.status === 0 && issuesOf(path.join(tmp, 'outD3')).length === 1, 'no terminal with --authorized: it goes on (here with --no-probe, so no request is made)');
    ok(!/authorized:\s*true|authorized_live\s*=\s*true/.test(fs.readFileSync(path.join(PG, 'lib', 'wizard.js'), 'utf8')), 'the wizard source never sets the authorisation itself');
    const noEnv = cli(['--description', 'x', '--root', siteD, '--url', 'https://shop.example.net/', '--out', path.join(tmp, 'outD4'), '--no-probe']);
    ok(noEnv.status === 2 && /--env local \| staging \| live/.test(noEnv.stderr), 'an address without --env is an error (exit 2), not a guess');

    group('"local" for a public name is confirmed; local-looking names are not');
    ok(['localhost', 'a.localhost', '127.0.0.1', '10.1.2.3', '192.168.1.5', '172.20.0.1', 'shop.local', 'x.test', 'wordpress', '::1'].every(intake.hostIsLocal) && !['example.com', '8.8.8.8', '172.32.0.1', 'shop.dev'].some(intake.hostIsLocal), 'hostIsLocal: localhost, private ranges, .local, .test, single names yes; public names no');
    const siteE = makeSite('localcheck', { ownLog: false });
    const loc = await wiz(['Pages break', '', '', 'http://www.example.com/', siteE, 'n', 'staging', ''], { env: 'local', out: path.join(tmp, 'outE'), 'no-probe': true, 'no-questions': true });
    const eid = issuesOf(path.join(tmp, 'outE'))[0];
    ok(/does not look like a local address/.test(loc.text) && eid && jl(path.join(tmp, 'outE'), eid).environment === 'staging', 'a public name called local: asked, and "no" leads to choosing staging or live');
    const loc2 = await wiz(['Pages break', '', '', 'http://localhost:8080/', siteE, ''], { env: 'local', out: path.join(tmp, 'outE2'), 'no-probe': true, 'no-questions': true });
    ok(!/does not look like a local address/.test(loc2.text) && !loc2.error, 'localhost: no extra question');
    const loc3 = cli(['--description', 'x', '--root', siteE, '--url', 'http://www.example.com/', '--env', 'local', '--no-probe', '--out', path.join(tmp, 'outE3')]);
    ok(loc3.status === 0 && /does not look like a local address/.test(loc3.stdout + loc3.stderr), 'no terminal: only a warning (the existing rule is not changed)');

    group('--yes asks nothing; missing values are errors');
    const yes = await wiz([], { yes: true, description: 'Critical error', root: siteE, out: path.join(tmp, 'outF'), 'no-probe': true }, {});
    ok(!yes.error && !/\d\/7/.test(yes.text) && /VERDICT/.test(yes.text), '--yes with a terminal: no question is printed and the run completes');
    const miss1 = cli(['--root', siteE, '--out', path.join(tmp, 'outG')]);
    ok(miss1.status === 2 && /Missing required value: the problem description/.test(miss1.stderr), 'no description: exit 2 with a clear message');
    const miss2 = cli(['--description', 'x', '--out', path.join(tmp, 'outG')]);
    ok(miss2.status === 2 && /Missing required value: the site folder/.test(miss2.stderr), 'no site folder: exit 2 with a clear message');
    const miss3 = cli(['--description', 'x', '--root', path.join(tmp, 'nope'), '--out', path.join(tmp, 'outG')]);
    ok(miss3.status === 2 && /does not exist/.test(miss3.stderr), 'a folder that does not exist: exit 2');
    ok(issuesOf(path.join(tmp, 'outG')).length === 0, 'none of those errors left an issue behind');

    group('the PHP version collected here is not asked again');
    ok(Q.RULES.php.applies({ issue: { php_version: '8.1' }, observations: [{ type: 'removed-function-call' }] }) === false
        && Q.RULES.php.applies({ issue: { php_version: null }, observations: [{ type: 'removed-function-call' }] }) === true, 'question 5 applies without a version and not with one');
    const phpRun = await wiz(['Pages break', '', '', '', siteE, '8.2'], { out: path.join(tmp, 'outH'), 'no-probe': true, 'no-questions': true });
    const hid = issuesOf(path.join(tmp, 'outH'))[0];
    ok(!phpRun.error && hid && jl(path.join(tmp, 'outH'), hid).php_version === '8.2', 'the PHP version answered in the wizard is stored in the issue');
    ok(!/PHP version does your website run/.test(phpRun.text), 'no later question asks for it');

    group('screenshots without OCR data');
    const { PNG } = require('pngjs'); const img = new PNG({ width: 40, height: 40 }); img.data.fill(255);
    fs.writeFileSync(path.join(tmp, 'shot.png'), PNG.sync.write(img));
    const realStatus = ocrData.status; ocrData.status = () => ({ ok: false, reason: 'missing' });
    const ocr = await wiz(['Layout broken', path.join(tmp, 'shot.png'), '', '', siteE, ''], { out: path.join(tmp, 'outI'), 'no-probe': true, 'no-questions': true });
    ocrData.status = realStatus;
    ok(/text in screenshots cannot be read yet/.test(ocr.text) && /npm run guard:setup-ocr/.test(ocr.text), 'without OCR data it says so plainly and names npm run guard:setup-ocr');
    ok(/1 screenshot\(s\) kept/.test(ocr.text), 'the screenshot is still kept');

    group('a site above the size cap');
    const big = await wiz([], { yes: true, description: 'x', root: siteE, out: path.join(tmp, 'outJ'), 'max-size-mb': '0.000001' });
    ok(big.error && big.error.exitCode === 2 && /too big to copy/.test(big.error.message) && /give the wp-content folder itself/.test(big.error.message), 'the cap is explained with what to do');
    ok(issuesOf(path.join(tmp, 'outJ')).length === 0, 'the half-made issue folder is removed');

    group('where the files go');
    const blocker = path.join(tmp, 'a-file'); fs.writeFileSync(blocker, 'x');
    const fb = intake.chooseOutputRoot({ defaultRoot: path.join(blocker, 'issues'), cwd: tmp, env: {} });
    ok(fb.dir === path.join(tmp, 'plugin-guard-reports') && /not writable/.test(fb.why), 'default folder not writable: ./plugin-guard-reports in the current folder');
    ok(intake.chooseOutputRoot({ out: 'x/y', cwd: tmp, defaultRoot: path.join(tmp, 'd'), env: {} }).dir === path.join(tmp, 'x', 'y'), '--out wins');
    ok(intake.chooseOutputRoot({ cwd: tmp, defaultRoot: path.join(tmp, 'd'), env: { PLUGIN_GUARD_ISSUES: path.join(tmp, 'envdir') } }).dir === path.join(tmp, 'envdir'), 'PLUGIN_GUARD_ISSUES is next');
    let inside = null; try { intake.chooseOutputRoot({ cwd: siteE, defaultRoot: path.join(blocker, 'issues'), env: {}, siteRoot: siteE }); } catch (e) { inside = e; }
    ok(inside && inside.exitCode === 2 && /inside your site folder/.test(inside.message), 'never inside the site folder (the fallback in the site folder is refused)');
    let inside2 = null; try { intake.chooseOutputRoot({ out: path.join(siteE, 'wp-content', 'reports'), cwd: tmp, defaultRoot: tmp, env: {}, siteRoot: siteE }); } catch (e) { inside2 = e; }
    ok(inside2 && inside2.exitCode === 2, '--out inside the site folder is refused');

    group('the sandbox question');
    const sbA = await wiz(['Layout broken', '', '', '', siteE, ''], { out: path.join(tmp, 'outK'), 'no-probe': true, 'no-questions': true }, { preflight: () => ({ ok: false }) });
    ok(!/throwaway copy/.test(sbA.text), 'Docker not usable: the question is not asked');
    const sbB = await wiz(['Layout broken', '', '', '', siteE, '', 'n'], { out: path.join(tmp, 'outK2'), 'no-probe': true, 'no-questions': true }, { preflight: () => ({ ok: true }) });
    ok(/A deeper test in a throwaway copy takes a few minutes\. Run it\? \[Y\/n\]/.test(sbB.text) && !sbB.error, 'Docker usable and a terminal: the question is asked (default yes); "n" skips it');
    const sbC = await wiz([], { yes: true, description: 'x', root: siteE, out: path.join(tmp, 'outK3'), 'no-probe': true }, { preflight: () => ({ ok: true }) });
    ok(!/throwaway copy/.test(sbC.text), '--yes: never asked (the sandbox stays flag-only)');
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(`\n${failures ? 'FAILED' : 'OK'}: ${failures} failure(s)`);
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
