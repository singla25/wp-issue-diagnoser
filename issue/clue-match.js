// Does a finding that nobody asked about have anything to do with THIS report? Used by the classic adapter and by the new cross-component
// comparisons, so the short list is not buried under every benign duplicate in a large site.
//   named           a component of the finding is named by the evidence (a log path, a mention, the component hints)
//   log-file        a file the finding cites is a file a log line names (error site or stack trace)
//   symptom-family  the kind of problem normally produces the reported symptom. The default symptom "other" matches nothing here: it says nothing.
// P0 passes without a clue (it breaks the site by itself). Pure and deterministic.

const toRef = id => String(id).replace(/^plugin:/, '');

function context(evidence, issue, families) {
    const hints = (evidence.component_hints || []).slice(0, 8).map(h => toRef(h.component));
    const clues = evidence.clues || [];
    const named = new Set([...hints, ...clues.filter(c => c.type === 'component-path' || c.type === 'component-mention').map(c => toRef(c.value))]);
    const logFiles = new Set(clues.filter(c => c.source && c.source.kind === 'log' && c.detail && c.detail.file).map(c => c.detail.file));
    return { named, logFiles, symptom: (issue && issue.symptom) || 'other', families: families || {} };
}

// finding: { components, evidence:[{file}], severity, family }  -> { ok, why }
function matches(finding, cx) {
    const named = (finding.components || []).filter(c => cx.named.has(toRef(c)));
    if (named.length) return { ok: true, why: `names ${named.join(', ')}` };
    const files = (finding.evidence || []).map(e => e.file).filter(Boolean).filter(f => cx.logFiles.has(f));
    if (files.length) return { ok: true, why: `a log names ${files[0]}` };
    if (cx.symptom !== 'other' && finding.family && cx.families[finding.family] && cx.families[finding.family].includes(cx.symptom)) return { ok: true, why: `a ${finding.family} problem normally produces "${cx.symptom}"` };
    if (finding.severity === 'P0') return { ok: true, why: 'P0: breaks the site by itself' };
    return { ok: false, why: 'nothing in the report points at it' };
}

module.exports = { context, matches, toRef };
