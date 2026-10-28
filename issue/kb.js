// The curated knowledge base (data/known-conflicts.json). Each entry names a detector, implemented here as code. A hit is a hypothesis
// with its sources attached; it is never a proof. Entries that were not verified against their sources are labelled and weigh less.

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'known-conflicts.json');
const load = (file = FILE) => JSON.parse(fs.readFileSync(file, 'utf8')).entries;

const DETECTORS = {
    // at least `min` of the listed plugins are installed
    'installed-set': (e, ctx) => { const hit = ctx.installed.filter(s => e.params.slugs.includes(s)); return hit.length >= e.params.min ? { components: hit, evidence: hit.map(s => ({ component: s, file: ctx.pathOf[s] || null, line: null })), message: `${hit.length} such plugins are installed: ${hit.join(', ')}` } : null; },
    // a plugin from list `a` and one from list `b` are both installed
    'pair-installed': (e, ctx) => { const a = ctx.installed.filter(s => e.params.a.includes(s)), b = ctx.installed.filter(s => e.params.b.includes(s)); return a.length && b.length ? { components: [...a, ...b], evidence: [...a, ...b].map(s => ({ component: s, file: ctx.pathOf[s] || null, line: null })), message: `${a.join(', ')} is installed together with ${b.join(', ')}` } : null; },
    'woocommerce-with-cache': (e, ctx) => { if (!ctx.installed.includes('woocommerce')) return null; const c = ctx.installed.filter(s => e.params.cache_slugs.includes(s)), d = ctx.dropins.filter(x => e.params.dropins.includes(x)); return c.length || d.length ? { components: ['woocommerce', ...c], evidence: [...c.map(s => ({ component: s, file: ctx.pathOf[s] || null, line: null })), ...d.map(x => ({ component: `dropin:${x}`, file: `wp-content/${x}`, line: null }))], message: `WooCommerce is installed and a page cache is active (${[...c, ...d].join(', ')})` } : null; },
    observation: (e, ctx) => { const hits = ctx.observations.filter(o => o.type === e.params.type && (!e.params.handle || o.handle === e.params.handle)); return hits.length ? { components: [...new Set(hits.flatMap(o => o.components))], evidence: hits.flatMap(o => o.evidence).slice(0, 8), observation_ids: hits.map(o => o.id), message: hits.map(o => o.message).slice(0, 3).join('; ') } : null; },
    collision: (e, ctx) => { const types = e.params.types || [e.params.type]; const hits = ctx.collisions.filter(c => types.includes(c.type) && !c.weak); return hits.length ? { components: [...new Set(hits.flatMap(c => c.components))], evidence: hits.flatMap(c => c.evidence).slice(0, 8), collision_ids: hits.map(c => c.id), message: hits.map(c => c.message).slice(0, 3).join('; ') } : null; },
    'hook-contention': (e, ctx) => {
        const by = new Map();
        for (const [ref, m] of Object.entries(ctx.facts)) for (const h of m.hooks) if (h.op === 'add' && h.hook === e.params.hook) { if (!by.has(ref)) by.set(ref, []); by.get(ref).push(h); }
        if (by.size < e.params.min) return null;
        const comps = [...by.keys()].sort();
        return { components: comps, evidence: comps.flatMap(c => by.get(c).slice(0, 1).map(h => ({ component: c, file: h.file, line: h.line, priority: h.priority }))), message: `${comps.join(', ')} all add a callback to ${e.params.hook}` };
    }
};

// ctx: { components, facts, observations, collisions }. -> hits
function evaluate(ctx, entries = load()) {
    const installed = ctx.components.filter(c => c.kind === 'plugin').map(c => c.slug);
    const full = { ...ctx, installed, dropins: ctx.components.filter(c => c.kind === 'dropin').map(c => c.slug), pathOf: Object.fromEntries(ctx.components.map(c => [c.slug, c.path])) };
    const hits = [], not_applicable = [];
    for (const e of entries) {
        const d = DETECTORS[e.detector];
        if (!d) { hits.push({ id: e.id, error: `unknown detector "${e.detector}"` }); continue; }
        const r = d(e, full);
        if (!r) continue;
        // detected, but not relevant to THIS report: listed, never turned into a hypothesis
        if (e.symptoms && ctx.symptom && ctx.symptom !== 'other' && !e.symptoms.includes(ctx.symptom)) { not_applicable.push({ id: e.id, title: e.title, reason: `it explains ${e.symptoms.filter(x => x !== 'other').join(' / ')} problems, not "${ctx.symptom}"`, ...r }); continue; }
        if (e.requires_clue_types && !(ctx.clueTypes || []).some(t => e.requires_clue_types.includes(t))) { not_applicable.push({ id: e.id, title: e.title, reason: `the evidence has no ${e.requires_clue_types.join(' / ')} clue, and this pattern is common on healthy sites`, ...r }); continue; }
        hits.push({ id: e.id, title: e.title, family: e.family || 'cache', verified: !!e.verified, causes: e.causes, change: e.change, beyond_sources: e.beyond_sources || null, sources: e.sources, ...r });
    }
    hits.sort((a, b) => a.id.localeCompare(b.id));
    hits.not_applicable = not_applicable.sort((a, b) => a.id.localeCompare(b.id));
    return hits;
}

module.exports = { load, evaluate, DETECTORS, FILE };
