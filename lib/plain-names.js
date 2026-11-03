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
// -> [string]: "Passed: <reason>" per check, no check id; then the notes. Deterministic.
function readerWhy(h) {
    const out = [];
    for (const c of (h && h.checks) || []) {
        if (HIDDEN_CHECK_IDS.has(c.id)) continue;
        const line = `${checkStatusWord(c.status)}: ${c.reason}`;
        if (!INTERNAL_TERM.test(line)) out.push(line);
    }
    for (const n of (h && h.validation_notes) || []) if (!INTERNAL_TERM.test(n)) out.push(`Note: ${n}`);
    return out;
}
// the command line (gate mode, --verbose): the same lines for the whole validation
function readerValidationLines(val) {
    const out = [];
    for (const c of (val && val.checks) || []) {
        if (HIDDEN_CHECK_IDS.has(c.id)) continue;
        const line = `  ${checkStatusWord(c.status).padEnd(8)} ${c.reason}`;
        if (!INTERNAL_TERM.test(line)) out.push(line);
    }
    for (const h of (val && val.hypotheses) || []) {
        out.push(`  ${statusWord(h.status).padEnd(24)} ${h.title}`);
        for (const n of h.validation_notes || []) if (!INTERNAL_TERM.test(n)) out.push(`      ${n}`);
    }
    return out;
}
// "Not tested" in the Verdict: a plain label, the reason, no status code
const STEP_LABEL = { oracle: 'Check that the problem shows on the page' };
function readerStepLine(t) {
    const label = STEP_LABEL[t.id] || t.label;
    const reason = t.reason ? String(t.reason).replace(/symptom reproduced: could[ -]not[ -]test/i, 'the problem could not be tested on the site') : '';
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
function confidenceSentence(confidence, label, { reproduced = false } = {}) {
    const level = SURE_LEVEL[String(confidence)] || 'not very';
    let reason = (SURE_REASON.find(r => r[0].test(String(label))) || [null, ''])[1];
    if (/^Confirmed breaking cause found/.test(String(label)) && reproduced) reason = SURE_REASON[4][1];
    return `How sure we are: ${level}.${reason ? ` ${reason}` : ''}`;
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
function logNote(logs) {
    const files = ((logs && logs.files) || []).filter(f => f.truncated);
    if (!files.length) return null;
    const mb = Math.max(1, Math.round(files.reduce((a, f) => a + (f.bytes || 0), 0) / (1024 * 1024)));
    const entries = (logs.entries || []), total = entries.reduce((a, e) => a + (e.count || 1), 0);
    const soft = entries.filter(e => ['notice', 'warning', 'deprecated'].includes(e.level)).reduce((a, e) => a + (e.count || 1), 0);
    const noisy = total > 0 && soft / total >= 0.8;
    return `Your log is very large (about ${mb} MB)${noisy ? ' and mostly repeats the same warnings' : ''}. Only the most recent part was read, so older errors may not be shown.`;
}
// checkpoints (issue/checkpoints.js evaluate()) in plain words: the counts sentence, and one line per checkpoint (no ids)
const CP_WORD = { PASS: 'Pass', FAIL: 'Fail', 'NOT CHECKED': 'Not checked' };
function checkpointText(items, counts) {
    const sentence = `We looked at ${counts.total} things: ${counts.pass} pass, ${counts.fail} fail, ${counts.not_checked} not checked.`;
    const lines = items.map(c => {
        const r = String(c.reason || '').trim().replace(/[.\s]+$/, '');
        return c.result === 'PASS' ? `Pass: ${c.title}${r ? ` (${r})` : ''}` : `${CP_WORD[c.result] || 'Not checked'}: ${c.title}${r ? `: ${r}` : ''}`;
    });
    return { sentence, lines };
}

module.exports = { clipTitle, confidenceSentence, symptomSentence, testedSentence, shortTitle, logNote, checkpointText, SURE_LEVEL, readerWhy, readerValidationLines, readerStepLine, checkStatusWord, INTERNAL_TERM,  componentLabel, plainRef, plainText, namesOf, STATUS_WORD, statusWord, LIKELY_PHRASE, notTested, sandboxAsked, mergeTitles, cap };
