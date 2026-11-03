#!/usr/bin/env node
// validate.js, the crash/5xx lift of the "not reproduced" cap, extended to "could not test" (owner-approved change): when the problem is a crash
// and a probed page the report is about answered HTTP 5xx, the symptom counts as reproduced whether the oracle said "no" OR "could-not-test".
// Method: a FROZEN copy of the pre-change block lives in this file. The frozen validator is the current validate.js source with ONLY that block
// swapped back (compiled from text, so everything else is the same code). Every fixture is run through both: statuses, notes and checks must be
// identical except the not-reproduced-cap check and symptom_reproduced. The ews case (real shape of a stored probe: /ews/ answered 500, the
// second screen size not requested, a debug-log oracle without "available") must now be "yes", where the frozen copy gave "could-not-test".
// Mutation check: reverting validate.js to the frozen block makes the ews group fail (real === frozen, symptom could-not-test); widening the
// lift to non-crash symptoms or unrelated pages makes groups 3 and 5 fail. Offline. Fixtures only.
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-vsym-'));
process.env.PLUGIN_GUARD_ISSUES = path.join(tmp, 'issues');
const store = require('../lib/issue-store');
const evidence = require('../issue/evidence'), analysis = require('../issue/analysis'), validate = require('../issue/validate');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const group = t => console.log(`\n== ${t}`);

// ---- the frozen pre-change block (verbatim) and the block that replaced it ----
const FROZEN_BLOCK = `    if (symptom === 'no' && issue.symptom === 'white-screen' && probe && Array.isArray(probe.pages)) {
        const pathOf = u => { try { return new URL(u, 'http://x/').pathname.replace(/\\/+$/, '') || '/'; } catch { return null; } };
        // the pages the report names; with none named, the home page of the address given. A site in a sub-folder (/ews/) has its pages under that folder.
        const home = pathOf(issue.url || '/'), named = (issue.pages || []).map(pathOf).filter(Boolean);
        const isAbout = u => { const q = pathOf(u); return !!q && (named.length ? named.some(a => a === '/' ? q === home || q === '/' : q === a || q.endsWith(a)) : q === home || q === '/'); };
        const hit = probe.pages.find(p => p && p.status >= 500 && p.status < 600 && isAbout(p.url));
        if (hit) { symptom = 'yes'; checks.push(check('not-reproduced-cap', 'PASSED', \`the oracle said "not reproduced", but the problem is a crash and \${hit.url} (a page the report is about) answered HTTP \${hit.status}: the symptom counts as reproduced\`)); }
    }
`;
const VALIDATE = path.join(__dirname, '..', 'issue', 'validate.js');
const src = fs.readFileSync(VALIDATE, 'utf8');
const START = '    const symptomBefore = symptom;\n', END = '\n    // the hypothesis only carries a summary of its observation';
const a = src.indexOf(START), b = src.indexOf(END);
group('the frozen copy');
ok(a > 0 && b > a && src.indexOf(START, a + 1) < 0, 'validate.js holds the changed block exactly once');
const NEW_BLOCK = src.slice(a, b);
const reverted = NEW_BLOCK.slice(START.length).replace("if ((symptom === 'no' || symptom === 'could-not-test') && issue.symptom", "if (symptom === 'no' && issue.symptom").replace("the oracle said \"${symptomBefore === 'no' ? 'not reproduced' : 'could not test'}\"", 'the oracle said "not reproduced"');
ok(reverted === FROZEN_BLOCK, 'the new block is the frozen one plus exactly: one added line, the widened condition, the wording');
const oldSrc = src.slice(0, a) + FROZEN_BLOCK + src.slice(b);
const frozenMod = new Module(VALIDATE, module); frozenMod.filename = VALIDATE; frozenMod.paths = Module._nodeModulePaths(path.dirname(VALIDATE));
frozenMod._compile(oldSrc, VALIDATE);
const frozen = frozenMod.exports;
ok(typeof frozen.run === 'function' && frozen.run !== validate.run, 'the frozen validator compiles beside the real one');

// ---- comparison: everything except symptom_reproduced and the not-reproduced-cap check must be identical ----
const strip = r => { const c = JSON.parse(JSON.stringify(r)); delete c.symptom_reproduced; c.checks = (c.checks || []).filter(x => x.id !== 'not-reproduced-cap'); return c; };
const both = (id, opts) => { const before = frozen.run(id, opts); const after = validate.run(id, opts); return { before, after, same: JSON.stringify(strip(before)) === JSON.stringify(strip(after)), identical: JSON.stringify(before) === JSON.stringify(after) }; };
const statuses = r => r.hypotheses.map(h => `${h.type}:${h.status}`).join(', ');

// ---- fixture builders copied from selftest-likely-cause.js (not imported) ----
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
const okLint = () => ({ ok: true, message: '' });
async function prepared(name, o = {}, prep = null) {
    const root = path.join(tmp, name, 'wp'); build(root, o);
    const config = path.join(root, 'plugin-guard.config.json'); fs.writeFileSync(config, JSON.stringify(o.config || {}));
    const issue = store.create({ title: 'Critical error', description: o.description || 'The site shows a critical error', symptom: o.symptom || 'white-screen', environment: 'local', url: o.url || 'http://127.0.0.1:9/ews/', root, pages: o.pages || [], ...(o.oracle ? { oracle: o.oracle } : {}) });
    await evidence.run(issue.id, { root, probeOptions: { probe: false } });
    analysis.run(issue.id, { root, config });
    const dir = store.dirOf(issue.id);
    if (prep) prep(dir, issue, root);
    const r = both(issue.id, { root, config, lint: okLint });
    const fatal = res => res.hypotheses.find(x => x.type === 'missing-function');
    return { ...r, h: fatal(r.after), h0: fatal(r.before) };
}
const intakeSkipped = (dir) => fs.writeFileSync(path.join(dir, 'work', 'intake.json'), JSON.stringify({ php_skipped: 1, php_skipped_examples: ['wp-content/plugins/x/.github/a.php'] }));
const probeWith = (pages, oracleResult = 'no') => (dir) => {
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'issue.json'), 'utf8')); j.probe_ran_at = new Date().toISOString(); j.oracle = { type: 'console-error', value: 'zzz-never', defaulted: false }; fs.writeFileSync(path.join(dir, 'issue.json'), JSON.stringify(j));
    const mk = p => ({ url: p.url, status: p.status, viewport: { name: 'laptop', width: 1280 }, loaded: true, console_errors: [], page_errors: [], error_responses: [] });
    fs.writeFileSync(path.join(dir, 'work', 'probe.json'), JSON.stringify({ schema: 1, planned: pages.length, protection: null, pages: pages.map(mk), oracle: { type: 'console-error', value: 'zzz-never', result: oracleResult } }));
};

// ---- fixture builders copied from selftest-issue-dups.js (not imported) ----
const head = (n, x = '') => `<?php\n/**\n * Plugin Name: ${n}\n * Version: 1.0.0\n${x} */\ndefined('ABSPATH') || exit;\n`;
let n = 0;
function tree(parts) {
    const root = path.join(tmp, `wp${++n}`); const wr = (rel, body) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); };
    wr('wp-config.php', '<?php\n'); wr('wp-includes/version.php', "<?php\n$wp_version = '6.8.1';\n"); fs.mkdirSync(path.join(root, 'wp-admin'), { recursive: true });
    wr('wp-includes/script-loader.php', "<?php\nfunction wp_default_scripts( $scripts ) {\n\t$scripts->add( 'jquery', false, array( 'jquery-core' ) );\n\t$scripts->add( 'jquery-core', '/wp-includes/js/jquery/jquery.js', array(), '3.7.1' );\n}\n");
    for (const [rel, body] of Object.entries(parts)) wr(rel, body);
    return { root };
}
const CUSTOM = { customPaths: ['wp-content/plugins/plugin-a', 'wp-content/plugins/plugin-b'] };
const mkIssue = (root, symptom = 'other') => store.create({ title: 'dups', description: 'fixture', symptom, environment: 'local', url: 'http://127.0.0.1:9/', root, pages: ['/'] });
const hypsOf = (parts, { symptom = 'other', cfg = CUSTOM } = {}) => {
    const t = tree(parts); const issue = mkIssue(t.root, symptom);
    fs.writeFileSync(path.join(t.root, 'plugin-guard.config.json'), JSON.stringify(cfg));
    analysis.run(issue.id, { root: t.root });
    return { id: issue.id, root: t.root };
};

(async () => {
    group('1. existing fixtures: the change alters nothing they produce');
    const HOME = 'http://127.0.0.1:9/ews/';
    const cases = [
        ['confirmed', { templates: 4 }], ['likely', {}, intakeSkipped], ['old', { at: '16-Mar-2026 13:11:38' }, intakeSkipped], ['once', { repeats: 1 }, intakeSkipped],
        ['nomention', { line: '$c = 1;' }, intakeSkipped], ['nofile', {}, (dir, issue, root) => { intakeSkipped(dir); fs.rmSync(path.join(root, FILE)); }],
        ['lift', {}, probeWith([{ url: HOME, status: 500 }])], ['fine', {}, probeWith([{ url: HOME, status: 200 }])],
        ['unrelated', { pages: ['/cart/'] }, probeWith([{ url: 'http://127.0.0.1:9/ews/other-page/', status: 503 }])],
        ['named', { pages: ['/cart/'] }, probeWith([{ url: 'http://127.0.0.1:9/ews/cart/', status: 503 }])], ['notcrash', { symptom: 'layout' }, probeWith([{ url: HOME, status: 500 }])]
    ];
    for (const [name, o, prep] of cases) {
        const r = await prepared('fx-' + name, o, prep);
        ok(r.identical, `likely-cause fixture "${name}": real and frozen give the identical result (${statuses(r.after) || 'no hypotheses'}; symptom ${r.after.symptom_reproduced})`);
    }
    const dupTree = { 'wp-content/plugins/plugin-a/plugin-a.php': head('A') + "function my_helper() { return 1; }\n", 'wp-content/plugins/plugin-b/plugin-b.php': head('B') + "function my_helper() { return 2; }\n" };
    const guardedTree = { 'wp-content/plugins/plugin-a/plugin-a.php': head('A') + "function my_helper() { return 1; }\n", 'wp-content/plugins/plugin-b/plugin-b.php': head('B') + "if ( ! function_exists( 'my_helper' ) ) {\nfunction my_helper() { return 2; }\n}\n" };
    const shell = { 'wp-content/uploads/2026/shell.php': "<?php eval(base64_decode('ZWNobyAxOw==')); ?>", 'wp-content/plugins/plugin-a/plugin-a.php': head('A') };
    const constOnly = { 'wp-content/plugins/plugin-a/plugin-a.php': head('A') + "define( 'ACME_X', 1 );\n", 'wp-content/plugins/plugin-b/plugin-b.php': head('B') + "define( 'ACME_X', 2 );\n" };
    for (const [name, parts, symptom] of [['dup-declaration', dupTree, 'white-screen'], ['guarded', guardedTree, 'white-screen'], ['shell', shell, 'white-screen'], ['constant', constOnly, 'other']]) {
        const D = hypsOf(parts, { symptom });
        const r = both(D.id, { root: D.root, lint: okLint });
        ok(r.identical, `issue-dups fixture "${name}": identical (${statuses(r.after) || 'no hypotheses'})`);
    }

    group('2. the ews case: a 500 on /ews/, the second screen size not requested, a debug-log oracle without "available"');
    const EWS = 'http://localhost82.local.com/ews/';
    const ewsProbe = dir => {
        const resp = { url: EWS, status: 500, type: 'document', same_site: true, source: { type: 'other', ref: null, name: 'localhost82.local.com' } };
        fs.writeFileSync(path.join(dir, 'work', 'probe.json'), JSON.stringify({
            schema: 1, planned: { pages: [EWS], viewports: ['laptop 1280x800', 'mobile 390x844'], loads: 2, notes: [] }, protection: null,
            pages: [
                { console_errors: [], page_errors: [], error_responses: [resp, resp], failed_requests: [], url: EWS, viewport: { name: 'laptop', width: 1280, height: 800 }, loaded: true, status: 500, first_status: 500, retried: true, outcome: 'server-error', title: '', final_url: EWS, redirects: [], assets: [], scroll: { doc_width: 1280, viewport_width: 1280 }, text_chars: 93, text_flags: { blank: false, critical: true }, text_preview: 'There has been a critical error on this website. Learn more about troubleshooting WordPress.' },
                { console_errors: [], page_errors: [], error_responses: [], failed_requests: [], url: EWS, viewport: { name: 'mobile', width: 390, height: 844 }, loaded: false, status: 0, skipped: 'answered HTTP 500 at laptop; not requested again at another screen size', reused_status: 500, text_chars: 0, text_flags: { blank: true, critical: false }, text_preview: '', screenshot: null }
            ],
            oracle: { type: 'debug-log', value: 'Fatal error', defaulted: false, symptom: 'white-screen', result: 'yes', reason: 'a probed page answered HTTP 500 while debug.log gained no matching line (0 line(s) gained)' },
            debug_log: { new_bytes: 0, lines: 0 }
        }));
    };
    const ews = await prepared('ews', { url: EWS, oracle: { type: 'debug-log', value: 'Fatal error', defaulted: false } }, ewsProbe);
    ok(ews.after.oracle.recomputed === 'could-not-test' && ews.after.oracle.agrees === false, `the recomputation gives "could-not-test" and disagrees with the stored "yes" (${ews.after.oracle.recomputed}, agrees ${ews.after.oracle.agrees})`);
    ok(ews.before.symptom_reproduced === 'could-not-test' && !ews.before.checks.some(c => c.id === 'not-reproduced-cap'), 'the frozen pre-change code left it at "could-not-test" (the bug)');
    const cap = ews.after.checks.find(c => c.id === 'not-reproduced-cap');
    ok(ews.after.symptom_reproduced === 'yes', `now: symptom_reproduced === "yes" (${ews.after.symptom_reproduced})`);
    ok(cap && cap.status === 'PASSED' && cap.reason.includes('the oracle said "could not test"') && cap.reason.includes(`${EWS} (a page the report is about) answered HTTP 500`) && !cap.reason.includes('not reproduced'), `the not-reproduced-cap check says "could not test" (${cap && cap.reason})`);
    ok(ews.same, `every hypothesis status, note and other check is unchanged (${statuses(ews.after)})`);
    ok(!ews.h || ews.h.status !== 'CONFIRMED', `the disagreeing stored oracle still keeps the fatal from CONFIRMED (${ews.h && ews.h.status})`);
    const lifted = await prepared('lift-no', {}, probeWith([{ url: HOME, status: 500 }]));
    const capNo = lifted.after.checks.find(c => c.id === 'not-reproduced-cap');
    ok(lifted.after.symptom_reproduced === 'yes' && capNo && capNo.reason.includes('the oracle said "not reproduced"'), 'the oracle "no" case keeps its "not reproduced" wording');

    group('3. a 5xx on a page the report is not about does not lift');
    const other = [{ url: 'http://127.0.0.1:9/ews/other-page/', status: 503 }];
    const u1 = await prepared('unrel-no', { pages: ['/cart/'] }, probeWith(other, 'no'));
    ok(u1.after.symptom_reproduced === 'no' && !u1.after.checks.some(c => c.id === 'not-reproduced-cap') && u1.identical, 'oracle "no": the symptom stays "no", no lift check, identical to before');
    ok(u1.h0 && u1.h && u1.h.status === 'PROBABLE_NEEDS_REVIEW' && u1.h.status === u1.h0.status && u1.h.validation_notes.some(x => /NOT reproduced/.test(x)), `the fatal is downgraded exactly as before (${u1.h && u1.h.status})`);
    const u2 = await prepared('unrel-cnt', { pages: ['/cart/'] }, probeWith(other, 'yes'));
    ok(u2.after.symptom_reproduced === 'could-not-test' && !u2.after.checks.some(c => c.id === 'not-reproduced-cap') && u2.identical, `"could-not-test" (stored answer disagrees): stays "could-not-test", identical to before (${u2.after.symptom_reproduced})`);
    ok(u2.h && u2.h.status === 'PROBABLE_NEEDS_REVIEW' && u2.h.status === u2.h0.status, `the fatal is downgraded exactly as before (${u2.h && u2.h.status})`);

    group('4. "ran and did not reproduce" still downgrades');
    const fine = await prepared('fine-200', {}, probeWith([{ url: HOME, status: 200 }]));
    ok(fine.after.symptom_reproduced === 'no' && fine.h.status === 'PROBABLE_NEEDS_REVIEW' && fine.identical, `page answered 200, oracle "no": CONFIRMED becomes PROBABLE_NEEDS_REVIEW (${fine.h.status})`);
    const control = await prepared('control', {});
    ok(control.h && control.h.status === 'CONFIRMED', 'control: the same fixture with no probe is CONFIRMED, so the downgrades above are the cap at work');

    group('5. a non-crash symptom is not lifted');
    for (const [label, res] of [['no', 'no'], ['could-not-test', 'yes']]) {
        const r = await prepared('layout-' + label, { symptom: 'layout' }, probeWith([{ url: HOME, status: 500 }], res));
        ok(r.after.symptom_reproduced === r.before.symptom_reproduced && r.after.symptom_reproduced !== 'yes' && !r.after.checks.some(c => c.id === 'not-reproduced-cap') && r.identical, `layout + 500 on the report's page, oracle ${label}: not lifted (${r.after.symptom_reproduced}), identical to before`);
    }

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(failures ? `\n${failures} FAILED` : '\nAll checks passed');
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
