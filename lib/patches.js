// Turns finding.patch objects into files the owner reviews and applies. Nothing here touches the site.

const HARDEN = {
    generator: `// Hide the WordPress version from the page source.
remove_action( 'wp_head', 'wp_generator' );
add_filter( 'the_generator', '__return_empty_string' );`,
    xmlrpc: `// Disable XML-RPC (brute-force amplification, pingback abuse).
add_filter( 'xmlrpc_enabled', '__return_false' );
add_filter( 'xmlrpc_methods', '__return_empty_array', PHP_INT_MAX );`,
    'users-rest': `// Public REST user list -> logged-in users only.
add_filter( 'rest_endpoints', function ( $endpoints ) {
	if ( ! is_user_logged_in() ) {
		unset( $endpoints['/wp/v2/users'], $endpoints['/wp/v2/users/(?P<id>[\\d]+)'] );
	}
	return $endpoints;
} );`,
    'author-enum': `// /?author=N must not reveal usernames.
add_action( 'template_redirect', function () {
	if ( ! is_user_logged_in() && isset( $_GET['author'] ) ) {
		wp_safe_redirect( home_url( '/' ), 301 );
		exit;
	}
}, 0 );`
};

const HARDEN_EXTRA = {
    'sitemap-users': `// Keep usernames out of the built-in sitemap.
add_filter( 'wp_sitemaps_add_provider', function ( $provider, $name ) {
	return 'users' === $name ? false : $provider;
}, 10, 2 );`
};
Object.assign(HARDEN, HARDEN_EXTRA);

const HTACCESS = {
    backups: { apache: '<FilesMatch "\\.(sql|sql\\.gz|bak|old|orig)$">\n  Require all denied\n</FilesMatch>\nRedirectMatch 404 ^/(backup|dump|database|db)[^/]*\\.(zip|gz|tar)$\nRedirectMatch 404 ^/wp-content/(updraft|backups|backup-db|ai1wm-backups)/', nginx: 'location ~* \\.(sql|sql\\.gz|bak|old|orig)$ { deny all; }\nlocation ~* ^/(backup|dump|database|db)[^/]*\\.(zip|gz|tar)$ { deny all; }\nlocation ~* ^/wp-content/(updraft|backups|backup-db|ai1wm-backups)/ { deny all; }' },
    'debug-files': { apache: '<FilesMatch "^(phpinfo|info|test|adminer)\\.php$">\n  Require all denied\n</FilesMatch>', nginx: 'location ~* ^/(phpinfo|info|test|adminer)\\.php$ { deny all; }' },
    headers: { apache: '<IfModule mod_headers.c>\n  Header always set X-Content-Type-Options "nosniff"\n  Header always set Referrer-Policy "strict-origin-when-cross-origin"\n  Header always set X-Frame-Options "SAMEORIGIN"\n  Header always set Permissions-Policy "camera=(), microphone=(), geolocation=()"\n  # Enable only after HTTPS works on the site and all sub-domains:\n  # Header always set Strict-Transport-Security "max-age=31536000; includeSubDomains"\n  # A Content-Security-Policy must be written for the site\'s own scripts and fonts; do not copy a generic one.\n</IfModule>', nginx: 'add_header X-Content-Type-Options "nosniff" always;\nadd_header Referrer-Policy "strict-origin-when-cross-origin" always;\nadd_header X-Frame-Options "SAMEORIGIN" always;\nadd_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;\n# add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;  # only once HTTPS is solid' },
    'server-tokens': { apache: '<IfModule mod_headers.c>\n  Header unset X-Powered-By\n</IfModule>\n# "ServerTokens Prod" belongs in the main Apache configuration, not .htaccess', nginx: 'server_tokens off;\n# PHP: set expose_php = Off in php.ini' },
    'https-redirect': { apache: 'RewriteEngine On\nRewriteCond %{HTTPS} off\nRewriteRule ^ https://%{HTTP_HOST}%{REQUEST_URI} [L,R=301]', nginx: 'server {\n  listen 80;\n  server_name _;\n  return 301 https://$host$request_uri;\n}' },
    'core-readme': { apache: '<FilesMatch "^(readme\\.html|license\\.txt)$">\n  Require all denied\n</FilesMatch>', nginx: 'location ~* ^/(readme\\.html|license\\.txt)$ { deny all; }' },
    'debug-log': { apache: '<Files "debug.log">\n  Require all denied\n</Files>', nginx: 'location ~* /wp-content/debug\\.log$ { deny all; }' },
    dotfiles: { apache: '<FilesMatch "^\\.(?!well-known)">\n  Require all denied\n</FilesMatch>\nRedirectMatch 404 /\\.git', nginx: 'location ~ /\\.(?!well-known) { deny all; }' },
    'config-backup': { apache: '<FilesMatch "wp-config.*\\.(bak|old|orig|save|txt|swp)$|wp-config\\.php~$">\n  Require all denied\n</FilesMatch>', nginx: 'location ~* wp-config.*(\\.(bak|old|orig|save|txt|swp)|~)$ { deny all; }' },
    dirlist: { apache: 'Options -Indexes', nginx: 'autoindex off;' },
    readme: { apache: '<FilesMatch "^(readme|license|changelog)\\.(txt|md|html)$" >\n  Require all denied\n</FilesMatch>', nginx: 'location ~* ^/wp-content/plugins/.+/(readme|license|changelog)\\.(txt|md|html)$ { deny all; }' },
    'plugin-direct-php': { apache: '# Plugin PHP is only meant to run through WordPress. Allow the known entry points per plugin if one breaks.\nRewriteEngine On\nRewriteRule ^wp-content/plugins/[^/]+/(?:.+/)?(?!index\\.php)[^/]+\\.php$ - [F,L]', nginx: '# Plugin PHP is only meant to run through WordPress. Whitelist entry points per plugin if one breaks.\nlocation ~* ^/wp-content/plugins/.+\\.php$ { deny all; }' },
    'uploads-php': { apache: '<Directory "wp-content/uploads">\n  <FilesMatch "\\.php$">\n    Require all denied\n  </FilesMatch>\n</Directory>', nginx: 'location ~* ^/wp-content/uploads/.+\\.php$ { deny all; }' }
};

function collect(findings) {
    const p = { reprioritize: [], secure: [], harden: new Set(), htaccess: new Set() };
    for (const f of findings) {
        if (!f.patch) continue;
        if (f.patch.type === 'reprioritize') p.reprioritize.push(...f.patch.items);
        else if (f.patch.type === 'secure-filter') p.secure.push(f.patch);
        else if (f.patch.type === 'harden') p.harden.add(f.patch.id);
        else if (f.patch.type === 'htaccess') p.htaccess.add(f.patch.id);
    }
    return p;
}

const q = s => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

function muPlugin(p) {
    const lines = [];
    lines.push(`<?php
/**
 * Plugin Name: Plugin Guard resolutions
 * Description: Generated by plugin-guard. REVIEW BEFORE USE. Re-orders conflicting hooks and applies hardening.
 * Version: 1.0
 *
 * Install: copy to wp-content/mu-plugins/. Remove the file to undo everything in it.
 */
defined( 'ABSPATH' ) || exit;
`);
    if (p.reprioritize.length) {
        lines.push(`/**
 * Move every callback a plugin/theme registered on $hook to $priority. Callbacks are found by the file they
 * are defined in, so it works for closures and object methods too. $kind is 'plugin', 'theme' or 'mu'.
 */
function pg_reprioritize( $hook, $kind, $slug, $priority ) {
	global $wp_filter;
	if ( empty( $wp_filter[ $hook ] ) ) {
		return;
	}
	$root = 'theme' === $kind ? get_theme_root() : ( 'mu' === $kind ? WPMU_PLUGIN_DIR : WP_PLUGIN_DIR );
	$base = wp_normalize_path( trailingslashit( $root ) . ( 'mu' === $kind ? '' : $slug . '/' ) );
	$moves = array();
	foreach ( $wp_filter[ $hook ]->callbacks as $prio => $callbacks ) {
		foreach ( $callbacks as $cb ) {
			try {
				$fn = $cb['function'];
				if ( is_array( $fn ) ) {
					$ref = new ReflectionMethod( $fn[0], $fn[1] );
				} elseif ( is_object( $fn ) && ! ( $fn instanceof Closure ) ) {
					$ref = new ReflectionMethod( $fn, '__invoke' );
				} else {
					$ref = new ReflectionFunction( $fn );
				}
				$file = wp_normalize_path( (string) $ref->getFileName() );
			} catch ( Throwable $e ) {
				continue;
			}
			if ( 0 === strpos( $file, $base ) && (int) $prio !== (int) $priority ) {
				$moves[] = array( $cb, $prio );
			}
		}
	}
	foreach ( $moves as $m ) {
		remove_filter( $hook, $m[0]['function'], $m[1] );
		add_filter( $hook, $m[0]['function'], $priority, $m[0]['accepted_args'] );
	}
}

add_action( 'plugins_loaded', 'pg_apply_resolutions', PHP_INT_MAX );
add_action( 'init', 'pg_apply_resolutions', PHP_INT_MAX );
function pg_apply_resolutions() {`);
        for (const r of p.reprioritize) lines.push(`	pg_reprioritize( '${q(r.hook)}', '${r.kind === 'theme' ? 'theme' : r.kind === 'mu' ? 'mu' : 'plugin'}', '${q(r.slug)}', ${r.priority} );`);
        lines.push('}\n');
    }
    for (const s of p.secure) lines.push(`add_filter( '${q(s.hook)}', '${q(s.callback)}', PHP_INT_MAX ); // conflicting plugins disagreed: pin the hardened value\n`);
    for (const id of p.harden) lines.push(HARDEN[id] + '\n');
    return lines.join('\n');
}

function build(findings) {
    const p = collect(findings);
    const files = {};
    if (p.reprioritize.length || p.secure.length || p.harden.size) files['pg-resolutions.php'] = muPlugin(p);
    if (p.htaccess.size) {
        const ids = [...p.htaccess];
        files['htaccess.snippet'] = `# Plugin Guard: add near the top of .htaccess (Apache 2.4). Test, then keep a copy of the old file.\n# BEGIN plugin-guard\n${ids.map(i => `# ${i}\n${HTACCESS[i].apache}`).join('\n\n')}\n# END plugin-guard\n`;
        files['nginx.snippet'] = `# Plugin Guard: add inside the server { } block, then \`nginx -t && nginx -s reload\`.\n${ids.map(i => `# ${i}\n${HTACCESS[i].nginx}`).join('\n\n')}\n`;
    }
    return files;
}

module.exports = { build, collect, HTACCESS };
