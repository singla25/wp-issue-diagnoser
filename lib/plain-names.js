// Plain words for a reader who is not technical. Pure and deterministic; no network, nothing is decided here.
//   plainRef('theme:unicamp', names)  -> 'the theme Unicamp'      plainRef('woocommerce', names) -> 'the plugin WooCommerce'
//   plainText(text, components)       -> the same text with every internal id (theme:x, mu:x, plugin:x, "plugin theme:x", a component slug) in plain words
//   STATUS_WORD                       -> reader words for the technical status names (the status itself stays in findings.json)
//   notTested(timeline, opts)         -> the "not tested" steps that are tied to what was asked
// Technical ids stay in findings.json (ref, components, hypothesis ids); only reader-facing text goes through here.

const STATUS_WORD = {
    CONFIRMED: 'Confirmed', REPRODUCIBLE: 'Reproduced', FIXED_VERIFIED: 'Fixed and verified',
    PROBABLE_NEEDS_REVIEW: 'Needs review', UNVERIFIED: 'Not checked', REJECTED_FALSE_POSITIVE: 'Ruled out'
};
const statusWord = s => STATUS_WORD[s] || String(s || '').toLowerCase().replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());

// the ONE phrase for "no confirmed cause, but the log names one"
const LIKELY_PHRASE = 'Most likely cause found in your log (not confirmed)';

const cap = s => String(s).split(/[-_\s]+/).filter(Boolean).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function kindOf(ref) { return /^theme:/.test(ref) ? 'theme' : /^mu:/.test(ref) ? 'must-use plugin' : 'plugin'; }
const slugOf = ref => String(ref).replace(/^(theme|mu|plugin):/, '');

// names: { [ref or slug]: 'Header Name' } (from components.json). The folder name, capitalised, when no name is known.
function plainRef(ref, names = {}) {
    const nm = names[ref] || names[slugOf(ref)] || cap(slugOf(ref));
    return `the ${kindOf(ref)} ${nm}`;
}

// the label of a component named by a log error: 'plugin heavy' stays as it was; a theme or must-use plugin never shows its internal id
const componentLabel = b => b.component_label || (/^(theme|mu):/.test(String(b.component)) ? plainRef(b.component) : `plugin ${b.component}`);

function namesOf(components) {
    const names = {};
    for (const c of components || []) { if (c.ref) names[c.ref] = c.name || c.slug || slugOf(c.ref); if (c.slug) names[c.slug] = c.name || c.slug; }
    return names;
}

// text -> text. Known component refs/slugs first (longest first), then any leftover theme:/mu:/plugin: token.
function plainText(text, components, { bare = false } = {}) {
    if (text === null || text === undefined) return text;
    let t = String(text);
    const names = namesOf(components);
    const refs = [...new Set((components || []).flatMap(c => [c.ref, c.slug].filter(Boolean)))].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
    const token = (ref, full) => plainRef(full || ref, names);
    // "plugin theme:unicamp" -> the theme
    t = t.replace(/\b(?:plugin|theme|must-use plugin) ((?:theme|mu):[a-z0-9._-]+)/gi, (m, r) => token(r));
    t = t.replace(/(^|[^A-Za-z0-9_:.-])((?:theme|mu|plugin):[A-Za-z0-9._-]+)/g, (m, pre, r) => pre + token(r));
    for (const r of refs) {
        if (!bare || /^(theme|mu|plugin):/.test(r)) continue;
        // a bare slug is replaced only where it stands alone and is not already part of a plain phrase
        const re = new RegExp(`(^|[^A-Za-z0-9_:./-])${escRe(r)}(?![A-Za-z0-9_:./-])`, 'g');
        t = t.replace(re, (m, pre, off, whole) => (/(the (theme|plugin|must-use plugin) )$/.test(whole.slice(0, off + pre.length)) ? m : pre + plainRef(r, names)));
    }
    return t.replace(/ \+ (the (?:theme|plugin|must-use plugin) )/g, ' and $1');
}

// ---- "Not tested": only what is tied to the answer ----
// timeline: [{ id, label, status, reason }]. opts: { verbose, hasScreenshots, sandboxAsked }. -> the steps that are NOT done and worth telling
function sandboxAsked(timeline) {
    const s = (timeline || []).find(x => x.id === 'sandbox');
    return !!(s && !/^not requested/i.test(String(s.reason || '')));
}
function notTested(timeline, { verbose = false, hasScreenshots = false, sandbox } = {}) {
    const asked = sandbox === undefined ? sandboxAsked(timeline) : !!sandbox;
    return (timeline || []).filter(t => t.status !== 'PASSED').filter(t => {
        if (verbose) return true;
        if (t.id === 'image-diff' || t.id === 'ocr') return hasScreenshots;
        if (t.id === 'original-public') return asked;
        if (t.id === 'sandbox') return asked;
        return true;
    });
}

// ---- the same advisory many times (an outdated template override, five times) is one line with a count ----
// titles: [{ title, key? }] in order -> [{ title, count }]
function mergeTitles(items) {
    const m = new Map();
    for (const it of items) { const k = it.key || it.title; const e = m.get(k); if (e) e.count++; else m.set(k, { title: it.title, count: 1 }); }
    return [...m.values()];
}

// ---- reader-facing validation text: the validator's internal wording stays in findings.json (checks, validation_notes), never in a sentence the reader sees ----
// A check is hidden by id (the oracle recomputation and the notes about it are developer information); any other line is dropped if it still carries an internal term.
const HIDDEN_CHECK_IDS = new Set(['oracle', 'not-reproduced-cap', 'hypotheses', 'sources']);
const INTERNAL_TERM = /(?<![A-Za-z0-9_-])(?:stored oracle answer|oracle|recomputation|recomputed|NOT_RUN)(?![A-Za-z0-9_-])/i;
const CHECK_STATUS_WORD = { PASSED: 'Passed', FAILED: 'Failed', NOT_RUN: 'Not checked', BLOCKED: 'Blocked', SKIPPED: 'Skipped' };
const checkStatusWord = s => CHECK_STATUS_WORD[s] || String(s || '').toLowerCase().replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
// The internal file names of the issue folder (work/evidence.json, probe.json, bisect.json, ...) in plain words. The validator's own text (findings.json) is not changed;
// only the reader text goes through here. Specific phrases first, then the file names; a line that still names a .json file is never shown (see readerWhy).
const FILE_PHRASES = [
    [/\bthe (log|probe) clue cited by this hypothesis is not in (?:work\/)?evidence\.json/gi, (m, k) => `the ${k === 'log' ? 'log entry' : 'live-page observation'} this possible cause cites is no longer in the saved evidence`],
    [/\bthe (log|probe) clue is still in (?:work\/)?evidence\.json/gi, (m, k) => `the ${k === 'log' ? 'log entry' : 'live-page observation'} is still in the saved evidence`],
    [/(?:work\/)?bisect\.json does not hold/gi, () => 'the plugin-by-plugin test does not show'],
    [/(?:work\/)?bisect\.json:\s*/gi, () => 'the plugin-by-plugin test: '],
    [/(?:work\/)?probe\.json holds no page observations to recompute from/gi, () => 'the saved live-page results hold no page observations']
];
const FILE_WORD = {
    'evidence.json': 'the saved evidence', 'probe.json': 'the saved live-page results', 'bisect.json': 'the saved plugin-by-plugin test', 'bisect.log': 'the saved plugin-by-plugin test',
    'sandbox.json': 'the saved test-copy results', 'hypotheses.json': 'the saved list of possible causes', 'validation.json': 'the saved re-check', 'custom-code.json': 'the saved code analysis',
    'intake.json': 'the saved copy report', 'logs.json': 'the saved log entries', 'components.json': 'the saved list of plugins and themes', 'findings.json': 'the saved report data'
};
function readerFiles(text) {
    if (text === null || text === undefined) return text;
    let t = String(text);
    for (const [re, to] of FILE_PHRASES) t = t.replace(re, to);
    return readerDates(t.replace(/(?:\bwork\/)?\b([a-z0-9-]+\.(?:json|log))\b/gi, (m, name) => FILE_WORD[name.toLowerCase()] || (/\.json$/i.test(name) ? 'the saved results' : m)));
}
// a raw timestamp (2026-11-04T09:15:40.000Z) in reader text -> "4 Nov 2026" (UTC, as the log dates elsewhere in the report). The producer's text (findings.json) keeps the timestamp.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ISO_TIME = /\b(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g;
function readerDates(text) {
    if (text === null || text === undefined) return text;
    return String(text).replace(ISO_TIME, (m, y, mo, d) => { const t = new Date(m); const u = Number.isNaN(t.getTime()) ? new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d))) : t; return Number.isNaN(u.getTime()) ? m : `${u.getUTCDate()} ${MONTHS[u.getUTCMonth()]} ${u.getUTCFullYear()}`; });
}
const FILE_NAME = /\.json\b|\bwork\//i;
// -> [string]: "Passed: <reason>" per check, no check id; then the notes. Deterministic. Internal file names are said in plain words.
function readerWhy(h) {
    const out = [];
    for (const c of (h && h.checks) || []) {
        if (HIDDEN_CHECK_IDS.has(c.id)) continue;
        const line = `${checkStatusWord(c.status)}: ${readerFiles(c.reason)}`;
        if (!INTERNAL_TERM.test(line) && !FILE_NAME.test(line)) out.push(line);
    }
    for (const n0 of (h && h.validation_notes) || []) { const n = readerFiles(n0); if (!INTERNAL_TERM.test(n) && !FILE_NAME.test(n)) out.push(`Note: ${n}`); }
    return out;
}
// the command line (gate mode, --verbose): the same lines for the whole validation
function readerValidationLines(val) {
    const out = [];
    for (const c of (val && val.checks) || []) {
        if (HIDDEN_CHECK_IDS.has(c.id)) continue;
        const line = `  ${checkStatusWord(c.status).padEnd(8)} ${readerFiles(c.reason)}`;
        if (!INTERNAL_TERM.test(line) && !FILE_NAME.test(line)) out.push(line);
    }
    for (const h of (val && val.hypotheses) || []) {
        out.push(`  ${statusWord(h.status).padEnd(24)} ${h.title}`);
        for (const n0 of h.validation_notes || []) { const n = readerFiles(n0); if (!INTERNAL_TERM.test(n) && !FILE_NAME.test(n)) out.push(`      ${n}`); }
    }
    return out;
}
// "Not tested" in the Verdict: a plain label, the reason, no status code
const STEP_LABEL = { oracle: 'Check that the problem shows on the page' };
function readerStepLine(t) {
    const label = STEP_LABEL[t.id] || t.label;
    const reason = t.reason ? readerFiles(String(t.reason).replace(/symptom reproduced: could[ -]not[ -]test/i, 'the problem could not be tested on the site')) : '';
    const line = `${label}${reason ? `: ${reason.slice(0, 140)}` : ` (${checkStatusWord(t.status).toLowerCase()})`}`;
    return line;
}

// ---- report polish (gate mode): confidence sentence, symptom sentence, log note, checkpoint text, short title ----
// "How sure we are": levels not very / fairly / very (none and low -> not very; medium and medium-high -> fairly; high -> very), with the reason of the verdict tier.
const SURE_LEVEL = { none: 'not very', low: 'not very', medium: 'fairly', 'medium-high': 'fairly', high: 'very' };
const SURE_REASON = [
    [/^Fixed and verified/, 'A retest showed the problem gone on the same page and screen size that failed before.'],
    [/^Most likely cause found in your log/, 'The error is in your log, but it was not confirmed by a test on the site.'],
    [/^Confirmed cause found in your logs/, 'The error is in your log and the code was re-read, but it was not seen failing on the site.'],
    [/^Confirmed breaking cause found/, 'The cause was re-checked in the code and the problem was seen failing.'],
    [/^Reproduced and cause found/, 'The problem was reproduced in a test copy of your site and narrowed down to this cause.'],
    [/^No confirmed breaking cause/, 'Nothing that was checked points at a cause that could be confirmed.']
];
// live (gate mode, taken from Case 1 of the case file so the two agree): { status: 500 } the live page answered with that error | 'not-checked' no live page was loaded |
// 'fine' the live pages loaded did not answer with an error | null (not known: the sentence of the tier, as before)
const LIVE_REASON = {
    'not-checked': 'The error is in your log and the code was re-read; it was not checked on the live site.',
    fine: 'The error is in your log and the code was re-read; the live pages that were loaded did not answer with an error.'
};
function confidenceSentence(confidence, label, { reproduced = false, live = null } = {}) {
    const level = SURE_LEVEL[String(confidence)] || 'not very';
    let reason = (SURE_REASON.find(r => r[0].test(String(label))) || [null, ''])[1];
    if (/^Confirmed breaking cause found/.test(String(label)) && reproduced) reason = SURE_REASON[4][1];
    if (/^Confirmed cause found in your logs/.test(String(label)) && live) reason = live.status ? `The error is in your log, the code was re-read, and the live page answered HTTP ${live.status}.` : LIVE_REASON[live] || reason;
    return `How sure we are: ${level}.${reason ? ` ${reason}` : ''}`;
}
// ZERO checks ran (no check of the list could run: no site files, no log, no live check, or none that ran): the verdict says so and why, derived from the data;
// it never reads like a clean check and never says "Nothing that was checked points at a cause"
const NOTHING_CHECKED_LABEL = 'Nothing could be checked';
function zeroChecksSentence({ hasRoot = false, hasCode = false, hasLog = false, probeRan = false, total = 0, liveStop = null } = {}) {
    const why = [];
    if (!hasCode) why.push(hasRoot ? 'no code was read' : 'no site files were given');
    if (!hasLog) why.push('no log was read');
    // liveStop (no site files only, S4): the probe really started and no page loaded (a stop by the website, a site that could not be reached): say that, with the reason from the live-check sentence
    why.push(probeRan ? `the live page was loaded, but none of the ${total} checks ran on it` : liveStop && !liveStop.attempted && /hidden characters/.test(String(liveStop.reason || '')) ? 'no live check was run, because a saved address has hidden characters' : liveStop && liveStop.attempted ? (liveStop.gave > 0 ? `only ${liveStop.gave} of ${liveStop.total} live page checks gave a result` : `no live page check ran (${String(liveStop.reason || '').replace(/[.\s]+$/, '')})`) : 'no live check was run');
    const text = why.length > 1 ? `${why.slice(0, -1).join(', ')} and ${why[why.length - 1]}` : why[0];
    return `How sure we are: not at all. Nothing could be checked, so this report does not say whether your site is healthy: ${text}.`;
}
// NO site files, and the live page answered with an error status OR a live check failed: the verdict is built only from true parts (the statuses and the count come from the data);
// it names no cause, no plugin and no theme, and never says that something was confirmed or fully checked
const ERROR_PAGE_LABEL = 'A problem was seen on the live page';
// S4: a 4xx answer (not 429) and no failed live check is named as what it is; a 5xx or a failed check keeps the label above
const only4xx = (statuses, failedLive) => { const codes = [...new Set(statuses.map(Number).filter(n => n >= 400))].sort((a, b) => a - b); return failedLive === 0 && codes.length > 0 && codes.every(n => n >= 400 && n < 500 && n !== 429) ? codes : null; };
function errorPageLabel({ statuses = [], failedLive = 0 } = {}) { const c = only4xx(statuses, failedLive); return c ? `The live page answered with an error (HTTP ${c.join(' and HTTP ')})` : ERROR_PAGE_LABEL; }
function errorPageSentence({ statuses = [], failedLive = 0, hasRoot = false, hasLog = false, conflict = false } = {}) {
    const parts = [];
    const codes = [...new Set(statuses.map(Number).filter(n => n >= 400))].sort((a, b) => a - b);
    if (codes.length) parts.push(`The live page answered with an error (HTTP ${codes.join(' and HTTP ')}).`);
    if (failedLive > 0) parts.push(`${failedLive} live check${failedLive === 1 ? '' : 's'} failed.`);
    parts.push(conflict ? 'No confirmed cause could be found from what was given; a possible conflict is listed below.' : 'No cause could be found from what was given.');
    const missing = [!hasRoot && 'the site files', !hasLog && 'a log'].filter(Boolean);
    if (missing.length) parts.push(`To go further, give ${missing.join(' and ')}.`);
    return parts.join(' ');
}
// NO site files, a LOG was given (--no-files --log): what the log can say, and no more. A fatal error that names a file of a plugin or a theme is a POSSIBLE cause, never "confirmed" or "most likely":
// the code was not read and nothing was tested. A name must match NAME_OK (letters, digits, . _ -), so a hostile folder name never reaches a report.
const NAME_OK = /^[A-Za-z0-9._-]{1,60}$/;
const FATAL_LEVEL = /^(fatal error|parse error)$/;
function logCausesOf(entries = []) {
    const byName = new Map(); let fatalOutside = false;
    for (const e of entries) {
        if (!e || !FATAL_LEVEL.test(String(e.level || ''))) continue;
        const m = /^wp-content\/(plugins|themes)\/([^/]+)\//.exec(String(e.file || ''));
        if (!m || !NAME_OK.test(m[2])) { fatalOutside = true; continue; }
        const last = /^\d{4}-\d{2}-\d{2}/.test(String(e.last_seen || '')) ? String(e.last_seen).slice(0, 10) : null;
        const key = `${m[1]}:${m[2]}`, cur = byName.get(key);
        if (!cur) byName.set(key, { name: m[2], kind: m[1] === 'themes' ? 'theme' : 'plugin', last_seen: last });
        else if (last && (!cur.last_seen || last > cur.last_seen)) cur.last_seen = last;
    }
    const causes = [...byName.values()].sort((a, b) => (b.last_seen || '').localeCompare(a.last_seen || '') || a.name.localeCompare(b.name));
    return { causes, fatalOutside };
}
const OLDER_ERRORS = 'The log may also hold older errors, and the tool cannot tell if this is the error you see now.';
// the verdict of a no-files run WITH a log. causes: logCausesOf().causes (at most 3 are named, then "and N more"); checkFinds: the texts of the log checks that found something
function logVerdict({ statuses = [], failedLive = 0, causes = [], checkFinds = [], fatalOutside = false, empty = false } = {}) {
    const page = statuses.some(n => Number(n) >= 400) || failedLive > 0;
    const possible = causes.length > 0 || checkFinds.length > 0;
    const parts = [];
    const codes = [...new Set(statuses.map(Number).filter(n => n >= 400))].sort((a, b) => a - b);
    if (codes.length) parts.push(`The live page answered with an error (HTTP ${codes.join(' and HTTP ')}).`);
    if (failedLive > 0) parts.push(`${failedLive} live check${failedLive === 1 ? '' : 's'} failed.`);
    if (possible) {
        const shown = causes.slice(0, 3), more = causes.length - shown.length;
        const one = c => `${c.name}${c.last_seen ? ` (last seen ${c.last_seen})` : ''}`;
        const list = shown.map(one);
        const joined = more > 0 ? `${list.join(', ')} and ${more} more` : list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}` : list[0];
        if (causes.length) parts.push(causes.length === 1 ? `The log shows a fatal error in a file of ${joined}.` : `The log shows fatal errors in files of ${joined}.`);
        for (const t of checkFinds) parts.push(`${String(t).replace(/\s*\(and \d+ more\)\s*$/, '').replace(/^./, c => c.toUpperCase()).replace(/\.?$/, '.')}`);
        const many = causes.length + checkFinds.length > 1;
        parts.push(`${many ? 'These are possible causes' : 'This is a possible cause'}, not confirmed: the code was not read and nothing was tested.`);
        parts.push(OLDER_ERRORS);
    } else if (empty) parts.push('The log file is empty. This does not mean the site is fine.');
    else if (fatalOutside) parts.push('The last part of the log (up to 2 MB) was read. The log shows a fatal error, but no plugin or theme can be named from it. This does not mean the site is fine.');
    else parts.push('The last part of the log (up to 2 MB) was read. It has no fatal error that names a plugin or a theme. This does not mean the site is fine.');
    parts.push('To go further, give the site files.');
    const label = possible ? (page ? (only4xx(statuses, failedLive) ? 'The live page answered with an error, and the log shows a possible cause' : 'A problem was seen on the live page, and the log shows a possible cause') : 'The log shows a possible cause') : page ? errorPageLabel({ statuses, failedLive }) : 'No cause could be named from the log';
    return { label, text: parts.join(' '), see: possible ? parts.filter(p => !/^To go further/.test(p) && !/^The live page answered|live checks? failed/.test(p)) : [] };
}
// S3a: the live page checks in one sentence, NO site files only. Built from issue/checkpoints.js liveSummary (the real rows): "gave a result" is PASS, FAIL or ALSO NOTICED, never NOT CHECKED.
// When no live check ran at all (no address, or switched off) it never says "0 of N": it says that none ran, and why.
function liveChecksSentence(sum) {
    if (!sum || !(sum.total > 0)) return null;
    const NOT_PASS = 'A check that did not run is not a pass.';
    const why = String(sum.reason || '').replace(/[.\s]+$/, '');
    if (sum.none_ran) return `No live page check ran: ${why}. ${NOT_PASS}`;
    if (!sum.not_run) return `${sum.gave} of ${sum.total} live page checks gave a result.`;
    return `${sum.gave} of ${sum.total} live page checks gave a result. ${sum.not_run} could not run: ${why}. ${NOT_PASS}${sum.load_error ? ` ${require('./load-error').ONE_LOAD}` : ''}`;
}
// S3b: what the live page showed about plugins, theme and WordPress, in reader sentences (NO site files only). `sig` is issue/live-signals.js collect(). A source that found nothing gives no line.
// A version from a file address can be a cache number, and the generator tag can be hidden or changed: the sentences say so. Nothing here says a plugin is "active" or "installed".
function liveSignalsLines(sig) {
    if (!sig || typeof sig !== 'object') return [];
    const out = [];
    const vers = (e, src) => { const vs = (e.versions || []).filter(x => x.src === src).map(x => x.v); return vs.length ? `${vs.join('/')}${e.versions_more ? ` and ${e.versions_more} more` : ''}` : null; };
    const verText = e => { const parts = []; const a = vers(e, 'asset'), c = vers(e, 'comment'); if (a) parts.push(`version ${a} in the file address, which can be a cache number`); if (c) parts.push(`version ${c} named in a comment on the page`); return parts.length ? parts.join('; ') : 'version not shown'; };
    const short = e => { const v = vers(e, 'asset') || vers(e, 'comment'); return v ? `${e.slug} ${v}` : e.slug; };
    const joinList = (items, more) => (more > 0 ? `${items.join(', ')} and ${more} more` : items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}` : items[0]);
    if (sig.wordpress) out.push(`The page says it runs WordPress ${sig.wordpress} (from the generator tag, which can be hidden or changed).`);
    const pl = Array.isArray(sig.plugins) ? sig.plugins : [];
    if (pl.length) {
        const one = pl.length === 1 && !sig.plugins_more;
        out.push(one ? `The page loads files of: ${pl[0].slug} (${verText(pl[0])}). Plugins that load nothing on this page are not shown.`
            : `The page loads files of: ${joinList(pl.map(short), sig.plugins_more || 0)} (a number after a name is a version from a file address or a page comment, and can be a cache number). Plugins that load nothing on this page are not shown.`);
    }
    const nc = Array.isArray(sig.named_in_comments) ? sig.named_in_comments : [];
    if (nc.length) out.push(`A comment on the page names: ${joinList(nc.map(short), sig.named_in_comments_more || 0)}. A comment is not proof that the plugin is active.`);
    const th = Array.isArray(sig.themes) ? sig.themes : [];
    if (th.length) out.push(th.length === 1 && !sig.themes_more ? `The page loads files of the theme: ${th[0].slug} (${verText(th[0])}).` : `The page loads files of these themes: ${joinList(th.map(short), sig.themes_more || 0)}.`);
    return out;
}
// S3c: possible known conflicts (issue/live-conflicts.js match()), in reader sentences. Every data part (the cause text, the "beyond the source" text, the source title, its host and its date) is the entry's own text,
// not shortened and not reworded. `opts.prefix` ("the page loads files of") and `opts.partial` (the note that other plugins may exist) come from the CALLER: the matcher also serves sources other than the live page.
// Never says "installed" or "active", and never says that the conflict is the cause of THIS problem.
function liveConflictLines(res, opts = {}) {
    if (!res || !Array.isArray(res.conflicts) || !res.conflicts.length) return [];
    const list = (names, more) => (more > 0 ? `${names.join(', ')} and ${more} more` : names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0]);
    const prefix = String(opts.prefix || '').trim(), partial = String(opts.partial || '').trim();
    const out = res.conflicts.map(c => {
        const src = (c.sources || []).map(x => `"${x.title}" (${x.host})${x.checked ? `, checked ${x.checked}` : ''}`).join(' and ');
        return [`Possible, not confirmed: ${prefix} ${list(c.names, c.partners_more || 0)}.`, `What the source says: ${c.causes}`, c.beyond_sources, src ? `Source: ${src}.` : null, 'This does not show that it causes the problem you reported.', partial || null].filter(Boolean).join(' ');
    });
    if (res.more > 0) out.push(`And ${res.more} more possible conflicts.`);
    return out;
}
// S4c: NO site files, the live page answered without an error and no live check failed (a quiet page). The label and the sentence say what was looked at, and that this is not a clean bill of health.
//   some check noticed something (not tied to the problem): the "noticed" sentence, the label stays; otherwise the label says the live page checks found nothing wrong ("(N of 7)" when fewer than all gave a result).
//   A possible conflict line (S3c) adds one sentence. Built from the data: the counts come from the check rows.
const quietText = pages => `How sure we are: not very. ${pages > 1 ? `Only ${pages} public pages at the address were` : 'Only the public page at the address was'} loaded, without logging in. What was not looked at is listed in this report. This does not mean the site is fine, and it does not mean your problem is not real.`;
const noticedText = hasLog => `How sure we are: not very. A check noticed something that could not be linked to the problem you reported, because no site files${hasLog ? '' : ' or log'} were given (see below). Nothing is confirmed.`;
// the number of pages the probe planned (probe.json `planned.pages`), else the distinct page addresses it recorded; at least 1
function probedPageCount(probe) {
    const p = probe && typeof probe === 'object' ? probe : {};
    if (p.planned && Array.isArray(p.planned.pages) && p.planned.pages.length) return p.planned.pages.length;
    const urls = new Set((Array.isArray(p.pages) ? p.pages : []).map(x => x && x.url).filter(Boolean));
    return Math.max(1, urls.size);
}
function quietPageVerdict({ gave = 0, total = 0, noticed = 0, conflict = false, symptomSeen = false, pages = 1, hasLog = false } = {}) {
    if (symptomSeen) return null;   // the report already says the problem was seen on the site (the oracle): never "nothing wrong" next to it
    const tail = conflict ? ' A possible conflict is listed below; it is not confirmed.' : '';
    if (noticed > 0) return { label: 'No confirmed breaking cause was found', text: noticedText(hasLog) + tail };
    return { label: gave >= total ? 'The live page checks found nothing wrong' : `The live page checks that ran found nothing wrong (${gave} of ${total})`, text: quietText(pages) + tail };
}
// the symptom value (yes / no / could-not-test / null) in words
function symptomSentence(value) {
    if (value === 'yes' || value === true) return 'The problem was seen on the site.';
    if (value === 'no' || value === false) return 'The problem was not seen on the pages that were checked.';
    return 'The problem was not tested on the site.';
}
// the "Tested" line: no internal value (null, undefined, a status code) ever reaches the reader
function testedSentence(f) {
    const did = (f.timeline || []).filter(t => t.status === 'PASSED').length;
    const sb = f.sandbox ? f.sandbox.reproduced_in_sandbox : undefined;
    const sandbox = sb === true ? 'the problem was reproduced in the test copy (sandbox)' : sb === false ? 'the problem did not show in the test copy (sandbox)' : 'the test copy (sandbox) was not used';
    return `${did} ${did === 1 ? 'step' : 'steps'} ran; ${sandbox}${f.bisect ? '; a plugin-by-plugin test was run' : ''}${(f.retests || []).length ? `; ${f.retests.length} ${f.retests.length === 1 ? 'retest' : 'retests'}` : ''}.`;
}
// a title that was cut inside a word (the wizard keeps the first 100 characters of the description): cut back to the last whole word and add an ellipsis
// a title that is too long: cut at the last whole word (total length <= max) and add an ellipsis
function clipTitle(text, max) {
    const t = String(text || '');
    if (t.length <= max) return t;
    const head = t.slice(0, max - 1), cut = head.lastIndexOf(' ');
    return /\s/.test(t[max - 1]) ? `${head.replace(/[\s,;:.-]+$/, '')}\u2026` : cut > 0 ? `${head.slice(0, cut).replace(/[\s,;:.-]+$/, '')}\u2026` : `${head}\u2026`;
}
function shortTitle(title, description) {
    const t = String(title || ''), d = String(description || '').replace(/\s+/g, ' ').trim();
    if (!t || !d || d.length <= t.length || !d.startsWith(t)) return t;
    if (!/\w/.test(t[t.length - 1]) || !/\w/.test(d[t.length])) return t;     // it ends at a word boundary: not cut inside a word
    const cut = t.lastIndexOf(' ');
    return cut > 0 ? `${t.slice(0, cut).replace(/[\s,;:.-]+$/, '')}…` : t;
}
// a site log larger than the read cap: only its end was read. "mostly repeats the same warnings" only when >= 80% of the log entries read are notice / warning / deprecated.
// What the intake step wrote about the ORIGINAL log ("copied and redacted (the last 2 MB of 262570 KB); ...; the last 2 MB of this log had no fatal error, so 48 MB before it were also read (48 MB of 256 MB)").
// The copy that is analysed holds only the last 2 MB, so logs.json alone never knows the size of the original. -> { original_mb, parts: ['the last 2 MB', '48 MB before that'] } or null.
function logRead(intakeSteps) {
    const st = (Array.isArray(intakeSteps) ? intakeSteps : []).find(x => x && x.id === 'intake-log');
    if (!st) return null;
    if (st.log_read && st.log_read.original_bytes) { const mbOf = b => Math.max(1, Math.round(b / 1048576)); return { original_mb: mbOf(st.log_read.original_bytes), parts: (st.log_read.parts || []).map(p => `${mbOf(p.bytes)} MB ${p.direction === 'forwards' ? 'from the start' : 'before that'}`) }; }
    const m = /the last 2 MB of (\d+) KB/.exec(String(st.reason || ''));
    if (!m) return null;
    const parts = []; const deep = /so ([^()]*?) were also read/.exec(String(st.reason || ''));
    if (deep) for (const p of deep[1].split(' and ')) { const q = /([\d.]+) MB (before it|from the start)/.exec(p); if (q) parts.push(`${q[1]} MB ${q[2] === 'before it' ? 'before that' : 'from the start'}`); }
    return { original_mb: Math.max(1, Math.round(Number(m[1]) / 1024)), parts };
}
function logNote(logs, intakeSteps) {
    const read = logRead(intakeSteps);
    if (read && read.original_mb > 2) {
        const entries = ((logs && logs.entries) || []), total = entries.reduce((a, e) => a + (e.count || 1), 0);
        const soft = entries.filter(e => ['notice', 'warning', 'deprecated'].includes(e.level)).reduce((a, e) => a + (e.count || 1), 0);
        const noisy = total > 0 && soft / total >= 0.8;
        return `Your log is very large (about ${read.original_mb} MB)${noisy ? ' and mostly repeats the same warnings' : ''}. Only part of it was read (${['the last 2 MB', ...read.parts].join(', then ')}), so older errors may not be shown.`;
    }
    const files = ((logs && logs.files) || []).filter(f => f.truncated);
    if (!files.length) return null;
    const mb = Math.max(1, Math.round(files.reduce((a, f) => a + (f.bytes || 0), 0) / (1024 * 1024)));
    const entries = (logs.entries || []), total = entries.reduce((a, e) => a + (e.count || 1), 0);
    const soft = entries.filter(e => ['notice', 'warning', 'deprecated'].includes(e.level)).reduce((a, e) => a + (e.count || 1), 0);
    const noisy = total > 0 && soft / total >= 0.8;
    return `Your log is very large (about ${mb} MB)${noisy ? ' and mostly repeats the same warnings' : ''}. Only the most recent part was read, so older errors may not be shown.`;
}
// checkpoints (issue/checkpoints.js evaluate()) in plain words: the counts as ONE dot line (REPORT-SPEC Part 2: the old "We looked at N things" sentence is gone), and one line per checkpoint (no ids)
const CP_WORD = { PASS: 'Pass', FAIL: 'Fail', 'ALSO NOTICED': 'Also noticed', 'NOT CHECKED': 'Not checked' };
const countsLine = counts => `${counts.pass} pass · ${counts.fail} fail · ${counts.not_checked} not checked · ${counts.also_noticed || 0} also noticed`;
function checkpointText(items, counts) {
    const sentence = countsLine(counts);
    const lines = items.map(c => {
        const r = String(c.reason || '').trim().replace(/[.\s]+$/, '');
        return c.result === 'PASS' ? `Pass: ${c.title}${r ? ` (${r})` : ''}` : `${CP_WORD[c.result] || 'Not checked'}: ${c.title}${r ? `: ${r}` : ''}`;
    });
    return { sentence, lines };
}

module.exports = { quietPageVerdict, probedPageCount, errorPageLabel, liveConflictLines, liveSignalsLines, liveChecksSentence, logCausesOf, logVerdict, NAME_OK, ERROR_PAGE_LABEL, errorPageSentence, NOTHING_CHECKED_LABEL, zeroChecksSentence, readerFiles, readerDates, countsLine, clipTitle, confidenceSentence, symptomSentence, testedSentence, shortTitle, logNote, logRead, checkpointText, SURE_LEVEL, readerWhy, readerValidationLines, readerStepLine, checkStatusWord, INTERNAL_TERM,  componentLabel, plainRef, plainText, namesOf, STATUS_WORD, statusWord, LIKELY_PHRASE, notTested, sandboxAsked, mergeTitles, cap };
