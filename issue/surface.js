// What a component offers to the rest of the site, read with the regex scanner already in lib/php.js plus a short list of extra calls
// (script/style handles, post types, blocks, menus). Used for components that are not analysed with the syntax tree (large third-party
// plugins), so the component index is complete without parsing 50 MB of someone else's code. Same output shape as phpast.js.

const php = require('../lib/php');

const EXTRA = /\b(wp_register_script|wp_enqueue_script|wp_register_style|wp_enqueue_style|wp_deregister_script|wp_dequeue_script|wp_deregister_style|wp_dequeue_style|register_post_type|register_taxonomy|register_block_type|register_block_type_from_metadata|add_menu_page|add_submenu_page|add_options_page)\s*\(/g;
const ASSET = { wp_enqueue_script: ['enqueue', 'script'], wp_register_script: ['register', 'script'], wp_enqueue_style: ['enqueue', 'style'], wp_register_style: ['register', 'style'], wp_dequeue_script: ['dequeue', 'script'], wp_deregister_script: ['deregister', 'script'], wp_dequeue_style: ['dequeue', 'style'], wp_deregister_style: ['deregister', 'style'] };

// -> facts in the shape of phpast.analyse (hooks carry the callback as a plain name; priority may be null)
function scan(raw, file, regexScan) {
    const s = regexScan || php.scanSource(raw, file);
    const f = {
        file, parsed: true, errors: [], fallback: 'regex', bundled: !!s.bundled,
        functions: s.functions.map(x => ({ name: x.name || x, line: x.line || null, guarded: !!x.guarded })),
        classes: s.classes.map(x => ({ name: x.name || x, line: x.line || null, kind: 'class', guarded: !!x.guarded })),
        constants: [], shortcodes: s.shortcodes.map(x => ({ tag: x.tag, line: x.line })),
        rest: s.restRoutes.map(x => ({ namespace: x.namespace, route: typeof x.route === 'string' ? x.route : null, line: x.line })),
        ajax: s.ajax.map(x => ({ action: x.action, nopriv: x.nopriv, line: x.line })),
        hooks: [], assets: [], localize: [], cpts: [], taxonomies: [], blocks: [], menus: [], options: [], globals: [], db: [], includes: []
    };
    for (const h of s.hooks) f.hooks.push({ op: 'add', hook: h.hook, callback: { kind: h.identity ? h.identity.kind : 'dynamic', name: h.callback, raw: h.callbackRaw }, priority: h.priority, line: h.line });
    for (const h of s.removals) f.hooks.push({ op: 'remove', hook: h.hook, callback: { kind: h.identity ? h.identity.kind : 'dynamic', name: h.callback, raw: h.callbackRaw }, priority: h.priority, line: h.line });
    const code = php.phpSegments(raw), text = php.clean(code, false);
    let m;
    EXTRA.lastIndex = 0;
    while ((m = EXTRA.exec(text))) {
        const { args } = php.parseArgs(text, m.index + m[0].length - 1);
        const name = php.literal(args[0]);
        if (!name) continue;
        const ln = text.slice(0, m.index).split('\n').length, fn = m[1];
        if (ASSET[fn]) f.assets.push({ op: ASSET[fn][0], type: ASSET[fn][1], handle: name, src: null, deps: null, line: ln });
        else if (fn === 'register_post_type') f.cpts.push({ name, line: ln });
        else if (fn === 'register_taxonomy') f.taxonomies.push({ name, line: ln });
        else if (fn.startsWith('register_block_type')) f.blocks.push({ name, line: ln });
        else f.menus.push({ slug: fn === 'add_submenu_page' ? php.literal(args[3]) || name : php.literal(args[2]) || name, via: fn, line: ln });
    }
    return f;
}

module.exports = { scan };
