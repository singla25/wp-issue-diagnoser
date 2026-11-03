#!/usr/bin/env node
// The "Most likely cause" tier and the "What is wrong" box (issue/whats-wrong.js, gate.js, summary.js, result.js, the HTML), and the rule that a page that answered 5xx is never
// "not reproduced" (oracle.js debug-log, validate.js). Every case uses the exact ews log line:
//   PHP Fatal error:  Uncaught Error: Class "Elementor\Core\Schemes\Color" not found in .../themes/unicamp/elementor/widgets/original/heading.php:48
// Offline. Fixtures only.
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-likely-'));
process.env.PLUGIN_GUARD_ISSUES = path.join(tmp, 'issues');
const store = require('../lib/issue-store');
const evidence = require('../issue/evidence'), analysis = require('../issue/analysis'), validate = require('../issue/validate'), resolve = require('../issue/resolve'), result = require('../issue/result');
const oracle = require('../issue/oracle');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const group = t => console.log(`\n== ${t}`);
const w = (root, rel, body = '<?php\n') => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); };
const CLASS = 'Elementor\\Core\\Schemes\\Color';
const FILE = 'wp-content/themes/unicamp/elementor/widgets/original/heading.php';
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const stamp = d => `${String(d.getUTCDate()).padStart(2, '0')}-${MON[d.getUTCMonth()]}-${d.getUTCFullYear()} ${d.toISOString().slice(11, 19)}`;
const daysAgo = n => stamp(new Date(Date.now() - n * 86400e3));

function build(root, o = {}) {
    w(root, 'wp-includes/version.php', "<?php\n$wp_version = '6.8.1';\n"); w(root, 'wp-config.php', '<?php\n');
    w(root, 'wp-content/plugins/elementor/elementor.php', '<?php\n/**\n * Plugin Name: Elementor\n * Version: 3.35.7\n */\nnamespace Elementor;\nclass Plugin {}\n');
    w(root, 'wp-content/themes/unicamp/style.css', '/*\nTheme Name: Unicamp\nVersion: 1.4.2\n*/');
    w(root, FILE, '<?php\n' + '// filler\n'.repeat(46) + (o.line || `$c = \\${o.cls || CLASS}::get_type();`) + '\n');
    if (o.woo !== false) { w(root, 'wp-content/plugins/woocommerce/woocommerce.php', '<?php\n/**\n * Plugin Name: WooCommerce\n * Version: 9.1.0\n */\n'); }
    if (o.templates) for (let i = 1; i <= o.templates; i++) { w(root, `wp-content/plugins/woocommerce/templates/t${i}/t${i}.php`, '<?php\n/**\n * @version 9.0.0\n */\n'); w(root, `wp-content/themes/unicamp/woocommerce/t${i}/t${i}.php`, '<?php\n/**\n * @version 3.0.0\n */\n'); }
    const cls = o.cls || CLASS, at = o.at || daysAgo(1);
    const one = t => `[${t} UTC] PHP Fatal error:  Uncaught Error: Class "${cls}" not found in ${root}/${FILE}:48\nStack trace:\n#0 {main}\n  thrown in ${root}/${FILE} on line 48\n`;
    const secs = at.slice(-2);
    w(root, 'wp-content/debug.log', one(at) + (o.repeats === 1 ? '' : one(at.slice(0, -2) + String((Number(secs) + 1) % 60).padStart(2, '0'))));
    if (o.extra) o.extra(root);
}
async function run(name, o = {}, prep = null) {
    const root = path.join(tmp, name, 'wp'); build(root, o);
    const config = path.join(root, 'plugin-guard.config.json'); fs.writeFileSync(config, JSON.stringify(o.config || {}));
    const issue = store.create({ title: 'Critical error', description: o.description || 'The site shows a critical error', symptom: o.symptom || 'white-screen', environment: 'local', url: 'http://127.0.0.1:9/ews/', root, pages: o.pages || [], ...(o.oracle ? { oracle: o.oracle } : {}) });
    await evidence.run(issue.id, { root, probeOptions: { probe: false } });
    analysis.run(issue.id, { root, config });
    const dir = store.dirOf(issue.id);
    if (prep) prep(dir, issue, root);
    const val = validate.run(issue.id, { root, config, lint: () => ({ ok: true, message: '' }) });
    const policy = validate.policyFor(root, config), plans = resolve.build(issue.id, val, { root, policy, dir });
    result.write(issue.id, { validation: val, plans, dir, root, policy, gate: true });
    const f = JSON.parse(fs.readFileSync(path.join(dir, 'result', 'findings.json'), 'utf8'));
    return { f, val, dir, h: val.hypotheses.find(x => x.type === 'missing-function'), md: fs.readFileSync(path.join(dir, 'result', 'ISSUE-REPORT.md'), 'utf8'), html: fs.readFileSync(path.join(dir, 'result', 'issue.html'), 'utf8'), box: null };
}
const intakeSkipped = (dir) => fs.writeFileSync(path.join(dir, 'work', 'intake.json'), JSON.stringify({ php_skipped: 1, php_skipped_examples: ['wp-content/plugins/x/.github/a.php'] }));
const probeWith = (pages, oracleResult = 'no') => (dir, issue) => {
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'issue.json'), 'utf8')); j.probe_ran_at = new Date().toISOString(); j.oracle = { type: 'console-error', value: 'zzz-never', defaulted: false }; fs.writeFileSync(path.join(dir, 'issue.json'), JSON.stringify(j));
    const mk = p => ({ url: p.url, status: p.status, viewport: { name: 'laptop', width: 1280 }, loaded: true, console_errors: [], page_errors: [], error_responses: [] });
    fs.writeFileSync(path.join(dir, 'work', 'probe.json'), JSON.stringify({ schema: 1, planned: pages.length, protection: null, pages: pages.map(mk), oracle: { type: 'console-error', value: 'zzz-never', result: oracleResult } }));
};
const H = '"Most likely cause (found in your log)"';

(async () => {
    group('the exact ews line, Rule B holds: a confirmed finding with the box');
    const c = await run('confirmed', { templates: 4 });
    const box = c.f.what_is_wrong;
    ok(c.h.status === 'CONFIRMED' && c.f.findings.length === 1 && box && box.tier === 'confirmed', 'the fatal is CONFIRMED and the box is there (tier confirmed)');
    const t = box.lines.join('\n');
    ok(/^Error in your log: PHP Fatal error: Class "Elementor\\Core\\Schemes\\Color" not found\./.test(box.lines[0]), 'the box starts with the error text from the log');
    ok(t.includes('Where: the theme file wp-content/themes/unicamp/elementor/widgets/original/heading.php, line 48 (theme Unicamp 1.4.2).'), 'file and line, with the theme and its version');
    ok(/What was checked: found in your log, repeated 2 times, file and line re-read/.test(t), '"found in your log, repeated 2 times, file and line re-read"');
    ok(t.includes('The class: Elementor 3.35.7 does not contain it') && t.includes('This usually means the theme was written for an older version of Elementor.'), 'the class: "Elementor 3.35.7 does not contain it" (its files were searched)');
    ok(t.includes('Versions: theme Unicamp 1.4.2 · Elementor 3.35.7 · WooCommerce 9.1.0.'), 'the versions of the theme, the provider and WooCommerce');
    ok(/A second thing to check: an outdated template override \(4 templates\) is listed under Advisories \(Unicamp \+ WooCommerce\)\./.test(t), 'an outdated template override is named as a second thing to check');
    ok(t.includes('What to try: update theme Unicamp; use a version of Elementor that has this class; test with a default theme') && t.includes('Live check: none was run'), 'what to try, and whether a live check ran');
    ok(!/broken|because of|your site is/i.test(t) && !/\bconfirmed\b/i.test(t), 'the box never says "your site is broken because of X" and never says "confirmed" in its own words');
    ok(c.f.summary.lines.some(l => /^Cause found in your log:$/.test(l)) && c.f.summary.lines.some(l => l.includes('Versions: theme Unicamp')), 'the box is in the summary');
    ok(c.md.includes('Versions: theme Unicamp 1.4.2') && c.html.includes('What is wrong'), 'and in the Markdown and in the HTML');
    const advs = c.f.advisories.filter(a => a.type === 'template-override-outdated');
    ok(advs.length === 1 && advs[0].merged === 4 && advs[0].merged_ids.length === 4, 'four identical "Outdated template override" advisories are ONE advisory with merged = 4');

    group('Most likely cause: repeated, file and line re-read, but nothing established it');
    const l = await run('likely', {}, intakeSkipped);
    ok(l.h.status === 'PROBABLE_NEEDS_REVIEW' && l.f.findings.length === 0 && l.f.likely && l.f.likely.length === 1 && l.f.likely[0].tier === 'likely', 'PROBABLE_NEEDS_REVIEW stays (statuses untouched); the item is in "likely", not in findings');
    ok(l.f.what_is_wrong.tier === 'likely' && l.f.what_is_wrong.heading === 'Most likely cause (found in your log)' && l.f.what_is_wrong.age === 'recent', 'heading "Most likely cause (found in your log)", age recent');
    ok(l.f.summary.headline === 'No confirmed breaking cause was found.' && l.f.summary.lines.includes('Most likely cause (found in your log):'), 'the summary still says no confirmed cause, then shows the most likely cause at the top');
    ok(l.f.verdict.label === 'Most likely cause found in your log (not confirmed)' && l.f.verdict.confidence === 'low', `verdict: ${l.f.verdict.label}`);
    ok(!l.f.what_is_wrong.lines.some(x => /\bconfirmed\b/i.test(x)) && !/\bconfirmed\b/i.test(l.f.what_is_wrong.heading), 'no "confirmed" in the box or its heading');
    ok(!l.f.advisories.some(a => a.id === l.f.likely[0].id), 'it is not also listed as an advisory');
    ok(l.f.what_is_wrong.lines.some(x => /Could not check all code/.test(x)), 'the box says "Could not check all code" when the copy skipped PHP');
    ok(l.html.includes('Most likely cause (found in your log)') && l.html.includes("sec('whatswrong'") && !/\.innerHTML\s*=|insertAdjacentHTML/.test(l.html), 'the HTML carries the box in its data, builds it with textContent (no innerHTML assignment)');
    ok(l.html.includes('not confirmed'), 'the HTML says "not confirmed"');

    group('an old log entry is still shown, and labelled');
    const old = await run('old', { at: '16-Mar-2026 13:11:38' }, intakeSkipped);
    ok(old.f.likely && old.f.what_is_wrong.age === 'old' && old.f.what_is_wrong.heading === 'Most likely cause (old log entry)' && old.f.what_is_wrong.lines.some(x => /^Old log entry: last seen in your log on 16 Mar 2026/.test(x)), 'older than 7 days: shown, labelled "old log entry", with the date');
    ok(l.f.what_is_wrong.lines.some(x => /^Last seen in your log on \d+ \w+ \d{4}\.$/.test(x)), 'a recent one says "Last seen in your log on <date>"');
    const edge = await run('week', { at: daysAgo(6) }, intakeSkipped);
    ok(edge.f.what_is_wrong.age === 'recent', '6 days before the report is still recent');

    group('no tier without the re-checked facts');
    for (const [name, o, why] of [['once', { repeats: 1 }, 'the fatal is in the log only once'], ['nomention', { line: '$c = 1;' }, 'the cited line does not name the class']]) {
        const r = await run('no-' + name, o, intakeSkipped);
        ok(!r.f.likely && !r.f.what_is_wrong && r.f.findings.length === 0, `${why}: no tier and no box`);
    }
    const nofile = await run('no-file', {}, (dir, issue, root) => { intakeSkipped(dir); fs.rmSync(path.join(root, FILE)); });
    ok(!nofile.f.likely && !nofile.f.what_is_wrong, 'the file is not in the copy: no tier');

    group('wording of the provider');
    const g = await run('guess', { cls: 'Foobarwidgets\\Core\\Thing', line: '$c = new \\Foobarwidgets\\Core\\Thing();', extra: r => w(r, 'wp-content/plugins/foobarwidgets-pro/foobarwidgets-pro.php', '<?php\n/**\n * Plugin Name: Foobar Widgets Pro\n * Version: 2.0\n */\n') }, intakeSkipped);
    ok(g.f.what_is_wrong.lines.some(x => x === 'The class: this class normally comes from Foobar Widgets Pro (a guess from its name, not checked).') && !g.f.what_is_wrong.lines.some(x => /does not contain/.test(x)), 'a guessed provider: "this class normally comes from Foobar Widgets Pro (a guess ...)", never "does not contain"');
    ok(l.f.what_is_wrong.lines.some(x => x === 'The class: this class normally comes from Elementor 3.35.7; whether it contains the class was not checked.') && !l.f.what_is_wrong.lines.some(x => /does not contain/.test(x)), 'a known provider whose files were NOT searched (copy skipped PHP): "normally comes from Elementor 3.35.7; whether it contains the class was not checked"');
    const fn = await run('function', { cls: 'unicamp_missing_helper', line: '$x = unicamp_missing_helper();' , extra: r => { const p = path.join(r, 'wp-content/debug.log'); fs.writeFileSync(p, fs.readFileSync(p, 'utf8').split('Class "unicamp_missing_helper" not found').join('Call to undefined function unicamp_missing_helper()')); } });
    ok(!fn.f.what_is_wrong || /undefined function unicamp_missing_helper\(\)/.test(fn.f.what_is_wrong.lines[0]), 'an undefined-function fatal gets the same box (function wording)');

    group('a log fatal naming a theme file reads "(theme Unicamp)"');
    const once = await run('label', { repeats: 1 });
    ok(once.f.summary.lines.some(x => /backed by a log error/.test(x) && x.includes('(theme Unicamp)') && !/plugin theme:unicamp/.test(x)), 'the "backed by a log error" line says (theme Unicamp), not (plugin theme:unicamp)');

    group('a 5xx page is never "not reproduced"');
    const HOME = 'http://127.0.0.1:9/ews/';
    const lift = await run('lift', {}, probeWith([{ url: HOME, status: 500 }]));
    ok(lift.val.symptom_reproduced === 'yes' && lift.val.checks.some(x => x.id === 'not-reproduced-cap' && x.status === 'PASSED') && lift.h.status === 'CONFIRMED', 'crash + the oracle said "no" + the home page answered 500: the cap is lifted, the symptom counts as reproduced, the fatal stays CONFIRMED');
    ok(lift.f.verdict.label !== 'Not reproduced', `and the verdict is not "Not reproduced" (${lift.f.verdict.label})`);
    const fine = await run('fine', {}, probeWith([{ url: HOME, status: 200 }]));
    ok(fine.val.symptom_reproduced === 'no' && fine.h.status === 'PROBABLE_NEEDS_REVIEW', '"ran and did not reproduce" (the page answered 200) still downgrades, as before');
    const unrelated = await run('unrelated', { pages: ['/cart/'] }, probeWith([{ url: 'http://127.0.0.1:9/ews/other-page/', status: 503 }]));
    ok(unrelated.val.symptom_reproduced === 'no' && unrelated.h.status === 'PROBABLE_NEEDS_REVIEW', 'a 5xx on a page the report is not about does not lift the cap');
    const named = await run('named', { pages: ['/cart/'] }, probeWith([{ url: 'http://127.0.0.1:9/ews/cart/', status: 503 }]));
    ok(named.val.symptom_reproduced === 'yes' && named.h.status === 'CONFIRMED', 'a 5xx on a page the report names (in a site in a sub-folder) lifts it');
    const notCrash = await run('notcrash', { symptom: 'layout' }, probeWith([{ url: HOME, status: 500 }]));
    ok(notCrash.val.symptom_reproduced === 'no', 'when the problem is not a crash, a 5xx does not lift the cap');

    group('every oracle that reads new lines of a copied log: a 5xx is never "no"');
    const pg = status => ({ url: 'http://x/', loaded: true, status, viewport: { name: 'laptop', width: 1280 }, console_errors: [], page_errors: [], error_responses: [], scroll: { doc_width: 1000, viewport_width: 1280 }, text: 'x' });
    const dl = lines => ({ available: true, new_text: lines });
    const ev = (spec, pages, d, symptom) => oracle.evaluate(spec, { pages, planned: pages.length, protection: null, debug_log: d }, { symptom });
    const dbg = { type: 'debug-log', value: 'Fatal error' };
    ok(ev(dbg, [pg(500)], dl(''), 'white-screen').result === 'yes', 'debug-log, a crash, HTTP 500 and no new log line: yes');
    ok(ev(dbg, [pg(500)], dl('[x] PHP Notice: unrelated\n'), 'white-screen').result === 'yes', 'debug-log, HTTP 500 and only an unrelated new line: yes');
    ok(ev(dbg, [pg(503)], dl(''), 'layout').result === 'could-not-test', 'debug-log, not a crash, HTTP 503: could not test (never "no")');
    ok(ev(dbg, [pg(200)], dl(''), 'white-screen').result === 'no', 'debug-log, HTTP 200 and no new line: still "no" (a real answer)');
    ok(ev(dbg, [pg(200)], dl('[x] PHP Fatal error: x\n'), 'white-screen').result === 'yes', 'debug-log, a new matching line: yes, as before');
    ok(ev({ type: 'generic', value: null, defaulted: true }, [pg(500)], dl(''), 'white-screen').result === 'yes', 'generic, HTTP 500 and no new log line: yes');
    ok(ev({ type: 'generic', value: null, defaulted: true }, [pg(500)], { available: false, reason: 'no log' }, 'white-screen').result === 'yes', 'generic, HTTP 500 and the log not readable: yes');
    ok(ev({ type: 'http-5xx', value: null }, [pg(500)], dl(''), 'white-screen').result === 'yes', 'http-5xx: yes');

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(failures ? `\n${failures} FAILED` : '\nAll checks passed');
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
