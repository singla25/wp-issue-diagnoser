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
    // when the report was made, in readable local words ("4 Nov 2026, 17:58"); findings.json keeps the raw value
    function whenText(iso) { var d = new Date(iso); if (isNaN(d.getTime())) return String(iso); var M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']; return d.getDate() + ' ' + M[d.getMonth()] + ' ' + d.getFullYear() + ', ' + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); }
`);
// 1b. the page header: the date the report was made in readable words (gate mode only)
patch("' · generated ' + F.generated_at;", "' · generated ' + (F.gate ? whenText(F.generated_at) : F.generated_at);", 'replace');

// 2. the new sections come first: status, what you see, the cases, what was checked, for a developer, advisories (verbose only)
patch("    // ---------------------------------------------------------------- 1. verdict\n", `    // ---------------------------------------------------------------- 0. gate: summary, findings, advisories
    if (G) {
        var CF = F.case_file;
        var sst = sec('status', 'Status');
        sst.appendChild(el('p', { class: 'note-strong', text: CF.status.line }));
        sst.appendChild(el('p', { class: 'small', text: CF.status.looked }));
        if (CF.status.php) sst.appendChild(el('p', { class: 'small', text: CF.status.php }));
        if (CF.status.note) sst.appendChild(el('p', { class: 'small', text: CF.status.note }));
        if (CF.status.sandbox_note) sst.appendChild(el('p', { class: 'small', text: CF.status.sandbox_note }));
        // 'Same fatal required': with every plugin off the page failed with a different (or an unknown) error
        (CF.status.cautions || []).forEach(function (ln) { sst.appendChild(el('p', { class: 'small', role: 'note', text: ln })); });
        // the fidelity check of the test copy (6d-2): the sentence, then the likely reasons as a short list (6d-3: under the level heading)
        var sfd = null;
        if (CF.status.fidelity) { sfd = el('div', { id: 'fidelity' }); sfd.appendChild(el('p', { class: 'note-strong', text: CF.status.fidelity.line })); if (CF.status.fidelity.reasons.length) { sfd.appendChild(el('p', { class: 'small', text: 'Likely reasons:' })); var lfd = el('ul', { class: 'v' }); CF.status.fidelity.reasons.forEach(function (r) { lfd.appendChild(el('li', { text: r })); }); sfd.appendChild(lfd); } if (!CF.level) sst.appendChild(sfd); }
        // no error log on the site: say so, and how to turn logging on (plain steps)
        if (CF.status.log_help && CF.status.log_help.length) { var slh = el('div', { id: 'log-help' }); CF.status.log_help.forEach(function (ln, i) { slh.appendChild(el('p', { class: i ? 'small' : 'note-strong', text: ln })); }); sst.appendChild(slh); }
        // no log on the site, but the test copy matched: its own log, named as coming from a test copy (TEST-COPY-SPEC 6.2)
        if (CF.status.copy_log && CF.status.copy_log.length) { var scl = el('div', { id: 'copy-log' }); CF.status.copy_log.forEach(function (ln, i) { scl.appendChild(el('p', { class: i ? 'small' : 'note-strong', text: ln })); }); sst.appendChild(scl); }
        // 6d-3: the report level (its heading), the fidelity sentence, what is missing, and the "How close the copy is" box
        if (CF.level) {
            var slv = el('div', { id: 'copy-level', class: 'card' }); slv.appendChild(el('h3', { text: CF.level.heading })); sst.appendChild(slv);
            if (sfd) slv.appendChild(sfd);
            if (CF.level.missing.length) { slv.appendChild(el('p', { class: 'small', text: ${JSON.stringify(require('../issue/case-file').MISSING_INTRO)} })); var lms = el('ul', { class: 'v' }); CF.level.missing.forEach(function (m) { lms.appendChild(el('li', { text: m })); }); slv.appendChild(lms); }
            CF.level.lines.forEach(function (ln) { slv.appendChild(el('p', { class: /^NOT (?:TESTED|CONFIRMED)/.test(ln) ? 'note-strong' : 'small', text: ln })); });
            if (CF.close) {
                var scb = el('div', { id: 'how-close' }); scb.appendChild(el('h4', { text: CF.close.title }));
                var dcb = el('dl'); ${JSON.stringify(require('../issue/case-file').CLOSE_GROUPS)}.forEach(function (g) { if ((CF.close[g[0]] || []).length) field(dcb, g[1], CF.close[g[0]]); });
                scb.appendChild(dcb); slv.appendChild(scb);
            }
        }
        var ssee = sec('see', 'What you see');
        CF.see.forEach(function (ln) { ssee.appendChild(el('p', { class: 'small', text: ln })); });
        // a crash with no likely cause: the sentence comes right above the (unnumbered) advisory case
        if (CF.no_cause_note) { var snc = el('section', { id: 'no-cause' }); snc.appendChild(el('p', { class: 'note-strong', text: CF.no_cause_note })); document.getElementById('content').appendChild(snc); }
        var nCheck = 0;
        CF.cases.forEach(function (c) {
            var sc = c.n ? sec('case-' + c.n, 'Case ' + c.n + ': ' + c.heading) : sec('check-' + (++nCheck), c.heading), cd = el('dl');
            c.rows.forEach(function (r) { field(cd, r[0], r[1]); });
            sc.appendChild(cd);
        });
        var sch = sec('checked', 'What was checked');
        sch.appendChild(el('p', { class: 'note-strong', text: CF.checked.line }));
        sch.appendChild(el('p', { class: 'small', text: CF.checked.legend }));
        (CF.checked.notes || []).forEach(function (nt) { sch.appendChild(el('p', { class: 'small', text: nt })); });
        if (G.verbose && F.checkpoint_text && F.checkpoint_text.lines.length) {
            var dcp = el('details'); dcp.appendChild(el('summary', { text: 'All ' + F.checkpoint_text.lines.length + ' checks' }));
            var lcp = el('ul', { class: 'v' }); F.checkpoint_text.lines.forEach(function (ln) { lcp.appendChild(el('li', { text: ln })); });
            dcp.appendChild(lcp); sch.appendChild(dcp);
        }
        if (CF.developer.length) {
            var sdv = sec('developer', 'For a developer'), ddv = el('details');
            ddv.appendChild(el('summary', { text: 'Show the technical details' }));
            var ldv = el('ul', { class: 'v' }); CF.developer.forEach(function (ln) { ldv.appendChild(el('li', { text: ln })); });
            ddv.appendChild(ldv);
            if (CF.excerpt) { ddv.appendChild(el('p', { class: 'small', text: CF.excerpt.title })); var pre = el('pre', { class: 'code' }); CF.excerpt.lines.forEach(function (ln) { pre.appendChild(el('span', { text: ln })); }); ddv.appendChild(pre); }
            sdv.appendChild(ddv);
        }
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
patch("'No hypothesis survived validation.');\n    var all = F.resolution", "(G ? F.case_file.status.line : 'No hypothesis survived validation.'));\n    var all = F.resolution", 'replace');
patch("text: 'There is nothing to resolve: no hypothesis survived validation.' }", "text: G ? 'No fix is suggested, because no cause was found.' : 'There is nothing to resolve: no hypothesis survived validation.' }", 'replace');

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
patch(".map(function (t) { return t.label + ' (' + t.status + (t.reason ? ': ' + String(t.reason).slice(0, 140) : '') + ')'; }));\n", ".map(function (t) { return F.gate && F.not_tested_text && F.not_tested_text[t.id] ? F.not_tested_text[t.id] : t.label + ' (' + t.status + (t.reason ? ': ' + String(t.reason).slice(0, 140) : '') + ')'; }).filter(function (x, i, a) { return !F.gate || a.indexOf(x) === i; }));\n", 'replace');

// 3d. the Verdict in plain words: no internal value (null, could-not-test, a status code), one pointer line for the cause, the confidence as a sentence
patch("text: 'Confidence: ' + v.confidence + ' · symptom reproduced: ' + v.symptom_reproduced", "text: F.gate && F.confidence_text ? F.confidence_text + ' ' + F.symptom_text : 'Confidence: ' + v.confidence + ' · symptom reproduced: ' + v.symptom_reproduced", 'replace');
patch("field(dl1, 'Cause', top ? first(", "field(dl1, 'Cause', F.gate && F.verdict_cause_line ? F.verdict_cause_line : top ? first(", 'replace');
patch("'No safe automatic fix: a person has to decide (see the resolution options).'", "(F.gate && F.fix_text ? F.fix_text : F.gate && !live.length ? 'No fix is suggested, because no cause was found.' : 'No safe automatic fix: a person has to decide (see the resolution options).')", 'replace');
// a settings tip (or any option) of a hypothesis that is not listed is not the Fix: the Fix is taken only from the hypotheses the Resolution section lists
patch("var all = F.resolution.reduce(function (a, r) { return a.concat(r.options); }, []);", "var all = F.resolution.filter(function (r) { return !F.gate || live.some(function (h) { return h.id === r.hypothesis; }); }).reduce(function (a, r) { return a.concat(r.options); }, []);", 'replace');
patch("field(dl1, 'Tested', did + ' step(s) ran'", "field(dl1, 'Tested', F.gate && F.tested_text ? F.tested_text : did + ' step(s) ran'", 'replace');
patch("    var s1 = sec('verdict', 'Verdict'),", "    var s1 = sec('verdict', F.gate ? 'The verdict in detail (for a developer)' : 'Verdict'),", 'replace');
patch("    document.getElementById('title').textContent = F.issue.title;\n", "    document.getElementById('title').textContent = F.gate && F.issue_title_short ? F.issue_title_short : F.issue.title;\n    if (F.gate) document.title = 'Issue report: ' + (F.issue_title_short || F.issue.title);\n", 'replace');
// resolution: "What to try" first (the same list as the box), options with their reader wording
patch("        optsOf(h.id).forEach(function (o) {\n", `        var wt = F.gate ? (F.resolution.filter(function (x) { return x.hypothesis === h.id; })[0] || {}).what_to_try : null;
        if (wt && wt.length) { s7.appendChild(el('h4', { text: 'What to try' })); var wl = el('ol', { class: 'v' }); wt.forEach(function (t) { wl.appendChild(el('li', { text: t })); }); s7.appendChild(wl); }
        optsOf(h.id).forEach(function (o) {\n`, 'replace');
patch("box.appendChild(el('h4', { text: o.title }));", "box.appendChild(el('h4', { text: F.gate && o.reader_title ? o.reader_title : o.title }));", 'replace');
patch("box.appendChild(el('p', { text: o.detail || '' }));", "box.appendChild(el('p', { text: F.gate && o.reader_detail ? o.reader_detail : (o.detail || '') }));", 'replace');

// 4. the table of contents
patch("    ['verdict:Verdict', 'reported:As reported',", "    (G ? ['status:Status', 'see:What you see'].concat(F.case_file.cases.filter(function (c) { return c.n; }).map(function (c) { return 'case-' + c.n + ':Case ' + c.n; })).concat(['checked:What was checked']).concat(F.case_file.developer.length ? ['developer:For a developer'] : []).concat(G.verbose || (F.advisories || []).length ? ['advisories:Advisories'] : []) : []).concat(['verdict:Verdict', 'reported:As reported',", 'replace');
patch("'retests:Retests', 'limits:Limits'].forEach(", "'retests:Retests', 'limits:Limits']).forEach(", 'replace');

// 4b. the Limits in reader words (findings.json keeps the internal text)
patch("F.limits.forEach(function (x) { l10.appendChild(", "(F.gate && F.limits_text ? F.limits_text : F.limits).forEach(function (x) { l10.appendChild(", 'replace');

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

// 6. empty sections are not shown: the graph when it holds no relation, "Also found" when nothing else was found (F.graph / F.also_found: the local G is reused above)
patch("    // ---------------------------------------------------------------- 9. retests\n", `    if (F.gate) {
        if (!F.graph.edges.length && s4.parentNode) s4.parentNode.removeChild(s4);
        if (!n8 && s8.parentNode) s8.parentNode.removeChild(s8);
    }
`, 'before');
patch("'retests:Retests', 'limits:Limits']).forEach(function (p) {", "'retests:Retests', 'limits:Limits']).filter(function (p) { return !F.gate || !!document.getElementById(p.split(':')[0]); }).forEach(function (p) {", 'replace');

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
