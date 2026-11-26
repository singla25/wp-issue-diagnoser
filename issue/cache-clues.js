// Case A of the cache clue (4p-1a): the live page answered with an ERROR and the answer shows signs that a cache served it. A clue, "possible, not confirmed": never a cause,
// never a hypothesis, never a status. It reads only what the probe already stored (page.status, page.text_flags, page.cache_signs: a fixed vocabulary, see probe/recorder.js
// cacheSigns). Nothing is requested. A page that was fine, or that has no sign, gives nothing; the report never says "no cache".
const ORDER = [['age_over_zero', () => 'the Age header is above 0'], ['x_cache', v => `X-Cache says ${v}`], ['cf_cache_status', v => `CF-Cache-Status says ${v}`], ['litespeed', v => `X-LiteSpeed-Cache says ${v}`], ['varnish', () => 'X-Varnish shows a hit']];
const SERVED = new Set(['hit', 'stale', 'expired']);

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
module.exports = { caseA, signsOf, isErrorPage };
