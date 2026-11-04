#!/usr/bin/env node
// Reader-facing text must not carry the validator's internal wording: "oracle", "recomputation", "stored", NOT_RUN and the id of any validation check or
// probe step (collected below from the SOURCE by regex, so a new id is picked up with no change here). Scanned: Summary, Verdict, "What is wrong" box,
// "Why this status", Findings, Advisories, Resolution options, the Markdown (without "What was checked" and "Limits"), the command-line text, with and
// without --verbose. NOT scanned: timeline, limits, "What was checked", developer sections and findings.json (which keeps every check on purpose).
// Fixture: the ews case (stored oracle "yes", recomputed "could-not-test"; heading.php:48, Elementor\Core\Schemes\Color; Unicamp / Elementor / WooCommerce).
// Offline. Fixtures only.
const fs = require('fs');
const os = require('os');
const path = require('path');

// ---- VISIBLE allow-list: a term that may legitimately appear in reader text (whole term, case-insensitive). One line of reason each. ----
const ALLOW = [
    ['stored', "an ordinary English word (plugin 'Stored Products', 'stored in uploads'); only the phrase 'stored oracle answer' is internal, and 'oracle' is scanned on its own"],
];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-rw-'));
process.env.PLUGIN_GUARD_ISSUES = path.join(tmp, 'issues');
const store = require('../lib/issue-store');
const evidence = require('../issue/evidence'), analysis = require('../issue/analysis'), validate = require('../issue/validate'), resolve = require('../issue/resolve'), result = require('../issue/result');
const plain = require('../lib/plain-names');

let failures = 0, skipped = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const group = t => console.log(`\n== ${t}`);

// ---- the internal terms, from the source ----
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const ids = new Set();
for (const m of read('issue/validate.js').matchAll(/check\(\s*(?:'([^']+)'|`([^`$]*)(?:\$\{|`))/g)) ids.add(m[1] || m[2]);              // check('id' ... ) and check(`prefix:${...}`)
for (const m of read('issue/fatal-recheck.js').matchAll(/\badd\('([^']+)'/g)) ids.add(m[1]);                                             // the fatal re-check ids (shown as fatal:<id>)
for (const m of read('issue/probe.js').matchAll(/\bstep\('([^']+)'/g)) ids.add(m[1]);                                                   // probe step ids
const TERMS = [...new Set(['oracle', 'recomputation', 'recomputed', 'stored', 'NOT_RUN', ...ids])].filter(t => !ALLOW.some(a => a[0].toLowerCase() === t.toLowerCase()));
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const RES = TERMS.map(t => [t, new RegExp(`(?<![A-Za-z0-9_-])${escRe(t)}${/[A-Za-z0-9]$/.test(t) ? '(?![A-Za-z0-9_-])' : ''}`, 'i')]);
const hits = text => RES.filter(([, re]) => re.test(text)).map(([t]) => t);
// one entry per term found: a short excerpt around the first match (the rendered page has no line breaks, so lines are no use)
const lineHits = text => RES.map(([t, re]) => { const m = re.exec(String(text)); return m ? [String(text).slice(Math.max(0, m.index - 50), m.index + 90).replace(/\s+/g, ' '), [t]] : null; }).filter(Boolean);
function scan(label, text) {
    const bad = lineHits(text);
    ok(!bad.length, `${label}: no internal wording`);
    for (const [l, h] of bad.slice(0, 12)) console.log(`      -> [${h.join(', ')}] ${l.trim().slice(0, 200)}`);
}

// ---- the ews fixture (construction copied from selftest-polish.js / selftest-validate-symptom.js) ----
const w = (root, rel, body = '<?php\n') => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); };
const CLASS = 'Elementor\\Core\\Schemes\\Color';
const FILE = 'wp-content/themes/unicamp/elementor/widgets/original/heading.php';
const EWS = 'http://localhost82.local.com/ews/';
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const stamp = d => `${String(d.getUTCDate()).padStart(2, '0')}-${MON[d.getUTCMonth()]}-${d.getUTCFullYear()} ${d.toISOString().slice(11, 19)}`;
function build(root) {
    w(root, 'wp-includes/version.php', "<?php\n$wp_version = '6.8.1';\n"); w(root, 'wp-config.php', '<?php\n');
    w(root, 'wp-content/plugins/elementor/elementor.php', '<?php\n/**\n * Plugin Name: Elementor\n * Version: 3.35.7\n */\nnamespace Elementor;\nclass Plugin {}\n');
    w(root, 'wp-content/themes/unicamp/style.css', '/*\nTheme Name: Unicamp\nVersion: 2.2.0\n*/');
    w(root, FILE, '<?php\n' + '// filler\n'.repeat(46) + `$c = \\${CLASS}::get_type();\n`);
    w(root, 'wp-content/plugins/woocommerce/woocommerce.php', '<?php\n/**\n * Plugin Name: WooCommerce\n * Version: 10.6.1\n */\n');
    for (let i = 1; i <= 5; i++) { w(root, `wp-content/plugins/woocommerce/templates/t${i}/t${i}.php`, '<?php\n/**\n * @version 9.0.0\n */\n'); w(root, `wp-content/themes/unicamp/woocommerce/t${i}/t${i}.php`, '<?php\n/**\n * @version 3.0.0\n */\n'); }
    const at = stamp(new Date(Date.now() - 86400e3)), at2 = at.slice(0, -2) + String((Number(at.slice(-2)) + 1) % 60).padStart(2, '0');
    const one = t => `[${t} UTC] PHP Fatal error:  Uncaught Error: Class "${CLASS}" not found in ${root}/${FILE}:48\nStack trace:\n#0 {main}\n  thrown in ${root}/${FILE} on line 48\n`;
    w(root, 'wp-content/debug.log', one(at) + one(at2));
}
const ewsProbe = dir => {
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'issue.json'), 'utf8')); j.probe_ran_at = new Date().toISOString(); j.oracle = { type: 'debug-log', value: 'Fatal error', defaulted: false }; fs.writeFileSync(path.join(dir, 'issue.json'), JSON.stringify(j));
    const resp = { url: EWS, status: 500, type: 'document', same_site: true, source: { type: 'other', ref: null, name: 'localhost82.local.com' } };
    fs.writeFileSync(path.join(dir, 'work', 'probe.json'), JSON.stringify({
        schema: 1, planned: { pages: [EWS], viewports: ['laptop 1280x800', 'mobile 390x844'], loads: 2, notes: [] }, protection: null,
        pages: [
            { console_errors: [], page_errors: [], error_responses: [resp, resp], failed_requests: [], url: EWS, viewport: { name: 'laptop', width: 1280, height: 800 }, loaded: true, status: 500, first_status: 500, retried: true, outcome: 'server-error' },
            { console_errors: [], page_errors: [], error_responses: [], failed_requests: [], url: EWS, viewport: { name: 'mobile', width: 390, height: 844 }, loaded: false, status: 0, skipped: 'answered HTTP 500 at laptop; not requested again at another screen size' }],
        oracle: { type: 'debug-log', value: 'Fatal error', defaulted: false, symptom: 'white-screen', result: 'yes', reason: 'a probed page answered HTTP 500 while debug.log gained no matching line (0 line(s) gained)' },
        debug_log: { new_bytes: 0, lines: 0 }
    }));
};
async function run(name, { verbose = false } = {}) {
    const root = path.join(tmp, name, 'wp'); build(root);
    const config = path.join(root, 'plugin-guard.config.json'); fs.writeFileSync(config, '{}');
    const issue = store.create({ title: 'Critical error', description: 'The site shows a critical error', symptom: 'white-screen', environment: 'local', url: EWS, root, pages: [], oracle: { type: 'debug-log', value: 'Fatal error', defaulted: false } });
    await evidence.run(issue.id, { root, probeOptions: { probe: false } });
    analysis.run(issue.id, { root, config });
    const dir = store.dirOf(issue.id);
    ewsProbe(dir);
    const val = validate.run(issue.id, { root, config, lint: () => ({ ok: true, message: '' }) });
    const policy = validate.policyFor(root, config), plans = resolve.build(issue.id, val, { root, policy, dir });
    result.write(issue.id, { validation: val, plans, dir, root, policy, gate: true, verbose });
    const R = n => fs.readFileSync(path.join(dir, 'result', n), 'utf8');
    return { id: issue.id, dir, val, plans, f: JSON.parse(R('findings.json')), md: R('ISSUE-REPORT.md'), html: R('issue.html') };
}
// the Markdown without the developer sections
const readerMd = md => md.split(/^(?=## )/m).filter(s => !/^## (What was checked|Limits)\b/.test(s)).join('');

(async () => {
    group('0b. the reader filter drops whole internal terms only');
    const hy = { checks: [{ id: 'x1', status: 'PASSED', reason: 'plugin Stored Products is active' }, { id: 'x2', status: 'PASSED', reason: 'the file was stored in uploads' }, { id: 'x3', status: 'FAILED', reason: 'the stored oracle answer did not match its recomputation' }, { id: 'oracle', status: 'FAILED', reason: 'plain' }], validation_notes: ['plugin Stored Products is active', 'the file was stored in uploads', 'the stored oracle answer did not match its recomputation'] };
    const rw = plain.readerWhy(hy), rv = plain.readerValidationLines({ checks: hy.checks, hypotheses: [{ status: 'UNVERIFIED', title: 't', validation_notes: hy.validation_notes }] }).join('\n');
    ok(rw.some(l => /Stored Products/.test(l)) && rw.some(l => /stored in uploads/.test(l)), "readerWhy keeps a line with a plugin named 'Stored Products' and one with 'stored' in normal prose");
    ok(!rw.some(l => /oracle|recomput/i.test(l)) && rw.length === 4, "readerWhy still drops the 'stored oracle answer ... recomputation' sentence and the oracle check");
    ok(/Stored Products/.test(rv) && /stored in uploads/.test(rv) && !/oracle|recomput/i.test(rv), 'readerValidationLines: same');
    group('0. the term list');
    console.log(`      ${TERMS.length} terms; allow-list: ${ALLOW.length} entr${ALLOW.length === 1 ? 'y' : 'ies'}`);
    ok(['oracle', 'bisect', 'sources', 'not-reproduced-cap', 'declaration-sites'].every(t => TERMS.includes(t)) && TERMS.some(t => t === 'support:') && TERMS.some(t => t === 'php-l:') && TERMS.includes('live-probe') && TERMS.includes('fatal-fresh'), 'the ids were collected from validate.js, fatal-recheck.js and probe.js');
    ok(ALLOW.every(a => a.length === 2 && a[1]), 'every allow-list entry has a reason');

    const base = await run('base');
    ok(base.val.oracle.stored === 'yes' && base.val.oracle.recomputed === 'could-not-test', 'fixture: stored oracle "yes", recomputed "could-not-test"');
    ok(base.f.likely && base.f.likely.length >= 0 && base.f.hypotheses.some(h => (h.validation_notes || []).some(n => /stored oracle answer/.test(n))), 'fixture: the validator did write the "stored oracle answer" note (kept in findings.json for developers)');
    ok(base.f.validation.checks.some(c => c.id === 'oracle' && c.status === 'FAILED') || base.val.checks.some(c => c.id === 'oracle' && c.status === 'FAILED'), 'fixture: the "oracle" check FAILED (kept for developers)');

    let pw = null; try { pw = require('../lib/playwright').load(); } catch { /* not installed */ }
    const haveBrowser = !!(pw && require('../lib/playwright').status().chromium);
    const browser = haveBrowser ? await pw.chromium.launch() : null;
    if (!browser) { console.log("SKIP  plugin-guard's own browser is not installed: the rendered-page part did not run"); skipped++; }

    for (const verbose of [false, true]) {
        const name = verbose ? 'gate + verbose' : 'gate';
        const r = verbose ? await run('verbose', { verbose: true }) : base;
        group(`${name}: data the reader sees`);
        scan(`${name}: Summary`, r.f.summary.text + '\n' + r.f.summary.lines.join('\n') + '\n' + r.f.summary.headline);
        scan(`${name}: Verdict`, [r.f.verdict.label, ...(r.f.verdict.notes || [])].join('\n'));
        scan(`${name}: What is wrong box`, r.f.what_is_wrong ? r.f.what_is_wrong.lines.join('\n') : '');
        scan(`${name}: advisories`, r.f.advisories.map(a => [a.title, a.cause, a.type_text, a.why_not_shown && a.why_not_shown.text].join(' ')).join('\n'));
        scan(`${name}: findings and most likely cause`, [...r.f.findings, ...(r.f.likely || [])].map(x => [x.title, x.cause, x.type_text, x.shown_because].join(' ')).join('\n'));
        group(`${name}: checkpoint step A2 (counts, list, empty Findings text, Verdict lines, log note)`);
        scan(`${name}: the Summary as the report prints it (counts sentence, log note)`, r.f.summary.report_lines.join('\n') + '\n' + r.f.summary.text_report);
        scan(`${name}: the Summary as the page prints it`, r.f.summary.lines_html.join('\n'));
        scan(`${name}: checkpoint counts and the list`, [r.f.checkpoint_text.sentence, ...r.f.checkpoint_text.lines].join('\n'));
        ok(!r.f.checkpoint_text.lines.length === !verbose, `${name}: the checkpoint list is in the reader text only with --verbose`);
        scan(`${name}: empty-Findings text`, r.f.findings_empty_text);
        scan(`${name}: Verdict cause line, confidence sentence, symptom, Tested and Fix lines`, [r.f.verdict_cause_line, r.f.confidence_text, r.f.symptom_text, r.f.tested_text, r.f.fix_text].filter(Boolean).join('\n'));
        scan(`${name}: the log note (both variants)`, [{ files: [{ truncated: true, bytes: 5 * 1048576 }], entries: [{ level: 'warning', count: 9 }] }, { files: [{ truncated: true, bytes: 5 * 1048576 }], entries: [{ level: 'fatal error', count: 9 }] }].map(plain.logNote).join('\n'));
        scan(`${name}: the resolution reader wording`, r.f.resolution.flatMap(x => [...(x.what_to_try || []), ...x.options.flatMap(o => [o.reader_title, o.reader_detail].filter(Boolean))]).join('\n'));
        group(`${name}: Markdown`);
        scan(`${name}: ISSUE-REPORT.md (without "What was checked" and "Limits")`, readerMd(r.md));
        // the lists of the gate Markdown ("All checks", "What was checked") are read too: no HTML entity (escaped once, with a backslash), no null / undefined, no raw status word
        const mdSec = h => (r.md.split(/^(?=## )/m).find(x => x.startsWith(`## ${h}`)) || '');
        for (const h of verbose ? ['All checks', 'What was checked'] : ['What was checked']) {
            const t = mdSec(h);
            ok(t.length > 0 && !/&gt;|&lt;|&amp;|\bnull\b|\bundefined\b/.test(t), `${name}: Markdown "${h}": no &gt; &lt; &amp; null undefined`);
        }
        ok(!/\b(NOT_RUN|PASSED|FAILED|SKIPPED|BLOCKED)\b/.test(mdSec('What was checked')), `${name}: Markdown "What was checked": no raw status word`);
        group(`${name}: command-line text`);
        const comps = []; // the gate branch of issue-cli prints the summary and the option titles; the validation lines come from the shared reader helper
        const cli = [r.f.summary.text, ...r.plans.flatMap(p => p.options.map(o => plain.plainText(o.title, comps)))].join('\n');
        scan(`${name}: summary and option titles`, cli);
        ok(typeof plain.readerValidationLines === 'function', 'the command line prints the validation through plain-names.readerValidationLines');
        if (typeof plain.readerValidationLines === 'function') scan(`${name}: the validation lines the command line prints`, plain.readerValidationLines(r.val).join('\n'));
        ok(/readerValidationLines/.test(read('lib/issue-cli.js')), 'issue-cli.js uses it in gate mode');
        if (browser) {
            group(`${name}: the rendered page`);
            const ctx = await browser.newContext({ serviceWorkers: 'block' }), page = await ctx.newPage();
            await page.route('**/*', rt => (rt.request().url().startsWith('file://') ? rt.continue() : rt.abort()));
            await page.goto('file://' + path.join(r.dir, 'result', 'issue.html'));
            const areas = await page.evaluate(() => ['summary', 'whatswrong', 'findings', 'advisories', 'verdict', 'resolution'].map(id => { const s = document.getElementById(id); return [id, s ? s.textContent.replace(/\n\s*\n+/g, '\n') : '']; }));
            for (const [id, t] of areas) scan(`${name}: page section "${id}" (closed "Why this status" lists included)`, t);
            ok(areas.find(a => a[0] === 'resolution')[1].includes('Why this status'), 'the "Why this status" list is on the page');
            await ctx.close();
        }
    }
    if (browser) await browser.close();

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(failures ? `\n${failures} FAILED` : `\nAll reader-wording checks passed${skipped ? ` (${skipped} part(s) skipped)` : ''}.`);
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
