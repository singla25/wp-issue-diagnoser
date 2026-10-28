#!/usr/bin/env node
// `guard:auto` on REAL containers (the real sandbox, the real Playwright probe, the real bisection), with an injected Agent 1 whose failures match a
// fixture site (trees.autoSite). SKIPS (exit 0, labelled) when Docker or the pinned images are not usable. Takes a few minutes.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const sandbox = require('../issue/sandbox');

const pf = sandbox.preflight({});
if (!pf.ok) { console.log(`SKIPPED (not run): needs a usable Docker daemon and the pinned images.\n  reason: ${pf.reason}\n  Written but NOT executed in this environment: nothing here is claimed as verified.`); process.exit(0); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-adk-'));
process.env.PLUGIN_GUARD_RUNS = path.join(tmp, 'runs'); process.env.PLUGIN_GUARD_ISSUES = path.join(tmp, 'issues'); process.env.PLUGIN_GUARD_SANDBOXES = path.join(tmp, 'sandboxes'); process.env.QA_REPORTS_DIR = path.join(tmp, 'fe');
const trees = require('./fixtures/issue/trees');
const frontend = require('../agents/frontend');
const auto = require('../lib/auto');
const runs = require('../lib/runs');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
function hashTree(dir) { const h = crypto.createHash('sha256'); (function walk(d) { for (const n of fs.readdirSync(d).sort()) { const f = path.join(d, n), st = fs.lstatSync(f); h.update(`${path.relative(dir, f)}|${st.isSymbolicLink() ? 'l' : st.isDirectory() ? 'd' : 'f'}|${st.mode}|`); if (st.isDirectory()) walk(f); else if (st.isFile()) h.update(fs.readFileSync(f)); } })(dir); return h.digest('hex'); }
const labelled = () => { const l = sandbox.labelled({ dockerBin: 'docker', runner: require('child_process').spawnSync, env: process.env }); return l.containers.length + l.volumes.length + l.networks.length; };
let n = 0;
const ff = o => { n++; return { id: `FE-${n}`, fingerprint: `fp-${n}`, title: o.title, category: o.category, severity: o.severity || 'P2', classification: o.classification || 'POSSIBLE ISSUE', status: 'Fail', actual: o.actual, expected: null, occurrences: o.pages.map(p => ({ url: `http://localhost:8080${p}`, viewport: 'laptop 1280x800', actual: o.actual, where: 'x', screenshot: null })), recommendation: 'r', fix: { where: 'w' } }; };
const findings = frontend.convert({ summary: { finishedAt: '2026-10-28T10:00:00Z' }, findings: [
    ff({ title: 'Page failed to load', category: 'functional', classification: 'CONFIRMED WEBSITE ISSUE', severity: 'P0', actual: 'HTTP 500 http://localhost:8080/', pages: ['/'] }),
    ff({ title: 'Console error', category: 'console', actual: 'pgd-boom', pages: ['/?p=1'] }),
    ff({ title: 'Uncaught JavaScript error', category: 'console', actual: 'mubug', pages: ['/?p=1'] })
] }, 'run', { take: () => null }, 'http://localhost:8080/');
const agent1 = async (cfg, run) => ({ agent: 'user-frontend', run_id: run.id, url: cfg.url, mode: 'visual', environment: cfg.environment, started_at: new Date().toISOString(), finished_at: new Date().toISOString(), tests_ran: true, checks: [{ id: 'frontend-run', label: 'Frontend run (visual)', status: 'PASSED', reason: 'ok' }], findings: findings.map(f => ({ ...f, run_id: run.id })) });

(async () => {
    const root = path.join(tmp, 'wp'); const c = trees.autoSite(root); fs.writeFileSync(path.join(root, 'plugin-guard.config.json'), JSON.stringify(c.config));
    const before = hashTree(root);
    const logs = []; const old = console.log; console.log = (...a) => logs.push(a.join(' '));
    let code; try { code = await auto.auto({ url: 'http://localhost:8080/', root, env: 'local', 'sandbox-max-issues': '3' }, { agent1 }); } finally { console.log = old; }
    const id = runs.list().pop(), A = runs.read(id, 'auto.json'), d = runs.read(id, 'findings.json');
    ok([0, 1].includes(code), `the pipeline finished (exit ${code})`);
    ok(A.mode === 'sandbox' && A.preflight.started_docker === false, 'preflight: the sandbox is available (Docker was already running, nothing was started)');
    const by = v => A.issues.find(i => String(i.oracle.value || i.oracle.type).includes(v));
    const x = by('http-5xx'), y = by('pgd-boom'), z = by('mubug');
    ok(x && /\[pg-a, pg-b, pg-c\]/.test(x.bisect) && x.verdict === 'Reproduced and cause found', `3-plugin interaction: ${x && x.bisect}`);
    ok(y && /\[pg-d\]/.test(y.bisect) && y.verdict === 'Reproduced and cause found', `single plugin: ${y && y.bisect}`);
    ok(z && z.not_plugin_conflict === true && z.reproduced_in_sandbox === 'yes' && !/\[pg-/.test(z.bisect), `a must-use plugin bug that is present with every plugin off: NOT A PLUGIN CONFLICT (${z && z.bisect})`);
    ok(A.shared.page_loads < 60 && A.shared.cache_hits > 0, `shared cache on real page loads: ${A.shared.page_loads} loads, ${A.shared.cache_hits} reused`);
    ok(A.sandbox_steps.filter(s => s.id === 'sandbox-start').length === 1 && A.sandbox_steps.some(s => s.id === 'sandbox-teardown' && s.status === 'PASSED') && labelled() === 0, 'ONE sandbox started and torn down; no container, volume or network is left');
    ok(A.integrity.same === true && hashTree(root) === before, 'the original tree is unchanged (fingerprint and hash)');
    ok(d.auto && fs.existsSync(path.join(runs.dirOf(id), 'report.html')) && fs.existsSync(path.join(runs.dirOf(id), 'report.pdf')), 'findings.json carries the auto block; report.html and report.pdf exist');
    ok(!A.issues.some(i => /Fixed and verified/.test(i.verdict)), 'nothing is FIXED_VERIFIED');
    if (failures) for (const i of A.issues) { const sj = JSON.parse(fs.readFileSync(path.join(process.env.PLUGIN_GUARD_ISSUES, i.id, 'work', 'sandbox.json'), 'utf8')); console.log(`      ${i.oracle.type} ${i.oracle.value || ''} -> reproduced ${i.reproduced_in_sandbox}; baseline ${JSON.stringify(sj.baseline).slice(0, 500)}; steps ${sj.steps.filter(s => /oracle|bisect/.test(s.id)).map(s => s.reason).join(' | ').slice(0, 300)}`); }
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(failures ? `\n${failures} FAILED` : '\nAll checks passed');
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); try { sandbox.sweep({}); } catch { /* ignore */ } process.exit(1); });
