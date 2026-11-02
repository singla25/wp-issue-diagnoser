// Who redirects, and on which hook. Two parts, split on purpose:
//   build(analysis)  the STATIC map, from the syntax-tree facts: every wp_redirect() / wp_safe_redirect() / header( 'Location: ...' ) call, with the function,
//                    method or closure around it, matched to the add_action / add_filter that registers that function or method IN THE SAME COMPONENT.
//                    Closures, file-scope calls and functions nothing in the component registers stay unmatched and say "unknown hook context".
//                    The map is written to custom-code.json whatever happens later.
//   join(map, ...)   the OBSERVATION join, done by hypotheses.build AFTER the probe (and again after the sandbox): a redirect-on-hook candidate exists only if a
//                    redirect was observed, or the reporter's symptom is "redirect". A redirect on template_redirect or a login hook is common in legitimate
//                    plugins: without an observed redirect it is a clue (it stays in the map), not a finding.
// Nothing here assigns a status; hypotheses.js emits at most PROBABLE_NEEDS_REVIEW and only issue/validate.js can CONFIRM, REPRODUCE or REJECT.

const schema = require('../lib/schema');

const COMMON_HOOKS = new Set(['template_redirect', 'login_redirect', 'wp_login', 'wp_login_failed', 'login_init', 'auth_redirect', 'login_head']);
const isCommon = hook => COMMON_HOOKS.has(hook) || /^login_form_/.test(hook || '');
const last = s => String(s || '').replace(/^\\+/, '').split('\\').pop().toLowerCase();
const describe = i => !i ? 'file scope' : i.kind === 'closure' ? 'a closure' : i.kind === 'method' ? `${i.class ? last(i.class) + '::' : ''}${i.name}()` : `${i.name}()`;

// the hooks (of the same component) whose callback is the function or method a redirect sits in
function hooksFor(redirect, hooks) {
    const i = redirect.in;
    if (!i || i.kind === 'closure') return [];
    return hooks.filter(h => {
        if (h.op !== 'add' || !h.hook || !h.callback) return false;
        const cb = h.callback;
        if (i.kind === 'function') return cb.kind === 'function' && last(cb.name) === last(i.name);
        if (cb.kind !== 'method' || String(cb.name).toLowerCase() !== String(i.name).toLowerCase()) return false;
        const c = String(cb.class || '');
        if (['$this', 'self', 'static'].includes(c)) return h.owner_class && last(h.owner_class) === last(i.class);
        if (c.startsWith('instance:')) return last(c.slice(9)) === last(i.class);
        if (c.startsWith('$') || c === 'parent') return false;         // a variable or a parent class: the class is not known
        return last(c) === last(i.class);                              // 'Class::m' and [Class::class, 'm']
    });
}

function build(analysis) {
    const map = [];
    for (const [ref, m] of Object.entries(analysis.facts)) {
        for (const r of m.redirects || []) {
            const hooks = hooksFor(r, m.hooks || []).map(h => ({ hook: h.hook, priority: h.priority, file: h.file, line: h.line })).sort((a, b) => a.hook.localeCompare(b.hook) || (a.priority || 0) - (b.priority || 0));
            const matched = hooks.length > 0;
            map.push({ component: ref, file: r.file, line: r.line, call: r.call, target: r.target, dynamic_target: !!r.dynamic, status: r.status, enclosing: describe(r.in), enclosing_kind: r.in ? r.in.kind : 'file',
                hooks, context: matched ? 'hook' : 'unknown', common: matched && hooks.every(h => isCommon(h.hook)),
                unknown_reason: matched ? null : !r.in ? 'file scope: it runs when the file is loaded, not on a hook' : r.in.kind === 'closure' ? 'unknown hook context: a closure cannot be matched to the hook that runs it' : `unknown hook context: nothing in ${ref} registers ${describe(r.in)} as a hook callback` });
        }
    }
    return map.sort((a, b) => a.component.localeCompare(b.component) || String(a.file).localeCompare(String(b.file)) || (a.line || 0) - (b.line || 0));
}

// -> observations for hypotheses.js. observed: a probe or the sandbox saw a redirect. symptom: the issue's symptom.
function join(map, { observed = false, symptom = null, reported = false, refOf = {} } = {}) {
    const out = [];
    for (const e of map) {
        if (e.context !== 'hook') continue;
        if (!observed && !((symptom === 'redirect' || reported) && !e.common)) continue;      // common hooks are a clue, not a finding, unless a redirect was seen
        const hooks = e.hooks.map(h => `${h.hook}${h.priority === null || h.priority === undefined ? '' : ' @' + h.priority}`).join(', ');
        const c = refOf[e.component];
        out.push({ type: 'redirect-on-hook', components: [e.component], custom: !!c && !c.inspection_only, observed: !!observed, common: e.common, hook: e.hooks[0].hook, hooks: e.hooks, call: e.call, target: e.target,
            id: schema.stableId('obs', 'redirect-on-hook', e.component, `${e.file}:${e.line}`),
            evidence: [{ file: e.file, line: e.line, component: e.component, role: 'redirects' }],
            message: `${e.component} calls ${e.call === 'header' ? "header( 'Location: …' )" : e.call + '()'} in ${e.enclosing}, which runs on ${hooks}${e.target ? ` (to ${e.target})` : ''}` });
    }
    return out;
}

module.exports = { build, join, hooksFor, isCommon, describe, COMMON_HOOKS };
