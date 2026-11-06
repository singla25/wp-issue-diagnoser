#!/usr/bin/env node
// Self-test of TEST-COPY-SPEC 6d-1 against a REAL Docker daemon, through the same entry the person uses: the plugin-guard wizard (lib/wizard.js)
// with an injected terminal and real Docker, a database file (scripts/fixtures/issue/dump/wp-site.sql.txt with a synthetic active_plugins list
// written at test time) and --keep-sandbox so the containers can be inspected afterwards. It SKIPS LOUDLY (exit 0, a SKIP line saying nothing was
// verified) when Docker is not usable or the pinned images are missing (`npm run guard:setup-sandbox`). Nothing is pulled.
// What it proves:
//   - the dummy admin password (taken from the one terminal line, and every --user_pass value any build of this run set) is in NO file under the
//     issue folder or the sandbox folder (recursive: logs/, work/, compose.json, state.json, proxy conf, findings.json, issue.html, ISSUE-REPORT.md,
//     steps...), not in the captured stdout/stderr except the one allowed 'Test login for the copy' line, and not in `docker compose logs` of any
//     service; the terminal line appears exactly once
//   - the active plugins come from the imported database (read, compared with the copy), `wp plugin activate` is never run, and the baseline is the
//     database's own set; the copy's own debug log is read as unverified data with paths relative to wp-content

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { PassThrough } = require('stream');
const { spawnSync } = require('child_process');
const sandbox = require('../issue/sandbox');

const pf = sandbox.preflight({});
if (!pf.ok) { console.log(`SKIP  selftest-6d1-docker was NOT run: it needs a usable Docker daemon and the pinned sandbox images.\n  reason: ${pf.reason}\n  Nothing in this suite is claimed as verified in this environment.`); process.exit(0); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-6d1-dk-'));
process.env.PLUGIN_GUARD_ISSUES = path.join(tmp, 'issues');
fs.mkdirSync(process.env.PLUGIN_GUARD_ISSUES, { mode: 0o700 });
const store = require('../lib/issue-store');
const wizard = require('../lib/wizard');
const vm = require('../issue/version-match');
const { SandboxWpCli } = require('../issue/sandbox-wpcli');
const trees = require('./fixtures/issue/trees');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const group = t => console.log(`\n== ${t}`);
const write = (root, rel, body) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); return f; };
function hashTree(dir) { const h = crypto.createHash('sha256'); (function walk(d) { for (const n of fs.readdirSync(d).sort()) { const f = path.join(d, n), st = fs.lstatSync(f); h.update(`${path.relative(dir, f)}|${st.isSymbolicLink() ? 'l' : st.isDirectory() ? 'd' : 'f'}|${st.mode}|`); if (st.isDirectory()) walk(f); else if (st.isFile()) h.update(fs.readFileSync(f)); } })(dir); return h.digest('hex'); }
// every file under a folder (recursive, symbolic links not followed): those whose bytes contain the needle, and those this user could not read
function search(dir, needles) {
    const hits = [], unreadable = []; let files = 0;
    (function walk(d) { let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { unreadable.push(d); return; } for (const e of es) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (e.isFile()) { files++; let b; try { b = fs.readFileSync(f); } catch { unreadable.push(f); continue; } for (const n of needles) if (b.includes(n)) hits.push(f); } } })(dir);
    return { hits, unreadable, files };
}
// the sandbox folder: files this user cannot read (owned by the container user) are read INSIDE this sandbox's own web container (as root there,
// via `docker compose exec`, only for paths that are bind mounts of this sandbox); a file that can be read neither way stays in `unreadable`
const MOUNTS = [['site/wp-content/', '/var/www/html/wp-content/'], ['logs/', '/var/log/pg/']];
function searchSandbox(sbDir, needles) {
    const s = search(sbDir, needles), left = []; let viaContainer = 0;
    let st = null; try { st = JSON.parse(fs.readFileSync(path.join(sbDir, 'state.json'), 'utf8')); } catch { /* no state */ }
    for (const f of s.unreadable) {
        const rel = path.relative(sbDir, f), mt = MOUNTS.find(([h]) => rel.startsWith(h));
        if (!st || !/^pgsb[0-9a-f]{8}$/.test(st.project) || !mt || rel.split('/').includes('..')) { left.push(f); continue; }
        const r = spawnSync('docker', ['compose', '-p', st.project, '-f', path.join(sbDir, 'compose.json'), 'exec', '-T', '-u', '0', 'wordpress', 'cat', '--', mt[1] + rel.slice(mt[0].length)], { timeout: 60000, maxBuffer: 50 * 1024 * 1024 });
        if (r.status !== 0) { left.push(f); continue; }
        viaContainer++; for (const n of needles) if (r.stdout.includes(n)) s.hits.push(f);
    }
    return { ...s, unreadable: left, viaContainer };
}
const labelled = () => { const l = sandbox.labelled({ dockerBin: 'docker', runner: spawnSync, env: process.env }); return l.containers.length + l.volumes.length + l.networks.length; };
const occurrences = (text, needle) => text.split(needle).length - 1;
const ser = list => `a:${list.length}:{${list.map((s, i) => `i:${i};s:${Buffer.byteLength(s)}:"${s}";`).join('')}}`;

// ---- the site: plugin-a (active), plugin-b (present, not active), fatal-plugin (active: a class-not-found fatal on the front end only) ----
const SITE = path.join(tmp, 'site', 'wp');
trees.duplicateFunction(SITE);
write(SITE, 'wp-content/plugins/fatal-plugin/fatal-plugin.php', "<?php\n/* Plugin Name: Fatal Plugin */\nadd_action( 'template_redirect', function () { new \\Pg6d1\\Missing_Thing(); } );\n");
write(SITE, 'wp-content/themes/acme/style.css', '/* Theme Name: Acme */');
const ACTIVE = ['fatal-plugin/fatal-plugin.php', 'gone/gone.php', 'plugin-a/plugin-a.php'];
const SITE_HASH = hashTree(SITE);
const SB = path.join(tmp, 'sandboxes');
const DUMP = path.join(tmp, 'in', 'site.sql');
const sqlText = fs.readFileSync(path.join(__dirname, 'fixtures', 'issue', 'dump', 'wp-site.sql.txt'), 'utf8');
ok(sqlText.includes("'active_plugins','a:0:{}'"), 'the fixture export has an active_plugins row to replace');
fs.mkdirSync(path.dirname(DUMP)); fs.writeFileSync(DUMP, sqlText.replace("'active_plugins','a:0:{}'", `'active_plugins','${ser(ACTIVE).replace(/"/g, '\\"')}'`));

(async () => {
    const before = labelled();
    // every WP-CLI call of this run (real Docker underneath), and every password any build set: recorded in memory only
    const calls = [], passwords = new Set();
    const realRun = SandboxWpCli.prototype.run;
    SandboxWpCli.prototype.run = function (args, o) { calls.push(args.slice()); for (const a of args) if (/^--user_pass=/.test(a)) passwords.add(a.slice('--user_pass='.length)); return realRun.call(this, args, o); };
    // the terminal (injected), plus everything written to this process's stdout and stderr while the wizard runs
    const input = new PassThrough(), output = new PassThrough();
    let text = ''; output.on('data', d => { text += d; });
    input.end(['', '', '1'].join('\n') + '\n');
    let captured = '';
    const ow = process.stdout.write, ew = process.stderr.write, log = console.log, err = console.error;
    process.stdout.write = (c, ...r) => { captured += String(c); return true; }; process.stderr.write = (c, ...r) => { captured += String(c); return true; };
    console.log = (...a) => { captured += a.join(' ') + '\n'; }; console.error = (...a) => { captured += a.join(' ') + '\n'; };
    const out = path.join(tmp, 'reports');
    let error = null, code = null;
    const t0 = Date.now();
    try { code = await wizard.run({ _: [], description: 'The home page is white since the update', root: SITE, 'no-probe': true, out, sandbox: true, 'db-dump': DUMP, 'keep-sandbox': true, 'no-bisect': true }, { input, output, tty: true, cwd: tmp, env: { HOME: tmp }, preflight: () => ({ ok: true }), siteRoots: [], sandboxOptions: { sandboxesRoot: SB } }); }
    catch (e) { error = e; }
    finally { process.stdout.write = ow; process.stderr.write = ew; console.log = log; console.error = err; SandboxWpCli.prototype.run = realRun; }
    const all = text + captured;
    const ids = fs.existsSync(out) ? fs.readdirSync(out).filter(x => store.ISSUE_RE.test(x)) : [];
    const idir = ids.length ? path.join(out, ids[0]) : null, sbDir = idir ? path.join(SB, ids[0]) : null;
    group(`the wizard with real Docker and a database file (${Math.round((Date.now() - t0) / 1000)} s)`);
    ok(!error && idir && fs.existsSync(path.join(idir, 'result', 'findings.json')), `the run finished with a report${error ? ` (error: ${error.stack})` : ''} (exit ${code})`);
    const m = /Test login for the copy: pgadmin \/ ([A-Za-z0-9]{20,64}) {2}\(shown only here, never saved\)/.exec(all);
    const pw = m && m[1];
    ok(pw && passwords.has(pw), `the terminal line carries the password that was set (${pw ? pw.length : 0} characters; ${passwords.size} password(s) set in this run)`);
    const LINE = pw ? `Test login for the copy: pgadmin / ${pw}  (shown only here, never saved)` : '\u0000none';
    ok(occurrences(all, LINE) === 1, `the 'Test login for the copy' line appears exactly once (${occurrences(all, LINE)})`);
    const rest = all.split(LINE).join('');
    // the same predicate is used for the control and for the real check
    const leaks = (txt, list) => list.filter(p => txt.includes(p));
    ok(pw && leaks(rest, [...passwords]).length === 0, 'no password is anywhere else in the captured stdout or stderr');

    group('CONTROL: the search finds a planted string (a broken search cannot pass silently)');
    const CTRL = `PgCtl${crypto.randomBytes(12).toString('hex')}`;
    const plant = d => write(d, path.join('.pg6d1-control', 'sub', '.hidden-control'), `x\n${CTRL}\ny`);
    const planted = [idir, sbDir].filter(Boolean).map(plant);
    if (idir) { const c = search(idir, [CTRL]); ok(c.hits.length === 1 && c.hits[0] === planted[0], `the issue folder search finds the planted hidden file (${c.hits.length} hit)`); }
    if (sbDir) { const c = searchSandbox(sbDir, [CTRL]); ok(c.hits.length === 1 && c.hits[0] === planted[1], `the sandbox folder search finds the planted hidden file (${c.hits.length} hit)`); }
    const stand = rest.slice(0, Math.floor(rest.length / 2)) + CTRL + rest.slice(Math.floor(rest.length / 2));
    ok(leaks(stand, [CTRL]).length === 1 && leaks(rest, [CTRL]).length === 0, 'the stdout/stderr check finds the string planted in a captured-output stand-in');
    for (const d of [idir, sbDir].filter(Boolean)) fs.rmSync(path.join(d, '.pg6d1-control'), { recursive: true, force: true });
    ok([idir, sbDir].filter(Boolean).every(d => !fs.existsSync(path.join(d, '.pg6d1-control'))), 'the planted files are removed before the real search');

    group('the password is in no file and no container log');
    const needles = [...passwords].filter(p => p && p.length >= 20);
    if (idir) { const s = search(idir, needles); ok(needles.length && s.hits.length === 0 && s.files > 20, `none of the ${s.files} files under the issue folder (work/, result/findings.json, issue.html, ISSUE-REPORT.md, steps, site-copy) contains it${s.hits.length ? `: ${s.hits.join(', ')}` : ''}${s.unreadable.length ? `; ${s.unreadable.length} unreadable` : ''}`); ok(s.unreadable.length === 0, 'every file under the issue folder could be read'); }
    if (sbDir) {
        const s = searchSandbox(sbDir, needles);
        ok(fs.existsSync(path.join(sbDir, 'compose.json')) && fs.existsSync(path.join(sbDir, 'state.json')) && fs.existsSync(path.join(sbDir, 'proxy', 'proxy.conf')) && fs.existsSync(path.join(sbDir, 'logs')), 'the kept sandbox folder has compose.json, state.json, proxy/proxy.conf and logs/');
        ok(needles.length && s.hits.length === 0 && s.files > 20, `none of the ${s.files} files under the sandbox folder (logs/, compose.json, state.json, proxy conf, the site copy) contains it (${s.viaContainer} read inside the container)${s.hits.length ? `: ${s.hits.join(', ')}` : ''}`);
        ok(s.unreadable.length === 0, `every file under the sandbox folder was read (directly, or inside this sandbox's own web container)${s.unreadable.length ? `; NOT read: ${s.unreadable.slice(0, 5).join(', ')}` : ''}`);
        const st = JSON.parse(fs.readFileSync(path.join(sbDir, 'state.json'), 'utf8'));
        const logs = spawnSync('docker', ['compose', '-p', st.project, '-f', path.join(sbDir, 'compose.json'), 'logs', '--no-color'], { encoding: 'utf8', timeout: 120000, maxBuffer: 50 * 1024 * 1024 });
        const svcs = JSON.parse(fs.readFileSync(path.join(sbDir, 'compose.json'), 'utf8')).services;
        ok(logs.status === 0 && Object.keys(svcs).every(s => s === 'cli' || logs.stdout.includes(`${s}-`) || logs.stdout.includes(`${s} `)) && needles.every(p => !logs.stdout.includes(p) && !logs.stderr.includes(p)), `\`docker compose logs\` of every service (${Object.keys(svcs).join(', ')}; ${logs.stdout.length} bytes) does not contain it`);
    }

    group('active plugins: read from the database, compared, never activated');
    ok(!calls.some(a => a[0] === 'plugin' && a[1] === 'activate'), `no \`wp plugin activate\` in any of the ${calls.length} WP-CLI calls of the run`);
    const ap = idir ? JSON.parse(fs.readFileSync(path.join(idir, 'work', 'active-plugins.json'), 'utf8')) : {};
    // the copy's plugins folder as the build saw it (the kept sandbox): plugin-b, plus what the WordPress image seeds there on its first start
    const inCopy = sbDir ? vm.copyPlugins(path.join(sbDir, 'site', 'wp-content', 'plugins')).map(p => p.path) : [];
    const notActive = inCopy.filter(p => !ACTIVE.includes(p));
    ok(ap.source === 'from the database' && JSON.stringify(ap.active) === JSON.stringify(ACTIVE) && JSON.stringify(ap.missing_files) === '["gone/gone.php"]' && notActive.includes('plugin-b/plugin-b.php') && ap.not_active_present === notActive.length, `work/active-plugins.json from the real database: ${JSON.stringify(ap)} (present but not active in the copy: ${notActive.join(', ')})`);
    const sbj = idir ? JSON.parse(fs.readFileSync(path.join(idir, 'work', 'sandbox.json'), 'utf8')) : {};
    ok(sbj.baseline && JSON.stringify(sbj.baseline.active_plugins) === '["fatal-plugin","plugin-a"]', `the baseline is the database's own set: ${JSON.stringify(sbj.baseline && sbj.baseline.active_plugins)}`);
    const f = idir ? JSON.parse(fs.readFileSync(path.join(idir, 'result', 'findings.json'), 'utf8')) : {};
    ok(f.sandbox && f.sandbox.summary && f.sandbox.summary.active_plugins && f.sandbox.summary.active_plugins.source === 'from the database' && f.case_file.developer.includes(vm.MISSING_FILES_NOTE), 'findings.json sandbox.summary.active_plugins and the missing-files sentence in the developer block');

    group('the copy\'s own debug log: unverified data, paths relative to wp-content');
    const cl = idir && fs.existsSync(path.join(idir, 'work', 'copy-log.json')) ? JSON.parse(fs.readFileSync(path.join(idir, 'work', 'copy-log.json'), 'utf8')) : {};
    const hit = (cl.last_fatals || []).find(x => /Pg6d1\\Missing_Thing/.test(x.message));
    ok(cl.label === 'unverified' && cl.available === true && hit && hit.file === 'plugins/fatal-plugin/fatal-plugin.php' && hit.line === 3, `work/copy-log.json has the front-end fatal of the copy: ${JSON.stringify(hit || cl)}`);
    ok(!JSON.stringify(cl).includes('/var/www/html'), 'no absolute container path in it');
    ok(f.sandbox && f.sandbox.copy_log && f.sandbox.copy_log.label === 'unverified', 'findings.json sandbox.copy_log is labelled unverified');

    if (idir) sandbox.destroy(path.basename(idir), { sandboxesRoot: SB });
    ok(labelled() === before && !fs.existsSync(sbDir || '/nonexistent-6d1'), 'after destroy no labelled container, volume or network is left, and the sandbox folder is gone');
    ok(hashTree(SITE) === SITE_HASH, 'the original site tree is byte-for-byte unchanged');
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(failures ? `\n${failures} FAILED` : '\nAll checks passed');
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); try { sandbox.sweep({ sandboxesRoot: SB }); } catch { /* ignore */ } process.exit(1); });
