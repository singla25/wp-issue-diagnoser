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
        ok(/Looked at: [^.\n]*the live page/.test(c.stdout) && /Not looked at: [^.\n]*the code/.test(c.stdout), 'the status line says the live page was looked at and the code was not');
        ok(!fs.existsSync(path.join(dirC, 'site-copy')), 'no site copy was made');
        const fC = fs.existsSync(path.join(dirC, 'result', 'findings.json')) ? readJson(path.join(dirC, 'result', 'findings.json')) : null;
        ok(fC && !(fC.hypotheses || []).some(h => ['CONFIRMED', 'REPRODUCIBLE'].includes(h.status)), 'no cause is CONFIRMED or REPRODUCIBLE without any site files');
    } finally { server.close(); }

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll no-files checks passed');
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); failures++; }).finally(() => { fs.rmSync(tmp, { recursive: true, force: true }); if (failures) process.exit(1); });
