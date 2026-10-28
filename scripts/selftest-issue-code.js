#!/usr/bin/env node
// Offline self-test of issue mode, step 4: PHP syntax-tree facts, custom-code-first analysis, ownership gate, component/feature index.
// Uses a disposable fake WordPress tree. Nothing is executed (only `php -l` and parsing); no network, no browser, no real site.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-code-'));
process.env.PLUGIN_GUARD_ISSUES = path.join(tmp, 'issues');
const phpast = require('../issue/phpast');
const custom = require('../issue/custom');
const indexer = require('../issue/index');
const analysis = require('../issue/analysis');
const ownership = require('../lib/ownership');
const store = require('../lib/issue-store');

let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) failures++; };
const group = t => console.log(`\n== ${t}`);
const write = (root, rel, body) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); return f; };
function hashTree(dir) {
    const h = crypto.createHash('sha256');
    (function walk(d) { for (const n of fs.readdirSync(d).sort()) { const f = path.join(d, n), st = fs.lstatSync(f); h.update(`${path.relative(dir, f)}|${st.isSymbolicLink() ? 'l' : st.isDirectory() ? 'd' : 'f'}|${st.mode}|`); if (st.isDirectory()) walk(f); else if (st.isFile()) h.update(fs.readFileSync(f)); } })(dir);
    return h.digest('hex');
}
const hdr = (name, v = '1.0.0', extra = '') => `<?php\n/**\n * Plugin Name: ${name}\n * Version: ${v}\n${extra} */\n`;

// ------------------------------------------------------------------ fixture
const wp = path.join(tmp, 'site'), outside = path.join(tmp, 'outside');
write(wp, 'wp-config.php', '<?php // fixture');
write(wp, 'wp-includes/version.php', "<?php $wp_version = '6.6';");
write(wp, 'wp-includes/script-loader.php', `<?php
function wp_default_scripts( $scripts ) {
	$scripts->add( 'jquery', false, array( 'jquery-core', 'jquery-migrate' ), '3.7.1' );
	$scripts->add( 'jquery-core', '/wp-includes/js/jquery/jquery.js', array(), '3.7.1' );
	$scripts->add( 'jquery-migrate', '/wp-includes/js/jquery/jquery-migrate.js', array(), '3.4.1' );
	$vendor = array( 'react' => array(), 'lodash' => array() );
	foreach ( $vendor as $handle => $deps ) { $scripts->add( $handle, "/v/$handle.js", $deps, '1', 1 ); }
	foreach ( array( 'all', 'html5' ) as $h ) { $scripts->add( "mediaelement-$h", '/m.js' ); }
}
function wp_default_styles( $styles ) { $styles->add( 'dashicons', '/wp-includes/css/dashicons.css' ); }
`);
write(outside, 'evil.php', "<?php function outside_fn() {} add_action('init','outside_fn');");

write(wp, 'wp-content/plugins/woocommerce/woocommerce.php', hdr('WooCommerce', '9.0.0') + `
add_shortcode( 'woocommerce_checkout', 'wc_checkout_shortcode' );
function wc_checkout_shortcode() { return ''; }
add_action( 'rest_api_init', function () { register_rest_route( 'wc/store/v1', '/checkout', array( 'methods' => 'POST', 'permission_callback' => '__return_true' ) ); } );
wp_register_script( 'wc-checkout', plugins_url( 'assets/js/checkout.js', __FILE__ ), array( 'jquery' ), '9.0.0', true );
register_post_type( 'shop_order', array() );
add_action( 'woocommerce_checkout_process', 'wc_noop' );
require __DIR__ . '/includes/class-wc-shortcodes.php';
function wc_noop() {}
`);
write(wp, 'wp-content/plugins/woocommerce/includes/class-wc-shortcodes.php', `<?php
class WC_Shortcodes {
	public static function init() {
		$shortcodes = array(
			'woocommerce_cart' => __CLASS__ . '::cart',
			'woocommerce_my_account' => __CLASS__ . '::my_account',
		);
		foreach ( $shortcodes as $shortcode => $function ) {
			add_shortcode( apply_filters( "{$shortcode}_shortcode_tag", $shortcode ), $function );
		}
	}
}
`);
write(wp, 'wp-content/plugins/woocommerce/templates/checkout/form-checkout.php', '<?php\n/**\n * Checkout Form\n *\n * @version 9.0.0\n */\n');
write(wp, 'wp-content/plugins/woo-gateway-x/woo-gateway-x.php', hdr('Woo Gateway X', '2.1.0', ' * Requires Plugins: woocommerce\n') + `
add_filter( 'woocommerce_checkout_process', 'gx_check', 10 );
function gx_check() {}
function my_helper() { return 'gateway'; }
wp_localize_script( 'wc-checkout', 'acmeData', array( 'gx' => 1 ) );
`);
write(wp, 'wp-content/plugins/wp-rocket/wp-rocket.php', hdr('WP Rocket', '3.16') + "add_action( 'template_redirect', 'rocket_buffer', 2 );\nfunction rocket_buffer() {}\n");
write(wp, 'wp-content/advanced-cache.php', '<?php // drop-in written by the cache plugin');
write(wp, 'wp-content/plugins/noisy/noisy.php', hdr('Noisy') + "add_action( 'template_redirect', 'noisy_a' ); add_action( 'wp_footer', 'noisy_b' ); function noisy_a() {} function noisy_b() {}\n");
write(wp, 'wp-content/plugins/acme-checkout/includes/dequeue.php', "<?php\nwp_dequeue_script( 'wc-checkout' );\n");
write(wp, 'wp-content/plugins/slide-pack/slide-pack.php', hdr('Slide Pack') + "add_shortcode( 'metaslider', 'sp_slide' );\nfunction sp_slide() {}\n");
write(wp, 'wp-content/plugins/lib-a/lib-a.php', hdr('Lib A') + 'function shared_util() { return 1; }\n');
write(wp, 'wp-content/plugins/lib-b/lib-b.php', hdr('Lib B') + 'function shared_util() { return 2; }\n');

write(wp, 'wp-content/plugins/acme-checkout/acme-checkout.php', hdr('Acme Checkout', '1.4.0') + `defined( 'ABSPATH' ) || exit;
// add_action( 'commented_hook', 'never' );
$text = "add_action( 'string_hook', 'never' )";
add_action( 'woocommerce_checkout_update_order_review', 'acme_update', 20, 2 );
remove_action( 'woocommerce_checkout_process', 'gx_check', 20 );
function acme_update( $posted ) {}
function my_helper() { return 'acme'; }
if ( ! function_exists( 'acme_guarded' ) ) { function acme_guarded() {} }
wp_enqueue_script( 'acme-slider', plugin_dir_url( __FILE__ ) . 'js/slider.js', array( 'jquery', 'swiper-missing' ), '1.0', true );
wp_localize_script( 'acme-slider', 'acmeData', array( 'url' => '/x', 'nonce' => 'n' ) );
add_action( 'wp_ajax_acme_' . $kind, array( __CLASS__, 'ajax' ) );
`);
write(wp, 'wp-content/plugins/acme-checkout/readme.txt', '=== Acme Checkout ===\nContributors: acme\nTags: checkout, cart, woocommerce\nRequires at least: 6.0\n\nCustom checkout tweaks for the Acme shop.\n\n== Description ==\nLong text\n');
write(wp, 'wp-content/plugins/acme-checkout/includes/broken.php', '<?php\nfunction broken( {\n');
write(wp, 'wp-content/plugins/acme-checkout/includes/modern.php', "<?php\nenum Suit: string { case A = 'a'; }\nfinal class M { public function __construct(private readonly int $x = 1) {} public function f() { return match(true) { default => 1 }; } }\n");
write(wp, 'wp-content/plugins/acme-checkout/vendor/lib/util.php', '<?php function my_helper() { return "vendor copy"; }\n');
fs.symlinkSync(outside, path.join(wp, 'wp-content/plugins/acme-checkout/escape'));

write(wp, 'wp-content/themes/acme-child/style.css', '/*\nTheme Name: Acme Child\nTemplate: twentytwentyfour\nVersion: 1.0\n*/');
write(wp, 'wp-content/themes/acme-child/functions.php', `<?php
add_action( 'wp_enqueue_scripts', 'acme_child_scripts', 100 );
function acme_child_scripts() {
    wp_deregister_script( 'jquery' );
    wp_register_script( 'jquery', 'https://ajax.googleapis.com/ajax/libs/jquery/1.12.4/jquery.min.js', array(), '1.12.4', false );
    wp_enqueue_script( 'jquery' );
}
`);
write(wp, 'wp-content/themes/acme-child/woocommerce/checkout/form-checkout.php', '<?php\n/**\n * Checkout Form (child override)\n *\n * @version 3.5.0\n */\n');
write(wp, 'wp-content/themes/other-theme/style.css', '/*\nTheme Name: Other\nVersion: 1.0\n*/');
write(wp, 'wp-content/themes/other-theme/woocommerce/checkout/form-checkout.php', '<?php\n/**\n * @version 9.0.0\n */\n');

const ALLOW = ['wp-content/plugins/acme-checkout', 'wp-content/themes/acme-child'];
const policy = ownership.loadPolicy(wp, { customPaths: ALLOW }).policy;
const noPolicy = ownership.loadPolicy(wp, {}).policy;
const before = hashTree(wp);
const evidence = { features: [{ id: 'checkout', matched: 'checkout' }, { id: 'cache', matched: 'cache' }, { id: 'search', matched: 'search' }, { id: 'slider', matched: 'slider' }], clues: [], component_hints: [] };

(function syntaxTree() {
    group('PHP syntax tree');
    const F = phpast.analyse(`<?php
namespace Acme;
if ( ! function_exists( 'acme_helper' ) ) { function acme_helper() {} }
function plain() {}
class Boot { function __construct() {
 add_action( 'init', [ $this, 'init' ], 20, 2 );
 add_filter( 'the_content', fn($c) => $c, PHP_INT_MAX );
 remove_action( 'wp_head', 'wp_generator', 5 );
 wp_enqueue_script( 'acme-slider', plugins_url( 'js/s.js', __FILE__ ), array( 'jquery', 'swiper' ), '1.0', true );
 // add_action('commented','out');
 $s = "add_action('instring','x')";
 add_action( 'wp_ajax_acme_' . $kind, array( __CLASS__, 'ajax' ) );
 add_action( 'wp_ajax_nopriv_save', 'save_it' );
 wp_localize_script('acme-slider','acmeData',array('ajax'=>admin_url('admin-ajax.php'),'nonce'=>'x'));
 global $wpdb; $wpdb->get_results("SELECT * FROM {$wpdb->prefix}x WHERE id=$id"); $wpdb->get_results($wpdb->prepare("SELECT 1 FROM t WHERE a=%d",1));
 register_post_type('book',[]); add_shortcode('acme_form',[$this,'form']); update_option('acme_opt',1);
 wp_enqueue_style('acme', get_stylesheet_directory_uri() . '/css/a.css');
} }`, 'x.php');
    ok(F.parsed && F.errors.length === 0, 'PHP 8 code with namespaces, arrow functions and constants parses');
    ok(!F.hooks.some(h => /commented|instring/.test(h.hook || '')), 'calls inside comments and strings are ignored');
    const init = F.hooks.find(h => h.hook === 'init');
    ok(init && init.priority === 20 && init.args === 2 && init.callback.kind === 'method' && init.callback.class === '$this' && init.callback.name === 'init', 'hook priority, accepted args and $this callback');
    ok(F.hooks.find(h => h.hook === 'the_content').priority === 2147483647 && F.hooks.find(h => h.hook === 'the_content').callback.kind === 'closure', 'PHP_INT_MAX and closures');
    const rm = F.hooks.find(h => h.op === 'remove');
    ok(rm && rm.hook === 'wp_head' && rm.callback.name === 'wp_generator' && rm.priority === 5, 'remove_action with callback and priority');
    const dyn = F.hooks.find(h => h.dynamic);
    ok(dyn && dyn.prefix === 'wp_ajax_acme_' && dyn.callback.class === 'self' && F.ajax.some(a => a.dynamic && a.action === 'acme_'), 'concatenated hook name keeps its literal prefix; __CLASS__ callback; AJAX action detected');
    ok(F.ajax.some(a => a.action === 'save' && a.nopriv), 'wp_ajax_nopriv_ hook is an AJAX action without login');
    ok(F.functions.find(f => f.name === 'Acme\\acme_helper').guarded === true && F.functions.find(f => f.name === 'Acme\\plain').guarded === false, 'if ( ! function_exists() ) guard is recognised, namespaced names');
    const slider = F.assets.find(a => a.handle === 'acme-slider');
    ok(slider.deps.join() === 'jquery,swiper' && slider.src.rel === 'js/s.js' && slider.src.base === 'file-dir' && slider.ver === '1.0', 'script handle, dependency array, source relative to the file, version');
    ok(F.assets.find(a => a.handle === 'acme').src.base === 'theme', 'theme stylesheet source');
    ok(F.localize.find(l => l.object === 'acmeData').keys.join() === 'ajax,nonce', 'wp_localize_script object and keys');
    ok(F.db.some(d => d.interpolated && !d.prepared) && F.db.some(d => d.prepared), 'wpdb call with interpolated SQL vs prepared SQL');
    ok(F.cpts[0].name === 'book' && F.shortcodes[0].tag === 'acme_form' && F.options[0].name === 'acme_opt', 'post type, shortcode, option');
    const bad = phpast.analyse('<?php\nfunction broken( {\n', 'b.php');
    ok(!bad.parsed && bad.errors.length > 0 && bad.errors[0].line, 'a syntax error is reported with its line, not skipped');
    ok(phpast.phpLint(path.join(wp, 'wp-content/plugins/acme-checkout/includes/broken.php')).ok === false && phpast.phpLint(path.join(wp, 'wp-content/plugins/acme-checkout/acme-checkout.php')).ok === true, 'php -l agrees: broken file is broken, good file is good');
    ok(phpast.analyse(fs.readFileSync(path.join(wp, 'wp-content/plugins/acme-checkout/includes/modern.php'), 'utf8'), 'm.php').parsed, 'enum, readonly promoted property and match expression parse');
})();

group('custom code first: ownership gate');
const R = custom.analyse(wp, { policy, hints: ['woo-gateway-x'], focus: {} });
const comp = ref => R.components.find(c => c.ref === ref);
ok(R.mode === 'custom-first' && R.message === null, 'with an allowlist the mode is custom-first');
ok(comp('acme-checkout').ownership === 'custom' && comp('acme-checkout').depth === 'syntax-tree' && !comp('acme-checkout').inspection_only, 'the allowlisted plugin is custom and analysed with the syntax tree');
ok(comp('theme:acme-child').ownership === 'custom' && comp('theme:acme-child').depth === 'syntax-tree', 'the allowlisted theme is custom');
ok(comp('woocommerce').ownership === 'unknown' && comp('woocommerce').depth === 'surface' && comp('woocommerce').inspection_only, 'a plugin that is not on the allowlist is never assumed to be ours; it gets the regex surface only');
ok(comp('woo-gateway-x').depth === 'syntax-tree' && comp('woo-gateway-x').inspection_only && comp('woo-gateway-x').ownership === 'unknown', 'a component the evidence points at gets the syntax tree but stays inspection-only');
ok(comp('theme:other-theme').depth === 'syntax-tree' && comp('theme:other-theme').inspection_only, 'any theme is analysed deeply, inspection-only unless allowlisted');
const accFiles = R.facts['acme-checkout'];
ok(!accFiles.functions.some(f => /vendor/.test(f.file)) && comp('acme-checkout').files.skipped_protected >= 1, 'vendor/ inside custom code is skipped (protected)');
ok(!Object.values(R.facts).some(m => m.functions.some(f => f.name === 'outside_fn')), 'a symlink inside custom code is not followed, so code outside the root is never analysed');
const nR = custom.analyse(wp, { policy: noPolicy, hints: [] });
ok(nR.mode === 'inspection-only' && /no custom code declared; set customPaths/.test(nR.message) && nR.components.every(c => c.inspection_only), 'no allowlist: says so, everything is inspection-only');
ok(nR.steps[0].status === 'SKIPPED' && /customPaths/.test(nR.steps[0].reason), 'the step records why it was skipped');
ok(R.observations.every(o => o.evidence.every(e => !e.file || ['custom', 'unknown', 'protected', 'rejected'].includes(e.ownership))), 'every piece of evidence carries its ownership');
ok(R.observations.filter(o => o.custom).every(o => o.evidence.some(e => e.ownership === 'custom')), 'an observation is marked custom only when some evidence lies in custom code');

group('observations');
const O = type => R.observations.filter(o => o.type === type);
const dup = O('duplicate-declaration').find(o => o.declaration.name === 'my_helper');
ok(dup && dup.risk === 'fatal-if-both-load' && dup.components.sort().join() === 'acme-checkout,woo-gateway-x', 'duplicate my_helper(): both plugins named, "fatal if both load"');
ok(dup && dup.evidence.length === 2 && dup.evidence.every(e => e.file && e.line) && dup.evidence.find(e => /acme-checkout/.test(e.file)).ownership === 'custom' && dup.evidence.find(e => /woo-gateway-x/.test(e.file)).ownership === 'unknown', 'file:line for both; only the custom side is marked custom');
ok(!R.observations.some(o => o.declaration && o.declaration.name === 'acme_guarded'), 'a function guarded by function_exists is not reported');
ok(!dup.evidence.some(e => /vendor/.test(e.file)), 'the vendor copy of my_helper() is not part of the evidence');
const wrongPrio = O('remove-wrong-priority')[0];
ok(wrongPrio && wrongPrio.hook === 'woocommerce_checkout_process' && wrongPrio.removed_priority === 20 && wrongPrio.added_priority === 10 && wrongPrio.components.join() === 'acme-checkout,woo-gateway-x', 'remove_action at priority 20 for a callback added at priority 10 is reported as doing nothing');
const rep = O('handle-replaced').filter(o => o.handle === 'jquery');
ok(rep.length === 1 && rep[0].components[0] === 'theme:acme-child' && rep[0].replacement.ver === '1.12.4' && /1\.12\.4/.test(rep[0].replacement.src) && rep[0].custom, 'the theme replaces WordPress jQuery with 1.12.4: handle, version, file:line, custom');
ok(R.core_handles.known && R.core_handles.scripts === 7 && R.core_handles.styles === 1 && R.steps.find(s => s.id === 'core-handles').status === 'PASSED' && /script-loader\.php/.test(R.steps.find(s => s.id === 'core-handles').reason), 'core handles are read from the site\'s own script-loader.php (literal adds, loops over static arrays, interpolated names)');
const miss = O('dependency-handle-not-registered');
ok(miss.length === 1 && miss[0].missing === 'swiper-missing' && !miss.some(o => o.missing === 'jquery'), 'a dependency nobody registers is reported; core "jquery" is not');
ok(rep[0].core_handle === true && rep[0].core_version === '3.7.1' && rep[0].handle_type === 'script', 'the replaced "jquery" is recognised as a WordPress core handle, and its core version (3.7.1) is read from script-loader.php');
const bare = path.join(tmp, 'bare'); write(bare, 'wp-config.php', '<?php'); write(bare, 'wp-content/plugins/p/p.php', hdr('P') + "wp_enqueue_script( 'p-js', 'x.js', array( 'jquery', 'not-registered' ) );\nwp_dequeue_script( 'jquery' );\n");
const polBare = ownership.loadPolicy(bare, { customPaths: ['wp-content/plugins/p'] }).policy;
const RB = custom.analyse(bare, { policy: polBare });
ok(RB.core_handles.known === false && /core handles are unknown/.test(RB.core_handles.reason) && RB.steps.find(s => s.id === 'core-handles').status === 'SKIPPED', 'without script-loader.php: "core handles unknown", nothing is guessed');
ok(!RB.observations.some(o => o.type === 'dependency-handle-not-registered') && /dependency check\(s\) on handles that might be core handles were skipped/.test(RB.steps.find(s => s.id === 'core-handles').reason), 'the dependency check is skipped (and says how many) instead of using a remembered list');
const bareRemoved = RB.observations.find(o => o.type === 'handle-removed');
ok(bareRemoved && bareRemoved.handle === 'jquery' && bareRemoved.core_handle === false, 'with core handles unknown, a dequeued "jquery" is not claimed to be core');
const wcShort = R.facts.woocommerce.shortcodes.filter(x => x.resolved_from === 'static-array');
ok(R.components.find(c => c.ref === 'woocommerce').files.targeted_tree_files === 2 && R.facts.woocommerce.assets.some(a => a.handle === 'wc-checkout' && a.src && a.src.rel === 'assets/js/checkout.js' && a.src.base === 'file-dir') && wcShort.map(x => x.tag).sort().join() === 'woocommerce_cart,woocommerce_my_account' && wcShort.every(x => x.filtered === true), 'a WooCommerce-style shortcode table (foreach over a static array + apply_filters) is resolved by the syntax tree even for a surface-depth plugin; the file that registers a script is parsed too, which gives its source path');
const loc = O('localize-object-collision')[0];
ok(loc && loc.object === 'acmeData' && loc.components.sort().join() === 'acme-checkout,woo-gateway-x', 'the same JavaScript object created by two components');
const tpl = O('template-override-outdated');
ok(tpl.length === 1 && tpl[0].template === 'checkout/form-checkout.php' && tpl[0].theme_version === '3.5.0' && tpl[0].plugin_version === '9.0.0' && tpl[0].evidence[0].line === 5 && tpl[0].custom, 'outdated WooCommerce template override: versions and the @version line');
ok(R.templates.overrides.find(o => o.theme === 'theme:other-theme').outdated === false, 'an up-to-date override is not reported');
const dq = O('handle-removed').find(o => o.handle === 'wc-checkout');
ok(dq && dq.removed_by === 'acme-checkout' && dq.registered_by.join() === 'woocommerce' && dq.components.sort().join() === 'acme-checkout,woocommerce' && dq.custom, 'custom code dequeues a handle that WooCommerce registers: both components are named');
const syn = O('syntax-error')[0];
ok(syn && /broken\.php/.test(syn.evidence[0].file) && syn.evidence[0].ownership === 'custom' && syn.components[0] === 'acme-checkout' && /syntax error/i.test(syn.message), 'syntax error in custom code (php -l) is an observation with file:line');
ok(comp('acme-checkout').files.lint_broken === 1 && comp('acme-checkout').files.parsed >= 2, 'file statistics: parsed, broken');
ok(O('duplicate-declaration').every(o => o.declaration.name !== 'shared_util'), 'duplicates that only the regex surface can see (lib-a / lib-b) are NOT reported by default (the regex scanner cannot see guards)');
const R2 = custom.analyse(wp, { policy, hints: [], focus: { names: ['shared_util'] } });
const su = R2.observations.find(o => o.type === 'duplicate-declaration' && o.declaration.name === 'shared_util');
ok(su && su.components.join() === 'lib-a,lib-b' && su.evidence.every(e => e.ownership === 'unknown' && e.line), 'the same duplicate IS reported when the evidence names it (e.g. a "Cannot redeclare" log line), and none of it is custom');
ok(JSON.stringify(custom.analyse(wp, { policy, hints: ['woo-gateway-x'], focus: {} }).observations) === JSON.stringify(R.observations), 'determinism: a second analysis gives identical observations');
ok(hashTree(wp) === before, 'the WordPress tree is byte-identical after the analysis');

group('component and feature index');
const IDX = indexer.build(wp, R, evidence, { description: { title: 'Checkout is blank', text: 'Checkout shows a white screen since the gateway update' } });
const checkout = IDX.providers.find(p => p.feature === 'checkout');
const row = c => checkout.rows.find(r => r.component === c);
ok(row('woocommerce').role === 'provides' && row('woocommerce').evidence.some(e => e.kind === 'shortcode' && e.value === 'woocommerce_checkout' && e.line) && row('woocommerce').evidence.some(e => e.kind === 'rest-route' && /wc\/store\/v1\/checkout/.test(e.value)) && row('woocommerce').evidence.some(e => e.kind === 'script-handle' && e.value === 'wc-checkout'), 'WooCommerce provides checkout: shortcode, REST route and script handle, each with file:line');
ok(row('woo-gateway-x').roles.includes('extends') && row('woo-gateway-x').evidence.some(e => e.kind === 'hook-added' && /woocommerce_checkout_process @10/.test(e.value)), 'the gateway extends checkout: hook and priority');
ok(row('acme-checkout').roles.includes('extends') && row('acme-checkout').roles.includes('alters') && row('acme-checkout').ownership === 'custom', 'the custom plugin extends and alters (removes a hook of) checkout, and is marked custom');
ok(row('theme:acme-child').roles.includes('overrides') && row('theme:acme-child').evidence.some(e => e.kind === 'template-file' && /acme-child\/woocommerce\/checkout\/form-checkout\.php/.test(e.file)), 'the child theme overrides the checkout template (file shown)');
ok(checkout.rows[0].component === 'woocommerce', 'rows are ranked: the provider comes first');
ok(/Checkout: provided by WooCommerce 9\.0\.0/.test(checkout.summary) && /extended by .*Woo Gateway X/.test(checkout.summary) && /template overrides in .*acme-child/.test(checkout.summary) && /Acme Checkout \(custom\)/.test(checkout.summary), `summary sentence names provider, extenders, override and custom code: "${checkout.summary.slice(0, 200)}"`);
ok(/taxonomy signals for this feature were checked against official documentation; the rest were not/.test(checkout.summary) && checkout.signals_verified === false && checkout.signals_verified_count > 0 && checkout.signals_verified_count < checkout.signals_total, 'the summary says how many of the feature\'s taxonomy signals were checked against documentation');
ok(row('woocommerce').evidence.find(e => e.kind === 'shortcode').signal_verified === true && row('woo-gateway-x').evidence.find(e => e.kind === 'hook-added').signal_verified === true, 'each piece of evidence says whether the signal behind it was verified (woocommerce_checkout shortcode and woocommerce_checkout_process hook were)');
ok(!/extended by[^;]*WooCommerce/.test(checkout.summary) && row('woocommerce').roles.includes('extends'), 'the provider is not also listed as "extended by" itself (its own hook use is still in the evidence)');
const cache = IDX.providers.find(p => p.feature === 'cache');
ok(!cache.rows.some(r => r.component === 'noisy'), 'a plugin that only uses template_redirect / wp_footer is not a "cache" component (generic hooks are not signals)');
const GENERIC = ['init', 'wp_head', 'wp_footer', 'template_redirect', 'wp_enqueue_scripts', 'admin_init', 'plugins_loaded', 'wp_loaded', 'after_setup_theme', 'admin_menu', 'admin_enqueue_scripts', 'wp_print_scripts', 'pre_get_posts', 'posts_clauses', 'admin_notices', 'save_post', 'the_content', 'wp_ajax'];
const taxAll = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'feature-taxonomy.json'), 'utf8')).entries;
ok(taxAll.every(e => (e.signals.hooks || []).every(h => !GENERIC.includes(h))), 'taxonomy: no hook signal is one that nearly every plugin uses');
ok(cache.rows.some(r => r.component === 'wp-rocket' && r.roles.includes('known-provider')) && cache.rows.some(r => r.component === 'dropin:advanced-cache.php' && r.roles.includes('caches')), 'caching: WP Rocket by slug, the advanced-cache.php drop-in');
ok(/no installed component matched/.test(IDX.providers.find(p => p.feature === 'search').summary), 'a feature nobody provides says so instead of guessing');
ok(IDX.text_matches.length > 0 && IDX.text_matches[0].score >= IDX.text_matches[IDX.text_matches.length - 1].score, 'BM25 text matches are ordered by score');
ok(JSON.stringify(indexer.build(wp, R, evidence, { description: { title: 'Checkout is blank', text: 'Checkout shows a white screen since the gateway update' } })) === JSON.stringify(IDX), 'determinism: the same query ranks identically on every run');
const tie = indexer.build(wp, R, { features: [], clues: [], component_hints: [] }, { description: { title: 'x', text: 'helper' } }).text_matches;
ok(tie.every((h, i) => i === 0 || tie[i - 1].score > h.score || (tie[i - 1].score === h.score && tie[i - 1].ref < h.ref)), 'ties are broken by component reference');
const rd = indexer.readme(path.join(wp, 'wp-content/plugins/acme-checkout/readme.txt'));
ok(rd.tags.join() === 'checkout,cart,woocommerce' && /Custom checkout tweaks/.test(rd.short), 'readme tags and short description are read');
ok(IDX.components.find(c => c.ref === 'woo-gateway-x').requires === 'woocommerce', 'declared plugin dependencies are indexed');

group('taxonomy rows whose signals are all unverified weigh less');
const slider = IDX.providers.find(p => p.feature === 'slider'), sRow = slider.rows.find(r => r.component === 'slide-pack');
ok(sRow && sRow.role === 'provides' && sRow.all_signals_unverified === true && sRow.weight_factor === 0.5 && sRow.score_parts.roles_raw === 5 && sRow.score_parts.roles_weighted === 2.5, 'slider: the shortcode "metaslider" is not in any cited official page, so the row\'s role weight is halved (5 -> 2.5)');
ok(/Slide Pack 1\.0\.0 \[signals unverified, reduced weight\]/.test(slider.summary), 'the summary names the row as unverified and reduced');
const wooRow = IDX.providers.find(p => p.feature === 'checkout').rows.find(r => r.component === 'woocommerce');
ok(wooRow.all_signals_unverified === false && wooRow.weight_factor === 1 && wooRow.score_parts.roles_weighted === wooRow.score_parts.roles_raw, 'checkout: the WooCommerce row rests on verified signals (woocommerce_checkout shortcode) and keeps full weight');
ok(IDX.scoring.unverified_row_factor === 0.5 && IDX.scoring.role_weights.provides === 5 && IDX.scoring.rules.some(r => /multiplied by unverified_row_factor/.test(r)), 'the row scoring rules are exported with the result (and written to feature-index.json)');
const mkIdx = (verifiedSignals) => { const tx = require('../issue/describe').loadTaxonomy().map(t => t.id === 'slider' ? { ...t, verified_signals: verifiedSignals } : t); return indexer.build(wp, R, evidence, { description: { title: 'x', text: 'slider' }, taxonomy: tx }); };
const sFull = mkIdx({ shortcodes: ['metaslider'] }).providers.find(p => p.feature === 'slider').rows.find(r => r.component === 'slide-pack');
ok(sFull.weight_factor === 1 && sFull.score_parts.roles_weighted === 5 && sFull.score > sRow.score, 'the same row with ONE verified signal keeps full weight and outranks the unverified version');
ok(slider.rows.every(r => r.score_parts && typeof r.weight_factor === 'number'), 'every row records its weighting');

group('investigate end to end (CLI)');
const cfgFile = path.join(wp, 'plugin-guard.config.json');
fs.writeFileSync(cfgFile, JSON.stringify({ customPaths: ALLOW }));
const hashWithCfg = hashTree(wp);
const cli = args => spawnSync(process.execPath, [path.join(__dirname, 'guard.js'), ...args], { encoding: 'utf8', env: { ...process.env, INIT_CWD: tmp } });
const n = cli(['issue', 'new', '--no-prompt', '--title', 'Checkout is blank', '--description', 'Checkout shows a white screen. Cannot redeclare my_helper()', '--symptom', 'white-screen', '--root', wp, '--env', 'local']);
const id = /(iss-\d{8}-\d{6}-[0-9a-f]{6})/.exec(n.stdout)[1];
fs.mkdirSync(path.join(wp, 'wp-content'), { recursive: true });
fs.writeFileSync(path.join(wp, 'wp-content/debug.log'), '[27-Oct-2026 10:11:12 UTC] PHP Fatal error:  Cannot redeclare my_helper() (previously declared in /srv/s/wp-content/plugins/woo-gateway-x/woo-gateway-x.php:5) in /srv/s/wp-content/plugins/acme-checkout/acme-checkout.php on line 8\n');
const hashWithLog = hashTree(wp);
const inv = cli(['issue', 'investigate', id]);
ok(inv.status === 0 && /Custom code: acme-checkout/.test(inv.stdout) && /theme:acme-child/.test(inv.stdout), `investigate runs the analysis (exit ${inv.status}) ${inv.stderr.slice(0, 200)}`);
ok(/\[duplicate-declaration\] function my_helper\(\) is declared in 2 places/.test(inv.stdout), 'the "Cannot redeclare" log line focuses the analysis: both declarations are listed');
const dirOf = store.dirOf(id), W = f => JSON.parse(fs.readFileSync(path.join(dirOf, 'work', f), 'utf8'));
const cc = W('custom-code.json');
ok(cc.mode === 'custom-first' && cc.policy.customPaths.join() === ALLOW.join() && Object.keys(cc.facts).includes('acme-checkout') && !Object.keys(cc.facts).includes('woocommerce'), 'custom-code.json: policy and syntax-tree facts only for deep components');
ok(W('evidence.json').clues.some(c => c.type === 'php-redeclare' && c.confidence === 'certain') && W('feature-index.json').providers.some(p => p.feature === 'checkout'), 'evidence.json and feature-index.json were written');
const snap = () => ['evidence.json', 'custom-code.json', 'components.json', 'feature-index.json'].map(f => fs.readFileSync(path.join(dirOf, 'work', f), 'utf8')).join('\0');
const s1 = snap(); cli(['issue', 'investigate', id]);
ok(snap() === s1, 'determinism: a second investigation gives byte-identical work files');
ok(hashTree(wp) === hashWithLog, 'the WordPress tree is byte-identical after the investigation');
fs.rmSync(cfgFile);
const hashNoCfg = hashTree(wp);
const id2 = /(iss-\d{8}-\d{6}-[0-9a-f]{6})/.exec(cli(['issue', 'new', '--no-prompt', '--title', 'no allowlist', '--root', wp]).stdout)[1];
const inv2 = cli(['issue', 'investigate', id2]);
ok(inv2.status === 0 && /no custom code declared; set customPaths/.test(inv2.stdout) && /Custom code: none declared/.test(inv2.stdout), 'without an allowlist the CLI says "no custom code declared; set customPaths"');
ok(hashTree(wp) === hashNoCfg, 'still byte-identical');

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
