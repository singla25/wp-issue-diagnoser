// Agent 1: user and frontend tester. It does NOT contain a browser framework: it runs the existing src/frontend Playwright
// agent (read-only, paced, stops on WAF/429, never submits forms) and converts its qa-report.json into shared findings.
// Evidence (screenshots, the frontend's own reports) is copied into reports/runs/<run-id>/evidence/frontend/.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const schema = require('../lib/schema');
const config = require('../lib/config');

const FRONTEND = path.join(__dirname, '..', '..', 'frontend');
const SEV = { P0: 'HIGH', P1: 'MEDIUM', P2: 'LOW', P3: 'INFO' }; // a visitor-facing defect is not a security finding; Agent 3 may raise it with evidence
const CLASS_STATUS = {
    'CONFIRMED WEBSITE ISSUE': 'UNVERIFIED', 'SEO ISSUE': 'UNVERIFIED', 'ACCESSIBILITY ISSUE': 'UNVERIFIED', 'PERFORMANCE ISSUE': 'UNVERIFIED',
    'POSSIBLE ISSUE': 'PROBABLE_NEEDS_REVIEW', 'MANUAL REVIEW REQUIRED': 'PROBABLE_NEEDS_REVIEW', 'THIRD-PARTY ISSUE': 'PROBABLE_NEEDS_REVIEW',
    'RATE LIMITING / SITE PROTECTION': 'BLOCKED', 'TEST ENVIRONMENT ISSUE': 'UNVERIFIED'
};

function runFrontend({ url, mode, timeoutMinutes }) {
    const cli = path.join(FRONTEND, 'scripts', 'run-qa.js');
    if (!fs.existsSync(path.join(FRONTEND, 'node_modules', '@playwright'))) return Promise.resolve({ started: false, reason: 'src/frontend dependencies are not installed. Run once: npm run setup:frontend' });
    const env = { ...process.env, CI: '1' };
    delete env.PSI_API_KEY; // no third-party request during an Agent 1 run
    delete env.PG_TEST_PASSWORD; // credentials are never handed to the browser agent: it does not log in
    delete env.PG_TEST_USER;
    return new Promise(resolve => {
        const child = spawn(process.execPath, [cli, mode, '--url', url], { cwd: FRONTEND, env, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '', timedOut = false, error = null;
        const keep = d => { output = (output + d).slice(-200000); };
        child.stdout.on('data', keep); child.stderr.on('data', keep);
        const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 10000).unref(); }, timeoutMinutes * 60000);
        child.on('error', e => { error = e.message; });
        child.on('close', status => { clearTimeout(timer); resolve({ started: true, status, timedOut, output: output.trim(), error }); });
    });
}

function copyEvidence(report, reportsDir, evidenceDir) {
    fs.mkdirSync(evidenceDir, { recursive: true });
    const copied = new Map();
    const take = shot => {
        if (!shot) return null;
        if (copied.has(shot)) return copied.get(shot);
        const src = path.isAbsolute(shot) ? shot : [path.join(reportsDir, shot), path.join(reportsDir, 'screenshots', shot), path.join(FRONTEND, shot)].find(fs.existsSync);
        if (!src || !fs.existsSync(src)) { copied.set(shot, null); return null; }
        const name = path.basename(src);
        fs.copyFileSync(src, path.join(evidenceDir, name));
        const rel = `evidence/frontend/${name}`;
        copied.set(shot, rel);
        return rel;
    };
    for (const f of ['qa-report.json', 'QA-REPORT.md', 'RESPONSIVE-REPORT.md', 'visual-qa-report.json']) {
        if (fs.existsSync(path.join(reportsDir, f))) fs.copyFileSync(path.join(reportsDir, f), path.join(evidenceDir, f));
    }
    // Playwright keeps traces only for failed tests (retain-on-failure); copy any that exist.
    const traceDir = path.join(FRONTEND, 'test-results');
    let traces = 0;
    if (fs.existsSync(traceDir)) for (const d of fs.readdirSync(traceDir)) {
        const t = path.join(traceDir, d, 'trace.zip');
        if (fs.existsSync(t) && traces < 20) { fs.copyFileSync(t, path.join(evidenceDir, `trace-${++traces}.zip`)); }
    }
    return { take, traces };
}

function convert(report, runId, ev, url) {
    const out = [];
    const at = report.summary.finishedAt || new Date().toISOString();
    for (const f of report.findings || []) {
        const occ = f.occurrences || [];
        const first = occ[0] || {};
        const shots = [...new Set(occ.map(o => ev.take(o.screenshot)).concat(ev.take(f.evidence && f.evidence.screenshot)).filter(Boolean))];
        const blocked = f.classification === 'RATE LIMITING / SITE PROTECTION';
        const finding = schema.makeFinding({
            id: schema.stableId('UF', f.fingerprint || f.id, f.title), run_id: runId, title: f.title, description: f.actual ? String(f.actual).slice(0, 600) : f.title,
            severity: blocked ? 'INFO' : SEV[f.severity] || 'INFO', status: CLASS_STATUS[f.classification] || 'UNVERIFIED', category: f.category || 'frontend',
            finding_type: blocked ? 'access-restriction' : 'defect',
            source_agent: 'user-frontend', confidence: f.status === 'Fail' ? 'likely' : 'possible', url: first.url || f.url || url, expected_behavior: f.expected || null, actual_behavior: f.actual ? String(f.actual).slice(0, 600) : null,
            evidence: [...shots, ...occ.slice(0, 8).map(o => `${o.url}${o.viewport ? ` @ ${o.viewport}` : ''}${o.actual ? `: ${o.actual}` : ''}`)], recommended_fix: f.recommendation || null,
            reproduction_steps: [`Open ${first.url || f.url || url}${first.viewport ? ` at viewport ${first.viewport}` : ''}`, f.actual ? `Observe: ${String(f.actual).slice(0, 200)}` : 'Observe the behavior described above'],
            blocked_reason: blocked ? String(f.actual || 'blocked by site protection / rate limiting').slice(0, 300) : null,
            component: (first.where || (f.fix && f.fix.where) || '').slice(0, 120) || null, rule: f.fingerprint || null,
            original: { classification: f.classification, severity: f.severity, frontend_id: f.id, pages: occ.length, status: f.status, occurrences: occ.slice(0, 20).map(o => ({ url: o.url, viewport: o.viewport, where: o.where, element: o.element, editUrl: o.editUrl })) }, created_at: at
        });
        out.push(finding);
    }
    return out;
}

function checksFrom(report, run) {
    const checks = [];
    const s = report.summary;
    const lim = report.testingLimitations || {};
    const limited = /LIMITED|stopped/i.test(s.completion || '') || (lim.testsLimited || []).length;
    checks.push({ id: 'frontend-run', label: `Frontend run (${s.mode}) on ${s.target}`, status: /^LIMITED|TESTING LIMITED/i.test(s.completion || '') ? 'BLOCKED' : limited ? 'PASSED' : 'PASSED', reason: s.completion });
    checks.push({ id: 'pages', label: 'Pages loaded', status: s.pagesTested > 0 ? 'PASSED' : 'FAILED', reason: `${s.pagesTested} page(s) at ${(s.viewportsTested || []).join(', ') || 'no'} viewport(s)` });
    checks.push({ id: 'journeys', label: 'Site journeys (menu, hero, ...)', status: s.userJourneysTested ? (s.userJourneysPassed === s.userJourneysTested ? 'PASSED' : 'FAILED') : 'NOT_RUN', reason: s.userJourneysTested ? `${s.userJourneysPassed}/${s.userJourneysTested} passed` : 'no site-specific journeys configured (src/frontend/sites/<host>.js)' });
    if (lim.testsLimited && lim.testsLimited.length) checks.push({ id: 'limited', label: 'Tests stopped by site protection', status: 'BLOCKED', reason: `${lim.testsLimited.length} test(s): the agent did not retry around the protection` });
    const forms = (report.siteProfile && report.siteProfile.forms) || [];
    checks.push({ id: 'forms', label: 'Forms (detected, validated visually, NEVER submitted)', status: forms.length ? 'SKIPPED' : 'PASSED', reason: forms.length ? `${forms.length} form(s) found. Submission was not attempted by design, so whether each one submits successfully, is rejected by validation, or is blocked by CAPTCHA/WAF is NOT VERIFIED. Test it on staging with a disposable account.` : 'no forms found on the tested pages' });
    checks.push({ id: 'login', label: 'Login / registration with test accounts', status: 'NEEDS_AUTHORIZATION', reason: 'The frontend agent is read-only and never logs in. Needs a staging site, a disposable account, and a supported login journey; not run.' });
    checks.push({ id: 'search', label: 'Search and filtering', status: 'NOT_RUN', reason: 'only the search results page is loaded as a page; typing queries is not performed' });
    return checks;
}

async function run({ runId, runDir, cfg, now = new Date() }) {
    const auth = config.urlAuthorization(cfg);
    const evidenceDir = path.join(runDir, 'evidence', 'frontend');
    const base = { agent: 'user-frontend', run_id: runId, url: cfg.url, mode: cfg.frontendMode, environment: cfg.environment, started_at: now.toISOString(), checks: [], findings: [], tests_ran: false };
    if (!auth.ok) {
        base.checks.push({ id: 'authorization', label: 'Authorization to test this URL', status: 'NEEDS_AUTHORIZATION', reason: auth.message });
        base.findings.push(schema.makeFinding({ id: schema.stableId('UF', 'authorization', cfg.url), run_id: runId, title: 'Testing not started: authorization needed', description: auth.message, severity: 'INFO', status: 'NEEDS_AUTHORIZATION', category: 'access', finding_type: 'access-restriction', source_agent: 'user-frontend', url: cfg.url, blocked_reason: auth.message, recommended_fix: 'Confirm the environment (--env staging|local|live) and, for a live site, the owner\'s permission (--authorized). A staging copy is preferred.' }));
        return finalize(base);
    }
    const r = await runFrontend({ url: cfg.url, mode: cfg.frontendMode, timeoutMinutes: cfg.timeoutMinutes });
    base.tests_ran = r.started;
    base.frontend_log_tail = r.output ? r.output.split('\n').slice(-15).join('\n') : null;
    const reportsDir = process.env.QA_REPORTS_DIR ? path.resolve(process.env.QA_REPORTS_DIR) : path.join(FRONTEND, 'reports'); // same folder the frontend module writes to
    const reportFile = path.join(reportsDir, 'qa-report.json');
    let report = null;
    try { if (r.started && fs.statSync(reportFile).mtimeMs >= now.getTime() - 5000) report = JSON.parse(fs.readFileSync(reportFile, 'utf8')); } catch { /* handled below */ }
    if (!report) {
        const reason = !r.started ? r.reason : r.timedOut ? `the frontend run did not finish within ${cfg.timeoutMinutes} minutes and was stopped` : r.error ? r.error : `the frontend agent produced no report (exit ${r.status})`;
        base.checks.push({ id: 'frontend-run', label: `Frontend run (${cfg.frontendMode})`, status: !r.started ? 'NOT_RUN' : 'FAILED', reason });
        base.findings.push(schema.makeFinding({ id: schema.stableId('UF', 'no-report', cfg.url), run_id: runId, title: 'Frontend tests did not produce a result', description: reason, severity: 'INFO', status: 'UNVERIFIED', category: 'environment', finding_type: 'info', source_agent: 'user-frontend', url: cfg.url, blocked_reason: reason, recommended_fix: 'Fix the cause above and re-run. This is a testing problem, not evidence that the website is broken.' }));
        return finalize(base);
    }
    const ev = copyEvidence(report, reportsDir, evidenceDir);
    base.findings = convert(report, runId, ev, cfg.url);
    base.checks = checksFrom(report, r);
    base.summary = report.summary;
    base.limitations = report.testingLimitations || null;
    base.site_profile = { builders: report.siteProfile && report.siteProfile.builders, themes: report.siteProfile && report.siteProfile.themes, plugins_seen_in_assets: report.siteProfile && report.siteProfile.pluginsSeenInAssets };
    base.traces = ev.traces;
    base.pages_tested = report.pagesTested || [];
    return finalize(base);
}

function finalize(a) { a.finished_at = new Date().toISOString(); return a; }

module.exports = { run, convert, checksFrom };
