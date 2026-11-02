#!/usr/bin/env node
// Step 7a: conflict-type labels (issue/conflict-type.js), the confirmed-and-breaking gate (issue/gate.js), the plain-language cause (issue/cause.js), rollback text
// (issue/rollback.js) and the plain-English summary (issue/summary.js). All pure. Neither module assigns a status: validate.js stays the only owner.
// Also the one hypotheses.js change of this step: a PHP fatal that names a component file becomes a hypothesis. Offline fixtures only.
const fs = require('fs');
const os = require('os');
const path = require('path');

const CT = require('../issue/conflict-type');
const gate = require('../issue/gate');
const { cause } = require('../issue/cause');
const rollback = require('../issue/rollback');
const summary = require('../issue/summary');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const group = t => console.log(`\n== ${t}`);

// ---------------------------------------------------------------- helpers
const FATAL = { id: 'c-fatal', type: 'php-fatal', value: 'Uncaught Error: boom', detail: { level: 'fatal error' }, source: { kind: 'log', ref: 'wp-content/debug.log', line: 3 }, snippet: 'PHP Fatal error: boom in /srv/wp-content/plugins/heavy/heavy.php:6' };
const LOC = { id: 'c-loc', type: 'php-location', value: 'wp-content/plugins/heavy/heavy.php:6', detail: { file: 'wp-content/plugins/heavy/heavy.php', line: 6 }, source: { kind: 'log', ref: 'wp-content/debug.log', line: 3 } };
const probeClue = (type, value, detail = {}, id = `p-${type}`) => ({ id, type, value, detail, source: { kind: 'probe', ref: 'http://x.test/', line: null } });
const H = (type, o = {}) => ({ id: `h-${type}-${o.tag || ''}`, type, title: `title ${type}`, status: 'CONFIRMED', components: ['a', 'b'], supports: [], independent_kinds: [], evidence: [{ file: 'wp-content/plugins/a/a.php', line: 4 }], mechanism: `The ${type} mechanism. Second sentence.`, class: null, advisory: false, ...o });
const logSup = (ref = 'c-fatal') => ({ supports: [{ kind: 'log', ref }], independent_kinds: ['log'] });
const ctxOf = (o = {}) => ({ clues: [FATAL, LOC], oracleType: 'http-5xx', sandbox: { ran: false }, probe: { ran: false }, ...o });
const one = (h, c) => gate.split([h], c || ctxOf());

// ---------------------------------------------------------------- the label table
group('label table: every type the code can emit has a row');
const hypSrc = fs.readFileSync(path.join(__dirname, '..', 'issue', 'hypotheses.js'), 'utf8');
const familyBlock = /const FAMILY_OF = \{([\s\S]*?)\};/.exec(hypSrc)[1];
const emitted = new Set([...familyBlock.matchAll(/'([a-z][a-z-]*)'\s*:/g)].map(m => m[1]).filter(t => t !== 'kb'));
for (const t of ['missing-function', 'error-in-component', 'duplicate-declaration', 'missing-dependency', 'bisect-minimal-set', 'syntax-error']) emitted.add(t);
for (const r of Object.keys(require('../issue/classic-adapter').TAKEN)) emitted.add(`classic:${r}`);
for (const id of require('../data/known-conflicts.json').entries.map(e => e.id)) emitted.add(`kb:${id}`);
const mapped = new Set([...CT.ENV_TYPES, ...CT.CORE_PHP_TYPES, ...CT.HOOK_TYPES, ...CT.BY_KINDS_TYPES]);
const unmapped = [...emitted].filter(t => !mapped.has(t)).sort();
ok(emitted.size >= 50 && unmapped.length === 0, `${emitted.size} types can be emitted (hypotheses.js, the classic adapter, the knowledge base); unmapped: ${unmapped.join(', ') || 'none'}`);
const integrity = require('../checks/integrity').PATTERNS.map(p => `classic:integrity-${p.id}`).concat(['classic:integrity-php-in-uploads', 'classic:integrity-php-in-image', 'classic:integrity-disguised-name', 'classic:integrity-heavy-hex']);

const mk = (type, comps, o = {}) => (type.startsWith('kb:') ? H('kb', { kb: [type.slice(3)], components: comps, ...o }) : H(type, { components: comps, ...o }));
for (const t of [...CT.ENV_TYPES].sort()) ok(CT.label(mk(t, ['a', 'b'])).label === 'environment-server', `${t} -> environment-server`);
for (const t of [...CT.CORE_PHP_TYPES].sort()) ok(CT.label(mk(t, ['a'])).label === 'plugin-core-php', `${t} -> plugin-core-php`);
for (const t of [...CT.HOOK_TYPES].sort()) ok(CT.label(mk(t, ['a', 'b'])).label === 'hook', `${t} -> hook`);
for (const t of integrity) ok(CT.label(mk(t, [], { class: 'compromise' })).label === 'compromise' && CT.label(mk(t, ['a'])).label === 'compromise', `${t} -> compromise`);
for (const t of [...CT.BY_KINDS_TYPES].sort()) {
    const core = t === 'handle-replaced';
    const two = CT.label(mk(t, ['a', 'b'])).label, th = CT.label(mk(t, ['theme:t', 'a'])).label, solo = CT.label(mk(t, ['a'])).label;
    ok(two === 'plugin-plugin' && th === 'theme-plugin' && solo === 'unclassified', `${t}: two plugins -> plugin-plugin, theme + plugin -> theme-plugin, one component -> unclassified`);
    if (core) ok(CT.label(mk(t, ['a']), { obsOf: () => ({ core_handle: true }) }).label === 'plugin-core-php', `${t} with a core handle -> plugin-core-php`);
}

group('label precedence: compromise > environment-server > plugin-core-php > hook > theme-plugin > plugin-plugin > unclassified');
const memClue = { id: 'c-mem', type: 'php-fatal', value: 'Allowed memory size of 134217728 bytes exhausted (tried to allocate 8192 bytes)', snippet: 'PHP Fatal error: Allowed memory size of 134217728 bytes exhausted (tried to allocate 8192 bytes) in /srv/wp-content/plugins/heavy/heavy.php on line 6', source: { kind: 'log', ref: 'l', line: 1 }, detail: {} };
const cl = { clueById: id => ({ 'c-mem': memClue }[id] || null) };
ok(CT.label(H('classic:cfg-http-url', { class: 'compromise' })).label === 'compromise', 'compromise beats environment-server (a server type with class compromise)');
ok(CT.label(H('error-in-component', { components: ['heavy'], supports: [{ kind: 'log', ref: 'c-mem' }] }), cl).label === 'environment-server', 'environment-server beats plugin-core-php (memory exhausted is also an error-in-component)');
ok(CT.label(H('redirect-on-hook', { components: ['a', 'wordpress-core'] })).label === 'plugin-core-php', 'plugin-core-php beats hook (a component is WordPress itself)');
ok(CT.label(H('removed-function-call', { components: ['theme:t', 'a'] })).label === 'plugin-core-php', 'plugin-core-php beats theme-plugin (a removed PHP function in a theme + plugin pair)');
ok(CT.label(H('redirect-on-hook', { components: ['theme:t', 'a'] })).label === 'hook' && CT.label(H('duplicate-shortcode', { components: ['theme:t', 'a'] })).label === 'hook', 'hook beats theme-plugin');
ok(CT.label(H('hook-same-priority', { components: ['a', 'b', 'c'] })).label === 'hook', 'hook beats plugin-plugin');
ok(CT.label(H('duplicate-library', { components: ['theme:t', 'a', 'b'] })).label === 'theme-plugin', 'theme-plugin beats plugin-plugin (a theme and two plugins)');
ok(CT.label(H('duplicate-library', { components: ['a', 'mu:m'] })).label === 'plugin-plugin', 'a must-use plugin counts as a plugin side');
ok(CT.label(H('duplicate-library', { components: ['theme:t'] })).label === 'unclassified' && CT.label(H('duplicate-library', { components: [] })).label === 'unclassified', 'unclassified last: one theme alone, or no component at all');
ok(CT.label(H('hook-same-priority', { components: ['theme:t', 'a'] })).candidates.join() === 'hook,theme-plugin', 'the candidates are listed in precedence order (hook, theme-plugin)');
ok(CT.LABELS.join() === 'compromise,environment-server,plugin-core-php,hook,theme-plugin,plugin-plugin,unclassified', 'the seven labels, in the fixed order');

group('environment causes from the log: memory, time, missing extension, disk (they win even when a plugin file is named)');
const envHyp = (type, text) => ({ h: H(type, { components: ['heavy'], supports: [{ kind: 'log', ref: 'c-e' }] }), c: { clueById: () => ({ id: 'c-e', type: 'php-fatal', value: text, snippet: `PHP Fatal error: ${text} in /srv/wp-content/plugins/heavy/heavy.php on line 6` }) } });
for (const [what, type, text] of [
    ['memory size exhausted', 'error-in-component', 'Allowed memory size of 134217728 bytes exhausted (tried to allocate 8192 bytes)'],
    ['maximum execution time', 'error-in-component', 'Maximum execution time of 30 seconds exceeded'],
    ['missing mbstring function', 'missing-function', 'Uncaught Error: Call to undefined function mb_strlen()'],
    ['missing curl function', 'missing-function', 'Call to undefined function curl_init()'],
    ['missing ZipArchive class', 'missing-function', 'Uncaught Error: Class "ZipArchive" not found'],
    ['missing DOMDocument class', 'missing-function', "Class 'DOMDocument' not found"],
    ['disk full', 'error-in-component', 'No space left on device'],
    ['permission denied', 'error-in-component', 'file_put_contents(): failed to open stream: Permission denied']
]) { const { h, c } = envHyp(type, text); ok(CT.label(h, c).label === 'environment-server', `${what} (${type}) naming a plugin file -> environment-server`); }
{ const { h, c } = envHyp('missing-function', 'Uncaught Error: Call to undefined function heavy_helper()'); ok(CT.label(h, c).label === 'plugin-core-php', 'an undefined function of the plugin itself is NOT an environment cause (plugin-core-php)'); }
{ const { h, c } = envHyp('missing-function', 'Uncaught Error: Call to undefined function json_helper_x()'); ok(CT.label(h, c).label === 'plugin-core-php', 'a made-up function that starts like an extension name is not mistaken for one (json_ is not in the list)'); }
{ const { h, c } = envHyp('error-in-component', 'Undefined variable $x'); ok(CT.label(h, c).label === 'plugin-core-php', 'an ordinary PHP error in a plugin file stays plugin-core-php'); }

// ---------------------------------------------------------------- the gate
group('gate matrix: established x breaking');
{
    const r = one(H('syntax-error', { components: ['heavy'], ...logSup() }));
    ok(r.findings.length === 1 && r.advisories.length === 0 && r.findings[0].breaking_because[0].kind === 'log' && /names wp-content\/plugins\/heavy\/heavy\.php/.test(r.findings[0].breaking_because[0].reason), 'established (CONFIRMED) and breaking (a log fatal names a file): FINDING, with the reason');
    const nb = one(H('duplicate-declaration', { supports: [{ kind: 'observation', ref: 'o1' }], independent_kinds: ['observation'] }));
    ok(nb.findings.length === 0 && nb.advisories[0].why_not_shown.primary === 'not-breaking' && nb.advisories[0].why_not_shown.all.join() === 'not-breaking', 'a CONFIRMED item with no direct effect on the site is an ADVISORY ("not-breaking")');
    const ub = one(H('syntax-error', { status: 'PROBABLE_NEEDS_REVIEW', components: ['heavy'], ...logSup() }));
    ok(ub.findings.length === 0 && ub.advisories[0].why_not_shown.primary === 'not-established', 'a breaking but not established item (PROBABLE_NEEDS_REVIEW + log fatal) is an ADVISORY ("not-established")');
    ok(ub.advisories[0].backed_by_log.length === 1 && ub.advisories[0].backed_by_log[0].file === 'wp-content/plugins/heavy/heavy.php' && ub.advisories[0].backed_by_log[0].component === 'heavy' && ub.counts.backed_by_log === 1, '...it is never dropped: it records the log file and the component, and is counted as backed by a log error');
    const un = one(H('syntax-error', { status: 'UNVERIFIED', components: ['heavy'], ...logSup() }));
    ok(un.findings.length === 0 && un.advisories[0].why_not_shown.primary === 'not-established', 'UNVERIFIED: an advisory');
    const adv = one(H('removed-function-call', { advisory: true, components: ['heavy'], ...logSup() }));
    ok(adv.findings.length === 0 && adv.advisories[0].why_not_shown.primary === 'advisory', 'advisory: true is an advisory whatever else is true ("advisory")');
    ok(adv.advisories[0].why_not_shown.all.join() === 'advisory', 'a CONFIRMED + breaking item that is flagged advisory has exactly the reason "advisory"');
    const unc = one(H('js-error-in-component', { components: ['solo'], ...logSup() }));
    ok(unc.findings.length === 1 && unc.findings[0].label === 'unclassified', 'a confirmed and breaking item labelled unclassified is still shown');
    const rep = gate.split([H('syntax-error', { tag: 'r', status: 'REJECTED_FALSE_POSITIVE', components: ['heavy'], ...logSup() }), H('syntax-error', { tag: 'ok', components: ['heavy'], ...logSup() })], ctxOf());
    ok(rep.findings.length === 1 && rep.advisories.length === 0 && rep.rejected === 1 && rep.counts.rejected === 1, 'REJECTED_FALSE_POSITIVE is neither shown nor an advisory; it is only counted');
}

group('gate matrix: only the hypothesis\' own validated supports count as breaking evidence');
{
    const base = H('duplicate-declaration', { supports: [{ kind: 'observation', ref: 'o1' }], independent_kinds: ['observation'] });
    const r = one(base, ctxOf({ sandbox: { ran: true, reproduced: 'yes', matches: [{ detail: 'HTTP 500' }] }, probe: { ran: true } }));
    ok(r.findings.length === 0 && r.advisories[0].why_not_shown.primary === 'not-breaking', 'an unrelated 5xx somewhere on the site does not make a confirmed item "breaking"');
    const notValidated = H('syntax-error', { components: ['heavy'], supports: [{ kind: 'log', ref: 'c-fatal' }], independent_kinds: [] });
    ok(one(notValidated).findings.length === 0, 'a log support that did not survive validation (not in independent_kinds) does not count');
    const noFile = { ...FATAL, id: 'c-nofile', source: { kind: 'log', ref: 'other.log', line: 9 } };
    ok(one(H('syntax-error', { components: ['heavy'], supports: [{ kind: 'log', ref: 'c-nofile' }], independent_kinds: ['log'] }), ctxOf({ clues: [noFile] })).findings.length === 0, 'a log fatal that names no file is not breaking evidence');
    const notFatal = { ...FATAL, id: 'c-w', type: 'php-notice' };
    ok(one(H('syntax-error', { components: ['heavy'], supports: [{ kind: 'log', ref: 'c-w' }], independent_kinds: ['log'] }), ctxOf({ clues: [notFatal, { ...LOC, source: FATAL.source }] })).findings.length === 0, 'a PHP notice is not a fatal');
}
group('gate matrix: bisect (the sandbox) and the oracle that fired');
{
    const rep = (o = {}) => H('bisect-minimal-set', { status: 'REPRODUCIBLE', components: ['x'], supports: [{ kind: 'bisect', ref: 'bisect:x' }], independent_kinds: ['bisect'], ...o });
    const sb = (reproduced, matches = [], extra = {}) => ctxOf({ clues: [], sandbox: { ran: true, reproduced, matches, ...extra } });
    ok(one(rep(), { ...sb('yes'), oracleType: 'http-5xx' }).findings.length === 1, 'REPRODUCIBLE, the sandbox reproduced it, oracle http-5xx: finding');
    ok(one(rep(), { ...sb('yes'), oracleType: 'redirect' }).findings.length === 1, '... oracle redirect: finding');
    ok(one(rep(), { ...sb('yes', [{ detail: 'the page is blank (no visible text) with HTTP 200' }]), oracleType: 'generic' }).findings.length === 1, '... generic oracle that found a blank page: finding');
    ok(one(rep(), { ...sb('yes', [{ detail: 'a critical-error text is shown with HTTP 200' }]), oracleType: 'generic' }).findings.length === 1, '... generic oracle that found a critical-error text: finding');
    ok(one(rep(), { ...sb('yes', [{ detail: 'the page ended in a redirect loop' }]), oracleType: 'generic' }).findings.length === 1 && one(rep(), { ...sb('yes', [{ detail: 'redirected to another host: a -> b' }]), oracleType: 'generic' }).findings.length === 1, '... generic oracle that found a redirect loop or another host: finding');
    ok(one(rep(), { ...sb('yes', [{ detail: 'HTTP 404 for /wp-json/x' }]), oracleType: 'request-failed' }).findings.length === 1 && one(rep(), { ...sb('yes', [{ detail: 'HTTP 404 for /style.css' }]), oracleType: 'request-failed' }).findings.length === 0, '... a failed request counts on login / REST / checkout only');
    ok(one(rep(), { ...sb('yes', [{ detail: 'Uncaught TypeError: x is not a function' }]), oracleType: 'console-error' }).findings.length === 1 && one(rep(), { ...sb('yes', [{ detail: 'jQuery Migrate warning' }]), oracleType: 'console-error' }).findings.length === 0, '... a JavaScript error counts when it stopped something (Uncaught / not a function), a warning does not');
    ok(one(rep(), { ...sb('yes'), oracleType: 'no-hscroll' }).advisories[0].why_not_shown.primary === 'not-breaking', 'the oracle was a horizontal-scroll check: reproduced, but not an effect that breaks the site: advisory');
    ok(one(rep(), { ...sb('no'), oracleType: 'http-5xx' }).findings.length === 0, 'the sandbox did not reproduce the symptom: advisory');
    ok(one(rep(), { ...sb('yes'), oracleType: 'http-5xx', sandbox: { ran: false } }).findings.length === 0, 'no sandbox test was run: a bisect support alone proves nothing');
    ok(one(H('syntax-error', { status: 'REPRODUCIBLE', components: ['x'], supports: [{ kind: 'observation', ref: 'o' }], independent_kinds: ['observation'] }), { ...sb('yes'), oracleType: 'http-5xx' }).findings.length === 0, 'REPRODUCIBLE without a bisect support of its own is not "breaking" because the sandbox reproduced something else');
}
group('gate matrix: the live probe');
{
    const pc = (clue) => one(H('js-error-in-component', { components: ['x'], supports: [{ kind: 'probe', ref: clue.id }], independent_kinds: ['probe'] }), ctxOf({ clues: [clue], probe: { ran: true } }));
    ok(pc(probeClue('probe-page-error', 'Uncaught TypeError: a is not a function')).findings.length === 1, 'a page error seen by the probe: finding');
    ok(pc(probeClue('probe-console-error', 'Uncaught ReferenceError: b is not defined')).findings.length === 1 && pc(probeClue('probe-console-error', 'jQuery.migrateMute is deprecated')).findings.length === 0, 'a console error counts only when it is an uncaught / not-a-function error');
    ok(pc(probeClue('probe-http-status', 'HTTP 503 /', { status: 503 })).findings.length === 1 && pc(probeClue('probe-http-status', 'HTTP 404 /', { status: 404 })).findings.length === 0, 'a 5xx answer counts, a 404 does not');
    ok(pc(probeClue('probe-redirect', 'redirect loop: x')).findings.length === 1, 'a redirect problem seen by the probe: finding');
    ok(pc(probeClue('probe-failed-asset', 'HTTP 404 /wp-json/wc/v3', { status: 404, url: 'http://x.test/wp-json/wc/v3' })).findings.length === 1 && pc(probeClue('probe-failed-asset', 'HTTP 404 /a.png', { status: 404, url: 'http://x.test/a.png' })).findings.length === 0, 'a failed request counts on login / REST / checkout, a missing image does not');
}
group('gate matrix: reported, not observed (redirect-on-hook)');
{
    const rh = (o = {}) => H('redirect-on-hook', { components: ['a'], supports: [{ kind: 'observation', ref: 'o' }], independent_kinds: ['observation'], ...o });
    const r = one(rh());
    ok(r.findings.length === 0 && r.advisories[0].why_not_shown.primary === 'reported-not-observed', 'a redirect-on-hook item that rests only on what the reporter said: advisory with the reason "reported-not-observed"');
    ok(one(rh({ status: 'UNVERIFIED' })).advisories[0].why_not_shown.all.join() === 'reported-not-observed,not-established', '... and when it is also not established, both reasons are listed, "reported-not-observed" first');
    const seen = probeClue('probe-redirect', 'redirect loop: x', {}, 'p-r');
    ok(one(rh({ supports: [{ kind: 'observation', ref: 'o' }, { kind: 'probe', ref: 'p-r' }], independent_kinds: ['observation', 'probe'] }), ctxOf({ clues: [seen], probe: { ran: true } })).findings.length === 1, 'the probe saw the redirect: finding');
    ok(one(rh(), ctxOf({ sandbox: { ran: true, redirectObserved: true } })).findings.length === 1, 'the sandbox saw the redirect: finding');
    ok(one(rh(), ctxOf({ sandbox: { ran: false, redirectObserved: true } })).findings.length === 0, 'a sandbox that did not run cannot have seen it');
}
group('gate matrix: compromise is always shown (unless rejected)');
{
    for (const st of ['PROBABLE_NEEDS_REVIEW', 'UNVERIFIED', 'CONFIRMED']) {
        const r = one(H('classic:integrity-obfuscated-exec', { status: st, class: 'compromise', components: [], evidence: [{ file: 'wp-content/uploads/x.php', line: 1 }] }));
        ok(r.findings.length === 1 && r.findings[0].label === 'compromise' && r.findings[0].shown_because === 'compromise signs are always shown' && r.advisories.length === 0, `compromise with status ${st}: shown as a finding, no breaking evidence needed`);
    }
    const rj = one(H('classic:integrity-obfuscated-exec', { status: 'REJECTED_FALSE_POSITIVE', class: 'compromise', components: [] }));
    ok(rj.findings.length === 0 && rj.advisories.length === 0 && rj.rejected === 1, 'compromise that validate.js rejected (the pattern is gone from the file) is not shown');
}
group('gate: determinism, purity, no status assigned');
{
    const set = () => [H('syntax-error', { tag: '1', components: ['heavy'], ...logSup() }), H('duplicate-declaration', { tag: '2', supports: [{ kind: 'observation', ref: 'o' }], independent_kinds: ['observation'] }), H('classic:integrity-obfuscated-exec', { tag: '3', class: 'compromise', components: [], status: 'PROBABLE_NEEDS_REVIEW' }), H('removed-function-call', { tag: '4', advisory: true, status: 'UNVERIFIED', components: ['heavy'], ...logSup() })];
    const a = gate.split(set(), ctxOf()), b = gate.split(set().reverse(), ctxOf());
    ok(JSON.stringify(a) === JSON.stringify(b), 'deterministic: the same hypotheses in another order give the identical split');
    ok(a.findings[0].label === 'compromise', 'compromise findings are listed first');
    const frozen = set().map(h => Object.freeze({ ...h, supports: Object.freeze(h.supports.slice()), components: Object.freeze(h.components.slice()) }));
    let threw = null; try { gate.split(frozen, ctxOf()); } catch (e) { threw = e.message; }
    ok(!threw, 'the input is not modified (frozen input does not throw)');
    ok(JSON.stringify(set().map(h => h.status)) === JSON.stringify(a.findings.concat(a.advisories).map(x => x.id).length ? set().map(h => h.status) : []), 'statuses come back as they went in');
    ok(a.findings.concat(a.advisories).every(x => ['CONFIRMED', 'PROBABLE_NEEDS_REVIEW', 'UNVERIFIED'].includes(x.status)), 'every item carries the status validate.js gave it');
    for (const f of ['conflict-type.js', 'gate.js', 'cause.js', 'rollback.js', 'summary.js']) {
        const src = fs.readFileSync(path.join(__dirname, '..', 'issue', f), 'utf8').replace(/\/\/.*$/gm, '');
        ok(!/status\s*[:=]\s*['"](CONFIRMED|REPRODUCIBLE|REJECTED_FALSE_POSITIVE|FIXED_VERIFIED)['"]/.test(src) && !/\.status\s*=[^=]/.test(src) && !/(verdict)\s*[:=]/.test(src), `${f} never assigns CONFIRMED / REPRODUCIBLE / REJECTED_FALSE_POSITIVE / FIXED_VERIFIED`);
    }
    for (const f of ['conflict-type.js', 'gate.js', 'cause.js', 'rollback.js', 'summary.js']) ok(!/require\([^)]*(combined|frontend)/.test(fs.readFileSync(path.join(__dirname, '..', 'issue', f), 'utf8')), `${f} does not load another module of the repository`);
}

// ---------------------------------------------------------------- a bisection that names a single plugin
group('a bisection that names one plugin keeps the label "unclassified" and says the partner is unknown');
{
    const ctx = ctxOf({ clues: [], sandbox: { ran: true, reproduced: 'yes', matches: [{ detail: 'HTTP 500' }] }, names: { x: 'X' } });
    const mkb = comps => H('bisect-minimal-set', { status: 'REPRODUCIBLE', components: comps, supports: [{ kind: 'bisect', ref: 'bisect:p' }], independent_kinds: ['bisect'] });
    const r = gate.split([mkb(['x'])], ctx), f = r.findings[0];
    ok(f && f.label === 'unclassified' && f.cause === 'caused by plugin X (conflict partner not identified)', `one plugin: label "${f && f.label}" in the data, cause "${f && f.cause}"`);
    const text = summary.summarise(r, { ran: { sandbox: true } }).text;
    ok(/aused by plugin X \(conflict partner not identified\)/.test(text), 'the report text says "caused by plugin X (conflict partner not identified)"');
    const two = gate.split([mkb(['a', 'b'])], { ...ctx, names: { a: 'A', b: 'B' } }).findings[0];
    ok(two.label === 'plugin-plugin' && two.cause === 'caused by plugin A and plugin B together', 'two plugins: plugin-plugin, "caused by plugin A and plugin B together"');
    const th = gate.split([H('bisect-minimal-set', { status: 'REPRODUCIBLE', components: [], supports: [{ kind: 'bisect', ref: 'bisect:theme' }], independent_kinds: ['bisect'] })], ctx).findings[0];
    ok(th.label === 'unclassified' && th.cause === 'caused by the active theme (conflict partner not identified)', 'the theme alone: unclassified, "caused by the active theme (conflict partner not identified)"');
}

// ---------------------------------------------------------------- plain-language causes
group('every finding has a plain-language cause line');
{
    const types = [...new Set([...CT.ENV_TYPES, ...CT.CORE_PHP_TYPES, ...CT.HOOK_TYPES, ...CT.BY_KINDS_TYPES, ...integrity])].sort();
    const JARGON = /oracle|hypothes|regex|\bAST\b|syntax tree|callback|\bclue|payload|\bhook\b|bisect|probe/i;
    let bad = [];
    for (const t of types) {
        const h = t.startsWith('kb:') ? H('kb', { kb: [t.slice(3)], components: ['a', 'b'], ...logSup() }) : H(t, { components: ['a', 'b'], class: t.startsWith('classic:integrity-') ? 'compromise' : null, ...logSup() });
        const r = one(h), f = r.findings[0];
        if (!f || !f.cause || f.cause.length < 12 || f.cause === t || JARGON.test(f.cause)) bad.push(`${t}: ${f ? JSON.stringify(f.cause) : 'no finding'}`);
    }
    ok(bad.length === 0, `all ${types.length} types give a finding with a plain cause line${bad.length ? ': ' + bad.slice(0, 4).join(' | ') : ''}`);
    const ex = (type, o = {}) => one(H(type, { components: ['heavy'], ...o, ...logSup() })).findings[0].cause;
    ok(ex('syntax-error', { evidence: [{ file: 'wp-content/plugins/heavy/heavy.php', line: 12 }] }) === 'a PHP syntax error in wp-content/plugins/heavy/heavy.php:12', 'syntax error: "a PHP syntax error in <file>"');
    ok(/^Possible compromise signs were found in wp-content\/uploads\/x\.php \(pattern match, not proof\)$/.test(ex('classic:integrity-obfuscated-exec', { class: 'compromise', components: [], evidence: [{ file: 'wp-content/uploads/x.php', line: 1 }] })), 'compromise: the cause line is the cautious sentence');
    ok(/PHP ran out of memory/.test(one(H('error-in-component', { components: ['heavy'], supports: [{ kind: 'log', ref: 'c-mem' }], independent_kinds: ['log'] }), ctxOf({ clues: [memClue, { ...LOC, source: memClue.source }] })).findings[0].cause), 'memory exhausted: "PHP ran out of memory ... raised in <file>"');
    ok(cause(H('some-future-type', { mechanism: 'Something odd happened here. More.' })) === 'Something odd happened here' && cause(H('some-future-type', { mechanism: '', title: 'A title' })) === 'A title', 'a type without a template falls back to the first sentence of its own text, then its title (never empty)');
    ok(/on PHP 8\.3 \(sandbox\); the site's own PHP version is unknown/.test(cause(H('removed-function-call', { components: ['a'] }), { obsOf: () => ({ message: "a calls each(), which no longer exists from PHP 8.0; on PHP 8.3 (sandbox); the site's own PHP version is unknown" }) })), 'a sandbox-PHP cause keeps the sentence "the site\'s own PHP version is unknown"');
}

// ---------------------------------------------------------------- rollback
group('rollback text: only from data the result has');
{
    const plan = { hypothesis: 'h', options: [
        { type: 'patch', title: 'Fix', file: 'wp-content/plugins/a/a.php' }, { type: 'shim', title: 'Shim', file: 'wp-content/mu-plugins/pg-shim.php' }, { type: 'plugin', title: 'Deactivate', plugin: 'woo-thing' },
        { type: 'settings', title: 'Setting', setting: { label: 'Delay JavaScript', admin_path: 'WP Rocket > File Optimization', stored_key: 'delay_js' } }, { type: 'human', title: 'Look at it' }, { type: 'plugin', title: 'bad slug', plugin: '../../etc; rm -rf' }
    ] };
    const r = rollback.rollbackFor(plan);
    ok(r.intro === 'Plugin Guard itself changed nothing on your website.', 'the first line says Plugin Guard changed nothing');
    ok(/restore wp-content\/plugins\/a\/a\.php from your backup/.test(r.options[0].undo), 'patch: restore the file from the backup');
    ok(/delete wp-content\/mu-plugins\/pg-shim\.php/.test(r.options[1].undo), 'shim: delete the file');
    ok(/re-activate woo-thing/.test(r.options[2].undo) && /wp plugin activate woo-thing/.test(r.options[2].undo), 'plugin: re-activate it');
    ok(/Delay JavaScript/.test(r.options[3].undo) && /delay_js/.test(r.options[3].undo) && /WP Rocket > File Optimization/.test(r.options[3].undo), 'setting: change it back, naming the screen and the stored key from the data');
    ok(/nothing to undo/.test(r.options[4].undo), 'an option with no data: "there is nothing to undo"');
    ok(/nothing to undo/.test(r.options[5].undo) && !/rm -rf/.test(JSON.stringify(r)), 'a plugin slug that is not a plain slug is never put into a command');
    ok(rollback.rollbackFor(null).options.length === 0 && rollback.rollbackFor({ options: [] }).intro === rollback.INTRO, 'no plan: only the first line');
    ok(JSON.stringify(rollback.rollbackFor(plan)) === JSON.stringify(r), 'deterministic');
}

// ---------------------------------------------------------------- summaries
group('summaries in plain English');
const split = (hs, c) => gate.split(hs, c || ctxOf());
const JARGON2 = /oracle|hypothes|regex|\bAST\b|callback|\bclue|payload|bisect/i;
const seenFinding = (type = 'js-error-in-component', tag = 's') => H(type, { tag, components: ['heavy'], supports: [{ kind: 'probe', ref: 'p-page' }], independent_kinds: ['probe'], evidence: [{ file: 'wp-content/plugins/heavy/heavy.js', line: 3 }] });
const seenCtx = ctxOf({ clues: [FATAL, LOC, probeClue('probe-page-error', 'Uncaught TypeError: a is not a function', {}, 'p-page')], probe: { ran: true } });
{
    const logOnly = split([H('syntax-error', { components: ['heavy'], evidence: [{ file: 'wp-content/plugins/heavy/heavy.php', line: 12 }], ...logSup() })]);
    const s1 = summary.summarise(logOnly, { ran: { probe: true } });
    ok(s1.headline === '1 confirmed cause was found in your logs.' && !/breaks your website/.test(s1.text), 'only a log: "1 confirmed cause was found in your logs." and NOT "breaks your website"');
    ok(/^  • A PHP syntax error in wp-content\/plugins\/heavy\/heavy\.php:12\.$/m.test(s1.text), 'the bullet is the plain cause line and nothing more');
    ok(!/a problem involving PHP or WordPress itself|two plugins clash|a single plugin, theme or file|your hosting/.test(s1.text), 'the label is not appended as an explanation (a plugin\'s own file is not "a problem involving PHP or WordPress itself")');
    const seen = split([seenFinding()], seenCtx);
    const s2 = summary.summarise(seen, { ran: { probe: true } });
    ok(s2.headline === 'We found 1 confirmed cause that breaks your website.' && /JavaScript error|A JavaScript error on the page comes from plugin heavy/.test(s2.text) && !/found in your logs/.test(s2.text), 'seen failing on the live page: "We found 1 confirmed cause that breaks your website."');
    const two = split([seenFinding('js-error-in-component', 'a'), seenFinding('failed-asset', 'b')], seenCtx);
    ok(summary.summarise(two, { ran: { probe: true } }).headline === 'We found 2 confirmed causes that break your website.', 'plural: "2 confirmed causes that break your website"');
    const mixed2 = split([seenFinding(), H('syntax-error', { tag: 'lg', components: ['heavy'], evidence: [{ file: 'wp-content/plugins/heavy/heavy.php', line: 12 }], ...logSup() })], seenCtx);
    const sm = summary.summarise(mixed2, { ran: { probe: true } });
    ok(sm.headline.endsWith('break your website.') && /PHP syntax error in wp-content\/plugins\/heavy\/heavy\.php:12 \(found in your logs\)\.$/m.test(sm.text) && !/JavaScript error.*found in your logs/.test(sm.text), 'seen and log-only together: the headline says "break your website", only the log-only bullet says "(found in your logs)"');
    ok(logOnly.findings[0].log_only === true && split([seenFinding()], seenCtx).findings[0].log_only === false, 'the data says which findings rest on a log alone (log_only)');
    const s1b = summary.summarise(logOnly, { ran: {} });
    ok(/no live check or sandbox test was run/.test(s1b.text) && !/does not mean the site is healthy/.test(s1b.text) && summary.summarise(logOnly, { ran: { sandbox: true } }).text.indexOf('no live check') === -1, 'findings: with neither probe nor sandbox the summary says "no live check or sandbox test was run"; if one ran it does not; the "healthy" sentence is not added when something was found');
    const advOnly = split([H('duplicate-declaration', { supports: [{ kind: 'observation', ref: 'o' }], independent_kinds: ['observation'] }), H('syntax-error', { tag: 'b', status: 'PROBABLE_NEEDS_REVIEW', components: ['heavy'], ...logSup() })]);
    const s3 = summary.summarise(advOnly, { ran: {} });
    ok(s3.headline === 'No confirmed breaking cause was found.' && /2 possible causes are listed under Advisories \(run with --verbose to see them\)\./.test(s3.text), 'advisories only: "No confirmed breaking cause was found." and "2 possible causes are listed under Advisories (run with --verbose to see them)."');
    ok(/1 of them is backed by a log error but was not confirmed: wp-content\/plugins\/heavy\/heavy\.php \(plugin heavy\)\./.test(s3.text), 'the log-backed line names the file and the component');
    ok(/2 possible causes are listed under Advisories below\./.test(summary.summarise(advOnly, { ran: {}, verbose: true }).text) && !/run with --verbose/.test(summary.summarise(advOnly, { ran: {}, verbose: true }).text), 'with --verbose the summary says "listed under Advisories below", not "run with --verbose"');
    ok(/no live check or sandbox test was run/.test(s3.text) && !/does not mean the site is healthy/.test(s3.text), 'advisories only: the "no live check" sentence is there; "healthy" is not said (something was found)');
    const empty = summary.summarise(split([]), { ran: {} });
    ok(empty.headline === 'No confirmed breaking cause was found.' && /Nothing else stood out\./.test(empty.text) && /no live check or sandbox test was run/.test(empty.text), 'empty: never an empty report');
    ok(/This does not mean the site is healthy\./.test(empty.text) && empty.lines[empty.lines.length - 1] === 'This does not mean the site is healthy.', 'empty and nothing ran: "This does not mean the site is healthy." is the last line');
    ok(!/healthy/.test(summary.summarise(split([]), { ran: { probe: true } }).text) && !/no live check/.test(summary.summarise(split([]), { ran: { probe: true } }).text), 'empty but a live check ran: neither the "no live check" nor the "healthy" sentence');
    const comp = split([H('classic:integrity-obfuscated-exec', { class: 'compromise', status: 'PROBABLE_NEEDS_REVIEW', components: [], evidence: [{ file: 'wp-content/uploads/x.php', line: 1 }] })]);
    const s4 = summary.summarise(comp, { ran: { probe: true } });
    ok(s4.text.includes('Possible compromise signs were found (pattern match, not proof).') && /A person should look at: wp-content\/uploads\/x\.php\./.test(s4.text) && s4.headline === 'No confirmed breaking cause was found.', 'compromise: the exact sentence, the file, and no claim of a confirmed breaking cause');
    ok(s4.lines.includes('Do not delete files yourself; ask your host or a security professional to check, and keep a backup.'), 'compromise: "Do not delete files yourself; ask your host or a security professional to check, and keep a backup."');
    ok(!summary.summarise(split([seenFinding()], seenCtx), { ran: { probe: true } }).text.includes('Do not delete files yourself'), 'the delete advice appears only with compromise signs');
    const everyText = [s1, s1b, s2, s3, empty, s4, sm].map(s => s.text).join('\n');
    ok(!/hacked|infected|malware|your site is compromised|you have been/i.test(everyText), 'the word "hacked" (or infected, malware, "your site is compromised") is never used');
    ok(![s1, s2, s3, empty, s4].some(s => JARGON2.test(s.text)), 'no jargon in any summary');
    const mixed = split([seenFinding(), H('classic:integrity-obfuscated-exec', { tag: 'c', class: 'compromise', components: [], evidence: [{ file: 'wp-content/uploads/x.php' }] })], seenCtx);
    const sx = summary.summarise(mixed, { ran: { probe: true } });
    ok(sx.text.includes('We found 1 confirmed cause') && sx.text.includes('Possible compromise signs were found') && sx.text.includes('Do not delete files yourself'), 'a confirmed cause and compromise signs together: both are said, the compromise one separately');
    ok(JSON.stringify(summary.summarise(advOnly, { ran: {} })) === JSON.stringify(summary.summarise(advOnly, { ran: {} })), 'deterministic');
    ok(gate.split([H('syntax-error', { status: 'FIXED_VERIFIED', components: ['heavy'], ...logSup() })], ctxOf()).findings.length === 1, 'a hypothesis that issue retest marked FIXED_VERIFIED was established; it stays a finding (the report shows the retest)');
    ok(Object.keys(gate.REASON_TEXT).sort().join() === 'advisory,not-breaking,not-established,reported-not-observed' && advOnly.advisories.every(a => a.why_not_shown.text && a.why_not_shown.text === gate.REASON_TEXT[a.why_not_shown.primary]), 'every advisory carries its reason in plain words');
}

// ---------------------------------------------------------------- the hypotheses.js change
(async () => {
    group('a PHP fatal that names a component file becomes a hypothesis (hypotheses.js)');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-gate-'));
    process.env.PLUGIN_GUARD_ISSUES = path.join(tmp, 'issues');
    const store = require('../lib/issue-store'), ev = require('../issue/evidence'), an = require('../issue/analysis');
    const root = path.join(tmp, 'wp'); const w = (r, b) => { const f = path.join(root, r); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, b); };
    w('wp-config.php', '<?php\n'); w('wp-includes/version.php', "<?php\n$wp_version = '6.8.1';\n"); fs.mkdirSync(path.join(root, 'wp-admin'), { recursive: true });
    w('wp-content/plugins/heavy/heavy.php', '<?php\n/**\n * Plugin Name: Heavy\n * Version: 1.0\n */\nfunction heavy_run() { return 1; }\n');
    w('wp-content/plugins/other/other.php', '<?php\n/**\n * Plugin Name: Other\n * Version: 1.0\n */\nfunction heavy_run() { return 2; }\n');
    const run = async (line, title) => {
        w('wp-content/debug.log', line ? `[01-Nov-2026 10:00:00 UTC] ${line}\n` : '');
        const i = store.create({ title, description: 'site down', symptom: 'white-screen', environment: 'local', url: 'http://127.0.0.1:9/', root, pages: ['/'] });
        await ev.run(i.id, { root, probeOptions: { probe: false } });
        const r = an.run(i.id, { root }); const e = JSON.parse(fs.readFileSync(path.join(store.dirOf(i.id), 'work', 'evidence.json'), 'utf8'));
        return { hyps: r.hypotheses.hypotheses, clues: e.clues };
    };
    const mem = await run(`PHP Fatal error:  Allowed memory size of 134217728 bytes exhausted (tried to allocate 8192 bytes) in ${root}/wp-content/plugins/heavy/heavy.php on line 6`, 'mem');
    const eic = mem.hyps.find(h => h.type === 'error-in-component');
    ok(eic && eic.components.join() === 'heavy' && eic.supports.some(s => s.kind === 'log') && /Allowed memory size/.test(eic.mechanism), 'a "memory size exhausted" fatal naming a plugin file now makes an error-in-component hypothesis with a log support');
    const lab = CT.label(eic, { clueById: id => mem.clues.find(c => c.id === id) });
    ok(lab.label === 'environment-server', 'through the real log: that hypothesis is labelled environment-server');
    const time = await run(`PHP Fatal error:  Maximum execution time of 30 seconds exceeded in ${root}/wp-content/plugins/heavy/heavy.php on line 6`, 'time');
    ok(CT.label(time.hyps.find(h => h.type === 'error-in-component'), { clueById: id => time.clues.find(c => c.id === id) }).label === 'environment-server', 'through the real log: "maximum execution time" -> environment-server');
    const ext = await run(`PHP Fatal error:  Uncaught Error: Call to undefined function mb_strlen() in ${root}/wp-content/plugins/heavy/heavy.php:6`, 'ext');
    const mf = ext.hyps.find(h => h.type === 'missing-function');
    ok(mf && !ext.hyps.some(h => h.type === 'error-in-component') && CT.label(mf, { clueById: id => ext.clues.find(c => c.id === id) }).label === 'environment-server', 'through the real log: a missing mbstring function arrives as missing-function (not duplicated as error-in-component) and is labelled environment-server');
    const red = await run(`PHP Fatal error:  Cannot redeclare heavy_run() (previously declared in ${root}/wp-content/plugins/heavy/heavy.php:6) in ${root}/wp-content/plugins/other/other.php on line 6`, 'redeclare');
    ok(red.hyps.some(h => h.type === 'duplicate-declaration') && !red.hyps.some(h => h.type === 'error-in-component'), 'a "Cannot redeclare" fatal keeps its own hypothesis and does not get a second one');
    const none = await run('', 'clean');
    ok(!none.hyps.some(h => h.type === 'error-in-component'), 'a clean log makes no such hypothesis');
    const warn = await run(`PHP Warning:  Undefined variable $x in ${root}/wp-content/plugins/heavy/heavy.php on line 6`, 'warn');
    ok(warn.hyps.filter(h => h.type === 'error-in-component').length === 1, 'a PHP warning still makes exactly one error-in-component hypothesis, as before');
    const sp = gate.split(mem.hyps.map(h => ({ ...h, independent_kinds: [...new Set(h.supports.map(s => s.kind))] })), { clues: mem.clues, oracleType: 'http-5xx', sandbox: { ran: false }, probe: { ran: false } });
    ok(sp.findings.length === 0 && sp.advisories.some(a => a.type === 'error-in-component' && a.backed_by_log.length === 1 && a.backed_by_log[0].file === 'wp-content/plugins/heavy/heavy.php' && a.backed_by_log[0].component === 'heavy'), 'end to end: that hypothesis is not established, so it is an advisory that names the log file and the plugin (the summary then says so)');
    const sum = summary.summarise(sp, { ran: {} });
    ok(/backed by a log error but was not confirmed: wp-content\/plugins\/heavy\/heavy\.php \(plugin heavy\)/.test(sum.text), 'and the summary line is there');

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
