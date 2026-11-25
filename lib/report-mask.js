// Masking for the SHAREABLE report files (4a): the website address of the reporter, email addresses and IP addresses are replaced when the report is WRITTEN
// (issue/result.js), never while the probe runs and never in the working data under work/ (retest and `issue show` need the real address there).
// What is masked:
//   - the host of the issue's address and of its page addresses, with or without scheme, "www." or any sub-domain, and with or without a port:
//     "https://www.acme-shop.example:8080/checkout/" becomes "[site address]/checkout/" (the PATH stays: the person needs the page names);
//   - email addresses and IPv4 / IPv6 addresses, with the SAME rules as lib/feedback.js (MASKS is reused, not copied).
// What is NOT masked: loopback hosts and addresses (localhost, 127.0.0.0/8, ::1) and any other domain-like text: a pattern for "anything that looks like a host" is
// used only for screenshot (OCR) text (4a-3), nowhere else.
// Best effort and pattern based: a name that is split, spelt in a different way or typed in a picture can remain. Nothing here claims that everything was removed.
const { MASKS } = require('./feedback');

// the made-up addresses of the tool's own test copy (user<ID>@example.invalid, pgadmin@example.invalid, admin@example.invalid) are not personal data and are part of what the
// report says about the copy: they are kept
const keepToolEmail = m => (/@example\.invalid$/i.test(m) ? m : EMAIL_RULE[2]);
const SITE_ADDRESS = '[site address]';
// shown in the Limits list of a report in which something was masked (never claims that everything was removed)
const NOTE = 'Masking is best effort and pattern based; names can remain.';
const IP_TEXT = '[IP address removed]';
const EMAIL_RULE = MASKS.find(m => m[0] === 'email address'), IP_RULES = MASKS.filter(m => /^IPv[46] address$/.test(m[0]));

const isLoopbackHost = h => { const x = String(h || '').toLowerCase().replace(/^\[|\]$/g, ''); return x === 'localhost' || x.endsWith('.localhost') || x === '::1' || /^127(?:\.\d{1,3}){3}$/.test(x); };
// an IP found in text: loopback ones are left as they are
const isLoopbackIp = s => /^127(?:\.\d{1,3}){3}$/.test(s) || /^(?:0{1,4}:){7}0{0,3}1$/.test(s) || s === '::1';
const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'gov', 'edu', 'ac']);   // the parent of acme.co.uk is co.uk, not a site
// shared hosting platforms: the platform name itself is never masked as a parent (the site's own host is)
const PLATFORMS = new Set(['wordpress.com', 'wordpress.org', 'github.io', 'wpengine.com', 'wpenginepowered.com', 'pantheonsite.io', 'kinsta.cloud', 'netlify.app', 'vercel.app', 'herokuapp.com',
    'azurewebsites.net', 'cloudwaysapps.com', 'flywheelsites.com', 'amazonaws.com', 'cloudfront.net', 'appspot.com', 'pages.dev', 'workers.dev', 'myshopify.com', 'wixsite.com', 'squarespace.com', 'blogspot.com', 'wpcomstaging.com']);
const esc = h => h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// the hosts to mask: from the issue's address and its page addresses. Not loopback, not an IP (an IP is masked by the IP rule), no leading "www.".
function hostsOf(issue) {
    const out = new Set();
    for (const v of [issue && issue.url, ...((issue && issue.pages) || [])]) {
        try {
            const u = new URL(String(v));
            if (!/^https?:$/.test(u.protocol)) continue;
            const h = u.hostname.toLowerCase().replace(/\.+$/, '').replace(/^www\./, '');   // a trailing dot (acme.example.) is the same host
            if (h && h.includes('.') && !isLoopbackHost(h) && !/^[\d.]+$/.test(h) && !h.includes(':')) {
                out.add(h);
                try { const uni = require('url').domainToUnicode(h); if (uni && uni !== h) out.add(uni.toLowerCase()); } catch { /* keep the punycode form only */ }   // an address with non-ASCII letters is written both ways
            }
        } catch { /* a page path ("/shop/") has no host */ }
    }
    // a sub-domain address (shop.acme.example) also masks every parent down to two labels (acme.example), unless the parent is only a public suffix (co.uk)
    // or a shared platform that the report text may name for other reasons (wordpress.com, github.io ...)
    for (const h of [...out]) {
        const labels = h.split('.');
        for (let i = 1; labels.length - i >= 2; i++) { const parent = labels.slice(i).join('.'); if (!(labels.length - i === 2 && SECOND_LEVEL.has(labels[i])) && !PLATFORMS.has(parent)) out.add(parent); }
    }
    return [...out].sort((a, b) => b.length - a.length || a.localeCompare(b));
}
// at most 6 leading labels (so a long "a.a.a.a" text cannot make the match slow). The host may start after a percent-encoded character (%2F in a redirect
// address), after "_" (not a host character), and its dots may be written %2E.
const siteRe = h => new RegExp(`(?:(?<![A-Za-z0-9-])|(?<=%[0-9A-Fa-f]{2}))(?:https?:\\/\\/)?(?:[A-Za-z0-9-]+(?:\\.|%2[Ee])){0,6}${esc(h).replace(/\\\./g, '(?:\\.|%2[Ee])')}(?::\\d{1,5})?(?![A-Za-z0-9-])`, 'gi');

// emails: word by word. A word over 320 characters (no email address is that long) is searched only around each "@" (up to 64 characters before, 260 after),
// so a long run of letters cannot make the rule slow and an email inside a long address is still found.
function maskEmails(t) {
    return t.replace(/\S+/g, w => {
        if (!w.includes('@')) return w;
        if (w.length <= 320) return w.replace(EMAIL_RULE[1], keepToolEmail);
        // windows around every '@' (64 before, 260 after), overlapping windows merged, so an email at a window edge is never cut
        const win = []; for (let at = w.indexOf('@'); at !== -1; at = w.indexOf('@', at + 1)) { const a = Math.max(0, at - 64), b = Math.min(w.length, at + 260); if (win.length && a <= win[win.length - 1][1]) win[win.length - 1][1] = Math.max(win[win.length - 1][1], b); else win.push([a, b]); }
        let out = '', pos = 0;
        for (const [a, b] of win) { out += w.slice(pos, a) + w.slice(a, b).replace(EMAIL_RULE[1], keepToolEmail); pos = b; }
        return out + w.slice(pos);
    });
}
const MAPPED = /(?<![\w:])::ffff:((?:\d{1,3}\.){3}\d{1,3})(?![\w])/gi;   // an IPv4 address written as IPv6
function text(value, { hosts = [], noIp = false } = {}) {
    let t = String(value == null ? '' : value);
    if (!t) return t;
    // each rule runs only when its trigger character is there (cheap, and it keeps a long text with no such character fast)
    if (t.includes('@')) t = maskEmails(t);                                     // email first: an address may contain the site host
    const low = t.toLowerCase();
    for (const h of hosts) if (low.includes(h) || low.includes(h.replace(/\./g, '%2e'))) t = t.replace(siteRe(h), SITE_ADDRESS);
    if (t.includes('\u0000')) t = t.replace(/\u0000/g, '');                    // the placeholder below uses NUL: a NUL in the text is dropped first
    const kept = [];                                                            // loopback addresses are set aside, so no later rule can cut them
    const keep = m => { kept.push(m); return `\u0000${kept.length - 1}\u0000`; };
    if (/::ffff:/i.test(t)) t = t.replace(MAPPED, (m, v4) => (isLoopbackIp(v4) ? keep(m) : IP_TEXT));
    for (const [kind, re, to] of IP_RULES) {
        if (kind === 'IPv6 address' ? !t.includes(':') : !/\d\.\d/.test(t)) continue;
        // an IPv6 match with no digit is a name, not an address (PHP "Feed::add", "a::b"): left alone
        t = t.replace(re, (m, off, str) => (isLoopbackIp(m) ? keep(m)
            : kind === 'IPv6 address' && !/\d/.test(m) ? keep(m)
            : kind === 'IPv4 address' && (noIp || /(?:^|[^A-Za-z])(?:version|ver\.?|v\.?|release|rev\.?)\s*[:=]?\s*$/i.test(str.slice(Math.max(0, off - 12), off))) ? keep(m)   // a version number (WooCommerce 8.9.1.0) looks like an address
            : to));
    }
    if (kept.length) t = t.replace(/\u0000(\d+)\u0000/g, (m, i) => kept[Number(i)]);
    return t;
}
// every string of a value (keys are left as they are); a new copy
function deep(v, ctx, seen = new WeakSet(), depth = 0, key = '') {
    // the value of a key named like a version (version, plugin_version, required_php_version ...) is never read as an IPv4 address
    if (typeof v === 'string') return text(v, /version/i.test(key) ? { ...ctx, noIp: true } : ctx);
    if (Array.isArray(v) || (v && typeof v === 'object')) {
        if (seen.has(v)) return '[circular]';
        if (depth > 200) return '[too deep]';
        seen.add(v);
        let out;
        if (Array.isArray(v)) out = v.map(x => deep(x, ctx, seen, depth + 1, key));
        else { out = {}; for (const k of Object.keys(v)) Object.defineProperty(out, k, { value: deep(v[k], ctx, seen, depth + 1, k), enumerable: true, writable: true, configurable: true }); }
        seen.delete(v);
        return out;
    }
    return v;
}

// ---------------------------------------------------------------- the text read from a screenshot (OCR), 4a-3
// OCR text can hold the site name in a damaged form ("ACME - SHOP", "acme.shop"). Best effort and pattern based, and ONLY for OCR text:
//   - the host rules of text() (a clean host, email, IP);
//   - the NAME of the site (the host labels without the ending): ignoring case, with up to 3 spaces, dots or hyphens allowed between two letters;
//     a name shorter than 5 letters and the common words in OCR_STOP are never used;
//   - anything that looks like a website name (letters, dots, a common ending such as .com or .shop), because a screenshot of a browser shows the address bar;
//     a few well-known hosts (wordpress.org, github.com ...) are left alone. This pattern is NOT used for any other text.
// Simple on purpose: no letter/digit look-alike rules (0/o, 1/l, rn/m). A name that OCR read badly can remain. Nothing here claims that everything was removed.
const OCR_STOP = new Set(['wordpress', 'plugin', 'theme', 'local', 'localhost', 'admin', 'staging', 'demo', 'test', 'shop', 'blog', 'site']);
// Website-like text in OCR. The ENDING must be written in lower case (a screenshot of an address bar is lower case; "Error.In file" or "Settings.Me" is a sentence that lost
// its space). STRONG endings count on their own. WEAK endings (country codes and common words: de, it, in, no, me, co, info, store, site ...) count only with a clear sign that
// it is an address: "://" or "www." before it, or "/" or ":<port>" after it. The first name before the ending starts with a letter (so "6.5.it" and "v1.2.co" are not addresses).
const STRONG = 'com|net|org|io|shop|xyz|biz|example|invalid';
const WEAK = 'co|uk|de|fr|nl|es|it|au|ca|in|us|info|store|online|site|me|eu|ch|at|be|se|no|dk|pl|ru|br|jp|cn|dev|app|test|local';   // dev, app, test and local are also code words (window.app, config.local)
const KNOWN_HOSTS = new Set(['wordpress.org', 'wordpress.com', 'w.org', 'github.com', 'gravatar.com', 'google.com', 'googleapis.com', 'gstatic.com', 'cloudflare.com', 'jquery.com', 'php.net', 'mysql.com', 'wp.com']);
const DOMAIN_LIKE = new RegExp(`(?<![\\p{L}\\p{N}@._-])(?:\\p{L}[\\p{L}\\p{N}-]{0,40}\\.){1,5}(${STRONG}|${WEAK})(?![A-Za-z0-9-])`, 'gu');
function siteTokens(hosts) {
    const out = new Set();
    for (const h of hosts || []) {
        let host = String(h).toLowerCase(); try { host = require('url').domainToUnicode(host) || host; } catch { /* keep as it is */ }
        const labels = host.split('.');
        // a shared platform ends the site's own name: for acme.myshopify.com only "acme" is the name, never "myshopify"
        for (let i = 0; i < labels.length; i++) if (PLATFORMS.has(labels.slice(i).join('.'))) { labels.length = i; labels.push('x'); break; }
        labels.pop();
        if (labels.length > 1 && SECOND_LEVEL.has(labels[labels.length - 1])) labels.pop();
        for (const l of labels) { const c = l.replace(/[^\p{L}\p{N}]/gu, ''); if (c.length >= 5 && c.length <= 30 && c !== 'www' && !OCR_STOP.has(c)) out.add(c); }
    }
    return [...out].sort((a, b) => b.length - a.length);
}
// not inside a file name or a code word: nothing but a space or a slash before the name (no "-" or "_"), and no "_", "-" or file ending after it ("class-wc-orders.php" keeps "orders")
const tokenRe = tok => new RegExp(`(?<![\\p{L}\\p{N}_-])${[...tok].map(ch => esc(ch)).join('[\\s.\\-]{0,3}')}(?![\\p{L}\\p{N}_-]|\\.(?:php|js|css|html?|json|txt|log|png|jpe?g|gif|svg|webp)\\b)`, 'giu');
function ocrText(value, ctx = {}) {
    let t = text(value, ctx);
    if (!t) return t;
    t = t.replace(DOMAIN_LIKE, (m, ending, off, str) => {
        if (KNOWN_HOSTS.has(m.toLowerCase())) return m;
        if (new RegExp(`^(?:${STRONG})$`).test(ending)) return SITE_ADDRESS;
        const before = str.slice(Math.max(0, off - 3), off), after = str.slice(off + m.length, off + m.length + 2);
        return before === '://' || /^www\./i.test(m) || /^\/|^:\d/.test(after) ? SITE_ADDRESS : m;   // a weak ending needs "://" or "www." before it, or "/" or ":port" after it
    });   // whole names first, so "acmeshop.com" leaves no ".com" behind
    // the name pass never reads the placeholders of the earlier passes (a site called "siteaddress" must not turn "[site address]" into "[[site address]]")
    for (const tok of siteTokens(ctx.hosts)) { const re = tokenRe(tok); t = t.split(SITE_ADDRESS).map(part => part.replace(re, SITE_ADDRESS)).join(SITE_ADDRESS); }
    return t;
}
// a copy of a findings object in which the OCR text fields are masked with ocrText: reported.images[].ocr_text and the supports / texts of kind "ocr"
function maskOcrFields(v, ctx, seen = new WeakSet(), depth = 0) {
    if (!v || typeof v !== 'object' || depth > 200 || seen.has(v)) return v;
    seen.add(v);
    if (Array.isArray(v)) { const a = v.map(x => maskOcrFields(x, ctx, seen, depth + 1)); seen.delete(v); return a; }
    const o = {};
    for (const k of Object.keys(v)) {
        const x = v[k];
        Object.defineProperty(o, k, { value: (k === 'ocr_text' && typeof x === 'string') || (k === 'text' && typeof x === 'string' && v.kind === 'ocr') ? ocrText(x, ctx) : maskOcrFields(x, ctx, seen, depth + 1), enumerable: true, writable: true, configurable: true });
    }
    seen.delete(v);
    return o;
}
module.exports = { text, deep, hostsOf, isLoopbackHost, isLoopbackIp, SITE_ADDRESS, NOTE, ocrText, maskOcrFields, siteTokens, OCR_STOP };
