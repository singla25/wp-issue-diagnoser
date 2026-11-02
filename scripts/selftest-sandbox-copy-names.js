#!/usr/bin/env node
// The copy step judges FILES by name (logs, dumps, backups, keys, wp-config, .env, symlinks are skipped) and never skips PHP or a folder because its name is an
// ordinary word such as "debug" or "cache". Real case: freemius/includes/debug/debug-bar-start.php was dropped with its folder and the sandbox died with
// "Failed to open stream". Offline; the original tree is hashed before and after.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const copy = require('../issue/sandbox-copy');
const phase = require('../issue/sandbox-phase');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const group = t => console.log(`\n== ${t}`);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-copynames-'));
const orig = path.join(tmp, 'site');
const w = (rel, body = '<?php\n') => { const f = path.join(orig, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); };
const hash = root => { const h = crypto.createHash('sha256'); (function walk(d) { for (const n of fs.readdirSync(d).sort()) { const f = path.join(d, n), st = fs.lstatSync(f); h.update(`${path.relative(root, f)}|${st.mode}|${st.size}\n`); if (st.isDirectory()) walk(f); else if (st.isFile()) h.update(fs.readFileSync(f)); } })(root); return h.digest('hex'); };

const P = 'wp-content/plugins/add-search/includes/freemius/includes/debug';
const KEEP = [
    `${P}/debug-bar-start.php`, `${P}/class-fs-debug-bar-panel.php`, `${P}/index.php`,
    'wp-content/plugins/add-search/includes/freemius/templates/debug/index.php',
    'wp-content/themes/unicamp/framework/class-debug.php',
    'wp-content/plugins/woo/src/Internal/Traits/ScriptDebug.php', 'wp-content/plugins/megamenu/classes/Debug.php', 'wp-content/plugins/woo/vendor/acme/lib/src/Debug.php',
    'wp-content/plugins/elementor/core/debug/inspector.php', 'wp-content/plugins/twiggy/vendor/twig/src/Cache/FilesystemCache.php', 'wp-content/plugins/elementor/core/upgrade/manager.php',
    'wp-content/plugins/aio/lib/view/backups/backups-list.php', 'wp-content/plugins/updraftplus/updraftplus.php', 'wp-content/plugins/backwpup/backwpup.php',
    'wp-content/plugins/debugger/debug.css', 'wp-content/plugins/debugger/debug.tpl.html', 'wp-content/plugins/debugger/debug.js'
];
const SKIP = [
    'wp-content/plugins/p/debug.log', 'wp-content/plugins/p/error_log', 'wp-content/plugins/p/sub/error_log', 'wp-content/plugins/p/php_errorlog', 'wp-content/plugins/p/dump.sql', 'wp-content/plugins/p/db.sql.gz',
    'wp-content/plugins/p/old.bak', 'wp-content/plugins/p/site.zip', 'wp-content/plugins/p/wp-config.php', 'wp-content/plugins/p/wp-config-sample.php', 'wp-content/plugins/p/.env', 'wp-content/plugins/p/.env.local',
    'wp-content/plugins/p/id_rsa', 'wp-content/plugins/p/server.key', 'wp-content/plugins/p/private.pem', 'wp-content/plugins/p/.git/config', 'wp-content/plugins/p/node_modules/x/i.js',
    'wp-content/plugins/p/debug/debug.log', 'wp-content/plugins/p/backup/site.wpress', 'wp-content/plugins/p/cache/page.log'
];
for (const f of [...KEEP, ...SKIP]) w(f);
w('wp-content/plugins/p/certs/cacert.pem', '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n');
w('wp-content/plugins/p/certs/ca-bundle.crt', ['-----BEGIN RSA', 'PRIVATE KEY-----\nMIIB\n-----END RSA', 'PRIVATE KEY-----\n'].join(' '));
fs.symlinkSync('/etc/passwd', path.join(orig, 'wp-content/plugins/p/passwd-link'));
fs.symlinkSync(path.join(orig, 'wp-content/plugins/add-search'), path.join(orig, 'wp-content/plugins/dir-link'));
w('wp-content/themes/unicamp/style.css', '/* Theme Name: Unicamp */');
const before = hash(orig);

const scanned = copy.scan(orig);
const copied = new Set(scanned.entries.filter(e => !e.dir).map(e => e.rel)), dirs = new Set(scanned.entries.filter(e => e.dir).map(e => e.rel));
const skipped = new Map(scanned.skipped.map(s => [s.path, s.reason]));

group('files and folders that must be copied');
ok(copied.has(`${P}/debug-bar-start.php`) && copied.has(`${P}/class-fs-debug-bar-panel.php`) && copied.has(`${P}/index.php`), 'debug-bar-start.php, class-fs-debug-bar-panel.php and index.php in a plugin\'s "debug" folder are copied');
ok(dirs.has(P) && dirs.has('wp-content/plugins/add-search/includes/freemius/templates/debug'), 'a directory named "debug" is copied (with its files)');
ok(copied.has('wp-content/themes/unicamp/framework/class-debug.php'), 'class-debug.php in a theme is copied');
ok(copied.has('wp-content/plugins/woo/src/Internal/Traits/ScriptDebug.php') && copied.has('wp-content/plugins/megamenu/classes/Debug.php') && copied.has('wp-content/plugins/woo/vendor/acme/lib/src/Debug.php'), 'ScriptDebug.php, Debug.php (also under a vendor folder) are copied');
ok(copied.has('wp-content/plugins/elementor/core/debug/inspector.php') && copied.has('wp-content/plugins/twiggy/vendor/twig/src/Cache/FilesystemCache.php') && copied.has('wp-content/plugins/elementor/core/upgrade/manager.php') && copied.has('wp-content/plugins/aio/lib/view/backups/backups-list.php'), 'code in folders named debug, Cache, upgrade and backups is copied');
ok(copied.has('wp-content/plugins/updraftplus/updraftplus.php') && copied.has('wp-content/plugins/backwpup/backwpup.php'), 'plugins whose folder is called updraftplus or backwpup are not dropped');
ok(['debug.css', 'debug.tpl.html', 'debug.js'].every(n => copied.has(`wp-content/plugins/debugger/${n}`)), 'CSS, template and JS files with "debug" in the name are copied');
ok(copied.has('wp-content/plugins/p/certs/cacert.pem') && !copied.has('wp-content/plugins/p/certs/ca-bundle.crt') && /key or certificate/.test(skipped.get('wp-content/plugins/p/certs/ca-bundle.crt') || ''), 'a public CA bundle (cacert.pem) is copied; the same name holding a PRIVATE KEY is not');

group('what is still skipped');
for (const f of SKIP.filter(f => !/\/(debug|backup|cache)\/[^/]+$/.test(f) || /\.(log|wpress)$/.test(f))) {
    const leaf = f.startsWith('wp-content/plugins/p/.git/') || f.includes('node_modules') ? null : f;
    if (leaf) ok(!copied.has(f), `not copied: ${f.replace('wp-content/plugins/', '')}${skipped.has(f) ? ` (${skipped.get(f)})` : ''}`);
}
ok(!copied.has('wp-content/plugins/p/.git/config') && !copied.has('wp-content/plugins/p/node_modules/x/i.js') && skipped.get('wp-content/plugins/p/.git') === 'tool folder', '.git and node_modules stay skipped');
ok(scanned.symlinks === 2 && !copied.has('wp-content/plugins/p/passwd-link') && !dirs.has('wp-content/plugins/dir-link') && [...copied].every(r => !r.startsWith('wp-content/plugins/dir-link/')), 'symbolic links (file and folder) are skipped and never followed');
ok(skipped.get('wp-content/plugins/p/debug/debug.log') === 'log file' && dirs.has('wp-content/plugins/p/debug'), 'inside a "debug" folder only the log file is skipped');

group('a real copy: secrets absent, original untouched');
const dest = path.join(tmp, 'sandbox', 'site');
copy.copySite(orig, dest, { sandboxDir: path.join(tmp, 'sandbox') });
ok(fs.existsSync(path.join(dest, P, 'debug-bar-start.php')) && !fs.existsSync(path.join(dest, 'wp-content/plugins/p/.env')) && !fs.existsSync(path.join(dest, 'wp-content/plugins/p/error_log')), 'the copy has the debug-bar file and neither .env nor error_log');
ok(hash(orig) === before, 'the original tree hashes the same before and after');

group('activation failure on a file that the copy dropped');
const copyRoot = path.join(tmp, 'copyroot'); fs.mkdirSync(path.join(copyRoot, 'wp-content/plugins/x'), { recursive: true });
w('wp-content/plugins/x/lost.php'); w('wp-content/plugins/x/kept.php'); fs.writeFileSync(path.join(copyRoot, 'wp-content/plugins/x/kept.php'), '<?php');
const msg = f => `PHP Warning: require_once(/var/www/html/wp-content/plugins/x/${f}): Failed to open stream: No such file or directory in /var/www/html/wp-content/plugins/x/main.php on line 4`;
ok(phase.missingFromCopy(msg('lost.php'), orig, copyRoot) === 'wp-content/plugins/x/lost.php', 'a missing file that exists in the original is named');
ok(phase.missingFromCopy(msg('kept.php'), orig, copyRoot) === null && phase.missingFromCopy(msg('never.php'), orig, copyRoot) === null, 'a file that is in the copy, or in neither, is not blamed on the copy');
ok(phase.missingFromCopy('Fatal error: Cannot redeclare my_helper()', orig, copyRoot) === null && phase.missingFromCopy(msg('../../../../etc/passwd'), orig, copyRoot) === null, 'other fatals and traversal paths give nothing');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
