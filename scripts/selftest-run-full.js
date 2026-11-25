#!/usr/bin/env node
// Self-test of scripts/run-full.sh --dry-run (the H-move step): the snapshot of the working tree is taken with a SEPARATE temporary git index (the repository's own index is
// never touched), it leaves out run-logs/, issues/ and plugin-guard-reports/ even when .gitignore does not list them (the second guard), a wrong
// run-logs/docker-baseline.txt changes nothing (BASE in the script is the only authority), the log goes into run-logs/<label>/ (or PG_RUN_LOGS), PG_TIMED=1 puts a time
// in front of every log line, a second run is refused while one holds the lock, and a bad option is refused.
// The script is run from a COPY inside a throw-away git repository, so the real repository is not used. No Docker, no network, no npm test: the dry run runs only a tiny check.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pg-rf-')));
let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const group = t => console.log(`\n== ${t}`);
const SCRIPT = path.join(__dirname, 'run-full.sh');
const CANARY = 'canary-client-host.example';
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', timeout: 120000, ...opts });
const write = (root, rel, text) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
const rd = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };

// a throw-away repository that looks like the real one as far as the script needs it
function makeRepo(name, { ignoreFolders = true } = {}) {
    const repo = path.join(tmp, name);
    fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
    fs.copyFileSync(SCRIPT, path.join(repo, 'scripts', 'run-full.sh')); fs.chmodSync(path.join(repo, 'scripts', 'run-full.sh'), 0o755);
    write(repo, 'package.json', JSON.stringify({ name: 'fixture', scripts: { 'selftest:hygiene': 'node -e "console.log(\'PASS  tiny check\')"' } }));
    write(repo, 'lib/real-file.js', '// a real file\n'); write(repo, 'data/ocr/.keep', ''); fs.mkdirSync(path.join(repo, 'node_modules'), { recursive: true }); write(repo, 'node_modules/.keep', '');
    write(repo, '.gitignore', ignoreFolders ? 'node_modules/\nrun-logs/\nissues/\nplugin-guard-reports/\n' : 'node_modules/\n');
    sh('git', ['init', '-q'], { cwd: repo }); sh('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'add', 'package.json', 'lib', 'scripts', 'data', '.gitignore'], { cwd: repo });
    sh('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'fixture'], { cwd: repo });
    // client data and logs that must never reach a snapshot (a canary address inside)
    write(repo, 'issues/iss-1/issue.json', `{"url":"https://${CANARY}/"}`); write(repo, 'plugin-guard-reports/r.md', `report of ${CANARY}`); write(repo, 'run-logs/old/test.log', `log of ${CANARY}`);
    write(repo, 'untracked-new-file.txt', 'a new file that is not added\n');
    return repo;
}
const walk = (d, out = []) => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n), st = fs.lstatSync(p); if (n === 'node_modules') continue; if (st.isDirectory()) walk(p, out); else out.push(p); } return out; };
const run = (repo, label, args = [], env = {}, cwd = tmp) => sh('bash', [path.join(repo, 'scripts', 'run-full.sh'), label, ...args], { cwd, env: (() => { const e = { ...process.env, ...env }; for (const k of ['PG_RUN_LOGS', 'PG_TIMED']) if (!(k in env)) delete e[k]; return e; })() });   // a PG_RUN_LOGS or PG_TIMED of the person who starts this suite must not reach the fixture runs

(async () => {
    group('a dry run in a throw-away repository (.gitignore lists the folders)');
    const repo = makeRepo('repo1');
    write(repo, 'run-logs/docker-baseline.txt', 'containers=99 labelled=9 volumes=99\n');   // a WRONG file: it must change nothing
    const idx = path.join(repo, '.git', 'index'), before = rd(idx) ? require('crypto').createHash('sha256').update(fs.readFileSync(idx)).digest('hex') : '';
    const statusBefore = sh('git', ['status', '--porcelain'], { cwd: repo }).stdout;
    const r = run(repo, 'dry1', ['--dry-run'], { PG_TIMED: '1' });
    const RUN = path.join(repo, 'run-logs', 'dry1');
    ok(r.status === 0 && /DRY-RUN OK/.test(rd(path.join(RUN, 'result.txt'))), `the dry run ends with exit 0 and "DRY-RUN OK" (exit ${r.status}: ${rd(path.join(RUN, 'result.txt')).trim().slice(0, 100)})`);
    const files = walk(path.join(RUN, 'tree')).map(f => path.relative(path.join(RUN, 'tree'), f));
    ok(files.includes('lib/real-file.js') && files.includes('untracked-new-file.txt') && files.includes('scripts/run-full.sh'), 'the snapshot holds the tracked files and the new untracked file (the working tree, not only the last commit)');
    ok(!files.some(f => /^(issues|plugin-guard-reports|run-logs)\//.test(f)) && !files.some(f => rd(path.join(RUN, 'tree', f)).includes(CANARY)), 'the snapshot holds no issues/, plugin-guard-reports/ or run-logs/ and no file with the canary client address');
    const after = require('crypto').createHash('sha256').update(fs.readFileSync(idx)).digest('hex');
    ok(before === after && sh('git', ['status', '--porcelain'], { cwd: repo }).stdout === statusBefore && /\?\? untracked-new-file\.txt/.test(statusBefore), 'the repository\'s own git index is byte for byte the same and the new file is still untracked (a SEPARATE temporary index was used)');
    ok(!fs.existsSync(path.join(RUN, 'index.tmp')), 'the temporary index file is removed');
    const log = rd(path.join(RUN, 'test.log')).split('\n').filter(Boolean);
    const body = log.filter(l => !/^test exit \d+$/.test(l));   // the closing "test exit N" line is written by the script itself, without a time
    ok(body.length >= 1 && body.every(l => /^\d\d:\d\d:\d\d /.test(l)) && log[log.length - 1] === 'test exit 0', 'PG_TIMED=1: every line of the test output in test.log starts with the time');
    ok(/docker before: containers\/labelled\/volumes = .* \(baseline 5 0 11\)/.test(rd(path.join(RUN, 'progress.txt'))), 'the baseline shown is the constant 5 0 11 (the real proof that a baseline file decides nothing is in the real-run group below)');
    ok(fs.existsSync(path.join(repo, 'run-logs', '.run-full.lock')), 'the lock file is inside run-logs/');

    group('the second guard: the folders are left out although .gitignore does not list them');
    const repo2 = makeRepo('repo2', { ignoreFolders: false });
    const r2 = run(repo2, 'dry2', ['--dry-run']);
    const files2 = walk(path.join(repo2, 'run-logs', 'dry2', 'tree')).map(f => path.relative(path.join(repo2, 'run-logs', 'dry2', 'tree'), f));
    ok(r2.status === 0 && !files2.some(f => /^(issues|plugin-guard-reports|run-logs)\//.test(f)) && !files2.some(f => rd(path.join(repo2, 'run-logs', 'dry2', 'tree', f)).includes(CANARY)), 'with a .gitignore that lists none of them, the snapshot still has no issues/, plugin-guard-reports/ or run-logs/');

    group('PG_RUN_LOGS, the options, the lock');
    const repo3 = makeRepo('repo3'), other = path.join(tmp, 'elsewhere');
    const r3 = run(repo3, 'dry3', ['--dry-run'], { PG_RUN_LOGS: other });
    ok(r3.status === 0 && fs.existsSync(path.join(other, 'dry3', 'result.txt')) && !fs.existsSync(path.join(repo3, 'run-logs', 'dry3')), 'PG_RUN_LOGS puts the logs in another folder');
    const dots = run(repo3, '..', ['--dry-run']), dot = run(repo3, '.', ['--dry-run']);
    ok(dots.status === 2 && dot.status === 2 && !fs.existsSync(path.join(repo3, 'run-logs', 'result.txt')) && !fs.existsSync(path.join(repo3, 'tree')), 'a label that is only dots (. or ..) is refused (it would make the run folder the repository itself)');
    const bad = run(repo3, 'x', ['--nonsense']), noLabel = sh('bash', [path.join(repo3, 'scripts', 'run-full.sh')], { cwd: tmp }), badLabel = run(repo3, 'a b');
    ok(bad.status === 2 && /unknown option/.test(bad.stderr) && noLabel.status === 2 && badLabel.status === 2, 'an unknown option, a missing label and a bad label are refused (exit 2)');
    // the lock: hold it from another process, then start a run
    const ready = path.join(tmp, 'lock-ready');
    const holder = spawn('bash', ['-c', `exec 9>"${path.join(repo3, 'run-logs', '.run-full.lock')}"; flock -n 9 && touch "${ready}" && sleep 8`], { stdio: 'ignore' });
    for (let i = 0; i < 100 && !fs.existsSync(ready); i++) await new Promise(res => setTimeout(res, 50));   // wait for the holder's signal, not for a fixed time
    const locked = run(repo3, 'dry-lock', ['--dry-run']);
    ok(locked.status === 3 && /another run-full\.sh is running/.test(locked.stderr), `a run is refused while another one holds the lock (exit ${locked.status})`);
    holder.kill();
    ok(!/pg-runs/.test(fs.readFileSync(SCRIPT, 'utf8').replace(/^#.*$/gm, '')), 'the script no longer uses a folder outside the repository (no "pg-runs" in its code)');

    group('the dry run says NOT OK (and exits 1) when the snapshot is not clean');
    const repo4 = makeRepo('repo4', { ignoreFolders: false });
    write(repo4, 'dump.sql', '-- a database dump that a bad .gitignore let into the working tree\n');
    const r4 = run(repo4, 'dry4', ['--dry-run']);
    ok(r4.status === 1 && /DRY-RUN NOT OK:.*secrets-or-dumps/.test(rd(path.join(repo4, 'run-logs', 'dry4', 'result.txt'))), `a database dump in the snapshot: "DRY-RUN NOT OK ... secrets-or-dumps" and exit 1 (exit ${r4.status})`);

    group('the log folder: absolute, and not inside the repository except run-logs/');
    const repo5 = makeRepo('repo5');
    const startDir = path.join(tmp, 'start'); fs.mkdirSync(startDir);
    const rel = run(repo5, 'dry5', ['--dry-run'], { PG_RUN_LOGS: 'relative-logs' }, startDir);
    ok(rel.status === 0 && fs.existsSync(path.join(startDir, 'relative-logs', 'dry5', 'result.txt')) && !fs.existsSync(path.join(repo5, 'relative-logs')), 'a relative PG_RUN_LOGS is made absolute (it is resolved from the folder the script was started in, not from the repository)');
    const inRepo = run(repo5, 'dry6', ['--dry-run'], { PG_RUN_LOGS: path.join(repo5, 'my-logs') }), holdRepo = run(repo5, 'dry7', ['--dry-run'], { PG_RUN_LOGS: tmp });
    ok(inRepo.status === 2 && /must not be inside the repository/.test(inRepo.stderr) && holdRepo.status === 2 && /must not hold the repository/.test(holdRepo.stderr), 'a log folder inside the repository (other than run-logs/), or one that holds the repository, is refused (exit 2)');
    ok(!fs.existsSync(path.join(repo5, 'my-logs')), 'a refused folder is not created inside the repository');
    fs.symlinkSync(path.join(repo5, 'lib'), path.join(tmp, 'link-into-repo'));
    const viaLink = run(repo5, 'dry8', ['--dry-run'], { PG_RUN_LOGS: path.join(tmp, 'link-into-repo') }), viaRoot = run(repo5, 'dry9', ['--dry-run'], { PG_RUN_LOGS: '/' });
    ok(viaLink.status === 2 && /must not be inside the repository/.test(viaLink.stderr) && !fs.existsSync(path.join(repo5, 'lib', 'dry8')) && viaRoot.status === 2 && /must not hold the repository/.test(viaRoot.stderr), 'a symbolic link that points into the repository, and the folder /, are refused (exit 2), and nothing is written through the link');

    group('the real run: the Docker check (a fake docker program on the PATH; no real Docker is used)');
    const bin = path.join(tmp, 'bin'); fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/bash
n() { local i; for ((i=0;i<$1;i++)); do echo "id$i"; done; }
case "$*" in
  "ps -aq") n "\${FAKE_C:-5}";;
  "ps -aq --filter label=pg.sandbox=1") n "\${FAKE_L:-0}";;
  "volume ls -q") n "\${FAKE_V:-11}";;
esac
`); fs.chmodSync(path.join(bin, 'docker'), 0o755);
    const withFake = env => ({ PATH: `${bin}:${process.env.PATH}`, ...env });
    const repo8 = makeRepo('repo8'); write(repo8, 'package.json', JSON.stringify({ name: 'fixture', scripts: { test: 'node -e "console.log(\'PASS  fixture test\')"', 'selftest:hygiene': 'node -e ""' } }));
    sh('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qam', 'test script'], { cwd: repo8 });
    const good = run(repo8, 'real-ok', [], withFake({}));
    ok(good.status === 0 && /^run VALID/.test(rd(path.join(repo8, 'run-logs', 'real-ok', 'result.txt'))) && /test exit 0/.test(rd(path.join(repo8, 'run-logs', 'real-ok', 'test.exit'))), `a real run with the Docker state at the baseline is VALID (the snapshot's npm test ran): ${rd(path.join(repo8, 'run-logs', 'real-ok', 'result.txt')).trim().slice(0, 60)}`);
    write(repo8, 'run-logs/docker-baseline.txt', 'containers=6 labelled=0 volumes=11\n');   // a file that SAYS the state is fine: it must not decide anything
    const off = run(repo8, 'real-off', [], withFake({ FAKE_C: '6' }));
    ok(off.status === 3 && /not the baseline/.test(off.stderr) && /run NOT started/.test(rd(path.join(repo8, 'run-logs', 'real-off', 'result.txt'))) && !fs.existsSync(path.join(repo8, 'run-logs', 'real-off', 'tree')), 'a Docker state that is not the baseline stops a real run (exit 3, nothing run), also when run-logs/docker-baseline.txt says that state is fine');
    write(repo8, 'run-logs/env.sh', 'BASE="6 0 11"; DRY=1\n');   // an env.sh that tries to change the baseline and to turn the run into a dry run
    const hack = run(repo8, 'real-env', [], withFake({ FAKE_C: '6' }));
    ok(hack.status === 3 && /not the baseline/.test(hack.stderr) && !/DRY-RUN/.test(rd(path.join(repo8, 'run-logs', 'real-env', 'result.txt'))), 'an env.sh that sets BASE or DRY cannot change the baseline or make the run a dry run (it is read only inside the subshell that runs the tests)');
    write(repo8, 'run-logs/env.sh', 'readonly BASE="6 0 11"; declare -r DRY=1\ndocker() { echo fake; }\nexport PG_SEEDED_TEST_VAR=from-env-sh\n');   // the harder tricks: readonly, a function named docker
    const hack2 = run(repo8, 'real-env2', [], withFake({ FAKE_C: '6' }));
    ok(hack2.status === 3 && /not the baseline/.test(hack2.stderr) && !/DRY-RUN/.test(rd(path.join(repo8, 'run-logs', 'real-env2', 'result.txt'))), 'an env.sh with "readonly BASE", "declare -r DRY" and a function named docker still cannot change the baseline, the mode or the Docker check');
    write(repo8, 'package.json', JSON.stringify({ name: 'fixture', scripts: { test: 'node -e "console.log(process.env.PG_SEEDED_TEST_VAR === \'from-env-sh\' ? \'PASS  env.sh variable seen by the tests\' : \'FAIL  not seen\'); process.exit(process.env.PG_SEEDED_TEST_VAR === \'from-env-sh\' ? 0 : 1)"', 'selftest:hygiene': 'node -e ""' } }));
    sh('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qam', 'env test'], { cwd: repo8 });
    write(repo8, 'run-logs/env.sh', 'export PG_SEEDED_TEST_VAR=from-env-sh\n');
    write(repo8, 'run-logs/env.sh', 'exit 0\n');   // a common last line: the shell ends before the tests start
    const ex = run(repo8, 'real-exit', [], withFake({}));
    ok(ex.status === 0 && /^run NOT valid: test exit 97/.test(rd(path.join(repo8, 'run-logs', 'real-exit', 'result.txt'))), `an env.sh that ends the shell ("exit 0") cannot make a run VALID: the tests did not start (${rd(path.join(repo8, 'run-logs', 'real-exit', 'result.txt')).trim().slice(0, 60)})`);
    write(repo8, 'run-logs/env.sh', 'npm() { echo "PASS  a fake npm"; return 0; }\nexport PG_SEEDED_TEST_VAR=from-env-sh\n');   // a function that pretends to be npm
    const fn = run(repo8, 'real-npm', [], withFake({}));
    ok(/PASS  env.sh variable seen by the tests/.test(rd(path.join(repo8, 'run-logs', 'real-npm', 'test.log'))) && !/a fake npm/.test(rd(path.join(repo8, 'run-logs', 'real-npm', 'test.log'))), 'a function named npm in env.sh is not used: the real npm runs the tests (command npm)');
    write(repo8, 'run-logs/env.sh', 'export PG_SEEDED_TEST_VAR=from-env-sh\n');
    const seen = run(repo8, 'real-env3', [], withFake({}));
    ok(seen.status === 0 && /^run VALID/.test(rd(path.join(repo8, 'run-logs', 'real-env3', 'result.txt'))) && /PASS  env.sh variable seen by the tests/.test(rd(path.join(repo8, 'run-logs', 'real-env3', 'test.log'))), 'the variables an env.sh exports ARE seen by the tests (that is what the file is for)');

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll run-full checks passed');
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } process.exit(1); });
