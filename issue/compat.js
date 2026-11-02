// Static compatibility: what a component's own headers say about the PHP and WordPress versions, and calls to functions that no longer exist.
// Everything here is an ADVISORY observation (advisory: true): it explains a crash if it is the cause, but a version number or a call that has not
// been seen failing proves nothing. hypotheses.js turns an advisory into a hypothesis only when a clue implicates the same component, and it stays
// advisory (never CONFIRMED) unless a log fatal naming the function, a probe observation or the bisection corroborates it.
//
//   removed-function-call   a plain function call (no method, static or namespaced call) to a function in data/removed-wp-functions.json whose
//                           `removed_in` is not newer than the PHP version in use. Skipped when ANY component of the site defines a function of that
//                           name (polyfills, vendor code) or when the call sits inside an if that tests function_exists( 'name' ).
//                           Only entries with "verified": true are ever matched.
//   requires-php-mismatch   "Requires PHP" newer than the PHP version in use
//   requires-wp-mismatch    "Requires at least" newer than this site's WordPress (wp-includes/version.php)
//   tested-up-to-older      "Tested up to" (readme.txt, or style.css for a theme) older than this site's WordPress, by major.minor
// The PHP version in use is the one the reporter states (issue.php_version) or, failing that, the sandbox image's. The PHP of the machine running
// Plugin Guard is never used: it says nothing about the site.

const fs = require('fs');
const path = require('path');
const semver = require('semver');

const DATA = path.join(__dirname, '..', 'data', 'removed-wp-functions.json');
const IMAGES = path.join(__dirname, '..', 'data', 'sandbox-images.json');
const MAX_SITES = 5;
const cache = new Map();

function load(file = DATA) { if (!cache.has(file)) cache.set(file, JSON.parse(fs.readFileSync(file, 'utf8'))); return cache.get(file); }

// -> (lowercase name) => entry | null, built from the VERIFIED entries only
function matcher(entries) {
    const exact = new Map(), prefixes = [];
    for (const e of entries) {
        if (!e.verified || e.kind !== 'php' && e.kind !== 'wordpress') continue;
        for (const n of (e.match.exact || [])) exact.set(String(n).toLowerCase(), e);
        if (e.match.prefix) prefixes.push({ prefix: String(e.match.prefix).toLowerCase(), except: new Set((e.match.except || []).map(x => String(x).toLowerCase())), e });
    }
    return name => exact.get(name) || (prefixes.find(p => name.startsWith(p.prefix) && !p.except.has(name)) || {}).e || null;
}
let defaultMatch = null;
const watch = name => { if (!defaultMatch) defaultMatch = matcher(load().entries); return !!defaultMatch(name); };

function sandboxPhp() {
    try { const m = /php(\d+(?:\.\d+)?)/.exec(JSON.parse(fs.readFileSync(IMAGES, 'utf8')).images.wordpress.tag); return m ? m[1] : null; } catch { return null; }
}
// -> { version, source, stated } | null
function effectivePhp(issue) {
    const stated = issue && issue.php_version;
    if (stated && semver.coerce(stated)) return { version: stated, source: 'the PHP version the reporter gave', stated: true, label: `on PHP ${stated} (stated by the reporter)` };
    const sb = sandboxPhp();
    // the wording is fixed: wherever a finding rests on the sandbox default, it must say that the site's own PHP version is unknown
    return sb ? { version: sb, source: `the PHP of the sandbox image (php${sb}); the live site may run another version`, stated: false, label: `on PHP ${sb} (sandbox); the site's own PHP version is unknown` } : null;
}
const gt = (a, b) => { const x = semver.coerce(a), y = semver.coerce(b); return !!(x && y && semver.gt(x, y)); };
const gte = (a, b) => { const x = semver.coerce(a), y = semver.coerce(b); return !!(x && y && semver.gte(x, y)); };
const majorMinor = v => { const c = semver.coerce(v); return c ? `${c.major}.${c.minor}.0` : null; };

// "Tested up to" of a component: plugin -> readme.txt, theme -> style.css. null when there is none.
function testedUpTo(c) {
    if (!c || c.single || !c.dir) return null;
    const file = path.join(c.dir, c.kind === 'theme' ? 'style.css' : 'readme.txt');
    try { const fd = fs.openSync(file, 'r'); const b = Buffer.alloc(8192); const n = fs.readSync(fd, b, 0, 8192, 0); fs.closeSync(fd); const m = /^[ \t*#@]*Tested up to:\s*([0-9][0-9.]*)/mi.exec(b.toString('utf8', 0, n)); return m ? m[1] : null; } catch { return null; }
}

// analysis: result of custom.analyse(). -> { observations, step }
function run(root, analysis, { issue = {}, wpVersion = null, entries = null, php = undefined } = {}) {
    const list = entries || load().entries;
    const match = matcher(list);
    const unverified = list.filter(e => !e.verified).length;
    const eff = php === undefined ? effectivePhp(issue) : php;
    const wp = wpVersion === null ? (require('../lib/components').wpVersion(root) || {}).version || null : wpVersion;
    const obs = [];
    const refOf = Object.fromEntries(analysis.components.map(c => [c.ref, c]));
    const push = o => obs.push({ advisory: true, family: 'compat', ...o, id: require('../lib/schema').stableId('obs', o.type, o.components.join(','), o.evidence.map(e => `${e.file}:${e.line}`).join(';'), o.function || o.header || ''), evidence: o.evidence });

    // functions the site defines itself, anywhere (a polyfill or a vendored copy makes the call harmless)
    const defined = new Set();
    for (const m of Object.values(analysis.facts)) for (const f of m.functions || []) defined.add(String(f.name).toLowerCase());

    // ---- removed functions ----
    let calls = 0;
    if (eff) for (const [ref, m] of Object.entries(analysis.facts)) {
        const byFn = new Map();
        for (const c of m.calls || []) {
            calls++;
            const e = match(c.name);
            if (!e || c.guarded || defined.has(c.name) || !gte(eff.version, e.removed_in)) continue;
            if (!byFn.has(c.name)) byFn.set(c.name, { e, sites: [] });
            byFn.get(c.name).sites.push({ file: c.file, line: c.line, component: ref });
        }
        for (const [name, { e, sites }] of [...byFn].sort((a, b) => a[0].localeCompare(b[0]))) {
            const c = refOf[ref];
            push({ type: 'removed-function-call', components: [ref], custom: !!c && !c.inspection_only, function: name, removed_in: e.removed_in, function_kind: e.kind, entry: e.id, source_url: e.source.url, claim: e.claim,
                php_version: eff.version, php_source: eff.source, php_stated: eff.stated, dup_key: `removed:${name}`, evidence: sites.slice(0, MAX_SITES),
                php_label: eff.label, message: `${ref} calls ${name}(), which no longer exists from PHP ${e.removed_in}; ${eff.label}` });
        }
    }

    // ---- headers ----
    for (const c of analysis.components) {
        if (c.kind === 'dropin') continue;
        const at = [{ file: c.main_file, line: null, component: c.ref }];
        if (c.requires_php && eff && gt(c.requires_php, eff.version))
            push({ type: 'requires-php-mismatch', header: 'requires-php', components: [c.ref], custom: !c.inspection_only, evidence: at, php_version: eff.version, php_source: eff.source, php_stated: eff.stated, php_label: eff.label, requires: c.requires_php, message: `${c.ref} says it needs PHP ${c.requires_php} or newer; ${eff.label}` });
        if (c.requires_wp && wp && gt(c.requires_wp, wp))
            push({ type: 'requires-wp-mismatch', header: 'requires-wp', components: [c.ref], custom: !c.inspection_only, evidence: at, wp_version: wp, requires: c.requires_wp, message: `${c.ref} says it needs WordPress ${c.requires_wp} or newer; this site runs ${wp}` });
        if (c.tested_up_to && wp && majorMinor(c.tested_up_to) && majorMinor(wp) && gt(majorMinor(wp), majorMinor(c.tested_up_to)))
            push({ type: 'tested-up-to-older', header: 'tested-up-to', components: [c.ref], custom: !c.inspection_only, evidence: [{ file: c.kind === 'theme' ? `${c.path}/style.css` : `${c.path}/readme.txt`, line: null, component: c.ref }], wp_version: wp, tested: c.tested_up_to, message: `${c.ref} was last tested with WordPress ${c.tested_up_to}; this site runs ${wp}. That is a reminder, not a fault` });
    }
    obs.sort((a, b) => a.type.localeCompare(b.type) || a.id.localeCompare(b.id));
    return { observations: obs, step: { id: 'compat', label: 'Static compatibility (PHP / WordPress versions, removed functions)', status: 'PASSED',
        reason: `${eff ? `${eff.label}` : 'no PHP version is known, so no PHP rule was applied'}; WordPress ${wp || 'unknown'}; ${calls} watched call(s) read in syntax-tree components only (custom code, themes, components the evidence names); ${obs.length} advisory observation(s)${unverified ? `; ${unverified} data entr${unverified === 1 ? 'y is' : 'ies are'} not verified and never matched` : ''}`,
        advisories: obs.length, php: eff, wordpress: wp } };
}

module.exports = { run, watch, matcher, load, effectivePhp, testedUpTo, sandboxPhp, DATA };
