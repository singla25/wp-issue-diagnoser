#!/usr/bin/env node
// Self-test of `guard:auto`, part 2: ONE sandbox for several issues, against a fake docker and a stubbed page observer (no Playwright, no daemon).
// The stub plays a site whose behaviour depends on which plugins are active, so the bisection results are known in advance:
//   /      answers HTTP 500 only while pg-a, pg-b and pg-c are ALL active          -> issue A (http-5xx): cause {pg-a, pg-b, pg-c}
//   /shop/ has a console error "boom" while pg-b is active                           -> issue B (console-error): cause {pg-b}
//   /about/ fails to load /x.js while pg-c is active                                 -> issue C (request-failed): cause {pg-c}
//   D (no-hscroll at 390) never happens                                              -> not reproduced, nothing to bisect
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-asb-'));
process.env.PLUGIN_GUARD_ISSUES = path.join(tmp, 'issues'); process.env.PLUGIN_GUARD_SANDBOXES = path.join(tmp, 'sandboxes');
const trees = require('./fixtures/issue/trees');
const store = require('../lib/issue-store');
const many = require('../issue/sandbox-many');
const sandbox = require('../issue/sandbox');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const group = t => console.log(`\n== ${t}`);
function hashTree(dir) { const h = crypto.createHash('sha256'); (function walk(d) { for (const n of fs.readdirSync(d).sort()) { const f = path.join(d, n), st = fs.lstatSync(f); h.update(`${path.relative(dir, f)}|${st.isSymbolicLink() ? 'l' : st.isDirectory() ? 'd' : 'f'}|${st.mode}|`); if (st.isDirectory()) walk(f); else if (st.isFile()) h.update(fs.readFileSync(f)); } })(dir); return h.digest('hex'); }
const FD = path.join(tmp, 'fake'); fs.mkdirSync(FD); fs.copyFileSync(path.join(__dirname, 'fixtures', 'issue', 'fake-docker.js'), path.join(FD, 'docker')); fs.chmodSync(path.join(FD, 'docker'), 0o755);
const wpRules = [{ match: 'plugin list', out: 'pg-a\npg-b\npg-c\n' }, { match: 'theme list', out: 'acme\ntwentytwentysix\n' }, { match: 'option get stylesheet', out: 'acme\n' }];
const logLines = () => (fs.existsSync(path.join(FD, 'fake.log')) ? fs.readFileSync(path.join(FD, 'fake.log'), 'utf8').split('\n').filter(Boolean).map(JSON.parse) : []);
const activeNow = () => { const act = new Set(['pg-a', 'pg-b', 'pg-c']); let started = false; for (const l of logLines()) { const i = l.args.indexOf('plugin'); if (i < 0 || l.args[i - 1] !== 'wp') continue; const verb = l.args[i + 1]; if (verb !== 'activate' && verb !== 'deactivate') continue; const nm = l.args.slice(i + 2).filter(a => !a.startsWith('--')); for (const n of nm) verb === 'activate' ? act.add(n) : act.delete(n); started = true; } return act; };
let observes = 0;
const observe = async ({ base, pages, vp }) => {
    observes++;
    const a = activeNow(), out = [];
    for (const v of vp) for (const u of pages) {
        const p = new URL(u).pathname;
        out.push({ url: u, viewport: { name: v.name, width: v.width }, loaded: true, status: p === '/' && a.has('pg-a') && a.has('pg-b') && a.has('pg-c') ? 500 : 200, console_errors: p === '/shop/' && a.has('pg-b') ? [{ text: 'boom happened' }] : [], page_errors: [], error_responses: p === '/about/' && a.has('pg-c') ? [{ url: `${base.origin}/x.js`, status: 404 }] : [], failed_requests: [], scroll: { doc_width: v.width, viewport_width: v.width }, text: 'ok' });
    }
    return { ok: true, pagesFull: out, planned: out.length, protection: null, login: null };
};
const opts = (extra = {}) => ({ dockerBin: path.join(FD, 'docker'), sandboxesRoot: path.join(tmp, 'sandboxes'), env: { PATH: process.env.PATH, HOME: process.env.HOME }, ...extra });
const fresh = () => { for (const f of ['fake.log', 'fake.state.json']) fs.rmSync(path.join(FD, f), { force: true }); fs.writeFileSync(path.join(FD, 'fake.json'), JSON.stringify({ wp: wpRules })); observes = 0; };
const mk = (root, title, oracle, pages) => store.create({ title, description: '', symptom: 'other', environment: 'local', url: 'http://localhost/', root, pages, oracle, auto: { fingerprint: title.slice(0, 8), source: 'test', occurrences: 1, severity: 'P2', frontend_ids: [] } });

(async () => {
    const root = path.join(tmp, 'wp'); trees.threePlugins(root);
    const before = hashTree(root);
    const A = mk(root, 'A 5xx', { type: 'http-5xx' }, ['/']), B = mk(root, 'B console', { type: 'console-error', value: 'boom' }, ['/shop/']), C = mk(root, 'C asset', { type: 'request-failed', value: '/x.js' }, ['/about/', '/']), D = mk(root, 'D overflow', { type: 'no-hscroll', value: '390' }, ['/shop/']);
    group('one sandbox, four issues');
    fresh();
    const r = await many.runMany([A.id, B.id, C.id, D.id], { root, options: { viewports: 'laptop' }, components: [], sandboxOptions: opts(), observe });
    const cause = id => r.per[id].bisect && r.per[id].bisect.causes.map(c => c.plugins.join('+')).join(',');
    ok(r.unavailable === null && r.sandbox && r.sandbox.url === 'http://127.0.0.1:38080', 'the sandbox starts once (127.0.0.1)');
    ok(logLines().filter(l => l.args.includes('up')).length === 1, 'and docker compose up was called exactly once for the four issues');
    ok(cause(A.id) === 'pg-a+pg-b+pg-c' && cause(B.id) === 'pg-b' && cause(C.id) === 'pg-c', `each issue is bisected to its own cause: A {${cause(A.id)}}, B {${cause(B.id)}}, C {${cause(C.id)}}`);
    if (r.per[D.id].reproduced_in_sandbox !== 'no') console.log('      D:', JSON.stringify(r.per[D.id]).slice(0, 400));
    ok(r.per[D.id].reproduced_in_sandbox === 'no' && r.per[D.id].bisect === null, 'issue D (never happens) is "not reproduced" and is not bisected');
    ok(['yes', 'yes', 'yes'].join() === [A.id, B.id, C.id].map(id => r.per[id].reproduced_in_sandbox).join(), 'A, B and C are reproduced in the sandbox');
    const own = [A.id, B.id, C.id].reduce((n, id) => n + r.per[id].bisect.loads, 0);
    ok(r.shared.page_loads === observes && r.shared.page_loads === r.shared.sets, `every plugin set was loaded exactly once (${r.shared.page_loads} page loads for ${r.shared.sets} distinct sets)`);
    ok(r.shared.page_loads < own && r.shared.cache_hits > 0, `the cache is shared: the three bisections would need ${own} loads on their own, the shared run did ${r.shared.page_loads} (${r.shared.cache_hits} answers came from the cache)`);
    ok(r.steps.some(s => s.id === 'sandbox-teardown' && s.status === 'PASSED') && !fs.existsSync(path.join(tmp, 'sandboxes', fs.existsSync(path.join(tmp, 'sandboxes')) ? '' : 'x')) || fs.readdirSync(path.join(tmp, 'sandboxes')).length === 0, 'the sandbox was torn down (folder gone)');
    const st = JSON.parse(fs.readFileSync(path.join(FD, 'fake.state.json'), 'utf8'));
    ok(st.containers.length + st.volumes.length + st.networks.length === 0, 'no container, volume or network is left');
    for (const i of [A, B, C, D]) {
        const sj = JSON.parse(fs.readFileSync(path.join(store.dirOf(i.id), 'work', 'sandbox.json'), 'utf8'));
        ok(sj.steps.some(s => s.id === 'sandbox-teardown') && sj.baseline && sj.baseline.active_plugins.join() === 'pg-a,pg-b,pg-c' && sj.sandbox.recommendation, `${i.title}: work/sandbox.json holds the shared steps (with teardown), the baseline and the active plugin set`);
    }
    ok(fs.existsSync(path.join(store.dirOf(A.id), 'work', 'bisect.log')) && fs.existsSync(path.join(store.dirOf(C.id), 'work', 'bisect.json')) && !fs.existsSync(path.join(store.dirOf(D.id), 'work', 'bisect.json')), 'bisect.log / bisect.json exist per bisected issue, and not for the one that was not reproduced');
    ok(hashTree(root) === before, 'the original tree is unchanged (hash before == after)');
    const dump = fs.readFileSync(path.join(store.dirOf(A.id), 'work', 'bisect.json'), 'utf8');

    group('the same input twice');
    fresh(); const r2 = await many.runMany([A.id, B.id, C.id, D.id], { root, options: { viewports: 'laptop' }, sandboxOptions: opts(), observe });
    const j = id => fs.readFileSync(path.join(store.dirOf(id), 'work', 'bisect.json'), 'utf8').replace(/pgsb[0-9a-f]{8}/g, 'P');
    { const x = dump.replace(/pgsb[0-9a-f]{8}/g, 'P').split('\n'), y = j(A.id).split('\n'); for (let i = 0; i < Math.max(x.length, y.length); i++) if (x[i] !== y[i]) { console.log(`      first difference line ${i + 1}: ${x[i]}  |  ${y[i]}`); break; } console.log('      loads', r.shared.page_loads, r2.shared.page_loads); }
    ok(r2.shared.page_loads === r.shared.page_loads && j(A.id) === dump.replace(/pgsb[0-9a-f]{8}/g, 'P'), 'same number of page loads and an identical bisect.json for issue A');

    group('when it cannot or must not run');
    fresh(); fs.writeFileSync(path.join(FD, 'fake.json'), JSON.stringify({ info: { fail: true }, wp: wpRules }));
    const r3 = await many.runMany([A.id, B.id], { root, sandboxOptions: opts(), observe });
    ok(r3.unavailable && /Static-only mode: not reproduced, sandbox unavailable/.test(r3.unavailable) && Object.values(r3.per).every(p => p.reproduced_in_sandbox === null && p.bisect === null) && observes === 0, 'Docker unusable: static-only for every issue, nothing loaded');
    fresh(); fs.writeFileSync(path.join(FD, 'fake.json'), JSON.stringify({ port: '0.0.0.0:38081', wp: wpRules }));
    const r4 = await many.runMany([A.id], { root, sandboxOptions: opts(), observe });
    const st4 = JSON.parse(fs.readFileSync(path.join(FD, 'fake.state.json'), 'utf8'));
    ok(r4.steps.some(s => s.id === 'sandbox' && s.status === 'BLOCKED' && /127\.0\.0\.1/.test(s.reason)) && st4.containers.length === 0 && fs.readdirSync(path.join(tmp, 'sandboxes')).length === 0, 'a safeguard refusal (port not on 127.0.0.1) blocks the run and tears everything down');
    fresh(); const boom = async () => { throw new Error('observer crashed'); };
    const r5 = await many.runMany([A.id], { root, sandboxOptions: opts(), observe: boom });
    const st5 = JSON.parse(fs.readFileSync(path.join(FD, 'fake.state.json'), 'utf8'));
    ok(r5.per[A.id].steps.some(s => s.status === 'FAILED' && /observer crashed/.test(s.reason)) && st5.containers.length === 0 && r5.steps.some(s => s.id === 'sandbox-teardown'), 'an error in the middle of testing is recorded as FAILED and the teardown still runs');
    fresh(); const r6 = await many.runMany([], { root, sandboxOptions: opts(), observe });
    ok(r6.unavailable && observes === 0 && logLines().length === 0, 'no issue: nothing is started');
    ok(hashTree(root) === before, 'the original tree is still unchanged after every scenario (hash)');

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(failures ? `\n${failures} FAILED` : '\nAll checks passed');
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
