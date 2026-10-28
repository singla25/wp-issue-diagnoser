#!/usr/bin/env node
// `npm run guard:demo`: the worked example, end to end, on a tiny fake WordPress tree that this script builds in a temporary folder.
//   (default)   offline, no Docker: two plugins declare the same function ("white screen after activating Plugin B"). Shows the CONFIRMED verdict,
//               the patch for the one custom plugin, tasks.md, issue.html and the report. Takes a few seconds.
//   --sandbox   needs rootless Docker + the pinned images: two plugins hook the_content at the same priority and one empties the post. Shows the
//               symptom reproduced in a sandbox, the bisection, the two candidate orders tested, the winner VERIFIED IN SANDBOX, and a retest of
//               the fixed copy that ends in FIXED_VERIFIED. Takes several minutes.
//   --keep      leave the temporary folder in place (its path is printed) so you can open issue.html; otherwise it is deleted.
// Nothing outside the temporary folder is written; the fixture tree is hashed before and after to prove it was not changed by the investigation.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2), SANDBOX = args.includes('--sandbox'), KEEP = args.includes('--keep');
const trees = require('./fixtures/issue/trees');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-demo-'));
process.env.PLUGIN_GUARD_ISSUES = path.join(tmp, 'issues'); process.env.PLUGIN_GUARD_SANDBOXES = path.join(tmp, 'sandboxes');
const hashTree = dir => { const h = crypto.createHash('sha256'); (function walk(d) { for (const n of fs.readdirSync(d).sort()) { const f = path.join(d, n), st = fs.lstatSync(f); h.update(`${path.relative(dir, f)}|${st.isDirectory() ? 'd' : 'f'}|`); if (st.isDirectory()) walk(f); else h.update(fs.readFileSync(f)); } })(dir); return h.digest('hex'); };
const guard = (...a) => spawnSync(process.execPath, [path.join(__dirname, 'guard.js'), ...a], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' }, timeout: 1800000 });
const say = t => console.log(t);
const step = (n, t) => say(`\n[${n}] ${t}`);
const R = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const rel = p => path.relative(tmp, p);
let code = 0;

function finish() { if (KEEP) say(`\nKept: ${tmp}\n  open ${path.join(process.env.PLUGIN_GUARD_ISSUES, 'index.html')} in a browser (the Issues index)`); else fs.rmSync(tmp, { recursive: true, force: true }); process.exit(code); }

(function main() {
    if (SANDBOX) { const pf = require('../issue/sandbox').preflight({}); if (!pf.ok) { say(`The --sandbox demo needs Docker: ${pf.reason}\nRun without --sandbox for the offline demo.`); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(3); } }
    const root = path.join(tmp, 'wordpress'), fixed = path.join(tmp, 'wordpress-fixed');
    const c = SANDBOX ? trees.hookCollision(root) : trees.duplicateFunction(root);
    const cfg = path.join(tmp, 'config.json'); fs.writeFileSync(cfg, JSON.stringify(c.config));
    const before = hashTree(root);
    say(`Plugin Guard demo: ${SANDBOX ? 'hook collision, with the sandbox' : 'duplicate function, offline'}\nA fake WordPress site was built in a temporary folder. The reported problem:\n  "${c.description}"`);
    step(1, 'Create the issue');
    const nw = guard('issue', 'new', '--title', SANDBOX ? 'Post text disappears' : 'White screen after activating Plugin B', '--description', c.description, '--symptom', c.symptom, ...(c.oracle ? ['--oracle', c.oracle] : []), '--pages', c.pages || '/', '--root', root, '--env', 'local', '--url', 'http://localhost/', '--no-prompt');
    const id = /(iss-\d{8}-\d{6}-[0-9a-f]{6})/.exec(nw.stdout)?.[1]; if (!id) { say(nw.stdout + nw.stderr); code = 1; return finish(); }
    say(`  issue ${id}`);
    step(2, `Investigate${SANDBOX ? ' (builds throwaway Docker containers; several minutes)' : ''}`);
    const inv = guard('issue', 'investigate', id, '--root', root, '--config', cfg, '--no-probe', ...(SANDBOX ? ['--sandbox'] : []));
    say(inv.stdout.split('\n').filter(l => /^(VERDICT|Validation|  (CONFIRMED|REPRODUCIBLE|PROBABLE|UNVERIFIED)|    (VERIFIED IN SANDBOX|TESTED, DID NOT HELP)|  \[(send|you|needs)|  (PASSED|NOT_RUN|FAILED)\s+(Oracle in the sandbox|Bisection|Verify))/.test(l)).map(l => '  ' + l.slice(0, 190)).join('\n'));
    if (inv.status !== 0) { say(inv.stdout + inv.stderr); code = 1; return finish(); }
    const dir = path.join(process.env.PLUGIN_GUARD_ISSUES, id), f = R(path.join(dir, 'result', 'findings.json'));
    step(3, 'What came out');
    say(`  verdict:  ${f.verdict.label} (confidence ${f.verdict.confidence}); symptom reproduced: ${f.verdict.symptom_reproduced}`);
    for (const h of f.hypotheses.slice(0, 2)) say(`  cause:    [${h.status}] ${h.title}`);
    const opts = f.resolution.flatMap(r => r.options).filter(o => o.type === 'patch' || o.type === 'shim');
    for (const o of opts) say(`  fix:      ${o.title}  ${o.verified_in_sandbox === true ? '=> VERIFIED IN SANDBOX' : o.verified_in_sandbox === false ? '=> tested in the sandbox, did not help' : o.test_to_choose ? '=> TEST TO CHOOSE' : '=> not verified in the sandbox'}`);
    const diffs = fs.readdirSync(path.join(dir, 'result', 'patches')).filter(n => n.endsWith('.diff'));
    if (diffs.length) say(`\n  patch (result/patches/${diffs[0]}):\n` + fs.readFileSync(path.join(dir, 'result', 'patches', diffs[0]), 'utf8').split('\n').map(l => '    ' + l).join('\n'));
    say(`  files:    ${['issue.html', 'ISSUE-REPORT.md', 'tasks.md', 'findings.json'].map(n => rel(path.join(dir, 'result', n))).join(', ')}`);
    say(`  tasks.md: ${(fs.readFileSync(path.join(dir, 'result', 'tasks.md'), 'utf8').match(/^### ☐/gm) || []).length} task(s) for a separate Claude Code session (Plugin Guard never changes your site)`);

    if (SANDBOX) {
        step(4, 'Apply the verified shim to a COPY and retest in a fresh sandbox');
        const win = opts.find(o => o.verified_in_sandbox === true);
        if (!win) { say('  no candidate was verified, so there is nothing to retest.'); code = 1; return finish(); }
        trees.hookCollision(fixed); fs.mkdirSync(path.join(fixed, 'wp-content', 'mu-plugins'), { recursive: true });
        fs.copyFileSync(path.join(dir, 'result', 'patches', 'shims', win.file), path.join(fixed, 'wp-content', 'mu-plugins', win.file));
        const rt = guard('issue', 'retest', id, '--root', fixed, '--config', cfg, '--sandbox');
        say(rt.stdout.split('\n').filter(l => /^RETEST|^  (the oracle|Hypothesis|Nothing)/.test(l)).map(l => '  ' + l).join('\n'));
        const e = R(path.join(dir, 'result', 'retests.json')).pop(); if (!e.fixed_verified) code = 1;
    }
    step(SANDBOX ? 5 : 4, 'The original site was not touched');
    const after = hashTree(root); say(`  fixture hash before == after: ${before === after ? 'yes' : 'NO'}`); if (before !== after) code = 1;
    say(`\n${code === 0 ? 'Demo finished.' : 'Demo FAILED.'}${KEEP ? '' : ' (Run with --keep to keep the files and open issue.html.)'}`);
    finish();
})();
