// The plain-English summary at the top of a report. Pure and deterministic; assigns nothing. Written for someone who is not technical:
// no "hypothesis", no "oracle", no "hooks", and never a claim that the site "is hacked" (compromise signs are a pattern match, not proof).

const LABEL_TEXT = {
    'plugin-plugin': 'two plugins clash',
    'theme-plugin': 'your theme and a plugin clash',
    hook: 'two parts of the site act on the same WordPress step',
    'plugin-core-php': 'a problem involving PHP or WordPress itself',
    'environment-server': 'a limit or a setting of your hosting',
    compromise: 'possible compromise signs',
    unclassified: 'a single plugin, theme or file'
};
const COMPROMISE_SENTENCE = 'Possible compromise signs were found (pattern match, not proof).';
const NO_CHECK = 'Note: no live check or sandbox test was run, so nothing here was seen failing on your website.';
const cap = s => String(s).replace(/^./, c => c.toUpperCase());
const plural = (n, one, many) => (n === 1 ? one : many);

// split: result of gate.split. ran: { probe, sandbox } booleans. -> { headline, lines, text }
function summarise(split, { ran = {} } = {}) {
    const compromise = split.findings.filter(f => f.label === 'compromise' || f.class === 'compromise');
    const causes = split.findings.filter(f => !compromise.includes(f));
    const adv = split.advisories, backed = adv.filter(a => a.backed_by_log && a.backed_by_log.length);
    const lines = [];
    let headline;
    if (causes.length) {
        headline = `We found ${causes.length} confirmed ${plural(causes.length, 'cause', 'causes')} that ${plural(causes.length, 'breaks', 'break')} your website.`;
        lines.push(headline);
        for (const f of causes) lines.push(`  • ${cap(f.cause)} (${LABEL_TEXT[f.label] || LABEL_TEXT.unclassified}).`);
    } else {
        headline = 'No confirmed breaking cause was found.';
        lines.push(headline);
    }
    if (compromise.length) {
        const files = [...new Set(compromise.flatMap(f => (f.evidence || []).map(e => e.file)).filter(Boolean))];
        lines.push(`${COMPROMISE_SENTENCE} A person should look at: ${files.slice(0, 5).join(', ')}${files.length > 5 ? ` and ${files.length - 5} more` : ''}.`);
    }
    if (adv.length) lines.push(`${adv.length} possible ${plural(adv.length, 'cause is', 'causes are')} listed under Advisories (run with --verbose to see ${plural(adv.length, 'it', 'them')}).`);
    else if (!causes.length && !compromise.length) lines.push('Nothing else stood out.');
    if (backed.length) {
        const who = backed.flatMap(a => a.backed_by_log.map(b => `${b.file}${b.component ? ` (plugin ${b.component})` : ''}`));
        const uniq = [...new Set(who)];
        lines.push(`${backed.length} of them ${plural(backed.length, 'is', 'are')} backed by a log error but ${plural(backed.length, 'was', 'were')} not confirmed: ${uniq.slice(0, 3).join('; ')}${uniq.length > 3 ? ` and ${uniq.length - 3} more` : ''}.`);
    }
    if (!ran.probe && !ran.sandbox) lines.push(NO_CHECK);
    return { headline, lines, text: lines.join('\n'), counts: split.counts, compromise_sentence: compromise.length ? COMPROMISE_SENTENCE : null };
}

module.exports = { summarise, LABEL_TEXT, COMPROMISE_SENTENCE, NO_CHECK };
