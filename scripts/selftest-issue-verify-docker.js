#!/usr/bin/env node
// Self-test of issue mode, step 9 prelude: patches and shims VERIFIED IN THE SANDBOX, acceptance case 2 (hook collision) and the determinism of the
// bisection, all on REAL containers. SKIPS (exit 0, labelled) when Docker or the pinned images are missing. Takes several minutes.
//   A. a patch of custom code and a shim, each applied to the sandbox copy; "verified in sandbox" only because the symptom is gone on the same page + size
//      a shim that changes nothing is "tested, did not help"; without --sandbox everything stays "not verified in sandbox"
//   B. hook collision: REPRODUCIBLE; the right ordering candidate is verified, the opposite one is "did not help"; a retest with the shim in place is FIXED_VERIFIED
//   C. the same input twice: bisect.json and bisect.log identical (issue id, timestamps and the root folder name are the only normalisation)
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const sandbox = require('../issue/sandbox');

const pf = sandbox.preflight({});
if (!pf.ok) { console.log(`SKIPPED (not run): needs a usable Docker daemon and the pinned images.\n  reason: ${pf.reason}\n  Written but NOT executed in this environment: nothing here is claimed as verified.`); process.exit(0); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-vf-'));
process.env.PLUGIN_GUARD_ISSUES = path.join(tmp, 'issues'); process.env.PLUGIN_GUARD_SANDBOXES = path.join(tmp, 'sandboxes');
const trees = require('./fixtures/issue/trees');
let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const group = t => console.log(`\n== ${t}`);
function hashTree(dir) { const h = crypto.createHash('sha256'); (function walk(d) { for (const n of fs.readdirSync(d).sort()) { const f = path.join(d, n), st = fs.lstatSync(f); h.update(`${path.relative(dir, f)}|${st.isSymbolicLink() ? 'l' : st.isDirectory() ? 'd' : 'f'}|${st.mode}|`); if (st.isDirectory()) walk(f); else if (st.isFile()) h.update(fs.readFileSync(f)); } })(dir); return h.digest('hex'); }
const guard = (...a) => spawnSync(process.execPath, [path.join(__dirname, 'guard.js'), ...a], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' }, timeout: 1800000 });
const labelled = () => { const l = sandbox.labelled({ dockerBin: 'docker', runner: spawnSync, env: process.env }); return l.containers.length + l.volumes.length + l.networks.length; };
const R = (dir, f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
let n = 0;
function investigate(builder, { sandboxFlag = true, extra = [], label = '' } = {}) {
    const root = path.join(tmp, `wp${++n}${label}`), c = builder(root), before = hashTree(root), cfg = path.join(tmp, `cfg${n}.json`);
    fs.writeFileSync(cfg, JSON.stringify(c.config));
    const nw = guard('issue', 'new', '--title', 'Fixture', '--description', c.description, '--symptom', c.symptom, ...(c.oracle ? ['--oracle', c.oracle] : []), '--pages', c.pages || '/', '--root', root, '--env', 'local', '--url', 'http://localhost/', '--no-prompt');
    const id = /(iss-\d{8}-\d{6}-[0-9a-f]{6})/.exec(nw.stdout)[1], dir = path.join(process.env.PLUGIN_GUARD_ISSUES, id);
    const inv = guard('issue', 'investigate', id, '--root', root, '--config', cfg, '--no-probe', ...(sandboxFlag ? ['--sandbox'] : []), ...extra);
    return { id, dir, root, cfg, status: inv.status, out: inv.stdout, f: R(dir, 'result/findings.json'), hash: before };
}
const opts = (f, type) => f.resolution.flatMap(r => r.options).filter(o => o.type === type);

(async () => {
    // ============================================================ A. patch and shim verified in the sandbox
    group('A. a patch of custom code and a shim, applied and tested in the sandbox');
    const A = investigate(trees.badgeWrongPriority);
    ok(A.status === 0, `investigate --sandbox completes (exit ${A.status})`);
    ok(R(A.dir, 'work/sandbox.json').reproduced_in_sandbox === 'yes', 'the symptom (PG-BADGE missing) is reproduced in the sandbox first');
    const patch = opts(A.f, 'patch')[0], shim = opts(A.f, 'shim')[0];
    ok(patch && patch.verified_in_sandbox === true && /VERIFIED|applied in the sandbox, php -l passed/.test(patch.sandbox_verification.reason), `patch: VERIFIED IN SANDBOX (${patch && patch.sandbox_verification.reason.slice(0, 110)})`);
    ok(shim && shim.verified_in_sandbox === true, `shim: VERIFIED IN SANDBOX (${shim && shim.sandbox_verification.reason.slice(0, 90)})`);
    ok(/VERIFIED IN SANDBOX/.test(fs.readFileSync(path.join(A.dir, 'result/ISSUE-REPORT.md'), 'utf8')) && /Allowed files/.test(fs.readFileSync(path.join(A.dir, 'result/tasks.md'), 'utf8')), 'ISSUE-REPORT.md says so, and the verified patch is a task in tasks.md');
    ok(labelled() === 0, 'no container, volume or network is left after the verification sandbox');
    // a shim that changes nothing must NOT be marked verified
    const vf = require('../issue/verify-fixes');
    const noop = { type: 'shim', who: 'you-can-do-this', title: 'does nothing', file: 'pg-noop.php', php: '<?php\n// a shim that changes nothing\n', verified: true, verification: [], not_verified: [] };
    const bad = { type: 'patch', who: 'send-to-claude-code', title: 'wrong priority', file: 'wp-content/plugins/pg-switch/pg-switch.php', diff: patch.diff.replace('20 );', '15 );'), verified: true, verification: [], not_verified: [] };
    const plans = [{ hypothesis: 'x', options: [noop, bad] }];
    const r2 = await vf.run(A.id, { root: A.root, plans, options: { sandbox: true } });
    ok(noop.verified_in_sandbox === false && bad.verified_in_sandbox === false && bad.who === 'needs-a-human', `a no-op shim and a patch with the wrong priority are "tested, did not help" (${noop.verified_in_sandbox}, ${bad.verified_in_sandbox}); the bad patch stops being a task`);
    ok(noop.not_verified.some(x => /NOT verified in sandbox/.test(x)), 'and they stay labelled NOT verified');
    // without --sandbox, everything stays unverified
    const U = investigate(trees.badgeWrongPriority, { sandboxFlag: false, label: 'u' });
    ok(opts(U.f, 'patch').concat(opts(U.f, 'shim')).every(o => o.verified_in_sandbox === null && o.not_verified.some(x => /NOT verified in sandbox/.test(x))), 'without --sandbox, patches and shims are labelled "NOT verified in sandbox" (static checks only)');
    ok(labelled() === 0, 'no container left');

    // ============================================================ B. hook collision (acceptance 2)
    group('B. acceptance 2: two plugins on the_content at the same priority, the second one empties the post');
    const B = investigate(trees.hookCollision);
    const h = B.f.hypotheses.find(x => x.title.startsWith('Same hook, same priority'));
    ok(h && h.status === 'REPRODUCIBLE', `the pair is REPRODUCIBLE (${h && h.status}: ${h && h.components.join(' + ')})`);
    ok(B.f.bisect && B.f.bisect.causes.length === 1 && B.f.bisect.causes[0].plugins.join() === 'pg-a-token,pg-b-clean' && B.f.verdict.label === 'Reproduced and cause found', `the bisect names exactly the pair; verdict "${B.f.verdict.label}"`);
    const cands = opts(B.f, 'shim');
    const right = cands.find(c => c.verified_in_sandbox === true), wrong = cands.find(c => c.verified_in_sandbox === false);
    ok(cands.length === 2 && right && wrong && /^pg_token_add after pg_clean_strip$/.test(right.candidate) && /^pg_clean_strip after pg_token_add$/.test(wrong.candidate), `two ordering candidates: "${right && right.candidate}" is VERIFIED IN SANDBOX, "${wrong && wrong.candidate}" did not help`);
    // the shim in place on a COPY, then retest in a sandbox
    const fixedCopy = path.join(tmp, 'collision-fixed'); trees.hookCollision(fixedCopy);
    fs.mkdirSync(path.join(fixedCopy, 'wp-content/mu-plugins'), { recursive: true });
    fs.copyFileSync(path.join(B.dir, 'result/patches/shims', right.file), path.join(fixedCopy, 'wp-content/mu-plugins', right.file));
    const withWrong = path.join(tmp, 'collision-wrong'); trees.hookCollision(withWrong);
    fs.mkdirSync(path.join(withWrong, 'wp-content/mu-plugins'), { recursive: true });
    fs.copyFileSync(path.join(B.dir, 'result/patches/shims', wrong.file), path.join(withWrong, 'wp-content/mu-plugins', wrong.file));
    const rtW = guard('issue', 'retest', B.id, '--root', withWrong, '--config', B.cfg, '--sandbox'), eW = R(B.dir, 'result/retests.json').pop();
    ok(eW.verdict === 'Still failing' && !eW.fixed_verified, `retest with the WRONG ordering shim in place: ${eW.verdict}`);
    const rtF = guard('issue', 'retest', B.id, '--root', fixedCopy, '--config', B.cfg, '--sandbox'), eF = R(B.dir, 'result/retests.json').pop();
    ok(eF.verdict === 'Fixed' && eF.fixed_verified && eF.conditions.every(c => c.status === 'PASSED'), `retest with the right shim in place: ${eF.verdict}, FIXED_VERIFIED (${eF.conditions.map(c => c.id).join(', ')})`);
    const fB = R(B.dir, 'result/findings.json');
    ok(fB.hypotheses.find(x => x.id === h.id).status === 'FIXED_VERIFIED' && fB.verdict.label === 'Fixed and verified', 'findings.json: FIXED_VERIFIED, "Fixed and verified"');
    ok(labelled() === 0, 'no container left');

    // ============================================================ C. determinism of the bisection
    group('C. the same input twice: bisect.json and bisect.log, exactly');
    const C1 = investigate(trees.threePlugins, { label: 'c1' }), C2 = investigate(trees.threePlugins, { label: 'c2' });
    const norm = (t, X) => t.split(X.id).join('ISSUE').split(X.root).join('ROOT').split(path.basename(X.root)).join('ROOT').replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, 'TS').replace(/pgsb[0-9a-f]{8}/g, 'PROJECT').replace(/127\.0\.0\.1:\d+/g, '127.0.0.1:PORT').replace(/iss-\d{8}-\d{6}-[0-9a-f]{6}/g, 'ISSUE');
    const j1 = norm(fs.readFileSync(path.join(C1.dir, 'work/bisect.json'), 'utf8'), C1), j2 = norm(fs.readFileSync(path.join(C2.dir, 'work/bisect.json'), 'utf8'), C2);
    const l1 = norm(fs.readFileSync(path.join(C1.dir, 'work/bisect.log'), 'utf8'), C1), l2 = norm(fs.readFileSync(path.join(C2.dir, 'work/bisect.log'), 'utf8'), C2);
    ok(j1 === j2 && j1.length > 100, `bisect.json is identical (${j1.length} bytes)`);
    if (l1 !== l2) { const a = l1.split('\n'), b = l2.split('\n'); for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) { console.log(`      first difference, line ${i + 1}:\n        A: ${a[i]}\n        B: ${b[i]}`); break; } }
    ok(l1 === l2 && l1.length > 100, `bisect.log is identical (${l1.split('\n').length} lines)`);
    ok(norm(JSON.stringify({ ...C1.f, generated_at: 0 }), C1) === norm(JSON.stringify({ ...C2.f, generated_at: 0 }), C2), 'findings.json (with the bisect, the validation and the plans) is identical too');
    ok(labelled() === 0, 'no container left');
    ok(true, `trees: hashes before/after are checked below`);
    for (const x of [A, U, B, C1, C2]) ok(hashTree(x.root) === x.hash, `original tree ${path.basename(x.root)} unchanged (hash before == after)`);
    ok(hashTree(fixedCopy) !== undefined, 'housekeeping');
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(failures ? `\n${failures} FAILED` : '\nAll checks passed');
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); try { sandbox.sweep({}); } catch { /* ignore */ } process.exit(1); });
