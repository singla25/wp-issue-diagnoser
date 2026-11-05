#!/usr/bin/env node
// Step 7a: less noise, clearer words (offline, fixtures only; nothing here changes a status or a verdict).
//   1  cp-08  options WordPress itself creates are ignored (an explicit list, no wildcards); a plugin's own option is still reported
//   2  cp-13  a use of another plugin is a hard dependency unless THAT USE is guarded (per use, not per file)
//   3  same-vendor core + Pro pairs (slug + -pro / -premium / -plus AND the same Author header): shared names are not a clash; the exact sentence; an older core
//   4  healthy-site report: no settings tip as "Fix", "probably not the crash" only for a crash, de-duplicated "Not tested", skipped-PHP wording with real counts
//   5  cp-24 / cp-25 mysql_query(): only a guarded call is left out
//   6  cp-22 / cp-25 repeat cp-09 / cp-24: shown as "same finding as ..."; the counts are unchanged (see the note there)
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-7a-'));
process.env.PLUGIN_GUARD_ISSUES = path.join(tmp, 'issues');
const store = require('../lib/issue-store');
const evidence = require('../issue/evidence'), analysis = require('../issue/analysis'), validate = require('../issue/validate'), resolve = require('../issue/resolve'), result = require('../issue/result');
const graph = require('../issue/graph');
const cpMod = require('../issue/checkpoints');
const caseFile = require('../issue/case-file');
const gateHtml = require('../lib/issue-html-gate');
const { impliedDeps } = require('../lib/implied');

let failures = 0, skipped = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const group = t => console.log(`\n== ${t}`);
const write = (root, rel, body) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); return f; };
const hdr = (name, v = '1.0.0', extra = '') => `<?php\n/**\n * Plugin Name: ${name}\n * Version: ${v}\n${extra} */\n`;
const LOADER = `<?php
function wp_default_scripts( $scripts ) {
	$scripts->add( 'jquery', false, array( 'jquery-core', 'jquery-migrate' ), '3.7.1' );
	$scripts->add( 'jquery-core', '/wp-includes/js/jquery/jquery.js', array(), '3.7.1' );
}
`;
let nSite = 0;
function site(files) {
    const root = path.join(tmp, `wp${++nSite}`);
    write(root, 'wp-config.php', '<?php');
    write(root, 'wp-includes/script-loader.php', LOADER);
    write(root, 'wp-includes/version.php', "<?php $wp_version = '6.6';");
    for (const [rel, body] of Object.entries(files)) write(root, rel, body);
    return root;
}
// the investigation up to the analysis (work/*.json): the same calls as `issue investigate`
async function investigate(root, { allow = [], php = null, symptom = 'other' } = {}) {
    const cfg = path.join(tmp, `cfg${nSite}-${Math.random().toString(16).slice(2, 8)}.json`);
    fs.writeFileSync(cfg, JSON.stringify({ customPaths: allow }));
    const issue = store.create({ title: 'Problem', description: '', symptom, environment: 'local', root, ...(php ? { phpVersion: php } : {}) });
    await evidence.run(issue.id, { root, probeOptions: { probe: false } });
    analysis.run(issue.id, { root, config: cfg });
    const dir = store.dirOf(issue.id);
    return { issue, dir, cfg, W: f => JSON.parse(fs.readFileSync(path.join(dir, 'work', f), 'utf8')) };
}
const rowsOf = r => Object.fromEntries(cpMod.evaluate({ work: cpMod.loadWork(r.dir), validation: null, ran: {}, hasRoot: true, issue: r.issue }).map(x => [x.id, x]));

(async () => {
    // ================================================================ 1. cp-08
    group('1. cp-08: options WordPress itself creates are ignored');
    const bare = site({});
    const stub = (opts, extra = {}) => ({
        components: [{ ref: 'a', kind: 'plugin', slug: 'a', name: 'A', main_file: 'wp-content/plugins/a/a.php' }, { ref: 'b', kind: 'plugin', slug: 'b', name: 'B', main_file: 'wp-content/plugins/b/b.php' }],
        facts: { a: { hooks: [], assets: [], cpts: [], taxonomies: [], options: opts.map(n => ({ op: 'update', name: n, file: 'a.php', line: 1 })) }, b: { hooks: [], assets: [], cpts: [], taxonomies: [], options: opts.map(n => ({ op: 'get', name: n, file: 'b.php', line: 1 })) } },
        observations: [], ...extra });
    const REQUIRED = ['active_plugins', 'blogname', 'siteurl', 'home', 'template', 'stylesheet', 'admin_email', 'blogdescription'];
    ok(REQUIRED.every(n => graph.CORE_OPTIONS.has(n)), 'the list names active_plugins, blogname, siteurl, home, template, stylesheet, admin_email, blogdescription');
    ok(![...graph.CORE_OPTIONS].some(n => /[*?]/.test(n)) && graph.CORE_OPTIONS.size >= 80, `an explicit list, no wildcards (${graph.CORE_OPTIONS.size} names)`);
    let bad = [];
    for (const n of [...graph.CORE_OPTIONS].sort()) {
        const g = graph.build(bare, stub([n]), { collisions: [] });   // schema.php is missing here: only the explicit list can ignore it
        if (g.edges.some(e => e.type === 'shared-option')) bad.push(n);
    }
    ok(bad.length === 0, `every listed name is ignored one by one, even without wp-admin/includes/schema.php${bad.length ? ': ' + bad.join(', ') : ''}`);
    for (const n of REQUIRED) ok(!graph.build(bare, stub([n]), { collisions: [] }).edges.some(e => e.type === 'shared-option'), `${n}: not reported as a shared setting`);
    const mine = graph.build(bare, stub(['myplugin_settings']), { collisions: [] });
    ok(mine.edges.filter(e => e.type === 'shared-option' && e.key === 'myplugin_settings').length === 1, 'a plugin-specific option (myplugin_settings) is still reported');
    ok(graph.build(bare, stub(['blogname', 'myplugin_settings']), { collisions: [] }).edges.filter(e => e.type === 'shared-option').map(e => e.key).join() === 'myplugin_settings', 'with both, only the plugin option is reported');

    // ================================================================ 2. cp-13
    group('2. cp-13: a hard dependency unless THAT USE is guarded');
    const soft = (src, slug = 'jetpack') => (impliedDeps(`<?php\n${src}`).find(d => d.slug === slug) || {}).soft;
    ok(soft("if ( class_exists( 'Jetpack' ) ) { Jetpack::is_active(); }") === true, 'a use inside if ( class_exists( \'Jetpack\' ) ) is soft');
    ok(soft("if ( ! class_exists( 'Jetpack' ) ) { return; }\nJetpack::is_active();") === true, 'an early return when the class is missing guards the later use');
    ok(soft("$on = class_exists( 'Jetpack' ) && Jetpack::is_active();") === true, 'a test in the same statement guards the use');
    ok(soft("if ( is_plugin_active( 'jetpack/jetpack.php' ) ) { Jetpack::is_active(); }") === true && soft("if ( did_action( 'jetpack_loaded' ) ) { Jetpack::is_active(); }") === true, 'is_plugin_active and did_action for the same plugin guard');
    ok(soft("if ( defined( 'WPCF7_VERSION' ) ) { $f = WPCF7_ContactForm::get_current(); }", 'contact-form-7') === true, 'defined( WPCF7_VERSION ) guards a WPCF7 use');
    ok(soft("function a(){ if(!class_exists('Jetpack')){return;} Jetpack::x(); } function b(){ Jetpack::y(); }") === false, 'a guard in ANOTHER function does not guard a use in this one');
    ok(soft("function a(){ if ( $x ) { if(!class_exists('Jetpack')){return;} } Jetpack::y(); }") === false, 'an early-return guard inside a CLOSED earlier block does not guard a later use');
    ok(soft("function a(){ if(!is_admin() || class_exists('Jetpack')) return; Jetpack::x(); }") === false && soft("function a(){ if(!class_exists('Jetpack') && $b) return; Jetpack::x(); }") === false, 'a condition with another term (!is_admin() ||, && ...) is not a guard');
    ok(soft("function a(){ if(!class_exists('Jetpack') || !function_exists('jetpack_x')) { return; } Jetpack::x(); }") === true, 'an OR-chain of negated guard calls is a guard');
    ok(soft("if(!class_exists('Jetpack')){return;}\nfunction b(){ Jetpack::y(); }") === false, 'a file-top-level early return does not guard a use inside a later function');
    ok(soft('Jetpack::is_active();') === false, 'an unguarded use is hard');
    ok(soft("if ( class_exists( 'Jetpack' ) ) { Jetpack::a(); }\nfunction later() { Jetpack::b(); }") === false, 'PER USE: one guarded and one unguarded call in the same file is still hard');
    ok(soft("if ( class_exists( 'WooCommerce' ) ) { Jetpack::a(); }") === false, 'a guard for a DIFFERENT plugin guards nothing');
    ok(soft("// if ( class_exists( 'Jetpack' ) ) {\nJetpack::a();") === false, 'a commented-out guard guards nothing');
    ok(impliedDeps("<?php\nif ( class_exists( 'WooCommerce' ) ) { echo 1; }")[0].soft === true, 'the existing soft logic stays: a bare class_exists( WooCommerce ) is soft');

    const akismet = await investigate(site({
        'wp-content/plugins/akismet-style/akismet-style.php': hdr('Akismet Style') + "if ( class_exists( 'Jetpack' ) ) { $x = Jetpack::is_active(); }\nfunction as_form() { if ( defined( 'WPCF7_VERSION' ) ) { return WPCF7_ContactForm::get_current(); } }\n"
    }));
    ok(!akismet.W('graph.json').problems.some(p => p.type === 'missing-implied-dependency'), 'fixture, Akismet-style guarded Jetpack and WPCF7 use, nothing installed: no missing dependency');
    ok(rowsOf(akismet)['cp-13'].result === 'PASS', 'cp-13 PASS for the guarded fixture');
    const unguarded = await investigate(site({
        'wp-content/plugins/plain-use/plain-use.php': hdr('Plain Use') + "function pu() { return Jetpack::is_active(); }\n"
    }));
    ok(unguarded.W('graph.json').problems.some(p => p.type === 'missing-implied-dependency' && p.missing === 'jetpack'), 'fixture, unguarded Jetpack use, Jetpack not installed: the missing dependency is reported');
    ok(rowsOf(unguarded)['cp-13'].result === 'FAIL' || rowsOf(unguarded)['cp-13'].result === 'ALSO NOTICED', 'cp-13 finds it');
    const mixed = await investigate(site({
        'wp-content/plugins/mixed-use/mixed-use.php': hdr('Mixed Use') + "if ( class_exists( 'Jetpack' ) ) { Jetpack::a(); }\nfunction later() { return Jetpack::b(); }\n"
    }));
    ok(mixed.W('graph.json').problems.some(p => p.type === 'missing-implied-dependency' && p.missing === 'jetpack'), 'fixture, one guarded and one unguarded Jetpack call in ONE file: still fires');

    // ================================================================ 3. same vendor
    group('3. same-vendor core + Pro pairs');
    const PAIR = (proAuthor, proExtra = '', coreV = '3.10.0') => ({
        'wp-content/plugins/elementor/elementor.php': hdr('Elementor', coreV, ' * Author: Elementor.com\n') + "add_action( 'wp_enqueue_scripts', function () { wp_enqueue_script( 'el-promo', plugins_url( 'a.js', __FILE__ ), array(), '1' ); } );\nupdate_option( 'elementor_flag', 1 );\nadd_filter( 'the_content', 'el_core_content', 10 );\n",
        'wp-content/plugins/elementor/a.js': 'window.elementorPromotionsData = { core: true };\n',
        'wp-content/plugins/elementor-pro/elementor-pro.php': hdr('Elementor Pro', '3.9.0', ` * Author: ${proAuthor}\n${proExtra}`) + "add_action( 'wp_enqueue_scripts', function () { wp_enqueue_script( 'el-pro-promo', plugins_url( 'b.js', __FILE__ ), array(), '1' ); } );\nupdate_option( 'elementor_flag', 2 );\nadd_filter( 'the_content', 'el_pro_content', 10 );\n",
        'wp-content/plugins/elementor-pro/b.js': 'window.elementorPromotionsData = { pro: true };\n'
    });
    const ALLOW = ['wp-content/plugins/elementor', 'wp-content/plugins/elementor-pro'];
    const LINE = 'Elementor and Elementor Pro are made by the same vendor and are meant to work together, so sharing names between them is expected. This says nothing about where the copy came from.';
    const same = await investigate(site(PAIR('Elementor.com')), { allow: ALLOW });
    const sc = same.W('collisions.json'), sg = same.W('graph.json');
    ok(!sc.collisions.some(c => c.type === 'js-global-collision' && c.global === 'elementorPromotionsData'), 'the shared JavaScript object elementorPromotionsData is NOT reported as a clash');
    ok((sc.same_vendor || []).some(x => x.name === 'elementorPromotionsData'), 'it is kept as a same-vendor note (nothing disappears silently)');
    ok(!sg.edges.some(e => e.type === 'shared-option' && e.key === 'elementor_flag') && !sg.edges.some(e => e.type === 'hook-same-priority'), 'the shared option and the shared hook are NOT reported as a clash');
    ok(sg.same_vendor && sg.same_vendor.lines.includes(LINE), 'the report line is exactly the owner wording, with the plugins\' real names');
    ok(sg.same_vendor.lines.filter(l => l === LINE).length === 1 && sg.same_vendor.pairs[0].shared === true, 'it is said once');
    const sr = rowsOf(same);
    ok(sr['cp-08'].result === 'PASS' && sr['cp-09'].result === 'PASS', 'the checkpoints for shared settings and hooks pass for such a pair');
    ok(sg.same_vendor.lines.length === 1 && !sg.same_vendor.pairs[0].core_older, 'no "older core" line when the Pro header states no core version');
    // a Pro that asks for a newer core than the installed one
    const older = await investigate(site(PAIR('Elementor.com', ' * Requires Elementor: 3.20.0\n')), { allow: ALLOW });
    const OLD_LINE = 'Elementor Pro asks for Elementor 3.20.0 or newer, and Elementor 3.10.0 is installed.';
    ok(older.W('graph.json').same_vendor.lines.includes(OLD_LINE) && older.W('graph.json').same_vendor.lines.length === 2, `the Pro header names a core version and the core is older: one plain line ("${OLD_LINE}")`);
    const newer = await investigate(site(PAIR('Elementor.com', ' * Requires Elementor: 3.5.0\n')), { allow: ALLOW });
    ok(newer.W('graph.json').same_vendor.lines.length === 1, 'a core that is new enough adds no line');
    // negative: the same slug pattern with a different Author is still reported
    const diff = await investigate(site(PAIR('Someone Else Ltd')), { allow: ALLOW });
    ok(diff.W('collisions.json').collisions.some(c => c.type === 'js-global-collision' && c.global === 'elementorPromotionsData'), 'NEGATIVE: a different Author with the same slug pattern: the shared JavaScript object is still reported');
    ok(diff.W('graph.json').edges.some(e => e.type === 'shared-option' && e.key === 'elementor_flag') && diff.W('graph.json').edges.some(e => e.type === 'hook-same-priority') && !diff.W('graph.json').same_vendor, 'NEGATIVE: the shared option and hook are still reported, and no same-vendor line is made');
    const noAuthor = await investigate(site(PAIR('').replace ? PAIR('') : PAIR('')), { allow: ALLOW });
    ok(!noAuthor.W('graph.json').same_vendor, 'NEGATIVE: an empty Author is not "the same Author"');
    ok(graph.vendorPairs(bare, [{ ref: 'acme', kind: 'plugin', slug: 'acme', name: 'Acme', main_file: 'x.php' }, { ref: 'acme-addon', kind: 'plugin', slug: 'acme-addon', name: 'Acme Addon', main_file: 'y.php' }]).length === 0, 'only -pro / -premium / -plus count (acme-addon is not a Pro edition)');

    // ================================================================ 4. healthy-site report
    group('4. healthy-site report');
    const OFFICE = site({
        'wp-content/plugins/woocommerce/woocommerce.php': hdr('WooCommerce', '10.6.1'),
        'wp-content/themes/unicamp/style.css': '/*\nTheme Name: Unicamp\nVersion: 2.2.0\n*/',
        'wp-content/plugins/woocommerce/templates/t1/t1.php': '<?php\n/**\n * @version 9.0.0\n */\n',
        'wp-content/themes/unicamp/woocommerce/t1/t1.php': '<?php\n/**\n * @version 3.0.0\n */\n',
        'wp-content/plugins/elementor/elementor.php': PAIR('Elementor.com')['wp-content/plugins/elementor/elementor.php'],
        'wp-content/plugins/elementor/a.js': 'window.elementorPromotionsData = { core: true };\n',
        'wp-content/plugins/elementor-pro/elementor-pro.php': PAIR('Elementor.com', ' * Requires Elementor: 3.20.0\n')['wp-content/plugins/elementor-pro/elementor-pro.php'],
        'wp-content/plugins/elementor-pro/b.js': 'window.elementorPromotionsData = { pro: true };\n',
        'wp-content/plugins/bigcustom/bigcustom.php': hdr('Big Custom') + '// padding\n'.repeat(160000)
    });
    async function report({ gate = true, verbose = false, symptom = 'other', intake = null, root = OFFICE }) {
        const config = path.join(tmp, `cfg-report-${Math.random().toString(16).slice(2, 8)}.json`);
        fs.writeFileSync(config, JSON.stringify({ customPaths: [...ALLOW, 'wp-content/plugins/bigcustom'] }));
        const issue = store.create({ title: 'Layout looks wrong', description: 'The header looks odd', symptom, environment: 'local', root, phpVersion: '8.3', oracle: null });
        await evidence.run(issue.id, { root, probeOptions: { probe: false } });
        analysis.run(issue.id, { root, config });
        const dir = store.dirOf(issue.id);
        if (intake) fs.writeFileSync(path.join(dir, 'work', 'intake.json'), JSON.stringify(intake));
        const val = validate.run(issue.id, { root, config, lint: () => ({ ok: true, message: '' }) });
        const policy = validate.policyFor(root, config), plans = resolve.build(issue.id, val, { root, policy, dir });
        const res = result.write(issue.id, { validation: val, plans, dir, root, policy, gate, verbose });
        const R = n => fs.readFileSync(path.join(dir, 'result', n), 'utf8');
        return { id: issue.id, dir, f: JSON.parse(R('findings.json')), md: R('ISSUE-REPORT.md'), html: R('issue.html') };
    }
    const h = await report({ intake: { steps: [], php_skipped: 2, php_skipped_examples: [] } });
    const cf = h.f.case_file;
    const reader = [h.md, JSON.stringify(cf)].join('\n');
    ok(!/probably not the crash/i.test(h.md) && !/probably not the crash/i.test(JSON.stringify(cf)) && !/probably not what stops the page/i.test(JSON.stringify(cf)), 'a report that is not about a crash never says "probably not the crash"');
    ok(cf.cases.some(c => c.kind === 'check' && c.heading === 'Also noticed') && /^## Case 1: Also noticed$/m.test(h.md) && cf.checked.legend.startsWith('Also noticed:'), 'it says "Also noticed" instead');
    ok(/the code \(3 PHP files were not read: 1 too large, 2 for other reasons\)/.test(cf.status.looked), `"Looked at" has the real counts and reasons: ${cf.status.looked}`);
    ok(cf.checked.notes && cf.checked.notes.includes(LINE) && h.md.includes(LINE), 'the same-vendor sentence is in "What was checked" (Markdown and findings.json)');
    ok(cf.checked.notes.includes('Elementor Pro asks for Elementor 3.20.0 or newer, and Elementor 3.10.0 is installed.'), 'the older-core line is there too');
    ok(!/\b(cp-\d+|same_vendor|js-global-collision|shared-option)\b/.test(h.md), 'no internal word in the reader text of these lines');
    const crash = await report({ symptom: 'white-screen' });
    ok(crash.f.case_file.cases.some(c => c.kind === 'check' && c.heading === caseFile.CHECK) && /probably not the crash/.test(crash.f.case_file.checked.legend), 'a crash report keeps "Something else to check (probably not the crash)"');
    // lookedAt wording
    const L = d => caseFile.lookedAt({ hasLog: true, probeRan: false, hasCode: true, phpSkipped: true, phpSkippedDetail: d }).line;
    ok(/the code \(12 PHP files were not read: 9 too large, 3 could not be parsed\)\./.test(L({ total: 12, tooLarge: 9, unparsed: 3, other: 0 })), '"the code (12 PHP files were not read: 9 too large, 3 could not be parsed)"');
    ok(/the code \(1 PHP file was not read: 1 for other reasons\)/.test(L({ total: 1, tooLarge: 0, unparsed: 0, other: 1 })), 'one file, a reason that is not known: "1 PHP file was not read: 1 for other reasons"');
    ok(/the code \(some PHP files were not read\)/.test(caseFile.lookedAt({ hasCode: true, phpSkipped: true }).line), 'without counts the older short sentence is kept');
    ok(!/PHP files? (was|were) not read/.test(caseFile.lookedAt({ hasCode: true, phpSkipped: false }).line), 'no skipped file: no sentence');
    // not tested: de-duplicated
    const dup = JSON.parse(JSON.stringify(h.f));
    const first = dup.timeline.find(s => s.id === 'live-probe' && dup.not_tested.includes(s.id));
    if (first) { dup.timeline.push({ ...first, id: first.id + '-again' }); dup.not_tested = [...dup.not_tested, first.id + '-again']; }
    const once = s => { const m = result.gateMarkdown(dup).split('\n').filter(l => l.startsWith('- ') && l.includes(s)); return m.length; };
    ok(!first || once((first.label || '').slice(0, 20)) === result.gateMarkdown(JSON.parse(JSON.stringify(h.f))).split('\n').filter(l => l.startsWith('- ') && l.includes((first.label || '').slice(0, 20))).length, 'a step line that reads the same twice is listed once in the Markdown');
    ok(gateHtml.PATCHES.some(p => /a\.indexOf\(x\) === i/.test(p.replacement)), 'the page de-duplicates the "Not tested" list');
    // the Fix box
    ok(gateHtml.PATCHES.some(p => /live\.some\(function \(h\) \{ return h\.id === r\.hypothesis/.test(p.replacement)) && gateHtml.PATCHES.some(p => /No fix is suggested, because no cause was found\.' : 'No safe automatic fix/.test(p.replacement)), 'the Fix field is taken only from hypotheses the Resolution lists, and says "No fix is suggested" when none is listed');
    let pw = null; try { pw = require('../lib/playwright').load(); } catch { /* not installed */ }
    const browser = pw && require('../lib/playwright').status().chromium ? await pw.chromium.launch() : null;
    if (!browser) { console.log("SKIP  plugin-guard's own browser is not installed: the rendered-page part did not run"); skipped++; }
    else {
        const ctx = await browser.newContext({ serviceWorkers: 'block' }), pg = await ctx.newPage(), errs = [];
        pg.on('pageerror', e => errs.push(e.message));
        await pg.route('**/*', rt => (rt.request().url().startsWith('file://') ? rt.continue() : rt.abort()));
        await pg.goto('file://' + path.join(h.dir, 'result', 'issue.html'));
        const fix = await pg.evaluate(() => { const dt = [...document.querySelectorAll('#verdict dt')].find(d => d.textContent === 'Fix'); return dt ? dt.nextElementSibling.textContent : null; });
        const nt = await pg.evaluate(() => { const dt = [...document.querySelectorAll('#verdict dt')].find(d => d.textContent === 'Not tested'); return dt ? [...dt.nextElementSibling.querySelectorAll('li')].map(li => li.textContent) : []; });
        const note = await pg.evaluate(() => document.getElementById('checked') ? document.getElementById('checked').textContent : '');
        ok(fix === null || !/settings|setting/i.test(fix) || /No fix is suggested/.test(fix), `the Fix field of a report with no listed cause: ${fix}`);
        ok(new Set(nt).size === nt.length, 'the "Not tested" list on the page has no repeated line');
        ok(note.includes(LINE), 'the page shows the same-vendor sentence under "What was checked"');
        ok(!errs.length, 'the page runs without errors');
        await ctx.close(); await browser.close();
    }

    // ================================================================ 5. mysql_query
    group('5. cp-24 / cp-25: mysql_query()');
    const MQ = (body) => site({ 'wp-content/plugins/legacy/legacy.php': hdr('Legacy') + body });
    const compatOf = async (body) => { const r = await investigate(MQ(body), { allow: ['wp-content/plugins/legacy'], php: '8.3' }); return { r, obs: r.W('custom-code.json').observations.filter(o => o.type === 'removed-function-call' && o.function === 'mysql_query') }; };
    const unG = await compatOf("function legacy_q( $sql ) { return mysql_query( $sql ); }\n");
    ok(unG.obs.length === 1 && /8\.3/.test(unG.obs[0].php_version), 'positive: an unguarded mysql_query() with the site PHP stated 8.3 is reported');
    ok(rowsOf(unG.r)['cp-24'].result !== 'PASS' && rowsOf(unG.r)['cp-25'].result !== 'PASS', 'positive: cp-24 and cp-25 both find it');
    const gd = await compatOf("function legacy_q( $sql ) { if ( function_exists( 'mysql_query' ) ) { return mysql_query( $sql ); } return null; }\n");
    ok(gd.obs.length === 0 && rowsOf(gd.r)['cp-24'].result === 'PASS', 'negative: a call inside a branch guarded by function_exists( \'mysql_query\' ) is left out');
    const other = await compatOf("function legacy_q( $sql ) { if ( function_exists( 'mysqli_query' ) ) { return mysql_query( $sql ); } return null; }\n");
    ok(other.obs.length === 1, 'a guard for a DIFFERENT function does not leave it out');
    const after = await compatOf("function legacy_q( $sql ) { if ( function_exists( 'mysql_query' ) ) { echo 1; } return mysql_query( $sql ); }\n");
    ok(after.obs.length === 1, 'a call AFTER the guarded block (outside the branch) is still reported');

    // ================================================================ 6. repeated findings
    group('6. cp-22 / cp-25 repeat cp-09 / cp-24');
    const rr = rowsOf(unG.r);
    ok(rr['cp-25'].same_as === 'cp-24' && /^same finding as "/.test(rr['cp-25'].reason) && rr['cp-24'].same_as === undefined, 'cp-25 is shown as the same finding as cp-24 (cp-24 keeps its own text)');
    ok(!/cp-\d+/.test(rr['cp-25'].reason), 'the reader text names the check by its title, not its id');
    const HOOK = await investigate(site({
        'wp-content/plugins/hk-a/hk-a.php': hdr('Hook A') + "add_filter( 'the_content', 'hk_a', 10 );\nfunction hk_a( $c ) { return $c; }\n",
        'wp-content/plugins/hk-b/hk-b.php': hdr('Hook B') + "add_filter( 'the_content', 'hk_b', 10 );\nfunction hk_b( $c ) { return $c; }\n"
    }), { allow: ['wp-content/plugins/hk-a', 'wp-content/plugins/hk-b'] });
    const hr = rowsOf(HOOK);
    ok(hr['cp-09'].result !== 'PASS' && hr['cp-22'].result !== 'PASS' && hr['cp-22'].same_as === 'cp-09' && hr['cp-09'].same_as === undefined, 'cp-22 repeats cp-09: shown as the same finding, cp-09 is not');
    const t = cpMod.tally(Object.values(hr));
    ok(t.pass + t.fail + t.also_noticed + t.not_checked === t.total && t.total === 53, `the counts still add up to the 53 pinned rows (${t.pass}/${t.fail}/${t.also_noticed}/${t.not_checked} of ${t.total}); a row that repeats another is not merged`);

    if (skipped) console.log(`\n${skipped} part(s) skipped`);
    console.log(failures ? `\n${failures} check(s) failed` : '\nAll 7a checks passed.');
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
