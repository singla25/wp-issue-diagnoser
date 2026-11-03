// debug.log and error_log files of a local WordPress copy: read-only, tail only, never outside the root, never through a symlink.
// PHP entries are grouped (one timestamped line plus its stack trace), mapped to components, de-duplicated and sorted newest first.
// Log text is data: it is redacted, cut, and never interpreted.

const fs = require('fs');
const readdir = require('../lib/sorted-dir');
const path = require('path');
const redact = require('../lib/redact');
const ownership = require('../lib/ownership');
const clues = require('./clues');

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const MAX_ENTRIES = 500;
const MAX_ENTRY_LINES = 60;
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const STAMP = /^\[(\d{2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2})(?: ([A-Za-z0-9_\/+-]+))?\]\s?(.*)$/;

// Offset (minutes east of UTC) of the zone WRITTEN in the line. Abbreviations that mean different zones (IST, CST...) are not guessed.
const ABBR = { UTC: 0, GMT: 0, Z: 0, WET: 0, WEST: 60, CET: 60, CEST: 120, EET: 120, EEST: 180, BST: 60, EST: -300, EDT: -240, MST: -420, MDT: -360, PST: -480, PDT: -420, AKST: -540, AKDT: -480, HST: -600, JST: 540, KST: 540, AEST: 600, AEDT: 660, NZST: 720, NZDT: 780 };
const AMBIGUOUS = new Set(['IST', 'CST', 'BST_', 'SST', 'AST', 'PKT']);
function ianaOffset(zone, utcMs) {
    const f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    const p = Object.fromEntries(f.formatToParts(new Date(utcMs)).map(x => [x.type, Number(x.value)]));
    return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(utcMs / 1000) * 1000) / 60000);
}
// -> { minutes, how }: how = 'written' | 'assumed-utc' (no zone in the line) | 'unknown-zone' (zone written but not understood, UTC assumed)
function zoneOffset(zone, fields) {
    if (!zone) return { minutes: 0, how: 'assumed-utc' };
    const z = zone.trim();
    let m = /^(?:UTC|GMT)?([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(z);                 // +02, +0200, +02:00, UTC+2
    if (m) return { minutes: (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0)), how: 'written' };
    if (Object.prototype.hasOwnProperty.call(ABBR, z.toUpperCase())) return { minutes: ABBR[z.toUpperCase()], how: 'written' };
    if (z.includes('/')) {                                                         // Europe/Berlin: the offset depends on the date (DST)
        try {
            const guess = Date.UTC(...fields), o1 = ianaOffset(z, guess), o2 = ianaOffset(z, guess - o1 * 60000);
            return { minutes: o2, how: 'written' };
        } catch { /* not a zone this Node knows */ }
    }
    return { minutes: 0, how: 'unknown-zone' };
}
function isoOf(m) {
    const mon = MONTHS[m[2].toLowerCase()];
    if (mon === undefined) return null;
    const fields = [Number(m[3]), mon, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6])];
    const z = zoneOffset(m[7], fields);
    return { iso: new Date(Date.UTC(...fields) - z.minutes * 60000).toISOString(), zone: m[7] || null, tz: z.how };
}

// last `maxBytes` of a file; the first (possibly cut) line is dropped when the file was longer
function readTail(abs, maxBytes) {
    const st = fs.lstatSync(abs);
    if (!st.isFile()) return null;
    const len = Math.min(st.size, maxBytes), fd = fs.openSync(abs, 'r');
    try {
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, st.size - len);
        let text = buf.toString('utf8');
        if (st.size > len) text = text.slice(text.indexOf('\n') + 1);
        return { text, bytes: st.size, truncated: st.size > len };
    } finally { fs.closeSync(fd); }
}

// ---------- deep scan: a fatal that is NOT in the last 2 MB of a huge log ----------
// Used only when the tail holds no fatal and the problem looks like a crash. Reads in 1 MB chunks, line-aligned, never more than `cap` bytes in total: first backwards from
// just before the tail (most recent first, 3/4 of the budget), then forwards from the start of the file (a log that was flooded with notices later still holds the old crash
// at its beginning). Only fatal-like lines are kept (with the few lines after them, for the stack trace): at most 200 entries, 1200 characters per line, redacted.
// Same guards as readTail: a regular file, opened read-only, one chunk in memory at a time.
const FATAL_LIKE = /\b(?:PHP )?(?:Fatal error|Parse error)\b|Uncaught\s+\w*(?:Error|Exception)|\bnot found in\b/;
const CRASH_WORDS = /white screen|blank (?:page|screen)|critical error|fatal error|there has been a critical|error 500|http 500|500 (?:internal )?error|internal server error|site (?:is )?down|page (?:is )?not loading|stopped working|can'?t load|cannot load/i;
const looksLikeCrash = text => CRASH_WORDS.test(String(text || ''));
const hasFatal = text => /\b(?:PHP )?Fatal error\b|\bParse error\b/.test(String(text || ''));

function deepScan(abs, { tailBytes = DEFAULT_MAX_BYTES, cap = 64 * 1024 * 1024, chunk = 1024 * 1024, maxEntries = 200, maxLine = 1200 } = {}) {
    const st = fs.lstatSync(abs);
    if (!st.isFile()) return null;
    const total = st.size, out = { text: '', entries: 0, read_bytes: 0, total_bytes: total, passes: [], found: false, capped: false };
    const fd = fs.openSync(abs, 'r');
    const kept = [];
    const take = (text, order) => {      // lines of one chunk -> fatal-like lines + up to 6 following lines
        const lines = text.split(/\r?\n/);
        const found = [];
        for (let i = 0; i < lines.length; i++) {
            if (!FATAL_LIKE.test(lines[i])) continue;
            const block = [lines[i], ...lines.slice(i + 1, i + 7).filter(l => /^(#\d+|Stack trace:|\s+thrown in)/.test(l))];
            found.push(block.map(l => redact.text(l).slice(0, maxLine)).join('\n'));
        }
        return order === 'back' ? found.reverse() : found;
    };
    try {
        const readAt = (from, len) => { const buf = Buffer.alloc(len); fs.readSync(fd, buf, 0, len, from); return buf.toString('utf8'); };
        let budget = cap;
        // pass 1: backwards from the start of the tail, 3/4 of the budget
        let end = Math.max(0, total - tailBytes), spent = 0;
        const backBudget = Math.floor(cap * 0.75);
        const backFrom = end;
        while (end > 0 && spent < backBudget && kept.length < maxEntries) {
            const len = Math.min(chunk, end, backBudget - spent), from = end - len;
            let text = readAt(from, len);
            if (from > 0) text = text.slice(text.indexOf('\n') + 1);        // the first line of the chunk may be cut
            kept.push(...take(text, 'back')); spent += len; end = from;
        }
        out.read_bytes += spent;
        if (spent) out.passes.push({ direction: 'backwards', from_byte: end, to_byte: backFrom, bytes: spent });
        // pass 2 (only if pass 1 found no fatal): forwards from byte 0, never into what was read
        if (!kept.length) {
            budget = cap - spent; let pos = 0, fwd = 0;
            while (pos < end && fwd < budget && kept.length < maxEntries) {
                const len = Math.min(chunk, end - pos, budget - fwd);
                let text = readAt(pos, len);
                if (pos + len < end) text = text.slice(0, text.lastIndexOf('\n') + 1);      // the last line of the chunk may be cut: it is read again with the next chunk
                const used = Buffer.byteLength(text, 'utf8') || len;
                kept.push(...take(text, 'fwd')); fwd += used; pos += used || len;
            }
            out.read_bytes += fwd;
            if (fwd) out.passes.push({ direction: 'forwards', from_byte: 0, to_byte: pos, bytes: fwd });
        }
        out.capped = end > 0 && kept.length === 0 && out.read_bytes >= cap - chunk;
    } finally { fs.closeSync(fd); }
    out.entries = Math.min(kept.length, maxEntries);
    out.found = out.entries > 0;
    out.text = kept.slice(0, maxEntries).join('\n') + (kept.length ? '\n' : '');
    return out;
}
const mb = b => (b / 1048576 >= 10 ? Math.round(b / 1048576) : Math.round(b / 104857.6) / 10);
const describeDeep = d => `the last 2 MB of this log had no fatal error, so ${d.passes.map(p => `${mb(p.bytes)} MB ${p.direction === 'backwards' ? 'before it' : 'from the start'}`).join(' and ')} were also read (${mb(d.read_bytes)} MB of ${mb(d.total_bytes)} MB): ${d.found ? `${d.entries} fatal-like line(s) found` : 'no fatal error found in the part read'}`;

function levelOf(msg) {
    const m = /^PHP (Fatal error|Parse error|Warning|Notice|Deprecated)|^(Fatal error|Parse error|Warning|Notice|Deprecated)/i.exec(msg);
    return m ? (m[1] || m[2]).toLowerCase() : 'other';
}

function parseLog(text, fileRef) {
    const entries = [];
    let cur = null;
    const flush = () => { if (cur) entries.push(finish(cur)); cur = null; };
    for (const raw of text.split(/\r?\n/)) {
        const line = redact.text(raw).slice(0, 800);
        const m = STAMP.exec(line);
        if (m) { flush(); const t = isoOf(m); cur = { time: t && t.iso, zone: t && t.zone, tz: t ? t.tz : 'unknown-zone', head: m[8], lines: [m[8]] }; }
        else if (cur && cur.lines.length < MAX_ENTRY_LINES && line.trim()) cur.lines.push(line);
        else if (!cur && /PHP (Fatal|Warning|Notice|Parse|Deprecated)/.test(line)) cur = { time: null, zone: null, tz: 'no-timestamp', head: line, lines: [line] }; // error_log files without a timestamp
    }
    flush();
    return entries.map(e => ({ ...e, file_ref: fileRef }));

    function finish(c) {
        const full = c.lines.join('\n');
        // the error is raised at the LAST "in <file> on line N" of the head; "previously declared in" names the other side of a redeclare
        const prevM = /previously declared in\s+(\S+?\.php):(\d+)/.exec(c.head);
        const headNoPrev = c.head.replace(/\(?previously declared in[^)]*\)?/, '');
        const locs = [...headNoPrev.matchAll(/\bin\s+(\/?\S+?\.php)(?::|\s+on line\s+)(\d+)/g)];
        const loc = locs.length ? locs[locs.length - 1] : /thrown in\s+(\S+?\.php)\s+on line\s+(\d+)/.exec(full);
        const previous = prevM && clues.sitePath(prevM[1]) ? { file: clues.sitePath(prevM[1]), line: Number(prevM[2]) } : null;
        const trace = [...full.matchAll(/^#\d+\s+(\S+?\.php)\((\d+)\):\s*(.{0,120})$/gm)].map(t => ({ file: clues.sitePath(t[1]), line: Number(t[2]), call: t[3].trim() })).filter(t => t.file);
        const files = [...new Set([loc && clues.sitePath(loc[1]), previous && previous.file, ...trace.map(t => t.file)].filter(Boolean))];
        const components = [...new Set(files.map(f => ownership.componentOf(f)).filter(Boolean))];
        return { time: c.time, zone: c.zone, tz: c.tz, level: levelOf(c.head), message: c.head.replace(/\s+/g, ' ').slice(0, 300), file: loc ? clues.sitePath(loc[1]) : null, line: loc ? Number(loc[2]) : null, previous, trace: trace.slice(0, 12), components, text: full.slice(0, 3000) };
    }
}

// Same message at the same place -> one entry with a count and first/last time.
function dedupe(entries) {
    const map = new Map();
    for (const e of entries) {
        const key = `${e.level}|${e.message.replace(/\d+/g, '#')}|${e.file}|${e.line}`;
        const g = map.get(key);
        if (!g) map.set(key, { ...e, count: 1, first_seen: e.time, last_seen: e.time, sources: [e.file_ref], tz_flags: e.tz === 'written' ? [] : [e.tz] });
        else { g.count++; if (e.time && (!g.first_seen || e.time < g.first_seen)) g.first_seen = e.time; if (e.time && (!g.last_seen || e.time > g.last_seen)) { g.last_seen = e.time; } if (!g.sources.includes(e.file_ref)) g.sources.push(e.file_ref); if (e.tz !== 'written' && !g.tz_flags.includes(e.tz)) g.tz_flags.push(e.tz); }
    }
    return [...map.values()];
}

// window: { from: ISO|null, to: ISO|null } -> entries get in_window: true/false, or null when there is no window or no timestamp
function collect(root, { maxBytes = DEFAULT_MAX_BYTES, window = null, deep = null } = {}) {
    const result = { files: [], entries: [], problems: [] };
    const candidates = ['wp-content/debug.log', 'error_log', 'wp-content/error_log', 'wp-admin/error_log'];
    for (const kind of ['plugins', 'themes']) {
        const base = path.join(root, 'wp-content', kind);
        let names = []; try { names = readdir(base).sort().slice(0, 60); } catch { /* none */ }
        for (const n of names) candidates.push(`wp-content/${kind}/${n}/error_log`);
    }
    let all = [];
    for (const rel of candidates) {
        const r = ownership.resolveInside(root, rel);
        if (!r.ok) { result.problems.push(`${rel}: ${r.reason}`); continue; }
        if (!fs.existsSync(r.abs)) continue;
        if (r.symlink) { result.problems.push(`${rel}: is a symbolic link, not read`); continue; }
        let t; try { t = readTail(r.abs, maxBytes); } catch (e) { result.problems.push(`${rel}: ${e.code || e.message}`); continue; }
        if (!t) continue;
        const fileInfo = { ref: rel, bytes: t.bytes, truncated: t.truncated };
        let text = t.text;
        if (deep && deep.enabled && t.truncated && !hasFatal(text)) {
            try { const d = deepScan(r.abs, { tailBytes: maxBytes, cap: deep.cap }); if (d) { fileInfo.deep = { read_bytes: d.read_bytes, total_bytes: d.total_bytes, found: d.found, entries: d.entries, passes: d.passes, text: describeDeep(d) }; text = `${text}\n${d.text}`; } }
            catch (e) { result.problems.push(`${rel}: deep scan failed (${e.code || e.message})`); }
        }
        result.files.push(fileInfo);
        all = all.concat(parseLog(text, rel));
    }
    const merged = dedupe(all).slice(0, MAX_ENTRIES);
    for (const e of merged) e.in_window = window && (window.from || window.to) && e.last_seen ? (!window.from || e.last_seen >= window.from) && (!window.to || e.first_seen <= window.to) : null;
    merged.sort((a, b) => (b.last_seen || '').localeCompare(a.last_seen || '') || b.count - a.count || a.message.localeCompare(b.message));
    result.entries = merged;
    return result;
}

module.exports = { collect, parseLog, dedupe, readTail, isoOf, zoneOffset, deepScan, describeDeep, looksLikeCrash, hasFatal, DEFAULT_MAX_BYTES };
