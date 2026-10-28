#!/usr/bin/env node
// Offline self-test. Builds a fake WordPress install full of planted problems, a fake `wp` command, a stand-in for
// wordpress.org and fake sites on 127.0.0.1, then checks that every problem is found AND that clean code is not
// flagged. Touches no real site and no real outside service.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-selftest-'));
process.env.PLUGIN_GUARD_HOME = path.join(tmp, 'projects');
process.env.PLUGIN_GUARD_REPORTS = path.join(tmp, 'reports');

const projectLib = require('../lib/project');
const { WpCli } = require('../lib/wpcli');
const decisions = require('../lib/decisions');
const history = require('../lib/history');
const fixfile = require('../lib/fixfile');
const reportPdf = require('../lib/report-pdf');
const { compare, inRange } = require('../lib/version');
const { scan, GuardError } = require('../guard');

let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) failures++; };
const group = t => console.log(`\n== ${t}`);
const has = (r, rule, needle) => r.findings.some(f => f.rule === rule && (!needle || JSON.stringify(f).includes(needle)));
const find = (r, rule, needle) => r.findings.find(f => f.rule === rule && (!needle || JSON.stringify(f).includes(needle)));
const md5 = s => crypto.createHash('md5').update(s).digest('hex');
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const write = (root, rel, body, mode) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); if (mode) fs.chmodSync(f, mode); };
const hdr = (name, extra = '', v = '1.0.0') => `<?php\n/**\n * Plugin Name: ${name}\n * Version: ${v}\n${extra} */\n`;
const throws = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

// ---------------------------------------------------------------- fixture: a compromised-looking WordPress install
const CLEAN_MAIN = hdr('Clean Plugin') + "defined('ABSPATH') || exit;\nif ( ! function_exists('clean_one') ) { function clean_one(){} }\nclass Clean_Main { function run(){ check_ajax_referer('x'); } }\nadd_action('wp_ajax_nopriv_ok', array('Clean_Main','run'));\nadd_filter('authenticate', 'clean_auth', 5);\nregister_rest_route('clean/v1','/r',array('methods'=>'GET','callback'=>'f','permission_callback'=>'is_user_logged_in'));\n// eval(\"commented out\"); $wpdb->query($_GET['x']);\n";
const WF_MAIN = hdr('Wordfence') + "defined('ABSPATH') || exit;\nfunction shared_helper(){}\nadd_filter('authenticate', 'wf_auth', 20, 3);\nadd_filter('xmlrpc_enabled', '__return_true');\ndefine('SHARED_LIMIT', 5);\n";
const NF_MAIN = hdr('NinjaFirewall') + "defined('ABSPATH') || exit;\nfunction shared_helper(){}\nadd_filter('authenticate', 'nf_auth', 20, 3);\nadd_filter('xmlrpc_enabled', '__return_false');\nremove_filter('authenticate', 'wf_auth', 20);\ndefine('SHARED_LIMIT', 9);\n";
const WP_INDEX = '<?php // wp-admin index original';
const WP_FUNCS = '<?php // wp-includes functions original';
const VERSION_PHP = "<?php $wp_version = '6.4.2'; $wp_local_package = 'en_US';";
const today = new Date().toISOString().slice(0, 10);

function buildSite(root) {
    const f = {
        'wp-includes/version.php': VERSION_PHP, 'wp-includes/functions.php': WP_FUNCS, 'wp-admin/index.php': WP_INDEX, 'index.php': '<?php // front controller',
        'readme.html': '<html>WordPress Version 6.4.2</html>',
        'wp-content/plugins/wordfence/wordfence.php': WF_MAIN,
        'wp-content/plugins/ninjafirewall/nfw.php': NF_MAIN,
        'wp-content/plugins/ninjafirewall/backdoor.php': "<?php @system($_GET['c']);",
        'wp-content/plugins/needs-deps/needs-deps.php': hdr('Needs Deps', ' * Requires Plugins: woocommerce, helper-inactive\n * Requires PHP: 99.0\n * Requires at least: 6.9\n') + "defined('ABSPATH') || exit;\n",
        'wp-content/plugins/helper-inactive/helper.php': hdr('Helper Inactive') + "defined('ABSPATH') || exit;\n",
        'wp-content/plugins/woo-addon/woo-addon.php': hdr('Woo Addon') + "defined('ABSPATH') || exit;\nadd_action('init', function(){ $o = wc_get_order(1); });\n",
        'wp-content/plugins/leaky/leaky.php': hdr('Leaky') + "add_action('wp_ajax_nopriv_save_it', 'leaky_save');\nfunction leaky_save(){ global $wpdb; $wpdb->query(\"DELETE FROM x WHERE id=\" . $_GET['id']); }\nregister_rest_route('leaky/v1', '/w', array('methods' => 'POST', 'callback' => 'leaky_save'));\n",
        'wp-content/plugins/leaky/readme.txt': '=== Leaky ===\nStable tag: 1.0.0\n',
        'wp-content/plugins/clean/clean.php': CLEAN_MAIN,
        'wp-content/plugins/old-vuln/old.php': hdr('Old Vuln', '', '1.2.0') + "defined('ABSPATH') || exit;\n",
        'wp-content/plugins/abandoned-plugin/a.php': hdr('Abandoned') + "defined('ABSPATH') || exit;\n",
        'wp-content/plugins/closed-plugin/c.php': hdr('Closed') + "defined('ABSPATH') || exit;\n",
        'wp-content/plugins/cool-plugin-nulled/c.php': hdr('Cool Plugin') + "defined('ABSPATH') || exit;\n",
        'wp-content/plugins/dropper/dropper.php': hdr('Dropper') + "defined('ABSPATH') || exit;\n$x = eval(base64_decode('ZWNobyAxOw=='));\n",
        'wp-content/mu-plugins/loader.php': "<?php\ndefined('ABSPATH') || exit;\nadd_action('init','mu_x');\n",
        'wp-content/db.php': "<?php\n// custom\nadd_action('init','x');\n",
        'wp-content/advanced-cache.php': "<?php\n// WP Rocket advanced-cache\n",
        'wp-content/themes/child/style.css': "/*\n Theme Name: Child\n Template: missing-parent\n Version: 1.0\n*/",
        'wp-content/themes/child/functions.php': "<?php\ndefined('ABSPATH') || exit;\nfunction leaky_save(){}\n",
        'wp-content/themes/oldtheme/style.css': "/*\n Theme Name: Old Theme\n Version: 1.0\n*/",
        'wp-content/themes/oldtheme/functions.php': "<?php\ndefined('ABSPATH') || exit;\n",
        'wp-content/themes/twentytwentyfour/style.css': "/*\n Theme Name: Twenty Twenty-Four\n Version: 1.0\n*/",
        'wp-content/uploads/2024/shell.php': "<?php echo 1;",
        'wp-content/uploads/2024/pic.jpg': "GIF89a<?php echo 'x'; ?>",
        'wp-content/debug.log': '[01-Jan-2026 10:00:00 UTC] PHP Warning: x',
        'backup.sql': 'CREATE TABLE x;', 'phpinfo.php': '<?php phpinfo();', 'wp-config.php.bak': 'define("DB_PASSWORD","x");', '.env': 'KEY=1',
        'wp-config.php': "<?php\ndefine('DB_NAME','x');\ndefine('DB_USER','root');\ndefine('DB_PASSWORD','Zx9-canary-pw');\ndefine('AUTH_KEY','put your unique phrase here');\ndefine('WP_DEBUG', true);\n$table_prefix = 'wp_';\n"
    };
    for (const [rel, body] of Object.entries(f)) write(root, rel, body);
    fs.chmodSync(path.join(root, 'wp-config.php'), 0o644);
    fs.chmodSync(path.join(root, 'wp-content/uploads'), 0o777);
}

// a fake `wp` that answers from a JSON file (and refuses anything it does not know)
function fakeWp(dir) {
    const bin = path.join(dir, 'fake-wp.js');
    fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require('fs');
const data = JSON.parse(fs.readFileSync(process.env.FAKE_WP_DATA, 'utf8'));
const args = process.argv.slice(2);
const positional = args.filter(a => !a.startsWith('--'));
let key = positional.slice(0, 3).join(' ');
if (positional[0] === 'db' && positional[1] === 'query') key = 'db query ' + (/posts/.test(positional[2]) ? 'posts' : 'options');
else if (positional[0] === 'option') key = 'option get ' + positional[2];
else if (positional[0] === 'plugin' || positional[0] === 'theme' || positional[0] === 'user' || positional[0] === 'core' || positional[0] === 'db' || positional[0] === 'super-admin' || positional[0] === 'site') key = positional.slice(0, 2).join(' ') + (args.includes('--network') ? ' --network' : '');
if (!(key in data)) { process.stderr.write('Error: fake wp does not know: ' + key + '\\n'); process.exit(1); }
const v = data[key];
if (v && v.__exit) { process.stderr.write(v.__err || 'Error\\n'); process.exit(v.__exit); }
if (args.includes('--format=json')) process.stdout.write(JSON.stringify(v));
else if (key.startsWith('db query')) process.stdout.write(v.map(r => r.join('\\t')).join('\\n'));
else process.stdout.write(String(v));
`);
    fs.chmodSync(bin, 0o755);
    return bin;
}

// stand-in for wordpress.org / wpscan; anything else goes to the real fetch (the fake sites on 127.0.0.1)
function stubFetch(calls, tables) {
    const reply = (json, status = 200) => new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });
    return async (url, init) => {
        const u = new URL(String(url));
        if (!/^(api|downloads)\.wordpress\.org$|^wpscan\.com$/.test(u.host)) return fetch(url, init);
        calls.push(u.host + u.pathname);
        if (u.pathname.startsWith('/plugins/info') || u.pathname.startsWith('/themes/info')) {
            const slug = u.searchParams.get('request[slug]');
            const hit = tables.info[slug];
            return hit ? reply(hit, hit.error ? 404 : 200) : reply({ error: 'Plugin not found.' }, 404);
        }
        if (u.pathname.startsWith('/core/version-check')) return reply({ offers: [{ version: '99.0' }] });
        if (u.pathname.startsWith('/core/checksums')) return reply({ checksums: tables.core });
        const m = /^\/plugin-checksums\/([^/]+)\//.exec(u.pathname);
        if (m) return tables.sums[m[1]] ? reply(tables.sums[m[1]]) : reply({ error: 'no' }, 404);
        return reply({}, 404);
    };
}

// ---------------------------------------------------------------- fake sites for the live probe
function site(handler) {
    return new Promise(res => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => res({ s, url: `http://127.0.0.1:${s.address().port}/` })); });
}
const leakySite = (req, res) => {
    const u = req.url;
    res.setHeader('server', 'Apache/2.4.41 (Ubuntu)');
    res.setHeader('x-powered-by', 'PHP/7.4.3');
    if (u === '/') { res.setHeader('content-type', 'text/html'); return res.end('<meta name="generator" content="WordPress 6.4.2"><meta name="generator" content="Elementor 3.18.3; features: x"><script src="/wp-content/plugins/old-vuln/a.js?ver=1.2.0"></script><script src="/wp-content/plugins/ghost/b.js?ver=3.0"></script><link href="/wp-content/themes/child/s.css">'); }
    if (u === '/wp-json/') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ namespaces: ['wp/v2', 'wc/v3', 'yoast/v1'] })); }
    if (u === '/wp-content/debug.log') return res.end('[01-Jan-2026 10:00:00 UTC] PHP Warning:  boom');
    if (u === '/backup.sql') return res.end('CREATE TABLE wp_users (id int);');
    if (u.startsWith('/wp-json/wp/v2/users')) { res.setHeader('content-type', 'application/json'); return res.end('[{"id":1,"name":"admin"}]'); }
    if (u.startsWith('/?author=')) { res.statusCode = 301; res.setHeader('location', '/author/admin/'); return res.end(); }
    if (u === '/wp-sitemap-users-1.xml') return res.end('<urlset><url><loc>http://x/author/admin/</loc></url></urlset>');
    if (u === '/xmlrpc.php') return res.end('XML-RPC server accepts POST requests only.');
    if (u === '/readme.html') return res.end('<h1>WordPress</h1> Version 6.4.2');
    if (u === '/wp-content/plugins/old-vuln/readme.txt') return res.end('=== Old ===\nStable tag: 1.2.0\n');
    res.statusCode = 404; res.end('nope');
};

async function main() {
    // ============================================================ foundation
    group('Project settings, schedule, safety rails');
    ok(compare('1.10.0', '1.9.9') > 0 && compare('2.0-beta1', '2.0') < 0 && inRange('1.2.0', '>=1.0 <1.5') && !inRange('1.5.0', '<1.5'), 'version compare / ranges');
    ok((await throws(() => projectLib.create('bad name', { url: 'https://x.test' }))) !== null, 'invalid project name rejected');
    ok((await throws(() => projectLib.create('nothing', {}))) !== null, 'project needs a url or a path');
    projectLib.create('sched', { url: 'https://x.test/', schedule: 'weekly' });
    const sp = projectLib.load('sched');
    ok(projectLib.isDue(sp, null) && projectLib.isDue(sp, new Date(Date.now() - 8 * 864e5).toISOString()) && !projectLib.isDue(sp, new Date(Date.now() - 3 * 864e5).toISOString()), 'weekly schedule: due after 7 days, not before');
    projectLib.setSchedule('sched', 'none');
    ok(!projectLib.isDue(projectLib.load('sched'), null), 'schedule "none" is never due (nothing runs unless approved)');
    ok(projectLib.load('sched').outsideLookups.wordpressOrg === false, 'outside lookups are OFF by default');
    fs.writeFileSync(projectLib.fileOf('sched'), JSON.stringify({ url: 'https://x.test/', schedule: 'hourly' }));
    ok(/schedule must be one of/.test((await throws(() => projectLib.load('sched'))).message), 'invalid settings give a clear error');

    const wpc = new WpCli({ path: '/nowhere', runner: () => ({ status: 0, stdout: '' }) });
    ok(['plugin delete x', 'db query DROP TABLE x', 'db query SELECT 1; DELETE FROM x', 'option get DB_PASSWORD', 'eval echo 1'].every(c => { try { wpc.run(c.split(' ').length > 3 && c.startsWith('db query') ? ['db', 'query', c.slice(9)] : c.split(' ')); return false; } catch { return true; } }), 'WP-CLI wrapper refuses anything that could change the site');
    ok(wpc.run(['db', 'query', "SELECT ID FROM wp_posts WHERE post_content REGEXP 'eval[(]'"]).ok === true && wpc.run(['core', 'version']).ok, 'WP-CLI wrapper allows the read-only commands');

    group('Decisions file and history');
    const dp = decisions.parse('## PG-aaaa1111bb | P1 | T\ndecision: ignore\nreason:\n\n## PG-cccc2222dd | P2 | U\ndecision: fix\n\n## PG-dddd3333ee | P2 | V\ndecision: maybe\n');
    ok(dp.problems.length === 2 && /no reason/.test(dp.problems[0]) && /maybe/.test(dp.problems[1]), 'decisions: ignore without reason and unknown values are reported');
    const h = history.diff({ at: 'x', findings: [{ id: 'a' }, { id: 'b' }], components: [{ ref: 'p', version: '1.0' }] }, [{ id: 'b', plugins: [] }, { id: 'c', plugins: ['p'] }], [{ ref: 'p', version: '1.1' }]);
    ok(h.fixed.length === 1 && h.isNew.has('c') && /1\.0 → 1\.1/.test(h.cause.get('c')), 'history: fixed / new / "appeared after update"');

    // ============================================================ local scan with everything switched on
    group('Local scan: plugins, themes, conflicts, dependencies');
    const root = path.join(tmp, 'site');
    buildSite(root);
    const wpData = path.join(tmp, 'wp.json');
    const baseData = {
        'plugin list': ['wordfence', 'ninjafirewall', 'needs-deps', 'woo-addon', 'leaky', 'clean', 'old-vuln', 'abandoned-plugin', 'closed-plugin', 'cool-plugin-nulled', 'dropper'].map(n => ({ name: n, status: 'active', version: n === 'old-vuln' ? '1.2.0' : '1.0.0', update: n === 'old-vuln' ? 'available' : 'none', auto_update: 'off' }))
            .concat([{ name: 'helper-inactive', status: 'inactive', version: '1.0.0', update: 'none', auto_update: 'off' }]),
        'theme list': [{ name: 'child', status: 'active' }, { name: 'oldtheme', status: 'inactive' }, { name: 'twentytwentyfour', status: 'inactive' }],
        'user list': [{ ID: 1, user_login: 'admin', user_email: 'a@corp.test', user_registered: '2020-01-01 00:00:00' }, { ID: 2, user_login: 'bob', user_email: 'bob@evil.test', user_registered: '2021-01-01 00:00:00' }, { ID: 7, user_login: 'newguy', user_email: 'n@corp.test', user_registered: `${today} 00:00:00` }, { ID: 8, user_login: 'c', user_email: 'c@corp.test', user_registered: '2021-01-01 00:00:00' }],
        'option get users_can_register': '1', 'option get default_role': 'editor', 'option get siteurl': 'https://corp.test',
        'cron event list': [{ hook: 'evil_cron' }, { hook: 'clean_daily_job' }, { hook: 'woocommerce_cleanup_sessions' }, { hook: 'wp_version_check' }],
        'db prefix': 'wp_', 'db query posts': [['12', 'post']], 'db query options': [['sneaky_option']],
        'core is-installed': { __exit: 1, __err: 'Error: not multisite' }
    };
    fs.writeFileSync(wpData, JSON.stringify(baseData));
    process.env.FAKE_WP_DATA = wpData;
    const wpBin = fakeWp(tmp);

    const calls = [];
    const sums = {
        wordfence: { files: { 'wordfence.php': { sha256: sha('different official content') } } },
        ninjafirewall: { files: { 'nfw.php': { sha256: sha(NF_MAIN) } } },
        clean: { files: { 'clean.php': { sha256: sha(CLEAN_MAIN) } } }
    };
    const tables = {
        core: { 'wp-includes/version.php': md5(VERSION_PHP), 'wp-includes/functions.php': md5(WP_FUNCS), 'wp-admin/index.php': md5('<?php // wp-admin index ORIGINAL'), 'index.php': md5('<?php // front controller') },
        sums,
        info: {
            wordfence: { slug: 'wordfence', version: '1.0.0', last_updated: `${today} 1:00pm GMT` }, ninjafirewall: { slug: 'ninjafirewall', version: '1.0.0', last_updated: `${today} 1:00pm GMT` },
            clean: { slug: 'clean', version: '1.0.0', last_updated: `${today} 1:00pm GMT` },
            'old-vuln': { slug: 'old-vuln', version: '2.0.0', last_updated: `${today} 1:00pm GMT` },
            'abandoned-plugin': { slug: 'abandoned-plugin', version: '1.0.0', last_updated: '2019-03-04 1:00pm GMT' },
            'closed-plugin': { error: 'closed', description: 'Closed for a security issue.', reason: 'security-issue' }
        }
    };
    projectLib.create('shop', { path: root, url: null });
    const shop = projectLib.load('shop');
    Object.assign(shop, { outsideLookups: { wordpressOrg: true, vulnerabilityDb: false }, advisories: [path.join(tmp, 'adv.json')], precedence: ['ninjafirewall', 'wordfence'], prefer: { firewall: 'wordfence' }, expectedAdminDomains: ['corp.test'], phpVersion: '7.4.33' });
    fs.writeFileSync(path.join(tmp, 'adv.json'), JSON.stringify([{ id: 'TEST-1', slug: 'old-vuln', affected: '<1.5.0', fixedIn: '1.5.0', severity: 'high', title: 'Test vulnerability' }]));
    projectLib.save(shop);

    const r = await scan('shop', { wpBin, fetchImpl: stubFetch(calls, tables) });
    ok(r.mode === 'local' && r.activeKnown, 'local mode, active list read through WP-CLI');
    ok(has(r, 'dep-missing', 'woocommerce') && has(r, 'dep-inactive', 'helper-inactive'), 'dependencies: missing and inactive required plugins');
    ok(has(r, 'dep-php-version') && has(r, 'dep-wp-version') && has(r, 'dep-implied', 'woo-addon'), 'dependencies: PHP / WordPress version and implied WooCommerce');
    ok(has(r, 'theme-parent-missing', 'missing-parent'), 'themes: child theme without its parent');
    ok(has(r, 'redeclare-function', 'leaky_save') && JSON.stringify(find(r, 'redeclare-function', 'leaky_save').plugins).includes('theme:child'), 'conflict between a theme and a plugin (same function)');
    ok(has(r, 'redeclare-function', 'shared_helper') && has(r, 'hook-priority', 'priority 20') && has(r, 'hook-contradiction', 'xmlrpc_enabled') && has(r, 'hook-removed', 'wf_auth') && has(r, 'shared-constant', 'SHARED_LIMIT') && has(r, 'duplicate-feature', 'firewall'), 'conflicts: redeclare, priority, contradiction, removed hook, constant, duplicate job');
    ok(find(r, 'duplicate-feature').commands.join() === 'wp plugin deactivate ninjafirewall', 'prefer setting decides which plugin to keep');
    const hp = find(r, 'hook-priority');
    ok(hp.patch.items[0].slug === 'ninjafirewall' && hp.patch.items[0].priority === 20 && hp.patch.items[1].priority === 21, 'priority resolution follows the precedence setting');
    ok(has(r, 'inactive-theme', 'oldtheme') && !has(r, 'inactive-theme', 'twentytwentyfour'), 'unused theme flagged, default fallback theme kept');
    ok(has(r, 'inactive-plugin', 'helper-inactive'), 'inactive plugin flagged');
    ok(has(r, 'ajax-nopriv-unprotected', 'save_it') && has(r, 'code-sql-user-input') && has(r, 'rest-no-permission', 'leaky/v1') && has(r, 'code-no-abspath', 'leaky'), 'exposure: public AJAX, SQL input, public REST write, missing ABSPATH guard');
    ok(has(r, 'known-vuln', 'TEST-1'), 'known vulnerability matched from the offline advisory file');
    ok(!r.findings.some(f => f.plugins.length === 1 && f.plugins[0] === 'clean'), 'clean plugin has NO findings (comments, nonce, guards, official checksums all respected)');
    ok(find(r, 'hook-priority').evidence.every(e => /^wp-content\/plugins\//.test(e)), 'findings point to real paths inside the WordPress folder');

    group('Local scan: drop-ins, mu-plugins, server settings');
    ok(has(r, 'dropin-unrecognised', 'db.php') && has(r, 'dropin-orphan', 'advanced-cache.php') && has(r, 'mu-no-header', 'loader'), 'drop-ins and must-use plugins');
    ok(has(r, 'cfg-debug') && has(r, 'cfg-file-edit') && has(r, 'cfg-salts') && has(r, 'cfg-db-root') && has(r, 'default-db-prefix'), 'wp-config.php: debug, file editor, salts, root DB user, default prefix');
    ok(has(r, 'perm-config-readable') && has(r, 'perm-world-writable', 'uploads'), 'file permissions: world-readable config, world-writable folder');
    ok(has(r, 'stray-backup', 'backup.sql') && has(r, 'stray-debug', 'phpinfo.php') && has(r, 'stray-config-copy', 'wp-config.php.bak') && !r.findings.some(f => f.rule === 'stray-config-copy' && f.evidence.includes('wp-config.php')) && has(r, 'stray-env') && has(r, 'stray-core-readme') && has(r, 'stray-debuglog'), 'stray files: dump, phpinfo, config copy, .env, readme.html, debug.log');
    ok(has(r, 'php-eol', '7.4.33'), 'PHP end-of-life detected (project setting for the server version)');
    ok(!JSON.stringify(r).includes('Zx9-canary-pw'), 'the database password never appears in the results');

    group('Local scan: file integrity');
    ok(has(r, 'integrity-php-in-uploads', 'shell.php') && has(r, 'integrity-php-in-image', 'pic.jpg'), 'PHP in uploads and hidden behind an image extension');
    ok(has(r, 'integrity-obfuscated-exec', 'dropper') && has(r, 'code-exec-user-input', 'backdoor.php'), 'backdoor patterns found');
    ok(has(r, 'integrity-core-modified', 'wp-admin/index.php') && has(r, 'integrity-core-added', 'evil') === false, 'core: modified file found against the official list');
    ok(has(r, 'integrity-plugin-modified', 'wordfence') && has(r, 'integrity-plugin-added', 'backdoor.php') && has(r, 'integrity-unverifiable'), 'plugins: modified, extra file, unverifiable premium/custom');
    ok(has(r, 'integrity-nulled', 'cool-plugin-nulled'), 'pirated ("nulled") plugin marker');
    const lineHits = {};
    for (const f of r.findings) for (const e of f.evidence.filter(x => /:\d+$/.test(x) && /^(code|integrity)-/.test(f.rule))) lineHits[e] = (lineHits[e] || 0) + 1;
    ok(Object.values(lineHits).every(n => n === 1), 'the same code line is never reported twice by different checks');
    ok(!JSON.stringify(r.findings.filter(f => /^integrity-/.test(f.rule))).includes('ZWNobyAxOw'), 'findings contain locations only, never malware content');

    group('Local scan: database and users (WP-CLI)');
    ok(has(r, 'user-default-admin', 'admin') && has(r, 'user-admin-domain', 'bob') && find(r, 'user-new-admin', 'newguy').severity === 'P2', 'users: default name, unexpected e-mail domain, recent admin (first scan = P2)');
    ok(has(r, 'opt-open-registration', 'editor') && find(r, 'opt-open-registration').severity === 'P1', 'open registration with a content-editing default role');
    const cr = find(r, 'cron-unknown');
    ok(cr && cr.evidence.includes('evil_cron') && cr.evidence.includes('woocommerce_cleanup_sessions') && !cr.evidence.includes('clean_daily_job') && !cr.evidence.includes('wp_version_check'), 'cron: unknown job and the job of a removed plugin flagged; jobs of installed plugins and core are not');
    ok(has(r, 'db-injected-posts', 'post ID 12') && has(r, 'db-injected-options', 'sneaky_option'), 'injected code in posts and options');

    group('Local scan: lifecycle and outside-lookup policy');
    ok(has(r, 'core-outdated', '99.0') && has(r, 'plugin-abandoned', 'abandoned-plugin') && find(r, 'plugin-closed', 'closed-plugin').severity === 'P0' && has(r, 'plugin-outdated', 'old-vuln') && has(r, 'plugin-unlisted'), 'wordpress.org: outdated core, abandoned, closed-for-security, outdated, unlisted');
    ok(has(r, 'update-waiting', 'old-vuln'), 'update waiting (WP-CLI inventory)');
    ok(calls.length > 0 && calls.every(c => /wordpress\.org/.test(c)) && r.outside.total === calls.length, `outside requests are counted (${calls.length}) and only go to wordpress.org`);
    const calls2 = [];
    projectLib.create('closed', { path: root });
    const r2 = await scan('closed', { wpBin, fetchImpl: stubFetch(calls2, tables), save: false });
    ok(calls2.length === 0 && r2.checks.find(c => c.id === 'integrity-core').status === 'skipped' && /not allowed for this project/.test(r2.checks.find(c => c.id === 'integrity-core').reason), 'project without permission: ZERO outside requests, checks report why they were skipped');
    ok(!has(r2, 'integrity-core-modified') && has(r2, 'integrity-php-in-uploads'), 'local-only checks still run without outside lookups');

    group('No WP-CLI / no database');
    const r3 = await scan('closed', { wpBin: path.join(tmp, 'does-not-exist'), fetchImpl: stubFetch([], tables), save: false });
    ok(r3.checks.find(c => c.id === 'db-users').status === 'skipped' && r3.notes.some(n => /WP-CLI is not installed/.test(n)), 'missing WP-CLI: database checks skipped with a clear note, rest of the scan runs');
    ok(r3.activeKnown === false && has(r3, 'dep-missing'), 'active list unknown: everything assumed active, and the report says so');

    // ============================================================ decisions, fix file, history, retest
    group('Decisions → fix file → rescan → retest');
    const dfile = decisions.file('shop');
    ok(fs.existsSync(dfile) && /decision: pending/.test(fs.readFileSync(dfile, 'utf8')), 'decisions.txt created with every finding as pending');
    ok((await throws(() => fixfile.build(r))).message.includes('No finding is marked'), 'fix file refuses to build when nothing is marked fix');
    const fixTargets = [find(r, 'hook-priority'), find(r, 'ajax-nopriv-unprotected'), find(r, 'live-x')].filter(Boolean);
    const accept = find(r, 'php-eol');
    const ignore = find(r, 'default-db-prefix');
    let text = fs.readFileSync(dfile, 'utf8');
    const setDecision = (t, f, d, reason = '') => t.replace(new RegExp(`(## PG-${f.id} [^\\n]*\\ndecision: )pending(\\nreason: )`), `$1${d}$2${reason}`);
    for (const f of fixTargets) text = setDecision(text, f, 'fix');
    text = setDecision(text, accept, 'accept', 'the host upgrades PHP in March');
    text = setDecision(text, ignore, 'ignore', 'handled by the host firewall');
    fs.writeFileSync(dfile, text);
    const bad = setDecision(text, find(r, 'cfg-file-edit'), 'ignore', '');
    fs.writeFileSync(dfile, bad);
    ok(decisions.apply('shop', r.findings).length === 1, 'an "ignore" without a reason is rejected');
    fs.writeFileSync(dfile, text);
    ok(decisions.apply('shop', r.findings).length === 0, 'valid decisions accepted');
    {
        const rule = (r.findings.find(f => f.decision === 'pending') || r.findings[0]).rule;
        const same = r.findings.filter(f => f.rule === rule);
        let noReason = false;
        try { decisions.bulk('shop', r.findings, { rules: [rule], as: 'ignore', reason: '' }); } catch (e) { noReason = /needs --reason/.test(e.message); }
        let badRule = false;
        try { decisions.bulk('shop', r.findings, { rules: ['no-such-rule'], as: 'ignore', reason: 'x' }); } catch (e) { badRule = /No finding has rule/.test(e.message); }
        const before = decisions.load('shop').map;
        const res = decisions.bulk('shop', r.findings, { rules: [rule], as: 'ignore', reason: 'bulk test' });
        const after = decisions.load('shop').map;
        const untouched = [...before.values()].filter(d => d.decision !== 'pending' && same.some(f => f.id === d.id));
        ok(noReason && badRule, 'bulk: refuses ignore without a reason and unknown rule names');
        ok(res.changed === same.filter(f => (before.get(f.id) || { decision: 'pending' }).decision === 'pending').length && same.every(f => after.get(f.id).decision !== 'pending')
            && untouched.every(d => after.get(d.id).decision === d.decision), 'bulk: decides every pending finding of the rule, leaves earlier decisions alone');
    }
    const md = fixfile.build(r);
    ok(md.includes(`PG-${hp.id}`) && md.includes('pg_reprioritize') && md.includes("'plugin', 'ninjafirewall', 20"), 'fix file: approved items with the generated priority code');
    ok(!md.includes(`PG-${find(r, 'cfg-salts').id}`) && !md.includes('## Items\n\n### ☐ PG-' + accept.id), 'fix file: undecided and accepted items are NOT included');
    ok(/Do not change/.test(md) && md.includes('the host upgrades PHP in March') && md.includes('Never write secrets') && md.includes('retest shop'), 'fix file: accepted items listed as "do not change", safety rules and retest instruction present');
    ok(!/htaccess/i.test(md.split('## Shared code')[1] || ''), 'fix file: shared code only for approved items');

    // time passes: the owner fixes one thing, a plugin is updated and a new admin appears
    fs.rmSync(path.join(root, 'wp-content/plugins/leaky'), { recursive: true });
    write(root, 'wp-content/plugins/clean/clean.php', CLEAN_MAIN.replace('1.0.0', '1.1.0') + "function clean_two(){ eval($_POST['x']); }\n");
    const data2 = JSON.parse(fs.readFileSync(wpData, 'utf8'));
    data2['plugin list'] = data2['plugin list'].filter(p => p.name !== 'leaky').map(p => (p.name === 'clean' ? { ...p, version: '1.1.0' } : p));
    data2['user list'].push({ ID: 9, user_login: 'intruder', user_email: 'i@corp.test', user_registered: new Date(Date.now() + 60000).toISOString().slice(0, 19).replace('T', ' ') });
    fs.writeFileSync(wpData, JSON.stringify(data2));
    const rr = await scan('shop', { wpBin, fetchImpl: stubFetch([], tables), type: 'retest' });
    ok(rr.diff.fixed.some(f => /save_it|leaky/i.test(f.title)) && !has(rr, 'ajax-nopriv-unprotected'), 'retest: the removed plugin\'s findings are reported as Fixed');
    ok(rr.findings.find(f => f.id === hp.id).status === 'open', 'retest: an untouched problem is "still open"');
    const intr = find(rr, 'user-new-admin', 'intruder');
    ok(intr && intr.status === 'new' && intr.severity === 'P0', 'a new administrator since the last scan is Critical');
    const evalNew = rr.findings.find(f => f.rule === 'code-eval' && /clean/.test(f.title)) || rr.findings.find(f => f.plugins.includes('clean') && f.status === 'new');
    ok(evalNew && /clean was updated 1\.0\.0 → 1\.1\.0/.test(evalNew.cause), 'a problem that arrived with a plugin update says so');
    ok(rr.findings.find(f => f.id === accept.id).decision === 'accept' && rr.findings.find(f => f.id === accept.id).decisionReason.includes('March'), 'earlier decisions are remembered on the next run');

    // ============================================================ reports
    group('Report and PDF');
    const evil = { ...rr, findings: [{ ...rr.findings[0], title: '<script>alert(1)</script> & "quotes"', detail: '<img src=x onerror=alert(1)>' }, ...rr.findings.slice(1)] };
    const doc = reportPdf.html(evil);
    const docSkipped = reportPdf.html(r2);
    ok(!doc.includes('<script>alert(1)</script>') && !doc.includes('<img src=x') && doc.includes('&lt;script&gt;'), 'site-derived text is HTML-escaped in the report');
    ok(/What was checked/.test(doc) && /Not run/.test(docSkipped) && /not allowed for this project/.test(docSkipped) && /Limits and what left this computer/.test(doc), 'report lists what ran, what did not, and what left the computer');
    const outDir = path.join(tmp, 'out');
    const built = await reportPdf.build(rr, outDir, { retest: true, pdf: true });
    ok(fs.existsSync(built.html) && /Retest result/.test(fs.readFileSync(built.html, 'utf8')), 'retest report built');
    if (built.pdf) ok(fs.readFileSync(built.pdf).subarray(0, 4).toString() === '%PDF' && fs.statSync(built.pdf).size > 5000, `PDF rendered (${Math.round(fs.statSync(built.pdf).size / 1024)} KB)`);
    else console.log(`SKIP  PDF not rendered here: ${built.pdfError}`);

    // ============================================================ URL-only mode
    group('URL-only mode');
    const leaky = await site(leakySite);
    projectLib.create('urlonly', { url: leaky.url });
    const u = projectLib.load('urlonly');
    u.outsideLookups.wordpressOrg = true;
    projectLib.save(u);
    const ur = await scan('urlonly', { delayMs: 0, outsideDelayMs: 0, fetchImpl: stubFetch([], tables), certProbe: async () => ({ validTo: new Date(Date.now() + 10 * 864e5).toUTCString(), authorized: true }) });
    leaky.s.close();
    ok(ur.mode === 'url' && ur.checks.filter(c => c.status === 'skipped' && /needs a local copy/.test(c.reason)).length >= 10, 'URL mode: code / file / database checks listed as "not run: needs a local copy"');
    ok(has(ur, 'live-sensitive-file', 'debug.log') && find(ur, 'live-sensitive-file', 'debug.log').severity === 'P0' && has(ur, 'live-sensitive-file', 'backup.sql'), 'live: exposed debug.log and database dump');
    ok(has(ur, 'live-user-enum-rest') && has(ur, 'live-user-enum-author') && has(ur, 'live-user-enum-sitemap') && has(ur, 'live-xmlrpc') && has(ur, 'live-generator') && has(ur, 'live-core-readme'), 'live: user enumeration three ways, xmlrpc, version leaks');
    ok(has(ur, 'live-security-headers') && has(ur, 'live-version-disclosure'), 'live: missing security headers, server version disclosure');
    ok(ur.live.detected.some(d => d.slug === 'woocommerce') && ur.live.detected.some(d => d.slug === 'elementor' && d.version === '3.18.3'), 'plugins found through REST namespaces and generator tags');
    ok(ur.phpVersion.version === '7.4.3' && has(ur, 'php-eol', '7.4.3'), 'PHP version taken from the X-Powered-By header, and its end-of-life flagged');
    ok(has(ur, 'known-vuln') === false && ur.checks.find(c => c.id === 'vulns').status === 'skipped', 'no vulnerability data: said so instead of implying "clean"');
    ok(has(ur, 'plugin-unlisted') || has(ur, 'plugin-outdated'), 'wordpress.org lifecycle still runs on the plugins seen from outside');
    ok(ur.live.requests < 60, `live probe stays small (${ur.live.requests} requests)`);

    group('URL-only mode: blocked, unreachable, not WordPress');
    const blocked = await site((q, s) => { s.statusCode = 403; s.end('<title>Just a moment...</title> cf-chl'); });
    projectLib.create('blocked', { url: blocked.url });
    const e1 = await throws(() => scan('blocked', { delayMs: 0, save: false }));
    blocked.s.close();
    ok(e1 instanceof GuardError && e1.code === 'BLOCKED' && e1.exitCode === 3 && /set the project up locally/i.test(e1.message) && /did not try to get around/.test(e1.message), 'blocked by a firewall: error asks for a local setup, no bypass attempt');
    let hits = 0;
    const limited = await site((q, s) => { hits++; s.statusCode = 429; s.end('slow'); });
    projectLib.create('limited', { url: limited.url });
    const e2 = await throws(() => scan('limited', { delayMs: 0, save: false }));
    limited.s.close();
    ok(e2 instanceof GuardError && e2.code === 'BLOCKED' && hits === 1, `rate limited (429): stops after ${hits} request`);
    projectLib.create('down', { url: 'http://127.0.0.1:1/' });
    const e3 = await throws(() => scan('down', { delayMs: 0, save: false }));
    ok(e3 instanceof GuardError && e3.code === 'UNREACHABLE', 'unreachable site: clear error');
    const plain = await site((q, s) => { s.setHeader('content-type', 'text/html'); s.end('<html><body>hello</body></html>'); });
    projectLib.create('plain', { url: plain.url });
    const e4 = await throws(() => scan('plain', { delayMs: 0, save: false }));
    plain.s.close();
    ok(e4 instanceof GuardError && e4.code === 'NOT_WORDPRESS', 'a site that is not WordPress: clear error');

    group('Local + live together');
    const both = await site(leakySite);
    const bp = projectLib.load('closed');
    bp.url = both.url;
    projectLib.save(bp);
    const br = await scan('closed', { wpBin, delayMs: 0, fetchImpl: stubFetch([], tables), certProbe: async () => ({}), save: false });
    both.s.close();
    ok(br.mode === 'local + live' && has(br, 'live-unknown-plugin', 'ghost') && has(br, 'live-sensitive-file', 'debug.log'), 'local + live: live-only plugin flagged, live exposures found');
    ok(br.live.requests < 60, 'live probe ran once, not twice');

    if (process.env.PG_KEEP) console.log(`\nKept: ${tmp}`); else fs.rmSync(tmp, { recursive: true, force: true });
    console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
    process.exit(failures ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
