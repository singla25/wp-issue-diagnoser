#!/usr/bin/env node
// `npm run guard:verify-knowledge`: check the hand-written knowledge (data/feature-taxonomy.json, data/known-conflicts.json) against the
// official pages it cites. An explicit, network-using command; nothing else in Plugin Guard fetches anything except guard:setup-ocr.
//
//   node scripts/verify-knowledge.js            fetch every cited page, write data/knowledge-verification.json, print what was and was not found
//   node scripts/verify-knowledge.js --apply --reviewed
//                                               copy the result into the two data files (verified, last_checked, verified/unverified signals).
//                                               --reviewed is YOUR statement that you read the excerpts in the verification file: without it
//                                               nothing is marked verified.
// A signal / claim counts as found when its text appears in the page text (tags removed). That is a check that the page was fetched and
// mentions it, not a proof that the page supports the sentence written in the entry; the excerpts are there so a person can judge that.

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const DATA = path.join(__dirname, '..', 'data');
const SET = path.join(DATA, 'known-settings.json');
const TAX = path.join(DATA, 'feature-taxonomy.json'), KB = path.join(DATA, 'known-conflicts.json'), OUT = path.join(DATA, 'knowledge-verification.json');
const HOSTS = /(^|\.)(woocommerce\.com|woocommerce\.github\.io|developer\.woocommerce\.com|wordpress\.org|developer\.wordpress\.org|make\.wordpress\.org|api\.jquery\.com|docs\.wp-rocket\.me|wp-rocket\.me|elementor\.com|developers\.elementor\.com|contactform7\.com|wpml\.org|docs\.litespeedtech\.com|polylang\.pro|wpforms\.com|docs\.wpvibes\.com|revolution\.themepunch\.com)$/;
const MAX = 8 * 1024 * 1024;
const SOURCE = /^https:\/\/plugins\.svn\.wordpress\.org\//;   // plugin source files: PHP, not HTML, so tags are not stripped
const today = () => new Date().toISOString().slice(0, 10);

function get(url, hops = 0) {
    return new Promise((resolve, reject) => {
        let u; try { u = new URL(url); } catch { return reject(new Error('invalid URL')); }
        if (u.protocol !== 'https:' || !HOSTS.test(u.hostname)) return reject(new Error(`host ${u.hostname} is not on the official-sites allowlist`));
        if (hops > 3) return reject(new Error('too many redirects'));
        https.get(u, { headers: { 'user-agent': 'plugin-guard-verify-knowledge', accept: 'text/html' }, timeout: 30000 }, res => {
            if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) { res.resume(); return resolve(get(new URL(res.headers.location, u).href, hops + 1)); }
            if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
            const chunks = []; let n = 0;
            res.on('data', c => { n += c.length; if (n > MAX) res.destroy(new Error('larger than 8 MB')); else chunks.push(c); });
            res.on('end', () => resolve({ body: Buffer.concat(chunks).toString('utf8'), final: u.href }));
            res.on('error', reject);
        }).on('error', reject).on('timeout', function () { this.destroy(new Error('timed out')); });
    });
}
const text = html => html.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ');
const norm = s => ` ${String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
const excerpt = (t, i, n) => t.slice(Math.max(0, i - 90), Math.min(t.length, i + n + 90)).trim();

// A signal only counts when it appears the way code or documentation would write that kind of thing; a plain word match is not enough
// ("checkout" or "gallery" appear in ordinary prose, "add_to_cart" is also a shortcode, "contact-form-7" is also a plugin slug).
const esc = n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function contextRe(kind, name) {
    const n = esc(name);
    switch (kind) {
        case 'shortcodes': return new RegExp(`\\[${n}[\\s\\]/]`, 'i');
        case 'ajax': return new RegExp(`(?:wc-ajax=|[?&]action=|wp_ajax_(?:nopriv_)?)${n}(?![\\w-])`, 'i');
        case 'handles': case 'cpts': return new RegExp(`['"\u2018\u2019\u201c\u201d]${n}['"\u2018\u2019\u201c\u201d]`, 'i');
        default: return new RegExp(`(?<![\\w-])${n}(?![\\w-])`, 'i');   // hooks, blocks, rest routes, templates, drop-ins: the identifier itself
    }
}
function findSignal(kind, name, pages) {
    const hits = [];
    for (const [url, p] of Object.entries(pages)) {
        if (!p.text) continue;
        if (kind === 'plugins') { const i = norm(p.text).indexOf(norm(name)); if (i >= 0) hits.push({ url, check: 'content', excerpt: excerpt(p.text, Math.max(0, p.text.toLowerCase().indexOf(String(name).toLowerCase().replace(/-/g, ' '))), name.length) }); continue; }
        const m = contextRe(kind, name).exec(p.text);
        if (m) hits.push({ url, check: 'content', excerpt: excerpt(p.text, m.index, name.length) });
    }
    return hits;
}
function findClaim(phrase, pages) {
    const hits = [];
    for (const [url, p] of Object.entries(pages)) { if (!p.text) continue; const i = p.text.toLowerCase().indexOf(String(phrase).toLowerCase()); if (i >= 0) hits.push({ url, excerpt: excerpt(p.text, i, phrase.length) }); }
    return hits;
}

async function main() {
    const tax = JSON.parse(fs.readFileSync(TAX, 'utf8')), kb = JSON.parse(fs.readFileSync(KB, 'utf8'));
    const settings = fs.existsSync(SET) ? JSON.parse(fs.readFileSync(SET, 'utf8')) : { entries: [] };
    if (process.argv.includes('--apply')) return apply(tax, kb, settings);

    const urls = [...new Set([...tax.entries.flatMap(e => e.sources.map(s => s.url)), ...kb.entries.flatMap(e => e.sources.map(s => s.url)), ...settings.entries.flatMap(e => e.evidence.map(x => x.url))])];
    const pages = {};
    for (const url of urls) {
        try { const r = await get(url); const t = SOURCE.test(url) ? r.body.replace(/\s+/g, ' ') : text(r.body); pages[url] = { status: 200, final_url: r.final, bytes: r.body.length, text_chars: t.length, sha256: crypto.createHash('sha256').update(t).digest('hex'), text: t }; console.log(`ok    ${url} (${t.length} chars of text)`); }
        catch (e) { pages[url] = { status: 0, error: e.message }; console.log(`FAIL  ${url}: ${e.message}`); }
        await new Promise(r => setTimeout(r, 400));
    }
    const res = { fetched_at: today(), method: 'signal / claim text found in the page text after removing tags (plugin source files: whitespace collapsed only); excerpts must be read by a person before --apply --reviewed', pages: {}, taxonomy: {}, kb: {}, settings: {} };
    // Official per-item pages, derived from the signal itself: a WordPress core hook has developer.wordpress.org/reference/hooks/<hook>/,
    // a plugin in the directory has wordpress.org/plugins/<slug>/. They are only tried for a signal the cited pages did not contain.
    const derived = async (url, name, plugin) => {
        if (!(url in pages)) {
            try { const r = await get(url); const t = text(r.body); pages[url] = { status: 200, final_url: r.final, text_chars: t.length, sha256: crypto.createHash('sha256').update(t).digest('hex'), text: t }; }
            catch (e) { pages[url] = { status: 0, error: e.message }; }
            await new Promise(r => setTimeout(r, 300));
        }
        const p = pages[url]; if (p.status !== 200) return [];
        if (plugin) return [{ url, check: 'exists', excerpt: `page exists in the official plugin directory (${p.final_url}); this proves the slug is real, not that the plugin provides the feature` }];
        const m = new RegExp(`(?<![\\w-])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'i').exec(p.text);
        if (!m) return [];
        const d = p.text.indexOf('Back to top');       // developer.wordpress.org reference pages: the official one-line description follows this marker
        return [{ url, check: 'content', excerpt: d >= 0 ? p.text.slice(d + 11, d + 200).trim() : excerpt(p.text, m.index, name.length) }];
    };
    for (const e of tax.entries) {
        const mine = Object.fromEntries(e.sources.map(s => [s.url, pages[s.url]]));
        const r = { sources_fetched: e.sources.filter(s => pages[s.url].status === 200).map(s => s.url), signals: {} };
        for (const [kind, list] of Object.entries(e.signals)) for (const name of list) {
            let hits = findSignal(kind, name, mine);
            if (!hits.length && kind === 'hooks' && !/^woocommerce|\//.test(name)) hits = await derived(`https://developer.wordpress.org/reference/hooks/${name}/`, name, false);
            if (!hits.length && kind === 'plugins') hits = await derived(`https://wordpress.org/plugins/${name}/`, name, true);
            (r.signals[kind] = r.signals[kind] || {})[name] = { found: hits.length > 0, check: hits[0] ? (hits[0].check || 'content') : null, in: hits.map(h => h.url), excerpt: hits[0] ? hits[0].excerpt : null };
        }
        res.taxonomy[e.id] = r;
    }
    for (const e of kb.entries) {
        const mine = Object.fromEntries(e.sources.map(s => [s.url, pages[s.url]]));
        const r = { sources_fetched: e.sources.filter(s => pages[s.url].status === 200).map(s => s.url), claims: {} };
        for (const c of [...new Set(e.claims)]) { const hits = findClaim(c, mine); r.claims[c] = { found: hits.length > 0, in: hits.map(h => h.url), excerpt: hits[0] ? hits[0].excerpt : null }; }
        res.kb[e.id] = r;
    }
    for (const e of settings.entries) {
        const r = { evidence: e.evidence.map(x => { const p = pages[x.url]; const hits = p && p.status === 200 ? findClaim(x.claim, { [x.url]: p }) : []; return { role: x.role, url: x.url, claim: x.claim, fetched: !!(p && p.status === 200), found: hits.length > 0, excerpt: hits[0] ? hits[0].excerpt : null }; }) };
        res.settings[e.id] = r;
    }
    res.pages = Object.fromEntries(Object.entries(pages).map(([u, p]) => [u, { status: p.status, error: p.error || null, final_url: p.final_url || null, text_chars: p.text_chars || 0, sha256: p.sha256 || null }]));
    fs.writeFileSync(OUT, JSON.stringify(res, null, 1) + '\n');
    console.log('\nTaxonomy (signals found in the cited pages):');
    for (const e of tax.entries) { const r = res.taxonomy[e.id]; const all = Object.entries(r.signals).flatMap(([k, m]) => Object.entries(m).map(([n, v]) => v.found)); console.log(`  ${e.id.padEnd(15)} ${all.filter(Boolean).length}/${all.length} signals found; pages fetched ${r.sources_fetched.length}/${e.sources.length}`); }
    console.log('\nKnowledge base (claim phrases found):');
    for (const e of kb.entries) { const r = res.kb[e.id]; const all = Object.values(r.claims); console.log(`  ${e.id.padEnd(40)} ${all.filter(c => c.found).length}/${all.length} claims; pages fetched ${r.sources_fetched.length}/${e.sources.length}${all.filter(c => !c.found).length ? `  MISSING: ${Object.entries(r.claims).filter(([, c]) => !c.found).map(([k]) => k).join(' | ')}` : ''}`); }
    console.log('\nSettings (every evidence claim must be found on its page):');
    for (const e of settings.entries) { const r = res.settings[e.id].evidence; console.log(`  ${e.id.padEnd(46)} ${r.filter(x => x.found).length}/${r.length} claims found${r.some(x => !x.fetched) ? '  (a page could not be fetched)' : ''}`); }
    console.log(`\nWrote ${OUT}. Read the excerpts in it; then:  node scripts/verify-knowledge.js --apply --reviewed`);
}

function apply(tax, kb, settings) {
    const v = JSON.parse(fs.readFileSync(OUT, 'utf8')), reviewed = process.argv.includes('--reviewed'), date = v.fetched_at;
    for (const e of tax.entries) {
        const r = v.taxonomy[e.id]; if (!r) continue;
        for (const s of e.sources) if (v.pages[s.url] && v.pages[s.url].status === 200) s.last_checked = date;
        e.verified_signals = {}; e.unverified_signals = {};
        e.existence_only_signals = {};
        for (const [kind, m] of Object.entries(r.signals)) {
            const f = Object.entries(m).filter(([, x]) => x.found && x.check !== 'exists').map(([n]) => n), ex = Object.entries(m).filter(([, x]) => x.found && x.check === 'exists').map(([n]) => n), nf = Object.entries(m).filter(([, x]) => !x.found).map(([n]) => n);
            if (f.length) e.verified_signals[kind] = f; if (ex.length) e.existence_only_signals[kind] = ex; if (nf.length) e.unverified_signals[kind] = nf;
        }
        e.last_checked = r.sources_fetched.length ? date : null;
        e.verified = reviewed && e.sources.length > 0 && Object.keys(r.signals).length > 0 && r.sources_fetched.length === e.sources.length && Object.keys(e.unverified_signals).length === 0 && Object.keys(e.existence_only_signals).length === 0;
        e.reviewed = reviewed && r.sources_fetched.length ? { date, by: 'excerpts read by the assistant in the session that ran this command' } : null;
    }
    for (const e of kb.entries) {
        const r = v.kb[e.id]; if (!r) continue;
        for (const s of e.sources) if (v.pages[s.url] && v.pages[s.url].status === 200) s.last_checked = date;
        const missing = Object.entries(r.claims).filter(([, c]) => !c.found).map(([k]) => k);
        e.claims_missing = missing; e.last_checked = r.sources_fetched.length ? date : null;
        e.verified = reviewed && e.sources.length > 0 && e.claims.length > 0 && r.sources_fetched.length === e.sources.length && missing.length === 0;
        e.reviewed = reviewed && r.sources_fetched.length ? { date, by: 'excerpts read by the assistant in the session that ran this command' } : null;
    }
    for (const e of settings.entries) {
        const r = v.settings && v.settings[e.id]; if (!r) continue;
        const missing = r.evidence.filter(x => !x.found).map(x => `${x.claim} @ ${x.url}`);
        e.claims_missing = missing; e.last_checked = r.evidence.every(x => x.fetched) ? date : null;
        e.verified = reviewed && r.evidence.length > 0 && r.evidence.every(x => x.fetched) && missing.length === 0;
        e.reviewed = reviewed && e.last_checked ? { date, by: 'excerpts read by the assistant in the session that ran this command' } : null;
    }
    fs.writeFileSync(TAX, JSON.stringify(tax, null, 2) + '\n'); fs.writeFileSync(KB, JSON.stringify(kb, null, 2) + '\n'); fs.writeFileSync(SET, JSON.stringify(settings, null, 1) + '\n');
    console.log(`Applied ${date}${reviewed ? ' (reviewed)' : ' WITHOUT --reviewed: nothing was marked verified'}.\n  taxonomy verified: ${tax.entries.filter(e => e.verified).length}/${tax.entries.length}; knowledge base verified: ${kb.entries.filter(e => e.verified).length}/${kb.entries.length}`);
}

main().catch(e => { console.error(`verify-knowledge failed: ${e.message}`); process.exit(2); });
