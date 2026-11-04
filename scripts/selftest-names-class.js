#!/usr/bin/env node
// Pre-Part-3 step (I) and (II): does the cited line name the missing CLASS (issue/fatal-recheck.js namesClass), and what a confirmed case says about the log date and the live site.
//   (I)  a line within WINDOW of the cited line names the class only by its full name, an alias imported in the same file (`use Full as Alias;`), or its short name when the
//        file imports it unaliased or is in the class's own namespace. A bare short name, `use` / `namespace` lines, comment lines and `$Alias` never pass.
//        The function-fatal branch keeps its earlier matching exactly.
//   (II) Rule B is unchanged (owner decision 2026-11-04). A confirmed case shows the log entry's date and, when no live page was loaded, "Not checked on the live site."
// Main fixture: the real lines 1-58 of the ews theme file (scripts/fixtures/issue/names-class/heading.php): line 6 `use Elementor\Core\Schemes\Color as Scheme_Color;`,
// line 46 `Controls_Manager::COLOR`, line 48 `Scheme_Color::get_type()` (the fatal's line), line 49 `Scheme_Color::COLOR_1`. Offline; fixtures only; validate.js is not changed.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-namesclass-'));
process.env.PLUGIN_GUARD_ISSUES = path.join(tmp, 'issues');
const store = require('../lib/issue-store');
const evidence = require('../issue/evidence'), analysis = require('../issue/analysis'), validate = require('../issue/validate'), resolve = require('../issue/resolve'), result = require('../issue/result');
const oracle = require('../issue/oracle'), fr = require('../issue/fatal-recheck'), caseFile = require('../issue/case-file');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const group = t => console.log(`\n== ${t}`);
const w = (root, rel, body = '<?php\n') => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); };
const CLASS = 'Elementor\\Core\\Schemes\\Color';
const FILE = 'wp-content/themes/unicamp/elementor/widgets/original/heading.php';
const HEADING = fs.readFileSync(path.join(__dirname, 'fixtures', 'issue', 'names-class', 'heading.php'), 'utf8');
const HL = HEADING.split('\n');
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const stamp = d => `${String(d.getUTCDate()).padStart(2, '0')}-${MON[d.getUTCMonth()]}-${d.getUTCFullYear()} ${d.toISOString().slice(11, 19)}`;
const dateWords = d => `${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
const N = (lines, line, full = CLASS, short = 'Color') => fr.namesClass(lines, line, full, false, short);
// a file whose line `at` is `text` (1-based), with neutral code around it
const fileWith = (head, at, text, total = at + 4) => { const L = head.slice(); while (L.length < total) L.push('$z = 0;'); L[at - 1] = text; return L; };
// the function branch exactly as it was before this step (fatal-recheck.js, the one-line test it replaced)
const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const OLD_FN = (lines, line, full, short) => lines.slice(Math.max(0, line - 1 - fr.WINDOW), Math.min(lines.length, line + fr.WINDOW)).some(l => l.replace(/\\\\/g, '\\').toLowerCase().includes(full.toLowerCase()) || new RegExp(`(^|[^\\w$])${esc(short)}\\b`, 'i').test(l));

// ---- the pipeline (issue investigate --gate), as in selftest-cause-detail.js ----
const EWS = 'http://localhost82.local.com/ews/';
const fingerprint = root => { const h = crypto.createHash('sha256'); const walk = d => { for (const n of fs.readdirSync(d).sort()) { const p = path.join(d, n), st = fs.lstatSync(p); h.update(path.relative(root, p) + ':' + st.size + ':'); if (st.isDirectory()) walk(p); else h.update(fs.readFileSync(p)); } }; walk(root); return h.digest('hex'); };
// o: heading (file text), log ('fatal' | 'none'), at (Date of the log entries), templates
function build(root, o = {}) {
    w(root, 'wp-includes/version.php', "<?php\n$wp_version = '6.8.1';\n"); w(root, 'wp-config.php', '<?php\n');
    w(root, 'wp-content/plugins/elementor/elementor.php', '<?php\n/**\n * Plugin Name: Elementor\n * Version: 3.35.7\n */\nnamespace Elementor;\nclass Plugin {}\n');
    w(root, 'wp-content/themes/unicamp/style.css', '/*\nTheme Name: Unicamp\nVersion: 2.2.0\n*/');
    w(root, FILE, o.heading || HEADING);
    w(root, 'wp-content/plugins/woocommerce/woocommerce.php', '<?php\n/**\n * Plugin Name: WooCommerce\n * Version: 10.6.1\n */\n');
    for (let i = 1; i <= (o.templates || 0); i++) { w(root, `wp-content/plugins/woocommerce/templates/t${i}/t${i}.php`, '<?php\n/**\n * @version 9.0.0\n */\n'); w(root, `wp-content/themes/unicamp/woocommerce/t${i}/t${i}.php`, '<?php\n/**\n * @version 3.0.0\n */\n'); }
    if ((o.log || 'fatal') === 'none') return;
    const d = o.at || new Date(Date.now() - 2 * 3600e3), d2 = new Date(d.getTime() + 1000);
    const one = t => `[${stamp(t)} UTC] PHP Fatal error:  Uncaught Error: Class "${CLASS}" not found in ${root}/${FILE}:48\nStack trace:\n#0 {main}\n  thrown in ${root}/${FILE} on line 48\n`;
    w(root, 'wp-content/debug.log', one(d) + one(d2));
}
const page = status => ({ console_errors: [], page_errors: [], error_responses: status >= 500 ? [{ url: EWS, status, type: 'document', same_site: true, source: { type: 'other', ref: null, name: 'localhost82.local.com' } }] : [], failed_requests: [], url: EWS, viewport: { name: 'laptop', width: 1280, height: 800 }, loaded: true, status, first_status: status, retried: false, outcome: status >= 500 ? 'server-error' : 'ok' });
const probeWrite = (dir, pages) => {
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'issue.json'), 'utf8')); j.probe_ran_at = new Date().toISOString(); fs.writeFileSync(path.join(dir, 'issue.json'), JSON.stringify(j));
    const obs = { pages, planned: pages.length, protection: null, debug_log: { new_bytes: 0, lines: 0 } };
    const ans = oracle.evaluate(j.oracle, obs, { needsLogin: j.needs_login, symptom: j.symptom });
    fs.writeFileSync(path.join(dir, 'work', 'probe.json'), JSON.stringify({ schema: 1, planned: { pages: [EWS], viewports: ['laptop 1280x800'], loads: pages.length, notes: [] }, protection: null, pages, oracle: ans, debug_log: obs.debug_log }));
};
async function run(name, o = {}) {
    const root = path.join(tmp, name, 'wp'); build(root, o);
    const config = path.join(path.dirname(root), 'plugin-guard.config.json'); fs.writeFileSync(config, '{}');
    const before = fingerprint(root);
    const issue = store.create({ title: 'Critical error', description: 'The site shows a critical error', symptom: o.symptom || 'white-screen', environment: 'local', url: EWS, root, pages: [] });
    await evidence.run(issue.id, { root, probeOptions: { probe: false } });
    const dir = store.dirOf(issue.id);
    if (o.probe) probeWrite(dir, [page(o.probe)]);
    analysis.run(issue.id, { root, config });
    const val = validate.run(issue.id, { root, config, lint: () => ({ ok: true, message: '' }) });
    const policy = validate.policyFor(root, config), plans = resolve.build(issue.id, val, { root, policy, dir });
    result.write(issue.id, { validation: val, plans, dir, root, policy, gate: true });
    const f = JSON.parse(fs.readFileSync(path.join(dir, 'result', 'findings.json'), 'utf8'));
    const h = val.hypotheses.find(x => x.type === 'missing-function');
    return { f, h, val, same: before === fingerprint(root), md: fs.readFileSync(path.join(dir, 'result', 'ISSUE-REPORT.md'), 'utf8'), chk: id => ((h && h.checks) || []).find(c => c.id === `fatal:${id}`) || {} };
}
const confirmed = r => r.val.hypotheses.some(h => ['CONFIRMED', 'REPRODUCIBLE'].includes(h.status));
const sureOf = r => { const c = (r.f.case_file.cases || []).find(x => x.n === 1) || { rows: [] }; return ((c.rows.find(x => x[0] === 'How sure') || [0, []])[1]); };

(async () => {
    group('(I) the real ews file: alias imported on line 6, the fatal on line 48');
    ok(/^use Elementor\\Core\\Schemes\\Color as Scheme_Color;$/.test(HL[5]) && /Controls_Manager::COLOR/.test(HL[45]) && /'type'\s+=> Scheme_Color::get_type\(\),/.test(HL[47]) && /Scheme_Color::COLOR_1/.test(HL[48]) && /'before_end_section_title_style',/.test(HL[24]), 'the fixture holds the real lines (6 use ... as Scheme_Color; 25 the method name of the add_action; 46 Controls_Manager::COLOR; 48 and 49 Scheme_Color)');
    const r48 = N(HL, 48);
    ok(r48.ok && r48.line === 48 && r48.how === 'names it through its alias Scheme_Color', `case 2: line 48 names the class through the alias imported on line 6 (${r48.how})`);
    // case 1: the same file with the alias usages taken out of the window: Controls_Manager::COLOR is the only "Color" left near the cited line
    const noAlias = HL.map((l, i) => (i >= 46 && i <= 49 ? "\t\t\t'x' => 1," : l));
    const r46 = N(noAlias, 46);
    ok(!r46.ok && r46.line === null, 'case 1: a window holding only Controls_Manager::COLOR (no alias usage): FAIL (a bare short name never passes)');
    const L1 = fileWith(['<?php', 'namespace Unicamp_Elementor;', 'use Elementor\\Controls_Manager;', 'use Elementor\\Core\\Schemes\\Color as Scheme_Color;'], 10, "'type' => Controls_Manager::COLOR,", 20);
    ok(!N(L1, 10).ok, 'case 1 (small file): `Controls_Manager::COLOR` with the alias imported but not used near the line: FAIL');

    group('(I) the short name from another namespace, the import and the namespace');
    const other = fileWith(['<?php', 'namespace Unicamp_Elementor;', 'use Other\\Color;'], 10, '$x = Color::get_type();');
    ok(!N(other, 10).ok, 'case 3: `use Other\\Color;` and `Color::get_type()` on the line: FAIL (same short name, another class)');
    const otherNs = fileWith(['<?php', 'namespace Acme\\Schemes;'], 10, '$x = Color::get_type();');
    ok(!N(otherNs, 10).ok, 'case 3b: `Color::get_type()` in the namespace Acme\\Schemes (no import): FAIL');
    const aliasedOther = fileWith(['<?php', 'namespace Elementor\\Core\\Schemes;', 'use Other\\Thing as Color;'], 10, '$x = Color::get_type();');
    ok(!N(aliasedOther, 10).ok, 'case 3c: the class\'s own namespace, but `Color` is the alias of another class: FAIL');
    const imp = fileWith(['<?php', 'namespace Unicamp_Elementor;', 'use Elementor\\Core\\Schemes\\Color;'], 10, '$x = Color::get_type();');
    const rImp = N(imp, 10);
    ok(rImp.ok && rImp.how === 'names it through its import', `the short name with an unaliased import (\`use ${CLASS};\`): PASS (${rImp.how})`);
    const impLead = fileWith(['<?php', 'USE \\ELEMENTOR\\Core\\Schemes\\color;'], 10, '$x = new Color();');
    ok(N(impLead, 10).ok, 'an import with a leading backslash and mixed case: PASS');
    const ownNs = fileWith(['<?php', 'namespace Elementor\\Core\\Schemes;'], 10, '$x = Color::get_type();');
    ok(N(ownNs, 10).ok && N(ownNs, 10).how === "names it through the file's own namespace", 'the short name in the class\'s own namespace: PASS');

    group('(I) the full name');
    ok(N(fileWith(['<?php'], 10, '$c = Elementor\\Core\\Schemes\\Color::get_type();'), 10).how === 'names the class by its full name', 'case 4: the full name on the line: PASS ("names the class by its full name")');
    ok(N(fileWith(['<?php'], 10, '$c = \\Elementor\\Core\\Schemes\\Color::x();'), 10).ok, 'case 5: a leading backslash: PASS');
    ok(N(fileWith(['<?php'], 10, '$c = new \\ELEMENTOR\\core\\schemes\\COLOR();'), 10).ok, 'case 5: mixed case ELEMENTOR\\core\\schemes\\COLOR: PASS');
    ok(N(fileWith(['<?php'], 10, "if ( class_exists( 'Elementor\\\\Core\\\\Schemes\\\\Color' ) ) {"), 10).ok, 'doubled backslashes (escaped in a string): PASS');
    ok(!N(fileWith(['<?php'], 10, '$c = Foo\\Elementor\\Core\\Schemes\\Color::x();'), 10).ok && !N(fileWith(['<?php'], 10, '$c = \\Elementor\\Core\\Schemes\\ColorPicker::x();'), 10).ok && !N(fileWith(['<?php'], 10, '$c = \\Elementor\\Core\\Schemes\\Color\\Sub::x();'), 10).ok, 'a longer name (Foo\\..., ...ColorPicker, ...Color\\Sub) is not the class: FAIL');

    group('(I) the full name must be a class reference, resolved as PHP resolves it');
    const WC = (head, text) => N(fileWith(head, 10, text), 10, 'WC_Product', 'WC_Product').ok;
    const noNs = ['<?php'], fooNs = ['<?php', 'namespace Foo;'];
    ok(!WC(noNs, '$WC_Product = 1;'), 'a `$WC_Product` variable: FAIL');
    ok(!WC(noNs, '$x->WC_Product();'), '`$x->WC_Product()` (a method): FAIL');
    ok(!WC(noNs, '$y = Foo::WC_Product;'), '`Foo::WC_Product` (a constant): FAIL');
    ok(!WC(fooNs, '$p = new WC_Product();'), '`new WC_Product()` in a file with `namespace Foo;` (PHP reads Foo\\WC_Product): FAIL');
    ok(WC(noNs, '$p = new WC_Product();'), 'the same line in a file with no namespace: PASS');
    ok(WC(fooNs, '$p = new \\WC_Product();'), '`new \\WC_Product()` (leading backslash) in namespace Foo: PASS');
    ok(!N(fileWith(fooNs, 10, "'type' => Elementor\\Controls_Manager::COLOR,"), 10, 'Elementor\\Controls_Manager', 'Controls_Manager').ok, '`Elementor\\Controls_Manager::COLOR` (qualified, no leading backslash) in namespace Foo: FAIL');
    ok(N(fileWith(fooNs, 10, "'type' => \\Elementor\\Controls_Manager::COLOR,"), 10, 'Elementor\\Controls_Manager', 'Controls_Manager').ok, '`\\Elementor\\Controls_Manager::COLOR` with a leading backslash in namespace Foo: PASS');
    ok(!N(fileWith(fooNs, 10, '$c = Elementor\\Core\\Schemes\\Color::get_type();'), 10).ok, `${CLASS} without a leading backslash in namespace Foo: FAIL`);
    ok(N(fileWith(fooNs, 10, "if ( class_exists( 'Elementor\\\\Core\\\\Schemes\\\\Color' ) ) {"), 10).ok, 'inside a string a class name is always fully qualified (class_exists in namespace Foo): PASS');

    group('(I) a string names the class only when it is just the name');
    const S = text => N(fileWith(fooNs, 10, text), 10).ok;
    ok(S("if ( class_exists( '\\\\Elementor\\\\Core\\\\Schemes\\\\Color' ) ) {"), "class_exists( '\\\\Elementor\\\\Core\\\\Schemes\\\\Color' ) (leading backslash, whole string) in namespace Foo: PASS");
    ok(S("if ( class_exists( 'Elementor\\Core\\Schemes\\Color' ) ) {"), "class_exists( 'Elementor\\Core\\Schemes\\Color' ) (no leading backslash, whole string): PASS");
    ok(!S("$m = 'Install Elementor\\Core\\Schemes\\Color please';"), 'the name inside a longer single-quoted message: FAIL');
    ok(!S('$m = "Install Elementor\\\\Core\\\\Schemes\\\\Color please";'), 'the name inside a longer double-quoted message: FAIL');
    ok(!S("$cb = 'Elementor\\Core\\Schemes\\Color::get_type';"), "a 'Full::something' string: FAIL");

    group('(I) $Alias, ->Alias, ::Alias');
    const al = ['<?php', 'namespace Unicamp_Elementor;', 'use Elementor\\Core\\Schemes\\Color as Scheme_Color;'];
    ok(!N(fileWith(al, 10, '$Scheme_Color = 1;'), 10).ok, 'case 6: a `$Scheme_Color` variable: FAIL');
    ok(!N(fileWith(al, 10, '$x = $obj->Scheme_Color;'), 10).ok && !N(fileWith(al, 10, '$x = Foo::Scheme_Color;'), 10).ok && !N(fileWith(al, 10, '$x = My_Scheme_Color::x();'), 10).ok, '->Scheme_Color, Foo::Scheme_Color and My_Scheme_Color: FAIL');
    ok(N(fileWith(al, 10, '$x = new Scheme_Color();'), 10).how === 'names it through its alias Scheme_Color', '`new Scheme_Color()`: PASS through the alias');
    ok(!N(fileWith(al, 10, "$x = 'Scheme_Color';"), 10).ok, 'the alias only inside a string: FAIL');

    group('(I) use / namespace / comment lines never pass by themselves');
    const alone = (text, head = ['<?php']) => N(fileWith(head, 10, text, 14), 10).ok;
    ok(!alone('use Elementor\\Core\\Schemes\\Color;'), 'case 7: a `use Elementor\\Core\\Schemes\\Color;` line (and nothing else using it): FAIL');
    ok(!alone('use Elementor\\Core\\Schemes\\Color as Scheme_Color;'), 'case 7: a `use ... as Scheme_Color;` line: FAIL');
    ok(!alone('namespace Elementor\\Core\\Schemes\\Color;'), 'case 7: a `namespace` line: FAIL');
    ok(!alone('// \\Elementor\\Core\\Schemes\\Color::get_type()'), 'case 7: a // comment line: FAIL');
    ok(!alone('# \\Elementor\\Core\\Schemes\\Color::get_type()'), 'case 7: a # comment line: FAIL');
    ok(!alone('/* \\Elementor\\Core\\Schemes\\Color::get_type() */'), 'case 7: a /* ... */ line: FAIL');
    ok(!alone(' * @param \\Elementor\\Core\\Schemes\\Color $c'), 'case 7: a leading-* docblock line: FAIL');
    ok(!alone(' */ // \\Elementor\\Core\\Schemes\\Color'), 'case 7: a */ line: FAIL');
    const inBlock = fileWith(['<?php', '/*'], 10, '   $c = \\Elementor\\Core\\Schemes\\Color::get_type();', 14); inBlock[11] = '*/';
    ok(!N(inBlock, 10).ok, 'case 7: a line inside a /* ... */ block that does not start with *: FAIL (the block is followed from the file start)');
    ok(!alone('$x = 1; // \\Elementor\\Core\\Schemes\\Color'), 'a trailing comment after code: FAIL');
    ok(!alone('$x = Scheme_Color::x(); // alias used, but no import', ['<?php']) && !alone('$x = Color::x();', ['<?php']), 'an alias nobody imported, and a bare short name in a file with no namespace and no import: FAIL');

    group('(I) case 8: the function-fatal branch is unchanged');
    const fnCases = [
        [['<?php', '$a = 1;', '$x = my_helper();', '$b = 2;'], 3, 'my_helper', 'my_helper'],
        [['<?php', '$x = \\my_helper ();'], 2, 'my_helper', 'my_helper'],
        [['<?php', '$x = $this->get_thing();'], 2, 'Foo::get_thing', 'get_thing'],
        [['<?php', '// my_helper() in a comment'], 2, 'my_helper', 'my_helper'],
        [['<?php', '$my_helper = 1;'], 2, 'my_helper', 'my_helper'],
        [['<?php', '$x = other_fn();'], 2, 'my_helper', 'my_helper'],
        [['<?php', "$x = 'Acme\\\\Lib\\\\run';"], 2, 'Acme\\Lib\\run', 'run']
    ];
    const fnSame = fnCases.every(([L, n, full, short]) => fr.namesClass(L, n, full, true, short).ok === OLD_FN(L, n, full, short));
    ok(fnSame, `the function branch gives the same answer as the old one-line test on ${fnCases.length} windows (incl. a comment, a $variable and a namespaced name)`);
    ok(fr.namesClass(fnCases[0][0], 3, 'my_helper', true, 'my_helper').ok && fr.namesClass(fnCases[2][0], 2, 'Foo::get_thing', true, 'get_thing').ok, 'a function fatal still passes by its short name (my_helper(), ->get_thing())');
    ok(fr.namesClass(fnCases[3][0], 2, 'my_helper', true, 'my_helper').ok === true, 'and, as before, the function branch does not skip comment lines (BACKLOG: same rigor as the class branch)');

    group('(I) case 9: end to end through validate.js');
    const ewsA = await run('ews-a', { probe: 500 });
    ok(ewsA.h && ewsA.h.status === 'CONFIRMED' && ewsA.h.fatal_recheck.rule === 'A', `the ews fixture (real heading.php lines, fresh fatal, HTTP 500): CONFIRMED by Rule A (${ewsA.h && ewsA.h.status})`);
    ok(ewsA.chk('fatal-line').status === 'PASSED' && /line 48 of .*heading\.php \(re-read\) names it through its alias Scheme_Color$/.test(ewsA.chk('fatal-line').reason), `the check says which rule matched: "${ewsA.chk('fatal-line').reason}"`);
    const bare = await run('ews-bare', { probe: 500, heading: noAlias.join('\n') });
    ok(bare.h && bare.h.status !== 'CONFIRMED' && bare.chk('fatal-line').status === 'FAILED' && /^no line within 2 lines of 48 in .*heading\.php uses the class Elementor\\Core\\Schemes\\Color/.test(bare.chk('fatal-line').reason) && !/names Color/.test(bare.chk('fatal-line').reason), `the same site with only Controls_Manager::COLOR near line 48: not confirmed, and the check says no line uses the class (${bare.h && bare.h.status})`);
    const healthy = await run('healthy', { log: 'none', probe: 200 });
    ok(!confirmed(healthy) && !healthy.f.findings.length, 'a healthy site (no fatal in the log, the page answered 200): nothing CONFIRMED');
    const adv = await run('advisory', { log: 'none', templates: 5, probe: 500 });
    ok(!confirmed(adv) && !adv.f.findings.filter(x => x.label !== 'compromise').length, 'an advisory-only site (outdated template overrides only), even with a 5xx page: nothing CONFIRMED');
    const fine = await run('fine', { probe: 200 });
    ok(fine.h && !['CONFIRMED', 'REPRODUCIBLE'].includes(fine.h.status), `the same log line, but the live page answered 200: not CONFIRMED (${fine.h && fine.h.status})`);

    group('(II) Rule B as it is: a stale fatal on a healthy site');
    const OLD = new Date(Date.UTC(2026, 2, 16, 13, 11, 38));
    const staleNoProbe = await run('stale-noprobe', { at: OLD });
    // the current truth, stated explicitly (owner decision 2026-11-04: Rule B stays): an old log fatal with nothing defining the class is CONFIRMED with no live check at all
    ok(staleNoProbe.h && staleNoProbe.h.status === 'CONFIRMED' && staleNoProbe.h.fatal_recheck.rule === 'B', `a stale fatal (16 Mar 2026), NO probe: CONFIRMED through Rule B (${staleNoProbe.h && staleNoProbe.h.status}, rule ${staleNoProbe.h && staleNoProbe.h.fatal_recheck && staleNoProbe.h.fatal_recheck.rule}) — documented, not endorsed`);
    const sB = sureOf(staleNoProbe);
    ok(sB[0] === 'Confirmed by two independent checks. Not yet tested on a copy of your site.', `the owner's confirmed sentence, exactly: "${sB[0]}"`);
    ok(sB.includes('Last seen in your log on 16 Mar 2026.') && sB.includes('Not checked on the live site.') && sB.includes(caseFile.NOT_LIVE_SENTENCE), 'the case shows "Last seen in your log on 16 Mar 2026." and "Not checked on the live site."');
    ok(!sB.some(l => /last seen 16 Mar 2026/.test(l)) && sB.some(l => /^Found in your log 2 times/.test(l)) && !sB.some(l => /answered HTTP/.test(l)), 'the date is said once (its own line), the log count stays, no live answer is claimed');
    ok(/Seen in your log on 16 Mar 2026, not checked live\./.test(staleNoProbe.h.fatal_recheck.text.lines.join(' ')), 'the Rule B wording of fatal-recheck.js is unchanged ("Seen in your log on 16 Mar 2026, not checked live.")');
    ok(staleNoProbe.md.includes('Last seen in your log on 16 Mar 2026.') && staleNoProbe.md.includes('Not checked on the live site.'), 'the Markdown carries both lines');
    const staleFine = await run('stale-fine', { at: OLD, probe: 200 });
    ok(staleFine.h && !['CONFIRMED', 'REPRODUCIBLE'].includes(staleFine.h.status), `a stale fatal and a probe that loaded the page fine: NOT confirmed (${staleFine.h && staleFine.h.status})`);
    group('(II) a confirmed case with a live check');
    const sA = sureOf(ewsA);
    ok(sA[0] === 'Confirmed by two independent checks. Not yet tested on a copy of your site.' && sA.includes('The live page answered HTTP 500.') && !sA.includes('Not checked on the live site.') && sA.includes(`Last seen in your log on ${dateWords(new Date(Date.now() - 2 * 3600e3))}.`), 'Rule A: the confirmed sentence, "The live page answered HTTP 500.", the log date, and no "Not checked on the live site."');
    ok([ewsA, bare, healthy, adv, fine, staleNoProbe, staleFine].every(r => r.same), 'no site folder was written (fingerprint before and after)');

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(failures ? `\n${failures} FAILED` : '\nAll names-class checks passed.');
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
