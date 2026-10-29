// Orchestration of the three agents. URL-first: qa-url -> (qa-code) -> qa-validate. Local-first: scan --root . does all of it.
// Exit codes: 0 done, nothing at/above --fail-on · 1 findings at/above --fail-on · 2 bad usage or configuration
//             3 a prerequisite or stage was blocked (site blocked / authorization missing / nothing could run)

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const config = require('./config');
const runs = require('./runs');
const schema = require('./schema');
const redact = require('./redact');
const md = require('./report-md');
const tasks = require('./claude-tasks');
const html = require('./report-html');
const codeAgent = require('../agents/code');
const validateAgent = require('../agents/validate');

const SELF = 'node src/plugin-guard/scripts/guard.js';
const FAIL_RANK = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, INFO: 4 };
const log = (...a) => console.log(...a);

function resolveOrThrow(o) {
    const r = config.resolve(o);
    if (r.errors.length) throw new config.ConfigError(r.errors);
    for (const w of r.warnings) log(`Warning: ${w}`);
    return r.config;
}

function openCommand(file) {
    return process.platform === 'darwin' ? `open "${file}"` : process.platform === 'win32' ? `start "" "${file}"` : `xdg-open "${file}"`;
}

// Agent 1 (browser tests of a live site) is a plug-in stage. Plugin Guard alone has none: src/combined registers one (it is the only
// code that drives the Frontend QA agent). A registered stage is called as agent1(o, cfg, run) and writes agent1.json itself.
let agent1Stage = null;
const doctorExtras = [];
function registerAgent1(fn) { agent1Stage = fn; }
function registerDoctorChecks(fn) { doctorExtras.push(fn); }

function startRun(o, seed) {
    if (o.run) { const id = runs.resolve(o.run); return { id, dir: runs.dirOf(id) }; }
    const r = runs.create(seed);
    return { id: r.id, dir: r.dir };
}

async function stageCode(o, cfg, run) {
    log(`Agent 2 (code / security) on ${cfg.root}`);
    if (!cfg.customPaths.length) log('  Note: no customPaths allowlist. The scan still inspects everything, but no code is treated as yours, so no fix tasks can be generated.');
    const a = await codeAgent.run({ runId: run.id, config: cfg });
    a.findings = a.findings.map(f => redact.deep(f));
    runs.write(run.id, 'agent2.json', a);
    runs.write(run.id, '02-code-test-report.md', redact.text(md.codeReport(a)));
    runs.updateManifest(run.id, { target: { root: cfg.root, url: cfg.url }, stage: { name: 'agent2', data: { at: a.finished_at, root: cfg.root, url: cfg.url } } });
    log(`  report: ${path.join(run.dir, '02-code-test-report.md')}`);
    return a;
}

async function stageValidate(id, { allowStale = false, failOn = 'HIGH', auto = null } = {}) {
    const dir = runs.dirOf(id);
    const d = redact.deep(await validateAgent.run({ runId: id, allowStale }));
    if (auto) d.auto = redact.deep(auto);   // the guard:auto block: shown by report.html and 03-final-validation-report.md
    // the three machine/human outputs are generated from this ONE object
    runs.write(id, 'findings.json', d);
    runs.write(id, '03-final-validation-report.md', md.finalReport(d));
    const t = tasks.build(d);
    runs.write(id, 'claude-tasks.md', t.markdown);
    runs.write(id, 'report.html', html.build(d));
    const s = d.summary;
    log(`\nAgent 3 (validation) — run ${id}${d.complete ? '' : '  [PARTIAL]'}`);
    for (const st of d.stages) log(`  ${st.name}: ${st.state}`);
    log(`  findings ${s.total}: Critical ${s.by_severity.CRITICAL} · High ${s.by_severity.HIGH} · Medium ${s.by_severity.MEDIUM} · Low ${s.by_severity.LOW} · Info ${s.by_severity.INFO}`);
    log(`  confirmed/reproducible ${s.confirmed_or_reproducible} · need review ${s.needs_review} · blocked/authorization ${s.blocked_or_authorization} · rejected ${s.rejected_false_positives} · fix tasks ${t.tasks}`);
    for (const p of d.input_problems) log(`  ! ${p}`);
    log(`\nOutputs in ${dir}`);
    for (const f of ['01-user-test-report.md', '02-code-test-report.md', '03-final-validation-report.md', 'findings.json', 'claude-tasks.md', 'report.html']) log(`  ${fs.existsSync(path.join(dir, f)) ? '✔' : '–'} ${f}${fs.existsSync(path.join(dir, f)) ? '' : '  (that stage did not run)'}`);
    log(`\nOpen the dashboard: ${openCommand(path.join(dir, 'report.html'))}   (not opened automatically; not visually checked by this command)`);
    const limit = FAIL_RANK[failOn] ?? 1;
    const counted = d.findings.filter(f => !['REJECTED_FALSE_POSITIVE', 'BLOCKED', 'NEEDS_AUTHORIZATION', 'FIXED_VERIFIED'].includes(f.status) && FAIL_RANK[f.severity] <= limit);
    const nothingRan = d.stages.every(x => x.state !== 'completed');
    return { data: d, exit: nothingRan ? 3 : counted.length ? 1 : 0 };
}

async function qaCode(o) {
    if (!o.root && !o.config) throw new config.ConfigError(['qa-code needs the local WordPress root: --root <folder>']);
    const cfg = resolveOrThrow(o);
    if (!cfg.root) throw new config.ConfigError(['qa-code needs --root <WordPress root>']);
    const run = startRun(o, cfg.root);
    await stageCode(o, cfg, run);
    log(`\nRun id: ${run.id}\nNext: ${SELF} qa-validate --run ${run.id}`);
    return 0;
}

async function qaValidate(o) {
    const id = runs.resolve(o.run);
    const r = await stageValidate(id, { allowStale: !!o['allow-stale'], failOn: String(o['fail-on'] || 'HIGH').toUpperCase() });
    return r.exit;
}

// Workflow B
async function scanLocal(o) {
    const cfg = resolveOrThrow(o);
    if (!cfg.root) throw new config.ConfigError(['scan needs --root <WordPress root> (use --root . inside the project)']);
    log(`Local-first scan of ${cfg.root}`);
    const prereq = doctorChecks(cfg);
    for (const p of prereq) log(`  ${p.ok ? '✔' : p.required ? '✖' : '–'} ${p.name}: ${p.detail}`);
    const missing = prereq.filter(p => p.required && !p.ok);
    if (missing.length) { log(`\nBlocked: ${missing.map(m => m.name).join(', ')} missing.`); return 3; }
    const run = startRun(o, cfg.root);
    await stageCode(o, cfg, run);
    if (cfg.url && agent1Stage) await agent1Stage(o, cfg, run);
    else {
        const why = cfg.url ? 'this Plugin Guard build has no browser-test stage; the combined tool (src/combined) provides one' : 'no target URL supplied; a source checkout alone is not a running site';
        if (cfg.url) log(`\nAgent 1 not run: ${why}.`);
        else log('\nAgent 1 skipped: a source checkout is not a running website, and no --url was given. Start the site (or pass the staging URL) and add --url to include browser tests.');
        const a = { agent: 'user-frontend', run_id: run.id, url: cfg.url || null, mode: null, environment: cfg.environment, started_at: new Date().toISOString(), finished_at: new Date().toISOString(), tests_ran: false, findings: [],
            checks: [{ id: 'frontend-run', label: 'Frontend / user tests', status: 'NOT_RUN', reason: why }] };
        runs.write(run.id, 'agent1.json', a);
        runs.write(run.id, '01-user-test-report.md', md.userReport(a));
        runs.updateManifest(run.id, { stage: { name: 'agent1', data: { at: a.finished_at, tests_ran: false } } });
    }
    const r = await stageValidate(run.id, { failOn: String(o['fail-on'] || 'HIGH').toUpperCase() });
    return r.exit === 3 ? 0 : r.exit; // a missing browser stage is reported as PARTIAL, it is not a failure of the scan
}

function has(bin, args = ['--version']) { const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 15000 }); return r.error ? null : (r.stdout || r.stderr || '').split('\n')[0].trim(); }

function doctorChecks(cfg) {
    const out = [];
    const nodeOk = Number(process.versions.node.split('.')[0]) >= 20;
    out.push({ name: 'Node.js', ok: nodeOk, required: true, detail: `${process.version}${nodeOk ? '' : ' (20.12+ required)'}` });
    const php = has('php', ['-v']);
    out.push({ name: 'PHP CLI', ok: !!php, required: false, detail: php || 'not installed: php -l syntax checks will be NOT RUN' });
    const wp = has('wp', ['--version']);
    out.push({ name: 'WP-CLI', ok: !!wp, required: false, detail: wp || 'not installed: active plugin list and database checks will be skipped' });
    const pwStatus = require('./playwright').status();   // plugin-guard's OWN Playwright and Chromium (PDF reports, the page probe, the browser tests)
    out.push({ name: 'Chromium browser', ok: pwStatus.chromium, required: false, detail: pwStatus.chromium ? `installed (Playwright ${pwStatus.version}, plugin-guard's own)` : pwStatus.reason });
    for (const t of codeAgent.TOOLS) { const v = has(t.bin); out.push({ name: t.id, ok: !!v, required: false, detail: v ? `${v.slice(0, 50)} (${t.offline ? 'offline' : 'needs network'}; not run by Plugin Guard yet)` : `not installed (${t.offline ? 'offline' : 'needs network'}): ${t.needs}` }); }
    if (cfg && cfg.root) out.push({ name: 'WordPress root', ok: fs.existsSync(path.join(cfg.root, 'wp-config.php')), required: false, detail: fs.existsSync(path.join(cfg.root, 'wp-config.php')) ? 'wp-config.php found (a source checkout may have none: database checks then skip)' : 'no wp-config.php: this looks like a source checkout, not a configured site' });
    if (cfg && cfg.root) out.push({ name: 'Custom-code allowlist', ok: cfg.customPaths.length > 0, required: false, detail: cfg.customPaths.length ? cfg.customPaths.join(', ') : 'empty: no fix tasks will be generated' });
    const dc = require('./doctor-checks');
    out.push(...dc.dockerChecks());
    out.push(dc.dockerServiceCheck());
    out.push(dc.packageCheck(path.join(__dirname, '..'), 'issue mode (src/plugin-guard)'));
    // issue-mode sandbox: the daemon and the three pinned images (nothing is pulled by doctor)
    try {
        const sb = require('../issue/sandbox').preflight();
        out.push({ name: 'Docker sandbox images', ok: sb.ok, required: false, detail: sb.ok ? `Docker ${sb.docker}; the 3 pinned images are present` : sb.reason });
    } catch (e) { out.push({ name: 'Docker sandbox images', ok: false, required: false, detail: e.message.split('\n')[0] }); }
    const ocr = require('./ocr-data').status();
    out.push({ name: 'OCR language data', ok: ocr.ok, required: false, detail: ocr.ok ? 'installed and matches its pinned SHA-256' : `${ocr.reason} (issue mode: npm run guard:setup-ocr)` });
    out.push({ name: 'Test credentials', ok: cfg ? cfg.credentialsPresent : false, required: false, detail: 'PG_TEST_USER / PG_TEST_PASSWORD (environment only). The frontend agent and the live probe never log in; only the issue-mode sandbox (a throwaway copy) creates this user and logs in.' });
    for (const extra of doctorExtras) out.push(...extra(cfg));
    return out;
}

async function doctor(o) {
    let cfg = null;
    if (o.root || o.config) cfg = resolveOrThrow(o);
    log('Plugin Guard prerequisites');
    for (const p of doctorChecks(cfg)) log(`  ${p.ok ? '✔' : '–'} ${p.name}: ${p.detail}`);
    log('\nOffline: source analysis, php -l, ownership checks, report generation. Needs a live target: frontend tests. Needs network: composer/npm audit (not run), wordpress.org lookups (only if enabled per project).');
    return 0;
}

async function showConfig(o) {
    const r = config.resolve(o);
    const c = { ...r.config, policy: undefined };
    log(JSON.stringify(c, null, 2));
    for (const w of r.warnings) log(`warning: ${w}`);
    for (const e of r.errors) log(`ERROR: ${e}`);
    return r.errors.length ? 2 : 0;
}

async function showRun(o) {
    const id = runs.resolve(o.run);
    const dir = runs.dirOf(id);
    log(`Run ${id}\n  ${dir}`);
    for (const f of fs.readdirSync(dir)) log(`  ${f}`);
    const file = path.join(dir, 'report.html');
    if (fs.existsSync(file)) log(`\nOpen: ${openCommand(file)}`);
    else log('\nNo report.html yet: run qa-validate for this run.');
    return 0;
}

module.exports = { SELF, startRun, resolveOrThrow, registerAgent1, registerDoctorChecks, doctorChecks, stageCode, qaCode, qaValidate, scanLocal, doctor, showConfig, showRun, stageValidate, doctorChecks };
