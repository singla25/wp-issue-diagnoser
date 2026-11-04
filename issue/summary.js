// The plain-English summary at the top of a report. Pure and deterministic; assigns nothing. Written for someone who is not technical:
// no "hypothesis", no "oracle", no "hooks", and never a claim that the site "is hacked" (compromise signs are a pattern match, not proof).
// The kind of problem (the conflict-type label) is NOT used as an explanation here: the plain cause line is enough. The label stays in the data.

const plain = require('../lib/plain-names');
const COMPROMISE_SENTENCE = 'Possible compromise signs were found (pattern match, not proof).';
const COMPROMISE_ADVICE = 'Do not delete files yourself; ask your host or a security professional to check, and keep a backup.';
const NO_CHECK = 'Note: no live check or sandbox test was run, so nothing here was seen failing on your website.';
const NOT_HEALTHY = 'This does not mean the site is healthy.';
const WHAT_IS_WRONG = 'What is wrong';
const cap = s => String(s).replace(/^./, c => c.toUpperCase());
const plural = (n, one, many) => (n === 1 ? one : many);

// split: result of gate.split. ran: { probe, sandbox } booleans. -> { headline, lines, text, counts }
// the advisories by name, merged: 'an outdated template override (5 templates)'
function advisoryNames(adv) {
    const groups = new Map();
    for (const a of adv) {
        const head = String(a.title || a.cause || 'a possible cause').split(':')[0].trim().replace(/^./, c => c.toLowerCase());
        const g = groups.get(head) || { n: 0, tpl: a.type === 'template-override-outdated' };
        g.n += a.merged || 1; groups.set(head, g);
    }
    return [...groups.entries()].map(([head, g]) => `${/^[aeiou]/i.test(head) ? 'an' : 'a'} ${head}${g.n > 1 ? ` (${g.n} ${g.tpl ? 'templates' : 'times'})` : ''}`);
}

function summarise(split, { ran = {}, verbose = false, checkpointSentence = null, logNote = null } = {}) {
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
        for (const f of causes) lines.push(`  • ${cap(f.cause)}${f.log_only && seen.length ? ' (found in your logs)' : ''}.`);
    } else {
        // a log-backed most likely cause exists: the same one phrase as the verdict, never "no confirmed cause" next to the same item
        headline = (split.likely || []).length ? plain.LIKELY_PHRASE : 'No confirmed breaking cause was found.';
        lines.push(headline);
    }
    // the "What is wrong" box: a log fatal that names a file (issue/whats-wrong.js)
    if (split.box) { lines.push(`${split.box.heading}:`); for (const l of split.box.lines) lines.push(`  ${l}`); }
    // `lines` / `text` stay as they were; the report (page, Markdown, command line) adds the checkpoint counts and the log note right after the "What is wrong" block
    const extraAt = lines.length, extras = [checkpointSentence, logNote].filter(Boolean);
    if (compromise.length) {
        const files = [...new Set(compromise.flatMap(f => (f.evidence || []).map(e => e.file)).filter(Boolean))];
        lines.push(`${COMPROMISE_SENTENCE} A person should look at: ${files.slice(0, 5).join(', ')}${files.length > 5 ? ` and ${files.length - 5} more` : ''}.`);
        lines.push(COMPROMISE_ADVICE);
    }
    const advHint = adv.length && !verbose ? `${adv.length} possible ${plural(adv.length, 'cause is', 'causes are')} listed under Advisories (run with --verbose to see ${plural(adv.length, 'it', 'them')}).` : null;
    if (adv.length) lines.push(verbose ? `${adv.length} possible ${plural(adv.length, 'cause is', 'causes are')} listed under Advisories below.` : `${adv.length} possible ${plural(adv.length, 'cause is', 'causes are')} listed under Advisories (run with --verbose to see ${plural(adv.length, 'it', 'them')}).`);
    else if (!causes.length && !compromise.length) lines.push('Nothing else stood out.');
    if (backed.length) {
        const who = backed.flatMap(a => a.backed_by_log.map(b => `${b.file}${b.component ? ` (${b.component_label || plain.componentLabel(b)})` : ''}`));
        const uniq = [...new Set(who)];
        lines.push(`${backed.length} of them ${plural(backed.length, 'is', 'are')} backed by a log error but ${plural(backed.length, 'was', 'were')} not confirmed: ${uniq.slice(0, 3).join('; ')}${uniq.length > 3 ? ` and ${uniq.length - 3} more` : ''}.`);
    }
    const nothingRan = !ran.probe && !ran.sandbox;
    if (nothingRan) lines.push(NO_CHECK);
    if (ran.sandboxFailed) lines.push(`Note: the sandbox test could not run, and this is no evidence either way: ${String(ran.sandboxFailed).replace(/[.\s]+$/, "")}.`);
    if (nothingRan && !causes.length && !compromise.length && !adv.length) lines.push(NOT_HEALTHY);
    // the web page never says "run with --verbose": it names the advisories (they are listed, collapsed, on the page)
    const withExtras = ls => ls.slice(0, extraAt).concat(extras, ls.slice(extraAt));
    // the report (Markdown, command line) shows the headline once and puts a "What is wrong" line before the box; the page and `lines` keep their own layout
    let repBase = lines.slice(), repAt = extraAt;
    if (split.box) {
        const hi = repBase.indexOf(`${split.box.heading}:`);
        if (hi >= 0) {
            let at = hi;
            if (repBase[0] === split.box.heading) { repBase.shift(); repAt--; at--; }
            repBase.splice(at, 0, WHAT_IS_WRONG); repAt++;
        }
    }
    const reportLines = repBase.slice(0, repAt).concat(extras, repBase.slice(repAt));
    const linesHtml = withExtras(advHint ? lines.map(l => (l === advHint ? `${adv.length} possible ${plural(adv.length, 'cause is', 'causes are')} listed under Advisories: ${advisoryNames(adv).join('; ')}.` : l)) : lines);
    const cut = ls => ls.filter(l => !(split.box && (l === `${split.box.heading}:` || split.box.lines.some(b => l === `  ${b}`))));
    return { headline, lines, text: lines.join('\n'), counts: split.counts, report_lines: reportLines, text_report: reportLines.join('\n'), lines_html: linesHtml, ...(split.box ? { lines_html_without_box: cut(linesHtml) } : {}), compromise_sentence: compromise.length ? COMPROMISE_SENTENCE : null, ...(split.box ? { box: split.box, lines_without_box: lines.filter(l => !(l === `${split.box.heading}:` || split.box.lines.some(b => l === `  ${b}`))) } : {}) };
}

module.exports = { WHAT_IS_WRONG, summarise, advisoryNames, COMPROMISE_SENTENCE, COMPROMISE_ADVICE, NO_CHECK, NOT_HEALTHY };
