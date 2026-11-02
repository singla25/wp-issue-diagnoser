// Copies the parts of a WordPress site that the sandbox needs (themes, plugins, mu-plugins, languages, drop-ins; uploads only on request)
// from the ORIGINAL into the sandbox's own folder. The original is only read. Rules, each with a test:
//   - symbolic links are NEVER followed (they are skipped and counted): a link inside a plugin cannot pull in /etc or the original's secrets;
//   - .git and other tool folders, .env files, wp-config*.php, key and credential files, backups, archives and logs (by FILE name: debug.log, error_log, *.log) are skipped;
//     a folder or a PHP/CSS/template file is never skipped just because its name contains "debug", "cache", "backup" or "upgrade";
//   - the whole copy is measured first and refused above the size cap, BEFORE anything is written (never a silent partial copy);
//   - object-cache.php and db.php drop-ins are skipped: they point at services (Redis, another database) that do not exist in the sandbox;
//   - every destination is checked to be inside the sandbox folder.

const fs = require('fs');
const readdir = require('../lib/sorted-dir');
const path = require('path');

const DEFAULTS = { maxBytes: 500 * 1024 * 1024, maxFileBytes: 50 * 1024 * 1024, maxFiles: 100000 };
// Folders are skipped only when they are tool folders. A folder is NEVER skipped for its NAME alone when the name is an ordinary word: "debug", "cache", "upgrade", "backup"
// and "backups" are code folders in real plugins (freemius/includes/debug, Twig and PSR "Cache" namespaces, Elementor core/upgrade, a view called backups). What such a folder
// holds is judged file by file below (archives, dumps, backups, logs and keys are still skipped), and the size cap bounds the rest.
const SKIP_DIRS = /^(\.git|\.svn|\.hg|\.idea|\.vscode|\.github|\.ssh|\.aws|\.gnupg|node_modules|__MACOSX)$/i;
// a public CA bundle that HTTP libraries ship (cacert.pem): not a secret, and without it the plugin's requests fail. Copied only when the file holds no private key.
const PUBLIC_CERT = /^(cacert|ca-bundle|ca-certificates)\.(pem|crt)$/i;
const hasPrivateKey = f => { try { return /PRIVATE KEY/.test(fs.readFileSync(f, 'latin1').slice(0, 2 * 1024 * 1024)); } catch { return true; } };
const SKIP_FILES = [
    [/^\.env(\..*)?$/i, 'environment file'], [/^wp-config.*\.php$/i, 'wp-config (a fresh one is generated)'], [/\.(pem|key|pfx|p12|crt|cer|jks|keystore)$/i, 'key or certificate'],
    [/^(id_rsa|id_dsa|id_ecdsa|id_ed25519)(\.pub)?$/i, 'SSH key'], [/^(\.htpasswd|\.netrc|\.npmrc|\.pypirc|auth\.json|credentials(\..*)?|secrets?(\..*)?)$/i, 'credentials file'],
    [/\.(sql|sql\.gz|sqlite|sqlite3|db)$/i, 'database dump'], [/\.(zip|tar|tgz|gz|bz2|xz|7z|rar|wpress)$/i, 'archive or backup'], [/\.(bak|old|orig|save|swp|swo|tmp)$|~$/i, 'backup or editor leftover'],
    [/\.log$/i, 'log file'], [/^(error_log|php_errorlog|php_errors)$/i, 'log file'], [/^\.DS_Store$/i, 'system file']
];
const DROPIN_SKIP = new Set(['object-cache.php', 'db.php', 'db-error.php', 'sunrise.php', 'blog-deleted.php', 'blog-inactive.php', 'blog-suspended.php']);
const DROPINS = new Set(['advanced-cache.php', 'maintenance.php', 'install.php', 'php-error.php', 'fatal-error-handler.php', ...DROPIN_SKIP]);
const PARTS = ['plugins', 'themes', 'mu-plugins', 'languages'];

const inside = (parent, child) => child === parent || child.startsWith(parent + path.sep);
const err = (msg, code = 2) => Object.assign(new Error(msg), { exitCode: code });

// -> { entries: [{ src, rel, size, dir }], skipped: [{ path, reason }], symlinks: n, bytes, files, biggest }
function scan(root, { withUploads = false, ...limits } = {}) {
    const L = { ...DEFAULTS, ...limits };
    const wc = path.join(root, 'wp-content');
    const entries = [], skipped = [], top = new Map();
    let symlinks = 0, bytes = 0, files = 0;
    const skip = (p, reason) => { if (skipped.length < 400) skipped.push({ path: p, reason }); };
    const walk = (abs, rel, partName) => {
        let list; try { list = readdir(abs, { withFileTypes: true }); } catch { skip(rel, 'unreadable'); return; }
        list.sort((a, b) => a.name.localeCompare(b.name));
        for (const e of list) {
            const a = path.join(abs, e.name), r = `${rel}/${e.name}`;
            let st; try { st = fs.lstatSync(a); } catch { continue; }
            if (st.isSymbolicLink()) { symlinks++; skip(r, 'symbolic link (never followed)'); continue; }
            if (st.isDirectory()) {
                if (SKIP_DIRS.test(e.name)) { skip(r, 'tool folder'); continue; }
                entries.push({ src: a, rel: r, dir: true, size: 0 });
                walk(a, r, partName);
                continue;
            }
            if (!st.isFile()) { skip(r, 'not a regular file'); continue; }
            const bad = PUBLIC_CERT.test(e.name) && !hasPrivateKey(a) ? null : SKIP_FILES.find(([re]) => re.test(e.name));
            if (bad) { skip(r, bad[1]); continue; }
            if (st.size > L.maxFileBytes) { skip(r, `file larger than ${Math.round(L.maxFileBytes / 1048576)} MB`); continue; }
            files++; bytes += st.size; top.set(partName, (top.get(partName) || 0) + st.size);
            entries.push({ src: a, rel: r, dir: false, size: st.size });
        }
    };
    for (const part of PARTS) {
        const abs = path.join(wc, part);
        let st; try { st = fs.lstatSync(abs); } catch { continue; }
        if (st.isSymbolicLink()) { symlinks++; skip(`wp-content/${part}`, 'symbolic link (never followed)'); continue; }
        if (!st.isDirectory()) continue;
        entries.push({ src: abs, rel: `wp-content/${part}`, dir: true, size: 0 });
        walk(abs, `wp-content/${part}`, part);
    }
    if (withUploads) {
        const abs = path.join(wc, 'uploads');
        try { const st = fs.lstatSync(abs); if (st.isDirectory() && !st.isSymbolicLink()) { entries.push({ src: abs, rel: 'wp-content/uploads', dir: true, size: 0 }); walk(abs, 'wp-content/uploads', 'uploads'); } else if (st.isSymbolicLink()) { symlinks++; skip('wp-content/uploads', 'symbolic link (never followed)'); } } catch { /* none */ }
    }
    let dropins = [];
    try {
        for (const e of readdir(wc, { withFileTypes: true })) {
            if (!DROPINS.has(e.name)) continue;
            const a = path.join(wc, e.name), r = `wp-content/${e.name}`, st = fs.lstatSync(a);
            if (st.isSymbolicLink()) { symlinks++; skip(r, 'symbolic link (never followed)'); continue; }
            if (DROPIN_SKIP.has(e.name)) { skip(r, 'drop-in for a service the sandbox does not have (Redis, another database, multisite)'); continue; }
            dropins.push(e.name); files++; bytes += st.size; entries.push({ src: a, rel: r, dir: false, size: st.size });
        }
    } catch { /* no wp-content */ }
    return { entries, skipped, symlinks, bytes, files, dropins, biggest: [...top].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([part, size]) => ({ part, mb: Math.round(size / 104857.6) / 10 })), limits: L };
}

// Copies into destSite (…/sandboxes/<id>/site). Refuses, before writing anything, above the size / file caps.
function copySite(root, destSite, { sandboxDir, withUploads = false, ...limits } = {}) {
    if (!sandboxDir) throw err('copySite needs the sandbox folder to check destinations against');
    const sb = path.resolve(sandboxDir), dest = path.resolve(destSite);
    if (!inside(sb, dest) || dest === sb) throw err(`the destination ${dest} is not inside the sandbox folder ${sb}`);
    const rootReal = fs.realpathSync(root);
    if (inside(rootReal, sb) || inside(sb, rootReal)) throw err('the sandbox folder and the original site overlap: refusing to copy');
    const s = scan(root, { withUploads, ...limits });
    const L = s.limits;
    if (s.bytes > L.maxBytes) throw err(`The parts of the site to copy are ${Math.round(s.bytes / 1048576)} MB, above the ${Math.round(L.maxBytes / 1048576)} MB cap (--max-size-mb). Largest parts: ${s.biggest.map(b => `${b.part} ${b.mb} MB`).join(', ')}. Nothing was copied.`);
    if (s.files > L.maxFiles) throw err(`${s.files} files, above the cap of ${L.maxFiles}. Nothing was copied.`);
    let copied = 0;
    for (const e of s.entries) {
        const to = path.join(dest, e.rel);
        if (!inside(dest, path.resolve(to))) throw err(`refusing to write outside the sandbox: ${to}`);
        if (e.dir) { fs.mkdirSync(to, { recursive: true, mode: 0o755 }); fs.chmodSync(to, 0o755); continue; }
        fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o755 });
        fs.copyFileSync(e.src, to);
        fs.chmodSync(to, 0o644);
        copied++;
    }
    for (const d of ['wp-content/mu-plugins', 'wp-content/plugins', 'wp-content/themes', 'wp-content/uploads']) fs.mkdirSync(path.join(dest, d), { recursive: true, mode: 0o755 });
    fs.chmodSync(path.join(dest, 'wp-content/uploads'), 0o777); // written by www-data in the container; the sandbox folder itself is 0700
    return { files: copied, bytes: s.bytes, symlinks_skipped: s.symlinks, dropins_copied: s.dropins, uploads_copied: !!withUploads,
        skipped: s.skipped.slice(0, 60), skipped_total: s.skipped.length, skipped_by_reason: Object.fromEntries([...new Set(s.skipped.map(x => x.reason))].sort().map(r => [r, s.skipped.filter(x => x.reason === r).length])) };
}

module.exports = { scan, copySite, SKIP_DIRS, SKIP_FILES, DROPIN_SKIP, DEFAULTS };
