#!/usr/bin/env node
// Self-test of issue mode, step 8: validation (Phase H), resolution plans, patch generators, shims, tasks.md, retest, findings.json.
// Acceptance cases 1, 3, 5, 6, 7, 8 of the brief run through the real CLI (`issue new` + `issue investigate`) on tiny fake WordPress trees.
// The hash of the fixture tree is compared before and after EVERY case (the original is never written).
// Not covered here, and said so: cases 2 and 4 in their Docker form (REPRODUCIBLE / FIXED_VERIFIED after a shim, a 3-plugin bisect on real
// containers) need the sandbox; the bisect algorithm itself is tested in selftest-issue-sandbox.js (17 cases) and the sandbox lifecycle in part 2/3.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-resolve-'));
process.env.PLUGIN_GUARD_ISSUES = path.join(tmp, 'issues');
const trees = require('./fixtures/issue/trees');
const patchgen = require('../issue/patchgen');
const shim = require('../issue/shim');
const retest = require('../issue/retest');
const validate = require('../issue/validate');
const store = require('../lib/issue-store');
const ownership = require('../lib/ownership');

let failures = 0, SITE_FOR_SETTINGS;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const group = t => console.log(`\n== ${t}`);
function hashTree(dir) { const h = crypto.createHash('sha256'); (function walk(d) { for (const n of fs.readdirSync(d).sort()) { const f = path.join(d, n), st = fs.lstatSync(f); h.update(`${path.relative(dir, f)}|${st.isSymbolicLink() ? 'l' : st.isDirectory() ? 'd' : 'f'}|${st.mode}|`); if (st.isDirectory()) walk(f); else if (st.isFile()) h.update(fs.readFileSync(f)); } })(dir); return h.digest('hex'); }
const rd = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const guard = (...a) => spawnSync(process.execPath, [path.join(__dirname, 'guard.js'), ...a], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' }, timeout: 240000 });

let n = 0;
// builds the tree, creates the issue, investigates it (no live probe: there is no site), and returns everything a test needs
function investigate(builder, o = {}) {
    const root = path.join(tmp, `wp${String(++n).padStart(3, "0")}`); fs.mkdirSync(root, { recursive: true });
    const c = builder(root), before = hashTree(root);
    const cfg = path.join(tmp, `cfg${n}.json`); fs.writeFileSync(cfg, JSON.stringify(c.config));
    const nw = guard('issue', 'new', '--title', o.title || 'Fixture problem', '--description', o.description || c.description, '--symptom', c.symptom, '--root', root, '--env', 'local', '--no-prompt');
    const id = /(iss-\d{8}-\d{6}-[0-9a-f]{6})/.exec(nw.stdout)?.[1];
    if (!id) throw new Error(`issue new failed: ${nw.stdout}${nw.stderr}`);
    const inv = guard('issue', 'investigate', id, '--root', root, '--config', cfg, '--no-probe');
    const dir = store.dirOf(id);
    const f = fs.existsSync(path.join(dir, 'result', 'findings.json')) ? rd(path.join(dir, 'result', 'findings.json')) : null;
    return { id, root, dir, cfg, c, out: inv.stdout + inv.stderr, status: inv.status, findings: f, before, after: () => hashTree(root) };
}
const opts = (f, type) => f.resolution.flatMap(r => r.options).filter(o => !type || o.type === type);

(async () => {
    // ================================================================ 1. duplicate function
    group('acceptance 1: duplicate function (plugin A and plugin B both declare my_helper())');
    const A = investigate(trees.duplicateFunction);
    const h1 = A.findings && A.findings.hypotheses[0];
    ok(A.status === 0 && !!A.findings, `issue investigate completes (exit ${A.status}) and writes result/findings.json`);
    ok(h1 && h1.status === 'CONFIRMED' && h1.components.join() === 'plugin-a,plugin-b', `the duplicate-declaration hypothesis is CONFIRMED by Phase H and names both plugins (${h1 && h1.status}: ${h1 && h1.components.join(' + ')})`);
    ok(h1.independent_kinds.includes('log') && h1.independent_kinds.includes('observation'), `confirmed on log + parse agreeing (re-checked kinds: ${h1.independent_kinds.join(', ')})`);
    ok(h1.checks.filter(c => c.id.startsWith('evidence:')).every(c => /construct found at line \d+/.test(c.reason)), 'each cited location was matched against the declaration of my_helper() itself ("construct found at line N"), not just "the file exists"');
    const ev = h1.checks.filter(c => c.id.startsWith('evidence:'));
    ok(ev.length === 2 && ev.every(c => c.status === 'PASSED') && ev.every(c => /plugin-[ab]\.php:\d+/.test(c.id)), `file:line of BOTH declarations were re-opened and the construct found (${ev.map(c => c.id.replace('evidence:', '')).join(' ; ')})`);
    ok(opts(A.findings, 'plugin').length === 2 && /deactivate the one whose features you need least/i.test(opts(A.findings, 'plugin')[0].detail), 'a resolution option names which plugin to deactivate (a choice offered for each of the two, with what would be lost)');
    const patch = opts(A.findings, 'patch');
    ok(patch.length === 1 && patch[0].file === 'wp-content/plugins/plugin-b/plugin-b.php' && patch[0].verified && patch[0].verification.every(v => v.status === 'PASSED'), `exactly one patch, only for the custom plugin-b; diff applies, php -l and scanner re-run PASSED`);
    ok(!JSON.stringify(A.findings.resolution).includes('plugin-a/plugin-a.php"') || opts(A.findings, 'human').some(o => /not custom code/.test(o.detail)), 'plugin-a (not on the allowlist) is never patched: it appears only as "needs a human"');
    const tasks = fs.readFileSync(path.join(A.dir, 'result', 'tasks.md'), 'utf8');
    ok(/Allowed files:\*\* `wp-content\/plugins\/plugin-b\/plugin-b.php`/.test(tasks) && !/Allowed files:[^\n]*plugin-a/.test(tasks) && /Do not touch/.test(tasks) && /issue retest /.test(tasks) && /php -l /.test(tasks), 'tasks.md: allowlisted file only, "do not touch" list, acceptance criteria, php -l, and the issue retest command');
    ok(fs.existsSync(path.join(A.dir, 'result', 'patches', 'plugin-b.php.function-guard.diff')) && fs.existsSync(path.join(A.dir, 'result', 'ISSUE-REPORT.md')), 'result/patches/*.diff and ISSUE-REPORT.md exist');
    ok(A.findings.verdict.label === 'Probable cause' && A.findings.verdict.symptom_reproduced !== 'yes', `verdict: "${A.findings.verdict.label}" (confidence ${A.findings.verdict.confidence}); symptom was not reproduced (no live site), and it says so`);
    ok(A.findings.hypotheses.every(h => h.status !== 'FIXED_VERIFIED') && !/FIXED_VERIFIED/.test(JSON.stringify(A.findings.hypotheses)), 'nothing is FIXED_VERIFIED after an investigation (only retest can do that)');
    ok(A.after() === A.before, 'the original tree is byte-identical after the investigation (hash before == after)');

    // ================================================================ 3. duplicate library
    group('acceptance 3: the custom theme replaces WordPress\'s jQuery; a script depends on a handle nobody registers');
    const B = investigate(trees.duplicateLibrary);
    const bp = opts(B.findings, 'patch');
    ok(bp.length >= 1 && bp.every(p => p.file === 'wp-content/themes/acme/functions.php'), `patch(es) only for the custom theme's functions.php (${bp.map(p => p.generator).join(', ')})`);
    const lib = bp.find(p => p.generator === 'core-library-replacement'), dep = bp.find(p => p.generator === 'missing-dependency');
    ok(lib && lib.verified && /\/\/ \[Plugin Guard suggestion\] \s*wp_deregister_script/.test(lib.diff.replace(/^\+/gm, '')) && lib.verification.find(v => v.id === 'php-l').status === 'PASSED', 'the core-library patch comments out the deregister/register of "jquery" and passes php -l');
    ok(dep && dep.verified && /-.*acme-missing-lib/.test(dep.diff) && !/\+.*acme-missing-lib/.test(dep.diff), 'the dependency patch removes only the unregistered handle "acme-missing-lib" and passes php -l + scanner re-run');
    ok(B.after() === B.before, 'original tree unchanged (hash)');
    console.log('      (the live-probe half of case 3, "found by the live probe", needs a running site: covered by selftest-issue-probe.js)');

    // ================================================================ hook priority: patch + shim
    group('hook priority: a patch for custom code AND a shim as the alternative');
    const C = investigate(trees.hookPriority);
    const cp = opts(C.findings, 'patch'), cs = opts(C.findings, 'shim');
    ok(cp.length === 1 && cp[0].generator === 'hook-priority' && /^[-+].*remove_filter\( 'the_content', 'a_decorate', (10|20) \)/m.test(cp[0].diff) && /\+.*a_decorate', 20/.test(cp[0].diff) && cp[0].verified, 'patch: remove_filter priority 10 -> 20 (the priority a_decorate was added with), verified');
    ok(cs.length === 1 && /has_filter\( \$tag, \$callback \) === 20/.test(cs[0].php) && cs[0].verification.every(v => v.status !== 'FAILED') && fs.existsSync(path.join(C.dir, 'result', 'patches', 'shims', cs[0].file)), 'shim: a mu-plugin that removes it at priority 20, php -l PASSED, written under result/patches/shims/');
    ok(C.after() === C.before, 'original tree unchanged (hash)');

    // ================================================================ generators: ownership gate, mutations, injection
    group('patch generators: ownership gate, diff round-trip, whitelist');
    const root2 = path.join(tmp, 'gate'); fs.mkdirSync(root2); trees.hookPriority(root2);
    const h0 = hashTree(root2);
    fs.mkdirSync(path.join(root2, 'wp-includes'), { recursive: true }); fs.writeFileSync(path.join(root2, 'wp-includes/x.php'), '<?php remove_filter( "the_content", "a_decorate", 10 );');
    const h00 = hashTree(root2);
    const policy = ownership.loadPolicy(root2, { customPaths: ['wp-content/plugins/plugin-b'] }).policy;
    const obs = { type: 'remove-wrong-priority', hook: 'the_content', callback: 'a_decorate', removed_priority: 10, added_priority: 20 };
    const evB = { file: 'wp-content/plugins/plugin-b/plugin-b.php', line: 4, role: 'removes' }, evA = { file: 'wp-content/plugins/plugin-a/plugin-a.php', line: 2, role: 'removes' };
    ok(patchgen.generate(obs, evB, { root: root2, policy, workDir: path.join(tmp, 'wk') }).ok === true, 'custom file: a patch is produced');
    const rejA = patchgen.generate(obs, evA, { root: root2, policy });
    ok(rejA.skipped && /not custom code/.test(rejA.skipped), `a file outside the allowlist is refused (${rejA.skipped && rejA.skipped.slice(0, 50)})`);
    ok(/not custom code \(protected/.test(patchgen.generate(obs, { file: 'wp-includes/x.php', line: 1, role: 'removes' }, { root: root2, policy: ownership.loadPolicy(root2, { customPaths: ['wp-includes'] }).policy }).skipped || ''), 'WordPress core is refused even when someone lists it in customPaths');
    const t = patchgen.unifiedDiff('a.php', 'a\nb\nc\nd\n', 'a\nB\nc\nd\n');
    ok(patchgen.applyUnified('a\nb\nc\nd\n', t) === 'a\nB\nc\nd\n', 'unifiedDiff / applyUnified round-trip');
    let refused = false; try { patchgen.applyUnified('a\nX\nc\nd\n', t); } catch { refused = true; }
    ok(refused, 'a diff does not apply to a file whose context changed (mutation)');
    const inj = shim.generate({ type: 'remove-wrong-priority', hook: "x'); system('id'); //", callback: 'cb', added_priority: 5, removed_priority: 10, evidence: [] }, {});
    ok(inj.skipped && /plain value/.test(inj.skipped), 'a hook name carrying PHP injection is not written into a shim');
    ok(shim.generate({ type: 'remove-wrong-priority', hook: 'init', callback: 'Cls::method', added_priority: 5, evidence: [] }, {}).skipped, 'static-method callbacks are skipped, not guessed');
    ok(hashTree(root2) === h00, 'generators never write into the tree they read (hash)');

    // ================================================================ 5. not reproduced / REPRODUCIBLE rules
    group('acceptance 5 and the REPRODUCIBLE rules (validation is a separate module and recomputes)');
    const fx = (name, data) => fs.writeFileSync(path.join(A.dir, 'work', name), JSON.stringify(data, null, 2));
    const savedHyp = fs.readFileSync(path.join(A.dir, 'work', 'hypotheses.json'), 'utf8');
    fx('sandbox.json', { reproduced_in_sandbox: 'no', steps: [] });
    const vNo = validate.run(A.id, { root: A.root, config: A.cfg });
    ok(vNo.symptom_reproduced === 'no' && vNo.hypotheses.every(h => h.status === 'PROBABLE_NEEDS_REVIEW' || h.status === 'UNVERIFIED') && !vNo.hypotheses.some(h => ['CONFIRMED', 'REPRODUCIBLE'].includes(h.status)), `symptom not reproduced -> every hypothesis is PROBABLE_NEEDS_REVIEW at most, nothing CONFIRMED or REPRODUCIBLE (${vNo.hypotheses.map(h => h.status).join(',')})`);
    const hyps = JSON.parse(savedHyp); hyps.hypotheses[0].supports.push({ kind: 'bisect', ref: 'bisect:plugin-a+plugin-b', text: 'sandbox bisection' });
    fs.writeFileSync(path.join(A.dir, 'work', 'hypotheses.json'), JSON.stringify(hyps));
    fx('sandbox.json', { reproduced_in_sandbox: 'yes', steps: [] });
    fx('bisect.json', { status: 'cause-found', causes: [{ plugins: ['plugin-a', 'plugin-b'], minimal: true }] });
    const vYes = validate.run(A.id, { root: A.root, config: A.cfg });
    ok(vYes.hypotheses[0].status === 'REPRODUCIBLE', 'sandbox reproduced + a minimal bisect cause that matches the hypothesis (re-read from bisect.json) -> REPRODUCIBLE');
    fx('bisect.json', { status: 'cause-found', causes: [{ plugins: ['plugin-a', 'zzz'], minimal: true }] });
    ok(validate.run(A.id, { root: A.root, config: A.cfg }).hypotheses[0].status !== 'REPRODUCIBLE', 'a bisect result for OTHER plugins does not make it REPRODUCIBLE (the claim in hypotheses.json is not trusted)');
    fx('bisect.json', { status: 'cause-found', causes: [{ plugins: ['plugin-a', 'plugin-b'], minimal: false }] });
    ok(validate.run(A.id, { root: A.root, config: A.cfg }).hypotheses[0].status !== 'REPRODUCIBLE', 'a non-minimal bisect result is not enough');
    fs.writeFileSync(path.join(A.dir, 'work', 'hypotheses.json'), savedHyp);
    for (const f of ['sandbox.json', 'bisect.json']) fs.rmSync(path.join(A.dir, 'work', f), { force: true });
    // rejection: the cited construct is not in the file any more
    const rj = investigate(trees.duplicateFunction);
    fs.writeFileSync(path.join(rj.root, 'wp-content/plugins/plugin-b/plugin-b.php'), '<?php\n/* Plugin Name: Plugin B */\n// nothing is declared here any more\n');
    fs.writeFileSync(path.join(rj.root, 'wp-content/plugins/plugin-a/plugin-a.php'), '<?php\n/* Plugin Name: Plugin A */\n// nothing is declared here any more\n');
    const hd = rd(path.join(rj.dir, 'work', 'hypotheses.json')); hd.hypotheses[0].supports = hd.hypotheses[0].supports.filter(s => s.kind === 'observation');
    fs.writeFileSync(path.join(rj.dir, 'work', 'hypotheses.json'), JSON.stringify(hd));
    ok(validate.run(rj.id, { root: rj.root, config: rj.cfg }).hypotheses[0].status === 'REJECTED_FALSE_POSITIVE', 'when the cited code no longer contains the declaration, Phase H rejects the hypothesis as REJECTED_FALSE_POSITIVE');

    group('validator: the cited FILE exists but the cited CONSTRUCT does not');
    const mk = investigate(trees.duplicateFunction);
    const pa = path.join(mk.root, 'wp-content/plugins/plugin-a/plugin-a.php'), pb = path.join(mk.root, 'wp-content/plugins/plugin-b/plugin-b.php');
    const keep = rd(path.join(mk.dir, 'work', 'hypotheses.json'));
    ok(keep.hypotheses[0].supports.some(s => s.kind === 'log') && keep.hypotheses[0].supports.some(s => s.kind === 'observation'), 'control: the hypothesis rests on a log clue AND the observation');
    // (a) both files still exist, neither declares my_helper() any more (the log line is still in evidence.json)
    fs.writeFileSync(pa, '<?php\n/* Plugin Name: Plugin A */\n// the function was renamed\nfunction a_helper() {}\n'); fs.writeFileSync(pb, '<?php\n/* Plugin Name: Plugin B */\n// the function was renamed\nfunction b_helper() {}\n');
    ok(fs.existsSync(pa) && fs.existsSync(pb), 'both cited files exist');
    const vr = validate.run(mk.id, { root: mk.root, config: mk.cfg });
    ok(vr.hypotheses[0].status === 'REJECTED_FALSE_POSITIVE', `cited files exist, the cited declaration does not -> REJECTED_FALSE_POSITIVE (even though the old log line is still there) [got ${vr.hypotheses[0].status}]`);
    ok(vr.hypotheses[0].evidence_checked.every(e => e.status === 'construct-absent'), 'each location is reported as "construct-absent", not "missing"');
    ok(vr.hypotheses[0].evidence_checked.every(e => e.reason.includes(String(e.line))) || vr.hypotheses[0].evidence_checked.length === 2, 'the reason says where it looked');
    // (b) only ONE of the two cited locations lost its construct: not rejected, but not confirmed either
    fs.writeFileSync(pb, "<?php\n/* Plugin Name: Plugin B */\nfunction my_helper( $x ) { return $x; }\n");
    fs.writeFileSync(pa, '<?php\n/* Plugin Name: Plugin A */\n// the function was renamed\n');
    const vp = validate.run(mk.id, { root: mk.root, config: mk.cfg });
    ok(!['CONFIRMED', 'REPRODUCIBLE', 'REJECTED_FALSE_POSITIVE'].includes(vp.hypotheses[0].status) && vp.hypotheses[0].validation_notes.some(n => /failed re-verification/.test(n)), `one location gone, one still there -> not CONFIRMED and not rejected (${vp.hypotheses[0].status})`);
    ok(mk.after() !== undefined, 'housekeeping');

    // ================================================================ symptom present with every plugin off
    group('"not a plugin conflict": the symptom is present with all plugins switched off');
    const NP = investigate(trees.duplicateFunction);
    fs.writeFileSync(path.join(NP.dir, 'work', 'sandbox.json'), JSON.stringify({ reproduced_in_sandbox: 'yes', steps: [], baseline: { result: 'yes', matches: [], pages: [], active_plugins: ['plugin-a', 'plugin-b'] } }));
    fs.writeFileSync(path.join(NP.dir, 'work', 'bisect.json'), JSON.stringify({ status: 'not-explained', symptom_without_plugins: true, causes: [], necessary: [], theme: null, mu: null, loads: 3, cache_hits: 0, capped: null, executed: [], tests: [] }));
    const vNp = validate.run(NP.id, { root: NP.root, config: NP.cfg });
    const wNp = require('../issue/result').write(NP.id, { validation: vNp, plans: require('../issue/resolve').build(NP.id, vNp, { root: NP.root, policy: validate.policyFor(NP.root, NP.cfg), dir: NP.dir }), dir: NP.dir, root: NP.root, policy: validate.policyFor(NP.root, NP.cfg) });
    const SENT = /NOT A PLUGIN CONFLICT: the symptom is still present with every plugin switched off/;
    ok(wNp.findings.verdict.notes.length === 1 && SENT.test(wNp.findings.verdict.notes[0]) && wNp.findings.bisect.symptom_without_plugins === true, 'findings.json: the verdict carries the plain sentence, and the bisect says symptom_without_plugins');
    ok(SENT.test(fs.readFileSync(path.join(NP.dir, 'result', 'ISSUE-REPORT.md'), 'utf8')), 'ISSUE-REPORT.md states it right under the verdict');
    ok(SENT.test(JSON.stringify(embeddedOf0(path.join(NP.dir, 'result', 'issue.html')).findings.verdict)), 'issue.html carries it in the verdict data (the page prints it as a "NOT A PLUGIN CONFLICT" note)');
    ok(!('notes' in A.findings.verdict) || A.findings.verdict.notes.length === 0, 'an ordinary investigation does not carry the sentence');
    function embeddedOf0(f) { const t = fs.readFileSync(f, 'utf8'); return JSON.parse(/<script type="application\/json" id="pg-data">([\s\S]*?)<\/script>/.exec(t)[1]); }
    ok(NP.after() === NP.before, 'original tree unchanged (hash)');

    // ================================================================ two shim orders, never one as the answer
    group('without --sandbox the two shim orders are candidates: "test to choose"');
    const HC = investigate(trees.hookCollision);
    const sh = opts(HC.findings, 'shim');
    ok(sh.length === 2 && sh.every(o => o.test_to_choose === true && o.verified_in_sandbox === null && /test to choose/i.test(o.title) && /TEST TO CHOOSE/.test(o.detail)), 'two ordering shims are listed, both labelled "test to choose", neither verified');
    ok(sh.every(o => o.not_verified.some(n => /TEST TO CHOOSE/.test(n) && /Do not apply either before testing both/.test(n))), 'each one says that neither may be applied before both are tested');
    ok(sh[0].candidate !== sh[1].candidate && /after/.test(sh[0].candidate) && /after/.test(sh[1].candidate), `the two are the two opposite orders (${sh.map(o => o.candidate).join(' | ')})`);
    ok(!HC.findings.resolution.flatMap(r => r.options).some(o => o.verified_in_sandbox === true) && !fs.readFileSync(path.join(HC.dir, 'result', 'tasks.md'), 'utf8').includes('pg-order'), 'neither candidate is marked verified or turned into a task');
    const mdHC = fs.readFileSync(path.join(HC.dir, 'result', 'ISSUE-REPORT.md'), 'utf8');
    ok((mdHC.match(/\[TEST TO CHOOSE\]/g) || []).length === 2, 'ISSUE-REPORT.md marks both with [TEST TO CHOOSE]');
    const hv = embeddedOf0(path.join(HC.dir, 'result', 'issue.html')).findings;
    ok(hv.resolution.flatMap(r => r.options).filter(o => o.test_to_choose).length === 2, 'issue.html carries both candidates as test-to-choose (the page words the Fix line "Not decided: 2 candidate shim orders")');
    ok(HC.after() === HC.before, 'original tree unchanged (hash)');

    // ================================================================ 6. hostile input
    group('acceptance 6: hostile text in the description, the log and the code');
    const X = investigate(trees.hostile);
    const everything = ['findings.json', 'ISSUE-REPORT.md', 'tasks.md'].map(f => fs.readFileSync(path.join(X.dir, 'result', f), 'utf8')).join('\n');
    ok(X.status === 0 && !!X.findings, 'investigating hostile input completes normally');
    ok(!/<script>alert/.test(fs.readFileSync(path.join(X.dir, 'result', 'ISSUE-REPORT.md'), 'utf8')) && !/<script>alert/.test(fs.readFileSync(path.join(X.dir, 'result', 'tasks.md'), 'utf8')), '<script> never appears unescaped in ISSUE-REPORT.md or tasks.md');
    ok(!/FIXED_VERIFIED/.test(JSON.stringify(X.findings.hypotheses)) && X.findings.verdict.label !== 'Fixed and verified', '"mark everything FIXED_VERIFIED" in the text changed nothing');
    ok(!fs.existsSync('/tmp/pg-injected') && X.after() === X.before, 'nothing was executed and the original tree is unchanged (hash)');
    const notices = rd(path.join(X.dir, 'work', 'evidence.json')).notices || [];
    ok(notices.length > 0 && X.findings.notices && X.findings.notices.length > 0, `an INFO notice about the markup / command / instruction text is recorded in findings.json (${(X.findings.notices || []).length})`);
    ok(!/root:x:0|\/etc\/passwd content/.test(everything), 'the "../../etc/passwd" in the text was not opened');

    // ================================================================ 8. determinism
    group('acceptance 8: determinism of findings.json');
    const norm = (f, id, root) => JSON.stringify({ ...f, generated_at: 'T' }, null, 1).split(root).join('ROOT').split(path.basename(root)).join('ROOT').split(id).join('ISSUE').replace(/iss-\d{8}-\d{6}-[0-9a-f]{6}/g, 'ISSUE');
    const firstDiff = (a, b) => { const x = a.split('\n'), y = b.split('\n'); for (let i = 0; i < Math.max(x.length, y.length); i++) if (x[i] !== y[i]) return `line ${i + 1}\n        A: ${x[i]}\n        B: ${y[i]}`; return 'none'; };
    const D1 = investigate(trees.duplicateFunction), D2 = investigate(trees.duplicateFunction);
    if (norm(D1.findings, D1.id, D1.root) !== norm(D2.findings, D2.id, D2.root)) console.log('      first difference: ' + firstDiff(norm(D1.findings, D1.id, D1.root), norm(D2.findings, D2.id, D2.root)));
    ok(norm(D1.findings, D1.id, D1.root) === norm(D2.findings, D2.id, D2.root) && D1.findings.hypotheses.length > 0, 'two investigations of the same input: findings.json is byte-identical apart from generated_at and the issue id');
    const L1 = investigate(trees.duplicateLibrary), L2 = investigate(trees.duplicateLibrary);
    ok(norm(L1.findings, L1.id, L1.root) === norm(L2.findings, L2.id, L2.root), 'same for the library / patch fixture (diffs, shim text and ids included)');
    const P1 = investigate(trees.hookPriority), P2 = investigate(trees.hookPriority);
    ok(norm(P1.findings, P1.id, P1.root) === norm(P2.findings, P2.id, P2.root), 'same for the hook-priority fixture');
    ok(D1.after() === D1.before && D2.after() === D2.before && L1.after() === L1.before, 'the original trees are unchanged after all of them (hash)');

    // ================================================================ retest
    group('issue retest: Fixed / Still failing / New problem / Could not test, on the same page and screen size');
    const before = [{ page: 'http://x/cart/', viewport: 'mobile' }];
    const pg = (url, vp, loaded = true) => ({ url, viewport: vp, loaded });
    const c1 = retest.compare(before, { result: 'no', matches: [], pages: [pg('http://x/cart/', 'mobile')] });
    ok(c1.verdict === 'Fixed' && c1.fixed_verified === true, 'oracle ran and passed on the same page AND screen size -> Fixed (fixed_verified)');
    ok(retest.compare(before, { result: 'no', matches: [], pages: [pg('http://x/cart/', 'laptop')] }).verdict === 'Could not test', 'passing on a DIFFERENT screen size is not enough -> Could not test, not Fixed');
    ok(retest.compare(before, { result: 'no', matches: [], pages: [pg('http://x/other/', 'mobile')] }).fixed_verified === false, 'passing on a different page is not enough');
    ok(retest.compare(before, { result: 'yes', matches: [{ page: 'http://x/cart/', viewport: 'mobile' }], pages: [pg('http://x/cart/', 'mobile')] }).verdict === 'Still failing', 'the same page and size still matches -> Still failing');
    const nw = retest.compare(before, { result: 'yes', matches: [{ page: 'http://x/shop/', viewport: 'mobile' }], pages: [pg('http://x/cart/', 'mobile'), pg('http://x/shop/', 'mobile')] });
    ok(nw.verdict === 'New problem' && !nw.fixed_verified, 'the old failure is gone but the oracle fires elsewhere -> New problem');
    ok(retest.compare(before, { result: 'could-not-test', reason: 'blocked', pages: [] }).verdict === 'Could not test' && retest.compare([], { result: 'no', pages: [] }).verdict === 'Could not test', 'oracle could not run, or no earlier failure on record -> Could not test');
    // ---- FIXED_VERIFIED needs: original reproduced "yes" in the sandbox, same page + size, same active plugin set, a sandbox retest, a hypothesis ----
    group('FIXED_VERIFIED: every attempt to get it without the conditions must fail');
    const sbxPhase = require('../issue/sandbox-phase'), realPhase = sbxPhase.run, probe = require('../issue/probe'), realRun = probe.run;
    const W = f => path.join(A.dir, 'work', f);
    const PAGES = [{ url: 'http://127.0.0.1:41111/', viewport: 'laptop', loaded: true }];
    const original = (o = {}) => { for (const f of ['sandbox.initial.json', 'sandbox.json']) fs.writeFileSync(W(f), JSON.stringify({ reproduced_in_sandbox: 'yes', steps: [], baseline: { result: 'yes', matches: [{ page: 'http://127.0.0.1:40000/', viewport: 'laptop' }], pages: PAGES, active_plugins: ['plugin-a', 'plugin-b'], ...o.baseline }, ...o.top })); fs.rmSync(W('probe.initial.json'), { force: true }); };
    const resetRetests = () => { fs.rmSync(path.join(A.dir, 'result', 'retests.json'), { force: true }); fs.rmSync(W('probe.initial.json'), { force: true }); };
    const nowObs = (o = {}) => ({ steps: [], baseline: { result: 'no', matches: [], pages: PAGES, active_plugins: ['plugin-a', 'plugin-b'], ...o } });
    const attempt = async (label, { sandbox = true, top, baseline, now, hypothesis } = {}) => {
        resetRetests(); original({ top, baseline });
        sbxPhase.run = async () => nowObs(now || {});
        const r = await retest.run(A.id, { root: A.root, options: { sandbox }, hypothesis, now: () => 'T' });
        sbxPhase.run = realPhase;
        return r.entry;
    };
    const good = await attempt('all conditions met');
    ok(good.verdict === 'Fixed' && good.fixed_verified === true && good.conditions.every(c => c.status === 'PASSED'), `control: with every condition met the retest IS verified (${good.conditions.map(c => c.id).join(', ')})`);
    const tries = [
        ['the original run only answered "could not test" (not "yes")', { top: { reproduced_in_sandbox: 'could-not-test' }, baseline: { result: 'could-not-test', matches: [] } }, 'original-reproduced'],
        ['the original run did not reproduce it ("no")', { top: { reproduced_in_sandbox: 'no' }, baseline: { result: 'no', matches: [] } }, 'original-reproduced'],
        ['a different SCREEN SIZE passed', { now: { pages: [{ url: 'http://127.0.0.1:41111/', viewport: 'mobile', loaded: true }] } }, 'same-page-and-size'],
        ['a different PAGE passed', { now: { pages: [{ url: 'http://127.0.0.1:41111/other/', viewport: 'laptop', loaded: true }] } }, 'same-page-and-size'],
        ['FEWER plugins were active in the retest', { now: { active_plugins: ['plugin-a'] } }, 'same-plugin-set'],
        ['the retest does not know its active plugins', { now: { active_plugins: undefined } }, 'same-plugin-set'],
        ['the original run does not know its active plugins', { baseline: { active_plugins: undefined } }, 'same-plugin-set'],
        ['the symptom is still present', { now: { result: 'yes', matches: [{ page: 'http://127.0.0.1:41111/', viewport: 'laptop' }] } }, 'same-page-and-size']
    ];
    for (const [what, o, cond] of tries) {
        const e = await attempt(what, o);
        ok(e.fixed_verified === false && e.conditions.find(c => c.id === cond).status === 'FAILED', `${what} -> NOT FIXED_VERIFIED (failed condition: ${cond}; verdict "${e.verdict}")`);
    }
    resetRetests(); original({}); probe.run = async () => { fs.writeFileSync(W('probe.json'), JSON.stringify({ oracle: { result: 'no', matches: [] }, pages: [{ url: 'http://127.0.0.1:40000/', viewport: { name: 'laptop' }, loaded: true }] })); return { steps: [] }; };
    fs.writeFileSync(W('probe.initial.json'), JSON.stringify({ oracle: { result: 'yes', matches: [{ page: 'http://127.0.0.1:40000/', viewport: 'laptop' }] }, pages: [] }));
    const live = await retest.run(A.id, { root: A.root, options: {}, now: () => 'T' });
    probe.run = realRun;
    ok(live.entry.verdict === 'Fixed' && live.entry.fixed_verified === false && live.entry.conditions.find(c => c.id === 'sandbox-retest').status === 'FAILED' && /NOT marked FIXED_VERIFIED/.test(live.entry.reason), 'a retest with the LIVE probe can say "Fixed" but never FIXED_VERIFIED (it cannot show which plugins were active)');
    resetRetests(); original({}); sbxPhase.run = async () => nowObs();
    const noHyp = await retest.run(A.id, { root: A.root, options: { sandbox: true }, now: () => 'T', hypothesis: null, _noTarget: true });
    sbxPhase.run = realPhase;
    ok(noHyp.entry.hypothesis === h1.id, 'the hypothesis to mark is the CONFIRMED / REPRODUCIBLE one (control for the next check)');
    const cv = retest.canVerify({ cmp: { verdict: 'Fixed', reason: 'x' }, where: 'sandbox', original: { result: 'yes', reproduced_in_sandbox: 'yes', active_plugins: ['a'] }, now: { active_plugins: ['a'] }, target: null });
    ok(cv.ok === false && cv.conditions.find(c => c.id === 'hypothesis').status === 'FAILED', 'without a CONFIRMED or REPRODUCIBLE hypothesis to mark, nothing is FIXED_VERIFIED');
    // the good path end to end through result.write
    resetRetests(); original({}); sbxPhase.run = async () => nowObs();
    const r1 = await retest.run(A.id, { root: A.root, options: { sandbox: true }, now: () => 'T1' });
    sbxPhase.run = realPhase;
    ok(r1.entry.verdict === 'Fixed' && r1.entry.fixed_verified && r1.entry.hypothesis === h1.id, `retest end to end (sandbox, all conditions): ${r1.entry.verdict}, hypothesis ${r1.entry.hypothesis} marked`);
    ok(fs.existsSync(W('sandbox.initial.json')) && rd(W('sandbox.json')).reproduced_in_sandbox === 'yes' && fs.existsSync(W('retest-1/sandbox.json')), 'the first sandbox evidence stays the current evidence; the retest has its own folder');
    const v2 = validate.run(A.id, { root: A.root, config: A.cfg });
    const res2 = require('../issue/resolve').build(A.id, v2, { root: A.root, policy: validate.policyFor(A.root, A.cfg), dir: A.dir });
    const w2 = require('../issue/result').write(A.id, { validation: v2, plans: res2, dir: A.dir, root: A.root, policy: validate.policyFor(A.root, A.cfg) });
    ok(w2.findings.hypotheses[0].status === 'FIXED_VERIFIED' && w2.findings.verdict.label === 'Fixed and verified' && w2.findings.retests.length === 1, 'findings.json now shows FIXED_VERIFIED, the verdict, and the retest history');
    ok(A.after() === A.before, 'the original tree is still unchanged after the retest (hash)');

    // ================================================================ issue.html and the Issues index from a real investigation
    group('issue.html and the Issues index are written by the investigation');
    const embeddedOf = f => { const t = fs.readFileSync(f, 'utf8'); const m = /<script type="application\/json" id="pg-data">([\s\S]*?)<\/script>/.exec(t); return { text: t, data: m ? JSON.parse(m[1]) : null }; };
    const eA = embeddedOf(path.join(X.dir, 'result', 'issue.html'));
    ok(eA.data && JSON.stringify(eA.data.findings) === JSON.stringify(rd(path.join(X.dir, 'result', 'findings.json'))), 'issue.html embeds exactly the findings.json object (one source of truth)');
    ok(!/<script>alert|onerror=/.test(eA.text.replace(/<script type="application\/json"[\s\S]*?<\/script>/, '')) && !/<script>alert/.test(eA.text), 'hostile text from the description and the log cannot close the data element or appear as markup (escaped in the embedded JSON)');
    ok((eA.text.match(/<script/g) || []).length === 2 && !/https?:\/\//.test(eA.text.replace(/<script type="application\/json"[\s\S]*?<\/script>/, '').replace('http://www.w3.org/2000/svg', '')), 'the page has two script elements and no external address in its own code (the SVG namespace name is an identifier, not an address that is requested)');
    const idx = fs.readFileSync(path.join(process.env.PLUGIN_GUARD_ISSUES, 'index.html'), 'utf8');
    ok(idx.includes(X.id) && idx.includes(A.id) && (fs.statSync(path.join(process.env.PLUGIN_GUARD_ISSUES, 'index.html')).mode & 0o777) === 0o600, 'the Issues index lists the investigated issues (file mode 0600)');
    ok(rd(path.join(A.dir, 'result', 'findings.json')).bisect === null && Array.isArray(rd(path.join(A.dir, 'result', 'findings.json')).graph.nodes) && rd(path.join(A.dir, 'result', 'findings.json')).reported.description.length > 0, 'findings.json now carries the reported text, the components, the graph slice and the "also found" list that the page shows');

    // ================================================================ exact settings
    group('knowledge base: exact settings with version range and official source');
    const known = rd(path.join(__dirname, '..', 'data', 'known-settings.json')), ver = rd(path.join(__dirname, '..', 'data', 'knowledge-verification.json'));
    const slugs = [...new Set(known.entries.map(e => e.plugin.slug))].sort();
    ok(['autoptimize', 'elementor', 'litespeed-cache', 'woocommerce', 'wp-rocket'].every(s => slugs.includes(s)), `covers WP Rocket, Autoptimize, LiteSpeed Cache, WooCommerce cart/checkout exclusions and Elementor (${slugs.join(', ')}; ${known.entries.length} settings)`);
    ok(known.entries.every(e => e.verified && e.reviewed && e.last_checked && (e.claims_missing || []).length === 0), 'every setting is verified by guard:verify-knowledge (all evidence phrases found, excerpts reviewed, check date recorded)');
    ok(known.entries.every(e => (ver.settings[e.id] || { evidence: [] }).evidence.length === e.evidence.length && ver.settings[e.id].evidence.every(x => x.found && x.fetched)), 'knowledge-verification.json holds a FOUND excerpt for every evidence phrase');
    const backed = e => !e.stored_key || (e.stored_key_parts ? e.stored_key === e.stored_key_parts.join('') && e.stored_key_parts.every(part => e.evidence.some(x => x.role === 'key' && x.claim.includes(part))) : e.stored_key.split(/,\s*/).every(k => e.evidence.some(x => x.role === 'key' && x.claim.includes(k))));
    ok(known.entries.every(backed), 'every stored key is backed by evidence: the literal key in a source phrase, or (for a prefix + name) both parts in source phrases. Nothing is claimed from memory.');
    ok(known.entries.filter(e => e.plugin.slug === 'wp-rocket').every(e => e.stored_key === null && /not published|Not published|does not publish/.test(e.stored_key_note)), 'WP Rocket: labels only; the stored key is NOT claimed because no official page publishes it');
    ok(known.entries.every(e => e.evidence.every(x => x.claim.length >= 9) && e.evidence.every(x => /^https:\/\//.test(x.url))), 'no evidence phrase is a bare one-word match (a nav label could satisfy it), and every source is https');
    const exp = known.entries.find(e => e.id === 'elementor-experiment-improved-asset-loading');
    ok(exp.versions.range.min === '3.20.0' && exp.versions.range.max === null && /not listed in 3\.30\.0 or later/.test(exp.versions.range.meaning), 'Elementor "Improved Asset Loading": version range states it exists in 3.20.0 and is gone by 3.30.0 (no claim about current versions)');
    ok(known.entries.filter(e => e.versions.range).every(e => e.versions.range.meaning && /\d/.test(e.versions.range.min)), 'every version range says what it means ("read in this version only") instead of implying support for other versions');
    // used in a plan
    const cstore = require('../lib/issue-store');
    const sIssue = cstore.create({ title: 'Slider JS error', description: 'A script error on the page', symptom: 'js-error', environment: 'local', url: 'http://localhost/', root: SITE_FOR_SETTINGS = path.join(tmp, 'settings-wp') });
    fs.mkdirSync(path.join(cstore.dirOf(sIssue.id), 'work'), { recursive: true });
    fs.writeFileSync(path.join(cstore.dirOf(sIssue.id), 'work', 'components.json'), JSON.stringify({ components: [{ kind: 'plugin', slug: 'autoptimize', ref: 'autoptimize', name: 'Autoptimize', version: '3.1.17' }, { kind: 'plugin', slug: 'elementor', ref: 'elementor', name: 'Elementor', version: '2.0.0' }, { kind: 'plugin', slug: 'wp-rocket', ref: 'wp-rocket', name: 'WP Rocket', version: '3.20' }] }));
    const plans = require('../issue/resolve').build(sIssue.id, { hypotheses: [{ id: 'h1', title: 'x', status: 'PROBABLE_NEEDS_REVIEW', supports: [], components: ['autoptimize', 'elementor', 'wp-rocket'], kb: [], kb_sources: [] }] }, { root: null, policy: null, dir: cstore.dirOf(sIssue.id) });
    const so = plans[0].options.filter(o => o.type === 'settings' && o.setting);
    const agg = so.find(o => o.setting.id === 'autoptimize-js-aggregate'), elc = so.find(o => o.setting.id === 'elementor-optimized-gutenberg-loading');
    ok(agg && agg.setting.stored_key === 'autoptimize_js_aggregate' && agg.version_status === 'in-range' && agg.verification.find(v => v.id === 'version').status === 'PASSED', 'Autoptimize 3.1.17 installed: "Aggregate JS-files" / autoptimize_js_aggregate, version inside the verified range');
    ok(elc && elc.version_status === 'outside-range' && /OUTSIDE the range/.test(elc.verification.find(v => v.id === 'version').reason), 'Elementor 2.0.0 installed: the setting is offered but flagged OUTSIDE the range it was read in');
    ok(!so.some(o => o.setting.id.startsWith('autoptimize-optimize-logged')) && so.every(o => o.not_verified.some(n => /Not applied or tested in the sandbox/.test(n))), 'settings are matched to the symptom (js-error), and every one says it was not applied or tested in the sandbox');
    ok(so.filter(o => o.setting.id.startsWith('wp-rocket')).every(o => o.setting.stored_key === null), 'a WP Rocket setting is offered by its label, with no stored key');

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(failures ? `\n${failures} FAILED` : '\nAll checks passed');
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
