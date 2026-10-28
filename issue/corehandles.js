// The script and style handles WordPress itself registers, read from THIS site's own wp-includes/script-loader.php (the version that is
// actually installed), never from a list in this tool. If the file is missing the answer is "core handles unknown" and nothing is guessed.
//
// How handles are found (all by parsing, nothing is executed):
//   $scripts->add( 'utils', ... ) / $styles->add( 'colors', ... )        literal handles
//   foreach ( $vendor_scripts as $handle => $deps ) { $scripts->add( $handle, ... ) }   loops over static arrays in the same function
//   wp-includes/assets/script-loader-packages.php                         'a11y.js' => ...  becomes 'wp-a11y', exactly as wp_default_packages_scripts() does
// What it cannot see is reported: registrations whose handle is built at run time (`unresolved`), and handles registered outside
// script-loader.php (for example by core block code). A handle missing from this list is therefore "not found", not "does not exist".

const fs = require('fs');
const path = require('path');
const phpast = require('./phpast');

const cache = new Map();

function read(file) { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } }
function wpVersion(root) { const t = read(path.join(root, 'wp-includes', 'version.php')); const m = t && /\$wp_version\s*=\s*'([^']+)'/.exec(t); return m ? m[1] : null; }

// -> { known, reason?, version, scripts: Map(handle -> {ver, deps}), styles: Map, unresolved, packages, source }
function load(root) {
    const loader = path.join(root, 'wp-includes', 'script-loader.php');
    let st; try { st = fs.statSync(loader); } catch { return { known: false, reason: 'wp-includes/script-loader.php was not found, so core handles are unknown', version: wpVersion(root) }; }
    const key = `${loader}|${st.mtimeMs}|${st.size}`;
    if (cache.has(key)) return cache.get(key);
    const src = read(loader);
    const f = phpast.analyse(src, 'wp-includes/script-loader.php');
    const out = { known: true, version: wpVersion(root), scripts: new Map(), styles: new Map(), unresolved: 0, packages: 0, parse_errors: f.errors.length, source: 'wp-includes/script-loader.php' };
    if (!f.registry.length) return { known: false, reason: `wp-includes/script-loader.php registered no handles that could be read${f.errors.length ? ` (parse error: ${f.errors[0].message})` : ''}, so core handles are unknown`, version: out.version };
    // the one registration whose handle is `'wp-' . $basename` is covered by the packages file below, when the rule is really in this loader
    const marker = (() => { const i = src.search(/'wp-'\s*\.\s*\$basename/); return i < 0 ? null : src.slice(0, i).split('\n').length; })();
    const covered = r => marker !== null && r.line >= marker && r.line <= marker + 15;
    out.packages_rule = marker !== null;
    for (const r of f.registry) {
        if (r.handle === null) { if (!(covered(r) && fs.existsSync(path.join(root, 'wp-includes', 'assets', 'script-loader-packages.php')))) out.unresolved++; continue; }
        const m = r.target === 'script' ? out.scripts : out.styles;
        if (!m.has(r.handle)) m.set(r.handle, { ver: r.ver, deps: r.deps });
    }
    // block-editor packages: only trusted when the loader still contains the rule that turns file names into handles
    const pk = path.join(root, 'wp-includes', 'assets', 'script-loader-packages.php');
    const pkSrc = read(pk);
    if (pkSrc && marker !== null) {
        const pf = phpast.analyse(pkSrc, 'wp-includes/assets/script-loader-packages.php');
        const re = /^\s*'([^']+\.js)'\s*=>\s*array\(/gm;
        let m;
        while ((m = re.exec(pkSrc))) {
            const handle = 'wp-' + path.basename(m[1]).replace('.js', '');
            if (!out.scripts.has(handle)) { out.scripts.set(handle, { ver: null, deps: null }); out.packages++; }
        }
        if (!pf.parsed) out.parse_errors += pf.errors.length;
    } // else: the packages file (or the rule) is missing; the loop stays counted in `unresolved` and block-editor handles are not in the list
    cache.set(key, out);
    return out;
}

// Option names WordPress itself creates, read from populate_options() in THIS site's wp-admin/includes/schema.php.
// -> { known, names:Set, reason? }
function coreOptions(root) {
    const t = read(path.join(root, 'wp-admin', 'includes', 'schema.php'));
    if (!t) return { known: false, names: new Set(), reason: 'wp-admin/includes/schema.php was not found, so core option names are unknown' };
    const i = t.indexOf('function populate_options');
    if (i < 0) return { known: false, names: new Set(), reason: 'populate_options() was not found in schema.php' };
    const body = t.slice(i, t.indexOf('\n}\n', i) + 1 || undefined);
    const names = new Set([...body.matchAll(/^\s*'([A-Za-z0-9_]+)'\s*=>/gm)].map(m => m[1]));
    return names.size ? { known: true, names } : { known: false, names, reason: 'no option names could be read from populate_options()' };
}

const has = (core, type, handle) => !!core.known && (type === 'style' ? core.styles : core.scripts).has(String(handle));

module.exports = { load, has, wpVersion, coreOptions };
