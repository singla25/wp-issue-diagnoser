// Are the files what they should be?
//  1. Malware / backdoor patterns in wp-content and the web root (local, no outside lookups).
//  2. PHP hiding in uploads or behind image extensions.
//  3. WordPress core and plugin files compared with the official wordpress.org copies (needs outside lookups).
//  4. "Nulled" (pirated) plugin markers.
// Findings never contain file content, only the file, the line and the pattern name.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { finding } = require('../lib/finding');

const MAX_FILE = 1024 * 1024;
const MAX_FILES = 25000;
const CODE_EXT = /\.(php|phtml|php[3-8]|phar|inc)$/i;
const SKIP = new Set(['node_modules', '.git', 'languages']);

const PATTERNS = [
    { id: 'obfuscated-exec', sev: 'P0', re: /\b(eval|assert)\s*\(\s*(@\s*)?(base64_decode|gzinflate|gzuncompress|gzdecode|str_rot13|rawurldecode)\s*\(/i, what: 'runs obfuscated code (eval of an encoded string)' },
    { id: 'request-exec', sev: 'P0', re: /\b(eval|assert|system|passthru|shell_exec|popen|proc_open)\s*\(\s*(@\s*)?\$_(GET|POST|REQUEST|COOKIE|SERVER)\b/i, what: 'executes code or commands taken straight from the request' },
    { id: 'request-as-function', sev: 'P0', re: /\$_(GET|POST|REQUEST|COOKIE)\s*\[[^\]]+\]\s*\(/, what: 'calls a function whose name comes from the request (classic backdoor)' },
    { id: 'known-webshell', sev: 'P0', re: /\b(c99shell|r57shell|b374k|FilesMan|WSO\s*[0-9]|Weevely|webshell|IndoXploit|Mini\s*Shell)\b/i, what: 'contains the name of a known web shell' },
    { id: 'file-write-request', sev: 'P1', re: /file_put_contents\s*\([^;]*\$_(GET|POST|REQUEST|COOKIE)/i, what: 'writes a file with content from the request' },
    { id: 'preg-e', sev: 'P1', re: /preg_replace\s*\(\s*(['"])[^'"]*\/[a-z]*e[a-z]*\1/i, what: 'uses preg_replace with the /e modifier (code execution)' },
    { id: 'include-image', sev: 'P1', re: /\b(include|require)(_once)?\s*\(?\s*['"][^'"]+\.(jpe?g|png|gif|ico|txt)['"]/i, what: 'includes an image/text file as PHP (hiding place for code)' },
    { id: 'create-function', sev: 'P2', re: /\bcreate_function\s*\(/i, what: 'uses create_function (removed in PHP 8; used by old malware)' },
    { id: 'long-base64', sev: 'P2', re: /['"][A-Za-z0-9+\/=]{2500,}['"]/, what: 'contains a very long encoded string' }
];
const VENDOR_TESTS = /\/(vendor|libs?)\/(?:.*\/)?(tests?|fixtures?)\//i;
const NULLED = /\b(nulled|cracked by|gpl[-\s]?club|babiato|wpnull|crackedplugins|null24|weadown|downloadfreethemes)\b/i;

function walk(dir, out, root, limit) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
        if (out.length >= limit) return;
        const full = path.join(dir, e.name);
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(full, out, root, limit); }
        else out.push(full);
    }
}

const rel = (root, f) => path.relative(root, f).split(path.sep).join('/');
const md5 = f => crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex');
const sha256 = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

function localPatterns(ctx) {
    const out = [];
    const root = ctx.wpRoot;
    const files = [];
    for (const f of fs.readdirSync(root, { withFileTypes: true })) if (f.isFile()) files.push(path.join(root, f.name));
    walk(path.join(root, 'wp-content'), files, root, MAX_FILES);
    let scanned = 0;
    const seen = new Set();
    for (const f of files) {
        const r = rel(root, f);
        const inUploads = r.startsWith('wp-content/uploads/');
        const base = path.basename(f);
        let st;
        try { st = fs.statSync(f); } catch { continue; }
        const isCode = CODE_EXT.test(base);
        const imageLike = /\.(jpe?g|png|gif|ico|svg|webp|txt|css|js)$/i.test(base);
        if (!isCode && !(imageLike && inUploads)) { if (!/\.php\./i.test(base)) continue; }

        const add = (rule, severity, title, detail, key, line) => { const k = `${rule}:${r}:${key || ''}`; if (!seen.has(k)) { seen.add(k); out.push(finding({ rule, severity, category: 'integrity', plugins: [], key: k, title, detail, evidence: [line ? `${r}:${line}` : r], owner: 'admin', confidence: 'likely',
            fix: `Treat the site as possibly compromised: take a backup for evidence, then replace ${r} with a clean copy (reinstall the plugin/theme/core) or delete it if nothing owns it. Change all admin and database passwords and the security keys afterwards.`, done: `${r} is clean or removed and a fresh scan finds nothing.` })); } };

        if (/\.php\.(jpe?g|png|gif|ico|svg|webp|pdf|txt|css|js)$/i.test(base) || /^\.[^/]+\.php$/i.test(base)) add('integrity-disguised-name', 'P1', `Suspicious file name: ${r}`, 'Double extensions (.php.jpg) and hidden dot-files ending in .php are used to sneak code past upload filters.');
        if (inUploads && isCode && !(base === 'index.php' && st.size < 200)) { add('integrity-php-in-uploads', 'P0', `PHP file in the uploads folder: ${r}`, 'WordPress never stores PHP in uploads. Almost every file like this is a web shell or a dropper.'); }
        if (st.size > MAX_FILE || ++scanned > 12000) continue;
        let text;
        try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
        if (!isCode && !/<\?(php|=)/i.test(text.slice(0, 300000))) continue;
        if (inUploads && !isCode) add('integrity-php-in-image', 'P0', `PHP code hidden in a non-PHP upload: ${r}`, 'A file with an image/text extension that contains <?php is how attackers bypass "images only" upload filters.');
        // the code-risk scan of plugins/themes/mu-plugins already reports request input reaching exec/eval: don't say it twice
        const coveredByExposure = /^wp-content\/(plugins|themes|mu-plugins)\//.test(r) && !/\/(vendor|libs?)\//i.test(r);
        for (const p of PATTERNS) {
            if (p.id === 'request-exec' && coveredByExposure) continue;
            const m = p.re.exec(text);
            if (!m) continue;
            const line = text.slice(0, m.index).split('\n').length;
            // libraries legitimately contain long encoded strings; only flag them outside vendor folders
            if (p.id === 'long-base64' && /\/(vendor|libs?|assets|fonts)\//i.test(r)) continue;
            // a library's own test fixtures deliberately contain deprecated calls (e.g. PHP_CodeSniffer's DeprecatedFunctionsUnitTest.inc)
            if (p.id === 'create-function' && VENDOR_TESTS.test(r)) continue;
            add(`integrity-${p.id}`, p.sev, `${r}:${line} ${p.what}`, `Pattern "${p.id}" matched. Legitimate code rarely does this; most hits are malware, but check before deleting.`, p.id, line);
        }
        // crypto/image libraries (phpseclib, ...) legitimately carry big \x tables; only flag hex escapes outside vendor folders
        if ((text.match(/\\x[0-9a-f]{2}/gi) || []).length > 80 && isCode && !/\/(vendor|libs?)\//i.test(r)) add('integrity-heavy-hex', 'P2', `${r} is heavily obfuscated with hex escapes`, 'Hundreds of \\x.. escapes in a PHP file are used to hide function names from scanners.', 'hex');
    }
    return out;
}

async function core(ctx) {
    const out = [];
    const root = ctx.wpRoot;
    if (!ctx.wpVersion) { ctx.record('integrity-core', 'WordPress core files vs official copy', 'skipped', 'WordPress version could not be read from wp-includes/version.php'); return out; }
    const r = await ctx.outside.coreChecksums(ctx.wpVersion.version, ctx.wpVersion.locale);
    if (r.skipped) { ctx.record('integrity-core', 'WordPress core files vs official copy', 'skipped', r.reason); return out; }
    const sums = r.ok && r.json && r.json.checksums;
    if (!sums) { ctx.record('integrity-core', 'WordPress core files vs official copy', 'skipped', `wordpress.org has no checksum list for ${ctx.wpVersion.version} ${ctx.wpVersion.locale} (${r.error || 'HTTP ' + r.status})`); return out; }
    ctx.record('integrity-core', 'WordPress core files vs official copy', 'done');
    const changed = [], missing = [];
    for (const [file, sum] of Object.entries(sums)) {
        if (file.startsWith('wp-content/')) continue; // default themes/plugins vary with what the owner deleted
        const full = path.join(root, file);
        if (!fs.existsSync(full)) { if (!/^(readme\.html|license\.txt|wp-config-sample\.php)$/.test(file)) missing.push(file); continue; }
        if (md5(full) !== sum) changed.push(file);
    }
    const added = [];
    for (const dir of ['wp-admin', 'wp-includes']) {
        const files = [];
        walk(path.join(root, dir), files, root, 20000);
        for (const f of files) { const r2 = rel(root, f); if (!(r2 in sums) && CODE_EXT.test(r2)) added.push(r2); }
    }
    for (const f of fs.readdirSync(root, { withFileTypes: true })) if (f.isFile() && CODE_EXT.test(f.name) && !(f.name in sums) && f.name !== 'wp-config.php') added.push(f.name);
    const base = { category: 'integrity', confidence: 'certain', owner: 'admin', plugins: [] };
    if (changed.length) out.push(finding({ ...base, rule: 'integrity-core-modified', severity: 'P0', key: 'core-modified', title: `${changed.length} WordPress core file(s) differ from the official ${ctx.wpVersion.version} release`, detail: 'Core files are never meant to be edited. Changes are either a hack or a risky customisation that updates will overwrite.', evidence: changed.slice(0, 20), fix: 'Replace the listed files with the originals.', commands: [`wp core download --force --skip-content --version=${ctx.wpVersion.version}`], done: 'Core checksums all match.' }));
    if (added.length) out.push(finding({ ...base, rule: 'integrity-core-added', severity: 'P1', key: 'core-added', title: `${added.length} PHP file(s) in WordPress core folders are not part of WordPress`, detail: 'wp-admin, wp-includes and the root only contain files from the WordPress package. Extra PHP files there are a common backdoor hiding place.', confidence: 'likely', evidence: added.slice(0, 20), fix: 'Inspect each file. Delete those you cannot explain.', done: 'No unknown PHP files remain in core folders.' }));
    if (missing.length) out.push(finding({ ...base, rule: 'integrity-core-missing', severity: 'P3', key: 'core-missing', title: `${missing.length} WordPress core file(s) are missing`, detail: 'Missing core files can break admin screens or updates.', evidence: missing.slice(0, 20), fix: 'Reinstall core.', commands: [`wp core download --force --skip-content --version=${ctx.wpVersion.version}`], done: 'No core file is missing.' }));
    return out;
}

async function plugins(ctx) {
    const out = [];
    const unverifiable = [];
    let checked = 0;
    let skipped = null;
    for (const p of ctx.plugins.filter(x => !x.single && x.version)) {
        const r = await ctx.outside.pluginChecksums(p.slug, p.version);
        if (r.skipped) { skipped = r.reason; break; }
        if (!r.ok || !r.json || !r.json.files) { unverifiable.push(`${p.slug} ${p.version}`); continue; }
        checked++;
        const modified = [], added = [];
        const official = r.json.files;
        for (const [file, sum] of Object.entries(official)) {
            const full = path.join(p.dir, file);
            if (!fs.existsSync(full)) continue;
            const want = Array.isArray(sum.sha256) ? sum.sha256[0] : sum.sha256;
            const wantMd5 = Array.isArray(sum.md5) ? sum.md5[0] : sum.md5;
            if (want ? sha256(full) !== want : wantMd5 && md5(full) !== wantMd5) modified.push(file);
        }
        const local = [];
        walk(p.dir, local, p.dir, 5000);
        for (const f of local) { const r2 = rel(p.dir, f); if (CODE_EXT.test(r2) && !(r2 in official)) added.push(r2); }
        if (modified.length) out.push(finding({ rule: 'integrity-plugin-modified', severity: 'P1', category: 'integrity', confidence: 'certain', owner: 'admin', plugins: [p.ref], key: p.slug,
            title: `${p.name || p.slug} ${p.version}: ${modified.length} file(s) differ from the official wordpress.org release`, detail: 'The plugin was edited, corrupted, tampered with, or is a modified ("nulled") copy. Plugin edits are lost on update and are a frequent way to hide a backdoor.',
            evidence: modified.slice(0, 15).map(f => p.loc(f)), fix: `Reinstall the plugin from wordpress.org. If you intentionally customised it, move the change into a small separate plugin or the theme.`, commands: [`wp plugin install ${p.slug} --version=${p.version} --force`], done: 'All plugin files match the official checksums.' }));
        if (added.length) out.push(finding({ rule: 'integrity-plugin-added', severity: 'P1', category: 'integrity', confidence: 'likely', owner: 'admin', plugins: [p.ref], key: p.slug,
            title: `${p.name || p.slug}: ${added.length} PHP file(s) are not part of the official release`, detail: 'Extra PHP files inside a plugin folder are how attackers keep access after a plugin is "cleaned".',
            evidence: added.slice(0, 15).map(f => p.loc(f)), fix: 'Delete the files you cannot explain (reinstalling the plugin does not remove them).', done: 'Only official files remain.' }));
    }
    if (skipped) ctx.record('integrity-plugins', 'Plugin files vs official copy', 'skipped', skipped);
    else {
        ctx.record('integrity-plugins', 'Plugin files vs official copy', 'done', `${checked} verified, ${unverifiable.length} could not be (premium, custom or unknown version)`);
        if (unverifiable.length) out.push(finding({ rule: 'integrity-unverifiable', severity: 'P3', category: 'integrity', confidence: 'certain', owner: 'admin', plugins: [], key: 'unverifiable',
            title: `${unverifiable.length} plugin(s) cannot be checked against wordpress.org`, detail: 'Premium, custom or removed plugins have no official checksum list, so tampering cannot be ruled out this way. Only make sure they came from the vendor.',
            evidence: unverifiable.slice(0, 40), fix: 'Download these from the vendor again and compare, or keep them updated through the vendor\'s updater.', done: 'You know where each came from.' }));
    }
    return out;
}

function nulled(ctx) {
    const out = [];
    for (const p of [...ctx.plugins, ...ctx.themes]) {
        let hit = NULLED.test(p.slug) ? 'folder name' : null;
        for (const f of fs.existsSync(p.dir) && !p.single ? fs.readdirSync(p.dir) : []) {
            if (NULLED.test(f)) { hit = `file ${f}`; break; }
        }
        if (!hit && NULLED.test(`${p.author || ''} ${p.description || ''}`)) hit = 'plugin header';
        if (hit) out.push(finding({ rule: 'integrity-nulled', severity: 'P0', category: 'integrity', confidence: 'likely', owner: 'admin', plugins: [p.ref], key: p.ref,
            title: `${p.name || p.ref} looks like a pirated ("nulled") copy`, detail: `The ${hit} contains a marker used by sites that redistribute cracked premium plugins. Nulled plugins very often ship with a backdoor.`,
            fix: 'Remove it and buy/download the real plugin from the vendor. Then scan the site for backdoors and rotate all passwords.', commands: [`wp plugin delete ${p.slug}`], done: 'The pirated copy is gone and the real one is installed.' }));
    }
    return out;
}

async function run(ctx) {
    ctx.record('integrity-patterns', 'Malware and backdoor patterns, PHP in uploads', 'done');
    return [...localPatterns(ctx), ...nulled(ctx), ...await core(ctx), ...await plugins(ctx)];
}

module.exports = { run, PATTERNS, localPatterns };   // localPatterns: the offline part, used by issue/classic-adapter.js
