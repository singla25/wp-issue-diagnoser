#!/usr/bin/env node
// Self-test of --no-files (S1a): the command runs with NO site folder (modes D and E of docs/INPUT-MODES.md).
//   - the flag's refusals are plain (with --root, --sandbox, --db-dump, --log) and the old refusal without --root is unchanged
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
const group = t => console.log(`\n== ${t}`);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-nofiles-'));
const CMD = path.join(__dirname, 'plugin-guard.js');
const ENV = (extra = {}) => ({ ...process.env, PLUGIN_GUARD_ISSUES: path.join(tmp, 'issues'), PG_PROBE_NAV_DELAY_MS: '0', PG_PROBE_REQUEST_DELAY_MS: '0', PG_PROBE_COOLDOWN_FILE: path.join(tmp, 'cool.json'), ...extra });
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
    const lg = run([...base, '--no-files', '--log', path.join(tmp, 'debug.log')]);
    ok(lg.status === 2 && /--log cannot be used with --no-files yet/.test(lg.stderr), '--no-files with --log: refused for now (S1b)');
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
        ok(fC && fC.verdict.label === 'Nothing could be checked' && /the live page was loaded, but none of the 53 checks ran on it/.test(fC.confidence_text), 'S1b (a)/(case c): 0 checks ran, so the verdict says nothing could be checked and that the page was loaded but no check ran on it');
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

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll no-files checks passed');
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); failures++; }).finally(() => { fs.rmSync(tmp, { recursive: true, force: true }); if (failures) process.exit(1); });
