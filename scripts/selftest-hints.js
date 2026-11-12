#!/usr/bin/env node
// The commands Plugin Guard prints for the user (lib/hints.js) work in BOTH layouts:
//   1. inside the repository every hint is EXACTLY the text printed before lib/hints.js existed (the literals below are copied from the code
//      as it was), checked in the table and at the places that print them; no package file prints a repository-form hint by itself
//   2. a copy of src/plugin-guard on its own (temp folder, git-listed files only, no issues/, sandboxes/, reports/, projects/, node_modules/):
//      the usage, next-step, issue, doctor, help and missing-package texts name `node scripts/guard.js` and the package's own npm scripts,
//      and NEVER src/plugin-guard, "repository root", src/combined, setup:guard or guard:setup-
//   3. every `npm run X` a standalone hint names is a script of the package's package.json; the npm ci lines are exactly as decided,
//      scripts["setup-browser"] is exactly "playwright install chromium", and no standalone text says npx
//   4. PG_HINT_LAYOUT=repo forces the repository wording in the copy (hint text only: the report folders stay where they were)
// Offline; nothing is downloaded (the copy borrows the installed packages through a symbolic link for the checks that need them).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PG = path.join(__dirname, '..');
const layout = require('../lib/repo-layout');
const REPO = layout.repoRoot();

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; return c; };
const group = t => console.log(`\n== ${t}`);
const childEnv = extra => {
    const env = { ...process.env, NO_COLOR: '1', ...extra };
    for (const k of Object.keys(env)) if (/^(PG_REAL_|PLUGIN_GUARD_|PG_PROBE_COOLDOWN_FILE$|PG_HINT_LAYOUT$)/.test(k) && !(k in (extra || {}))) delete env[k];
    return env;
};
const runIn = (cwd, args, extra, timeout = 180000) => { const r = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', env: childEnv(extra), input: '', timeout, maxBuffer: 32 * 1024 * 1024 }); return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` }; };

if (!REPO) {
    console.log('SKIP  this is not the repository (src/plugin-guard is on its own here): the repository texts cannot be compared and the copy is built from the repository only');
    process.exit(0);
}
delete process.env.PG_HINT_LAYOUT;
const hints = require('../lib/hints');

// ---- the texts as they were (copied literally from the code before lib/hints.js) ----
const OLD = {
    guard: 'node src/plugin-guard/scripts/guard.js',
    packagesLine: 'Run once from the repository root:  npm run setup:guard',
    packagesLabel: 'issue mode (src/plugin-guard)',
    playwrightMissing: 'Run once from the repository root: npm run setup:guard',
    chromiumMissing: 'Run once from the repository root: npm run setup:guard',
    playwrightWhere: 'in src/plugin-guard',
    pdfFix: 'Run once: npm run setup:guard',
    ocrLine: 'Run once from the repository root:  npm run guard:setup-ocr',
    noRun: 'No run found. Start one with: node src/plugin-guard/scripts/guard.js qa-url --url <site>',
};
const OLD_DEPS = 'Issue mode needs packages that are not installed: nope-pkg.\nRun once from the repository root:  npm run setup:guard\n(The classic scan and qa-* commands work without them.)';
const OLD_QA_URL = '"qa-url" drives the Frontend QA agent, so it lives in src/combined now:\n  node src/combined/scripts/combined.js qa-url --url http://x\n';
const OLD_AUTO = '"auto" drives the Frontend QA agent, so it lives in src/combined now:\n  node src/combined/scripts/combined.js auto --url http://x\n  (or: npm run guard:auto -- ...)\n';
const OLD_ISSUE_USAGE = 'Usage: node src/plugin-guard/scripts/guard.js issue <new|investigate|show|list|retest|index|cleanup|open> [id]';
const OLD_HELP_SANDBOX = '  --sandbox                also test in a throwaway copy in Docker (needs: npm run guard:setup-sandbox)\n';
const OLD_SETUP = 'npm run guard:setup-sandbox --';
const OLD_SB_BOGUS = 'guard:setup-sandbox: unknown option "--bogus" (use --check, --repin, --php <x.y>, --db <mariadb|mysql>)\n';
const OLD_PKG_ADVICE = 'npm run setup:guard';
// ---- the standalone texts decided by the owner ----
const NEW = {
    guard: 'node scripts/guard.js',
    packagesLine: 'Run once in this folder: npm ci',
    packagesLabel: 'issue mode (this package)',
    playwrightMissing: 'Run once in this folder: npm ci, then: npm run setup-browser',
    chromiumMissing: 'Run once in this folder: npm run setup-browser',
    playwrightWhere: 'in this package',
    pdfFix: 'Run once in this folder: npm ci, then: npm run setup-browser',
    ocrLine: 'Run once in this folder: npm run setup-ocr',
    noRun: 'No run found. Start one with: node scripts/guard.js qa-code --root <wordpress-root>',
};
const NEW_FRONTEND = cmd => `"${cmd}" needs the Frontend QA agent, which is not part of this package.`;
const FORBIDDEN = ['src/plugin-guard', 'repository root', 'src/combined', 'setup:guard', 'guard:setup-'];
const forbiddenIn = text => FORBIDDEN.filter(s => text.includes(s));
const headerUsage = file => fs.readFileSync(file, 'utf8').split('\n').slice(1, 35).map(l => l.replace(/^\/\/ ?/, '')).join('\n') + '\n';

// ================================================================ 1. inside the repository: exactly as before
group('1. inside the repository every hint is the old text, byte for byte');
{
    ok(hints.inRepo() === true, 'lib/hints.js sees the repository (lib/repo-layout.js)');
    const R = hints.current();
    for (const k of Object.keys(OLD)) ok(R[k] === OLD[k], `table: ${k} = ${JSON.stringify(OLD[k])}`);
    ok(Object.keys(hints.REPO).sort().join() === Object.keys(OLD).sort().join() && Object.keys(hints.ALONE).sort().join() === Object.keys(OLD).sort().join(), 'the table has exactly these hints, in both layouts');
    for (const [n, want] of [['setup-ocr', 'npm run guard:setup-ocr'], ['setup-sandbox', 'npm run guard:setup-sandbox'], ['knowledge-review', 'npm run guard:knowledge-review'], ['checkpoints', 'npm run guard:checkpoints']]) ok(R.npmRun(n) === want && R.scriptLabel(n) === want.slice('npm run '.length), `npmRun(${n}) = ${want}`);
    ok(R.frontendOnly('qa-url', ['qa-url', '--url', 'http://x']) + '\n' === OLD_QA_URL && R.frontendOnly('auto', ['auto', '--url', 'http://x']) + '\n' === OLD_AUTO, 'the qa-url / auto message is the old one');
    ok(R.usage('any text src/combined') === 'any text src/combined', 'the usage text is printed unchanged');
    ok(hints.PACKAGES_ADVICE[OLD.packagesLabel] === OLD_PKG_ADVICE, 'doctor: the old label keeps its old advice');

    group('1b. inside the repository, at the places that print them');
    ok(require('../lib/workflow').SELF === OLD.guard, 'lib/workflow.js SELF (src/combined/lib/stage-url.js reads it) is unchanged');
    let msg = ''; try { require('../lib/issue-deps').need(['nope-pkg']); } catch (e) { msg = e.message; }
    ok(msg === OLD_DEPS, 'lib/issue-deps.js: the missing-package message is the old one');
    let om = ''; try { require('../lib/ocr-data').verified('zz-none'); } catch (e) { om = e.message; }
    ok(om.split('\n')[1] === OLD.ocrLine, `lib/ocr-data.js: "${OLD.ocrLine}"`);
    ok(require('../issue/version-match').SETUP === OLD_SETUP, `issue/version-match.js SETUP = ${OLD_SETUP}`);
    const t = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-hints-'));
    fs.writeFileSync(path.join(t, 'package.json'), JSON.stringify({ dependencies: { 'absent-hint-pkg': '1.0.0' } }));
    const pc = require('../lib/doctor-checks').packageCheck(t, OLD.packagesLabel);
    ok(pc.name === 'Packages: issue mode (src/plugin-guard)' && pc.detail === '1 of 1 missing (absent-hint-pkg): run npm run setup:guard', `lib/doctor-checks.js: ${pc.detail}`);
    const r1 = runIn(PG, ['scripts/guard.js', 'qa-validate'], { PLUGIN_GUARD_RUNS: path.join(t, 'runs') });
    ok(r1.out === `\nPlugin Guard: ${OLD.noRun}\n`, 'lib/runs.js: "No run found" is the old text');
    const u = runIn(PG, ['scripts/guard.js']);
    ok(u.status === 2 && u.out === headerUsage(path.join(PG, 'scripts', 'guard.js')), 'scripts/guard.js usage is its header comment, unchanged');
    const q = runIn(PG, ['scripts/guard.js', 'qa-url', '--url', 'http://x']), a = runIn(PG, ['scripts/guard.js', 'auto', '--url', 'http://x']);
    ok(q.status === 2 && q.out === OLD_QA_URL && a.status === 2 && a.out === OLD_AUTO, 'scripts/guard.js qa-url / auto: the old message');
    const ih = runIn(PG, ['scripts/guard.js', 'issue', 'help']);
    ok(ih.out.split('\n')[0] === OLD_ISSUE_USAGE, 'lib/issue-cli.js usage line is the old one');
    const h = runIn(PG, ['scripts/plugin-guard.js', '--help']);
    ok(h.out.includes(OLD_HELP_SANDBOX), 'scripts/plugin-guard.js --help names npm run guard:setup-sandbox');
    const sb = runIn(PG, ['scripts/setup-sandbox.js', '--bogus']);
    ok(sb.out === OLD_SB_BOGUS, 'scripts/setup-sandbox.js: the old error prefix');
    const idx = require('../lib/issue-html').buildIndex([]);
    const data = JSON.parse(/<script type="application\/json" id="pg-data">([\s\S]*?)<\/script>/.exec(idx)[1]);
    // the client shows D.start when the page data has one; inside the repository it has none, so the text shown is the old one
    ok(idx.includes("'No issue has been created yet. Start with: ' + (D.start || 'node src/plugin-guard/scripts/guard.js issue new')") && JSON.stringify(data) === '{"issues":[]}', 'issues/index.html: the embedded data is unchanged ({"issues":[]}), so the client shows the old "Start with" text');
    fs.rmSync(t, { recursive: true, force: true });

    group('1c. no package file prints a repository-form hint by itself (only lib/hints.js holds them)');
    const OLD_FORMS = ['node src/plugin-guard/scripts/guard.js', 'setup:guard', 'guard:setup-ocr', 'guard:setup-sandbox', 'repository root', 'src/combined/scripts/combined.js', 'guard:knowledge-review', 'guard:checkpoints'];
    // lines that keep the old form on purpose (not printed as a hint)
    const KEEP = {
        'scripts/setup-sandbox.js': [/^const (MATRIX_)?ABOUT = /],   // the _about text written into data/sandbox-images.json by --repin
        'scripts/knowledge-review.js': [/Generated by `npm run guard:knowledge-review`/],   // KNOWLEDGE-REVIEW.md's own text (a test compares it byte for byte)
        'lib/playwright.js': [/^let H; try \{ H = require\('\.\/hints'\)\.current\(\); \} catch \{ H = \{ playwrightMissing: 'Run once from the repository root: npm run setup:guard'/],   // only when the file is copied alone (selftest-playwright.js)
        'lib/issue-index-client.js': [/\(D\.start \|\| 'node src\/plugin-guard\/scripts\/guard\.js issue new'\)/],   // browser code: the old text when the page data has no start command (inside the repository)
    };
    const files = [];
    (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((x, y) => (x.name < y.name ? -1 : 1))) { const f = path.join(d, e.name), rel = path.relative(PG, f).split(path.sep).join('/'); if (e.isDirectory()) { if (!['node_modules', 'fixtures'].includes(e.name)) walk(f); } else if (/\.js$/.test(e.name) && !/^scripts\/selftest/.test(rel) && rel !== 'lib/hints.js') files.push(rel); } })(PG);
    const roots = ['lib', 'issue', 'probe', 'agents', 'checks', 'scripts'];
    const bad = [];
    for (const rel of files.filter(r => roots.includes(r.split('/')[0]) || r === 'guard.js')) {
        fs.readFileSync(path.join(PG, rel), 'utf8').split('\n').forEach((l, i) => {
            const s = l.trim();
            if (s.startsWith('//') || s.startsWith('*') || s.startsWith('/*')) return;
            if (!OLD_FORMS.some(x => l.includes(x))) return;
            if ((KEEP[rel] || []).some(re => re.test(s))) return;
            bad.push(`${rel}:${i + 1}`);
        });
    }
    ok(bad.length === 0, `only lib/hints.js holds the repository forms (${bad.length ? bad.join(', ') : 'none elsewhere'})`);
}

// ================================================================ 2. a copy on its own
group('2. a copy of src/plugin-guard on its own (temp folder, no node_modules)');
const EXCLUDED_TOP = ['issues', 'sandboxes', 'reports', 'projects', 'node_modules', 'state', layout.FALLBACK];
const gitTop = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: REPO, encoding: 'utf8' });
let listed;
if (!gitTop.error && gitTop.status === 0 && fs.realpathSync(gitTop.stdout.trim()) === fs.realpathSync(REPO)) {
    const git = spawnSync('git', ['ls-files', '-co', '--exclude-standard', '-z', '--', 'src/plugin-guard'], { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    listed = String(git.stdout || '').split('\0').filter(Boolean).map(f => f.slice('src/plugin-guard/'.length));
} else {   // a git-archive snapshot (the full run): its own files, minus what .gitignore keeps out
    const IGNORED = rel => rel.split('/').includes('node_modules') || /(^|\/)(\.env(\..*)?|\.DS_Store)$|\.log$/.test(rel) || /^data\/ocr\/.*\.(traineddata|part)$/.test(rel);
    listed = [];
    (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((x, y) => (x.name < y.name ? -1 : 1))) { const f = path.join(d, e.name), rel = path.relative(PG, f).split(path.sep).join('/'); if (e.isDirectory()) { if (!(d === PG && EXCLUDED_TOP.includes(e.name)) && e.name !== 'node_modules') walk(f); } else if (!IGNORED(rel)) listed.push(rel); } })(PG);
}
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pg-hints-copy-')));
const COPY = path.join(TMP, 'plugin-guard');
let cleaned = false;
const cleanup = () => { if (!cleaned) { cleaned = true; try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } } };
process.on('exit', cleanup);
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { cleanup(); process.exit(130); });
for (const rel of listed.filter(r => !EXCLUDED_TOP.includes(r.split('/')[0]))) {
    const src = path.join(PG, rel), dst = path.join(COPY, rel);
    let st; try { st = fs.lstatSync(src); } catch { continue; }
    if (!st.isFile()) continue;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
}
ok(fs.existsSync(path.join(COPY, 'scripts', 'guard.js')) && !fs.existsSync(path.join(COPY, 'node_modules')) && layout.repoRoot(COPY) === null && JSON.stringify(fs.readdirSync(TMP)) === '["plugin-guard"]', 'the copy is on its own (no repository around it, no node_modules)');
const pkgScripts = JSON.parse(fs.readFileSync(path.join(COPY, 'package.json'), 'utf8')).scripts;
const seen = [];   // every standalone text printed, for section 3
const W = path.join(TMP, 'work'); fs.mkdirSync(W);
const check = (label, r, { mustHave = [], exact } = {}) => {
    seen.push(r.out);
    const f = forbiddenIn(r.out);
    ok(f.length === 0 && mustHave.every(s => r.out.includes(s)) && (exact === undefined || r.out === exact), `${label}${f.length ? `: names ${f.join(', ')}` : ''}${mustHave.filter(s => !r.out.includes(s)).map(s => `; missing ${JSON.stringify(s)}`).join('')}${exact !== undefined && r.out !== exact ? `; got ${JSON.stringify(r.out.slice(0, 200))}` : ''}`);
};
{
    const A = hints.forLayout(false);
    for (const k of Object.keys(NEW)) ok(A[k] === NEW[k], `standalone table: ${k} = ${JSON.stringify(NEW[k])}`);
    ok(A.frontendOnly('qa-url', ['qa-url', '--x']) === NEW_FRONTEND('qa-url') && A.frontendOnly('auto', ['auto']) === NEW_FRONTEND('auto'), 'standalone: the Frontend QA message names no path');
    ok(hints.PACKAGES_ADVICE[NEW.packagesLabel] === NEW.packagesLine, 'standalone doctor label advises npm ci');

    group('2a. without packages (no node_modules in the copy)');
    const u = runIn(COPY, ['scripts/guard.js']);
    check('guard.js usage names no repository path and says issue mode needs npm ci', u, { mustHave: ['(issue mode; needs: npm ci)', 'see README.md', 'not part of this package'] });
    check('guard.js qa-url: the standalone message', runIn(COPY, ['scripts/guard.js', 'qa-url', '--url', 'http://x']), { exact: NEW_FRONTEND('qa-url') + '\n' });
    check('guard.js auto: the standalone message', runIn(COPY, ['scripts/guard.js', 'auto', '--url', 'http://x']), { exact: NEW_FRONTEND('auto') + '\n' });
    check('guard.js qa-validate with no run: points at node scripts/guard.js qa-code', runIn(COPY, ['scripts/guard.js', 'qa-validate'], { PLUGIN_GUARD_RUNS: path.join(W, 'runs') }), { exact: `\nPlugin Guard: ${NEW.noRun}\n` });
    check('guard.js issue new without packages: "Run once in this folder: npm ci"', runIn(COPY, ['scripts/guard.js', 'issue', 'new', '--no-prompt'], { PLUGIN_GUARD_ISSUES: path.join(W, 'i0') }), { mustHave: [`\n${NEW.packagesLine}\n`] });
    check('plugin-guard without packages: "Run once in this folder: npm ci"', runIn(COPY, ['scripts/plugin-guard.js', '--description', 'x', '--root', W, '--yes']), { mustHave: [`\n${NEW.packagesLine}\n`] });
    check('plugin-guard --help names npm run setup-sandbox', runIn(COPY, ['scripts/plugin-guard.js', '--help']), { mustHave: ['(needs: npm run setup-sandbox)\n'] });
    const probe = runIn(COPY, ['-e', [
        "const o=[];",
        "o.push(require('./lib/workflow').SELF);",
        "const pw=require('./lib/playwright');o.push(pw.status().reason);try{pw.load()}catch(e){o.push(e.message)}",
        "try{require('./lib/ocr-data').verified('zz-none')}catch(e){o.push(e.message)}",
        "o.push(JSON.stringify(require('./lib/doctor-checks').packageCheck(process.cwd(),require('./lib/hints').current().packagesLabel)));",
        "console.log(o.join('\\n'))"].join('')]);
    check('in-process texts without packages (workflow.SELF, playwright status/load, OCR, the packages check)', probe, { mustHave: [`${NEW.guard}\n`, `@playwright/test is not installed in this package. ${NEW.playwrightMissing}`, `Playwright is not installed for plugin-guard. ${NEW.playwrightMissing}`, NEW.ocrLine, '"name":"Packages: issue mode (this package)"', `. ${NEW.packagesLine}"`] });
    const d = runIn(COPY, ['scripts/guard.js', 'doctor']);
    check('doctor without packages: "Packages: issue mode (this package)" and npm ci', d, { mustHave: ['Packages: issue mode (this package)', NEW.packagesLine] });
    check('setup-sandbox with a wrong option: its own script name', runIn(COPY, ['scripts/setup-sandbox.js', '--bogus']), { mustHave: ['setup-sandbox: unknown option "--bogus"'] });

    group('2b. with the installed packages (a symbolic link, nothing downloaded)');
    fs.symlinkSync(path.join(PG, 'node_modules'), path.join(COPY, 'node_modules'), 'dir');
    const env = { PLUGIN_GUARD_ISSUES: path.join(W, 'issues') };
    check('issue help: Usage: node scripts/guard.js issue ...', runIn(COPY, ['scripts/guard.js', 'issue', 'help'], env), { mustHave: ['Usage: node scripts/guard.js issue <new|'] });
    const site = path.join(W, 'site'); fs.mkdirSync(path.join(site, 'wp-content', 'plugins'), { recursive: true }); fs.writeFileSync(path.join(site, 'wp-config.php'), '<?php\n');
    const nw = runIn(COPY, ['scripts/guard.js', 'issue', 'new', '--title', 'Hint check', '--description', 'White screen on the home page', '--symptom', 'white-screen', '--root', site, '--env', 'local', '--no-prompt'], env);
    const id = /(iss-\d{8}-\d{6}-[0-9a-f]{6})/.exec(nw.out)?.[1];
    check('issue new: Next: node scripts/guard.js issue investigate <id>', nw, { mustHave: [`Next: node scripts/guard.js issue investigate ${id}`] });
    if (id) check('issue open before an investigation: run  node scripts/guard.js issue investigate <id>', runIn(COPY, ['scripts/guard.js', 'issue', 'open', id], env), { mustHave: [`run  node scripts/guard.js issue investigate ${id}`] });
    const probe2 = runIn(COPY, ['-e', [
        "const o=[];",
        "o.push(require('./issue/version-match').SETUP);",
        "const cf=require('./issue/case-file');const t={status:'matched',text:'x'};",
        "o.push(cf.versionLines({schema:1,php:t,db:t,wordpress:t,commands:[require('./issue/version-match').SETUP+' --php 8.2']}).pop());",
        "const h=require('./lib/issue-html').buildIndex([]);o.push(/id=\"pg-data\">([^<]*)</.exec(h)[1]);",
        "console.log(o.join('\\n'))"].join('')]);
    check('version-match SETUP, the case-file versions line, the issues index data', probe2, { mustHave: ['npm run setup-sandbox --\n', 'can be fetched once: npm run setup-sandbox -- --php 8.2\n', '{"issues":[],"start":"node scripts/guard.js issue new"}'] });
    const client = fs.readFileSync(path.join(COPY, 'lib', 'issue-index-client.js'), 'utf8');
    ok(/text: L\.length \? 'No issue matches the search\.' : 'No issue has been created yet\. Start with: ' \+ \(D\.start \|\| 'node src\/plugin-guard\/scripts\/guard\.js issue new'\)/.test(client), 'issues/index.html shows D.start (data from the server, set as text, no innerHTML) and the old text when it is absent');
    check('doctor with packages: Packages: issue mode (this package)', runIn(COPY, ['scripts/guard.js', 'doctor']), { mustHave: ['Packages: issue mode (this package)'] });
}

// ================================================================ 3. the npm scripts a standalone hint names exist
group('3. every npm run name in a standalone hint is a script of the package; npm ci exactly as decided, setup-browser, no npx');
{
    const A = hints.forLayout(false);
    const texts = [...Object.values(hints.ALONE), ...Object.keys(hints.SCRIPTS).map(n => A.npmRun(n)), ...seen];
    const named = [...new Set(texts.flatMap(t => [...t.matchAll(/npm run ([\w:.-]+)/g)].map(m => m[1])))].sort();
    const missing = named.filter(n => !pkgScripts[n]);
    ok(named.includes('setup-ocr') && named.includes('setup-sandbox') && missing.length === 0, `every npm run name exists in package.json scripts (${named.join(', ')}${missing.length ? '; MISSING: ' + missing.join(', ') : ''})`);
    ok(Object.values(hints.SCRIPTS).every(n => pkgScripts[n]) && !pkgScripts['setup:guard'] && !Object.keys(pkgScripts).some(n => n.startsWith('guard:')), 'the package has no setup:guard and no guard: scripts, so no standalone hint may name them');
    ok(pkgScripts['setup-browser'] === 'playwright install chromium', 'package.json scripts["setup-browser"] is exactly "playwright install chromium" (the root setup:guard runs the same through npm exec)');
    ok(named.includes('setup-browser'), 'a standalone hint names npm run setup-browser');
    const npx = texts.filter(t => /\bnpx\b/.test(t));
    ok(npx.length === 0, `no standalone text says npx (${npx.length ? npx.map(t => t.slice(0, 80)).join(' | ') : 'none'})`);
    const ci = [...new Set(texts.flatMap(t => t.match(/npm ci[^\n"]*/g) || []))];
    ok(ci.length > 0 && ci.every(x => x === 'npm ci' || x === 'npm ci, then: npm run setup-browser' || x === 'npm ci)'), `every npm ci hint is exactly as decided (${ci.join(' | ')})`);
}

// ================================================================ 4. PG_HINT_LAYOUT=repo
group('4. PG_HINT_LAYOUT=repo forces the repository wording in the copy (hint text only)');
{
    const R = { PG_HINT_LAYOUT: 'repo' };
    const q = runIn(COPY, ['scripts/guard.js', 'qa-url', '--url', 'http://x'], R);
    ok(q.out === OLD_QA_URL, 'qa-url: the repository message');
    ok(runIn(COPY, ['scripts/guard.js', 'issue', 'help'], R).out.split('\n')[0] === OLD_ISSUE_USAGE, 'issue help: the repository usage line');
    const u = runIn(COPY, ['scripts/guard.js'], R);
    ok(u.out === headerUsage(path.join(COPY, 'scripts', 'guard.js')), 'guard.js usage: the header comment unchanged');
    const p = runIn(COPY, ['-e', "let m='';try{require('./lib/issue-deps').need(['nope-pkg'])}catch(e){m=e.message};const r=require('./lib/runs'),l=require('./lib/repo-layout');console.log(JSON.stringify([m,r.runsRoot(),l.repoRoot(),require('./issue/version-match').SETUP]))"], R);
    let got = null; try { got = JSON.parse(p.out); } catch { /* none */ }
    ok(got && got[0] === OLD_DEPS && got[3] === OLD_SETUP, 'missing packages and SETUP: the repository wording');
    ok(got && got[1] === path.join(COPY, layout.FALLBACK, 'runs') && got[2] === null, 'and nothing else changes: the runs folder stays next to the copy\'s code, repo-layout still says "on its own"');
    ok(runIn(COPY, ['scripts/guard.js', 'qa-url'], { PG_HINT_LAYOUT: 'alone' }).out === NEW_FRONTEND('qa-url') + '\n' && runIn(COPY, ['scripts/guard.js', 'qa-url'], { PG_HINT_LAYOUT: '' }).out === NEW_FRONTEND('qa-url') + '\n', 'any other value (or empty) does not force anything');
}

cleanup();
ok(!fs.existsSync(TMP), 'the temp copy is removed');
console.log(failures ? `\n${failures} FAILED` : '\nAll hints checks passed');
process.exit(failures ? 1 : 0);
