// Plugin, theme and WordPress names and versions read from what the live probe ALREADY loaded. Pure and deterministic: no request, no file, no browser.
// Used in a run WITHOUT site files only (issue/result.js). Three sources, nothing else:
//   1. the addresses of the scripts and styles the page loaded (rec.assets): /wp-content/plugins/<slug>/ or /wp-content/themes/<slug>/ and the ?ver= value (it can be a cache number)
//   2. the generator meta tag (the WordPress version; it can be hidden or changed)
//   3. a small FIXED list of comment texts that some plugins print (COMMENTS below, each pinned by a sample in scripts/selftest-live-signals.js)
// Safety: a slug is only [A-Za-z0-9._-], a version only digits, dots, letters, "-" or "+" (at most 20 characters); anything else is dropped and never shown. A full address and
// every query value except `ver` are never kept. The scan and the lists are capped. The text of a page comment is matched by a fixed pattern and then thrown away.

const SLUG = /^(?!\.+$)[A-Za-z0-9._-]{1,60}$/;
const VERSION = /^[A-Za-z0-9.+-]{1,20}$/;
const WP_VERSION = /^[0-9]+(?:\.[0-9]+){1,3}(?:[-+][A-Za-z0-9.]{1,12})?$/;
const MAX_ASSETS = 500, MAX_COMMENTS = 100, MAX_COMMENT_CHARS = 300, MAX_PLUGINS = 5, MAX_VERSIONS = 3, MAX_NAMES = 100;

// The fixed comment list. `slug` is the plugin folder name on wordpress.org; `version` is the capture group, or null when the comment names no version.
const COMMENTS = [
    { slug: 'wordpress-seo', re: /This site is optimized with the Yoast SEO plugin v([A-Za-z0-9.+-]{1,20})\b/ },
    { slug: 'wordpress-seo-premium', re: /This site is optimized with the Yoast SEO Premium plugin v([A-Za-z0-9.+-]{1,20})\b/ },
    { slug: 'all-in-one-seo-pack', re: /^\s*All in One SEO(?: Pro)? ([0-9][A-Za-z0-9.+-]{0,19}) - aioseo\.com/ },
    { slug: 'wp-rocket', re: /Performance optimized by WP Rocket/, version: null },
    { slug: 'w3-total-cache', re: /Performance optimized by W3 Total Cache/, version: null },
    { slug: 'litespeed-cache', re: /Page optimized by LiteSpeed Cache/, version: null }
];

// a folder name that looks like a web address (www.x or ending in .com, .example ...) is refused: a report viewer could turn it into a link
const okSlug = s => typeof s === 'string' && SLUG.test(s) && !/^www\./i.test(s) && !/\.[A-Za-z]{2,}$/.test(s);
const okVersion = v => (typeof v === 'string' && VERSION.test(v) ? v : null);

// the part of an asset address we use: the kind, the slug and the ver value. Nothing else is returned.
function assetPart(url) {
    let u; try { u = new URL(String(url)); } catch { return null; }
    const m = /\/wp-content\/(plugins|themes)\/([^/]+)\//.exec(u.pathname);
    if (!m || !okSlug(m[2])) return null;
    return { kind: m[1] === 'themes' ? 'theme' : 'plugin', slug: m[2], version: okVersion(u.searchParams.get('ver')) };
}

// the browser side (probe/worker.js): the generator tag text and the page comments, cut. Returns only what matched, never the raw comments.
function fromPage(raw) {
    const out = { wordpress: null, comments: [] };
    if (!raw || typeof raw !== 'object') return out;
    for (const g of Array.isArray(raw.generators) ? raw.generators.slice(0, 20) : []) {
        const m = /^\s*WordPress\s+([0-9][A-Za-z0-9.+-]{0,19})\s*$/.exec(String(g).slice(0, 80));
        if (m && WP_VERSION.test(m[1])) { out.wordpress = m[1]; break; }
    }
    const seen = new Set();
    for (const c of Array.isArray(raw.comments) ? raw.comments.slice(0, MAX_COMMENTS) : []) {
        const t = String(c).slice(0, MAX_COMMENT_CHARS);
        for (const e of COMMENTS) {
            const m = e.re.exec(t);
            if (!m) continue;
            const version = e.version === null ? null : okVersion(m[1]);
            const key = `${e.slug}|${version}`;
            if (!seen.has(key)) { seen.add(key); out.comments.push({ slug: e.slug, version }); }
        }
    }
    return out;
}

// all loaded pages of probe.json (the real shape: pages[] with loaded, assets[{url,status}], context{plugins,themes}, signals{wordpress,comments}) -> one result
function collect(pages) {
    const plugins = new Map(), themes = new Map();
    let wordpress = null, scanned = 0, truncated = false;
    const add = (map, slug, v, src) => {
        if (!map.has(slug)) map.set(slug, { slug, loaded: false, versions: [] });
        const e = map.get(slug);
        if (src === 'asset') e.loaded = true;
        if (v && !e.versions.some(x => x.v === v && x.src === src)) e.versions.push({ v, src });
    };
    for (const p of Array.isArray(pages) ? pages : []) {
        if (!p || !p.loaded) continue;
        const assets = Array.isArray(p.assets) ? p.assets : [];
        if (assets.length > MAX_ASSETS) truncated = true;
        // only files from the address that was probed (a script from another site, for example an embed, is not a plugin of this site), and only files that were really loaded (status below 400)
        let origin = null; try { origin = new URL(String(p.url)).origin; } catch { origin = null; }
        for (const a of assets.slice(0, MAX_ASSETS)) {
            scanned++;
            if (!origin || !a || !(Number(a.status) < 400)) continue;
            let o = null; try { o = new URL(String(a.url)).origin; } catch { continue; }
            if (o !== origin) continue;
            const x = assetPart(a.url);
            if (x) add(x.kind === 'theme' ? themes : plugins, x.slug, x.version, 'asset');
        }
        // the names the page context stored (probe/wp.js pageContext) are NOT used: they come from every link and image of the page, whatever its status or host
        const sg = p.signals && typeof p.signals === 'object' ? p.signals : null;
        if (sg) {
            if (!wordpress && typeof sg.wordpress === 'string' && WP_VERSION.test(sg.wordpress)) wordpress = sg.wordpress;
            for (const c of Array.isArray(sg.comments) ? sg.comments.slice(0, 20) : []) if (c && okSlug(c.slug)) add(plugins, c.slug, okVersion(c.version), 'comment');
        }
    }
    const shape = list => list.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0)).map(e => {
        const vs = e.versions.slice().sort((a, b) => (a.src === b.src ? (a.v < b.v ? -1 : a.v > b.v ? 1 : 0) : a.src === 'asset' ? -1 : 1));
        return { slug: e.slug, versions: vs.slice(0, MAX_VERSIONS), versions_more: Math.max(0, vs.length - MAX_VERSIONS) };
    });
    // plugins whose files the page loaded; plugins only NAMED in a page comment (a cache plugin leaves a comment, not always a file) are kept apart, so "loads files of" stays true
    const all = [...plugins.values()], pl = shape(all.filter(e => e.loaded)), named = shape(all.filter(e => !e.loaded)), th = shape([...themes.values()]);
    // every plugin name whose files were loaded (names only, valid names, at most 100): the input of the known-conflict match (issue/live-conflicts.js); the display lists below stay capped
    const plugin_names = all.filter(e => e.loaded).map(e => e.slug).sort().slice(0, MAX_NAMES);
    return { wordpress, plugin_names, plugins: pl.slice(0, MAX_PLUGINS), plugins_more: Math.max(0, pl.length - MAX_PLUGINS), named_in_comments: named.slice(0, MAX_PLUGINS), named_in_comments_more: Math.max(0, named.length - MAX_PLUGINS), themes: th.slice(0, MAX_PLUGINS), themes_more: Math.max(0, th.length - MAX_PLUGINS), scanned_assets: scanned, truncated };
}

module.exports = { collect, fromPage, assetPart, COMMENTS, MAX_ASSETS, MAX_PLUGINS, MAX_VERSIONS, okSlug, okVersion, WP_VERSION };
