// TEST-COPY-SPEC 6d-2 (section 7): the FIDELITY CHECK of a test copy built from a database file. Does the copy show the SAME problem as the real site?
// compare({ real, copy }) is a pure function: no file, no network, no clock. It assigns no status and no verdict; issue/sandbox-phase.js and
// issue/sandbox-many.js (the producers) use its level to decide whether the copy's result may be written as evidence at all.
//
//   matched        the same page fails with the same kind of status in the copy (or, with no failing page known on the real site, a copy page fails) AND the
//                  fatal the report calls the cause is in the copy's own log: same kind (class / function), same name, same file relative to wp-content.
//                  A different line number alone is not a mismatch.
//   status-only    the same page fails with the same kind of status, and the real site has no cause fatal to compare with (weaker evidence)
//   did-not-match  the copy loads where the real site fails, fails another way, or shows a different fatal (or none) where the real site names one
//   could-not-test the copy did not start, could not load its pages, or the sandbox failed: never "not reproduced"
//   not-tested     nothing to compare: no failing page and no cause fatal on the real side, or the copy was not built
//
// The cause fatal is the one the report calls the cause (the first hypothesis, in rank order, whose log support names a class or a function at a file),
// never "any fatal in the copy's log". Names and file paths are code identifiers, cut and checked by pattern; text from the site is data and is never run.

const LEVELS = ['matched', 'status-only', 'did-not-match', 'could-not-test', 'not-tested'];
const COUNTS = new Set(['matched', 'status-only']);      // the levels whose copy result may be used as evidence
const LIKELY_REASONS = ['different versions', 'missing data', 'server settings', 'calls to outside services'];
const CLASSES = ['5xx', '4xx', 'white'];
const NAME_RE = /^[A-Za-z_\\][\w\\:>-]{0,199}$/;

const one = t => String(t ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
// a class or function name: case-insensitive, every leading backslash removed, a doubled backslash (escaped log text) folded
const normName = n => one(n).replace(/\\\\/g, '\\').replace(/^\\+/, '').replace(/\(\)$/, '').toLowerCase();
// a file path RELATIVE TO wp-content: everything up to and including the first 'wp-content/' is removed (the real site's root and the sandbox's
// /var/www/html alike); a core file keeps its wp-includes/ or wp-admin/ part; null when it is not a usable relative path
function normFile(p) {
    let s = one(p).replace(/\\/g, '/').replace(/^file:\/\//, '');
    if (!s) return null;
    // 'wp-content' only as a WHOLE path segment ('xwp-content/' or 'my-wp-content/' is not it)
    const wc = /(?:^|\/)wp-content\//.exec(s);
    if (wc) s = s.slice(wc.index + wc[0].length);
    else { const m = /(?:^|\/)((?:wp-includes|wp-admin)\/.+)$/.exec(s); if (m) s = m[1]; else s = s.replace(/^\/var\/www\/html\//, ''); }
    s = s.replace(/^\/+/, '');
    if (!s || s.split('/').includes('..') || s.length > 300) return null;
    return s;
}
// a page address -> its path (no query, no fragment, no trailing slash except the root): what is STORED and shown (a query may hold personal values)
function pathOf(u) {
    let p; try { p = new URL(String(u), 'http://x/').pathname; } catch { return null; }
    p = p.replace(/\/+$/, '');
    return (p || '/').slice(0, 300);
}
// 6d-3: what two pages are COMPARED by: the normalised path and the query as written (no fragment). Never stored; never a bare path suffix.
function pageKeyOf(u) {
    let x; try { x = new URL(String(u), 'http://x/'); } catch { return null; }
    return `${x.pathname.replace(/\/+$/, '') || '/'}${x.search}`.slice(0, 600);
}
// the kind of failure of one observed page: '5xx', '4xx', 'white' (a success status with a blank or critical-error page), or null (it loaded fine)
function statusClassOf(p) {
    if (!p) return null;
    const st = Number(p.reused_status || p.status);
    if (st >= 500 && st < 600) return '5xx';
    if (st >= 400 && st < 500) return '4xx';
    const fl = typeof p.text === 'string' ? require('./oracle').textFlags(p.text) : p.text_flags || (p.text_chars === 0 ? { blank: true, critical: false } : null);
    if (fl && (fl.blank || fl.critical) && st > 0) return 'white';
    return null;
}
// a fatal as { kind: 'class' | 'function', name, file, line } from a log message (and the file the log parser found), or null
const FATAL_RULES = [
    ['class', /(?:Class|Interface|Trait)\s+["']?([\w\\]+)["']?\s+not found/i],
    ['function', /Call to undefined (?:function|method)\s+([\w\\:>-]+)\s*\(/i],
    ['function', /Cannot redeclare\s+([\w\\:]+)\s*\(/i]
];
function fatalOf(message, file, line) {
    const msg = one(message).slice(0, 600);
    for (const [kind, re] of FATAL_RULES) {
        const m = re.exec(msg);
        if (!m) continue;
        const name = m[1].replace(/\\\\/g, '\\');
        if (!NAME_RE.test(name)) return null;
        // the file: the one the log parser read, else the last "in <file>:<line>" / "in <file> on line <n>" of the message
        let f = file ? normFile(file) : null, l = Number.isInteger(line) ? line : null;
        if (!f) { const all = [...msg.replace(/\(?previously declared in\s+\S+/i, '').matchAll(/\bin\s+(\/?[^\s:()'"]+\.php)(?::(\d+)|\s+on line\s+(\d+))/gi)]; const last = all.pop(); if (last) { f = normFile(last[1]); l = Number(last[2] || last[3]) || null; } }
        return { kind, name: name.replace(/^\\+/, ''), file: f, line: l };
    }
    return null;
}
const sameFatal = (a, b) => !!a && !!b && a.kind === b.kind && normName(a.name) === normName(b.name) && !!a.file && !!b.file && a.file === b.file;
// the same page: the normalised path and query are equal, or the copy's front page stands for the page the issue is about. No suffix match.
const samePage = (real, copy, home) => {
    if (!real || !copy) return false;
    if (real === copy) return true;
    if (copy === '/') return real === (home || '/');
    return false;
};
const fatalOut = f => (f ? { kind: f.kind, name: f.name, file: f.file, line: f.line } : null);
const classText = c => (c === 'white' ? 'a blank page' : c ? `HTTP ${c}` : 'no error');

// real: { failing_pages: [{ path, status_class }], cause_fatal: { kind, name, file, line } | null, home: '/' }
// copy: { built: bool, error: string | null, pages: [{ path, status_class, loaded }], fatals: [{ kind, name, file, line }], log_available: bool }
function compare({ real = {}, copy = {} } = {}) {
    const rf = (real.failing_pages || []).filter(p => p && p.path && CLASSES.includes(p.status_class));
    const cause = real.cause_fatal && real.cause_fatal.name && real.cause_fatal.file ? real.cause_fatal : null;
    const out = (level, reasons, extra = {}) => ({ schema: 1, level, counts: COUNTS.has(level), page: null, status_class: null, real_fatal: fatalOut(cause), copy_fatal: null, reasons: reasons.map(stripPaths), likely_reasons: level === 'did-not-match' ? LIKELY_REASONS.slice() : [], real_page: rf.length > 0, ...extra });
    if (copy.error) return out('could-not-test', [one(copy.error).slice(0, 300)]);
    if (!copy.built) return out('not-tested', ['the test copy was not built']);
    if (!rf.length && !cause) return out('not-tested', ['no failing page and no error message from your site to compare']);
    const loaded = (copy.pages || []).filter(p => p && p.loaded && p.path);
    if (!loaded.length) return out('could-not-test', ['the pages of the test copy could not be loaded']);

    // the page: the first failing page of the real site that the copy loaded too
    let hit = null, miss = null;
    for (const r of rf) {
        const c = loaded.find(p => samePage(r.key || r.path, p.key || p.path, real.home));
        if (!c) continue;
        if (c.status_class === r.status_class) { hit = { path: r.path, status_class: r.status_class }; break; }
        if (!miss) miss = { path: r.path, real: r.status_class, copy: c.status_class || null };
    }
    if (rf.length && !hit && miss) return out('did-not-match', [`on ${miss.path} your site showed ${classText(miss.real)}, the test copy showed ${classText(miss.copy)}`], { page: miss.path, status_class: miss.real });
    // a failing page IS known on the real site but the copy did not load it: never matched through the "no failing page known" branch below
    if (rf.length && !hit) {
        const elsewhere = loaded.find(p => CLASSES.includes(p.status_class));
        if (elsewhere) return out('did-not-match', [`your site failed on ${rf[0].path}; the test copy did not load that page and failed on ${elsewhere.path} instead (${classText(elsewhere.status_class)})`], { page: rf[0].path, status_class: rf[0].status_class });
        return out('not-tested', ['the test copy did not load the page that failed on your site']);
    }

    if (!cause) return out('status-only', [`on ${hit.path} both showed ${classText(hit.status_class)}; no error message from your site to compare`], { page: hit.path, status_class: hit.status_class });
    const copyFatals = (copy.fatals || []).filter(f => f && f.name);
    const same = copyFatals.find(f => sameFatal(cause, f));
    // the copy's log could not be read: nothing to compare the cause with, which is not a mismatch
    if (!same && !copyFatals.length && !copy.log_available) return out('could-not-test', ["the test copy's log could not be read"], { page: hit ? hit.path : null, status_class: hit ? hit.status_class : null });
    if (!same) {
        const sameName = copyFatals.find(f => f.kind === cause.kind && normName(f.name) === normName(cause.name));
        const why = sameName ? `the test copy shows the same ${cause.kind} name in another file (${sameName.file || 'unknown file'})`
            : copyFatals.length ? 'the test copy shows a different error than the one your report names as the cause'
            : "the test copy's log has no error like the one your report names as the cause";
        // only the compared fatal is named (the same name in another file); an unrelated fatal of the copy is not carried into the result
        return out('did-not-match', [why], { page: hit ? hit.path : null, status_class: hit ? hit.status_class : null, copy_fatal: fatalOut(sameName || null) });
    }
    if (hit) return out('matched', [`on ${hit.path} both showed ${classText(hit.status_class)}, and the copy's log has the same error (${cause.kind} ${cause.name} in ${cause.file})`], { page: hit.path, status_class: hit.status_class, copy_fatal: fatalOut(same) });
    // ONLY when no failing page is known on the real site (rf is empty: no live check; a known page without a hit returned above): the copy must fail on one of its pages as well as log the same error
    const failing = loaded.find(p => CLASSES.includes(p.status_class));
    if (failing) return out('matched', [`the copy's log has the same error (${cause.kind} ${cause.name} in ${cause.file}) and ${failing.path} showed ${classText(failing.status_class)} in the copy`], { page: failing.path, status_class: failing.status_class, copy_fatal: fatalOut(same) });
    return out('did-not-match', ["the copy's log has the same error, but the copy's pages loaded without an error"], { copy_fatal: fatalOut(same) });
}

// ---- building the two sides from the files of an issue (read-only) ----
// NOTE: the cause is taken from work/hypotheses.json, i.e. the ANALYSIS ranking before validation (the sandbox phase runs before issue/validate.js).
// The final report's cause (after validation and the gate) may differ: a hypothesis ranked first here can be downgraded or ruled out later.
// the fatal the report calls the cause: the first hypothesis (rank order) whose log support is a class-not-found, undefined-function or redeclare clue with a location
function causeFatal(hypotheses, clues) {
    const byId = new Map((clues || []).map(c => [c.id, c]));
    const clueLib = require('./clues');
    for (const h of (hypotheses && hypotheses.hypotheses) || []) {
        if (!h || h.status === 'REJECTED_FALSE_POSITIVE') continue;
        for (const s of h.supports || []) {
            if (!/^log(-(un)?verified)?$/.test(String(s.kind || ''))) continue;
            const c = byId.get(s.ref);
            if (!c || !['php-class-not-found', 'php-undefined-function', 'php-redeclare'].includes(c.type)) continue;
            const loc = clueLib.locationOf(c, clues);
            const file = loc && loc.detail ? normFile(loc.detail.file) : null;
            const name = String(c.value || '').replace(/\\\\/g, '\\');
            if (!file || !NAME_RE.test(name)) continue;
            return { kind: c.type === 'php-class-not-found' ? 'class' : 'function', name: name.replace(/^\\+/, ''), file, line: loc.detail.line || null };
        }
    }
    return null;
}
// probe: work/probe.json; hypotheses: work/hypotheses.json; evidence: work/evidence.json; issue: the issue record
function realFrom({ probe, hypotheses, evidence, issue } = {}) {
    const pages = probe && Array.isArray(probe.pages) ? probe.pages : [];
    const failing = [];
    for (const p of pages) { const c = statusClassOf(p), q = p && pathOf(p.url), k = p && pageKeyOf(p.url); if (c && q && !failing.some(x => (x.key || x.path) === k && x.status_class === c)) failing.push({ path: q, ...(k && k !== q ? { key: k } : {}), status_class: c }); }
    const home = issue && issue.url ? pageKeyOf(issue.url) : '/';
    return { failing_pages: failing, cause_fatal: causeFatal(hypotheses, evidence && evidence.clues), home };
}
// pages: the observed pages of the copy's baseline; copyLog: issue/sandbox-phase.js readCopyLog() output
function copyFrom({ pages, copyLog, error = null, built = true } = {}) {
    const ps = (pages || []).map(p => ({ path: pathOf(p.url), ...(pageKeyOf(p.url) !== pathOf(p.url) ? { key: pageKeyOf(p.url) } : {}), status_class: statusClassOf(p), loaded: !!p.loaded })).filter(p => p.path);
    const fatals = ((copyLog && copyLog.last_fatals) || []).map(x => fatalOf(x.message, x.file, x.line)).filter(Boolean);
    return { built: !!built && !error, error: error ? one(error) : null, pages: ps, fatals, log_available: !!(copyLog && copyLog.available) };
}

// work/fidelity.json -> the object findings.json carries (fixed words, code identifiers, paths and numbers only), or null
function clean(fd) {
    if (!fd || fd.schema !== 1 || !LEVELS.includes(fd.level)) return null;
    const fat = f => (f && ['class', 'function'].includes(f.kind) && typeof f.name === 'string' && NAME_RE.test(f.name) ? { kind: f.kind, name: f.name, file: typeof f.file === 'string' ? normFile(f.file) : null, line: Number.isInteger(f.line) ? f.line : null } : null);
    return {
        schema: 1, level: fd.level, counts: COUNTS.has(fd.level),
        page: typeof fd.page === 'string' && fd.page.startsWith('/') ? fd.page.slice(0, 300) : null,
        status_class: CLASSES.includes(fd.status_class) ? fd.status_class : null,
        real_fatal: fat(fd.real_fatal), copy_fatal: fat(fd.copy_fatal),
        reasons: (Array.isArray(fd.reasons) ? fd.reasons : []).filter(r => typeof r === 'string').slice(0, 4).map(r => stripPaths(r).slice(0, 300)),
        likely_reasons: (Array.isArray(fd.likely_reasons) ? fd.likely_reasons : []).filter(r => LIKELY_REASONS.includes(r)),
        // 6d-3: was a failing page of the real site part of the comparison? (an older fidelity.json without the field: read from its first reason)
        real_page: typeof fd.real_page === 'boolean' ? fd.real_page : !(fd.level === 'matched' && /^the copy's log has the same error/.test(String((fd.reasons || [])[0] || '')))
    };
}

// ---- the reader's words (gate report only; owner wording) ----
const MISMATCH = 'The test copy did not show the same problem as your site, so nothing from it is used. The cause stays not confirmed.';
const NOT_TESTED = 'The test copy could not be compared with your site, because no failing page or error message was available to compare. Nothing from it is used.';
const statusOnlyText = c => `The test copy showed the same kind of failure (${c === 'white' ? 'a blank page' : `HTTP ${c || '5xx'}`} on the same page). No error message was available on either side to compare, so this is weaker evidence.`;
// absolute host paths out of a reason (findings.json and the reader alike): a wp-content path becomes relative, any other one 'a folder on this computer'
const stripPaths = t => one(t).replace(/(?<![\w.@+-])(?:\/[\w.@+-]+){2,}\/?/g, m => (/\/wp-content\//.test(m) ? m.slice(m.search(/\/wp-content\//) + 1) : /^\/var\/www\/html\/wp-(?:includes|admin)\//.test(m) ? m.replace('/var/www/html/', '') : 'a folder on this computer'));
// one plain sentence from the sandbox failure text: the first sentence, no trailing full stop, no control characters, no absolute host path
function plainReason(t) {
    let s = one(t).replace(/^(?:NOTICE|WARNING|ERROR):\s*/i, '');
    s = (s.split(/(?<=\S)\.\s+(?=[A-Z])/)[0] || s).replace(/[.\s]+$/, '');
    s = stripPaths(s);
    return s.slice(0, 200) || 'the sandbox reported an error';
}
const couldNotTestText = reason => `The test copy could not be started (${plainReason(reason)}), so no test was done. This does not mean the problem is absent.`;
// -> { line, reasons } for the report, or null when nothing is to be said (matched: the "How sure" sentence says it)
function readerText(fd) {
    const c = clean(fd);
    if (!c) return null;
    if (c.level === 'did-not-match') return { line: MISMATCH, reasons: c.likely_reasons.length ? c.likely_reasons : LIKELY_REASONS.slice() };
    if (c.level === 'status-only') return { line: statusOnlyText(c.status_class), reasons: [] };
    if (c.level === 'not-tested') return { line: NOT_TESTED, reasons: [] };
    if (c.level === 'could-not-test') return { line: couldNotTestText(c.reasons[0] || ''), reasons: [] };
    return null;
}

module.exports = { samePage, pageKeyOf, stripPaths, compare, realFrom, copyFrom, causeFatal, fatalOf, sameFatal, normName, normFile, pathOf, statusClassOf, clean, readerText, plainReason, couldNotTestText, statusOnlyText, LEVELS, COUNTS, LIKELY_REASONS, MISMATCH, NOT_TESTED };
