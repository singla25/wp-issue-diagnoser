// Phase C (+ the facts Phase D indexes): custom code first.
//
// Depth of analysis, decided by ownership and by what the evidence points at, never by guesswork:
//   custom (inside a customPaths entry)        -> syntax tree (php-parser) over every file that passes the ownership gate
//   hinted by the evidence, or any theme       -> syntax tree, but "inspection-only": nothing here may become a fix task
//   everything else                            -> regex surface (what it offers), enough for the index
// Without a customPaths allowlist nothing is custom: the result says so and everything is inspection-only.
// Caps are in files and bytes, never in seconds, so the same tree always gives the same result.
// The host never runs the site's PHP: files are only read, parsed and (on a parse failure) `php -l`-checked.

const fs = require('fs');
const readdir = require('../lib/sorted-dir');
const path = require('path');
const semver = require('semver');
const components = require('../lib/components');
const ownership = require('../lib/ownership');
const schema = require('../lib/schema');
const phpast = require('./phpast');
const surface = require('./surface');
const compat = require('./compat');
const corehandles = require('./corehandles');

const MAX_FILES = 2500;
const INSPECT_MAX_FILES = 800;
const INSPECT_MAX_BYTES = 6 * 1024 * 1024;
const SKIP_DIRS = new Set(['node_modules', '.git', 'languages']);
const FOLDER = { plugin: 'plugins', theme: 'themes', mu: 'mu-plugins' };
// Files that build registrations in a loop over a static array, or that enqueue / register scripts and styles (the syntax tree gives their
// source paths and dependency arrays, which the regex surface does not), are parsed with the syntax tree even in third-party components.
const LOOP_REGISTRATION = /\bforeach\s*\([^)]*\)[^;{]*\{?[\s\S]{0,500}?\b(add_shortcode|add_action|add_filter|remove_action|remove_filter|wp_register_script|wp_enqueue_script|wp_register_style|wp_enqueue_style)\s*\(|\bwp_(?:enqueue|register)_(?:script|style)\s*\(/;
const posix = p => p.split(path.sep).join('/');

function walkPhp(dir, out) {
    let entries; try { entries = readdir(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
        if (out.length >= MAX_FILES) return;
        const full = path.join(dir, e.name);
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walkPhp(full, out); }
        else if (/\.(php|phtml|php5)$/i.test(e.name)) out.push(full);
    }
}
const siteRel = (root, abs) => posix(path.relative(root, abs));

function componentRel(c) { return c.kind === 'dropin' ? `wp-content/${c.slug}` : c.single ? `wp-content/${FOLDER[c.kind]}/${path.basename(c.main)}` : `wp-content/${FOLDER[c.kind]}/${c.slug}`; }

// Run the syntax tree over the files of one component that the gate allows. -> { facts: [per file], stats }
function deepFacts(root, comp, policy, { onlyCustomFiles, capped }) {
    const files = [];
    if (comp.single) files.push(comp.dir === path.dirname(comp.dir) ? comp.dir : path.join(comp.dir, comp.main)); else walkPhp(comp.dir, files);
    const stats = { total: files.length, parsed: 0, failed: 0, lint_broken: 0, parser_limitation: 0, skipped_protected: 0, too_big: 0, truncated: files.length >= MAX_FILES, bytes: 0 };
    const out = [], failures = [];
    for (const abs of files) {
        const rel = siteRel(root, abs);
        const own = ownership.classify(policy, rel);
        if (own.owner === 'protected' || own.owner === 'rejected') { stats.skipped_protected++; continue; }
        if (onlyCustomFiles && own.owner !== 'custom') { stats.skipped_protected++; continue; }
        let st; try { st = fs.statSync(abs); } catch { continue; }
        if (st.size > phpast.MAX_BYTES) { stats.too_big++; continue; }
        if (capped && (out.length >= INSPECT_MAX_FILES || stats.bytes + st.size > INSPECT_MAX_BYTES)) { stats.truncated = true; break; }
        stats.bytes += st.size;
        const f = phpast.analyse(fs.readFileSync(abs, 'utf8'), rel, { watch: compat.watch });
        if (f.parsed) stats.parsed++;
        else {
            stats.failed++;
            const lint = phpast.phpLint(abs);
            f.lint = lint;
            if (lint && !lint.ok) { stats.lint_broken++; failures.push({ file: rel, line: (f.errors[0] || {}).line || null, message: lint.message || (f.errors[0] || {}).message }); }
            else if (lint && lint.ok) stats.parser_limitation++;
        }
        out.push(f);
    }
    return { facts: out, stats, failures };
}

// the regex surface of a non-deep component: one pass over its files
function surfaceFacts(root, comp, policy) {
    const files = [];
    if (comp.single) files.push(path.join(comp.dir, comp.main)); else walkPhp(comp.dir, files);
    const out = [];
    let targeted = 0;
    const scanByRel = new Map((comp.scans || []).map(s => [s.file, s]));
    for (const abs of files) {
        let st; try { st = fs.statSync(abs); } catch { continue; }
        if (st.size > phpast.MAX_BYTES) continue;
        const relInComp = posix(path.relative(comp.single ? path.dirname(abs) : comp.dir, abs));
        const text = fs.readFileSync(abs, 'utf8');
        // Registrations built in a loop over a static array (WooCommerce's shortcode table) are invisible to the regex scanner. Files that
        // look like that get the syntax tree, which resolves such arrays; every other file keeps the cheap regex surface.
        if (LOOP_REGISTRATION.test(text)) {
            const f = phpast.analyse(text, siteRel(root, abs), { watch: compat.watch });
            if (f.parsed) { f.targeted_tree = true; targeted++; out.push(f); continue; }
        }
        out.push(surface.scan(text, siteRel(root, abs), scanByRel.get(relInComp)));
    }
    return { facts: out, stats: { total: files.length, parsed: out.length, failed: 0, targeted_tree_files: targeted, truncated: files.length >= MAX_FILES } };
}

// merge per-file facts into component facts (every entry carries its file)
const KEYS = ['functions', 'classes', 'constants', 'hooks', 'shortcodes', 'rest', 'ajax', 'assets', 'localize', 'cpts', 'taxonomies', 'blocks', 'menus', 'options', 'globals', 'db', 'includes', 'calls', 'redirects'];
function merge(fileFacts) {
    const m = Object.fromEntries(KEYS.map(k => [k, []]));
    for (const f of fileFacts) for (const k of KEYS) for (const e of f[k] || []) m[k].push({ ...e, file: f.file, ...(f.bundled ? { bundled: true } : {}) });
    return m;
}

// ---- template overrides (WooCommerce) ----
function templateVersion(abs) {
    let head; try { const fd = fs.openSync(abs, 'r'); const b = Buffer.alloc(4096); const n = fs.readSync(fd, b, 0, 4096, 0); fs.closeSync(fd); head = b.toString('utf8', 0, n); } catch { return null; }
    const m = /@version\s+([0-9][\w.\-]*)/.exec(head);
    return m ? { version: m[1], line: head.slice(0, m.index).split('\n').length } : null;
}
function templateOverrides(root, themes) {
    const found = [];
    const wooDir = path.join(root, 'wp-content', 'plugins', 'woocommerce');
    const wooVersion = (() => { try { return /^[ \t/*#@]*Version:\s*(\S+)/mi.exec(fs.readFileSync(path.join(wooDir, 'woocommerce.php'), 'utf8').slice(0, 8192))[1]; } catch { return null; } })();
    for (const t of themes) {
        const base = path.join(t.dir, 'woocommerce');
        if (!fs.existsSync(base)) continue;
        const list = [];
        (function w(d) { let es; try { es = readdir(d, { withFileTypes: true }); } catch { return; } es.sort((a, b) => a.name.localeCompare(b.name)); for (const e of es) { if (e.isSymbolicLink()) continue; const f = path.join(d, e.name); if (e.isDirectory()) w(f); else if (/\.php$/.test(e.name) && list.length < 400) list.push(f); } })(base);
        for (const abs of list) {
            const rel = posix(path.relative(base, abs)), mine = templateVersion(abs), core = path.join(wooDir, 'templates', rel);
            const entry = { theme: t.ref, file: siteRel(root, abs), template: rel, theme_version: mine && mine.version, line: mine ? mine.line : 1, plugin_exists: fs.existsSync(core), plugin_version: null, outdated: null };
            if (entry.plugin_exists) {
                const theirs = templateVersion(core); entry.plugin_version = theirs && theirs.version;
                const a = semver.coerce(entry.theme_version), b = semver.coerce(entry.plugin_version);
                entry.outdated = a && b ? semver.lt(a, b) : null;
            }
            found.push(entry);
        }
    }
    return { woocommerce_version: wooVersion, overrides: found };
}

const deterministicId = (type, ...parts) => schema.stableId('obs', type, ...parts);

// -> { mode, message, policy, components: [...], facts: { [ref]: merged }, observations: [...], steps: [...], templates }
// focus.names: function/class names (lower-case) the evidence mentions, e.g. from a "Cannot redeclare" log line. Declarations that come only from the
// regex surface (third-party code) are trusted for duplicate detection ONLY for those names: the regex scanner lists class methods as functions
// and cannot see guards, so using it everywhere would bury the real problem under hundreds of false alarms.
function analyse(root, { policy, hints = [], focus = {}, discovered = components.discover(root) } = {}) {
    const focusNames = new Set([...(focus.names || [])].map(n => String(n).toLowerCase().replace(/^\\/, '')));
    const all = [...discovered.plugins, ...discovered.themes, ...discovered.mu, ...discovered.dropins];
    const hasAllow = policy.customPaths.length > 0;
    const hintRefs = new Set(hints);
    const result = { mode: hasAllow ? 'custom-first' : 'inspection-only', message: hasAllow ? null : 'no custom code declared; set customPaths (plugin-guard.config.json) to enable custom-first analysis. Everything below is inspection-only: it can explain the problem but cannot become a fix task.', policy: { customPaths: policy.customPaths, protectedPaths: policy.protectedPaths }, components: [], facts: {}, observations: [], steps: [] };

    const failuresAll = [];
    for (const c of all.sort((a, b) => a.ref.localeCompare(b.ref))) {
        const rel = componentRel(c), own = ownership.classify(policy, rel);
        const custom = own.owner === 'custom';
        const deep = custom || hintRefs.has(c.ref) || c.kind === 'theme';
        const r = deep ? deepFacts(root, c, policy, { onlyCustomFiles: custom, capped: !custom }) : surfaceFacts(root, c, policy);
        const merged = merge(r.facts);
        for (const f of r.failures || []) failuresAll.push({ ...f, component: c.ref, custom });
        result.facts[c.ref] = merged;
        const impliedMap = new Map();
        for (const sc of c.scans || []) for (const im of sc.implied || []) { const prev = impliedMap.get(im.slug); impliedMap.set(im.slug, { slug: im.slug, soft: (prev ? prev.soft : true) && im.soft }); }
        const mainAbs = c.single ? path.join(c.dir, c.main) : path.join(c.dir, c.main);
        let updated = null; try { updated = new Date(Math.max(...[mainAbs, path.join(c.dir, 'style.css'), path.join(c.dir, 'readme.txt')].filter(f => fs.existsSync(f)).map(f => fs.statSync(f).mtimeMs))).toISOString(); } catch { /* unreadable */ }
        result.components.push({
            implied: [...impliedMap.values()].sort((a, b) => a.slug.localeCompare(b.slug)), parent_theme: c.template || null, updated_at: updated,
            requires_php: c.requiresPhp || null, requires_wp: c.requiresWp || null, tested_up_to: compat.testedUpTo(c), main_file: c.kind === 'dropin' ? rel : c.single ? rel : `${rel}/${c.main}`,
            ref: c.ref, kind: c.kind, slug: c.slug, name: c.name || c.slug, version: c.version || null, description: c.description || null, requires_plugins: c.requiresPlugins || [],
            path: rel, ownership: own.owner, ownership_reason: own.reason, depth: deep ? 'syntax-tree' : 'surface', inspection_only: !custom, files: r.stats,
            counts: Object.fromEntries(KEYS.filter(k => merged[k].length).map(k => [k, merged[k].length]))
        });
    }
    result.steps.push({ id: 'custom-first', label: 'Custom code first', status: hasAllow ? 'PASSED' : 'SKIPPED', reason: result.message,
        custom_components: result.components.filter(c => !c.inspection_only).map(c => c.ref), syntax_tree_components: result.components.filter(c => c.depth === 'syntax-tree').map(c => c.ref) });

    // ---- observations ----
    const obs = result.observations;
    const refOf = Object.fromEntries(result.components.map(c => [c.ref, c]));
    // every evidence file carries its ownership as the gate sees it: only 'custom' files can ever be named in a fix task
    const push = o => obs.push({ id: deterministicId(o.type, o.components.join(','), o.evidence.map(e => `${e.file}:${e.line}`).join(';')), ...o, evidence: o.evidence.map(e => ({ ...e, ownership: e.file ? ownership.classify(policy, e.file).owner : null })) });

    // parse failures in custom code (a syntax error is a white screen)
    for (const f of failuresAll) push({ type: 'syntax-error', components: [f.component], custom: f.custom, evidence: [{ file: f.file, line: f.line }], message: `php -l reports a syntax error in ${f.file}: ${f.message}` });

    // duplicate declarations across everything we have
    const decl = new Map();
    for (const [ref, m] of Object.entries(result.facts)) {
        for (const k of ['functions', 'classes']) for (const d of m[k]) {
            const key = `${k === 'functions' ? 'f' : 'c'}:${String(d.name).toLowerCase()}`;
            if (!decl.has(key)) decl.set(key, []);
            const ast = refOf[ref].depth === 'syntax-tree', short = String(d.name).toLowerCase().replace(/^.*\\/, '');
            if (!ast && !focusNames.has(String(d.name).toLowerCase()) && !focusNames.has(short)) continue;
            decl.get(key).push({ ref, file: d.file, line: d.line, guarded: !!d.guarded, bundled: !!d.bundled, ast });
        }
    }
    for (const [key, list] of [...decl].sort((a, b) => a[0].localeCompare(b[0]))) {
        const distinct = list.filter((d, i) => list.findIndex(x => x.file === d.file && x.line === d.line) === i);
        if (distinct.length < 2) continue;
        const refs = [...new Set(distinct.map(d => d.ref))];
        const unguarded = distinct.filter(d => !d.guarded);
        if (unguarded.length < 2 && !(refs.length > 1 && unguarded.length >= 1 && distinct.some(d => d.guarded))) continue;
        const name = key.slice(2), kind = key[0] === 'f' ? 'function' : 'class';
        push({ type: 'duplicate-declaration', dup_key: `decl:${kind}:${name.replace(/^.*\\/, '')}`, components: refs, custom: refs.some(r => refOf[r] && !refOf[r].inspection_only),
            declaration: { kind, name }, risk: unguarded.length >= 2 ? 'fatal-if-both-load' : 'conditional (one declaration is guarded by function_exists / class_exists)',
            evidence: distinct.map(d => ({ file: d.file, line: d.line, component: d.ref, guarded: d.guarded, bundled: d.bundled })), message: `${kind} ${name}() is declared in ${distinct.length} places` });
    }

    // a removal aimed at a callback another component owns, and whether its priority matches the original add
    const owner = new Map(); // callback name -> [{ref, file, line}]
    for (const [key, list] of decl) if (key[0] === 'f') owner.set(key.slice(2), list.filter(d => d.ast));
    const adds = new Map(); // hook -> adds
    for (const [ref, m] of Object.entries(result.facts)) for (const h of m.hooks) if (h.op === 'add' && h.hook) { if (!adds.has(h.hook)) adds.set(h.hook, []); adds.get(h.hook).push({ ...h, ref }); }
    for (const [ref, m] of Object.entries(result.facts)) {
        if (refOf[ref].depth !== 'syntax-tree') continue; // who removes what is only trusted from the syntax tree
        for (const h of m.hooks) {
            if (h.op !== 'remove' || !h.hook) continue;
            const cb = h.callback || {};
            const name = cb.kind === 'function' || (cb.kind === 'static' && !cb.class) ? String(cb.name || '').toLowerCase() : null;
            const target = (adds.get(h.hook) || []).find(a => a.ref !== ref && a.callback && a.callback.kind === cb.kind && String(a.callback.name || '').toLowerCase() === String(cb.name || '').toLowerCase() && (cb.kind !== 'method' || String(a.callback.class) === String(cb.class)));
            const otherOwner = name && (owner.get(name) || []).find(o => o.ref !== ref);
            if (!target && !otherOwner) continue;
            const t = target || { ref: otherOwner.ref, file: otherOwner.file, line: otherOwner.line, priority: null };
            const mismatch = target && h.priority !== null && target.priority !== null && h.priority !== target.priority;
            push({ type: mismatch ? 'remove-wrong-priority' : 'removes-other-component-hook', components: [ref, t.ref].sort(), custom: !refOf[ref].inspection_only,
                hook: h.hook, callback: cb.name || null, removed_priority: h.priority, added_priority: target ? target.priority : null,
                evidence: [{ file: h.file, line: h.line, component: ref, role: 'removes' }, { file: t.file, line: t.line, component: t.ref, role: target ? 'adds' : 'declares' }],
                message: mismatch ? `${ref} removes ${cb.name} from ${h.hook} at priority ${h.priority}, but ${t.ref} added it at priority ${target.priority}: the removal does nothing` : `${ref} removes ${cb.name || 'a callback'} from ${h.hook}, a callback that belongs to ${t.ref}` });
        }
    }

    // handles removed and replaced, and dependencies nobody registers. Core handles come from THIS site's wp-includes/script-loader.php.
    const core = corehandles.load(root);
    result.core_handles = core.known ? { known: true, version: core.version, scripts: core.scripts.size, styles: core.styles.size, block_packages: core.packages, unresolved_registrations: core.unresolved } : { known: false, reason: core.reason, version: core.version };
    const registeredBy = { script: new Map(), style: new Map() };
    for (const [ref, m] of Object.entries(result.facts)) for (const a of m.assets) if (a.op === 'register' || a.op === 'enqueue') { const t = registeredBy[a.type]; const k = String(a.handle).toLowerCase(); if (!t.has(k)) t.set(k, new Set()); t.get(k).add(ref); }
    let suppressed = 0, unchecked = 0;
    for (const [ref, m] of Object.entries(result.facts)) {
        if (refOf[ref].depth !== 'syntax-tree') continue;
        for (const a of m.assets) {
            if (a.op === 'deregister' || a.op === 'dequeue') {
                const again = m.assets.find(b => (b.op === 'register' || b.op === 'enqueue') && b.handle === a.handle && b.src);
                const owners = [...(registeredBy[a.type].get(String(a.handle).toLowerCase()) || [])].filter(r => r !== ref).sort();
                const isCore = corehandles.has(core, a.type, a.handle);
                // a plugin or theme dequeuing its own handles is routine; keep it for custom code, replacements, core handles, and handles another component registers
                if (refOf[ref].inspection_only && !again && !isCore && !owners.length) { suppressed++; continue; }
                push({ type: again ? 'handle-replaced' : 'handle-removed', components: [ref, ...owners], custom: !refOf[ref].inspection_only, handle: a.handle, handle_type: a.type, core_handle: isCore, core_version: isCore ? (a.type === 'style' ? core.styles : core.scripts).get(a.handle).ver || null : null,
                    removed_by: ref, registered_by: owners, replacement: again ? { src: again.src.url || again.src.raw, rel: again.src.rel, ver: again.ver, file: again.file, line: again.line } : null,
                    evidence: [{ file: a.file, line: a.line, component: ref, role: a.op }, ...(again ? [{ file: again.file, line: again.line, component: ref, role: 'registers replacement' }] : [])],
                    message: `${ref} ${a.op}s the "${a.handle}" ${a.type}${isCore ? ' (a WordPress core handle)' : owners.length ? ` (registered by ${owners.join(', ')})` : ''}${again ? ` and registers its own${again.ver ? ` (version ${again.ver})` : ''}` : ''}` });
            }
            if ((a.op === 'register' || a.op === 'enqueue') && Array.isArray(a.deps)) for (const d of a.deps) {
                if (registeredBy[a.type].has(String(d).toLowerCase()) || corehandles.has(core, a.type, d)) continue;
                if (!core.known) { unchecked++; continue; }
                push({ type: 'dependency-handle-not-registered', components: [ref], custom: !refOf[ref].inspection_only, handle: a.handle, missing: d,
                    evidence: [{ file: a.file, line: a.line }], message: `"${a.handle}" depends on "${d}", which neither WordPress's script-loader.php (${core.version || 'this version'}) nor any scanned component registers${core.unresolved ? ` (${core.unresolved} core registration(s) could not be resolved, so it may be one of those)` : ''}` });
            }
        }
    }
    result.steps.push({ id: 'core-handles', label: 'WordPress core script/style handles', status: core.known ? 'PASSED' : 'SKIPPED',
        reason: core.known ? `read from this site's own script-loader.php (WordPress ${core.version}): ${core.scripts.size} scripts, ${core.styles.size} styles${core.unresolved ? `; ${core.unresolved} registration(s) built at run time could not be resolved` : ''}` : `${core.reason}${unchecked ? `; ${unchecked} dependency check(s) on handles that might be core handles were skipped` : ''}` });

    // the same JavaScript object localized by two components: the second overwrites the first on the page
    const objs = new Map();
    for (const [ref, m] of Object.entries(result.facts)) for (const l of m.localize) if (l.object) { if (!objs.has(l.object)) objs.set(l.object, []); objs.get(l.object).push({ ref, file: l.file, line: l.line, handle: l.handle }); }
    for (const [name, list] of [...objs].sort((a, b) => a[0].localeCompare(b[0]))) {
        const refs = [...new Set(list.map(l => l.ref))];
        if (refs.length > 1) push({ type: 'localize-object-collision', components: refs, custom: refs.some(r => !refOf[r].inspection_only), object: name, evidence: list.map(l => ({ file: l.file, line: l.line, component: l.ref })), message: `JavaScript object "${name}" is created by ${refs.length} components` });
    }

    // ---- the same name registered by two components: shortcode, AJAX action, REST route, script/style handle, constant ----
    // The facts come from the syntax tree for custom code, themes and the components the evidence names, and from the regex surface for the rest
    // (which has no constants and no script sources). Every observation carries `dup_key` so the classic adapter does not report the same thing twice,
    // and `trusted`: true when at least one side was read with the syntax tree. Nothing here is a verdict.
    const dupGroups = (items, keyOf) => { const m = new Map(); for (const it of items) { const k = keyOf(it); if (k === null || k === undefined || k === '') continue; if (!m.has(k)) m.set(k, []); m.get(k).push(it); } return [...m].sort((a, b) => String(a[0]).localeCompare(String(b[0]))); };
    const isAst = ref => refOf[ref] && refOf[ref].depth === 'syntax-tree';
    const sites = (list) => list.filter((d, i) => list.findIndex(x => x.file === d.file && x.line === d.line && x.ref === d.ref) === i).map(d => ({ file: d.file, line: d.line, component: d.ref }));
    const pushDup = (type, name, list, extra, message) => {
        const refs = [...new Set(list.map(d => d.ref))].sort();
        if (refs.length < 2) return;
        push({ type, components: refs, custom: refs.some(r => refOf[r] && !refOf[r].inspection_only), trusted: refs.some(isAst), dup_key: `${type}:${String(name).toLowerCase()}`, name, ...extra, evidence: sites(list), message });
    };
    const factsOf = (key, pick) => Object.entries(result.facts).flatMap(([ref, m]) => (m[key] || []).map(e => ({ ...pick(e), ref, file: e.file, line: e.line })));
    for (const [tag, list] of dupGroups(factsOf('shortcodes', e => ({ name: e.tag })), d => String(d.name).toLowerCase()))
        pushDup('duplicate-shortcode', tag, list, { shortcode: tag }, `shortcode [${tag}] is registered by ${[...new Set(list.map(d => d.ref))].join(' and ')}: the one loaded last replaces the other`);
    for (const [key, list] of dupGroups(factsOf('ajax', e => ({ name: `${e.action}${e.nopriv ? '|nopriv' : ''}`, action: e.action, nopriv: !!e.nopriv, dynamic: !!e.dynamic })).filter(d => !d.dynamic), d => d.name))
        pushDup('duplicate-ajax-action', key, list, { action: list[0].action, nopriv: list[0].nopriv }, `AJAX action "${list[0].action}"${list[0].nopriv ? ' (nopriv)' : ''} has a handler in ${[...new Set(list.map(d => d.ref))].join(' and ')}: both run for the same request`);
    for (const [key, list] of dupGroups(factsOf('rest', e => ({ name: e.route ? `${e.namespace}/${String(e.route).replace(/^\/+/, '')}` : null })), d => d.name && String(d.name).toLowerCase()))
        pushDup('duplicate-rest-route', key, list, { route: key }, `REST route /${key} is registered by ${[...new Set(list.map(d => d.ref))].join(' and ')}`);
    // constants: only the syntax tree records them; a definition inside if ( ! defined( 'NAME' ) ) is a guard
    for (const [name, list] of dupGroups(factsOf('constants', e => ({ name: e.name, guarded: !!e.guarded })), d => d.name)) {
        const unguarded = list.filter(d => !d.guarded);
        if (new Set(unguarded.map(d => d.ref)).size < 2) continue;
        pushDup('duplicate-constant', name, unguarded, { constant: name, risk: 'warning-only' }, `constant ${name} is defined by ${[...new Set(unguarded.map(d => d.ref))].join(' and ')}: PHP keeps the first value and only warns, so one of them runs with the other's value`);
    }
    // script / style handles: two components that each REGISTER the same handle with a file; WordPress ignores the second one
    // the file a registration points at, as far as the code says: a full URL, else the folder it is relative to (plugins_url( 'x.js', __FILE__ ) is
    // relative to the folder of THAT file, so the same relative name in two plugins is two different files)
    const srcKey = a => (!a.src ? null : a.src.url ? a.src.url : a.src.rel !== null && a.src.rel !== undefined ? `${a.src.base || ''}|${a.src.base === 'file-dir' ? path.posix.dirname(a.file || '') : ''}|${a.src.rel}` : (a.src.raw && a.src.raw !== 'dynamic' ? a.src.raw : null));
    const regs = Object.entries(result.facts).flatMap(([ref, m]) => m.assets.filter(a => (a.op === 'register' || a.op === 'enqueue') && a.src && srcKey(a)).map(a => ({ ref, file: a.file, line: a.line, handle: String(a.handle).toLowerCase(), type: a.type, src: srcKey(a) })));
    for (const [key, list] of dupGroups(regs, d => `${d.type}:${d.handle}`)) {
        const [type, handle] = [key.split(':')[0], key.slice(key.indexOf(':') + 1)];
        if (corehandles.has(core, type, handle) || new Set(list.map(d => d.ref)).size < 2 || new Set(list.map(d => d.src)).size < 2) continue;
        pushDup('duplicate-script-handle', handle, list, { handle, handle_type: type }, `the ${type} handle "${handle}" is registered by ${[...new Set(list.map(d => d.ref))].join(' and ')} with different files: WordPress keeps the first and silently ignores the second`);
    }

    // theme template overrides older than the plugin's own template
    const tpl = templateOverrides(root, discovered.themes);
    result.templates = tpl;
    for (const o of tpl.overrides) if (o.outdated) push({ type: 'template-override-outdated', components: [o.theme, 'woocommerce'].sort(), custom: !refOf[o.theme].inspection_only, template: o.template,
        theme_version: o.theme_version, plugin_version: o.plugin_version, evidence: [{ file: o.file, line: o.line, component: o.theme }], message: `${o.theme} overrides woocommerce/${o.template} at @version ${o.theme_version}; WooCommerce's own copy is @version ${o.plugin_version}` });
    result.steps.push({ id: 'template-overrides', label: 'Theme template overrides (WooCommerce)', status: tpl.overrides.length || tpl.woocommerce_version ? 'PASSED' : 'SKIPPED', reason: tpl.woocommerce_version ? null : 'WooCommerce is not installed here, so no override can be outdated', overrides: tpl.overrides.length });

    obs.sort((a, b) => a.type.localeCompare(b.type) || a.id.localeCompare(b.id));
    result.steps.push({ id: 'observations', label: 'Code observations', status: 'PASSED', reason: `${suppressed} routine handle removal(s) in inspection-only code were not reported; duplicate declarations from regex-only code are reported only for names the evidence mentions`, count: obs.length, by_type: Object.fromEntries([...new Set(obs.map(o => o.type))].map(t => [t, obs.filter(o => o.type === t).length])) });
    return result;
}

module.exports = { analyse, templateOverrides, deepFacts, merge, componentRel };
