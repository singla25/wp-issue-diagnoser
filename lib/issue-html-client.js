'use strict';
// Client script of issue.html. Built from ONE embedded JSON object. Every piece of text goes in through textContent / setAttribute only,
// nothing is parsed as markup, nothing is evaluated and nothing is fetched. Text from the site, logs, screenshots or the reporter is data.
(function () {
    var D = JSON.parse(document.getElementById('pg-data').textContent), F = D.findings;
    var NS = 'http://www.w3.org/2000/svg';
    function el(t, a, k) { var e = document.createElement(t); if (a) for (var n in a) { if (n === 'text') e.textContent = a[n]; else e.setAttribute(n, a[n]); } (k || []).forEach(function (c) { if (c != null) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); }); return e; }
    function sv(t, a, k) { var e = document.createElementNS(NS, t); if (a) for (var n in a) { if (n === 'text') e.textContent = a[n]; else e.setAttribute(n, a[n]); } (k || []).forEach(function (c) { if (c) e.appendChild(c); }); return e; }
    function sec(id, title) { var s = el('section', { 'aria-labelledby': id + '-h', id: id }); s.appendChild(el('h2', { id: id + '-h', text: title })); document.getElementById('content').appendChild(s); return s; }
    function pill(text, tone) { return el('span', { class: 'pill p-' + (tone || 'info'), text: text }); }
    function field(dl, k, v) { if (v == null || v === '' || (Array.isArray(v) && !v.length)) return; dl.appendChild(el('dt', { text: k })); var dd = el('dd'); if (Array.isArray(v)) { var ul = el('ul', { class: 'v' }); v.forEach(function (x) { ul.appendChild(el('li', { text: String(x) })); }); dd.appendChild(ul); } else dd.textContent = String(v); dl.appendChild(dd); }
    function first(s) { var m = /^(.+?[.!?])(\s|$)/.exec(String(s || '')); return m ? m[1] : String(s || ''); }
    function tone(st) { return { CONFIRMED: 'ok', REPRODUCIBLE: 'ok', FIXED_VERIFIED: 'ok', PROBABLE_NEEDS_REVIEW: 'warn', UNVERIFIED: 'warn', REJECTED_FALSE_POSITIVE: 'info' }[st] || 'info'; }
    var WHO = { 'you-can-do-this': 'You can do this', 'send-to-claude-code': 'Send to Claude Code', 'needs-a-human': 'Needs a human' };
    var live = F.hypotheses.filter(function (h) { return h.status !== 'REJECTED_FALSE_POSITIVE'; });
    var optsOf = function (hid) { var r = F.resolution.filter(function (x) { return x.hypothesis === hid; })[0]; return r ? r.options : []; };

    // ---------------------------------------------------------------- header
    document.getElementById('title').textContent = F.issue.title;
    document.getElementById('meta').textContent = 'Issue ' + F.issue.id + ' · symptom ' + F.issue.symptom + ' · environment ' + F.issue.environment + ' · generated ' + F.generated_at;
    var toc = document.getElementById('toc');

    // ---------------------------------------------------------------- 1. verdict
    var s1 = sec('verdict', 'Verdict'), v = F.verdict, top = live[0] || null;
    var vc = el('div', { class: 'card verdict', 'data-tone': /Fixed|Reproduced/.test(v.label) ? 'ok' : v.label === 'Could not test' ? 'bad' : 'warn' });
    vc.appendChild(el('div', { class: 'label', text: v.label }));
    vc.appendChild(el('p', { class: 'meta', text: 'Confidence: ' + v.confidence + ' · symptom reproduced: ' + v.symptom_reproduced }));
    var dl1 = el('dl');
    field(dl1, 'Cause', top ? first(top.title + '. ' + top.mechanism) + ' [' + top.status.replace(/_/g, ' ') + ']' : 'No hypothesis survived validation.');
    var all = F.resolution.reduce(function (a, r) { return a.concat(r.options); }, []);
    var best = all.filter(function (o) { return o.verified_in_sandbox === true; })[0] || all.filter(function (o) { return o.type === 'patch' || o.type === 'shim'; })[0] || all.filter(function (o) { return o.type === 'settings'; })[0] || null;
    var cands = all.filter(function (o) { return o.test_to_choose; });
    if (cands.length && !all.some(function (o) { return o.verified_in_sandbox === true; })) field(dl1, 'Fix', 'Not decided: ' + cands.length + ' candidate shim orders, test to choose (' + cands.map(function (c) { return c.candidate; }).join(' | ') + '). Run with --sandbox to find out which one works.');
    else field(dl1, 'Fix', best ? best.title + (best.verified_in_sandbox === true ? ' (VERIFIED IN SANDBOX)' : ' (not verified in the sandbox)') : 'No safe automatic fix: a person has to decide (see the resolution options).');
    var did = F.timeline.filter(function (t) { return t.status === 'PASSED'; }).length, notDone = F.timeline.filter(function (t) { return t.status !== 'PASSED'; });
    field(dl1, 'Tested', did + ' step(s) ran' + (F.sandbox ? '; sandbox reproduction: ' + F.sandbox.reproduced_in_sandbox : '; no sandbox') + (F.bisect ? '; bisection: ' + F.bisect.status : '') + (F.retests.length ? '; ' + F.retests.length + ' retest(s)' : ''));
    field(dl1, 'Not tested', notDone.map(function (t) { return t.label + ' (' + t.status + (t.reason ? ': ' + String(t.reason).slice(0, 140) : '') + ')'; }));
    (v.notes || []).forEach(function (n) { vc.appendChild(el('p', { class: 'note-strong', role: 'note' }, [pill('NOT A PLUGIN CONFLICT', 'bad'), el('strong', { text: ' ' + n })])); });
    vc.appendChild(dl1); s1.appendChild(vc);
    if (F.notices && F.notices.length) s1.appendChild(el('div', { class: 'card', role: 'note' }, [pill('INFO', 'info'), el('span', { text: F.notices.length + ' piece(s) of text looked like markup, a command, a path trick or an instruction. They are shown as plain text and were not acted on.' })]));
    if (F.sandbox && F.sandbox.summary) s1.appendChild(el('div', { class: 'card', role: 'note' }, [pill('SANDBOX LIMIT', 'warn'), el('span', { text: F.sandbox.summary.notice + ' ' + F.sandbox.summary.recommendation })]));

    // ---------------------------------------------------------------- 2. as reported
    var s2 = sec('reported', 'The issue as reported'), R = F.reported;
    s2.appendChild(el('p', { class: 'reported', text: R.description || '(no description)' }));
    var dl2 = el('dl'); field(dl2, 'Since', R.since); field(dl2, 'Changed before', R.changed_before); field(dl2, 'Pages', R.pages); field(dl2, 'Address', R.url); s2.appendChild(dl2);
    var dlg = el('dialog', { 'aria-label': 'Screenshot' }), dimg = el('img', { alt: '' }), closeB = el('button', { type: 'button', text: 'Close' }), lastBtn = null;
    dlg.appendChild(closeB); dlg.appendChild(dimg); document.body.appendChild(dlg);
    closeB.addEventListener('click', function () { dlg.close(); }); dlg.addEventListener('close', function () { if (lastBtn) lastBtn.focus(); });
    if (R.images.length) {
        s2.appendChild(el('h3', { text: 'Screenshots from the developer' }));
        var th = el('div', { class: 'thumbs' });
        R.images.forEach(function (im) {
            var emb = D.images.filter(function (x) { return x.name === im.name; })[0];
            var box = el('div');
            if (emb && emb.uri) { var b = el('button', { type: 'button', class: 'thumb', 'aria-label': 'Open screenshot ' + im.name + ' larger' }, [el('img', { src: emb.uri, alt: 'Screenshot ' + im.name })]); b.addEventListener('click', function () { lastBtn = b; dimg.setAttribute('src', emb.uri); dimg.setAttribute('alt', 'Screenshot ' + im.name); dlg.showModal(); }); box.appendChild(b); }
            else box.appendChild(el('p', { class: 'small', text: 'Screenshot ' + im.name + ' is not embedded' + (emb && emb.note ? ': ' + emb.note : '') + '.' }));
            box.appendChild(el('div', { class: 'small', text: im.name + (im.width ? ' · ' + im.width + '×' + im.height : '') }));
            var d = el('details'); d.appendChild(el('summary', { text: 'Text read by OCR (may contain mistakes)' }));
            d.appendChild(el('div', { class: 'ocr', text: im.ocr_text ? im.ocr_text : 'No text was read from this image.' })); box.appendChild(d);
            th.appendChild(box);
        });
        s2.appendChild(th);
    }

    // ---------------------------------------------------------------- 3. components
    var s3 = sec('components', 'Involved components');
    if (!F.components.length) s3.appendChild(el('div', { class: 'empty', text: 'No component could be tied to this report.' }));
    else {
        var sc = el('div', { class: 'scroll' }), tb = el('table'); tb.appendChild(el('thead', null, [el('tr', null, ['Component', 'Role in this feature', 'Version', 'Ownership', 'Evidence'].map(function (h) { return el('th', { scope: 'col', text: h }); }))]));
        var tbd = el('tbody');
        F.components.forEach(function (c) { tbd.appendChild(el('tr', null, [el('td', { text: c.name + ' (' + c.ref + ')' }), el('td', { text: (c.roles.concat(c.in_hypotheses.map(function (t) { return 'in hypothesis: ' + t; }))).join('; ') || '—' }), el('td', { text: c.version || '—' }), el('td', { text: c.ownership }), el('td', { text: c.evidence.join(', ') || '—' })])); });
        tb.appendChild(tbd); sc.appendChild(tb); s3.appendChild(sc);
    }

    // ---------------------------------------------------------------- 4. graph (inline SVG, drawn here)
    var s4 = sec('graph', 'Dependency and conflict graph for this issue'), G = F.graph;
    if (!G.nodes.length) s4.appendChild(el('div', { class: 'empty', text: 'The slice around this issue holds no components.' }));
    else {
        var W = 360, H = 360, cx = 180, cy = 180, r = G.nodes.length === 1 ? 0 : 128, pos = {};
        G.nodes.forEach(function (n, i) { var a = -Math.PI / 2 + (2 * Math.PI * i) / G.nodes.length; pos[n.ref] = { x: Math.round(cx + r * Math.cos(a)), y: Math.round(cy + r * Math.sin(a)) }; });
        var svg = sv('svg', { class: 'graph', viewBox: '0 0 ' + W + ' ' + H, role: 'group', 'aria-label': 'Graph of ' + G.nodes.length + ' components and ' + G.edges.length + ' relations. The same information is listed as text below the graph.' });
        var kinds = {}; G.edges.forEach(function (e) { var k = e.type.split(':')[0]; if (!(k in kinds)) kinds[k] = Object.keys(kinds).length; });
        G.edges.forEach(function (e) { var a = pos[e.from], b = pos[e.to]; if (!a || !b) return; var cls = 'edge' + (kinds[e.type.split(':')[0]] % 3 === 1 ? ' e-dash' : kinds[e.type.split(':')[0]] % 3 === 2 ? ' e-dot' : ''); svg.appendChild(sv('line', { class: cls, x1: a.x, y1: a.y, x2: b.x, y2: b.y }, [sv('title', { text: e.from + ' — ' + e.type + ' — ' + e.to + ': ' + e.why })])); });
        var info = el('div', { class: 'card', id: 'node-info', role: 'status', 'aria-live': 'polite' }); info.textContent = 'Select a component (click, or Tab then Enter) to see why it is in the graph.';
        var nodeEls = {};
        function show(ref) {
            Object.keys(nodeEls).forEach(function (k) { nodeEls[k].setAttribute('class', 'node' + (G.nodes.filter(function (n) { return n.ref === k; })[0].distance === 0 ? ' seed' : '') + (k === ref ? ' sel' : '')); nodeEls[k].setAttribute('aria-pressed', k === ref ? 'true' : 'false'); });
            var n = G.nodes.filter(function (x) { return x.ref === ref; })[0], why = G.edges.filter(function (e) { return e.from === ref || e.to === ref; });
            info.textContent = ''; info.appendChild(el('strong', { text: ref })); info.appendChild(el('p', { class: 'small', text: n.distance === 0 ? 'A starting point: the report, the log or a hypothesis points at it directly.' : 'Reached ' + n.distance + ' relation(s) away from a starting point.' }));
            var ul = el('ul', { class: 'v' }); why.forEach(function (e) { ul.appendChild(el('li', { text: (e.from === ref ? 'with ' + e.to : 'with ' + e.from) + ' — ' + e.type + ': ' + e.why })); }); if (!why.length) ul.appendChild(el('li', { text: 'No relation inside this slice.' })); info.appendChild(ul);
        }
        G.nodes.forEach(function (n) {
            var p = pos[n.ref], g = sv('g', { class: 'node' + (n.distance === 0 ? ' seed' : ''), tabindex: '0', role: 'button', 'aria-pressed': 'false', 'aria-label': 'Component ' + n.ref }, [sv('circle', { cx: p.x, cy: p.y, r: 26 }), sv('text', { x: p.x, y: p.y + 4, text: n.ref.length > 11 ? n.ref.slice(0, 10) + '…' : n.ref })]);
            g.addEventListener('click', function () { show(n.ref); }); g.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); show(n.ref); } });
            nodeEls[n.ref] = g; svg.appendChild(g);
        });
        s4.appendChild(svg); s4.appendChild(info);
        var dt = el('details'); dt.appendChild(el('summary', { text: 'Text alternative: all ' + G.edges.length + ' relation(s)' }));
        var ul2 = el('ul', { class: 'v' }); G.edges.forEach(function (e) { ul2.appendChild(el('li', { text: e.from + ' — ' + e.type + ' — ' + e.to + ': ' + e.why })); }); if (!G.edges.length) ul2.appendChild(el('li', { text: 'No relations.' }));
        dt.appendChild(ul2); s4.appendChild(dt); if (G.dropped) s4.appendChild(el('p', { class: 'small', text: G.dropped + ' further relation(s) were left out of the slice (kept in work/slice.json).' }));
    }

    // ---------------------------------------------------------------- 5. timeline
    var s5 = sec('timeline', 'Investigation timeline'), ol = el('ol', { class: 'v' });
    F.timeline.forEach(function (t) { ol.appendChild(el('li', null, [pill(t.status, t.status === 'PASSED' ? 'ok' : t.status === 'FAILED' || t.status === 'BLOCKED' ? 'bad' : 'warn'), el('strong', { text: t.label }), t.reason ? el('span', { text: ': ' + t.reason }) : null])); });
    if (!F.timeline.length) s5.appendChild(el('div', { class: 'empty', text: 'No step was recorded.' })); else s5.appendChild(ol);

    // ---------------------------------------------------------------- 6. bisect log
    var s6 = sec('bisect', 'Bisect log'), B = F.bisect;
    if (!B) s6.appendChild(el('div', { class: 'empty', text: 'The bisection did not run (it needs --sandbox and a reproduced symptom).' }));
    else {
        if (B.symptom_without_plugins) s6.appendChild(el('p', { class: 'note-strong', role: 'note' }, [pill('NOT A PLUGIN CONFLICT', 'bad'), el('strong', { text: ' The symptom is present with every plugin switched off.' })]));
        s6.appendChild(el('p', { text: 'Status ' + B.status + ': ' + (B.causes.map(function (c) { return '[' + c.plugins.join(', ') + ']' + (c.minimal ? '' : ' (not proven minimal)'); }).join(' and ') || 'no plugin set') + '. ' + B.loads + ' page load(s), ' + B.cache_hits + ' answered from the cache' + (B.capped ? '; STOPPED by the ' + B.capped + ' cap' : '') + '. The full text is in work/bisect.log.' }));
        var sc6 = el('div', { class: 'scroll' }), t6 = el('table'); t6.appendChild(el('thead', null, [el('tr', null, ['#', 'Active plugins', 'Theme', 'Must-use', 'Result', 'Why'].map(function (h) { return el('th', { scope: 'col', text: h }); }))]));
        var b6 = el('tbody'); (B.tests || []).forEach(function (t) { b6.appendChild(el('tr', null, [el('td', { text: String(t.n) }), el('td', { text: t.plugins.join(', ') || '(none)' }), el('td', { text: t.theme === null ? 'site theme' : t.theme }), el('td', { text: t.mu === null ? 'all' : t.mu.join(', ') || '(none)' }), el('td', { text: t.result === 'fail' ? 'symptom present' : t.result === 'pass' ? 'symptom absent' : 'could not tell' }), el('td', { text: t.why || '' })])); });
        t6.appendChild(b6); sc6.appendChild(t6); s6.appendChild(sc6);
    }

    // ---------------------------------------------------------------- 7. resolution options
    var s7 = sec('resolution', 'Resolution options');
    if (!live.length) s7.appendChild(el('div', { class: 'empty', text: 'There is nothing to resolve: no hypothesis survived validation.' }));
    live.forEach(function (h) {
        s7.appendChild(el('h3', { text: h.title })); s7.appendChild(el('p', null, [pill(h.status.replace(/_/g, ' '), tone(h.status)), el('span', { class: 'small', text: ' score ' + h.score + ' · ' + h.independent_kinds.join(', ') })]));
        var det = el('details'); det.appendChild(el('summary', { text: 'Why this status (' + h.checks.length + ' check(s) re-run by the validator)' }));
        var cl = el('ul', { class: 'v' }); h.checks.forEach(function (c) { cl.appendChild(el('li', { text: c.status + ' ' + c.id + ': ' + c.reason })); }); h.validation_notes.forEach(function (n) { cl.appendChild(el('li', { text: 'note: ' + n })); }); det.appendChild(cl); s7.appendChild(det);
        optsOf(h.id).forEach(function (o) {
            var box = el('div', { class: 'opt' });
            box.appendChild(el('h4', { text: o.title })); box.appendChild(el('div', null, [pill(WHO[o.who] || o.who, o.who === 'needs-a-human' ? 'warn' : 'info'), pill(o.type, 'info'), o.test_to_choose ? pill('TEST TO CHOOSE', 'warn') : o.verified_in_sandbox === true ? pill('VERIFIED IN SANDBOX', 'ok') : o.verified_in_sandbox === false ? pill('TESTED IN SANDBOX: DID NOT HELP', 'bad') : (o.type === 'patch' || o.type === 'shim') ? pill('NOT VERIFIED IN SANDBOX', 'warn') : null]));
            box.appendChild(el('p', { text: o.detail || '' }));
            if (o.diff) { var pre = el('pre', { class: 'diff', tabindex: '0', 'aria-label': 'Patch for ' + (o.file || '') }); o.diff.replace(/\n$/, '').split('\n').forEach(function (ln) { pre.appendChild(el('span', { class: ln[0] === '+' && ln.slice(0, 3) !== '+++' ? 'add' : ln[0] === '-' && ln.slice(0, 3) !== '---' ? 'del' : /^(---|\+\+\+|@@)/.test(ln) ? 'hdr' : '', text: ln || ' ' })); }); box.appendChild(pre); }
            if (o.php) { var pp = el('pre', { class: 'code', tabindex: '0', 'aria-label': 'Must-use plugin ' + (o.file || '') }); o.php.replace(/\n$/, '').split('\n').forEach(function (ln) { pp.appendChild(el('span', { text: ln || ' ' })); }); box.appendChild(pp); }
            if (o.setting) { var d3 = el('dl'); field(d3, 'Label', o.setting.label); field(d3, 'Where', o.setting.admin_path); field(d3, 'Stored key', o.setting.stored_key); field(d3, 'Read in', o.setting.verified_against); field(d3, 'Installed', (o.installed_version || 'unknown') + ' (' + (o.version_status || 'unknown') + ')'); box.appendChild(d3); }
            var vu = el('ul', { class: 'v' });
            (o.verification || []).forEach(function (x) { vu.appendChild(el('li', { text: x.status + ' ' + x.id + ': ' + x.reason })); });
            if (o.sandbox_verification) vu.appendChild(el('li', { text: 'SANDBOX ' + o.sandbox_verification.status + ': ' + o.sandbox_verification.reason }));
            (o.not_verified || []).forEach(function (x) { vu.appendChild(el('li', { text: 'NOT verified: ' + x })); });
            if (vu.childNodes.length) box.appendChild(vu);
            s7.appendChild(box);
        });
    });

    // ---------------------------------------------------------------- 8. also found
    var s8 = sec('also', 'Also found, not related to this issue'), A = F.also_found, n8 = A.observations.length + A.collisions.length;
    var d8 = el('details'); d8.appendChild(el('summary', { text: n8 + ' item(s) found elsewhere in the site that the slice around this issue did not reach' }));
    var u8 = el('ul', { class: 'v' }); A.observations.concat(A.collisions).forEach(function (x) { u8.appendChild(el('li', { text: '[' + x.type + '] ' + x.message })); }); if (!n8) u8.appendChild(el('li', { text: 'Nothing else was found.' })); d8.appendChild(u8); s8.appendChild(d8);

    // ---------------------------------------------------------------- 9. retests
    var s9 = sec('retests', 'Retest history');
    if (!F.retests.length) s9.appendChild(el('div', { class: 'empty', text: 'No retest yet. After applying a fix to a copy, run: issue retest ' + F.issue.id }));
    else { var sc9 = el('div', { class: 'scroll' }), t9 = el('table'); t9.appendChild(el('thead', null, [el('tr', null, ['#', 'When', 'Where', 'Result', 'FIXED_VERIFIED', 'Detail'].map(function (h) { return el('th', { scope: 'col', text: h }); }))]));
        var b9 = el('tbody'); F.retests.forEach(function (r) { b9.appendChild(el('tr', null, [el('td', { text: String(r.n) }), el('td', { text: r.at }), el('td', { text: r.where }), el('td', { text: r.verdict }), el('td', { text: r.fixed_verified ? 'yes' : 'no' }), el('td', { text: r.reason })])); }); t9.appendChild(b9); sc9.appendChild(t9); s9.appendChild(sc9); }

    var s10 = sec('limits', 'Limits'), l10 = el('ul', { class: 'v' }); F.limits.forEach(function (x) { l10.appendChild(el('li', { text: x })); }); s10.appendChild(l10);
    // navigation
    ['verdict:Verdict', 'reported:As reported', 'components:Components', 'graph:Graph', 'timeline:Timeline', 'bisect:Bisect', 'resolution:Resolution', 'also:Also found', 'retests:Retests', 'limits:Limits'].forEach(function (p) { var q = p.split(':'); toc.appendChild(el('a', { href: '#' + q[0], text: q[1] })); });
})();
