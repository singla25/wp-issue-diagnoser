// A small, deterministic issue pipeline for the gate tests: tree -> issue -> evidence (no probe) -> analysis -> validation (php -l stubbed) -> resolution -> result files.
// `result` options (gate, verbose) are passed straight to issue/result.js write(). Used by selftest-gate-output.js and to record the gate-off golden files.
const fs = require('fs');
const os = require('os');
const path = require('path');

function normalise(text, ctx) {
    return String(text)
        .split(ctx.root).join('<ROOT>').split(ctx.id).join('<ISSUE>')
        .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, '<TIME>')
        .replace(/iss-\d{8}-\d{6}-[0-9a-f]{6}/g, '<ISSUE>');
}

// -> { id, root, dir, files: { 'findings.json': text, ... }, normalised: {...}, validation, plans, store }
async function run({ trees, tree = 'duplicateFunction', result = {}, tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-gate-pipe-')), mutate = null, title = 'Gate output fixture', symptom = null, probeOff = true } = {}) {
    process.env.PLUGIN_GUARD_ISSUES = path.join(tmp, 'issues');
    // fresh modules per call would be needed if the store cached its root; it reads the environment on every call
    const store = require('../../../lib/issue-store');
    const evidence = require('../../../issue/evidence'), analysis = require('../../../issue/analysis'), validate = require('../../../issue/validate'), resolve = require('../../../issue/resolve'), res = require('../../../issue/result');
    const root = path.join(tmp, 'wp');
    const cfg = (trees || require('./trees'))[tree](root);
    if (mutate) mutate(root);
    fs.writeFileSync(path.join(root, 'plugin-guard.config.json'), JSON.stringify(cfg.config));
    const issue = store.create({ title, description: cfg.description || 'fixture', symptom: symptom || cfg.symptom || 'white-screen', environment: 'local', url: 'http://127.0.0.1:9/', root, pages: ['/'] });
    await evidence.run(issue.id, { root, probeOptions: { probe: probeOff ? false : undefined } });
    analysis.run(issue.id, { root, config: path.join(root, 'plugin-guard.config.json') });
    const dir = store.dirOf(issue.id);
    const val = validate.run(issue.id, { root, config: path.join(root, 'plugin-guard.config.json'), lint: () => ({ ok: true, message: '' }) });
    const policy = validate.policyFor(root, path.join(root, 'plugin-guard.config.json'));
    const plans = resolve.build(issue.id, val, { root, policy, dir });
    const out = res.write(issue.id, { validation: val, plans, dir, root, policy, ...result });
    const R = f => fs.readFileSync(path.join(dir, 'result', f), 'utf8');
    const files = {};
    for (const f of ['findings.json', 'ISSUE-REPORT.md', 'issue.html', 'tasks.md']) files[f] = R(f);
    const ctx = { root, id: issue.id };
    return { id: issue.id, root, dir, tmp, files, normalised: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, normalise(v, ctx)])), validation: val, plans, store, written: out };
}

module.exports = { run, normalise };
