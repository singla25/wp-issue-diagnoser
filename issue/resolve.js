// Resolution plans: for every validated hypothesis, the options a person (or a separate Claude Code session) can take, each labelled by WHO may
// do it and carrying the verification it has had. Nothing here changes the site. Five option types:
//   patch     custom code, ownership-gated, a unified diff in result/patches/ (deterministic generators, see patchgen.js)
//   shim      a must-use plugin in result/patches/shims/ (shim.js)
//   settings  a setting named by the knowledge base (no verified option names are stored yet, so these are guidance, labelled as such)
//   plugin    deactivate / replace / update a plugin, saying which features the feature table says it provides
//   human     protected code, premium plugin, no safe automatic fix
// Labels: "you-can-do-this" (a patch or settings step the owner applies by hand), "send-to-claude-code" (custom, allowlisted, goes to tasks.md),
// "needs-a-human" (a decision or protected code).

const fs = require('fs');
const path = require('path');
const patchgen = require('./patchgen');
const shim = require('./shim');
const ownership = require('../lib/ownership');

const SETTINGS_FILE = path.join(__dirname, '..', 'data', 'known-settings.json');
let semver = null; try { semver = require('semver'); } catch { /* optional: without it the version is reported as unknown */ }
const loadSettings = () => { try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')).entries; } catch { return []; } };
// where does the installed version stand against the versions the setting was READ in?
function versionStatus(entry, installed) {
    const r = entry.versions && entry.versions.range;
    if (!r) return { status: 'unknown', note: 'the source states no version: the setting is described as the documentation names it today' };
    const v = semver && installed ? semver.coerce(installed) : null;
    if (!v) return { status: 'unknown', note: `the installed version ${installed || '(not known)'} could not be compared; verified for ${r.min}${r.max ? '-' + r.max : '+'} only` };
    const okMin = !r.min || semver.gte(v, r.min), okMax = !r.max || semver.lte(v, r.max);
    return okMin && okMax ? { status: 'in-range', note: `installed ${installed} is inside the verified range ${r.min}-${r.max || 'open'}` } : { status: 'outside-range', note: `installed ${installed} is OUTSIDE the range ${r.min}-${r.max || 'open'} this setting was read in: the label or key may differ in your version` };
}

const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

function build(id, validation, { root, policy, dir }) {
    const W = f => path.join(dir, 'work', f);
    const custom = readJson(W('custom-code.json')) || { observations: [] }, index = readJson(W('feature-index.json')) || { providers: [] };
    const comps = (readJson(W('components.json')) || { components: [] }).components;
    const obsById = new Map((custom.observations || []).map(o => [o.id, o]));
    const edgeById = new Map(((readJson(W('graph.json')) || {}).edges || []).map(e => [e.id, e]));
    const plans = [];
    for (const h of validation.hypotheses) {
        if (h.status === 'REJECTED_FALSE_POSITIVE') continue;
        const obs = h.supports.map(s => (s.kind === 'observation' ? obsById.get(s.ref) : null)).find(Boolean) || null;
        const options = [];
        // ---- 1. custom code patches (one per custom evidence location) ----
        if (obs && root) {
            for (const ev of obs.evidence.filter(e => e.file)) {
                if (!['custom', 'unknown', 'protected', 'rejected'].includes(ev.ownership || '')) continue;
                const g = patchgen.generate(obs, ev, { root, policy, workDir: path.join(dir, 'work') });
                if (g.skipped) { if (g.generator !== null || ev.ownership === 'custom') options.push({ type: 'human', who: 'needs-a-human', title: `${ev.file}:${ev.line || '?'}`, detail: `no automatic patch: ${g.skipped}`, verification: [] }); continue; }
                options.push({ type: 'patch', who: g.ok ? 'send-to-claude-code' : 'needs-a-human', title: g.summary, detail: g.why, file: g.rel, line: ev.line, generator: g.generator, diff: g.diff, verification: g.validation, verified: g.ok,
                    not_verified: ['The oracle has not been re-run with this patch applied; that happens in `issue retest` (against a fixed copy or the sandbox).'] });
            }
            // ---- 2. a shim (any ownership: this is the route for code that must not be edited) ----
            const s = shim.generate(obs, { workDir: path.join(dir, 'work') });
            if (!s.skipped) options.push({ type: 'shim', who: 'you-can-do-this', title: s.summary, detail: s.why, file: s.file, php: s.php, verification: s.validation, verified: s.ok, not_verified: ['Not yet run in the sandbox with the oracle; run `issue retest` after placing it on a copy.'] });
        }
        // ---- 2b. two components at the same hook priority: both orders as candidates, the sandbox decides ----
        for (const sup of h.supports.filter(x => /^graph-relevant/.test(x.kind))) {
            for (const s of shim.generateOrder(edgeById.get(sup.ref), { workDir: path.join(dir, 'work') })) {
                if (s.skipped) { options.push({ type: 'human', who: 'needs-a-human', title: 'Hook order', detail: `no shim: ${s.skipped}`, verification: [] }); continue; }
                options.push({ type: 'shim', who: 'you-can-do-this', title: `${s.summary} (candidate; test to choose)`, detail: `TEST TO CHOOSE: this is one of TWO candidate orders and neither is the answer yet. ${s.why}`, file: s.file, php: s.php, candidate: s.candidate, test_to_choose: true, verification: s.validation, verified: s.ok, not_verified: ['TEST TO CHOOSE: one of two candidate orders. Plugin Guard cannot tell from the code which one is right; only a run in the sandbox (--sandbox) can say which one, if either, makes the symptom disappear. Do not apply either before testing both.'] });
            }
        }
        // ---- 3. settings from the knowledge base (guidance, not a verified option name) ----
        for (const k of h.kb || []) if (k && (k.change || k.title)) options.push({ type: 'settings', who: 'you-can-do-this', title: `Settings: ${k.title || k.id}`, detail: k.change || k.message || '', source: (h.kb_sources || [])[0] || null,
            verification: [], not_verified: ['The knowledge base names the change in words; it does not yet store the exact option name, so this was not applied or tested in the sandbox.'], kb_verified: h.kb_verified });
        // ---- 3b. exact settings (data/known-settings.json): label, where it is, the stored key when a primary source shows it, and the version range it was read in ----
        const symptom = (readJson(path.join(dir, 'issue.json')) || {}).symptom;
        for (const slug of (h.components || []).map(c => String(c).replace(/^plugin:/, ''))) {
            const comp = comps.find(x => (x.slug === slug || x.ref === slug) && x.kind === 'plugin');
            for (const e of loadSettings().filter(x => x.plugin.slug === slug && (x.applies_to.symptoms.includes(symptom) || symptom === 'other'))) {
                const vs = versionStatus(e, comp && comp.version);
                options.push({ type: 'settings', who: 'you-can-do-this', title: `Setting: ${e.plugin.name} > ${e.label}`, detail: `${e.effect} Try: ${e.change}`, setting: { id: e.id, label: e.label, admin_path: e.admin_path, stored_key: e.stored_key, verified_against: e.versions.verified_against }, installed_version: comp ? comp.version || null : null, version_status: vs.status,
                    verification: [{ id: 'knowledge-verified', status: e.verified ? 'PASSED' : 'NOT_RUN', reason: e.verified ? `label${e.stored_key ? ' and stored key' : ''} found on the official page / plugin source (${e.last_checked})` : 'not yet verified by guard:verify-knowledge' }, { id: 'version', status: vs.status === 'in-range' ? 'PASSED' : vs.status === 'outside-range' ? 'FAILED' : 'NOT_RUN', reason: vs.note }],
                    not_verified: [`Not applied or tested in the sandbox: this is a setting to try, not a proven fix.${e.stored_key ? '' : ' ' + e.stored_key_note}`], kb_verified: e.verified });
            }
        }
        // ---- 4. deactivate / replace / update, with the functionality that would be lost ----
        const plugins = (h.components || []).map(c => String(c).replace(/^plugin:/, '')).filter(c => comps.some(x => (x.slug === c || x.ref === c) && x.kind === 'plugin'));
        for (const slug of plugins) {
            const c = comps.find(x => x.slug === slug || x.ref === slug);
            const lost = (index.providers || []).filter(p => (p.rows || []).some(r => r.ref === slug || r.component === slug || r.name === c.name)).map(p => p.label);
            options.push({ type: 'plugin', who: 'needs-a-human', title: `Deactivate, replace or update ${c.name || slug}`, detail: `Switching off ${c.name || slug}${c.version ? ` ${c.version}` : ''} would stop: ${lost.length ? lost.join(', ') : 'whatever it provides (no feature in the table maps to it; read its description: ' + String(c.description || 'none').slice(0, 160) + ')'}. ${h.type === 'duplicate-declaration' ? 'Of the two plugins that declare the same name, deactivate the one whose features you need least, or ask its author to prefix the name.' : 'Check for an updated version first.'}`, plugin: slug, lost_features: lost, verification: [],
                not_verified: ['Which plugin to deactivate is a decision for the site owner; Plugin Guard does not make it.'] });
        }
        if (!options.length) options.push({ type: 'human', who: 'needs-a-human', title: 'No safe automatic option', detail: 'The evidence names no custom code Plugin Guard may change and no known setting or shim for this pattern.', verification: [] });
        plans.push({ hypothesis: h.id, title: h.title, status: h.status, options });
    }
    return plans;
}

module.exports = { build };
