// issue.html in GATE mode (issue investigate --gate): the same client script, patched at build time. issue-html-client.js itself is not touched, so with the gate off
// the page is byte-identical to what it was before step 7b. Each patch names the exact text it replaces; if the client changes and a patch no longer fits, build()
// throws (and the tests fail) instead of producing a wrong page. Nothing here uses innerHTML: every text goes in through textContent.

const PATCHES = [];
const patch = (anchor, replacement, where = 'after') => PATCHES.push({ anchor, replacement, where });

// 1. which hypotheses are listed: the findings, plus the advisories only with --verbose
patch("    var live = F.hypotheses.filter(function (h) { return h.status !== 'REJECTED_FALSE_POSITIVE'; });\n", `    // gate mode (issue investigate --gate): what is shown is the findings; the advisories are listed only with --verbose
    var G = F.gate || null;
    var SW = { CONFIRMED: 'Confirmed', REPRODUCIBLE: 'Reproduced', FIXED_VERIFIED: 'Fixed and verified', PROBABLE_NEEDS_REVIEW: 'Needs review', UNVERIFIED: 'Not checked', REJECTED_FALSE_POSITIVE: 'Ruled out' };
    function stWord(st) { return SW[st] || String(st).replace(/_/g, ' ').toLowerCase(); }
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
            if (F.what_is_wrong.note) bx.appendChild(el('p', { class: 'small', text: F.what_is_wrong.note }));
            sw.appendChild(bx);
        }
        var sg = sec('summary', 'Summary');
        (F.summary.lines_html_without_box || F.summary.lines_html || F.summary.lines_without_box || F.summary.lines || []).forEach(function (ln, i) { sg.appendChild(el('p', { class: i === 0 ? 'note-strong' : 'small', text: ln.replace(/^\\s*•\\s*/, '• ') })); });
        if (G.verbose && F.checkpoint_text && F.checkpoint_text.lines.length) {
            var dcp = el('details'); dcp.appendChild(el('summary', { text: 'All ' + F.checkpoint_text.lines.length + ' checks' }));
            var lcp = el('ul', { class: 'v' }); F.checkpoint_text.lines.forEach(function (ln) { lcp.appendChild(el('li', { text: ln })); });
            dcp.appendChild(lcp); sg.appendChild(dcp);
        }
        var sf = sec('findings', (F.findings || []).length ? 'Findings (' + (F.findings || []).length + ')' : 'Findings');
        if (!(F.findings || []).length) sf.appendChild(el('div', { class: 'empty', text: F.findings_empty_text || 'No confirmed cause was found.' }));
        (F.findings || []).forEach(function (x) {
            var c = el('div', { class: 'card' });
            c.appendChild(el('h3', { text: x.cause.charAt(0).toUpperCase() + x.cause.slice(1) }));
            c.appendChild(el('div', null, [pill(x.label, x.label === 'compromise' ? 'bad' : 'info'), pill(stWord(x.status), tone(x.status))]));
            var d = el('dl');
            field(d, 'Kind of problem', x.type_text);
            field(d, 'Shown because', x.shown_because);
            field(d, 'Where', (x.evidence || []).filter(function (e) { return e.file; }).slice(0, 4).map(function (e) { return e.file + (e.line ? ':' + e.line : ''); }));
            field(d, 'Seen', (x.breaking_because || []).map(function (b) { return b.reason; }));
            field(d, 'How to undo', [x.rollback.intro].concat(x.rollback.options.map(function (o) { return o.title + ': ' + o.undo; })));
            c.appendChild(d); sf.appendChild(c);
        });
        if (G.verbose || (F.advisories || []).length) {
            var sa0 = sec('advisories', 'Advisories (' + (F.advisories || []).length + ')'), sa = sa0;
            if (!G.verbose) { sa = el('details'); sa.appendChild(el('summary', { text: 'Show the possible causes' })); sa0.appendChild(sa); }
            sa.appendChild(el('p', { class: 'small', text: 'Possible causes that were not confirmed, or not seen to break the site. They are listed so that nothing disappears.' }));
            if (!(F.advisories || []).length) sa.appendChild(el('div', { class: 'empty', text: 'None.' }));
            (F.advisories || []).forEach(function (a) {
                var ca = el('div', { class: 'card' });
                ca.appendChild(el('h3', { text: a.cause.charAt(0).toUpperCase() + a.cause.slice(1) }));
                ca.appendChild(el('div', null, [pill(a.label, 'info'), pill(stWord(a.status), tone(a.status))]));
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

// 3b. plain words in the parts of the client that are shared with the gate-off page (each anchor must occur once)
patch("' [' + top.status.replace(/_/g, ' ') + ']'", "' [' + (F.gate ? stWord(top.status) : top.status.replace(/_/g, ' ')) + ']'", 'replace');
patch("pill(h.status.replace(/_/g, ' '), tone(h.status))", "pill(F.gate ? stWord(h.status) : h.status.replace(/_/g, ' '), tone(h.status))", 'replace');
patch("el('td', { text: c.name + ' (' + c.ref + ')' })", "el('td', { text: F.gate && c.label ? c.label.charAt(0).toUpperCase() + c.label.slice(1) : c.name + ' (' + c.ref + ')' })", 'replace');
// "Not tested": only what is tied to the answer (result.js decides which steps; --verbose keeps all of them)
patch("field(dl1, 'Not tested', notDone.map(", "field(dl1, 'Not tested', (F.gate && F.not_tested ? notDone.filter(function (t) { return F.not_tested.indexOf(t.id) >= 0; }) : notDone).map(", 'replace');

// 3c. reader words in "Why this status", "Not tested" and the verification lines (result.js computes reader_why / not_tested_text; findings.json keeps every check)
patch("det.appendChild(el('summary', { text: 'Why this status (' + h.checks.length + ' check(s) re-run by the validator)' }));", "det.appendChild(el('summary', { text: F.gate ? 'Why this status' : 'Why this status (' + h.checks.length + ' check(s) re-run by the validator)' }));", 'replace');
patch("h.checks.forEach(function (c) { cl.appendChild(el('li', { text: c.status + ' ' + c.id + ': ' + c.reason })); }); h.validation_notes.forEach(function (n) { cl.appendChild(el('li', { text: 'note: ' + n })); });", "if (F.gate && F.reader_why) (F.reader_why[h.id] || []).forEach(function (t) { cl.appendChild(el('li', { text: t })); }); else { h.checks.forEach(function (c) { cl.appendChild(el('li', { text: c.status + ' ' + c.id + ': ' + c.reason })); }); h.validation_notes.forEach(function (n) { cl.appendChild(el('li', { text: 'note: ' + n })); }); }", 'replace');
patch("vu.appendChild(el('li', { text: x.status + ' ' + x.id + ': ' + x.reason }));", "vu.appendChild(el('li', { text: F.gate ? stWord2(x.status) + ': ' + x.reason : x.status + ' ' + x.id + ': ' + x.reason }));", 'replace');
patch("    function stWord(st) {", "    function stWord2(st) { return { PASSED: 'Passed', FAILED: 'Failed', NOT_RUN: 'Not checked', BLOCKED: 'Blocked', SKIPPED: 'Skipped' }[st] || String(st).replace(/_/g, ' ').toLowerCase(); }\n    function stWord(st) {", 'replace');
patch(".map(function (t) { return t.label + ' (' + t.status + (t.reason ? ': ' + String(t.reason).slice(0, 140) : '') + ')'; }));\n", ".map(function (t) { return F.gate && F.not_tested_text && F.not_tested_text[t.id] ? F.not_tested_text[t.id] : t.label + ' (' + t.status + (t.reason ? ': ' + String(t.reason).slice(0, 140) : '') + ')'; }));\n", 'replace');

// 3d. the Verdict in plain words: no internal value (null, could-not-test, a status code), one pointer line for the cause, the confidence as a sentence
patch("text: 'Confidence: ' + v.confidence + ' · symptom reproduced: ' + v.symptom_reproduced", "text: F.gate && F.confidence_text ? F.confidence_text + ' ' + F.symptom_text : 'Confidence: ' + v.confidence + ' · symptom reproduced: ' + v.symptom_reproduced", 'replace');
patch("field(dl1, 'Cause', top ? first(", "field(dl1, 'Cause', F.gate && F.verdict_cause_line ? F.verdict_cause_line : top ? first(", 'replace');
patch("'No safe automatic fix: a person has to decide (see the resolution options).'", "(F.gate && F.fix_text ? F.fix_text : 'No safe automatic fix: a person has to decide (see the resolution options).')", 'replace');
patch("field(dl1, 'Tested', did + ' step(s) ran'", "field(dl1, 'Tested', F.gate && F.tested_text ? F.tested_text : did + ' step(s) ran'", 'replace');
patch("    document.getElementById('title').textContent = F.issue.title;\n", "    document.getElementById('title').textContent = F.gate && F.issue_title_short ? F.issue_title_short : F.issue.title;\n    if (F.gate) document.title = 'Issue report: ' + (F.issue_title_short || F.issue.title);\n", 'replace');
// resolution: "What to try" first (the same list as the box), options with their reader wording
patch("        optsOf(h.id).forEach(function (o) {\n", `        var wt = F.gate ? (F.resolution.filter(function (x) { return x.hypothesis === h.id; })[0] || {}).what_to_try : null;
        if (wt && wt.length) { s7.appendChild(el('h4', { text: 'What to try' })); var wl = el('ol', { class: 'v' }); wt.forEach(function (t) { wl.appendChild(el('li', { text: t })); }); s7.appendChild(wl); }
        optsOf(h.id).forEach(function (o) {\n`, 'replace');
patch("box.appendChild(el('h4', { text: o.title }));", "box.appendChild(el('h4', { text: F.gate && o.reader_title ? o.reader_title : o.title }));", 'replace');
patch("box.appendChild(el('p', { text: o.detail || '' }));", "box.appendChild(el('p', { text: F.gate && o.reader_detail ? o.reader_detail : (o.detail || '') }));", 'replace');

// 4. the table of contents
patch("    ['verdict:Verdict', 'reported:As reported',", "    (G ? (F.what_is_wrong ? ['whatswrong:What is wrong'] : []).concat(['summary:Summary', 'findings:Findings']).concat(G.verbose || (F.advisories || []).length ? ['advisories:Advisories'] : []) : []).concat(['verdict:Verdict', 'reported:As reported',", 'replace');
patch("'retests:Retests', 'limits:Limits'].forEach(", "'retests:Retests', 'limits:Limits']).forEach(", 'replace');

// 5. last step in gate mode: any internal id that is still visible (a graph label, a relation, a piece of evidence) is shown in plain words. Text nodes and aria-labels only.
patch("    // navigation\n", `    if (F.gate) {
        var LAB = {}; (F.components || []).forEach(function (c) { if (c.label) LAB[c.ref] = c.label; });
        var capw = function (x) { return String(x).split(/[-_\\s]+/).filter(Boolean).map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1); }).join(' '); };
        var PT = F.plain_text || [];
        var plainTok = function (t) {
            t = String(t); PT.forEach(function (p) { if (t.indexOf(p[0]) >= 0) t = t.split(p[0]).join(p[1]); });
            return plainRaw(t);
        };
        var plainRaw = function (t) { return String(t).replace(/(?:\\b(?:plugin|theme) )?\\b(theme|mu):([A-Za-z0-9._-]+)/g, function (m, k, slug) { return LAB[k + ':' + slug] || ('the ' + (k === 'mu' ? 'must-use plugin ' : 'theme ') + capw(slug)); }); };
        var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null), nodes = [], nd;
        while ((nd = walker.nextNode())) nodes.push(nd);
        nodes.forEach(function (x) { if (/(theme|mu):/.test(x.nodeValue) && x.parentNode && x.parentNode.id !== 'pg-data') x.nodeValue = plainTok(x.nodeValue); });
        Array.prototype.forEach.call(document.querySelectorAll('[aria-label]'), function (e) { var a = e.getAttribute('aria-label'); if (/(theme|mu):/.test(a)) e.setAttribute('aria-label', plainTok(a)); });
    }
`, 'before');

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
