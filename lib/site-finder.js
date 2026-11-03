// Finds WordPress folders on this computer so the wizard can show a numbered list instead of asking for a path.
// Read-only and bounded: readdir/lstat only (file contents are never read), never follows a symlink, skips node_modules and dot-folders,
// depth 3 below each root, at most 200 directories listed per root, at most maxMs (2 s) in all. Deterministic order (path).
// A WordPress folder = contains wp-content with plugins/ and themes/ (then intake.resolveSite gives the real root).
//   findSites({ cwd, home, roots, maxDepth, maxMs, maxDirs, now, fsi }) -> [{ path, wpContent, group: 'near' | 'common' }]  ("near" = in or above the current folder)

const nodefs = require('fs');
const path = require('path');
const intake = require('./site-intake');

function defaultRoots(home) {
    const r = ['/var/www', '/srv/www', '/opt/lampp/htdocs', '/Applications/MAMP/htdocs'];
    if (home) r.push(path.join(home, 'public_html'), path.join(home, 'www'), path.join(home, 'sites'), path.join(home, 'Local Sites'));
    return r;
}

function findSites({ cwd = process.cwd(), home = require('os').homedir(), roots = null, maxDepth = 3, maxMs = 2000, maxDirs = 200, now = Date.now, fsi = nodefs } = {}) {
    const started = now();
    const timeUp = () => now() - started > maxMs;
    const isDirNoLink = p => { try { const s = fsi.lstatSync(p); return s.isDirectory() && !s.isSymbolicLink(); } catch { return false; } };
    const looksWp = d => isDirNoLink(path.join(d, 'wp-content')) && isDirNoLink(path.join(d, 'wp-content', 'plugins')) && isDirNoLink(path.join(d, 'wp-content', 'themes'));
    const found = new Map();   // real root -> { path, wpContent, group }
    const add = (d, group) => {
        const s = intake.resolveSite(d);
        if (!s.error && !found.has(s.root)) found.set(s.root, { path: s.root, wpContent: s.wpContent, group });
    };
    // breadth first below one start folder; the start itself counts as depth 0
    const scan = (start, group) => {
        let listed = 0;
        if (!isDirNoLink(start)) return;
        let level = [start];
        for (let depth = 0; depth <= maxDepth && level.length; depth++) {
            const next = [];
            for (const d of level) {
                if (timeUp() || listed >= maxDirs) return;
                let ents; try { ents = fsi.readdirSync(d, { withFileTypes: true }); } catch { continue; }
                listed++;
                if (ents.some(e => e.name === 'wp-content') && looksWp(d)) { add(d, group); continue; }   // a site: do not search inside it
                if (depth === maxDepth) continue;
                for (const e of ents.slice().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
                    if (!e.isDirectory() || e.isSymbolicLink()) continue;
                    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
                    next.push(path.join(d, e.name));
                }
            }
            level = next;
        }
    };
    // 1 the current folder and every folder above it (three lstat calls each), 2 the tree below the current folder, 3 the common web roots
    const c = path.resolve(cwd);
    for (let d = c; ; d = path.dirname(d)) { if (looksWp(d)) add(d, 'near'); if (path.dirname(d) === d) break; }
    scan(c, 'near');
    for (const r of (roots || defaultRoots(home))) scan(path.resolve(r), 'common');
    const all = [...found.values()];
    const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    return [...all.filter(s => s.group === 'near').sort(byPath), ...all.filter(s => s.group !== 'near').sort(byPath)];
}

module.exports = { findSites, defaultRoots };
