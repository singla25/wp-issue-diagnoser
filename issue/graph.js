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

const fs = require('fs');
const path = require('path');
const corehandles = require('./corehandles');
const schema = require('../lib/schema');

const TRANSFORM_HOOKS = ['the_content', 'the_title', 'the_excerpt', 'script_loader_tag', 'style_loader_tag', 'rest_authentication_errors', 'wp_mail', 'authenticate', 'login_redirect', 'wp_nav_menu_items', 'upload_mimes'];
const MAX_EDGES = 2000;
// Options WordPress itself creates and uses (an explicit list, no wildcards). It is joined with the names read from THIS site's wp-admin/includes/schema.php, so a site
// whose schema.php is missing still does not report them. A plugin's own option (myplugin_settings) is not here and is still reported.
const CORE_OPTIONS = new Set(['active_plugins', 'admin_email', 'admin_email_lifespan', 'auto_plugin_theme_update_emails', 'auto_update_core_major', 'auto_update_core_minor', 'auto_update_plugins', 'auto_update_themes',
    'avatar_default', 'avatar_rating', 'blog_charset', 'blog_public', 'blogdescription', 'blogname', 'can_compress_scripts', 'category_base', 'close_comments_days_old', 'close_comments_for_old_posts', 'comment_max_links',
    'comment_moderation', 'comment_order', 'comment_previously_approved', 'comment_registration', 'comments_notify', 'comments_per_page', 'cron', 'current_theme', 'date_format', 'db_upgraded', 'db_version',
    'default_category', 'default_comment_status', 'default_comments_page', 'default_email_category', 'default_link_category', 'default_ping_status', 'default_pingback_flag', 'default_post_format', 'default_role',
    'fresh_site', 'gmt_offset', 'hack_file', 'home', 'html_type', 'image_default_align', 'image_default_link_type', 'image_default_size', 'initial_db_version', 'large_size_h', 'large_size_w', 'links_updated_date_format',
    'mailserver_login', 'mailserver_pass', 'mailserver_port', 'mailserver_url', 'medium_large_size_h', 'medium_large_size_w', 'medium_size_h', 'medium_size_w', 'moderation_keys', 'moderation_notify',
    'page_comments', 'page_for_posts', 'page_on_front', 'permalink_structure', 'ping_sites', 'posts_per_page', 'posts_per_rss', 'recently_activated', 'recently_edited', 'require_name_email', 'rewrite_rules', 'rss_use_excerpt',
    'show_avatars', 'show_comments_cookies_opt_in', 'show_on_front', 'sidebars_widgets', 'siteurl', 'site_icon', 'start_of_week', 'sticky_posts', 'stylesheet', 'tag_base', 'template', 'thread_comments',
    'thread_comments_depth', 'thumbnail_crop', 'thumbnail_size_h', 'thumbnail_size_w', 'time_format', 'timezone_string', 'uninstall_plugins', 'upload_path', 'upload_url_path', 'uploads_use_yearmonth_folders',
    'use_balanceTags', 'use_smilies', 'use_trackback', 'users_can_register', 'WPLANG', 'wp_page_for_privacy_policy', 'wp_force_deactivated_plugins']);
const WEAK = new Set(['shared-option', 'hook-same-priority']); // not followed when growing the slice from a seed past depth 1

// ---- one vendor, a core plugin and its Pro/Premium/Plus edition ----
// Two plugins are a same-vendor pair when one folder name is the other + "-pro", "-premium" or "-plus" AND their plugin headers give the same Author. Both are the plugins'
// own words about themselves (self-declared): this is not a check of where either copy came from. Names such a pair shares (a JavaScript object, a setting, a hook) are meant to be shared.
const PRO_SUFFIX = /^(.+)-(pro|premium|plus)$/;
const normAuthor = a => String(a || '').toLowerCase().replace(/\s+/g, ' ').replace(/[.\s]+$/, '').trim();
const headOf = (root, c) => { try { const fd = fs.openSync(path.join(root, c.main_file), 'r'); try { const b = Buffer.alloc(8192); return b.toString('utf8', 0, fs.readSync(fd, b, 0, 8192, 0)); } finally { fs.closeSync(fd); } } catch { return ''; } };
const authorOf = head => { const m = /^[ \t/*#@]*Author:(.*)$/mi.exec(head); return m ? m[1].replace(/\s*\*\/.*$/, '').trim() : ''; };
const verCmp = (a, b) => { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d < 0 ? -1 : 1; } return 0; };
// the core version the Pro header asks for: "Requires Elementor: 3.20", "Elementor requires at least: 3.20" or "Requires Plugins: elementor (>= 3.20)"
function requiredCore(head, core) {
    const keys = [core.slug, core.name].filter(Boolean).map(k => String(k).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    for (const k of keys) {
        let m = new RegExp(`^[ \\t/*#@]*Requires\\s+${k}\\s*:\\s*v?(\\d+(?:\\.\\d+)*)`, 'mi').exec(head) || new RegExp(`^[ \\t/*#@]*${k}\\s+requires(?:\\s+at\\s+least)?\\s*:\\s*v?(\\d+(?:\\.\\d+)*)`, 'mi').exec(head)
            || new RegExp(`^[ \\t/*#@]*Requires Plugins:[^\\n]*\\b${k}\\b[^\\n\\d]*(\\d+(?:\\.\\d+)+)`, 'mi').exec(head);
        if (m) return m[1];
    }
    return null;
}
// -> [{ core: ref, pro: ref, core_name, pro_name, core_version, pro_version, requires_core, core_older }]
function vendorPairs(root, components) {
    const plugins = (components || []).filter(c => c.kind === 'plugin' && c.slug && c.main_file);
    const out = [];
    for (const pro of plugins) {
        const m = PRO_SUFFIX.exec(pro.slug); if (!m) continue;
        const core = plugins.find(c => c.slug === m[1]); if (!core) continue;
        const ph = headOf(root, pro), a = normAuthor(authorOf(ph)), b = normAuthor(authorOf(headOf(root, core)));
        if (!a || a !== b) continue;
        const req = requiredCore(ph, { slug: core.slug, name: core.name });
        out.push({ core: core.ref, pro: pro.ref, core_name: core.name || core.slug, pro_name: pro.name || pro.slug, core_version: core.version || null, pro_version: pro.version || null,
            requires_core: req, core_older: !!(req && core.version && verCmp(core.version, req) < 0) });
    }
    return out.sort((x, y) => (x.pro < y.pro ? -1 : x.pro > y.pro ? 1 : 0));
}
const pairKey = (a, b) => [a, b].sort().join('|');
// the lines the report shows for these pairs. `shared` = the pairs for which a shared name was left out. Exactly these words (the names are the plugins' own).
function vendorLines(pairs, shared) {
    const out = [];
    for (const p of pairs || []) {
        if ((shared || []).includes(pairKey(p.core, p.pro))) out.push(`${p.core_name} and ${p.pro_name} are made by the same vendor and are meant to work together, so sharing names between them is expected. This says nothing about where the copy came from.`);
        if (p.core_older) out.push(`${p.pro_name} asks for ${p.core_name} ${p.requires_core} or newer, and ${p.core_name} ${p.core_version} is installed.`);
    }
    return out;
}

function build(root, analysis, collide, { featureHooks = [] } = {}) {
    const refs = new Set(analysis.components.map(c => c.ref));
    const byRef = Object.fromEntries(analysis.components.map(c => [c.ref, c]));
    const edges = [], problems = [];
    const pairs = vendorPairs(root, analysis.components), vendorSet = new Set(pairs.map(p => pairKey(p.core, p.pro))), sharedPairs = new Set();
    const sameVendor = (a, b) => vendorSet.has(pairKey(a, b));
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
            if (sameVendor(comps[i], comps[j])) { sharedPairs.add(pairKey(comps[i], comps[j])); continue; }
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
        if (!o.name || copts.names.has(o.name) || CORE_OPTIONS.has(o.name)) continue;
        if (!opt.has(o.name)) opt.set(o.name, new Map());
        const e = opt.get(o.name).get(ref) || { write: false, read: false, file: o.file, line: o.line };
        if (o.op === 'get') e.read = true; else { e.write = true; e.file = o.file; e.line = o.line; }
        opt.get(o.name).set(ref, e);
    }
    for (const [name, by] of [...opt].sort((a, b) => a[0].localeCompare(b[0]))) {
        const comps = [...by.keys()].sort();
        if (comps.length < 2 || !comps.some(c => by.get(c).write)) continue;
        for (let i = 0; i < comps.length; i++) for (let j = i + 1; j < comps.length; j++) if (by.get(comps[i]).write || by.get(comps[j]).write) {
            if (sameVendor(comps[i], comps[j])) { sharedPairs.add(pairKey(comps[i], comps[j])); continue; }
            add({ type: 'shared-option', from: comps[i], to: comps[j], key: name, option: name, why: `both use the option "${name}" and at least one writes it`, evidence: [{ component: comps[i], ...by.get(comps[i]) }, { component: comps[j], ...by.get(comps[j]) }] });
        }
    }
    const cpt = new Map();
    for (const [ref, m] of Object.entries(analysis.facts)) for (const c of [...m.cpts, ...m.taxonomies]) { if (!cpt.has(c.name)) cpt.set(c.name, new Map()); if (!cpt.get(c.name).has(ref)) cpt.get(c.name).set(ref, c); }
    for (const [name, by] of [...cpt].sort((a, b) => a[0].localeCompare(b[0]))) {
        const comps = [...by.keys()].sort();
        for (let i = 0; i < comps.length; i++) for (let j = i + 1; j < comps.length; j++) add({ type: 'duplicate-post-type', from: comps[i], to: comps[j], key: name, why: `both register "${name}"`, evidence: [{ component: comps[i], file: by.get(comps[i]).file, line: by.get(comps[i]).line }, { component: comps[j], file: by.get(comps[j]).file, line: by.get(comps[j]).line }] });
    }

    // ---- earlier findings that involve two or more components ----
    for (const o of analysis.observations) { const cs = [...new Set(o.components)].sort(); for (let i = 0; i < cs.length; i++) for (let j = i + 1; j < cs.length; j++) add({ type: `observation:${o.type}`, from: cs[i], to: cs[j], key: o.id, why: o.message, ref: o.id, evidence: o.evidence }); }
    for (const p of (collide && collide.same_vendor) || []) sharedPairs.add(pairKey(p.components[0], p.components[1]));
    for (const c of (collide && collide.collisions) || []) { const cs = [...new Set(c.components)].sort(); for (let i = 0; i < cs.length; i++) for (let j = i + 1; j < cs.length; j++) add({ type: `collision:${c.type}`, from: cs[i], to: cs[j], key: c.id, why: c.message, ref: c.id, evidence: c.evidence }); }

    edges.sort((a, b) => a.type.localeCompare(b.type) || a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.id.localeCompare(b.id));
    const truncated = edges.length > MAX_EDGES;
    const nodes = analysis.components.map(c => ({ ref: c.ref, name: c.name, kind: c.kind, version: c.version, ownership: c.ownership, inspection_only: c.inspection_only, updated_at: c.updated_at }));
    nodes.push({ ref: 'wordpress-core', name: 'WordPress core', kind: 'core', version: core.version || null, ownership: 'protected', inspection_only: true });
    return { nodes, edges: edges.slice(0, MAX_EDGES), edges_total: edges.length, truncated, problems, relevant_hooks: [...relevant].sort(), core_options_known: copts.known,
        ...(pairs.length ? { same_vendor: { pairs: pairs.map(p => ({ ...p, shared: sharedPairs.has(pairKey(p.core, p.pro)) })), lines: vendorLines(pairs, [...sharedPairs]) } } : {}) };
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

module.exports = { build, slice, TRANSFORM_HOOKS, CORE_OPTIONS, vendorPairs, vendorLines, pairKey };
