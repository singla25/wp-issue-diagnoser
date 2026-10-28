'use strict';
// Client script of the Issues index. Text only (textContent); links are relative paths built from validated issue ids.
(function () {
    var D = JSON.parse(document.getElementById('pg-data').textContent), L = D.issues;
    function el(t, a, k) { var e = document.createElement(t); if (a) for (var n in a) { if (n === 'text') e.textContent = a[n]; else e.setAttribute(n, a[n]); } (k || []).forEach(function (c) { if (c != null) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); }); return e; }
    var tb = document.getElementById('rows'), q = document.getElementById('q'), count = document.getElementById('count'), tone = { 'Fixed and verified': 'ok', 'Reproduced and cause found': 'ok', 'Probable cause': 'warn', 'Not reproduced': 'warn', 'Could not test': 'bad' };
    function render() {
        var words = q.value.toLowerCase().split(/\s+/).filter(Boolean), shown = 0;
        tb.textContent = '';
        L.forEach(function (i) {
            var hay = [i.id, i.title, i.symptom, i.environment, i.verdict || '', i.top_status || ''].join(' ').toLowerCase();
            if (words.some(function (w) { return hay.indexOf(w) < 0; })) return;
            shown++;
            tb.appendChild(el('tr', null, [
                el('td', null, [i.has_report ? el('a', { href: i.id + '/result/issue.html', text: i.title }) : el('span', { text: i.title }), el('div', { class: 'small', text: i.id })]),
                el('td', { text: i.symptom + ' / ' + i.environment }),
                el('td', null, [el('span', { class: 'pill p-' + (i.verdict ? tone[i.verdict] || 'info' : 'info'), text: i.verdict || 'Not investigated yet' })]),
                el('td', { text: i.top_status ? i.top_status.replace(/_/g, ' ') : '—' }),
                el('td', { text: i.retests ? i.retests + ' (' + (i.last_retest || '') + ')' : '0' }),
                el('td', { text: i.created_at ? i.created_at.slice(0, 10) : '' })
            ]));
        });
        if (!shown) tb.appendChild(el('tr', null, [el('td', { colspan: '6', class: 'empty', text: L.length ? 'No issue matches the search.' : 'No issue has been created yet. Start with: node src/plugin-guard/scripts/guard.js issue new' })]));
        count.textContent = 'Showing ' + shown + ' of ' + L.length + ' issue' + (L.length === 1 ? '' : 's');
    }
    q.addEventListener('input', render); render();
})();
