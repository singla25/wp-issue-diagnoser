// issue.html in GATE mode (issue investigate --gate): the same client script, patched at build time. issue-html-client.js itself is not touched, so with the gate off
// the page is byte-identical to what it was before step 7b. Each patch names the exact text it replaces; if the client changes and a patch no longer fits, build()
// throws (and the tests fail) instead of producing a wrong page. Nothing here uses innerHTML: every text goes in through textContent.

const PATCHES = [];
const patch = (anchor, replacement, where = 'after') => PATCHES.push({ anchor, replacement, where });

// 1. which hypotheses are listed: the findings, plus the advisories only with --verbose
patch("    var live = F.hypotheses.filter(function (h) { return h.status !== 'REJECTED_FALSE_POSITIVE'; });\n", `    // gate mode (issue investigate --gate): what is shown is the findings; the advisories are listed only with --verbose
    var G = F.gate || null;
    if (G && !G.verbose) { var shownIds = {}; (F.findings || []).concat(F.likely || []).forEach(function (x) { shownIds[x.id] = true; }); live = live.filter(function (h) { return shownIds[h.id]; }); }
`);

// 2. the new sections come first: summary, findings, advisories (verbose only)
patch("    // ---------------------------------------------------------------- 1. verdict\n", `    // ---------------------------------------------------------------- 0. gate: summary, findings, advisories
    if (G) {
        if (F.what_is_wrong) {
            var sw = sec('whatswrong', 'What is wrong'), bx = el('div', { class: 'card' });
            bx.appendChild(el('h3', { text: F.what_is_wrong.heading }));
            bx.appendChild(el('div', null, [pill(F.what_is_wrong.tier === 'likely' ? 'not confirmed' : 'confirmed', F.what_is_wrong.tier === 'likely' ? 'warn' : 'ok')]));
            (F.what_is_wrong.lines || []).forEach(function (ln) { bx.appendChild(el('p', { class: 'small', text: ln })); });
            sw.appendChild(bx);
        }
        var sg = sec('summary', 'Summary');
        (F.summary.lines_without_box || F.summary.lines || []).forEach(function (ln, i) { sg.appendChild(el('p', { class: i === 0 ? 'note-strong' : 'small', text: ln.replace(/^\\s*•\\s*/, '• ') })); });
        var sf = sec('findings', 'Findings (' + (F.findings || []).length + ')');
        if (!(F.findings || []).length) sf.appendChild(el('div', { class: 'empty', text: 'Nothing passed the gate: no cause was both established and seen to break the site.' }));
        (F.findings || []).forEach(function (x) {
            var c = el('div', { class: 'card' });
            c.appendChild(el('h3', { text: x.cause.charAt(0).toUpperCase() + x.cause.slice(1) }));
            c.appendChild(el('div', null, [pill(x.label, x.label === 'compromise' ? 'bad' : 'info'), pill(String(x.status).replace(/_/g, ' '), tone(x.status))]));
            var d = el('dl');
            field(d, 'Kind of problem', x.type_text);
            field(d, 'Shown because', x.shown_because);
            field(d, 'Where', (x.evidence || []).filter(function (e) { return e.file; }).slice(0, 4).map(function (e) { return e.file + (e.line ? ':' + e.line : ''); }));
            field(d, 'Seen', (x.breaking_because || []).map(function (b) { return b.reason; }));
            field(d, 'How to undo', [x.rollback.intro].concat(x.rollback.options.map(function (o) { return o.title + ': ' + o.undo; })));
            c.appendChild(d); sf.appendChild(c);
        });
        if (G.verbose) {
            var sa = sec('advisories', 'Advisories (' + (F.advisories || []).length + ')');
            sa.appendChild(el('p', { class: 'small', text: 'Possible causes that were not confirmed, or not seen to break the site. They are listed so that nothing disappears.' }));
            if (!(F.advisories || []).length) sa.appendChild(el('div', { class: 'empty', text: 'None.' }));
            (F.advisories || []).forEach(function (a) {
                var ca = el('div', { class: 'card' });
                ca.appendChild(el('h3', { text: a.cause.charAt(0).toUpperCase() + a.cause.slice(1) }));
                ca.appendChild(el('div', null, [pill(a.label, 'info'), pill(String(a.status).replace(/_/g, ' '), tone(a.status))]));
                var da = el('dl');
                field(da, 'Not shown because it is', a.why_not_shown.text + (a.why_not_shown.all.length > 1 ? ' (also: ' + a.why_not_shown.all.slice(1).join(', ') + ')' : ''));
                field(da, 'Kind of problem', a.type_text);
                field(da, 'A log error names', (a.backed_by_log || []).map(function (b) { return b.file + (b.component ? ' (' + (b.component_label || 'plugin ' + b.component) + ')' : ''); }));
                if (a.merged) field(da, 'Occurrences', String(a.merged) + ' (merged into one entry)');
                ca.appendChild(da); sa.appendChild(ca);
            });
        }
    }

`, 'before');

// 3. wording where "no hypothesis survived validation" would mislead
patch("'No hypothesis survived validation.');\n    var all = F.resolution", "(G ? F.summary.headline : 'No hypothesis survived validation.'));\n    var all = F.resolution", 'replace');
patch("text: 'There is nothing to resolve: no hypothesis survived validation.' }", "text: G ? 'There is nothing to resolve: no confirmed breaking cause was found.' : 'There is nothing to resolve: no hypothesis survived validation.' }", 'replace');

// 4. the table of contents
patch("    ['verdict:Verdict', 'reported:As reported',", "    (G ? (F.what_is_wrong ? ['whatswrong:What is wrong'] : []).concat(['summary:Summary', 'findings:Findings']).concat(G.verbose ? ['advisories:Advisories'] : []) : []).concat(['verdict:Verdict', 'reported:As reported',", 'replace');
patch("'retests:Retests', 'limits:Limits'].forEach(", "'retests:Retests', 'limits:Limits']).forEach(", 'replace');

function apply(src) {
    let out = src;
    for (const p of PATCHES) {
        const n = out.split(p.anchor).length - 1;
        if (n !== 1) throw new Error(`issue-html gate patch does not fit the client script (found ${n} times): ${p.anchor.slice(0, 60)}`);
        out = p.where === 'replace' ? out.replace(p.anchor, () => p.replacement) : p.where === 'before' ? out.replace(p.anchor, () => p.replacement + p.anchor) : out.replace(p.anchor, () => p.anchor + p.replacement);
    }
    return out;
}

module.exports = { apply, PATCHES };
