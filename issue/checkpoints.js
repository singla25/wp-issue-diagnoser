// The checkpoint list (data/checkpoints.json, generated from docs/COVERAGE.md): every checkpoint gets PASS, FAIL or NOT CHECKED with one plain reason.
// ALSO NOTICED  (gate report only, when the caller gives `tie`) the check found something that is not tied to the reported crash (see "tied to the crash" below). FAIL is then only a tied finding.
// This module adds NO detection. It only reads what the existing steps already wrote (work/custom-code.json, collisions.json, graph.json, kb-hits.json,
// evidence.json, probe.json, components.json, the hypotheses of validation) and says, for each checkpoint, whether the check ran and what it found.
//   PASS         the check ran and found nothing. For a row the coverage table calls PARTIAL the reason adds "checked for the common cases only".
//   FAIL         the check found something; the reason is one plain sentence (component names from lib/plain-names.js).
//   NOT CHECKED  the row is NOT DETECTED, has no evaluator, is classic-only (issue mode never runs checks/*), or its source did not run / was incomplete.
//                A missing source is NEVER a PASS, and a finding always wins over a missing second source.
// It never reads or writes a hypothesis status (no CONFIRMED / REJECTED / FIXED_VERIFIED here). Pure, offline, deterministic: output is in id order.
const fs = require('fs');
const path = require('path');
const plainNames = require('../lib/plain-names');
const conflictType = require('./conflict-type');
const oracle = require('./oracle');

const FILE = path.join(__dirname, '..', 'data', 'checkpoints.json');
const load = (file = FILE) => JSON.parse(fs.readFileSync(file, 'utf8'));
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const PARTIAL_NOTE = 'checked for the common cases only';
const CONTENT_HOOKS = new Set(['the_content', 'template_redirect', 'init', 'wp_enqueue_scripts']);

// the files an investigation wrote (work/), for a caller that has the issue folder
function loadWork(dir) {
    const W = f => readJson(path.join(dir, 'work', f));
    return { customCode: W('custom-code.json'), collisions: W('collisions.json'), graph: W('graph.json'), kbHits: W('kb-hits.json'), evidence: W('evidence.json'), probe: W('probe.json'), components: (W('components.json') || {}).components || null, sandbox: W('sandbox.json') };
}

// ---------------------------------------------------------------- what ran
function sourcesOf({ work = {}, ran = {}, hasRoot = false, hasCode = true, codeFound = 0, validation = null, logOnly = false }) {
    const noRoot = 'no site files were given, so no code was read';
    const stepOf = (list, id) => (list || []).find(s => s.id === id);
    const noCode = codeFound > 0 ? `the site folder holds ${codeFound} PHP file${codeFound === 1 ? '' : 's'}, but none could be analysed, so no code was checked` : 'the site folder holds no code files, so no code was read';
    const need = (cond, whyNot) => (hasRoot && hasCode && cond ? { ok: true } : { ok: false, why: !hasRoot ? noRoot : !hasCode ? noCode : whyNot });
    const cc = work.customCode, ccSteps = cc && cc.steps;
    const classicStep = stepOf(ccSteps, 'classic-checks'), compatStep = stepOf(ccSteps, 'compat');
    const S = {};
    S.custom = need((stepOf(ccSteps, 'observations') || {}).status === 'PASSED', 'the code analysis did not run');
    S.classic = need(!!classicStep && classicStep.status === 'PASSED' && !(classicStep.crashed || []).length, 'the classic checks did not run completely');
    S.compat = need(!!compatStep && compatStep.status === 'PASSED', 'the version and removed-function check did not run');
    S.redirectMap = need((stepOf(ccSteps, 'redirect-map') || {}).status === 'PASSED', 'the redirect map was not built');
    S.collisions = need((stepOf((work.collisions || {}).steps, 'collisions') || {}).status === 'PASSED', 'no script or style files were found to compare');
    S.graph = need(!!work.graph && !work.graph.truncated, work.graph && work.graph.truncated ? 'only part of the relations between components was kept' : 'the component relations were not built');
    S.kb = need(!!work.kbHits, 'the known-patterns check did not run');
    const logStep = stepOf(work.evidence && work.evidence.steps, 'logs');
    S.logs = { ok: !!((hasRoot || logOnly) && logStep && logStep.status === 'PASSED'), why: !(hasRoot || logOnly) ? 'no site files were given, so no log was read' : 'no log file was found or read (turn on WP_DEBUG_LOG); that is not evidence that nothing went wrong' };
    S.hypotheses = { ok: !!(validation && Array.isArray(validation.hypotheses)), why: 'the hypotheses were not validated' };
    const pr = work.probe, loaded = pr && Array.isArray(pr.pages) ? pr.pages.filter(p => p.loaded) : [];
    S.probe = { ok: !!(ran.probe && pr && Array.isArray(pr.pages) && pr.pages.length), why: (protectionReason(pr) || {}).reason || 'the live page probe did not run (no address, not allowed, or switched off)' };
    S.probeComplete = { ok: S.probe.ok && loaded.length > 0 && !pr.protection && plannedLoads(pr.planned) !== null && loaded.length >= plannedLoads(pr.planned), why: !S.probe.ok ? S.probe.why : !loaded.length ? 'the live page probe loaded no page' : 'the live page probe stopped early, so a quiet result cannot be trusted' };
    const phpInfo = compatStep && compatStep.php;
    S.php = { ok: !!(phpInfo && phpInfo.stated), why: `the site's PHP version is not known (--php); only the sandbox's PHP ${phpInfo && phpInfo.version ? phpInfo.version : '8.3'} could be compared` };
    return S;
}

// ---------------------------------------------------------------- sentences
function makeCtx(inp, S) {
    const comps = inp.work.components || [], names = plainNames.namesOf(comps);
    const ref = r => plainNames.plainRef(r, names);
    const list = refs => { const u = [...new Set(refs)].sort(); return u.length > 3 ? `${u.slice(0, 3).map(ref).join(', ')} and ${u.length - 3} more` : u.map(ref).join(' and '); };
    const pt = t => plainNames.plainText(t, comps, { bare: false });
    // what a found sentence is about (for the "tied to the crash" decision): the components and the files of the thing it came from. The sentence itself is unchanged.
    const tg = (x, text) => ({ t: text, c: [...(x.components || []), ...(x.from ? [x.from] : []), ...(x.to ? [x.to] : []), ...(x.component ? [x.component] : []), ...(x.missing ? [x.missing] : [])], f: [...(x.evidence || []).map(e => e && e.file).filter(Boolean), ...(x.file ? [x.file] : [])] });
    const cc = inp.work.customCode || {}, obsAll = (cc.observations || []).slice().sort((a, b) => (a.id < b.id ? -1 : 1));
    // a core plugin and its Pro edition by the same vendor (graph.json same_vendor, issue/graph.js): what they share on purpose is not a clash
    const vendor = new Set((((inp.work.graph || {}).same_vendor || {}).pairs || []).map(p => [p.core, p.pro].sort().join('|')));
    const obs = (...types) => obsAll.filter(o => types.includes(o.type));
    const obsV = (...types) => obs(...types).filter(o => !((o.components || []).length === 2 && vendor.has([...o.components].sort().join('|'))));
    const classicStep = ((cc.steps || []).find(s => s.id === 'classic-checks')) || {};
    // a classic rule "found" it when an observation was kept OR the rule was found and left out (not tied to the report): both mean the check saw something
    const classic = (...rules) => [
        ...obsAll.filter(o => o.classic_rule && rules.includes(o.classic_rule)).map(o => tg(o, pt(o.message))),
        ...(classicStep.skipped || []).filter(s => rules.includes(s.rule)).map(s => tg(s, pt(s.title)))
    ];
    const edges = (...types) => ((inp.work.graph || {}).edges || []).filter(e => types.includes(e.type)).sort((a, b) => (a.id < b.id ? -1 : 1));
    const probe = inp.work.probe || {}, pages = Array.isArray(probe.pages) ? probe.pages : [], loadedPages = pages.filter(p => p.loaded);
    const kb = (...ids) => { const k = inp.work.kbHits; const hits = Array.isArray(k) ? k : (k && k.hits) || []; return hits.filter(h => ids.includes(h.id)); };
    return { ref, list, pt, tg, obs, obsV, classic, edges, pages, loadedPages, kb, names, comps, S };
}

// a REST route as a reader can read it: the code analysis sometimes records a route whose namespace or tail is a PHP expression ("null/'/' . $this->rest_base"), which is never shown as it is
function routeText(route) {
    const r = String(route == null ? '' : route).replace(/^(?:null|undefined)\//, '');
    return r && !/[$]|'\s*\.|\.\s*'|\bnull\b|\bundefined\b/.test(r) ? `the REST route /${r}` : 'a REST route (its address is built by the code, so it cannot be shown as text)';
}
const where = p => { try { return new URL(p.url).pathname || '/'; } catch { return String(p.url || 'a page'); } };
const flagsOf = p => (typeof p.text === 'string' ? oracle.textFlags(p.text) : p.text_flags || (p.text_chars === 0 ? { blank: true, critical: false } : null));

// each evaluator -> { found: [plain sentence], need: [source keys], blocked: reason shown when nothing was found, sentence: optional single summary of found }
const EVALUATORS = {
    'duplicate-declaration': c => ({ need: ['custom'], found: c.obs('duplicate-declaration').map(o => { const m = /^decl:(\w+):(.*)$/.exec(o.dup_key || ''); return `${c.list(o.components)} both declare the same ${m ? `${m[1]} "${m[2]}"` : 'function or class'}`; }) }),
    'duplicate-constant': c => ({ need: ['custom'], found: c.obs('duplicate-constant').map(o => c.tg(o, `${c.list(o.components)} both define the constant ${o.constant}`)) }),
    'duplicate-shortcode': c => ({ need: ['custom'], found: c.obs('duplicate-shortcode').map(o => c.tg(o, `${c.list(o.components)} both register the shortcode [${o.shortcode}]`)) }),
    'duplicate-rest-route': c => ({ need: ['custom'], found: c.obsV('duplicate-rest-route').map(o => c.tg(o, `${c.list(o.components)} both register ${routeText(o.route)}`)) }),
    'duplicate-ajax-action': c => ({ need: ['custom'], found: c.obsV('duplicate-ajax-action').map(o => c.tg(o, `${c.list(o.components)} both answer the AJAX action "${o.action}"`)) }),
    'duplicate-script-handle': c => ({ need: ['custom'], found: c.obs('duplicate-script-handle').map(o => c.tg(o, `${c.list(o.components)} both register the ${o.handle_type || 'script'} name "${o.handle}" with different files`)) }),
    'duplicate-post-type': c => ({ need: ['graph'], found: c.edges('duplicate-post-type').map(e => c.tg(e, `${c.list([e.from, e.to])} both register the content type "${e.key}"`)) }),
    'shared-option': c => ({ need: ['graph'], found: c.edges('shared-option').map(e => c.tg(e, `${c.list([e.from, e.to])} share the setting "${e.key}"`)) }),
    'hook-same-priority': c => ({ need: ['graph', 'classic'], found: [...c.edges('hook-same-priority').map(e => c.tg(e, `${c.list([e.from, e.to])} both act on "${e.hook}" at the same priority`)), ...c.classic('hook-priority', 'hook-contradiction')] }),
    'hook-removal': c => ({ need: ['custom', 'classic'], found: [...c.obsV('removes-other-component-hook', 'remove-wrong-priority').map(o => c.tg(o, `${c.list(o.components)}: one removes a hook that belongs to the other`)), ...c.classic('hook-removed')] }),
    'library-clash': c => ({ need: ['collisions'], found: ((c.inp.work.collisions || {}).collisions || []).filter(x => ['library-version-conflict', 'duplicate-library'].includes(x.type)).sort((a, b) => (a.id < b.id ? -1 : 1)).map(x => c.tg(x, `${c.list((x.components || []).filter(k => k !== 'wordpress-core'))} load ${x.library ? `the library ${x.library}` : 'the same library'} more than once`)) }),
    'duplicate-purpose': c => ({ need: ['kb', 'classic'], found: [...c.kb('multiple-full-page-cache-plugins', 'wp-rocket-with-incompatible-plugin').map(h => c.tg(h, c.pt(h.title))), ...c.classic('duplicate-feature')] }),
    'missing-dependency': c => ({ need: ['graph', 'classic'], found: [...(((c.inp.work.graph || {}).problems || []).slice().sort((a, b) => (`${a.type}${a.component}${a.missing}` < `${b.type}${b.component}${b.missing}` ? -1 : 1)).map(p => c.tg(p, c.pt(`${c.ref(p.component)} needs "${p.missing}", which is not installed`)))), ...c.classic('dep-missing', 'dep-inactive', 'dep-implied', 'theme-parent-missing')] }),
    'template-override': c => { const o = c.obs('template-override-outdated'); return { need: ['custom'], found: o.length ? [c.tg({ components: o.flatMap(x => x.components), evidence: o.flatMap(x => x.evidence || []) }, `${c.list(o.flatMap(x => x.components))}: ${o.length} template cop${o.length === 1 ? 'y is' : 'ies are'} older than the plugin's own`)] : [] }; },
    'handle-removal': c => ({ need: ['custom'], found: c.obs('handle-removed', 'handle-replaced').map(o => c.tg(o, `${c.list(o.components)}: ${o.type === 'handle-replaced' ? 'a script or style of another part is replaced' : 'a script or style of another part is removed'} ("${o.handle}")`)) }),
    'theme-post-type': c => ({ need: ['graph'], found: c.edges('duplicate-post-type').filter(e => /^theme:/.test(e.from) || /^theme:/.test(e.to)).map(e => c.tg(e, `${c.list([e.from, e.to])} both register the content type "${e.key}"`)) }),
    'page-builder': c => ({ need: ['kb', 'graph'], found: [...c.kb('cache-plugin-with-elementor').map(h => c.tg(h, c.pt(h.title))), ...(((c.inp.work.graph || {}).problems || []).filter(p => p.type === 'missing-implied-dependency' && p.missing === 'elementor').map(p => c.tg(p, c.pt(`${c.ref(p.component)} needs Elementor, which is not installed`))))] }),
    'redirect-on-hook': c => ({ need: ['redirectMap', 'hypotheses'], found: (((c.inp.validation || {}).hypotheses) || []).filter(h => h.type === 'redirect-on-hook' && h.status !== 'REJECTED_FALSE_POSITIVE').map(h => c.tg(h, c.pt(`${c.list(h.components || [])} redirect visitors from a WordPress hook, and this matches the problem`))) }),
    'rest-auth-hook': c => ({ need: ['kb'], found: c.kb('rest-authentication-errors-contention').map(h => c.tg(h, c.pt(h.title))) }),
    'content-hooks': c => ({ need: ['graph'], found: c.edges('hook-same-priority').filter(e => CONTENT_HOOKS.has(e.hook)).map(e => c.tg(e, `${c.list([e.from, e.to])} both act on "${e.hook}" at the same priority`)) }),
    'removed-functions': c => ({ need: ['compat'], found: c.obs('removed-function-call').map(o => c.tg(o, `${c.list(o.components)} calls ${o.function}(), which no longer exists from PHP ${o.removed_in}`)), blocked: c.S.php.ok ? null : c.S.php.why, note: c.phpNote }),
    'php-version-code': c => ({ need: ['compat'], found: [...c.obs('removed-function-call').map(o => c.tg(o, `${c.list(o.components)} calls ${o.function}(), which no longer exists from PHP ${o.removed_in}`)), ...c.obs('requires-php-mismatch').map(o => c.tg(o, `${c.list(o.components)} needs PHP ${o.requires} or newer`))], blocked: c.S.php.ok ? null : c.S.php.why, note: c.phpNote }),
    'version-headers': c => ({ need: ['compat', 'classic'], found: [...c.obs('requires-php-mismatch').map(o => c.tg(o, `${c.list(o.components)} needs PHP ${o.requires} or newer`)), ...c.obs('requires-wp-mismatch').map(o => c.tg(o, `${c.list(o.components)} needs WordPress ${o.requires} or newer`)), ...c.obs('tested-up-to-older').map(o => c.tg({}, `${c.list(o.components)} was not tested with this WordPress version`)), ...c.classic('dep-php-version', 'dep-wp-version')], blocked: c.S.php.ok ? null : c.S.php.why, note: c.phpNote }),
    'syntax-error': c => ({ need: ['custom'], found: c.obs('syntax-error').map(o => c.tg(o, `${c.list(o.components)} has a PHP syntax error in ${((o.evidence || [])[0] || {}).file || 'a file'}`)) }),
    'log-limits': c => ({ need: ['logs'], found: c.logHits(['memory', 'execution-time']).map(k => (k === 'memory' ? 'the log shows PHP running out of memory' : 'the log shows a PHP script running out of time')) }),
    'log-extensions': c => ({ need: ['logs'], found: c.logHits(['missing-extension']).map(() => 'the log shows code that needs a PHP extension the server does not have') }),
    'home-siteurl': c => ({ need: ['classic'], found: c.classic('cfg-http-url') }),
    'dropins': c => ({ need: ['classic'], found: c.classic('dropin-unrecognised', 'dropin-orphan') }),
    'https': c => ({ need: ['classic'], found: [...c.classic('cfg-http-url'), ...c.loadedPages.filter(p => [...(p.console_errors || []), ...(p.page_errors || [])].some(e => /mixed content/i.test(e.text || ''))).map(p => c.tg(p, `${where(p)} loads something over http on a secure page`))] }),
    'white-screen': c => ({ need: ['probe'], blocked: c.S.probeComplete.ok ? null : c.S.probeComplete.why, found: c.loadedPages.filter(p => p.status >= 500 || (p.status >= 200 && p.status < 400 && (((flagsOf(p) || {}).blank) || ((flagsOf(p) || {}).critical)))).map(p => (p.status >= 500 ? `${where(p)} answered with an error (HTTP ${p.status})` : `${where(p)} showed a blank page or a critical-error text`)) }),
    'http-5xx': c => ({ need: ['probe'], blocked: c.S.probeComplete.ok ? null : c.S.probeComplete.why, found: c.loadedPages.filter(p => p.status >= 500).map(p => c.tg(p, `${where(p)} answered with a server error (HTTP ${p.status})`)) }),
    'critical-error-page': c => ({ need: ['probe'], blocked: c.S.probeComplete.ok ? null : c.S.probeComplete.why, found: c.loadedPages.filter(p => p.status >= 200 && p.status < 400 && (flagsOf(p) || {}).critical).map(p => c.tg(p, `${where(p)} shows WordPress's critical-error text`)) }),
    'redirect-loop': c => ({ need: ['probe'], blocked: c.S.probeComplete.ok ? null : c.S.probeComplete.why, found: c.pages.flatMap(p => oracle.redirectSigns(p).map(() => `${where(p)} redirects in a loop, in a long chain, or to another site`)) }),
    'admin-ajax': c => ({ need: ['probe'], blocked: c.S.probeComplete.ok ? null : c.S.probeComplete.why, found: c.loadedPages.filter(p => [...(p.error_responses || []), ...(p.failed_requests || [])].some(r => /admin-ajax/.test(r.url || ''))).map(p => c.tg(p, `${where(p)} has a failing admin-ajax request`)) }),
    'js-errors': c => ({ need: ['probe'], blocked: c.S.probeComplete.ok ? null : c.S.probeComplete.why, found: c.loadedPages.filter(p => [...(p.page_errors || []), ...(p.console_errors || []).filter(e => !/^Failed to load resource/i.test(e.text || ''))].length).map(p => c.tg(p, `${where(p)} shows a JavaScript error`)) }),
    'failed-assets': c => ({ need: ['probe'], blocked: c.S.probeComplete.ok ? null : c.S.probeComplete.why, found: c.loadedPages.filter(p => (p.error_responses || []).some(r => r.same_site) || (p.failed_requests || []).length).map(p => c.tg(p, `${where(p)} could not load one of its own files`)) }),
    'obfuscated-code': c => ({ need: ['classic'], found: c.classicPrefix('integrity-', ['integrity-php-in-uploads']) }),
    'php-in-uploads': c => ({ need: ['classic'], found: c.classic('integrity-php-in-uploads') })
};

// helpers that need the whole input (attached in evaluate)
function attach(c, inp) {
    c.inp = inp;
    const cmpStep = ((inp.work.customCode || {}).steps || []).find(s => s.id === 'compat') || {}, php = cmpStep.php;
    c.phpNote = php && !php.stated ? `compared with PHP ${php.version} of the sandbox image, because the site's own PHP version is not known` : '';
    const cc = inp.work.customCode || {}, step = (cc.steps || []).find(s => s.id === 'classic-checks') || {};
    c.classicPrefix = (prefix, except) => [
        ...(cc.observations || []).filter(o => o.classic_rule && o.classic_rule.startsWith(prefix) && !except.includes(o.classic_rule)).sort((a, b) => (a.id < b.id ? -1 : 1)).map(o => c.tg(o, c.pt(o.message))),
        ...(step.skipped || []).filter(s => s.rule && s.rule.startsWith(prefix) && !except.includes(s.rule)).map(s => c.tg(s, c.pt(s.title)))
    ];
    // which server-side causes the log lines name (the same patterns issue/conflict-type.js uses to label a hypothesis)
    c.logHits = kinds => {
        const clues = ((inp.work.evidence || {}).clues || []).filter(x => x.source && x.source.kind === 'log');
        const texts = clues.map(x => (x.type === 'php-undefined-function' ? `Call to undefined function ${x.value}(` : x.type === 'php-class-not-found' ? `Class "${x.value}" not found` : `${x.value} ${x.snippet || ''}`));
        const out = [];
        for (const t of texts) for (const [kind, re] of conflictType.ENV_LOG) if (kinds.includes(kind) && re.test(t)) { out.push(kind); break; }
        return [...new Set(out)].sort();
    };
    return c;
}

// ---------------------------------------------------------------- tied to the crash
// FAIL means "found AND tied to this crash". `tie` = { components: [ref], files: [path] } built by the caller (issue/result.js) from the crash evidence: the likely cause's (or finding's) components and files,
// the log fatal's file, its provider, and the plugins / themes in its stack trace. A found item is tied when it names one of those components or files. The rows below are crash symptoms of the
// probe / log (white screen, HTTP 5xx, critical-error page, redirect loop,): when they found something they are tied by what they are. Without `tie`
// (a caller that has no crash evidence to give) nothing is classified: every found item is a FAIL, as before.
const SYMPTOM_ROWS = new Set(['white-screen', 'http-5xx', 'critical-error-page', 'redirect-loop']);
// weak-tie rows (owner decision, REPORT-SPEC Part 2; amends HANDOFF decision 25): sharing a component with the crash is NOT a tie for these. They are FAIL only when their own
// evidence names a FILE of the crash evidence (stronger than a shared component); otherwise ALSO NOTICED. Duplicate AJAX action, same hook / same priority, one plugin removing
// another's hook, outdated template override, theme dequeuing plugin scripts. The ids stay internal (never in reader text).
const WEAK_TIE_ROWS = new Set(['cp-06', 'cp-09', 'cp-10', 'cp-14', 'cp-15']);
const normRef = r => String(r || '').replace(/^plugin:/, '');
const componentOfFile = f => { try { return normRef(require('../lib/ownership').componentOf(f) || ''); } catch { return ''; } };
function makeTie(inp) {
    const comps = new Set((inp.components || []).map(normRef).filter(r => r && r !== 'wordpress-core')), files = new Set((inp.files || []).filter(Boolean));
    for (const f of files) { const c = componentOfFile(f); if (c && c !== 'wordpress-core') comps.add(c); }
    return { components: comps, files };
}
const PATH_IN_TEXT = /wp-content\/[^\s:()'"]+/g;
function isTied(x, tie, { fileOnly = false } = {}) {
    if (!tie) return true;
    const files = [...(x.f || []), ...(String(x.t).match(PATH_IN_TEXT) || [])];
    if (fileOnly) return files.some(f => tie.files.has(f));
    if ((x.c || []).some(r => tie.components.has(normRef(r)))) return true;
    return files.some(f => tie.files.has(f) || (componentOfFile(f) && tie.components.has(componentOfFile(f))));
}

// rows that can repeat another row's finding: the content-hook row repeats "same hook, same priority"; the PHP-version row repeats "removed functions"
const SAME_AS = { 'content-hooks': 'hook-same-priority', 'php-version-code': 'removed-functions' };

// ---------------------------------------------------------------- the evaluation
// inp: { work, validation, ran:{probe,sandbox}, hasRoot, issue?, checkpoints? } -> [{ id, title, result, reason }] for EVERY checkpoint, in id order
// the number of page loads the probe planned: a plain number (older data) or the object probe.json really holds ({ pages, viewports, loads }).
// Anything else (missing, zero, not a whole number) is null: the probe is then NOT "complete", so a quiet result is NOT CHECKED, never a pass.
const plannedLoads = v => { const n = typeof v === 'number' ? v : v && typeof v === 'object' ? v.loads : null; return Number.isInteger(n) && n > 0 ? n : null; };
function evaluate(inp = {}) {
    const input = { work: inp.work || {}, validation: inp.validation || null, ran: inp.ran || {}, hasRoot: !!inp.hasRoot, hasCode: inp.hasCode !== false, codeFound: Number(inp.codeFound) || 0, issue: inp.issue || null, logOnly: !!inp.logOnly };
    const tie = inp.tie ? makeTie(inp.tie) : null;
    const list = (inp.checkpoints || load()).checkpoints.slice().sort((a, b) => (a.id < b.id ? -1 : 1));
    const S = sourcesOf(input), c = attach(makeCtx(input, S), input);
    const missing = keys => { const bad = keys.map(k => S[k]).find(s => s && !s.ok); return bad ? bad.why : null; };
    const texts = new Map(), evalOf = new Map();
    const rows = list.map(cp => {
        const base = { id: cp.id, title: cp.title, tied_to_crash: false, breaks_site: cp.breaks_site || 'depends' };
        if (cp.coverage === 'NOT DETECTED') return { ...base, result: 'NOT CHECKED', reason: cp.no_evaluator_reason ? `not checked yet: ${cp.no_evaluator_reason}` : 'not checked yet' };
        if (cp.reached_in === 'Classic') return { ...base, result: 'NOT CHECKED', reason: cp.no_evaluator_reason || 'only the classic scan checks this' };
        const ev = cp.evaluator && EVALUATORS[cp.evaluator];
        if (!ev) return { ...base, result: 'NOT CHECKED', reason: cp.no_evaluator_reason ? `not checked: ${cp.no_evaluator_reason}` : 'not checked: no check is wired to this yet' };
        let r;
        try { r = ev(c); } catch (e) { return { ...base, result: 'NOT CHECKED', reason: 'the check could not read its data' }; }
        if (r.need.includes('probe')) base.live_row = true;   // a live page check (it reads the probe): liveSummary counts these rows
        // data of a source that did not run (stale files, no folder given) is never read: when none of the sources ran, the row is NOT CHECKED
        if (r.need.every(k => S[k] && !S[k].ok)) return { ...base, result: 'NOT CHECKED', reason: S[r.need[0]].why };
        const found = r.found.filter(Boolean).map(x => (typeof x === 'string' ? { t: x, c: [], f: [] } : x));
        texts.set(cp.id, found.map(x => x.t)); evalOf.set(cp.id, cp.evaluator);
        if (found.length) {
            // tied to the crash: a symptom row of the probe / log, or an item that names a component or file of the crash evidence. Items that are tied come first in the reason.
            const tied = found.filter(x => !tie || SYMPTOM_ROWS.has(cp.evaluator) || isTied(x, tie, { fileOnly: WEAK_TIE_ROWS.has(cp.id) })), rest = found.filter(x => !tied.includes(x));
            const order = [...tied, ...rest], text = order[0].t, more = order.length > 1 ? ` (and ${order.length - 1} more)` : '';
            return { ...base, result: tied.length ? 'FAIL' : 'ALSO NOTICED', reason: text + more, tied_to_crash: tied.length > 0, breaks_site: cp.breaks_site || 'depends', live: r.need.includes('probe'), from_log: r.need.includes('logs') };   // live: the check reads the live page (probe), so a FAIL here is a failed LIVE check
        }
        const gap = missing(r.need) || r.blocked;
        if (gap) return { ...base, result: 'NOT CHECKED', reason: gap };
        // a log check on a log WITHOUT site files: it only says what the part of the log that was read does not hold, never that the site is fine
        if (!input.hasRoot && input.logOnly && r.need.includes('logs')) return { ...base, result: 'PASS', reason: 'not found in the part of the log that was read' };
        return { ...base, result: 'PASS', reason: ['nothing found', cp.coverage === 'PARTIAL' ? PARTIAL_NOTE : '', r.note || ''].filter(Boolean).join('; ') };
    });
    // a row that only repeats another row's findings is shown as "same finding as <that row>" (its own result and count stay; ids are internal, the reader sees the title)
    for (const row of rows) {
        const baseEval = SAME_AS[evalOf.get(row.id)];
        if (!baseEval || (row.result !== 'FAIL' && row.result !== 'ALSO NOTICED')) continue;
        const baseRow = rows.find(x => evalOf.get(x.id) === baseEval && (x.result === 'FAIL' || x.result === 'ALSO NOTICED'));
        const mine = texts.get(row.id) || [], theirs = new Set(texts.get(baseRow && baseRow.id) || []);
        if (baseRow && mine.length && mine.every(t => theirs.has(t))) { row.same_as = baseRow.id; row.reason = `same finding as "${baseRow.title}"`; }
    }
    return rows;
}

const tally = rows => ({ pass: rows.filter(r => r.result === 'PASS').length, fail: rows.filter(r => r.result === 'FAIL').length, also_noticed: rows.filter(r => r.result === 'ALSO NOTICED').length, not_checked: rows.filter(r => r.result === 'NOT CHECKED').length, total: rows.length });

// S3a: what the live page checks did, from the REAL rows and the probe data (never a fixed number). `live_row` marks the rows that read the probe.
// gave = PASS, FAIL or ALSO NOTICED (never NOT CHECKED). The reason says why the others did not run, from the data; a case it cannot tell is "could not be read" or the safe generic one.
// Used for a run WITHOUT site files only (issue/result.js); the row texts themselves are not changed.
// plain text for a reader: no control or format characters, one space between words, cut at a word boundary (never mid-word)
const cutText = (t, n) => { const x = String(t == null ? '' : t).replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim(); if (x.length <= n) return x; const y = x.slice(0, n), sp = y.lastIndexOf(' '); return `${(sp > n / 2 ? y.slice(0, sp) : y).replace(/[\s,;:(]+$/, '')} ...`; };
// why a probe that was STOPPED by the site or for the server's safety did not give results (probe.json `protection`), in reader words; null when it was not stopped.
// ONE helper for the live-check sentence (liveSummary) and for the reason of a live row (sourcesOf), so the two never differ. none_ran: no request was sent at all (a cooldown).
function protectionReason(pr) {
    const p = pr && typeof pr === 'object' ? pr.protection : null;
    if (!p || typeof p !== 'object') return null;
    if (p.kind === 'cooldown') return { none_ran: true, reason: 'an earlier run was stopped by the website\'s protection, so this run waited and sent no request' };
    const detail = cutText(p.reason, 120) || 'no detail was given';
    if (['TestStopped', 'breaker'].includes(p.kind)) return { none_ran: false, reason: `the test was stopped to keep the website safe, so no more requests were sent: ${detail}` };
    return { none_ran: false, reason: `the website's protection or rate limiting stopped the test, so no more requests were sent: ${detail}` };
}
function liveSummary(rows, work = {}) {
    const live = (rows || []).filter(r => r && r.live_row);
    if (!live.length) return null;
    const gave = live.filter(r => r.result !== 'NOT CHECKED').length, notRun = live.length - gave;
    const pr = work.probe && typeof work.probe === 'object' ? work.probe : null, pages = pr && Array.isArray(pr.pages) ? pr.pages : [];
    const loaded = pages.filter(p => p && p.loaded).length;
    const step = (((work.evidence || {}).steps) || []).find(x => x && x.id === 'live-probe') || null;
    let reason = null, none_ran = false;
    if (notRun) {
        const skipped = pages.filter(p => p && p.skipped), codes = [...new Set(skipped.map(p => Number(p.reused_status)).filter(n => n >= 100))].sort((a, b) => a - b);
        const prot = protectionReason(pr);
        if (prot) { reason = prot.reason; none_ran = prot.none_ran; }
        else if (!loaded && step && ['NOT_RUN', 'BLOCKED', 'FAILED'].includes(step.status)) {
            const t = cutText(step.reason, 200);
            none_ran = step.status !== 'FAILED';
            reason = /no site address was given/.test(t) ? 'no address was given' : /switched off/.test(t) ? 'the live check was switched off' : t || 'the live page test did not run';
        } else if (plannedLoads(pr && pr.planned) === null) reason = 'the result of the live page test could not be read';
        else if (skipped.length && codes.length) reason = `the page answered with an error (${codes.map(n => `HTTP ${n}`).join(' and ')}), so it was not loaded again at the other screen size`;
        else reason = 'fewer page loads were completed than planned';
    }
    return { total: live.length, gave, not_run: notRun, none_ran, reason };
}

module.exports = { liveSummary, SYMPTOM_ROWS, WEAK_TIE_ROWS, evaluate, loadWork, load, tally, EVALUATORS, PARTIAL_NOTE, FILE };
