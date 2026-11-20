#!/usr/bin/env node
// Checkpoints (step A1): data/checkpoints.json is generated from docs/COVERAGE.md and kept in step with it; issue/checkpoints.js gives every one of the
// 53 checkpoints PASS / FAIL / NOT CHECKED with a plain reason, adds no detection, and never calls a missing source a PASS.
// Offline. Fixtures only. The ews-style fixture is the one of selftest-polish.js (log line heading.php:48, class Elementor\Core\Schemes\Color).
//
// Mutation note (not run): in issue/checkpoints.js `sourcesOf`, `need` returns ok only when `hasRoot` is true and `S.probe` only when `ran.probe` is true.
// Remove either guard and section 3 fails: the no-root fixture would turn the leftover work files into PASS rows, and the "probe did not run" case
// (probe.json holds pages, ran.probe is false) would turn the probe rows into PASS.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-cp-'));
process.env.PLUGIN_GUARD_ISSUES = path.join(tmp, 'issues');
const store = require('../lib/issue-store');
const evidence = require('../issue/evidence'), analysis = require('../issue/analysis'), validate = require('../issue/validate');
const cpMod = require('../issue/checkpoints');
const gen = require('./gen-checkpoints');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const group = t => console.log(`\n== ${t}`);
const w = (root, rel, body = '<?php\n') => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); };
const CLASS = 'Elementor\\Core\\Schemes\\Color';
const FILE = 'wp-content/themes/unicamp/elementor/widgets/original/heading.php';
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const stamp = d => `${String(d.getUTCDate()).padStart(2, '0')}-${MON[d.getUTCMonth()]}-${d.getUTCFullYear()} ${d.toISOString().slice(11, 19)}`;
const WPV = "<?php\n$wp_version = '6.8.1';\n";

function buildEws(root) {
    w(root, 'wp-includes/version.php', WPV); w(root, 'wp-config.php', '<?php\n');
    w(root, 'wp-content/plugins/elementor/elementor.php', '<?php\n/**\n * Plugin Name: Elementor\n * Version: 3.35.7\n */\nnamespace Elementor;\nclass Plugin {}\n');
    w(root, 'wp-content/themes/unicamp/style.css', '/*\nTheme Name: Unicamp\nVersion: 2.2.0\n*/');
    w(root, FILE, '<?php\n' + '// filler\n'.repeat(46) + `$c = \\${CLASS}::get_type();\n`);
    w(root, 'wp-content/plugins/woocommerce/woocommerce.php', '<?php\n/**\n * Plugin Name: WooCommerce\n * Version: 10.6.1\n */\n');
    for (let i = 1; i <= 5; i++) { w(root, `wp-content/plugins/woocommerce/templates/t${i}/t${i}.php`, '<?php\n/**\n * @version 9.0.0\n */\n'); w(root, `wp-content/themes/unicamp/woocommerce/t${i}/t${i}.php`, '<?php\n/**\n * @version 3.0.0\n */\n'); }
    const at = stamp(new Date(Date.now() - 86400e3));
    w(root, 'wp-content/debug.log', `[${at} UTC] PHP Fatal error:  Uncaught Error: Class "${CLASS}" not found in ${root}/${FILE}:48\nStack trace:\n#0 {main}\n  thrown in ${root}/${FILE} on line 48\n`);
}
function buildClean(root) {
    w(root, 'wp-includes/version.php', WPV); w(root, 'wp-config.php', '<?php\n');
    w(root, 'wp-content/plugins/hello/hello.php', '<?php\n/**\n * Plugin Name: Hello Note\n * Version: 1.0.0\n */\nfunction hello_note_show() { return 1; }\n');
    w(root, 'wp-content/themes/plain/style.css', '/*\nTheme Name: Plain\nVersion: 1.0.0\n*/');
    w(root, 'wp-content/themes/plain/functions.php', '<?php\nfunction plain_setup() { return 1; }\n');
}
// one investigation up to and including validation, the same way selftest-polish.js does it
async function investigate(name, { build = null, withRoot = true } = {}) {
    const root = path.join(tmp, name, 'wp'); if (build) build(root); else fs.mkdirSync(root, { recursive: true });
    const config = path.join(root, 'plugin-guard.config.json'); fs.writeFileSync(config, '{}');
    const issue = store.create({ title: 'Critical error', description: 'The site shows a critical error', symptom: 'white-screen', environment: 'local', url: 'http://127.0.0.1:9/ews/', root: withRoot ? root : undefined, pages: [] });
    await evidence.run(issue.id, { root: withRoot ? root : undefined, probeOptions: { probe: false } });
    analysis.run(issue.id, { root: withRoot ? root : undefined, config });
    let val = null; if (withRoot) val = validate.run(issue.id, { root, config, lint: () => ({ ok: true, message: '' }) });
    return { id: issue.id, dir: store.dirOf(issue.id), val, root };
}
const run = (inv, o = {}) => cpMod.evaluate({ work: cpMod.loadWork(inv.dir), validation: inv.val, ran: { probe: false, sandbox: false }, hasRoot: true, ...o });
const by = rows => Object.fromEntries(rows.map(r => [r.id, r]));
const T = rows => cpMod.tally(rows);

(async () => {
    const data = JSON.parse(fs.readFileSync(gen.OUT, 'utf8'));
    const cps = data.checkpoints;

    group('1. data/checkpoints.json is in step with docs/COVERAGE.md');
    ok(fs.readFileSync(gen.OUT, 'utf8') === gen.build(), 'regenerated in memory it is byte-for-byte the file on disk');
    ok(data.schema === 1 && data.source === 'docs/COVERAGE.md' && data.counts.total === 53 && cps.length === 53, '53 checkpoints, schema 1, source named');
    ok(data.counts.detected + data.counts.partial + data.counts.not_detected === data.counts.total
        && data.counts.detected === cps.filter(c => c.coverage === 'DETECTED').length && data.counts.partial === cps.filter(c => c.coverage === 'PARTIAL').length && data.counts.not_detected === cps.filter(c => c.coverage === 'NOT DETECTED').length, 'the counts add up and match the rows');
    ok(cps.every((c, i) => c.id === `cp-${String(i + 1).padStart(2, '0')}` && c.title && c.section && ['DETECTED', 'PARTIAL', 'NOT DETECTED'].includes(c.coverage) && ['Issue', 'Classic', 'Both', 'Neither'].includes(c.reached_in) && c.where && typeof c.missing === 'string'), 'rows are cp-01..cp-53 in order, each with title, section, coverage, reached_in, where, missing');
    const md = fs.readFileSync(gen.SOURCE, 'utf8');
    const m = /Summary: (\d+) items: (\d+) DETECTED . (\d+) PARTIAL . (\d+) NOT DETECTED/.exec(md);
    ok(m && Number(m[1]) === data.counts.total && Number(m[2]) === data.counts.detected && Number(m[3]) === data.counts.partial && Number(m[4]) === data.counts.not_detected, "the table's own summary line (53 / 19 / 26 / 8) agrees with the generated counts");
    const edited = path.join(tmp, 'COVERAGE-edited.md');
    fs.writeFileSync(edited, md.replace(/^(\| 2 \| Duplicate constant \| )DETECTED/m, '$1PARTIAL'));
    ok(gen.build(edited) !== gen.build(), 'a deliberately edited copy of COVERAGE.md gives a different file');
    const script = path.join(__dirname, 'gen-checkpoints.js');
    const chk = (src) => spawnSync(process.execPath, [script, '--check', ...(src ? ['--source', src] : [])], { encoding: 'utf8' });
    ok(chk().status === 0, '--check exits 0 when the file is current');
    const stale = chk(edited);
    ok(stale.status === 1 && /stale/.test(stale.stderr), '--check exits 1 and says "stale" when the table no longer matches the file');
    const noTable = path.join(tmp, 'empty.md'); fs.writeFileSync(noTable, '# nothing\n');
    ok(chk(noTable).status === 2, 'a source without the table is a usage error (exit 2), not a stale file');
    // default source missing: a copy of the script without docs/COVERAGE.md above it
    const lone = path.join(tmp, 'lone', 'pkg'); fs.mkdirSync(path.join(lone, 'scripts'), { recursive: true }); fs.mkdirSync(path.join(lone, 'lib'), { recursive: true }); fs.mkdirSync(path.join(lone, 'data'), { recursive: true });
    fs.copyFileSync(script, path.join(lone, 'scripts', 'gen-checkpoints.js')); fs.copyFileSync(path.join(__dirname, '..', 'lib', 'hints.js'), path.join(lone, 'lib', 'hints.js')); fs.copyFileSync(path.join(__dirname, '..', 'lib', 'repo-layout.js'), path.join(lone, 'lib', 'repo-layout.js'));
    const loneRun = (...a) => spawnSync(process.execPath, [path.join(lone, 'scripts', 'gen-checkpoints.js'), ...a], { encoding: 'utf8' });
    const MSG = "needs the repository's docs/COVERAGE.md, which is not part of this package";
    for (const a of [[], ['--check']]) { const r = loneRun(...a); ok(r.status === 2 && r.stderr.trim() === MSG && !/\n\s+at /.test(r.stderr), `default source missing (${a[0] || 'write'}): exit 2, one sentence, no stack trace`); }
    ok(!fs.existsSync(path.join(lone, 'data', 'checkpoints.json')), 'default source missing: nothing was written');
    const rx = loneRun('--source', path.join(tmp, 'nope.md')); ok(rx.status === 2 && rx.stderr.trim() !== MSG, 'an explicit --source that is missing keeps its own error (exit 2)');

    group('2. every row has an evaluator or a reason for none');
    ok(cps.every(c => (c.evaluator ? !c.no_evaluator_reason : typeof c.no_evaluator_reason === 'string' && c.no_evaluator_reason.length > 8)), 'a row has an evaluator key XOR a documented reason');
    ok(cps.every(c => !c.evaluator || typeof cpMod.EVALUATORS[c.evaluator] === 'function'), 'every evaluator key used exists in issue/checkpoints.js');
    ok(Object.keys(cpMod.EVALUATORS).every(k => cps.some(c => c.evaluator === k)), 'no evaluator is left unused');
    ok(cps.filter(c => c.coverage === 'NOT DETECTED').every(c => !c.evaluator), 'a NOT DETECTED row has no evaluator');
    ok(cps.filter(c => c.reached_in === 'Classic').every(c => !c.evaluator && c.no_evaluator_reason === 'only the classic scan checks this'), 'a classic-only row says "only the classic scan checks this"');
    ok(new Set(cps.map(c => c.evaluator).filter(Boolean)).size === cps.filter(c => c.evaluator).length, 'each evaluator key serves exactly one row');

    group('3. result counts on three fixtures');
    const ews = await investigate('ews', { build: buildEws });
    const rEws = run(ews);
    ok(rEws.length === 53 && rEws.every(r => ['PASS', 'FAIL', 'NOT CHECKED'].includes(r.result) && r.reason && r.title) && rEws.map(r => r.id).join() === cps.map(c => c.id).join(), 'EVERY checkpoint is answered, in id order, with a reason');
    const te = T(rEws);
    ok(te.pass === 26 && te.fail === 1 && te.not_checked === 26, `ews-style tree, no probe, no sandbox: 26 PASS, 1 FAIL, 26 NOT CHECKED (got ${te.pass}/${te.fail}/${te.not_checked})`);
    const be = by(rEws);
    ok(be['cp-14'].result === 'FAIL' && /^the theme Unicamp and the plugin WooCommerce: 5 template copies/.test(be['cp-14'].reason), 'the one FAIL is the outdated template copies, with plain names: "the theme Unicamp and the plugin WooCommerce"');
    ok(!/theme:|plugin:/.test(rEws.map(r => r.reason).join('\n')), 'no internal id (theme:x) in any reason');
    ok(['cp-38', 'cp-39', 'cp-40', 'cp-41', 'cp-43', 'cp-44', 'cp-45'].every(id => be[id].result === 'NOT CHECKED' && /live page probe did not run/.test(be[id].reason)), 'the probe rows (38-41, 43-45) are NOT CHECKED: the probe did not run');
    ok(be['cp-30'].result === 'PASS' && be['cp-31'].result === 'PASS' && /common cases only/.test(be['cp-30'].reason), 'the log was read: rows 30 and 31 PASS, and a PARTIAL row says "checked for the common cases only"');
    ok(be['cp-02'].result === 'PASS' && be['cp-02'].reason === 'nothing found', 'a DETECTED row passes without the partial note');
    ok(['cp-24', 'cp-25', 'cp-26'].every(id => be[id].result === 'NOT CHECKED' && be[id].reason === "the site's PHP version is not known (--php); only the sandbox's PHP 8.3 could be compared"), "PHP unknown: rows 24-26 are NOT CHECKED with the sandbox-PHP reason");

    const clean = await investigate('clean', { build: buildClean });
    const rClean = run(clean), tc = T(rClean), bc = by(rClean);
    ok(tc.pass === 25 && tc.fail === 0 && tc.not_checked === 28, `clean tree (no log): 25 PASS, 0 FAIL, 28 NOT CHECKED (got ${tc.pass}/${tc.fail}/${tc.not_checked})`);
    ok(bc['cp-30'].result === 'NOT CHECKED' && /no log file/.test(bc['cp-30'].reason) && bc['cp-31'].result === 'NOT CHECKED', 'no log file: rows 30 and 31 are NOT CHECKED, never PASS');
    ok(bc['cp-11'].result === 'NOT CHECKED' && /no script or style files/.test(bc['cp-11'].reason), 'nothing to compare for libraries: NOT CHECKED, not PASS');

    const noroot = await investigate('noroot', { withRoot: false });
    const rNo = run(noroot, { hasRoot: false }), tn = T(rNo), bn = by(rNo);
    ok(tn.pass === 0 && tn.fail === 0 && tn.not_checked === 53, `no root: 0 PASS, 0 FAIL, 53 NOT CHECKED (got ${tn.pass}/${tn.fail}/${tn.not_checked})`);
    ok(rNo.filter(r => cps.find(c => c.id === r.id).evaluator && cps.find(c => c.id === r.id).reached_in !== 'Classic' && !['cp-38', 'cp-39', 'cp-40', 'cp-41', 'cp-43', 'cp-44', 'cp-45', 'cp-20'].includes(r.id)).every(r => /no site files were given/.test(r.reason) || /no log|PHP version/.test(r.reason)), 'every code-reading row names the missing folder as the reason');
    // the guard: the work files of the ews run are still there, but the caller says there was no root and no probe: nothing may turn into a PASS
    const guard = cpMod.evaluate({ work: cpMod.loadWork(ews.dir), validation: ews.val, ran: { probe: false, sandbox: false }, hasRoot: false });
    ok(T(guard).pass === 0 && T(guard).fail === 0, 'hasRoot false with leftover work files: still no PASS and no FAIL from a missing source');
    // H1: a site folder was given but no code file was read: every checkpoint that needs code is NOT CHECKED, never PASS (the log rows still count)
    const rNoCode = cpMod.evaluate({ work: cpMod.loadWork(ews.dir), validation: ews.val, ran: { probe: false, sandbox: false }, hasRoot: true, hasCode: false }), tnc = T(rNoCode), bnc = by(rNoCode);
    ok(rNoCode.length === 53 && tnc.fail === 0 && tnc.pass < te.pass, `hasCode false: no FAIL and fewer PASS than with code (${tnc.pass} < ${te.pass})`);
    ok(bnc['cp-02'].result === 'NOT CHECKED' && /the site folder holds no code files, so no code was read/.test(bnc['cp-02'].reason) && bnc['cp-14'].result === 'NOT CHECKED', 'hasCode false: a code row (cp-02) and the template-copies row (cp-14) are NOT CHECKED with the reason');
    ok(rNoCode.filter(r => /holds no code files/.test(r.reason)).every(r => r.result === 'NOT CHECKED') && bnc['cp-30'].result === 'PASS', 'hasCode false: every row with that reason is NOT CHECKED; the log row (cp-30) still passes');
    ok(by(cpMod.evaluate({ work: cpMod.loadWork(ews.dir), validation: ews.val, ran: { probe: false, sandbox: false }, hasRoot: true }))['cp-02'].result === 'PASS', 'hasCode left out (default) behaves as before: cp-02 PASS');
    // H2: code files were found but none could be analysed: its own reason (with the number), never "holds no code files"
    const rUnread = cpMod.evaluate({ work: cpMod.loadWork(ews.dir), validation: ews.val, ran: { probe: false, sandbox: false }, hasRoot: true, hasCode: false, codeFound: 3 }), bun = by(rUnread);
    ok(bun['cp-02'].result === 'NOT CHECKED' && bun['cp-02'].reason === 'the site folder holds 3 PHP files, but none could be analysed, so no code was checked' && !rUnread.some(r => /holds no code files/.test(r.reason)), 'hasCode false, 3 files found: "the site folder holds 3 PHP files, but none could be analysed, so no code was checked"');
    const fakeProbe = { planned: 2, protection: null, pages: [{ url: 'http://127.0.0.1:9/', viewport: { name: 'desktop', width: 1280 }, loaded: true, status: 200, console_errors: [], page_errors: [], error_responses: [], failed_requests: [], redirects: [], text_flags: { blank: false, critical: false } }] };
    const withFake = (probe, ran) => cpMod.evaluate({ work: { ...cpMod.loadWork(ews.dir), probe }, validation: ews.val, ran, hasRoot: true });
    ok(by(withFake(fakeProbe, { probe: false }))['cp-39'].result === 'NOT CHECKED', 'probe.json holds a page but ran.probe is false: NOT CHECKED (the ran guard)');

    group('4. what the checks found is named: FAIL cases from synthetic work files');
    const steps = [{ id: 'observations', status: 'PASSED' }, { id: 'classic-checks', status: 'PASSED', crashed: [], skipped: [{ rule: 'integrity-php-in-uploads', title: 'wp-content/uploads/x.php:1 contains PHP in the uploads folder', reason: 'no clue' }] },
        { id: 'compat', status: 'PASSED', php: { version: '8.1', stated: true } }, { id: 'redirect-map', status: 'PASSED' }];
    const comps = [{ ref: 'alpha', slug: 'alpha', name: 'Alpha Forms' }, { ref: 'beta', slug: 'beta', name: 'Beta Tools' }, { ref: 'theme:zeta', slug: 'zeta', name: 'Zeta' }];
    const customCode = { steps, observations: [
        { id: 'obs-1', type: 'duplicate-constant', constant: 'ALPHA_DIR', components: ['alpha', 'beta'] },
        { id: 'obs-2', type: 'removed-function-call', function: 'each', removed_in: '8.0', components: ['theme:zeta'] }] };
    const logs = { steps: [{ id: 'logs', status: 'PASSED' }], clues: [{ type: 'php-fatal', value: 'Allowed memory size of 134217728 bytes exhausted (tried to allocate 20480 bytes)', source: { kind: 'log', ref: 'debug.log' } }] };
    const synth = { customCode, components: comps, graph: { edges: [], problems: [{ type: 'missing-declared-dependency', component: 'alpha', missing: 'beta-core', why: 'x' }], truncated: false }, kbHits: { hits: [] }, collisions: { collisions: [], steps: [{ id: 'collisions', status: 'PASSED' }] }, evidence: logs, probe: null };
    const rs = by(cpMod.evaluate({ work: synth, validation: { hypotheses: [] }, ran: { probe: false }, hasRoot: true }));
    ok(rs['cp-02'].result === 'FAIL' && rs['cp-02'].reason === 'the plugin Alpha Forms and the plugin Beta Tools both define the constant ALPHA_DIR', 'a duplicate constant: FAIL with both plain names');
    ok(rs['cp-24'].result === 'FAIL' && /^the theme Zeta calls each\(\), which no longer exists from PHP 8\.0$/.test(rs['cp-24'].reason), 'a removed function: FAIL naming the theme');
    ok(rs['cp-30'].result === 'FAIL' && /out of memory/.test(rs['cp-30'].reason) && rs['cp-31'].result === 'PASS', 'a memory fatal in the log: row 30 FAIL, row 31 PASS');
    ok(rs['cp-50'].result === 'FAIL' && /PHP in the uploads/.test(rs['cp-50'].reason), 'a classic compromise rule that the adapter left out for lack of a clue still counts as found');
    ok(rs['cp-13'].result === 'FAIL' && /needs "beta-core", which is not installed/.test(rs['cp-13'].reason), 'a missing dependency: FAIL');
    ok(rs['cp-02'].result === 'FAIL' && rs['cp-01'].result === 'PASS', 'other rows are not affected');
    const stated = { ...synth, customCode: { ...customCode, steps: steps.map(x => (x.id === 'compat' ? { ...x, php: { version: '8.1', stated: true } } : x)), observations: [] } };
    const unknown = { ...stated, customCode: { ...stated.customCode, steps: stated.customCode.steps.map(x => (x.id === 'compat' ? { ...x, php: { version: '8.3', stated: false } } : x)) } };
    const ev2 = wk => by(cpMod.evaluate({ work: wk, validation: { hypotheses: [] }, ran: { probe: false }, hasRoot: true }));
    ok(['cp-24', 'cp-25', 'cp-26'].every(id => ev2(stated)[id].result === 'PASS'), 'PHP given (--php), nothing found: rows 24-26 PASS');
    ok(['cp-24', 'cp-25', 'cp-26'].every(id => ev2(unknown)[id].result === 'NOT CHECKED'), 'PHP unknown, nothing found: rows 24-26 NOT CHECKED');
    const unkFind = ev2({ ...unknown, customCode: { ...unknown.customCode, observations: customCode.observations } });
    ok(unkFind['cp-24'].result === 'FAIL' && unkFind['cp-25'].result === 'FAIL', 'PHP unknown but a removed function was found: FAIL (a finding wins)');
    const pageOf = o => ({ url: 'http://127.0.0.1:9/shop/', viewport: { name: 'desktop', width: 1280 }, loaded: true, status: 200, console_errors: [], page_errors: [], error_responses: [], failed_requests: [], redirects: [], text_flags: { blank: false, critical: false }, ...o });
    const P = (pages, extra = {}) => by(cpMod.evaluate({ work: { ...synth, probe: { planned: pages.length, protection: null, pages, ...extra } }, validation: { hypotheses: [] }, ran: { probe: true }, hasRoot: true }));
    const p0 = P([pageOf({})]);
    ok(['cp-38', 'cp-39', 'cp-40', 'cp-41', 'cp-43', 'cp-44', 'cp-45'].every(id => p0[id].result === 'PASS'), 'a complete clean probe: the seven probe rows PASS');
    const p5 = P([pageOf({ status: 503 })]);
    ok(p5['cp-39'].result === 'FAIL' && p5['cp-38'].result === 'FAIL' && p5['cp-40'].result === 'PASS', 'a 503 page: rows 38 and 39 FAIL, the critical-error text row passes');
    const pc = P([pageOf({ text_flags: { blank: false, critical: true } })]);
    ok(pc['cp-40'].result === 'FAIL' && pc['cp-39'].result === 'PASS', 'critical-error text with HTTP 200: row 40 FAIL');
    const pl = P([pageOf({ loaded: false, status: 0, error: 'net::ERR_TOO_MANY_REDIRECTS' }), pageOf({})]);
    ok(pl['cp-41'].result === 'FAIL', 'a redirect loop on a page that never loaded: row 41 FAIL');
    const pj = P([pageOf({ page_errors: [{ text: 'TypeError: x is undefined' }], error_responses: [{ url: 'http://127.0.0.1:9/wp-admin/admin-ajax.php', status: 400, same_site: true }] })]);
    ok(pj['cp-44'].result === 'FAIL' && pj['cp-43'].result === 'FAIL' && pj['cp-45'].result === 'FAIL', 'a JavaScript error and a failing admin-ajax request: rows 44, 43 and 45 FAIL');
    const pp = P([pageOf({})], { planned: 4 });
    ok(pp['cp-39'].result === 'NOT CHECKED' && /stopped early/.test(pp['cp-39'].reason), 'a probe that loaded fewer pages than planned and found nothing: NOT CHECKED, not PASS');
    const pq = P([pageOf({})], { protection: { reason: '429' } });
    ok(pq['cp-44'].result === 'NOT CHECKED', 'the site\'s protection stopped the probe: a quiet result is NOT CHECKED');
    const ps = P([pageOf({ status: 500 })], { protection: { reason: '5xx' } });
    ok(ps['cp-39'].result === 'FAIL', 'a stopped probe that did see a 5xx still reports it (a finding wins over a missing source)');

    // S3a-fix: the REAL probe.json shape. issue/probe.js writes `planned` as an object { pages, viewports, loads, notes }, not a number; a complete probe must give real results
    const PR = (pages, planned, extra = {}) => by(cpMod.evaluate({ work: { ...synth, probe: { schema: 1, planned, protection: null, pages, ...extra } }, validation: { hypotheses: [] }, ran: { probe: true }, hasRoot: true }));
    const real = loads => ({ pages: ['http://127.0.0.1:9/shop/'], viewports: ['laptop 1280x800', 'mobile 390x844'], loads, notes: [] });
    const LIVE7 = ['cp-38', 'cp-39', 'cp-40', 'cp-41', 'cp-43', 'cp-44', 'cp-45'];
    const rc = PR([pageOf({}), pageOf({ viewport: { name: 'mobile', width: 390 } })], real(2));
    ok(LIVE7.every(id => rc[id].result === 'PASS'), 'S3a-fix: a complete probe in the real shape (planned.loads 2, 2 pages loaded): the seven live rows PASS');
    const rf = PR([pageOf({})], real(2));
    ok(LIVE7.every(id => rf[id].result === 'NOT CHECKED' && /stopped early/.test(rf[id].reason)), 'S3a-fix: fewer pages loaded than planned.loads (1 of 2) and nothing found: all seven rows NOT CHECKED with the stopped-early reason');
    const rg = PR([pageOf({ status: 500 })], real(2));
    ok(rg['cp-39'].result === 'FAIL' && rg['cp-38'].result === 'FAIL' && rg['cp-44'].result === 'NOT CHECKED', 'S3a-fix: the same partial probe that saw a 500: the finding rows FAIL, the quiet rows stay NOT CHECKED');
    const rp = PR([pageOf({})], real(1), { protection: { reason: '429' } });
    ok(LIVE7.every(id => rp[id].result === 'NOT CHECKED'), 'S3a-fix: planned.loads met but the site protection stopped the probe: NOT CHECKED');
    const odd = [undefined, null, 0, -1, 1.5, '1', NaN, {}, { loads: 0 }, { loads: '1' }, { loads: 1.5 }, { loads: null }, [], true];
    ok(odd.every(v => LIVE7.every(id => PR([pageOf({})], v)[id].result === 'NOT CHECKED')), `S3a-fix: a missing or unusable planned (${odd.length} odd values) gives NOT CHECKED on every live row, never PASS`);
    ok(odd.every(v => /stopped early/.test(PR([pageOf({})], v)['cp-39'].reason)), 'S3a-fix: and the reason is the same safe one ("the live page probe stopped early, so a quiet result cannot be trusted")');
    const oddNoKey = by(cpMod.evaluate({ work: { ...synth, probe: { schema: 1, protection: null, pages: [pageOf({})] } }, validation: { hypotheses: [] }, ran: { probe: true }, hasRoot: true }));
    ok(LIVE7.every(id => oddNoKey[id].result === 'NOT CHECKED'), 'S3a-fix: a probe.json with no planned key at all: NOT CHECKED');
    const plain = PR([pageOf({})], 1);
    ok(LIVE7.every(id => plain[id].result === 'PASS'), 'S3a-fix: the plain number (older data) still works: complete probe PASS');

    // S3a: the live page checks in one sentence (issue/checkpoints.js liveSummary + lib/plain-names.js liveChecksSentence), counted from the real rows
    const plainNames = require('../lib/plain-names');
    const NP = 'A check that did not run is not a pass.';
    const sumOf = (probe, evidenceSteps, ranProbe = true) => { const w = { ...synth, ...(probe ? { probe } : {}), ...(evidenceSteps ? { evidence: { steps: evidenceSteps } } : {}) }; const rows = cpMod.evaluate({ work: w, validation: { hypotheses: [] }, ran: { probe: ranProbe }, hasRoot: false }); return typeof cpMod.liveSummary === 'function' ? cpMod.liveSummary(rows, w) : null; };
    const sent = sm => (typeof plainNames.liveChecksSentence === 'function' ? plainNames.liveChecksSentence(sm) : null);
    const cplete = sumOf({ schema: 1, planned: real(2), protection: null, pages: [pageOf({}), pageOf({ viewport: { name: 'mobile', width: 390 } })] });
    ok(cplete && cplete.total === 7 && cplete.gave === 7 && cplete.not_run === 0 && sent(cplete) === '7 of 7 live page checks gave a result.', 'S3a (1): all 7 ran: "7 of 7 live page checks gave a result." and no "could not run" part');
    const SK = { url: 'http://127.0.0.1:9/shop/', viewport: { name: 'mobile', width: 390 }, loaded: false, status: 0, skipped: 'answered HTTP 500 at laptop; not requested again at another screen size', reused_status: 500 };
    const c500 = sumOf({ schema: 1, planned: real(2), protection: null, pages: [pageOf({ status: 500 }), SK] });
    ok(c500 && c500.gave + c500.not_run === c500.total && c500.gave > 0 && c500.not_run > 0 && sent(c500) === `${c500.gave} of 7 live page checks gave a result. ${c500.not_run} could not run: the page answered with an error (HTTP 500), so it was not loaded again at the other screen size. ${NP}`, `S3a (2): a 500 page: gave a result counts PASS, FAIL and ALSO NOTICED only; the reason is the real cause, not "stopped early" (${c500 && sent(c500)})`);
    const c429 = sumOf({ schema: 1, planned: real(2), protection: { kind: 'ProtectionStop', reason: 'Repeated rate limiting (1 x HTTP 429)' }, pages: [] }, [{ id: 'live-probe', status: 'BLOCKED', reason: 'Testing limited by site protection' }], false);
    ok(c429 && sent(c429) === `0 of 7 live page checks gave a result. 7 could not run: the website's protection or rate limiting stopped the test, so no more requests were sent: Repeated rate limiting (1 x HTTP 429). ${NP}` && !/no address|switched off/.test(sent(c429)), 'S3a (3): a protection stop (429): the real reason in plain words, not "no address, not allowed, or switched off"');
    const cNoUrl = sumOf(null, [{ id: 'live-probe', status: 'NOT_RUN', reason: 'no site address was given (--url), so no page could be loaded' }], false);
    ok(cNoUrl && sent(cNoUrl) === `No live page check ran: no address was given. ${NP}` && !/0 of 7/.test(sent(cNoUrl)), 'S3a (4a): no address: never "0 of 7"; it says no live page check ran, and why');
    const cOff = sumOf(null, [{ id: 'live-probe', status: 'NOT_RUN', reason: 'the live probe was switched off (--no-probe)' }], false);
    ok(cOff && sent(cOff) === `No live page check ran: the live check was switched off. ${NP}`, 'S3a (4b): --no-probe: no live page check ran, the live check was switched off');
    const cOld = sumOf({ schema: 1, protection: null, pages: [pageOf({})] });
    ok(cOld && sent(cOld) === `0 of 7 live page checks gave a result. 7 could not run: the result of the live page test could not be read. ${NP}` && !/stopped early/.test(sent(cOld)), 'S3a (5): an old folder with no `planned`: the reason is that the result could not be read, not "stopped early"');
    const cFew = sumOf({ schema: 1, planned: real(4), protection: null, pages: [pageOf({})] });
    ok(cFew && /^0 of 7 live page checks gave a result\. 7 could not run: fewer page loads were completed than planned\./.test(sent(cFew)), 'S3a: fewer loads than planned with no known cause: the safe generic reason');
    // S3a review round 1: the wording follows the KIND of stop; a cooldown sent no request; a reason is plain text cut at a word
    const cTs = sumOf({ schema: 1, planned: real(2), protection: { kind: 'TestStopped', reason: 'Server instability (3 x 5xx)' }, pages: [] }, [{ id: 'live-probe', status: 'BLOCKED', reason: 'x' }], false);
    ok(cTs && sent(cTs) === `0 of 7 live page checks gave a result. 7 could not run: the test was stopped to keep the website safe, so no more requests were sent: Server instability (3 x 5xx). ${NP}` && !/protection/.test(sent(cTs)), 'S3a review: a server-safety stop (5xx or connection errors) is not called site protection');
    const cCd = sumOf({ schema: 1, planned: real(2), protection: { kind: 'cooldown', reason: 'cooling down after site protection at 2026-11-20T08:00:00.000Z (Repeated rate limiting (1 x HTTP 429)); next run allowed after 2026-11-20T08:30:00.000Z', requests_sent: 0 }, pages: [] }, [{ id: 'live-probe', status: 'BLOCKED', reason: 'x' }], false);
    ok(cCd && sent(cCd) === `No live page check ran: an earlier run was stopped by the website's protection, so this run waited and sent no request. ${NP}` && !/0 of 7|2026/.test(sent(cCd)), 'S3a review: a cooldown sent no request: "No live page check ran ...", no "0 of 7", no raw timestamps');
    const cWaf = sumOf({ schema: 1, planned: real(2), protection: { kind: 'ProtectionStop', reason: 'Cloudflare/WAF challenge page' }, pages: [] }, null, false);
    ok(cWaf && /stopped the test, so no more requests were sent: Cloudflare\/WAF challenge page\./.test(sent(cWaf)), 'S3a review: a name that starts with a capital word ("Cloudflare/WAF") keeps its capital');
    const longWords = 'word '.repeat(80);
    const cLong = sumOf({ schema: 1, planned: real(2), protection: null, pages: [] }, [{ id: 'live-probe', status: 'FAILED', reason: `the site could not be reached (\u001b[31mERR ${longWords})` }], false);
    ok(cLong && !/[\u0000-\u001f\u007f]/.test(sent(cLong)) && /word\. A check that did not run/.test(sent(cLong)) && sent(cLong).length < 400, 'S3a review: a step reason holds no control character and is cut at a word, not in the middle of one');
    // S3a2: a live ROW says the true reason when the probe was stopped by protection (it said "no address, not allowed, or switched off", which is untrue); the old texts stay where they are true
    const OLDROW = 'the live page probe did not run (no address, not allowed, or switched off)';
    const rowsOf = (probe, steps, hasRoot) => { const w = { ...synth, ...(probe ? { probe } : {}), ...(steps ? { evidence: { steps } } : {}) }; const rows = cpMod.evaluate({ work: w, validation: { hypotheses: [] }, ran: { probe: false }, hasRoot }); return { rows, sum: cpMod.liveSummary(rows, w) }; };
    for (const hasRoot of [false, true]) {
        const r429 = rowsOf({ schema: 1, planned: real(2), protection: { kind: 'ProtectionStop', reason: 'Repeated rate limiting (1 x HTTP 429)' }, pages: [] }, [{ id: 'live-probe', status: 'BLOCKED', reason: 'x' }], hasRoot);
        const live = r429.rows.filter(r => r.live_row);
        ok(live.length === 7 && live.every(r => r.result === 'NOT CHECKED' && r.reason === r429.sum.reason && !/no address|switched off|not allowed/.test(r.reason)), `S3a2 (${hasRoot ? 'with' : 'without'} a site folder): a 429 stop: every live row says the true reason, the same text as the live-check sentence ("${live[0] && live[0].reason}")`);
        const rcd = rowsOf({ schema: 1, planned: real(2), protection: { kind: 'cooldown', reason: 'cooling down after site protection at 2026-11-20T08:00:00.000Z (x)', requests_sent: 0 }, pages: [] }, null, hasRoot).rows.filter(r => r.live_row);
        ok(rcd.length === 7 && rcd.every(r => r.reason === 'an earlier run was stopped by the website\'s protection, so this run waited and sent no request'), `S3a2 (${hasRoot ? 'with' : 'without'} a site folder): a cooldown says that an earlier run was stopped and no request was sent`);
        const rno = rowsOf(null, [{ id: 'live-probe', status: 'NOT_RUN', reason: 'no site address was given (--url), so no page could be loaded' }], hasRoot).rows.filter(r => r.live_row);
        ok(rno.length === 7 && rno.every(r => r.reason === OLDROW), `S3a2 (${hasRoot ? 'with' : 'without'} a site folder): no address, no probe data: the old row text stays, it is true there`);
        const rnp = rowsOf({ schema: 1, planned: real(2), protection: null, pages: [] }, null, hasRoot).rows.filter(r => r.live_row);
        ok(rnp.every(r => r.reason === OLDROW), `S3a2 (${hasRoot ? 'with' : 'without'} a site folder): a probe file with no page and no protection: the old row text stays`);
    }
    ok(rf['cp-39'].reason === 'the live page probe stopped early, so a quiet result cannot be trusted' && PR([pageOf({})], real(1), { protection: { kind: 'ProtectionStop', reason: '429' } })['cp-39'].reason === 'the live page probe stopped early, so a quiet result cannot be trusted', 'S3a2: "stopped early" stays where it is true (fewer loads than planned; a stop after a page loaded)');
    ok(typeof cpMod.liveSummary === 'function' && cpMod.liveSummary([], {}) === null && sent(null) === null && sent({ total: 0 }) === null, 'S3a: no live rows (or no summary): no sentence');
    ok(c500 && c500.gave === cpMod.evaluate({ work: { ...synth, probe: { schema: 1, planned: real(2), protection: null, pages: [pageOf({ status: 500 }), SK] } }, validation: { hypotheses: [] }, ran: { probe: true }, hasRoot: false }).filter(r => r.live_row && r.result !== 'NOT CHECKED').length, 'S3a: the count is taken from the real rows (live_row, result other than NOT CHECKED)');

    group('5. NOT DETECTED rows are never PASS or FAIL');
    const nd = cps.filter(c => c.coverage === 'NOT DETECTED').map(c => c.id);
    const everything = [rEws, rClean, rNo, Object.values(rs), Object.values(p0), Object.values(p5)];
    ok(everything.every(rows => rows.filter(r => nd.includes(r.id)).every(r => r.result === 'NOT CHECKED' && r.reason)), 'in every run the eight NOT DETECTED rows are NOT CHECKED with a reason');
    ok(be['cp-42'].reason === 'not checked yet: needs a REST probe, which does not exist yet', 'REST invalid JSON says "needs a REST probe"');
    ok(everything.every(rows => rows.filter(r => ['cp-36', 'cp-48', 'cp-51', 'cp-52'].includes(r.id)).every(r => r.result === 'NOT CHECKED' && r.reason === 'only the classic scan checks this')), 'the four classic-only rows say so in issue mode');

    group('6. determinism, and no verdict is touched');
    ok(JSON.stringify(run(ews)) === JSON.stringify(rEws) && JSON.stringify(run(clean)) === JSON.stringify(rClean), 'two runs over the same files give identical output');
    const before = JSON.stringify(ews.val.hypotheses.map(h => [h.id, h.status]));
    cpMod.evaluate({ work: cpMod.loadWork(ews.dir), validation: ews.val, ran: { probe: false }, hasRoot: true });
    ok(before === JSON.stringify(ews.val.hypotheses.map(h => [h.id, h.status])), 'no hypothesis status changed');
    const src = fs.readFileSync(path.join(__dirname, '..', 'issue', 'checkpoints.js'), 'utf8').replace(/\/\/.*$/gm, '');
    ok(!/CONFIRMED|REPRODUCIBLE|REJECTED_FALSE_POSITIVE|FIXED_VERIFIED/.test(src.replace(/h\.status !== 'REJECTED_FALSE_POSITIVE'/, '')) && !/require\(['"](https?|net|child_process|dns)['"]\)|fetch\(/.test(src), 'issue/checkpoints.js assigns no verdict and makes no network or process call');

    group('7. breaks_site and the tie context (classification only)');
    ok(cps.every(c => ['yes', 'no', 'depends'].includes(c.breaks_site)) && cps.find(c => c.id === 'cp-27').breaks_site === 'yes' && cps.find(c => c.id === 'cp-02').breaks_site === 'no', 'every checkpoint has breaks_site (yes / no / depends); syntax errors yes, a duplicate constant no');
    const tiedRows = cpMod.evaluate({ work: cpMod.loadWork(ews.dir), validation: ews.val, ran: { probe: false }, hasRoot: true, tie: { components: ['theme:unicamp'], files: [] } });
    const tt = T(tiedRows);
    ok(tt.pass === T(rEws).pass && tt.not_checked === T(rEws).not_checked && tt.fail + tt.also_noticed === T(rEws).fail && tiedRows.every(r => ['PASS', 'FAIL', 'ALSO NOTICED', 'NOT CHECKED'].includes(r.result)), 'a tie context only splits the old FAILs into FAIL and ALSO NOTICED; PASS and NOT CHECKED do not move');
    // REPORT-SPEC Part 2 (owner decision, amends HANDOFF decision 25): the weak-tie rows (duplicate AJAX action, same hook / priority, hook removal, outdated template override,
    // theme dequeuing plugin scripts) are never tied by sharing a component with the crash; only by a FILE of the crash evidence. Symptom rows stay FAIL.
    const bt = by(tiedRows);
    ok(cpMod.WEAK_TIE_ROWS && ['cp-06', 'cp-09', 'cp-10', 'cp-14', 'cp-15'].every(id => cpMod.WEAK_TIE_ROWS.has(id)) && cpMod.WEAK_TIE_ROWS.size === 5, 'the five weak-tie rows are cp-06, cp-09, cp-10, cp-14 and cp-15');
    ok(bt['cp-14'].result === 'ALSO NOTICED' && bt['cp-14'].tied_to_crash === false && tt.fail === 0 && tt.also_noticed === 1, `ews-style tree, the crash in the theme Unicamp: the template copies (same theme) are ALSO NOTICED, not FAIL (was 1 FAIL / 0 also noticed, now ${tt.fail} / ${tt.also_noticed})`);
    const tplFile = (((cpMod.loadWork(ews.dir).customCode || {}).observations || []).find(o => o.type === 'template-override-outdated' && (o.evidence || []).some(e => e.file)) || { evidence: [{}] }).evidence.find(e => e.file).file;
    const byTplFile = by(cpMod.evaluate({ work: cpMod.loadWork(ews.dir), validation: ews.val, ran: { probe: false }, hasRoot: true, tie: { components: [], files: [tplFile] } }));
    ok(tplFile && byTplFile['cp-14'].result === 'FAIL' && byTplFile['cp-14'].tied_to_crash === true, `a weak-tie row is still a FAIL when the crash evidence names one of its own files (${tplFile})`);
    const tieComp = { components: ['alpha', 'beta', 'theme:zeta'], files: [] };
    const weakSyn = { ...synth, graph: { edges: [{ id: 'e1', type: 'hook-same-priority', from: 'alpha', to: 'beta', hook: 'wp_footer' }], problems: [], truncated: false },
        customCode: { ...customCode, observations: [...customCode.observations, { id: 'obs-9', type: 'duplicate-ajax-action', action: 'save', components: ['alpha', 'beta'] }, { id: 'obs-10', type: 'handle-removed', handle: 'zeta-js', components: ['theme:zeta', 'alpha'] }, { id: 'obs-11', type: 'removes-other-component-hook', components: ['alpha', 'beta'] }] } };
    const ws = by(cpMod.evaluate({ work: weakSyn, validation: { hypotheses: [] }, ran: { probe: false }, hasRoot: true, tie: tieComp }));
    ok(['cp-06', 'cp-09', 'cp-10', 'cp-15'].every(id => ws[id].result === 'ALSO NOTICED' && ws[id].tied_to_crash === false) && ws['cp-02'].result === 'FAIL', 'synthetic: duplicate AJAX action, same hook / priority, hook removal and a dequeued script that share a crash component are ALSO NOTICED; a duplicate constant with the same components stays FAIL');
    const wsNoTie = by(cpMod.evaluate({ work: weakSyn, validation: { hypotheses: [] }, ran: { probe: false }, hasRoot: true }));
    ok(['cp-06', 'cp-09', 'cp-10', 'cp-15'].every(id => wsNoTie[id].result === 'FAIL'), 'without a tie context they are FAIL, as before (nothing is reclassified)');
    const sym = by(cpMod.evaluate({ work: { ...synth, probe: { planned: 1, protection: null, pages: [pageOf({ status: 503 })] } }, validation: { hypotheses: [] }, ran: { probe: true }, hasRoot: true, tie: { components: ['gamma'], files: [] } }));
    ok(sym['cp-38'].result === 'FAIL' && sym['cp-39'].result === 'FAIL' && sym['cp-38'].tied_to_crash && sym['cp-39'].tied_to_crash, 'the symptom rows (white screen, HTTP 5xx) stay FAIL with a tie context, tied by what they are');

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(failures ? `\n${failures} FAILED` : '\nAll checkpoint checks passed.');
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
