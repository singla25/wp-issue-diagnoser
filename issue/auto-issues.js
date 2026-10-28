// Auto-issues: turn the reproducible failures that Agent 1 (the frontend agent) observed into issues, with no human description.
//   - Only four classes of failure qualify, each with ONE generic oracle:
//       a console / page error ........ console-error   (the error text; digits become \d+)
//       a missing or failed asset ..... request-failed  (the asset's path)
//       a page answered with HTTP 5xx . http-5xx
//       horizontal overflow ........... no-hscroll      (at the width it was seen at)
//   - Third-party failures, rate-limit / protection answers, blocked checks and every other kind of finding (typography, SEO ...) do not qualify;
//     they are listed as skipped with the reason.
//   - Duplicates are grouped by a fingerprint of (oracle type, normalised value); the pages and viewports are merged.
//   - Ranked by the frontend's severity, then by class, then by how often it was seen; capped (default 5). Deterministic: same input, same issues.
//   - Nothing is invented: the title is made of the finding's own title and the evidence values; the description stays empty; the issue is marked
//     auto_generated with the fingerprint and the frontend finding ids it came from.
const crypto = require('crypto');
const store = require('../lib/issue-store');

const SEV_RANK = { P0: 0, P1: 1, P2: 2, P3: 3 };
const CLASS_RANK = { 'http-5xx': 0, 'request-failed': 1, 'console-error': 2, 'no-hscroll': 3 };
const QUALIFYING = new Set(['CONFIRMED WEBSITE ISSUE', 'POSSIBLE ISSUE']);
const MAX_PAGES = 10;
const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const one = s => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();

// the text of a console / page error as a pattern that matches the same error with other numbers in it
function errorPattern(actual) {
    let t = one(actual).replace(/^Uncaught(?: \(in promise\))?:?\s*/i, '').replace(/\s+—.*$/, '').slice(0, 120).trim();
    if (!t) return null;
    if (/\d/.test(t)) { const re = 're:' + t.split(/(\d+)/).map((p, i) => (i % 2 ? '\\d+' : reEsc(p).replace(/\s+/g, '\\s+'))).join(''); if (re.length <= 190) return re; t = t.replace(/\d.*$/, '').trim(); if (!t) return null; }
    return t;
}
const pathOf = (u, origin) => { try { const x = new URL(u, origin); return x.origin === origin ? x.pathname + x.search : null; } catch { return null; } };

// -> { oracle:{type,value}, symptom, why } | { skip: reason }
function classify(f, origin) {
    const o = f.original || {}, occ = o.occurrences || [], first = occ[0] || {};
    if (f.finding_type === 'access-restriction' || f.status === 'BLOCKED' || o.classification === 'RATE LIMITING / SITE PROTECTION') return { skip: 'blocked by the site\'s protection or rate limiting: not a failure of the site' };
    if (o.classification === 'THIRD-PARTY ISSUE' || f.category === 'third-party') return { skip: 'a third-party failure: not something this site\'s plugins can be bisected for' };
    if (!QUALIFYING.has(o.classification)) return { skip: `a ${String(o.classification || 'review').toLowerCase()} finding, not a reproducible failure` };
    const actual = one(f.actual_behavior || f.description || first.actual);
    if (/^Horizontal overflow/i.test(f.title)) {
        const vp = occ.map(x => /(\d{3,4})x\d+/.exec(x.viewport || '')).find(Boolean) || /(\d{3,4})x\d+/.exec(f.title);
        const w = vp ? Number(vp[1]) : null;
        return w && w >= 280 ? { oracle: { type: 'no-hscroll', value: String(w) }, symptom: 'layout' } : { skip: 'horizontal overflow without a known viewport width' };
    }
    if (f.category === 'console' && !/^PHP error/i.test(f.title)) { const v = errorPattern(first.actual || actual); return v ? { oracle: { type: 'console-error', value: v }, symptom: 'js-error' } : { skip: 'a console error with no text' }; }
    const m5 = /^HTTP (5\d\d)\b/.exec(actual) || /^HTTP (5\d\d)\b/.exec(first.actual || '');
    if (m5 && !/^(Missing|Third-party)/.test(f.title) && f.category !== 'assets') return { oracle: { type: 'http-5xx', value: null }, symptom: 'white-screen' };
    if (f.category === 'assets' || /^(Missing |Request failed|Broken images)/.test(f.title)) {
        const url = (/https?:\/\/[^\s"')]+/.exec(`${actual} ${first.actual || ''} ${(f.evidence || []).join(' ')}`) || [])[0];
        const p = url && pathOf(url, origin);
        return p ? { oracle: { type: 'request-failed', value: p.split('?')[0] }, symptom: 'other' } : { skip: 'an asset failure on another host or without an address' };
    }
    return { skip: 'not one of the four failure classes (console error, failed asset, HTTP 5xx, horizontal overflow)' };
}

function derive(findings, { url, max = 5 } = {}) {
    const origin = new URL(url).origin;
    const groups = new Map(), skipped = [];
    for (const f of findings.filter(x => x.source_agent === 'user-frontend')) {
        const c = classify(f, origin);
        if (c.skip) { skipped.push({ finding: f.id, title: f.title, reason: c.skip }); continue; }
        const norm = String(c.oracle.value || '').toLowerCase().replace(/\d+/g, 'N');
        const fp = crypto.createHash('sha1').update(`${c.oracle.type}|${norm}`).digest('hex').slice(0, 12);
        const o = f.original || {}, occ = o.occurrences || [];
        const g = groups.get(fp) || { fp, oracle: c.oracle, symptom: c.symptom, severity: 'P3', title: f.title, pages: [], viewports: new Set(), occurrences: 0, ids: [], titles: new Set() };
        if ((SEV_RANK[o.severity] ?? 3) < SEV_RANK[g.severity]) g.severity = o.severity;
        for (const x of occ.length ? occ : [{ url: f.url }]) { const p = pathOf(x.url || f.url, origin); if (p && !g.pages.includes(p) && g.pages.length < MAX_PAGES) g.pages.push(p); if (x.viewport) g.viewports.add(String(x.viewport).split(' ')[0]); }
        g.occurrences += o.pages || occ.length || 1; g.ids.push(f.id); g.titles.add(f.title);
        groups.set(fp, g);
    }
    const ranked = [...groups.values()].sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || CLASS_RANK[a.oracle.type] - CLASS_RANK[b.oracle.type] || b.occurrences - a.occurrences || (a.fp < b.fp ? -1 : 1));
    const kept = ranked.slice(0, Math.max(0, max));
    for (const g of ranked.slice(kept.length)) skipped.push({ finding: g.ids[0], title: g.title, reason: `over the cap of ${max} auto-issues (ranked ${ranked.indexOf(g) + 1} of ${ranked.length})` });
    const issues = kept.map(g => {
        const what = g.oracle.type === 'console-error' ? `“${g.oracle.value.replace(/^re:/, '').replace(/\\s\+/g, ' ').replace(/\\d\+/g, '#').replace(/\\(.)/g, '$1').slice(0, 60)}”` : g.oracle.type === 'request-failed' ? g.oracle.value.slice(0, 70) : g.oracle.type === 'no-hscroll' ? `at ${g.oracle.value}px` : '';
        const where = g.pages[0] ? ` on ${g.pages[0]}${g.pages.length > 1 ? ` (+${g.pages.length - 1} more)` : ''}` : '';
        return { fingerprint: g.fp, title: `[auto] ${[...g.titles][0]}${what ? ': ' + what : ''}${where}`.slice(0, 120), symptom: g.symptom, oracle: g.oracle, pages: g.pages.length ? g.pages : ['/'], viewports: [...g.viewports].sort(), severity: g.severity, occurrences: g.occurrences, frontend_ids: g.ids.sort() };
    });
    return { issues, skipped, considered: findings.filter(x => x.source_agent === 'user-frontend').length, groups: ranked.length, max };
}

// -> the stored issues (issue.json), created through the normal store so every limit and check applies
function create(specs, { root, environment, url, authorized = false } = {}) {
    return specs.map(s => store.create({ title: s.title, description: '', symptom: s.symptom, environment, url, root, pages: s.pages, oracle: s.oracle, authorized, auto: { fingerprint: s.fingerprint, source: 'frontend-agent', occurrences: s.occurrences, severity: s.severity, frontend_ids: s.frontend_ids } }));
}
module.exports = { derive, create, classify, errorPattern };
