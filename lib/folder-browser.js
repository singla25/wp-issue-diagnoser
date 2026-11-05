// A drill-down folder browser for the wizard: instead of one long list of sites, each screen shows at most 9 folders (or sites) with the number of
// WordPress sites under each, "N of M shown", and "m" for the next 9. Typing a path is always allowed (accepted only if intake.resolveSite passes).
// Read-only and bounded, like lib/site-finder.js: readdir/lstat only (file contents are never read), no symlink is followed, node_modules and dot-folders are
// skipped, depth 3 below the folder being counted, at most maxDirs (200) directories listed per folder, at most maxMs (2 s) per screen. A count from a scan
// that hit the directory cap or the time limit is shown as "at least N". Deterministic order (name).
//   phpHint(sitePath)  '8.3' when a part of the path is named like a PHP version (74, 8.3, php83, php-8.3 ...); only a HINT, never a fact
//   browse({ list, roots, cwd, io: { say, ask }, abs, ... }) -> the intake.resolveSite result of the chosen site (the caller handles an ended input: ask() throws)

const nodefs = require('fs');
const path = require('path');
const intake = require('./site-intake');

const PAGE = 9;
const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const PHP_PART = /^(?:php[-_]?)?(7\.?4|8\.?[0-4])$/i;
function phpHint(p) {
    const parts = String(p || '').split(/[\\/]+/).filter(Boolean);
    for (let i = parts.length - 1; i >= 0; i--) {
        const m = PHP_PART.exec(parts[i]);
        if (m) { const d = m[1].replace('.', ''); return `${d[0]}.${d[1]}`; }
    }
    return null;
}

function browse({ list = [], roots = [], cwd = process.cwd(), io, abs = p => path.resolve(cwd, p), maxDepth = 3, maxMs = 2000, maxDirs = 200, now = Date.now, fsi = nodefs, pageSize = PAGE } = {}) {
    const isDirNoLink = p => { try { const s = fsi.lstatSync(p); return s.isDirectory() && !s.isSymbolicLink(); } catch { return false; } };
    const looksWp = d => isDirNoLink(path.join(d, 'wp-content')) && isDirNoLink(path.join(d, 'wp-content', 'plugins')) && isDirNoLink(path.join(d, 'wp-content', 'themes'));
    const skip = e => !e.isDirectory() || e.isSymbolicLink() || e.name === 'node_modules' || e.name.startsWith('.');
    let screenStart = now();
    const timeUp = () => now() - screenStart > maxMs;
    const children = d => { let ents; try { ents = fsi.readdirSync(d, { withFileTypes: true }); } catch { return []; } return ents.filter(e => !skip(e)).map(e => e.name).sort(byName); };
    // the sites below one folder (the folder itself counts as depth 0); capped = the directory cap or the time limit stopped the scan
    const scan = start => {
        const sites = []; let listed = 0, capped = false;
        if (!isDirNoLink(start)) return { sites, capped };
        let level = [start];
        for (let depth = 0; depth <= maxDepth && level.length; depth++) {
            const next = [];
            for (let i = 0; i < level.length; i++) {
                const d = level[i];
                if (timeUp() || listed >= maxDirs) { capped = true; return { sites, capped }; }
                let ents; try { ents = fsi.readdirSync(d, { withFileTypes: true }); } catch { continue; }
                listed++;
                if (ents.some(e => e.name === 'wp-content') && looksWp(d)) { sites.push(d); continue; }
                if (depth === maxDepth) continue;
                for (const e of ents.slice().sort((a, b) => byName(a.name, b.name))) if (!skip(e)) next.push(path.join(d, e.name));
            }
            level = next;
        }
        return { sites, capped };
    };
    const entryOf = (dir, label) => {
        if (looksWp(dir)) return { path: dir, label, site: true, count: 1, capped: false, sites: [dir] };
        const s = scan(dir);
        return { path: dir, label, site: false, count: s.sites.length, capped: s.capped, sites: s.sites };
    };
    const describe = e => (e.site ? 'WordPress site' : `${e.capped ? 'at least ' : ''}${e.count} WordPress site${e.count === 1 ? '' : 's'}`);

    const ask = async q => (await io.ask(q)).trim();
    // one level: `entries` already built. Returns a resolved site, or 'back'.
    const level = async (title, buildEntries, canGoBack, announce) => {
        screenStart = now();
        let entries = buildEntries().filter(e => e.site || e.count > 0 || e.capped);
        const total = entries.reduce((n, e) => n + e.count, 0), anyCapped = entries.some(e => e.capped);
        // few sites in all: show the sites themselves (what the flat list always did)
        if (!anyCapped && total <= pageSize && entries.some(e => !e.site)) {
            const sites = [].concat(...entries.map(e => e.sites)).sort(byName);
            entries = sites.map(p => ({ path: p, label: p, site: true, count: 1, capped: false, sites: [p] }));
        } else if (entries.length === 1 && !entries[0].site && announce !== false) {
            io.say(`Opening ${entries[0].path} (the only folder with WordPress sites in it).`);
            return { into: entries[0].path, auto: true };
        }
        let start = 0;
        const sitesOnly = entries.every(e => e.site);
        for (;;) {
            const shown = entries.slice(start, start + pageSize);
            io.say(title ? title : (sitesOnly ? 'I found these WordPress sites on this computer:' : 'WordPress sites on this computer, by folder:'));
            shown.forEach((e, i) => io.say(`  ${i + 1}) ${e.label}${e.site ? '' : `  (${describe(e)})`}`));
            const more = start + pageSize < entries.length;
            io.say(`  ${start + shown.length} of ${entries.length} shown${more ? ` · type m for the next ${Math.min(pageSize, entries.length - start - pageSize)}` : (entries.length > pageSize ? ' · type m to start again' : '')}${canGoBack ? ' · type b to go back' : ''}`);
            for (;;) {
                const a = await ask('Type the number, or type a path');
                if (!a) { io.say('    This one is needed: the code of the site is what gets analysed.'); continue; }
                if (/^m$/i.test(a) && entries.length > pageSize) { start = start + pageSize < entries.length ? start + pageSize : 0; break; }
                if (/^b$/i.test(a) && canGoBack) return 'back';
                if (/^\d+$/.test(a)) {
                    const n = Number(a);
                    if (n < 1 || n > shown.length) { io.say(`    There is no number ${a} in the list (1 to ${shown.length}). Try again, or type a path.`); continue; }
                    const e = shown[n - 1];
                    if (e.site) { const s = intake.resolveSite(e.path); if (!s.error) return s; io.say(`    ${s.error}`); continue; }
                    return { into: e.path };
                }
                const s = intake.resolveSite(abs(a));
                if (!s.error) return s;
                io.say(`    ${s.error}`);
            }
        }
    };

    return (async () => {
        // the first screen: the roots the finder looks in (the ones that exist) and the current folder; the single-site / none cases are handled by the caller
        const top = () => {
            const seen = new Set(), out = [];
            for (const r of [...roots, cwd]) { const d = path.resolve(r); if (!seen.has(d) && isDirNoLink(d)) { seen.add(d); out.push(d); } }
            const es = out.map(d => entryOf(d, d));
            for (const s of list) if (s.group === 'near' && !seen.has(s.path) && !es.some(e => e.sites.includes(s.path))) es.push({ path: s.path, label: s.path, site: true, count: 1, capped: false, sites: [s.path] });
            return es;
        };
        const stack = [];
        let r = await level(null, top, false, true);
        const autoTop = !!(r && r.into && r.auto);
        const below = (dir, canBack) => level(`${dir}:`, () => children(dir).map(n => entryOf(path.join(dir, n), n)), canBack, false);
        for (;;) {
            if (r && r.root) return r;
            if (r === 'back') {
                stack.pop();
                const prev = stack[stack.length - 1];
                r = prev ? await below(prev, !(autoTop && stack.length === 1)) : await level(null, top, false, false);
                continue;
            }
            if (r && r.into) { stack.push(r.into); r = await below(r.into, !(autoTop && stack.length === 1)); continue; }
            return null;
        }
    })();
}

module.exports = { browse, phpHint, PAGE };
