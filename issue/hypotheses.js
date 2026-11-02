// Phase F: a short, ranked list of hypotheses. Each one says which components are involved, the mechanism in plain words, what supports it,
// what speaks against it, and the test that would prove or disprove it. Nothing here is a verdict: the status is at most
// PROBABLE_NEEDS_REVIEW; only the validation step may promote it, and only a deterministic check (a reproduced oracle, a bisect result,
// a re-read of the file) may do that. The score is the sum of the rules in SCORING, printed with every hypothesis; there are no hidden weights.

const schema = require('../lib/schema');

const MAX_HYPOTHESES = 5;
const SCORING = [
    { rule: 'support:log', points: 3, why: 'a log line (parsed, certain) names it' },
    { rule: 'support:bisect', points: 5, why: 'in the sandbox the symptom appears only when these components are active together (a minimal set found by delta debugging); the validation step is what may turn this into REPRODUCIBLE' },
    { rule: 'support:probe', points: 2.5, why: 'the live page showed it when it was loaded (observed, not inferred)' },
    { rule: 'support:observation', points: 2.5, why: 'the code analysis found the construct, with file and line' },
    { rule: 'support:collision', points: 2.5, why: 'the JavaScript / CSS analysis found the collision' },
    { rule: 'support:kb-verified', points: 2, why: 'it matches a knowledge-base entry whose sources were checked' },
    { rule: 'support:kb-unverified', points: 1, why: 'it matches a knowledge-base entry whose sources were NOT checked' },
    { rule: 'support:ocr', points: 1, why: 'text read by OCR from a screenshot mentions it (may contain mistakes)' },
    { rule: 'support:description', points: 0.5, why: 'the report mentions it' },
    { rule: 'support:graph-relevant-unverified', points: 1, why: 'same, but the only reason the hook is "relevant" is a taxonomy signal that was NOT verified against official documentation (and the two components are not both named by the evidence), so it counts half' },
    { rule: 'support:graph-relevant', points: 2, why: 'two components touch the same thing (a hook, option or handle) AND that thing belongs to a feature named in the report or both components are named by the evidence; this is context, not proof' },
    { rule: 'support:index', points: 0.5, why: 'the component provides a feature named in the report, and at least one taxonomy signal behind that was checked against official documentation' },
    { rule: 'support:index-unverified', points: 0.25, why: 'same, but NONE of the taxonomy signals behind it was verified, so it counts half' },
    { rule: 'independent-sources', points: 1.5, why: 'per additional kind of evidence that agrees (log / observation / collision / kb / graph / ocr); a mention in the description or a feature match does not count as evidence' },
    { rule: 'stack:error-site', points: 3, why: 'a component of the hypothesis is where the logged error was raised' },
    { rule: 'stack:in-trace', points: 1.5, why: 'a component of the hypothesis appears elsewhere in a logged stack trace' },
    { rule: 'timing', points: 2, why: 'a component was modified within 3 days of the "since" date in the report' },
    { rule: 'custom', points: 1.5, why: 'custom (allowlisted) code is involved, so a fix task is possible' },
    { rule: 'symptom-mismatch', points: -3, why: 'this kind of problem does not normally produce the reported symptom type' },
    { rule: 'contradiction', points: -2, why: 'something that was checked speaks against it (for example, the log was read and has no fatal error)' }
];
const W = Object.fromEntries(SCORING.map(r => [r.rule, r.points]));

// kind of problem -> symptom types it normally produces ("other" accepts everything)
const FAMILY_SYMPTOMS = {
    bisect: ['white-screen', 'js-error', 'layout', 'form-checkout', 'login-admin', 'slow', 'wrong-content', 'other', 'redirect'],
    fatal: ['white-screen', 'login-admin', 'form-checkout', 'wrong-content'],
    js: ['js-error', 'layout', 'form-checkout', 'login-admin', 'slow'],
    layout: ['layout', 'js-error', 'wrong-content'],
    hook: ['wrong-content', 'form-checkout', 'login-admin', 'js-error', 'white-screen', 'slow', 'redirect'],
    cache: ['wrong-content', 'form-checkout', 'login-admin', 'slow', 'js-error', 'layout', 'redirect'],
    template: ['layout', 'form-checkout', 'wrong-content', 'js-error'],
    config: ['wrong-content', 'form-checkout', 'login-admin', 'redirect', 'slow', 'other'],   // PHP only warns about a second define(): never the 'fatal' family
    compromise: ['white-screen', 'redirect', 'js-error', 'wrong-content', 'login-admin', 'other'],
    redirect: ['redirect', 'login-admin', 'wrong-content'],
    compat: ['white-screen', 'login-admin', 'form-checkout', 'wrong-content', 'js-error', 'redirect', 'other']
};
const FAMILY_OF = { 'duplicate-declaration': 'fatal', 'syntax-error': 'fatal', 'missing-function': 'fatal', 'error-in-component': 'fatal', 'missing-dependency': 'fatal', 'js-error-in-component': 'js', 'failed-asset': 'js', 'bisect-minimal-set': 'bisect',
    'library-version-conflict': 'js', 'duplicate-library': 'js', 'js-global-collision': 'js', 'jquery-api-version-mismatch': 'js', 'script-missing-dependency': 'js', 'handle-replaced': 'js', 'handle-removed': 'js', 'dependency-handle-not-registered': 'js', 'localize-object-collision': 'js',
    'css-selector-overlap': 'layout', 'template-override-outdated': 'template', 'remove-wrong-priority': 'hook', 'removes-other-component-hook': 'hook', 'hook-same-priority': 'hook', 'kb': 'cache',
    'duplicate-constant': 'config', 'duplicate-shortcode': 'hook', 'duplicate-ajax-action': 'hook', 'duplicate-rest-route': 'hook', 'duplicate-script-handle': 'js',
    'removed-function-call': 'fatal', 'requires-php-mismatch': 'compat', 'requires-wp-mismatch': 'compat', 'tested-up-to-older': 'compat', 'redirect-on-hook': 'redirect' };

const MECH = {
    'duplicate-declaration': o => `${o.declaration.kind} ${o.declaration.name} is declared in ${o.components.join(' and ')}. When both load, PHP stops with "Cannot redeclare" and the page is blank (${o.risk}).`,
    'remove-wrong-priority': o => `${((o.evidence || []).find(e => e.role === 'removes') || {}).component || o.components[0]} tries to remove ${o.callback} from ${o.hook} at priority ${o.removed_priority === null ? 10 : o.removed_priority}, but it was added at priority ${o.added_priority}. The removal silently does nothing, so the callback it meant to disable still runs.`,
    'removes-other-component-hook': o => `${o.message}. Whatever that callback did for ${o.components.join('/')} no longer happens.`,
    'handle-replaced': o => `${o.removed_by} removes the "${o.handle}" ${o.handle_type} and registers its own${o.replacement && o.replacement.ver ? ` (version ${o.replacement.ver})` : ''}${o.core_version ? ` in place of WordPress's ${o.core_version}` : ''}. Everything that depends on "${o.handle}" now gets the replacement.`,
    'handle-removed': o => `${o.removed_by} removes the "${o.handle}" ${o.handle_type}${o.registered_by.length ? ` that ${o.registered_by.join(', ')} registers` : ''}, so what relies on it does not load.`,
    'dependency-handle-not-registered': o => `"${o.handle}" depends on "${o.missing}", which nothing registers, so WordPress will not print "${o.handle}" at all.`,
    'localize-object-collision': o => `${o.components.join(' and ')} both create the JavaScript object "${o.object}"; the one printed later overwrites the other's data.`,
    'template-override-outdated': o => `${o.components[0]} overrides WooCommerce's ${o.template} at version ${o.theme_version}; the plugin's own copy is ${o.plugin_version}, so changes made in the plugin are missing from what the page uses.`,
    'syntax-error': o => `${o.evidence[0].file} does not parse (${o.message.replace(/^php -l reports a syntax error in \S+: /, '')}). PHP stops when it loads that file.`
};
MECH['duplicate-shortcode'] = o => `The shortcode [${o.shortcode}] is registered by ${o.components.join(' and ')}. WordPress keeps the registration that runs last, so one of them silently stops working wherever the shortcode is used.`;
MECH['duplicate-ajax-action'] = o => `${o.components.join(' and ')} both handle the AJAX action "${o.action}"${o.nopriv ? ' (for visitors who are not logged in)' : ''}. Both handlers run for the same request, so the answer can be doubled or cut short.`;
MECH['duplicate-rest-route'] = o => `${o.components.join(' and ')} both register the REST route /${o.route}. Only one can answer, so clients get the other's response format.`;
MECH['duplicate-script-handle'] = o => `${o.components.join(' and ')} both register the ${o.handle_type} handle "${o.handle}" with different files. WordPress keeps the first and ignores the second, so what loads depends on plugin order.`;
MECH['duplicate-constant'] = o => `${o.components.join(' and ')} both define the constant ${o.constant}. PHP keeps the first value and only prints a warning, so one of them runs with the other's value. This is not a crash.`;
MECH['removed-function-call'] = o => `${o.components.join(' and ')} calls ${o.function}(), which was removed in PHP ${o.removed_in}. On PHP ${o.removed_in} or newer the call stops PHP with "Call to undefined function ${o.function}()". Checked ${o.php_label}.`;
MECH['requires-php-mismatch'] = o => `${o.components.join(' and ')} says it needs PHP ${o.requires}; checked ${o.php_label}. A plugin run on an older PHP than it was written for can fail on load. This is the plugin's own statement, not an observed failure.`;
MECH['requires-wp-mismatch'] = o => `${o.components.join(' and ')} says it needs WordPress ${o.requires}; this site runs ${o.wp_version}. It may use functions this WordPress does not have. This is the plugin's own statement, not an observed failure.`;
MECH['tested-up-to-older'] = o => `${o.components.join(' and ')} was last tested with WordPress ${o.tested}; this site runs ${o.wp_version}. Newer WordPress versions can change behaviour a plugin relies on. A reminder, not a fault.`;
const COLL_MECH = {
    'library-version-conflict': c => `${c.library} is loaded in more than one version (${c.versions.join(', ')}) by ${c.components.join(', ')}; plugins attached to one copy do not exist on the other.`,
    'duplicate-library': c => `${c.library} is loaded more than once by ${c.components.join(', ')}; the second copy can replace the first one's plugins and globals.`,
    'js-global-collision': c => `${c.components.join(' and ')} both assign ${c.global}; the later script overwrites the earlier.`,
    'jquery-api-version-mismatch': c => `${c.evidence[0].file} calls ${c.api}, which needs ${c.needs.replace('jQuery ', 'jQuery ')}; the jQuery that loads is ${c.effective_jquery} (${c.effective_source}), so the call fails and the rest of that script does not run.`,
    'script-missing-dependency': c => `${c.evidence[0].file} uses jQuery but "${c.handle}" does not depend on it, so it can run before jQuery exists.`,
    'css-selector-overlap': c => `${c.components.join(' and ')} style "${c.selector}" with different values for ${c.conflicting_properties.map(p => p.property).join(', ')}; which one wins depends on load order and specificity.`
};

const ADVISORY_TYPES = new Set(['removed-function-call', 'requires-php-mismatch', 'requires-wp-mismatch', 'tested-up-to-older']);
const NEW_DUP_TYPES = new Set(['duplicate-shortcode', 'duplicate-ajax-action', 'duplicate-rest-route', 'duplicate-script-handle', 'duplicate-constant']);
const toRef = id => String(id).replace(/^plugin:/, '');
const dayMs = 86400000;

// ctx: { issue, evidence, analysis, index, collide, graph, kb, description:{dates}, logs:{entries} }
function build(ctx) {
    const { issue, evidence, analysis, collide, graph, kb } = ctx;
    const refOf = Object.fromEntries(analysis.components.map(c => [c.ref, c]));
    const cands = new Map();
    const add = (type, comps, extra, support, base) => {
        const components = [...new Set(comps)].filter(Boolean).sort();
        const key = `${type}|${components.join(',')}|${extra || ''}`;
        const c = cands.get(key) || { type, components, supports: [], contradicts: [], ...base, key };
        for (const s of support) if (!c.supports.some(x => x.kind === s.kind && x.ref === s.ref)) c.supports.push(s);
        Object.assign(c, base, { supports: c.supports, contradicts: c.contradicts, key, type, components });
        cands.set(key, c);
        return c;
    };

    // ---- from log clues (certain) ----
    const logClues = evidence.clues.filter(c => c.source.kind === 'log');
    for (const c of logClues) {
        if (c.type === 'php-redeclare') {
            const prev = c.detail.previous_file && require('../lib/ownership').componentOf(c.detail.previous_file);
            const site = logClues.find(x => x.type === 'php-location' && x.source.line === c.source.line && x.source.ref === c.source.ref);
            const siteComp = site && require('../lib/ownership').componentOf(site.detail.file);
            const comps = [prev, siteComp].filter(Boolean).map(toRef);
            const name = String(c.value).toLowerCase();
            const obs = analysis.observations.find(o => o.type === 'duplicate-declaration' && o.declaration.name.toLowerCase().replace(/^.*\\/, '') === name.replace(/^.*\\/, ''));
            if (obs) add('duplicate-declaration', obs.components, name, [{ kind: 'log', ref: c.id, text: `log: Cannot redeclare ${c.value}()${c.detail.log ? ` (seen ${c.detail.log.count}x, last ${c.detail.log.last_seen})` : ''}`, file: c.snippet }], { family: 'fatal', obs });
            else if (comps.length) add('duplicate-declaration', comps, name, [{ kind: 'log', ref: c.id, text: `log: Cannot redeclare ${c.value}()` }], { family: 'fatal', mechanism: `The log shows "Cannot redeclare ${c.value}()": two files declare it and both loaded.` });
        }
        if (c.type === 'php-undefined-function' || c.type === 'php-class-not-found') {
            const owners = Object.entries(analysis.facts).filter(([, m]) => [...m.functions, ...m.classes].some(f => String(f.name).toLowerCase().replace(/^.*\\/, '') === String(c.value).toLowerCase().replace(/^.*\\/, ''))).map(([r]) => r);
            const site = logClues.find(x => x.type === 'php-location' && x.source.line === c.source.line && x.source.ref === c.source.ref);
            const siteComp = site && toRef(require('../lib/ownership').componentOf(site.detail.file) || '');
            add('missing-function', [siteComp, ...owners].filter(Boolean), String(c.value).toLowerCase(), [{ kind: 'log', ref: c.id, text: `log: ${c.type === 'php-class-not-found' ? 'class not found' : 'call to undefined function'} ${c.value}` }],
                { family: 'fatal', mechanism: `The log shows a call to ${c.value}, which was not defined at that moment. ${owners.length ? `It is declared in ${owners.join(', ')}, so that code was probably not loaded yet, not active, or loaded after the call.` : 'No scanned component declares it, so the plugin that should provide it may be missing or deactivated.'}` });
        }
        if (['php-fatal', 'php-notice'].includes(c.type) && c.detail && c.detail.file && c.detail.level !== 'notice' && c.detail.level !== 'deprecated') {
            const comp = toRef(require('../lib/ownership').componentOf(c.detail.file) || '');
            if (comp) add('error-in-component', [comp], '', [{ kind: 'log', ref: c.id, text: `log: ${c.detail.level} in ${c.detail.file}:${c.detail.line}` }], { family: 'fatal', mechanism: `The log shows a ${c.detail.level} raised in ${c.detail.file}:${c.detail.line}.` });
        }
    }
    // ---- from OCR / description clues: only to support existing candidates later ----

    // ---- observations ----
    const clueCx = require('./clue-match').context(evidence, issue, FAMILY_SYMPTOMS);
    const bisectComps = new Set(((ctx.bisect && ctx.bisect.causes) || []).flatMap(c => c.plugins.map(toRef)));
    const probeClueOf = comp => evidence.clues.find(c => c.source.kind === 'probe' && c.detail && c.detail.component && toRef(c.detail.component) === comp);
    const probeComps = new Set(evidence.clues.filter(c => c.source.kind === 'probe' && c.detail && c.detail.component).map(c => toRef(c.detail.component)));
    for (const o of analysis.observations) {
        // duplicates of a shortcode / AJAX action / REST route / handle / constant are common and mostly harmless: they become a hypothesis only when
        // custom code is involved or the report points at them (a named component, a file in a log, or a symptom this kind of problem produces)
        // advisories (versions in headers, calls to removed functions) stay in custom-code.json unless a clue implicates the component
        if (o.advisory && !o.components.some(c => clueCx.named.has(c) || bisectComps.has(c) || probeComps.has(c))) continue;
        if (NEW_DUP_TYPES.has(o.type) && !o.custom && !require('./clue-match').matches({ components: o.components, evidence: o.evidence, family: FAMILY_OF[o.type], severity: 'P3' }, clueCx).ok) continue;
        const fam = o.family || FAMILY_OF[o.type] || 'hook';
        const mech = MECH[o.type] ? MECH[o.type](o) : o.type.startsWith('classic:') ? `${o.message}. ${o.detail || ''}`.trim() : o.message;
        add(o.type, o.components, o.type === 'duplicate-declaration' ? o.declaration.name.toLowerCase() : o.id, [{ kind: 'observation', ref: o.id, text: o.message, file: o.evidence[0] && o.evidence[0].file, line: o.evidence[0] && o.evidence[0].line }], { family: fam, mechanism: mech, obs: o, custom: o.custom });
    }
    // a removed-function advisory is corroborated by a log fatal that names the function ("Call to undefined function each()"), or by a probe observation
    // from the same component (the bisection attaches its own support further down)
    for (const c of cands.values()) {
        if (!c.obs || c.obs.type !== 'removed-function-call') continue;
        for (const lc of logClues) if (lc.type === 'php-undefined-function' && String(lc.value).replace(/^.*[\\:>]/, '').toLowerCase() === c.obs.function && !c.supports.some(x => x.ref === lc.id)) c.supports.push({ kind: 'log', ref: lc.id, text: `log: Call to undefined function ${lc.value}()` });
        const pc = c.components.map(probeClueOf).find(Boolean);
        if (pc) c.supports.push({ kind: 'probe', ref: pc.id, text: `live page: "${String(pc.value).slice(0, 100)}" from ${c.components.join(', ')}` });
    }
    // ---- redirect callers (step 5-D): THE POST-PROBE JOIN ----
    // The static map (analysis.redirect_map, from issue/redirects.js) is built before any page is loaded. It is joined with what was OBSERVED here, because this
    // function runs after the live probe has written its clues to evidence.json (analysis.run) and runs again after the sandbox baseline (analysis.applyBisect
    // passes ctx.sandboxRedirect). A candidate exists only if a redirect was seen or the reporter's symptom is "redirect"; otherwise the map stays in
    // custom-code.json. This module emits UNVERIFIED / PROBABLE_NEEDS_REVIEW at most: validate.js alone assigns CONFIRMED, REPRODUCIBLE and REJECTED_FALSE_POSITIVE.
    const redirectClues = evidence.clues.filter(c => c.type === 'probe-redirect');
    const redirectObserved = redirectClues.length > 0 || !!ctx.sandboxRedirect;
    for (const o of require('./redirects').join(analysis.redirect_map || [], { observed: redirectObserved, symptom: issue.symptom, refOf })) {
        const sup = [{ kind: 'observation', ref: o.id, text: o.message, file: o.evidence[0].file, line: o.evidence[0].line }];
        if (redirectClues.length) sup.push({ kind: 'probe', ref: redirectClues[0].id, text: `live page: ${redirectClues[0].value}` });
        const seen = redirectClues.length ? `The live page showed it: ${redirectClues[0].value}.` : ctx.sandboxRedirect ? 'The sandbox copy showed a redirect problem.' : 'The reported symptom is a redirect; none was observed on the probed pages.';
        add(o.type, o.components, o.id, sup, { family: 'redirect', obs: o, mechanism: `${o.message}. ${seen}${o.common ? ' A redirect on this hook is common in legitimate plugins, so the code alone proves nothing; the observed redirect is what makes it a suspect.' : ''}` });
    }
    // ---- collisions ----
    for (const c of collide.collisions) {
        if (c.weak) continue;
        add(c.type, c.components, c.id, [{ kind: 'collision', ref: c.id, text: c.message, file: c.evidence[0] && c.evidence[0].file, line: c.evidence[0] && c.evidence[0].line }], { family: FAMILY_OF[c.type] || 'js', mechanism: COLL_MECH[c.type] ? COLL_MECH[c.type](c) : c.message, coll: c });
    }
    // ---- graph: missing dependencies, same-priority hooks on relevant hooks ----
    const customOrNamed = new Set([...analysis.components.filter(c => !c.inspection_only).map(c => c.ref), ...evidence.component_hints.slice(0, 8).map(h => toRef(h.component))]);
    // A "Requires Plugins" header is a certain statement. The implied kind comes from a code pattern and is common in optional integrations,
    // so it is only worth a hypothesis for custom code or a component the evidence points at.
    for (const p of graph.problems.filter(x => x.type !== 'missing-implied-dependency' || customOrNamed.has(x.component))) add('missing-dependency', [p.component], p.missing, [{ kind: 'observation', ref: `${p.type}:${p.component}:${p.missing}`, text: p.why }], { family: 'fatal', mechanism: `${p.why}. Code that calls into it fails when it is not there.` });
    // Two components adding the same hook at the same priority is normal (everybody hooks the_content at 10). It becomes a hypothesis only when
    // the hook belongs to a feature the report names, or both components are named by the evidence. It never counts as deterministic support.
    const named = new Set([...evidence.component_hints.slice(0, 8).map(h => toRef(h.component)), ...evidence.clues.filter(c => c.type === 'component-path' || c.type === 'component-mention').map(c => toRef(c.value))]);
    const featureHooks = new Set(ctx.featureHooks || []);
    for (const e of graph.edges.filter(x => x.type === 'hook-same-priority')) {
        const namedPair = named.has(e.from) && named.has(e.to);
        if (!featureHooks.has(e.hook) && !namedPair) continue;
        // a pair the evidence names is relevant on its own; a hook that is relevant only through a taxonomy signal counts full only if that signal was verified
        const verifiedHook = (ctx.featureHooksVerified || new Set()).has(e.hook);
        add('hook-same-priority', [e.from, e.to], e.key, [{ kind: namedPair || verifiedHook ? 'graph-relevant' : 'graph-relevant-unverified', ref: e.id, text: `${e.why}${featureHooks.has(e.hook) ? ' (a hook of a feature named in the report)' : ' (both components are named by the evidence)'}`, file: e.evidence[0] && e.evidence[0].file, line: e.evidence[0] && e.evidence[0].line }], { family: 'hook', mechanism: `${e.from} and ${e.to} ${e.why}. When two callbacks run at the same priority, the order is the order they were added, which depends on plugin load order, and one can undo or overwrite the other's output.` });
    }
    // ---- the live probe: what the browser actually showed on the reported page(s) ----
    const probeClues = evidence.clues.filter(c => c.source.kind === 'probe');
    for (const c of probeClues) {
        const comp = c.detail && c.detail.component && toRef(c.detail.component);
        const vps = (c.detail.viewports || []).join(', ');
        if ((c.type === 'probe-console-error' || c.type === 'probe-page-error') && comp && comp !== 'wordpress-core') add('js-error-in-component', [comp], c.value.slice(0, 80), [{ kind: 'probe', ref: c.id, text: `live page: "${c.value.slice(0, 120)}" from ${c.detail.script || 'a script'} (${vps})`, file: c.detail.script }], { family: 'js', mechanism: `The browser raised "${c.value.slice(0, 160)}" from ${c.detail.script || 'a script'}, which belongs to ${comp}. Everything that script was meant to do after that point does not happen.` });
        if (c.type === 'probe-failed-asset' && comp && comp !== 'wordpress-core') add('failed-asset', [comp], c.detail.url, [{ kind: 'probe', ref: c.id, text: `live page: ${c.value} (${vps})`, file: c.detail.url }], { family: 'js', mechanism: `The browser asked for ${c.detail.url} (a ${c.detail.type} of ${comp}) and got HTTP ${c.detail.status}. What depends on that file does not work.` });
        if (c.type === 'probe-duplicate-library') {
            const same = [...cands.values()].filter(x => x.coll && x.coll.library === c.detail.library);
            if (same.length) for (const x of same) x.supports.push({ kind: 'probe', ref: c.id, text: `live page: ${c.detail.library} is loaded ${c.detail.urls.length} times (${c.detail.urls.join(', ')})` });
            else if ((c.detail.components || []).length) add('duplicate-library', c.detail.components.map(toRef), c.detail.library, [{ kind: 'probe', ref: c.id, text: `live page: ${c.detail.library} is loaded ${c.detail.urls.length} times (${c.detail.urls.join(', ')})` }], { family: 'js', mechanism: `${c.detail.library} is loaded ${c.detail.urls.length} times on the live page (${c.detail.urls.join(', ')}); the second copy can replace the first one's plugins and globals.` });
        }
    }

    // ---- the sandbox bisection: the strongest evidence this tool can produce, because the symptom was switched on and off by changing the components ----
    const bis = ctx.bisect;
    if (bis && bis.causes && bis.causes.length) {
        for (const cause of bis.causes) {
            const set = cause.plugins.map(toRef);
            const sup = { kind: 'bisect', ref: `bisect:${cause.plugins.join('+')}`, text: `sandbox bisection (${bis.loads} page loads): the symptom is present when [${cause.plugins.join(', ')}] are active together and absent when any of them is switched off${bis.minimal === false ? ' (the search was stopped by a cap, so this set is not proven minimal)' : ''}` };
            for (const x of cands.values()) if (x.type !== 'bisect-minimal-set' && x.components.length && x.components.every(cp => set.includes(cp))) x.supports.push(sup);
            add('bisect-minimal-set', set, cause.plugins.join('+'), [sup], { family: 'bisect', mechanism: `In a throwaway copy of the site the symptom appears exactly when ${cause.plugins.join(' + ')} ${cause.plugins.length > 1 ? 'are' : 'is'} active, and disappears when any of ${cause.plugins.length > 1 ? 'them is' : 'it is'} switched off${Object.keys(cause.required_by || {}).length ? ` (${Object.entries(cause.required_by).map(([p, by]) => `${p} is only included because ${by.join(', ')} requires it`).join('; ')})` : ''}. This shows WHICH components are involved; why they conflict is what the other evidence on this list explains.`, bisect: cause });
        }
    }
    if (bis && bis.theme && bis.theme.involved === true && !(bis.causes || []).length) add('bisect-minimal-set', [], 'theme', [{ kind: 'bisect', ref: 'bisect:theme', text: 'sandbox bisection: with no plugin changed, a default theme makes the symptom disappear' }], { family: 'bisect', mechanism: 'In the sandbox the symptom disappears when the site\'s theme is replaced by a default theme: the theme (or a child/parent combination) is involved.' });

    // ---- knowledge base: a hit that comes from an observation or collision strengthens THAT hypothesis; the others stand on their own ----
    for (const h of kb) {
        const sup = { kind: h.verified ? 'kb-verified' : 'kb-unverified', ref: h.id, text: `${h.title}${h.verified ? '' : ' (entry not verified)'}: ${h.message}` };
        const owners = [...cands.values()].filter(c => (c.obs && (h.observation_ids || []).includes(c.obs.id)) || (c.coll && (h.collision_ids || []).includes(c.coll.id)));
        if (owners.length) { for (const c of owners) { c.supports.push(sup); c.kb = [...(c.kb || []), h.id]; c.kbHit = c.kbHit || h; } continue; }
        add('kb', h.components, h.id, [sup], { family: h.family, mechanism: `${h.causes}`, kb: [h.id], kbHit: h });
    }

    // ---- supports from the other sources (ocr, description, index) ----
    const hay = new Map(); // component -> sources that mention it
    for (const c of evidence.clues) {
        if (c.source.kind === 'log') continue;
        const comps = c.type === 'component-path' || c.type === 'component-mention' ? [toRef(c.value)] : c.detail && c.detail.file ? [toRef(require('../lib/ownership').componentOf(c.detail.file) || '')] : [];
        for (const comp of comps.filter(Boolean)) { if (!hay.has(comp)) hay.set(comp, []); hay.get(comp).push(c); }
    }
    const idxRows = new Map();
    for (const p of ctx.index.providers) for (const r of p.rows) { if (!idxRows.has(r.component)) idxRows.set(r.component, []); idxRows.get(r.component).push({ feature: p.feature, role: r.role, unverified: !!r.all_signals_unverified }); }

    // ---- score ----
    const since = ctx.description.dates && ctx.description.dates[0] ? Date.parse(`${ctx.description.dates[0]}T00:00:00Z`) : null;
    const errSites = new Set(logClues.filter(c => c.type === 'php-location').map(c => toRef(require('../lib/ownership').componentOf(c.detail.file) || '')));
    const traceComps = new Set(logClues.filter(c => c.type === 'component-path').map(c => toRef(c.value)));
    const logPassed = ctx.steps && ctx.steps.some(s => s.id === 'logs' && s.status === 'PASSED');
    const anyFatalInLog = logClues.some(c => c.type === 'php-fatal' || c.type === 'php-redeclare' || c.type === 'php-undefined-function' || c.type === 'wp-critical-error');
    const out = [];
    for (const c of cands.values()) {
        for (const comp of c.components) {
            if (hay.has(comp)) for (const cl of hay.get(comp)) c.supports.push({ kind: cl.source.kind === 'ocr' ? 'ocr' : 'description', ref: cl.id, text: `${cl.source.kind === 'ocr' ? 'OCR' : 'description'} mentions ${comp} (${cl.type}: ${cl.value})` });
            if (idxRows.has(comp)) for (const r of idxRows.get(comp)) c.supports.push({ kind: r.unverified ? 'index-unverified' : 'index', ref: `${comp}:${r.feature}`, text: `${comp} ${r.role === 'provides' ? 'provides' : 'is involved in'} "${r.feature}", a feature named in the report${r.unverified ? ' (every taxonomy signal behind this is unverified)' : ''}` });
        }
        const bd = [], kinds = new Set();
        const bestOf = k => c.supports.filter(s => s.kind === k);
        for (const k of ['log', 'bisect', 'probe', 'observation', 'collision', 'kb-verified', 'kb-unverified', 'graph-relevant', 'graph-relevant-unverified', 'ocr', 'description', 'index', 'index-unverified']) if (bestOf(k).length) { kinds.add(k.replace(/-(un)?verified$/, '')); bd.push({ rule: `support:${k}`, points: W[`support:${k}`], why: `${SCORING.find(r => r.rule === `support:${k}`).why} (${bestOf(k).length})` }); }
        const independent = [...kinds].filter(k => !['index', 'description'].includes(k)); // a mention is not evidence; kinds have already lost their -verified / -unverified suffix
        if (independent.length > 1) bd.push({ rule: 'independent-sources', points: round((independent.length - 1) * W['independent-sources']), why: `${independent.length} kinds of source agree: ${independent.sort().join(', ')}` });
        if (c.components.some(x => errSites.has(x))) bd.push({ rule: 'stack:error-site', points: W['stack:error-site'], why: `the logged error was raised in ${c.components.filter(x => errSites.has(x)).join(', ')}` });
        else if (c.components.some(x => traceComps.has(x))) bd.push({ rule: 'stack:in-trace', points: W['stack:in-trace'], why: `${c.components.filter(x => traceComps.has(x)).join(', ')} appears in a logged stack trace` });
        if (since !== null) { const near = c.components.filter(x => refOf[x] && refOf[x].updated_at && Math.abs(Date.parse(refOf[x].updated_at) - since) <= 3 * dayMs); if (near.length) bd.push({ rule: 'timing', points: W.timing, why: `${near.join(', ')} was modified within 3 days of ${ctx.description.dates[0]}` }); }
        const custom = c.components.some(x => refOf[x] && !refOf[x].inspection_only);
        if (custom) bd.push({ rule: 'custom', points: W.custom, why: `custom code involved: ${c.components.filter(x => refOf[x] && !refOf[x].inspection_only).join(', ')}` });
        const fam = c.family || 'hook';
        if (issue.symptom !== 'other' && FAMILY_SYMPTOMS[fam] && !FAMILY_SYMPTOMS[fam].includes(issue.symptom)) bd.push({ rule: 'symptom-mismatch', points: W['symptom-mismatch'], why: `a ${fam} problem does not normally produce the reported symptom "${issue.symptom}"` });
        if (fam === 'fatal' && logPassed && !anyFatalInLog && !bestOf('log').length) { c.contradicts.push({ kind: 'log', text: 'the log was read and contains no fatal error' }); bd.push({ rule: 'contradiction', points: W.contradiction, why: 'the log was read and contains no fatal error' }); }
        const score = round(bd.reduce((s, x) => s + x.points, 0));
        const deterministic = ['log', 'bisect', 'probe', 'observation', 'collision'].some(k => kinds.has(k));
        // advisory: a version number or a call that has not been seen failing. A removed-function call stops being advisory when a log, a probe observation or the bisection backs it.
        const advisory = !!(c.obs && c.obs.advisory) && !(c.obs.type === 'removed-function-call' && ['log', 'probe', 'bisect'].some(k => kinds.has(k)));
        out.push({ id: schema.stableId('hyp', c.key), title: titleOf(c), type: c.type, family: fam, components: c.components, mechanism: c.mechanism || c.obs && c.obs.message || c.type, supports: c.supports.map(({ kind, ref, text, file, line }) => ({ kind, ref, text, file: file || null, line: line || null })), contradicts: c.contradicts,
            advisory: advisory, class: (c.obs && c.obs.class) || null, active_state: (c.obs && c.obs.active_state) || null, severity: (c.obs && c.obs.severity) || null, score, score_breakdown: bd, status: !advisory && independent.length >= 2 && deterministic ? 'PROBABLE_NEEDS_REVIEW' : 'UNVERIFIED', custom_involved: custom, kb: c.kb || [], kb_verified: c.kbHit ? c.kbHit.verified : null, kb_sources: c.kbHit ? c.kbHit.sources.map(s => s.url) : [], kb_beyond_sources: c.kbHit ? c.kbHit.beyond_sources : null,
            oracle: oracleFor(c, issue), evidence: (c.obs && c.obs.evidence) || (c.coll && c.coll.evidence) || [] });
    }
    out.sort((a, b) => (a.advisory ? 1 : 0) - (b.advisory ? 1 : 0) || b.score - a.score || a.id.localeCompare(b.id));   // an advisory never outranks a real hypothesis
    // a hypothesis nothing but a weak index/description mention supports is not worth a place in the short list
    const eligible = out.filter(h => h.supports.some(s => ['log', 'bisect', 'probe', 'observation', 'collision', 'kb-verified', 'kb-unverified', 'graph-relevant', 'graph-relevant-unverified'].includes(s.kind)));
    const rep = ctx.reproduced && ctx.reproduced.result !== 'could-not-test' ? ctx.reproduced : (ctx.sandboxReproduced ? { result: ctx.sandboxReproduced, reason: 'sandbox', type: 'sandbox' } : ctx.reproduced || null);
    for (const h of eligible) { h.symptom_reproduced = rep ? rep.result : 'not-tested'; if (rep && rep.result === 'no') h.oracle.text += ' NOTE: the symptom was NOT reproduced on the probed pages, so this hypothesis rests on static evidence only and stays unconfirmed.'; }
    return { max: MAX_HYPOTHESES, scoring_rules: SCORING, symptom: issue.symptom, symptom_reproduced: rep, hypotheses: eligible.slice(0, MAX_HYPOTHESES), not_listed: eligible.slice(MAX_HYPOTHESES).map(h => ({ id: h.id, title: h.title, score: h.score })), considered: out.length };
}

const round = n => Math.round(n * 100) / 100;
function titleOf(c) {
    const comps = c.components.join(' + ');
    const t = { 'duplicate-declaration': 'Duplicate declaration', 'remove-wrong-priority': 'Hook removed at the wrong priority', 'removes-other-component-hook': 'One component removes another\'s hook', 'handle-replaced': 'Script/style handle replaced', 'handle-removed': 'Script/style handle removed', 'dependency-handle-not-registered': 'Dependency nobody registers', 'localize-object-collision': 'Same JavaScript object created twice', 'template-override-outdated': 'Outdated template override', 'syntax-error': 'Syntax error', 'missing-function': 'Missing function or class', 'error-in-component': 'Error raised in a component', 'missing-dependency': 'Missing required plugin', 'library-version-conflict': 'Library in conflicting versions', 'duplicate-library': 'Library loaded twice', 'js-global-collision': 'JavaScript global overwritten', 'jquery-api-version-mismatch': 'jQuery API not in the loaded version', 'script-missing-dependency': 'Script uses jQuery without depending on it', 'css-selector-overlap': 'Competing CSS rules', 'hook-same-priority': 'Same hook, same priority', 'js-error-in-component': 'JavaScript error raised by a component on the live page', 'failed-asset': 'A component\'s file does not load', 'bisect-minimal-set': 'Sandbox bisection: these components together cause the symptom' }[c.type];
    if (c.type.startsWith('classic:')) return `${c.obs.message}`;
    return t ? `${t}: ${comps}` : `${c.kbHit ? c.kbHit.title : c.type}${comps ? `: ${comps}` : ''}`;
}
// The test that would prove or disprove it. The oracle is the reporter's (or the generic one for the symptom); the action is what to change.
function oracleFor(c, issue) {
    const action = ['duplicate-declaration', 'handle-replaced', 'handle-removed', 'localize-object-collision', 'js-global-collision', 'duplicate-library', 'library-version-conflict', 'missing-function', 'error-in-component', 'syntax-error', 'hook-same-priority', 'removes-other-component-hook', 'kb'].includes(c.type)
        ? { do: 'deactivate', components: c.components, then: 'run the oracle' } : { do: 'apply the change described in the mechanism to a copy', components: c.components, then: 'run the oracle' };
    return { oracle: { type: issue.oracle.type, value: issue.oracle.value, generic: issue.oracle.defaulted }, action, needs_sandbox: true,
        text: `In a throwaway copy: ${action.do === 'deactivate' ? `deactivate ${c.components.join(' and ')} one at a time and together` : 'apply the change'}, then run the oracle (${issue.oracle.defaulted ? 'generic oracle for this symptom' : 'the oracle you gave'}). If the symptom disappears only then, this hypothesis is confirmed; if it stays, it is rejected.` };
}

module.exports = { build, SCORING, MAX_HYPOTHESES, FAMILY_SYMPTOMS };
