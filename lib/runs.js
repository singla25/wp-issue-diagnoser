// A "run" is one directory under reports/runs/<run-id>/ shared by the three agents:
//   run.json                 manifest: target, per-stage state (used to refuse stale results)
//   agent1.json / agent2.json  structured output of Agent 1 / Agent 2 (findings + checks)
//   01-user-test-report.md, 02-code-test-report.md, 03-final-validation-report.md, findings.json, claude-tasks.md, report.html
//   evidence/                screenshots, copies of frontend reports, tool output

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const runsRoot = () => process.env.PLUGIN_GUARD_RUNS || path.join(__dirname, '..', '..', '..', 'reports', 'runs');
const RUN_RE = /^[0-9]{8}-[0-9]{6}-[0-9a-f]{6}$/;
const stamp = d => d.toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');

function newRunId(seed = '', now = new Date()) {
    return `${stamp(now)}-${crypto.createHash('sha1').update(`${seed}|${now.toISOString()}|${process.pid}`).digest('hex').slice(0, 6)}`;
}
const dirOf = id => { if (!RUN_RE.test(id)) throw new Error(`"${id}" is not a run id (expected YYYYMMDD-HHMMSS-xxxxxx)`); return path.join(runsRoot(), id); };

function create(seed, now = new Date()) {
    const id = newRunId(seed, now);
    const dir = dirOf(id);
    fs.mkdirSync(path.join(dir, 'evidence'), { recursive: true });
    const manifest = { run_id: id, created_at: now.toISOString(), target: { url: null, root: null }, stages: {} };
    write(id, 'run.json', manifest);
    return { id, dir, manifest };
}

function list() {
    if (!fs.existsSync(runsRoot())) return [];
    return fs.readdirSync(runsRoot()).filter(n => RUN_RE.test(n) && fs.existsSync(path.join(runsRoot(), n, 'run.json'))).sort();
}
function resolve(ref) {
    if (!ref || ref === 'latest') { const l = list().pop(); if (!l) throw new Error('No run found. Start one with: node src/plugin-guard/scripts/guard.js qa-url --url <site>'); return l; }
    dirOf(ref);
    if (!fs.existsSync(path.join(dirOf(ref), 'run.json'))) throw new Error(`Run ${ref} does not exist under ${runsRoot()}`);
    return ref;
}
const write = (id, name, data) => fs.writeFileSync(path.join(dirOf(id), name), typeof data === 'string' ? data : JSON.stringify(data, null, 2));
const read = (id, name) => { try { return JSON.parse(fs.readFileSync(path.join(dirOf(id), name), 'utf8')); } catch { return null; } };

function updateManifest(id, patch) {
    const m = read(id, 'run.json') || { run_id: id, stages: {}, target: {} };
    if (patch.target) m.target = { ...m.target, ...Object.fromEntries(Object.entries(patch.target).filter(([, v]) => v)) };
    if (patch.stage) m.stages[patch.stage.name] = { ...(m.stages[patch.stage.name] || {}), ...patch.stage.data };
    write(id, 'run.json', m);
    return m;
}

// Can the stored Agent 1 / Agent 2 result still be combined with the others? (same target, not too old)
function compatibility(manifest, { now = new Date(), maxAgeHours = 24 } = {}) {
    const problems = [];
    const s1 = manifest.stages.agent1, s2 = manifest.stages.agent2;
    for (const [k, s] of [['agent1', s1], ['agent2', s2]]) {
        if (!s || !s.at) continue;
        const age = (now - new Date(s.at)) / 3600000;
        if (age > maxAgeHours) problems.push(`${k} result is ${Math.round(age)} h old (limit ${maxAgeHours} h): re-run it`);
    }
    if (s1 && s2 && s1.url && s2.url && new URL(s1.url).origin !== new URL(s2.url).origin) problems.push(`Agent 1 tested ${s1.url} but Agent 2 was configured for ${s2.url}`);
    return problems;
}

module.exports = { runsRoot, newRunId, create, list, resolve, dirOf, write, read, updateManifest, compatibility, RUN_RE };
