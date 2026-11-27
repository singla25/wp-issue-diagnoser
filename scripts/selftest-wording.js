#!/usr/bin/env node
// Self-test of three small wording fixes (step "wording 3"): in a run without site files
//   1. the explanation of the fourth count ("Also noticed, probably not the crash: ...") is shown only when something WAS noticed (a count of 0 needs no explanation), in the
//      terminal text, ISSUE-REPORT.md, issue.html and findings.json (checked.legend is an empty string then);
//   2. the log hint says that a log file also works without site files, and the form it names really works (--no-files --log <file> reads the log);
//   3. (the wizard sentence "..., and read your description" is checked in selftest-wizard-plain.js.)
// Real runs against a fixture server on 127.0.0.1 (a quiet page; a page with a script error) and a run with --no-probe. Never touches a real site.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pg-wording-')));
process.env.PLUGIN_GUARD_ISSUES = path.join(tmp, 'issues');
const ENVX = { PG_PROBE_NAV_DELAY_MS: '0', PG_PROBE_REQUEST_DELAY_MS: '0', PG_PROBE_5XX_RETRY_DELAY_MS: '0', PG_PROBE_COOLDOWN_FILE: path.join(tmp, 'cool.json') };
Object.assign(process.env, ENVX);
let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const group = t => console.log(`\n== ${t}`);
const CMD = path.join(__dirname, 'plugin-guard.js');
const LEGEND = /Also noticed(?:, probably not the crash)?: a check found something, but nothing ties it to this problem\./;
const HELP = 'To let this tool read the error log of your site, run it again with the site folder (--root), or without it but with your log file (--no-files --log, then the file path).';
const QUIET = '<html><body><h1>Fixture</h1><p>Some text so the page does not look blank to the probe.</p></body></html>';
const JSERR = '<html><head><script>throw new Error("a script error of the page")</script></head><body><h1>Fixture</h1><p>Some text so the page does not look blank to the probe.</p></body></html>';

const run = args => new Promise(resolve => { const c = spawn(process.execPath, [CMD, ...args], { cwd: tmp, env: { ...process.env } }); let so = '', se = ''; c.stdout.on('data', d => { so += d; }); c.stderr.on('data', d => { se += d; }); c.on('close', code => resolve({ status: code, out: so + se })); });
const dirs = () => { try { return fs.readdirSync(path.join(tmp, 'issues')).filter(n => /^iss-/.test(n)); } catch { return []; } };
async function scenario(body, extra = null) {
    let sv = null;
    if (body !== null) { sv = http.createServer((q, res) => { if (q.url === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(body); } res.writeHead(404); res.end('no'); }); await new Promise(r => sv.listen(0, '127.0.0.1', r)); }
    const before = new Set(dirs());
    const args = ['--description', 'The page is odd', '--no-files', '--yes', ...(sv ? ['--url', `http://127.0.0.1:${sv.address().port}/`, '--env', 'local'] : ['--no-probe']), ...(extra || [])];
    const r = await run(args);
    if (sv) sv.close();
    const id = dirs().find(n => !before.has(n)), dir = path.join(tmp, 'issues', id || 'none');
    const rd = rel => { try { return fs.readFileSync(path.join(dir, rel), 'utf8'); } catch { return ''; } };
    const f = rd('result/findings.json') ? JSON.parse(rd('result/findings.json')) : null;
    return { r, f, md: rd('result/ISSUE-REPORT.md'), html: rd('result/issue.html') };
}

(async () => {
    group('the explanation of "also noticed" only when something was noticed');
    const quiet = await scenario(QUIET);
    ok(quiet.r.status === 0 && /7 pass · 0 fail · 46 not checked · 0 also noticed/.test(quiet.r.out) && /7 pass · 0 fail · 46 not checked · 0 also noticed/.test(quiet.md), `a quiet page: the counts line ends with "0 also noticed" in the terminal and in ISSUE-REPORT.md (exit ${quiet.r.status})`);
    ok(!LEGEND.test(quiet.r.out) && !LEGEND.test(quiet.md) && !LEGEND.test(quiet.html) && !!quiet.f && quiet.f.case_file.checked.legend === '', 'with 0 also noticed the explanation is NOT in the terminal text, ISSUE-REPORT.md, issue.html (also not in its embedded data) and findings.json holds an empty legend');
    ok(!/\n\n\n/.test(quiet.md.split('## What was checked')[1] || '') && /## What was checked\n\n[^\n]+\n/.test(quiet.md), 'ISSUE-REPORT.md: no empty gap is left where the explanation was (the section heading is followed by the counts line)');
    ok(/WHAT WAS CHECKED\n  \d+ pass[^\n]*also noticed\n(?!  *\n)/.test(quiet.r.out), 'terminal text: no blank indented line is left where the explanation was');
    const noticed = await scenario(JSERR);
    ok(noticed.r.status === 0 && /6 pass · 0 fail · 46 not checked · 1 also noticed/.test(noticed.r.out), `a page with a script error: "1 also noticed" (exit ${noticed.r.status})`);
    ok(LEGEND.test(noticed.r.out) && LEGEND.test(noticed.md) && LEGEND.test(noticed.html) && !!noticed.f && LEGEND.test(noticed.f.case_file.checked.legend), 'with 1 also noticed the explanation IS in the terminal text, ISSUE-REPORT.md, issue.html and findings.json');

    group('the log hint says that a log file also works without site files');
    const help = await scenario(null);
    ok(help.r.status === 0 && help.r.out.includes(HELP) && help.md.includes(HELP) && help.html.includes(HELP), 'the new sentence is in the terminal text, ISSUE-REPORT.md and issue.html (no site files, no log)');
    ok(!/with the site folder \(--root\)\./.test(help.r.out + help.md + help.html), 'the old sentence (it ended after "(--root)") is gone from all three');
    const log = path.join(tmp, 'debug.log');
    fs.writeFileSync(log, '[27-Oct-2026 10:00:00 UTC] PHP Fatal error:  Uncaught Error: Call to undefined function acme_x() in /srv/s/wp-content/plugins/acme/acme.php:7\n');
    const withLog = await scenario(null, ['--log', log]);
    ok(withLog.r.status === 0 && /Looked at: your log/.test(withLog.r.out) && /The log shows a fatal error in a file of acme/.test(withLog.r.out) && !withLog.r.out.includes(HELP), 'the form the sentence names works: --no-files --log <file> reads the log (and the hint is not repeated when a log was read)');

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll wording checks passed');
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } process.exit(1); });
