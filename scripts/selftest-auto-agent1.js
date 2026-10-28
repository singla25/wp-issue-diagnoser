#!/usr/bin/env node
// `guard:auto` with the REAL frontend agent (visual mode, Playwright) against a fixture site on 127.0.0.1 (never a real site), through the real CLI,
// with --no-sandbox (the sandbox is covered elsewhere). Proves the wiring: the frontend run, the conversion, the auto-issues derived from what the
// browser really saw, the report, the exit code, and that nothing but GET/HEAD reached the site. Slow on purpose (the frontend agent paces itself).
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync, spawn } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-aa1-'));
const env = { ...process.env, NO_COLOR: '1', PLUGIN_GUARD_RUNS: path.join(tmp, 'runs'), PLUGIN_GUARD_ISSUES: path.join(tmp, 'issues'), PLUGIN_GUARD_SANDBOXES: path.join(tmp, 'sb'), QA_REPORTS_DIR: path.join(tmp, 'fe'),
    VISUAL_MAX_PAGES: '2', VISUAL_VIEWPORTS: 'laptop,mobile', NAVIGATION_DELAY_MS: '2000', REQUEST_DELAY_MS: '500', CI: '1' };
const trees = require('./fixtures/issue/trees');
let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const PAGE = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><meta name="description" content="Fixture page for the guard:auto self-test, long enough to look like a real description of a page."></head><body><header><nav><a href="/">Home</a> <a href="/about/">About</a></nav></header><main><h1>${title}</h1>${body}</main><footer><p>Footer text of the fixture site.</p></footer></body></html>`;

(async () => {
    const hits = [];
    const srv = http.createServer((req, res) => {
        hits.push(`${req.method} ${req.url}`);
        const send = (code, type, body) => { res.writeHead(code, { 'Content-Type': type }); res.end(req.method === 'HEAD' ? undefined : body); };
        if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'text/plain', 'read only');
        const p = req.url.split('?')[0];
        if (p === '/') return send(200, 'text/html', PAGE('Home', '<p>Welcome to the fixture site. This paragraph gives the page body copy of a realistic length so it does not look empty or thin.</p><script>nonexistentFunction();</script><div style="width:900px;height:20px;background:#ddd">a block wider than a phone</div>'));
        if (p === '/about/') return send(200, 'text/html', PAGE('About', '<p>About the fixture. A plain page that should load without any trouble at all, with enough words to be real content.</p>'));
        if (p === '/robots.txt') return send(200, 'text/plain', 'User-agent: *\nDisallow:\n');
        return send(404, 'text/html', PAGE('Not found', '<p>Nothing here.</p>'));
    });
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${srv.address().port}/`;
    const root = path.join(tmp, 'wp'); trees.threePlugins(root);
    const t0 = Date.now();
    const out = await new Promise(resolve => { const c = spawn(process.execPath, [path.join(__dirname, 'guard.js'), 'auto', '--url', url, '--root', root, '--env', 'local', '--no-sandbox'], { env }); let o = ''; c.stdout.on('data', d => { o += d; }); c.stderr.on('data', d => { o += d; }); c.on('close', code => resolve({ code, o })); });
    srv.close();
    console.log(`      (took ${Math.round((Date.now() - t0) / 1000)} s)`);
    const runsDir = path.join(tmp, 'runs'), id = fs.readdirSync(runsDir).sort().pop(), dir = path.join(runsDir, id);
    const a = JSON.parse(fs.readFileSync(path.join(dir, 'auto.json'), 'utf8')), d = JSON.parse(fs.readFileSync(path.join(dir, 'findings.json'), 'utf8'));
    ok([0, 1].includes(out.code), `the real pipeline finished (exit ${out.code}); the frontend agent ran in visual mode`);
    ok(d.stages.every(s => s.state === 'completed') && d.findings.some(f => f.source_agent === 'user-frontend'), `Agent 1 (real browser) and Agent 2 completed; ${d.findings.filter(f => f.source_agent === 'user-frontend').length} frontend finding(s)`);
    const types = a.issues.map(i => i.oracle.type);
    if (process.env.PG_DEBUG) console.log(JSON.stringify(d.findings.filter(f => f.source_agent === 'user-frontend').map(f => ({ t: f.title, c: f.category, a: f.actual_behavior, cl: f.original && f.original.classification, e: f.evidence.slice(0, 2) })), null, 1), JSON.stringify(a.skipped, null, 1));
    ok(a.issues.length >= 2 && types.includes('console-error') && a.issues.some(i => i.oracle.type === 'no-hscroll' && i.oracle.value === '390') && a.issues.find(i => i.oracle.type === 'console-error').oracle.value === 'nonexistentFunction is not defined', `auto-issues were derived from what the real browser saw (a console error, and the overflow at the mobile width 390): ${a.issues.map(i => `${i.oracle.type}${i.oracle.value ? ' ' + String(i.oracle.value).slice(0, 40) : ''}`).join(' | ')}`);
    ok(a.issues.every(i => /^\[auto\] /.test(i.title)) && a.mode === 'static-only' && /--no-sandbox/.test(a.mode_reason) && a.issues.every(i => i.reproduced_in_sandbox === null), 'marked [auto]; --no-sandbox: static-only, nothing claimed as reproduced');
    ok(!hits.some(h => /^(POST|PUT|DELETE|PATCH)/.test(h)) && hits.length > 0, `only GET/HEAD requests reached the site (${hits.length})`);
    ok(fs.existsSync(path.join(dir, 'report.html')) && fs.existsSync(path.join(dir, 'report.pdf')), 'report.html and report.pdf were written');
    ok(a.integrity.same === true, 'the original tree was not changed');
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(failures ? `\n${failures} FAILED` : '\nAll checks passed');
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
