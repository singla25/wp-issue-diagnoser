#!/usr/bin/env node
// Self-test of `issue cleanup`: it lists first, asks before deleting, and refuses anything that is not a plain issue / sandbox folder directly
// inside the issues or sandboxes folder. Docker is replaced by the fake docker (no daemon); the tree outside both folders is hashed before and after.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-clean-'));
const ISS = path.join(tmp, 'issues'), SBX = path.join(tmp, 'sandboxes'), VICTIM = path.join(tmp, 'victim');
fs.mkdirSync(ISS, { mode: 0o700 }); fs.mkdirSync(SBX, { mode: 0o700 }); fs.mkdirSync(VICTIM);
process.env.PLUGIN_GUARD_ISSUES = ISS; process.env.PLUGIN_GUARD_SANDBOXES = SBX;
const cl = require('../issue/cleanup');
const sandbox = require('../issue/sandbox');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const group = t => console.log(`\n== ${t}`);
function hashTree(dir) { const h = crypto.createHash('sha256'); (function walk(d) { for (const n of fs.readdirSync(d).sort()) { const f = path.join(d, n), st = fs.lstatSync(f); h.update(`${path.relative(dir, f)}|${st.isSymbolicLink() ? 'l:' + fs.readlinkSync(f) : st.isDirectory() ? 'd' : 'f'}|`); if (st.isDirectory()) walk(f); else if (st.isFile()) h.update(fs.readFileSync(f)); } })(dir); return h.digest('hex'); }
const iid = n => `iss-2026010${n}-100000-00000${n}`;
const NOW = Date.parse('2026-10-28T00:00:00Z');
const mkIssue = (id, createdAt) => { const d = path.join(ISS, id); fs.mkdirSync(path.join(d, 'work'), { recursive: true, mode: 0o700 }); fs.writeFileSync(path.join(d, 'issue.json'), JSON.stringify({ id, title: `T ${id}`, created_at: createdAt, symptom: 'other', environment: 'local', images: [] })); fs.writeFileSync(path.join(d, 'work', 'x.txt'), 'x'); return d; };
const mkSandbox = (id, project, pid) => { const d = path.join(SBX, id); fs.mkdirSync(path.join(d, 'site'), { recursive: true, mode: 0o700 }); fs.writeFileSync(path.join(d, 'state.json'), JSON.stringify({ project, issue: id, pid })); fs.writeFileSync(path.join(d, 'compose.json'), '{}'); return d; };
// fake docker beside the test
const FD = path.join(tmp, 'fake'); fs.mkdirSync(FD); fs.copyFileSync(path.join(__dirname, 'fixtures', 'issue', 'fake-docker.js'), path.join(FD, 'docker')); fs.chmodSync(path.join(FD, 'docker'), 0o755);
fs.writeFileSync(path.join(FD, 'fake.json'), '{}');
const sbOpts = { dockerBin: path.join(FD, 'docker'), env: { PATH: process.env.PATH, HOME: process.env.HOME }, sandboxesRoot: SBX };
const L = p => ({ 'pg.sandbox': '1', 'pg.owner': 'plugin-guard', 'pg.project': p, 'pg.issue': 'x' });
const fakeState = () => JSON.parse(fs.readFileSync(path.join(FD, 'fake.state.json'), 'utf8'));

(async () => {
    group('plan: what is a candidate, what is skipped');
    const oldA = mkIssue(iid(1), '2026-01-01T00:00:00Z'), oldB = mkIssue(iid(2), '2026-02-01T00:00:00Z'), fresh = mkIssue(iid(3), '2026-10-20T00:00:00Z');
    fs.writeFileSync(path.join(ISS, 'index.html'), '<html></html>'); fs.writeFileSync(path.join(ISS, 'notes.txt'), 'mine'); fs.mkdirSync(path.join(ISS, 'my-own-folder'));
    fs.writeFileSync(path.join(VICTIM, 'precious.txt'), 'do not delete'); fs.symlinkSync(VICTIM, path.join(ISS, iid(4)));   // an issue-id-looking SYMBOLIC LINK to a folder elsewhere
    const p = cl.plan({ olderThanDays: 30, now: NOW });
    ok(p.issues.map(i => i.id).join() === [iid(1), iid(2)].join(), `old issues are candidates, the recent one is not (${p.issues.map(i => `${i.id.slice(4, 12)}: ${i.age_days}d`).join(', ')})`);
    ok(p.skipped.some(s => /my-own-folder/.test(s.path)) && p.skipped.some(s => /notes\.txt/.test(s.path)) && !p.skipped.some(s => /index\.html/.test(s.path)) && !p.issues.some(i => /index|notes|my-own/.test(i.id)), 'other files and folders are only "skipped", index.html is ignored');
    ok(p.skipped.some(s => s.path.endsWith(iid(4)) && /symbolic link/.test(s.reason)) && !p.issues.some(i => i.id === iid(4)), 'an issue-id-named symbolic link to another folder is skipped as a symbolic link');
    ok(cl.plan({ olderThanDays: 400, now: NOW }).issues.length === 0 && cl.plan({ olderThanDays: 0, now: NOW }).issues.length === 3, 'the age threshold is honoured (400 days: none; 0 days: all three)');
    ok(cl.plan({ only: iid(3), now: NOW }).issues.map(i => i.id).join() === iid(3), 'naming one issue selects just that one, whatever its age');
    for (const bad of ['../victim', '/etc', 'iss-1', iid(1) + '/..', '']) { let e = null; try { cl.plan({ only: bad }); } catch (x) { e = x; } ok(bad === '' ? e === null : e && e.name === 'CleanupRefusal', `an id like ${JSON.stringify(bad)} is ${bad === '' ? 'treated as "none given"' : 'refused'}`); }

    group('nothing is deleted without a "yes"');
    const before = hashTree(tmp);
    let r = await cl.apply(p, {});
    ok(r.removed.length === 0 && !r.asked && hashTree(tmp) === before, 'no confirm function (no terminal, no --yes): nothing deleted, folder tree identical');
    r = await cl.apply(p, { confirm: async () => false });
    ok(r.asked && !r.confirmed && r.removed.length === 0 && hashTree(tmp) === before, 'answering "no": nothing deleted');
    let shown = null; r = await cl.apply(p, { confirm: async pl => { shown = pl; return false; } });
    ok(shown && shown.issues.length === 2, 'the question is asked once, with the list');

    group('after "yes": only the listed items go');
    r = await cl.apply(p, { confirm: async () => true });
    ok(r.removed.length === 2 && !fs.existsSync(oldA) && !fs.existsSync(oldB) && fs.existsSync(fresh), 'the two old issues are removed, the recent one stays');
    ok(fs.existsSync(path.join(ISS, 'notes.txt')) && fs.existsSync(path.join(ISS, 'my-own-folder')) && fs.existsSync(path.join(VICTIM, 'precious.txt')) && fs.lstatSync(path.join(ISS, iid(4))).isSymbolicLink(), 'other files, folders and the symlink target are untouched');
    ok(fs.existsSync(path.join(ISS, 'index.html')) && fs.readFileSync(path.join(ISS, 'index.html'), 'utf8').includes(iid(3)), 'the Issues index is rebuilt and still lists the remaining issue');

    group('a path swapped for a symbolic link after the list was made is refused');
    const sw = mkIssue(iid(5), '2026-01-01T00:00:00Z'); const ps = cl.plan({ now: NOW });
    ok(ps.issues.some(i => i.id === iid(5)), 'control: it is a candidate');
    fs.rmSync(sw, { recursive: true }); fs.symlinkSync(VICTIM, sw);
    r = await cl.apply(ps, { confirm: async () => true });
    ok(r.removed.length === 0 && r.failed.some(f => /refused/.test(f.reason)) && fs.existsSync(path.join(VICTIM, 'precious.txt')), 'the swapped folder is refused at deletion time and the symlink target is intact');
    fs.unlinkSync(sw);

    group('refusing unsafe folders');
    const keep = process.env.PLUGIN_GUARD_ISSUES;
    process.env.PLUGIN_GUARD_ISSUES = '/'; let e1 = null; try { cl.plan({}); } catch (x) { e1 = x; } ok(e1 && /too broad/.test(e1.message), 'an issues folder of "/" is refused');
    process.env.PLUGIN_GUARD_ISSUES = os.homedir(); let e2 = null; try { cl.plan({}); } catch (x) { e2 = x; } ok(e2 && /too broad/.test(e2.message), 'the home folder as issues folder is refused');
    const linkRoot = path.join(tmp, 'issues-link'); fs.symlinkSync(ISS, linkRoot); process.env.PLUGIN_GUARD_ISSUES = linkRoot; let e3 = null; try { cl.plan({}); } catch (x) { e3 = x; } ok(e3 && /symbolic link/.test(e3.message), 'an issues folder that is itself a symbolic link is refused');
    process.env.PLUGIN_GUARD_ISSUES = keep;

    group('sandboxes: leftovers go, live ones and unlabelled Docker resources stay');
    const live = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)']);
    const sDead = mkSandbox(iid(6), 'pgsbdead0006', 999999), sLive = mkSandbox(iid(7), 'pgsblive0007', live.pid);
    fs.writeFileSync(path.join(FD, 'fake.state.json'), JSON.stringify({ containers: [{ id: 'c-dead', labels: L('pgsbdead0006') }, { id: 'c-live', labels: L('pgsblive0007') }, { id: 'c-user', labels: {} }], volumes: [{ name: 'v-dead', labels: L('pgsbdead0006') }, { name: 'v-user', labels: {} }], networks: [] }));
    fs.mkdirSync(path.join(SBX, 'not-a-sandbox')); fs.symlinkSync(VICTIM, path.join(SBX, iid(8)));
    const ps2 = cl.plan({ issues: false });
    ok(ps2.sandboxes.map(s => s.id).join() === iid(6) && ps2.skipped.some(s => /still running/.test(s.reason)) && ps2.skipped.some(s => /not-a-sandbox/.test(s.path)) && ps2.skipped.some(s => s.path.endsWith(iid(8)) && /symbolic link/.test(s.reason)), 'only the sandbox whose owner is gone is a candidate; a live one, a foreign folder and a symlink are skipped');
    r = await cl.apply(ps2, { confirm: async () => true, sandboxOptions: sbOpts });
    const st = fakeState();
    ok(r.removed.length === 1 && !fs.existsSync(sDead) && fs.existsSync(sLive), 'the dead sandbox folder is removed, the live one stays');
    ok(!st.containers.some(c => c.id === 'c-dead') && !st.volumes.some(v => v.name === 'v-dead') && st.containers.some(c => c.id === 'c-live') && st.containers.some(c => c.id === 'c-user') && st.volumes.some(v => v.name === 'v-user'), 'its labelled containers and volumes are removed; the live sandbox\'s and the user\'s unlabelled ones are untouched');
    ok(fs.existsSync(path.join(VICTIM, 'precious.txt')), 'the symlink target is intact');
    live.kill();

    group('the command');
    const run = (...a) => spawnSync(process.execPath, [path.join(__dirname, 'guard.js'), 'issue', 'cleanup', ...a], { encoding: 'utf8', env: { ...process.env, PLUGIN_GUARD_ISSUES: ISS, PLUGIN_GUARD_SANDBOXES: SBX }, stdio: ['ignore', 'pipe', 'pipe'] });
    mkIssue(iid(9), '2026-01-01T00:00:00Z');
    const dry = run('--older-than-days', '30', '--no-sandboxes');
    ok(dry.status === 0 && /Cleanup candidates/.test(dry.stdout) && /Nothing was deleted: there is no terminal to ask on/.test(dry.stdout) && fs.existsSync(path.join(ISS, iid(9))), 'without a terminal and without --yes the command lists and deletes nothing');
    const bad = run('../victim');
    ok(bad.status !== 0 && /not an issue id/.test(bad.stdout + bad.stderr) && fs.existsSync(path.join(VICTIM, 'precious.txt')), 'a path-like argument is refused');
    const yes = run('--older-than-days', '30', '--no-sandboxes', '--yes');
    ok(yes.status === 0 && /removed  issue/.test(yes.stdout) && !fs.existsSync(path.join(ISS, iid(9))) && fs.existsSync(path.join(VICTIM, 'precious.txt')), 'with --yes it removes the old issue and nothing else');

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(failures ? `\n${failures} FAILED` : '\nAll checks passed');
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
