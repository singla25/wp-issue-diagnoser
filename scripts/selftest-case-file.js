#!/usr/bin/env node
// REPORT-SPEC Part 1: the case-file layout of the gate report (issue/case-file.js): STATUS line, WHAT YOU SEE, Case 1 / Case 2 / (Case 3 hook), WHAT WAS CHECKED,
// FOR A DEVELOPER. Page, Markdown report and command-line summary are rendered from ONE object (findings.json case_file) and must agree.
// Fixture: the ews case, with the exact log line
//   PHP Fatal error:  Uncaught Error: Class "Elementor\Core\Schemes\Color" not found in .../themes/unicamp/elementor/widgets/original/heading.php:48
// Cases: positive (the ews line), negative (no log fatal), clean site, reader-facing term scan, gate-off layout, the site is not written, validate.js untouched. Offline. Fixtures only.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-casefile-'));
process.env.PLUGIN_GUARD_ISSUES = path.join(tmp, 'issues');
const store = require('../lib/issue-store');
const evidence = require('../issue/evidence'), analysis = require('../issue/analysis'), validate = require('../issue/validate'), resolve = require('../issue/resolve'), result = require('../issue/result');
const caseFile = require('../issue/case-file');
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

function build(root, { log = true, templates = 5, plugins = true } = {}) {
    w(root, 'wp-includes/version.php', "<?php\n$wp_version = '6.8.1';\n"); w(root, 'wp-config.php', '<?php\n');
    if (!plugins) { fs.mkdirSync(path.join(root, 'wp-content', 'plugins'), { recursive: true }); return; }
    w(root, 'wp-content/plugins/elementor/elementor.php', '<?php\n/**\n * Plugin Name: Elementor\n * Version: 3.35.7\n */\nnamespace Elementor;\nclass Plugin {}\n');
    w(root, 'wp-content/themes/unicamp/style.css', '/*\nTheme Name: Unicamp\nVersion: 2.2.0\n*/');
    w(root, FILE, '<?php\n' + '// filler\n'.repeat(46) + `$c = \\${CLASS}::get_type();\n`);
    w(root, 'wp-content/plugins/woocommerce/woocommerce.php', '<?php\n/**\n * Plugin Name: WooCommerce\n * Version: 10.6.1\n */\n');
    for (let i = 1; i <= templates; i++) { w(root, `wp-content/plugins/woocommerce/templates/t${i}/t${i}.php`, '<?php\n/**\n * @version 9.0.0\n */\n'); w(root, `wp-content/themes/unicamp/woocommerce/t${i}/t${i}.php`, '<?php\n/**\n * @version 3.0.0\n */\n'); }
    if (!log) return;
    const at = stamp(new Date(Date.now() - 86400e3)), at2 = at.slice(0, -2) + String((Number(at.slice(-2)) + 1) % 60).padStart(2, '0');
    const one = t => `[${t} UTC] PHP Fatal error:  Uncaught Error: Class "${CLASS}" not found in ${root}/${FILE}:48\nStack trace:\n#0 {main}\n  thrown in ${root}/${FILE} on line 48\n`;
    w(root, 'wp-content/debug.log', one(at) + one(at2));
}
const ewsProbe = dir => {
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'issue.json'), 'utf8')); j.probe_ran_at = new Date().toISOString(); j.oracle = { type: 'debug-log', value: 'Fatal error', defaulted: false }; fs.writeFileSync(path.join(dir, 'issue.json'), JSON.stringify(j));
    const resp = { url: EWS, status: 500, type: 'document', same_site: true, source: { type: 'other', ref: null, name: 'localhost82.local.com' } };
    fs.writeFileSync(path.join(dir, 'work', 'probe.json'), JSON.stringify({
        schema: 1, planned: { pages: [EWS], viewports: ['laptop 1280x800'], loads: 1, notes: [] }, protection: null,
        pages: [{ console_errors: [], page_errors: [], error_responses: [resp], failed_requests: [], url: EWS, viewport: { name: 'laptop', width: 1280, height: 800 }, loaded: true, status: 500, first_status: 500, retried: false, outcome: 'server-error' }],
        oracle: { type: 'debug-log', value: 'Fatal error', defaulted: false, symptom: 'white-screen', result: 'yes', reason: 'a probed page answered HTTP 500' }, debug_log: { new_bytes: 0, lines: 0 }
    }));
};
const fingerprint = root => {
    const h = crypto.createHash('sha256');
    const walk = d => { for (const n of fs.readdirSync(d).sort()) { const p = path.join(d, n), st = fs.lstatSync(p); h.update(path.relative(root, p) + ':' + st.size + ':'); if (st.isDirectory()) walk(p); else h.update(fs.readFileSync(p)); } };
    walk(root); return h.digest('hex');
};
async function run(name, { gate = true, verbose = false, probe = false, ...o } = {}) {
    const root = path.join(tmp, name, 'wp'); build(root, o);
    const config = path.join(path.dirname(root), 'plugin-guard.config.json'); fs.writeFileSync(config, '{}');
    const before = fingerprint(root);
    const issue = store.create({ title: 'Critical error', description: 'The site shows a critical error', symptom: 'white-screen', environment: 'local', url: EWS, root, pages: [], oracle: { type: 'debug-log', value: 'Fatal error', defaulted: false } });
    await evidence.run(issue.id, { root, probeOptions: { probe: false } });
    analysis.run(issue.id, { root, config });
    const dir = store.dirOf(issue.id);
    if (probe) ewsProbe(dir);
    const val = validate.run(issue.id, { root, config, lint: () => ({ ok: true, message: '' }) });
    const policy = validate.policyFor(root, config), plans = resolve.build(issue.id, val, { root, policy, dir });
    const res = result.write(issue.id, { validation: val, plans, dir, root, policy, gate, verbose });
    const R = n => fs.readFileSync(path.join(dir, 'result', n), 'utf8');
    return { id: issue.id, dir, root, res, plans, same: before === fingerprint(root), f: JSON.parse(R('findings.json')), md: R('ISSUE-REPORT.md'), html: R('issue.html') };
}
const cliText = (r, verbose) => { const out = []; cli.printGate(r.res, r.plans, { gate: true, verbose }, t => out.push(t), r.dir); return out.join('\n'); };

// every string the reader can see in the case file
const strings = cf => [cf.title, cf.status.line, cf.status.looked, cf.status.note, ...cf.see, ...cf.cases.flatMap(c => [c.heading, ...c.rows.flatMap(([k, v]) => [k, ...v])]), cf.checked && cf.checked.line, cf.checked && cf.checked.sentence, cf.checked && cf.checked.legend, ...(cf.checked ? cf.checked.items : [])].filter(Boolean).join('\n');
// internal words that must never reach the reader (whole terms; "gate" and "null" included on purpose)
const INTERNAL = [/\b(theme|mu|plugin):[a-z0-9._-]+/i, /PROBABLE[ _]NEEDS[ _]REVIEW/i, /\boracle\b/i, /\brecomput\w*/i, /\bNOT_RUN\b/, /\bgate\b/i, /\bnull\b/, /\bundefined\b/, /\bNaN\b/, /\bhacked\b/i, /broken because of/i, /\b(UNVERIFIED|REPRODUCIBLE|REJECTED_FALSE_POSITIVE)\b|(?<!NOT )\bCONFIRMED\b/, /Confidence:/, /Nothing passed/i, /cp-\d+/];
const OLD_HEAD = /^#{1,3} (Findings|Verdict|What is wrong|Summary)\b/m;

(async () => {
    group('positive: the ews log line');
    const r = await run('ews', { probe: true });
    const cf = r.f.case_file;
    ok(cf && cf.status.line === '1 likely cause (not confirmed) · 1 thing to check · 0 confirmed', `STATUS line: ${cf && cf.status.line}`);
    ok(cf.status.looked === 'Looked at: your log, the live page, the code. Not looked at: a throwaway test copy.', `Looked at / Not looked at is built from what ran: ${cf.status.looked}`);
    ok(cf.see.includes('The live page answered HTTP 500.'), 'WHAT YOU SEE has the live check');
    const c1 = cf.cases[0], c2 = cf.cases[1];
    const row = (c, k) => ((c.rows.find(x => x[0] === k) || [0, []])[1]).join('\n');
    ok(c1.kind === 'likely' && c1.heading === 'Likely cause (not confirmed)' && /Elementor/.test(row(c1, 'Components')) && /the theme Unicamp 2\.2\.0/.test(row(c1, 'Components')), 'Case 1: Likely cause (not confirmed), components "the theme Unicamp 2.2.0" and "the plugin Elementor 3.35.7"');
    ok(!/WooCommerce/.test(row(c1, 'Components')), 'Case 1 does not list WooCommerce');
    ok(c2.kind === 'check' && c2.heading === 'Something else to check (probably not the crash)' && /the plugin WooCommerce 10\.6\.1/.test(row(c2, 'Components')) && /the theme Unicamp/.test(row(c2, 'Components')), 'Case 2: Something else to check (probably not the crash), components WooCommerce and Unicamp');
    ok(/5 templates/.test(row(c2, 'What')) && /t1\/t1\.php: the theme has version 3\.0\.0, the plugin has version 9\.0\.0/.test(row(c2, 'Files')) && /cart, checkout or layout/.test(row(c2, 'What can break')), 'Case 2 names the files, both versions and what can break');
    ok(/heading\.php, line 48/.test(row(c1, 'Where')) && /Found in your log 2 times, last seen \d+ \w+ \d{4}\./.test(row(c1, 'How sure')) && /The file and line were read again/.test(row(c1, 'How sure')) && /The live page answered HTTP 500\./.test(row(c1, 'How sure')) && /Not confirmed by a second, independent test\./.test(row(c1, 'How sure')), 'Case 1: where (file, line) and how sure (log count, last seen, re-read, live result, "Not confirmed by a second, independent test.")');
    ok(/not two plugins or two pieces of code fighting over the same WordPress step/.test(row(c1, 'Why')) && /Elementor 3\.35\.7 does not contain it/.test(row(c1, 'Why')), 'Case 1 Why: says plainly that it is not a hook / two-plugin conflict, and what the installed plugin has');
    ok(r.f.summary.lines.some(l => l.trim() === 'The class: Elementor 3.35.7 does not contain it (every PHP file of the copy was read). This usually means the theme was written for an older version of Elementor.') && c1.rows.find(x => x[0] === 'Why')[1].includes('The class: Elementor 3.35.7 does not contain it (every PHP file of the copy was read). This usually means the theme was written for an older version of Elementor.'), 'the cause sentence is the same in Case 1 and in the summary line (nine fixes (b))');
    ok(!/Confidence:/.test(strings(cf)) && !/Nothing passed the gate/i.test(r.md + r.html.replace(/<script[\s\S]*?<\/script>/g, '')), 'no "Confidence: low", no "Nothing passed the gate" (nine fixes (a), (f))');
    ok(r.f.verdict.confidence === 'low' && r.f.verdict.label === 'Most likely cause found in your log (not confirmed)' && r.f.what_is_wrong.tier === 'likely' && r.f.hypotheses.some(h => h.status === 'PROBABLE_NEEDS_REVIEW'), 'findings.json keeps every internal field and label (verdict, box, statuses)');
    ok(!cf.cases.some(c => c.kind === 'signs') && !/Signs that a copy was modified/.test(r.md), 'Case 3 (modified copy) is not rendered when there is no data');

    group('one object, three renderings: Markdown, command line, page');
    const cl = cliText(r, false);
    ok(r.md.includes(`**${cf.status.line}**`) && cl.includes(cf.status.line) && r.f.summary.text_report.includes(cf.status.line), 'the Markdown, the command line and findings.json carry the same STATUS line');
    ok(r.md.includes('## Case 1: Likely cause (not confirmed)') && r.md.includes('## Case 2: Something else to check (probably not the crash)') && cl.includes('CASE 1  LIKELY CAUSE (NOT CONFIRMED)') && cl.includes('CASE 2  SOMETHING ELSE TO CHECK (PROBABLY NOT THE CRASH)'), 'both name Case 1 and Case 2 with the one phrase');
    ok(!OLD_HEAD.test(r.md) && !/^(Findings|Verdict|What is wrong|Summary)$/m.test(cl), 'the old "Findings", "Verdict", "What is wrong" and "Summary" headings are gone from the Markdown and the command line');
    ok(/## What was checked\n\n26 pass · 3 fail · 23 not checked · 1 also noticed\n/.test(r.md.replace(/\d+ pass · \d+ fail · \d+ not checked · \d+ also noticed/, '26 pass · 3 fail · 23 not checked · 1 also noticed')) && new RegExp(`${r.f.checkpoints.counts.pass} pass · ${r.f.checkpoints.counts.fail} fail · ${r.f.checkpoints.counts.not_checked} not checked · ${r.f.checkpoints.counts.also_noticed} also noticed`).test(r.md), 'WHAT WAS CHECKED: "N pass · N fail · N not checked · N also noticed", equal to the JSON counts');
    ok(/Also noticed, probably not the crash:/.test(r.md) && !r.f.checkpoint_text.lines.length && !/All checks/.test(r.md), 'the fourth state reads "Also noticed, probably not the crash"; the full list only with --verbose');
    ok(/## For a developer/.test(r.md) && r.md.indexOf('## For a developer') > r.md.indexOf('## What was checked') && /Versions: theme Unicamp 2\.2\.0/.test(r.md.slice(r.md.indexOf('## For a developer'))), 'FOR A DEVELOPER holds what exists today (the technical lines)');
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
                sec: id => pg.evaluate(i => { const s = document.getElementById(i); return s ? s.textContent : null; }, id), body: await pg.evaluate(() => document.body.innerText), close: () => ctx.close() };
            return o;
        };
        const pr = await open(r);
        ok(pr.ids.slice(0, 4).join(',') === 'status,see,case-1,case-2' && pr.ids.includes('checked') && pr.ids.includes('developer') && !pr.ids.includes('summary') && !pr.ids.includes('findings') && !pr.ids.includes('whatswrong'), `page sections: ${pr.ids.slice(0, 7).join(', ')} ...`);
        ok((await pr.sec('status')).includes(cf.status.line) && (await pr.sec('case-1')).includes('Likely cause (not confirmed)') && (await pr.sec('case-1')).includes('Not confirmed by a second, independent test.') && (await pr.sec('case-2')).includes('WooCommerce'), 'the page shows the same STATUS line and the same cases');
        ok(!/--verbose|run with|run again/i.test(pr.body) && !/Confidence: /.test(pr.body), 'the page never tells a reader to run with --verbose and shows no "Confidence: low" (nine fixes (d), (f))');
        ok(pr.reqs.every(u => u.startsWith('file://')) && !pr.errs.length && !/\.innerHTML\s*=|insertAdjacentHTML/.test(r.html.replace(/<script type="application\/json"[\s\S]*?<\/script>/g, '')), 'the page is offline: no request left the file, no script error, no innerHTML');
        for (const t of strings(cf).split('\n').filter(l => /Likely cause|answered HTTP 500/.test(l))) ok(pr.body.includes(t), `the page carries: ${t.slice(0, 70)}`);
        await pr.close();
    }

    group('negative: no fatal in the log');
    const n = await run('nolog', { log: false, templates: 0 });
    ok(n.f.case_file.status.line === '0 likely cause · 0 confirmed. This does not mean the site is healthy.' && n.f.case_file.status.empty, `empty case: "${n.f.case_file.status.line}"`);
    ok(!n.f.case_file.cases.length && !n.f.likely && !n.f.what_is_wrong && n.md.includes('0 likely cause · 0 confirmed. This does not mean the site is healthy.') && cliText(n, false).includes('0 likely cause · 0 confirmed. This does not mean the site is healthy.'), 'no case; the Markdown and the command line say the same');
    ok(/Not looked at: your log, the live page, a throwaway test copy\./.test(n.f.case_file.status.looked) && /Looked at: the code\./.test(n.f.case_file.status.looked), `Looked at / Not looked at reflects that no log and no live check exist: ${n.f.case_file.status.looked}`);

    group('clean site');
    const cs = await run('clean', { plugins: false });
    ok(cs.f.case_file.status.line === caseFile.EMPTY_STATUS && !cs.f.case_file.cases.length && !/Likely cause/.test(cs.md), `clean site: "${cs.f.case_file.status.line}"`);
    ok(!OLD_HEAD.test(cs.md), 'and no old heading');

    group('Case 3 hook, status line wording');
    const mod = caseFile.build({ ...r.f, advisories: [], likely: [], findings: [], what_is_wrong: null, checkpoints: r.f.checkpoints, checkpoint_text: r.f.checkpoint_text }, { comps: [], facts: { hasCode: true }, modified: ['license check removed in a.php'] });
    ok(mod.cases.length === 1 && mod.cases[0].heading === 'Signs that a copy was modified' && /cannot be verified against the vendor/.test(mod.cases[0].rows[1][1][0]), 'Case 3 is rendered only when data is passed in, with the "cannot be verified" wording');
    ok(caseFile.statusLine({ likely: 2, check: 0, confirmed: 1 }) === '2 likely causes (not confirmed) · 0 thing to check · 1 confirmed' && caseFile.statusLine({ likely: 0, check: 2, confirmed: 0 }) === '0 likely cause · 2 things to check · 0 confirmed. This does not mean the site is healthy.', 'plural wording of the status line');

    group('a sandbox that could not run: the note reaches the Markdown, the command line and the page');
    const NOTE = 'Note: the sandbox test could not run, and this is no evidence either way: the plugins could not be switched on in it.';
    const sbf = { ...r.f, summary: { ...r.f.summary, lines: [...r.f.summary.lines, NOTE] } };
    const sbCtx = { comps: [], facts: { hasCode: true }, sandboxNote: sbf.summary.lines.find(l => /sandbox test could not run/.test(l)) };
    const sbCf = caseFile.build({ ...sbf, advisories: [], likely: [], findings: [], what_is_wrong: null }, sbCtx);
    ok(sbCf.status.sandbox_note === NOTE && caseFile.markdown(sbCf).join('\n').includes(NOTE) && caseFile.cli({ ...sbCf, checked: null }).includes(NOTE), 'case file: the note is in the Markdown and the command-line text, same sentence as the summary line');
    ok(!cf.status.sandbox_note && !/sandbox test could not run/.test(r.md), 'and absent when the sandbox did not fail');
    ok(/sandbox_note/.test(fs.readFileSync(path.join(__dirname, '..', 'lib', 'issue-html-gate.js'), 'utf8')) && /sandboxNote/.test(fs.readFileSync(path.join(__dirname, '..', 'issue', 'result.js'), 'utf8')), 'the page patch and result.js carry it (the real pipeline is covered by selftest-sandbox-failure)');

    group('reader-facing term scan');
    for (const [name, rr] of [['ews', r], ['no log', n], ['clean', cs]]) {
        const text = strings(rr.f.case_file) + '\n' + rr.md.split(/^## (?:What was checked|Limits|For a developer)\b/m)[0] + '\n' + rr.f.summary.text_report;
        const bad = INTERNAL.filter(re => re.test(text)).map(String);
        ok(!bad.length, `${name}: no internal word in the case file, the Markdown (without the steps / developer / Limits) or the command-line summary${bad.length ? ' -> ' + bad.join(' ') : ''}`);
    }
    const rv = await run('ews-verbose', { probe: true, verbose: true });
    ok(!INTERNAL.filter(re => re.test(strings(rv.f.case_file))).length && rv.f.case_file.checked.items.length === rv.f.checkpoints.items.length, 'with --verbose: the list is in the case file and has no internal word');

    group('gate off keeps the old layout; the site is not written; validate.js is untouched');
    const off = await run('ews-off', { probe: true, gate: false });
    ok(!off.f.case_file && off.md.startsWith('# Issue report: ') && off.md.includes('## Verdict') && !off.md.includes('## Status') && off.f.verdict.label !== r.f.verdict.label, 'gate off: no case file, the old Markdown (selftest-gate-output compares the recorded bytes)');
    ok(r.same && n.same && cs.same && off.same && rv.same, 'the site folder is byte-identical before and after (fingerprint of every file)');
    const again = await run('ews-again', { probe: true });
    const strip = o => JSON.stringify(o).replace(/iss-\d{8}-\d{6}-[0-9a-f]{6}/g, 'ID').replace(/\/ews[-a-z]*\//g, '/X/');
    ok(strip(again.f.case_file) === strip(r.f.case_file), 'the case file is deterministic (two runs, same bytes)');
    const repo = path.resolve(__dirname, '..', '..', '..');
    const inTree = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: repo });
    if (inTree.error || inTree.status !== 0) { console.log('SKIP  not inside a git work tree: the validate.js unmodified check did not run'); skipped++; }
    else {
        const git = spawnSync('git', ['diff', '--quiet', '--', 'src/plugin-guard/issue/validate.js', 'src/plugin-guard/issue/retest.js', 'src/plugin-guard/issue/fatal-recheck.js'], { cwd: repo });
        if (git.error) { console.log('SKIP  git is not available: the validate.js check did not run'); skipped++; } else ok(git.status === 0, 'validate.js, retest.js and fatal-recheck.js are unmodified (git diff --quiet)');
    }
    ok(!/case-file/.test(fs.readFileSync(path.join(__dirname, '..', 'issue', 'validate.js'), 'utf8')) && !/status\s*=/.test(fs.readFileSync(path.join(__dirname, '..', 'issue', 'case-file.js'), 'utf8')), 'case-file.js assigns no status and validate.js does not know it');

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(failures ? `\n${failures} FAILED` : `\nAll case-file checks passed${skipped ? ` (${skipped} part(s) skipped)` : ''}.`);
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
