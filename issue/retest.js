// `issue retest <id>`: repeat the oracle after a fix was applied to a COPY (or after a shim was placed on a copy) and say Fixed / Still failing /
// New problem / Could not test. This is the ONLY place a hypothesis may become FIXED_VERIFIED, and only when the oracle actually ran and
// passed on the SAME page and the SAME screen size that failed before. Where it runs:
//   default      the live probe (read-only, governed, the same as the first investigation) against the issue's URL
//   --sandbox    a fresh sandbox built from --root (the fixed copy); the baseline oracle only, no bisection
// The earlier evidence is never overwritten: the first probe.json is archived as work/probe.initial.json and every retest keeps its own folder.

const fs = require('fs');
const path = require('path');
const store = require('../lib/issue-store');

const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
// A sandbox gets a new random port every time, so for sandbox runs a page is identified by its path (and query); live runs compare the full URL.
const pageId = page => { try { const u = new URL(page); return u.pathname + u.search; } catch { return String(page); } };
const keyer = sandbox => (page, viewport) => `${sandbox ? pageId(page) : page} @ ${viewport}`;

// pure: previous failing page+viewport pairs, and the new observation -> verdict
function compare(failedBefore, now, { sandbox = false } = {}) {
    const key = keyer(sandbox);
    if (!failedBefore.length) return { verdict: 'Could not test', reason: 'the symptom was not seen before the fix (no failing page and screen size on record), so there is nothing to compare', fixed_verified: false };
    if (!now || now.result === 'could-not-test') return { verdict: 'Could not test', reason: now ? now.reason || 'the oracle could not be evaluated' : 'the oracle did not run', fixed_verified: false };
    const loaded = new Set((now.pages || []).filter(p => p.loaded).map(p => key(p.url, p.viewport)));
    const matching = new Set((now.matches || []).map(m => key(m.page, m.viewport)));
    const still = failedBefore.filter(f => matching.has(key(f.page, f.viewport)));
    const notRerun = failedBefore.filter(f => !loaded.has(key(f.page, f.viewport)));
    const added = [...matching].filter(k => !failedBefore.some(f => key(f.page, f.viewport) === k));
    if (still.length) return { verdict: 'Still failing', reason: `the symptom is still present on ${still.map(f => key(f.page, f.viewport)).join('; ')}`, fixed_verified: false };
    if (notRerun.length) return { verdict: 'Could not test', reason: `these page / screen size combinations that failed before were not loaded this time: ${notRerun.map(f => key(f.page, f.viewport)).join('; ')}`, fixed_verified: false };
    if (added.length) return { verdict: 'New problem', reason: `the original failure is gone, but the oracle now fires elsewhere: ${added.join('; ')}`, fixed_verified: false };
    if (now.result !== 'no') return { verdict: 'Could not test', reason: `the oracle answered "${now.result}"`, fixed_verified: false };
    return { verdict: 'Fixed', reason: `the oracle ran and passed on every page and screen size that failed before (${failedBefore.map(f => key(f.page, f.viewport)).join('; ')})`, fixed_verified: true };
}


// FIXED_VERIFIED needs ALL of these, each recorded with its reason (a retest that is "Fixed" but fails one stays "Fixed, not verified"):
//   original-reproduced   the ORIGINAL run reproduced the symptom in the sandbox: the answer was "yes" (not "probable", not "could not test")
//   same-page-and-size    the oracle ran and passed on the same page and the same screen size that failed (compare() says Fixed)
//   same-plugin-set       the retest sandbox had at least the plugins active that were active when the symptom was seen; both sets are known
//   sandbox-retest        the retest ran in a sandbox (a live probe cannot tell which plugins were active)
//   hypothesis            a CONFIRMED or REPRODUCIBLE hypothesis exists to be marked
function canVerify({ cmp, where, original, now, target }) {
    const c = [];
    const add = (id, ok, reason) => c.push({ id, status: ok ? 'PASSED' : 'FAILED', reason });
    add('original-reproduced', !!original && original.result === 'yes' && original.reproduced_in_sandbox === 'yes', original && original.result === 'yes' && original.reproduced_in_sandbox === 'yes' ? 'the original sandbox run answered "yes": the symptom was reproduced' : `the original run did not reproduce the symptom in the sandbox (answer: ${original ? original.reproduced_in_sandbox || original.result : 'none on record'})`);
    add('same-page-and-size', cmp.verdict === 'Fixed', cmp.verdict === 'Fixed' ? cmp.reason : `the comparison on the same page and screen size says "${cmp.verdict}"`);
    const was = original && original.active_plugins, is = now && now.active_plugins;
    const known = Array.isArray(was) && Array.isArray(is);
    const missing = known ? was.filter(p => !is.includes(p)) : [];
    add('same-plugin-set', known && !missing.length, !known ? 'the active plugin set is not known for the original run or the retest' : missing.length ? `plugins missing in the retest: ${missing.join(', ')}` : `the retest had all ${was.length} plugin(s) active that were active before`);
    add('sandbox-retest', where === 'sandbox', where === 'sandbox' ? 'the retest ran in a sandbox' : 'the retest used the live probe, which cannot show which plugins were active');
    add('hypothesis', !!target, target ? `hypothesis ${target} is CONFIRMED or REPRODUCIBLE` : 'no CONFIRMED or REPRODUCIBLE hypothesis exists to mark');
    return { ok: c.every(x => x.status === 'PASSED'), conditions: c };
}

function failedBefore(dir) {
    const probe = readJson(path.join(dir, 'work', 'probe.initial.json')) || readJson(path.join(dir, 'work', 'probe.json'));
    const sbx = readJson(path.join(dir, 'work', 'sandbox.initial.json')) || readJson(path.join(dir, 'work', 'sandbox.json'));
    const out = [];
    if (probe && probe.oracle && probe.oracle.result === 'yes') for (const m of probe.oracle.matches || []) out.push({ page: m.page, viewport: m.viewport, where: 'live probe' });
    if (sbx && sbx.baseline && sbx.baseline.result === 'yes') for (const m of sbx.baseline.matches || []) out.push({ page: m.page, viewport: m.viewport, where: 'sandbox' });
    const k = keyer(false);
    return out.filter((f, i, a) => a.findIndex(x => k(x.page, x.viewport) === k(f.page, f.viewport)) === i).sort((a, b) => k(a.page, a.viewport).localeCompare(k(b.page, b.viewport)));
}

async function run(id, { root, options = {}, env = process.env, hypothesis = null, now = () => new Date().toISOString() } = {}) {
    const issue = store.load(id), dir = store.dirOf(id);
    const W = f => path.join(dir, 'work', f), R = f => path.join(dir, 'result', f);
    fs.mkdirSync(path.join(dir, 'result'), { recursive: true, mode: 0o700 });
    for (const f of ['probe', 'sandbox']) if (fs.existsSync(W(`${f}.json`)) && !fs.existsSync(W(`${f}.initial.json`))) fs.copyFileSync(W(`${f}.json`), W(`${f}.initial.json`));
    const key = keyer(!!options.sandbox);
    const before = failedBefore(dir);
    const history = readJson(R('retests.json')) || [];
    const n = history.length + 1;
    let observed = null, where = options.sandbox ? 'sandbox' : 'live probe', steps = [];
    if (options.sandbox) {
        if (!root) observed = { result: 'could-not-test', reason: 'the sandbox needs the fixed copy of the site (--root)' };
        else {
            const sb = await require('./sandbox-phase').run(id, { root, options: { ...options, sandbox: true, noBisect: true }, analysis: { components: [], top: [] }, env });
            fs.mkdirSync(W(`retest-${n}`), { recursive: true, mode: 0o700 });
            if (fs.existsSync(W('sandbox.json'))) fs.copyFileSync(W('sandbox.json'), path.join(W(`retest-${n}`), 'sandbox.json'));
            if (fs.existsSync(W('sandbox.initial.json'))) fs.copyFileSync(W('sandbox.initial.json'), W('sandbox.json'));   // the first evidence stays the current evidence
            const was = ((readJson(W('sandbox.initial.json')) || {}).baseline || {}).active_plugins || [];
            const lacking = sb.baseline ? was.filter(p => !(sb.baseline.active_plugins || []).includes(p)) : [];
            steps = sb.steps; observed = lacking.length ? { result: 'could-not-test', reason: `the retest sandbox did not have these plugins active, which were active when the symptom was seen: ${lacking.join(', ')}. A run with fewer plugins proves nothing about the fix.` } : sb.baseline ? { ...sb.baseline } : { result: 'could-not-test', reason: (steps.find(s => s.id === 'sandbox') || {}).reason || 'the sandbox did not run' };
        }
    } else {
        const viewports = [...new Set(before.map(f => f.viewport))].filter(Boolean);
        const r = await require('./probe').run(id, { root, options: { ...options, viewports: viewports.length ? viewports.join(',') : options.viewports }, env });
        steps = r.steps || [];
        const pj = readJson(W('probe.json')) || {};
        observed = pj.oracle ? { result: pj.oracle.result, reason: pj.oracle.reason, matches: pj.oracle.matches || [], pages: (pj.pages || []).map(p => ({ url: p.url, viewport: p.viewport && (p.viewport.name || p.viewport), loaded: !!p.loaded })) } : { result: 'could-not-test', reason: (steps[0] && steps[0].reason) || 'the probe did not run' };
        fs.mkdirSync(W(`retest-${n}`), { recursive: true, mode: 0o700 });
        if (fs.existsSync(W('probe.json'))) fs.copyFileSync(W('probe.json'), path.join(W(`retest-${n}`), 'probe.json'));
        if (fs.existsSync(W('probe.initial.json'))) fs.copyFileSync(W('probe.initial.json'), W('probe.json'));   // the first evidence stays the current evidence
    }
    const cmp = compare(before, observed, { sandbox: !!options.sandbox });
    const val = readJson(W('validation.json')) || { hypotheses: [] };
    const target = hypothesis || (val.hypotheses.find(h => ['CONFIRMED', 'REPRODUCIBLE'].includes(h.status)) || {}).id || null;
    const sbx0 = readJson(W('sandbox.initial.json')) || {};
    const original = sbx0.baseline ? { ...sbx0.baseline, reproduced_in_sandbox: sbx0.reproduced_in_sandbox } : null;
    const ver = canVerify({ cmp, where: options.sandbox ? 'sandbox' : 'live probe', original, now: observed, target });
    const entry = { n, at: now(), where, verdict: cmp.verdict, reason: cmp.reason, fixed_verified: ver.ok, hypothesis: target, conditions: ver.conditions, compared: before.map(f => key(f.page, f.viewport)), oracle: { type: issue.oracle.type, value: issue.oracle.value, result: observed && observed.result } };
    if (cmp.fixed_verified && !ver.ok) entry.reason += ` NOT marked FIXED_VERIFIED: ${ver.conditions.filter(x => x.status === 'FAILED').map(x => `${x.id} (${x.reason})`).join('; ')}`;
    history.push(entry);
    fs.writeFileSync(R('retests.json'), JSON.stringify(history, null, 2) + '\n', { mode: 0o600 });
    return { entry, steps, history };
}

module.exports = { run, compare, failedBefore, canVerify };
