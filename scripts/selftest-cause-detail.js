#!/usr/bin/env node
// REPORT-SPEC Part 2: the cause detail under FOR A DEVELOPER (issue/cause-detail.js) and the owner-approved changes that come with it:
//   A  symbol and file:line, a capped and redacted excerpt read from the copy, the call chain ONLY when the log has a stack trace, other files of the same theme or plugin
//      using the symbol, classes with a similar name "found in your installed <plugin>" (never a fix, nothing guessed), what the tool cannot know
//   B  the old "We looked at N things" sentence is gone (page, Markdown, command line); only the dot line stays
//   C  a crash with no likely and no confirmed cause: "No likely cause was found for the crash." and the advisory case carries no Case number
//   D  "PHP 8.2 (you told us)" in Looked at; "PHP: not stated." otherwise (the host's PHP is never claimed)
//   E  no internal file name (.json) in "Why this status", the Limits or any reader text
//   F  "How sure": "Not reproduced on a test copy of your site." when not confirmed; a confirmed case says what was checked; the Limits sentence follows what ran
//   G  the oracle root cause: a crash keeps its default oracle (questions.proposeOracle), so its stored answer recomputes identically and Rule A can confirm the ews fatal
// Every case uses the exact ews log line:
//   PHP Fatal error:  Uncaught Error: Class "Elementor\Core\Schemes\Color" not found in .../themes/unicamp/elementor/widgets/original/heading.php:48
// Offline. Fixtures only. validate.js is not changed (the cases below run through it unchanged).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-causedetail-'));
process.env.PLUGIN_GUARD_ISSUES = path.join(tmp, 'issues');
const store = require('../lib/issue-store');
const evidence = require('../issue/evidence'), analysis = require('../issue/analysis'), validate = require('../issue/validate'), resolve = require('../issue/resolve'), result = require('../issue/result');
const oracle = require('../issue/oracle'), Q = require('../issue/questions'), caseFile = require('../issue/case-file'), causeDetail = require('../issue/cause-detail');
const plain = require('../lib/plain-names');
const cli = require('../lib/issue-cli');

let failures = 0, skipped = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const group = t => console.log(`\n== ${t}`);
const w = (root, rel, body = '<?php\n') => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); };
const CLASS = 'Elementor\\Core\\Schemes\\Color';
const FILE = 'wp-content/themes/unicamp/elementor/widgets/original/heading.php';
const EWS = 'http://localhost82.local.com/ews/';
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const stamp = d => `${String(d.getUTCDate()).padStart(2, '0')}-${MON[d.getUTCMonth()]}-${d.getUTCFullYear()} ${d.toISOString().slice(11, 19)}`;
const SECRET = 'sk_live_ABCDEFGHIJKLMNOPQRSTUV12';

// o: log ('ews' | 'none' | 'trace'), templates, others (files of the theme that also use the class), similar (Elementor defines a class with a similar name), secret, fence
function build(root, o = {}) {
    w(root, 'wp-includes/version.php', "<?php\n$wp_version = '6.8.1';\n"); w(root, 'wp-config.php', '<?php\n');
    w(root, 'wp-content/plugins/elementor/elementor.php', '<?php\n/**\n * Plugin Name: Elementor\n * Version: 3.35.7\n */\nnamespace Elementor;\nclass Plugin {}\n');
    if (o.similar) w(root, 'wp-content/plugins/elementor/core/kits/documents/tabs/global-colors.php', '<?php\nnamespace Elementor\\Core\\Kits\\Documents\\Tabs;\nclass Global_Colors {}\n');
    w(root, 'wp-content/themes/unicamp/style.css', '/*\nTheme Name: Unicamp\nVersion: 2.2.0\n*/');
    const filler = Array.from({ length: 46 }, (_, i) => (o.secret && i === 44 ? `$api_key = '${SECRET}';` : o.fence && i === 45 ? '// ``` not a fence </pre><script>x</script>' : '// filler'));
    w(root, FILE, '<?php\n' + filler.join('\n') + '\n' + `$c = \\${CLASS}::get_type();\n` + '// after 1\n// after 2\n');
    for (let i = 1; i <= (o.others || 0); i++) w(root, `wp-content/themes/unicamp/elementor/widgets/w${i}.php`, `<?php\nuse ${CLASS};\n$x = Color::get_type();\n`);
    w(root, 'wp-content/themes/unicamp/functions.php', '<?php\n// no use of the class here\n');
    w(root, 'wp-content/plugins/woocommerce/woocommerce.php', '<?php\n/**\n * Plugin Name: WooCommerce\n * Version: 10.6.1\n */\n');
    for (let i = 1; i <= (o.templates === undefined ? 5 : o.templates); i++) { w(root, `wp-content/plugins/woocommerce/templates/t${i}/t${i}.php`, '<?php\n/**\n * @version 9.0.0\n */\n'); w(root, `wp-content/themes/unicamp/woocommerce/t${i}/t${i}.php`, '<?php\n/**\n * @version 3.0.0\n */\n'); }
    if ((o.log || 'ews') === 'none') return;
    const at = stamp(new Date(Date.now() - 2 * 3600e3)), at2 = at.slice(0, -2) + String((Number(at.slice(-2)) + 1) % 60).padStart(2, '0');
    const trace = o.log === 'trace'
        ? `#0 ${root}/wp-content/plugins/elementor/includes/widgets-manager.php(123): Elementor\\Widgets_Manager->register(Object(Unicamp\\Heading))\n#1 ${root}/wp-includes/class-wp-hook.php(324): do_action('elementor/widgets/register', Object(Elementor\\Widgets_Manager))\n#2 {main}\n`
        : '#0 {main}\n';
    const one = t => `[${t} UTC] PHP Fatal error:  Uncaught Error: Class "${CLASS}" not found in ${root}/${FILE}:48\nStack trace:\n${trace}  thrown in ${root}/${FILE} on line 48\n`;
    w(root, 'wp-content/debug.log', one(at) + one(at2));
}
const fingerprint = root => {
    const h = crypto.createHash('sha256');
    const walk = d => { for (const n of fs.readdirSync(d).sort()) { const p = path.join(d, n), st = fs.lstatSync(p); h.update(path.relative(root, p) + ':' + st.size + ':'); if (st.isDirectory()) walk(p); else h.update(fs.readFileSync(p)); } };
    walk(root); return h.digest('hex');
};
const page = (status, url = EWS) => ({ console_errors: [], page_errors: [], error_responses: status >= 500 ? [{ url, status, type: 'document', same_site: true, source: { type: 'other', ref: null, name: 'localhost82.local.com' } }] : [], failed_requests: [], url, viewport: { name: 'laptop', width: 1280, height: 800 }, loaded: true, status, first_status: status, retried: false, outcome: status >= 500 ? 'server-error' : 'ok' });
// a probe as probe.js writes it: the oracle answer is the one oracle.evaluate gives for the issue's oracle; debug_log WITHOUT `available` (the real shape)
const probeWrite = (dir, pages, { storedOracle = null } = {}) => {
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'issue.json'), 'utf8')); j.probe_ran_at = new Date().toISOString(); if (storedOracle) j.oracle = storedOracle.spec; fs.writeFileSync(path.join(dir, 'issue.json'), JSON.stringify(j));
    const obs = { pages, planned: pages.length, protection: null, debug_log: { new_bytes: 0, lines: 0 } };
    const ans = storedOracle ? { ...storedOracle.spec, symptom: j.symptom, result: storedOracle.result, reason: 'stored' } : oracle.evaluate(j.oracle, obs, { needsLogin: j.needs_login, symptom: j.symptom });
    fs.writeFileSync(path.join(dir, 'work', 'probe.json'), JSON.stringify({ schema: 1, planned: { pages: [EWS], viewports: ['laptop 1280x800'], loads: pages.length, notes: [] }, protection: null, pages, oracle: ans, debug_log: obs.debug_log }));
    return ans;
};
// o: build options plus symptom, php, answerWhat (the follow-up answer "white screen", applied through the question engine), probe (status of the page), stored (old debug-log oracle), sandbox
async function run(name, o = {}) {
    const root = path.join(tmp, name, 'wp'); build(root, o);
    const config = path.join(path.dirname(root), 'plugin-guard.config.json'); fs.writeFileSync(config, '{}');
    const before = fingerprint(root);
    const issue = store.create({ title: 'Critical error', description: 'The site shows a critical error', symptom: o.symptom || 'other', environment: 'local', url: EWS, root, pages: [], ...(o.php ? { phpVersion: o.php } : {}) });
    await evidence.run(issue.id, { root, probeOptions: { probe: false } });
    const dir = store.dirOf(issue.id);
    let patch = null;
    if (o.answerWhat) {
        const ev = JSON.parse(fs.readFileSync(path.join(dir, 'work', 'evidence.json'), 'utf8'));
        patch = Q.toPatch({ id: 'what' }, { value: 'white-screen' }, null, { issue: store.load(issue.id), clues: ev.clues || [] });
        const ap = store.applyQuestionAnswers(issue.id, { fields: patch.fields, record: { what: patch.rec } });
        if (!ap.ok) throw new Error(ap.message);
    }
    let stored = null;
    if (o.probe) stored = probeWrite(dir, [page(o.probe)], o.stored ? { storedOracle: o.stored } : {});
    if (o.sandbox) fs.writeFileSync(path.join(dir, 'work', 'sandbox.json'), JSON.stringify({ reproduced_in_sandbox: o.sandbox, steps: [{ id: 'sandbox', label: 'Sandbox (throwaway copy in Docker)', status: 'PASSED', reason: 'ran' }] }));
    if (o.sandboxFailed) fs.writeFileSync(path.join(dir, 'work', 'sandbox.json'), JSON.stringify({ reproduced_in_sandbox: null, could_not_run: 'the plugins could not be switched on in it', steps: [{ id: 'sandbox', label: 'Sandbox (throwaway copy in Docker)', status: 'FAILED', reason: 'the plugins could not be switched on in it' }] }));
    analysis.run(issue.id, { root, config });
    const val = validate.run(issue.id, { root, config, lint: () => ({ ok: true, message: '' }) });
    const policy = validate.policyFor(root, config), plans = resolve.build(issue.id, val, { root, policy, dir });
    const res = result.write(issue.id, { validation: val, plans, dir, root, policy, gate: true, verbose: !!o.verbose });
    const R = n => fs.readFileSync(path.join(dir, 'result', n), 'utf8');
    const out = []; cli.printGate(res, plans, { gate: true, verbose: !!o.verbose }, t => out.push(t), dir);
    return { id: issue.id, dir, root, res, plans, val, patch, stored, issue: store.load(issue.id), same: before === fingerprint(root), f: JSON.parse(R('findings.json')), md: R('ISSUE-REPORT.md'), html: R('issue.html'), cli: out.join('\n'), h: val.hypotheses.find(x => x.type === 'missing-function') };
}
const section = (md, h) => { const i = md.indexOf(`\n## ${h}`); if (i < 0) return ''; const j = md.indexOf('\n## ', i + 4); return md.slice(i, j < 0 ? undefined : j); };
const row = (c, k) => ((c.rows.find(x => x[0] === k) || [0, []])[1]);
// internal words that never reach a reader (whole terms), plus internal file names
const INTERNAL = [/\b(theme|mu|plugin):[a-z0-9._-]+/i, /PROBABLE[ _]NEEDS[ _]REVIEW/i, /\boracle\b/i, /\brecomput\w*/i, /\bNOT_RUN\b/, /\bgate\b/i, /\bnull\b/, /\bundefined\b/, /\bcp-\d+/, /\.json\b/];
const OLD_SENTENCE = /We looked at \d+ things/;
const COUNTS = /\d+ pass · \d+ fail · \d+ not checked · \d+ also noticed/g;

(async () => {
    group('G. the oracle root cause: a crash keeps its default oracle');
    ok(Q.proposeOracle('white-screen', [{ type: 'php-fatal' }]) === null && Q.proposeOracle('white-screen', [{ type: 'php-redeclare' }]) === null && Q.proposeOracle('white-screen', [{ type: 'php-undefined-function' }]) === null && Q.proposeOracle('white-screen', [{ type: 'php-class-not-found' }]) === null, 'white screen + any PHP fatal clue: no oracle is proposed (the default stays)');
    ok(Q.proposeOracle('js-error', [{ type: 'js-not-defined', detail: { symbol: 'jQuery.fn.slick' } }]).type === 'console-error' && Q.proposeOracle('layout', [{ type: 'php-fatal' }]) === null, 'a JavaScript symbol is still proposed; layout still gets none');
    const pg5 = [page(500)], obs5 = { pages: pg5, planned: 1, protection: null, debug_log: { new_bytes: 0, lines: 0 } };
    for (const spec of [{ type: 'generic', value: null, defaulted: true }, { type: 'http-5xx', value: null, defaulted: true }]) {
        const a = oracle.evaluate(spec, obs5, { symptom: 'white-screen' }), b = oracle.evaluate(spec, JSON.parse(JSON.stringify(obs5)), { symptom: 'white-screen' });
        ok(a.result === 'yes' && b.result === a.result, `${spec.type} on a 5xx page with a log that cannot be read: "yes", and the same answer again from the stored observations`);
    }
    const dbg = oracle.evaluate({ type: 'debug-log', value: 'Fatal error' }, obs5, { symptom: 'white-screen' });
    ok(dbg.result === 'could-not-test', `the old debug-log oracle on the same stored observations: "${dbg.result}" (this is what disagreed with its stored "yes")`);

    // (1) through validate.js: the stored answer of the default oracle and its re-check agree
    const gen = await run('generic', { symptom: 'white-screen', probe: 500 });
    ok(gen.issue.oracle.type === 'http-5xx' && gen.val.oracle.stored === 'yes' && gen.val.oracle.recomputed === 'yes' && gen.val.oracle.agrees === true, `default oracle of a white screen (${gen.issue.oracle.type}): stored "${gen.val.oracle.stored}", re-checked "${gen.val.oracle.recomputed}", they agree`);
    const gen2 = await run('generic2', { symptom: 'other', probe: 500 });
    ok(gen2.issue.oracle.type === 'generic' && gen2.val.oracle.agrees === true && gen2.val.oracle.recomputed === 'yes', 'the generic oracle (symptom "other") on the 5xx page: stored and re-checked agree ("yes")');

    // (2) the ews case through the question engine: "1" (white screen) with the fatal in the log keeps the default oracle; Rule A confirms
    const ews = await run('ews', { answerWhat: true, probe: 500 });
    ok(ews.patch && ews.patch.fields.symptom === 'white-screen' && ews.patch.fields.oracle === undefined, 'the answer "white screen" sets the symptom and proposes no oracle, although the log has the fatal');
    ok(ews.issue.symptom === 'white-screen' && ews.issue.oracle.type === 'http-5xx' && ews.issue.oracle.defaulted === true, `the issue keeps the default oracle for a white screen (${ews.issue.oracle.type})`);
    ok(ews.val.oracle.agrees === true && ews.val.symptom_reproduced === 'yes', 'validate.js: the stored oracle answer and its re-check agree; the symptom is reproduced');
    ok(ews.h && ews.h.status === 'CONFIRMED' && ews.h.fatal_recheck && ews.h.fatal_recheck.rule === 'A', `the ews fatal is CONFIRMED by Rule A (status ${ews.h && ews.h.status}, rule ${ews.h && ews.h.fatal_recheck && ews.h.fatal_recheck.rule})`);
    ok(!ews.val.hypotheses.some(h => (h.validation_notes || []).some(n => /stored oracle answer/.test(n))), 'no hypothesis carries the "stored oracle answer did not match" cap note');
    // the counterfactual: the old proposal (debug-log "Fatal error", stored "yes") on the same tree is capped by the disagreement; validate.js is the same file
    const old = await run('ews-old', { symptom: 'white-screen', probe: 500, stored: { spec: { type: 'debug-log', value: 'Fatal error', defaulted: false }, result: 'yes' } });
    ok(old.val.oracle.agrees === false && old.h.status === 'PROBABLE_NEEDS_REVIEW' && old.h.validation_notes.some(n => /stored oracle answer/.test(n)), 'control: with the old debug-log oracle the same fatal stays not confirmed (the disagreement cap), so the proposal was the root cause');

    // (3) never CONFIRMED
    const healthy = await run('healthy', { log: 'none', templates: 0, answerWhat: true, probe: 200 });
    ok(!healthy.val.hypotheses.some(h => ['CONFIRMED', 'REPRODUCIBLE'].includes(h.status)) && !healthy.f.findings.length, 'a healthy site (no fatal, the page answered 200): nothing is confirmed');
    const adv = await run('advisory', { log: 'none', templates: 5, symptom: 'white-screen', probe: 500 });
    ok(!adv.val.hypotheses.some(h => ['CONFIRMED', 'REPRODUCIBLE'].includes(h.status)) && !adv.f.findings.filter(x => x.label !== 'compromise').length, 'an advisory-only site (a template override only), even with a 5xx page: nothing is confirmed');
    const fine = await run('fine', { answerWhat: true, probe: 200 });
    ok(fine.h && fine.h.status !== 'CONFIRMED' && fine.h.status !== 'REPRODUCIBLE' && fine.val.symptom_reproduced === 'no', `the same log line but the live page answered 200: not confirmed (${fine.h && fine.h.status})`);

    group('A. the cause detail (confirmed ews case)');
    const cd = ews.f.cause_detail, cf = ews.f.case_file;
    ok(cd && cd.symbol.name === CLASS && cd.symbol.kind === 'class' && cd.location.file === FILE && cd.location.line === 48, 'findings.json cause_detail: the exact symbol and file:line');
    ok(cd.lines[0] === `Symbol: the class ${CLASS}, at ${FILE}:48.`, `the first developer line: ${cd.lines[0]}`);
    ok(cd.excerpt.available && cd.excerpt.from === 44 && cd.excerpt.to === 50 && cd.excerpt.lines.length <= 9 && cd.excerpt.lines.filter(l => l.cited).length === 1 && cd.excerpt.lines.find(l => l.cited).n === 48 && /Schemes\\Color::get_type/.test(cd.excerpt.lines.find(l => l.cited).text), `the excerpt: lines ${cd.excerpt.from}-${cd.excerpt.to} (at most 9), line 48 marked`);
    ok(!cd.stack.available && !cd.stack.frames.length && cd.lines.includes('Call chain: the log has no stack trace with function or file names for this error, so the calls that led to it are not known.'), 'the ews log has only "#0 {main}": the report says so and invents no call chain');
    ok(cd.same_symbol.searched && cd.same_symbol.count === 0 && cd.lines.some(l => /^Other files of the theme Unicamp that use the class .+: none \(\d+ PHP files read\)\.$/.test(l)), 'other files of the theme Unicamp that use the class: none (and how many files were read)');
    ok(cd.candidates.searched && !cd.candidates.found.length && cd.lines.includes(`No class with a similar name was found in your installed Elementor 3.35.7 (${cd.candidates.files_read} PHP ${cd.candidates.files_read === 1 ? 'file' : 'files'} read).`) && !/Global_Colors/.test(JSON.stringify(ews.f)), 'nothing similar in the installed Elementor: said so, and no guessed class name (no Global_Colors)');
    ok(cd.lines.some(l => /^Which version of Elementor still has Elementor\\Core\\Schemes\\Color cannot be known from your copy: only the installed version \(3\.35\.7\) was read/.test(l)), 'what the tool cannot know: which Elementor version still has the class');
    ok(cf.developer.slice(0, cd.lines.length).join('\n') === cd.lines.join('\n') && cf.developer.some(l => /^Versions: theme Unicamp 2\.2\.0/.test(l)), 'case_file.developer: the cause-detail lines, then the versions line');
    const c1 = cf.cases[0];
    const repeated = cf.developer.filter(l => /^(Error in your log|Where|What was checked|Last seen|The class|Live check|What to try|A second thing to check):/.test(l));
    ok(!repeated.length, `the developer block no longer repeats the Case 1 lines${repeated.length ? ': ' + repeated.join(' | ') : ''}`);
    ok(c1.n === 1 && c1.kind === 'confirmed' && c1.heading === caseFile.CONFIRMED, 'Case 1 is the confirmed cause');
    const dev = section(ews.md, 'For a developer');
    ok(dev.includes(cd.lines[0].replace(/\\/g, '\\')) && /```php\n[\s\S]*> 48 \| \$c = \\Elementor\\Core\\Schemes\\Color::get_type\(\);[\s\S]*```/.test(dev), 'Markdown: the developer lines and the excerpt as a code block, line 48 marked');
    ok(/\nFOR A DEVELOPER\n/.test(ews.cli) && ews.cli.includes(cd.lines[0]) && /> 48 \| \$c = /.test(ews.cli), 'command line: FOR A DEVELOPER with the same lines and the excerpt');
    ok(ews.html.includes("el('pre', { class: 'code' })") && ews.html.includes('CF.excerpt') && !/\.innerHTML\s*=|insertAdjacentHTML/.test(ews.html.replace(/<script type="application\/json"[\s\S]*?<\/script>/g, '')), 'page: the excerpt goes into a <pre> through textContent (no innerHTML)');

    group('A. stack trace, other files, a similar class, redaction, escaping');
    const tr = await run('trace', { log: 'trace', others: 3, similar: true, secret: true, fence: true, answerWhat: true, probe: 500 });
    const td = tr.f.cause_detail;
    ok(td.stack.available && td.stack.frames.length === 2 && td.stack.frames[0].file === 'wp-content/plugins/elementor/includes/widgets-manager.php' && td.stack.frames[0].line === 123 && /Widgets_Manager->register/.test(td.stack.frames[0].call), 'a log with a stack trace: the frames the log wrote, in order (file, line, call)');
    ok(td.lines.some(l => /^Call chain from your log, most recent call first: #0 Elementor\\Widgets_Manager->register\(.+\) \(wp-content\/plugins\/elementor\/includes\/widgets-manager\.php:123\); #1 do_action\('elementor\/widgets\/register'/.test(l)) && td.lines.includes('WordPress steps named in that call chain: elementor/widgets/register.'), 'the call chain and the WordPress step (hook) named in it');
    ok(td.same_symbol.count === 3 && td.same_symbol.examples.join() === ['wp-content/themes/unicamp/elementor/widgets/w1.php', 'wp-content/themes/unicamp/elementor/widgets/w2.php', 'wp-content/themes/unicamp/elementor/widgets/w3.php'].join() && td.lines.some(l => /^Other files of the theme Unicamp that use the class Elementor\\Core\\Schemes\\Color: 3 \(\d+ PHP files read\): /.test(l)), 'three other theme files use the class: counted, named in order, the cited file not counted');
    ok(td.candidates.found.length === 1 && td.candidates.found[0].name === 'Elementor\\Core\\Kits\\Documents\\Tabs\\Global_Colors' && td.candidates.found[0].verified === false && td.lines.some(l => l.startsWith('Classes with a similar name, found in your installed Elementor 3.35.7 (only a name match; not checked as a replacement and not a fix): Elementor\\Core\\Kits\\Documents\\Tabs\\Global_Colors')), 'a class that really is in the installed Elementor: "found in your installed Elementor 3.35.7", verified false, never called a fix');
    ok(!/\breplace(s|d)? it with\b|\bthe fix is\b|\bfixed by\b/i.test(td.lines.join('\n')), 'no wording presents the candidate as the fix');
    const ex = td.excerpt.lines.map(l => l.text).join('\n');
    ok(!ex.includes(SECRET) && /\[REDACTED\]/.test(ex), 'a key on a line near the cited line is masked in the excerpt');
    ok(!section(tr.md, 'For a developer').includes(SECRET) && !tr.cli.includes(SECRET) && !tr.html.includes(SECRET), 'and in the Markdown, the command line and the page data');
    const fence = section(tr.md, 'For a developer');
    ok((fence.match(/```/g) || []).length === 2 && fence.includes("// ''' not a fence"), 'a ``` in the code cannot close the Markdown code block');
    ok(tr.same, 'the site folder is byte-identical before and after (read-only)');

    group('B. the old "We looked at" sentence is gone; the dot line once');
    for (const [name, r] of [['ews', ews], ['trace', tr], ['advisory', adv]]) {
        const once = t => (t.match(COUNTS) || []).length === 1;
        ok(!OLD_SENTENCE.test(r.md + r.cli + JSON.stringify(r.f.case_file)) && once(r.md) && once(r.cli) && r.f.checkpoint_text.sentence === plain.countsLine(r.f.checkpoints.counts), `${name}: no "We looked at" sentence; the dot line exactly once in the Markdown and on the command line`);
    }

    group('C. a crash with no likely cause');
    const ac = adv.f.case_file;
    ok(ac.no_cause_note === caseFile.NO_CAUSE_NOTE && ac.no_cause_note === 'No likely cause was found for the crash.' && !ac.cases.some(c => c.n === 1 && c.kind === 'check'), 'the note "No likely cause was found for the crash."; Case 1 is not an advisory');
    ok(ac.cases.length >= 1 && ac.cases.every(c => c.kind !== 'check' || c.n === null) && ac.cases[0].heading === caseFile.CHECK, 'the advisory case is headed "Something else to check (probably not the crash)" and carries no number');
    ok(/\*\*No likely cause was found for the crash\.\*\*\n\n## Something else to check \(probably not the crash\)\n/.test(adv.md) && !/## Case \d+: Something else to check/.test(adv.md), 'Markdown: the sentence right above the advisory case, no "Case N" on it');
    ok(/\nNo likely cause was found for the crash\.\n\nSOMETHING ELSE TO CHECK \(PROBABLY NOT THE CRASH\)\n/.test(adv.cli) && !/CASE \d+  SOMETHING ELSE/.test(adv.cli), 'command line: the same');
    ok(ac.status.line === '0 likely cause · 1 thing to check · 0 confirmed. This does not mean the site is healthy.', `the status line is unchanged: ${ac.status.line}`);
    ok(ews.f.case_file.cases[0].n === 1 && !ews.f.case_file.no_cause_note, 'a crash WITH a cause keeps Case 1 and no note');
    const lk = await run('likely', { symptom: 'white-screen', probe: 500, stored: { spec: { type: 'debug-log', value: 'Fatal error', defaulted: false }, result: 'yes' } });
    ok(lk.f.case_file.cases[0].n === 1 && lk.f.case_file.cases[0].kind === 'likely' && lk.f.case_file.cases[1].n === 2 && !lk.f.case_file.no_cause_note && lk.md.includes('## Case 2: Something else to check (probably not the crash)'), 'a crash with a likely cause: Case 1 likely cause, Case 2 something else to check, as before');
    const lay = await run('layout', { log: 'none', templates: 5, symptom: 'layout' });
    ok(!lay.f.case_file.no_cause_note, 'not a crash (layout): no crash sentence');

    group('D. the PHP version in Looked at');
    const php = await run('php', { php: '8.2', answerWhat: true, probe: 500 });
    ok(/Looked at: [^.]*PHP 8\.2 \(you told us\)\./.test(php.f.case_file.status.looked) && !php.f.case_file.status.php && php.md.includes('PHP 8.2 (you told us)') && php.cli.includes('PHP 8.2 (you told us)'), `stated: ${php.f.case_file.status.looked}`);
    ok(ews.f.case_file.status.php === caseFile.PHP_NOT_STATED && ews.md.includes('PHP: not stated.') && ews.cli.includes('PHP: not stated.') && !/PHP \d/.test(ews.f.case_file.status.looked + ews.f.case_file.status.php), 'not stated: "PHP: not stated.", and no PHP version is claimed (not the sandbox image, not the host)');
    ok(!/process\.version|php -v|execSync|spawnSync/.test(fs.readFileSync(path.join(__dirname, '..', 'issue', 'case-file.js'), 'utf8')), 'case-file.js never asks this computer for its PHP');

    group('E. no internal file name in reader text');
    const hy = { checks: [{ id: 'support:log', status: 'PASSED', reason: 'the log clue is still in evidence.json' }, { id: 'support:probe', status: 'FAILED', reason: 'the probe clue cited by this hypothesis is not in evidence.json' }, { id: 'bisect', status: 'FAILED', reason: 'work/bisect.json does not hold a minimal cause matching this hypothesis, or the symptom was not reproduced in the sandbox' }, { id: 'x', status: 'PASSED', reason: 'see sandbox.json, intake.json and custom-code.json' }], validation_notes: ['read from work/probe.json'] };
    const rw = plain.readerWhy(hy);
    ok(rw.length === 5 && rw.every(l => !/\.json\b|\bwork\//.test(l)) && rw[0] === 'Passed: the log entry is still in the saved evidence', `readerWhy says the files in plain words: "${rw[0]}"`);
    ok(plain.readerValidationLines({ checks: hy.checks, hypotheses: [{ status: 'CONFIRMED', title: 't', validation_notes: hy.validation_notes }] }).every(l => !/\.json\b/.test(l)), 'the command-line validation lines too');
    for (const [name, r] of [['ews', ews], ['trace', tr], ['advisory', adv], ['old oracle', old]]) {
        const why = Object.values(r.f.reader_why || {}).flat();
        const limits = r.f.limits_text || [];
        ok(why.length > 0 || name === 'advisory' ? !why.some(l => /\.json\b/.test(l)) && !limits.some(l => /\.json\b/.test(l)) : false, `${name}: "Why this status" (${why.length} lines) and the Limits have no .json file name`);
        ok(!/\.json\b/.test(r.md) && !/\.json\b/.test(r.cli), `${name}: the gate Markdown and the command line name no .json file`);
        ok(r.f.hypotheses.some(h => (h.checks || []).some(c => /\.json/.test(c.reason))) || name === 'advisory', `${name}: findings.json keeps the internal check text`);
    }

    group('F. how sure, and the Limits');
    const rowsOf = r => row(r.f.case_file.cases[0], 'How sure');
    ok(rowsOf(ews)[0] === 'Confirmed by two independent checks. Not yet tested on a copy of your site.' && rowsOf(ews).slice(1).some(l => /^Found in your log 2 times/.test(l)), `confirmed, no test copy: "${rowsOf(ews)[0]}", then the evidence lines`);
    ok(!rowsOf(ews).includes(caseFile.NOT_CONFIRMED_SENTENCE), 'a confirmed case never says "Not reproduced on a test copy of your site."');
    ok(rowsOf(lk)[rowsOf(lk).length - 1] === caseFile.NOT_CONFIRMED_SENTENCE && caseFile.NOT_CONFIRMED_SENTENCE === 'Not reproduced on a test copy of your site.', 'not confirmed: "How sure" ends "Not reproduced on a test copy of your site."');
    const sbYes = await run('sandbox-yes', { answerWhat: true, probe: 500, sandbox: 'yes' });
    ok(sbYes.h.status === 'CONFIRMED' && rowsOf(sbYes)[0] === 'Confirmed by two independent checks. Reproduced on a test copy of your site.', `a test copy reproduced it: "${rowsOf(sbYes)[0]}"`);
    const FIRST = 'A cause is shown as confirmed only when at least two independent checks agree after re-checking the code. A test on a copy of your site is a stronger check; none was run this time. Neither proves that a change will fix the problem: only running this report again after changing a copy does.';
    ok(ews.f.limits_text[0] === FIRST && section(ews.md, 'Limits').includes(FIRST), 'Limits (no test copy): the exact owner sentence in the Markdown and in limits_text');
    ok(sbYes.f.limits_text[0] === FIRST.replace('none was run this time', 'one was run this time') && !sbYes.md.includes('none was run this time'), 'Limits (a test copy ran): "one was run this time"');
    ok(ews.f.limits[0] === result.LIMITS[0] && /CONFIRMED only when/.test(ews.f.limits[0]) && ews.f.limits_text.slice(1).join() === ews.f.limits.slice(1).join(), 'findings.json `limits` keeps its internal text; only the first reader sentence differs');
    ok(ews.html.includes('F.limits_text') && !section(ews.md, 'Limits').includes('FIXED_VERIFIED'), 'the page uses the reader text; the Markdown Limits no longer name FIXED_VERIFIED');
    const sbNo = await run('sandbox-no', { answerWhat: true, probe: 500, sandbox: 'no' });
    ok(sbNo.h.status === 'CONFIRMED' && rowsOf(sbNo)[0] === 'Confirmed by two independent checks. A test on a copy of your site did not reproduce it.', `confirmed, and a test copy ran without reproducing it: "${rowsOf(sbNo)[0]}"`);
    const confirmedCases = [ews, tr, sbYes, sbNo, php].flatMap(r => r.f.case_file.cases.filter(c => c.kind === 'confirmed'));
    ok(confirmedCases.length >= 5 && confirmedCases.every(c => !c.rows.some(([, v]) => v.some(t => t.includes(caseFile.NOT_CONFIRMED_SENTENCE)))) && rowsOf(lk).includes(caseFile.NOT_CONFIRMED_SENTENCE), `"${caseFile.NOT_CONFIRMED_SENTENCE}" appears in no confirmed case (${confirmedCases.length} checked), only in a not-confirmed one`);
    const sbFail = await run('sandbox-failed', { answerWhat: true, probe: 500, sandboxFailed: true });
    const L1 = 'A cause is shown as confirmed only when at least two independent checks agree after re-checking the code.', L3 = 'Neither proves that a change will fix the problem: only running this report again after changing a copy does.';
    const variants = [[ews, 'none was run this time'], [sbYes, 'one was run this time'], [sbNo, 'one was run this time'], [sbFail, 'one was started this time but could not run']];
    ok(variants.every(([r, mid]) => r.f.limits_text[0] === `${L1} A test on a copy of your site is a stronger check; ${mid}. ${L3}` && section(r.md, 'Limits').includes(r.f.limits_text[0])), 'Limits: the three middle-sentence variants (none run / one run / one started but could not run); the first and last sentences are exactly the owner\'s');
    const cs = caseFile.confirmedSentence;
    ok(cs(2, null) === 'Confirmed by two independent checks. Not yet tested on a copy of your site.' && cs(2, 'no') === 'Confirmed by two independent checks. A test on a copy of your site did not reproduce it.' && cs(3, 'yes') === 'Confirmed by three independent checks. Reproduced on a test copy of your site.', 'the confirmed sentence follows the data (no copy / not reproduced / reproduced)');

    group('reader-facing term scan (ids, review status, oracle, re-check words, NOT_RUN, gate, null, .json)');
    for (const [name, r] of [['ews', ews], ['trace', tr], ['advisory', adv], ['likely', lk], ['php', php]]) {
        const c = r.f.case_file;
        const text = [c.title, c.status.line, c.status.looked, c.status.php, c.no_cause_note, ...c.see, ...c.cases.flatMap(x => [x.heading, ...x.rows.flatMap(([k, v]) => [k, ...v])]), c.checked.line, c.checked.legend, ...(r.f.limits_text || [])].filter(Boolean).join('\n');
        const bad = INTERNAL.filter(re => re.test(text)).map(String);
        ok(!bad.length, `${name}: no internal word in the case file and the Limits${bad.length ? ' -> ' + bad.join(' ') : ''}`);
        const devText = (r.f.cause_detail ? r.f.cause_detail.lines : []).join('\n');
        const badDev = INTERNAL.filter(re => re.test(devText)).map(String);
        ok(!badDev.length, `${name}: the cause-detail sentences carry no internal word${badDev.length ? ' -> ' + badDev.join(' ') : ''}`);
    }

    group('the page (offline, textContent only)');
    let pw = null; try { pw = require('../lib/playwright').load(); } catch { /* not installed */ }
    const browser = pw && require('../lib/playwright').status().chromium ? await pw.chromium.launch() : null;
    if (!browser) { console.log("SKIP  plugin-guard's own browser is not installed: the rendered-page part did not run"); skipped++; }
    else {
        const open = async rr => {
            const ctx = await browser.newContext({ serviceWorkers: 'block' }), pg = await ctx.newPage(), errs = [], reqs = [];
            pg.on('pageerror', e => errs.push(e.message));
            await pg.route('**/*', rt => { reqs.push(rt.request().url()); return rt.request().url().startsWith('file://') ? rt.continue() : rt.abort(); });
            await pg.goto('file://' + path.join(rr.dir, 'result', 'issue.html'));
            const o = { ids: await pg.evaluate(() => [...document.querySelectorAll('#content > section')].map(s => s.id)), reqs, errs,
                sec: id => pg.evaluate(i => { const s = document.getElementById(i); return s ? s.textContent : null; }, id),
                devOpen: await pg.evaluate(() => { const d = document.querySelector('#developer details'); return d ? d.open : null; }),
                pre: await pg.evaluate(() => [...document.querySelectorAll('#developer pre.code span')].map(s => s.textContent)),
                scripts: await pg.evaluate(() => document.querySelectorAll('script:not([type="application/json"])').length), close: () => ctx.close() };
            return o;
        };
        const pe = await open(tr);
        ok(pe.devOpen === false && pe.pre.length === tr.f.case_file.excerpt.lines.length && pe.pre.some(t => /^> 48 \| /.test(t)) && pe.pre.some(t => t.includes('</pre><script>x</script>')), 'page: the developer block is collapsed; the excerpt lines are shown as text (a "<script>" in the code stays text)');
        ok(pe.scripts === 1 && pe.reqs.every(u => u.startsWith('file://')) && !pe.errs.length, 'page: no injected script ran, no request left the file, no script error');
        const dv = await pe.sec('developer'), chk = await pe.sec('checked'), lim = await pe.sec('limits');
        ok(dv.includes('found in your installed Elementor 3.35.7') && !OLD_SENTENCE.test(chk) && (chk.match(COUNTS) || []).length === 1 && lim.includes('A test on a copy of your site is a stronger check; none was run this time.'), 'page: the candidate wording, the dot line once and no old sentence, the reader Limits');
        ok(!/\.json\b/.test(await pe.sec('limits')) && !/\.json\b/.test(await pe.sec('resolution') || ''), 'page: no .json in the Limits or in "Why this status"');
        await pe.close();
        const pa = await open(adv);
        ok(pa.ids.includes('no-cause') && pa.ids.indexOf('no-cause') + 1 === pa.ids.indexOf('check-1') && !pa.ids.includes('case-1') && (await pa.sec('no-cause')).includes('No likely cause was found for the crash.') && /^Something else to check \(probably not the crash\)/.test(await pa.sec('check-1')), 'page: the sentence directly above the unnumbered advisory case; no Case 1');
        await pa.close();
        const pp = await open(php);
        ok((await pp.sec('status')).includes('PHP 8.2 (you told us)'), 'page: PHP 8.2 (you told us) in the status');
        await pp.close();
        await browser.close();
    }

    group('determinism, read-only, ownership');
    const again = await run('ews-again', { answerWhat: true, probe: 500 });
    const strip = o => JSON.stringify(o).replace(/iss-\d{8}-\d{6}-[0-9a-f]{6}/g, 'ID').replace(new RegExp(tmp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/[a-z0-9-]+/', 'g'), '/X/');
    ok(strip(again.f.cause_detail) === strip(ews.f.cause_detail) && strip(again.f.case_file) === strip(ews.f.case_file), 'the cause detail and the case file are the same on a second run');
    ok([ews, tr, adv, healthy, fine, php, sbYes].every(r => r.same), 'no site folder was written (fingerprint before and after)');
    const src = fs.readFileSync(path.join(__dirname, '..', 'issue', 'cause-detail.js'), 'utf8').replace(/\/\/.*$/gm, '');
    ok(!/writeFileSync|appendFileSync|mkdirSync|rmSync|unlinkSync|renameSync|require\(['"](https?|net|dns|child_process)['"]\)|fetch\(/.test(src) && !/status\s*=|CONFIRMED|REPRODUCIBLE|FIXED_VERIFIED/.test(src), 'cause-detail.js only reads: no write, no network, no process, no status');
    ok(!/case-file|cause-detail/.test(fs.readFileSync(path.join(__dirname, '..', 'issue', 'validate.js'), 'utf8')), 'validate.js does not know the report layout');
    ok(causeDetail.build(null) === null && causeDetail.build({ file: FILE }) === null, 'no re-checked fatal: no cause detail');

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(failures ? `\n${failures} FAILED` : `\nAll cause-detail checks passed${skipped ? ` (${skipped} part(s) skipped)` : ''}.`);
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
