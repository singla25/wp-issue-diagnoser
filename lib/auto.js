// `guard:auto`: the one-command pipeline. No question is asked. It only COMPOSES the existing pieces:
//   preflight (doctor + Docker) -> Agent 1 (frontend, mode visual) -> Agent 2 (code/conflict scan) -> auto-issues from Agent 1's reproducible failures
//   -> ONE shared sandbox + bisection per issue (local/staging only) -> validation (Agent 3 for the run, Phase H for every issue) -> one report.
// Rules: read-only on the original site (it is fingerprinted before and after), no AI, the same governor/cooldown/authorization rules as qa-url,
// every status comes from a validator, and anything that could not run is listed with its reason.
// Exit codes (as qa-*): 0 done, nothing at/above --fail-on · 1 findings at/above it · 2 bad usage or configuration · 3 a prerequisite or stage was blocked.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const runs = require('./runs');
const store = require('./issue-store');
const workflow = require('./workflow');
const preflight = require('./auto-preflight');
const autoIssues = require('../issue/auto-issues');
const diagnosis = require('./auto-diagnosis');

const log = (...a) => console.log(...a);
const FAIL_RANK = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, INFO: 4 };
const num = (v, d, min, max, name) => { if (v === undefined) return d; const n = Number(v); if (!Number.isInteger(n) || n < min || n > max) throw new config.ConfigError([`--${name} must be a whole number from ${min} to ${max}`]); return n; };

// path|size|mtime of every file (symbolic links are not followed). Logs and cache folders are left out: a copy that is also being served locally
// writes to them. -> { files, hash } | { skipped }
function fingerprint(root, cap = 300000) {
    const h = crypto.createHash('sha256'); let n = 0, over = false;
    const SKIP = /^(\.git|node_modules)$/, SKIP_REL = /^wp-content\/(cache|upgrade|uploads|wflogs|ai1wm-backups)(\/|$)/;
    (function walk(dir, rel) {
        if (over) return;
        let es; try { es = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1)); } catch { return; }
        for (const e of es) {
            const r = rel ? `${rel}/${e.name}` : e.name;
            if (e.isSymbolicLink()) { h.update(`${r}|link|`); continue; }
            if (e.isDirectory()) { if (!SKIP.test(e.name) && !SKIP_REL.test(r)) walk(path.join(dir, e.name), r); continue; }
            if (/\.log$/i.test(e.name)) continue;
            let st; try { st = fs.lstatSync(path.join(dir, e.name)); } catch { continue; }
            h.update(`${r}|${st.size}|${Math.round(st.mtimeMs)}|`); if (++n > cap) { over = true; return; }
        }
    })(root, '');
    return over ? { skipped: `more than ${cap} files: too many to fingerprint` } : { files: n, hash: h.digest('hex') };
}

function printPdf(htmlFile, pdfFile) {
    return (async () => {
        let pw; try { pw = require(require.resolve('@playwright/test', { paths: [path.join(__dirname, '..', '..', 'frontend')] })); } catch { return { ok: false, reason: 'Playwright is not installed (npm run setup:frontend)' }; }
        let browser; try { browser = await pw.chromium.launch(); } catch (e) { return { ok: false, reason: `Chromium cannot start (${String(e.message).split('\n')[0]})` }; }
        try {
            const ctx = await browser.newContext(); await ctx.route('**/*', r => (r.request().url().startsWith('file://') ? r.continue() : r.abort()));
            const page = await ctx.newPage(); await page.goto(`file://${htmlFile}`);
            await page.evaluate(() => document.querySelectorAll('details').forEach(d => { d.open = true; }));
            await page.emulateMedia({ media: 'print', colorScheme: 'light' });
            await page.pdf({ path: pdfFile, format: 'A4', printBackground: true, margin: { top: '14mm', bottom: '14mm', left: '10mm', right: '10mm' } });
            return { ok: true };
        } catch (e) { return { ok: false, reason: String(e.message).split('\n')[0] }; } finally { await browser.close(); }
    })();
}

const oneLine = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

// deps (tests only): agent1, agent2, observe, sandboxOptions, preflightOptions, pdf
async function auto(o, deps = {}) {
    // ---- usage: nothing is guessed ----
    const missing = ['url', 'root', 'env'].filter(k => !o[k]);
    if (missing.length) throw new config.ConfigError([`guard:auto needs ${missing.map(k => '--' + k).join(', ')}. Example: npm run guard:auto -- --url https://staging.example/ --root /path/to/wordpress --env staging`]);
    const maxIssues = num(o['max-issues'], 5, 0, 20, 'max-issues'), sandboxMax = num(o['sandbox-max-issues'], 3, 0, 20, 'sandbox-max-issues');
    const failOn = String(o['fail-on'] || 'HIGH').toUpperCase();
    if (!(failOn in FAIL_RANK)) throw new config.ConfigError([`--fail-on must be one of ${Object.keys(FAIL_RANK).join(', ')}`]);
    const cfg = workflow.resolveOrThrow({ ...o, mode: 'visual' });
    if (!cfg.url) throw new config.ConfigError(['guard:auto needs --url']);
    const didNot = [];   // { what, why }  -> "what did not run, and why"

    log(`guard:auto  ${cfg.url} (${cfg.environment})  source ${cfg.root}`);
    const before = fingerprint(cfg.root);

    // ---- 1. preflight ----
    log('\n[1/7] Preflight');
    for (const p of workflow.doctorChecks(cfg)) log(`  ${p.ok ? '✔' : p.required ? '✖' : '–'} ${p.name}: ${String(p.detail).slice(0, 160)}`);
    const pf = deps.preflight ? deps.preflight() : preflight.run({ environment: cfg.environment, noSandbox: !!o['no-sandbox'], root: cfg.root, ...(deps.preflightOptions || {}) });
    for (const a of pf.attempts) log(`  ${a.ok ? '✔' : '–'} ${a.what}${a.detail ? `: ${a.detail}` : ''}`);
    log(pf.mode === 'sandbox' ? `  Sandbox: available${pf.started_docker ? ' (the user Docker service was started)' : ''}.` : `  Static-only mode: ${pf.reason}`);
    if (pf.mode !== 'sandbox') didNot.push({ what: 'Sandbox and bisection', why: pf.reason || 'not requested' });

    const run = workflow.startRun({}, cfg.url);
    runs.write(run.id, 'run.json', { ...runs.read(run.id, 'run.json'), auto: true });

    // ---- 2. Agent 1 ----
    log('\n[2/7] Agent 1: frontend QA (visual mode)');
    const a1 = deps.agent1 ? await deps.agent1(cfg, run) : await workflow.stageUrl(o, cfg, run);
    if (deps.agent1) { runs.write(run.id, 'agent1.json', a1); runs.updateManifest(run.id, { target: { url: cfg.url }, stage: { name: 'agent1', data: { at: a1.finished_at, url: cfg.url, mode: 'visual', environment: cfg.environment, tests_ran: a1.tests_ran } } }); }
    if (!a1.tests_ran) didNot.push({ what: 'Frontend QA (Agent 1)', why: (a1.checks.find(c => c.status !== 'PASSED') || {}).reason || 'it did not run' });
    for (const c of a1.checks.filter(c => ['NOT_RUN', 'NEEDS_AUTHORIZATION', 'BLOCKED'].includes(c.status))) didNot.push({ what: c.label, why: oneLine(c.reason) });

    // ---- 3. Agent 2 ----
    log('\n[3/7] Agent 2: code and conflict scan');
    const a2 = deps.agent2 ? await deps.agent2(cfg, run) : await workflow.stageCode(o, cfg, run);
    if (deps.agent2) { runs.write(run.id, 'agent2.json', a2); runs.updateManifest(run.id, { target: { root: cfg.root, url: cfg.url }, stage: { name: 'agent2', data: { at: a2.finished_at, root: cfg.root, url: cfg.url } } }); }
    for (const c of (a2.checks || []).filter(c => ['NOT_RUN', 'SKIPPED', 'BLOCKED'].includes(c.status))) didNot.push({ what: c.label, why: oneLine(c.reason) });

    // ---- 4. auto-issues ----
    log('\n[4/7] Auto-issues from reproducible frontend failures');
    const derived = a1.tests_ran ? autoIssues.derive(a1.findings, { url: cfg.url, max: maxIssues }) : { issues: [], skipped: [], considered: 0, groups: 0, max: maxIssues };
    const made = autoIssues.create(derived.issues, { root: cfg.root, environment: cfg.environment, url: cfg.url, authorized: !!o.authorized });
    log(`  ${derived.considered} frontend finding(s) -> ${derived.groups} distinct failure(s) -> ${made.length} auto-issue(s) (cap ${maxIssues})`);
    for (const s of derived.skipped.filter(s => /over the cap/.test(s.reason))) didNot.push({ what: `Auto-issue for "${oneLine(s.title).slice(0, 80)}"`, why: s.reason });
    const kinds = new Map(); for (const s of derived.skipped.filter(s => !/over the cap/.test(s.reason))) kinds.set(s.reason, (kinds.get(s.reason) || 0) + 1);
    for (const [why, n] of kinds) didNot.push({ what: `${n} frontend finding(s) not turned into issues`, why });

    // ---- per-issue static analysis (no extra request to the site: Agent 1 already observed it) ----
    const evidence = require('../issue/evidence'), analysis = require('../issue/analysis');
    const an = {};
    for (const i of made) {
        await evidence.run(i.id, { root: cfg.root, probeOptions: { probe: false } });
        an[i.id] = analysis.run(i.id, { root: cfg.root, config: o.config });
    }

    // ---- 5. one shared sandbox ----
    log('\n[5/7] Sandbox (one, shared by all issues)');
    let sb = null;
    const forSandbox = made.slice(0, sandboxMax);
    for (const i of made.slice(sandboxMax)) didNot.push({ what: `Sandbox test of "${oneLine(i.title).slice(0, 80)}"`, why: `over --sandbox-max-issues (${sandboxMax})` });
    if (pf.mode === 'sandbox' && forSandbox.length) {
        const first = an[forSandbox[0].id];
        sb = await require('../issue/sandbox-many').runMany(forSandbox.map(i => i.id), { root: cfg.root, options: { dump: o['db-dump'] && config.userPath(o['db-dump']), keepRealData: !!o['keep-real-data'], neutralisePayments: !!o['neutralise-payments'], withUploads: !!o['with-uploads'], maxSizeMb: o['max-size-mb'], maxLoads: o['max-loads'], maxMinutes: o['max-minutes'], noBisect: !!o['no-bisect'] }, components: (first && first.analysis && first.analysis.components) || [], top: (first && first.analysis && first.analysis.top) || [], sandboxOptions: deps.sandboxOptions || {}, observe: deps.observe });
        for (const s of sb.steps) log(`  ${s.status.padEnd(8)} ${s.label}${s.reason ? `: ${String(s.reason).slice(0, 150)}` : ''}`);
        if (sb.unavailable) didNot.push({ what: 'Sandbox and bisection', why: sb.unavailable });
        if (sb.shared) log(`  ${sb.shared.page_loads} page load(s) for ${sb.shared.sets} plugin set(s); ${sb.shared.cache_hits} reused from the cache`);
    } else log(`  skipped: ${!made.length ? 'there is no auto-issue to test' : pf.reason}`);

    // ---- 6. validation: Phase H for each issue, then Agent 3 for the run ----
    log('\n[6/7] Validation');
    const validate = require('../issue/validate'), resolve = require('../issue/resolve'), result = require('../issue/result'), vf = require('../issue/verify-fixes');
    const policy = validate.policyFor(cfg.root, o.config);
    const rows = [];
    for (const i of made) {
        const per = sb && sb.per[i.id] || null;
        if (per && (per.bisect || per.reproduced_in_sandbox)) analysis.applyBisect(i.id, an[i.id], { bisect: per.bisect, sandboxReproduced: per.reproduced_in_sandbox });
        const val = validate.run(i.id, { root: cfg.root, config: o.config });
        const plans = resolve.build(i.id, val, { root: cfg.root, policy, dir: store.dirOf(i.id) });
        await vf.run(i.id, { root: cfg.root, plans, options: { sandbox: false } });   // labels every patch/shim "not verified in the sandbox" with the reason
        const w = result.write(i.id, { validation: val, plans, dir: store.dirOf(i.id), root: cfg.root, policy });
        const f = w.findings, top = f.hypotheses.filter(h => h.status !== 'REJECTED_FALSE_POSITIVE')[0] || null, b = f.bisect;
        const sbSteps = per ? per.steps : [];
        rows.push({
            id: i.id, title: i.title, oracle: { type: i.oracle.type, value: i.oracle.value }, pages: i.pages, occurrences: i.auto.occurrences, severity: i.auto.severity, fingerprint: i.auto.fingerprint,
            verdict: f.verdict.label, confidence: f.verdict.confidence, reproduced_in_sandbox: per ? per.reproduced_in_sandbox : null,
            sandbox_reason: per ? (sbSteps.find(s => s.status !== 'PASSED') || {}).reason || null : (i.id in (sb ? sb.per : {}) ? null : (pf.mode !== 'sandbox' ? pf.reason : 'over --sandbox-max-issues')),
            not_plugin_conflict: !!(b && b.symptom_without_plugins), cause: top ? `[${top.status.replace(/_/g, ' ')}] ${top.title}. ${oneLine(top.mechanism).split(/(?<=[.!?])\s/)[0]}` : null,
            bisect: b ? `${b.status}${b.causes.length ? ': ' + b.causes.map(c => '[' + c.plugins.join(', ') + ']').join(' and ') : ''} (${b.loads} tests, ${b.cache_hits} cached)${b.capped ? `; STOPPED by the ${b.capped} cap` : ''}` : null,
            options: f.resolution.flatMap(r => r.options).slice(0, 6).map(op => `[${op.who}] ${op.type}: ${op.title}${op.verified_in_sandbox === true ? ' (VERIFIED IN SANDBOX)' : op.verified_in_sandbox === false ? ' (tested, did not help)' : op.test_to_choose ? ' (test to choose)' : ''}`),
            report: path.relative(run.dir, path.join(store.dirOf(i.id), 'result', 'issue.html'))
        });
        log(`  ${i.id.slice(4, 19)}  ${f.verdict.label.padEnd(28)} ${oneLine(i.title).slice(0, 80)}`);
    }
    if (made.length) didNot.push({ what: 'Verification of patches and shims in the sandbox', why: 'guard:auto bisects only; every patch/shim is labelled "not verified in the sandbox". Run  issue investigate <id> --sandbox  on an auto-issue to verify them.' });
    const after = fingerprint(cfg.root);
    const integrity = before.skipped || after.skipped ? { same: null, files: 0, detail: before.skipped || after.skipped } : { same: before.hash === after.hash, files: before.files, detail: before.hash === after.hash ? '' : 'a file under --root has a different size or modification time than before the run (not written by Plugin Guard; check what else touches this copy)' };
    log(`  original site: ${integrity.same === true ? `unchanged (${integrity.files} files fingerprinted before and after)` : integrity.same === false ? `CHANGED: ${integrity.detail}` : `not checked: ${integrity.detail}`}`);
    const plain = diagnosis.diagnose({ a1, root: cfg.root });
    const autoData = {
        plain,
        inputs: { url: cfg.url, environment: cfg.environment, root: cfg.root, max_issues: maxIssues, sandbox_max_issues: sandboxMax },
        mode: pf.mode, mode_reason: pf.reason, preflight: { started_docker: pf.started_docker, attempts: pf.attempts },
        counts: { considered: derived.considered, groups: derived.groups, issues: rows.length, reproduced: rows.filter(r => r.reproduced_in_sandbox === 'yes').length, not_plugin: rows.filter(r => r.not_plugin_conflict).length },
        issues: rows, issues_none: !a1.tests_ran ? 'Frontend QA did not run, so there was nothing to turn into issues.' : null,
        skipped: derived.skipped.slice(0, 40), shared: sb ? sb.shared : null, sandbox_steps: sb ? sb.steps : [], integrity, did_not_run: didNot
    };
    log('\n[7/7] Agent 3: validation and the report');
    const r = await workflow.stageValidate(run.id, { failOn, auto: autoData });
    const htmlFile = path.join(run.dir, 'report.html'), pdfFile = path.join(run.dir, 'report.pdf');
    const pdf = deps.pdf ? await deps.pdf(htmlFile, pdfFile) : await printPdf(htmlFile, pdfFile);
    log(pdf.ok ? `  PDF: ${pdfFile}` : `  PDF not built: ${pdf.reason} (report.html is complete)`);
    fs.writeFileSync(path.join(run.dir, 'auto.json'), JSON.stringify({ ...autoData, pdf: pdf.ok ? 'report.pdf' : null, pdf_reason: pdf.ok ? null : pdf.reason }, null, 2) + '\n');
    log('\nIN PLAIN WORDS');
    log(`  ${plain.headline}`);
    for (const l of plain.lines) log(`  ${l}`);
    if (plain.next.length) { log('  What to do next:'); plain.next.forEach((n, i) => log(`    ${i + 1}. ${n}`)); }
    log(`\nRun id: ${run.id}\nReport: ${htmlFile}`);
    let exit = r.exit;
    if (!a1.tests_ran) exit = 3;
    if (integrity.same === false) { log('\nBlocked: the original site changed during the run (see above).'); exit = 3; }
    return exit;
}

module.exports = { auto, fingerprint };
