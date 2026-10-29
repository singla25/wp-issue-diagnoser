// "In plain words": the part of a guard:auto report a non-technical person reads first. It answers, without jargon:
//   - is the SITE ITSELF answering badly (server errors), and were the browser tests paused because of it (and until when)?
//   - what does the site's own error log say is the likely cause? Harmless warnings (PHP "Deprecated" notices and similar) are counted and set
//     aside so they cannot hide the real crash; a fatal error is named with its plugin or theme, file and line.
//   - what to do next, in order.
// Read-only: it reads Agent 1's recorded result and the log files under --root (through issue/logs.js: tail only, never outside the root, never
// through a symlink). It sends no request. Wording is careful: "likely cause", never "confirmed": only the validators confirm.
const logs = require('../issue/logs');

const oneLine = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const SERVER_ERR = /5xx|HTTP 5\d\d|Server instability|server error/i;
const SERIOUS = e => e.level === 'fatal error' || e.level === 'parse error' || /Uncaught|Allowed memory size|Maximum execution time|Call to undefined|Cannot redeclare/i.test(e.message);
const when = iso => { if (!iso) return null; const d = new Date(iso); return Number.isNaN(d.getTime()) ? iso : `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`; };
const nice = c => (c ? String(c).replace(/^(plugin|theme|mu):/, '') : null);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

function diagnose({ a1, root, maxBytes = 4 * 1024 * 1024 } = {}) {
    const out = { site_error: false, tests_paused_until: null, headline: '', lines: [], next: [], serious: [], noise: null, log: { found: false, files: [] } };
    // ---- what Agent 1 experienced ----
    const texts = [...(a1.checks || []).map(c => `${c.reason || ''}`), ...(a1.findings || []).map(f => `${f.title} ${f.description || ''} ${f.blocked_reason || ''}`)].join(' \n ');
    const checkTexts = (a1.checks || []).map(c => `${c.reason || ''}`).join(' \n ');
    const stopped = SERVER_ERR.test(checkTexts) || (!a1.tests_ran && SERVER_ERR.test(texts));   // the tests were stopped because of server errors
    const someErrors = !stopped && SERVER_ERR.test(texts);                                          // the tests ran and saw some pages fail
    out.site_error = stopped || someErrors;
    const m = /next run allowed after (\d{4}-\d{2}-\d{2}T[\d:.]+Z)/.exec(texts);
    if (m) out.tests_paused_until = m[1];
    const protectedByWaf = /rate limit|WAF|challenge|429|403/i.test(texts) && !out.site_error;
    // ---- the site's own error log ----
    let col = { files: [], entries: [], problems: [] };
    if (root) { try { col = logs.collect(root, { maxBytes }); } catch { /* unreadable: said below */ } }
    out.log = { found: col.files.length > 0, files: col.files.map(f => f.ref), problems: col.problems };
    const serious = col.entries.filter(SERIOUS).slice(0, 3);
    const rest = col.entries.filter(e => !SERIOUS(e));
    out.serious = serious.map(e => ({ plugin_or_theme: nice(e.components && e.components[0]), message: oneLine(e.message).slice(0, 220), file: e.file, line: e.line, count: e.count, last_seen: e.last_seen }));
    const by = {}; let total = 0;
    for (const e of rest) { total += e.count; const k = e.level === 'other' ? 'other' : e.level; by[k] = (by[k] || 0) + e.count; }
    const comp = {}; for (const e of rest) for (const c of (e.components || []).slice(0, 1)) comp[c] = (comp[c] || 0) + e.count;
    const top = Object.entries(comp).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
    out.noise = total ? { total, by_level: by, top_component: top ? nice(top[0]) : null } : null;

    // ---- the words ----
    if (someErrors) {
        out.headline = 'Some pages of your site returned a server error (HTTP 500). The browser tests still ran; the failing pages are listed in this report.';
    } else if (stopped) {
        out.headline = 'Your site itself is not answering properly: its pages returned a server error (HTTP 500). That is a problem with the site, not with this test.';
        out.lines.push('The automatic browser tests were paused ON PURPOSE after three server errors in a row, so the tool does not make a struggling site worse.' + (out.tests_paused_until ? ` They can run again after ${when(out.tests_paused_until)}.` : ''));
    } else if (protectedByWaf) {
        out.headline = 'The site\'s own protection (a firewall or rate limit) told the tool to slow down, so the browser tests were limited.';
        out.lines.push('That is the site working as designed; the tool never tries to get around it.' + (out.tests_paused_until ? ` The tests can run again after ${when(out.tests_paused_until)}.` : ''));
    } else if (!a1.tests_ran) {
        out.headline = 'The browser tests did not run.';
        out.lines.push(oneLine((a1.checks.find(c => c.status !== 'PASSED') || {}).reason || 'No reason was recorded.'));
    } else {
        out.headline = 'The site answered the browser tests normally.';
    }
    if (serious.length) {
        out.lines.push(`Your site's own error log shows ${plural(serious.length, 'serious error')}. The most recent is the LIKELY cause of the crash:`);
        for (const s of out.serious) out.lines.push(`• ${s.plugin_or_theme ? `In "${s.plugin_or_theme}"` : 'In the site'}${s.file ? ` (${s.file}${s.line ? ` line ${s.line}` : ''})` : ''}: ${s.message}${s.count > 1 ? ` — seen ${s.count} times` : ''}${s.last_seen ? `, last at ${when(s.last_seen)}` : ''}.`);
    } else if (out.log.found) {
        out.lines.push(out.site_error ? 'Your site\'s error log contains NO fatal error, so the crash is not recorded there.' : 'Your site\'s error log contains no fatal error.');
    } else {
        out.lines.push(out.site_error ? 'No error log was found, so the cause of the crash cannot be read from files. Turning on WordPress\'s debug log (WP_DEBUG_LOG) would record it.' : 'No error log was found in the site copy.');
    }
    if (out.noise) {
        const parts = Object.entries(out.noise.by_level).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${k === 'other' ? 'other' : k}`);
        out.lines.push(`The log also holds ${out.noise.total} harmless-looking warnings (${parts.join(', ')})${out.noise.top_component ? `, mostly from "${out.noise.top_component}"` : ''}. "Deprecated" means a plugin's code is older than your PHP version; it does not crash a page, but it can fill the log and hide the real error.`);
    }
    // ---- what to do next, in order ----
    if (out.site_error) {
        if (serious.length) out.next.push(`Fix or update the ${out.serious[0].plugin_or_theme ? `"${out.serious[0].plugin_or_theme}" plugin/theme` : 'code named above'}, or switch it off, then reload the home page.`);
        else out.next.push('Look at the web server\'s own error log (Apache or Nginx) for the line that says why the page failed, or temporarily switch plugins off one by one.');
        if (someErrors) out.next.push('After fixing it, run the same command again to check that those pages now load.');
        else out.next.push('When the home page loads again' + (out.tests_paused_until ? ` (and after ${when(out.tests_paused_until)})` : '') + ', run the same command again: the browser tests and the "which plugin breaks it" test can then run.');
        if (serious.length) out.next.push('Optional, for a step-by-step investigation of that one crash: node src/plugin-guard/scripts/guard.js issue new --title "Site returns HTTP 500" --symptom white-screen --root <the same folder> --env local');
    } else if (!a1.tests_ran) out.next.push('Fix what is described above, then run the same command again.');
    return out;
}
module.exports = { diagnose, SERIOUS };
