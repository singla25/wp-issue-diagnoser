// A real PHP syntax tree (php-parser, pure JavaScript: it parses, it never executes anything) turned into WordPress-specific facts.
// Unlike the regex scanner (lib/php.js) it ignores calls inside comments and strings, understands PHP 8 syntax, concatenated hook
// names, nested arrays and conditional declarations (`if ( ! function_exists(...) )`), and records line numbers from the tree.
// A file the parser cannot read is reported with its errors (and `php -l` says whether it is really broken); it is never silently skipped.

const Engine = require('php-parser');
const { spawnSync } = require('child_process');
const fs = require('fs');

const MAX_BYTES = 1.5 * 1024 * 1024;
const parser = new Engine({ parser: { php8: true, suppressErrors: true, extractDoc: true }, ast: { withPositions: true } });
const INT_MAX = 2147483647;

const ASSET_FN = { wp_enqueue_script: ['enqueue', 'script'], wp_register_script: ['register', 'script'], wp_enqueue_style: ['enqueue', 'style'], wp_register_style: ['register', 'style'], wp_dequeue_script: ['dequeue', 'script'], wp_deregister_script: ['deregister', 'script'], wp_dequeue_style: ['dequeue', 'style'], wp_deregister_style: ['deregister', 'style'] };
const OPTION_FN = { get_option: 'get', update_option: 'update', add_option: 'add', delete_option: 'delete', get_site_option: 'get', update_site_option: 'update' };
const DB_METHODS = new Set(['query', 'get_results', 'get_row', 'get_var', 'get_col', 'prepare']);

// Resolution state for the current analyse() call (the parser is synchronous, so a module-level context is safe):
//   ENV   variables bound by an unrolled `foreach` over a static array literal  { name: node }
//   ARRS  stack of scopes { varName: array-literal node } assigned earlier in the same function (or file)
//   CLASS the class being walked, for __CLASS__
let ENV = null, ARRS = [new Map()], CLASS = null;
const arrOf = name => { for (let i = ARRS.length - 1; i >= 0; i -= i === ARRS.length - 1 && ARRS.length > 1 ? ARRS.length - 1 : 1) { if (ARRS[i].has(name)) return ARRS[i].get(name); if (i === 0) break; } return null; };

const nm = x => (x == null ? null : typeof x === 'string' ? x : typeof x.name === 'string' ? x.name : x.name && typeof x.name.name === 'string' ? x.name.name : null);
const line = n => (n && n.loc ? n.loc.start.line : null);
const trim = (s, n = 160) => String(s).slice(0, n);

// -> { value } | { dynamic: true, prefix } | null. Concatenation of literals is resolved; anything with a variable keeps its literal prefix.
function str(n) {
    if (!n) return null;
    if (n.kind === 'string') return { value: n.value };
    if (n.kind === 'variable' && ENV && typeof n.name === 'string' && ENV[n.name]) return str(ENV[n.name]);
    if (n.kind === 'magic' && n.value === '__CLASS__' && CLASS) return { value: CLASS };
    if (n.kind === 'number') return { value: String(n.value) };
    // apply_filters( 'tag', $value ): the value is what the code intends; the name MAY be changed by some filter, so it is marked
    if (n.kind === 'call' && nm(n.what) === 'apply_filters' && n.arguments[1]) { const r = str(n.arguments[1]); return r && { ...r, filtered: true }; }
    // $array[ $key ] where $array is a static array literal assigned in this scope
    if (n.kind === 'offsetlookup' && n.what && n.what.kind === 'variable' && n.offset) {
        const arr = arrOf(n.what.name), k = str(n.offset);
        if (arr && k && 'value' in k) { const it = items(arr).find(i => i.key && str(i.key) && str(i.key).value === k.value); return it ? str(it.value) : null; }
    }
    if (n.kind === 'bin' && n.type === '.') {
        const l = str(n.left), r = str(n.right);
        if (l && 'value' in l && r && 'value' in r) return { value: l.value + r.value };
        if (l && 'value' in l) return { dynamic: true, prefix: l.value };
        return { dynamic: true, prefix: (l && l.prefix) || '' };
    }
    if (n.kind === 'encapsed' && Array.isArray(n.value)) {
        let out = '';
        for (const p of n.value) {
            const piece = p.kind === 'string' ? { value: p.value } : p.kind === 'encapsedpart' ? str(p.expression) : null;
            if (!piece || !('value' in piece)) return { dynamic: true, prefix: out };
            out += piece.value;
        }
        return { value: out };
    }
    if (n.kind === 'cast' || n.kind === 'parenthesis') return str(n.expr || n.inner);
    return null;
}
const items = a => (a && a.kind === 'array' ? a.items.map(i => (i && i.kind === 'entry' ? i : { key: null, value: i })) : []);
function strList(n) { // array( 'a', 'b' ) -> ['a','b'] ; null when it is not a literal array
    if (n && n.kind === 'variable' && ENV && ENV[n.name]) return strList(ENV[n.name]);
    if (!n || n.kind !== 'array') return null;
    const out = [];
    for (const it of items(n)) { const s = str(it.value); if (s && 'value' in s) out.push(s.value); }
    return out;
}
function num(n, dflt) {
    if (!n) return dflt;
    if (n.kind === 'number') return Number(n.value);
    if (n.kind === 'name' || n.kind === 'constref') return nm(n) === 'PHP_INT_MAX' ? INT_MAX : nm(n) === 'PHP_INT_MIN' ? -INT_MAX : null;
    if (n.kind === 'unary' && n.type === '-' ) { const v = num(n.what, null); return v === null ? null : -v; }
    return null;
}
function callback(n) {
    if (!n) return { kind: 'dynamic' };
    if (n.kind === 'variable' && ENV && ENV[n.name]) return callback(ENV[n.name]);
    if (n.kind === 'bin' || n.kind === 'magic') { const s_ = str(n); if (s_ && 'value' in s_) return callback({ kind: 'string', value: s_.value }); return { kind: 'dynamic' }; }
    if (n.kind === 'string') { const m = /^([\w\\]+)::(\w+)$/.exec(n.value); return m ? { kind: 'method', class: m[1], name: m[2], static: true } : { kind: 'function', name: n.value }; }
    if (n.kind === 'closure' || n.kind === 'arrowfunc') return { kind: 'closure' };
    if (n.kind === 'array') {
        const [a, b] = items(n).map(i => i.value), m = str(b);
        if (!a || !m || !('value' in m)) return { kind: 'dynamic' };
        let cls = null;
        if (a.kind === 'variable' && a.name === 'this') cls = '$this';
        else if (a.kind === 'magic' && a.value === '__CLASS__') cls = 'self';
        else if (a.kind === 'string') cls = a.value;
        else if (a.kind === 'staticlookup' && nm(a.offset) === 'class') cls = nm(a.what) === 'static' ? 'static' : nm(a.what) || 'self';
        else if (a.kind === 'selfreference' || a.kind === 'parentreference' || a.kind === 'staticreference') cls = a.kind === 'selfreference' ? 'self' : a.kind === 'staticreference' ? 'static' : 'parent';
        else if (a.kind === 'new') cls = `instance:${nm(a.what) || '?'}`;
        else if (a.kind === 'variable') cls = `$${a.name}`;
        return cls ? { kind: 'method', class: cls, name: m.value, static: false } : { kind: 'dynamic' };
    }
    return { kind: 'dynamic' };
}
// where a script/style URL points, as far as the code says: relative to the calling file, the plugin root or the theme
function src(n) {
    if (!n) return null;
    const s = str(n);
    if (s && 'value' in s) return { raw: trim(s.value), url: /^(https?:)?\/\//.test(s.value) ? s.value : null, rel: null, base: null };
    const call = n.kind === 'call' ? nm(n.what) : null;
    if (call === 'plugins_url') { const p = str(n.arguments[0]); return { raw: 'plugins_url()', url: null, rel: p && 'value' in p ? p.value.replace(/^\//, '') : null, base: n.arguments[1] && n.arguments[1].kind === 'magic' ? 'file-dir' : 'plugins-dir' }; }
    if (call === 'plugin_dir_url') return { raw: 'plugin_dir_url()', url: null, rel: '', base: 'file-dir' };
    if (['get_theme_file_uri', 'get_parent_theme_file_uri', 'get_stylesheet_directory_uri', 'get_template_directory_uri'].includes(call)) { const p = str(n.arguments[0]); return { raw: `${call}()`, url: null, rel: p && 'value' in p ? p.value.replace(/^\//, '') : '', base: call === 'get_theme_file_uri' || call === 'get_stylesheet_directory_uri' ? 'theme' : 'parent-theme' }; }
    if (n.kind === 'bin' && n.type === '.') {
        const l = src(n.left), r = str(n.right);
        if (l && l.base && r && 'value' in r) return { ...l, rel: `${l.rel || ''}${(l.rel || '').length && !(l.rel || '').endsWith('/') ? '' : ''}${r.value}`.replace(/^\/+/, '') };
    }
    return { raw: 'dynamic', url: null, rel: null, base: null, dynamic: true };
}
function guardNames(test) { // if ( ! function_exists( 'x' ) ) -> ['x']
    const out = [];
    (function w(n) { if (!n || typeof n !== 'object') return; if (Array.isArray(n)) return n.forEach(w); if (n.kind === 'call' && ['function_exists', 'class_exists', 'interface_exists', 'trait_exists', 'defined'].includes(nm(n.what))) { const s = str(n.arguments[0]); if (s && 'value' in s) out.push(s.value.replace(/^\\/, '')); } for (const k of Object.keys(n)) if (k !== 'loc') w(n[k]); })(test);
    return out;
}

function emptyFacts(file) {
    return { file, parsed: false, errors: [], fallback: null, functions: [], classes: [], constants: [], hooks: [], calls: [], redirects: [], calls: [], shortcodes: [], rest: [], ajax: [], assets: [], localize: [], cpts: [], taxonomies: [], blocks: [], menus: [], options: [], globals: [], db: [], includes: [], registry: [], noAbspathGuard: null };
}

// opts.watch: (lowercase name) => boolean. Plain function calls whose name it accepts are recorded in `calls` (method calls, static calls and
// namespaced calls never are), each with `guarded`: the call sits inside an if whose test mentions function_exists( 'same name' ), in either polarity.
function analyse(source, file, opts = {}) {
    const f = emptyFacts(file);
    ENV = null; ARRS = [new Map()]; CLASS = null;
    let ast;
    try { ast = parser.parseCode(source, file); } catch (e) { f.errors.push({ line: null, message: trim(e.message, 120) }); return f; }
    f.parsed = ast.errors.length === 0;
    f.errors = ast.errors.slice(0, 3).map(e => ({ line: e.line || line(e) || null, message: trim(String(e.message).split('\n')[0], 140) }));

    const guards = []; // names guarded by an enclosing `if`
    const fnStack = []; // the functions, methods and closures around the node being walked: { kind: 'function' | 'method' | 'closure', name, class }
    let ns = '';
    const qual = name => (ns ? `${ns}\\${name}` : name);
    const arg = (c, i) => c.arguments[i];

    function call(c) {
        const fn = nm(c.what), ln = line(c);
        if (c.what.kind === 'propertylookup' && c.what.what.kind === 'variable' && c.what.what.name === 'wpdb') {
            const m = nm(c.what.offset);
            if (DB_METHODS.has(m)) {
                const a0 = arg(c, 0), s = str(a0);
                const prepared = !!(a0 && a0.kind === 'call' && nm(a0.what && a0.what.offset) === 'prepare');
                const literal = !!(s && 'value' in s);
                f.db.push({ method: m, line: ln, prepared, literal, interpolated: !prepared && !literal, table: s && (s.value || s.prefix) ? ((/\b(?:from|into|update|join)\s+[`{]?\$?[\w>.{}-]*?([\w]+)[`}]?/i.exec(s.value || s.prefix) || [])[1] || null) : null });
            }
            return;
        }
        // $scripts->add( 'handle', 'src', array( deps ), 'ver' ) in WordPress's own script-loader.php
        if (c.what.kind === 'propertylookup' && c.what.what.kind === 'variable' && /^(wp_)?(scripts|styles)$/.test(String(c.what.what.name)) && nm(c.what.offset) === 'add') {
            const h = str(arg(c, 0)), v = str(arg(c, 3));
            f.registry.push({ target: /script/.test(c.what.what.name) ? 'script' : 'style', handle: h && 'value' in h ? h.value : null, dynamic: !(h && 'value' in h), deps: strList(arg(c, 2)), ver: v && 'value' in v ? v.value : null, line: ln });
            return;
        }
        if (!fn) return;
        const bare = fn.replace(/^\\/, '');
        // redirects: wp_redirect(), wp_safe_redirect() and header( 'Location: ... ' ), with the function, method or closure they sit in (null = file scope)
        if (bare === 'wp_redirect' || bare === 'wp_safe_redirect' || bare === 'header') {
            const t = str(arg(c, 0)), v = t && ('value' in t ? t.value : t.prefix);
            if (bare !== 'header' || (v && /^\s*location\s*:/i.test(v))) {
                const target = bare === 'header' ? (v || '').replace(/^\s*location\s*:\s*/i, '') : (t && 'value' in t ? t.value : (t && t.prefix) || null);
                const top = fnStack.length ? fnStack[fnStack.length - 1] : null;
                f.redirects.push({ call: bare, target: target ? trim(target, 120) : null, dynamic: !(t && 'value' in t), status: bare === 'header' ? null : num(arg(c, 1), null), line: ln, in: top ? { kind: top.kind, name: top.name, class: top.class } : null });
            }
        }
        if (opts.watch && !bare.includes('\\')) { const lower = bare.toLowerCase(); if (opts.watch(lower)) f.calls.push({ name: lower, line: ln, guarded: guards.some(g => String(g).toLowerCase() === lower) }); }
        if (/^(add|remove)_(action|filter)$/.test(bare)) {
            const h = str(arg(c, 0));
            if (!h) return;
            const [op, type] = bare.split('_');
            const entry = { op, type, owner_class: CLASS, filtered: !!h.filtered, hook: 'value' in h ? h.value : null, dynamic: !('value' in h), prefix: 'value' in h ? null : h.prefix, callback: callback(arg(c, 1)), priority: num(arg(c, 2), 10), args: op === 'add' ? num(arg(c, 3), 1) : null, line: ln };
            f.hooks.push(entry);
            const hook = entry.hook || '', pre = entry.prefix || '';
            const a = /^wp_ajax_(nopriv_)?(.*)$/.exec(hook || pre), p = /^admin_post_(nopriv_)?(.*)$/.exec(hook || pre);
            if (op === 'add' && a) f.ajax.push({ action: a[2], dynamic: entry.dynamic, nopriv: !!a[1], line: ln });
            if (op === 'add' && p) f.ajax.push({ action: `admin-post:${p[2]}`, dynamic: entry.dynamic, nopriv: !!p[1], line: ln });
        } else if (bare === 'add_shortcode') { const t = str(arg(c, 0)); if (t && 'value' in t) f.shortcodes.push({ tag: t.value, filtered: !!t.filtered, callback: callback(arg(c, 1)), line: ln }); }
        else if (bare === 'register_rest_route') { const ns_ = str(arg(c, 0)), r = str(arg(c, 1)); if (ns_ && 'value' in ns_) f.rest.push({ namespace: ns_.value, route: r && 'value' in r ? r.value : (r && r.prefix) || null, line: ln }); }
        else if (ASSET_FN[bare]) {
            const h = str(arg(c, 0)); if (!h || !('value' in h)) return;
            const [op, type] = ASSET_FN[bare];
            f.assets.push({ op, type, handle: h.value, src: op === 'enqueue' || op === 'register' ? src(arg(c, 1)) : null, deps: op === 'enqueue' || op === 'register' ? strList(arg(c, 2)) : null, ver: (() => { const v = str(arg(c, 3)); return v && 'value' in v ? v.value : null; })(), line: ln });
        } else if (bare === 'wp_localize_script' || bare === 'wp_add_inline_script') {
            const h = str(arg(c, 0)), o = str(arg(c, 1));
            if (bare === 'wp_localize_script' && h && 'value' in h) f.localize.push({ handle: h.value, object: o && 'value' in o ? o.value : null, keys: items(arg(c, 2)).map(i => (i.key ? str(i.key) : null)).filter(k => k && 'value' in k).map(k => k.value), line: ln });
            if (bare === 'wp_add_inline_script' && h && 'value' in h) f.localize.push({ handle: h.value, object: null, keys: [], inline: true, line: ln });
        } else if (bare === 'register_post_type') { const s = str(arg(c, 0)); if (s && 'value' in s) f.cpts.push({ name: s.value, line: ln }); }
        else if (bare === 'register_taxonomy') { const s = str(arg(c, 0)); if (s && 'value' in s) f.taxonomies.push({ name: s.value, line: ln }); }
        else if (bare === 'register_block_type' || bare === 'register_block_type_from_metadata') { const s = str(arg(c, 0)); if (s && 'value' in s) f.blocks.push({ name: s.value, line: ln }); }
        else if (['add_menu_page', 'add_submenu_page', 'add_options_page', 'add_management_page', 'add_theme_page'].includes(bare)) { const i = bare === 'add_submenu_page' ? 2 : bare === 'add_menu_page' ? 2 : 2; const s = str(arg(c, bare === 'add_submenu_page' ? 3 : i)); if (s && 'value' in s) f.menus.push({ slug: s.value, via: bare, line: ln }); }
        else if (OPTION_FN[bare]) { const s = str(arg(c, 0)); if (s) f.options.push({ op: OPTION_FN[bare], name: 'value' in s ? s.value : null, prefix: s.prefix || null, line: ln }); }
        else if (bare === 'define') { const s = str(arg(c, 0)); if (s && 'value' in s) f.constants.push({ name: s.value, line: ln, guarded: guards.includes(s.value) }); }   // guarded: inside if ( ! defined( 'NAME' ) )
    }

    const FACT_KEYS = ['functions', 'classes', 'constants', 'hooks', 'shortcodes', 'rest', 'ajax', 'assets', 'localize', 'cpts', 'taxonomies', 'blocks', 'menus', 'options', 'registry'];
    const unrolled = (n, run) => { // run `run`, then mark every fact it added as resolved from a static array
        const before = Object.fromEntries(FACT_KEYS.map(k => [k, f[k].length]));
        run();
        for (const k of FACT_KEYS) for (let i = before[k]; i < f[k].length; i++) f[k][i].resolved_from = 'static-array';
    };
    function walk(n, parentIf) {
        if (!n || typeof n !== 'object') return;
        if (Array.isArray(n)) { for (const x of n) walk(x, parentIf); return; }
        switch (n.kind) {
            case 'method': case 'closure': case 'arrowfunc': { ARRS.push(new Map()); fnStack.push(n.kind === 'method' ? { kind: 'method', name: nm(n.name), class: CLASS } : { kind: 'closure', name: null, class: CLASS }); const savedEnv = ENV; for (const k of Object.keys(n)) if (k !== 'loc' && k !== 'leadingComments' && k !== 'trailingComments') walk(n[k], parentIf); ENV = savedEnv; fnStack.pop(); ARRS.pop(); return; }
            case 'assign': {
                if (n.left && n.left.kind === 'variable' && typeof n.left.name === 'string' && n.right && n.right.kind === 'array' && n.operator === '=') ARRS[ARRS.length - 1].set(n.left.name, n.right);
                // inside an unrolled loop, $handle = 'wp-' . $package; binds $handle for the rest of that iteration
                else if (ENV && n.operator === '=' && n.left && n.left.kind === 'variable' && typeof n.left.name === 'string' && n.right) { const r = str(n.right); if (r && 'value' in r) ENV[n.left.name] = { kind: 'string', value: r.value }; }
                break;
            }
            case 'foreach': {
                const src = n.source;
                const arr = src && src.kind === 'variable' ? arrOf(src.name) : src && src.kind === 'array' ? src : null;
                const kv = n.key && n.key.kind === 'variable' ? n.key.name : null, vv = n.value && n.value.kind === 'variable' ? n.value.name : null;
                if (arr && (kv || vv) && arr.items.length <= 400) {
                    unrolled(n, () => arr.items.forEach((it, i) => {
                        const e = it && it.kind === 'entry' ? it : { key: null, value: it };
                        const saved = ENV; ENV = { ...(ENV || {}) };
                        if (kv) ENV[kv] = e.key || { kind: 'number', value: String(i) };
                        if (vv) ENV[vv] = e.value;
                        walk(n.body, parentIf);
                        ENV = saved;
                    }));
                    return;
                }
                break;
            }
            case 'namespace': { const prev = ns; ns = typeof n.name === 'string' ? n.name : nm(n.name) || ''; walk(n.children, parentIf); if (n.children && n.children.length && !n.withBrackets) { /* file-scoped namespace stays */ } else ns = prev; return; }
            case 'if': {
                const g = guardNames(n.test);
                guards.push(...g); walk(n.body, n); guards.length -= g.length;
                walk(n.alternate, parentIf); walk(n.test, parentIf); return;
            }
            case 'function': { const name = nm(n.name); if (name) f.functions.push({ name: qual(name), line: line(n), guarded: guards.includes(name) || guards.includes(qual(name)) }); ARRS.push(new Map()); fnStack.push({ kind: 'function', name: name ? qual(name) : null, class: null }); const savedEnv = ENV; for (const k of Object.keys(n)) if (k !== 'loc' && k !== 'leadingComments' && k !== 'trailingComments') walk(n[k], parentIf); ENV = savedEnv; fnStack.pop(); ARRS.pop(); return; }
            case 'class': case 'interface': case 'trait': case 'enum': {
                const name = nm(n.name);
                const savedClass = CLASS; CLASS = name ? qual(name) : CLASS;
                if (name) f.classes.push({ name: qual(name), kind: n.kind, line: line(n), extends: n.extends ? nm(n.extends) : null, implements: (n.implements || []).map(nm).filter(Boolean), methods: (n.body || []).filter(m => m.kind === 'method').map(m => nm(m.name)).filter(Boolean), guarded: guards.includes(name) || guards.includes(qual(name)) });
                for (const k of Object.keys(n)) if (k !== 'loc' && k !== 'leadingComments' && k !== 'trailingComments') walk(n[k], parentIf);
                CLASS = savedClass;
                return;
            }
            case 'call': call(n); break;
            case 'global': for (const v of n.items || []) if (v.kind === 'variable' && typeof v.name === 'string') f.globals.push({ name: v.name, kind: 'global', line: line(n) }); break;
            case 'offsetlookup': if (n.what && n.what.kind === 'variable' && n.what.name === 'GLOBALS') { const s = str(n.offset); if (s && 'value' in s) f.globals.push({ name: s.value, kind: '$GLOBALS', line: line(n) }); } break;
            case 'include': { const s = str(n.target); f.includes.push({ line: line(n), once: !!n.once, require: !!n.require, target: s ? ('value' in s ? trim(s.value) : `${trim(s.prefix || '')}…`) : 'dynamic' }); break; }
            default: break;
        }
        for (const k of Object.keys(n)) if (k !== 'loc' && k !== 'leadingComments' && k !== 'trailingComments') walk(n[k], parentIf);
    }
    walk(ast.children, null);
    f.noAbspathGuard = !/\b(ABSPATH|WPINC|WP_UNINSTALL_PLUGIN)\b/.test(source);
    return f;
}

// php -l for a file the parser could not read: is it broken, or is it a parser limitation? null when php is not installed.
function phpLint(abs) {
    const r = spawnSync('php', ['-l', abs], { encoding: 'utf8', timeout: 20000 });
    if (r.error) return null;
    return { ok: r.status === 0, message: trim((r.stdout + r.stderr).split('\n').find(l => /error/i.test(l)) || '', 200) };
}

module.exports = { analyse, phpLint, str, callback, MAX_BYTES };
