#!/usr/bin/env node
// Step 7b: the gate wired into issue/result.js ({ gate: true, verbose }), the Markdown and HTML reports, and `issue investigate --gate [--verbose]`.
//  - gate off: the four result files are byte-identical to the golden copies recorded BEFORE this step (scripts/fixtures/issue/gate-off/)
//  - gate on: findings / advisories / summary / labels / causes / rollback; advisories only with --verbose; the empty case is never an empty report
//  - the HTML stays offline (no innerHTML, no external resources) and is checked in a real browser
// Offline fixtures only; the CLI is run as a child process with no terminal (so no questions are asked).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const pipe = require('./fixtures/issue/gate-pipeline');
const trees = require('./fixtures/issue/trees');
const GOLD = path.join(__dirname, 'fixtures', 'issue', 'gate-off');

let failures = 0, skipped = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const group = t => console.log(`\n== ${t}`);
const head = (n, x = '') => `<?php\n/**\n * Plugin Name: ${n}\n * Version: 1.0.0\n${x} */\n`;
const w = (root, rel, body) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); };
const base = root => { w(root, 'wp-config.php', '<?php\n'); w(root, 'wp-includes/version.php', "<?php\n$wp_version = '6.8.1';\n"); fs.mkdirSync(path.join(root, 'wp-admin'), { recursive: true }); };

// the fixtures: the existing duplicate-function tree (with a log), the same without the log, a clean site, and a shell in uploads
const T = {
    ...trees,
    // two CUSTOM plugins declaring the same function, and no log: the code analysis sees both sites (so it can be CONFIRMED) but nothing is seen to break
    dupNoLog: root => { base(root); const fn = (n, v) => head(n) + "defined( 'ABSPATH' ) || exit;\nfunction my_helper( $x ) {\n\treturn $x . '" + v + "';\n}\n"; w(root, 'wp-content/plugins/plugin-a/plugin-a.php', fn('Plugin A', 'a')); w(root, 'wp-content/plugins/plugin-b/plugin-b.php', fn('Plugin B', 'b')); return { config: { customPaths: ['wp-content/plugins/plugin-a', 'wp-content/plugins/plugin-b'] }, description: 'Fixture', symptom: 'white-screen' }; },
    clean: root => { base(root); w(root, 'wp-content/plugins/clean/clean.php', head('Clean') + "defined('ABSPATH') || exit;\nfunction clean_fn() {}\n"); return { config: { customPaths: ['wp-content/plugins/clean'] }, description: 'Something feels off', symptom: 'other' }; },
    shell: root => { base(root); w(root, 'wp-content/plugins/clean/clean.php', head('Clean') + "defined('ABSPATH') || exit;\nfunction clean_fn() {}\n"); w(root, 'wp-content/uploads/2026/shell.php', "<?php eval(base64_decode('ZWNobyAxOw==')); ?>"); return { config: { customPaths: [] }, description: 'Odd redirects to a strange site', symptom: 'other' }; }
};
const run = o => pipe.run({ trees: T, ...o });
const json = r => JSON.parse(r.files['findings.json']);

(async () => {
    group('gate off: byte-identical to the output recorded before step 7b');
    const off = await run({ tree: 'duplicateFunction' }), off2 = await run({ tree: 'duplicateFunction', result: { gate: false, verbose: true } });
    for (const f of ['findings.json', 'ISSUE-REPORT.md', 'issue.html', 'tasks.md']) {
        const gold = fs.readFileSync(path.join(GOLD, `${f}.golden`), 'utf8');
        ok(off.normalised[f] === gold, `${f}: no gate option -> identical to the golden copy (${gold.length} characters)`);
    }
    ok(['findings.json', 'ISSUE-REPORT.md', 'issue.html', 'tasks.md'].every(f => off2.normalised[f] === off.normalised[f]), 'gate: false (even with verbose: true) gives the same bytes as no option at all');
    const offJ = json(off);
    ok(!('findings' in offJ) && !('advisories' in offJ) && !('summary' in offJ) && !('gate' in offJ), 'findings.json has none of the new keys');

    group('gate on: findings and advisories, labels, causes, rollback (a duplicate function that the log also names)');
    const on = await run({ tree: 'duplicateFunction', result: { gate: true } }), onJ = json(on);
    ok(Array.isArray(onJ.findings) && Array.isArray(onJ.advisories) && onJ.summary && onJ.gate.enabled === true && onJ.gate.verbose === false, 'findings.json has findings, advisories, summary and gate');
    const f0 = onJ.findings[0];
    ok(onJ.findings.length >= 1 && f0.status === 'CONFIRMED' && f0.label && f0.cause && f0.rollback && f0.rollback.intro === 'Plugin Guard itself changed nothing on your website.' && f0.breaking_because.length >= 1, `a finding: status ${f0 && f0.status}, label ${f0 && f0.label}, cause "${f0 && f0.cause}", rollback and the reason it is breaking`);
    ok(f0.log_only === true && onJ.summary.headline.includes('found in your logs') && !onJ.summary.text.includes('breaks your website'), 'it rests on a log alone, so the summary says "found in your logs"');
    const nOn = JSON.parse(on.normalised['findings.json']), nOff = JSON.parse(off.normalised['findings.json']);
    ok(JSON.stringify(nOn.hypotheses) === JSON.stringify(nOff.hypotheses) && JSON.stringify(nOn.finding_ids) === JSON.stringify(nOff.finding_ids) && JSON.stringify(nOn.counts) === JSON.stringify(nOff.counts) && JSON.stringify(nOn.resolution.map(r => r.options.map(o => ({ ...o, undo: undefined })))) === JSON.stringify(nOff.resolution.map(r => r.options.map(o => ({ ...o, undo: undefined })))), 'hypotheses, their ids, their status counts and the fix options are untouched (paths normalised): the gate only labels and splits');
    ok(onJ.hypotheses.every(h => h.status === offJ.hypotheses.find(x => x.id === h.id).status), 'no status differs between gate off and gate on');
    ok(onJ.resolution.every(r => r.options.every(o => 'undo' in o)) && onJ.resolution.some(r => r.options.some(o => o.undo)), 'every fix option got undo text (null if the data has nothing to say)');
    ok(onJ.verdict.label === 'Confirmed cause found in your logs' && offJ.verdict.label !== onJ.verdict.label, 'the verdict follows the gate (a cause that rests on a log alone: "Confirmed cause found in your logs")');
    const md = on.files['ISSUE-REPORT.md'];
    ok(md.indexOf('## Summary') > 0 && md.indexOf('## Summary') < md.indexOf('## Findings') && !md.includes('## Advisories') && !md.includes('## Hypotheses'), 'Markdown: summary first, then findings, no advisories section and no full hypothesis list without --verbose');
    ok(/How to undo: Plugin Guard itself changed nothing on your website\./.test(md) && /Seen: a log error names /.test(md), 'Markdown: the undo line and the reason it is breaking are in the finding');
    const ver = await run({ tree: 'duplicateFunction', result: { gate: true, verbose: true } }), verJ = json(ver);
    ok(verJ.gate.verbose === true && ver.files['ISSUE-REPORT.md'].includes(`## Advisories (${verJ.advisories.length})`), 'with verbose: true the Markdown has the Advisories section');
    ok(JSON.stringify(verJ.advisories) === JSON.stringify(onJ.advisories) && JSON.stringify(verJ.findings) === JSON.stringify(onJ.findings), 'findings.json carries the same findings and advisories either way (verbose only changes what the reports show)');
    ok(on.files['tasks.md'].length <= off.files['tasks.md'].length, 'tasks.md is written only for what is shown');

    group('advisories only: a confirmed duplicate that nothing was seen to break');
    const adv = await run({ tree: 'dupNoLog', result: { gate: true } }), advJ = json(adv);
    ok(advJ.findings.length === 0 && advJ.advisories.some(a => a.type === 'duplicate-declaration' && a.status === 'CONFIRMED' && a.why_not_shown.primary === 'not-breaking'), 'CONFIRMED (two verified sites) but not breaking: an advisory with the reason "not-breaking"');
    ok(advJ.summary.headline === 'No confirmed breaking cause was found.' && /possible causes? (is|are) listed under Advisories \(run with --verbose to see (it|them)\)\./.test(advJ.summary.text) && /no live check or sandbox test was run/.test(advJ.summary.text), 'summary: "No confirmed breaking cause was found." + the Advisories line + the "no live check" sentence');
    const advMd = adv.files['ISSUE-REPORT.md'];
    ok(!advMd.includes('Findings (0)') && /^## Findings$/m.test(advMd) && advMd.includes('_None: nothing passed the gate'), 'Markdown: an empty Findings heading has no (0); it says so and is not empty');
    ok(!advMd.includes('Duplicate declaration') && !advMd.toLowerCase().includes('is declared in'), 'Markdown without --verbose does not print the advisory');
    const advV = await run({ tree: 'dupNoLog', result: { gate: true, verbose: true } });
    ok(/not shown because it is confirmed, but no effect on the site was seen/.test(advV.files['ISSUE-REPORT.md']), 'with verbose the advisory is listed with the plain reason');
    const advTasks = (await run({ tree: 'dupNoLog', result: {} })).files['tasks.md'];
    ok(!/### ☐ T-0/.test(adv.files['tasks.md']) && adv.files['tasks.md'].length <= advTasks.length, 'tasks.md is written only for what is shown (an advisory gets no task without --verbose)');

    group('empty: a clean site');
    const emp = await run({ tree: 'clean', result: { gate: true } }), empJ = json(emp);
    ok(empJ.findings.length === 0 && empJ.advisories.length === 0, 'no finding and no advisory');
    ok(empJ.summary.lines.join('\n') === ['No confirmed breaking cause was found.', 'Nothing else stood out.', 'Note: no live check or sandbox test was run, so nothing here was seen failing on your website.', 'This does not mean the site is healthy.'].join('\n'), 'the summary: "No confirmed breaking cause was found." "Nothing else stood out." the no-check note and "This does not mean the site is healthy."');
    ok(emp.files['ISSUE-REPORT.md'].includes('## Summary') && emp.files['ISSUE-REPORT.md'].includes('No confirmed breaking cause was found.') && empJ.verdict.label === 'No confirmed breaking cause was found', 'the Markdown report is not empty: it says what was (not) found; the verdict says it too');

    group('compromise: always shown');
    const sh = await run({ tree: 'shell', result: { gate: true } }), shJ = json(sh);
    ok(shJ.findings.length >= 1 && shJ.findings.every(f => f.label === 'compromise') && shJ.findings.every(f => f.class === 'compromise'), 'compromise signs are findings (without --verbose)');
    ok(shJ.summary.text.includes('Possible compromise signs were found (pattern match, not proof).') && shJ.summary.text.includes('wp-content/uploads/2026/shell.php') && shJ.summary.text.includes('Do not delete files yourself; ask your host or a security professional to check, and keep a backup.') && !/hacked|your site is (infected|compromised)/i.test(sh.files['ISSUE-REPORT.md'] + sh.files['issue.html']) && !/malware/i.test(shJ.summary.text + sh.files['ISSUE-REPORT.md']), 'the cautious wording, the file and the advice; never "hacked" (and no "malware" in the summary or the Markdown)');
    ok(sh.files['ISSUE-REPORT.md'].includes('Possible compromise signs were found in wp-content/uploads/2026/shell.php (pattern match, not proof)'), 'Markdown: the finding names the file');

    group('single-plugin bisection (crafted sandbox data)');
    {
        const r0 = await run({ tree: 'clean', result: {} });
        const work = f => path.join(r0.dir, 'work', f);
        fs.writeFileSync(work('sandbox.json'), JSON.stringify({ steps: [{ id: 'sandbox-oracle', label: 'Oracle in the sandbox', status: 'PASSED', reason: null }], sandbox: null, reproduced_in_sandbox: 'yes', baseline: { result: 'yes', matches: [{ detail: 'HTTP 500' }] }, redirect_observed: false }));
        const hyp = { id: 'hyp-bis', type: 'bisect-minimal-set', title: 'Bisect', family: 'bisect', components: ['clean'], status: 'REPRODUCIBLE', score: 9, supports: [{ kind: 'bisect', ref: 'bisect:clean' }], contradicts: [], score_breakdown: [], oracle: {}, checks: [], validation_notes: [], independent_kinds: ['bisect'], ownership: [], fix_eligible: false, mechanism: 'In a throwaway copy the symptom appears exactly when clean is active.', evidence: [], kb: [], kb_verified: null, kb_sources: [], advisory: false, class: null };
        const issueNow = r0.store.load(r0.id); issueNow.oracle = { type: 'http-5xx', value: null, defaulted: true }; r0.store.save(issueNow);
        const resMod = require('../issue/result');
        const out = resMod.write(r0.id, { validation: { ...r0.validation, hypotheses: [hyp] }, plans: [], dir: r0.dir, root: r0.root, policy: null, gate: true });
        const fj = out.findings, md1 = fs.readFileSync(path.join(r0.dir, 'result', 'ISSUE-REPORT.md'), 'utf8');
        const f = fj.findings[0];
        ok(f && f.label === 'unclassified' && /caused by plugin Clean \(conflict partner not identified\)/.test(f.cause), `one plugin: the label stays "${f && f.label}" in the data and the cause reads "${f && f.cause}"`);
        ok(fj.verdict.label === 'Confirmed breaking cause found' && /aused by plugin Clean \(conflict partner not identified\)/.test(md1) && fj.summary.headline === 'We found 1 confirmed cause that breaks your website.' && !/found in your logs/.test(fj.summary.text), 'the report says "caused by plugin Clean (conflict partner not identified)" and, as the sandbox saw it, "breaks your website"');
        ok(!fj.summary.text.includes('no live check or sandbox test was run'), 'the sandbox ran: no "no live check" sentence');
    }

    group('the HTML report stays offline and is checked in a real browser');
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'issue-html-client.js'), 'utf8').replace(/\/\/.*$/gm, '');
    ok(!/\binnerHTML\b|\bouterHTML\b|insertAdjacentHTML|document\.write|\beval\(|new Function|\bfetch\(|XMLHttpRequest|importScripts|\.src\s*=/.test(src), 'the client script has no innerHTML, document.write, eval, fetch or script loading');
    for (const [name, r] of [['gate on', on], ['gate on + verbose', ver], ['empty', emp], ['compromise', sh]]) ok(!/(src|href)\s*=\s*["']https?:/i.test(r.files['issue.html']) && !/<link\b|<iframe|<img[^>]+src=["']http/i.test(r.files['issue.html']) && /Content-Security-Policy[^>]*default-src 'none'/.test(r.files['issue.html']), `${name}: no external address in src / href, no link or iframe, a strict Content-Security-Policy`);
    let pw = null; try { pw = require('../lib/playwright').load(); } catch { /* not installed */ }
    if (!pw || !require('../lib/playwright').status().chromium) { console.log('SKIP  plugin-guard\'s own browser is not installed: the browser part did not run'); skipped++; }
    else {
        const browser = await pw.chromium.launch();
        const open = async (r) => {
            const ctx = await browser.newContext({ serviceWorkers: 'block' }), page = await ctx.newPage(), reqs = [], errs = [];
            page.on('pageerror', e => errs.push(e.message));
            await page.route('**/*', route => { reqs.push(route.request().url()); return route.request().url().startsWith('file://') ? route.continue() : route.abort(); });
            const file = path.join(r.dir, 'result', 'issue.html');
            await page.goto('file://' + file);
            const ids = await page.evaluate(() => [...document.querySelectorAll('main section')].map(s => s.id));
            const text = await page.evaluate(() => document.body.innerText);
            await ctx.close();
            return { ids, text, reqs, errs, file };
        };
        const a = await open(on), b = await open(ver), c = await open(emp), d = await open(sh), g = await open(off);
        ok(a.ids[0] === 'summary' && a.ids[1] === 'findings' && a.ids.indexOf('verdict') > a.ids.indexOf('findings') && !a.ids.includes('advisories'), `gate on: sections come summary, findings, verdict ...; no advisories section (${a.ids.slice(0, 4).join(', ')})`);
        ok(b.ids.includes('advisories') && b.ids.indexOf('advisories') === 2, 'gate on + verbose: an advisories section follows the findings');
        ok(a.text.includes(onJ.summary.headline) && a.text.includes(f0.cause.charAt(0).toUpperCase() + f0.cause.slice(1)) && a.text.includes('Plugin Guard itself changed nothing on your website.'), 'the page shows the summary, the plain cause and the undo line');
        ok(c.text.includes('No confirmed breaking cause was found.') && c.text.includes('This does not mean the site is healthy.') && c.text.includes('Nothing passed the gate'), 'empty case in the browser: never an empty page');
        ok(d.ids.includes('findings') && d.text.includes('Possible compromise signs were found (pattern match, not proof).'), 'compromise is shown in the browser without --verbose');
        ok(!g.ids.includes('summary') && !g.ids.includes('findings') && g.ids[0] === 'verdict', 'gate off: the page has the old sections only (verdict first)');
        ok([a, b, c, d, g].every(x => x.reqs.every(u => u.startsWith('file://')) && x.errs.length === 0), 'no request left the file and the page raised no script error (5 pages)');
        await browser.close();
    }

    group('the command line: issue investigate --gate [--verbose]');
    {
        const issues = path.join(os.tmpdir(), `pg-gate-cli-${process.pid}`); fs.mkdirSync(issues, { recursive: true });
        const root = path.join(issues, 'wp'); const cfg = T.dupNoLog(root); fs.writeFileSync(path.join(root, 'plugin-guard.config.json'), JSON.stringify(cfg.config));
        const env = { ...process.env, PLUGIN_GUARD_ISSUES: path.join(issues, 'i'), NO_COLOR: '1' };
        const cli = (...a) => spawnSync(process.execPath, [path.join(__dirname, 'guard.js'), ...a], { encoding: 'utf8', env, input: '', timeout: 240000 });
        const made = cli('issue', 'new', '--no-prompt', '--title', 'CLI gate fixture', '--description', 'fixture', '--symptom', 'white-screen', '--env', 'local', '--url', 'http://127.0.0.1:9/', '--pages', '/', '--root', root);
        const id = (/iss-\d{8}-\d{6}-[0-9a-f]{6}/.exec(made.stdout) || [])[0];
        ok(!!id, `an issue was created through the command line (${id || made.stderr.slice(0, 120)})`);
        const plain = cli('issue', 'investigate', id, '--root', root, '--no-probe');
        ok(plain.status === 0 && /VERDICT: /.test(plain.stdout) && !/listed under Advisories/.test(plain.stdout) && !/Confirmed breaking cause found/.test(plain.stdout) && /Hypotheses \(/.test(plain.stdout), 'default `issue investigate` (no --gate): the same technical output as before, no summary block');
        const g1 = cli('issue', 'investigate', id, '--root', root, '--no-probe', '--gate');
        ok(g1.status === 0 && /No confirmed breaking cause was found\./.test(g1.stdout) && /listed under Advisories \(run with --verbose to see (it|them)\)\./.test(g1.stdout) && !/Evidence for iss-/.test(g1.stdout) && !/not verified: /.test(g1.stdout) && /\(run again with --verbose to list the Advisories\)/.test(g1.stdout) && !/Hypotheses \(\d/.test(g1.stdout), '--gate: the plain summary, a pointer to --verbose, and the technical lists are hidden');
        const g2 = cli('issue', 'investigate', id, '--root', root, '--no-probe', '--gate', '--verbose');
        ok(g2.status === 0 && /Hypotheses \(\d/.test(g2.stdout) && /Evidence for iss-/.test(g2.stdout) && /listed under Advisories/.test(g2.stdout) && !/\(run again with --verbose/.test(g2.stdout), '--gate --verbose: the technical lists are back and the pointer is gone');
        const md2 = fs.readFileSync(path.join(env.PLUGIN_GUARD_ISSUES, id, 'result', 'ISSUE-REPORT.md'), 'utf8');
        ok(md2.includes('## Advisories (') , 'the last run (--gate --verbose) wrote the Advisories section');
        fs.rmSync(issues, { recursive: true, force: true });
    }

    for (const r of [off, off2, on, ver, adv, advV, emp, sh]) fs.rmSync(r.tmp, { recursive: true, force: true });
    console.log(failures ? `\n${failures} check(s) FAILED` : `\nAll checks passed${skipped ? ` (${skipped} skipped)` : ''}`);
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
