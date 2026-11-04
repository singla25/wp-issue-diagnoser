// Case 3 of the report, "Signs that a copy was modified" (REPORT-SPEC 5.3): STRONG signs only, read from the issue's COPY of the site. Read-only, offline, deterministic
// (every listing goes through lib/sorted-dir.js); it writes nothing and assigns no status. It never says a copy is cracked, pirated or malware: it names the file and the sign.
//   (a) the eval-of-an-encoded-string pattern of checks/integrity.js (`obfuscated-exec`: eval / assert of base64_decode, gzinflate, gzuncompress, gzdecode, str_rot13,
//       rawurldecode), and only that one, in the PHP files of the themes and plugins of the copy;
//   (b) the words "nulled" or "cracked" (whole words, any case) in a theme or plugin folder name, in its header fields (Plugin Name, Theme Name, Author, Description,
//       Version, Plugin URI), in the name line of its readme or in the name of a file at the top of its folder.
// NOT signs here (they fire on ordinary premium code): minified JavaScript (only PHP is read), files encoded by a vendor loader (ionCube, Zend Guard, SourceGuardian),
// Freemius SDK folders, licence calls to a vendor's domain, and any comparison with WordPress.org checksums (that needs the network and is not built).
// The split with the "Possible compromise signs" case (issue/classic-adapter.js, class 'compromise'): Case 3 covers the files of THIRD-PARTY themes and plugins (not in
// the customPaths allowlist); a compromise match of the same pattern in the same file is listed once, here (issue/case-file.js leaves it out of the compromise case).
// Custom code, must-use plugins, uploads and the site root stay with the compromise case.

const fs = require('fs');
const path = require('path');
const readdir = require('../lib/sorted-dir');
const ownership = require('../lib/ownership');
const integrity = require('../checks/integrity');

const EVAL = integrity.PATTERNS.find(p => p.id === 'obfuscated-exec');
const WORD = /\b(nulled|cracked)\b/i;
const HEADER_FIELDS = ['Plugin Name', 'Theme Name', 'Author', 'Description', 'Version', 'Plugin URI'];
// a file encoded by a vendor's loader is not a sign (it is how some premium code ships)
const VENDOR_ENCODED = /ionCube Loader|extension_loaded\(\s*['"]ionCube|<\?php \/\/0[0-9a-f]{3}[0-9a-f]*|\bsg_load\(|SourceGuardian|Zend Guard|zend_loader|@Zend;/i;
const SKIP_DIRS = new Set(['.git', '.svn', 'node_modules']);
const SKIP_DIR_RE = /^freemius$/i;                       // the Freemius SDK ships its own obfuscated-looking helpers
const MAX_FILE = 1024 * 1024, MAX_FILES = 60000, MAX_LISTED = 8;
const QUICK = /base64_decode|gzinflate|gzuncompress|gzdecode|str_rot13|rawurldecode/i;

const readHead = (f, n = 8192) => { let fd; try { fd = fs.openSync(f, 'r'); const b = Buffer.alloc(n); return b.toString('utf8', 0, fs.readSync(fd, b, 0, n, 0)); } catch { return ''; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* closed */ } } };
const headerOf = (text, key) => { const m = new RegExp(`^[ \\t/*#@]*${key}:(.*)$`, 'mi').exec(text); return m ? m[1].replace(/\s*\*\/.*$/, '').trim() : null; };
const isFile = f => { try { return fs.lstatSync(f).isFile(); } catch { return false; } };
const isDir = f => { try { return fs.lstatSync(f).isDirectory(); } catch { return false; } };

// the themes and plugins of the copy: [{ kind, slug, rel (folder or single file, relative to the site), name, headers: { field: value }, top: [file names], readmeName }]
function componentsOf(root) {
    const out = [];
    const pdir = path.join(root, 'wp-content', 'plugins');
    if (isDir(pdir)) for (const e of readdir(pdir, { withFileTypes: true })) {
        if (e.isSymbolicLink()) continue;
        const full = path.join(pdir, e.name);
        if (e.isDirectory()) {
            let top = []; try { top = readdir(full, { withFileTypes: true }).filter(x => x.isFile()).map(x => x.name); } catch { /* unreadable */ }
            const main = top.filter(f => /\.php$/i.test(f)).find(f => /^[ \t/*#@]*Plugin Name:/mi.test(readHead(path.join(full, f))));
            const head = main ? readHead(path.join(full, main)) : '';
            out.push({ kind: 'plugin', slug: e.name, rel: `wp-content/plugins/${e.name}`, dir: full, main, headers: Object.fromEntries(HEADER_FIELDS.map(k => [k, headerOf(head, k)])), top, readme: readmeName(full, top) });
        } else if (e.isFile() && /\.php$/i.test(e.name) && e.name !== 'index.php') {
            const head = readHead(full);
            if (!/^[ \t/*#@]*Plugin Name:/mi.test(head)) continue;
            out.push({ kind: 'plugin', slug: e.name.replace(/\.php$/i, ''), rel: `wp-content/plugins/${e.name}`, file: full, main: e.name, headers: Object.fromEntries(HEADER_FIELDS.map(k => [k, headerOf(head, k)])), top: [], readme: null });
        }
    }
    const tdir = path.join(root, 'wp-content', 'themes');
    if (isDir(tdir)) for (const e of readdir(tdir, { withFileTypes: true })) {
        if (!e.isDirectory() || e.isSymbolicLink()) continue;
        const full = path.join(tdir, e.name), style = path.join(full, 'style.css');
        const head = isFile(style) ? readHead(style) : '';
        if (!/^[ \t/*#@]*Theme Name:/mi.test(head)) continue;
        let top = []; try { top = readdir(full, { withFileTypes: true }).filter(x => x.isFile()).map(x => x.name); } catch { /* unreadable */ }
        out.push({ kind: 'theme', slug: e.name, rel: `wp-content/themes/${e.name}`, dir: full, main: 'style.css', headers: Object.fromEntries(HEADER_FIELDS.map(k => [k, headerOf(head, k)])), top, readme: readmeName(full, top) });
    }
    return out;
}
// the name line of a readme ("=== Plugin Name ===")
function readmeName(dir, top) {
    const f = top.find(n => /^readme\.(txt|md)$/i.test(n));
    if (!f) return null;
    const m = /^\s*(?:===|#)\s*(.+?)\s*(?:===)?\s*$/m.exec(readHead(path.join(dir, f), 2048));
    return m ? { file: f, name: m[1] } : null;
}
const nameOf = c => c.headers['Plugin Name'] || c.headers['Theme Name'] || c.slug;
const label = comp => `the ${comp.kind} ${comp.name}`;

// -> { signs: [{ kind: 'eval-encoded' | 'name', component: { kind, slug, name }, file, line, where, text }], count, files_read, complete, lines: [reader lines], files: [rel] }
function scan(root, { policy = null, maxFiles = MAX_FILES } = {}) {
    const res = { signs: [], count: 0, files_read: 0, complete: true, lines: [], files: [] };
    if (!root || !isDir(path.join(root, 'wp-content'))) return res;
    const custom = rel => { if (!policy) return false; try { return ownership.classify(policy, rel).owner === 'custom'; } catch { return false; } };
    let seen = 0;
    for (const c of componentsOf(root)) {
        if (custom(c.rel)) continue;                                   // custom code: the compromise case covers it
        const comp = { kind: c.kind, slug: c.slug, name: nameOf(c) };
        // (b) the words in names and headers
        if (WORD.test(c.slug)) res.signs.push({ kind: 'name', component: comp, file: c.rel, line: null, where: 'folder name', text: `${c.rel}: the folder name "${c.slug}" contains the word "${WORD.exec(c.slug)[1]}"` });
        for (const k of HEADER_FIELDS) { const v = c.headers[k]; if (v && WORD.test(v)) res.signs.push({ kind: 'name', component: comp, file: `${c.rel}${c.file ? '' : `/${c.main}`}`, line: null, where: `${k} header`, text: `${c.rel}${c.file ? '' : `/${c.main}`}: the "${k}" header ("${v.slice(0, 80)}") contains the word "${WORD.exec(v)[1]}"` }); }
        if (c.readme && WORD.test(c.readme.name)) res.signs.push({ kind: 'name', component: comp, file: `${c.rel}/${c.readme.file}`, line: null, where: 'readme name', text: `${c.rel}/${c.readme.file}: the name in the readme ("${c.readme.name.slice(0, 80)}") contains the word "${WORD.exec(c.readme.name)[1]}"` });
        for (const f of c.top) if (WORD.test(f)) res.signs.push({ kind: 'name', component: comp, file: `${c.rel}/${f}`, line: null, where: 'file name', text: `${c.rel}/${f}: the file name contains the word "${WORD.exec(f)[1]}"` });
        // (a) eval of an encoded string, in the component's PHP files
        const files = [];
        if (c.file) files.push([c.file, c.rel]);
        else (function walk(abs, rel) {
            let list; try { list = readdir(abs, { withFileTypes: true }); } catch { res.complete = false; return; }
            for (const e of list) {
                if (e.isSymbolicLink()) continue;
                const a = path.join(abs, e.name), r = `${rel}/${e.name}`;
                if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !SKIP_DIR_RE.test(e.name)) walk(a, r); continue; }
                if (e.isFile() && /\.(php|phtml|inc)$/i.test(e.name)) files.push([a, r]);
            }
        })(c.dir, c.rel);
        for (const [abs, rel] of files) {
            if (++seen > maxFiles) { res.complete = false; break; }
            let st; try { st = fs.statSync(abs); } catch { res.complete = false; continue; }
            if (st.size > MAX_FILE) { res.complete = false; continue; }
            let text; try { text = fs.readFileSync(abs, 'latin1'); } catch { res.complete = false; continue; }
            res.files_read++;
            if (!QUICK.test(text) || VENDOR_ENCODED.test(text.slice(0, 4096))) continue;
            const m = EVAL.re.exec(text);
            if (!m) continue;
            const line = text.slice(0, m.index).split('\n').length;
            const fn = m[1].toLowerCase(), dec = m[3].toLowerCase();
            res.signs.push({ kind: 'eval-encoded', component: comp, file: rel, line, where: 'code', text: `${rel}, line ${line}, contains ${fn}(${dec}(...)): it runs code that is hidden in an encoded string` });
        }
    }
    res.count = res.signs.length;
    res.files = [...new Set(res.signs.map(s => s.file))];
    res.lines = res.signs.slice(0, MAX_LISTED).map(s => `${s.text} (${label(s.component)}).`);
    if (res.signs.length > MAX_LISTED) res.lines.push(`And ${res.signs.length - MAX_LISTED} more.`);
    return res;
}

module.exports = { scan, componentsOf, WORD, EVAL_PATTERN_ID: EVAL.id, MAX_LISTED };
