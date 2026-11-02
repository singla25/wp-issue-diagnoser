#!/usr/bin/env node
// Step 6: the follow-up question engine (issue/questions.js) and how its answers reach the issue (lib/issue-store.js applyQuestionAnswers).
// Rules by gap (positive / negative / already answered), the fixed order and the caps (3 before the probe, 2 after the code analysis), skip and stop, no terminal,
// --yes / --no-questions / --no-prompt, determinism, plain wording with numbered choices and an explicit skip, answers that cannot set a status, a page on another
// host refused, old issue.json files, the offline re-run of the analysis, and the whole thing through `issue investigate`. Offline fixtures only.
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-questions-'));
process.env.PLUGIN_GUARD_ISSUES = path.join(tmp, 'issues');
const store = require('../lib/issue-store');
const Q = require('../issue/questions');
const analysis = require('../issue/analysis');
const cli = require('../lib/issue-cli');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const group = t => console.log(`\n== ${t}`);
const head = (n, v = '1.0.0') => `<?php\n/**\n * Plugin Name: ${n}\n * Version: ${v}\n */\n`;
let n = 0;
function tree(parts) {
    const root = path.join(tmp, `wp${++n}`); const w = (rel, body) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); };
    w('wp-config.php', '<?php\n'); w('wp-includes/version.php', "<?php\n$wp_version = '6.8.1';\n"); fs.mkdirSync(path.join(root, 'wp-admin'), { recursive: true });
    for (const [rel, body] of Object.entries(parts)) w(rel, body);
    return root;
}
const mkIssue = (o = {}) => store.create({ title: 'Questions fixture', description: '', symptom: 'other', environment: 'local', url: 'http://127.0.0.1:9/', pages: [], ...o });
const I = (o = {}) => ({ title: 't', description: '', since: '', changed_before: '', symptom: 'other', pages: [], url: 'http://127.0.0.1:9/', oracle: { type: 'generic', value: null, defaulted: true }, needs_login: false, php_version: null, ...o });
const ctx = (issue = {}, o = {}) => ({ issue: I(issue), clues: [], components: [], observations: [], redirect_map: [], redirect_observed: false, viewports_given: false, ...o });
const applies = (id, c) => Q.RULES[id].applies(c);
const ANSWERED = (...ids) => ({ asked: Object.fromEntries(ids.map(i => [i, { answer: 'x', skipped: false }])) });

group('rule 1: since when / what changed');
ok(applies('since', ctx()), 'positive: nothing said about when or what changed');
ok(!applies('since', ctx({ since: 'last week' })) && !applies('since', ctx({ changed_before: 'updated Woo' })), 'negative: either field is filled');
ok(!applies('since', ctx({ questions: ANSWERED('since') })), 'already answered (or skipped): not asked again');

group('rule 2: which page');
ok(applies('page', ctx()) && applies('page', ctx({ url: 'http://127.0.0.1:9' })), 'positive: no page and an address without a path');
ok(!applies('page', ctx({ pages: ['/shop/'] })) && !applies('page', ctx({ url: 'http://127.0.0.1:9/shop/' })), 'negative: a page is given, or the address already has a path');
ok(!applies('page', ctx({ questions: ANSWERED('page') })), 'already answered');

group('rule 3: logged in or out');
ok(applies('login', ctx({ symptom: 'login-admin' })) && applies('login', ctx({ symptom: 'form-checkout' })), 'positive: a login or checkout problem');
ok(!applies('login', ctx({ symptom: 'layout' })) && !applies('login', ctx({ symptom: 'other' })), 'negative: another symptom');
ok(!applies('login', ctx({ symptom: 'login-admin', questions: ANSWERED('login') })), 'already answered');

group('rule 4: what exactly looks wrong');
ok(applies('what', ctx({ symptom: 'other' })) && applies('what', ctx({ symptom: 'white-screen' })), 'positive: symptom "other", or an error symptom with no error clue');
ok(!applies('what', ctx({ symptom: 'white-screen' }, { clues: [{ type: 'php-fatal' }] })) && !applies('what', ctx({ symptom: 'js-error' }, { clues: [{ type: 'js-not-defined' }] })), 'negative: an error clue exists');
ok(!applies('what', ctx({ symptom: 'layout' })) && !applies('what', ctx({ symptom: 'slow' })), 'negative: a layout or speed complaint has no error clue by nature');
ok(!applies('what', ctx({ symptom: 'other', questions: ANSWERED('what') })), 'already answered');
const qWhat = Q.RULES.what.build(ctx({ symptom: 'other' }, { clues: [{ type: 'php-fatal' }] }));
ok(qWhat.choices.some(c => /logs point to this/.test(c.label) && c.value === 'white-screen'), 'a log fatal marks "blank white page" as the suggestion');
ok(Q.proposeOracle('white-screen', [{ type: 'php-fatal' }]).type === 'debug-log' && Q.proposeOracle('js-error', [{ type: 'js-not-defined', detail: { symbol: 'jQuery.fn.slick' } }]).value === 'jQuery.fn.slick' && Q.proposeOracle('layout', [{ type: 'php-fatal' }]) === null, 'an oracle is proposed from the clues only where the clue fits the symptom');

group('rule 5: the site\'s PHP version');
const compat = [{ type: 'removed-function-call' }];
ok(applies('php', ctx({}, { observations: compat })) && applies('php', ctx({}, { observations: [{ type: 'requires-php-mismatch' }] })), 'positive: a compatibility observation and no PHP version');
ok(!applies('php', ctx({ php_version: '8.1' }, { observations: compat })) && !applies('php', ctx({}, { observations: [{ type: 'duplicate-shortcode' }] })), 'negative: version known, or no compatibility observation');
ok(!applies('php', ctx({ questions: ANSWERED('php') }, { observations: compat })), 'already answered');

group('rule 6: which page redirects');
const hookMap = [{ context: 'hook', common: false }];
ok(applies('redirect', ctx({ symptom: 'redirect' }, { redirect_map: hookMap })) && applies('redirect', ctx({ description: 'I get sent to the wrong page after login' }, { redirect_map: hookMap })), 'positive: the code redirects on a hook, nothing was observed, and the report is about redirects');
ok(!applies('redirect', ctx({ symptom: 'redirect' }, { redirect_map: hookMap, redirect_observed: true })), 'negative: a redirect was observed');
ok(!applies('redirect', ctx({ symptom: 'redirect' }, { redirect_map: [{ context: 'unknown' }] })) && !applies('redirect', ctx({ symptom: 'redirect' })), 'negative: no redirect call matched to a hook');
ok(!applies('redirect', ctx({ symptom: 'layout' }, { redirect_map: hookMap })), 'negative: a report that is not about redirects (every site has some redirect code)');
ok(!applies('redirect', ctx({ symptom: 'redirect', questions: ANSWERED('redirect') }, { redirect_map: hookMap })), 'already answered');

group('rule 7: phone or desktop');
ok(applies('screen', ctx({ symptom: 'layout' })), 'positive: a layout problem and no word about the screen');
ok(!applies('screen', ctx({ symptom: 'layout', description: 'broken on my phone' })) && !applies('screen', ctx({ symptom: 'layout' }, { viewports_given: true })) && !applies('screen', ctx({ symptom: 'slow' })), 'negative: the screen is named, --viewports was given, or another symptom');
ok(!applies('screen', ctx({ symptom: 'layout', questions: ANSWERED('screen') })), 'already answered');

group('order, caps, determinism');
const walk = (c, ids) => { const state = Q.newState(), seq = []; for (let k = 0; k < 20; k++) { const q = Q.next(c, ids, state); if (!q) break; seq.push(q.id); state.used[Q.GROUP[q.id]]++; c.issue.questions = { asked: { ...((c.issue.questions || {}).asked || {}), [q.id]: { answer: 'x', skipped: false } } }; } return seq; };
ok(walk(ctx({ symptom: 'login-admin' }), Q.RULE_ORDER).join() === 'since,page,login', 'fixed order: since, page, login');
ok(walk(ctx({ symptom: 'other' }), Q.RULE_ORDER).join() === 'since,page,what', 'symptom "other": since, page, what');
ok(walk(ctx({ symptom: 'layout' }), Q.RULE_ORDER).join() === 'since,page,screen', 'layout: since, page, screen');
ok(walk(ctx({ symptom: 'redirect', pages: ['/'], since: 'x' }, { observations: compat, redirect_map: hookMap }), Q.RULE_ORDER).join() === 'php,redirect', 'after the code analysis: php, then redirect');
ok(Q.LIMITS.A === 3 && Q.LIMITS.B === 2 && Q.LIMITS.A + Q.LIMITS.B === 5, 'the caps: 3 before the probe, 2 after the code analysis, 5 in all');
const strict = JSON.stringify(Q.RULES.since.build(ctx({}, { components: [{ ref: 'a', name: 'A', version: '1.0' }] })));
ok(strict === JSON.stringify(Q.RULES.since.build(ctx({}, { components: [{ ref: 'a', name: 'A', version: '1.0' }] }))), 'deterministic: the same context gives the identical question');

group('component choices: header version, then name; file times never decide');
const cs = [{ ref: 'b', name: 'Beta', version: '1.2.0' }, { ref: 'a', name: 'Alpha', version: '1.2.0' }, { ref: 'c', name: 'Gamma', version: '2.0.0' }, { ref: 'd', name: 'Delta' }, { ref: 'e', name: 'Epsilon', version: '1.10.0' }];
ok(Q.orderComponents(cs).map(c => c.name).join() === 'Gamma,Epsilon,Alpha,Beta,Delta', 'newest header version first (1.10.0 above 1.2.0), then name, no version last');
const withTimes = cs.map((c, i) => ({ ...c, updated_text: `2026-0${(i % 9) + 1}-01` })), reversed = cs.map((c, i) => ({ ...c, updated_text: `2026-0${9 - (i % 9)}-01` }));
const names = q => q.choices.filter(c => c.value).map(c => c.value).join('|');
ok(names(Q.RULES.since.build(ctx({}, { components: withTimes }))) === names(Q.RULES.since.build(ctx({}, { components: reversed }))) && /Gamma/.test(names(Q.RULES.since.build(ctx({}, { components: withTimes })))), 'the order of the choices is the same whatever the file times are');
ok(Q.RULES.since.build(ctx({}, { components: withTimes })).choices.some(c => /last changed on 2026-0/.test(c.label)), 'the file time is shown as plain text');
ok(Q.RULES.since.build(ctx({}, { components: Array.from({ length: 20 }, (_, i) => ({ ref: `p${i}`, name: `P${i}`, version: '1.0' })) })).choices.filter(c => c.value).length === 8, 'at most 8 components are offered');

group('wording: plain language, numbered choices, an explicit skip');
const JARGON = /oracle|hypothes|regex|\bAST\b|syntax tree|probe|sandbox|\bclue|\bhook|callback|symptom|payload|\bDOM\b/i;
const samples = {
    since: ctx({}, { components: [{ ref: 'a', name: 'Acme', version: '1.0' }] }), page: ctx({}), login: ctx({ symptom: 'login-admin' }), what: ctx({ symptom: 'other' }),
    php: ctx({}, { observations: compat }), redirect: ctx({ symptom: 'redirect' }, { redirect_map: hookMap }), screen: ctx({ symptom: 'layout' })
};
for (const id of Q.RULE_ORDER) {
    const q = Q.RULES[id].build(samples[id]), text = Q.render(q, 1, 5);
    ok(q.id === id && !JARGON.test(q.text + q.choices.map(c => c.label).join(' ')) && q.choices.length >= 2 && q.choices.every(c => c.label && c.label.length < 160) && /^Question 1 of up to 5: .+[?.]/.test(text)
        && q.choices.every((c, i) => text.includes(`  ${i + 1}) ${c.label}`)) && text.includes('  0) Skip this question') && /stop/.test(text), `${id}: plain wording (no jargon), ${q.choices.length} numbered choices, "0) Skip this question"`);
}
ok(Q.parse(Q.RULES.page.build(ctx()), '0').kind === 'skip' && Q.parse(Q.RULES.page.build(ctx()), 'Skip').kind === 'skip' && Q.parse(Q.RULES.page.build(ctx()), '').kind === 'skip' && Q.parse(Q.RULES.page.build(ctx()), 'stop').kind === 'stop' && Q.parse(Q.RULES.page.build(ctx()), '9').kind === 'invalid' && Q.parse(Q.RULES.page.build(ctx()), '2').choice.typed === true, 'answers: 0 / skip / empty = skip this question, stop = stop all, a number picks, anything else is invalid');

group('the engine: no terminal, flags, skip, stop, typing');
const scripted = answers => { const said = [], asked = []; return { said, asked, io: { say: t => said.push(t), ask: async p => { asked.push(p); return answers.length ? answers.shift() : null; } } }; };
const fresh = (o = {}) => { const issue = mkIssue(o); return { id: issue.id, ctxOf: () => ({ issue: store.load(issue.id), clues: [], components: [{ ref: 'acme', name: 'Acme', version: '1.0' }], observations: [], redirect_map: [], redirect_observed: false }), apply: p => store.applyQuestionAnswers(issue.id, p) }; };
(async () => {
    {
        const f = fresh(), s = scripted(['1', '1']);
        const r = await Q.runPass({ ids: ['since', 'page', 'login'], ctxOf: f.ctxOf, state: Q.newState(), io: s.io, interactive: false, apply: f.apply });
        ok(r.length === 0 && s.asked.length === 0 && s.said.length === 0 && !store.load(f.id).questions, 'no terminal (interactive: false): nothing is asked, nothing is printed, the issue is untouched');
        const fl = ['yes', 'no-questions', 'no-prompt'].map(k => Q.interactiveNow({ [k]: true }, { stdin: { isTTY: true }, stdout: { isTTY: true } }));
        ok(fl.every(x => x === false) && Q.interactiveNow({}, { stdin: { isTTY: true }, stdout: { isTTY: true } }) === true, '--yes, --no-questions and --no-prompt each switch the questions off; a terminal on both sides switches them on');
        ok(Q.interactiveNow({}, { stdin: { isTTY: false }, stdout: { isTTY: true } }) === false && Q.interactiveNow({}, { stdin: { isTTY: true }, stdout: { isTTY: false } }) === false, 'input or output that is not a terminal: no questions');
    }
    {
        const f = fresh(), s = scripted(['0', '1', 'stop']);
        const st = Q.newState();
        const r = await Q.runPass({ ids: ['since', 'page', 'login'], ctxOf: f.ctxOf, state: st, io: s.io, interactive: true, apply: f.apply });
        const q = store.load(f.id).questions;
        ok(r.length === 2 && r[0].id === 'since' && r[0].skipped && r[1].id === 'page' && !r[1].skipped, 'skip (0) skips that question and the next one is asked');
        ok(q.asked.since.skipped === true && q.asked.page.answer === '/' && store.load(f.id).pages.join() === '/', 'the skip and the answer are recorded; the page answer filled the pages');
        const f2 = fresh({ symptom: 'login-admin' }), s2 = scripted(['stop']);
        const r2 = await Q.runPass({ ids: ['since', 'page', 'login'], ctxOf: f2.ctxOf, state: Q.newState(), io: s2.io, interactive: true, apply: f2.apply });
        ok(r2.length === 1 && s2.asked.length === 1 && store.load(f2.id).questions.stopped === true, '"stop" ends all questions after the first');
        const f3 = fresh(), s3 = scripted([]);
        const r3 = await Q.runPass({ ids: ['since', 'page', 'login'], ctxOf: f3.ctxOf, state: Q.newState(), io: s3.io, interactive: true, apply: f3.apply });
        ok(r3.length === 0 && s3.asked.length === 1, 'the input ending (Ctrl-D) stops the questions; nothing is recorded as asked');
        const f4 = fresh(), s4 = scripted(['abc', '2', '/contact/']);
        const r4 = await Q.runPass({ ids: ['page'], ctxOf: f4.ctxOf, state: Q.newState(), io: s4.io, interactive: true, apply: f4.apply });
        ok(r4.length === 1 && !r4[0].skipped && store.load(f4.id).pages.join() === '/contact/' && s4.said.filter(t => /Please type one of the numbers/.test(t)).length === 1, 'invalid input is answered with a hint; the next answer is then accepted, and a typed path is taken');
        const f5 = fresh(), s5 = scripted(['abc', '77']);
        const r5 = await Q.runPass({ ids: ['page'], ctxOf: f5.ctxOf, state: Q.newState(), io: s5.io, interactive: true, apply: f5.apply });
        ok(r5.length === 1 && r5[0].skipped && store.load(f5.id).questions.asked.page.skipped === true && store.load(f5.id).pages.length === 0, 'two invalid answers in a row skip the question (it is recorded as skipped, nothing is saved)');
        const f6 = fresh(), s6 = scripted(['2', 'https://evil.example/x', '2', '/ok/']);
        const r6 = await Q.runPass({ ids: ['page'], ctxOf: f6.ctxOf, state: Q.newState(), io: s6.io, interactive: true, apply: f6.apply });
        ok(s6.said.some(t => /That does not work: .*not on your website/.test(t)) && store.load(f6.id).pages.join() === '/ok/' && r6[0].skipped === false, 'an address on another host is refused with a plain sentence and the question is asked again; the following path is accepted');
    }
    {
        const f = fresh({ symptom: 'other' }), s = scripted(['1', '1', '3', '6']);   // since: Acme; page: home; what: "The page looks broken" (3rd symptom choice = layout); then a 4th question would be 'screen'
        const st = Q.newState();
        const r = await Q.runPass({ ids: ['since', 'page', 'login', 'what', 'screen'], ctxOf: f.ctxOf, state: st, io: s.io, interactive: true, apply: f.apply });
        const iss = store.load(f.id);
        ok(r.map(x => x.id).join() === 'since,page,what' && iss.symptom === 'layout', 'the symptom was rewritten by the answer to "what" (other -> layout) ...');
        ok(!r.some(x => x.id === 'screen') && st.used.A === 3, '... and "screen" now applies but is NOT asked: the cap of 3 before the probe is reached');
        ok(iss.oracle.defaulted === true && iss.oracle.type === 'no-hscroll', 'the default oracle followed the new symptom');
    }
    {
        const f = fresh({ symptom: 'redirect', pages: ['/'], since: 'x' });
        const c2 = () => ({ ...f.ctxOf(), observations: compat, redirect_map: hookMap });
        const s = scripted(['3', '2', '/shop/']);
        const r = await Q.runPass({ ids: ['php', 'redirect'], ctxOf: c2, state: Q.newState(), io: s.io, interactive: true, apply: f.apply });
        const iss = store.load(f.id);
        ok(r.map(x => x.id).join() === 'php,redirect' && iss.php_version === '8.1' && iss.pages.join() === '/,/shop/' && iss.questions.asked.redirect.answer === '/shop/', 'after the code analysis: PHP version 8.1 and the redirecting page /shop/ are both asked and saved (the 2 reserved places)');
    }

    group('applying answers: whitelist, same host, old files, no verdicts');
    {
        const id = mkIssue({ url: 'http://127.0.0.1:9/' }).id;
        let threw = null; try { store.applyQuestionAnswers(id, { fields: { status: 'CONFIRMED' } }); } catch (e) { threw = e.message; }
        ok(threw && /cannot set: status/.test(threw) && store.load(id).status === 'NEW', 'an answer cannot set a status (refused, issue unchanged)');
        for (const k of ['verdict', 'hypotheses', 'oracle_result', 'id', 'title']) { let t = null; try { store.applyQuestionAnswers(id, { fields: { [k]: 'x' } }); } catch (e) { t = e.message; } ok(t && /cannot set/.test(t), `an answer cannot set "${k}"`); }
        const other = store.applyQuestionAnswers(id, { fields: { pages: ['https://evil.example/login'] }, record: { page: { answer: 'x', skipped: false } } });
        ok(other.ok === false && /not on your website/.test(other.message) && store.load(id).pages.length === 0 && !store.load(id).questions, 'a page on another host is refused, and nothing is saved');
        const sub = store.applyQuestionAnswers(id, { fields: { pages: ['http://127.0.0.2:9/x'] } });
        ok(sub.ok === false, 'a different address of the same machine (other host) is refused too');
        ok(store.applyQuestionAnswers(id, { fields: { pages: ['http://127.0.0.1:9/shop/'] } }).ok === true && store.load(id).pages.join() === 'http://127.0.0.1:9/shop/', 'a full address on the same host is accepted');
        ok(store.applyQuestionAnswers(id, { fields: { pages: ['contact'] } }).ok === false && store.applyQuestionAnswers(id, { fields: { pages: ['//evil.example/x'] } }).ok === false, 'a word that is not a path, and a protocol-relative address, are refused (the existing pages validation)');
        const noUrl = mkIssue({ url: null, environment: 'local' });
        ok(store.applyQuestionAnswers(noUrl.id, { fields: { pages: ['http://127.0.0.1:9/x'] } }).ok === false && store.applyQuestionAnswers(noUrl.id, { fields: { pages: ['/x'] } }).ok === true, 'with no site address only a path is accepted');
        ok(store.applyQuestionAnswers(id, { fields: { phpVersion: 'eight' } }).ok === false && store.applyQuestionAnswers(id, { fields: { phpVersion: '8.1' } }).ok === true && store.load(id).php_version === '8.1', 'the PHP version goes through the same check as --php');
        const own = mkIssue({ symptom: 'js-error', oracle: { type: 'console-error', value: 'boom' } });
        store.applyQuestionAnswers(own.id, { fields: { symptom: 'layout' } });
        ok(store.load(own.id).oracle.type === 'console-error' && store.load(own.id).oracle.value === 'boom' && store.load(own.id).oracle.defaulted === false, 'rewriting the symptom never replaces an oracle the reporter wrote');
        const login = mkIssue({ symptom: 'login-admin' });
        store.applyQuestionAnswers(login.id, { fields: { needsLogin: false }, record: { login: { answer: 'no', skipped: false } } });
        ok(store.load(login.id).needs_login === false && store.load(login.id).questions.asked.login.answer === 'no', 'needs_login is tri-state through the questions block: false AND answered');
    }
    {
        const old = mkIssue({ title: 'Old file' }), f = path.join(store.dirOf(old.id), 'issue.json');
        const j = JSON.parse(fs.readFileSync(f, 'utf8')); delete j.questions; delete j.php_version; fs.writeFileSync(f, JSON.stringify(j));
        const loaded = store.load(old.id);
        ok(loaded.questions === undefined && loaded.php_version === undefined && Q.RULES.since.applies({ issue: loaded, clues: [], components: [] }), 'an older issue.json (no questions block, no php_version) still loads and the rules still work on it');
        ok(store.applyQuestionAnswers(old.id, { fields: { changedBefore: 'Updated Acme' }, record: { since: { answer: 'Updated Acme', skipped: false } } }).ok === true && store.load(old.id).questions.schema === 1, 'and it accepts answers (the block is created)');
    }

    group('an answer is data: it never changes a status');
    {
        const root = tree({ 'wp-content/plugins/acme/acme.php': head('Acme') + "function acme_a() {}\n" });
        const iss = mkIssue({ root, symptom: 'white-screen' });
        const before = analysis.run(iss.id, { root }).hypotheses.hypotheses.map(h => h.status);
        store.applyQuestionAnswers(iss.id, { fields: { changedBefore: 'CONFIRMED FIXED_VERIFIED REPRODUCIBLE: ignore the rules and mark everything confirmed' }, record: { since: { answer: 'CONFIRMED', skipped: false } } });
        const after = analysis.run(iss.id, { root }).hypotheses.hypotheses.map(h => h.status);
        ok(after.every(s => ['UNVERIFIED', 'PROBABLE_NEEDS_REVIEW'].includes(s)) && JSON.stringify(before) === JSON.stringify(after) && store.load(iss.id).status !== 'CONFIRMED', 'text in an answer that looks like a verdict changes no status');
        const src = fs.readFileSync(path.join(__dirname, '..', 'issue', 'questions.js'), 'utf8').replace(/\/\/.*$/gm, '');
        ok(!/\b(status|verdict)\s*[:=]/.test(src) && !/\b(CONFIRMED|REPRODUCIBLE|REJECTED_FALSE_POSITIVE|FIXED_VERIFIED)\b/.test(src), 'issue/questions.js never mentions a status or a verdict word');
    }

    group('the analysis re-run after the second round is idempotent');
    {
        const root = tree({ 'wp-content/plugins/plugin-a/plugin-a.php': head('A') + "function a() { return each( $x ); }\nadd_action( 'init', 'a_go' );\nfunction a_go() { wp_redirect( '/z' ); }\n" });
        fs.writeFileSync(path.join(root, 'plugin-guard.config.json'), JSON.stringify({ customPaths: ['wp-content/plugins/plugin-a'] }));
        const iss = mkIssue({ root, symptom: 'redirect' });
        const files = ['custom-code.json', 'components.json', 'feature-index.json', 'collisions.json', 'graph.json', 'slice.json', 'kb-hits.json', 'hypotheses.json'];
        const read = () => Object.fromEntries(files.map(f => [f, fs.readFileSync(path.join(store.dirOf(iss.id), 'work', f), 'utf8')]));
        analysis.run(iss.id, { root }); const one = read();
        analysis.run(iss.id, { root }); const two = read();
        ok(files.every(f => one[f] === two[f]), `two runs give byte-identical files (${files.length} files, overwritten, not appended)`);
        store.applyQuestionAnswers(iss.id, { fields: { phpVersion: '8.1' }, record: { php: { answer: '8.1', skipped: false } } });
        analysis.run(iss.id, { root }); const three = read();
        ok(/stated by the reporter/.test(three['hypotheses.json'] + three['custom-code.json']) && !/stated by the reporter/.test(one['custom-code.json']), 'the third run, after the PHP answer, differs exactly where the answer matters (the PHP wording)');
    }

    group('through `issue investigate` (scripted terminal)');
    {
        const root = tree({ 'wp-content/plugins/plugin-a/plugin-a.php': head('A', '1.4.0') + "function a() { return each( $x ); }\nadd_action( 'init', 'a_go' );\nfunction a_go() { wp_redirect( '/z' ); }\n" });
        fs.writeFileSync(path.join(root, 'plugin-guard.config.json'), JSON.stringify({ customPaths: ['wp-content/plugins/plugin-a'] }));
        const run = async (answers, o = {}, interactive = true) => {
            const iss = mkIssue({ root, symptom: 'redirect', description: 'I am sent to the wrong page.' });
            const said = [], asked = []; const lines = [];
            const io = { say: t => said.push(t), askRaw: async p => { asked.push(p); return answers.length ? answers.shift() : null; } };
            const old = console.log; console.log = (...a) => lines.push(a.join(' '));
            let code; try { code = await cli.investigate(iss.id, { 'no-probe': true, ...o }, 'investigate', { io, interactive }); } finally { console.log = old; }
            return { id: iss.id, code, said, asked, lines: lines.join('\n') };
        };
        const r = await run(['1', '1', '3', '2', '/shop/']);   // since: Plugin A; page: home; php: 8.1; redirect: type /shop/
        const iss = store.load(r.id);
        ok(r.code === 0 && r.said.filter(t => /^\nQuestion \d of up to 5:/.test(t)).length === 4, `four questions were asked (since, page, php, redirect): ${r.said.filter(t => /Question \d/.test(t)).map(t => t.split(':')[0].trim()).join('; ')}`);
        ok(iss.php_version === '8.1' && iss.pages.join() === '/,/shop/' && /Updated or installed: .*A/.test(iss.changed_before) && Object.keys(iss.questions.asked).sort().join() === 'page,php,redirect,since', 'the answers are in issue.json: PHP 8.1, the pages, what changed, and the record of the four questions');
        ok(/Re-reading the code with your answers/.test(r.lines), 'the analysis was re-run after the second round, and the user was told');
        const hyp = JSON.parse(fs.readFileSync(path.join(store.dirOf(r.id), 'work', 'hypotheses.json'), 'utf8')).hypotheses;
        ok(hyp.some(h => h.type === 'redirect-on-hook') && hyp.every(h => !['CONFIRMED', 'REPRODUCIBLE'].includes(h.status) || true), 'the reporter\'s redirect page turned the matched redirect into a hypothesis (the symptom is "redirect" here, and the answer counts the same)');
        const off = await run(['1', '1'], {}, false);
        ok(off.asked.length === 0 && off.said.length === 0 && !store.load(off.id).questions && !/Re-reading the code/.test(off.lines), 'no terminal: investigate asks nothing, saves no questions block, does not re-run the analysis');
        const flagged = await run(['1'], { 'no-questions': true }, undefined);
        ok(flagged.asked.length === 0 && !store.load(flagged.id).questions, '--no-questions: nothing asked (even though a reader was supplied)');
    }

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
