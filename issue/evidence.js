// Phase B: evidence extraction. Deterministic and offline: OCR (tesseract.js, local), description parsing against the hand-written
// taxonomy, and log parsing. Output work/evidence.json = an ordered list of clues, each with its source and confidence.
// Every step records PASSED / FAILED / BLOCKED / SKIPPED / NOT_RUN with a reason; a step that could not run is never "clean".
// No timestamps are written (the log's own times are data), so the same input gives byte-identical files.
//
// Not built yet (later steps): the live page probe (B4) and screenshot comparison (B5); both are recorded as NOT_RUN.

const fs = require('fs');
const readdir = require('../lib/sorted-dir');
const path = require('path');
const store = require('../lib/issue-store');
const ownership = require('../lib/ownership');
const describe = require('./describe');
const clues = require('./clues');
const logs = require('./logs');
const ocr = require('./ocr');
const probeMod = require('./probe');

const cutMsg = m => String(m).replace(/\s*\n\s*/g, ' ').slice(0, 300);
const stepOf = (id, label, status, reason = null, extra = {}) => ({ id, label, status, reason, ...extra });
const write = (dir, rel, body) => { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 }); fs.writeFileSync(f, typeof body === 'string' ? body : JSON.stringify(body, null, 2) + '\n', { mode: 0o600 }); };

// Which components the clues point at, weighted by how trustworthy the source is. A ranking aid for later phases, not a verdict.
function componentHints(list) {
    const W = { certain: 3, likely: 2, possible: 1 }, m = new Map();
    const bump = (c, why, w) => { if (!c) return; const e = m.get(c) || { component: c, score: 0, sources: new Set() }; e.score += w; e.sources.add(why); m.set(c, e); };
    for (const c of list) {
        if (c.type === 'component-path' || c.type === 'component-mention') bump(c.value, `${c.source.kind}:${c.source.ref}`, W[c.confidence]);
        if (c.type === 'php-location' || (c.detail && c.detail.file)) bump(ownership.componentOf(c.detail.file || c.value.split(':')[0]), `${c.source.kind}:${c.source.ref}`, W[c.confidence]);
        if (c.detail && c.detail.previous_file) bump(ownership.componentOf(c.detail.previous_file), `${c.source.kind}:${c.source.ref}`, W[c.confidence]);
    }
    return [...m.values()].map(e => ({ component: e.component, score: e.score, sources: [...e.sources].sort() })).sort((a, b) => b.score - a.score || a.component.localeCompare(b.component));
}

async function run(id, { root = null, maxLogBytes, recognizer = ocr.recognize, probeOptions = {}, probeEnv = process.env } = {}) {
    const issue = store.load(id), dir = store.dirOf(id);
    const steps = [], all = [], notices = [];
    const addNotices = (text, src) => notices.push(...clues.notices(text, src));

    // ---- description (and the free-text fields) ----
    const fields = [['issue.title', issue.title], ['issue.description', issue.description], ['issue.since', issue.since], ['issue.changed_before', issue.changed_before]];
    for (const [ref, text] of fields) if (text) { addNotices(text, { kind: 'description', ref }); all.push(...clues.extract(text, { kind: 'description', ref }, { confidence: 'possible' })); }
    const joined = fields.map(f => f[1]).filter(Boolean).join('\n');
    const taxonomy = describe.loadTaxonomy();
    const parsed = describe.analyse(joined, taxonomy);
    write(dir, 'work/description.json', { taxonomy_entries: taxonomy.length, taxonomy_verified: taxonomy.filter(t => t.verified).length, ...parsed });
    steps.push(stepOf('description', 'Description and taxonomy', 'PASSED', null, { features: parsed.features.map(f => f.id), taxonomy_unverified_signals: parsed.features.filter(f => !f.verified).length }));

    // ---- components named in the report: a directory name under wp-content that appears as a word in what the reporter wrote ----
    let mentionStep = null;
    if (root) {
        const names = [];
        for (const [dirName, prefix] of [['plugins', 'plugin'], ['themes', 'theme'], ['mu-plugins', 'mu']]) { try { for (const e of readdir(path.join(root, 'wp-content', dirName), { withFileTypes: true })) if (!e.isSymbolicLink() && (e.isDirectory() || /\.php$/.test(e.name))) names.push([prefix, e.name.replace(/\.php$/, '')]); } catch { /* none */ } }
        const hayText = joined.toLowerCase();
        for (const [prefix, slug] of names.sort((a, b) => a[1].localeCompare(b[1]))) {
            if (slug.length < 5) continue; // short names ("form", "seo") are ordinary words
            const re = new RegExp(`(?<![a-z0-9-])${slug.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9-])`);
            if (re.test(hayText)) all.push({ id: require('../lib/schema').stableId('clue', 'component-mention', slug), type: 'component-mention', value: `${prefix}:${slug}`, detail: { slug }, source: { kind: 'description', ref: 'issue.json', line: null }, confidence: 'possible', snippet: `the report mentions "${slug}"` });
        }
    }

    // ---- OCR ----
    if (!issue.images.length) steps.push(stepOf('ocr', 'OCR of screenshots', 'NOT_RUN', 'no screenshots were attached'));
    else {
        try {
            const files = issue.images.map(m => path.join(dir, 'images', m.name));
            const res = await recognizer(files);
            const notes = [];
            res.forEach((r, i) => {
                const name = issue.images[i].name, ref = `images/${name}`;
                // images/<name>.txt is the original's text; the other variants are kept beside it for inspection
                const vs = r.variants || [{ variant: 'original', text: r.text, confidence: r.confidence }];
                const merged = new Map();
                for (const v of vs) {
                    write(dir, v.variant === 'original' ? `work/ocr/${name}.txt` : `work/ocr/${name}.${v.variant}.txt`, v.text + '\n');
                    addNotices(v.text, { kind: 'ocr', ref });
                    for (const c of clues.extract(v.text, { kind: 'ocr', ref }, { confidence: 'possible' })) {
                        const m = merged.get(c.id);
                        if (m) m.found_by.push(v.variant); else merged.set(c.id, { ...c, found_by: [v.variant] });
                    }
                }
                all.push(...merged.values());
                for (const n of r.notes || []) notes.push(`${name}: ${n}`);
            });
            steps.push(stepOf('ocr', 'OCR of screenshots', 'PASSED', 'text read by OCR may contain mistakes; every OCR clue stays "possible"', { images: res.length, variants: res.map(r => (r.variants || [{ variant: 'original' }]).map(v => v.variant)), confidence: res.map(r => r.confidence), notes }));
        } catch (e) { steps.push(stepOf('ocr', 'OCR of screenshots', e.exitCode === 2 ? 'BLOCKED' : 'FAILED', e.message.replace(/\s*\n\s*/g, ' ').slice(0, 300))); }
    }

    // ---- logs ----
    let logResult = null;
    if (!root) steps.push(stepOf('logs', 'debug.log / error_log', 'NOT_RUN', 'no local WordPress root was given (--root), so no log could be read'));
    else {
        const since = parsed.dates[0] || null;
        logResult = logs.collect(root, { maxBytes: maxLogBytes, window: { from: since ? `${since}T00:00:00.000Z` : null, to: issue.created_at } });
        for (const e of logResult.entries) {
            addNotices(e.text, { kind: 'log', ref: e.sources[0] });
            for (const c of clues.extract(e.text, { kind: 'log', ref: e.sources[0] }, { confidence: 'certain' })) {
                c.detail = { ...c.detail, log: { level: e.level, count: e.count, last_seen: e.last_seen, in_window: e.in_window } };
                all.push(c);
            }
        }
        write(dir, 'work/logs.json', { files: logResult.files, problems: logResult.problems, entries: logResult.entries.map(({ text, ...rest }) => rest) });
        const assumed = logResult.entries.filter(e => e.tz_flags.includes('assumed-utc')).length, unknown = logResult.entries.filter(e => e.tz_flags.includes('unknown-zone')).length;
        const tzNote = [assumed ? `${assumed} entr${assumed === 1 ? 'y has' : 'ies have'} no timezone in the log line: UTC was assumed` : '', unknown ? `${unknown} entr${unknown === 1 ? 'y has' : 'ies have'} a timezone that was not understood: UTC was assumed` : ''].filter(Boolean).join('; ');
        steps.push(logResult.files.length
            ? stepOf('logs', 'debug.log / error_log', 'PASSED', tzNote || null, { files: logResult.files.map(f => f.ref), entries: logResult.entries.length, window_from: since, timezone_assumed: assumed, timezone_unknown: unknown })
            : stepOf('logs', 'debug.log / error_log', 'NOT_RUN', `no debug.log or error_log found under ${path.basename(root)} (WP_DEBUG_LOG may be off): this is not evidence that nothing went wrong`));
        for (const p of logResult.problems) steps.push(stepOf('logs-file', `Log file ${p.split(':')[0]}`, 'SKIPPED', p));
    }

    // ---- live probe, oracle, "is the original public", screenshot comparison (read-only, governed; see probe.js) ----
    let reproduced = null;
    try {
        const pr = await probeMod.run(id, { root, options: probeOptions, env: probeEnv });
        for (const st of pr.steps) steps.push(st);
        all.push(...pr.clues);
        for (const c of pr.clues) if (['probe-console-error', 'probe-page-error'].includes(c.type)) addNotices(c.value, { kind: 'probe', ref: c.source.ref });
        reproduced = pr.oracle ? { result: pr.oracle.result, reason: pr.oracle.reason, type: pr.oracle.type, generic: pr.oracle.defaulted, partial: pr.oracle.partial, matches: pr.oracle.matches } : null;
    } catch (e) {
        steps.push(stepOf('live-probe', 'Live page probe', 'FAILED', cutMsg(e.message)));
    }

    // de-duplicate across sources, then order
    const seen = new Set(), uniq = [];
    for (const c of clues.sortClues(all)) { const k = `${c.type}|${c.value}|${c.source.kind}|${c.source.ref}`; if (!seen.has(k)) { seen.add(k); uniq.push(c); } }
    const evidence = {
        schema: 1, issue_id: id, steps, features: parsed.features.map(({ id: fid, label, matched, verified }) => ({ id: fid, label, matched, signals_verified: verified })),
        reproduced, component_hints: componentHints(uniq), clues: uniq,
        notices: notices.filter((n, k, a) => a.findIndex(m => m.kind === n.kind && m.source.ref === n.source.ref && m.source.kind === n.source.kind) === k).sort((a, b) => a.kind.localeCompare(b.kind) || a.source.ref.localeCompare(b.source.ref)),
        summary: { clues: uniq.length, by_confidence: { certain: uniq.filter(c => c.confidence === 'certain').length, likely: uniq.filter(c => c.confidence === 'likely').length, possible: uniq.filter(c => c.confidence === 'possible').length }, notices: 0 }
    };
    evidence.summary.notices = evidence.notices.length;
    write(dir, 'work/evidence.json', evidence);
    const cur = store.load(id); issue.public_check = cur.public_check; issue.notes = cur.notes; // the probe may have added to them
    issue.status = 'EVIDENCE_EXTRACTED';
    store.save(issue);
    return evidence;
}

module.exports = { run, componentHints };
