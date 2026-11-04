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
    ok(rNo.filter(r => cps.find(c => c.id === r.id).evaluator && cps.find(c => c.id === r.id).reached_in !== 'Classic' && !['cp-38', 'cp-39', 'cp-40', 'cp-41', 'cp-43', 'cp-44', 'cp-45', 'cp-20'].includes(r.id)).every(r => /no local copy of the site/.test(r.reason) || /no log|PHP version/.test(r.reason)), 'every code-reading row names the missing folder as the reason');
    // the guard: the work files of the ews run are still there, but the caller says there was no root and no probe: nothing may turn into a PASS
    const guard = cpMod.evaluate({ work: cpMod.loadWork(ews.dir), validation: ews.val, ran: { probe: false, sandbox: false }, hasRoot: false });
    ok(T(guard).pass === 0 && T(guard).fail === 0, 'hasRoot false with leftover work files: still no PASS and no FAIL from a missing source');
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
