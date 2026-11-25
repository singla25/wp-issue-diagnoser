#!/usr/bin/env node
// Self-test of step 4m (masking leftovers): the three places of scripts/guard.js that take --url (scan, init = project create, set) use the one address rule;
// the FIX-PLAN.md evidence line is masked; a failed write of issues/index.html prints a warning instead of hiding the error.
// (The masking of `issue show` and `issue list` is a separate commit: see its own checks.) Fixture servers and temp folders only; never touches a real site.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pg-left-')));
const HOME = path.join(tmp, 'home'), ISS = path.join(tmp, 'issues');
fs.mkdirSync(HOME, { recursive: true });
let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const group = t => console.log(`\n== ${t}`);
const GUARD = path.join(__dirname, 'guard.js'), CMD = path.join(__dirname, 'plugin-guard.js');
const SENTENCE = 'The address has hidden characters or spaces, maybe from arrow keys. Type it again.';
const ESC = '\x1b';
const ENVX = { PLUGIN_GUARD_HOME: HOME, PLUGIN_GUARD_ISSUES: ISS, PG_PROBE_NAV_DELAY_MS: '0', PG_PROBE_REQUEST_DELAY_MS: '0', PG_PROBE_COOLDOWN_FILE: path.join(tmp, 'cool.json') };
Object.assign(process.env, ENVX);
const run = (cmd, args) => new Promise(resolve => { const c = spawn(process.execPath, [cmd, ...args], { cwd: tmp, env: { ...process.env } }); let so = '', se = ''; c.stdout.on('data', d => { so += d; }); c.stderr.on('data', d => { se += d; }); c.on('close', code => resolve({ status: code, out: so + se })); });
const projFile = n => path.join(HOME, n, 'project.json');
const site = path.join(tmp, 'site'); fs.mkdirSync(path.join(site, 'wp-content'), { recursive: true });

(async () => {
    group('scripts/guard.js: scan, init (project create) and set refuse a hidden character in --url');
    const BADS = [`http://127.0.0.1:9/p/${ESC}[D${ESC}[D`, 'http://127.0.0.1:9/p/%1B[D', 'http://127.0.0.1:9/a b'];
    for (const bad of BADS) {
        const a = await run(GUARD, ['scan', 'nope', '--url', bad]);
        ok(a.status === 2 && a.out.includes(`--url: ${SENTENCE}`) && !a.out.includes('%1B') && !a.out.includes(ESC), `scan <name> --url ${JSON.stringify(bad).slice(0, 34)}: exit 2, the sentence, the address not repeated (exit ${a.status})`);
    }
    const rt = await run(GUARD, ['retest', 'nope', '--url', 'http://127.0.0.1:9/p/%1B[D']);
    ok(rt.status === 2 && rt.out.includes(`--url: ${SENTENCE}`) && !rt.out.includes('%1B'), `retest <name> --url with a hidden character: exit 2, the sentence, the address not repeated (exit ${rt.status})`);
    const i1 = await run(GUARD, ['init', 'pbad', '--url', 'http://127.0.0.1:9/p/%1B[D', '--path', site]);
    ok(i1.status === 2 && i1.out.includes(`--url: ${SENTENCE}`) && !fs.existsSync(projFile('pbad')), `init (project create) --url with a hidden character: exit 2, the sentence, no project made (exit ${i1.status})`);
    const i2 = await run(GUARD, ['init', 'pgood', '--url', '  http://127.0.0.1:9/ok%20x  ', '--path', site]);
    const stored = fs.existsSync(projFile('pgood')) ? JSON.parse(fs.readFileSync(projFile('pgood'), 'utf8')) : {};
    ok(i2.status === 0 && stored.url === 'http://127.0.0.1:9/ok%20x', `guard: an address with a typed %20 and spaces at the two ends is accepted and stored trimmed (exit ${i2.status}, url "${stored.url}")`);
    const s1 = await run(GUARD, ['set', 'pgood', '--url', `http://127.0.0.1:9/q${ESC}[A`]);
    const after = JSON.parse(fs.readFileSync(projFile('pgood'), 'utf8'));
    ok(s1.status === 2 && s1.out.includes(`--url: ${SENTENCE}`) && after.url === 'http://127.0.0.1:9/ok%20x', `set <name> --url with a hidden character: exit 2, the sentence, the saved address is unchanged (exit ${s1.status})`);
    // a project file edited by hand: the same rule when it is read
    fs.mkdirSync(path.join(HOME, 'phand'), { recursive: true });
    fs.writeFileSync(projFile('phand'), JSON.stringify({ ...stored, name: 'phand', url: 'http://127.0.0.1:9/h%1B[D' }));
    const projectLib = require('../lib/project');
    let msg = ''; try { projectLib.load('phand'); } catch (e) { msg = e.message; }
    ok(msg.includes(`url: ${SENTENCE}`) && !msg.includes('%1B'), 'a project file with a hidden character in its address is refused when it is read (the address is not repeated)');

    group('FIX-PLAN.md: the evidence line from the site\'s own files is masked');
    const fixPlan = require('../issue/fix-plan');
    const root = path.join(tmp, 'root'); fs.mkdirSync(path.join(root, 'wp-content', 'plugins', 'addons'), { recursive: true });
    fs.writeFileSync(path.join(root, 'wp-content', 'plugins', 'addons', 'readme.txt'), '= 1.4 =\n* Compatible with Elementor 3.4.2, see https://www.acme-shop.example/docs or write owner-test@acme-shop.example (server 203.0.113.9)\n');
    const ctx = { comp: { kind: 'plugin', rel: 'wp-content/plugins/addons' }, provider: { name: 'Elementor' } };
    const issue = { root, url: 'https://www.acme-shop.example/', pages: [] };
    const raw = fixPlan.compatEvidence(root, ctx), masked = typeof fixPlan.evidenceFor === 'function' ? fixPlan.evidenceFor(issue, ctx) : null;
    ok(raw && /acme-shop/.test(raw.text) && /owner-test/.test(raw.text) && raw.text.includes('203.0.113.9'), 'the evidence line CAN hold the site address, an email and an IP address (a changelog or readme line of the site, up to 160 characters)');
    ok(masked && !/acme-shop|owner-test|203\.0\.113\.9/.test(masked.text) && masked.text.includes('[site address]') && masked.text.includes('[email removed]') && masked.text.includes('[IP address removed]') && masked.version === '3.4.2' && masked.file === 'wp-content/plugins/addons/readme.txt', 'evidenceFor masks all three and keeps the version and the file name');
    ok(/evidenceFor\(issue, ctx\)/.test(fs.readFileSync(path.join(__dirname, '..', 'issue', 'fix-plan.js'), 'utf8').split('function writeFor')[1] || ''), 'writeFor builds FIX-PLAN.md from the masked evidence');
    ok(typeof fixPlan.evidenceFor === 'function' && fixPlan.evidenceFor({ root, url: null, pages: [] }, { comp: null, provider: null }) === null, 'no evidence: null, no crash');

    group('a failed write of issues/index.html is not hidden');
    fs.mkdirSync(path.join(ISS, 'index.html'), { recursive: true });   // a folder where the file should go: the write fails with EISDIR
    const r = await run(CMD, ['--description', 'The page is white', '--no-files', '--yes']);
    const dirs = fs.readdirSync(ISS).filter(n => /^iss-/.test(n));
    ok(r.status === 0 && dirs.length === 1 && fs.existsSync(path.join(ISS, dirs[0], 'result', 'ISSUE-REPORT.md')), `the report is still written and the run ends with exit 0 (exit ${r.status})`);
    ok(/Warning: the overview page issues\/index\.html could not be written \(EISDIR\)/.test(r.out) && (r.out.match(/Warning: the overview page/g) || []).length === 1, 'one plain warning line names the problem (and the code), once');

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll leftovers checks passed');
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } process.exit(1); });
