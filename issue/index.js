// Phase D: a searchable index of every component, and the "who provides this feature" table.
//
// Two separate things, both deterministic:
//   1. EXACT signal matches: a feature's signals (taxonomy: shortcodes, blocks, REST namespaces, AJAX actions, post types, script handles,
//      hooks, template folders, well-known plugin slugs) matched against what each component really registers. Each match is evidence with file:line.
//   2. A BM25 text ranking (minisearch, no fuzzy matching, no randomness) of components against the words of the report, used to order
//      components and to show which ones the description is "about". Ties are broken by component reference.
// Taxonomy signals that are not verified against their documentation are flagged on every row that depends on them.

const fs = require('fs');
const readdir = require('../lib/sorted-dir');
const path = require('path');
const MiniSearch = require('minisearch');
const describe = require('./describe');

const ROLE_WEIGHT = { provides: 5, overrides: 4, extends: 3, alters: 3, 'known-provider': 3, caches: 3, loads: 1 };
const ROLE_ORDER = ['provides', 'known-provider', 'overrides', 'extends', 'alters', 'caches', 'loads'];
const BOOST = { name: 2, slug: 2, shortcodes: 3, blocks: 3, rest: 2, ajax: 2, handles: 2, cpts: 2, tags: 1.5, description: 1, hooks: 1, menus: 1, templates: 1, requires: 1 };
// A row is a claim "component X is involved in feature F" resting on taxonomy signals. When NONE of the signals behind a row was found in
// official documentation, the role weights are multiplied by this factor (printed in ROW_SCORING and written into feature-index.json).
const UNVERIFIED_ROW_FACTOR = 0.5;
const BM25_MAX_POINTS = 2;
const ROW_SCORING = { role_weights: ROLE_WEIGHT, unverified_row_factor: UNVERIFIED_ROW_FACTOR, bm25_max_points: BM25_MAX_POINTS,
    rules: ['row score = sum of the role weights of the roles found, plus up to bm25_max_points for how well the component matches the words of the report',
        'if no signal behind the row is verified against official documentation, the role weights (not the text-match points) are multiplied by unverified_row_factor',
        'a row with at least one verified signal keeps full weight'] };
const round = n => Math.round(n * 10000) / 10000;
const low = s => String(s).toLowerCase();

// "=== Name ===\nContributors: ...\nTags: a, b, c\n...\n\nShort description line" -> { tags, short }
function readme(abs) {
    let t; try { const fd = fs.openSync(abs, 'r'); const b = Buffer.alloc(16384); const n = fs.readSync(fd, b, 0, 16384, 0); fs.closeSync(fd); t = b.toString('utf8', 0, n); } catch { return { tags: [], short: null }; }
    const tags = (/^Tags:\s*(.+)$/mi.exec(t) || [])[1];
    const after = t.split(/\r?\n\r?\n/).slice(1).map(x => x.trim()).find(x => x && !/^==/.test(x) && !/^[A-Z][\w ]*:\s/.test(x));
    return { tags: tags ? tags.split(',').map(x => x.trim()).filter(Boolean).slice(0, 20) : [], short: after ? after.replace(/\s+/g, ' ').slice(0, 300) : null };
}
function templateFiles(dir) { // names of template files shipped by a plugin or a theme (names only, capped)
    const out = [];
    for (const sub of ['templates', 'woocommerce']) {
        (function w(d, base) { let es; try { es = readdir(d, { withFileTypes: true }); } catch { return; } es.sort((a, b) => a.name.localeCompare(b.name)); for (const e of es) { if (e.isSymbolicLink() || out.length >= 300) continue; const f = path.join(d, e.name); if (e.isDirectory()) w(f, `${base}${e.name}/`); else if (/\.php$/.test(e.name)) out.push({ path: `${sub}/${base}${e.name}`, file: f }); } })(path.join(dir, sub), '');
    }
    return out;
}

const uniq = a => [...new Set(a)];
// Components -> documents. `analysis` is the result of custom.analyse(); `root` the WordPress root.
function documents(root, analysis) {
    return analysis.components.map(c => {
        const f = analysis.facts[c.ref], abs = path.join(root, c.path);
        const rd = c.kind === 'plugin' && !c.path.endsWith('.php') ? readme(path.join(abs, 'readme.txt')) : { tags: [], short: null };
        const tpl = c.kind === 'dropin' || c.path.endsWith('.php') ? [] : templateFiles(abs);
        const rest = f.rest.map(r => `${r.namespace}${r.route ? '/' + String(r.route).replace(/^\//, '') : ''}`);
        return {
            id: c.ref, ref: c.ref, name: c.name, slug: c.slug, kind: c.kind, version: c.version, ownership: c.ownership, depth: c.depth, inspection_only: c.inspection_only,
            description: [c.description, rd.short].filter(Boolean).join(' '), tags: rd.tags.join(' '), requires: (c.requires_plugins || []).join(' '),
            hooks: uniq(f.hooks.map(h => h.hook || h.prefix).filter(Boolean)).join(' '), shortcodes: uniq(f.shortcodes.map(s => s.tag)).join(' '), blocks: uniq(f.blocks.map(b => b.name)).join(' '),
            rest: uniq(rest).join(' '), ajax: uniq(f.ajax.map(a => a.action)).join(' '), handles: uniq(f.assets.map(a => a.handle)).join(' '),
            cpts: uniq([...f.cpts, ...f.taxonomies].map(x => x.name)).join(' '), menus: uniq(f.menus.map(m => m.slug)).join(' '), templates: tpl.map(t => t.path).join(' '),
            _templates: tpl, _rest: rest
        };
    });
}

// words of the report, unstemmed, without stop words, plus identifiers from clues; sorted so the query string is stable
function queryTerms(evidence, description) {
    const words = describe.words([description.title, description.text].filter(Boolean).join(' ')).filter(w => !describe.STOP.has(w) && w.length > 2 && !/^\d/.test(w));
    const fromClues = [];
    for (const c of evidence.clues || []) {
        if (c.type === 'component-path') fromClues.push(String(c.value).replace(/^[a-z]+:/, ''));
        else if (['rest-route', 'ajax-action'].includes(c.type)) fromClues.push(c.value);
        else if (c.type === 'js-not-defined' && c.detail && c.detail.symbol) fromClues.push(c.detail.symbol.replace(/[$]/g, ''));
    }
    for (const f of evidence.features || []) fromClues.push(f.id);
    return uniq([...words, ...fromClues.flatMap(x => describe.words(x))].filter(w => w.length > 2)).sort();
}

function build(root, analysis, evidence, { description = { title: '', text: '' }, taxonomy = describe.loadTaxonomy() } = {}) {
    const docs = documents(root, analysis).sort((a, b) => a.ref.localeCompare(b.ref));
    const ms = new MiniSearch({ fields: Object.keys(BOOST), storeFields: ['ref'], idField: 'id', searchOptions: { boost: BOOST, combineWith: 'OR', prefix: false, fuzzy: false } });
    ms.addAll(docs);
    const terms = queryTerms(evidence, description);
    const hits = terms.length ? ms.search(terms.join(' ')) : [];
    const text_matches = hits.map(h => ({ ref: h.ref, score: round(h.score), terms: [...h.queryTerms].sort(), fields: Object.keys(h.match).sort() })).sort((a, b) => b.score - a.score || a.ref.localeCompare(b.ref)).slice(0, 15);
    const bm25 = Object.fromEntries(text_matches.map(h => [h.ref, h.score]));
    const maxBm = Math.max(0, ...Object.values(bm25));

    const tax = Object.fromEntries(taxonomy.map(t => [t.id, t]));
    const providers = [];
    for (const ef of evidence.features || []) {
        const entry = tax[ef.id]; if (!entry) continue;
        const sig = entry.signals || {}, rows = [];
        for (const d of docs) {
            const f = analysis.facts[d.ref], ev = [], roles = new Set();
            const vsig = (k, v) => ((entry.verified_signals || {})[k] || []).map(low).includes(low(v));
            const add = (role, kind, value, file, line, sigKind, sigVal) => { roles.add(role); ev.push({ role, kind, value, file: file || null, line: line || null, signal_verified: sigKind ? vsig(sigKind, sigVal) : null }); };
            if ((sig.plugins || []).map(low).includes(low(d.slug)) && d.kind === 'plugin') add('known-provider', 'plugin-slug', d.slug, d.path, null, 'plugins', d.slug);
            for (const s of f.shortcodes) if ((sig.shortcodes || []).map(low).includes(low(s.tag))) add('provides', 'shortcode', s.tag, s.file, s.line, 'shortcodes', s.tag);
            for (const b of f.blocks) if ((sig.blocks || []).map(low).includes(low(b.name))) add('provides', 'block', b.name, b.file, b.line, 'blocks', b.name);
            for (const r of f.rest) { const full = `${r.namespace}${r.route ? '/' + String(r.route).replace(/^\//, '') : ''}`; for (const want of sig.rest || []) if (low(full).startsWith(low(want)) || low(want).startsWith(low(r.namespace) + '/')) add('provides', 'rest-route', full, r.file, r.line, 'rest', want); }
            for (const a of f.ajax) if ((sig.ajax || []).map(low).includes(low(a.action))) add('provides', 'ajax-action', a.action, a.file, a.line, 'ajax', a.action);
            for (const c of [...f.cpts, ...f.taxonomies]) if ((sig.cpts || []).map(low).includes(low(c.name))) add('provides', 'post-type', c.name, c.file, c.line, 'cpts', c.name);
            for (const a of f.assets) if ((a.op === 'register' || a.op === 'enqueue') && (sig.handles || []).map(low).includes(low(a.handle))) add('loads', `${a.type}-handle`, a.handle, a.file, a.line, 'handles', a.handle);
            for (const h of f.hooks) if (h.hook && (sig.hooks || []).includes(h.hook)) add(h.op === 'add' ? 'extends' : 'alters', h.op === 'add' ? 'hook-added' : 'hook-removed', `${h.hook}${h.priority !== null && h.priority !== undefined ? ` @${h.priority}` : ''}`, h.file, h.line, 'hooks', h.hook);
            if (d.kind === 'dropin' && (sig.dropins || []).includes(d.slug)) add('caches', 'drop-in', d.slug, d.path, null, 'dropins', d.slug);
            if (d.kind === 'theme') for (const t of d._templates) if ((sig.templates || []).some(p => t.path.replace(/^woocommerce\//, 'woocommerce/').startsWith(p.replace(/^woocommerce\//, 'woocommerce/')))) add('overrides', 'template-file', t.path, path.relative(root, t.file).split(path.sep).join('/'), 1, 'templates', t.path);
            if (!ev.length) continue;
            const best = ROLE_ORDER.find(r => roles.has(r));
            const rawRoles = [...roles].reduce((s, r) => s + ROLE_WEIGHT[r], 0), verifiedCount = ev.filter(e => e.signal_verified === true).length;
            const allUnverified = verifiedCount === 0, factor = allUnverified ? UNVERIFIED_ROW_FACTOR : 1;
            const text = maxBm ? BM25_MAX_POINTS * ((bm25[d.ref] || 0) / maxBm) : 0;
            const score = rawRoles * factor + text;
            rows.push({ component: d.ref, name: d.name, kind: d.kind, version: d.version, ownership: d.ownership, role: best, roles: ROLE_ORDER.filter(r => roles.has(r)), score: round(score),
                all_signals_unverified: allUnverified, weight_factor: factor, score_parts: { roles_raw: rawRoles, roles_weighted: round(rawRoles * factor), text_match: round(text) }, evidence: ev.slice(0, 12), evidence_total: ev.length });
        }
        rows.sort((a, b) => b.score - a.score || a.component.localeCompare(b.component));
        const mark = x => (x.all_signals_unverified ? ' [signals unverified, reduced weight]' : '');
        const named = (role, label, keep = () => true) => { const r = rows.filter(x => x.roles.includes(role) && keep(x)); return r.length ? `${label} ${r.map(x => `${x.name}${x.ownership === 'custom' ? ' (custom)' : ''}${x.version ? ' ' + x.version : ''}${mark(x)}`).join(', ')}` : null; };
        const overrides = rows.filter(x => x.roles.includes('overrides')).map(x => `${x.name}: ${x.evidence.filter(e => e.role === 'overrides').slice(0, 3).map(e => `${e.file}:${e.line}`).join(', ')}`);
        const parts = [
            named('provides', 'provided by'), (() => { const k = rows.filter(x => x.role === 'known-provider'); return k.length ? `known provider plugin: ${k.map(x => x.name + mark(x)).join(', ')}` : null; })(),
            named('extends', 'extended by', x => !x.roles.includes('provides') && !x.roles.includes('known-provider')), named('alters', 'altered (hooks removed) by'), overrides.length ? `template overrides in ${overrides.join('; ')}` : null,
            (() => { const c = rows.filter(x => x.roles.includes('caches') || (entry.id === 'cache' && x.role === 'known-provider')); return c.length && entry.id !== 'cache' ? `caching: ${c.map(x => x.name).join(', ')}` : null; })()
        ].filter(Boolean);
        providers.push({ feature: entry.id, label: entry.label, matched_phrase: ef.matched, signals_verified: !!entry.verified, signals_verified_count: Object.values(entry.verified_signals || {}).flat().length, signals_total: Object.values(entry.signals || {}).flat().length, rows,
            summary: rows.length ? `${entry.label}: ${parts.join('; ')}.${entry.verified ? '' : ` (${Object.values(entry.verified_signals || {}).flat().length} of ${Object.values(entry.signals || {}).flat().length} taxonomy signals for this feature were checked against official documentation; the rest were not)`}` : `${entry.label}: no installed component matched this feature's signals (it may be provided by something this index cannot see).` });
    }
    providers.sort((a, b) => a.feature.localeCompare(b.feature));
    return { scoring: ROW_SCORING, query: { terms }, text_matches, providers, components: docs.map(({ _templates, _rest, ...d }) => ({ ...d, templates: undefined, template_count: _templates.length })) };
}

module.exports = { ROW_SCORING, UNVERIFIED_ROW_FACTOR, build, documents, queryTerms, readme, BOOST, ROLE_WEIGHT };
