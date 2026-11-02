// The gate: which validated hypotheses are FINDINGS (shown) and which are ADVISORIES (listed, with the reason they were not shown). It labels and splits;
// it never assigns, changes or upgrades a status: CONFIRMED / REPRODUCIBLE / REJECTED_FALSE_POSITIVE belong to issue/validate.js alone. Pure and deterministic.
//
//   FINDING = established AND breaking
//     established  the validated status is CONFIRMED or REPRODUCIBLE; or the hypothesis is class "compromise" (always shown, whatever its status,
//                  unless it is REJECTED_FALSE_POSITIVE; breaking is not required for it)
//     breaking     direct evidence of an effect on the site, from the hypothesis' OWN validated supports (an unrelated 5xx on the page proves nothing about it):
//                    log       a PHP fatal in a log whose line names a file
//                    bisect    the sandbox reproduced the symptom with these components and the issue's oracle fired for a 5xx, a blank page, a critical error,
//                              a redirect loop / chain / other host, a failed login / REST / checkout request, or a JavaScript error
//                    probe     the live page showed a page error, a 5xx, a redirect problem, or a failed request on login / REST / checkout
//                  a redirect-on-hook hypothesis that rests only on what the reporter said (no redirect seen by the probe or the sandbox) is "reported, not observed"
//   everything else is an ADVISORY with a primary reason (advisory | reported-not-observed | not-established | not-breaking) and every reason that applies.
//   A hypothesis that is not established but has a log fatal naming a file is an advisory AND is counted as "backed by a log error" (the summary names the file).

const { label } = require('./conflict-type');
const { cause } = require('./cause');
const ownership = require('../lib/ownership');

const ESTABLISHED = new Set(['CONFIRMED', 'REPRODUCIBLE']);
const FATAL_CLUES = new Set(['php-fatal', 'php-redeclare', 'php-undefined-function', 'php-class-not-found', 'wp-critical-error']);
const REQUEST_AREAS = /login|wp-json|\/checkout|\/cart|admin-ajax|wc-ajax/i;

const clueIndex = clues => new Map((clues || []).map(c => [c.id, c]));

// the file a log fatal names: its own detail, or the "php-location" clue of the same log line
function fatalFile(clue, clues) {
    if (!clue || !FATAL_CLUES.has(clue.type)) return null;
    if (clue.detail && clue.detail.file) return clue.detail.file;
    const loc = (clues || []).find(x => x.type === 'php-location' && x.source && clue.source && x.source.ref === clue.source.ref && x.source.line === clue.source.line && x.detail && x.detail.file);
    return loc ? loc.detail.file : null;
}
const componentOfFile = f => { const c = ownership.componentOf(f || ''); return c ? c.replace(/^plugin:/, '') : null; };

// does an oracle that fired (matches = what it found) describe a breaking effect? -> a short reason or null
function oracleBreaking(type, matches) {
    const text = (matches || []).map(m => m.detail || '').join(' | ');
    switch (type) {
        case 'http-5xx': return 'the page answered with a server error (5xx)';
        case 'redirect': return 'the page ended in a redirect loop, a long redirect chain or another host';
        case 'generic': {
            if (/redirect loop|redirects in a row|another host/i.test(text)) return 'the page ended in a redirect problem';
            if (/blank|critical-error|critical error|Fatal error|Parse error/i.test(text)) return 'the page was blank or showed a critical error';
            if (/HTTP 5\d\d|answered HTTP 5/i.test(text)) return 'the page answered with a server error (5xx)';
            if (/JavaScript: .*(Uncaught|is not a function|is not defined)/i.test(text)) return 'a JavaScript error stopped a feature';
            return null;
        }
        case 'request-failed': return REQUEST_AREAS.test(text) ? 'a request for login, the REST API or checkout failed' : null;
        case 'console-error': return /Uncaught|is not a function|is not defined|TypeError|ReferenceError/i.test(text) ? 'a JavaScript error stopped a feature' : null;
        case 'debug-log': return /PHP (Fatal|Parse)|Fatal error|Parse error/i.test(text) && /\.php/.test(text) ? 'a PHP fatal error naming a file was written to the log' : null;
        default: return null;
    }
}

// supports of one kind that survived validation
const validated = (h, kind) => ((h.independent_kinds || []).includes(kind) ? (h.supports || []).filter(s => s.kind === kind) : []);

function logEvidence(h, ctx, idx) {
    const out = [];
    for (const s of validated(h, 'log')) {
        const clue = idx.get(s.ref), file = fatalFile(clue, ctx.clues);
        if (file) out.push({ kind: 'log', file, component: componentOfFile(file), reason: `a log error names ${file}` });
    }
    return out;
}
function probeEvidence(h, ctx, idx) {
    const out = [];
    for (const s of validated(h, 'probe')) {
        const c = idx.get(s.ref); if (!c) continue;
        const d = c.detail || {};
        let why = null;
        if (c.type === 'probe-page-error') why = 'a JavaScript error stopped a feature on the live page';
        else if (c.type === 'probe-console-error' && /^Uncaught|is not a function|is not defined/i.test(c.value || '')) why = 'a JavaScript error stopped a feature on the live page';
        else if (c.type === 'probe-http-status' && Number(d.status) >= 500) why = 'the live page answered with a server error (5xx)';
        else if (c.type === 'probe-redirect') why = 'the live page showed a redirect problem';
        else if (c.type === 'probe-failed-asset' && (Number(d.status) >= 500 || REQUEST_AREAS.test(d.url || ''))) why = 'a request for login, the REST API or checkout failed on the live page';
        if (why) out.push({ kind: 'probe', reason: why, clue: c.id });
    }
    return out;
}
function bisectEvidence(h, ctx) {
    const sb = ctx.sandbox || {};
    if (!validated(h, 'bisect').length || sb.reproduced !== 'yes') return [];
    const why = oracleBreaking(ctx.oracleType, sb.matches);
    return why ? [{ kind: 'bisect', reason: `in the sandbox, ${why} only with these components active` }] : [];
}
// a redirect-on-hook candidate rests on the code plus an observed redirect; the sandbox may have seen it
function sandboxRedirect(h, ctx) {
    return h.type === 'redirect-on-hook' && ctx.sandbox && ctx.sandbox.ran && ctx.sandbox.redirectObserved ? [{ kind: 'sandbox', reason: 'the sandbox copy showed a redirect problem' }] : [];
}

function breaking(h, ctx, idx) {
    const because = [...logEvidence(h, ctx, idx), ...bisectEvidence(h, ctx), ...probeEvidence(h, ctx, idx), ...sandboxRedirect(h, ctx)];
    return because;
}

// hyps: validated hypotheses (validation.json). ctx: { clues, oracleType, sandbox:{ran,reproduced,matches,redirectObserved}, probe:{ran}, obsOf, names, kinds }
function split(hyps, ctx = {}) {
    const idx = clueIndex(ctx.clues);
    const lctx = { ...ctx, clueById: id => idx.get(id) || null };
    const findings = [], advisories = [];
    let rejected = 0;
    for (const h of hyps) {
        if (h.status === 'REJECTED_FALSE_POSITIVE') { rejected++; continue; }
        const lab = label(h, lctx), plain = cause(h, lctx);
        const compromise = h.class === 'compromise';
        const established = ESTABLISHED.has(h.status) || compromise;
        const because = breaking(h, ctx, idx);
        const logBacked = logEvidence(h, ctx, idx);
        const base = { id: h.id, type: h.type, title: h.title, status: h.status, label: lab.label, label_candidates: lab.candidates, cause: plain, components: h.components || [], class: h.class || null,
            severity: h.severity || null, evidence: h.evidence || [], mechanism: h.mechanism || null, ownership: h.ownership || null, fix_eligible: !!h.fix_eligible, active_state: h.active_state || null };
        if (!h.advisory && established && (compromise || because.length)) {
            findings.push({ ...base, established: compromise ? 'compromise' : h.status, breaking_because: because, shown_because: compromise ? 'compromise signs are always shown' : 'established and breaking' });
            continue;
        }
        const reasons = [];
        if (h.advisory) reasons.push('advisory');
        if (h.type === 'redirect-on-hook' && !because.length) reasons.push('reported-not-observed');
        if (!established) reasons.push('not-established');
        if (established && !because.length && h.type !== 'redirect-on-hook') reasons.push('not-breaking');
        const primary = reasons[0] || 'not-breaking';
        advisories.push({ ...base, why_not_shown: { primary, all: reasons }, breaking_evidence: because, backed_by_log: !established ? logBacked : [] });
    }
    const order = (a, b) => (a.label === 'compromise' ? 0 : 1) - (b.label === 'compromise' ? 0 : 1) || String(a.id).localeCompare(String(b.id));
    findings.sort(order);
    advisories.sort((a, b) => a.why_not_shown.primary.localeCompare(b.why_not_shown.primary) || String(a.id).localeCompare(String(b.id)));
    return { findings, advisories, rejected, counts: { findings: findings.length, advisories: advisories.length, rejected, backed_by_log: advisories.filter(a => a.backed_by_log.length).length } };
}

module.exports = { split, oracleBreaking, fatalFile, FATAL_CLUES, ESTABLISHED, REQUEST_AREAS };
