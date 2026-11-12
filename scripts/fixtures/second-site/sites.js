// A SECOND fake WordPress site for the generality tests (scripts/selftest-second-site.js and selftest-second-site-docker.js). It is not the
// site the earlier fixtures were written around (scripts/fixtures/issue/trees.js): another made-up shop ("Larkspur Tea Shop"), its own theme
// pair, an innocent plugin that is always there, and one problem per builder. Each builder writes into `root` (a temp folder) and returns
// what the test needs to know about the site. Everything is plain text so a reader can see what the test is about. Nothing here is real.
//   pluginPair      two plugins that only fail TOGETHER (HTTP 500 on the home page); removing either one clears the page
//   healthy         nothing is wrong: the home page loads, the log has no error
//   pluginRedirect  a PLUGIN (not .htaccess) redirects the home page to itself on template_redirect, so the browser gives up
//   dbError         wp-config.php holds wrong database credentials; the log has the connection warning WordPress writes
//   themeFatal      the ACTIVE theme's functions.php calls a function that does not exist, on every front-end page (HTTP 500, a fatal in the log)
//   missingDep      a plugin calls a function of Advanced Custom Fields, which is NOT installed: { guarded: false } unguarded (a fatal),
//                   { guarded: true } behind function_exists( 'get_field' ) (no fatal, the page loads)
const fs = require('fs');
const path = require('path');

// the small helper of scripts/fixtures/issue/trees.js (copied, not shared, so neither file depends on the other)
const w = (root, rel, body) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); return f; };
const head = (name, extra = '') => `<?php\n/**\n * Plugin Name: ${name}\n * Version: 1.2.0\n * Author: Larkspur Fixtures\n${extra} */\n`;

const SHOP = 'Larkspur Tea Shop';
const INNOCENT = { slug: 'lk-contact-card', name: 'Larkspur Contact Card' };

// the parts every variant shares: a wp-config.php with (fixture) database settings, the WordPress version, two small themes (the fresh install
// of a test copy activates twentytwentyfive; twentytwentyfour is the "default theme" a bisection can switch to) and one innocent plugin
function base(root, { db = {} } = {}) {
    const d = { name: 'larkspur', user: 'larkspur_wp', pass: 'fixture-pass-for-tests', host: 'localhost', ...db };
    w(root, 'wp-config.php', `<?php\n// ${SHOP} (fixture)\ndefine( 'DB_NAME', '${d.name}' );\ndefine( 'DB_USER', '${d.user}' );\ndefine( 'DB_PASSWORD', '${d.pass}' );\ndefine( 'DB_HOST', '${d.host}' );\n$table_prefix = 'lk_';\ndefine( 'WP_DEBUG', true );\ndefine( 'WP_DEBUG_LOG', true );\ndefine( 'WP_DEBUG_DISPLAY', false );\nrequire_once ABSPATH . 'wp-settings.php';\n`);
    w(root, 'wp-includes/version.php', "<?php\n$wp_version = '6.8.1';\n");
    fs.mkdirSync(path.join(root, 'wp-content', 'uploads'), { recursive: true });
    for (const [slug, name] of [['twentytwentyfive', 'Twenty Twenty-Five'], ['twentytwentyfour', 'Twenty Twenty-Four']]) {
        w(root, `wp-content/themes/${slug}/style.css`, `/*\nTheme Name: ${name}\nVersion: 1.0\n*/\n`);
        w(root, `wp-content/themes/${slug}/index.php`, `<?php\necho '<!doctype html><html><head><title>${SHOP}</title></head><body><h1>${SHOP}</h1><p>Loose leaf teas, packed by hand. Theme ${slug}.</p></body></html>';\n`);
    }
    w(root, `wp-content/plugins/${INNOCENT.slug}/${INNOCENT.slug}.php`, head(INNOCENT.name) + "defined( 'ABSPATH' ) || exit;\n\nadd_shortcode( 'lk_contact', function () {\n\treturn '<p class=\"lk-contact\">Call us: 0100 000 000</p>';\n} );\n");
}

// 1. Two plugins that only fail together. Stock Sync (loaded second) only defines a helper; Price Badge stops the home page with HTTP 500
//    when that helper exists. Price Badge alone: the helper is missing, the page loads. Stock Sync alone: nobody calls it, the page loads.
//    Modelled on trees.js threePlugins / hookCollision, but a new tree: two plugins, an innocent third one, no log entry naming either.
function pluginPair(root) {
    base(root);
    w(root, 'wp-content/plugins/lk-stock-sync/lk-stock-sync.php', head('Larkspur Stock Sync') + "defined( 'ABSPATH' ) || exit;\n\nfunction lk_stock_ready() {\n\treturn true;\n}\n");
    w(root, 'wp-content/plugins/lk-price-badge/lk-price-badge.php', head('Larkspur Price Badge') + "defined( 'ABSPATH' ) || exit;\n\nadd_action( 'template_redirect', function () {\n\tif ( is_front_page() && function_exists( 'lk_stock_ready' ) ) {\n\t\twp_die( 'The price badge could not be built.', 'Larkspur', array( 'response' => 500 ) );\n\t}\n} );\n");
    return { description: 'Since yesterday the home page of the tea shop shows an error message instead of the shop.', pair: ['lk-price-badge', 'lk-stock-sync'], pairNames: ['Larkspur Price Badge', 'Larkspur Stock Sync'], innocent: [INNOCENT.slug] };
}

// 2. Nothing is wrong: the theme prints the page, the innocent plugin adds a shortcode, there is no error log entry.
function healthy(root) {
    base(root);
    w(root, 'wp-content/plugins/lk-opening-hours/lk-opening-hours.php', head('Larkspur Opening Hours') + "defined( 'ABSPATH' ) || exit;\n\nadd_filter( 'the_content', function ( $c ) {\n\treturn $c . '<p class=\"lk-hours\">Open Monday to Saturday.</p>';\n} );\n");
    return { description: 'Please check the shop before the weekend sale. Everything looks fine to me, I only want to be sure.', plugins: [INNOCENT.slug, 'lk-opening-hours'] };
}

// 3. A redirect loop made by a PLUGIN (not by .htaccess): on template_redirect it sends the home page to the home page again.
function pluginRedirect(root) {
    base(root);
    w(root, 'wp-content/plugins/lk-home-redirect/lk-home-redirect.php', head('Larkspur Home Redirect') + "defined( 'ABSPATH' ) || exit;\n\n// meant to send visitors to the shop's start page; the target it builds is the home page itself\nadd_action( 'template_redirect', function () {\n\tif ( is_front_page() ) {\n\t\twp_redirect( home_url( '/' ), 302 );\n\t\texit;\n\t}\n} );\n");
    return { description: 'The home page never opens. The browser keeps loading and then says the page redirected too many times.', plugin: 'lk-home-redirect', pluginName: 'Larkspur Home Redirect', innocent: [INNOCENT.slug] };
}

// 4. Wrong database credentials in wp-config.php. The log holds what WordPress writes when the connection is refused (a warning from
//    wp-includes/class-wpdb.php); every page shows "Error establishing a database connection".
function dbError(root) {
    base(root, { db: { pass: 'wrong-fixture-pass-after-move', host: 'db.larkspur.invalid' } });
    const one = t => `[${t} UTC] PHP Warning:  mysqli_real_connect(): (HY000/1045): Access denied for user 'larkspur_wp'@'db.larkspur.invalid' (using password: YES) in ${root}/wp-includes/class-wpdb.php on line 1982\n`;
    w(root, 'wp-content/debug.log', one('12-Nov-2026 08:00:00') + one('12-Nov-2026 08:00:41') + one('12-Nov-2026 08:01:15'));
    return { description: 'Every page of the site shows "Error establishing a database connection" since the host moved the database.', plugins: [INNOCENT.slug], phrase: 'Error establishing a database connection' };
}

// 5. A fatal error in the ACTIVE theme. A test site built from the files only (no database) starts WordPress's default theme folder, twentytwentyfive,
//    so the made-up theme "Larkspur Teahouse" lives in that folder (its own Theme Name); twentytwentyfour stays clean, so the bisection's
//    "default theme" step can show the page loading without it. The fatal happens only on front-end pages (template_redirect), never for WP-CLI.
const THEME = { slug: 'twentytwentyfive', name: 'Larkspur Teahouse' };
function themeFatal(root) {
    base(root);
    w(root, `wp-content/themes/${THEME.slug}/style.css`, `/*\nTheme Name: ${THEME.name}\nVersion: 2.0.1\nAuthor: Larkspur Fixtures\n*/\n`);
    const fn = w(root, `wp-content/themes/${THEME.slug}/functions.php`, "<?php\n// Larkspur Teahouse: show the seasonal tea badge in the header\nadd_action( 'template_redirect', function () {\n\tlk_teahouse_badge();\n} );\n");
    const one = t => `[${t} UTC] PHP Fatal error:  Uncaught Error: Call to undefined function lk_teahouse_badge() in ${root}/wp-content/themes/${THEME.slug}/functions.php:4\nStack trace:\n#0 ${root}/wp-includes/class-wp-hook.php(324): {closure}('')\n#1 {main}\n  thrown in ${root}/wp-content/themes/${THEME.slug}/functions.php on line 4\n`;
    w(root, 'wp-content/debug.log', one('12-Nov-2026 09:10:00') + one('12-Nov-2026 09:10:31'));
    return { description: 'After I updated my theme, every page of the shop shows "There has been a critical error on this website."', theme: THEME.slug, themeName: THEME.name, plugins: [INNOCENT.slug], file: fn };
}

// 6. A missing dependency. Larkspur Banner Fields reads a field with get_field(), a function of Advanced Custom Fields, which is NOT installed.
//    guarded: false -> called directly on every front-end page: "Call to undefined function get_field()" (a fatal, in the log)
//    guarded: true  -> behind function_exists( 'get_field' ): nothing happens without ACF, the page loads, the log stays empty
const DEP = { slug: 'lk-banner-fields', name: 'Larkspur Banner Fields', needs: 'advanced-custom-fields' };
function missingDep(root, { guarded = false } = {}) {
    base(root);
    const call = guarded ? "\tif ( function_exists( 'get_field' ) ) {\n\t\techo esc_html( get_field( 'lk_banner_text' ) );\n\t}\n" : "\techo esc_html( get_field( 'lk_banner_text' ) );\n";
    w(root, `wp-content/plugins/${DEP.slug}/${DEP.slug}.php`, head(DEP.name) + `defined( 'ABSPATH' ) || exit;\n\nadd_action( 'template_redirect', function () {\n${call}} );\n`);
    if (!guarded) {
        const line = 10;
        const one = t => `[${t} UTC] PHP Fatal error:  Uncaught Error: Call to undefined function get_field() in ${root}/wp-content/plugins/${DEP.slug}/${DEP.slug}.php:${line}\nStack trace:\n#0 ${root}/wp-includes/class-wp-hook.php(324): {closure}('')\n#1 {main}\n  thrown in ${root}/wp-content/plugins/${DEP.slug}/${DEP.slug}.php on line ${line}\n`;
        w(root, 'wp-content/debug.log', one('12-Nov-2026 10:00:00') + one('12-Nov-2026 10:00:52'));
    }
    return { description: guarded ? 'Please check the shop banner plugin; I removed Advanced Custom Fields and want to be sure nothing broke.' : 'Since I removed Advanced Custom Fields the shop shows "There has been a critical error on this website."',
        plugin: DEP.slug, pluginName: DEP.name, needs: DEP.needs, guarded, plugins: [INNOCENT.slug, DEP.slug] };
}

module.exports = { w, base, pluginPair, healthy, pluginRedirect, dbError, themeFatal, missingDep, THEME, DEP, SHOP, INNOCENT };
