#!/usr/bin/env node
// Self-test of `guard:auto`, part 3: the whole pipeline with the REAL Agent 2, Agent 3, auto-issues, validation and report builders, and an injected
// Agent 1 (realistic converted findings), a fake docker and a stubbed page observer (the symptoms depend on which plugins are active, see below).
// The real frontend agent is exercised by selftest-auto-agent1.js; real containers by selftest-auto-docker.js.
//   /       HTTP 500 only while pg-a, pg-b and pg-c are all active     -> cause {pg-a, pg-b, pg-c}
//   /shop/  console error "boom" while pg-b is active                    -> cause {pg-b}
//   /about/ /x.js fails while pg-c is active                             -> cause {pg-c}
//   /legacy/ console error "themebug" ALWAYS (even with every plugin off) -> NOT A PLUGIN CONFLICT
//   overflow at 390 on /shop/ never happens                              -> not reproduced
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-apl-'));
process.env.PLUGIN_GUARD_RUNS = path.join(tmp, 'runs'); process.env.PLUGIN_GUARD_ISSUES = path.join(tmp, 'issues'); process.env.PLUGIN_GUARD_SANDBOXES = path.join(tmp, 'sandboxes'); process.env.QA_REPORTS_DIR = path.join(tmp, 'fe');
const trees = require('./fixtures/issue/trees');
const frontend = require('../agents/frontend');
const runs = require('../lib/runs');
const auto = require('../lib/auto');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const group = t => console.log(`\n== ${t}`);
function hashTree(dir) { const h = crypto.createHash('sha256'); (function walk(d) { for (const n of fs.readdirSync(d).sort()) { const f = path.join(d, n), st = fs.lstatSync(f); h.update(`${path.relative(dir, f)}|${st.isSymbolicLink() ? 'l' : st.isDirectory() ? 'd' : 'f'}|${st.mode}|`); if (st.isDirectory()) walk(f); else if (st.isFile()) h.update(fs.readFileSync(f)); } })(dir); return h.digest('hex'); }
async function quiet(fn) { const old = console.log; const lines = []; console.log = (...a) => lines.push(a.join(' ')); try { return { r: await fn(), out: lines.join('\n') }; } finally { console.log = old; } }

// ---- fake docker + the stubbed site ----
const FD = path.join(tmp, 'fake'); fs.mkdirSync(FD); fs.copyFileSync(path.join(__dirname, 'fixtures', 'issue', 'fake-docker.js'), path.join(FD, 'docker')); fs.chmodSync(path.join(FD, 'docker'), 0o755);
const wpRules = [{ match: 'plugin list', out: 'pg-a\npg-b\npg-c\n' }, { match: 'theme list', out: 'acme\ntwentytwentysix\n' }, { match: 'option get stylesheet', out: 'acme\n' }];
const logLines = () => (fs.existsSync(path.join(FD, 'fake.log')) ? fs.readFileSync(path.join(FD, 'fake.log'), 'utf8').split('\n').filter(Boolean).map(JSON.parse) : []);
const activeNow = () => { const act = new Set(['pg-a', 'pg-b', 'pg-c']); for (const l of logLines()) { const i = l.args.indexOf('plugin'); if (i < 0 || l.args[i - 1] !== 'wp') continue; const verb = l.args[i + 1]; if (verb !== 'activate' && verb !== 'deactivate') continue; for (const n of l.args.slice(i + 2).filter(a => !a.startsWith('--'))) verb === 'activate' ? act.add(n) : act.delete(n); } return act; };
const observe = async ({ base, pages, vp }) => {
    const a = activeNow(), out = [];
    for (const v of vp) for (const u of pages) {
        const p = new URL(u).pathname;
        out.push({ url: u, viewport: { name: v.name, width: v.width }, loaded: true, status: p === '/' && a.has('pg-a') && a.has('pg-b') && a.has('pg-c') ? 500 : 200, console_errors: (p === '/shop/' && a.has('pg-b') ? [{ text: 'boom happened' }] : []).concat(p === '/legacy/' ? [{ text: 'themebug happened' }] : []), page_errors: [], error_responses: p === '/about/' && a.has('pg-c') ? [{ url: `${base.origin}/x.js`, status: 404 }] : [], failed_requests: [], scroll: { doc_width: v.width, viewport_width: v.width }, text: 'ok' });
    }
    return { ok: true, pagesFull: out, planned: out.length, protection: null, login: null };
};
const resetDocker = (cfg = {}) => { for (const f of ['fake.log', 'fake.state.json']) fs.rmSync(path.join(FD, f), { force: true }); fs.writeFileSync(path.join(FD, 'fake.json'), JSON.stringify({ wp: wpRules, ...cfg })); };
const sbOpts = { dockerBin: path.join(FD, 'docker'), sandboxesRoot: path.join(tmp, 'sandboxes'), env: { PATH: process.env.PATH, HOME: process.env.HOME } };

// ---- Agent 1's output, as the real converter would produce it ----
let n = 0;
const ff = o => { n++; return { id: `FE-${n}`, fingerprint: `fp-${n}`, title: o.title, category: o.category, severity: o.severity || 'P2', classification: o.classification || 'POSSIBLE ISSUE', status: 'Fail', actual: o.actual, expected: null, occurrences: (o.pages || ['/']).map(p => ({ url: `http://localhost:8080${p}`, viewport: o.viewport || 'laptop 1280x800', actual: o.actual, where: 'x', screenshot: null })), recommendation: 'r', fix: { where: 'w' } }; };
const findings = frontend.convert({ summary: { finishedAt: '2026-10-28T10:00:00Z' }, findings: [
    ff({ title: 'Page failed to load', category: 'functional', classification: 'CONFIRMED WEBSITE ISSUE', severity: 'P0', actual: 'HTTP 500 http://localhost:8080/', pages: ['/'] }),
    ff({ title: 'Console error', category: 'console', actual: 'boom happened', pages: ['/shop/'] }),
    ff({ title: 'Missing JavaScript file', category: 'assets', classification: 'CONFIRMED WEBSITE ISSUE', severity: 'P1', actual: 'HTTP 404 http://localhost:8080/x.js', pages: ['/about/'] }),
    ff({ title: 'Uncaught JavaScript error', category: 'console', actual: 'themebug happened', pages: ['/legacy/'] }),
    ff({ title: 'Horizontal overflow (page scrolls sideways)', category: 'responsive', classification: 'CONFIRMED WEBSITE ISSUE', actual: 'Page is 700px wide', viewport: 'mobile 390x844', pages: ['/shop/'] }),
    ff({ title: 'Text smaller than 12px', category: 'typography', classification: 'CONFIRMED WEBSITE ISSUE', severity: 'P3', actual: '10px', pages: ['/'] }),
    ff({ title: 'Third-party console error', category: 'third-party', classification: 'THIRD-PARTY ISSUE', severity: 'P3', actual: 'gtag failed', pages: ['/'] })
] }, 'run', { take: () => null }, 'http://localhost:8080/');
const agent1 = (ran = true) => async (cfg, run) => ({ agent: 'user-frontend', run_id: run.id, url: cfg.url, mode: 'visual', environment: cfg.environment, started_at: new Date().toISOString(), finished_at: new Date().toISOString(), tests_ran: ran,
    checks: ran ? [{ id: 'frontend-run', label: 'Frontend run (visual)', status: 'PASSED', reason: 'ok' }, { id: 'login', label: 'Login / registration with test accounts', status: 'NEEDS_AUTHORIZATION', reason: 'The frontend agent is read-only and never logs in.' }] : [{ id: 'frontend-run', label: 'Frontend run (visual)', status: 'NOT_RUN', reason: 'the browser agent is not installed' }],
    findings: ran ? findings.map(f => ({ ...f, run_id: run.id })) : [] });
const O = (root, extra = {}) => ({ url: 'http://localhost:8080/', root, env: 'local', 'sandbox-max-issues': '5', ...extra });
const readRun = () => { const id = runs.list().pop(); return { id, dir: runs.dirOf(id), d: runs.read(id, 'findings.json'), a: runs.read(id, 'auto.json') }; };

(async () => {
    const root = path.join(tmp, 'wp'); const c = trees.threePlugins(root); fs.writeFileSync(path.join(root, 'plugin-guard.config.json'), JSON.stringify(c.config));
    const before = hashTree(root);

    group('usage: nothing is guessed');
    for (const [o, re, msg] of [[{ url: 'http://x.test/' }, /needs --root, --env/, 'missing --root and --env'], [{ root, env: 'local' }, /needs --url/, 'missing --url'], [O(root, { 'max-issues': 'abc' }), /--max-issues must be a whole number/, 'a non-number cap'], [O(root, { 'fail-on': 'severe' }), /--fail-on must be one of/, 'a bad --fail-on'], [O(root, { env: 'prod' }), /environment must be one of/, 'an unknown environment']]) {
        let e = null; try { await auto.auto(o, { agent1: agent1() }); } catch (x) { e = x; }
        ok(e && e.exitCode === 2 && re.test(e.message), `${msg}: exit 2 with an explanation`);
    }

    group('the full pipeline with a shared sandbox');
    resetDocker();
    const full = await quiet(() => auto.auto(O(root), { agent1: agent1(), observe, sandboxOptions: sbOpts, preflightOptions: { dockerBin: sbOpts.dockerBin, env: sbOpts.env } }));
    const R = readRun(), A = R.d.auto;
    ok([0, 1].includes(full.r), `exit code ${full.r} (0/1 by findings; same codes as qa-*)`);
    ok(logLines().filter(l => l.args.includes('up')).length === 1, 'ONE sandbox was built for all the issues (docker compose up once)');
    const by = t => A.issues.find(i => i.oracle.type === t && (t !== 'console-error' || true));
    ok(A.counts.considered === 7 && A.counts.issues === 5, `7 frontend findings -> ${A.counts.groups} distinct failures -> ${A.counts.issues} auto-issues (typography and third-party skipped)`);
    ok(A.issues.every(i => /^\[auto\] /.test(i.title)) && A.issues.every(i => store().load(i.id).auto_generated === true && store().load(i.id).description === ''), 'every auto-issue is marked auto_generated with an empty description');
    const cause = t => A.issues.find(i => i.oracle.type === t && !/themebug/.test(i.oracle.value || ''));
    ok(/REPRODUCIBLE/.test(by('http-5xx').cause) && /\[pg-a, pg-b, pg-c\]/.test(by('http-5xx').bisect) && by('http-5xx').verdict === 'Reproduced and cause found', `5xx: ${by('http-5xx').bisect}`);
    ok(/\[pg-b\]/.test(A.issues.find(i => i.oracle.value === 'boom happened').bisect) && /\[pg-c\]/.test(by('request-failed').bisect), 'console error -> [pg-b]; failed asset -> [pg-c]');
    const th = A.issues.find(i => /themebug/.test(i.oracle.value));
    ok(th.not_plugin_conflict === true && th.reproduced_in_sandbox === 'yes' && !th.bisect.includes('['), `the theme bug is NOT A PLUGIN CONFLICT (${th.bisect})`);
    ok(by('no-hscroll').reproduced_in_sandbox === 'no' && by('no-hscroll').bisect === null, 'the overflow that never happens: "not reproduced", not bisected');
    ok(A.shared.page_loads < A.issues.reduce((s, i) => s + (Number((/\((\d+) tests/.exec(i.bisect || '') || [])[1]) || 0), 0) && A.shared.cache_hits > 0, `shared cache: ${A.shared.page_loads} page loads served ${A.shared.sets} sets, ${A.shared.cache_hits} answers reused`);
    ok(A.sandbox_steps.some(s => s.id === 'sandbox-teardown' && s.status === 'PASSED') && JSON.parse(fs.readFileSync(path.join(FD, 'fake.state.json'), 'utf8')).containers.length === 0, 'teardown ran: no container left');
    ok(A.integrity.same === true && hashTree(root) === before, `the original tree is unchanged (fingerprint of ${A.integrity.files} files, and the full hash)`);
    group('the outputs');
    for (const f of ['report.html', 'report.pdf', 'findings.json', 'auto.json', '03-final-validation-report.md', 'claude-tasks.md']) ok(fs.existsSync(path.join(R.dir, f)), `${f} exists`);
    ok(fs.statSync(path.join(R.dir, 'report.pdf')).size > 5000 && fs.readFileSync(path.join(R.dir, 'report.pdf')).slice(0, 4).toString() === '%PDF', 'report.pdf is a real PDF');
    const md = fs.readFileSync(path.join(R.dir, '03-final-validation-report.md'), 'utf8');
    ok(/## guard:auto/.test(md) && /NOT A PLUGIN CONFLICT/.test(md), 'the Markdown report has the guard:auto section');
    const html = fs.readFileSync(path.join(R.dir, 'report.html'), 'utf8');
    ok(/id="pg-data"/.test(html) && (html.match(/<script/g) || []).length === 2 && !/innerHTML/.test(html), 'report.html is one offline file (two script elements, no innerHTML)');
    ok(R.d.findings.some(f => f.source_agent === 'user-frontend') && R.d.findings.some(f => f.source_agent === 'code-security') && R.d.stages.every(s => s.state === 'completed'), 'findings.json holds the frontend and the code/conflict findings, both stages completed');
    ok(A.did_not_run.some(r => /Login/.test(r.what)) && A.did_not_run.some(r => /Verification of patches and shims/.test(r.why + r.what)) && A.did_not_run.some(r => /not turned into issues/.test(r.what)), 'the "did not run" list names the login check, the unverified patches and the skipped findings, each with a reason');
    const statuses = new Set(A.issues.flatMap(i => [i.verdict]));
    ok(![...statuses].some(s => /Fixed and verified/.test(s)), 'nothing is FIXED_VERIFIED by this command (only issue retest can)');

    group('static-only: no Docker');
    resetDocker({ info: { fail: true, stderr: 'permission denied while trying to connect\n' } });
    const so = await quiet(() => auto.auto(O(root), { agent1: agent1(), observe, sandboxOptions: sbOpts, preflightOptions: { dockerBin: sbOpts.dockerBin, env: sbOpts.env } }));
    const R2 = readRun();
    ok(R2.a.mode === 'static-only' && R2.a.issues.every(i => i.reproduced_in_sandbox === null && i.bisect === null) && /permission denied/.test(R2.a.mode_reason) && R2.a.did_not_run.some(r => /Sandbox and bisection/.test(r.what)), 'the mode and the reason are recorded; no issue is "reproduced"; the report lists the sandbox under what did not run');
    ok(R2.a.issues.every(i => !/Reproduced and cause found/.test(i.verdict)) && [0, 1].includes(so.r), 'without a sandbox no issue reaches "Reproduced and cause found" (honest statuses)');

    group('--no-sandbox and --env live');
    resetDocker(); await quiet(() => auto.auto(O(root, { 'no-sandbox': true }), { agent1: agent1(), observe }));
    ok(logLines().length === 0 && readRun().a.mode === 'static-only' && /--no-sandbox/.test(readRun().a.mode_reason), '--no-sandbox: Docker is not even queried');
    resetDocker(); await quiet(() => auto.auto(O(root, { env: 'live', authorized: true, url: 'https://shop.example/' }), { agent1: agent1(), observe }));
    ok(logLines().length === 0 && /live/.test(readRun().a.mode_reason), '--env live: the sandbox is never built (and Docker is not queried)');

    group('Agent 1 did not run (exit 3, still a report)');
    resetDocker(); const blocked = await quiet(() => auto.auto(O(root), { agent1: agent1(false), observe, sandboxOptions: sbOpts }));
    const R3 = readRun();
    ok(blocked.r === 3 && R3.a.issues.length === 0 && /did not run|nothing to turn/.test(R3.a.issues_none) && fs.existsSync(path.join(R3.dir, 'report.html')) && logLines().length === 0, 'no frontend result: exit 3, no auto-issue, no sandbox, but the code scan and the report are still produced');
    ok(R3.d.stages.find(s => s.id === 'agent2').state === 'completed', 'Agent 2 still completed');

    group('the cap');
    resetDocker(); await quiet(() => auto.auto(O(root, { 'max-issues': '2', 'sandbox-max-issues': '1' }), { agent1: agent1(), observe, sandboxOptions: sbOpts, preflightOptions: { dockerBin: sbOpts.dockerBin, env: sbOpts.env } }));
    const R4 = readRun();
    ok(R4.a.issues.length === 2 && R4.a.did_not_run.filter(r => /over the cap of 2/.test(r.why)).length === 3 && R4.a.did_not_run.some(r => /over --sandbox-max-issues \(1\)/.test(r.why)) && R4.a.issues.filter(i => i.reproduced_in_sandbox !== null).length === 1, '--max-issues 2 keeps the two worst and lists three as over the cap; --sandbox-max-issues 1 tests only one');
    ok(R4.a.issues[0].oracle.type === 'http-5xx', 'the highest-ranked failure (the 5xx page) comes first');

    group('determinism: the same input twice');
    resetDocker(); await quiet(() => auto.auto(O(root), { agent1: agent1(), observe, sandboxOptions: sbOpts, preflightOptions: { dockerBin: sbOpts.dockerBin, env: sbOpts.env } }));
    const Ra = readRun(); resetDocker();
    await quiet(() => auto.auto(O(root), { agent1: agent1(), observe, sandboxOptions: sbOpts, preflightOptions: { dockerBin: sbOpts.dockerBin, env: sbOpts.env } }));
    const Rb = readRun();
    const norm = (a) => JSON.stringify(a.issues.map(i => ({ ...i, id: undefined, report: undefined })).concat([a.shared]));
    ok(norm(Ra.a) === norm(Rb.a), 'the auto-issues (fingerprints, verdicts, causes, bisect summaries) and the shared-load numbers are identical in two runs');

    group('real frontend wiring');
    const cli = spawnSync(process.execPath, [path.join(__dirname, 'guard.js'), 'auto', '--url', 'https://shop.example/', '--root', root, '--env', 'live'], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' }, timeout: 200000 });
    ok(cli.status === 3 && /authoriz|live/i.test(cli.stdout) && /Static-only mode|sandbox/i.test(cli.stdout), `--env live without --authorized: the real Agent 1 does not start (no request), exit ${cli.status}`);
    const cli2 = spawnSync(process.execPath, [path.join(__dirname, 'guard.js'), 'auto', '--url', 'https://shop.example/'], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
    ok(cli2.status === 2 && /needs --root, --env/.test(cli2.stdout + cli2.stderr), 'the CLI: missing flags exit 2');
    ok(hashTree(root) === before, 'after every scenario the original tree is byte-for-byte unchanged (hash)');

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(failures ? `\n${failures} FAILED` : '\nAll checks passed');
    process.exit(failures ? 1 : 0);
    function store() { return require('../lib/issue-store'); }
})().catch(e => { console.error(e); process.exit(1); });
