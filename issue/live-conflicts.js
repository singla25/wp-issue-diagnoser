// Known conflicts (data/known-conflicts.json) matched against a LIST OF PLUGIN NAMES. Pure and deterministic: no request, no file except the knowledge data file.
// Used in a run WITHOUT site files (issue/result.js) with the plugins whose FILES the live page loaded (issue/live-signals.js plugin_names). It takes ANY list of names,
// so other sources (a pasted plugin list, a Site Health text) can use it later; the words "the page loads files of" are NOT here: the caller passes them to the sentence builder.
// Names only, never versions. A hit is "possible, not confirmed": it is never a verdict, never a hypothesis, never a status.
// FAIL CLOSED: only the entry ids in ALLOWED can match, and only with a detector that reads nothing but a list of plugin names. Any other entry (also a new one added to the data
// file later) is ignored here until it is added to ALLOWED on purpose.

const kb = require('./kb');
const { okSlug } = require('./live-signals');

const ALLOWED = ['cache-plugin-with-elementor', 'multiple-full-page-cache-plugins', 'wp-rocket-with-incompatible-plugin'];   // fixed order = entry id order
const NAME_ONLY_DETECTORS = ['pair-installed', 'installed-set'];                                                           // these two read the plugin names and nothing else
const MAX_NAMES = 100, MAX_SHOWN = 3, MAX_PARTNERS = 3;
// A plugin name may match an entry only if the entry's OWN `claims` name that plugin (the phrase the source page was checked for). A name in the entry's list that no claim backs does not match,
// so a printed line is never wider than what the source was checked to say. The plugin the source page is about (params.a of a pair entry) is the subject and is not restricted.
// A name that is not in this map is never backed (fail closed).
const CLAIM_NAME = { 'litespeed-cache': 'LiteSpeed Cache', 'wp-rocket': 'WP Rocket', 'w3-total-cache': 'W3 Total Cache', 'wp-fastest-cache': 'WP Fastest Cache', 'wp-super-cache': 'WP Super Cache', 'wp-optimize': 'WP-Optimize', 'breeze': 'Breeze', 'fast-velocity-minify': 'Fast Velocity Minify', 'autoptimize': 'Autoptimize', 'perfmatters': 'Perfmatters' };
const backed = (e, slug) => !!CLAIM_NAME[slug] && Array.isArray(e.claims) && e.claims.includes(CLAIM_NAME[slug]);
const restrict = e => { const p = { ...(e.params || {}) }; if (Array.isArray(p.b)) p.b = p.b.filter(x => backed(e, x)); if (Array.isArray(p.slugs)) p.slugs = p.slugs.filter(x => backed(e, x)); return { ...e, params: p }; };
const PRIORITY = { 'pair-installed': 0, 'installed-set': 1 };   // pair entries print first (by id), then set entries (by id)

const hostOf = url => { try { return new URL(String(url)).hostname.replace(/^www\./, ''); } catch { return null; } };
const cleanText = (t, n = 2000) => String(t == null ? '' : t).replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

// names: any list of plugin folder names. opts.entries / opts.allowed exist for tests; the defaults are the data file and ALLOWED.
// -> { conflicts: [{ id, names:[main, ...partners], partners_more, causes, beyond_sources, sources:[{title,host,checked}], verified }] (at most 3, in id order), more }
function match(names, opts = {}) {
    const clean = [...new Set((Array.isArray(names) ? names : []).filter(okSlug))].sort().slice(0, MAX_NAMES);
    const allowed = Array.isArray(opts.allowed) ? opts.allowed : ALLOWED;
    const all = Array.isArray(opts.entries) ? opts.entries : kb.load();
    const entries = all.filter(e => e && allowed.includes(e.id) && NAME_ONLY_DETECTORS.includes(e.detector)).map(restrict);
    if (!clean.length || !entries.length) return { conflicts: [], more: 0 };
    const rank = id => PRIORITY[(entries.find(e => e.id === id) || {}).detector] ?? 9;
    const hits = kb.evaluate({ components: clean.map(slug => ({ kind: 'plugin', slug, path: null })) }, entries).filter(h => h && !h.error && Array.isArray(h.components) && h.components.length >= 2);
    const covered = new Set(), found = [];
    for (const h of hits.sort((a, b) => rank(a.id) - rank(b.id) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
        const comps = [...new Set(h.components.filter(okSlug))];
        // a lower-priority entry is skipped when every plugin it matched is already covered by an entry that prints (this also stops the same set from printing twice)
        if (comps.length < 2 || comps.every(c => covered.has(c))) continue;
        const shown = [comps[0], ...comps.slice(1, 1 + MAX_PARTNERS)];
        // only the names that are PRINTED (not the ones counted in "and N more") and only by an entry that prints (within the cap) cover a lower entry
        if (found.length < MAX_SHOWN) shown.forEach(c => covered.add(c));
        found.push({
            id: h.id, names: shown, partners_more: Math.max(0, comps.length - 1 - MAX_PARTNERS),
            causes: cleanText(h.causes), beyond_sources: h.beyond_sources ? cleanText(h.beyond_sources) : null, verified: !!h.verified,
            sources: (Array.isArray(h.sources) ? h.sources : []).map(x => ({ title: cleanText(x && x.title, 200), host: hostOf(x && x.url), checked: cleanText(x && x.last_checked, 20) || null })).filter(x => x.title && x.host)
        });
    }
    return { conflicts: found.slice(0, MAX_SHOWN), more: Math.max(0, found.length - MAX_SHOWN) };
}

module.exports = { match, CLAIM_NAME, ALLOWED, NAME_ONLY_DETECTORS, MAX_SHOWN, MAX_PARTNERS, MAX_NAMES };
