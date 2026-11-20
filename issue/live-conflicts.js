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

const hostOf = url => { try { return new URL(String(url)).hostname.replace(/^www\./, ''); } catch { return null; } };
const cleanText = (t, n = 2000) => String(t == null ? '' : t).replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

// names: any list of plugin folder names. opts.entries / opts.allowed exist for tests; the defaults are the data file and ALLOWED.
// -> { conflicts: [{ id, names:[main, ...partners], partners_more, causes, beyond_sources, sources:[{title,host,checked}], verified }] (at most 3, in id order), more }
function match(names, opts = {}) {
    const clean = [...new Set((Array.isArray(names) ? names : []).filter(okSlug))].sort().slice(0, MAX_NAMES);
    const allowed = Array.isArray(opts.allowed) ? opts.allowed : ALLOWED;
    const all = Array.isArray(opts.entries) ? opts.entries : kb.load();
    const entries = all.filter(e => e && allowed.includes(e.id) && NAME_ONLY_DETECTORS.includes(e.detector));
    if (!clean.length || !entries.length) return { conflicts: [], more: 0 };
    const hits = kb.evaluate({ components: clean.map(slug => ({ kind: 'plugin', slug, path: null })) }, entries).filter(h => h && !h.error && Array.isArray(h.components) && h.components.length >= 2);
    const seen = new Set(), found = [];
    for (const h of hits.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
        const comps = [...new Set(h.components.filter(okSlug))];
        const key = comps.slice().sort().join('|');
        if (comps.length < 2 || seen.has(key)) continue;                     // the same set of plugins is never listed twice (the first entry in id order wins)
        seen.add(key);
        found.push({
            id: h.id, names: [comps[0], ...comps.slice(1, 1 + MAX_PARTNERS)], partners_more: Math.max(0, comps.length - 1 - MAX_PARTNERS),
            causes: cleanText(h.causes), beyond_sources: h.beyond_sources ? cleanText(h.beyond_sources) : null, verified: !!h.verified,
            sources: (Array.isArray(h.sources) ? h.sources : []).map(x => ({ title: cleanText(x && x.title, 200), host: hostOf(x && x.url), checked: cleanText(x && x.last_checked, 20) || null })).filter(x => x.title && x.host)
        });
    }
    return { conflicts: found.slice(0, MAX_SHOWN), more: Math.max(0, found.length - MAX_SHOWN) };
}

module.exports = { match, ALLOWED, NAME_ONLY_DETECTORS, MAX_SHOWN, MAX_PARTNERS, MAX_NAMES };
