// The cause of a hypothesis in plain words, for a reader who is not technical ("a PHP syntax error in <file>"). The conflict-type label only says what kind of
// problem it is; this says what it is. Built from fields the hypothesis and its observation already have; when a type has no template the first sentence of the
// hypothesis' own mechanism text is used, then its title. Never empty. Each line is a PHRASE that completes "The cause: ..." (the reports add the capital and the full stop). Pure and deterministic; assigns nothing.

const { environmentCause } = require('./conflict-type');

const clip = (s, n = 140) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const first = s => { const t = clip(s, 400), m = /^(.*?[.!?])(\s|$)/.exec(t); return m ? m[1] : t; };

function plainRef(ref, ctx) {
    const r = String(ref || ''), bare = r.replace(/^(plugin:|theme:|mu:)/, '');
    const name = (ctx.names && ctx.names[r]) || (ctx.names && ctx.names[bare]) || bare;
    if (r === 'wordpress-core' || r === 'core') return 'WordPress itself';
    if (r.startsWith('theme:')) return `theme ${name}`;
    if (r.startsWith('mu:')) return `must-use plugin ${name}`;
    return `plugin ${name}`;
}
const names = (h, ctx) => (h.components || []).map(c => plainRef(c, ctx));
const joined = (h, ctx) => { const n = names(h, ctx); return n.length ? n.join(' and ') : 'the site'; };
const where = h => { const e = (h.evidence || []).find(x => x && x.file) || {}; return e.file ? `${e.file}${e.line ? `:${e.line}` : ''}` : 'a file of the site'; };
const fileOnly = h => { const e = (h.evidence || []).find(x => x && x.file) || {}; return e.file || 'a file of the site'; };

const ENV_SENTENCE = {
    memory: h => `PHP ran out of memory (the memory limit of your hosting is too low for this page), raised in ${fileOnly(h)}`,
    'execution-time': h => `a page took longer than your hosting allows (the PHP time limit), raised in ${fileOnly(h)}`,
    'missing-extension': h => `a PHP extension that the code needs is not installed on your server (raised in ${fileOnly(h)})`,
    'disk-or-permissions': h => `the server could not write a file (disk space or file permissions), raised in ${fileOnly(h)}`
};

const T = {
    'syntax-error': h => `a PHP syntax error in ${where(h)}`,
    'duplicate-declaration': (h, o) => `${o.declaration ? `the ${o.declaration.kind} ${o.declaration.name}() is defined twice` : 'the same function or class is defined twice'} (${(h.evidence || []).map(e => e.file).filter(Boolean).slice(0, 2).join(' and ')}), and PHP stops when both load`,
    'missing-function': (h, o, c) => { const log = (h.supports || []).find(s => s.kind === 'log'), cl = log && c.clueById ? c.clueById(log.ref) : null; return `${joined(h, c)} calls ${cl && cl.value ? `${clip(cl.value, 60)}()` : 'a function or class'} that does not exist at that moment`; },
    'error-in-component': (h, o, c) => `a PHP error raised by ${joined(h, c)} in ${where(h)}`,
    'removed-function-call': (h, o) => o.message || `a call to a PHP function that no longer exists, in ${where(h)}`,
    'requires-php-mismatch': (h, o) => o.message || `${'the plugin'} needs a newer PHP than the one in use`,
    'requires-wp-mismatch': (h, o) => o.message || 'a component needs a newer WordPress than the one in use',
    'tested-up-to-older': (h, o) => o.message || 'a component was last tested with an older WordPress than the one in use',
    'remove-wrong-priority': (h, o, c) => `${joined(h, c)} tries to switch off a feature of another component but at the wrong moment, so nothing is switched off`,
    'removes-other-component-hook': (h, o, c) => `${joined(h, c)} switches off a feature that belongs to another component`,
    'hook-same-priority': (h, o, c) => `${joined(h, c)} both change the same thing at the same moment, so the result depends on which loads first`,
    'redirect-on-hook': (h, o, c) => `${joined(h, c)} sends visitors to another address${o.target ? ` (${clip(o.target, 60)})` : ''} when WordPress runs its "${(o.hooks && o.hooks[0] && o.hooks[0].hook) || o.hook || 'page'}" step`,
    'duplicate-ajax-action': (h, o, c) => `${joined(h, c)} both answer the same background request${o.action ? ` ("${o.action}")` : ''}, so both run`,
    'duplicate-rest-route': (h, o, c) => `${joined(h, c)} both register the same web address of the WordPress API${o.route ? ` (/${o.route})` : ''}`,
    'duplicate-shortcode': (h, o, c) => `${joined(h, c)} both use the shortcode [${o.shortcode || '…'}], so one of them stops working`,
    'duplicate-constant': (h, o, c) => `${joined(h, c)} both define the setting ${o.constant || '…'}; PHP keeps the first value and only warns`,
    'duplicate-script-handle': (h, o, c) => `${joined(h, c)} both register a script or style under the same name${o.handle ? ` ("${o.handle}")` : ''} with different files, so only the first one loads`,
    'duplicate-library': (h, o, c) => `the JavaScript library ${o.library || ''} is loaded more than once by ${joined(h, c)}`.replace(/\s+/g, ' '),
    'library-version-conflict': (h, o, c) => `the JavaScript library ${o.library || ''} is loaded in more than one version${o.versions ? ` (${o.versions.join(', ')})` : ''} by ${joined(h, c)}`.replace(/\s+/g, ' '),
    'js-global-collision': (h, o, c) => `${joined(h, c)} both define the same JavaScript name${o.global ? ` (${o.global})` : ''}, so the later script overwrites the earlier`,
    'localize-object-collision': (h, o, c) => `${joined(h, c)} both pass data to the page under the same name${o.object ? ` (${o.object})` : ''}`,
    'script-missing-dependency': (h, o, c) => `a script of ${joined(h, c)} needs jQuery but does not wait for it`,
    'handle-removed': (h, o, c) => `${joined(h, c)} removes a script or style that another component needs`,
    'handle-replaced': (h, o, c) => `${joined(h, c)} replaces ${o.core_handle ? "WordPress's own" : 'another component\'s'} script ${o.handle ? `"${o.handle}" ` : ''}with its own copy`,
    'dependency-handle-not-registered': (h, o, c) => `${joined(h, c)} asks for a script${o.missing ? ` ("${o.missing}")` : ''} that nothing provides, so its own script is not printed`,
    'jquery-api-version-mismatch': (h, o, c) => `${joined(h, c)} uses a jQuery feature${o.api ? ` (${o.api})` : ''} that the jQuery on the page does not have`,
    'css-selector-overlap': (h, o, c) => `${joined(h, c)} style the same element differently${o.selector ? ` (${clip(o.selector, 50)})` : ''}`,
    'template-override-outdated': (h, o, c) => `${joined(h, c)}: the theme uses an old copy of a plugin template${o.template ? ` (${o.template})` : ''}`,
    'missing-dependency': (h, o, c) => `${joined(h, c)} needs another plugin or theme that is not installed or not active`,
    'js-error-in-component': (h, o, c) => `a JavaScript error on the page comes from ${joined(h, c)}`,
    'failed-asset': (h, o, c) => `a file that the page needs from ${joined(h, c)} cannot be loaded`,
    'bisect-minimal-set': (h, o, c) => {
        const refs = h.components || [];
        if (!refs.length) return 'caused by the active theme (conflict partner not identified)';
        return refs.length === 1 ? `caused by ${plainRef(refs[0], c)} (conflict partner not identified)` : `caused by ${refs.map(r => plainRef(r, c)).join(' and ')} together`;
    },
    'classic:dep-missing': (h, o, c) => `${joined(h, c)} needs a plugin that is not installed`,
    'classic:dep-inactive': (h, o, c) => `${joined(h, c)} needs a plugin that is installed but not active`,
    'classic:dep-implied': (h, o, c) => `${joined(h, c)} uses code of a plugin that is not active`,
    'classic:dep-wp-version': (h, o, c) => `${joined(h, c)} needs a newer WordPress than the one installed`,
    'classic:dep-php-version': (h, o, c) => `${joined(h, c)} needs a newer PHP than the one the server runs`,
    'classic:theme-parent-missing': (h, o, c) => `the child ${joined(h, c)} needs its parent theme, which is not installed`,
    'classic:hook-priority': (h, o, c) => `${joined(h, c)} both change the same thing at the same moment`,
    'classic:hook-contradiction': (h, o, c) => `${joined(h, c)} force opposite values for the same setting`,
    'classic:hook-removed': (h, o, c) => `${joined(h, c)}: one switches off a feature of the other`,
    'classic:duplicate-feature': (h, o, c) => `${joined(h, c)} do the same job, which often causes double or broken output`,
    'classic:shared-table': (h, o, c) => `${joined(h, c)} use the same database table`,
    'classic:dropin-unrecognised': () => 'a file in wp-content that WordPress loads on every request, and that matches no known plugin',
    'classic:dropin-orphan': () => 'a leftover file in wp-content from a plugin that is no longer active',
    'classic:cfg-http-url': () => 'the site address in wp-config.php starts with http://, so visitors may be sent to an insecure or wrong address'
};

function cause(h, ctx = {}) {
    const obs = (ctx.obsOf && ctx.obsOf(h)) || {};
    if (h.class === 'compromise' || /^classic:integrity-/.test(h.type || '')) return `Possible compromise signs were found in ${fileOnly(h)} (pattern match, not proof)`;
    const env = environmentCause(h, ctx);
    if (env) return ENV_SENTENCE[env](h);
    const key = h.type === 'kb' ? `kb:${(h.kb || [])[0] || ''}` : h.type;
    if (T[h.type]) return clip(T[h.type](h, obs, ctx), 400);                  // a phrase that completes "The cause: ..." (no capital letter, no full stop)
    if (h.type === 'kb') return clip(first(h.mechanism) || h.title || key, 400).replace(/[.]$/, '');
    return clip(first(h.mechanism) || h.title || h.type || 'a possible cause', 400).replace(/[.]$/, '');
}

module.exports = { cause, plainRef, TYPES: Object.keys(T) };
