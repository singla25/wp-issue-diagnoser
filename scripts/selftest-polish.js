#!/usr/bin/env node
// Report polish for a reader who is not technical: one phrase for the most likely cause, no internal ids in reader text, merged advisories in the
// components table, "Not tested" limited to what was asked, the environment guess from a read-only DNS lookup (fake resolver, offline), and the
// backup question only after the sandbox was chosen. Every report case uses the exact ews log line (heading.php:48, class Elementor\Core\Schemes\Color).
// Offline. Fixtures only.
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-polish-'));
process.env.PLUGIN_GUARD_ISSUES = path.join(tmp, 'issues');
const store = require('../lib/issue-store');
const evidence = require('../issue/evidence'), analysis = require('../issue/analysis'), validate = require('../issue/validate'), resolve = require('../issue/resolve'), result = require('../issue/result');
const plain = require('../lib/plain-names');
const { envGuess, envGuessResolved, isPrivateAddress } = require('../lib/env-guess');

let failures = 0, skipped = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const group = t => console.log(`\n== ${t}`);
const w = (root, rel, body = '<?php\n') => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); };
const CLASS = 'Elementor\\Core\\Schemes\\Color';
const FILE = 'wp-content/themes/unicamp/elementor/widgets/original/heading.php';
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const stamp = d => `${String(d.getUTCDate()).padStart(2, '0')}-${MON[d.getUTCMonth()]}-${d.getUTCFullYear()} ${d.toISOString().slice(11, 19)}`;

function build(root, o = {}) {
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
async function run(name, { verbose = false, images = false, sandboxStep = null } = {}) {
    const root = path.join(tmp, name, 'wp'); build(root);
    const config = path.join(root, 'plugin-guard.config.json'); fs.writeFileSync(config, '{}');
    const issue = store.create({ title: 'Critical error', description: 'The site shows a critical error', symptom: 'white-screen', environment: 'local', url: 'http://127.0.0.1:9/ews/', root, pages: [] });
    await evidence.run(issue.id, { root, probeOptions: { probe: false } });
    analysis.run(issue.id, { root, config });
    const dir = store.dirOf(issue.id);
    fs.writeFileSync(path.join(dir, 'work', 'intake.json'), JSON.stringify({ php_skipped: 1, php_skipped_examples: ['wp-content/plugins/x/.github/a.php'], steps: [
        { id: 'original-public', label: 'Are the originals of the screenshots public?', status: 'NOT_RUN', reason: 'no screenshot came from inside the WordPress folder' },
        { id: 'image-diff', label: 'Screenshot comparison (expected vs actual)', status: 'NOT_RUN', reason: 'no image pair was given' }] }));
    if (sandboxStep) fs.writeFileSync(path.join(dir, 'work', 'sandbox.json'), JSON.stringify({ reproduced_in_sandbox: null, steps: [sandboxStep] }));
    const val = validate.run(issue.id, { root, config, lint: () => ({ ok: true, message: '' }) });
    const policy = validate.policyFor(root, config), plans = resolve.build(issue.id, val, { root, policy, dir });
    result.write(issue.id, { validation: val, plans, dir, root, policy, gate: true, verbose });
    const R = n => fs.readFileSync(path.join(dir, 'result', n), 'utf8');
    return { id: issue.id, dir, f: JSON.parse(R('findings.json')), md: R('ISSUE-REPORT.md'), html: R('issue.html'), plans };
}
const NOSANDBOX = { id: 'sandbox', label: 'Sandbox (throwaway copy in Docker)', status: 'NOT_RUN', reason: 'not requested: add --sandbox (needs Docker and a local copy of the site)' };
const BAD = [/theme:/i, /\bplugin theme\b/i, /PROBABLE NEEDS REVIEW/, /PROBABLE_NEEDS_REVIEW/, /Findings \(0\)/];

(async () => {
    group('1. one phrase for the most likely cause');
    const r = await run('likely', { sandboxStep: NOSANDBOX });
    const PH = 'Most likely cause found in your log (not confirmed)';
    ok(plain.LIKELY_PHRASE === PH, 'the shared constant is the one phrase');
    ok(r.f.likely && r.f.likely.length === 1 && r.f.what_is_wrong && r.f.what_is_wrong.tier === 'likely', 'the ews line gives a most likely cause and the box');
    ok(r.f.summary.headline === PH && r.f.summary.lines[0] === PH, 'the Summary says the one phrase');
    ok(r.f.verdict.label === PH, 'the Verdict says the one phrase');
    ok(!r.f.summary.text.includes('No confirmed breaking cause was found') && !r.md.includes('No confirmed breaking cause was found') && !r.html.includes('No confirmed breaking cause was found'), 'never "No confirmed breaking cause was found" next to the same item');
    ok(r.md.includes(r.f.case_file.cases[0].heading) && r.f.case_file.cases[0].heading === PH.replace(/^Most likely cause found in your log/, 'Likely cause'), 'the Markdown carries the phrase (the case heading, derived from the data and from PH)');
    const none = await run('none-is-unchanged', {}); // same site; the wording without a log-backed cause is checked on the summary module directly
    const sum = require('../issue/summary').summarise({ findings: [], advisories: [], counts: {} }, { ran: {} });
    ok(sum.headline === 'No confirmed breaking cause was found.', 'with no log-backed likely cause the old wording stays');
    ok(none.f.summary.headline === PH, 'a second run of the same site gives the same headline');

    group('3. no internal ids in reader text');
    const parts = { 'summary': r.f.summary.text, 'markdown': r.md, 'box': r.f.what_is_wrong.lines.join('\n'), 'hypothesis titles (plain_text)': r.f.plain_text.map(p => p[1]).join('\n'), 'advisories': r.f.advisories.map(a => a.title + ' ' + a.cause).join('\n'), 'components': r.f.components.map(c => c.label + ' ' + c.in_hypotheses.join(' ')).join('\n'), 'advisory/finding causes': [...r.f.advisories, ...r.f.findings, ...r.f.likely].map(x => x.cause + ' ' + x.title).join('\n') };
    for (const [k, t] of Object.entries(parts)) ok(BAD.every(re => !re.test(t)), `${k}: no theme:x, "plugin theme:x", PROBABLE NEEDS REVIEW or Findings (0)`);
    ok(r.f.plain_text.some(p => p[0] === 'Missing function or class: theme:unicamp' && p[1] === 'Missing function or class: the theme Unicamp'), '"Missing function or class: the theme Unicamp"');
    ok(r.f.plain_text.some(p => p[1] === 'Outdated template override: the theme Unicamp and the plugin WooCommerce'), '"the theme Unicamp and the plugin WooCommerce" (name from the header)');
    ok(r.f.components.some(c => c.ref === 'theme:unicamp' && c.label === 'the theme Unicamp') && r.f.components.some(c => c.ref === 'woocommerce' && c.label === 'the plugin WooCommerce'), 'technical refs stay in findings.json; each component has a plain label');
    ok(r.f.hypotheses.every(h => h.status && /^[A-Z_]+$/.test(h.status)) && r.f.hypotheses.some(h => (h.components || []).includes('theme:unicamp') && /theme:unicamp/.test(h.title)), 'statuses, hypothesis titles and component ids stay technical in findings.json');
    ok(plain.statusWord('PROBABLE_NEEDS_REVIEW') === 'Needs review', 'status word: "Needs review"');
    ok(plain.plainRef('theme:some-theme', {}) === 'the theme Some Theme' && plain.plainRef('woocommerce', {}) === 'the plugin Woocommerce', 'no header name known: the folder name, capitalised');
    ok(!/Findings \(0\)/.test(r.md) && /^## Status$/m.test(r.md), 'Markdown: no "Findings (0)" heading; the Status heading replaces it');
    ok(!/broken because|is hacked/i.test(r.md + r.f.summary.text) && !/used to exist|no longer exist/i.test(r.md + r.f.summary.text), 'no "broken because", "hacked" or "the class used to exist"');
    // the command line text (the gate branch prints the summary and the option titles)
    const cliText = r.f.summary.text + '\n' + r.plans.flatMap(p => p.options).map(o => plain.plainText(o.title, [{ ref: 'theme:unicamp', name: 'Unicamp', slug: 'unicamp' }, { ref: 'woocommerce', name: 'WooCommerce', slug: 'woocommerce' }])).join('\n');
    ok(BAD.every(re => !re.test(cliText)), 'command-line text: none of the internal ids');
    // the rendered page
    let pw = null; try { pw = require('../lib/playwright').load(); } catch { /* not installed */ }
    if (!pw || !require('../lib/playwright').status().chromium) { console.log("SKIP  plugin-guard's own browser is not installed: the rendered-page part did not run"); skipped++; }
    else {
        const browser = await pw.chromium.launch();
        for (const [name, run0] of [['gate', r], ['gate + verbose', await run('likely-v', { verbose: true, sandboxStep: NOSANDBOX })]]) {
            const ctx = await browser.newContext({ serviceWorkers: 'block' }), page = await ctx.newPage();
            await page.route('**/*', rt => (rt.request().url().startsWith('file://') ? rt.continue() : rt.abort()));
            await page.goto('file://' + path.join(run0.dir, 'result', 'issue.html'));
            const text = await page.evaluate(() => document.body.innerText);
            const labels = await page.evaluate(() => [...document.querySelectorAll('[aria-label]')].map(e => e.getAttribute('aria-label')).join('\n'));
            ok(BAD.every(re => !re.test(text + labels)), `rendered page (${name}): no internal ids`);
            ok(text.includes(PH), `rendered page (${name}): the one phrase`);
            const comp = await page.evaluate(() => (document.querySelector('#components table') || { innerText: '' }).innerText);
            ok(/the theme Unicamp/i.test(comp) && (comp.match(/Outdated template override/g) || []).length === 2, `rendered page (${name}): components table merges the repeated advisory (once per component)`);
            const nt = await page.evaluate(() => { const dts = [...document.querySelectorAll('#verdict dt')]; const d = dts.find(x => x.textContent === 'Not tested'); return d ? d.nextSibling.innerText : ''; });
            if (name === 'gate') ok(!/Screenshot comparison|originals of the screenshots/.test(nt) && !/Sandbox/.test(nt), 'rendered page: "Not tested" has no screenshot comparison, originals or sandbox that nobody asked for');
            else ok(/Screenshot comparison/.test(nt) && /originals of the screenshots/.test(nt), 'rendered page with --verbose: everything shows');
            await ctx.close();
        }
        await browser.close();
    }

    group('4. the components table merges the repeated advisory');
    ok(r.f.advisories.filter(a => a.type === 'template-override-outdated').length === 1, 'the advisories list has it once (existing merge)');
    ok(r.f.components.every(c => c.in_hypotheses.filter(t => /^Outdated template override/.test(t)).length <= 1), 'each component lists it once');
    ok(r.f.components.find(c => c.ref === 'woocommerce').in_hypotheses.some(t => /^Outdated template override: the theme Unicamp and the plugin WooCommerce \(\d+ templates\)$/.test(t)), 'with its count: (N templates)');

    group('5. "Not tested" shows only what is tied to the answer');
    const T = [{ id: 'original-public', label: 'orig', status: 'NOT_RUN', reason: 'x' }, { id: 'image-diff', label: 'diff', status: 'NOT_RUN', reason: 'x' }, { id: 'sandbox', label: 'sbx', status: 'NOT_RUN', reason: 'not requested: add --sandbox' }, { id: 'oracle', label: 'Oracle', status: 'NOT_RUN', reason: 'could not run' }, { id: 'logs', label: 'log', status: 'BLOCKED', reason: 'unreadable' }];
    const ids = o => plain.notTested(T, o).map(t => t.id).join(',');
    ok(ids({}) === 'oracle,logs', 'default: the symptom check and the log check stay; screenshot comparison, originals and an unasked sandbox are dropped');
    ok(ids({ hasScreenshots: true }) === 'image-diff,oracle,logs', 'screenshots given: the comparison shows');
    const T2 = T.map(t => (t.id === 'sandbox' ? { ...t, status: 'BLOCKED', reason: 'Docker is not usable' } : t));
    ok(plain.notTested(T2, {}).map(t => t.id).join(',') === 'original-public,sandbox,oracle,logs', 'sandbox asked (and failed): the sandbox and the originals check show');
    ok(ids({ verbose: true }) === 'original-public,image-diff,sandbox,oracle,logs', '--verbose: everything shows');
    ok(!/Screenshot comparison|originals of the screenshots/.test(r.md.split('## What was checked')[1] || ''), 'Markdown "What was checked": the unasked steps are gone');
    ok(r.f.not_tested.join(',') === '' || !r.f.not_tested.includes('image-diff'), 'findings.json lists the kept ids');
    const rv = await run('verbose-md', { verbose: true, sandboxStep: NOSANDBOX });
    ok(/Screenshot comparison/.test(rv.md), 'Markdown with --verbose: everything shows');

    group('6. environment guess: read-only name lookup (fake resolver, offline)');
    const fake = map => async h => { if (!(h in map)) throw new Error('ENOTFOUND'); return map[h]; };
    const G = async (u, map) => (await envGuessResolved({ url: u }, { resolve: fake(map || {}) }));
    ok((await G('http://localhost82.local.com/ews/', { 'localhost82.local.com': ['127.0.0.1'] })).kind === 'local', 'localhost82.local.com -> 127.0.0.1 is local');
    ok((await G('https://a.example.com/', { 'a.example.com': ['10.1.2.3'] })).kind === 'local', '10.x is local');
    ok((await G('https://b.example.com/', { 'b.example.com': ['192.168.1.9'] })).kind === 'local' && (await G('https://c.example.com/', { 'c.example.com': ['172.20.0.5'] })).kind === 'local', '192.168.x and 172.16/12 are local');
    ok((await G('https://d.example.com/', { 'd.example.com': ['::1'] })).kind === 'local' && (await G('https://e.example.com/', { 'e.example.com': ['fd12::1'] })).kind === 'local' && (await G('https://f.example.com/', { 'f.example.com': ['fe80::1'] })).kind === 'local', '::1, fc00::/7 and fe80::/10 are local');
    ok((await G('https://shop.example.com/', { 'shop.example.com': ['93.184.216.34'] })).kind === 'live', 'a public address is guessed live');
    ok((await G('https://shop.example.com/', { 'shop.example.com': ['10.0.0.1', '93.184.216.34'] })).kind === 'live', 'one public address among private ones is not local');
    ok((await G('https://staging.example.com/', { 'staging.example.com': ['93.184.216.34'] })).kind === 'staging', 'the staging word rule is kept');
    ok((await G('https://shop.example.com/', {})).kind === envGuess({ url: 'https://shop.example.com/' }).kind, 'lookup failure: the current behaviour');
    const slow = await envGuessResolved({ url: 'https://slow.example.com/' }, { resolve: () => new Promise(() => {}), timeoutMs: 30 });
    ok(slow.kind === 'live', 'a lookup that never answers: falls back after the timeout');
    ok((await envGuessResolved({}, { resolve: fake({}) })).kind === 'local' && (await G('http://localhost:8080/')).kind === 'local', 'no address / localhost: local without any lookup');
    ok(['127.0.0.1', '127.9.9.9', '10.0.0.1', '172.16.0.1', '172.31.255.1', '192.168.0.1', '::1', 'fc00::1', 'fe80::1', '::ffff:10.0.0.1'].every(isPrivateAddress) && !['8.8.8.8', '172.32.0.1', '11.0.0.1', '2001:db8::1'].some(isPrivateAddress), 'address ranges');
    ok(envGuess({ url: 'https://localhost82.local.com/' }).kind === 'live', 'the sync envGuess is unchanged (no lookup)');

    group('7. the backup question comes only after the sandbox is chosen');
    const wizard = require('../lib/wizard'), cliLib = require('../lib/issue-cli');
    const siteE = path.join(tmp, 'wizsite'); w(siteE, 'wp-config.php', '<?php\n'); w(siteE, 'wp-includes/version.php', "<?php\n$wp_version = '6.8.1';\n"); fs.mkdirSync(path.join(siteE, 'wp-admin'), { recursive: true });
    w(siteE, 'wp-content/plugins/x/x.php', '<?php\n/**\n * Plugin Name: X\n */\n'); w(siteE, 'wp-content/themes/t/style.css', '/*\nTheme Name: T\n*/');
    fs.writeFileSync(path.join(tmp, 'backup.sql'), '-- dump\n');
    const realInv = cliLib.investigate; let seen = null; cliLib.investigate = async (_i, o2) => { seen = o2; return 0; };
    const wiz = async (answers, flags, host = async () => { throw new Error('offline'); }) => {
        const { PassThrough } = require('stream'); const input = new PassThrough(), output = new PassThrough(); let text = '';
        output.on('data', d => { text += d; });
        for (const a of answers) input.write(a + '\n'); input.end();
        let error = null; try { await wizard.run({ _: [], 'no-probe': true, 'no-questions': true, ...flags }, { input, output, tty: true, cwd: tmp, env: { HOME: tmp }, preflight: () => ({ ok: true }), siteRoots: [], resolveHost: host }); } catch (e) { error = e; }
        return { text, error };
    };
    seen = null;
    const n1 = await wiz(['Layout broken', '', '', siteE, 'n'], { out: path.join(tmp, 'o1') });
    ok(!n1.error && !/database backup/.test(n1.text) && /a deeper test in a throwaway copy/.test(n1.text) && seen && seen.sandbox === false, 'sandbox declined: the backup is never asked');
    seen = null;
    const n2 = await wiz(['Layout broken', '', '', siteE, ''], { out: path.join(tmp, 'o2') });
    ok(!n2.error && !/database backup/.test(n2.text) && seen && seen.sandbox === false, 'Enter (default no): the backup is never asked');
    seen = null;
    const y1 = await wiz(['Layout broken', '', '', siteE, 'y', path.join(tmp, 'backup.sql')], { out: path.join(tmp, 'o3') });
    ok(!y1.error && y1.text.indexOf('database backup') > y1.text.indexOf('deeper test') && seen && seen.sandbox === true && seen['db-dump'] === path.join(tmp, 'backup.sql'), 'sandbox chosen: the backup is asked next and passed on');
    seen = null;
    const y2 = await wiz(['Layout broken', '', '', siteE, 'y', ''], { out: path.join(tmp, 'o4') });
    ok(!y2.error && seen && seen.sandbox === true && !seen['db-dump'], 'sandbox chosen, no backup: Enter for none');
    seen = null;
    const fl = await wiz([], { yes: true, description: 'x', root: siteE, out: path.join(tmp, 'o5'), sandbox: true, 'db-dump': path.join(tmp, 'backup.sql') });
    ok(!fl.error && !/database backup/.test(fl.text) && seen && seen.sandbox === true && seen['db-dump'] === path.join(tmp, 'backup.sql'), 'flags-only: --sandbox --db-dump unchanged, nothing asked');
    seen = null;
    const lv = await wiz(['Pages break', '', 'https://shop.example.net/', siteE, '', 'shop.example.net'], { out: path.join(tmp, 'o6') });
    ok(!lv.error && !/database backup|throwaway copy/.test(lv.text), 'a live site: neither question is asked');
    seen = null;
    const lk = await wiz(['Layout broken', '', 'http://localhost82.local.com/ews/', siteE, '', ''], { out: path.join(tmp, 'o7') }, async () => ['127.0.0.1']);
    ok(!lk.error && /looks like a LOCAL site \(localhost82\.local\.com\)/.test(lk.text) && !/does not look like a local address/.test(lk.text) && seen && seen.environment !== 'live', 'localhost82.local.com -> 127.0.0.1: guessed local, accepted with Enter, no second "is it really local" question');
    seen = null;
    const lk2 = await wiz(['Layout broken', '', 'http://localhost82.local.com/ews/', siteE, '', ''], { out: path.join(tmp, 'o8') });
    ok(/looks like a LIVE site/.test(lk2.text), 'the same name when the lookup fails: the current behaviour (guessed live)');
    cliLib.investigate = realInv;

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(failures ? `\n${failures} FAILED` : `\nAll polish checks passed${skipped ? ` (${skipped} part(s) skipped)` : ''}.`);
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
