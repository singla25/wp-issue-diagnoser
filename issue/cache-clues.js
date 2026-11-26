// Case A of the cache clue (4p-1a): the live page answered with an ERROR and the answer shows signs that a cache served it. A clue, "possible, not confirmed": never a cause,
// never a hypothesis, never a status. It reads only what the probe already stored (page.status, page.text_flags, page.cache_signs: a fixed vocabulary, see probe/recorder.js
// cacheSigns). Nothing is requested. A page that was fine, or that has no sign, gives nothing; the report never says "no cache".
const ORDER = [['age_over_zero', () => 'the Age header is above 0'], ['x_cache', v => `X-Cache says ${v}`], ['cf_cache_status', v => `CF-Cache-Status says ${v}`], ['litespeed', v => `X-LiteSpeed-Cache says ${v}`], ['varnish', () => 'X-Varnish shows a hit']];
const SERVED = new Set(['hit', 'stale']);   // not 'expired': that copy was out of date and the origin answered again

// an error page: a status 400 to 599, or a page that carries the critical-error text: the SAME detector the rest of the report uses (issue/oracle.js flagsOf, the one behind the
// white-screen and critical-error-page checks); no new text check here
const oracle = require('./oracle');
const isErrorPage = p => !!p && p.loaded === true && ((Number(p.status) >= 400 && Number(p.status) < 600) || !!((oracle.flagsOf(p) || {}).critical));
// one page: the fixed words for its served-from-cache signs (a miss, a bypass or any other value is ignored here too, whatever the stored record holds)
function signsOf(p) {
    const cs = p && p.cache_signs && typeof p.cache_signs === 'object' ? p.cache_signs : {};
    const out = [];
    for (const [key, say] of ORDER) {
        const v = cs[key];
        if (key === 'age_over_zero' ? v === true : key === 'varnish' ? v === 'hit' : (typeof v === 'string' && SERVED.has(v))) out.push(say(v));
    }
    return out;
}
// pages: probe.json pages. -> { signs: [text], pages: n } or null
function caseA(pages) {
    const signs = [], seen = new Set();
    let n = 0;
    for (const p of Array.isArray(pages) ? pages : []) {
        if (!isErrorPage(p)) continue;
        const s = signsOf(p);
        if (!s.length) continue;
        n++;
        for (const t of s) if (!seen.has(t)) { seen.add(t); signs.push(t); }
    }
    return n ? { signs, pages: n } : null;
}

// Case B (4p-1b): the live page loaded FINE here, with no failed live check, but the reporter's description or screenshot text shows a browser error (a clue of lib/browser-error.js,
// the one table; certificate and SSL families are left out). Possible reasons only: an old answer kept by the browser, a problem that comes and goes, a login or a place. It never
// names one cause and asks for no request: the tool does not bypass a cache. pages: probe.json pages; clues: evidence clues; failedLive: the number of failed live check rows.
// -> { families: [id] } or null
const browserError = require('../lib/browser-error');
// probe: the probe.json object ({ pages, protection, unreachable, planned }). A probe that was STOPPED (protection, unreachable) or that completed fewer loads than planned is not
// "the page loaded fine": the other planned loads were never made, so the pages that were recorded say nothing about the rest.
function caseB({ pages, clues, failedLive = 0, probe = null } = {}) {
    const list = Array.isArray(pages) ? pages : [];
    if (probe && typeof probe === 'object') {
        if (probe.protection || probe.unreachable) return null;
        const planned = require('./probe-plan').plannedLoads(probe.planned);
        if (planned === null || list.filter(p => p && p.loaded === true).length < planned) return null;
    }
    if (!list.length || failedLive > 0 || !list.every(p => p && p.loaded === true && !isErrorPage(p))) return null;
    const families = [];
    for (const c of Array.isArray(clues) ? clues : []) {
        const fam = c && c.type === 'browser-error' && c.detail && typeof c.detail.family === 'string' ? c.detail.family : null;
        if (fam && !browserError.CERTIFICATE_OR_SSL.has(fam) && !families.includes(fam)) families.push(fam);
    }
    return families.length ? { families } : null;
}
module.exports = { caseA, caseB, signsOf, isErrorPage };
