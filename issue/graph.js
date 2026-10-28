// Phase E: a graph of components and the relations between them, then a slice of it around the components that matter for THIS issue.
//
// Edge types
//   declared-dependency   "Requires Plugins" header, or a child theme's parent
//   implied-dependency    code that only works with another plugin (lib/implied.js), without declaring it
//   hook-same-priority    two components add the same (relevant) hook at the same priority
//   hook-removal          one component removes a callback another one added (see observations)
//   asset-dependency      a script/style handle depends on a handle another component (or core) registers
//   shared-option         one component writes an option another one also uses (options WordPress itself creates are ignored)
//   duplicate-post-type   two components register the same post type / taxonomy
//   observation / collision   every observation and collision from earlier steps that involves two components
// A "relevant" hook is one of the issue's feature hooks or a filter that plugins commonly use to transform shared output (a heuristic
// list, not a claim). Nothing here is a verdict: an edge says "these two touch the same thing", and the hypotheses step decides what it means.

const corehandles = require('./corehandles');
const schema = require('../lib/schema');

const TRANSFORM_HOOKS = ['the_content', 'the_title', 'the_excerpt', 'script_loader_tag', 'style_loader_tag', 'rest_authentication_errors', 'wp_mail', 'authenticate', 'login_redirect', 'wp_nav_menu_items', 'upload_mimes'];
const MAX_EDGES = 2000;
const WEAK = new Set(['shared-option', 'hook-same-priority']); // not followed when growing the slice from a seed past depth 1

function build(root, analysis, collide, { featureHooks = [] } = {}) {
    const refs = new Set(analysis.components.map(c => c.ref));
    const byRef = Object.fromEntries(analysis.components.map(c => [c.ref, c]));
    const edges = [], problems = [];
    const add = e => edges.push({ id: schema.stableId('edge', e.type, e.from, e.to, e.key || ''), directed: false, ...e });
    const relevant = new Set([...TRANSFORM_HOOKS, ...featureHooks]);

    for (const c of analysis.components) {
        for (const d of c.requires_plugins || []) {
            if (refs.has(d)) add({ type: 'declared-dependency', from: c.ref, to: d, directed: true, why: `${c.ref} declares "Requires Plugins: ${d}"`, evidence: [] });
            else problems.push({ type: 'missing-declared-dependency', component: c.ref, missing: d, why: `${c.ref} declares that it requires "${d}", which is not installed` });
        }
        if (c.kind === 'theme' && c.parent_theme) {
            if (refs.has(`theme:${c.parent_theme}`)) add({ type: 'declared-dependency', from: c.ref, to: `theme:${c.parent_theme}`, directed: true, why: `${c.ref} is a child of theme ${c.parent_theme}`, evidence: [] });
            else problems.push({ type: 'missing-parent-theme', component: c.ref, missing: c.parent_theme, why: `${c.ref} is a child theme of "${c.parent_theme}", which is not installed` });
        }
        for (const im of c.implied || []) {
            if (im.slug === c.slug) continue;
            if (refs.has(im.slug)) add({ type: 'implied-dependency', from: c.ref, to: im.slug, directed: true, why: `${c.ref}'s code only works with ${im.slug}${im.soft ? ' (it checks for it first)' : ' and does not check for it'}`, soft: !!im.soft, evidence: [] });
            else if (!im.soft && !(c.requires_plugins || []).includes(im.slug)) problems.push({ type: 'missing-implied-dependency', component: c.ref, missing: im.slug, why: `${c.ref}'s code uses ${im.slug}, which is not installed, and does not check for it first` });
        }
    }

    // ---- hooks ----
    const hookAdds = new Map();
    for (const [ref, m] of Object.entries(analysis.facts)) for (const h of m.hooks) if (h.op === 'add' && h.hook && relevant.has(h.hook) && typeof h.priority === 'number') {
        const k = `${h.hook}@${h.priority}`; if (!hookAdds.has(k)) hookAdds.set(k, new Map());
        if (!hookAdds.get(k).has(ref)) hookAdds.get(k).set(ref, { file: h.file, line: h.line, callback: h.callback && (h.callback.name || h.callback.kind) });
    }
    for (const [k, byComp] of [...hookAdds].sort((a, b) => a[0].localeCompare(b[0]))) {
        const comps = [...byComp.keys()].sort();
        for (let i = 0; i < comps.length; i++) for (let j = i + 1; j < comps.length; j++) {
            const [hook, prio] = k.split('@');
            add({ type: 'hook-same-priority', from: comps[i], to: comps[j], key: k, hook, priority: Number(prio), why: `both add a callback to ${hook} at priority ${prio}`, evidence: [{ component: comps[i], ...byComp.get(comps[i]) }, { component: comps[j], ...byComp.get(comps[j]) }] });
        }
    }

    // ---- assets: handle depends on a handle another component or core registers ----
    const owner = { script: new Map(), style: new Map() };
    for (const [ref, m] of Object.entries(analysis.facts)) for (const a of m.assets) if (a.op === 'register' || a.op === 'enqueue') { const t = owner[a.type], k = String(a.handle).toLowerCase(); if (!t.has(k)) t.set(k, new Set()); t.get(k).add(ref); }
    const core = corehandles.load(root);
    for (const [ref, m] of Object.entries(analysis.facts)) for (const a of m.assets) {
        if ((a.op !== 'register' && a.op !== 'enqueue') || !Array.isArray(a.deps)) continue;
        for (const d of a.deps) {
            const owners = [...(owner[a.type].get(String(d).toLowerCase()) || [])].filter(o => o !== ref);
            for (const o of owners) add({ type: 'asset-dependency', from: ref, to: o, directed: true, key: `${a.handle}>${d}`, why: `${a.type} "${a.handle}" depends on "${d}", registered by ${o}`, evidence: [{ component: ref, file: a.file, line: a.line }] });
        }
    }

    // ---- data: options written by one and used by another; post types registered twice ----
    const copts = corehandles.coreOptions(root);
    const opt = new Map();
    for (const [ref, m] of Object.entries(analysis.facts)) for (const o of m.options) {
        if (!o.name || copts.names.has(o.name)) continue;
        if (!opt.has(o.name)) opt.set(o.name, new Map());
        const e = opt.get(o.name).get(ref) || { write: false, read: false, file: o.file, line: o.line };
        if (o.op === 'get') e.read = true; else { e.write = true; e.file = o.file; e.line = o.line; }
        opt.get(o.name).set(ref, e);
    }
    for (const [name, by] of [...opt].sort((a, b) => a[0].localeCompare(b[0]))) {
        const comps = [...by.keys()].sort();
        if (comps.length < 2 || !comps.some(c => by.get(c).write)) continue;
        for (let i = 0; i < comps.length; i++) for (let j = i + 1; j < comps.length; j++) if (by.get(comps[i]).write || by.get(comps[j]).write)
            add({ type: 'shared-option', from: comps[i], to: comps[j], key: name, option: name, why: `both use the option "${name}" and at least one writes it`, evidence: [{ component: comps[i], ...by.get(comps[i]) }, { component: comps[j], ...by.get(comps[j]) }] });
    }
    const cpt = new Map();
    for (const [ref, m] of Object.entries(analysis.facts)) for (const c of [...m.cpts, ...m.taxonomies]) { if (!cpt.has(c.name)) cpt.set(c.name, new Map()); if (!cpt.get(c.name).has(ref)) cpt.get(c.name).set(ref, c); }
    for (const [name, by] of [...cpt].sort((a, b) => a[0].localeCompare(b[0]))) {
        const comps = [...by.keys()].sort();
        for (let i = 0; i < comps.length; i++) for (let j = i + 1; j < comps.length; j++) add({ type: 'duplicate-post-type', from: comps[i], to: comps[j], key: name, why: `both register "${name}"`, evidence: [{ component: comps[i], file: by.get(comps[i]).file, line: by.get(comps[i]).line }, { component: comps[j], file: by.get(comps[j]).file, line: by.get(comps[j]).line }] });
    }

    // ---- earlier findings that involve two or more components ----
    for (const o of analysis.observations) { const cs = [...new Set(o.components)].sort(); for (let i = 0; i < cs.length; i++) for (let j = i + 1; j < cs.length; j++) add({ type: `observation:${o.type}`, from: cs[i], to: cs[j], key: o.id, why: o.message, ref: o.id, evidence: o.evidence }); }
    for (const c of (collide && collide.collisions) || []) { const cs = [...new Set(c.components)].sort(); for (let i = 0; i < cs.length; i++) for (let j = i + 1; j < cs.length; j++) add({ type: `collision:${c.type}`, from: cs[i], to: cs[j], key: c.id, why: c.message, ref: c.id, evidence: c.evidence }); }

    edges.sort((a, b) => a.type.localeCompare(b.type) || a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.id.localeCompare(b.id));
    const truncated = edges.length > MAX_EDGES;
    const nodes = analysis.components.map(c => ({ ref: c.ref, name: c.name, kind: c.kind, version: c.version, ownership: c.ownership, inspection_only: c.inspection_only, updated_at: c.updated_at }));
    nodes.push({ ref: 'wordpress-core', name: 'WordPress core', kind: 'core', version: core.version || null, ownership: 'protected', inspection_only: true });
    return { nodes, edges: edges.slice(0, MAX_EDGES), edges_total: edges.length, truncated, problems, relevant_hooks: [...relevant].sort(), core_options_known: copts.known };
}

// Keep only what is within `depth` edges of the seed components. Everything else is listed, not hidden.
function slice(graph, analysis, collide, { seeds, depth = 2 }) {
    const adj = new Map();
    for (const e of graph.edges) for (const [a, b] of [[e.from, e.to], [e.to, e.from]]) { if (!adj.has(a)) adj.set(a, []); adj.get(a).push({ to: b, type: e.type }); }
    const dist = new Map();
    let frontier = [...new Set(seeds)].filter(s => graph.nodes.some(n => n.ref === s)).sort();
    for (const s of frontier) dist.set(s, 0);
    for (let d = 1; d <= depth; d++) {
        const next = [];
        for (const n of frontier) for (const { to, type } of adj.get(n) || []) {
            if (dist.has(to) || to === 'wordpress-core') continue;
            if (d >= 2 && WEAK.has(type)) continue; // a weak edge does not pull in a node that is already two steps away
            dist.set(to, d); next.push(to);
        }
        frontier = next.sort();
    }
    const inSlice = r => dist.has(r);
    const touches = comps => comps.some(inSlice);
    const keptEdges = graph.edges.filter(e => inSlice(e.from) && inSlice(e.to));
    const rel = (list) => ({ related: list.filter(x => touches(x.components)), also_found: list.filter(x => !touches(x.components)) });
    const o = rel(analysis.observations), c = rel((collide && collide.collisions) || []);
    return { seeds: [...new Set(seeds)].sort(), depth, nodes: [...dist].map(([ref, distance]) => ({ ref, distance })).sort((a, b) => a.distance - b.distance || a.ref.localeCompare(b.ref)), edges: keptEdges, edges_dropped: graph.edges.length - keptEdges.length,
        observations: o.related.map(x => x.id), collisions: c.related.map(x => x.id), also_found: { observations: o.also_found.map(x => ({ id: x.id, type: x.type, components: x.components, message: x.message })), collisions: c.also_found.map(x => ({ id: x.id, type: x.type, components: x.components, message: x.message })) } };
}

module.exports = { build, slice, TRANSFORM_HOOKS };
