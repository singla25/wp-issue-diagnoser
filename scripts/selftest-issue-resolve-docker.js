#!/usr/bin/env node
// Self-test of issue mode, step 8, part 2: acceptance case 4 (a three-plugin interaction found only by bisection) and `issue retest` on REAL
// containers. SKIPS (exit 0, clearly labelled) when Docker or the pinned images are not available. Takes a few minutes.
//   investigate --sandbox -> the symptom is reproduced, the bisect names the minimal set {pg-a, pg-b, pg-c}, validation says REPRODUCIBLE
//   retest on the SAME broken tree  -> Still failing (never Fixed)
//   retest on a tree WITHOUT pg-c   -> Could not test (a run with fewer plugins proves nothing)
//   retest on the fixed tree        -> Fixed, and only then FIXED_VERIFIED
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const sandbox = require('../issue/sandbox');

const pf = sandbox.preflight({});
if (!pf.ok) { console.log(`SKIPPED (not run): the real-container retest tests need a usable Docker daemon and the pinned images.\n  reason: ${pf.reason}\n  Written but NOT executed in this environment: nothing here is claimed as verified.`); process.exit(0); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-rd-'));
process.env.PLUGIN_GUARD_ISSUES = path.join(tmp, 'issues'); process.env.PLUGIN_GUARD_SANDBOXES = path.join(tmp, 'sandboxes');
const trees = require('./fixtures/issue/trees');
let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
function hashTree(dir) { const h = crypto.createHash('sha256'); (function walk(d) { for (const n of fs.readdirSync(d).sort()) { const f = path.join(d, n), st = fs.lstatSync(f); h.update(`${path.relative(dir, f)}|${st.isSymbolicLink() ? 'l' : st.isDirectory() ? 'd' : 'f'}|${st.mode}|`); if (st.isDirectory()) walk(f); else if (st.isFile()) h.update(fs.readFileSync(f)); } })(dir); return h.digest('hex'); }
const guard = (...a) => spawnSync(process.execPath, [path.join(__dirname, 'guard.js'), ...a], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' }, timeout: 900000 });
const labelled = () => { const l = sandbox.labelled({ dockerBin: 'docker', runner: spawnSync, env: process.env }); return l.containers.length + l.volumes.length + l.networks.length; };

(async () => {
    const broken = path.join(tmp, 'broken'), fixed = path.join(tmp, 'fixed'), lacking = path.join(tmp, 'lacking');
    const c = trees.threePlugins(broken); trees.threePlugins(fixed, { fixed: true }); trees.threePlugins(lacking); fs.rmSync(path.join(lacking, 'wp-content/plugins/pg-c'), { recursive: true });
    const cfg = path.join(tmp, 'cfg.json'); fs.writeFileSync(cfg, JSON.stringify(c.config));
    const H = { broken: hashTree(broken), fixed: hashTree(fixed), lacking: hashTree(lacking) };
    const nw = guard('issue', 'new', '--title', 'Home page critical error', '--description', c.description, '--symptom', 'white-screen', '--oracle', 'http-5xx', '--pages', '/', '--root', broken, '--env', 'local', '--url', 'http://localhost/', '--no-prompt');
    const id = /(iss-\d{8}-\d{6}-[0-9a-f]{6})/.exec(nw.stdout)[1], dir = path.join(process.env.PLUGIN_GUARD_ISSUES, id), R = f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const inv = guard('issue', 'investigate', id, '--root', broken, '--config', cfg, '--no-probe', '--sandbox');
    ok(inv.status === 0, `investigate --sandbox completes (exit ${inv.status})`);
    const f = R('result/findings.json'), bis = R('work/bisect.json');
    ok(bis.causes.length === 1 && bis.causes[0].plugins.join() === 'pg-a,pg-b,pg-c' && bis.causes[0].minimal, `the bisection finds the minimal set {pg-a, pg-b, pg-c} (${bis.loads} loads, ${bis.cache_hits} from the cache)`);
    const log = fs.readFileSync(path.join(dir, 'work/bisect.log'), 'utf8').split('\n').filter(l => /^\s*\d+|load|test/i.test(l));
    ok(fs.existsSync(path.join(dir, 'work/bisect.log')) && new Set(bis.executed.map(e => JSON.stringify(e))).size === bis.executed.length, 'work/bisect.log exists and no plugin set was loaded twice');
    ok(f.hypotheses[0].status === 'REPRODUCIBLE' && f.verdict.label === 'Reproduced and cause found', `Phase H recomputed it from bisect.json: ${f.hypotheses[0].status}; verdict "${f.verdict.label}"`);
    ok(f.timeline.some(s => s.id === 'sandbox-notice' && /RAW OUTBOUND/.test(s.reason)), 'the report carries the raw-outbound notice and the "own copies only" recommendation');
    ok(labelled() === 0, 'no container, volume or network is left after the investigation');

    const rt = (root, extra = []) => { const r = guard('issue', 'retest', id, '--root', root, '--config', cfg, '--sandbox', ...extra); return { r, entry: (R('result/retests.json')).pop() }; };
    const a = rt(broken);
    ok(a.entry.verdict === 'Still failing' && !a.entry.fixed_verified, `retest on the SAME broken tree: ${a.entry.verdict} (never Fixed)`);
    const b = rt(lacking);
    ok(b.entry.verdict === 'Could not test' && /did not have these plugins active|pg-c/.test(b.entry.reason) && !b.entry.fixed_verified, `retest on a tree WITHOUT pg-c: ${b.entry.verdict} — ${b.entry.reason.slice(0, 90)}`);
    const d = rt(fixed);
    ok(d.entry.verdict === 'Fixed' && d.entry.fixed_verified && d.r.status === 0, `retest on the fixed tree: ${d.entry.verdict}, fixed_verified ${d.entry.fixed_verified}`);
    const f2 = R('result/findings.json');
    ok(f2.hypotheses[0].status === 'FIXED_VERIFIED' && f2.verdict.label === 'Fixed and verified' && f2.retests.length === 3, `findings.json: ${f2.hypotheses[0].status}, "${f2.verdict.label}", ${f2.retests.length} retests in the history`);
    ok(R('work/sandbox.json').reproduced_in_sandbox === 'yes' && fs.existsSync(path.join(dir, 'work/sandbox.initial.json')), 'the first sandbox evidence is still the current evidence after three retests');
    ok(labelled() === 0, 'no container, volume or network is left after the retests');
    ok(hashTree(broken) === H.broken && hashTree(fixed) === H.fixed && hashTree(lacking) === H.lacking, 'all three original trees are byte-for-byte unchanged (hash before == after)');
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(failures ? `\n${failures} FAILED` : '\nAll checks passed');
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); try { sandbox.sweep({}); } catch { /* ignore */ } process.exit(1); });
