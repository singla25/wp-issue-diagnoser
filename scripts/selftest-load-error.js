#!/usr/bin/env node
// Self-test of step 4i-a: the report says WHY the tool's own page load failed, in one fixed plain phrase (lib/load-error.js), never the raw error and never the address.
// Seen on a real run: a site with a bad HTTPS certificate date; the report said only "no page result could be used".
// Covered here:
//   - classify(): every table row, "not recognised" gives null, no phrase says "expired" (the tool knows only that the date is wrong);
//   - liveSummary + the live-check sentence: a recognised error gives "the tool's own page load failed: <phrase>" and the one-load sentence;
//     an unrecognised error and an unreachable site keep the OLD wording; the raw error text and the address never reach the sentence;
//   - the zero-checks verdict sentence carries the phrase, the verdict label does not change;
//   - a real run on an HTTPS fixture with a certificate the browser does not trust (127.0.0.1 only): the phrase is in ISSUE-REPORT.md, issue.html, findings.json
//     and the terminal output, the raw error is not, and retest never gives FIXED_VERIFIED.
// Chromium and openssl are needed for the last group (it says SKIP when openssl is missing). Never touches a real site.
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { spawn, spawnSync } = require('child_process');

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pg-loaderr-')));
process.env.PLUGIN_GUARD_ISSUES = path.join(tmp, 'issues');
const ENVX = { PG_PROBE_NAV_DELAY_MS: '0', PG_PROBE_REQUEST_DELAY_MS: '0', PG_PROBE_5XX_RETRY_DELAY_MS: '0', PG_PROBE_COOLDOWN_FILE: path.join(tmp, 'cool.json') };
Object.assign(process.env, ENVX);
let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const group = t => console.log(`\n== ${t}`);
const CMD = path.join(__dirname, 'plugin-guard.js');
const NP = 'A check that did not run is not a pass.';
const ONE = 'This was one load, from one computer, at one time. It does not show what other visitors see.';
const HEAD = "the tool's own page load failed: ";

let L = null; try { L = require('../lib/load-error'); } catch { /* old code: every check below FAILS, the file does not crash */ }
const cls = t => (L && typeof L.classify === 'function' ? L.classify(t) : null);
const cpMod = require('../issue/checkpoints'), plainNames = require('../lib/plain-names');

(async () => {
    group('classify(): one fixed phrase per error family');
    const TABLE = [
        ['page.goto: net::ERR_CERT_DATE_INVALID at https://host.example/', 'certificate date error'],
        ['net::ERR_CERT_AUTHORITY_INVALID', 'other certificate error'], ['net::ERR_CERT_REVOKED', 'other certificate error'],
        ['net::ERR_CERT_COMMON_NAME_INVALID', 'wrong host name'], ['net::ERR_NAME_NOT_RESOLVED', 'wrong host name'],
        ['net::ERR_SSL_PROTOCOL_ERROR', 'secure connection (SSL) error'], ['net::ERR_CONNECTION_REFUSED', 'connection refused'],
        ['page.goto: Timeout 30000ms exceeded.', 'timeout'], ['net::ERR_TIMED_OUT', 'timeout'], ['net::ERR_TOO_MANY_REDIRECTS', 'too many redirects'],
        ['net::ERR_CONNECTION_RESET', 'connection reset'], ['net::ERR_EMPTY_RESPONSE', 'connection reset']
    ];
    for (const [raw, phrase] of TABLE) { const c = cls(raw); ok(!!c && c.phrase === phrase, `${raw.slice(0, 48)} -> "${phrase}"`); }
    ok(cls('something odd happened') === null && cls('') === null && cls(null) === null && cls(undefined) === null, 'an error that is not in the table (or empty) gives null, so the old wording stays');
    ok(TABLE.every(([raw]) => { const c = cls(raw); return c && !/expire/i.test(c.phrase); }) && !!L && L.TABLE.every(r => !/expire/i.test(r[2])), 'no phrase says "expired": only "date error"');
    ok((cls('page.goto: net::ERR_CERT_DATE_INVALID at https://host.example/ETIMEDOUT/ERR_CONNECTION_REFUSED') || {}).phrase === 'certificate date error' && cls('page.goto: something odd at https://host.example/ERR_CERT_DATE_INVALID') === null, 'the address at the end is not read: a code inside the address cannot pick the family');
    ok(!!L && typeof L.classifyPages === 'function' && L.classifyPages([{ error: 'x' }, { error: 'net::ERR_CERT_DATE_INVALID' }]).phrase === 'certificate date error' && L.classifyPages([]) === null && L.classifyPages(null) === null, 'classifyPages takes the first recognised page error');

    group('the live-check sentence');
    const synth = { customCode: null, components: [], graph: null, kbHits: null, collisions: null, evidence: { steps: [] }, probe: null };
    const real = loads => ({ pages: ['https://host.example/shop/'], viewports: ['laptop 1280x800', 'mobile 390x844'], loads, notes: [] });
    const sumOf = (probe, steps) => { const w = { ...synth, probe, evidence: { steps } }; const rows = cpMod.evaluate({ work: w, validation: { hypotheses: [] }, ran: { probe: true }, hasRoot: false }); return cpMod.liveSummary(rows, w); };
    const failStep = [{ id: 'live-probe', status: 'FAILED', reason: '0 of 2 planned page loads completed (1 page(s) x 2 screen size(s)); 2 governed request(s)' }];
    const mk = err => ({ schema: 1, planned: real(2), protection: null, pages: [{ url: 'https://host.example/shop/', loaded: false, status: 0, error: err }, { url: 'https://host.example/shop/', loaded: false, status: 0, error: err }] });
    const s1 = sumOf(mk('page.goto: net::ERR_CERT_DATE_INVALID at https://host.example/shop/'), failStep);
    const t1 = plainNames.liveChecksSentence(s1);
    ok(t1 === `0 of 7 live page checks gave a result. 7 could not run: ${HEAD}certificate date error. ${NP} ${ONE}`, `date error: exact sentence ("${t1}")`);
    ok(!/host\.example|net::|ERR_|expire/i.test(t1), 'the sentence holds no address, no raw error text and no "expired"');
    ok(!/visitors (have|see|get) the same|everyone|all visitors|your customers/i.test(t1.replace(ONE, '')) && /one load, from one computer, at one time/.test(t1), 'it never says visitors have the same problem; it says one load, one computer, one time');
    const hostile = sumOf(mk('net::ERR_CERT_DATE_INVALID \u001b[31m<script>alert(1)</script> https://secret-name.example/?token=abc'), failStep);
    const th = plainNames.liveChecksSentence(hostile);
    ok(/certificate date error/.test(th) && !/secret-name|token|<script|\u001b/.test(th), 'a hostile error text never reaches the sentence');
    const other = plainNames.liveChecksSentence(sumOf(mk('net::ERR_CERT_AUTHORITY_INVALID'), failStep));
    ok(other === `0 of 7 live page checks gave a result. 7 could not run: ${HEAD}other certificate error. ${NP} ${ONE}`, 'another certificate error: "other certificate error"');
    const unk = plainNames.liveChecksSentence(sumOf(mk('something odd'), failStep));
    ok(unk === `0 of 7 live page checks gave a result. 7 could not run: no page result could be used. ${NP}`, 'an unrecognised error keeps the OLD sentence, without the one-load sentence');
    const unr = plainNames.liveChecksSentence(sumOf(mk('net::ERR_CERT_DATE_INVALID'), [{ id: 'live-probe', status: 'FAILED', reason: 'the site could not be reached (Site unreachable (x) for y: this is not site protection)' }]));
    ok(unr === `0 of 7 live page checks gave a result. 7 could not run: the site could not be reached. ${NP}`, 'a site that could not be reached keeps its own old wording');
    const noerr = plainNames.liveChecksSentence(sumOf({ schema: 1, planned: real(2), protection: null, pages: [] }, failStep));
    ok(noerr === `0 of 7 live page checks gave a result. 7 could not run: no page result could be used. ${NP}`, 'no page error saved: the old sentence');
    ok(s1 && s1.load_error === 'cert-date' && unk && unk.length > 0, 'the summary carries the error family id (not the text)');

    group('the verdict does not change');
    const stop = { gave: 0, total: 7, attempted: true, reason: `${HEAD}certificate date error` };
    const z = plainNames.zeroChecksSentence({ hasRoot: false, hasCode: false, hasLog: false, probeRan: false, total: 7, liveStop: stop });
    ok(z === `How sure we are: not at all. Nothing could be checked, so this report does not say whether your site is healthy: no site files were given, no log was read and no live page check ran (${HEAD}certificate date error).`, 'the zero-checks sentence names the reason; "not at all" and "Nothing could be checked" are kept');
    ok(plainNames.NOTHING_CHECKED_LABEL === 'Nothing could be checked', 'the label is unchanged');

    group('a real run: HTTPS fixture with a certificate the browser does not trust');
    const key = path.join(tmp, 'k.pem'), crt = path.join(tmp, 'c.pem');
    const gen = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', crt, '-days', '2', '-subj', '/CN=pg-fixture.invalid'], { encoding: 'utf8' });
    if (gen.status !== 0) console.log('SKIP  openssl is not available: the real-run group is skipped');
    else {
        const hits = [];
        const sv = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(crt) }, (q, res) => { hits.push(q.url); res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html><body>x</body></html>'); });
        await new Promise(r => sv.listen(0, '127.0.0.1', r));
        const url = `https://127.0.0.1:${sv.address().port}/`;
        const out = await new Promise(resolve => { const c = spawn(process.execPath, [CMD, '--description', 'The browser says the connection is not private', '--no-files', '--yes', '--url', url, '--env', 'local'], { cwd: tmp, env: { ...process.env } }); let so = '', se = ''; c.stdout.on('data', d => { so += d; }); c.stderr.on('data', d => { se += d; }); c.on('close', code => resolve({ status: code, stdout: so, stderr: se })); });
        sv.close();
        const dirs = fs.readdirSync(path.join(tmp, 'issues')).filter(n => /^iss-/.test(n));
        const dir = path.join(tmp, 'issues', dirs[0] || 'none'), rd = n => { try { return fs.readFileSync(path.join(dir, 'result', n), 'utf8'); } catch { return ''; } };
        const f = rd('findings.json') ? JSON.parse(rd('findings.json')) : null;
        ok(out.status === 0 && !!f, `the run ends with exit 0 and a findings.json (exit ${out.status})`);
        const sentence = f && f.live_checks ? f.live_checks.sentence : '';
        ok(new RegExp(`${HEAD}(other certificate error|wrong host name|certificate date error)`).test(sentence) && sentence.includes(ONE), `findings.json live_checks.sentence has the phrase and the one-load sentence ("${String(sentence).slice(0, 120)}")`);
        const phrase = (/page load failed: ([a-z ]+?)\./.exec(sentence) || [])[1] || '@@';
        for (const [name, text] of [['ISSUE-REPORT.md', rd('ISSUE-REPORT.md')], ['issue.html', rd('issue.html')], ['findings.json', rd('findings.json')], ['terminal output', out.stdout]]) {
            ok(text.includes(HEAD + phrase) && text.includes(ONE.slice(0, 40)), `${name} shows the phrase "${phrase}" and the one-load sentence`);
        }
        const line = ` ${sentence}`;
        ok(!/net::|ERR_CERT|ERR_SSL|127\.0\.0\.1/.test(line), 'the new sentence holds no raw error and no address');
        ok(f && f.verdict && f.verdict.label === 'Nothing could be checked' && !/CONFIRMED|REPRODUCIBLE|FIXED_VERIFIED/.test(JSON.stringify(f.verdict)), `the verdict label stays "Nothing could be checked" (label "${f && f.verdict && f.verdict.label}")`);
        const retest = require('../issue/retest');
        const rr = await retest.run(dirs[0], { root: null, options: {}, env: { ...process.env, ...ENVX }, now: () => 'T' });
        ok(rr && rr.entry && rr.entry.fixed_verified === false, 'retest on this issue never gives FIXED_VERIFIED');
        const wk = fs.existsSync(path.join(dir, 'work', 'probe.json')) ? fs.readFileSync(path.join(dir, 'work', 'probe.json'), 'utf8') : '';
        ok(!/--ignore-certificate-errors|ignoreHTTPSErrors/.test(fs.readFileSync(path.join(__dirname, '..', 'probe', 'worker.js'), 'utf8') + fs.readFileSync(path.join(__dirname, '..', 'probe', 'safety.js'), 'utf8')) && hits.length === 0, `no certificate bypass in the probe code, and the untrusted server saw no request (${hits.length})`);
        void wk;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll load-error checks passed');
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } process.exit(1); });
