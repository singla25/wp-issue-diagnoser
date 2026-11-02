#!/usr/bin/env node
// Step 5-A: the oracle judges redirect loops, long chains and cross-host redirects, and `generic` recognises a blank page or a critical-error
// text served with a success status (for the symptoms white-screen, redirect and other only). Also: every caller of oracle.evaluate passes the
// issue's symptom, and the probe already RECORDS a redirect loop (rec.error) without counting it toward its stop thresholds.
// Pure parts run offline; the real-worker part runs the probe against a fixture on 127.0.0.1 (never a real site).

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const oracle = require('../issue/oracle');
const store = require('../lib/issue-store');
const probe = require('../issue/probe');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const group = t => console.log(`\n== ${t}`);

const P = (o = {}) => ({ url: 'http://a.test/x', viewport: { name: 'laptop', width: 1280 }, loaded: true, status: 200, console_errors: [], page_errors: [], error_responses: [], scroll: { doc_width: 1280, viewport_width: 1280 }, text: 'hello world', ...o });
const E = (spec, pages, symptom, extra = {}) => oracle.evaluate(spec, { pages, planned: extra.planned || pages.length, ...extra }, symptom === undefined ? {} : { symptom });
const LOOP = 'page.goto: net::ERR_TOO_MANY_REDIRECTS at http://a.test/x';
const loopPage = () => P({ loaded: false, status: 0, error: LOOP });

(async () => {
    group('oracle "redirect": loops, chains, other hosts');
    ok(E({ type: 'redirect' }, [loopPage()], 'redirect').result === 'yes' && /loop/.test(E({ type: 'redirect' }, [loopPage()], 'redirect').matches[0].detail), 'a page that ends in ERR_TOO_MANY_REDIRECTS: yes (the loop), although no page loaded');
    const chain = n => Array.from({ length: n }, (_, i) => `http://a.test/${i}`);
    ok(E({ type: 'redirect' }, [P({ redirects: chain(5) })], 'redirect').result === 'yes', '4 redirects in a row (limit 3): yes');
    ok(E({ type: 'redirect' }, [P({ redirects: chain(4) })], 'redirect').result === 'no', '3 redirects in a row (limit 3): no');
    ok(E({ type: 'redirect', value: '1' }, [P({ redirects: chain(3) })], 'redirect').result === 'yes', 'the optional value is the chain limit (1): 2 hops is yes');
    ok(E({ type: 'redirect' }, [P({ redirects: ['http://a.test/a', 'http://a.test/b', 'http://a.test/a'] })], 'redirect').result === 'yes', 'a chain that visits the same address twice is a loop');
    ok(E({ type: 'redirect' }, [P({ redirects: ['http://a.test/a', 'http://evil.test/a'] })], 'redirect').result === 'yes', 'a redirect to another host: yes');
    ok(E({ type: 'redirect' }, [P({ redirects: ['http://a.test/a', 'https://www.a.test/a'] })], 'redirect').result === 'no', 'http -> https and a.test -> www.a.test are the same site: no');
    ok(E({ type: 'redirect' }, [P()], 'redirect').result === 'no', 'no redirect at all: no');
    ok(E({ type: 'redirect' }, [P()], 'redirect', { planned: 3 }).result === 'could-not-test', 'only 1 of 3 loads and nothing seen: "no" cannot be said');
    ok(E({ type: 'redirect' }, [P({ redirects: ['http://a.test/a', 'http://evil.test/a'] })], 'redirect', { planned: 3 }).result === 'yes', '...but a redirect seen before the probe stopped stands');
    ok(E({ type: 'redirect' }, [], 'redirect').result === 'could-not-test', 'no page at all: could not test');
    ok(E({ type: 'redirect' }, [P({ error: 'page.goto: Timeout 45000ms exceeded', loaded: false, status: 0 })], 'redirect').result !== 'yes', 'a timeout is not a redirect loop');

    group('oracle "generic": new signs only for white-screen / redirect / other');
    for (const sym of ['white-screen', 'redirect', 'other']) {
        ok(E({ type: 'generic' }, [loopPage()], sym).result === 'yes', `generic + symptom ${sym}: a redirect loop is yes`);
        ok(E({ type: 'generic' }, [P({ text: '' })], sym).result === 'yes', `generic + symptom ${sym}: a blank page with HTTP 200 is yes`);
        ok(E({ type: 'generic' }, [P({ text: 'Error. There has been a critical error on this website.' })], sym).result === 'yes', `generic + symptom ${sym}: the critical-error text with HTTP 200 is yes`);
    }
    ok(E({ type: 'generic' }, [P({ text: '<br />\nFatal error: Uncaught Error: Call to undefined function x() in /srv/a.php:3' })], 'white-screen').result === 'yes', 'a printed PHP "Fatal error:" with HTTP 200 is yes');
    ok(E({ type: 'generic' }, [P({ text: 'An article about why Fatal error messages appear in PHP.' })], 'white-screen').result === 'no', 'a sentence that merely contains the words "Fatal error" is not');
    for (const sym of [undefined, null, 'layout', 'js-error', 'slow']) {
        ok(E({ type: 'generic' }, [P({ text: '' })], sym).result === 'no' && E({ type: 'generic' }, [loopPage()], sym).result === 'could-not-test', `generic with symptom ${sym === undefined ? '(not passed)' : sym}: behaves as before (blank page: no; loop: no page loaded, could not test)`);
    }
    ok(E({ type: 'generic' }, [P()], 'white-screen').result === 'no', 'a normal page stays "no"');
    ok(E({ type: 'generic' }, [P({ status: 500, text: '' })], 'white-screen').matches.every(m => !/blank/.test(m.detail)), 'a 5xx page is reported as a 5xx, not as a blank page');
    ok(E({ type: 'generic' }, [P({ text: undefined, text_chars: 0 })], 'white-screen').result === 'yes' && E({ type: 'generic' }, [P({ text: undefined, text_flags: { blank: false, critical: true }, text_chars: 80 })], 'white-screen').result === 'yes',
        'a stored page record (text dropped, text_chars / text_flags kept) gives the same answer as the live one, so the validation step can recompute it');
    ok(E({ type: 'generic' }, [P({ text: undefined, text_chars: 40 })], 'white-screen').result === 'no', 'a stored record with text and no flags: no');
    const tf = oracle.textFlags('There has been a critical error on this website.');
    ok(tf.critical === true && tf.blank === false && oracle.textFlags('  \n ').blank === true, 'textFlags(): critical / blank');

    group('the symptom is recorded and every caller passes it');
    ok(E({ type: 'redirect' }, [P()], 'redirect').symptom === 'redirect' && !('symptom' in E({ type: 'redirect' }, [P()])), 'the result carries the symptom only when a caller passed one');
    const issueDir = path.join(__dirname, '..', 'issue');
    const callers = [];
    for (const f of fs.readdirSync(issueDir).sort()) {
        if (!f.endsWith('.js') || f === 'oracle.js') continue;
        fs.readFileSync(path.join(issueDir, f), 'utf8').split('\n').forEach((l, i) => { if (/\b(oracle|oracleMod|oracleLib)\s*\.\s*evaluate\(|require\('\.\/oracle'\)\.evaluate\(/.test(l)) callers.push({ at: `${f}:${i + 1}`, ok: /symptom:\s*issue\.symptom/.test(l) }); });
    }
    ok(callers.length >= 7, `found the callers of oracle.evaluate in issue/ (${callers.length}: ${callers.map(c => c.at).join(', ')})`);
    ok(callers.every(c => c.ok), `every one of them passes symptom: issue.symptom${callers.filter(c => !c.ok).length ? ' (missing: ' + callers.filter(c => !c.ok).map(c => c.at).join(', ') + ')' : ''}`);

    group('issue store: the new symptom and oracle');
    ok(store.SYMPTOM_IDS.includes('redirect') && store.DEFAULT_ORACLE.redirect === 'redirect' && store.ORACLES.redirect, 'symptom "redirect" exists, its default oracle is "redirect"');
    ok(store.SYMPTOMS[7][0] === 'other' && store.SYMPTOMS[0][0] === 'white-screen', 'the numbers of the older symptom choices did not change (the new one is last)');

    // ------------------------------------------------------------------ the real worker
    group('the real probe worker on a redirect loop (fixture on 127.0.0.1)');
    if (!probe.browserReady().ok) { console.log(`SKIP  plugin-guard's own browser is not installed (${probe.browserReady().reason}): the worker part did not run`); return finish(); }
    const hits = [];
    let port = 0;
    const server = http.createServer((req, res) => {
        const p = req.url.split('?')[0];
        hits.push({ method: req.method, path: p });
        const redirect = loc => { res.writeHead(302, { Location: loc }); res.end(); };
        if (p === '/loop/') return redirect('/loop/');
        if (p === '/ping/') return redirect('/pong/');
        if (p === '/pong/') return redirect('/ping/');
        if (p === '/c1/') return redirect('/c2/'); if (p === '/c2/') return redirect('/c3/'); if (p === '/c3/') return redirect('/c4/'); if (p === '/c4/') return redirect('/ok/');
        if (p === '/xhost/') return redirect(`http://localhost:${port}/ok/`);
        res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><title>ok</title><body><p>Everything works on this page.</p></body>');
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r)); port = server.address().port;
    const base = `http://127.0.0.1:${port}/`;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-redir-'));
    const job = { base, pages: ['/loop/', '/ping/', '/c1/', '/xhost/', '/ok/'].map(x => base.replace(/\/$/, '') + x), viewports: [{ name: 'laptop', width: 1280, height: 800 }], measure: [], layout: false, expected: null, publicCheck: null,
        stateRoot: tmp, cooldownFile: path.join(tmp, 'cool.json'), out: path.join(tmp, 'result.json') };
    fs.writeFileSync(path.join(tmp, 'job.json'), JSON.stringify(job));
    // asynchronous on purpose: the fixture server lives in this process and must keep answering while the worker runs
    const run = await new Promise(resolve => { const c = spawn(process.execPath, [path.join(__dirname, '..', 'probe', 'worker.js'), path.join(tmp, 'job.json')], { env: { ...process.env, PG_PROBE_NAV_DELAY_MS: '0', PG_PROBE_REQUEST_DELAY_MS: '0', PG_PROBE_5XX_RETRY_DELAY_MS: '0' }, stdio: 'ignore' }); const t = setTimeout(() => c.kill('SIGKILL'), 240000); c.on('close', code => { clearTimeout(t); resolve({ status: code }); }); });
    let out = null; try { out = JSON.parse(fs.readFileSync(job.out, 'utf8')); } catch { /* reported below */ }
    ok(!!out && !out.error && run.status === 0, `the worker finished (exit ${run.status}${out && out.error ? ', error: ' + out.error : ''})`);
    const rec = u => (out ? out.pages.find(p => p.url.endsWith(u)) : null);
    ok(rec('/loop/') && rec('/loop/').loaded === false && /ERR_TOO_MANY_REDIRECTS/.test(rec('/loop/').error || ''), 'the self-redirect is already recorded: loaded=false and rec.error holds ERR_TOO_MANY_REDIRECTS (probe/safety.js needs no change)');
    ok(rec('/ping/') && /ERR_TOO_MANY_REDIRECTS/.test(rec('/ping/').error || ''), 'a two-page loop (/ping/ <-> /pong/) is recorded the same way');
    ok(rec('/c1/') && rec('/c1/').loaded && rec('/c1/').redirects.length === 5, `a 4-hop chain is recorded in rec.redirects (${rec('/c1/') ? rec('/c1/').redirects.length : '?'} addresses)`);
    ok(rec('/xhost/') && rec('/xhost/').redirects.some(u => u.includes('localhost')), 'a redirect to another host name is recorded in rec.redirects');
    ok(rec('/ok/') && rec('/ok/').loaded && !(rec('/ok/').redirects || []).length, 'a normal page has no redirects');
    const g = out ? out.governor : {};
    ok(out && !g.stopped && !out.protection && g.status_429 === 0 && g.status_5xx === 0, 'a loop does not count toward the stop thresholds: the probe was not stopped, no 429 / 5xx / protection recorded, and the later pages were still loaded');
    ok(hits.every(h => h.method === 'GET'), 'only GET requests reached the fixture');
    const pages = out ? out.pages : [];
    ok(oracle.evaluate({ type: 'redirect' }, { pages, planned: pages.length }, { symptom: 'redirect' }).result === 'yes', 'the oracle says yes on the real record');
    const only = n => pages.filter(p => p.url.endsWith(n));
    ok(oracle.evaluate({ type: 'redirect' }, { pages: only('/loop/'), planned: 1 }, { symptom: 'redirect' }).result === 'yes', '...for the loop alone');
    ok(oracle.evaluate({ type: 'redirect' }, { pages: only('/c1/'), planned: 1 }, { symptom: 'redirect' }).result === 'yes', '...for the 4-hop chain alone');
    ok(oracle.evaluate({ type: 'redirect' }, { pages: only('/xhost/'), planned: 1 }, { symptom: 'redirect' }).result === 'yes', '...for the cross-host redirect alone');
    ok(oracle.evaluate({ type: 'redirect' }, { pages: only('/ok/'), planned: 1 }, { symptom: 'redirect' }).result === 'no', '...and no for the normal page');
    server.close(); fs.rmSync(tmp, { recursive: true, force: true });
    finish();
})().catch(e => { console.error(e); process.exit(1); });

function finish() { console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed'); process.exit(failures ? 1 : 0); }
