// Core and server settings read from the LOCAL files: wp-config.php, file permissions, stray files and PHP version.
// Secrets in wp-config.php (DB password, salts) are checked but never copied into a finding.

const fs = require('fs');
const path = require('path');
const { finding } = require('../lib/finding');
const { compare } = require('../lib/version');

// End of security support per PHP branch. Verify against https://www.php.net/supported-versions.php
const PHP_EOL = { '5': '2018-12-31', '7.0': '2018-12-03', '7.1': '2019-12-01', '7.2': '2020-11-30', '7.3': '2021-12-06', '7.4': '2022-11-28', '8.0': '2023-11-26', '8.1': '2025-12-31', '8.2': '2026-12-31', '8.3': '2027-12-31', '8.4': '2028-12-31', '8.5': '2029-12-31' };
const SALT_KEYS = ['AUTH_KEY', 'SECURE_AUTH_KEY', 'LOGGED_IN_KEY', 'NONCE_KEY', 'AUTH_SALT', 'SECURE_AUTH_SALT', 'LOGGED_IN_SALT', 'NONCE_SALT'];
const BACKUP_FILE = /\.(sql|sql\.gz|sql\.zip|bak|old|orig|save|swp|tar|tar\.gz|tgz|zip|7z|rar)$|~$|^backup|^dump|^db[-_]?backup/i;
const BACKUP_DIRS = ['wp-content/updraft', 'wp-content/backups', 'wp-content/backup-db', 'wp-content/ai1wm-backups', 'wp-content/backupwordpress', 'wp-content/uploads/backupbuddy_backups', 'wp-content/wpvividbackups', 'wp-content/uploads/backwpup'];
const DEBUG_FILES = ['phpinfo.php', 'info.php', 'test.php', 'php.php', 'i.php', 'adminer.php', 'error_log', 'php_errorlog'];

function parseConfig(text) {
    const clean = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|#).*$/gm, '');
    const defs = {};
    for (const m of clean.matchAll(/define\s*\(\s*(['"])(\w+)\1\s*,\s*((?:'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|[^;'"])*?)\s*\)\s*;/g)) defs[m[2]] = m[3].trim();
    const prefix = /\$table_prefix\s*=\s*(['"])([^'"]*)\1/.exec(clean);
    return { defs, prefix: prefix ? prefix[2] : null };
}
const isTrue = v => v !== undefined && /^(true|1)$/i.test(v);
const isFalse = v => v !== undefined && /^(false|0)$/i.test(v);
const unq = v => (v === undefined ? undefined : v.replace(/^(['"])(.*)\1$/, '$2'));

function readConfig(root) {
    for (const f of [path.join(root, 'wp-config.php'), path.join(root, '..', 'wp-config.php')]) {
        if (fs.existsSync(f)) return { file: f, text: fs.readFileSync(f, 'utf8') };
    }
    return null;
}

// Is the PHP branch still getting security fixes? Used by local and URL-only scans.
function phpSupport(ctx) {
    const out = [];
    const php = ctx.phpVersion;
    if (php && php.version) {
        const branch = /^(\d+)\.(\d+)/.exec(php.version);
        const key = branch ? (Number(branch[1]) < 7 ? branch[1] : `${branch[1]}.${branch[2]}`) : null;
        const eol = key && PHP_EOL[key];
        if (eol) {
            const days = Math.round((new Date(eol) - ctx.now) / 86400000);
            if (days < 0) out.push(finding({ rule: 'php-eol', severity: 'P1', category: 'configuration', confidence: php.source.startsWith('project') ? 'certain' : 'possible', owner: 'hosting', plugins: [], key: key,
                title: `PHP ${php.version} no longer receives security fixes (ended ${eol})`, detail: `Known PHP vulnerabilities stay open. Version source: ${php.source}.`, fix: 'Ask the host to move the site to a supported PHP version (test on staging first).', done: 'The server runs a PHP branch that still gets security fixes.' }));
            else if (days < 180) out.push(finding({ rule: 'php-eol-soon', severity: 'P3', category: 'configuration', confidence: 'possible', owner: 'hosting', plugins: [], key: key,
                title: `PHP ${php.version} stops receiving security fixes on ${eol} (${days} days)`, detail: `Plan the upgrade. Version source: ${php.source}.`, fix: 'Schedule a PHP upgrade before that date.', done: 'The server runs a newer PHP branch.' }));
        }
    }
    return out;
}

function run(ctx) {
    const out = [];
    const root = ctx.wpRoot;

    const cfg = readConfig(root);
    if (!cfg) {
        ctx.record('server-config', 'wp-config.php settings', 'skipped', 'no wp-config.php found at the root or one level above');
    } else {
        ctx.record('server-config', 'wp-config.php settings', 'done');
        const { defs, prefix } = parseConfig(cfg.text);
        ctx.config.multisite = isTrue(defs.MULTISITE);
        const where = path.relative(root, cfg.file) || 'wp-config.php';
        const add = o => out.push(finding({ confidence: 'certain', owner: 'hosting', evidence: [where], ...o }));

        if (isTrue(defs.WP_ALLOW_REPAIR)) add({ rule: 'cfg-allow-repair', severity: 'P0', category: 'configuration', title: 'WP_ALLOW_REPAIR is on', detail: '/wp-admin/maint/repair.php works WITHOUT logging in, letting anyone trigger database repair/optimisation.', fix: `Remove the line define( 'WP_ALLOW_REPAIR', true ); from ${where}.`, done: 'WP_ALLOW_REPAIR is not defined.', owner: 'code' });
        if (isTrue(defs.WP_DEBUG)) {
            const shown = !isFalse(defs.WP_DEBUG_DISPLAY);
            add({ rule: 'cfg-debug', severity: shown ? 'P1' : 'P2', category: 'configuration', owner: 'code', title: `WP_DEBUG is on${shown ? ' and errors are shown to visitors' : ''}`, detail: `Debug mode leaks file paths and plugin names${shown ? ' straight onto the pages' : ' into debug.log'}. Fine on a development copy; not on the live site.`, fix: `On the live site set define( 'WP_DEBUG', false ); (or at least WP_DEBUG_DISPLAY to false) in ${where}.`, done: 'WP_DEBUG is false in the production configuration.' });
        }
        if (isTrue(defs.WP_DEBUG_LOG) && !/^['"]\//.test(defs.WP_DEBUG_LOG)) add({ rule: 'cfg-debug-log', severity: 'P3', category: 'configuration', owner: 'code', title: 'Debug log is written inside the web folder', detail: 'wp-content/debug.log is public unless the web server blocks it.', fix: "Write the log outside the web root, e.g. define( 'WP_DEBUG_LOG', '/var/log/wp-debug.log' ); and block debug.log in the web server.", done: 'The log is outside the web root or blocked.' });
        if (!isTrue(defs.DISALLOW_FILE_EDIT)) add({ rule: 'cfg-file-edit', severity: 'P2', category: 'configuration', owner: 'code', title: 'The theme/plugin file editor is enabled', detail: 'An attacker who gets into any admin account can edit PHP files from the browser and take over the server.', fix: `Add define( 'DISALLOW_FILE_EDIT', true ); to ${where}.`, done: 'DISALLOW_FILE_EDIT is true.' });
        const weak = SALT_KEYS.filter(k => { const v = unq(defs[k]); return v === undefined || v.length < 32 || /put your unique phrase here/i.test(v); });
        if (weak.length) add({ rule: 'cfg-salts', severity: 'P1', category: 'configuration', owner: 'code', title: `Security keys/salts are missing, default or short (${weak.length} of 8)`, detail: 'The keys sign login cookies. Missing or default ones make stolen or forged cookies much easier to use.', fix: `Replace the 8 key/salt lines in ${where} with fresh values from https://api.wordpress.org/secret-key/1.1/salt/ (this logs everyone out once).`, done: 'All 8 keys are unique random strings of 64 characters.' });
        if (prefix === 'wp_') add({ rule: 'default-db-prefix', severity: 'P3', category: 'configuration', owner: 'admin', title: 'The database table prefix is the default "wp_"', detail: 'Automated SQL-injection tools assume wp_. A custom prefix is a small extra hurdle, not a fix for injection.', fix: 'Optional: change the prefix with a migration plugin on staging. Skip if the site is stable and plugins are patched.', done: 'Prefix changed, or the risk is accepted.' });
        if (unq(defs.DB_USER) === 'root') add({ rule: 'cfg-db-root', severity: 'P1', category: 'configuration', title: 'WordPress connects to the database as "root"', detail: 'If the site is ever compromised the attacker controls every database on the server.', fix: 'Create a database user limited to this one database and use it in wp-config.php.', done: 'DB_USER is not root.' });
        if (defs.DB_PASSWORD !== undefined && unq(defs.DB_PASSWORD) === '') add({ rule: 'cfg-db-empty-pass', severity: 'P1', category: 'configuration', title: 'The database password is empty', detail: 'Anyone who can reach the database server can log in.', fix: 'Set a strong password for the database user and update wp-config.php.', done: 'DB_PASSWORD is not empty.' });
        if (isFalse(defs.WP_AUTO_UPDATE_CORE)) add({ rule: 'cfg-core-autoupdate-off', severity: 'P2', category: 'configuration', owner: 'code', title: 'Automatic WordPress security updates are switched off', detail: 'WP_AUTO_UPDATE_CORE is false, so even urgent security releases wait for a person.', fix: `Remove the line from ${where}, or set it to 'minor'.`, done: "WP_AUTO_UPDATE_CORE is 'minor' or not defined." });
        if (/^['"]http:\/\//i.test(defs.WP_HOME || '') || /^['"]http:\/\//i.test(defs.WP_SITEURL || '')) add({ rule: 'cfg-http-url', severity: 'P2', category: 'configuration', owner: 'code', title: 'The site address is set to http:// in wp-config.php', detail: 'Logins and cookies travel unencrypted.', fix: 'Use https:// addresses and redirect HTTP to HTTPS.', done: 'WP_HOME and WP_SITEURL use https.' });
        if (!isTrue(defs.FORCE_SSL_ADMIN) && /https:/i.test(ctx.project.url || '')) add({ rule: 'cfg-force-ssl-admin', severity: 'P3', category: 'configuration', owner: 'code', title: 'FORCE_SSL_ADMIN is not set', detail: 'Admin logins are not forced onto HTTPS by WordPress itself.', fix: "Add define( 'FORCE_SSL_ADMIN', true ); to wp-config.php.", done: 'FORCE_SSL_ADMIN is true.' });

        if (process.platform !== 'win32') {
            const mode = fs.statSync(cfg.file).mode & 0o777;
            if (mode & 0o004) add({ rule: 'perm-config-readable', severity: 'P1', category: 'permissions', title: `${where} can be read by every user on the server (mode ${mode.toString(8)})`, detail: 'On shared hosting other accounts can read the database password.', fix: `chmod 640 ${where} (or 600), owned by the web user.`, commands: [`chmod 640 ${cfg.file}`], done: 'The file mode is 640 or stricter.' });
        }
    }

    // permissions: world-writable entries at the top of the usual folders
    if (process.platform !== 'win32') {
        const bad = new Set();
        for (const rel of ['', 'wp-content', 'wp-content/plugins', 'wp-content/themes', 'wp-content/uploads', 'wp-content/mu-plugins']) {
            const dir = path.join(root, rel);
            if (!fs.existsSync(dir)) continue;
            const list = [dir, ...fs.readdirSync(dir).slice(0, 400).map(n => path.join(dir, n))];
            for (const f of list) {
                try { const st = fs.lstatSync(f); if (!st.isSymbolicLink() && (st.mode & 0o002)) bad.add(`${path.relative(root, f) || '.'} (${(st.mode & 0o777).toString(8)})`); } catch { /* gone */ }
            }
        }
        ctx.record('server-permissions', 'File permissions', 'done');
        if (bad.size) out.push(finding({
            rule: 'perm-world-writable', severity: 'P1', category: 'permissions', confidence: 'certain', owner: 'hosting', plugins: [], key: 'world-writable',
            title: `${bad.size} file(s) or folder(s) are writable by every user on the server`,
            detail: 'A compromise of any other site on the same server, or any PHP flaw, can then plant code here.', evidence: [...bad].slice(0, 15),
            fix: 'Folders 755, files 644 (wp-config.php 640), owned by the web user.', commands: [`find ${root} -type d -perm -o+w -exec chmod 755 {} +`, `find ${root} -type f -perm -o+w -exec chmod 644 {} +`], done: 'No world-writable entries remain.'
        }));
    } else ctx.record('server-permissions', 'File permissions', 'skipped', 'not checked on Windows');

    // stray files in the web folder
    const stray = [];
    const scanDir = (dir, depth) => {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            const rel = path.relative(root, path.join(dir, e.name)).split(path.sep).join('/');
            if (e.isFile()) {
                if (depth === 0 && /^wp-config.+/i.test(e.name) && !['wp-config.php', 'wp-config-sample.php'].includes(e.name)) stray.push({ rel, kind: 'config-copy' });
                else if (BACKUP_FILE.test(e.name) && !/^(readme|license)/i.test(e.name) && !rel.startsWith('wp-content/plugins/') && !rel.startsWith('wp-content/themes/')) stray.push({ rel, kind: 'backup' });
                else if (DEBUG_FILES.includes(e.name.toLowerCase())) stray.push({ rel, kind: 'debug' });
                else if (rel === 'wp-content/debug.log') stray.push({ rel, kind: 'debuglog' });
            } else if (e.isDirectory() && depth < 1 && !['wp-admin', 'wp-includes', 'node_modules'].includes(e.name)) {
                if (e.name === '.git' || e.name === '.svn') stray.push({ rel, kind: 'vcs' });
                else if (e.name !== 'wp-content') scanDir(path.join(dir, e.name), depth + 1);
            }
        }
    };
    scanDir(root, 0);
    for (const f of ['.env', '.git', '.svn']) {
        if (fs.existsSync(path.join(root, f)) && !stray.some(s => s.rel === f)) stray.push({ rel: f, kind: f === '.env' ? 'env' : 'vcs' });
    }
    scanDir(path.join(root, 'wp-content'), 1);
    for (const d of BACKUP_DIRS) if (fs.existsSync(path.join(root, d))) stray.push({ rel: d, kind: 'backup-dir' });
    ctx.record('server-stray-files', 'Backups, debug and leftover files in the web folder', 'done');
    const kinds = {
        backup: ['P1', 'Backup or database dump in the web folder', 'Anyone who guesses the name can download the whole site or database.'],
        'backup-dir': ['P1', 'Backup folder inside the web folder', 'Backup plugins store full copies of the site here; if the folder is reachable, so is every backup.'],
        debug: ['P1', 'Debug or admin tool file left in the web folder', 'phpinfo()/Adminer-type files reveal the server setup or give database access.'],
        'config-copy': ['P0', 'Copy of wp-config.php in the web folder', 'A copy ending in .bak/.old/.txt is served as plain text and shows the database password.'],
        debuglog: ['P1', 'wp-content/debug.log exists', 'It lists errors with file paths and sometimes personal data, and is public unless blocked.'],
        env: ['P0', '.env file in the web folder', 'Environment files hold passwords and API keys.'],
        vcs: ['P0', 'Version-control folder (.git/.svn) in the web folder', 'Reveals source code and often secrets in history.']
    };
    for (const s of stray) {
        const [severity, title, detail] = kinds[s.kind];
        out.push(finding({ rule: `stray-${s.kind}`, severity, category: 'exposure', confidence: 'certain', owner: 'hosting', plugins: [], key: s.rel, title: `${title}: ${s.rel}`, detail, evidence: [s.rel],
            fix: `Move ${s.rel} out of the web folder (or delete it) and block it in the web server. Treat any password it contained as leaked.`, done: `${s.rel} no longer exists in the web folder.`,
            patch: { type: 'htaccess', id: s.kind === 'debuglog' ? 'debug-log' : s.kind === 'env' || s.kind === 'vcs' ? 'dotfiles' : s.kind === 'config-copy' ? 'config-backup' : 'backups' } }));
    }
    for (const f of ['readme.html', 'license.txt']) {
        if (fs.existsSync(path.join(root, f))) out.push(finding({ rule: 'stray-core-readme', severity: 'P3', category: 'exposure', confidence: 'certain', owner: 'hosting', plugins: [], key: f, title: `${f} reveals the WordPress version`, detail: 'The default page states the exact version, which tells attackers which exploits to try.', evidence: [f], fix: `Delete ${f} (WordPress recreates it on each core update) or block it.`, done: `${f} is gone or blocked.`, patch: { type: 'htaccess', id: 'core-readme' } }));
    }

    out.push(...phpSupport(ctx));
    return out;
}

module.exports = { run, phpSupport, parseConfig, PHP_EOL };
