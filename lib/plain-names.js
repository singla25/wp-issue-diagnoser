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
const INTERNAL_TERM = /(?<![A-Za-z0-9_-])(?:oracle|recomput\w*|stored|NOT_RUN)(?![A-Za-z0-9_-])/i;
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
    const line = `${label}${t.reason ? `: ${String(t.reason).slice(0, 140)}` : ` (${checkStatusWord(t.status).toLowerCase()})`}`;
    return line;
}

module.exports = { readerWhy, readerValidationLines, readerStepLine, checkStatusWord, INTERNAL_TERM,  componentLabel, plainRef, plainText, namesOf, STATUS_WORD, statusWord, LIKELY_PHRASE, notTested, sandboxAsked, mergeTitles, cap };
