#!/usr/bin/env node
// A sandbox that could not start or activate the site's plugins gives NO evidence. It must never change a verdict (it once turned "Confirmed cause found in your
// logs" into "No confirmed breaking cause"). A sandbox that ran and did NOT reproduce the symptom is real evidence and still changes it. Fake Docker, stubbed
// page loads, no network. validate.js is not involved in the fix: it only ever saw reproduced_in_sandbox === 'no' and was right to downgrade on it.
const fs = require('fs');
const os = require('os');
const path = require('path');

const trees = require('./fixtures/issue/trees');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-sbfail-'));
process.env.PLUGIN_GUARD_ISSUES = path.join(tmp, 'issues');
const store = require('../lib/issue-store');
const evidence = require('../issue/evidence'), analysis = require('../issue/analysis'), validate = require('../issue/validate'), resolve = require('../issue/resolve'), result = require('../issue/result');
const phase = require('../issue/sandbox-phase'), probe = require('../issue/probe');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const group = t => console.log(`\n== ${t}`);

function fakeEnv(name, wp, site) {
    const dir = path.join(tmp, 'fake-' + name); fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(path.join(__dirname, 'fixtures', 'issue', 'fake-docker.js'), path.join(dir, 'docker')); fs.chmodSync(path.join(dir, 'docker'), 0o755);
    const sbx = path.join(tmp, 'sbx-' + name); fs.mkdirSync(sbx, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, 'fake.json'), JSON.stringify({ wp }));
    return { opts: () => ({ dockerBin: path.join(dir, 'docker'), sandboxesRoot: sbx, root: site, env: { PATH: process.env.PATH, HOME: process.env.HOME } }), sbx };
}
const WP = [{ match: 'plugin list', out: 'plugin-a\nplugin-b\n' }, { match: 'theme list', out: 'acme\ntwentytwentysix\n' }, { match: 'option get stylesheet', out: 'acme\n' }];
const ACT_FAIL = { match: 'plugin activate', status: 1, stderr: "Fatal error: Cannot redeclare my_helper() (previously declared in /var/www/html/wp-content/plugins/plugin-a/plugin-a.php:8) in /var/www/html/wp-content/plugins/plugin-b/plugin-b.php on line 8\n" };

// the same stages as `issue investigate --gate`, with the sandbox as the only variable
async function pipeline(name, { sandbox = null, stubOracle = 'no' } = {}) {
    const root = path.join(tmp, name, 'wp'); const cfg = trees.duplicateFunction(root);
    fs.writeFileSync(path.join(root, 'plugin-guard.config.json'), JSON.stringify(cfg.config));
    const config = path.join(root, 'plugin-guard.config.json');
    const issue = store.create({ title: 'Gate fixture', description: cfg.description || 'fixture', symptom: cfg.symptom || 'white-screen', environment: 'local', url: 'http://127.0.0.1:9/', root, pages: ['/'] });
    await evidence.run(issue.id, { root, probeOptions: { probe: false } });
    const an = analysis.run(issue.id, { root, config });
    let sb = null;
    if (sandbox) {
        const real = probe.runSandbox; probe.runSandbox = async () => ({ ok: true, pages: [], status_codes: [200], oracle: { result: stubOracle } });
        const F = fakeEnv(name, sandbox === 'activation-fails' ? [ACT_FAIL, ...WP] : WP, root);
        try { sb = await phase.run(issue.id, { root, options: { sandbox: true }, analysis: { ...an.analysis, components: an.analysis.components, top: an.analysis.top }, sandboxOptions: F.opts() }); } finally { probe.runSandbox = real; }
        if (sb.bisect || sb.reproduced_in_sandbox) analysis.applyBisect(issue.id, an, { bisect: sb.bisect, sandboxReproduced: sb.reproduced_in_sandbox, sandboxRedirect: !!sb.redirect_observed });
    }
    const dir = store.dirOf(issue.id);
    const val = validate.run(issue.id, { root, config, lint: () => ({ ok: true, message: '' }) });
    const policy = validate.policyFor(root, config);
    const plans = resolve.build(issue.id, val, { root, policy, dir });
    result.write(issue.id, { validation: val, plans, dir, root, policy, gate: true });
    const f = JSON.parse(fs.readFileSync(path.join(dir, 'result', 'findings.json'), 'utf8'));
    return { f, sb, val, steps: sb ? sb.steps : [] };
}

(async () => {
    const none = await pipeline('none');
    const failed = await pipeline('failed', { sandbox: 'activation-fails', stubOracle: 'no' });   // the stub would say "not reproduced": a failed activation must not even ask
    const ranNo = await pipeline('ranno', { sandbox: 'runs', stubOracle: 'no' });
    const ranYes = await pipeline('ranyes', { sandbox: 'runs', stubOracle: 'yes' });
    const line = r => `${r.f.verdict.label} / ${r.f.hypotheses.map(h => h.status).join(',')}`;
    console.log(`  no sandbox:            ${line(none)}\n  activation failed:     ${line(failed)}\n  ran, not reproduced:   ${line(ranNo)}`);

    group('a sandbox that could not activate the plugins');
    ok(failed.sb.steps.some(s => s.id === 'sandbox-activate' && s.status === 'FAILED' && /Cannot redeclare/.test(s.reason)), 'the activation failure is still reported as a FAILED step');
    ok(failed.sb.reproduced_in_sandbox === null && failed.sb.bisect === null && !failed.sb.baseline, 'reproduced_in_sandbox is null (no evidence), no baseline, no bisect');
    ok(failed.steps.some(s => s.id === 'sandbox-oracle' && s.status === 'NOT_RUN') && failed.steps.some(s => s.id === 'bisect' && s.status === 'NOT_RUN') && failed.steps.some(s => s.id === 'sandbox-teardown' && s.status === 'PASSED'), 'oracle and bisect are NOT_RUN, and the teardown still ran');
    ok(failed.f.verdict.label === none.f.verdict.label && failed.f.verdict.label === 'Confirmed cause found in your logs', 'the verdict equals the no-sandbox verdict');
    ok(JSON.stringify(failed.f.hypotheses.map(h => [h.id, h.status])) === JSON.stringify(none.f.hypotheses.map(h => [h.id, h.status])) && failed.f.findings.length === none.f.findings.length && failed.f.findings.length >= 1, 'every status and every finding is the same as without a sandbox (no finding disappeared)');
    ok(failed.f.hypotheses.every(h => !h.validation_notes.some(n => /NOT reproduced/.test(n))), 'no validation note claims the symptom was "not reproduced"');
    const note = failed.f.summary.lines.find(l => /sandbox test could not run/.test(l));
    ok(!!note && /no evidence either way/.test(note) && /could not be switched on in it: Fatal error: Cannot redeclare my_helper\(\)/.test(note), `the summary says it, with the reason: "${(note || '').slice(0, 140)}"`);
    ok(!none.f.summary.lines.some(l => /sandbox test could not run/.test(l)), 'no note when no sandbox was asked for');
    const md = fs.readFileSync(path.join(store.dirOf(failed.f.issue.id), 'result', 'ISSUE-REPORT.md'), 'utf8');
    ok(/sandbox test could not run/.test(md), 'the Markdown report carries the note too');

    group('a sandbox that ran and did NOT reproduce the symptom is still real evidence');
    ok(ranNo.sb.reproduced_in_sandbox === 'no' && ranNo.val.hypotheses.every(h => h.status !== 'CONFIRMED'), 'reproduced "no": no hypothesis stays CONFIRMED (as before)');
    ok(ranNo.f.verdict.label !== none.f.verdict.label && ranNo.f.findings.length === 0, `and the verdict changes (${ranNo.f.verdict.label})`);
    ok(!ranNo.f.summary.lines.some(l => /sandbox test could not run/.test(l)), 'no "could not run" note when it did run');
    ok(ranYes.sb.reproduced_in_sandbox === 'yes', 'a sandbox that reproduces the symptom is unchanged ("yes")');

    group('the other producer (guard:auto: sandbox-many.js)');
    const src = fs.readFileSync(path.join(__dirname, '..', 'issue', 'sandbox-many.js'), 'utf8');
    ok(/out\.could_not_run = /.test(src) && /if \(out\.could_not_run\) \{/.test(src), 'it uses the same rule: a failed activation means reproduced_in_sandbox stays null for every issue');
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(failures ? `\n${failures} FAILED` : '\nAll checks passed');
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
