#!/usr/bin/env node
// Self-test of --no-files (S1a): the command runs with NO site folder (modes D and E of docs/INPUT-MODES.md).
//   - the flag's refusals are plain (with --root, --sandbox, --db-dump; --log needs a real file, S1d) and the old refusal without --root is unchanged
//   - case (a): a description only -> no crash, a report, level "NOT TESTED ON A COPY", no site copy, nothing visited
//   - case (c): a local fixture address that answers 200 -> the page is loaded with GET only, the report says the live page was looked at
// Real Chromium and a fixture web server on 127.0.0.1 only; no real site. Offline otherwise.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync, spawn } = require('child_process');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const J = JSON.stringify;
const group = t => console.log(`\n== ${t}`);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-nofiles-'));
const CMD = path.join(__dirname, 'plugin-guard.js');
const ENV = (extra = {}) => ({ ...process.env, PLUGIN_GUARD_ISSUES: path.join(tmp, 'issues'), PG_PROBE_NAV_DELAY_MS: '0', PG_PROBE_REQUEST_DELAY_MS: '0', PG_PROBE_5XX_RETRY_DELAY_MS: '0', PG_PROBE_COOLDOWN_FILE: path.join(tmp, 'cool.json'), ...extra });
const run = (args, extra) => spawnSync(process.execPath, [CMD, ...args], { encoding: 'utf8', cwd: tmp, env: ENV(extra), timeout: 240000 });
// the fixture server lives in THIS process, so a run that visits it must not block the event loop: spawn, not spawnSync
const runAsync = (args, extra) => new Promise(resolve => { const c = spawn(process.execPath, [CMD, ...args], { cwd: tmp, env: ENV(extra) }); let stdout = '', stderr = ''; c.stdout.on('data', d => { stdout += d; }); c.stderr.on('data', d => { stderr += d; }); const t = setTimeout(() => c.kill('SIGKILL'), 240000); c.on('close', status => { clearTimeout(t); resolve({ status, stdout, stderr }); }); });
const issueDirs = () => { try { return fs.readdirSync(path.join(tmp, 'issues')).filter(n => /^iss-/.test(n)); } catch { return []; } };
const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8'));

(async () => {
    group('the refusals are plain, and the old one is unchanged');
    const base = ['--description', 'White screen after an update', '--yes'];
    const noRoot = run(base);
    ok(noRoot.status === 2 && /Missing required value: the site folder\. Pass --root <wp-content folder or WordPress root>\./.test(noRoot.stderr), 'without --root and without --no-files: the old refusal, same words, exit 2');
    ok(issueDirs().length === 0, 'the refusals leave no issue folder behind');
    const both = run([...base, '--no-files', '--root', tmp]);
    ok(both.status === 2 && /--no-files and --root cannot be used together/.test(both.stderr), `--no-files with --root: refused with a plain message (exit ${both.status})`);
    const sb = run([...base, '--no-files', '--sandbox']);
    ok(sb.status === 2 && /--sandbox and --db-dump need the site files/.test(sb.stderr), '--no-files with --sandbox: refused');
    const db = run([...base, '--no-files', '--db-dump', path.join(tmp, 'x.sql')]);
    ok(db.status === 2 && /--sandbox and --db-dump need the site files/.test(db.stderr), '--no-files with --db-dump: refused');
    const lg = run([...base, '--no-files', '--log', path.join(tmp, 'no-such-folder', 'debug.log')]);
    ok(lg.status === 2 && /The log file .* does not exist or is not a file/.test(lg.stderr), '--no-files with --log and a missing file: refused');
    ok(issueDirs().length === 0, 'none of them created an issue folder');
    const help = run(['--help']);
    ok(/--no-files/.test(help.stdout) && /--root <folder>.*unless --no-files/.test(help.stdout), '--help lists --no-files and says --root is needed unless --no-files');
    const flags = require('./guard').parse(['--no-files']);
    ok(flags['no-files'] === true, 'the option table of guard.js knows --no-files (a boolean)');

    group('case (a): a description only');
    const a = run([...base, '--no-files']);
    ok(a.status === 0 && !/Cannot read properties|TypeError/.test(a.stdout + a.stderr), `exit 0 and no crash (exit ${a.status}) ${a.stderr.slice(0, 160)}`);
    const dirsA = issueDirs();
    ok(dirsA.length === 1, 'one issue folder was made');
    const dirA = path.join(tmp, 'issues', dirsA[0] || 'none');
    const issueA = fs.existsSync(path.join(dirA, 'issue.json')) ? readJson(path.join(dirA, 'issue.json')) : {};
    ok(!issueA.root && !fs.existsSync(path.join(dirA, 'site-copy')), 'no site folder was recorded and no site copy was made');
    ok(/NOT TESTED ON A COPY/.test(a.stdout) && /the code of your site/.test(a.stdout), 'the report says "NOT TESTED ON A COPY" and lists the code as missing');
    const fA = fs.existsSync(path.join(dirA, 'result', 'findings.json')) ? readJson(path.join(dirA, 'result', 'findings.json')) : null;
    ok(fA && fA.case_file && !(fA.hypotheses || []).some(h => ['CONFIRMED', 'REPRODUCIBLE'].includes(h.status)), 'no cause is CONFIRMED or REPRODUCIBLE without any site files');
    ok(/No site folder was given \(--no-files\)/.test(a.stdout), 'the terminal says plainly that no site folder was given');

    // ---- S1b: the wording comes from the data (what ran, what was read), not from the mode ----
    const R = n => fs.readFileSync(path.join(dirA, 'result', n), 'utf8');
    group('S1b (a) zero checks ran: the verdict says nothing could be checked, and why');
    ok(fA && fA.verdict.label === 'Nothing could be checked' && /^How sure we are: not at all\. Nothing could be checked/.test(fA.confidence_text), `case (a) verdict: "${fA && fA.verdict.label}" / "${fA && fA.confidence_text.slice(0, 80)}"`);
    ok(/no site files were given, no log was read and no live check was run/.test(fA.confidence_text) && !/Nothing that was checked points at a cause/.test(a.stdout + JSON.stringify(fA)), 'it names the reasons (no site files, no log, no live check) and never says "Nothing that was checked points at a cause"');
    ok(/VERDICT: Nothing could be checked/.test(a.stdout), 'the terminal prints the same verdict');
    const plain = require('../lib/plain-names');
    ok(/^How sure we are: not at all\. Nothing could be checked, so this report does not say whether your site is healthy: no code was read, no log was read and the live page was loaded, but none of the 53 checks ran on it\.$/.test(plain.zeroChecksSentence({ hasRoot: true, hasCode: false, hasLog: false, probeRan: true, total: 53 })), 'the sentence follows the data: a site folder without code says "no code was read", a probe that ran says the page was loaded');
    ok(/: no log was read and no live check was run\.$/.test(plain.zeroChecksSentence({ hasRoot: true, hasCode: true, hasLog: false, probeRan: false, total: 53 })) && !/site files/.test(plain.zeroChecksSentence({ hasRoot: true, hasCode: true, hasLog: false, probeRan: false, total: 53 })), 'with code but no log and no probe only those two reasons are named');

    group('S1b (b) no folder: nothing is said as if the site was searched');
    ok(!/No error log was found on this site/.test(a.stdout + R('ISSUE-REPORT.md') + R('issue.html')) && !/WP_DEBUG/.test(R('ISSUE-REPORT.md')), 'no "No error log was found on this site" and no WP_DEBUG advice in the terminal text, ISSUE-REPORT.md or issue.html');
    ok(/No log was read, because no site files were given\./.test(R('ISSUE-REPORT.md')) && /run it again with the site folder \(--root\)/.test(R('ISSUE-REPORT.md')), 'the report says no log was read because no site files were given, and what to do');

    group('S1b (c) the last line is true');
    ok(/Nothing on your site was changed\./.test(a.stdout) && !/Your site folder was not changed/.test(a.stdout), 'without a site folder the last line says "Nothing on your site was changed."');

    group('S1b (d) the NOT CHECKED reason');
    const rowsA = fA.checkpoints.items.filter(i => i.result === 'NOT CHECKED');
    const noFilesRows = rowsA.filter(i => /^no site files were given, so no (code|log) was read$/.test(i.reason));
    ok(rowsA.length === 53 && noFilesRows.length === 31 && noFilesRows.filter(i => /no code was read/.test(i.reason)).length === 29, `all 53 are NOT CHECKED; the 31 that need the site's code or log say "no site files were given, so no code was read" (29) or "... no log was read" (2); the other 22 keep their own reasons (not built yet, probe did not run, classic scan only)`);
    ok(!/\(--root\)/.test(JSON.stringify(fA.checkpoints)), 'no "(--root)" wording is left in the check reasons');

    group('S1b (e) the label says what was really read');
    const lab = require('../issue/case-file').notTestedLabel;
    const L = x => lab(x).replace(/^NOT TESTED: what this report says comes from (.*)\. It was not tried on a copy of your site\.$/, '$1');
    ok(L({ hasLog: false, hasCode: false }) === 'your description only', 'nothing read: "your description only"');
    ok(L({ hasLog: false, hasCode: false, probeRan: true }) === 'looking at the live page', 'a live page and no code or log: "looking at the live page" (it used to say "your description only")');
    ok(L({ hasLog: true, hasCode: false, probeRan: true }) === 'reading your log and looking at the live page', 'a log and a live page: both named');
    ok(L({ hasLog: false, hasCode: false, probeRan: true, screenshotsRead: true }) === 'looking at the live page and the text of your screenshots', 'a live page and screenshot text: both named');
    ok(L({ hasLog: true, hasCode: false }) === 'reading your log' && L({ hasLog: false, hasCode: true }) === 'reading the code', 'the old log-only and code-only sentences are unchanged');
    ok(lab({ hasLog: true, hasCode: true, probeRan: true }) === 'NOT TESTED: what this report says comes from reading your log and the code. It was not tried on a copy of your site.', 'a log and the code together keep the old sentence (unchanged)');

    group('case (c): a local fixture address that answers 200');
    const hits = [];
    const server = http.createServer((req, res) => {
        hits.push({ method: req.method, url: req.url });
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<!doctype html><html><head><title>Fixture</title></head><body><h1>Fixture shop</h1><p>The page works and has enough text to look like a real page.</p></body></html>');
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}/`;
    try {
        const before = issueDirs();
        const c = await runAsync([...base, '--no-files', '--url', url, '--env', 'local']);
        ok(c.status === 0 && !/Cannot read properties|TypeError/.test(c.stdout + c.stderr), `exit 0 and no crash (exit ${c.status}) ${c.stderr.slice(0, 160)}`);
        const dirC = issueDirs().filter(n => !before.includes(n)).map(n => path.join(tmp, 'issues', n))[0] || path.join(tmp, 'none');
        const probeC = fs.existsSync(path.join(dirC, 'work', 'probe.json')) ? readJson(path.join(dirC, 'work', 'probe.json')) : null;
        ok(hits.length > 0 && hits.every(h => h.method === 'GET'), `the fixture received ${hits.length} request(s), all GET`);
        ok(probeC && probeC.pages.length > 0 && probeC.pages.every(p => p.loaded && p.status === 200), 'the probe loaded the page and it answered 200');
        ok(/NOT TESTED ON A COPY/.test(c.stdout), 'the report level is "NOT TESTED ON A COPY"');
        ok(/comes from looking at the live page\./.test(c.stdout) && !/your description only/.test(c.stdout), 'S1b (e): the label says the report comes from looking at the live page, not "your description only"');
        ok(/Looked at: [^.\n]*the live page/.test(c.stdout) && /Not looked at: [^.\n]*the code/.test(c.stdout), 'the status line says the live page was looked at and the code was not');
        ok(!fs.existsSync(path.join(dirC, 'site-copy')), 'no site copy was made');
        const fC = fs.existsSync(path.join(dirC, 'result', 'findings.json')) ? readJson(path.join(dirC, 'result', 'findings.json')) : null;
        ok(fC && fC.verdict.label === 'No confirmed breaking cause was found' && /Nothing that was checked points at a cause that could be confirmed/.test(fC.confidence_text) && fC.checkpoints.counts.pass === 7, 'S3a-fix (case c): the page was loaded and the 7 live checks passed, so the verdict is the plain "No confirmed breaking cause was found" with 7 pass (it was "Nothing could be checked" while a wrong planned-loads test made every live check NOT CHECKED)');
        ok(fC && !(fC.hypotheses || []).some(h => ['CONFIRMED', 'REPRODUCIBLE'].includes(h.status)), 'no cause is CONFIRMED or REPRODUCIBLE without any site files');
    } finally { server.close(); }

    group('case (d): a local fixture address that answers 500 (checks DO run: the verdict is not "Nothing could be checked")');
    const hits500 = [];
    const server500 = http.createServer((req, res) => { hits500.push(req.method); res.writeHead(500, { 'Content-Type': 'text/html' }); res.end('<html><body>There has been a critical error on this website.</body></html>'); });
    await new Promise(r => server500.listen(0, '127.0.0.1', r));
    try {
        const before = issueDirs();
        const d = await runAsync([...base, '--no-files', '--url', `http://127.0.0.1:${server500.address().port}/`, '--env', 'local']);
        const dirD = issueDirs().filter(n => !before.includes(n)).map(n => path.join(tmp, 'issues', n))[0] || path.join(tmp, 'none');
        const fD = fs.existsSync(path.join(dirD, 'result', 'findings.json')) ? readJson(path.join(dirD, 'result', 'findings.json')) : null;
        ok(d.status === 0 && fD && fD.checkpoints.counts.fail + fD.checkpoints.counts.pass + fD.checkpoints.counts.also_noticed > 0, `exit 0 and some checks ran (${fD && JSON.stringify(fD.checkpoints.counts)})`);
        ok(fD && fD.verdict.label !== 'Nothing could be checked' && !/Nothing could be checked/.test(fD.confidence_text), 'the zero-checks verdict is derived from the number of checks that ran, not from the mode: with checks run it is not used');
        ok(/The live page answered HTTP 500\./.test(d.stdout) && /comes from looking at the live page/.test(d.stdout) && hits500.every(m => m === 'GET'), 'the report says the live page answered HTTP 500, rests on looking at the live page, and only GET requests were made');
    } finally { server500.close(); }

    group('--no-files with --env live: the live rules are not loosened (decision: no new rule, the existing ones apply)');
    const hitsLive = [];
    const serverLive = http.createServer((req, res) => { hitsLive.push(req.method); res.writeHead(200); res.end('x'); });
    await new Promise(r => serverLive.listen(0, '127.0.0.1', r));
    try {
        const lv = await runAsync([...base, '--no-files', '--url', `http://127.0.0.1:${serverLive.address().port}/`, '--env', 'live']);
        ok(lv.status === 3 && /is marked live\. Without a terminal to confirm on, a live site is not visited unless you pass --authorized/.test(lv.stderr), `a live address without --authorized and without a terminal is refused, exit 3 (exit ${lv.status})`);
        ok(hitsLive.length === 0, 'and the address was not visited at all (0 requests)');
    } finally { serverLive.close(); }

    // ---- S1b-fix: the verdict for an error page or a failed live check, when NO site files were given ----
    // trigger (from the data, never a fixed status or count): no site folder AND (a loaded live page answered a status of 400 or more OR a live check failed)
    const serve = (code, body) => new Promise(r => { const hit = []; const sv = http.createServer((q, res) => { hit.push(q.method); res.writeHead(code, { 'Content-Type': 'text/html' }); res.end(body); }); sv.listen(0, '127.0.0.1', () => r({ sv, hit, url: `http://127.0.0.1:${sv.address().port}/` })); });
    const CRIT = '<html><body>There has been a critical error on this website.</body></html>';
    const OK200 = '<!doctype html><html><head><title>Fixture</title></head><body><h1>Fixture shop</h1><p>The page works and has enough text to look like a real page.</p></body></html>';
    const FORBIDDEN = /No confirmed breaking cause was found|Nothing that was checked points at a cause/;
    const runCase = async (code, body, extraArgs = []) => {
        const { sv, url } = await serve(code, body);
        const before = issueDirs();
        try {
            const r = await runAsync([...base, ...extraArgs, '--url', url, '--env', 'local']);
            const dir = issueDirs().filter(n => !before.includes(n)).map(n => path.join(tmp, 'issues', n))[0] || path.join(tmp, 'none');
            const f = fs.existsSync(path.join(dir, 'result', 'findings.json')) ? readJson(path.join(dir, 'result', 'findings.json')) : null;
            const files = ['ISSUE-REPORT.md', 'issue.html', 'findings.json'].map(n => { try { return fs.readFileSync(path.join(dir, 'result', n), 'utf8'); } catch { return ''; } }).join('\n');
            return { r, f, files };
        } finally { sv.close(); }
    };
    group('S1b-fix (a): no files, the page answers 500 and live checks failed (case d)');
    const E500 = await runCase(500, CRIT, ['--no-files']);
    const failedN = E500.f ? E500.f.checkpoints.counts.fail : -1;
    ok(E500.r.status === 0 && E500.f && E500.f.verdict.label === 'A problem was seen on the live page', `the verdict label is "A problem was seen on the live page" (got "${E500.f && E500.f.verdict.label}")`);
    ok(E500.f && failedN > 0 && E500.f.confidence_text === `The live page answered with an error (HTTP 500). ${failedN} live checks failed. No cause could be found from what was given. To go further, give the site files and a log.`, `the sentence has the status code and the failed count from the data (${failedN}): "${E500.f && E500.f.confidence_text}"`);
    ok(/VERDICT: A problem was seen on the live page/.test(E500.r.stdout) && /The live page answered with an error \(HTTP 500\)\./.test(E500.r.stdout), 'the terminal prints the same verdict');
    ok(!FORBIDDEN.test(E500.r.stdout + E500.files), 'neither "No confirmed breaking cause was found" nor "Nothing that was checked points at a cause" is in the terminal text, findings.json, ISSUE-REPORT.md or issue.html');
    ok(!/plugin|theme|conflict/i.test(E500.f.confidence_text) && !/confirmed|fully checked/i.test(E500.f.confidence_text), 'the sentence names no cause, plugin or theme and says nothing was confirmed or fully checked');

    group('S1b-fix (b): no files, an error status (404) and no failed check: only the status part');
    const E404 = await runCase(404, '<html><body>Not found.</body></html>', ['--no-files']);
    ok(E404.f && E404.f.checkpoints.counts.fail === 0 && E404.f.verdict.label === 'The live page answered with an error (HTTP 404)' && E404.f.confidence_text === 'The live page answered with an error (HTTP 404). No cause could be found from what was given. To go further, give the site files and a log.', `status part only, no "checks failed" part: "${E404.f && E404.f.confidence_text}"`);
    ok(!FORBIDDEN.test(E404.r.stdout + E404.files), 'neither forbidden sentence appears');

    group('S1b-fix (c): no files, status 200 but a live check failed: only the failed part');
    const F200 = await runCase(200, CRIT, ['--no-files']);
    const failedC = F200.f ? F200.f.checkpoints.counts.fail : -1;
    ok(F200.f && failedC > 0 && F200.f.verdict.label === 'A problem was seen on the live page' && F200.f.confidence_text === `${failedC} live check${failedC === 1 ? '' : 's'} failed. No cause could be found from what was given. To go further, give the site files and a log.`, `failed part only, no "answered with an error" part: "${F200.f && F200.f.confidence_text}"`);
    ok(!/answered with an error/.test(F200.f.confidence_text) && !FORBIDDEN.test(F200.r.stdout + F200.files), 'no "answered with an error" and neither forbidden sentence');

    group('S1b-fix (d, e): status 200 and nothing failed (case c) and a description only (case a) are unchanged');
    const OK = await runCase(200, OK200, ['--no-files']);
    ok(OK.f && OK.f.verdict.label === 'No confirmed breaking cause was found' && OK.f.confidence_text === 'How sure we are: not very. Nothing that was checked points at a cause that could be confirmed.', `S3a-fix (case c) text is exactly: "${OK.f && OK.f.confidence_text}"`);
    ok(fA && fA.verdict.label === 'Nothing could be checked' && fA.confidence_text === 'How sure we are: not at all. Nothing could be checked, so this report does not say whether your site is healthy: no site files were given, no log was read and no live check was run.', 'case (a) text is exactly the S1b text');

    group('S1b-fix (f): WITH a site folder and failing checks the old verdict text is exactly the old text');
    const wp = path.join(tmp, 'wp');
    fs.mkdirSync(path.join(wp, 'wp-content', 'plugins', 'okplug'), { recursive: true }); fs.mkdirSync(path.join(wp, 'wp-content', 'themes', 'tt'), { recursive: true });
    fs.writeFileSync(path.join(wp, 'wp-content', 'plugins', 'okplug', 'okplug.php'), '<?php\n/**\n * Plugin Name: Ok Plug\n * Version: 1.0.0\n */\nfunction okplug_hello() { return 1; }\n');
    fs.writeFileSync(path.join(wp, 'wp-content', 'themes', 'tt', 'style.css'), '/*\nTheme Name: TT\nVersion: 1.0\n*/\n'); fs.writeFileSync(path.join(wp, 'wp-content', 'themes', 'tt', 'functions.php'), '<?php\n// theme\n');
    const WF = await runCase(500, CRIT, ['--root', wp, '--no-replica']);
    ok(WF.f && WF.f.checkpoints.counts.fail > 0 && WF.f.verdict.label === 'No confirmed breaking cause was found' && WF.f.confidence_text === 'How sure we are: not very. Nothing that was checked points at a cause that could be confirmed.', `with a site folder and ${WF.f && WF.f.checkpoints.counts.fail} failed checks the verdict is the old text, byte for byte`);
    ok(WF.f && !/A problem was seen on the live page|No cause could be found from what was given/.test(WF.r.stdout + WF.files), 'and none of the new wording appears');

    group('S1b-fix (g): the log step reason without site files');
    const logStep = (fA.timeline || []).find(t => t.id === 'logs');
    ok(logStep && logStep.reason === 'no site files were given, so no log could be read', `the log step says "no site files were given, so no log could be read" (got "${logStep && logStep.reason}")`);
    ok(!/no local WordPress root/.test(JSON.stringify(fA)) && (fA.timeline || []).filter(t => /was given \(--root\)/.test(t.reason || '')).length === 0, 'no "no local WordPress root" and no "was given (--root)" reason is left in findings.json of a no-files run');

    // ---- S1d: --log with --no-files: a log without a site folder. Possible causes only, never confirmed. Made-up logs and ONE fake secret marker; no real site. ----
    const SECRET = 'FAKEmarker0001', SECRET2 = 'FAKEmarker0002';
    const logsDir = path.join(tmp, 'logs'); fs.mkdirSync(logsDir, { recursive: true });
    const mkLog = (name, text) => { const f = path.join(logsDir, name); fs.writeFileSync(f, text); return f; };
    const LOG1 = mkLog('debug.log', `[19-Nov-2026 10:00:01 UTC] PHP Fatal error:  Uncaught Error: Call to undefined function acme_missing() in /srv/example/wp-content/plugins/acme-slider/acme.php:12\nStack trace:\n#0 /srv/example/wp-includes/class-wp-hook.php(324): acme_init()\n[19-Nov-2026 10:00:02 UTC] PHP Warning:  fetch https://api.example.test/v1?api_key=${SECRET} failed in /srv/example/wp-content/plugins/acme-slider/api.php on line 7\n[19-Nov-2026 10:00:03 UTC] PHP Notice:  login failed for password=${SECRET2} in /srv/example/wp-content/themes/tt/functions.php on line 3\n`);
    const LOG_CLEAN = mkLog('clean.log', '[19-Nov-2026 10:00:02 UTC] PHP Warning:  Undefined variable $x in /srv/example/wp-content/plugins/acme-slider/api.php on line 7\n[19-Nov-2026 10:00:03 UTC] PHP Notice:  Trying to access array offset in /srv/example/wp-content/themes/tt/functions.php on line 3\n');
    const LOG_EMPTY = mkLog('empty.log', '');
    const LOG_CORE = mkLog('core.log', '[19-Nov-2026 10:00:01 UTC] PHP Fatal error:  Uncaught Error: Call to undefined function core_thing() in /srv/example/wp-includes/foo.php:9\n[19-Nov-2026 10:00:02 UTC] PHP Fatal error:  Uncaught Error: Call to undefined function mu_thing() in /srv/example/wp-content/mu-plugins/x.php:4\n');
    const LOG_MANY = mkLog('many.log', ['plugin-a|15', 'plugin-b|18', 'plugin-c|17', 'plugin-d|19'].map(x => { const [n, d] = x.split('|'); return `[${d}-Nov-2026 10:00:01 UTC] PHP Fatal error:  Uncaught Error: Call to undefined function f_${n.replace('-', '_')}() in /srv/example/wp-content/plugins/${n}/main.php:3`; }).join('\n') + '\n');
    const LOG_MEM = mkLog('mem.log', '[19-Nov-2026 10:00:01 UTC] PHP Fatal error:  Allowed memory size of 134217728 bytes exhausted (tried to allocate 4096 bytes)\n');
    const LOG_HOSTILE = mkLog('hostile.log', '[19-Nov-2026 10:00:01 UTC] PHP Fatal error:  Uncaught Error: boom in /srv/example/wp-content/plugins/evil <b>"x y/a.php:3\n');
    const walk = d => { const out = []; (function w(x) { for (const n of fs.readdirSync(x)) { const f = path.join(x, n), st = fs.lstatSync(f); if (st.isDirectory()) w(f); else if (st.isFile()) out.push(f); } })(d); return out; };
    const runLogCase = async (extra, { code = null, body = null } = {}) => {
        let sv = null, url = null, before = issueDirs();
        if (code) { const x = await serve(code, body); sv = x.sv; url = x.url; }
        try {
            const r = await runAsync([...base, '--no-files', ...extra, ...(url ? ['--url', url, '--env', 'local'] : [])]);
            const dir = issueDirs().filter(n => !before.includes(n)).map(n => path.join(tmp, 'issues', n))[0] || path.join(tmp, 'none');
            const f = fs.existsSync(path.join(dir, 'result', 'findings.json')) ? readJson(path.join(dir, 'result', 'findings.json')) : null;
            const rd = n => { try { return fs.readFileSync(path.join(dir, 'result', n), 'utf8'); } catch { return ''; } };
            return { r, dir, f, report: rd('ISSUE-REPORT.md'), html: rd('issue.html'), all: fs.existsSync(dir) ? walk(dir) : [] };
        } finally { if (sv) sv.close(); }
    };
    const countIn = (res, needle) => res.all.filter(f => fs.readFileSync(f, 'utf8').includes(needle)).length + (res.r.stdout.includes(needle) ? 1 : 0) + (res.r.stderr.includes(needle) ? 1 : 0);
    const TAIL1 = 'This is a possible cause, not confirmed: the code was not read and nothing was tested.';
    const OLDER = 'The log may also hold older errors, and the tool cannot tell if this is the error you see now.';

    group('S1d (a) a real fake log now runs with --no-files; the log is masked before it is stored, and no site folder exists');
    const L1 = await runLogCase(['--log', LOG1]);
    ok(L1.r.status === 0 && L1.f, `exit 0 and a report (exit ${L1.r.status}) ${L1.r.stderr.slice(0, 120)}`);
    const issueL1 = readJson(path.join(L1.dir, 'issue.json'));
    ok(!issueL1.root && !fs.existsSync(path.join(L1.dir, 'site-copy')) && fs.existsSync(path.join(L1.dir, 'log-only', 'wp-content', 'debug.log')), 'issue.root stays empty, no site-copy, and only the masked copy exists under log-only/');
    ok(countIn(L1, SECRET) === 0 && countIn(L1, SECRET2) === 0, `the fake secrets appear in NO output file and not in the terminal (counts ${countIn(L1, SECRET)} and ${countIn(L1, SECRET2)}; ${L1.all.length} files checked)`);
    ok(fs.readFileSync(path.join(L1.dir, 'log-only', 'wp-content', 'debug.log'), 'utf8').includes('api_key=[REDACTED]'), 'the masked copy holds [REDACTED] in place of the secret');
    const rawLine = 'Call to undefined function acme_missing()';
    ok(!L1.r.stdout.includes(rawLine) && !L1.report.includes(rawLine) && !L1.html.includes(rawLine) && !JSON.stringify(L1.f).includes(rawLine), 'the log line itself is not copied into the terminal, ISSUE-REPORT.md, issue.html or findings.json');
    const userText = L1.r.stdout.split('\n').filter(l => !/^Saved: /.test(l)).join('\n') + L1.report;   // the "Saved:" line lists the report files themselves (findings.json, issue.html ...), as in every run
    ok(!/(hypotheses|evidence|validation|probe|logs|intake|sandbox|bisect|custom-code|components)\.json|\bwork\//.test(userText), 'no internal work file name (hypotheses.json, evidence.json, work/ ...) in the terminal text or ISSUE-REPORT.md of a log-only run');

    group('S1d (b) the possible cause, word for word; the code and database were not read; level 2; never confirmed');
    ok(L1.f.verdict.label === 'The log shows a possible cause' && L1.f.confidence_text === `The log shows a fatal error in a file of acme-slider (last seen 2026-11-19). ${TAIL1} ${OLDER} To go further, give the site files.`, `verdict: "${L1.f.verdict.label}" / "${L1.f.confidence_text}"`);
    ok(/Looked at: your log\. Not looked at: [^.]*the code \(no site files were given\)[^.]*a throwaway test copy\./.test(L1.r.stdout) && /NOT TESTED ON A COPY/.test(L1.r.stdout) && /comes from reading your log\./.test(L1.r.stdout), 'level 2 "NOT TESTED ON A COPY"; Looked at: your log; Not looked at: the code (no site files were given), a throwaway test copy; the label says reading your log');
    ok(/a database export file of your site/.test(L1.r.stdout) && /the code of your site/.test(L1.r.stdout), 'the missing list names the database export and the code');
    ok(!/confirmed(?!,| cause)|caused by|most likely/i.test(L1.f.confidence_text.replace(/not confirmed/g, '')), 'the sentence never says "confirmed" (except "not confirmed"), "caused by" or "most likely"');
    ok(!/all secrets|every secret/i.test(L1.r.stdout + L1.report), 'it never says that all secrets were removed');
    ok(/The log shows a fatal error in a file of acme-slider/.test(L1.r.stdout.split('WHAT YOU SEE')[1] || ''), 'the possible cause is also under "What you see"');

    group('S1d (c) the gate: a log alone never reaches CONFIRMED, REPRODUCIBLE or "likely"');
    ok(!(L1.f.hypotheses || []).some(h => ['CONFIRMED', 'REPRODUCIBLE', 'FIXED_VERIFIED'].includes(h.status)) && (L1.f.findings || []).length === 0, 'no hypothesis is CONFIRMED, REPRODUCIBLE or FIXED_VERIFIED and there is no finding');
    ok(!/Confirmed|Most likely/.test(L1.f.verdict.label) && !((L1.f.case_file || {}).cases || []).some(c => ['confirmed', 'likely'].includes(c.kind)), 'the verdict label and the case file carry no "Confirmed" or "Most likely" case');
    ok(L1.f.log_only && L1.f.log_only.possible_causes.length === 1 && L1.f.log_only.possible_causes[0].name === 'acme-slider', 'the possible cause is kept apart from the hypotheses, in its own field');

    group('S1d (d) the checks: only the two log checks can run; the other 51 say "no site files were given"');
    const rowsL = L1.f.checkpoints.items;
    ok(rowsL.filter(i => i.result === 'PASS').length === 2 && rowsL.filter(i => i.result === 'NOT CHECKED').length === 51, `2 log checks ran (pass), 51 are not checked (${JSON.stringify(L1.f.checkpoints.counts)})`);
    ok(rowsL.filter(i => i.result === 'PASS').every(i => i.reason === 'not found in the part of the log that was read'), 'a PASS of a log check says "not found in the part of the log that was read", never "this is fine"');
    ok(rowsL.filter(i => i.result === 'NOT CHECKED').filter(i => /no site files were given/.test(i.reason)).length >= 29, 'the code rows keep "no site files were given, so no code was read"');

    group('S1d (e) no fatal error that names a plugin or a theme');
    const CL = await runLogCase(['--log', LOG_CLEAN]);
    ok(CL.f && CL.f.verdict.label === 'No cause could be named from the log' && CL.f.confidence_text === 'The last part of the log (up to 2 MB) was read. It has no fatal error that names a plugin or a theme. This does not mean the site is fine. To go further, give the site files.', `clean log: "${CL.f && CL.f.verdict.label}" / "${CL.f && CL.f.confidence_text}"`);
    const EM = await runLogCase(['--log', LOG_EMPTY]);
    ok(EM.r.status === 0 && EM.f && EM.f.verdict.label === 'No cause could be named from the log' && EM.f.confidence_text === 'The log file is empty. This does not mean the site is fine. To go further, give the site files.', `empty log: "${EM.f && EM.f.confidence_text}"`);
    const CO = await runLogCase(['--log', LOG_CORE]);
    ok(CO.f && CO.f.verdict.label === 'No cause could be named from the log' && /The log shows a fatal error, but no plugin or theme can be named from it\./.test(CO.f.confidence_text) && CO.f.log_only.possible_causes.length === 0, `a fatal in core and in mu-plugins: no cause named: "${CO.f && CO.f.confidence_text}"`);

    group('S1d (f) at most 3 names, most recent first, then "and N more"; names are limited to letters, digits and . _ -');
    const MN = await runLogCase(['--log', LOG_MANY]);
    ok(MN.f && MN.f.confidence_text.startsWith('The log shows fatal errors in files of plugin-d (last seen 2026-11-19), plugin-b (last seen 2026-11-18), plugin-c (last seen 2026-11-17) and 1 more. These are possible causes, not confirmed:'), `four plugins: three names, newest first, "and 1 more": "${MN.f && MN.f.confidence_text.slice(0, 190)}"`);
    const HO = await runLogCase(['--log', LOG_HOSTILE]);
    ok(HO.r.status === 0 && HO.f && !/[<>"]/.test(HO.f.confidence_text) && !/evil/.test(HO.f.confidence_text + HO.report), `a hostile folder name (space, <, quote) never reaches a sentence: "${HO.f && HO.f.confidence_text.slice(0, 120)}"`);
    const P = require('../lib/plain-names');
    const hostile = P.logCausesOf([{ level: 'fatal error', file: 'wp-content/plugins/ev il<b>"x/a.php', last_seen: '2026-11-19T10:00:01Z' }, { level: 'fatal error', file: 'wp-content/plugins/ev\nil/a.php' }, { level: 'fatal error', file: 'wp-content/themes/ok.name-1_x/f.php', last_seen: '2026-11-19T10:00:01Z' }, { level: 'warning', file: 'wp-content/plugins/warn-only/a.php' }]);
    ok(hostile.causes.length === 1 && hostile.causes[0].name === 'ok.name-1_x' && hostile.fatalOutside === true && hostile.causes.every(c => P.NAME_OK.test(c.name)), 'logCausesOf: a name with space, "<", quote or newline is not a cause; only a clean name is; a warning is not a fatal');

    group('S1d (g) a log check that found something is a possible cause too; "No cause could be named" never appears then');
    const ME = await runLogCase(['--log', LOG_MEM]);
    ok(ME.f && ME.f.verdict.label === 'The log shows a possible cause' && /^The log shows PHP running out of memory\. This is a possible cause, not confirmed: the code was not read and nothing was tested\./.test(ME.f.confidence_text) && !/No cause could be named/.test(ME.r.stdout + ME.report + ME.html), `memory check: "${ME.f && ME.f.confidence_text.slice(0, 150)}"`);

    group('S1d (h) log + a home page that answers 500: one verdict, no contradiction');
    const PG = await runLogCase(['--log', LOG1], { code: 500, body: CRIT });
    const failedPG = PG.f ? PG.f.checkpoints.counts.fail : -1;
    ok(PG.f && failedPG > 0 && PG.f.verdict.label === 'A problem was seen on the live page, and the log shows a possible cause' && PG.f.confidence_text === `The live page answered with an error (HTTP 500). ${failedPG} live checks failed. The log shows a fatal error in a file of acme-slider (last seen 2026-11-19). ${TAIL1} ${OLDER} To go further, give the site files.`, `combined: "${PG.f && PG.f.confidence_text}"`);
    ok(!/No cause could be (found|named)|No confirmed breaking cause|Nothing that was checked points at a cause/.test(PG.r.stdout + PG.report + PG.html), 'no "No cause could be found / named" and neither old sentence next to a possible cause');
    ok(countIn(PG, SECRET) === 0, 'the fake secret is in no output file of this run either');
    const OK200L = await runLogCase(['--log', LOG1], { code: 200, body: OK200 });
    ok(OK200L.f && OK200L.f.verdict.label === 'The log shows a possible cause' && !/answered with an error/.test(OK200L.f.confidence_text), 'log + an address that answers 200: only the log part, the live rules are unchanged');
    const DS = await runLogCase(['--log', LOG1, '--description', 'The shop page is slow and shows a white screen since the update']);
    ok(DS.r.status === 0, 'log + a description works');

    group('S1d (i) names that are never read as a log (also through a symlink); the message holds no file content');
    const secretText = 'DB_PASSWORD=FAKEmarker0003\n';
    const refuse = (name, text = secretText) => { const f = path.join(logsDir, name); fs.writeFileSync(f, text); return run([...base, '--no-files', '--log', f]); };
    for (const nm of ['dump.sql', 'dump.sql.gz', 'prod.env', '.env', '.env.local', 'wp-config.php', 'wp-config-sample.php', 'DUMP.SQL', '.ENV', 'Wp-Config.PHP', 'dump.sql.', 'x.env.', 'wp-config.php.', 'wp-config.php.bak', 'dump.sql.zip']) {
        const x = refuse(nm);
        ok(x.status === 2 && new RegExp(`The file ${nm.replace(/\./g, '\\.')} is not read`).test(x.stderr) && !/FAKEmarker0003/.test(x.stdout + x.stderr), `${nm}: refused (exit 2), and the message holds no file content`);
    }
    const envFile = path.join(logsDir, 'real-name.env'); fs.writeFileSync(envFile, secretText);
    const linkFile = path.join(logsDir, 'innocent.log'); try { fs.rmSync(linkFile, { force: true }); fs.symlinkSync(envFile, linkFile); } catch { /* no symlinks here */ }
    const sl = run([...base, '--no-files', '--log', linkFile]);
    ok(sl.status === 2 && /is not read/.test(sl.stderr) && !/FAKEmarker0003/.test(sl.stdout + sl.stderr), 'a harmless name that is a symlink to an .env file is refused (the real path is checked)');
    const dirsBefore = issueDirs().length; const dirOnly = path.join(logsDir, 'adir.log'); fs.mkdirSync(dirOnly, { recursive: true });
    const notFile = run([...base, '--no-files', '--log', dirOnly]);
    ok(notFile.status === 2 && /does not exist or is not a file/.test(notFile.stderr) && issueDirs().length === dirsBefore, 'a folder is not a file: refused, and no issue folder is left');

    group('S1d (j) with a site folder (--root) --log behaves as before');
    const beforeW = issueDirs();
    const WLr = await runAsync([...base, '--root', wp, '--no-replica', '--log', LOG1]);
    const dirW = issueDirs().filter(n => !beforeW.includes(n)).map(n => path.join(tmp, 'issues', n))[0] || path.join(tmp, 'none');
    const fW = fs.existsSync(path.join(dirW, 'result', 'findings.json')) ? readJson(path.join(dirW, 'result', 'findings.json')) : null;
    ok(WLr.status === 0 && fW && /Log used: .*debug\.log \(given with --log\)\./.test(WLr.stdout), `--root with --log runs and says "Log used: ... (given with --log)" (exit ${WLr.status})`);
    ok(fW && !fW.log_only && !fs.existsSync(path.join(dirW, 'log-only')) && fs.existsSync(path.join(dirW, 'site-copy', 'wp-content', 'debug.log')), 'with a site folder the log goes into the site copy as before: no log-only folder, no log_only field');
    ok(fW && !/The log shows a possible cause|No cause could be named from the log|A problem was seen on the live page/.test(fW.verdict.label) && /Looked at: your log, the code\./.test(WLr.stdout), 'with a site folder none of the new no-files wording appears, and the code is looked at');
    ok(!/FAKEmarker000[12]/.test(fs.readFileSync(path.join(dirW, 'site-copy', 'wp-content', 'debug.log'), 'utf8')), 'with a site folder the log copy is still masked (unchanged)');

    // ---- S1d-fix: the --log refusal is a RULE (lower-case, trailing junk removed, split on "."; a part sql or env, or a name starting with wp-config = data; a packed part = packed) ----
    group('S1d-fix (k) names that are refused: database export, environment file, wp-config, packed files (also with trailing junk and through a symlink)');
    const DATA_MSG = /a database export, an environment file or wp-config is not a log\. Give an error log, for example debug\.log\./;
    const PACKED_MSG = /a packed file cannot be read as a log\. Unpack it and give the \.log file\./;
    const nDirs = issueDirs().length;
    const table = [
        ['dump.sql.7z', DATA_MSG], ['dump.sql.tar.gz', DATA_MSG], ['db.sql\t', DATA_MSG], ['.env.production', DATA_MSG], ['wp-config.php.bak', DATA_MSG], ['WP-CONFIG.PHP ', DATA_MSG], ['x.SQL.GZ', DATA_MSG],
        ['backup.tar.gz', PACKED_MSG], ['logs.zip', PACKED_MSG], ['old.7z', PACKED_MSG], ['x.rar', PACKED_MSG], ['y.xz', PACKED_MSG], ['z.bz2', PACKED_MSG], ['a.zst', PACKED_MSG], ['b.tgz', PACKED_MSG], ['c.tar', PACKED_MSG], ['d.GZ.\t ', PACKED_MSG]
    ];
    for (const [nm, msg] of table) {
        const x = refuse(nm);
        ok(x.status === 2 && msg.test(x.stderr) && /The file [^\n]* is not read/.test(x.stderr) && !/FAKEmarker0003/.test(x.stdout + x.stderr) && !/[\t]/.test(x.stderr), `${JSON.stringify(nm)}: refused (exit 2) with the ${msg === DATA_MSG ? 'database / environment / wp-config' : 'packed file'} message, no file content, no control character printed`);
    }
    const bidi = refuse('dump.sql\u202e'), zw = refuse('prod\u200b.env');
    ok(bidi.status === 2 && DATA_MSG.test(bidi.stderr) && !/[\u202e\u200b\u2028\u2029]/.test(bidi.stderr) && zw.status === 2 && DATA_MSG.test(zw.stderr) && !/[\u202e\u200b]/.test(zw.stderr), 'a bidi override or a zero-width character in the name is refused and is not printed as it is');
    const linkTo = (dirName, target) => { const d = path.join(logsDir, dirName); fs.mkdirSync(d, { recursive: true }); const real = path.join(logsDir, target); fs.writeFileSync(real, secretText); const l = path.join(d, 'debug.log'); try { fs.rmSync(l, { force: true }); fs.symlinkSync(real, l); } catch { /* no symlinks here */ } return run([...base, '--no-files', '--log', l]); };
    const slSql = linkTo('link-sql', 'real-dump.sql'), slPacked = linkTo('link-packed', 'archive.tar.gz');
    ok(slSql.status === 2 && DATA_MSG.test(slSql.stderr) && !/FAKEmarker0003/.test(slSql.stdout + slSql.stderr), 'a symlink named debug.log that points to a .sql file is refused through its real name');
    ok(slPacked.status === 2 && /is not read: a (packed file|database export)/.test(slPacked.stderr) && !/FAKEmarker0003/.test(slPacked.stdout + slPacked.stderr), 'a symlink named debug.log that points to a packed file is refused through its real name');
    ok(issueDirs().length === nDirs, 'none of these refusals made an issue folder');

    group('S1d-fix (l) names that are still accepted: a real log runs (exit 0)');
    for (const nm of ['debug.log', 'debug.log.1', 'error_log', 'php_errors.log', 'sql-errors.log', 'access.log']) {
        const f = path.join(logsDir, 'ok-' + nm.replace(/\./g, '_'), nm); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, '[19-Nov-2026 10:00:02 UTC] PHP Warning:  Undefined variable $x in /srv/example/wp-content/plugins/acme-slider/api.php on line 7\n');
        const x = run([...base, '--no-files', '--log', f]);
        ok(x.status === 0 && /Log used: /.test(x.stdout), `${nm}: accepted, the log is read (exit ${x.status})`);
    }

    // ---- S3a: the live page checks in one sentence (no site files only) ----
    group('S3a: "<N> of 7 live page checks gave a result. <M> could not run: <reason>." (no site files only)');
    const NP3 = 'A check that did not run is not a pass.';
    const seeOf = r => (((r.f || {}).case_file || {}).see || []);
    const S200 = await runCase(200, OK200, ['--no-files']);
    ok(S200.f && S200.f.live_checks && S200.f.live_checks.sentence === '7 of 7 live page checks gave a result.' && S200.f.live_checks.total === 7 && S200.f.live_checks.could_not_run === 0, 'S3a (1): a 200 page: findings.json live_checks says "7 of 7 live page checks gave a result." (no "could not run" part)');
    ok(S200.f && seeOf(S200).includes('7 of 7 live page checks gave a result.') && /7 of 7 live page checks gave a result\./.test(S200.r.stdout) && !/could not run/.test(S200.r.stdout), 'S3a (1): the sentence is under WHAT YOU SEE in the terminal text and in case_file.see');
    ok(S200.f && S200.f.live_checks && S200.f.live_checks.gave_a_result === S200.f.checkpoints.items.filter(i => ['cp-38', 'cp-39', 'cp-40', 'cp-41', 'cp-43', 'cp-44', 'cp-45'].includes(i.id) && i.result !== 'NOT CHECKED').length, 'S3a: the count comes from the real check rows (PASS, FAIL or ALSO NOTICED), not from a fixed number');
    const S500 = await runCase(500, CRIT, ['--no-files']);
    const L500 = (S500.f && S500.f.live_checks) || {};
    const want500 = `${L500.gave_a_result} of 7 live page checks gave a result. ${L500.could_not_run} could not run: the page answered with an error (HTTP 500), so it was not loaded again at the other screen size. ${NP3}`;
    ok(L500.gave_a_result === 3 && L500.could_not_run === 4 && L500.sentence === want500 && String(L500.sentence).startsWith('3 of 7 live page checks gave a result. 4 could not run: '), `S3a (2): a 500 page: 3 of 7, with the real cause (the second screen size was not loaded), not "stopped early": "${L500.sentence}"`);
    ok(L500.sentence && seeOf(S500).includes(want500) && S500.r.stdout.includes(want500) && !/stopped early/.test(want500), 'S3a (2): shown under WHAT YOU SEE and in case_file.see');
    const S429 = await runCase(429, 'Slow down', ['--no-files']);
    const w429 = `0 of 7 live page checks gave a result. 7 could not run: the website's protection or rate limiting stopped the test, so no more requests were sent: Repeated rate limiting (1 x HTTP 429). ${NP3}`;
    ok(S429.f && S429.f.live_checks && S429.f.live_checks.sentence === w429 && !/no address, not allowed|switched off/.test(S429.f.live_checks.sentence), `S3a (3): a 429 with an address: the real reason in plain words ("${S429.f && S429.f.live_checks && S429.f.live_checks.sentence}")`);
    ok(fA && fA.live_checks && fA.live_checks.sentence === `No live page check ran: no address was given. ${NP3}` && !/0 of 7/.test(fA.live_checks.sentence) && seeOf({ f: fA }).includes(fA.live_checks.sentence), 'S3a (4): no address (description only): "No live page check ran: no address was given." and never "0 of 7"');
    const SOff = await runCase(200, OK200, ['--no-files', '--no-probe']);
    ok(SOff.f && SOff.f.live_checks && SOff.f.live_checks.sentence === `No live page check ran: the live check was switched off. ${NP3}` && !/0 of 7/.test(SOff.f.live_checks.sentence), 'S3a (4): --no-probe: "No live page check ran: the live check was switched off."');
    // S3a2: the live rows say the true reason after a 429 stop (an address WAS given), with and without a site folder; the old row texts stay where they are true
    const rowReason = (r, id) => ((r.f && r.f.checkpoints.items.find(i => i.id === id)) || {}).reason;
    const OLDROW3 = 'the live page probe did not run (no address, not allowed, or switched off)';
    ok(S429.f && ['cp-38', 'cp-39', 'cp-40', 'cp-41', 'cp-43', 'cp-44', 'cp-45'].every(id => rowReason(S429, id) === S429.f.live_checks.reason && !/no address|not allowed|switched off/.test(rowReason(S429, id))), 'S3a2 (without a site folder, 429): every live row says the true reason, the same text as the sentence');
    const siteR = path.join(tmp, 'siteR'); fs.mkdirSync(path.join(siteR, 'wp-content', 'plugins', 'demo'), { recursive: true }); fs.mkdirSync(path.join(siteR, 'wp-content', 'themes', 't'), { recursive: true }); fs.writeFileSync(path.join(siteR, 'wp-content', 'plugins', 'demo', 'demo.php'), '<?php\n/* Plugin Name: Demo */\n');
    const R429 = await runCase(429, 'Slow down', ['--root', siteR, '--no-replica']);
    ok(R429.f && R429.f.live_checks === undefined && ['cp-38', 'cp-39', 'cp-44'].every(id => /^the website's protection or rate limiting stopped the test, so no more requests were sent: Repeated rate limiting \(1 x HTTP 429\)$/.test(rowReason(R429, id) || '')), 'S3a2 (with a site folder, 429): the rows say the true reason; still no live_checks field and no S3a sentence');
    ok(rowReason({ f: fA }, 'cp-38') === OLDROW3 && rowReason(SOff, 'cp-38') === OLDROW3, 'S3a2: no address and --no-probe: the old row text stays');
    ok(/^the live page probe stopped early/.test(rowReason(S500, 'cp-44') || ''), 'S3a2: a 500 page keeps "the live page probe stopped early" on its quiet rows');
    // S3a2-fix: a 200 page whose three scripts answer 503 (or drop the connection): the probe stops for the SERVER's sake and says so, it does not claim protection
    const PAGE3 = '<!doctype html><html><head><title>Fixture</title><script src="/a.js"></script><script src="/b.js"></script><script src="/c.js"></script></head><body><h1>Fixture shop</h1><p>The page works and has enough text to look like a real page.</p></body></html>';
    const stopCase = async (mode, extraArgs) => {
        const sv = http.createServer((q, res) => { if (q.url === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(PAGE3); } if (mode === 'reset') return q.socket.destroy(); res.writeHead(503, { 'Content-Type': 'text/plain' }); res.end('unavailable'); });
        await new Promise(r => sv.listen(0, '127.0.0.1', r));
        const before = issueDirs();
        try {
            const r = await runAsync([...base, ...extraArgs, '--url', `http://127.0.0.1:${sv.address().port}/`, '--env', 'local']);
            const dir = issueDirs().filter(n => !before.includes(n)).map(n => path.join(tmp, 'issues', n))[0] || path.join(tmp, 'none');
            const f = fs.existsSync(path.join(dir, 'result', 'findings.json')) ? readJson(path.join(dir, 'result', 'findings.json')) : null;
            const pj = fs.existsSync(path.join(dir, 'work', 'probe.json')) ? readJson(path.join(dir, 'work', 'probe.json')) : null;
            return { r, f, pj };
        } finally { sv.close(); }
    };
    const X5 = await stopCase('5xx', ['--no-files']), XR = await stopCase('reset', ['--no-files']);
    ok(X5.pj && X5.pj.protection && /Server instability/.test(X5.pj.protection.reason) && X5.f && X5.f.live_checks && /could not run: the test was stopped to keep the website safe, so no more requests were sent: Server instability \(3 x 5xx\)\. A check that did not run is not a pass\.$/.test(X5.f.live_checks.sentence) && !/protection/.test(X5.f.live_checks.sentence), `S3a2-fix: a server that answers 503 to its scripts: the sentence says the test was stopped to keep the website safe, not protection ("${X5.f && X5.f.live_checks && X5.f.live_checks.sentence}")`);
    ok(XR.pj && XR.pj.protection && /Connection resets/.test(XR.pj.protection.reason) && XR.f && XR.f.live_checks && /the test was stopped to keep the website safe, so no more requests were sent: Connection resets\/timeouts \(2\)\./.test(XR.f.live_checks.sentence) && !/protection/.test(XR.f.live_checks.sentence), 'S3a2-fix: a server that drops the connection: the same safe wording');
    ok(S429.f.live_checks.sentence.includes("the website's protection or rate limiting stopped the test, so no more requests were sent: Repeated rate limiting (1 x HTTP 429)."), 'S3a2-fix: a real 429 keeps the protection wording');
    const X5r = await stopCase('5xx', ['--root', siteR, '--no-replica']);
    ok(X5r.f && X5r.f.live_checks === undefined && X5r.pj && /Server instability/.test(X5r.pj.protection.reason) && !/live page checks? gave a result/.test(X5r.r.stdout), 'S3a2-fix (with a site folder, server errors): the probe stops, and still no live_checks field and no S3a sentence');
    // S3b: plugin, theme and WordPress version from what the probe ALREADY loaded (no new request); no site files only
    const PLUG = `<!doctype html><html><head><title>Fixture</title>
<meta name="generator" content="WordPress 6.4.2" />
<!-- This site is optimized with the Yoast SEO plugin v22.0 - https://yoast.com/wordpress/plugins/seo/ -->
<link rel="stylesheet" href="/wp-content/themes/twentytwentyfour/style.css?ver=1.2" />
<link rel="stylesheet" href="/wp-content/plugins/woo-sample/assets/a.css?ver=8.3.1&amp;nonce=abcdef123456" />
<script src="/wp-content/plugins/elementor-sample/b.js?ver=3.18.2"></script>
<script src="/wp-content/plugins/long-sample/c.js?ver=1234567890123456789012345"></script>
<script src="/wp-content/plugins/bad%20slug/d.js?ver=1.0"></script>
<script src="/wp-content/plugins/nover-sample/e.js"></script>
</head><body><h1>Fixture shop</h1><p>The page works and has enough text to look like a real page.</p>
<!-- <script src="/wp-content/plugins/ghost-sample/x.js?ver=9"></script> -->
<!-- This website is like a Rocket, isn't it? Performance optimized by WP Rocket. Learn more: https://wp-rocket.me -->
</body></html>`;
    const plugCase = async extraArgs => {
        const hits = [];
        const sv = http.createServer((q, res) => { hits.push(`${q.method} ${q.url}`); if (q.url === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(PLUG); } res.writeHead(200, { 'Content-Type': /\.css/.test(q.url) ? 'text/css' : 'application/javascript' }); res.end(/\.css/.test(q.url) ? 'body{}' : '/* ok */'); });
        await new Promise(r => sv.listen(0, '127.0.0.1', r));
        const before = issueDirs();
        try {
            const r = await runAsync([...base, ...extraArgs, '--url', `http://127.0.0.1:${sv.address().port}/`, '--env', 'local']);
            const dir = issueDirs().filter(n => !before.includes(n)).map(n => path.join(tmp, 'issues', n))[0] || path.join(tmp, 'none');
            const f = fs.existsSync(path.join(dir, 'result', 'findings.json')) ? readJson(path.join(dir, 'result', 'findings.json')) : null;
            const probeTxt = fs.existsSync(path.join(dir, 'work', 'probe.json')) ? fs.readFileSync(path.join(dir, 'work', 'probe.json'), 'utf8') : '';
            const files = ['ISSUE-REPORT.md', 'issue.html', 'findings.json'].map(n => { try { return fs.readFileSync(path.join(dir, 'result', n), 'utf8'); } catch { return ''; } }).join('\n');
            return { r, f, hits, probeTxt, files };
        } finally { sv.close(); }
    };
    const PL = await plugCase(['--no-files']);
    const wantSig = [
        'The page says it runs WordPress 6.4.2 (from the generator tag, which can be hidden or changed).',
        'The page loads files of: elementor-sample 3.18.2, long-sample, nover-sample and woo-sample 8.3.1 (a number after a name is a version from a file address or a page comment, and can be a cache number). Plugins that load nothing on this page are not shown.',
        'A comment on the page names: wordpress-seo 22.0 and wp-rocket. A comment is not proof that the plugin is active.',
        'The page loads files of the theme: twentytwentyfour (version 1.2 in the file address, which can be a cache number).'
    ];
    ok(PL.f && PL.f.live_signals && J(PL.f.live_signals.lines) === J(wantSig), `S3b: a page with several plugins, a theme, a bad slug, a very long version and a script tag in a comment: findings.json live_signals.lines is exactly the four sentences ${PL.f && PL.f.live_signals ? '' : '(no live_signals field)'}`);
    ok(PL.f && wantSig.every(l => seeOf(PL).includes(l) && PL.r.stdout.includes(l)), 'S3b: every sentence is under WHAT YOU SEE (case_file.see) and in the terminal text');
    ok(PL.f && !wantSig.some(l => PL.f.confidence_text.includes(l) || PL.f.verdict.label.includes(l)), 'S3b: none of them is in the verdict line or its sentence');
    ok(PL.f && PL.f.live_signals && !/ghost-sample|bad%20slug|bad slug|abcdef123456/.test(J(PL.f.live_signals)) && PL.f.live_signals.plugins.length === 4 && PL.f.live_signals.named_in_comments.length === 2, 'S3b: the script tag inside a comment, the bad slug and the query values are not in live_signals');
    ok(PL.hits.every(h => /^GET \//.test(h)) && !PL.hits.some(h => /ghost-sample|readme|plugins\/[^/]+\/?$|wp-json|xmlrpc|debug\.log/.test(h)) && new Set(PL.hits.map(h => h.split('?')[0])).size <= 7, `S3b: no new request: only GET, only the page and the files it asks for itself (${[...new Set(PL.hits.map(h => h.split('?')[0]))].join(' ')})`);
    ok(!/isn't it|Performance optimized by WP Rocket|yoast\.com/.test(PL.probeTxt + PL.files), 'S3b: the text of the page comments is not stored anywhere (probe.json, findings.json, the report)');
    ok(S200.f && S200.f.live_signals === undefined && !/The page loads files of|The page says it runs WordPress|A comment on the page names/.test(S200.r.stdout + S200.files), 'S3b: a page with no plugin, theme or generator in its files: no live_signals field and NO line');
    // S3c: plugins whose FILES the page loaded, matched by name against three known conflicts: "possible, not confirmed", no site files only, the verdict is not touched
    const pageOf = names => `<!doctype html><html><head><title>Fixture</title>${names.map(([n, v]) => `<script src="/wp-content/plugins/${n}/x.js${v ? `?ver=${v}` : ''}"></script>`).join('')}</head><body><h1>Fixture shop</h1><p>The page works and has enough text to look like a real page.</p><!-- This website is like a Rocket, isn't it? Performance optimized by WP Rocket. Learn more: https://wp-rocket.me --></body></html>`;
    const confCase = async (html, code, extraArgs) => {
        const sv = http.createServer((q, res) => { if (q.url === '/') { res.writeHead(code, { 'Content-Type': 'text/html' }); return res.end(html); } res.writeHead(200, { 'Content-Type': 'application/javascript' }); res.end('/* ok */'); });
        await new Promise(r => sv.listen(0, '127.0.0.1', r));
        const before = issueDirs();
        try {
            const r = await runAsync([...base, ...extraArgs, '--url', `http://127.0.0.1:${sv.address().port}/`, '--env', 'local']);
            const dir = issueDirs().filter(n => !before.includes(n)).map(n => path.join(tmp, 'issues', n))[0] || path.join(tmp, 'none');
            const f = fs.existsSync(path.join(dir, 'result', 'findings.json')) ? readJson(path.join(dir, 'result', 'findings.json')) : null;
            const kbf = path.join(dir, 'work', 'kb-hits.json');
            const files = ['ISSUE-REPORT.md', 'issue.html', 'findings.json'].map(n => { try { return fs.readFileSync(path.join(dir, 'result', n), 'utf8'); } catch { return ''; } }).join('\n');
            return { r, f, files, kb: fs.existsSync(kbf) ? readJson(kbf) : null };
        } finally { sv.close(); }
    };
    const KB = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'known-conflicts.json'), 'utf8')).entries;
    const EL = KB.find(e => e.id === 'cache-plugin-with-elementor');
    const wantEl = `Possible, not confirmed: the page loads files of elementor and litespeed-cache. What the source says: ${EL.causes} Source: "${EL.sources[0].title}" (elementor.com), checked ${EL.sources[0].last_checked}. This does not show that it causes the problem you reported. The page shows only plugins that load files on this page, so other plugins may exist that were not seen.`;
    const CF = await confCase(pageOf([['elementor', '3.18.2'], ['litespeed-cache', '6.0']]), 200, ['--no-files']);
    ok(CF.f && CF.f.live_conflicts && J(CF.f.live_conflicts.lines) === J([wantEl]), 'S3c: a page that loads files of elementor and litespeed-cache: findings.json live_conflicts.lines is the exact entry sentence');
    ok(CF.f && seeOf(CF).includes(wantEl) && CF.r.stdout.includes(wantEl) && !CF.f.confidence_text.includes('Possible, not confirmed') && !CF.f.verdict.label.includes('Possible'), 'S3c: the line is under WHAT YOU SEE and in the terminal text, and NOT in the verdict line or its sentence');
    ok(CF.f && CF.f.verdict.label === 'No confirmed breaking cause was found' && CF.f.confidence_text === 'How sure we are: not very. Nothing that was checked points at a cause that could be confirmed.' && S200.f.verdict.label === CF.f.verdict.label && S200.f.confidence_text === CF.f.confidence_text, 'S3c: the verdict label and "how sure we are" are exactly those of a 200 page with no match');
    ok(CF.f && !(CF.f.hypotheses || []).some(h => ['CONFIRMED', 'REPRODUCIBLE'].includes(h.status)) && CF.f.checkpoints.counts.pass === S200.f.checkpoints.counts.pass && CF.f.checkpoints.counts.not_checked === S200.f.checkpoints.counts.not_checked, 'S3c: no hypothesis, no CONFIRMED or REPRODUCIBLE, and the check counts are the same as without a match');
    const ONE = await confCase(pageOf([['elementor', '3.18.2'], ['woo-sample', '8.0']]), 200, ['--no-files']);
    ok(ONE.f && ONE.f.live_conflicts === undefined && !/Possible, not confirmed: the page loads files of/.test(ONE.r.stdout + ONE.files), 'S3c: only one of the two plugins: no live_conflicts field and no line');
    const COM = await confCase(pageOf([['elementor', '3.18.2']]), 200, ['--no-files']);
    ok(COM.f && J(COM.f.live_signals.named_in_comments.map(x => x.slug)) === J(['wp-rocket']) && COM.f.live_conflicts === undefined && !/Possible, not confirmed: the page loads files of/.test(COM.r.stdout + COM.files), 'S3c: elementor loads files and a page comment names wp-rocket: a comment-only name never matches');
    const VER = await confCase(pageOf([['elementor', '1.0'], ['litespeed-cache', '9.9.9'], ['elementor', '2.0']]), 200, ['--no-files']);
    ok(VER.f && VER.f.live_conflicts && VER.f.live_conflicts.lines.length === 1 && VER.f.live_conflicts.lines[0] === wantEl && !/1\.0|9\.9\.9|2\.0/.test(VER.f.live_conflicts.lines[0]), 'S3c: different versions of the same plugins: the same match, and no version in the sentence');
    const FIVE = await confCase(pageOf([['wp-rocket', '1'], ['autoptimize', '2'], ['breeze', '3'], ['fast-velocity-minify', '4'], ['litespeed-cache', '5'], ['elementor', '6']]), 200, ['--no-files']);
    ok(FIVE.f && FIVE.f.live_conflicts && FIVE.f.live_conflicts.lines.length === 2 && FIVE.f.live_conflicts.conflicts.map(c => c.id).join() === 'cache-plugin-with-elementor,wp-rocket-with-incompatible-plugin' && FIVE.f.live_conflicts.lines.every(l => l.startsWith('Possible, not confirmed: the page loads files of ')), 'S3c: several matches: up to three lines, in entry id order');
    const C500 = await confCase(pageOf([['elementor', '3.18.2'], ['litespeed-cache', '6.0']]), 500, ['--no-files']);
    ok(C500.f && C500.f.verdict.label === 'A problem was seen on the live page' && C500.f.live_conflicts && C500.f.live_conflicts.lines[0] === wantEl && /No confirmed cause could be found from what was given; a possible conflict is listed below\./.test(C500.f.confidence_text) && !C500.f.confidence_text.includes('Possible'), 'S3c: a 500 page with a matching pair: the verdict is the usual 500 verdict, the possible conflict is a separate line under WHAT YOU SEE');
    const W3 = await confCase(pageOf([['elementor', '3.18.2'], ['w3-total-cache', '2.7']]), 200, ['--no-files']);
    ok(W3.f && W3.f.live_conflicts === undefined && !/Possible, not confirmed: the page loads files of/.test(W3.r.stdout + W3.files), 'S3c-fix: a page that loads files of elementor and w3-total-cache (no claim backs that name for the Elementor entry): no line');
    const RL = await confCase(pageOf([['wp-rocket', '3.15'], ['litespeed-cache', '6.0']]), 200, ['--no-files']);
    ok(RL.f && RL.f.live_conflicts && RL.f.live_conflicts.lines.length === 1 && /files of wp-rocket and litespeed-cache\. What the source says: WP Rocket's own documentation/.test(RL.f.live_conflicts.lines[0]) && RL.f.live_conflicts.lines[0].includes('(docs.wp-rocket.me)') && !RL.f.live_conflicts.lines[0].includes('elementor.com'), 'S3c-fix: a page that loads files of wp-rocket and litespeed-cache prints the WP Rocket source (once), not the Elementor one');
    const CW = await confCase(pageOf([['elementor', '3.18.2'], ['litespeed-cache', '6.0']]), 200, ['--root', siteR, '--no-replica']);
    ok(CW.f && CW.f.live_conflicts === undefined && CW.f.live_signals === undefined && !/Possible, not confirmed: the page loads files of/.test(CW.r.stdout + CW.files), 'S3c: a run WITH a site folder, same page: no live_conflicts field and no such line');
    const siteK = path.join(tmp, 'siteK'); for (const pl of ['elementor', 'litespeed-cache']) { fs.mkdirSync(path.join(siteK, 'wp-content', 'plugins', pl), { recursive: true }); fs.writeFileSync(path.join(siteK, 'wp-content', 'plugins', pl, `${pl}.php`), `<?php\n/* Plugin Name: ${pl} */\n`); } fs.mkdirSync(path.join(siteK, 'wp-content', 'themes', 't'), { recursive: true });
    const CK = await confCase(pageOf([['elementor', '3.18.2']]), 200, ['--root', siteK, '--no-replica']);
    ok(CK.kb && (CK.kb.hits || []).some(h => h.id === 'cache-plugin-with-elementor') && CK.f && CK.f.live_conflicts === undefined, 'S3c: with a site folder the old kb path still finds the known conflict from the plugin folders (kb-hits.json), and the new field is absent');
    const PW = await plugCase(['--root', siteR, '--no-replica']);
    ok(PW.f && PW.f.live_signals === undefined && !/The page loads files of|The page says it runs WordPress|A comment on the page names/.test(PW.r.stdout + PW.files), 'S3b: a run WITH a site folder: no live_signals field and no such line');
    // ---- S4ab: wording of the verdict for a run WITHOUT site files (points 1, 2, 3, 5 and 7); a run WITH a site folder stays byte for byte ----
    const OLDZ = 'How sure we are: not at all. Nothing could be checked, so this report does not say whether your site is healthy: no site files were given, no log was read and no live check was run.';
    const NEWZ429 = "How sure we are: not at all. Nothing could be checked, so this report does not say whether your site is healthy: no site files were given, no log was read and no live page check ran (the website's protection or rate limiting stopped the test, so no more requests were sent: Repeated rate limiting (1 x HTTP 429)).";
    const OLDLINE = 'No live check was run, so nothing was seen on the live page.';
    const four = r => [r.r.stdout, r.files].join('\n');
    group('S4ab (1): after a stop with no page loaded, the verdict says why, not "no live check was run"');
    ok(S429.f && S429.f.verdict.label === 'Nothing could be checked' && S429.f.confidence_text === NEWZ429 && !/no live check was run/.test(four(S429)), 'S4 (1): a 429 on the first load: the sentence says no live page check ran, with the reason of the live-check sentence');
    ok(S429.r.stdout.includes(NEWZ429) && S429.files.split(NEWZ429).length >= 3, 'S4 (1): the same sentence is in the terminal VERDICT, ISSUE-REPORT.md, issue.html and findings.json');
    const closedPort = await new Promise(r => { const t = http.createServer(); t.listen(0, '127.0.0.1', () => { const p = t.address().port; t.close(() => r(p)); }); });
    const beforeU = issueDirs(); const U = await runAsync([...base, '--no-files', '--url', `http://127.0.0.1:${closedPort}/`, '--env', 'local']);
    const dirU = issueDirs().filter(n => !beforeU.includes(n)).map(n => path.join(tmp, 'issues', n))[0] || path.join(tmp, 'none');
    const fU = fs.existsSync(path.join(dirU, 'result', 'findings.json')) ? readJson(path.join(dirU, 'result', 'findings.json')) : null;
    ok(fU && fU.verdict.label === 'Nothing could be checked' && fU.confidence_text === 'How sure we are: not at all. Nothing could be checked, so this report does not say whether your site is healthy: no site files were given, no log was read and no live page check ran (the site could not be reached).' && !/no live check was run|net::|127\.0\.0\.1/.test(fU.confidence_text), 'S4 (1): a site that could not be reached (the probe started): "no live page check ran (the site could not be reached)." in plain words, no error text and no address');
    ok(fA.confidence_text === OLDZ && SOff.f.verdict.label === 'Nothing could be checked' && SOff.f.confidence_text === OLDZ, 'S4 (1): no address, and --no-probe: the old sentence stays ("no live check was run")');
    ok(plain.zeroChecksSentence({ probeRan: false, total: 53, liveStop: { attempted: true, gave: 0, total: 7, reason: 'the live check stopped.' } }).endsWith('no live page check ran (the live check stopped).') && /only 2 of 7 live page checks gave a result\.$/.test(plain.zeroChecksSentence({ probeRan: false, total: 53, liveStop: { attempted: true, gave: 2, total: 7, reason: 'x' } })) && !/no live page check ran/.test(plain.zeroChecksSentence({ probeRan: false, total: 53, liveStop: { attempted: true, gave: 2, total: 7, reason: 'x' } })) && plain.zeroChecksSentence({ probeRan: false, total: 53, liveStop: { attempted: false, gave: 0, total: 7, reason: 'no address was given' } }) === OLDZ && /the live page was loaded, but none of the 53 checks ran on it\.$/.test(plain.zeroChecksSentence({ probeRan: true, total: 53, liveStop: { attempted: true, gave: 0, total: 7, reason: 'x' } })), 'S4 (1): the sentence builder: 0 of 7 says no live page check ran, some results say "only N of 7", a probe that did not start keeps the old text, a loaded page keeps its old text');

    group('S4ab (2): WHAT YOU SEE drops the older line when the "N of 7" line is there');
    ok(!a.stdout.includes(OLDLINE) && a.stdout.includes('No live page check ran: no address was given.') && !S429.r.stdout.includes(OLDLINE) && S429.r.stdout.includes('0 of 7 live page checks gave a result.') && !SOff.r.stdout.includes(OLDLINE) && SOff.r.stdout.includes('No live page check ran: the live check was switched off.'), 'S4 (2): no address, --no-probe and a 429 stop: the "N of 7" / "No live page check ran" line only, not the older line as well');
    const beforeN = issueDirs(); const NU = await runAsync([...base, '--root', siteR, '--no-replica']);
    ok(NU.stdout.includes(OLDLINE) && !/live page checks? gave a result|No live page check ran/.test(NU.stdout), 'S4 (2): a run WITH a site folder and no address keeps the older line, and has no "N of 7" line');

    group('S4ab (3): a 500 page with a conflict line');
    const E500p = await confCase(pageOf([['elementor', '3.18.2']]), 500, ['--no-files']);
    ok(E500p.f && E500p.f.live_conflicts === undefined && /No cause could be found from what was given\./.test(E500p.f.confidence_text) && !/possible conflict is listed below/.test(E500p.f.confidence_text), 'S4 (3): a 500 page WITHOUT a conflict line keeps "No cause could be found from what was given."');
    ok(C500.f.confidence_text.includes('No confirmed cause could be found from what was given; a possible conflict is listed below.') && four(C500).includes('a possible conflict is listed below') && C500.f.summary && JSON.stringify(C500.f.summary).includes('a possible conflict is listed below'), 'S4 (3): with a conflict line the new sentence is in the terminal, the report files and the summary of findings.json');
    ok(plain.errorPageSentence({ statuses: [500], failedLive: 2, conflict: true }) === 'The live page answered with an error (HTTP 500). 2 live checks failed. No confirmed cause could be found from what was given; a possible conflict is listed below. To go further, give the site files and a log.' && plain.errorPageSentence({ statuses: [500], failedLive: 2 }) === 'The live page answered with an error (HTTP 500). 2 live checks failed. No cause could be found from what was given. To go further, give the site files and a log.', 'S4 (3): the sentence builder, with and without a conflict');

    group('S4ab (5): a 4xx answer (not 429) with no failed check is named as what it is');
    for (const code of [401, 403, 404, 410]) {
        const X = await runCase(code, '<html><body>Nope.</body></html>', ['--no-files']);
        const lab = `The live page answered with an error (HTTP ${code})`;
        ok(X.f && X.f.checkpoints.counts.fail === 0 && X.f.verdict.label === lab && X.f.confidence_text.startsWith(`${lab}. No cause could be found from what was given.`) && X.r.stdout.includes(`VERDICT: ${lab}`) && X.files.split(lab).length >= 4, `S4 (5): HTTP ${code} (no failed check): the label is "${lab}", the same in the terminal, ISSUE-REPORT.md, issue.html and findings.json`);
    }
    ok(E404.r.stdout.includes('VERDICT: The live page answered with an error (HTTP 404)') && !E404.r.stdout.includes('A problem was seen on the live page'), 'S4 (5): HTTP 404: the old label "A problem was seen on the live page" is gone from the output');
    ok(plain.errorPageLabel({ statuses: [404], failedLive: 1 }) === 'A problem was seen on the live page' && plain.errorPageLabel({ statuses: [500], failedLive: 0 }) === 'A problem was seen on the live page' && plain.errorPageLabel({ statuses: [404, 500], failedLive: 0 }) === 'A problem was seen on the live page' && plain.errorPageLabel({ statuses: [429], failedLive: 0 }) === 'A problem was seen on the live page' && plain.errorPageLabel({ statuses: [], failedLive: 2 }) === 'A problem was seen on the live page' && plain.errorPageLabel({ statuses: [403, 404], failedLive: 0 }) === 'The live page answered with an error (HTTP 403 and HTTP 404)', 'S4 (5): a failed check, a 5xx, a mix with a 5xx, a 429 or no status keep "A problem was seen on the live page"; two 4xx codes are both named');
    ok(E500.f.verdict.label === 'A problem was seen on the live page' && F200.f.verdict.label === 'A problem was seen on the live page', 'S4 (5): a 5xx page and a failed check on a 200 page keep the old label');

    group('S4ab (7): the combined label with a log');
    const P404 = await runLogCase(['--log', LOG1], { code: 404, body: '<html><body>Nope.</body></html>' });
    ok(P404.f && P404.f.verdict.label === 'The live page answered with an error, and the log shows a possible cause' && P404.r.stdout.includes('VERDICT: The live page answered with an error, and the log shows a possible cause') && P404.html.includes('The live page answered with an error, and the log shows a possible cause') && !P404.report.includes('A problem was seen on the live page'), 'S4 (7): a 4xx page and a log with a possible cause: the new combined label, in the terminal, issue.html and findings.json (ISSUE-REPORT.md does not print the verdict line, and has no old label)');
    ok(PG.f.verdict.label === 'A problem was seen on the live page, and the log shows a possible cause', 'S4 (7): a 5xx page with the log keeps the old combined label');
    const P404c = await runLogCase(['--log', LOG_CLEAN], { code: 404, body: '<html><body>Nope.</body></html>' });
    ok(P404c.f && P404c.f.verdict.label === 'The live page answered with an error (HTTP 404)', 'S4 (7): a 4xx page and a log with no possible cause: the 4xx label');

    group('S4ab: a run WITH a site folder is byte for byte as before');
    const W404 = await runCase(404, '<html><body>Nope.</body></html>', ['--root', siteR, '--no-replica']), W429 = await runCase(429, 'Slow down', ['--root', siteR, '--no-replica']);
    const NEWSTR = /The live page answered with an error \(HTTP|a possible conflict is listed below|no live page check ran|The live page answered with an error, and the log/;
    ok(W404.f && W404.f.verdict.label === WF.f.verdict.label && W404.f.confidence_text === WF.f.confidence_text && !NEWSTR.test(four(W404)), 'S4: with a site folder a 404 page: the old verdict text (the same as the 500 case WF pins), none of the new wording');
    ok(W429.f && !NEWSTR.test(four(W429)) && !/Repeated rate limiting \(1 x HTTP 429\)\)\./.test(W429.f.confidence_text), 'S4: with a site folder a 429 stop: none of the new wording');
    const W500c = await confCase(pageOf([['elementor', '3.18.2'], ['litespeed-cache', '6.0']]), 500, ['--root', siteR, '--no-replica']);
    ok(W500c.f && !NEWSTR.test(four(W500c)) && W500c.f.live_conflicts === undefined, 'S4: with a site folder a 500 page with the same plugins: none of the new wording');

    const site3 = path.join(tmp, 'site3'); fs.mkdirSync(path.join(site3, 'wp-content', 'plugins', 'demo'), { recursive: true }); fs.mkdirSync(path.join(site3, 'wp-content', 'themes', 't'), { recursive: true }); fs.writeFileSync(path.join(site3, 'wp-content', 'plugins', 'demo', 'demo.php'), '<?php\n/* Plugin Name: Demo */\n');
    const W200 = await runCase(200, OK200, ['--root', site3, '--no-replica']), W500 = await runCase(500, CRIT, ['--root', site3, '--no-replica']);
    ok(W200.f && W500.f && W200.f.live_checks === undefined && W500.f.live_checks === undefined && !/live page checks? gave a result|No live page check ran/.test(W200.r.stdout + W200.files + W500.r.stdout + W500.files), 'S3a: a run WITH a site folder has no live_checks field and none of the new sentences (old wording unchanged)');

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll no-files checks passed');
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); failures++; }).finally(() => { fs.rmSync(tmp, { recursive: true, force: true }); if (failures) process.exit(1); });
