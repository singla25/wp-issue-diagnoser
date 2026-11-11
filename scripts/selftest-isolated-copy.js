#!/usr/bin/env node
// Step 9, isolation: src/plugin-guard ALONE (copied to a clean temp folder outside the repository, without the other modules of the
// repository or the root package.json) installs and runs. This file reads nothing outside src/plugin-guard except the root package.json
// (the guard:test list), .gitignore and the git file list; the check that src/combined's paths into this package resolve is in the root
// scripts/selftest-repo.js.
//   1. inside the repository the report folders are EXACTLY as before (reports/plugin-guard, reports/runs); a copy on its own uses
//      plugin-guard-reports/ next to the package code, never the current folder
//   2. the copy is built from `git ls-files -co --exclude-standard` restricted to src/plugin-guard, never with issues/, sandboxes/,
//      reports/, projects/, node_modules/ (they hold real site copies and client records), in os.tmpdir(), removed afterwards
//   3. no file of the copy points above the package (so no path to another module or a repository file), except the pinned files below
//   4. in the copy: npm ci (no network: a loud SKIP, then a real copy of the installed packages), the OCR command and what it needs exist
//      (nothing is downloaded), doctor, guard:setup-sandbox --check (it only QUERIES Docker for the pinned images: nothing is pulled or
//      started), `issue new` + `issue investigate` and the plain wizard (no test copy, no Docker) on a fixture site, then every non-Docker
//      suite of guard:test that can run alone; every SKIP line a suite prints in the copy must be one of the pinned SKIP_LINES
// The Docker suites are NOT re-run in the copy (the full run covers them in the repository). The non-portable suites are skipped,
// loudly, and their list is pinned BY NAME here: a suite that becomes portable, or a new suite, must be placed in a list on purpose.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const PG = path.join(__dirname, '..');
const layout = require('../lib/repo-layout');
const REPO = layout.repoRoot();

// ---- the pinned lists (names as in the root package.json guard:test, without "guard:selftest:") ----
// need the Docker daemon and real containers: not re-run in the copy
const DOCKER = ['issue-sandbox-docker', 'issue-resolve-docker', 'issue-verify-docker', '6a-docker', '6b-docker', '6c1-docker', '6c2-docker', '6d1-docker', '6d2-docker'];
// read something that is not part of src/plugin-guard: skipped in the copy, with the reason
const NON_PORTABLE = {
    'issue-evidence': 'needs the OCR language file data/ocr/eng.traineddata, which is git-ignored and is NOT downloaded in the copy (npm run guard:setup-ocr)',
    'issue-sandbox': 'reads the repository CLAUDE.md (the sandbox exception must be stated there)',
    'checkpoints': 'reads docs/COVERAGE.md (data/checkpoints.json is generated from it; gen-checkpoints --check is not run either)',
    'isolated-copy': 'this suite itself (it builds the copy)',
};
// the ONLY SKIP lines a suite may print in the copy (suite -> the line's start); any other SKIP line FAILS, and each of these must appear
const SKIP_LINES = {
    hygiene: 'SKIP  .gitignore checks: this is a copy of src/plugin-guard on its own',                 // selftest-hygiene.js: the repository .gitignore
    'case-file': 'SKIP  not inside a git work tree: the validate.js unmodified check did not run',     // selftest-case-file.js: git
    '6d2': 'SKIP  validate.js / retest.js / fatal-recheck.js unmodified: git is not available here',  // selftest-6d2.js: git
    'issue-seeded': 'SKIP  PG_REAL_SITE / PG_REAL_PLUGIN are not set',                                 // never pointed at a real site from the copy
};
// files of the package that point above it, on purpose; anything else that does FAILS (section 4)
const ABOVE_PACKAGE = {
    'lib/repo-layout.js': 'checks whether the folder two levels up holds this very package (nothing is read from there)',
    'scripts/gen-checkpoints.js': 'docs/COVERAGE.md (non-portable: guard:checkpoints)',
    'scripts/selftest-issue-sandbox.js': 'CLAUDE.md (non-portable suite)',
    'scripts/selftest-case-file.js': 'the git work tree around the package (skips itself, loudly, outside a work tree)',
    'scripts/selftest-6c2.js': 'declares REPO (two levels up) and never uses it',
};
const EXCLUDED_TOP = ['issues', 'sandboxes', 'reports', 'projects', 'node_modules', 'state', layout.FALLBACK];

let failures = 0, skips = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; return c; };
const skip = m => { console.log(`SKIP  ${m}`); skips++; };
const group = t => console.log(`\n== ${t}`);
const inside = (parent, child) => { const r = path.relative(parent, child); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };
const childEnv = extra => {
    const env = { ...process.env, NO_COLOR: '1', ...extra };
    for (const k of Object.keys(env)) if (/^(PG_REAL_|PLUGIN_GUARD_|PG_PROBE_COOLDOWN_FILE$)/.test(k) && !(k in (extra || {}))) delete env[k];
    return env;
};

if (!REPO) {
    console.log('SKIP  this is not the repository (src/plugin-guard is on its own here): the isolated copy is built from the repository only');
    process.exit(0);
}

// ================================================================ 1. report folders
group('1. report folders: unchanged inside the repository, next to the code in a copy on its own');
{
    const saved = { r: process.env.PLUGIN_GUARD_REPORTS, u: process.env.PLUGIN_GUARD_RUNS };
    delete process.env.PLUGIN_GUARD_REPORTS; delete process.env.PLUGIN_GUARD_RUNS;
    const project = require('../lib/project'), runs = require('../lib/runs');
    const repo = path.join(__dirname, '..', '..', '..');
    ok(project.reportsRoot() === path.join(repo, 'reports', 'plugin-guard'), `inside the repository the classic reports stay in reports/plugin-guard (${path.relative(repo, project.reportsRoot())})`);
    ok(runs.runsRoot() === path.join(repo, 'reports', 'runs'), `inside the repository the runs stay in reports/runs (${path.relative(repo, runs.runsRoot())})`);
    ok(path.resolve(REPO) === path.resolve(repo) && layout.reportsBase() === path.join(repo, 'reports'), 'lib/repo-layout.js finds the repository that holds this package');
    process.env.PLUGIN_GUARD_REPORTS = '/x/r'; process.env.PLUGIN_GUARD_RUNS = '/x/u';
    ok(project.reportsRoot() === '/x/r' && runs.runsRoot() === '/x/u', 'PLUGIN_GUARD_REPORTS and PLUGIN_GUARD_RUNS still win');
    for (const [k, v] of [['PLUGIN_GUARD_REPORTS', saved.r], ['PLUGIN_GUARD_RUNS', saved.u]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    const t = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pg-layout-')));
    const lone = path.join(t, 'pkg'); fs.mkdirSync(lone);
    const fake = path.join(t, 'other', 'src', 'plugin-guard'); fs.mkdirSync(fake, { recursive: true });
    const twin = path.join(t, 'other', 'src', 'plugin-guard-twin'); fs.mkdirSync(twin);
    ok(layout.repoRoot(lone) === null && layout.reportsBase(lone) === path.join(lone, 'plugin-guard-reports'), 'a package on its own: plugin-guard-reports/ next to the package code');
    ok(layout.reportsBase(lone) !== path.join(process.cwd(), 'plugin-guard-reports') && !inside(process.cwd(), layout.reportsBase(lone)), 'not the current folder');
    ok(layout.repoRoot(fake) === path.join(t, 'other') && layout.repoRoot(twin) === null, 'only a folder whose src/plugin-guard IS this package counts as the repository (a different package next to one does not)');
    fs.rmSync(t, { recursive: true, force: true });
    const gi = fs.readFileSync(path.join(REPO, '.gitignore'), 'utf8').split('\n').map(l => l.trim());
    ok(gi.includes('src/plugin-guard/plugin-guard-reports/') && gi.includes('plugin-guard-reports/'), '.gitignore keeps plugin-guard-reports/ out (next to the code, and the older ./plugin-guard-reports)');
}

// ================================================================ 2. the copy
group('2. the copy: git-listed files of src/plugin-guard only, in a temp folder outside the repository');
// The file list: `git ls-files -co --exclude-standard` when the repository is a git work tree. The full run (scripts/run-full.sh) works on a
// `git archive` snapshot of exactly that list, with no .git: there the snapshot's own files are listed, minus what .gitignore keeps out
// inside src/plugin-guard (node_modules/, the OCR language file, logs, .env files) that run-full.sh puts back next to them. Said loudly.
const gitTop = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: REPO, encoding: 'utf8' });
const isWorkTree = !gitTop.error && gitTop.status === 0 && fs.realpathSync(gitTop.stdout.trim()) === fs.realpathSync(REPO);
let listed;
if (isWorkTree) {
    const git = spawnSync('git', ['ls-files', '-co', '--exclude-standard', '-z', '--', 'src/plugin-guard'], { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    ok(!git.error && git.status === 0, `git ls-files -co --exclude-standard lists src/plugin-guard (exit ${git.status})`);
    listed = String(git.stdout || '').split('\0').filter(Boolean).map(f => f.slice('src/plugin-guard/'.length));
} else {
    console.log('SKIP  not a git work tree (a git-archive snapshot of the full run): the file list is the snapshot\'s own src/plugin-guard, minus node_modules/, logs, .env files and the OCR language file (what .gitignore keeps out)'); skips++;
    const IGNORED = rel => rel.split('/').includes('node_modules') || /(^|\/)(\.env(\..*)?|\.DS_Store)$|\.log$/.test(rel) && !/(^|\/)\.env\.example$/.test(rel) || /^data\/ocr\/.*\.(traineddata|part)$/.test(rel);
    listed = [];
    (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) { const f = path.join(d, e.name), rel = path.relative(PG, f).split(path.sep).join('/'); if (e.isDirectory()) { if (!(d === PG && EXCLUDED_TOP.includes(e.name)) && e.name !== 'node_modules') walk(f); } else if (!IGNORED(rel)) listed.push(rel); } })(PG);
}
const take = listed.filter(rel => !EXCLUDED_TOP.includes(rel.split('/')[0]));
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pg-isolated-')));
const COPY = path.join(TMP, 'plugin-guard');
let cleaned = false;
const cleanup = () => { if (!cleaned) { cleaned = true; try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } } };
process.on('exit', cleanup);
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { cleanup(); process.exit(130); });

let links = 0;
for (const rel of take) {
    const src = path.join(PG, rel), dst = path.join(COPY, rel);
    let st; try { st = fs.lstatSync(src); } catch { continue; }   // listed but deleted in the work tree
    if (st.isSymbolicLink()) { links++; continue; }
    if (!st.isFile()) continue;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst); fs.chmodSync(dst, st.mode & 0o777);
}
const top = fs.readdirSync(COPY).sort();
ok(!inside(REPO, TMP) && !inside(TMP, REPO), `the copy is in ${os.tmpdir()}, outside the repository`);
ok(take.length > 200 && take.length < listed.length + 1 && fs.existsSync(path.join(COPY, 'package.json')) && fs.existsSync(path.join(COPY, 'package-lock.json')), `${take.length} files copied from git ls-files -co --exclude-standard (src/plugin-guard only)${links ? `, ${links} symbolic link(s) left out` : ''}`);
ok(EXCLUDED_TOP.every(d => !top.includes(d)) && listed.filter(rel => EXCLUDED_TOP.includes(rel.split('/')[0])).every(rel => !fs.existsSync(path.join(COPY, rel))), `no ${EXCLUDED_TOP.slice(0, 5).join('/, ')}/ (real site copies, client records) and no state/ or plugin-guard-reports/ in the copy`);
ok(JSON.stringify(fs.readdirSync(TMP)) === JSON.stringify(['plugin-guard']), 'nothing around it: no root package.json, no src/, no other module, no CLAUDE.md (the temp folder holds only plugin-guard/)');
ok(layout.repoRoot(COPY) === null && layout.reportsBase(COPY) === path.join(COPY, 'plugin-guard-reports'), 'the copy knows it is on its own: its classic reports go to plugin-guard-reports/ next to its code');
{
    const r = spawnSync(process.execPath, ['-e', "const p=require('./lib/project'),r=require('./lib/runs');console.log(JSON.stringify([p.reportsRoot(),r.runsRoot()]))"], { cwd: COPY, encoding: 'utf8', env: childEnv() });
    let got = null; try { got = JSON.parse(r.stdout); } catch { /* none */ }
    ok(got && got[0] === path.join(COPY, 'plugin-guard-reports', 'plugin-guard') && got[1] === path.join(COPY, 'plugin-guard-reports', 'runs'), `in the copy: reportsRoot and runsRoot are under plugin-guard-reports/ next to the code (${got ? got.map(x => path.relative(COPY, x)).join(', ') : r.stderr.trim().split('\n')[0]})`);
}

// ================================================================ 3. nothing points out of the package
group('3. no file of the copy points above the package (another module, a repository file)');
{
    const files = [];
    (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) { const f = path.join(d, e.name); if (e.isDirectory()) { if (e.name !== 'node_modules') walk(f); } else if (/\.(js|json|sh)$/.test(e.name) && e.name !== 'package-lock.json') files.push(f); } })(COPY);
    const SELF = 'scripts/selftest-isolated-copy.js';
    const above = [];
    for (const f of files) {
        const rel = path.relative(COPY, f).split(path.sep).join('/'); if (rel === SELF || rel === 'scripts/selftest-isolation-static.js') continue;
        const text = fs.readFileSync(f, 'utf8'), depth = rel.split('/').length - 1;
        text.split('\n').forEach((l, i) => {
            const climbs = [];
            for (const m of l.matchAll(/__dirname\s*((?:,\s*['"]\.\.['"]\s*)+)/g)) climbs.push((m[1].match(/\.\./g) || []).length);
            for (const m of l.matchAll(/\b(?:PG|PKG|pkg)\s*((?:,\s*['"]\.\.['"]\s*)+)/g)) climbs.push((m[1].match(/\.\./g) || []).length + depth);
            for (const m of l.matchAll(/(?:require|resolve)\(\s*['"]((?:\.\.\/)+)/g)) climbs.push(m[1].length / 3);
            if (climbs.some(n => n > depth)) above.push(rel);
        });
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(COPY, 'package.json'), 'utf8'));
    const pkgOut = Object.entries(pkg.scripts || {}).filter(([, v]) => /\.\.\/|src\/(frontend|combined)|--prefix/.test(v)).map(([k]) => k);
    const unexpected = [...new Set(above)].filter(f => !(f in ABOVE_PACKAGE)).sort(), stale = Object.keys(ABOVE_PACKAGE).filter(f => !above.includes(f));
    ok(unexpected.length === 0, `no file points above the package except the pinned ones (${Object.keys(ABOVE_PACKAGE).join(', ')}) (${unexpected.length}${unexpected.length ? ': ' + unexpected.join(' | ') : ''})`);
    ok(stale.length === 0, `the pinned list is not stale (${stale.join(', ') || 'each still points above the package'})`);
    ok(pkgOut.length === 0, `package.json scripts stay inside the package (${pkgOut.join(', ') || 'none leaves it'})`);
}

// ================================================================ 4. install and run in the copy
group('4. npm ci in the copy');
const run = (cmd, args, o = {}) => spawnSync(cmd, args, { cwd: COPY, encoding: 'utf8', timeout: o.timeout || 600000, maxBuffer: 64 * 1024 * 1024, env: childEnv(o.env), input: o.input === undefined ? '' : o.input });
{
    const ci = run('npm', ['ci', '--no-audit', '--no-fund', '--prefer-offline'], { timeout: 900000 });
    if (ci.status === 0) ok(fs.existsSync(path.join(COPY, 'node_modules', 'tesseract.js')) && fs.existsSync(path.join(COPY, 'node_modules', 'php-parser')), 'npm ci installed the locked packages in the copy');
    else {
        console.log('\n' + '!'.repeat(100));
        skip(`npm ci could not run in the copy (no network? exit ${ci.status}: ${String(ci.stderr || ci.error || '').trim().split('\n').slice(-1)[0]}). The install was NOT proven; a REAL copy of the installed packages is used instead so the rest still runs`);
        console.log('!'.repeat(100) + '\n');
        fs.cpSync(path.join(PG, 'node_modules'), path.join(COPY, 'node_modules'), { recursive: true, verbatimSymlinks: true });
    }
    ok(!fs.existsSync(path.join(COPY, 'data', 'ocr', 'eng.traineddata')), 'no OCR language file in the copy (nothing was downloaded)');
}

group('4b. the OCR command exists with what it needs (NOT run: nothing is downloaded)');
{
    const pkg = JSON.parse(fs.readFileSync(path.join(COPY, 'package.json'), 'utf8'));
    let tess = false; try { require.resolve('tesseract.js', { paths: [COPY] }); tess = true; } catch { /* missing */ }
    ok(pkg.scripts['setup-ocr'] === 'node scripts/setup-ocr.js' && ['scripts/setup-ocr.js', 'lib/ocr-data.js', 'data/ocr-pin.json'].every(f => fs.existsSync(path.join(COPY, f))), 'setup-ocr script, scripts/setup-ocr.js, lib/ocr-data.js and the SHA-256 pin data/ocr-pin.json are in the copy');
    ok(tess, 'tesseract.js (the OCR engine) resolves from the copy\'s own node_modules');
    const syn = run(process.execPath, ['--check', 'scripts/setup-ocr.js']);
    ok(syn.status === 0, 'scripts/setup-ocr.js parses');
}

group('4c. doctor and guard:setup-sandbox --check in the copy (read-only)');
{
    const d = run(process.execPath, ['scripts/guard.js', 'doctor'], { timeout: 180000 });
    const out = d.stdout + d.stderr;
    ok(d.status === 0 && /Plugin Guard prerequisites/.test(out) && /Packages: issue mode \(src\/plugin-guard\)/.test(out), `doctor runs in the copy (exit ${d.status})`);
    ok(!/src\/(?!plugin-guard\b)[a-z]+/.test(out) && !/Error: Cannot find module/.test(out), 'doctor names no other module under src/ and misses no module');
    const s = run(process.execPath, ['scripts/setup-sandbox.js', '--check'], { timeout: 180000 });
    ok([0, 2].includes(s.status) && !/\n\s+at .+:\d+:\d+\)?\n/.test(s.stdout + s.stderr), `guard:setup-sandbox --check runs (exit ${s.status}: ${s.status === 0 ? 'the pinned images are present' : String(s.stderr || s.stdout).trim().split('\n')[0]})`);
    console.log('NOTE  guard:setup-sandbox --check QUERIED Docker read-only (docker info and image inspect of the pinned images; nothing pulled, started or removed). No Docker suite was re-run in the copy.');
}

group('4d. issue new + issue investigate, and the plain wizard (no test copy, no Docker), on a fixture site');
{
    const trees = require(path.join(COPY, 'scripts', 'fixtures', 'issue', 'trees'));
    const work = path.join(TMP, 'work'); fs.mkdirSync(work);
    const hashTree = dir => { const h = crypto.createHash('sha256'); (function walk(d) { for (const n of fs.readdirSync(d).sort()) { const f = path.join(d, n), st = fs.lstatSync(f); h.update(`${path.relative(dir, f)}|${st.isDirectory() ? 'd' : st.size}|${st.mode}|${Math.round(st.mtimeMs)}\n`); if (st.isDirectory()) walk(f); else h.update(fs.readFileSync(f)); } })(dir); return h.digest('hex'); };
    const site = path.join(work, 'site'); const c = trees.duplicateFunction(site); fs.mkdirSync(path.join(site, 'wp-content', 'themes'), { recursive: true });
    const cfg = path.join(work, 'cfg.json'); fs.writeFileSync(cfg, JSON.stringify(c.config));
    const before = hashTree(site);
    const env = { PLUGIN_GUARD_ISSUES: path.join(work, 'issues') };
    const nw = run(process.execPath, ['scripts/guard.js', 'issue', 'new', '--title', 'Fixture problem', '--description', c.description, '--symptom', c.symptom, '--root', site, '--env', 'local', '--no-prompt'], { env });
    const id = /(iss-\d{8}-\d{6}-[0-9a-f]{6})/.exec(nw.stdout)?.[1];
    ok(nw.status === 0 && !!id, `issue new in the copy (exit ${nw.status}${id ? `, ${id}` : ''})`);
    const inv = id ? run(process.execPath, ['scripts/guard.js', 'issue', 'investigate', id, '--root', site, '--config', cfg, '--no-probe'], { env, timeout: 300000 }) : { status: null, stdout: '', stderr: '' };
    let f = null; try { f = JSON.parse(fs.readFileSync(path.join(work, 'issues', id, 'result', 'findings.json'), 'utf8')); } catch { /* none */ }
    ok(inv.status === 0 && f && f.hypotheses.length > 0 && f.hypotheses[0].status === 'CONFIRMED', `issue investigate in the copy writes findings.json; the duplicate function is ${f && f.hypotheses[0] ? f.hypotheses[0].status : 'not reported'} (exit ${inv.status})`);
    const out = path.join(work, 'wizard-out');
    const wz = run(process.execPath, ['scripts/plugin-guard.js', '--description', 'White screen: Cannot redeclare my_helper()', '--root', site, '--yes', '--no-replica', '--out', out], { env: { PLUGIN_GUARD_ISSUES: '' }, timeout: 300000 });
    const wid = fs.existsSync(out) ? fs.readdirSync(out).filter(n => /^iss-/.test(n)) : [];
    ok(wz.status === 0 && wid.length === 1 && fs.existsSync(path.join(out, wid[0], 'result', 'findings.json')) && fs.existsSync(path.join(out, wid[0], 'result', 'issue.html')), `the plain wizard (flags only, --no-replica) runs in the copy and writes its report into --out (exit ${wz.status})`);
    ok(hashTree(site) === before, 'the fixture site is byte-identical before and after');
    ok(!fs.existsSync(path.join(COPY, 'issues')) && !fs.existsSync(path.join(COPY, 'sandboxes')), 'nothing went into the copy\'s own issues/ or sandboxes/ (both runs were given a reports folder)');
}

group('4e. the non-Docker suites of guard:test, in the copy, one at a time');
{
    const root = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).scripts;
    const pkg = JSON.parse(fs.readFileSync(path.join(COPY, 'package.json'), 'utf8')).scripts;
    const names = root['guard:test'].split('&&').map(s => s.trim().replace(/^npm run /, ''));
    const mine = names.filter(n => /--prefix src\/plugin-guard run /.test(root[n] || '')).map(n => ({ name: n.replace(/^guard:selftest:?/, '') || 'selftest', script: root[n].replace(/^.*--prefix src\/plugin-guard run /, '').trim() }));
    const other = names.filter(n => !/--prefix src\/plugin-guard run /.test(root[n] || ''));
    const known = new Set(mine.map(x => x.name));
    const stale = [...DOCKER, ...Object.keys(NON_PORTABLE)].filter(n => !known.has(n));
    ok(names[names.length - 1] === 'guard:selftest:isolated-copy', 'this suite is the last one of guard:test');
    ok(stale.length === 0 && mine.every(x => pkg[x.script]), `the pinned Docker and non-portable lists name only guard:test suites of src/plugin-guard, and each has a script in the copy's package.json (${stale.join(', ') || 'none stale'})`);
    console.log(`\n${'!'.repeat(100)}\nNOT RE-RUN in the copy (Docker suites, ${DOCKER.length}): ${DOCKER.join(', ')}\nSKIPPED in the copy (non-portable, ${Object.keys(NON_PORTABLE).length}):`);
    for (const [n, why] of Object.entries(NON_PORTABLE)) console.log(`  - ${n}: ${why}`);
    console.log(`Not part of src/plugin-guard (run from the repository only, ${other.length}): ${other.join(', ')}\n${'!'.repeat(100)}`);
    skips += DOCKER.length + Object.keys(NON_PORTABLE).length;
    const todo = mine.filter(x => !DOCKER.includes(x.name) && !(x.name in NON_PORTABLE));
    let passLines = 0; const failed = [], skipLines = [];
    for (const x of todo) {
        const t0 = Date.now();
        const r = run('npm', ['run', '-s', x.script], { timeout: 1200000 });
        const text = `${r.stdout}${r.stderr}`;
        const p = (text.match(/^PASS/gm) || []).length, fl = (text.match(/^FAIL/gm) || []).length; passLines += p;
        if (r.status !== 0) failed.push(x.name);
        for (const l of text.split('\n').filter(l => /^SKIP\b/.test(l))) skipLines.push({ suite: x.name, line: l });
        ok(r.status === 0, `${x.name} in the copy (exit ${r.status}, ${p} PASS, ${fl} FAIL, ${Math.round((Date.now() - t0) / 1000)} s)`);
        if (r.status !== 0) console.log(text.split('\n').filter(l => /^FAIL|Error/.test(l)).slice(0, 5).map(l => `      ${l.slice(0, 200)}`).join('\n'));
    }
    const unpinned = skipLines.filter(x => !(SKIP_LINES[x.suite] && x.line.startsWith(SKIP_LINES[x.suite])));
    const missing = Object.entries(SKIP_LINES).filter(([n, start]) => !skipLines.some(x => x.suite === n && x.line.startsWith(start))).map(([n]) => n);
    for (const x of skipLines) console.log(`      ${x.suite}: ${x.line.slice(0, 160)}`);
    ok(unpinned.length === 0, `every SKIP line printed in the copy is pinned by name (${skipLines.length} seen${unpinned.length ? '; NOT pinned: ' + unpinned.map(x => `${x.suite}: ${x.line.slice(0, 90)}`).join(' | ') : ''})`);
    ok(missing.length === 0, `each pinned SKIP line appeared (${missing.length ? 'missing: ' + missing.join(', ') : Object.keys(SKIP_LINES).join(', ')})`);
    ok(todo.length >= 50 && failed.length === 0, `${todo.length} suites ran in the copy, ${passLines} PASS lines in all (${failed.length ? 'failed: ' + failed.join(', ') : 'none failed'})`);
}

cleanup();
ok(!fs.existsSync(TMP), 'the temp copy is removed');
console.log(failures ? `\n${failures} FAILED` : `\nAll isolated-copy checks passed (${skips} skipped, listed above).`);
process.exit(failures ? 1 : 0);
