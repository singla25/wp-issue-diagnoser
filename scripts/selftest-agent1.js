#!/usr/bin/env node
// Agent 1 against a local fixture site on 127.0.0.1 (never a real site): runs the real src/frontend Playwright agent (smoke mode).
// Takes a few minutes because the frontend agent paces its page loads on purpose.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-agent1-'));
process.env.PLUGIN_GUARD_RUNS = path.join(tmp, 'runs');
process.env.QA_REPORTS_DIR = path.join(tmp, 'frontend-reports'); // keep the frontend's state, cooldowns and screenshots out of src/frontend/reports
const runs = require('../lib/runs');
const workflow = require('../lib/workflow');
const validateAgent = require('../agents/validate');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const group = t => console.log(`\n== ${t}`);
async function quiet(fn) { const old = console.log; const lines = []; console.log = (...a) => lines.push(a.join(' ')); try { return { r: await fn(), out: lines.join('\n') }; } finally { console.log = old; } }

function server(handler) {
    const hits = [];
    const s = http.createServer((req, res) => { hits.push(`${req.method} ${req.url}`); handler(req, res); });
    return new Promise(r => s.listen(0, '127.0.0.1', () => r({ s, hits, url: `http://127.0.0.1:${s.address().port}/` })));
}
const PAGE = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><meta name="description" content="Fixture page for the Plugin Guard Agent 1 self-test, long enough to look like a description."></head><body><header><nav><a href="/">Home</a> <a href="/about/">About</a></nav></header><main><h1>${title}</h1>${body}</main><footer>© fixture</footer></body></html>`;

(async () => {
    group('Agent 1 on a healthy-but-imperfect fixture site');
    const site = await server((req, res) => {
        const send = (code, type, body, h = {}) => { res.writeHead(code, { 'Content-Type': type, ...h }); res.end(req.method === 'HEAD' ? undefined : body); };
        if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'text/plain', 'read only');
        const p = req.url.split('?')[0];
        if (p === '/') return send(200, 'text/html', PAGE('Home', '<p>Welcome to the fixture site. This paragraph exists so the page has body copy of a realistic length.</p><img src="/wp-content/plugins/shop/missing.png" width="200" height="100" alt="missing"><script src="/wp-content/plugins/shop/js/shop.js"></script><script>setTimeout(function(){ throw new Error("fixture boom"); }, 50)</script><form action="/subscribe" method="post"><label for="e">Email</label><input id="e" name="email" type="email"><button type="submit">Join</button></form>'));
        if (p === '/about/') return send(200, 'text/html', PAGE('About', '<p>About the fixture. Plain page that should load without any trouble at all.</p>'));
        if (p === '/robots.txt') return send(200, 'text/plain', 'User-agent: *\nDisallow:\n');
        return send(404, 'text/html', PAGE('Not found', '<p>Nothing here.</p>'));
    });
    const r1 = await quiet(() => workflow.qaUrl({ url: site.url, env: 'local', mode: 'smoke', 'timeout-min': '10' }));
    const id = runs.list().pop();
    const dir = runs.dirOf(id);
    const a1 = runs.read(id, 'agent1.json');
    ok(r1.r === 0 && a1.tests_ran === true, 'the existing Playwright agent ran and Agent 1 completed (exit 0)');
    ok(fs.existsSync(path.join(dir, '01-user-test-report.md')) && fs.existsSync(path.join(dir, 'evidence', 'frontend', 'qa-report.json')), '01-user-test-report.md and the frontend report are stored in the run');
    ok(a1.findings.length > 0 && a1.findings.every(f => f.source_agent === 'user-frontend' && f.run_id === id), `converted ${a1.findings.length} frontend finding(s) to the shared schema`);
    ok(a1.findings.some(f => /404|missing|failed|asset/i.test(`${f.title} ${f.category} ${f.description}`) && f.url), 'the missing plugin asset / broken image is reported with its page URL');
    ok(a1.findings.some(f => /error|console|javascript|exception/i.test(`${f.title} ${f.category} ${f.description}`)), 'the JavaScript error is reported');
    const shots = a1.findings.flatMap(f => f.evidence).filter(e => /^evidence\/frontend\//.test(e));
    ok(shots.length > 0 && shots.every(s => fs.existsSync(path.join(dir, s))), `screenshots are copied into the run's evidence folder (${shots.length})`);
    ok(a1.checks.some(c => c.id === 'forms' && c.status === 'SKIPPED' && /NOT VERIFIED/.test(c.reason)), 'a form was found but never submitted, and the report says its outcome is NOT VERIFIED');
    ok(a1.checks.some(c => c.id === 'login' && c.status === 'NEEDS_AUTHORIZATION'), 'login flows are NEEDS_AUTHORIZATION, not "passed"');
    ok(!site.hits.some(h => /^(POST|PUT|DELETE|PATCH)/.test(h)), `no state-changing request reached the site (${site.hits.length} GET/HEAD requests)`);
    ok(/Source-code checks have NOT run/.test(r1.out), 'without a source root the command explains how to continue');
    const v = await validateAgent.run({ runId: id });
    ok(v.complete === false && v.stages.find(s => s.id === 'agent1').state === 'completed', 'Agent 3 builds a PARTIAL report from Agent 1 alone');
    ok(v.findings.some(f => f.status === 'CONFIRMED') && v.findings.every(f => !f.fix_eligible), 'frontend findings with stored evidence are CONFIRMED, none becomes a code task');
    site.s.close();

    group('Agent 1 against a WAF challenge');
    const wafHits = [];
    const waf = await server((req, res) => { wafHits.push(req.url); res.writeHead(403, { 'Content-Type': 'text/html', 'cf-mitigated': 'challenge', server: 'cloudflare' }); res.end('<html><head><title>Just a moment...</title></head><body>Checking your browser before accessing the site. cf-chl-bypass</body></html>'); });
    const r2 = await quiet(() => workflow.qaUrl({ url: waf.url, env: 'local', mode: 'smoke', 'timeout-min': '10' }));
    const id2 = runs.list().pop();
    const b = runs.read(id2, 'agent1.json');
    ok(wafHits.length <= 3, `the agent stopped at the challenge (${wafHits.length} request(s)); it did not retry around it`);
    const v2 = await validateAgent.run({ runId: id2 });
    ok(v2.findings.length > 0 && v2.findings.every(f => ['BLOCKED', 'NEEDS_AUTHORIZATION', 'UNVERIFIED'].includes(f.status)), 'every result is BLOCKED / UNVERIFIED, none is a "confirmed website defect"');
    ok(v2.findings.some(f => f.status === 'BLOCKED' || b.checks.some(c => c.status === 'BLOCKED')), 'the blocked stage is recorded as BLOCKED with its reason');
    ok(v2.summary.by_status.CONFIRMED === 0, 'the site is not called broken because access was denied');
    waf.s.close();

    console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
