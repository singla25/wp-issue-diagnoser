// Conflict checks between ACTIVE plugins: fatal redeclarations, hooks with order-dependent outcomes,
// contradicting filters, one plugin removing another's hook, shared constants/tables/shortcodes/AJAX
// actions, and two plugins doing the same job. Hook collisions come with a resolution (priority order).

const { finding } = require('../lib/finding');
const { categoryOf } = require('../lib/categories');

// Hooks where several plugins acting at the same priority gives an order-dependent (and for the
// security ones, possibly bypassable) outcome.
const SECURITY_HOOKS = new Set([
    'authenticate', 'wp_authenticate_user', 'rest_authentication_errors', 'determine_current_user',
    'xmlrpc_enabled', 'xmlrpc_methods', 'login_errors', 'user_has_cap', 'map_meta_cap',
    'upload_mimes', 'wp_handle_upload_prefilter', 'rest_pre_dispatch', 'allowed_http_origins', 'wp_headers'
]);
const ORDER_HOOKS = new Set([...SECURITY_HOOKS, 'login_redirect', 'wp_redirect', 'template_include', 'send_headers']);
// For a hook two plugins force to opposite constants, the value a hardened site wants.
const SECURE_VALUE = { xmlrpc_enabled: '__return_false', rest_enabled: '__return_true' };

const byPlugin = (ctx, fn) => ctx.active.flatMap(p => p.scans.flatMap(s => fn(s, p).map(x => ({ ...x, plugin: p.ref, file: s.file, bundled: s.bundled }))));
const loc = (ctx, i) => ctx.bySlug.get(i.plugin).loc(i.file, i.line);

function groupBy(items, keyFn) {
    const m = new Map();
    for (const i of items) {
        const k = keyFn(i);
        if (!m.has(k)) m.set(k, []);
        m.get(k).push(i);
    }
    return m;
}
const distinctPlugins = items => [...new Set(items.map(i => i.plugin))];

// Order in which colliding plugins should run (first runs first): config precedence, then security
// categories, then name. Deterministic so the generated patch is reproducible.
function orderFor(ctx, slugs) {
    const prec = ctx.config.precedence || [];
    const rank = s => {
        const i = prec.indexOf(s);
        if (i >= 0) return [0, i];
        const cat = categoryOf(ctx.bySlug.get(s), ctx.config);
        return [cat && cat.security ? 1 : 2, 0];
    };
    return [...slugs].sort((a, b) => {
        const ra = rank(a), rb = rank(b);
        return ra[0] - rb[0] || ra[1] - rb[1] || a.localeCompare(b);
    });
}

function run(ctx) {
    const out = [];

    // 1. same function/class name declared by two plugins
    for (const [kind, key] of [['function', 'functions'], ['class', 'classes']]) {
        const all = byPlugin(ctx, s => s[key]);
        for (const [name, items] of groupBy(all, i => i.name.toLowerCase())) {
            const plugins = distinctPlugins(items);
            if (plugins.length < 2) continue;
            const unguarded = items.filter(i => !i.guarded);
            const bundled = items.some(i => i.bundled);
            const libraryCopies = unguarded.length >= 2 && unguarded.every(i => i.bundled);
            out.push(finding({
                rule: `redeclare-${kind}`, severity: unguarded.length >= 2 && !libraryCopies ? 'P0' : 'P2', category: 'conflict',
                confidence: unguarded.length >= 2 && !libraryCopies ? 'likely' : 'possible', plugins, key: name,
                title: `${kind} ${items[0].name}() is declared by ${plugins.join(' and ')}`,
                detail: libraryCopies
                    ? 'Both copies sit in bundled-library folders. Libraries like this usually have a loader that picks one copy, so this is probably safe, but the two plugins then share one version. Check that the loaded version is the newer one.'
                    : unguarded.length >= 2
                    ? `Neither declaration is guarded, so loading both plugins is a PHP fatal ("Cannot redeclare") — a white screen that takes the site's protections down with it.${bundled ? ' It looks like a bundled library: both plugins ship their own copy.' : ''}`
                    : 'One declaration is wrapped in an existence check, so this loads, but the plugins then share one implementation and the first loaded wins — behaviour may differ from what the second plugin expects.',
                evidence: items.map(i => `${loc(ctx, i)}${i.guarded ? ' (guarded)' : ''}`),
                fix: 'Deactivate one of the plugins, or update them so the bundled library is namespaced / guarded. Load order cannot fix a redeclaration.'
            }));
        }
    }

    // 2. hook priority collisions
    const adds = byPlugin(ctx, s => s.hooks).filter(h => h.priority !== null);
    for (const [hook, items] of groupBy(adds, h => h.hook)) {
        const plugins = distinctPlugins(items);
        if (plugins.length < 2) continue;
        const security = SECURITY_HOOKS.has(hook);

        // 2a. contradicting constants on the same filter
        const trues = items.filter(i => /^['"]?__return_true['"]?$/.test(i.callbackRaw));
        const falses = items.filter(i => /^['"]?__return_false['"]?$/.test(i.callbackRaw));
        if (trues.length && falses.length && distinctPlugins([...trues, ...falses]).length > 1) {
            const secure = SECURE_VALUE[hook];
            out.push(finding({
                rule: 'hook-contradiction', severity: security ? 'P1' : 'P2', category: 'conflict', confidence: 'certain', key: hook,
                plugins: distinctPlugins([...trues, ...falses]),
                title: `Plugins force opposite values on "${hook}"`,
                detail: `${distinctPlugins(trues).join(', ')} return true while ${distinctPlugins(falses).join(', ')} return false. The one with the higher priority number wins, which is accidental.`,
                evidence: items.map(i => `${loc(ctx, i)} priority ${i.priority}`),
                done: 'Only one value is applied on this hook.',
                fix: secure ? `Pin the hardened value (${secure === '__return_false' ? 'false' : 'true'}) with a late priority (code in the "Shared code" part of the fix file).` : 'Decide which plugin owns this setting and disable it in the other.',
                patch: secure ? { type: 'secure-filter', hook, callback: secure } : null
            }));
            continue;
        }

        // 2b. same priority on an order-sensitive hook
        if (!ORDER_HOOKS.has(hook)) continue;
        const byPrio = groupBy(items, i => i.priority);
        for (const [prio, same] of byPrio) {
            const ps = distinctPlugins(same);
            if (ps.length < 2) continue;
            const order = orderFor(ctx, ps);
            const resolution = order.map((ref, idx) => ({ hook, ref, kind: ctx.bySlug.get(ref).kind, slug: ctx.bySlug.get(ref).slug, priority: Number(prio) + idx }));
            out.push(finding({
                rule: 'hook-priority', severity: security ? 'P1' : 'P2', category: 'conflict', key: `${hook}@${prio}`,
                plugins: ps,
                title: `${ps.join(' and ')} both hook "${hook}" at priority ${prio}`,
                detail: `With equal priority WordPress runs them in load order, so the result depends on which plugin loads first.${security ? ' This is a security hook: one plugin can undo or bypass the other\'s check.' : ''}`,
                evidence: same.map(i => loc(ctx, i)),
                fix: `Run them in this order: ${order.join(' → ')} (priorities ${resolution.map(r => r.priority).join(', ')}). Code is in the "Shared code" part of the fix file. Change the order with "precedence" in the project's project.json.`,
                done: 'Both plugins run in the stated order (priorities differ) and login still works.',
                patch: { type: 'reprioritize', items: resolution }
            }));
        }
        if (security && byPrio.size > 1 && ![...byPrio.values()].some(v => distinctPlugins(v).length > 1)) {
            const sorted = [...byPrio.entries()].sort((a, b) => a[0] - b[0]);
            out.push(finding({
                rule: 'hook-order-note', severity: 'P3', category: 'conflict', confidence: 'certain', key: hook, plugins,
                title: `Order of security hook "${hook}": ${sorted.map(([p, v]) => `${distinctPlugins(v).join('+')}@${p}`).join(' → ')}`,
                detail: 'Different priorities, so the order is deterministic. Check that the plugin running last is the one you want to have the final say.',
                evidence: items.map(i => `${loc(ctx, i)} priority ${i.priority}`), fix: 'No action needed if the order is intended.'
            }));
        }
    }

    // 3. one plugin removes a hook another plugin adds. Only when both name the SAME callable (a function, or Class::method):
    //    remove_action('x', [$this, 'x']) removes the plugin's own method and says nothing about another plugin that has a method of the same name.
    const sameCallable = (a, b) => a && b && a.kind === b.kind && (a.kind === 'function' ? a.name === b.name : a.kind === 'static' && a.cls === b.cls && a.method === b.method);
    const removals = byPlugin(ctx, s => s.removals);
    const seenRem = new Set();
    for (const r of removals) {
        if (!r.identity || !['function', 'static'].includes(r.identity.kind)) continue;
        for (const p of ctx.active) {
            if (p.ref === r.plugin) continue;
            const target = p.scans.flatMap(s => s.hooks.map(h => ({ ...h, file: s.file }))).find(h => h.hook === r.hook && sameCallable(h.identity, r.identity));
            const k = `${r.plugin}>${p.ref}:${r.hook}:${r.callback}`;
            if (!target || seenRem.has(k)) continue;
            seenRem.add(k);
            out.push(finding({
                rule: 'hook-removed', severity: SECURITY_HOOKS.has(r.hook) ? 'P1' : 'P2', category: 'conflict', confidence: 'likely', key: k,
                plugins: [r.plugin, p.ref],
                title: `${r.plugin} removes "${r.callback}" that ${p.ref} adds on "${r.hook}"`,
                detail: `${loc(ctx, r)} calls remove_action/remove_filter on a callback registered by ${p.ref}. If that callback is a protection, it is silently switched off.`,
                evidence: [loc(ctx, r), p.loc(target.file, target.line)],
                fix: `Check whether ${r.plugin} is meant to replace ${p.ref}'s behaviour. If not, deactivate one of them.`
            }));
        }
    }

    // 4. shared constants, tables, shortcodes, AJAX actions
    const sharedRules = [
        ['constant', s => s.constants.map(c => ({ name: c.name, guarded: c.guarded })), (n, items) => items.filter(i => !i.guarded).length >= 2 ? 'P2' : null,
            'defined by two plugins: the first definition wins and PHP warns on the second, so one plugin runs with the other\'s value'],
        ['table', s => s.tables.map(t => ({ name: t })), () => 'P1', 'created by two plugins: they will read and overwrite each other\'s data'],
        ['shortcode', s => s.shortcodes.map(x => ({ name: x.tag, line: x.line })), () => 'P2', 'registered by two plugins: the last one loaded silently replaces the other'],
        ['ajax-action', s => s.ajax.map(x => ({ name: `${x.action}${x.nopriv ? ' (nopriv)' : ''}`, line: x.line })), () => 'P2', 'is handled by two plugins: both handlers run for the same request']
    ];
    for (const [kind, extract, sev, why] of sharedRules) {
        const all = byPlugin(ctx, extract);
        for (const [name, items] of groupBy(all, i => i.name)) {
            const plugins = distinctPlugins(items);
            const severity = plugins.length > 1 && sev(name, items);
            if (!severity) continue;
            out.push(finding({
                rule: `shared-${kind}`, severity, category: 'conflict', key: name, plugins,
                title: `${kind} "${name}" is used by ${plugins.join(' and ')}`, detail: `The ${kind} ${why}.`,
                evidence: items.map(i => `${loc(ctx, i)}`), fix: 'Deactivate one plugin, or ask the vendor to prefix the name.'
            }));
        }
    }

    // 5. two plugins doing the same job
    for (const [cat, group] of groupBy(ctx.active.filter(p => p.kind === 'plugin' || p.kind === 'mu').map(p => ({ p, cat: categoryOf(p, ctx.config) })).filter(x => x.cat), x => x.cat.id)) {
        if (group.length < 2) continue;
        const c = group[0].cat;
        const slugs = group.map(x => x.p.ref);
        const prefer = (ctx.config.prefer || {})[cat];
        const keep = prefer && slugs.includes(prefer) ? prefer : null;
        const drop = slugs.filter(s => s !== keep);
        out.push(finding({
            rule: 'duplicate-feature', severity: c.security ? 'P1' : cat === 'backup' ? 'P3' : 'P2', category: 'conflict', confidence: 'likely', key: cat, plugins: slugs,
            title: `Two ${c.label} plugins are active: ${slugs.join(', ')}`,
            detail: c.security
                ? 'Security plugins of the same type compete for the same hooks, files (.htaccess, auto_prepend_file) or login flow. Typical results: lock-outs, double-blocked requests, or each one disabling the other\'s rules.'
                : 'Running two of the same type duplicates work and often produces broken output or double requests.',
            fix: keep ? `Keep ${keep} (config "prefer"), deactivate ${drop.join(', ')}.` : `Keep one. Set "prefer": {"${cat}": "<slug>"} in the project's project.json to get the exact commands.`,
            commands: keep ? drop.filter(s => ctx.bySlug.get(s).kind === 'plugin').map(s => `wp plugin deactivate ${s}`) : [], owner: 'admin', done: keep ? `Only ${keep} is active for this job.` : 'Only one plugin is active for this job.'
        }));
    }
    return out;
}

module.exports = { run, SECURITY_HOOKS };
