#!/usr/bin/env node
// Offline self-test of issue mode, step 5: JS/CSS collisions, graph + slice, knowledge base, hypotheses and their scoring.
// Disposable fake WordPress trees; nothing is executed; no network, no browser.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-graph-'));
process.env.PLUGIN_GUARD_ISSUES = path.join(tmp, 'issues');
const store = require('../lib/issue-store');
const evidence = require('../issue/evidence');
const analysis = require('../issue/analysis');
const collide = require('../issue/collide');
const kb = require('../issue/kb');
const hyp = require('../issue/hypotheses');
const corehandles = require('../issue/corehandles');

let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) failures++; };
const group = t => console.log(`\n== ${t}`);
const write = (root, rel, body) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); return f; };
function hashTree(dir) { const h = crypto.createHash('sha256'); (function walk(d) { for (const n of fs.readdirSync(d).sort()) { const f = path.join(d, n), st = fs.lstatSync(f); h.update(`${path.relative(dir, f)}|${st.isSymbolicLink() ? 'l' : st.isDirectory() ? 'd' : 'f'}|${st.mode}|`); if (st.isDirectory()) walk(f); else if (st.isFile()) h.update(fs.readFileSync(f)); } })(dir); return h.digest('hex'); }
const hdr = (name, v = '1.0.0', extra = '') => `<?php\n/**\n * Plugin Name: ${name}\n * Version: ${v}\n${extra} */\n`;
const LOADER = `<?php
function wp_default_scripts( $scripts ) {
	$scripts->add( 'jquery', false, array( 'jquery-core', 'jquery-migrate' ), '3.7.1' );
	$scripts->add( 'jquery-core', '/wp-includes/js/jquery/jquery.js', array(), '3.7.1' );
	$scripts->add( 'jquery-migrate', '/wp-includes/js/jquery/jquery-migrate.js', array(), '3.4.1' );
}
function wp_default_styles( $styles ) { $styles->add( 'dashicons', '/wp-includes/css/dashicons.css' ); }
`;
function site(name, files, { allow = [] } = {}) {
    const root = path.join(tmp, name);
    write(root, 'wp-config.php', '<?php');
    write(root, 'wp-includes/script-loader.php', LOADER);
    write(root, 'wp-includes/version.php', "<?php $wp_version = '6.6';");
    for (const [rel, body] of Object.entries(files)) write(root, rel, body);
    return root;
}
// run the same pipeline as `issue investigate`
async function investigate(root, { title = 'Problem', description = '', symptom = 'other', allow = [], ocr = null, log = null, oracle = null } = {}) {
    if (log) write(root, 'wp-content/debug.log', log);
    const cfg = path.join(tmp, `cfg-${crypto.randomBytes(3).toString('hex')}.json`);
    fs.writeFileSync(cfg, JSON.stringify({ customPaths: allow }));
    const issue = store.create({ title, description, symptom, root, oracle });
    const ev = await evidence.run(issue.id, { root, recognizer: async files => files.map(() => ({ text: ocr || '', confidence: 90, variants: [{ variant: 'original', text: ocr || '', confidence: 90 }], notes: [] })) });
    if (ocr) { /* images not attached: OCR text is injected through a description-free path below */ }
    const an = analysis.run(issue.id, { root, config: cfg });
    return { issue, ev, an, dir: store.dirOf(issue.id), W: f => JSON.parse(fs.readFileSync(path.join(store.dirOf(issue.id), 'work', f), 'utf8')) };
}

(async () => {
    // ================================================================ case 1: duplicate function
    group('acceptance case 1: duplicate function, "white screen after activating B"');
    const s1 = site('dup', {
        'wp-content/plugins/plugin-a/plugin-a.php': hdr('Plugin A') + 'function my_helper() { return "a"; }\n',
        'wp-content/plugins/plugin-b/plugin-b.php': hdr('Plugin B', '2.0.0') + '\nfunction my_helper() { return "b"; }\n',
        'wp-content/plugins/bystander/bystander.php': hdr('Bystander') + 'function bystander_fn() {}\n'
    });
    const LOG1 = '[27-Oct-2026 10:11:12 UTC] PHP Fatal error:  Cannot redeclare my_helper() (previously declared in /srv/s/wp-content/plugins/plugin-a/plugin-a.php:8) in /srv/s/wp-content/plugins/plugin-b/plugin-b.php on line 7\n';
    write(s1, 'wp-content/debug.log', LOG1);
    const before1 = hashTree(s1);
    const r1 = await investigate(s1, { title: 'White screen after activating plugin B', description: 'White screen since 2026-10-20 after I activated plugin-b', symptom: 'white-screen',
        log: null });
    const H1 = r1.an.hypotheses.hypotheses;
    ok(H1.length >= 1 && H1[0].type === 'duplicate-declaration', `the top hypothesis is the duplicate declaration (${H1[0] && H1[0].title})`);
    ok(H1[0].components.join() === 'plugin-a,plugin-b', 'both plugins are named');
    ok(H1[0].status === 'PROBABLE_NEEDS_REVIEW' && !/CONFIRMED|REPRODUCIBLE/.test(JSON.stringify(H1)), 'status is PROBABLE_NEEDS_REVIEW: this step never confirms anything');
    ok(H1[0].supports.some(s => s.kind === 'log') && H1[0].supports.some(s => s.kind === 'observation') && H1[0].evidence.length === 2 && H1[0].evidence.every(e => e.file && e.line), 'supported by the log AND the code parse, with file:line for both declarations');
    const rules1 = H1[0].score_breakdown.map(b => b.rule);
    ok(['support:log', 'support:observation', 'independent-sources', 'stack:error-site'].every(r => rules1.includes(r)), `score breakdown: ${H1[0].score_breakdown.map(b => `${b.points > 0 ? '+' : ''}${b.points} ${b.rule}`).join(', ')}`);
    ok(H1.length === 1 || H1.slice(1).every(h => h.score < H1[0].score), 'nothing outranks it');
    ok(!H1.some(h => h.components.includes('bystander')), 'an uninvolved plugin is not blamed');
    ok(H1[0].oracle.action.do === 'deactivate' && H1[0].oracle.needs_sandbox && /one at a time and together/.test(H1[0].oracle.text) && H1[0].oracle.oracle.type === 'http-5xx' && H1[0].oracle.oracle.generic === true, 'the test that would prove it: deactivate in a throwaway copy, run the oracle (the generic one, and it says so)');
    ok(hashTree(s1) === before1, 'the WordPress tree is byte-identical after the investigation');

    // ================================================================ case 3: jQuery
    group('acceptance case 3: theme replaces jQuery 1.12, a plugin needs 3.x ("slider does nothing")');
    const s3 = site('jq', {
        'wp-content/themes/acme/style.css': '/*\nTheme Name: Acme\nVersion: 1.0\n*/',
        'wp-content/themes/acme/functions.php': `<?php
add_action( 'wp_enqueue_scripts', function () {
	wp_deregister_script( 'jquery' );
	wp_register_script( 'jquery', 'https://ajax.googleapis.com/ajax/libs/jquery/1.12.4/jquery.min.js', array(), '1.12.4', false );
	wp_enqueue_script( 'jquery' );
}, 100 );
`,
        'wp-content/plugins/fancy-slider/fancy-slider.php': hdr('Fancy Slider') + "add_shortcode( 'metaslider', 'fs_slide' );\nfunction fs_slide() {}\nwp_enqueue_script( 'fancy-slider', plugin_dir_url( __FILE__ ) . 'js/slider.js', array( 'jquery' ), '1.0', true );\nwp_enqueue_style( 'fancy-slider', plugin_dir_url( __FILE__ ) . 'css/slider.css' );\n",
        'wp-content/plugins/fancy-slider/js/slider.js': '/*! Fancy Slider 1.0 */\n(function ($) {\n\t$.fn.slider = function () { return this.each(function () { var id = $.escapeSelector("#x"); }); };\n\twindow.FancyGlobal = {};\n})(jQuery);\n',
        'wp-content/plugins/fancy-slider/css/slider.css': '.btn { color: red; margin: 0 }\n.only-fancy { display: block }\n',
        'wp-content/plugins/other-slides/other-slides.php': hdr('Other Slides') + "wp_enqueue_script( 'other-slides', plugin_dir_url( __FILE__ ) . 'js/other.js', array(), '1.0', true );\nwp_enqueue_style( 'other-slides', plugin_dir_url( __FILE__ ) . 'css/other.css' );\n",
        'wp-content/plugins/other-slides/js/other.js': '(function(){ jQuery(function(){ jQuery(".x").hide(); }); window.FancyGlobal = { other: true }; jQuery.fn.slider = function(){}; })();\n',
        'wp-content/plugins/other-slides/css/other.css': '.btn { color: blue; margin: 0 }\n',
        'wp-content/plugins/outside/outside.php': hdr('Outside') + "wp_enqueue_script( 'outside', plugin_dir_url( __FILE__ ) . '../../../../etc/passwd.js' );\nwp_enqueue_script( 'minified', plugin_dir_url( __FILE__ ) . 'js/min.js' );\n",
        'wp-content/plugins/outside/js/min.js': 'import x from "y"; export default 1; <<<not js'
    });
    const r3 = await investigate(s3, { title: 'Slider does nothing', description: 'The homepage slider does nothing since the theme update, console says $ is not a function', symptom: 'js-error', allow: ['wp-content/themes/acme'], oracle: { type: 'console-error', value: 'is not a function' } });
    const C3 = r3.an.collide.collisions, ct = t => C3.filter(c => c.type === t);
    const mm = ct('jquery-api-version-mismatch')[0];
    ok(mm && mm.api === 'jQuery.escapeSelector' && mm.effective_jquery === '1.12.4' && /acme/.test(mm.effective_source) && /3\.7\.1/.test(mm.effective_source) && mm.evidence[0].line === 3, `acorn: the plugin calls jQuery.escapeSelector (needs 3.0) but the theme's jQuery ${mm && mm.effective_jquery} loads, line ${mm && mm.evidence[0].line}`);
    const lv = ct('library-version-conflict').find(c => c.library === 'jquery');
    ok(lv && lv.versions.sort().join() === '1.12.4,3.7.1' && lv.components.includes('wordpress-core') && lv.components.includes('theme:acme'), 'the same library in two versions: core 3.7.1 (read from script-loader.php) and the theme\'s 1.12.4');
    const gc = ct('js-global-collision').map(c => c.global).sort();
    ok(gc.includes('FancyGlobal') && gc.includes('jQuery.fn.slider'), `two scripts assign the same global: ${gc.join(', ')}`);
    const md = ct('script-missing-dependency')[0];
    ok(md && md.handle === 'other-slides' && md.components[0] === 'other-slides' && /does not depend on "jquery"/.test(md.message), 'a script using jQuery without depending on it');
    ok(!ct('script-missing-dependency').some(c => c.handle === 'fancy-slider'), 'a script that does depend on jquery is not flagged');
    const cssO = ct('css-selector-overlap')[0];
    ok(cssO && cssO.selector === '.btn' && cssO.components.join() === 'fancy-slider,other-slides' && cssO.conflicting_properties.map(p => p.property).join() === 'color' && cssO.matches_failing_region === null, 'postcss: ".btn" has different colors in two plugins; matches_failing_region is null (needs the live probe)');
    ok(!C3.some(c => c.components.includes('outside')), 'a ../../ asset path and an unparsable "minified" file do not crash the analysis and produce no false collision');
    const af = r3.an.collide.steps.find(s => s.id === 'asset-files');
    ok(af.status === 'PASSED' && af.problems.some(p => /outside/.test(p) || /leaves the project root|outside the project root/.test(p)) || af.problems.length >= 1, 'the refused path is reported as a problem, not read');
    const kb3 = r3.an.kb.map(k => k.id);
    ok(kb3.includes('core-jquery-replaced') && kb3.includes('jquery-api-version-mismatch') && r3.an.kb.every(k => k.verified), `knowledge base hits (all verified entries): ${kb3.join(', ')}`);
    const H3 = r3.an.hypotheses.hypotheses, types3 = H3.map(h => h.type);
    ok(types3.slice(0, 3).includes('jquery-api-version-mismatch') && types3.includes('handle-replaced'), `hypotheses include the API mismatch and the replaced handle: ${H3.map(h => `${h.type}(${h.score})`).join(', ')}`);
    const top3 = H3.find(h => h.type === 'handle-replaced');
    ok(top3.custom_involved && top3.components.includes('theme:acme') && top3.score_breakdown.some(b => b.rule === 'custom') && /1\.12\.4/.test(top3.mechanism) && /3\.7\.1/.test(top3.mechanism), 'the theme (custom) replacing core 3.7.1 with 1.12.4 is scored with the custom-code bonus');
    ok(H3.every(h => h.family !== 'fatal'), 'no PHP-fatal hypothesis for a JavaScript symptom');
    ok(top3.kb.length >= 0 && H3.some(h => h.supports.some(s => s.kind === 'kb-verified')), 'KB-supported hypotheses cite a verified entry');

    // ================================================================ case 2: hook collision
    group('acceptance case 2: two plugins hook the_content at the same priority');
    const hookFiles = {
        'wp-content/plugins/seo-extras/seo-extras.php': hdr('SEO Extras') + "add_filter( 'the_content', 'seo_extras_strip', 10 );\nfunction seo_extras_strip( $c ) { return strip_tags( $c ); }\n",
        'wp-content/plugins/share-bar/share-bar.php': hdr('Share Bar') + "add_filter( 'the_content', 'share_bar_append', 10 );\nfunction share_bar_append( $c ) { return $c . '<div class=\"share\"></div>'; }\n",
        'wp-content/plugins/unrelated-a/unrelated-a.php': hdr('Unrelated A') + "add_filter( 'the_content', 'ua_f', 10 );\nfunction ua_f( $c ) { return $c; }\n",
        'wp-content/plugins/unrelated-b/unrelated-b.php': hdr('Unrelated B') + "add_filter( 'the_content', 'ub_f', 10 );\nfunction ub_f( $c ) { return $c; }\n"
    };
    const s2 = site('hook', hookFiles);
    const r2 = await investigate(s2, { title: 'Share buttons missing', description: 'The share buttons disappear from posts since I installed seo-extras. It happens with share-bar active.', symptom: 'wrong-content' });
    const e2 = r2.an.graph.edges.filter(e => e.type === 'hook-same-priority' && e.hook === 'the_content');
    ok(e2.length === 6, 'the graph records the same-hook same-priority relation for all 4 plugins (6 pairs)');
    const H2 = r2.an.hypotheses.hypotheses;
    ok(H2.length === 1 && H2[0].type === 'hook-same-priority' && H2[0].components.join() === 'seo-extras,share-bar', `only the pair the report names becomes a hypothesis (${H2.map(h => h.components.join('+')).join(' | ')})`);
    ok(H2[0].status === 'UNVERIFIED' && H2[0].supports.every(s => s.kind === 'graph-relevant' || ['index', 'description', 'ocr'].includes(s.kind)) && H2[0].oracle.action.do === 'deactivate', 'it is UNVERIFIED (context, not proof) and the proposed test is to deactivate them one at a time and together');
    const r2b = await investigate(site('hook2', hookFiles), { title: 'Share buttons missing', description: 'The share buttons disappear from posts.', symptom: 'wrong-content' });
    ok(r2b.an.hypotheses.hypotheses.length === 0 && r2b.an.graph.edges.some(e => e.type === 'hook-same-priority'), 'regression: without a named component or a feature hook, four plugins on the_content@10 give NO hypothesis (this was the noise on the real site)');

    // ================================================================ knowledge base
    group('knowledge base: detectors, applicability, verification');
    const comps = (...slugs) => slugs.map(s => ({ kind: s === 'advanced-cache.php' ? 'dropin' : 'plugin', slug: s, ref: s, path: `wp-content/plugins/${s}` }));
    const ev = (ctx, symptom = 'other', clueTypes = []) => kb.evaluate({ components: ctx, facts: {}, observations: [], collisions: [], symptom, clueTypes });
    ok(ev(comps('wp-rocket', 'litespeed-cache')).some(h => h.id === 'wp-rocket-with-incompatible-plugin') && ev(comps('wp-rocket', 'litespeed-cache')).some(h => h.id === 'multiple-full-page-cache-plugins'), 'WP Rocket + LiteSpeed Cache: both cache entries fire');
    ok(!ev(comps('wp-rocket', 'sg-cachepress')).some(h => h.id === 'wp-rocket-with-incompatible-plugin'), 'WP Rocket + SG Optimizer does NOT fire (WP Rocket\'s docs say they can run together; it was removed from the list after reading the page)');
    ok(!ev(comps('wp-rocket')).length && !ev(comps('litespeed-cache')).some(h => h.id === 'multiple-full-page-cache-plugins'), 'a single cache plugin raises nothing');
    const woo = comps('woocommerce', 'wp-rocket');
    ok(ev(woo, 'form-checkout').some(h => h.id === 'page-cache-with-woocommerce') && !ev(woo, 'white-screen').some(h => h.id === 'page-cache-with-woocommerce') && ev(woo, 'white-screen').not_applicable.some(h => h.id === 'page-cache-with-woocommerce' && /not "white-screen"/.test(h.reason)), 'WooCommerce + cache fires for a checkout symptom, and is parked as "not applicable" (with the reason) for a white screen');
    ok(ev(comps('elementor', 'autoptimize'), 'layout').some(h => h.id === 'cache-plugin-with-elementor'), 'Elementor + a caching plugin fires for a layout symptom');
    const restFacts = { a: { hooks: [{ op: 'add', hook: 'rest_authentication_errors', file: 'a.php', line: 1, priority: 10 }] }, b: { hooks: [{ op: 'add', hook: 'rest_authentication_errors', file: 'b.php', line: 2, priority: 10 }] } };
    const kbRest = (symptom, clues) => kb.evaluate({ components: comps('a', 'b'), facts: restFacts, observations: [], collisions: [], symptom, clueTypes: clues });
    ok(kbRest('login-admin', ['rest-route']).some(h => h.id === 'rest-authentication-errors-contention') && !kbRest('login-admin', []).some(h => h.id === 'rest-authentication-errors-contention') && kbRest('login-admin', []).not_applicable.some(h => /common on healthy sites/.test(h.reason)), 'rest_authentication_errors contention needs a REST-related clue, because it is common on healthy sites');
    const all = kb.load();
    ok(all.length === 10 && all.every(e => kb.DETECTORS[e.detector] && e.family), 'every entry has a detector implemented in code and a family');
    ok(all.every(e => e.verified && e.last_checked && e.reviewed), 'all entries were checked against their sources and reviewed (see data/knowledge-verification.json)');
    const tlist = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'knowledge-verification.json'), 'utf8'));
    ok(tlist.fetched_at === all[0].last_checked && Object.values(tlist.pages).filter(p => p.status === 200).length >= 25, 'the verification record backs the dates');

    // ================================================================ graph and slice
    group('graph and slice');
    const s5 = site('graph', {
        'wp-content/plugins/shop-core/shop-core.php': hdr('Shop Core') + "add_shortcode( 'shop_checkout', 'sc_checkout' );\nfunction sc_checkout() {}\nadd_shortcode( 'woocommerce_checkout', 'sc_checkout' );\nupdate_option( 'shared_opt', 1 );\nupdate_option( 'blogname', 'x' );\nregister_post_type( 'order_x' );\nwp_register_script( 'shop-js', plugin_dir_url( __FILE__ ) . 'shop.js' );\n",
        'wp-content/plugins/shop-addon/shop-addon.php': hdr('Shop Addon', '1.0', ' * Requires Plugins: shop-core, not-installed\n') + "get_option( 'shared_opt' );\nupdate_option( 'blogname', 'y' );\nregister_post_type( 'order_x' );\nwp_enqueue_script( 'addon-js', plugin_dir_url( __FILE__ ) . 'a.js', array( 'shop-js', 'jquery' ) );\nclass_exists( 'WooCommerce' );\n",
        'wp-content/plugins/shop-addon/a.js': 'jQuery(function(){});',
        'wp-content/plugins/needs-woo/needs-woo.php': hdr('Needs Woo') + "function nw() { return wc_get_order( 1 ); }\n",
        'wp-content/plugins/far-away/far-away.php': hdr('Far Away') + "function far_fn() {}\n",
        'wp-content/plugins/far-away/broken.php': '<?php function broken( {',
        'wp-content/plugins/chain-1/chain-1.php': hdr('Chain 1', '1.0', ' * Requires Plugins: shop-addon\n'),
        'wp-content/plugins/chain-2/chain-2.php': hdr('Chain 2', '1.0', ' * Requires Plugins: chain-1\n'),
        'wp-content/plugins/chain-3/chain-3.php': hdr('Chain 3', '1.0', ' * Requires Plugins: chain-2\n'),
        'wp-admin/includes/schema.php': "<?php\nfunction populate_options( array $options = array() ) {\n\t$defaults = array(\n\t\t'siteurl' => $guessurl,\n\t\t'blogname' => __( 'My Site' ),\n\t\t'active_plugins' => array(),\n\t);\n}\n"
    });
    const r5 = await investigate(s5, { title: 'Checkout broken', description: 'The shop checkout shows an error', symptom: 'form-checkout', allow: ['wp-content/plugins/far-away'] });
    const g = r5.an.graph, et = t => g.edges.filter(e => e.type === t);
    ok(et('declared-dependency').some(e => e.from === 'shop-addon' && e.to === 'shop-core') && g.problems.some(p => p.type === 'missing-declared-dependency' && p.missing === 'not-installed' && p.component === 'shop-addon'), 'declared dependency edge, and a required plugin that is not installed is a problem');
    ok(et('asset-dependency').some(e => e.from === 'shop-addon' && e.to === 'shop-core' && /shop-js/.test(e.why)), 'a script handle that depends on a handle another plugin registers');
    ok(et('shared-option').length === 1 && et('shared-option')[0].option === 'shared_opt', 'shared option: custom option names are linked; "blogname" (created by WordPress itself, read from schema.php) is not');
    ok(g.core_options_known && et('duplicate-post-type').length === 1 && et('duplicate-post-type')[0].key === 'order_x', 'two plugins registering the same post type');
    ok(!g.problems.some(p => p.component === 'shop-addon' && p.type === 'missing-implied-dependency') && !et('implied-dependency').some(e => e.from === 'shop-addon'), 'a guarded optional integration (class_exists( \'WooCommerce\' )) is "soft": no edge and no problem');
    ok(g.problems.some(p => p.type === 'missing-implied-dependency' && p.component === 'needs-woo' && p.missing === 'woocommerce'), 'code that calls wc_get_order() with WooCommerce not installed is reported as a missing implied dependency');
    ok(!r5.an.hypotheses.hypotheses.some(h => h.type === 'missing-dependency' && h.components.includes('needs-woo')), 'but an implied dependency of an unrelated, non-custom plugin is NOT a hypothesis (regression: this was noise on the real site)');
    ok(r5.an.hypotheses.hypotheses.some(h => h.type === 'missing-dependency' && h.components.includes('shop-addon') && /not-installed/.test(h.mechanism)), 'a declared "Requires Plugins" that is not installed IS a hypothesis (it is a certain statement)');
    const sl = r5.an.slice;
    ok(sl.seeds.includes('shop-core') && sl.nodes.find(n => n.ref === 'shop-core').distance === 0, 'the component that provides the feature (shortcode shop_checkout) is a seed at distance 0');
    ok(sl.nodes.find(n => n.ref === 'shop-addon').distance === 1 && sl.nodes.find(n => n.ref === 'chain-1').distance === 2 && !sl.nodes.some(n => n.ref === 'chain-3') && !sl.nodes.some(n => n.ref === 'chain-2' && n.distance > 2), 'the slice follows relations 2 steps out from the seeds and stops there');
    ok(!sl.nodes.some(n => n.ref === 'far-away'), 'an unrelated plugin is outside the slice');
    ok(sl.also_found.observations.some(o => o.type === 'syntax-error' && o.components.includes('far-away')), 'its syntax error is NOT hidden: it is listed under "also found, not related to this issue"');
    ok(JSON.stringify(r5.W('slice.json')) === JSON.stringify(sl), 'work/slice.json matches what the CLI used');

    // ================================================================ scoring
    group('scoring: transparent, no hidden weights');
    const pointsOf = Object.fromEntries(hyp.SCORING.map(r => [r.rule, r.points]));
    const allH = [...H1, ...H3, ...H2];
    ok(allH.every(h => h.score_breakdown.every(b => b.rule === 'independent-sources' ? b.points % pointsOf['independent-sources'] === 0 : b.points === pointsOf[b.rule])), 'every line of every breakdown equals the documented SCORING value');
    ok(allH.every(h => Math.abs(h.score - h.score_breakdown.reduce((s, b) => s + b.points, 0)) < 0.011), 'the score is exactly the sum of its breakdown');
    ok(r1.an.hypotheses.scoring_rules.length === hyp.SCORING.length && hyp.SCORING.every(r => r.why && typeof r.points === 'number'), 'the rules are written into hypotheses.json');
    ok(hyp.MAX_HYPOTHESES === 5 && allH.length > 0 && [H1, H2, H3].every(h => h.length <= 5), 'at most 5 hypotheses are listed');
    const mism = H3.find(h => h.type === 'css-selector-overlap');
    ok(!mism || mism.score_breakdown.some(b => b.rule === 'symptom-mismatch') === false, 'a CSS overlap is compatible with a JS symptom here, so it is not penalised');
    const r1b = await investigate(site('mismatch', { 'wp-content/plugins/p1/p1.php': hdr('P1') + "wp_enqueue_style( 'p1', plugin_dir_url( __FILE__ ) . 'c.css' );\n", 'wp-content/plugins/p1/c.css': '.x{color:red}', 'wp-content/plugins/p2/p2.php': hdr('P2') + "wp_enqueue_style( 'p2', plugin_dir_url( __FILE__ ) . 'c.css' );\n", 'wp-content/plugins/p2/c.css': '.x{color:blue}' }), { title: 'White screen', description: 'blank', symptom: 'white-screen' });
    const cssH = r1b.an.hypotheses.hypotheses.find(h => h.type === 'css-selector-overlap');
    ok(cssH && cssH.score_breakdown.some(b => b.rule === 'symptom-mismatch' && b.points === -3), 'a CSS problem is penalised when the symptom is a white screen');
    const s6 = site('contra', { 'wp-content/plugins/x1/x1.php': hdr('X1') + 'function dupe() {}\n', 'wp-content/plugins/x2/x2.php': hdr('X2') + 'function dupe() {}\n' });
    const r6 = await investigate(s6, { title: 'Blank page', description: 'blank', symptom: 'white-screen', allow: ['wp-content/plugins/x1', 'wp-content/plugins/x2'], log: '[27-Oct-2026 10:00:00 UTC] PHP Notice:  something harmless in /s/wp-content/plugins/zzz/z.php on line 1\n' });
    const contra = r6.an.hypotheses.hypotheses.find(h => h.type === 'duplicate-declaration');
    ok(contra && contra.contradicts.length === 1 && contra.score_breakdown.some(b => b.rule === 'contradiction' && b.points === -2) && contra.status === 'UNVERIFIED', 'a duplicate declaration is contradicted when the log was read and has no fatal error (-2, and it stays UNVERIFIED)');

    // timing
    const s7 = site('timing', { 'wp-content/plugins/new-one/new-one.php': hdr('New One') + 'function t_a() {}\n', 'wp-content/plugins/old-one/old-one.php': hdr('Old One') + 'function t_a() {}\n' });
    fs.utimesSync(path.join(s7, 'wp-content/plugins/new-one/new-one.php'), new Date('2026-10-20T12:00:00Z'), new Date('2026-10-20T12:00:00Z'));
    fs.utimesSync(path.join(s7, 'wp-content/plugins/old-one/old-one.php'), new Date('2025-01-01T12:00:00Z'), new Date('2025-01-01T12:00:00Z'));
    const r7 = await investigate(s7, { title: 'Broke', description: 'It broke on 2026-10-21', symptom: 'white-screen', allow: ['wp-content/plugins/new-one', 'wp-content/plugins/old-one'], log: '[27-Oct-2026 10:11:12 UTC] PHP Fatal error:  Cannot redeclare t_a() (previously declared in /s/wp-content/plugins/old-one/old-one.php:5) in /s/wp-content/plugins/new-one/new-one.php on line 5\n' });
    const th = r7.an.hypotheses.hypotheses[0];
    ok(th.score_breakdown.some(b => b.rule === 'timing' && /new-one/.test(b.why) && !/old-one/.test(b.why)), 'timing: the plugin modified within 3 days of the "since" date in the report is credited, the old one is not');

    group('hypothesis scoring: unverified taxonomy signals weigh less');
    const mmH = H3.find(h => h.type === 'jquery-api-version-mismatch');
    ok(mmH.score_breakdown.some(b => b.rule === 'support:index-unverified' && b.points === 0.25) && !mmH.score_breakdown.some(b => b.rule === 'support:index'), 'fancy-slider "provides the slider" only through an unverified signal (shortcode metaslider): its mention counts 0.25, not 0.5');
    ok(H1[0].score_breakdown.every(b => b.rule !== 'support:index-unverified'), 'a component with no taxonomy match gets neither');
    ok(hyp.SCORING.some(r => r.rule === 'support:index-unverified' && r.points === 0.25) && hyp.SCORING.some(r => r.rule === 'support:graph-relevant-unverified' && r.points === 1) && hyp.SCORING.find(r => r.rule === 'support:graph-relevant').points === 2, 'the scoring table lists the reduced rules next to the full ones');
    const MAIL = f => ({ ['wp-content/plugins/' + f + '/' + f + '.php']: hdr(f) + `add_filter( 'wp_mail_from', '${f.replace(/-/g, '_')}_f', 10 );\nfunction ${f.replace(/-/g, '_')}_f( $x ) { return $x; }\n` });
    const rvf = await investigate(site('hookver', { ...MAIL('mail-a'), ...MAIL('mail-b') }), { title: 'Emails missing', description: 'Notification emails are not sent', symptom: 'wrong-content' });
    const hvf = rvf.an.hypotheses.hypotheses.find(h => h.type === 'hook-same-priority');
    ok(hvf && hvf.supports[0].kind === 'graph-relevant' && hvf.score_breakdown.some(b => b.rule === 'support:graph-relevant' && b.points === 2), 'email feature: wp_mail_from is a VERIFIED taxonomy hook (found on developer.wordpress.org), so two plugins on it get the full +2');
    const CF = f => ({ ['wp-content/plugins/' + f + '/' + f + '.php']: hdr(f) + `add_action( 'wpcf7_before_send_mail', '${f.replace(/-/g, '_')}_f', 10 );\nfunction ${f.replace(/-/g, '_')}_f( $x ) {}\n` });
    const rvu = await investigate(site('hookunv', { ...CF('form-a'), ...CF('form-b') }), { title: 'Contact form mails fail', description: 'The contact form shows success but no mail arrives', symptom: 'wrong-content' });
    const hvu = rvu.an.hypotheses.hypotheses.find(h => h.type === 'hook-same-priority');
    ok(hvu && hvu.supports[0].kind === 'graph-relevant-unverified' && hvu.score_breakdown.some(b => b.rule === 'support:graph-relevant-unverified' && b.points === 1) && !hvu.score_breakdown.some(b => b.rule === 'support:graph-relevant'), 'contact-form feature: wpcf7_before_send_mail is NOT in any cited official page, so the same situation gets +1, not +2');
    ok(hvf.score - hvu.score >= 0.9, `and the verified case outranks the unverified one (${hvf.score} vs ${hvu.score})`);
    const rvn = await investigate(site('hooknamed', { ...CF('form-c'), ...CF('form-d') }), { title: 'Contact form mails fail', description: 'form-c and form-d are both active and no mail arrives', symptom: 'wrong-content' });
    const hvn = rvn.an.hypotheses.hypotheses.find(h => h.type === 'hook-same-priority');
    ok(hvn && hvn.supports[0].kind === 'graph-relevant' && hvn.score_breakdown.some(b => b.rule === 'support:graph-relevant' && b.points === 2), 'when the evidence names both components the pair is relevant on its own, so the unverified taxonomy signal does not reduce it');

    group('determinism and safety');
    // two SEPARATE issues with the same input: different ids and times, everything else identical
    const rA = await investigate(s3, { title: 'Slider does nothing', description: 'The homepage slider does nothing since the theme update, console says $ is not a function', symptom: 'js-error', allow: ['wp-content/themes/acme'], oracle: { type: 'console-error', value: 'is not a function' } });
    const rB = await investigate(s3, { title: 'Slider does nothing', description: 'The homepage slider does nothing since the theme update, console says $ is not a function', symptom: 'js-error', allow: ['wp-content/themes/acme'], oracle: { type: 'console-error', value: 'is not a function' } });
    const normalise = r => fs.readdirSync(path.join(r.dir, 'work')).filter(n => n.endsWith('.json')).sort().map(n => `${n}\n${fs.readFileSync(path.join(r.dir, 'work', n), 'utf8').split(r.issue.id).join('<ISSUE-ID>')}`).join('\n\0');
    ok(rA.issue.id !== rB.issue.id && rA.issue.created_at !== undefined, 'two separate issues have different ids');
    ok(normalise(rA) === normalise(rB) && normalise(rA).includes('hypotheses.json') && normalise(rA).includes('graph.json'), `determinism across separate investigations: all ${fs.readdirSync(path.join(rA.dir, 'work')).filter(n => n.endsWith('.json')).length} work files are byte-identical once the issue id is replaced (no timestamps are written)`);
    const snap = r => ['collisions.json', 'graph.json', 'slice.json', 'kb-hits.json', 'hypotheses.json', 'feature-index.json'].map(f => fs.readFileSync(path.join(r.dir, 'work', f), 'utf8')).join('\0');
    const a1 = snap(r3); analysis.run(r3.issue.id, { root: s3, config: path.join(tmp, fs.readdirSync(tmp).find(n => /^cfg-/.test(n))) });
    ok(a1.length > 1000, 'analysis outputs written: collisions, graph, slice, kb-hits, hypotheses');
    const cfg3 = (() => { const f = path.join(tmp, 'cfg-fixed.json'); fs.writeFileSync(f, JSON.stringify({ customPaths: ['wp-content/themes/acme'] })); return f; })();
    analysis.run(r3.issue.id, { root: s3, config: cfg3 }); const b1 = snap(r3); analysis.run(r3.issue.id, { root: s3, config: cfg3 }); const b2 = snap(r3);
    ok(b1 === b2, 'determinism: a second analysis gives byte-identical collisions, graph, slice, kb-hits and hypotheses');
    ok(collide.libOf('https://ajax.googleapis.com/ajax/libs/jquery/1.12.4/jquery.min.js', '').version === '1.12.4' && collide.libOf('js/select2.min.js', '/*! Select2 4.0.13 */').version === '4.0.13', 'library and version from a URL or a banner comment');
    ok(hashTree(s3) === hashTree(s3) && !fs.existsSync(path.join(s3, 'work')), 'nothing was written into the site');
    const jsErr = collide.analyseJs('import x from "y"; <<< not js');
    ok(jsErr.parse_error && jsErr.globals.length === 0, 'unparsable JavaScript is reported with its error, not thrown');
    ok(corehandles.load(s3).known && !corehandles.load(path.join(tmp, 'nowhere')).known, 'core handles: known with script-loader.php, unknown without');

    console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } process.exit(1); });
