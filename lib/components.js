// Everything WordPress loads from wp-content: plugins, themes, must-use plugins and drop-ins.
// Each component gets a unique `ref` (plugins use their slug; others are prefixed: theme:x, mu:x, dropin:x),
// the scanned PHP facts, and loc() to turn a file/line into a path relative to the WordPress root.

const fs = require('fs');
const readdir = require('./sorted-dir');
const path = require('path');
const { spawnSync } = require('child_process');
const { scanSource } = require('./php');
const { impliedDeps } = require('./implied');

const MAX_FILES = 2500;
const MAX_BYTES = 1.5 * 1024 * 1024;
const SKIP_DIRS = new Set(['node_modules', '.git', 'languages']);
const DROPINS = ['advanced-cache.php', 'db.php', 'object-cache.php', 'maintenance.php', 'sunrise.php', 'install.php', 'db-error.php', 'php-error.php', 'fatal-error-handler.php', 'blog-deleted.php', 'blog-inactive.php', 'blog-suspended.php'];

const HEADER_RE = /^[ \t/*#@]*Plugin Name:/mi;

function parseHeaders(head) {
    const get = key => {
        const m = new RegExp(`^[ \\t/*#@]*${key}:(.*)$`, 'mi').exec(head);
        return m ? m[1].replace(/\s*\*\/.*$/, '').trim() : null;
    };
    return {
        name: get('Plugin Name') || get('Theme Name'), version: get('Version'), requiresWp: get('Requires at least'),
        requiresPhp: get('Requires PHP'), requiresPlugins: (get('Requires Plugins') || '').split(',').map(s => s.trim()).filter(Boolean),
        updateUri: get('Update URI'), template: get('Template'), author: get('Author'), description: get('Description')
    };
}

function readHead(file, n = 8192) {
    const fd = fs.openSync(file, 'r');
    try {
        const buf = Buffer.alloc(n);
        return buf.toString('utf8', 0, fs.readSync(fd, buf, 0, n, 0));
    } finally {
        fs.closeSync(fd);
    }
}

function scanFile(raw, rel) {
    const s = scanSource(raw, rel);
    s.implied = impliedDeps(raw);
    return s;
}

function walkPhp(dir, out) {
    let entries;
    try { entries = readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
        if (out.length >= MAX_FILES) return;
        const full = path.join(dir, e.name);
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walkPhp(full, out); }
        else if (/\.(php|phtml|php5)$/i.test(e.name)) out.push(full);
    }
}

function build({ kind, slug, dir, mainFile, single, wpRoot, headerSource }) {
    const headers = parseHeaders(readHead(headerSource || mainFile));
    const files = [];
    if (single) files.push(mainFile); else walkPhp(dir, files);
    const scans = [];
    let truncated = files.length >= MAX_FILES;
    for (const f of files) {
        try {
            if (fs.statSync(f).size > MAX_BYTES) { truncated = true; continue; }
            scans.push(scanFile(fs.readFileSync(f, 'utf8'), path.relative(single ? path.dirname(f) : dir, f).split(path.sep).join('/')));
        } catch { truncated = true; }
    }
    const base = kind === 'mu' || kind === 'dropin' ? ['wp-content', kind === 'mu' ? 'mu-plugins' : ''] : ['wp-content', kind === 'theme' ? 'themes' : 'plugins'];
    const rel = (kind === 'mu' || kind === 'dropin') ? (single ? [] : [slug]) : [slug];
    return {
        kind, slug, ref: kind === 'plugin' ? slug : `${kind}:${slug}`, dir, main: path.basename(mainFile), single: !!single,
        ...headers, scans, truncated, mu: kind === 'mu',
        readmeExposed: ['readme.txt', 'readme.md', 'README.txt'].find(r => !single && fs.existsSync(path.join(dir, r))) || null,
        loc(file, line) {
            const p = [...base.filter(Boolean), ...rel, file].join('/');
            return line ? `${p}:${line}` : p;
        }
    };
}

function discover(wpRoot) {
    const out = { plugins: [], themes: [], mu: [], dropins: [] };
    const wc = path.join(wpRoot, 'wp-content');

    const pluginsDir = path.join(wc, 'plugins');
    if (fs.existsSync(pluginsDir)) {
        for (const e of readdir(pluginsDir, { withFileTypes: true })) {
            const full = path.join(pluginsDir, e.name);
            if (e.isSymbolicLink()) continue;
            if (e.isDirectory()) {
                let main;
                try { main = readdir(full).filter(f => /\.php$/i.test(f)).find(f => HEADER_RE.test(readHead(path.join(full, f)))); } catch { /* unreadable */ }
                if (main) out.plugins.push(build({ kind: 'plugin', slug: e.name, dir: full, mainFile: path.join(full, main), wpRoot }));
            } else if (/\.php$/i.test(e.name) && HEADER_RE.test(readHead(full)) && e.name !== 'index.php') {
                out.plugins.push(build({ kind: 'plugin', slug: e.name.replace(/\.php$/i, ''), dir: pluginsDir, mainFile: full, single: true, wpRoot }));
            }
        }
    }

    // mu-plugins: WordPress loads EVERY .php file directly in this folder, header or not.
    const muDir = path.join(wc, 'mu-plugins');
    if (fs.existsSync(muDir)) {
        for (const e of readdir(muDir, { withFileTypes: true })) {
            const full = path.join(muDir, e.name);
            if (e.isSymbolicLink()) continue;
            if (e.isFile() && /\.php$/i.test(e.name)) {
                const c = build({ kind: 'mu', slug: e.name.replace(/\.php$/i, ''), dir: muDir, mainFile: full, single: true, wpRoot });
                c.noHeader = !HEADER_RE.test(readHead(full));
                out.mu.push(c);
            } else if (e.isDirectory()) {
                const main = readdir(full).filter(f => /\.php$/i.test(f)).find(f => HEADER_RE.test(readHead(path.join(full, f))));
                const c = build({ kind: 'mu', slug: e.name, dir: full, mainFile: path.join(full, main || readdir(full).find(f => /\.php$/i.test(f)) || ''), wpRoot });
                c.loaderNeeded = true; // folders in mu-plugins only load when a loader file requires them
                if (c.scans.length) out.mu.push(c);
            }
        }
    }

    const themesDir = path.join(wc, 'themes');
    if (fs.existsSync(themesDir)) {
        for (const e of readdir(themesDir, { withFileTypes: true })) {
            const style = path.join(themesDir, e.name, 'style.css');
            if (e.isDirectory() && !e.isSymbolicLink() && fs.existsSync(style) && /^[ \t/*#@]*Theme Name:/mi.test(readHead(style))) {
                const main = fs.existsSync(path.join(themesDir, e.name, 'functions.php')) ? 'functions.php' : readdir(path.join(themesDir, e.name)).find(f => /\.php$/i.test(f));
                out.themes.push(build({ kind: 'theme', slug: e.name, dir: path.join(themesDir, e.name), mainFile: path.join(themesDir, e.name, main || 'style.css'), headerSource: style, wpRoot }));
            }
        }
    }

    for (const name of DROPINS) {
        const f = path.join(wc, name);
        if (fs.existsSync(f) && fs.statSync(f).isFile()) {
            const c = build({ kind: 'dropin', slug: name, dir: wc, mainFile: f, single: true, wpRoot });
            c.head = readHead(f, 4096);
            out.dropins.push(c);
        }
    }
    return out;
}

function wpVersion(wpRoot) {
    try {
        const t = fs.readFileSync(path.join(wpRoot, 'wp-includes', 'version.php'), 'utf8');
        const v = /\$wp_version\s*=\s*'([^']+)'/.exec(t);
        const l = /\$wp_local_package\s*=\s*'([^']+)'/.exec(t);
        return v ? { version: v[1], locale: l ? l[1] : 'en_US' } : null;
    } catch { return null; }
}

function phpVersion(override) {
    if (override) return { version: override, source: 'project setting' };
    const r = spawnSync('php', ['-r', 'echo PHP_VERSION;'], { encoding: 'utf8' });
    return r.status === 0 ? { version: r.stdout.trim(), source: 'this computer (may differ from the server)' } : null;
}

module.exports = { discover, wpVersion, phpVersion, parseHeaders, readHead, scanFile, DROPINS, HEADER_RE };
