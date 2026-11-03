// A label for each hypothesis: what KIND of problem it is. It is a filter for reports, not the explanation (issue/cause.js says the cause in plain words),
// and it never reads or writes a status. Pure and deterministic.
//
//   labels, in fixed precedence (the first label that applies wins; "unclassified" only when none does):
//     compromise > environment-server > plugin-core-php > hook > theme-plugin > plugin-plugin > unclassified
//   Each hypothesis first yields the SET of labels that apply (from its type, its `class`, the log text behind it and the kinds of its components), then the
//   precedence picks one. So a hook problem between a theme and a plugin is "hook"; a removed PHP function in a theme-plus-plugin pair is "plugin-core-php";
//   a "memory size exhausted" fatal that names a plugin file is "environment-server".
//   component kinds: plugin, theme, mu, core (WordPress itself: the ref "wordpress-core"). A conflict needs two sides: theme + plugin/mu = theme-plugin,
//   two or more plugin/mu = plugin-plugin, one component alone = unclassified (a bisection that names a single plugin keeps that label: the partner is unknown).

const PRECEDENCE = ['compromise', 'environment-server', 'plugin-core-php', 'hook', 'theme-plugin', 'plugin-plugin'];
const LABELS = [...PRECEDENCE, 'unclassified'];

const ENV_TYPES = new Set(['classic:cfg-http-url', 'classic:dropin-unrecognised', 'classic:dropin-orphan']);
const CORE_PHP_TYPES = new Set(['syntax-error', 'missing-function', 'error-in-component', 'removed-function-call', 'requires-php-mismatch', 'requires-wp-mismatch', 'tested-up-to-older',
    'classic:dep-php-version', 'classic:dep-wp-version', 'dependency-handle-not-registered', 'jquery-api-version-mismatch', 'kb:core-jquery-replaced']);
const HOOK_TYPES = new Set(['remove-wrong-priority', 'removes-other-component-hook', 'hook-same-priority', 'redirect-on-hook', 'duplicate-ajax-action', 'duplicate-rest-route', 'duplicate-shortcode',
    'classic:hook-priority', 'classic:hook-contradiction', 'classic:hook-removed', 'kb:rest-authentication-errors-contention']);
// every other type is labelled by the kinds of its components (see above)
const BY_KINDS_TYPES = new Set(['duplicate-declaration', 'duplicate-constant', 'duplicate-script-handle', 'duplicate-library', 'library-version-conflict', 'js-global-collision', 'localize-object-collision',
    'script-missing-dependency', 'handle-removed', 'handle-replaced', 'css-selector-overlap', 'template-override-outdated', 'missing-dependency', 'js-error-in-component', 'failed-asset', 'bisect-minimal-set',
    'classic:dep-missing', 'classic:dep-inactive', 'classic:dep-implied', 'classic:theme-parent-missing', 'classic:duplicate-feature', 'classic:shared-table',
    'kb:wp-rocket-with-incompatible-plugin', 'kb:page-cache-with-woocommerce', 'kb:cache-plugin-with-elementor', 'kb:woocommerce-outdated-template-override', 'kb:jquery-api-version-mismatch',
    'kb:script-missing-dependency', 'kb:library-loaded-twice', 'kb:multiple-full-page-cache-plugins']);

// Causes that come from the server, not from the code, read from the log line behind a hypothesis. They win over the code labels even when the line names a plugin file.
const ENV_LOG = [
    ['memory', /Allowed memory size of \d+ bytes exhausted|Out of memory \(allocated/i],
    ['execution-time', /Maximum execution time of \d+ seconds? exceeded/i],
    ['missing-extension', /Call to undefined function (mb_|curl_|iconv|imagecreate|imagejpeg|imagepng|imagewebp|imagettf|simplexml_|zip_|ctype_|bc(?:add|sub|mul|div|mod|pow|comp)|gmp_|intl_|idn_|numfmt_|collator_|openssl_|sodium_|exif_|finfo_|mysqli_)\w*\(/i],
    ['missing-extension', /Class ["']?\\?(ZipArchive|DOMDocument|SimpleXMLElement|Imagick|IntlDateFormatter|NumberFormatter|XMLWriter|XMLReader|mysqli|finfo|Normalizer|Collator)["']? not found/i],
    ['disk-or-permissions', /Disk quota exceeded|No space left on device|Read-only file system|failed to open stream: Permission denied|Unable to create directory/i]
];

const kindOfRef = (ref, ctx) => {
    const r = String(ref || '');
    if (ctx.kinds && ctx.kinds[r]) return ctx.kinds[r];
    if (r === 'wordpress-core' || r === 'core') return 'core';
    if (r.startsWith('theme:')) return 'theme';
    if (r.startsWith('mu:')) return 'mu';
    return 'plugin';
};
const kindsOf = (h, ctx) => {
    const kinds = (h.components || []).map(c => kindOfRef(c, ctx));
    if ((h.supports || []).some(s => s.ref === 'bisect:theme')) kinds.push('theme');      // "a default theme makes the symptom disappear": the theme is a side
    return kinds;
};

// the text of the log lines behind a hypothesis (clue value + snippet), for the environment patterns
function logTexts(h, ctx) {
    const byId = ctx.clueById || (() => null);
    return (h.supports || []).filter(s => s.kind === 'log').map(s => { const c = byId(s.ref); return c ? `${c.value || ''} ${c.snippet || ''}` : ''; }).concat([h.mechanism || '']).filter(Boolean);
}
function environmentCause(h, ctx = {}) {
    for (const t of logTexts(h, ctx)) for (const [kind, re] of ENV_LOG) if (re.test(t)) return kind;
    return null;
}

const typeKey = h => (h.type === 'kb' ? `kb:${(h.kb || [])[0] || ''}` : h.type);

// -> { label, candidates, kinds, why }
function label(h, ctx = {}) {
    const cand = new Set(), why = [];
    const key = typeKey(h), kinds = kindsOf(h, ctx);
    const obs = (ctx.obsOf && ctx.obsOf(h)) || {};
    if (h.class === 'compromise' || /^classic:integrity-/.test(h.type || '')) { cand.add('compromise'); why.push('class compromise'); }
    const env = ENV_TYPES.has(key) ? 'server file or setting' : environmentCause(h, ctx);
    if (env) { cand.add('environment-server'); why.push(`server cause: ${env}`); }
    if (CORE_PHP_TYPES.has(key) || (h.type === 'handle-replaced' && obs.core_handle) || kinds.includes('core')) { cand.add('plugin-core-php'); why.push('PHP / WordPress core'); }
    if (HOOK_TYPES.has(key)) { cand.add('hook'); why.push('hook'); }
    const sides = kinds.filter(k => k !== 'core');
    if (sides.includes('theme') && sides.some(k => k === 'plugin' || k === 'mu')) { cand.add('theme-plugin'); why.push('theme + plugin'); }
    if (sides.filter(k => k === 'plugin' || k === 'mu').length >= 2) { cand.add('plugin-plugin'); why.push('two or more plugins'); }
    // a "class not found" fatal in a theme whose class belongs to a KNOWN plugin is a theme-plugin problem; in a plugin whose class belongs to another known plugin, plugin-plugin.
    // A guessed provider does not count. (Server causes and compromise signs above still win.)
    const fr = h.fatal_recheck;
    if (fr && fr.provider && fr.provider.known && fr.provider.kind === 'plugin' && !cand.has('compromise') && !cand.has('environment-server')) {
        const side = fr.file_kind === 'theme' ? 'theme-plugin' : fr.file_kind === 'plugin' && fr.provider.slug !== (fr.file.split('/')[2] || '') ? 'plugin-plugin' : null;
        if (side) { cand.delete('plugin-core-php'); cand.add(side); why.push(`class ${fr.class} belongs to the plugin ${fr.provider.slug}`); }
    }
    const chosen = PRECEDENCE.find(l => cand.has(l)) || 'unclassified';
    return { label: chosen, candidates: PRECEDENCE.filter(l => cand.has(l)), kinds, why };
}

module.exports = { label, environmentCause, typeKey, LABELS, PRECEDENCE, ENV_TYPES, CORE_PHP_TYPES, HOOK_TYPES, BY_KINDS_TYPES, ENV_LOG };
