#!/usr/bin/env node
// End-to-end test of the report masking (step 4a-2): a real no-files run with a made-up, non-loopback website address (no request is sent: --no-probe, so the test needs no DNS),
// an email address and an IP address in the description. After the run every SHAREABLE file and the terminal text are searched for the host, the email and the IP.
//   shareable (masked):  result/ISSUE-REPORT.md, result/issue.html, result/findings.json, result/tasks.md, issues/index.html, the terminal output
//   working data (real): issue.json, issue.md, work/*  (retest and `issue show` need the real address there; they are never meant to be shared)
// (Patches and shims are code and are not masked; recorded as a decision.) Also: the note "Masking is best effort and pattern based; names can remain." appears only when something was masked; a loopback address is not masked;
// the feedback notice carries the new sentence. Never touches a real site.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pg-rmrun-')));
process.env.PLUGIN_GUARD_ISSUES = path.join(tmp, 'issues');
const ENVX = { PG_PROBE_NAV_DELAY_MS: '0', PG_PROBE_REQUEST_DELAY_MS: '0', PG_PROBE_COOLDOWN_FILE: path.join(tmp, 'cool.json') };
Object.assign(process.env, ENVX);
let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const group = t => console.log(`\n== ${t}`);
const CMD = path.join(__dirname, 'plugin-guard.js'), GUARD = path.join(__dirname, 'guard.js');
const HOST = 'acme-shop.example', EMAIL = 'owner-test@acme-shop.example', IP = '203.0.113.9', URL_ = `https://www.${HOST}:8080/checkout/`;
const NOTE = 'Masking is best effort and pattern based; names can remain.';
const runAsync = (cmd, args) => new Promise(resolve => { const c = spawn(process.execPath, [cmd, ...args], { cwd: tmp, env: { ...process.env } }); let so = '', se = ''; c.stdout.on('data', d => { so += d; }); c.stderr.on('data', d => { se += d; }); c.on('close', code => resolve({ status: code, stdout: so, stderr: se })); });
const dirs = () => { try { return fs.readdirSync(path.join(tmp, 'issues')).filter(n => /^iss-/.test(n)); } catch { return []; } };
const rd = (id, ...p) => { try { return fs.readFileSync(path.join(tmp, 'issues', id, ...p), 'utf8'); } catch { return ''; } };

(async () => {
    group('a run with a made-up website address, an email and an IP address');
    const before = new Set(dirs());
    const r = await runAsync(CMD, ['--description', `Contact ${EMAIL}, server ${IP}, the page ${URL_} is white`, '--no-files', '--yes', '--url', URL_, '--env', 'staging', '--no-probe']);
    const id = dirs().find(n => !before.has(n));
    ok(r.status === 0 && !!id, `the run ends with exit 0 and made an issue (exit ${r.status})`);
    const shareable = { 'ISSUE-REPORT.md': rd(id, 'result', 'ISSUE-REPORT.md'), 'issue.html': rd(id, 'result', 'issue.html'), 'findings.json': rd(id, 'result', 'findings.json'), 'tasks.md': rd(id, 'result', 'tasks.md'), 'terminal output': r.stdout + r.stderr };
    for (const [name, text] of Object.entries(shareable)) {
        ok(text.length > 100 && !/acme-shop/i.test(text) && !/owner-test/i.test(text) && !text.includes(IP), `${name}: no host, no email, no IP address`);
    }
    ok(shareable['findings.json'].includes('[site address]') && shareable['ISSUE-REPORT.md'].includes('[email removed]') && shareable['terminal output'].includes('[email removed]'), 'the masked values stand where the text was ("[site address]" in findings.json, "[email removed]" in the report title and in the terminal)');
    const idx = (() => { try { return fs.readFileSync(path.join(tmp, 'issues', 'index.html'), 'utf8'); } catch { return ''; } })();
    ok(idx.length > 100 && !/acme-shop/i.test(idx) && !/owner-test/i.test(idx) && !idx.includes(IP), 'issues/index.html (the overview of all issues) holds no host, no email, no IP address either')
    ok(shareable['ISSUE-REPORT.md'].includes(NOTE) && shareable['issue.html'].includes(NOTE) && shareable['findings.json'].includes(NOTE), 'the report says "Masking is best effort and pattern based; names can remain." (md, html, json)');
    ok(!/all (secrets|private|personal)[^.]*removed|everything (was )?removed/i.test(Object.values(shareable).join('\n')), 'the report never claims that everything was removed');

    group('the text read from a screenshot (OCR)');
    const ij = path.join(tmp, 'issues', id, 'issue.json'), ijd = JSON.parse(fs.readFileSync(ij, 'utf8'));
    ijd.images = [{ name: 'shot.png', kind: 'png', width: 100, height: 50 }]; fs.writeFileSync(ij, JSON.stringify(ijd));
    fs.mkdirSync(path.join(tmp, 'issues', id, 'work', 'ocr'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'issues', id, 'work', 'ocr', 'shot.png.txt'), 'Address bar: ACME - SHOP | acmeshop.com/cart\nYour connection is not private\nwp-content/plugins/foo/bar.php\n');
    const inv = await runAsync(GUARD, ['issue', 'investigate', id, '--no-prompt', '--gate', '--no-probe']);
    const oc = { 'findings.json': rd(id, 'result', 'findings.json'), 'issue.html': rd(id, 'result', 'issue.html'), 'ISSUE-REPORT.md': rd(id, 'result', 'ISSUE-REPORT.md') };
    ok(inv.status === 0 && oc['findings.json'].includes('ocr_text'), `a screenshot text was stored and the report was written again (exit ${inv.status})`);
    for (const [name, text] of Object.entries(oc)) ok(!/ACME - SHOP|acmeshop/i.test(text) && !/acme-shop/i.test(text), `${name}: the site name read from the screenshot (damaged: "ACME - SHOP", "acmeshop.com") is not in it`);
    ok(oc['findings.json'].includes('Your connection is not private') && oc['findings.json'].includes('wp-content/plugins/foo/bar.php'), 'the rest of the screenshot text stays (benign lines are not masked)');
    ok(rd(id, 'work', 'ocr', 'shot.png.txt').includes('ACME - SHOP'), 'work/ocr keeps the text as it was read (working data)');

    group('working data keeps the real address (retest and issue show need it)');
    const issueJson = rd(id, 'issue.json') ? JSON.parse(rd(id, 'issue.json')) : {};
    ok(issueJson.url === URL_ || String(issueJson.url).includes(HOST), 'issue.json keeps the real address');
    const store = require('../lib/issue-store');
    ok(store.load(id).url.includes(HOST), 'store.load (what retest reads) returns the real address');
    const show = await runAsync(GUARD, ['issue', 'show', id]), list = await runAsync(GUARD, ['issue', 'list']);
    console.log(`INFO  issue show prints issue.md: host in it ${show.stdout.includes(HOST)}, email ${show.stdout.includes('owner-test')}; issue list prints id, status, symptom and title: host in it ${list.stdout.includes(HOST)}`);
    ok(show.status === 0 && show.stdout.includes(HOST) && list.status === 0, 'issue show still prints the real issue file and issue list still works (reported, not changed)');

    group('nothing masked: no note; a loopback address is not masked');
    const b2 = new Set(dirs());
    const r2 = await runAsync(CMD, ['--description', 'The page is white, see http://127.0.0.1:9/shop/', '--no-files', '--yes', '--url', 'http://127.0.0.1:9/shop/', '--env', 'local', '--no-probe']);
    const id2 = dirs().find(n => !b2.has(n));
    const md2 = rd(id2, 'result', 'ISSUE-REPORT.md'), js2 = rd(id2, 'result', 'findings.json');
    ok(r2.status === 0 && md2.includes('127.0.0.1') && !md2.includes('[site address]') && !md2.includes(NOTE) && !js2.includes(NOTE), 'a loopback address stays as it is and the note is not added when nothing was masked');

    group('the feedback notice');
    const fb = require('../lib/feedback');
    ok(fb.SAVED_NOTICE.endsWith('The report itself still names your pages; check it before you share it.') && /email addresses and IP addresses are removed first/.test(fb.SAVED_NOTICE), 'the notice keeps its true part (about the feedback text) and adds "The report itself still names your pages; check it before you share it."');

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll report-mask run checks passed');
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } process.exit(1); });
