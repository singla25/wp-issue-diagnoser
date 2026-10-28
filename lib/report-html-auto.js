'use strict';
// Extra sections of report.html for a `guard:auto` run (data in D.auto). Text goes in with textContent only; nothing is parsed as markup.
(function () {
    var D = JSON.parse(document.getElementById('pg-data').textContent);
    if (!D.auto) return;
    var A = D.auto, main = document.querySelector('main'), anchor = document.querySelector('section[aria-labelledby=find-h]');
    function el(t, a, k) { var e = document.createElement(t); if (a) for (var n in a) { if (n === 'text') e.textContent = a[n]; else e.setAttribute(n, a[n]); } (k || []).forEach(function (c) { if (c != null) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); }); return e; }
    function sec(id, title) { var s = el('section', { id: id, 'aria-labelledby': id + '-h' }); s.appendChild(el('h2', { id: id + '-h', text: title })); main.insertBefore(s, anchor); return s; }
    function pill(text, cls) { return el('span', { class: 'badge ' + (cls || ''), text: text }); }
    function dlOf(rows) { var dl = el('dl'); rows.forEach(function (r) { if (r[1] == null || r[1] === '' || (Array.isArray(r[1]) && !r[1].length)) return; dl.appendChild(el('dt', { text: r[0] })); var dd = el('dd'); if (Array.isArray(r[1])) { var ul = el('ul', { class: 'ev' }); r[1].forEach(function (x) { ul.appendChild(el('li', { text: String(x) })); }); dd.appendChild(ul); } else dd.textContent = String(r[1]); dl.appendChild(dd); }); return dl; }
    var F = D.findings, fe = F.filter(function (f) { return f.source_agent === 'user-frontend'; }), co = F.filter(function (f) { return f.source_agent === 'code-security'; });
    function showAgent(agent) { var sel = document.getElementById('f-agent'); if (sel) { sel.value = agent; sel.dispatchEvent(new Event('change')); } var h = document.getElementById('find-h'); if (h) { h.scrollIntoView(); h.setAttribute('tabindex', '-1'); h.focus(); } }

    // 1. summary
    var s1 = sec('auto-summary', 'Run summary (guard:auto)');
    s1.appendChild(dlOf([
        ['Target', A.inputs.url + ' (' + A.inputs.environment + ')'], ['Source copy', A.inputs.root],
        ['Mode', A.mode === 'sandbox' ? 'Sandbox: ONE throwaway copy of the site in Docker, shared by all auto-issues' : 'Static-only: no sandbox (' + (A.mode_reason || 'not requested') + ')'],
        ['Frontend findings', fe.length + ' (visual mode, existing page caps and request governor)'], ['Code / conflict findings', String(co.length)],
        ['Auto-issues', A.counts.issues + ' created from ' + A.counts.considered + ' frontend finding(s); ' + A.counts.reproduced + ' reproduced in the sandbox; ' + A.counts.not_plugin + ' not a plugin conflict'],
        ['Shared page loads', A.shared ? A.shared.page_loads + ' page load(s) for ' + A.shared.sets + ' plugin set(s); ' + A.shared.cache_hits + ' answer(s) reused from the cache' : null],
        ['Original site', A.integrity.same === true ? 'unchanged (' + A.integrity.files + ' files fingerprinted before and after; logs and cache folders excluded)' : A.integrity.same === false ? 'CHANGED DURING THE RUN: ' + A.integrity.detail : 'not checked: ' + A.integrity.detail]
    ]));
    // 2/3. frontend and code findings
    [['auto-frontend', 'Frontend findings', fe, 'user-frontend'], ['auto-code', 'Code and conflict findings', co, 'code-security']].forEach(function (x) {
        var s = sec(x[0], x[1]); s.appendChild(el('p', { text: x[2].length + ' finding(s). Statuses are assigned by Agent 3 (validation) only.' }));
        var top = x[2].slice(0, 5); if (top.length) { var ul = el('ul', { class: 'ev' }); top.forEach(function (f) { ul.appendChild(el('li', { text: '[' + f.severity + ' / ' + f.status.replace(/_/g, ' ') + '] ' + f.title })); }); s.appendChild(ul); } else s.appendChild(el('div', { class: 'empty', text: x[3] === 'user-frontend' ? 'No frontend finding was recorded.' : 'No code or conflict finding was recorded.' }));
        var b = el('button', { type: 'button', text: 'Show these in the full findings list' }); b.addEventListener('click', function () { showAgent(x[3]); }); if (x[2].length) s.appendChild(b);
    });
    // 4. auto-issues
    var s4 = sec('auto-issues', 'Auto-issues: causes and fixes');
    s4.appendChild(el('p', { class: 'meta', text: 'Each one is a reproducible frontend failure turned into an issue with a generic oracle and no invented description. Nothing was applied to your site.' }));
    if (!A.issues.length) s4.appendChild(el('div', { class: 'empty', text: A.issues_none || 'No reproducible frontend failure qualified for an auto-issue.' }));
    A.issues.forEach(function (i) {
        var d = el('details', { class: 'f', open: '' }), sm = el('summary', null, [pill(i.verdict || 'not investigated', /Reproduced|Fixed/.test(i.verdict || '') ? 'st-REPRODUCIBLE' : ''), i.not_plugin_conflict ? pill('NOT A PLUGIN CONFLICT', 'st-BLOCKED') : null, el('span', { class: 't', text: i.title })]);
        d.appendChild(sm);
        var b = el('div', { class: 'body' });
        b.appendChild(dlOf([
            ['Oracle', i.oracle.type + (i.oracle.value ? ': ' + i.oracle.value : '')], ['Pages', i.pages], ['Seen', i.occurrences + ' time(s); frontend severity ' + i.severity],
            ['Reproduced in the sandbox', i.reproduced_in_sandbox === null ? 'not tested (' + (i.sandbox_reason || 'no sandbox') + ')' : i.reproduced_in_sandbox],
            ['Cause', i.cause], ['Bisection', i.bisect], ['Fixes', i.options], ['Full report', i.report]
        ]));
        d.appendChild(b); s4.appendChild(d);
    });
    // 5. not a plugin conflict
    var s5 = sec('auto-not-plugin', 'Not a plugin conflict'), np = A.issues.filter(function (i) { return i.not_plugin_conflict; });
    if (!np.length) s5.appendChild(el('div', { class: 'empty', text: 'Every reproduced symptom disappeared when plugins were switched off, or none was reproduced. No auto-issue is a "not a plugin conflict" case.' }));
    else { s5.appendChild(el('p', { text: 'These symptoms are still present with EVERY plugin switched off. The cause is the theme, a must-use plugin, WordPress core, the database content or the server; no plugin should be blamed for them on this evidence.' })); var u5 = el('ul', { class: 'ev' }); np.forEach(function (i) { u5.appendChild(el('li', { text: i.title })); }); s5.appendChild(u5); }
    // 6. what did not run
    var s6 = sec('auto-notrun', 'What did not run, and why');
    if (!A.did_not_run.length) s6.appendChild(el('div', { class: 'empty', text: 'Every step ran.' }));
    else { var t = el('table'); t.appendChild(el('thead', null, [el('tr', null, ['Step', 'Why'].map(function (h) { return el('th', { scope: 'col', text: h }); }))])); var tb = el('tbody'); A.did_not_run.forEach(function (r) { tb.appendChild(el('tr', null, [el('td', { text: r.what }), el('td', { text: r.why })])); }); t.appendChild(tb); s6.appendChild(t); }
})();
