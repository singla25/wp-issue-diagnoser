#!/usr/bin/env node
// REPORT-SPEC Part 3, leftover L1: HOW the cited line names the missing class, said in the evidence line ("line 48 uses it as Scheme_Color").
//   (a) issue/fatal-recheck.js gains two DATA-ONLY fields on its result, `names_how` (namesClass().how) and `names_line` (namesClass().line). Nothing else in it changes:
//       with the two fields taken out, every status, every check (id, status, reason), the supports, the rule, line_ok, sound and repeated are EXACTLY the frozen baseline
//       captured from HEAD before the edit (scripts/fixtures/issue/names-class/baseline-checks.json).
//   (b) names_how / names_line are present and right for the alias, full-name, import and same-namespace cases (null when no line names the class).
//   (c) the reader wording (issue/whats-wrong.js) uses them; without them (older findings) it falls back to the old "(line 48 names Color)".
// Fixed dates (no clock), offline, fixtures only; validate.js is not changed. `node scripts/selftest-names-how.js --capture` rewrites the baseline (only ever from HEAD code).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-nameshow-'));
process.env.PLUGIN_GUARD_ISSUES = path.join(tmp, 'issues');
const store = require('../lib/issue-store');
const evidence = require('../issue/evidence'), analysis = require('../issue/analysis'), validate = require('../issue/validate'), resolve = require('../issue/resolve'), result = require('../issue/result');
const oracle = require('../issue/oracle'), fr = require('../issue/fatal-recheck'), whatsWrong = require('../issue/whats-wrong');

const CAPTURE = process.argv.includes('--capture');
const BASELINE = path.join(__dirname, 'fixtures', 'issue', 'names-class', 'baseline-checks.json');
let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const group = t => console.log(`\n== ${t}`);
const w = (root, rel, body = '<?php\n') => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); };
const CLASS = 'Elementor\\Core\\Schemes\\Color';
const FILE = 'wp-content/themes/unicamp/elementor/widgets/original/heading.php';
const EWS = 'http://localhost82.local.com/ews/';
const HEADING = fs.readFileSync(path.join(__dirname, 'fixtures', 'issue', 'names-class', 'heading.php'), 'utf8');
const HL = HEADING.split('\n');
const fileWith = (head, at, text, total = at + 4) => { const L = head.slice(); while (L.length < total) L.push('$z = 0;'); L[at - 1] = text; return L.join('\n'); };
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const stamp = d => `${String(d.getUTCDate()).padStart(2, '0')}-${MON[d.getUTCMonth()]}-${d.getUTCFullYear()} ${d.toISOString().slice(11, 19)}`;
// fixed times: the log entries, the issue's creation and the probe run (Rule A pairs them within 24 hours)
const T_LOG = new Date(Date.UTC(2026, 10, 3, 9, 15, 0)), T_RUN = '2026-11-03T11:15:00.000Z', T_OLD = new Date(Date.UTC(2026, 2, 16, 13, 11, 38));

// the scenarios: the class branch by each way of naming, a window with no naming at all, Rule B, and a function fatal
const SCEN = {
    alias: { heading: HEADING, probe: 500 },
    full: { heading: fileWith(['<?php', 'namespace Unicamp_Elementor;'], 48, "\t\t\t'type' => \\Elementor\\Core\\Schemes\\Color::get_type(),", 52), probe: 500 },
    import: { heading: fileWith(['<?php', 'namespace Unicamp_Elementor;', 'use Elementor\\Core\\Schemes\\Color;'], 48, "\t\t\t'type' => Color::get_type(),", 52), probe: 500 },
    samens: { heading: fileWith(['<?php', 'namespace Elementor\\Core\\Schemes;'], 48, "\t\t\t'type' => Color::get_type(),", 52), probe: 500 },
    bare: { heading: HL.map((l, i) => (i >= 46 && i <= 49 ? "\t\t\t'x' => 1," : l)).join('\n'), probe: 500 },
    ruleB: { heading: HEADING, at: T_OLD },
    fn: { heading: fileWith(['<?php'], 48, '$x = unicamp_helper();', 52), probe: 500, fn: 'unicamp_helper' }
};
function build(root, o) {
    w(root, 'wp-includes/version.php', "<?php\n$wp_version = '6.8.1';\n"); w(root, 'wp-config.php', '<?php\n');
    w(root, 'wp-content/plugins/elementor/elementor.php', '<?php\n/**\n * Plugin Name: Elementor\n * Version: 3.35.7\n */\nnamespace Elementor;\nclass Plugin {}\n');
    w(root, 'wp-content/themes/unicamp/style.css', '/*\nTheme Name: Unicamp\nVersion: 2.2.0\n*/');
    w(root, FILE, o.heading);
    w(root, 'wp-content/plugins/woocommerce/woocommerce.php', '<?php\n/**\n * Plugin Name: WooCommerce\n * Version: 10.6.1\n */\n');
    const d = o.at || T_LOG, d2 = new Date(d.getTime() + 1000);
    const err = o.fn ? `Uncaught Error: Call to undefined function ${o.fn}()` : `Uncaught Error: Class "${CLASS}" not found`;
    const one = t => `[${stamp(t)} UTC] PHP Fatal error:  ${err} in ${root}/${FILE}:48\nStack trace:\n#0 {main}\n  thrown in ${root}/${FILE} on line 48\n`;
    w(root, 'wp-content/debug.log', one(d) + one(d2));
}
const page = status => ({ console_errors: [], page_errors: [], error_responses: status >= 500 ? [{ url: EWS, status, type: 'document', same_site: true, source: { type: 'other', ref: null, name: 'localhost82.local.com' } }] : [], failed_requests: [], url: EWS, viewport: { name: 'laptop', width: 1280, height: 800 }, loaded: true, status, first_status: status, retried: false, outcome: status >= 500 ? 'server-error' : 'ok' });
const fingerprint = root => { const h = crypto.createHash('sha256'); const walk = d => { for (const n of fs.readdirSync(d).sort()) { const p = path.join(d, n), st = fs.lstatSync(p); h.update(path.relative(root, p) + ':' + st.size + ':'); if (st.isDirectory()) walk(p); else h.update(fs.readFileSync(p)); } }; walk(root); return h.digest('hex'); };
const readJ = (dir, f) => JSON.parse(fs.readFileSync(path.join(dir, 'work', f), 'utf8'));

async function run(name) {
    const o = SCEN[name];
    const root = path.join(tmp, name, 'wp'); build(root, o);
    const config = path.join(path.dirname(root), 'plugin-guard.config.json'); fs.writeFileSync(config, '{}');
    const before = fingerprint(root);
    const issue = store.create({ title: 'Critical error', description: 'The site shows a critical error', symptom: 'white-screen', environment: 'local', url: EWS, root, pages: [] });
    const dir = store.dirOf(issue.id);
    const fix = patch => { const j = JSON.parse(fs.readFileSync(path.join(dir, 'issue.json'), 'utf8')); Object.assign(j, patch); fs.writeFileSync(path.join(dir, 'issue.json'), JSON.stringify(j)); };
    fix({ created_at: T_RUN });
    await evidence.run(issue.id, { root, probeOptions: { probe: false } });
    if (o.probe) {
        fix({ probe_ran_at: T_RUN });
        const j = store.load(issue.id), pages = [page(o.probe)], obs = { pages, planned: 1, protection: null, debug_log: { new_bytes: 0, lines: 0 } };
        fs.writeFileSync(path.join(dir, 'work', 'probe.json'), JSON.stringify({ schema: 1, planned: { pages: [EWS], viewports: ['laptop 1280x800'], loads: 1, notes: [] }, protection: null, pages, oracle: oracle.evaluate(j.oracle, obs, { needsLogin: j.needs_login, symptom: j.symptom }), debug_log: obs.debug_log }));
    }
    analysis.run(issue.id, { root, config });
    const val = validate.run(issue.id, { root, config, lint: () => ({ ok: true, message: '' }) });
    const policy = validate.policyFor(root, config), plans = resolve.build(issue.id, val, { root, policy, dir });
    const res = result.write(issue.id, { validation: val, plans, dir, root, policy, gate: true });
    // the same re-check called directly, with the arguments validate.js passes
    const hyp = readJ(dir, 'hypotheses.json'), ev = readJ(dir, 'evidence.json'), cc = readJ(dir, 'custom-code.json');
    let probe = null; try { probe = readJ(dir, 'probe.json'); } catch { /* no probe */ }
    const hs = hyp.hypotheses.find(h => h.type === 'missing-function');
    const direct = hs ? fr.recheck({ h: hs, clues: ev.clues, root, probe, issue: store.load(issue.id), intake: null, components: cc.components || [], sandbox: null }) : null;
    return { name, root, id: issue.id, val, direct, f: res.findings, same: before === fingerprint(root) };
}
const norm = (r, t) => String(t).split(r.root).join('ROOT').split(r.id).join('ISSUE');
// the frozen part: what must not change when the two data fields are added
const pickFr = (r, x) => (x ? { rule: x.rule, supports: x.supports, line_ok: x.line_ok, sound: x.sound, repeated: x.repeated, checks: x.checks.map(c => ({ id: c.id, status: c.status, reason: norm(r, c.reason) })) } : null);
const snapshot = r => ({
    hypotheses: r.val.hypotheses.map(h => ({ type: h.type, title: norm(r, h.title), status: h.status, independent_kinds: h.independent_kinds, checks: h.checks.map(c => ({ id: norm(r, c.id), status: c.status, reason: norm(r, c.reason) })), fatal_recheck: pickFr(r, h.fatal_recheck) })),
    symptom_reproduced: r.val.symptom_reproduced,
    direct: pickFr(r, r.direct)
});
// the full result with the two new fields removed: the rest must be the old result exactly
const without = x => { if (!x) return x; const { names_how, names_line, ...rest } = x; return rest; };   // eslint-disable-line no-unused-vars

(async () => {
    const runs = {};
    for (const n of Object.keys(SCEN)) runs[n] = await run(n);
    if (CAPTURE) {
        fs.writeFileSync(BASELINE, JSON.stringify(Object.fromEntries(Object.entries(runs).map(([n, r]) => [n, snapshot(r)])), null, 2) + '\n');
        console.log(`baseline written: ${BASELINE}`);
        fs.rmSync(tmp, { recursive: true, force: true });
        process.exit(0);
    }
    const base = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));

    group('(a) with the two new fields removed, everything equals the frozen baseline from HEAD');
    ok(Object.keys(base).join() === Object.keys(SCEN).join(), `the baseline has the same ${Object.keys(SCEN).length} scenarios (${Object.keys(SCEN).join(', ')})`);
    ok(base.alias.hypotheses.find(h => h.type === 'missing-function').status === 'CONFIRMED' && base.ruleB.hypotheses.find(h => h.type === 'missing-function').fatal_recheck.rule === 'B' && base.bare.hypotheses.find(h => h.type === 'missing-function').fatal_recheck.line_ok === false, 'the baseline itself: alias confirmed (Rule A), the stale entry by Rule B, the bare window not re-read');
    for (const [n, r] of Object.entries(runs)) {
        const now = snapshot({ ...r, val: { ...r.val, hypotheses: r.val.hypotheses.map(h => ({ ...h, fatal_recheck: without(h.fatal_recheck) })) }, direct: without(r.direct) });
        const b = base[n];
        ok(JSON.stringify(now.hypotheses.map(h => [h.type, h.title, h.status])) === JSON.stringify(b.hypotheses.map(h => [h.type, h.title, h.status])), `${n}: every hypothesis has the baseline status (${now.hypotheses.map(h => h.status).join(', ')})`);
        ok(JSON.stringify(now.hypotheses.map(h => h.checks)) === JSON.stringify(b.hypotheses.map(h => h.checks)), `${n}: every check id, status and reason equals the baseline`);
        ok(JSON.stringify(now.hypotheses.map(h => h.fatal_recheck)) === JSON.stringify(b.hypotheses.map(h => h.fatal_recheck)) && JSON.stringify(now.direct) === JSON.stringify(b.direct), `${n}: rule, supports, line_ok, sound, repeated and the re-check's own checks equal the baseline (through validate.js and called directly)`);
        ok(now.symptom_reproduced === b.symptom_reproduced && JSON.stringify(now) === JSON.stringify(b), `${n}: the whole frozen snapshot is identical`);
        const h = r.val.hypotheses.find(x => x.fatal_recheck);
        if (h) ok(JSON.stringify(Object.keys(h.fatal_recheck).filter(k => !['names_how', 'names_line'].includes(k))) === JSON.stringify(Object.keys(without(h.fatal_recheck))) && Object.keys(h.fatal_recheck).filter(k => /^names_/.test(k)).sort().join() === 'names_how,names_line', `${n}: the result has exactly two new keys (names_how, names_line) and no other change of shape`);
    }

    group('(b) names_how and names_line for each way of naming the class');
    const frOf = n => (runs[n].val.hypotheses.find(x => x.fatal_recheck) || {}).fatal_recheck || {};
    const EXPECT = { alias: ['names it through its alias Scheme_Color', 48], full: ['names the class by its full name', 48], import: ['names it through its import', 48], samens: ["names it through the file's own namespace", 48], bare: [null, null], ruleB: ['names it through its alias Scheme_Color', 48], fn: ['names unicamp_helper', 48] };
    for (const [n, [how, line]] of Object.entries(EXPECT)) ok(frOf(n).names_how === how && frOf(n).names_line === line && (!runs[n].direct || (runs[n].direct.names_how === how && runs[n].direct.names_line === line)), `${n}: names_how ${JSON.stringify(how)}, names_line ${line} (through validate.js and directly)`);

    group('(c) the reader wording');
    const sureOf = n => { const c = (runs[n].f.case_file.cases || []).find(x => x.n === 1) || { rows: [] }; return (c.rows.find(x => x[0] === 'How sure') || [0, []])[1].join(' | '); };
    const boxOf = n => (runs[n].f.what_is_wrong ? runs[n].f.what_is_wrong.lines.join(' | ') : '');
    const WANT = { alias: 'line 48 uses it as Scheme_Color', full: 'line 48 uses the full name Elementor\\Core\\Schemes\\Color', import: 'line 48 uses it by its imported name Color', samens: 'line 48 uses it (same namespace)' };
    for (const [n, t] of Object.entries(WANT)) ok(sureOf(n).includes(`The file and line were read again (${t}).`) && boxOf(n).includes(`file and line re-read (${t}).`) && !/names Color\)/.test(sureOf(n) + boxOf(n)), `${n}: "The file and line were read again (${t})." in Case 1 and in the box`);
    const comps = [{ ref: 'theme:unicamp', kind: 'theme', slug: 'unicamp', name: 'Unicamp', version: '2.2.0' }];
    const ctx = { components: comps, issue: { created_at: T_RUN }, probePages: [], advisories: [], ran: {}, fileComponent: 'theme:unicamp' };
    const old = { ...without(frOf('alias')) };
    const bOld = whatsWrong.build(old, ctx, 'confirmed');
    ok(bOld.case.sure.includes('The file and line were read again (line 48 names Color).') && bOld.lines.some(l => l.endsWith('file and line re-read (line 48 names Color).')), 'a re-check result without the new fields (an older findings file): the old wording "(line 48 names Color)"');
    const fnB = whatsWrong.build(frOf('fn'), ctx, 'likely');
    ok(fnB.case.sure.includes('The file and line were read again (line 48 names unicamp_helper).'), 'a function fatal keeps today\'s wording ("line 48 names unicamp_helper")');
    const moved = whatsWrong.build({ ...frOf('alias'), names_line: 49 }, ctx, 'confirmed');
    ok(moved.case.sure.includes('The file and line were read again (line 49 uses it as Scheme_Color).'), 'the line that names the class is the one said (a line next to the cited one)');
    ok(Object.values(runs).every(r => r.same), 'no site folder was written (fingerprint before and after)');

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(failures ? `\n${failures} FAILED` : '\nAll names-how checks passed.');
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
