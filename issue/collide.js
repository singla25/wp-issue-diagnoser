// JavaScript and CSS collisions between the assets components enqueue, read with real parsers (acorn, postcss). Nothing is executed.
//
//   libraries      the same library (jQuery, Select2, Swiper, Slick, Moment, Lodash, ...) loaded twice, or in different versions
//   core replaced  WordPress's own jQuery replaced by another version (the core version is read from this site's script-loader.php)
//   js globals     two scripts assigning the same window.X or jQuery.fn.X; a script using jQuery without depending on it
//   jQuery API     code calling a jQuery API that only exists from a given version, against the version that will actually load
//   css selectors  the same selector, with different values for the same property, in CSS from different components
//
// Only assets whose file can be located inside the site are parsed; the rest are listed as unresolved. `matches_failing_region` for CSS
// is null until the live page probe (a later step) can say which elements are on the failing page.

const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const walk = require('acorn-walk');
const postcss = require('postcss');
const semver = require('semver');
const ownership = require('../lib/ownership');
const corehandles = require('./corehandles');
const graphMod = require('./graph');

const MAX_ASSET_BYTES = 1.5 * 1024 * 1024, MAX_ASSETS = 300;
const posix = p => p.split(path.sep).join('/');

// library id -> how to recognise it in a file name / URL (and in the banner comment at the top of the file)
const LIBS = [
    ['jquery', /(?:^|[\/_.-])jquery(?:\.min)?[-.]?(\d+\.\d+(?:\.\d+)?)?(?:\.min)?\.js|jquery\/(\d+\.\d+(?:\.\d+)?)\//i, /jQuery(?: JavaScript Library)? v?(\d+\.\d+(?:\.\d+)?)/i],
    ['jquery-migrate', /jquery[-.]migrate(?:[-.](\d+\.\d+(?:\.\d+)?))?/i, /jQuery Migrate(?: -)? v?(\d+\.\d+(?:\.\d+)?)/i],
    ['jquery-ui', /jquery[-.]ui(?:[-.](\d+\.\d+(?:\.\d+)?))?/i, /jQuery UI(?: -)? v?(\d+\.\d+(?:\.\d+)?)/i],
    ['select2', /select2(?:[-.](\d+\.\d+(?:\.\d+)?))?/i, /Select2 v?(\d+\.\d+(?:\.\d+)?)/i],
    ['swiper', /swiper(?:[-.](?:bundle[-.])?(\d+\.\d+(?:\.\d+)?))?/i, /Swiper(?: [A-Za-z]+)? v?(\d+\.\d+(?:\.\d+)?)/i],
    ['slick', /slick(?:[-.](\d+\.\d+(?:\.\d+)?))?(?:\.min)?\.js/i, /Slick (?:Slider|Carousel)?\s*v?(\d+\.\d+(?:\.\d+)?)|Version:\s*(\d+\.\d+(?:\.\d+)?)/i],
    ['owl-carousel', /owl[.-]carousel(?:[-.](\d+\.\d+(?:\.\d+)?))?/i, /Owl Carousel v?(\d+\.\d+(?:\.\d+)?)/i],
    ['moment', /(?:^|[\/_.-])moment(?:[-.](\d+\.\d+(?:\.\d+)?))?(?:\.min)?\.js/i, /moment\.js.*?version\s*:?\s*(\d+\.\d+(?:\.\d+)?)/i],
    ['lodash', /lodash(?:[-.](\d+\.\d+(?:\.\d+)?))?(?:\.min)?\.js/i, /lodash v?(\d+\.\d+(?:\.\d+)?)/i],
    ['magnific-popup', /magnific[-.]popup/i, /Magnific Popup - v?(\d+\.\d+(?:\.\d+)?)/i],
    ['fancybox', /fancybox/i, /fancyBox v?(\d+\.\d+(?:\.\d+)?)/i],
    ['isotope', /isotope/i, /Isotope PACKAGED v?(\d+\.\d+(?:\.\d+)?)/i],
    ['masonry', /masonry/i, /Masonry(?: PACKAGED)? v?(\d+\.\d+(?:\.\d+)?)/i],
    ['bootstrap', /bootstrap(?:[-.](\d+\.\d+(?:\.\d+)?))?(?:\.bundle)?(?:\.min)?\.(?:js|css)/i, /Bootstrap v?(\d+\.\d+(?:\.\d+)?)/i],
    ['gsap', /gsap|tweenmax/i, /GSAP\s*(\d+\.\d+(?:\.\d+)?)/i],
    ['chartjs', /chart(?:\.umd|\.min)?\.js/i, /Chart\.js v?(\d+\.\d+(?:\.\d+)?)/i]
];
const libOf = (text, banner) => {
    for (const [id, nameRe, bannerRe] of LIBS) {
        const n = nameRe.exec(text);
        const b = banner ? bannerRe.exec(banner) : null;
        if (n || b) return { id, version: (n && (n[1] || n[2])) || (b && (b[1] || b[2])) || null };
    }
    return null;
};

// jQuery APIs that exist only from a version on, or only up to one. Each is checked against the jQuery docs by scripts/verify-knowledge.js.
const JQUERY_API = [
    { name: 'jQuery.escapeSelector', test: (obj, prop) => /^(jQuery|\$)$/.test(obj) && prop === 'escapeSelector', min: '3.0.0', doc: 'https://api.jquery.com/jQuery.escapeSelector/' },
    { name: '.even()', test: (obj, prop) => prop === 'even', min: '3.5.0', doc: 'https://api.jquery.com/even/', weak: true },
    { name: '.odd()', test: (obj, prop) => prop === 'odd', min: '3.5.0', doc: 'https://api.jquery.com/odd/', weak: true },
    { name: '.size()', test: (obj, prop) => prop === 'size', max_exclusive: '3.0.0', doc: 'https://api.jquery.com/size/', weak: true },
    { name: '.andSelf()', test: (obj, prop) => prop === 'andSelf', max_exclusive: '3.0.0', doc: 'https://api.jquery.com/andSelf/' }
];

function locate(root, comp, a, byRef) {
    const s = a.src;
    if (!s) return null;
    if (s.url) return { url: s.url };
    if (s.rel === null || s.rel === undefined || s.dynamic) return null;
    const base = (b, rel) => posix(path.posix.join(b, rel));
    let rel = null;
    const c = byRef[comp];
    if (s.base === 'file-dir') rel = base(path.posix.dirname(a.file), s.rel);
    else if (s.base === 'plugins-dir') rel = base('wp-content/plugins', s.rel);
    else if (s.base === 'theme' && c && c.kind === 'theme') rel = base(c.path, s.rel);
    else if (s.base === 'parent-theme' && c && c.kind === 'theme') rel = base(c.parent_theme ? `wp-content/themes/${c.parent_theme}` : c.path, s.rel);
    else if (s.base === 'theme' || s.base === 'parent-theme') return null;
    if (!rel) return null;
    const r = ownership.resolveInside(root, rel);
    if (!r.ok || r.symlink) return { problem: r.ok ? 'symlink' : r.reason, rel };
    return { rel: r.rel, abs: r.abs };
}

function bannerOf(src) { const m = /^\s*(?:#!.*\n)?\s*\/\*[\s\S]{0,700}?\*\//.exec(src); return m ? m[0] : ''; }

function analyseJs(src) {
    const out = { globals: [], usesJquery: false, apis: [], parse_error: null, banner: bannerOf(src) };
    let ast;
    try { ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true, allowReturnOutsideFunction: true, locations: true }); }
    catch (e) { out.parse_error = String(e.message).slice(0, 100); return out; }
    const params = new Set();
    walk.full(ast, n => { if (/Function/.test(n.type)) for (const p of n.params) if (p.type === 'Identifier') params.add(p.name); });
    const dollarIsJquery = !params.has('$');
    const root = e => { while (e && e.type === 'MemberExpression') e = e.object; return e && e.type === 'Identifier' ? e.name : null; };
    const pathOf = e => { const parts = []; while (e && e.type === 'MemberExpression') { parts.unshift(e.computed ? (e.property.type === 'Literal' ? String(e.property.value) : '*') : e.property.name); e = e.object; } return e && e.type === 'Identifier' ? [e.name, ...parts] : null; };
    walk.full(ast, n => {
        if (n.type === 'AssignmentExpression' && n.left.type === 'MemberExpression') {
            const p = pathOf(n.left); if (!p) return;
            const head = p[0] === '$' ? 'jQuery' : p[0];
            if (['window', 'self', 'globalThis'].includes(head) && p.length === 2) out.globals.push({ name: p[1], kind: 'window', line: n.loc ? n.loc.start.line : null });
            else if (head === 'jQuery' && p[1] === 'fn' && p.length === 3) out.globals.push({ name: `jQuery.fn.${p[2]}`, kind: 'jquery-plugin', line: n.loc ? n.loc.start.line : null });
            else if (head === 'jQuery' && p.length === 2 && p[0] === 'jQuery') out.globals.push({ name: `jQuery.${p[1]}`, kind: 'jquery-static', line: n.loc ? n.loc.start.line : null });
        }
        if (n.type === 'MemberExpression' && !n.computed && n.property.type === 'Identifier') {
            const o = root(n.object) ? (pathOf(n.object) || []).join('.') : '';
            for (const api of JQUERY_API) if (api.test(o, n.property.name)) out.apis.push({ api: api.name, min: api.min || null, max_exclusive: api.max_exclusive || null, doc: api.doc, weak: !!api.weak, line: n.loc ? n.loc.start.line : null });
        }
        if (n.type === 'Identifier' && (n.name === 'jQuery' || (n.name === '$' && dollarIsJquery))) out.usesJquery = true;
    });
    // names a classic script leaves in the global scope: top-level var / function (let/const/class clash instead of overwriting)
    for (const st of ast.body) {
        if (st.type === 'FunctionDeclaration' && st.id) out.globals.push({ name: st.id.name, kind: 'global-function', line: st.loc ? st.loc.start.line : null });
        if (st.type === 'VariableDeclaration') for (const d of st.declarations) if (d.id.type === 'Identifier') out.globals.push({ name: d.id.name, kind: st.kind === 'var' ? 'global-var' : 'global-lexical', line: st.loc ? st.loc.start.line : null });
    }
    // an IIFE that is handed jQuery is fine; a bare reference at the top level is what needs jQuery loaded first
    return out;
}

function analyseCss(src, file) {
    const rules = [];
    let root; try { root = postcss.parse(src, { from: file }); } catch (e) { return { rules, parse_error: String(e.reason || e.message).slice(0, 100) }; }
    root.walkRules(rule => {
        const media = []; for (let p = rule.parent; p && p.type !== 'root'; p = p.parent) if (p.type === 'atrule') media.unshift(`@${p.name} ${p.params}`.trim());
        if (media.some(m => /^@(keyframes|font-face|-webkit-keyframes)/.test(m))) return;
        const props = {}; rule.walkDecls(d => { props[d.prop.toLowerCase()] = { value: d.value.replace(/\s+/g, ' ').trim(), important: !!d.important }; });
        for (const sel of rule.selectors || []) rules.push({ selector: sel.replace(/\s+/g, ' ').trim(), media: media.join(' '), props, line: rule.source && rule.source.start ? rule.source.start.line : null });
    });
    return { rules, parse_error: null };
}

// closure of a handle's dependencies through everything we know (components + core)
function depsClosure(handle, type, depMap, core) {
    const seen = new Set(), todo = [handle];
    while (todo.length) {
        const h = String(todo.pop()).toLowerCase();
        if (seen.has(h)) continue; seen.add(h);
        for (const d of depMap[type].get(h) || []) todo.push(d);
        const c = (type === 'style' ? core.styles : core.scripts).get(h) || (core.known && (type === 'style' ? core.styles : core.scripts).get(Object.keys({})[0]));
        if (c && Array.isArray(c.deps)) for (const d of c.deps) todo.push(d);
    }
    return seen;
}

// analysis: result of custom.analyse(). -> { assets, collisions, steps }
function run(root, analysis) {
    const core = corehandles.load(root);
    const byRef = Object.fromEntries(analysis.components.map(c => [c.ref, c]));
    const assets = [], steps = [];
    let unresolvedSources = 0, problems = [];

    for (const [ref, m] of Object.entries(analysis.facts)) for (const a of m.assets) {
        if (a.op !== 'register' && a.op !== 'enqueue') continue;
        assets.push({ component: ref, handle: a.handle, type: a.type, op: a.op, deps: a.deps, ver: a.ver, file: a.file, line: a.line, src: a.src ? { raw: a.src.raw, url: a.src.url || null } : null, _a: a });
    }
    // dependency map: handle -> deps, from components (core deps come from `core`)
    const depMap = { script: new Map(), style: new Map() };
    for (const a of assets) if (Array.isArray(a.deps)) { const k = a.handle.toLowerCase(); depMap[a.type].set(k, [...new Set([...(depMap[a.type].get(k) || []), ...a.deps])]); }

    // locate + parse
    const parsed = [];
    let budget = MAX_ASSETS;
    for (const a of assets.slice().sort((x, y) => `${x.component}|${x.handle}`.localeCompare(`${y.component}|${y.handle}`))) {
        const loc = locate(root, a.component, a._a, byRef);
        a.location = loc && (loc.rel || loc.url) ? (loc.rel || loc.url) : null;
        const fromName = libOf(`${a.location || ''} ${a.src ? a.src.raw : ''}`, '');
        if (!loc) { if (a._a.src) unresolvedSources++; a.library = fromName; continue; }
        if (loc.url) { a.library = fromName; continue; }
        if (loc.problem) { problems.push(`${a.component}/${a.handle}: ${loc.problem}`); continue; }
        if (budget <= 0) { problems.push('asset limit reached: further files were not parsed'); break; }
        let st; try { st = fs.statSync(loc.abs); } catch { problems.push(`${loc.rel}: file not found`); continue; }
        if (!st.isFile() || st.size > MAX_ASSET_BYTES) { problems.push(`${loc.rel}: ${st.isFile() ? 'larger than 1.5 MB, not parsed' : 'not a file'}`); continue; }
        budget--;
        const text = fs.readFileSync(loc.abs, 'utf8');
        if (a.type === 'script' || /\.js$/i.test(loc.rel)) {
            const js = analyseJs(text);
            a.js = { globals: js.globals, uses_jquery: js.usesJquery, apis: js.apis, parse_error: js.parse_error };
            a.library = libOf(`${loc.rel}`, js.banner) || fromName;
            parsed.push(a);
        } else if (a.type === 'style' || /\.css$/i.test(loc.rel)) {
            const css = analyseCss(text, loc.rel);
            a.css = { rules: css.rules.length, parse_error: css.parse_error }; a._rules = css.rules;
            a.library = libOf(`${loc.rel}`, '') || fromName;
            parsed.push(a);
        }
    }
    const jsParsed = parsed.filter(a => a.js), cssParsed = parsed.filter(a => a._rules);
    steps.push({ id: 'asset-files', label: 'JavaScript / CSS files of enqueued assets', status: parsed.length ? 'PASSED' : 'SKIPPED',
        reason: parsed.length ? `${jsParsed.length} script(s) parsed with acorn, ${cssParsed.length} stylesheet(s) with postcss${unresolvedSources ? `; ${unresolvedSources} asset(s) have a source that cannot be located statically (built at run time or from a component analysed only by regex)` : ''}${problems.length ? `; ${problems.length} could not be read` : ''}` : `no enqueued asset file could be located${unresolvedSources ? ` (${unresolvedSources} have a source built at run time or in a component analysed only by regex)` : ''}`,
        scripts: jsParsed.length, styles: cssParsed.length, unresolved: unresolvedSources, problems: problems.slice(0, 10) });

    const collisions = [];
    const push = c => collisions.push({ id: require('../lib/schema').stableId('col', c.type, c.components.join(','), c.key || ''), ...c });

    // ---- libraries loaded twice / in different versions ----
    const byLib = new Map();
    for (const a of assets) if (a.library) { if (!byLib.has(a.library.id)) byLib.set(a.library.id, []); byLib.get(a.library.id).push(a); }
    if (core.known) { // WordPress's own copy of jQuery counts as a source of the library
        const j = core.scripts.get('jquery-core');
        if (j) { if (!byLib.has('jquery')) byLib.set('jquery', []); byLib.get('jquery').push({ component: 'wordpress-core', handle: 'jquery-core', type: 'script', ver: j.ver, library: { id: 'jquery', version: j.ver }, file: 'wp-includes/script-loader.php', line: null, core: true }); }
    }
    for (const [id, list] of [...byLib].sort((x, y) => x[0].localeCompare(y[0]))) {
        const distinct = list.filter((a, i) => list.findIndex(b => b.component === a.component && b.handle === a.handle) === i);
        if (distinct.length < 2) continue;
        const handles = new Set(distinct.map(a => a.handle.toLowerCase()));
        const versions = [...new Set(distinct.map(a => (a.library && a.library.version) || a.ver).filter(Boolean))];
        const comps = [...new Set(distinct.map(a => a.component))];
        if (handles.size < 2 && comps.length < 2) continue;
        if (id === 'jquery-migrate' || id === 'jquery-ui') { if (versions.length < 2 && handles.size < 2) continue; }
        // two assets with the SAME handle are one script (the second registration is ignored by WordPress): not a duplicate copy
        if (handles.size < 2 && versions.length < 2) continue;
        push({ type: versions.length > 1 ? 'library-version-conflict' : 'duplicate-library', key: id, library: id, versions, components: comps.filter(c => c !== 'wordpress-core').concat(comps.includes('wordpress-core') ? ['wordpress-core'] : []),
            evidence: distinct.map(a => ({ component: a.component, handle: a.handle, version: (a.library && a.library.version) || a.ver || null, file: a.file, line: a.line, location: a.location || null })),
            message: `${id} is loaded ${distinct.length} times under ${handles.size} handle(s)${versions.length ? ` (versions ${versions.join(', ')})` : ''}` });
    }

    // ---- jQuery needs: code that uses version-specific APIs vs the jQuery that will load ----
    const effective = (() => { // the jQuery version a page will get: a replacement of the core handle wins, else core's
        const rep = analysis.observations.find(o => o.type === 'handle-replaced' && o.handle === 'jquery');
        const coreV = core.known && core.scripts.get('jquery-core') ? core.scripts.get('jquery-core').ver : null;
        if (rep && rep.replacement) { const v = libOf(`${rep.replacement.src || ''}`, '') ; const ver = (v && v.version) || rep.replacement.ver; if (ver) return { version: ver, source: `${rep.components[0]} (replaces core jQuery ${coreV || '?'})` }; }
        return coreV ? { version: coreV, source: `WordPress ${core.version || ''} core` } : null;
    })();
    for (const a of jsParsed) for (const api of a.js.apis) {
        if (!effective) break;
        const v = semver.coerce(effective.version); if (!v) continue;
        const bad = (api.min && semver.lt(v, api.min)) || (api.max_exclusive && semver.gte(v, api.max_exclusive));
        if (!bad) continue;
        push({ type: 'jquery-api-version-mismatch', key: `${a.location}:${api.api}`, components: [a.component], api: api.api, needs: api.min ? `jQuery >= ${api.min}` : `jQuery < ${api.max_exclusive}`, effective_jquery: effective.version, effective_source: effective.source, weak: api.weak, doc: api.doc,
            evidence: [{ component: a.component, handle: a.handle, file: a.location, line: api.line }], message: `${a.location} uses ${api.api}, which needs ${api.min ? `jQuery ${api.min} or newer` : `jQuery older than ${api.max_exclusive}`}, but the jQuery that loads is ${effective.version} (${effective.source})` });
    }

    // ---- script uses jQuery but does not depend on it ----
    for (const a of jsParsed) {
        if (!a.js.uses_jquery || a.js.parse_error) continue;
        const closure = depsClosure(a.handle, 'script', depMap, core);
        if (closure.has('jquery') || closure.has('jquery-core') || a.library && a.library.id === 'jquery') continue;
        if (!Array.isArray(a.deps)) continue; // dependency list not known statically
        push({ type: 'script-missing-dependency', key: a.location, components: [a.component], handle: a.handle, needs: 'jquery',
            evidence: [{ component: a.component, handle: a.handle, file: a.file, line: a.line, location: a.location }], message: `${a.location} uses jQuery but its handle "${a.handle}" does not depend on "jquery" (directly or through another handle), so it can run before jQuery exists` });
    }

    // ---- the same global defined by two scripts ----
    // a core plugin and its Pro edition by the same vendor (graph.js vendorPairs) are meant to share such a name: it is not listed as a clash, and is kept in `same_vendor`
    const vendorSet = new Set(graphMod.vendorPairs(root, analysis.components).map(p => graphMod.pairKey(p.core, p.pro))), sameVendor = [];
    const globals = new Map();
    for (const a of jsParsed) for (const g of a.js.globals) { if (g.kind === 'global-lexical') continue; const k = g.name; if (!globals.has(k)) globals.set(k, []); globals.get(k).push({ ...g, component: a.component, handle: a.handle, location: a.location }); }
    for (const [name, list] of [...globals].sort((x, y) => x[0].localeCompare(y[0]))) {
        const per = list.filter((g, i) => list.findIndex(h => h.location === g.location) === i);
        const comps = [...new Set(per.map(g => g.component))];
        if (per.length < 2 || comps.length < 2) continue;
        if (/^(jQuery\.|\$\.)?(fn|extend|each|noop)$/.test(name)) continue;
        if (comps.length === 2 && vendorSet.has(graphMod.pairKey(comps[0], comps[1]))) { sameVendor.push({ kind: 'script-name', name, components: comps.slice().sort() }); continue; }
        push({ type: 'js-global-collision', key: name, global: name, kinds: [...new Set(per.map(g => g.kind))], components: comps, evidence: per.map(g => ({ component: g.component, handle: g.handle, file: g.location, line: g.line })),
            message: `${name} is assigned by ${per.length} scripts from ${comps.join(', ')}: the later one overwrites the earlier` });
    }

    // ---- the same CSS selector set differently by different components ----
    const bySel = new Map();
    for (const a of cssParsed) for (const r of a._rules) { const k = `${r.media}|${r.selector.toLowerCase()}`; if (!bySel.has(k)) bySel.set(k, []); bySel.get(k).push({ component: a.component, handle: a.handle, location: a.location, rule: r }); }
    const css = [];
    for (const [k, list] of bySel) {
        const comps = [...new Set(list.map(x => x.component))];
        if (comps.length < 2) continue;
        const props = new Map();
        for (const x of list) for (const [p, v] of Object.entries(x.rule.props)) { if (!props.has(p)) props.set(p, []); props.get(p).push({ component: x.component, value: v.value, important: v.important }); }
        const conflicts = [...props].filter(([, vs]) => new Set(vs.map(v => v.component)).size > 1 && new Set(vs.map(v => v.value)).size > 1).map(([p, vs]) => ({ property: p, values: vs.sort((a, b) => a.component.localeCompare(b.component)) }));
        if (!conflicts.length) continue;
        css.push({ selector: list[0].rule.selector, media: list[0].rule.media, components: comps, conflicts, list });
    }
    css.sort((a, b) => b.conflicts.length - a.conflicts.length || a.selector.localeCompare(b.selector));
    for (const c of css.slice(0, 40)) push({ type: 'css-selector-overlap', key: `${c.media}|${c.selector}`, components: c.components, selector: c.selector, media: c.media || null, conflicting_properties: c.conflicts.map(x => ({ property: x.property, values: x.values })), matches_failing_region: null,
        evidence: c.list.map(x => ({ component: x.component, handle: x.handle, file: x.location, line: x.rule.line })), message: `"${c.selector}" is styled by ${c.components.join(' and ')} with different values for ${c.conflicts.map(x => x.property).join(', ')}` });
    steps.push({ id: 'collisions', label: 'Library, JavaScript-global and CSS collisions', status: parsed.length || assets.length ? 'PASSED' : 'SKIPPED', reason: css.length > 40 ? `${css.length - 40} further CSS overlaps were not listed` : null, count: collisions.length, by_type: Object.fromEntries([...new Set(collisions.map(c => c.type))].map(t => [t, collisions.filter(c => c.type === t).length])), effective_jquery: effective });
    collisions.sort((a, b) => a.type.localeCompare(b.type) || a.id.localeCompare(b.id));
    return { assets: assets.map(({ _a, _rules, ...a }) => a), collisions, steps, effective_jquery: effective, ...(sameVendor.length ? { same_vendor: sameVendor } : {}) };
}

module.exports = { run, analyseJs, analyseCss, libOf, LIBS, JQUERY_API };
