#!/usr/bin/env node
// What a REAL render of the ews run showed after checkpoint step A (five defects), checked on fixtures:
//   1. FAIL only when the finding is TIED to the crash; any other found item is ALSO NOTICED ("N pass, N fail, N also noticed, N not checked")
//   2. no HTML entity, no "null"/"undefined", no NOT_RUN / PASSED word in the gate Markdown reader text
//   3. the large-log note uses the ORIGINAL size and what was read (intake step), "mostly repeats" only with >= 80% soft lines
//   4. one template count: the checkpoint and the "What is wrong" box agree (and say both numbers when the Advisories keep fewer)
//   5. the headline once, a "What is wrong" sub-heading before the box, and a verbose Advisories entry that does not say "not shown" while it is shown
// Offline. Fixtures only.
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-real-'));
process.env.PLUGIN_GUARD_ISSUES = path.join(tmp, 'issues');
const store = require('../lib/issue-store');
const evidence = require('../issue/evidence'), analysis = require('../issue/analysis'), validate = require('../issue/validate'), resolve = require('../issue/resolve'), result = require('../issue/result');
const plain = require('../lib/plain-names');
const cpMod = require('../issue/checkpoints');
const cli = require('../lib/issue-cli');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const group = t => console.log(`\n== ${t}`);
const w = (root, rel, body = '<?php\n') => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); };
const CLASS = 'Elementor\\Core\\Schemes\\Color';
const FILE = 'wp-content/themes/unicamp/elementor/widgets/original/heading.php';
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const stamp = d => `${String(d.getUTCDate()).padStart(2, '0')}-${MON[d.getUTCMonth()]}-${d.getUTCFullYear()} ${d.toISOString().slice(11, 19)}`;

// the ews case, plus an unrelated plugin that needs a newer WordPress (found, but not tied to the crash)
function build(root, templates) {
    w(root, 'wp-includes/version.php', "<?php\n$wp_version = '6.8.1';\n"); w(root, 'wp-config.php', '<?php\n');
    w(root, 'wp-content/plugins/elementor/elementor.php', '<?php\n/**\n * Plugin Name: Elementor\n * Version: 3.35.7\n */\nnamespace Elementor;\nclass Plugin {}\n');
    w(root, 'wp-content/themes/unicamp/style.css', '/*\nTheme Name: Unicamp\nVersion: 2.2.0\n*/');
    w(root, FILE, '<?php\n' + '// filler\n'.repeat(46) + `$c = \\${CLASS}::get_type();\n`);
    w(root, 'wp-content/plugins/woocommerce/woocommerce.php', '<?php\n/**\n * Plugin Name: WooCommerce\n * Version: 10.6.1\n */\n');
    for (let i = 1; i <= templates; i++) { w(root, `wp-content/plugins/woocommerce/templates/t${i}/t${i}.php`, '<?php\n/**\n * @version 9.0.0\n */\n'); w(root, `wp-content/themes/unicamp/woocommerce/t${i}/t${i}.php`, '<?php\n/**\n * @version 3.0.0\n */\n'); }
    w(root, 'wp-content/plugins/dupa/dupa.php', '<?php\n/**\n * Plugin Name: Dup A\n * Version: 1.0.0\n * Requires at least: 99.0\n */\nfunction dup_shared_helper() { return 1; }\n');
    w(root, 'wp-content/plugins/dupb/dupb.php', '<?php\n/**\n * Plugin Name: Dup B\n * Version: 1.0.0\n */\nfunction dup_shared_helper() { return 2; }\n');
    const at = stamp(new Date(Date.now() - 86400e3)), at2 = at.slice(0, -2) + String((Number(at.slice(-2)) + 1) % 60).padStart(2, '0');
    const one = t => `[${t} UTC] PHP Fatal error:  Uncaught Error: Class "${CLASS}" not found in ${root}/${FILE}:48\nStack trace:\n#0 {main}\n  thrown in ${root}/${FILE} on line 48\n`;
    w(root, 'wp-content/debug.log', one(at) + one(at2));
}
const REAL_LOG_STEP = { id: 'intake-log', label: 'Your log file', status: 'PASSED', reason: 'copied and redacted (the last 2 MB of 262570 KB); your file was not changed; the last 2 MB of this log had no fatal error, so 48 MB before it were also read (48 MB of 256 MB): 3 fatal-like line(s) found' };
const SMALL_LOG_STEP = { id: 'intake-log', label: 'Your log file', status: 'PASSED', reason: 'copied and redacted (12 KB); your file was not changed' };
async function run(name, { verbose = false, templates = 5, logStep = REAL_LOG_STEP } = {}) {
    const root = path.join(tmp, name, 'wp'); build(root, templates);
    const config = path.join(root, 'plugin-guard.config.json'); fs.writeFileSync(config, '{}');
    const issue = store.create({ title: 'Critical error', description: 'The site shows a critical error', symptom: 'white-screen', environment: 'local', url: 'http://127.0.0.1:9/ews/', root, pages: [] });
    await evidence.run(issue.id, { root, probeOptions: { probe: false } });
    analysis.run(issue.id, { root, config });
    const dir = store.dirOf(issue.id);
    fs.writeFileSync(path.join(dir, 'work', 'intake.json'), JSON.stringify({ php_skipped: 1, php_skipped_examples: ['wp-content/plugins/x/.github/a.php'], steps: [logStep,
        { id: 'image-diff', label: 'Screenshot comparison (expected vs actual)', status: 'NOT_RUN', reason: 'no image pair was given: name two screenshots expected-<name> and actual-<name> to compare them' }] }));
    fs.writeFileSync(path.join(dir, 'work', 'sandbox.json'), JSON.stringify({ reproduced_in_sandbox: null, steps: [{ id: 'sandbox', label: 'Sandbox (throwaway copy in Docker)', status: 'NOT_RUN', reason: 'not requested: add --sandbox (needs Docker and a local copy of the site)' }] }));
    const val = validate.run(issue.id, { root, config, lint: () => ({ ok: true, message: '' }) });
    const policy = validate.policyFor(root, config), plans = resolve.build(issue.id, val, { root, policy, dir });
    const res = result.write(issue.id, { validation: val, plans, dir, root, policy, gate: true, verbose });
    const R = n => fs.readFileSync(path.join(dir, 'result', n), 'utf8');
    return { id: issue.id, dir, res, plans, f: JSON.parse(R('findings.json')), md: R('ISSUE-REPORT.md') };
}
const section = (md, h) => { const i = md.indexOf(`\n## ${h}`); if (i < 0) return ''; const j = md.indexOf('\n## ', i + 4); return md.slice(i, j < 0 ? undefined : j); };
const BAD = /&gt;|&lt;|&amp;|\bnull\b|\bundefined\b/;
// REPORT-SPEC Part 2: the counts are the ONE dot line (the old "We looked at N things: ..." sentence is gone); groups: pass, fail, not checked, also noticed
const COUNTS = /(\d+) pass · (\d+) fail · (\d+) not checked · (\d+) also noticed/;
const OLD_SENTENCE = /We looked at \d+ things/;

(async () => {
    // ---------------------------------------------------------------- synthetic work files for the tie rules
    group('1. FAIL only when tied to the crash; anything else found is ALSO NOTICED');
    const steps = [{ id: 'observations', status: 'PASSED' }, { id: 'classic-checks', status: 'PASSED', crashed: [], skipped: [] }, { id: 'compat', status: 'PASSED', php: { version: '8.1', stated: true } }, { id: 'redirect-map', status: 'PASSED' }];
    const comps = [{ ref: 'alpha', slug: 'alpha', name: 'Alpha Forms' }, { ref: 'beta', slug: 'beta', name: 'Beta Tools' }, { ref: 'gamma', slug: 'gamma', name: 'Gamma' }, { ref: 'delta', slug: 'delta', name: 'Delta' }, { ref: 'theme:zeta', slug: 'zeta', name: 'Zeta' }];
    const customCode = { steps, observations: [
        { id: 'obs-1', type: 'duplicate-constant', constant: 'ALPHA_DIR', components: ['alpha', 'beta'] },
        { id: 'obs-2', type: 'removed-function-call', function: 'each', removed_in: '8.0', components: ['theme:zeta'] },
        { id: 'obs-3', type: 'duplicate-shortcode', shortcode: 'form', components: ['gamma', 'delta'], evidence: [{ file: 'wp-content/plugins/gamma/g.php' }] },
        { id: 'obs-4', type: 'duplicate-rest-route', route: "null/'/' . $this->rest_base . '/(?p<id>[\\d]+)'", components: ['gamma', 'delta'] },
        { id: 'obs-5', type: 'tested-up-to-older', components: ['alpha'] }] };
    const logs = { steps: [{ id: 'logs', status: 'PASSED' }], clues: [{ type: 'php-fatal', value: 'Allowed memory size of 134217728 bytes exhausted (tried to allocate 20480 bytes)', source: { kind: 'log', ref: 'debug.log' } }] };
    const synth = { customCode, components: comps, graph: { edges: [], problems: [], truncated: false }, kbHits: { hits: [] }, collisions: { collisions: [], steps: [{ id: 'collisions', status: 'PASSED' }] }, evidence: logs, probe: null };
    const ev = tie => cpMod.evaluate({ work: synth, validation: { hypotheses: [] }, ran: { probe: false }, hasRoot: true, ...(tie ? { tie } : {}) });
    const by = rows => Object.fromEntries(rows.map(r => [r.id, r]));
    const noTie = by(ev(null)), tied = by(ev({ components: ['plugin:alpha'], files: [] }));
    ok(noTie['cp-02'].result === 'FAIL' && noTie['cp-24'].result === 'FAIL' && cpMod.tally(Object.values(noTie)).also_noticed === 0, 'without a tie context nothing is reclassified (every found item is a FAIL, as before)');
    ok(tied['cp-02'].result === 'FAIL' && tied['cp-02'].tied_to_crash === true, 'a duplicate constant that names a crash component (alpha, also given as plugin:alpha) is a FAIL, tied_to_crash true');
    ok(tied['cp-24'].result === 'ALSO NOTICED' && tied['cp-24'].tied_to_crash === false, 'a removed function in another theme is ALSO NOTICED, tied_to_crash false');
    ok(tied['cp-26'].result === 'ALSO NOTICED', 'a "tested up to" header never ties, even for a crash component (it is a label, not a fact about the crash)');
    ok(tied['cp-30'].result === 'ALSO NOTICED' && tied['cp-30'].tied_to_crash === false, 'a log-memory row is ALSO NOTICED unless its evidence ties it to the crash (owner decision)');
    const byFile = by(ev({ components: [], files: ['wp-content/plugins/gamma/g.php'] }));
    ok(byFile['cp-03'].result === 'FAIL' && tied['cp-03'].result === 'ALSO NOTICED', 'an item tied by the FILE of the crash evidence is a FAIL; the same item with no matching file is ALSO NOTICED');
    ok(Object.values(tied).every(r => ['PASS', 'FAIL', 'ALSO NOTICED', 'NOT CHECKED'].includes(r.result) && typeof r.tied_to_crash === 'boolean' && ['yes', 'no', 'depends'].includes(r.breaks_site)), 'every row has a result, tied_to_crash (boolean) and breaks_site (yes / no / depends)');
    ok(Object.values(tied).every(r => (r.result === 'FAIL') === (r.tied_to_crash === true && r.result === 'FAIL') && (r.result !== 'ALSO NOTICED' || r.tied_to_crash === false)), 'tied_to_crash agrees with the result');
    ok(by(ev({ components: ['alpha'], files: [] }))['cp-02'].breaks_site === 'no' && tied['cp-24'].breaks_site === 'yes', 'breaks_site comes from data/checkpoints.json (duplicate constant: no; removed function: yes)');
    const rows = Object.values(tied), t = cpMod.tally(rows);
    ok(t.pass + t.fail + t.also_noticed + t.not_checked === t.total && t.also_noticed >= 3, `the four counts add up to the total (${t.pass}/${t.fail}/${t.also_noticed}/${t.not_checked} of ${t.total})`);
    const cp = plain.checkpointText(rows.map(r => ({ ...r })), t);
    ok(cp.sentence === `${t.pass} pass · ${t.fail} fail · ${t.not_checked} not checked · ${t.also_noticed} also noticed` && t.pass + t.fail + t.not_checked + t.also_noticed === t.total, 'the counts line: "N pass · N fail · N not checked · N also noticed" (adding up to the total)');
    ok(cp.lines.some(l => /^Also noticed: .+: .+/.test(l)) && cp.lines.some(l => /^Fail: .+: .+/.test(l)) && cp.lines.some(l => /^Pass: /.test(l)) && cp.lines.some(l => /^Not checked: /.test(l)), 'list lines read Pass: / Fail: / Also noticed: title: reason / Not checked:');

    group('2. no raw "null" in a REST route');
    const rt = by(ev(null));
    ok(!/\bnull\b|\bundefined\b/.test(rt['cp-05'].reason) && /a REST route/.test(rt['cp-05'].reason), `an unreadable route says "a REST route", never null (${rt['cp-05'].reason.slice(0, 90)})`);
    const syn2 = { ...synth, customCode: { ...customCode, observations: [{ id: 'o1', type: 'duplicate-rest-route', route: 'null/wc/v3/items', components: ['gamma', 'delta'] }, { id: 'o2', type: 'duplicate-rest-route', route: 'wc/v3/items', components: ['gamma', 'delta'] }] } };
    const r2 = by(cpMod.evaluate({ work: syn2, validation: { hypotheses: [] }, ran: { probe: false }, hasRoot: true }));
    ok(/the REST route \/wc\/v3\/items/.test(r2['cp-05'].reason) && !/null/.test(r2['cp-05'].reason), 'a readable route keeps its address and drops a leading "null/"');

    // ---------------------------------------------------------------- the large-log note
    group('3. the large-log note uses the original size');
    const NOTE = 'Your log is very large (about 256 MB). Only part of it was read (the last 2 MB, then 48 MB before that), so older errors may not be shown.';
    const soft = { files: [{ ref: 'wp-content/debug.log', bytes: 2096082, truncated: false }], entries: [{ level: 'fatal error', count: 3 }, { level: 'deprecated', count: 5 }] };
    ok(plain.logNote(soft, [REAL_LOG_STEP]) === NOTE, 'the real shape (262570 KB, 2 MB tail, 48 MB before): the exact sentence, no "mostly repeats" (3 of 8 are errors)');
    const noisy = { files: soft.files, entries: [{ level: 'deprecated', count: 90 }, { level: 'warning', count: 10 }, { level: 'fatal error', count: 3 }] };
    ok(plain.logNote(noisy, [REAL_LOG_STEP]) === 'Your log is very large (about 256 MB) and mostly repeats the same warnings. Only part of it was read (the last 2 MB, then 48 MB before that), so older errors may not be shown.', 'with >= 80% soft lines: "and mostly repeats the same warnings"');
    ok(plain.logNote(soft, [SMALL_LOG_STEP]) === null && plain.logNote(soft, []) === null, 'a small log: no note');
    ok(plain.logNote(soft, [{ id: 'intake-log', log_read: { original_bytes: 262570 * 1024, parts: [{ direction: 'backwards', bytes: 48 * 1048576 }] } }]) === NOTE, 'the structured form (log_read) gives the same sentence');
    ok(plain.logNote(soft, [{ id: 'intake-log', reason: 'copied and redacted (the last 2 MB of 5000 KB); your file was not changed' }]) === 'Your log is very large (about 5 MB). Only part of it was read (the last 2 MB), so older errors may not be shown.', 'a tail only (no deeper read): "(the last 2 MB)"');

    // ---------------------------------------------------------------- end to end on the ews-shaped fixture
    const r = await run('base'), rv = await run('verbose', { verbose: true }), small = await run('small', { logStep: SMALL_LOG_STEP });
    group('4. the rendered gate report (fixture)');
    const items = r.f.checkpoints.items, c = r.f.checkpoints.counts;
    ok(c.fail === 0 && c.also_noticed >= 2 && c.pass + c.fail + c.also_noticed + c.not_checked === c.total, `counts in findings.json: ${c.pass} pass, ${c.fail} fail, ${c.also_noticed} also noticed, ${c.not_checked} not checked (no probe ran, and the template copies only share a component with the crash: nothing is a FAIL)`);
    const m = COUNTS.exec(r.md), cliAll = (() => { const o = []; cli.printGate(r.res, r.plans, { gate: true, verbose: false }, x => o.push(x), r.dir); return o.join('\n'); })();
    const once = t => (t.match(new RegExp(COUNTS.source, 'g')) || []).length === 1;
    ok(m && Number(m[1]) === c.pass && Number(m[2]) === c.fail && Number(m[4]) === c.also_noticed && Number(m[3]) === c.not_checked && once(r.md) && once(cliAll) && COUNTS.exec(cliAll)[0] === m[0] && !OLD_SENTENCE.test(r.md + cliAll), 'the Markdown and the command line carry the dot line exactly once, equal to the JSON counts, and no "We looked at" sentence');
    const it = id => items.find(x => x.id === id);
    ok(it('cp-14').result === 'ALSO NOTICED' && it('cp-14').tied_to_crash === false, 'the Unicamp + WooCommerce template copies only share the theme with the crash file: ALSO NOTICED, not FAIL (weak-tie row, owner decision)');
    ok(it('cp-26').result === 'ALSO NOTICED' && it('cp-26').tied_to_crash === false && /Dup A/.test(it('cp-26').reason), 'an unrelated plugin that needs a newer WordPress is ALSO NOTICED, not FAIL');
    const p5 = { planned: 1, protection: null, pages: [{ url: 'http://127.0.0.1:9/ews/', viewport: { name: 'laptop', width: 1280 }, loaded: true, status: 500, console_errors: [], page_errors: [], error_responses: [], failed_requests: [], redirects: [], text_flags: { blank: false, critical: false } }] };
    const symRows = cpMod.evaluate({ work: { ...cpMod.loadWork(r.dir), probe: p5 }, validation: { hypotheses: [] }, ran: { probe: true }, hasRoot: true, tie: { components: ['theme:unicamp'], files: [] } }), sb = Object.fromEntries(symRows.map(x => [x.id, x]));
    ok(items.every(x => (x.result === 'FAIL') === (x.tied_to_crash && x.result === 'FAIL')) && items.filter(x => x.result === 'ALSO NOTICED').every(x => x.tied_to_crash === false) && ['cp-38', 'cp-39'].every(id => sb[id].result === 'FAIL' && sb[id].tied_to_crash === true) && sb['cp-14'].result === 'ALSO NOTICED' && sb['cp-14'].tied_to_crash === false && symRows.filter(x => x.result === 'FAIL').every(x => x.tied_to_crash === true), 'FAIL items are tied, ALSO NOTICED items are not (same tree with a 500 page: the white-screen and HTTP 5xx rows FAIL and are tied; the template copies stay ALSO NOTICED)');
    ok(rv.f.checkpoint_text.lines.some(l => /^Also noticed: Requires PHP/.test(l)) && rv.f.checkpoint_text.lines.every(l => /^(Pass|Fail|Also noticed|Not checked): /.test(l)), 'verbose list: "Also noticed: title: reason" and no other prefix');

    group('5. escaping, plain words, no null');
    const mdAll = rv.md;
    ok(!BAD.test(section(mdAll, 'All checks')) && !BAD.test(section(mdAll, 'What was checked')), 'the gate Markdown "All checks" and "What was checked" have no &gt; &lt; &amp; null undefined');
    ok(!BAD.test(mdAll), 'nor does the rest of the gate Markdown');
    ok(/expected-\\<name>/.test(section(mdAll, 'What was checked')), 'a "<name>" in a step reason is escaped once with a backslash, not turned into an entity');
    ok(!/\b(NOT_RUN|PASSED|FAILED|SKIPPED|BLOCKED)\b/.test(section(mdAll, 'What was checked')) && /^- Done: /m.test(section(mdAll, 'What was checked')) && /^- Not done: /m.test(section(mdAll, 'What was checked')), '"What was checked" says Done / Not done (never NOT_RUN / PASSED)');
    const out = []; cli.printGate(rv.res, rv.plans, { gate: true, verbose: true }, t => out.push(t), rv.dir);
    ok(!BAD.test(out.join('\n')), 'the command line has none of them either');

    group('6. one template count');
    const t8 = await run('tpl8', { verbose: true, templates: 8 });
    const n = Number((/^(\d+) template cop/.exec(t8.f.checkpoints.items.find(x => x.id === 'cp-14').reason.replace(/^the theme Unicamp and the plugin WooCommerce: /, '')) || [])[1]);
    const line = (t8.f.what_is_wrong.lines.find(l => /^A second thing to check/.test(l)) || '');
    const nums = (line.match(/\d+/g) || []).map(Number);
    ok(n === 8 && nums.includes(8), `the checkpoint and the box both count ${n} outdated template copies (box: ${line.slice(0, 120)})`);
    ok(nums.length === 1 || /in all/.test(line), 'if the Advisories keep fewer, the box says both numbers plainly ("in all")');

    group('7. the phrase once, a "Case 1" heading, a verbose Advisories entry that is not "not shown"');
    const LIKELY = plain.LIKELY_PHRASE.replace(/^Most likely cause found in your log/, 'Likely cause'), sum = r.md;
    ok(sum.split(LIKELY).length - 1 === 1, 'the phrase "Likely cause (not confirmed)" appears once in the Status / Case 1 text of the report (the case heading)');
    ok(r.f.summary.report_lines.join('\n').split(plain.LIKELY_PHRASE).length - 1 === 1, 'the headline phrase appears once in the Summary lines (findings.json)');
    ok(/\n## Case 1: Likely cause \(not confirmed\)\n/.test(sum) && sum.indexOf('## Case 1') < sum.indexOf('Where: the theme'), 'a "## Case 1" heading comes before the Where line');
    ok(!/See 'What is wrong' above/.test(r.md), "no text points to a 'What is wrong' heading that no longer exists");
    const cliOut = []; cli.printGate(r.res, r.plans, { gate: true, verbose: false }, t => cliOut.push(t), r.dir);
    const ct = cliOut.join('\n');
    ok(ct.split(LIKELY.toUpperCase()).length - 1 === 1 && /^CASE 1  /m.test(ct), 'the command line: the phrase once and a "CASE 1" line');
    ok(r.f.summary.lines_html.filter(l => l === plain.LIKELY_PHRASE).length <= 1, 'the page layout (lines_html) is unchanged');
    const adv = section(rv.md, 'Advisories');
    ok(/Not confirmed\./.test(adv) && !/not shown because it is not confirmed/.test(adv), 'verbose Advisories: "Not confirmed." only, not "not shown because it is not confirmed"');

    group('8. the log note in the report');
    ok(r.f.log_note === NOTE && r.f.summary.report_lines.includes(NOTE), 'the real-shaped intake step gives the note in the Summary');
    ok(!small.f.log_note && !/very large/.test(small.md), 'a small log: no note');

    console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll report-real checks passed.');
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
