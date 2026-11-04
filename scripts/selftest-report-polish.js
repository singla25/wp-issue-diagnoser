#!/usr/bin/env node
// Checkpoint step A2: the checkpoints in the GATE report (order, counts, list only with --verbose) and nine reader-facing fixes (a)-(i):
//   (a) empty Findings text   (b) Verdict cause pointer line   (c) no internal value in the Tested line   (d) the page names the advisory
//   (e) resolution agrees with "What to try"   (f) confidence as a sentence   (g) "Not tested"   (h) titles cut at a word   (i) a very large log
// Fixture: the ews case (log line heading.php:48, class Elementor\Core\Schemes\Color; Unicamp / Elementor / WooCommerce; construction copied from selftest-polish.js).
// Offline. Fixtures only.
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-rpolish-'));
process.env.PLUGIN_GUARD_ISSUES = path.join(tmp, 'issues');
const store = require('../lib/issue-store');
const evidence = require('../issue/evidence'), analysis = require('../issue/analysis'), validate = require('../issue/validate'), resolve = require('../issue/resolve'), result = require('../issue/result');
const plain = require('../lib/plain-names');
const cli = require('../lib/issue-cli');

let failures = 0, skipped = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const group = t => console.log(`\n== ${t}`);
const w = (root, rel, body = '<?php\n') => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); };
const CLASS = 'Elementor\\Core\\Schemes\\Color';
const FILE = 'wp-content/themes/unicamp/elementor/widgets/original/heading.php';
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const stamp = d => `${String(d.getUTCDate()).padStart(2, '0')}-${MON[d.getUTCMonth()]}-${d.getUTCFullYear()} ${d.toISOString().slice(11, 19)}`;

// log: 'ews' (the two fatal lines), 'none' (no log), 'big-noisy' (> 2 MB, nearly all warnings), 'big-mixed' (> 2 MB, half errors)
function build(root, log) {
    w(root, 'wp-includes/version.php', "<?php\n$wp_version = '6.8.1';\n"); w(root, 'wp-config.php', '<?php\n');
    w(root, 'wp-content/plugins/elementor/elementor.php', '<?php\n/**\n * Plugin Name: Elementor\n * Version: 3.35.7\n */\nnamespace Elementor;\nclass Plugin {}\n');
    w(root, 'wp-content/themes/unicamp/style.css', '/*\nTheme Name: Unicamp\nVersion: 2.2.0\n*/');
    w(root, FILE, '<?php\n' + '// filler\n'.repeat(46) + `$c = \\${CLASS}::get_type();\n`);
    w(root, 'wp-content/plugins/woocommerce/woocommerce.php', '<?php\n/**\n * Plugin Name: WooCommerce\n * Version: 10.6.1\n */\n');
    for (let i = 1; i <= 5; i++) { w(root, `wp-content/plugins/woocommerce/templates/t${i}/t${i}.php`, '<?php\n/**\n * @version 9.0.0\n */\n'); w(root, `wp-content/themes/unicamp/woocommerce/t${i}/t${i}.php`, '<?php\n/**\n * @version 3.0.0\n */\n'); }
    if (log === 'none') return;
    const at = stamp(new Date(Date.now() - 86400e3)), at2 = at.slice(0, -2) + String((Number(at.slice(-2)) + 1) % 60).padStart(2, '0');
    const one = t => `[${t} UTC] PHP Fatal error:  Uncaught Error: Class "${CLASS}" not found in ${root}/${FILE}:48\nStack trace:\n#0 {main}\n  thrown in ${root}/${FILE} on line 48\n`;
    let text = one(at) + one(at2);
    if (log === 'big-noisy' || log === 'big-mixed') {
        const warn = `[${at} UTC] PHP Warning:  Undefined variable $x in ${root}/wp-content/plugins/elementor/elementor.php on line 5\n`;
        const err = n => `[${at} UTC] PHP Fatal error:  Uncaught Error: Call to undefined function f${n}() in ${root}/wp-content/plugins/elementor/elementor.php:${n}\n`;
        let body = '';
        if (log === 'big-noisy') body = warn.repeat(Math.ceil(2.6 * 1024 * 1024 / warn.length));
        else { const parts = []; for (let i = 0; i < Math.ceil(2.6 * 1024 * 1024 / warn.length); i++) parts.push(i % 2 ? err(i % 7) : warn); body = parts.join(''); }
        text = body + text;
    }
    w(root, 'wp-content/debug.log', text);
}
const NOSANDBOX = { id: 'sandbox', label: 'Sandbox (throwaway copy in Docker)', status: 'NOT_RUN', reason: 'not requested: add --sandbox (needs Docker and a local copy of the site)' };
async function run(name, { verbose = false, complete = false, log = 'ews', title = 'Critical error', description = 'The site shows a critical error' } = {}) {
    const root = path.join(tmp, name, 'wp'); build(root, log);
    const config = path.join(root, 'plugin-guard.config.json'); fs.writeFileSync(config, '{}');
    const issue = store.create({ title, description, symptom: 'white-screen', environment: 'local', url: 'http://127.0.0.1:9/ews/', root, pages: [] });
    await evidence.run(issue.id, { root, probeOptions: { probe: false } });
    analysis.run(issue.id, { root, config });
    const dir = store.dirOf(issue.id);
    fs.writeFileSync(path.join(dir, 'work', 'intake.json'), JSON.stringify({ php_skipped: complete ? 0 : 1, php_skipped_examples: complete ? [] : ['wp-content/plugins/x/.github/a.php'], steps: [
        { id: 'original-public', label: 'Are the originals of the screenshots public?', status: 'NOT_RUN', reason: 'no screenshot came from inside the WordPress folder' },
        { id: 'image-diff', label: 'Screenshot comparison (expected vs actual)', status: 'NOT_RUN', reason: 'no image pair was given' }] }));
    fs.writeFileSync(path.join(dir, 'work', 'sandbox.json'), JSON.stringify({ reproduced_in_sandbox: null, steps: [NOSANDBOX] }));
    const val = validate.run(issue.id, { root, config, lint: () => ({ ok: true, message: '' }) });
    const policy = validate.policyFor(root, config), plans = resolve.build(issue.id, val, { root, policy, dir });
    const res = result.write(issue.id, { validation: val, plans, dir, root, policy, gate: true, verbose });
    const R = n => fs.readFileSync(path.join(dir, 'result', n), 'utf8');
    return { id: issue.id, dir, res, plans, f: JSON.parse(R('findings.json')), md: R('ISSUE-REPORT.md'), html: R('issue.html') };
}
const cliText = (r, verbose) => { const out = []; cli.printGate(r.res, r.plans, { gate: true, verbose }, t => out.push(t), r.dir); return out.join('\n'); };
const INTERNAL = /\bcp-\d+|\bnull\b|\bundefined\b|could-not-test|NOT_RUN|PASSED|FAILED|\bNaN\b/;
const COUNTS = /We looked at (\d+) things: (\d+) pass, (\d+) fail, (\d+) also noticed, (\d+) not checked\./;

(async () => {
    const r = await run('base');
    const rv = await run('verbose', { verbose: true });
    const box = r.f.what_is_wrong;

    group('1. the checkpoints: JSON, order, counts, the full list only with --verbose');
    const cp = r.f.checkpoints, cj = require('../issue/checkpoints');
    ok(cp && cp.items.length > 40 && cp.counts.total === cp.items.length && cp.counts.pass + cp.counts.fail + (cp.counts.also_noticed || 0) + cp.counts.not_checked === cp.counts.total, 'findings.json: checkpoints.counts and items (ids stay in the JSON)');
    ok(cp.items.every(i => /^cp-\d+$/.test(i.id) && i.title && ['PASS', 'FAIL', 'NOT CHECKED'].includes(i.result) && i.reason), 'every item has id, title, result and reason');
    ok(JSON.stringify(cp.counts) === JSON.stringify(cj.tally(cj.evaluate({ work: cj.loadWork(r.dir), validation: validate.run(r.id, { root: store.load(r.id).root, config: path.join(store.load(r.id).root, 'plugin-guard.config.json'), lint: () => ({ ok: true, message: '' }) }), ran: { probe: false, sandbox: false }, hasRoot: true }))), 'the counts are the ones evaluate() gives');
    const m = COUNTS.exec(r.f.summary.text_report);
    ok(m && Number(m[1]) === cp.counts.total && Number(m[2]) === cp.counts.pass && Number(m[3]) === cp.counts.fail && Number(m[4]) === (cp.counts.also_noticed || 0) && Number(m[5]) === cp.counts.not_checked, 'the Summary has the counts sentence "N pass, N fail, N also noticed, N not checked"');
    const rl = r.f.summary.report_lines;
    ok(rl.indexOf('What is wrong') >= 0 && rl.indexOf('What is wrong') < rl.findIndex(l => COUNTS.test(l)), 'Summary: What is wrong first, then the counts');
    ok(r.md.indexOf(box.lines[0]) > 0 && r.md.indexOf(box.lines[0]) < r.md.search(COUNTS), 'Markdown: What is wrong first, then the counts');
    const c1 = cliText(r, false);
    ok(c1.indexOf(box.lines[0]) >= 0 && c1.indexOf(box.lines[0]) < c1.search(COUNTS), 'command line: What is wrong first, then the counts');
    const titles = cp.items.map(i => i.title);
    ok(!titles.some(t => r.md.includes(t)) && !titles.some(t => c1.includes(t)) && !/## All checks/.test(r.md), 'without --verbose: no checkpoint title in the Markdown or on the command line');
    ok(/--verbose/.test(r.md) && /--verbose/.test(c1), 'Markdown and the command line may hint at --verbose');
    const mv = rv.md, cv = cliText(rv, true);
    ok(/## All checks/.test(mv) && titles.every(t => mv.includes(t)) && titles.every(t => cv.includes(t)), 'with --verbose: every checkpoint is listed in the Markdown and on the command line');
    const lines = rv.f.checkpoint_text.lines;
    ok(lines.length === cp.items.length && lines.every(l => /^(Pass: .+|Fail: .+: .+|Not checked: .+: .+)$/.test(l)), 'lines read "Pass: title (note)", "Fail: title: reason", "Not checked: title: reason"');
    ok(lines.every(l => !INTERNAL.test(l)) && !mv.split('## All checks')[1].match(/cp-\d+/) && !cv.match(/cp-\d+/), 'the list has no cp-NN id and no internal value');
    ok(rv.f.checkpoints.items.length === cp.items.length && JSON.stringify(rv.f.checkpoints.counts) === JSON.stringify(cp.counts), 'the JSON carries the same checkpoints with and without --verbose');
    ok(!r.f.checkpoint_text.lines.length, 'without --verbose the reader list is empty');

    let pw = null; try { pw = require('../lib/playwright').load(); } catch { /* not installed */ }
    const browser = pw && require('../lib/playwright').status().chromium ? await pw.chromium.launch() : null;
    if (!browser) { console.log("SKIP  plugin-guard's own browser is not installed: the rendered-page parts did not run"); skipped++; }
    const page = async rr => {
        const ctx = await browser.newContext({ serviceWorkers: 'block' }), pg = await ctx.newPage();
        await pg.route('**/*', rt => (rt.request().url().startsWith('file://') ? rt.continue() : rt.abort()));
        await pg.goto('file://' + path.join(rr.dir, 'result', 'issue.html'));
        const get = async id => pg.evaluate(i => { const s = document.getElementById(i); return s ? s.textContent.replace(/\n\s*\n+/g, '\n') : null; }, id);
        const o = { ids: await pg.evaluate(() => [...document.querySelectorAll('#content > section')].map(s => s.id)), body: await pg.evaluate(() => document.body.innerText), title: await pg.evaluate(() => document.title),
            h1: await pg.evaluate(() => document.getElementById('title').textContent), meta: await pg.evaluate(() => (document.querySelector('.verdict .meta') || { textContent: '' }).textContent),
            dd: async label => pg.evaluate(l => { const d = [...document.querySelectorAll('#verdict dt')].find(x => x.textContent === l); return d ? d.nextSibling.textContent : null; }, label),
            sec: get, openDetails: await pg.evaluate(() => [...document.querySelectorAll('#advisories details')].map(d => d.open)), close: () => ctx.close() };
        return o;
    };
    let pr = null, pv = null;
    if (browser) {
        pr = await page(r); pv = await page(rv);
        group('2. the page: order, counts, no "--verbose", the list only collapsed with --verbose');
        ok(pr.ids[0] === 'whatswrong' && pr.ids[1] === 'summary', 'the page: What is wrong, then the Summary');
        const sm = await pr.sec('summary');
        ok(COUNTS.test(sm), 'the Summary has the counts sentence');
        ok(!titles.some(t => pr.body.includes(t)) && !(await pr.sec('summary')).includes('All '), 'without --verbose: no checkpoint title anywhere on the page');
        ok(!/--verbose|run with|run again/i.test(pr.body) && !/--verbose/.test(await pr.sec('summary')), 'the page never says "run with --verbose"');
        ok(!/--verbose|run with|run again/i.test(pv.body), 'the page with --verbose does not say it either');
        const dv = await pv.sec('summary');
        ok(titles.every(t => dv.includes(t)) && /All \d+ checks/.test(dv), 'with --verbose: the whole list is in the Summary, in a collapsed section');
    }

    group('3. (a) the empty Findings text agrees with the What-is-wrong box');
    ok(r.f.findings.length === 0 && r.f.what_is_wrong && r.f.what_is_wrong.tier === 'likely', 'fixture: no finding, a most likely cause');
    ok(r.f.findings_empty_text === "No confirmed cause. See 'What is wrong' above.", "with a most likely cause: \"No confirmed cause. See 'What is wrong' above.\"");
    ok(r.md.includes("No confirmed cause. See 'What is wrong' above.") && !/Nothing passed the gate|nothing passed the gate/.test(r.md + r.html.replace(/<script[\s\S]*?<\/script>/g, '')), 'Markdown has it; the old sentence is gone');
    const none = await run('nolog', { log: 'none' });
    ok(!none.f.what_is_wrong && none.f.findings_empty_text === 'No confirmed cause was found.' && none.md.includes('No confirmed cause was found.'), 'with no cause at all: "No confirmed cause was found."');
    if (browser) {
        ok((await pr.sec('findings')).includes("No confirmed cause. See 'What is wrong' above."), 'page: the Findings box says it');
        const pn = await page(none); ok((await pn.sec('findings')).includes('No confirmed cause was found.') && !pn.ids.includes('whatswrong'), 'page, no cause: the plain sentence and no What-is-wrong box'); await pn.close();
    }

    group('4. (b) the Verdict cause line is a short pointer, not the box sentence');
    const cl = r.f.verdict_cause_line;
    ok(cl === 'The theme Unicamp, in a file that uses a class that comes from Elementor 3.35.7 (not confirmed). Details: see "What is wrong".', 'the pointer names the theme, the class owner and its version, "not confirmed" (the code of the copy was not read completely)');
    const cm = await run('complete', { complete: true });
    ok(cm.f.verdict_cause_line === 'The theme Unicamp, in a file that uses a class Elementor 3.35.7 does not have (confirmed). Details: see "What is wrong".' && !cm.f.verdict_cause_line.includes(cm.f.what_is_wrong.lines[0]), 'every PHP file read: "a class Elementor 3.35.7 does not have", and a confirmed cause says "confirmed"');
    ok(cl !== box.lines[0] && !cl.includes(box.lines[0]) && !box.lines.some(l => l === cl) && !cl.includes('Elementor\\Core') && !/PHP Fatal error/.test(cl), 'it is not the first line of the box (nor any line of it) and carries no class path');
    if (browser) ok((await pr.dd('Cause')) === cl, 'page: the Verdict "Cause" is the pointer line');

    group('5. (c) no internal value in the Tested line');
    ok(r.f.sandbox && r.f.sandbox.reproduced_in_sandbox === null, 'fixture: sandbox data with a null result (the old page printed "sandbox reproduction: null")');
    ok(/the test copy \(sandbox\) was not used/.test(r.f.tested_text) && !INTERNAL.test(r.f.tested_text), 'the Tested sentence says "the test copy (sandbox) was not used"');
    ok(plain.testedSentence({ timeline: [], sandbox: { reproduced_in_sandbox: true }, bisect: { status: 'x' }, retests: [1] }) === '0 steps ran; the problem was reproduced in the test copy (sandbox); a plugin-by-plugin test was run; 1 retest.' && /did not show/.test(plain.testedSentence({ timeline: [], sandbox: { reproduced_in_sandbox: false } })), 'other sandbox results in words');
    ok(plain.symptomSentence('could-not-test') === 'The problem was not tested on the site.' && plain.symptomSentence(null) === 'The problem was not tested on the site.' && plain.symptomSentence('yes') === 'The problem was seen on the site.', 'the symptom value in words');
    if (browser) {
        const vt = await pr.sec('verdict');
        ok(!INTERNAL.test(vt) && !/sandbox reproduction|symptom reproduced:|Confidence:/.test(vt), 'page: the Verdict has no null, undefined, could-not-test, status code or "Confidence:"');
        ok((await pr.dd('Tested')) === r.f.tested_text, 'page: the Tested line is the plain sentence');
    }

    group('6. (d) the page names the advisory and shows the Advisories collapsed');
    const adv = /1 possible cause is listed under Advisories: an outdated template override \((\d+) templates\)\./;
    ok(adv.test(r.f.summary.lines_html.join('\n')) && !/--verbose/.test(r.f.summary.lines_html.join('\n')) && !/--verbose/.test(r.f.summary.lines_html_without_box.join('\n')), 'the page text names it: "an outdated template override (N templates)" and has no --verbose hint');
    ok(/run with --verbose to see it/.test(r.md) && /run with --verbose to see it/.test(c1), 'Markdown and the command line keep the --verbose hint');
    if (browser) {
        const sm = await pr.sec('summary');
        ok(adv.test(sm), 'page: the Summary names the advisory');
        ok(pr.ids.includes('advisories') && pr.openDetails.length === 1 && pr.openDetails[0] === false, 'page: the Advisories section is there, collapsed');
        ok(/old copy of a plugin template/.test(await pr.sec('advisories')), 'page: the collapsed Advisories hold the advisory');
        ok(pv.ids.includes('advisories') && pv.openDetails.length === 0, 'page with --verbose: the Advisories are open (not collapsed)');
    }

    group('7. (e) the resolution agrees with "What to try"');
    const tryLine = box.lines.find(l => l.startsWith('What to try: ')), items = tryLine.replace(/^What to try: /, '').replace(/\.$/, '').split('; ');
    ok(items.length === 3 && /update theme Unicamp/.test(items[0]) && /use a version of Elementor that has this class/.test(items[1]) && /default theme/.test(items[2]), 'the box says: update the theme, use a version of Elementor that has this class, test with a default theme');
    const res0 = r.f.resolution.find(x => x.what_to_try);
    ok(res0 && res0.what_to_try.length === items.length && res0.what_to_try.every((t, i) => t.toLowerCase() === items[i].toLowerCase()), 'findings.json: the resolution carries the same list');
    ok(res0.options.every(o => !/^No safe automatic option$/.test(o.reader_title || o.title)) && res0.options.some(o => o.reader_title), 'no option still says "No safe automatic option"; it has its own reader wording (the plan data is unchanged)');
    ok(r.f.resolution.every(x => x.options.every(o => o.type && o.who && o.title)) && r.plans.every(p => p.options.every(o => !('reader_title' in o))), 'the plans and the original option fields are untouched');
    ok(items.every(t => c1.toLowerCase().includes(t.toLowerCase())) && !/No safe automatic option/.test(c1), 'command line: every item is listed, no contradicting option');
    ok(/update theme Unicamp/i.test(r.f.fix_text) && r.f.fix_text.toLowerCase().includes(items[1].toLowerCase()), 'the Verdict "Fix" line gives the same steps');
    if (browser) {
        const rt = (await pr.sec('resolution')).toLowerCase();
        ok(items.every(t => rt.includes(t.toLowerCase())), 'page: every "What to try" item is in the resolution text');
        ok(!/no safe automatic option/.test(rt) && !/deactivate/.test(rt), 'page: no option contradicts it');
        ok((await pr.dd('Fix')) === r.f.fix_text, 'page: the Verdict "Fix" is the same list');
    }

    group('8. (f) "How sure we are" in words');
    ok(r.f.confidence_text === 'How sure we are: not very. The error is in your log, but it was not confirmed by a test on the site.' && r.f.verdict.confidence === 'low', 'low + most likely cause -> the sentence; findings.json keeps "low"');
    const C = (c, l, o) => plain.confidenceSentence(c, l, o);
    ok(C('none', 'x').startsWith('How sure we are: not very.') && C('low', 'x').startsWith('How sure we are: not very.') && C('medium', 'x').startsWith('How sure we are: fairly.') && C('medium-high', 'x').startsWith('How sure we are: fairly.') && C('high', 'x').startsWith('How sure we are: very.'), 'levels: none/low not very, medium/medium-high fairly, high very');
    ok(/in your log/.test(C('medium-high', 'Confirmed cause found in your logs')) && /reproduced in a test copy/.test(C('high', 'Confirmed breaking cause found', { reproduced: true })) && /retest/.test(C('high', 'Fixed and verified')), 'the reason follows the verdict tier (log, reproduced, retest)');
    ok(r.md.includes(r.f.confidence_text) && cliText(r, false).length > 0, 'Markdown carries the sentence');
    // the command line prints the sentence under VERDICT (checked on the source: investigate() logs confidence_text)
    ok(/confidence_text/.test(fs.readFileSync(path.join(__dirname, '..', 'lib', 'issue-cli.js'), 'utf8')), 'issue-cli prints the sentence under VERDICT in gate mode');
    if (browser) ok(pr.meta.includes(r.f.confidence_text) && !/Confidence: /.test(pr.meta), 'page: the Verdict shows the sentence, not "Confidence: low"');

    group('9. (g) "Not tested" lists only what is tied to the problem');
    if (browser) {
        const nt = (await pr.dd('Not tested')) || '';
        ok(!/Screenshot comparison|originals of the screenshots|Sandbox/.test(nt) && !INTERNAL.test(nt), 'page: no screenshot comparison, originals or unasked sandbox');
        const ntv = (await pv.dd('Not tested')) || '';
        ok(/Screenshot comparison/.test(ntv) && /originals of the screenshots/.test(ntv), 'page with --verbose: everything shows');
    }
    ok(!/Screenshot comparison|originals of the screenshots/.test(r.md.split('## What was checked')[1] || '') && !/Screenshot comparison|originals of the screenshots/.test(r.f.summary.report_lines.join('\n') + c1), 'Markdown "What was checked", the Summary and the command line: not there');
    ok(!r.f.not_tested.includes('image-diff') && !r.f.not_tested.includes('original-public') && !r.f.not_tested.includes('sandbox'), 'findings.json lists the kept ids only');
    ok(!/not tested/i.test([r.f.confidence_text, r.f.tested_text, r.f.verdict_cause_line, r.f.findings_empty_text, r.f.checkpoint_text.sentence].join(' ')), 'the new texts add no second "Not tested" list');

    group('10. (h) a title is never cut inside a word');
    const D = 'The shop pages show a critical error after the WooCommerce update and the checkout button does nothing when customers try to pay with a card';
    const T = D.slice(0, 100);   // what the wizard keeps: the first 100 characters of the description
    ok(!/\s$/.test(T) && /\w$/.test(T) && /\w/.test(D[100]), 'fixture: the title ends inside a word');
    const rt = await run('longtitle', { title: T, description: D });
    const st = rt.f.issue_title_short;
    ok(st.endsWith('\u2026') && D.startsWith(st.slice(0, -1)) && /\s/.test(D[st.length - 1]) && st.length < T.length, `cut at a word boundary with an ellipsis: "${st}"`);
    ok(rt.f.issue.title === T, 'findings.json keeps the stored title');
    ok(rt.md.split('\n')[0] === `# Issue report: ${st}`, 'ISSUE-REPORT.md heading uses the short title');
    ok(plain.shortTitle('Critical error', 'The site shows a critical error') === 'Critical error' && plain.shortTitle('Site is broken', 'Site is broken after the update') === 'Site is broken' && plain.shortTitle('abc', 'abcdef') === 'abc', 'a title that is not cut is unchanged');
    ok(r.f.issue_title_short === 'Critical error', 'the normal title is unchanged');
    if (browser) { const pt = await page(rt); ok(pt.h1 === st && pt.title === `Issue report: ${st}`, 'page: heading and <title> use it'); await pt.close(); }

    group('10b. a new issue stores a title cut at a word boundary; the index shows the clean title');
    const LONG = 'The shop pages show a critical error after the WooCommerce update and the checkout button does nothing when customers try to pay with a card and then it keeps going on and on for a long time';
    const ct = plain.clipTitle(LONG.replace(/\s+/g, ' '), 100);
    ok(ct.length <= 100 && ct.endsWith('\u2026') && LONG.startsWith(ct.slice(0, -1)) && /\s/.test(LONG[ct.length - 1]), `wizard cut (100): whole words only: "${ct}"`);
    ok(/clipTitle\(titleRaw, 100\)/.test(fs.readFileSync(path.join(__dirname, '..', 'lib', 'wizard.js'), 'utf8')), 'the wizard uses it');
    const stored = store.create({ title: LONG + ' ' + LONG, description: LONG, symptom: 'other', environment: 'local', pages: [] });
    ok(stored.title.length <= 120 && stored.title.endsWith('\u2026') && (LONG + ' ' + LONG).startsWith(stored.title.slice(0, -1)) && /\s/.test((LONG + ' ' + LONG)[stored.title.length - 1]), 'issue-store: a long title is cut at a word with an ellipsis (<= 120)');
    ok(store.create({ title: 'Critical error', description: 'x', symptom: 'other', environment: 'local', pages: [] }).title === 'Critical error' && plain.clipTitle('Short title', 100) === 'Short title', 'a short title is unchanged');
    const mid = store.create({ title: T, description: D, symptom: 'other', environment: 'local', pages: [] });
    const idx = require('../issue/index-page');
    const row = idx.collect().find(x => x.id === mid.id);
    ok(row.title === plain.shortTitle(T, D) && row.title.endsWith('\u2026'), 'index page: an old mid-word title shows cleanly');

    group('11. (i) a very large log');
    const small = r.f;
    ok(!small.log_note && !/very large/.test(small.summary.report_lines.join('\n')) && !(box && box.note), 'a small log: no note anywhere');
    const noisy = await run('noisy', { log: 'big-noisy' }), mixed = await run('mixed', { log: 'big-mixed' });
    const lf = d => JSON.parse(fs.readFileSync(path.join(d.dir, 'work', 'logs.json'), 'utf8')).files[0];
    ok(lf(noisy).truncated && lf(noisy).bytes > 2 * 1024 * 1024 && lf(mixed).truncated, 'fixtures: the log is larger than the read cap');
    const mb = Math.round(lf(noisy).bytes / 1048576);
    const N1 = `Your log is very large (about ${mb} MB) and mostly repeats the same warnings. Only the most recent part was read, so older errors may not be shown.`;
    ok(noisy.f.log_note === N1, `noisy log: the long sentence ("mostly repeats the same warnings"): ${N1.slice(0, 60)}...`);
    const mb2 = Math.round(lf(mixed).bytes / 1048576);
    const N2 = `Your log is very large (about ${mb2} MB). Only the most recent part was read, so older errors may not be shown.`;
    ok(mixed.f.log_note === N2 && !/mostly repeats/.test(mixed.f.log_note), 'mixed log (many errors): only the short sentence');
    ok(noisy.f.summary.report_lines.includes(N1) && mixed.f.summary.report_lines.includes(N2), 'both are in the Summary');
    ok(noisy.md.includes(N1) && cliText(noisy, false).includes(N1) && mixed.md.includes(N2), 'Markdown and the command line carry it');
    ok(!noisy.f.summary.text.includes('very large'), 'the original summary lines are unchanged (the note is added only to the report lines)');
    if (noisy.f.what_is_wrong) ok(noisy.f.what_is_wrong.note === N1, 'the box carries it as a note');
    const L = (soft, other) => plain.logNote({ files: [{ truncated: true, bytes: 5 * 1048576 }], entries: [{ level: 'warning', count: soft }, { level: 'fatal error', count: other }] });
    ok(/mostly repeats/.test(L(80, 20)) && !/mostly repeats/.test(L(79, 21)) && !/mostly repeats/.test(L(0, 0)), 'the measure: >= 80% notice / warning / deprecated entries (80/20 yes, 79/21 no, none no)');
    ok(plain.logNote({ files: [{ truncated: false, bytes: 1000 }], entries: [] }) === null && plain.logNote(null) === null, 'not truncated: null');
    if (browser) {
        const pn = await page(noisy);
        ok((await pn.sec('summary')).includes(N1) && ((await pn.sec('whatswrong')) || '').includes(N1), 'page: the note is in the Summary and in the box area');
        ok(!(await pr.sec('summary')).includes('very large'), 'page, small log: no note');
        await pn.close();
    }

    if (browser) { await pr.close(); await pv.close(); await browser.close(); }
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(failures ? `\n${failures} FAILED` : `\nAll report-polish checks passed${skipped ? ` (${skipped} part(s) skipped)` : ''}.`);
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
