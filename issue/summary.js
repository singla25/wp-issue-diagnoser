// The plain-English summary at the top of a report. Pure and deterministic; assigns nothing. Written for someone who is not technical:
// no "hypothesis", no "oracle", no "hooks", and never a claim that the site "is hacked" (compromise signs are a pattern match, not proof).
// The kind of problem (the conflict-type label) is NOT used as an explanation here: the plain cause line is enough. The label stays in the data.

const COMPROMISE_SENTENCE = 'Possible compromise signs were found (pattern match, not proof).';
const COMPROMISE_ADVICE = 'Do not delete files yourself; ask your host or a security professional to check, and keep a backup.';
const NO_CHECK = 'Note: no live check or sandbox test was run, so nothing here was seen failing on your website.';
const NOT_HEALTHY = 'This does not mean the site is healthy.';
const cap = s => String(s).replace(/^./, c => c.toUpperCase());
const plural = (n, one, many) => (n === 1 ? one : many);

// split: result of gate.split. ran: { probe, sandbox } booleans. -> { headline, lines, text, counts }
function summarise(split, { ran = {}, verbose = false } = {}) {
    const compromise = split.findings.filter(f => f.label === 'compromise' || f.class === 'compromise');
    const causes = split.findings.filter(f => !compromise.includes(f));
    const adv = split.advisories, backed = adv.filter(a => a.backed_by_log && a.backed_by_log.length);
    const lines = [];
    let headline;
    if (causes.length) {
        const seen = causes.filter(f => !f.log_only);            // seen failing on the site (live page or sandbox), not only written in a log
        const n = causes.length;
        headline = seen.length
            ? `We found ${n} confirmed ${plural(n, 'cause', 'causes')} that ${plural(n, 'breaks', 'break')} your website.`
            : `${n} confirmed ${plural(n, 'cause was', 'causes were')} found in your logs.`;
        lines.push(headline);
        for (const f of causes) { lines.push(`  • ${cap(f.cause)}${f.log_only && seen.length ? ' (found in your logs)' : ''}.`); for (const m of f.more_lines || []) lines.push(m); }
    } else {
        headline = 'No confirmed breaking cause was found.';
        lines.push(headline);
    }
    if (compromise.length) {
        const files = [...new Set(compromise.flatMap(f => (f.evidence || []).map(e => e.file)).filter(Boolean))];
        lines.push(`${COMPROMISE_SENTENCE} A person should look at: ${files.slice(0, 5).join(', ')}${files.length > 5 ? ` and ${files.length - 5} more` : ''}.`);
        lines.push(COMPROMISE_ADVICE);
    }
    if (adv.length) lines.push(verbose ? `${adv.length} possible ${plural(adv.length, 'cause is', 'causes are')} listed under Advisories below.` : `${adv.length} possible ${plural(adv.length, 'cause is', 'causes are')} listed under Advisories (run with --verbose to see ${plural(adv.length, 'it', 'them')}).`);
    else if (!causes.length && !compromise.length) lines.push('Nothing else stood out.');
    if (backed.length) {
        const who = backed.flatMap(a => a.backed_by_log.map(b => `${b.file}${b.component ? ` (plugin ${b.component})` : ''}`));
        const uniq = [...new Set(who)];
        lines.push(`${backed.length} of them ${plural(backed.length, 'is', 'are')} backed by a log error but ${plural(backed.length, 'was', 'were')} not confirmed: ${uniq.slice(0, 3).join('; ')}${uniq.length > 3 ? ` and ${uniq.length - 3} more` : ''}.`);
    }
    const nothingRan = !ran.probe && !ran.sandbox;
    if (nothingRan) lines.push(NO_CHECK);
    if (ran.sandboxFailed) lines.push(`Note: the sandbox test could not run, and this is no evidence either way: ${String(ran.sandboxFailed).replace(/[.\s]+$/, "")}.`);
    if (nothingRan && !causes.length && !compromise.length && !adv.length) lines.push(NOT_HEALTHY);
    return { headline, lines, text: lines.join('\n'), counts: split.counts, compromise_sentence: compromise.length ? COMPROMISE_SENTENCE : null };
}

module.exports = { summarise, COMPROMISE_SENTENCE, COMPROMISE_ADVICE, NO_CHECK, NOT_HEALTHY };
