#!/usr/bin/env node
// Self-test of TEST-COPY-SPEC 6c-2 (reduced: dummy users only), against the fake `docker` (scripts/fixtures/issue/fake-docker.js). No daemon.
//   - the user-accounts question in the wizard (exact text; answer 1 / 0; not asked with --yes, --no-questions, --no-prompt or without a terminal)
//   - --keep-real-data is retired (exit 2 with one fixed sentence, also through guard:auto's command) and --users accepts only "dummy"
//   - users are rewritten in place, the lowest-ID administrator becomes the one known dummy admin (pgadmin) with a new password generated at run time,
//     set ONLY through the closed command table entry `user update <id> --user_pass=...` (masked as [REDACTED] in the audit trail)
//   - the post-anonymise check accepts exactly that one dummy admin row and refuses everything else (fail closed: no web start, destroyed)
//   - per-table counts of rewritten or removed rows (numbers only) and the number of tables that could not be checked, in the step and findings.json
//   - the password is printed once, only on a terminal, and is in no file under the issue or sandbox folder, no step, warning or JSON output
// The real-container proof is selftest-6c2-docker.js.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { PassThrough } = require('stream');
const { spawnSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-6c2-'));
process.env.PLUGIN_GUARD_ISSUES = path.join(tmp, 'issues');
fs.mkdirSync(process.env.PLUGIN_GUARD_ISSUES, { mode: 0o700 });
const PG = path.join(__dirname, '..');
const REPO = path.join(PG, '..', '..');
const sandbox = require('../issue/sandbox');
const cfg = require('../issue/sandbox-config');
const wpcli = require('../issue/sandbox-wpcli');
const guard = require('./guard');
const store = require('../lib/issue-store');
const wizard = require('../lib/wizard');
const cli = require('../lib/issue-cli');
const caseFile = require('../issue/case-file');
const resultMod = require('../issue/result');
const probe = require('../issue/probe');
const trees = require('./fixtures/issue/trees');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const group = t => console.log(`\n== ${t}`);
const write = (root, rel, body) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); return f; };
const rejects = async (fn, re) => { try { await fn(); return null; } catch (e) { return re.test(`${e.name}: ${e.message}`) ? e : null; } };
const throwsRefusal = fn => { try { fn(); return false; } catch (e) { return e.name === 'SandboxRefusal'; } };
let seq = 0;
const newId = () => `iss-20261106-1000${String(seq++).padStart(2, '0')}-${crypto.randomBytes(3).toString('hex')}`;
// every file under a folder whose bytes contain the needle (symbolic links are not followed)
const filesWith = (dir, needle) => { const hits = []; (function walk(d) { let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (e.isFile() && fs.readFileSync(f).includes(needle)) hits.push(f); } })(dir); return hits; };
const countFiles = dir => { let n = 0; (function walk(d) { let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { if (e.isDirectory()) walk(path.join(d, e.name)); else n++; } })(dir); return n; };
const occurrences = (text, needle) => text.split(needle).length - 1;

// ---- fixtures ----
const SITE = path.join(tmp, 'site');
write(SITE, 'wp-config.php', "<?php define('DB_NAME','x');");
write(SITE, 'wp-content/plugins/alpha/alpha.php', "<?php\n/* Plugin Name: Alpha */\n");
write(SITE, 'wp-content/themes/acme/style.css', '/* Theme Name: Acme */');
const SQL = write(tmp, 'in/site.sql', fs.readFileSync(path.join(__dirname, 'fixtures', 'issue', 'dump', 'tiny.sql.txt')));
const TABLES = 'Tables_in_wordpress\npgf_options\npgf_users\npgf_usermeta\npgf_posts\npgf_postmeta\npgf_comments\npgf_slider_items\npgf_crm_leads\n';
const base = (extra = []) => [...extra,
    { match: 'db query', stdin: 'SHOW TABLES', out: TABLES }, { match: 'db query', stdin: "option_name = 'siteurl'", out: 'option_value\nhttps://shop.example.com\n' }, { match: 'db query', stdin: "option_name = 'home'", out: 'option_value\nhttps://shop.example.com\n' }];
const COUNTS = [{ match: 'db query', stdin: 'AS pg_rows FROM `pgf_users`', out: 'pg_rows\n12\n' }, { match: 'db query', stdin: 'AS pg_rows FROM `pgf_comments`', out: 'pg_rows\n340\n' }];
const ADMIN = [{ match: 'db query', stdin: 'AS pg_admin FROM', out: 'pg_admin\n1\n' }, { match: 'db query', stdin: 'AS pg_admins FROM', out: 'pg_admins\n1\n' }];
const withAdmin = (extra = []) => base([...extra, ...ADMIN, ...COUNTS]);

function fakeEnv(name, fake = {}) {
    const dir = path.join(tmp, 'fake-' + name); fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(path.join(__dirname, 'fixtures', 'issue', 'fake-docker.js'), path.join(dir, 'docker')); fs.chmodSync(path.join(dir, 'docker'), 0o755);
    const sbx = path.join(tmp, 'sbx-' + name); fs.mkdirSync(sbx, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, 'fake.json'), JSON.stringify(fake));
    const f = {
        dir, sandboxesRoot: sbx,
        log: () => (fs.existsSync(path.join(dir, 'fake.log')) ? fs.readFileSync(path.join(dir, 'fake.log'), 'utf8').split('\n').filter(Boolean).map(JSON.parse) : []),
        state: () => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'fake.state.json'), 'utf8')); } catch { return { containers: [], volumes: [], networks: [] }; } },
        base: (extra = {}) => ({ dockerBin: path.join(dir, 'docker'), sandboxesRoot: sbx, env: { PATH: process.env.PATH, HOME: process.env.HOME }, ...extra })
    };
    f.opts = (extra = {}) => f.base({ root: SITE, pageCheck: () => ({ status: 200 }), ...extra });
    // the password the fake was given (as docker's argv), read back from the fake's own log (outside every issue and sandbox folder)
    f.password = () => { for (const l of f.log()) { const a = l.args.find(x => /^--user_pass=/.test(x)); if (a && l.args.includes('update')) return a.slice('--user_pass='.length); } return null; };
    return f;
}
const leftovers = f => { const s = f.state(); return s.containers.length + s.volumes.length + s.networks.length; };
const sub = (l, s, svc) => l.args[0] === 'compose' && l.args[5] === s && (!svc || l.args.includes(svc));

(async () => {
    // ================================================================ flags
    group('--keep-real-data is retired; --users accepts only "dummy" (every command parses with scripts/guard.js parse)');
    const RETIRED = '--keep-real-data was replaced by the user-accounts question; keeping real accounts is not available in this version.';
    const run = (bin, args) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', cwd: tmp, timeout: 60000, env: { ...process.env, PLUGIN_GUARD_ISSUES: path.join(tmp, 'issues') } });
    for (const [what, bin, args] of [
        ['guard.js issue investigate', path.join(PG, 'scripts', 'guard.js'), ['issue', 'investigate', 'iss-20261106-000000-aaaaaa', '--sandbox', '--keep-real-data']],
        ['guard.js with --keep-real-data=1', path.join(PG, 'scripts', 'guard.js'), ['issue', 'new', '--keep-real-data=1', '--no-prompt']],
        ['plugin-guard (the wizard command)', path.join(PG, 'scripts', 'plugin-guard.js'), ['--description', 'x', '--root', SITE, '--keep-real-data', '--yes']]]) {
        const r = run(bin, args);
        ok(r.status === 2 && r.stderr.includes(RETIRED) && !/Unknown option/.test(r.stderr), `${what}: exit 2 with exactly "${RETIRED}" (got exit ${r.status})`);
    }
    // the guard:auto (combined command) refusal is tested in src/combined/scripts/selftest-auto-retired-flag.js (this package must not load src/combined)
    ok(!('keep-real-data' in guard.FLAGS) && guard.FLAGS.users === 'v', 'the parser table has no keep-real-data flag, and --users takes a value');
    ok(guard.parse(['issue', 'investigate', 'x', '--users', 'dummy']).users === 'dummy' && guard.parse(['--users=dummy']).users === 'dummy', '--users dummy is accepted');
    for (const v of ['real', 'REAL', 'keep=bob', 'keep=bob,ann', 'keep=', '', 'dummies', 'all', '1', '3']) {
        let e = null; try { guard.parse(['issue', 'investigate', 'x', `--users=${v}`]); } catch (x) { e = x; }
        ok(e && e.exitCode === 2 && /keeping real or named accounts is not available in this version/.test(e.message), `--users ${v || '(empty)'} fails with exit 2: "keeping real or named accounts is not available in this version"`);
    }
    { const r = run(path.join(PG, 'scripts', 'guard.js'), ['issue', 'investigate', 'iss-20261106-000000-aaaaaa', '--users', 'keep=bob']); ok(r.status === 2 && /keeping real or named accounts is not available in this version/.test(r.stderr) && !/bob@|Unknown/.test(r.stderr), `through guard.js: --users keep=bob exits 2 with the message (exit ${r.status})`); }

    group('static: nothing reads keepRealData any more, and the REAL PERSONAL DATA warning is gone');
    {
        // the two existing suites that mentioned it were converted to the refusal message with the owner's approval; this suite names it on purpose
        const EXEMPT = new Set(['scripts/selftest-6a-fake.js', 'scripts/selftest-issue-sandbox-lifecycle.js', 'scripts/selftest-6c2.js']);
        const SKIP_DIRS = new Set(['node_modules', 'issues', 'sandboxes', 'state', 'projects', 'reports', 'plugin-guard-reports', 'history', '.git']);
        const files = [];
        (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(f); } else if (/\.(js|json|cjs|mjs)$/.test(e.name)) files.push(path.relative(PG, f)); } })(PG);
        const bad = re => files.filter(f => !EXEMPT.has(f) && re.test(fs.readFileSync(path.join(PG, f), 'utf8')));
        ok(files.length > 100 && bad(/keepRealData/).length === 0, `no code under src/plugin-guard reads keepRealData (${files.length} files; found in: ${bad(/keepRealData/).join(', ') || 'none'})`);
        ok(bad(/REAL PERSONAL DATA/).length === 0, `the "REAL PERSONAL DATA" warning text is gone (found in: ${bad(/REAL PERSONAL DATA/).join(', ') || 'none'})`);
        ok(bad(/real_data_kept|real_data:/).length === 0, `no handle or summary field real_data / real_data_kept remains (found in: ${bad(/real_data_kept|real_data:/).join(', ') || 'none'})`);
        const kr = bad(/keep-real-data/);
        ok(kr.length === 1 && kr[0] === path.join('scripts', 'guard.js') && /KEEP_REAL_DATA_RETIRED/.test(fs.readFileSync(path.join(PG, kr[0]), 'utf8')), `the flag name appears only in the refusal in scripts/guard.js (found in: ${kr.join(', ')})`);
    }

    // ================================================================ the closed command table
    group('the closed command table: ONE new entry, `user update <numeric id> --user_pass=<generated>`; every other user subcommand stays refused');
    const P = cfg.testPassword();
    ok(cfg.TEST_PASSWORD.test(P) && wpcli.TEST_PASSWORD.test(P) && String(cfg.TEST_PASSWORD) === String(wpcli.TEST_PASSWORD) && P.length === 24, `a generated password is 24 letters and digits and matches the pattern of both modules (${P.length} characters)`);
    { const set = new Set(Array.from({ length: 200 }, () => cfg.testPassword())); ok(set.size === 200 && [...set].every(p => /[A-Z]/.test(p) || /[a-z]/.test(p)), '200 generated passwords are all different'); }
    const okArgs = a => { try { wpcli.checkArgs(a); return true; } catch { return false; } };
    ok(okArgs(['user', 'update', '1', `--user_pass=${P}`]) && okArgs(['user', 'update', '42', `--user_pass=${P}`, '--skip-email', '--skip-plugins', '--skip-themes']), 'user update <id> --user_pass=<generated> [--skip-email --skip-plugins --skip-themes] is accepted');
    ok(wpcli.RULES.filter(r => r.cmd.startsWith('user ')).map(r => r.cmd).sort().join() === 'user create,user list,user update', `the user commands in the table: ${wpcli.RULES.filter(r => r.cmd.startsWith('user ')).map(r => r.cmd).sort().join(', ')} (create and list were there before; update is the one new entry)`);
    for (const [args, what] of [
        [['user', 'update', 'admin', `--user_pass=${P}`], 'a login instead of a numeric id'], [['user', 'update', '0', `--user_pass=${P}`], 'id 0'], [['user', 'update', '-1', `--user_pass=${P}`], 'a negative id'],
        [['user', 'update', '1', '2', `--user_pass=${P}`], 'two ids'], [['user', 'update', '1'], 'no --user_pass'], [['user', 'update', `--user_pass=${P}`], 'no id'],
        [['user', 'update', '1', '--user_pass=short1'], 'a short password'], [['user', 'update', '1', '--user_pass=correct horse battery staple'], 'a password with spaces'], [['user', 'update', '1', "--user_pass=abc$(id)defghijklmnopqrstu"], 'a password with shell characters'],
        [['user', 'update', '1', `--user_pass=${P}`, '--user_email=a@example.invalid'], '--user_email'], [['user', 'update', '1', `--user_pass=${P}`, '--role=administrator'], '--role'], [['user', 'update', '1', `--user_pass=${P}`, '--user_login=root'], '--user_login'], [['user', 'update', '1', `--user_pass=${P}`, '--display_name=x'], '--display_name'],
        [['user', 'update', '1', `--user_pass=${P}`, '--exec=phpinfo();'], '--exec'], [['user', 'update', '1', `--user_pass=${P}`, '--require=/tmp/x.php'], '--require'],
        [['user', 'delete', '1', '--yes'], 'user delete'], [['user', 'application-password', 'create', '1', 'x'], 'user application-password create'], [['user', 'application-password', 'list', '1'], 'user application-password list'],
        [['user', 'set-role', '1', 'administrator'], 'user set-role'], [['user', 'add-role', '1', 'administrator'], 'user add-role'], [['user', 'remove-role', '1', 'subscriber'], 'user remove-role'], [['user', 'add-cap', '1', 'manage_options'], 'user add-cap'],
        [['user', 'meta', 'update', '1', 'wp_capabilities', 'x'], 'user meta update'], [['user', 'reset-password', '1'], 'user reset-password'], [['user', 'session', 'destroy', '1', '--all'], 'user session destroy'],
        [['user', 'spam', '1'], 'user spam'], [['user', 'import-csv', '/tmp/u.csv'], 'user import-csv'], [['user', 'generate', '--count=5'], 'user generate'], [['user', 'get', '1'], 'user get'], [['user', 'check-password', 'pgadmin', P], 'user check-password'],
        [['user', 'create', 'bob', 'bob@corp.com'], 'user create with a real e-mail domain (as before)']]) ok(throwsRefusal(() => wpcli.checkArgs(args)), `refused: ${what}`);
    {
        const sbr = path.join(tmp, 'wc'), d = path.join(sbr, 'iss-20261106-000000-abcdef'); fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(path.join(d, 'compose.json'), '{}'); fs.writeFileSync(path.join(d, 'state.json'), JSON.stringify({ project: 'pgsb0000abcd' }));
        const calls = [];
        const w = new wpcli.SandboxWpCli({ sandboxesRoot: sbr, sandboxDir: d, project: 'pgsb0000abcd', dockerBin: '/bin/true', runner: (b, a) => { calls.push(a); return { status: 0, stdout: '', stderr: '' }; } });
        ok(w.run(['user', 'update', '7', `--user_pass=${P}`, '--skip-email']).ok, 'the entry runs through SandboxWpCli');
        const line = w.commands[w.commands.length - 1];
        ok(line.includes('--user_pass=[REDACTED]') && !line.includes(P) && /^wp user update …/.test(line), `the audit trail shows [REDACTED] instead of the password: "${line}"`);
        ok(calls[0].includes(`--user_pass=${P}`) && calls[0].includes('exec') && calls[0].includes('cli'), 'the password reaches docker compose exec as one argument (argv; acceptable only because it is generated, single-use and the copy listens on 127.0.0.1)');
        w.run(['core', 'install', '--url=http://127.0.0.1:8080', '--title=t', '--admin_user=pgadmin', `--admin_password=${P}`, '--admin_email=a@example.invalid', '--skip-email']);
        ok(w.commands[w.commands.length - 1].includes('--admin_password=[REDACTED]') && !w.commands.some(c => c.includes(P)), 'core install is masked the same way');
    }

    // ================================================================ SQL (pure)
    group('anonymisation SQL: a count before every personal-data statement (numbers only); the dummy admin SQL');
    const an = cfg.anonymiseSql('wp_', ['users', 'usermeta', 'options', 'posts', 'postmeta', 'comments', 'wc_orders', 'woocommerce_sessions', 'crm_leads']);
    ok(an.items.length === an.statements.length && an.items.every((it, i) => it.sql === an.statements[i]), 'items[] lists every statement in the same order');
    ok(an.items.filter(i => i.kind === 'personal').every(i => /^SELECT COUNT\(\*\) AS pg_rows FROM `wp_[a-z_]+`( pm JOIN `wp_posts` p ON [^;]+)?( WHERE [^;]+)?$/.test(i.count)) && an.items.filter(i => i.kind === 'secrets').every(i => i.count === null), 'each personal-data statement has a COUNT(*) query of its own rows (no column is ever selected); secret blanking is not counted');
    ok(['users', 'usermeta', 'comments', 'options', 'postmeta', 'wc_orders', 'woocommerce_sessions'].every(t => an.items.some(i => i.table === t && i.count)), 'counted tables: users, usermeta, comments, options, postmeta, wc_orders, woocommerce_sessions');
    ok(/WHERE m\.meta_key = 'wp_capabilities' AND m\.meta_value LIKE '%s:13:"administrator";b:1;%'/.test(cfg.adminPickSql('wp_')) && /^SELECT MIN\(u\.ID\) AS pg_admin/.test(cfg.adminPickSql('wp_')), 'the dummy admin is the lowest ID whose role list grants administrator');
    ok(/SET user_login = 'pgadmin'.*user_email = 'pgadmin@example\.invalid'.*WHERE ID = 7$/.test(cfg.adminRewriteSql('wp_', '7')) && !/INSERT/i.test(cfg.adminRewriteSql('wp_', '7') + cfg.adminPickSql('wp_')), 'one row is rewritten to pgadmin / pgadmin@example.invalid; nothing is inserted (no account is ever created)');
    ok([() => cfg.adminRewriteSql('wp_', '1 OR 1=1'), () => cfg.adminRewriteSql('wp_', '0'), () => cfg.adminRewriteSql('wp_', 'x'), () => cfg.adminPickSql("wp_'; --")].every(f => { try { f(); return false; } catch { return true; } }), 'a non-numeric id or an unsafe prefix is refused');
    const q = cfg.usersCheckSql('wp_');
    ok(/^SELECT COUNT\(\*\) AS pg_unscrubbed/.test(q.unscrubbed) && /CONCAT\('user', ID\)/.test(q.unscrubbed) && /= 'pgadmin' AND COALESCE\(user_email, ''\) = 'pgadmin@example\.invalid'/.test(q.unscrubbed) && /^SELECT COUNT\(\*\) AS pg_admins/.test(q.admins), 'the re-check: placeholders, or exactly login pgadmin AND e-mail pgadmin@example.invalid; plus a separate count of pgadmin-looking rows');

    // ================================================================ builds against the fake docker
    group('a build from a database file: one dummy admin, a password in memory only, counts in the anonymise step');
    const issue = store.create({ title: '6c-2 fixture', description: 'the shop page is white', symptom: 'white-screen', environment: 'local', root: SITE, pages: ['/'] });
    const idir = store.dirOf(issue.id);
    const A = fakeEnv('admin', { ports: ['127.0.0.1:38080', '127.0.0.1:38999'], wp: withAdmin() });
    const got = [];
    const h = sandbox.create(issue.id, A.opts({ dump: SQL, onTestLogin: l => got.push(l) }));
    const pw = A.password();
    const L = A.log();
    ok(pw && cfg.TEST_PASSWORD.test(pw) && got.length === 1 && got[0].user === 'pgadmin' && got[0].password === pw, `onTestLogin was called once with pgadmin and the password that was set (${pw ? pw.length : 0} characters)`);
    ok(h.test_login && h.test_login.password === pw && !Object.keys(h).includes('test_login') && !JSON.stringify(h, (k, v) => (k === 'wp' ? undefined : v)).includes(pw), 'the handle carries it as a non-enumerable field: JSON.stringify(handle) does not contain it');
    const iRewrite = L.findIndex(l => /SET user_login = 'pgadmin'/.test(l.stdin || '')), iCheck = L.findIndex(l => /pg_unscrubbed/.test(l.stdin || '')), iAdmins = L.findIndex(l => /pg_admins/.test(l.stdin || ''));
    const iUpd = L.findIndex(l => l.args.includes('update') && l.args.some(a => /^--user_pass=/.test(a))), iStart = L.findIndex(l => sub(l, 'start', 'wordpress'));
    const iAnon = L.findIndex(l => /user_email = CONCAT/.test(l.stdin || ''));
    ok(iAnon >= 0 && iAnon < iRewrite && iRewrite < iCheck && iCheck < iAdmins && iAdmins < iUpd && iUpd < iStart, `order: anonymise (${iAnon}) -> pgadmin rewrite (${iRewrite}) -> users re-check (${iCheck}) -> pgadmin count (${iAdmins}) -> user update (${iUpd}) -> start web (${iStart})`);
    ok(L.slice(iAnon, iStart).every(l => l.web_running === false), 'all of it while the web container is stopped');
    const upd = L[iUpd].args, at = upd.indexOf('wp');
    ok(upd.slice(at + 1, at + 4).join(' ') === 'user update 1' && ['--skip-email', '--skip-plugins', '--skip-themes'].every(f => upd.includes(f)), 'wp user update 1 --user_pass=... --skip-email --skip-plugins --skip-themes (no plugin code runs, no mail)');
    ok(!L.some(l => l.args.includes('create') && l.args.includes('user')) && !L.some(l => !l.args.join(' ').includes('wp db import -') && /INSERT INTO/i.test(l.stdin || '')), 'no account was created (no user create, no INSERT)');
    const anonStep = h.steps.find(s => s.id === 'anonymise');
    ok(anonStep && /rewritten or removed: users 12, usermeta 0, comments 340, options 0, postmeta 0/.test(anonStep.reason) && /NOT scrubbed \(tables of other plugins\): crm_leads, slider_items/.test(anonStep.reason), `the anonymise step has the counts and the unchecked tables: "${anonStep && anonStep.reason.slice(0, 260)}"`);
    ok(h.steps.some(s => s.id === 'test-login' && s.status === 'PASSED' && /login pgadmin/.test(s.reason)) && h.dummy_admin === true && h.users === 'dummy', 'a test-login step (PASSED) names the login, never the password');
    ok(JSON.stringify(h.removal_counts) === JSON.stringify({ users: 12, usermeta: 0, comments: 340, options: 0, postmeta: 0 }) && h.unchecked_tables === 2, `removal_counts ${JSON.stringify(h.removal_counts)}, unchecked_tables ${h.unchecked_tables}`);
    const ud = JSON.parse(fs.readFileSync(path.join(idir, 'work', 'user-data.json'), 'utf8'));
    ok(ud.users === 'dummy' && ud.dummy_admin === true && ud.unchecked_tables === 2 && ud.removal_counts.comments === 340 && (fs.statSync(path.join(idir, 'work', 'user-data.json')).mode & 0o777) === 0o600, 'work/user-data.json (0600) holds the same numbers and fixed words');
    ok(!/slider|crm/.test(fs.readFileSync(path.join(idir, 'work', 'user-data.json'), 'utf8')), 'user-data.json holds the number of unchecked tables, not their names or content');
    const sbFiles = countFiles(h.dir), issueFiles = countFiles(idir);
    ok(sbFiles > 5 && filesWith(h.dir, pw).length === 0, `the password is in none of the ${sbFiles} files of the sandbox folder (state.json, compose.json, wp-config.php, logs, versions.json, ...)`);
    ok(issueFiles > 2 && filesWith(idir, pw).length === 0, `nor in any of the ${issueFiles} files of the issue folder`);
    ok(!JSON.stringify(h.steps).includes(pw) && !JSON.stringify(h.warnings).includes(pw) && !h.wp.commands.some(c => c.includes(pw)) && h.wp.commands.some(c => c === 'wp user update … --user_pass=[REDACTED]'), 'nor in a step, a warning or the WP-CLI audit trail (which shows [REDACTED])');
    h.destroy(); ok(leftovers(A) === 0 && !fs.existsSync(h.dir), 'destroy leaves nothing');

    group('no administrator in the database: no dummy admin (none is created), and the build goes on');
    const N = fakeEnv('noadmin', { wp: base(COUNTS) });
    const gotN = [];
    const hn = sandbox.create(newId(), N.opts({ dump: SQL, onTestLogin: l => gotN.push(l) }));
    ok(!N.password() && !N.log().some(l => l.args.includes('update') && l.args.includes('user')) && hn.dummy_admin === false && hn.test_login === null, 'no user update was sent and the handle has no test login');
    ok(hn.steps.some(s => s.id === 'test-login' && s.status === 'SKIPPED' && /no administrator account was found in your database file/.test(s.reason)) && gotN.length === 1 && gotN[0].user === null && /no administrator account/.test(gotN[0].reason), 'the step and the callback say there is no administrator account');
    ok(N.log().some(l => /pg_admins/.test(l.stdin || '')) && hn.steps.some(s => s.id === 'web-started'), 'the pgadmin count (0 expected) ran and the web container started');
    hn.destroy();

    group('the test password cannot be set: the build goes on without a test login, the warning does not carry it');
    const U = fakeEnv('updfail', { wp: withAdmin([{ match: 'user update', status: 1, stderr: 'Error: could not update\n' }]) });
    const gotU = [];
    const hu = sandbox.create(newId(), U.opts({ dump: SQL, onTestLogin: l => gotU.push(l) }));
    const pu = U.password();
    ok(pu && hu.test_login === null && hu.dummy_admin === false && gotU[0].user === null && /could not be set/.test(gotU[0].reason) && hu.warnings.some(w => /could not be set/.test(w)) && !JSON.stringify([hu.steps, hu.warnings]).includes(pu), 'no test login, a warning without the password');
    hu.destroy();

    group('fail closed: the post-anonymise check accepts exactly one dummy admin row and refuses everything else');
    for (const [name, rules, re] of [
        ['second-real-row', withAdmin([{ match: 'db query', stdin: 'pg_unscrubbed', out: 'pg_unscrubbed\n1\n' }]), /1 user row\(s\) still had a real login/],
        ['pgadmin-real-email', withAdmin([{ match: 'db query', stdin: 'pg_unscrubbed', out: 'pg_unscrubbed\n1\n' }]), /still had a real login/],   // the SQL counts a pgadmin row whose e-mail is not pgadmin@example.invalid (proved on MySQL in -docker)
        ['second-pgadmin', withAdmin([{ match: 'db query', stdin: 'AS pg_admins FROM', out: 'pg_admins\n2\n' }]), /2 user row\(s\) looked like the dummy administrator, exactly 1 expected/],
        ['pgadmin-missing', withAdmin([{ match: 'db query', stdin: 'AS pg_admins FROM', out: 'pg_admins\n0\n' }]), /0 user row\(s\) looked like the dummy administrator, exactly 1 expected/],
        ['pgadmin-without-admin', base([...COUNTS, { match: 'db query', stdin: 'AS pg_admins FROM', out: 'pg_admins\n1\n' }]), /1 user row\(s\) looked like the dummy administrator, none expected/],
        ['admins-unreadable', withAdmin([{ match: 'db query', stdin: 'AS pg_admins FROM', status: 1, stderr: 'ERROR 1054\n' }]), /dummy administrator could not be checked \(ERROR 1054\)/],
        ['admins-empty', withAdmin([{ match: 'db query', stdin: 'AS pg_admins FROM', out: '' }]), /dummy administrator could not be checked \(unexpected answer\)/],
        ['unscrubbed-empty', withAdmin([{ match: 'db query', stdin: 'pg_unscrubbed', out: '' }]), /users table could not be checked \(unexpected answer\)/],
        ['unscrubbed-unreadable', withAdmin([{ match: 'db query', stdin: 'pg_unscrubbed', status: 1, stderr: 'ERROR 2013\n' }]), /users table could not be checked \(ERROR 2013\)/]]) {
        const F = fakeEnv('closed-' + name, { wp: rules });
        const id = newId();
        const e = await rejects(() => sandbox.create(id, F.opts({ dump: SQL, onTestLogin: () => { throw new Error('the callback must not run for a refused build'); } })), re);
        const FL = F.log();
        ok(e && FL.some(l => l.args.join(' ').includes('wp db import -')) && !FL.some(l => sub(l, 'start')), `${name}: refused (${e ? e.message.slice(0, 100) : 'NOT refused as expected'}), the web container was never started again`);
        ok(leftovers(F) === 0 && !fs.existsSync(path.join(F.sandboxesRoot, id)) && !FL.some(l => l.args.includes('update') && l.args.includes('user')), `${name}: destroyed, and no password was set`);
    }

    // ================================================================ findings.json and the developer block (the sandbox phase + result.js)
    group('findings.json: users, per-table counts and the number of unchecked tables; the developer block');
    {
        const root = path.join(tmp, 'pipe', 'wp'); const tc = trees.duplicateFunction(root);
        fs.writeFileSync(path.join(root, 'plugin-guard.config.json'), JSON.stringify(tc.config));
        const config = path.join(root, 'plugin-guard.config.json');
        const iss = store.create({ title: 'Pipeline', description: tc.description, symptom: tc.symptom, environment: 'local', root, pages: ['/'] });
        await require('../issue/evidence').run(iss.id, { root, probeOptions: { probe: false } });
        const anz = require('../issue/analysis').run(iss.id, { root, config });
        const F = fakeEnv('pipe', { wp: withAdmin([{ match: 'plugin list', out: 'plugin-a\nplugin-b\n' }, { match: 'theme list', out: 'acme\ntwentytwentysix\n' }, { match: 'option get stylesheet', out: 'acme\n' }]) });
        const real = probe.runSandbox; probe.runSandbox = async () => ({ ok: true, pages: [], status_codes: [200], oracle: { result: 'no' } });
        const seen = [];
        let sb; try { sb = await require('../issue/sandbox-phase').run(iss.id, { root, options: { sandbox: true, dump: SQL }, analysis: { ...anz.analysis, components: anz.analysis.components, top: anz.analysis.top }, sandboxOptions: F.base({ pageCheck: () => ({ status: 200 }), onTestLogin: l => seen.push(l) }) }); } finally { probe.runSandbox = real; }
        const ppw = F.password();
        const validate = require('../issue/validate'), resolve = require('../issue/resolve');
        const dir = store.dirOf(iss.id), val = validate.run(iss.id, { root, config, lint: () => ({ ok: true, message: '' }) }), pol = validate.policyFor(root, config);
        resultMod.write(iss.id, { validation: val, plans: resolve.build(iss.id, val, { root, policy: pol, dir }), dir, root, policy: pol, gate: true });
        const f = JSON.parse(fs.readFileSync(path.join(dir, 'result', 'findings.json'), 'utf8'));
        const sm = f.sandbox && f.sandbox.summary;
        ok(sb.sandbox && sm && sm.users === 'dummy' && sm.dummy_admin === true && JSON.stringify(sm.removal_counts) === JSON.stringify({ users: 12, usermeta: 0, comments: 340, options: 0, postmeta: 0 }) && sm.unchecked_tables === 2 && !('real_data_kept' in sm), `findings.json sandbox.summary: ${JSON.stringify(sm && { users: sm.users, dummy_admin: sm.dummy_admin, removal_counts: sm.removal_counts, unchecked_tables: sm.unchecked_tables })}`);
        const dev = f.case_file ? f.case_file.developer : [];
        ok(dev.includes('2 tables could not be checked and are copied as they are.') && dev.some(l => /^Test copy, rewritten or removed: users 12, usermeta 0, comments 340/.test(l)) && dev.includes(cli.OTHER_TABLES_NOTE) && dev.some(l => /^Test copy users: dummy users only/.test(l)), 'the developer block lists users, the counts, the unchecked-tables line and the other-tables note');
        ok(fs.readFileSync(path.join(dir, 'result', 'ISSUE-REPORT.md'), 'utf8').includes('2 tables could not be checked and are copied as they are.'), 'and so does ISSUE-REPORT.md');
        ok(ppw && seen.length === 1 && seen[0].password === ppw && filesWith(dir, ppw).length === 0 && countFiles(dir) > 10, `the password set in this build is in none of the ${countFiles(dir)} files of the issue folder (findings.json, issue.html, ISSUE-REPORT.md, work/sandbox.json, ...)`);
        ok(!JSON.stringify(sb).includes(ppw), 'nor in what the sandbox phase returned (its steps and summary)');
        const caseLines = caseFile.userDataLines(resultMod.cleanUserData({ schema: 1, users: 'dummy', dummy_admin: false, removal_counts: { users: 3, '<b>x': 9, comments: -1, posts: 'x' }, unchecked_tables: 0 }));
        ok(caseLines[1] === 'Test copy, rewritten or removed: users 3.' && caseLines[2] === '0 tables could not be checked and are copied as they are.' && /no dummy administrator/.test(caseLines[0]), 'only table-name keys and whole numbers pass into the report');
        ok(resultMod.cleanUserData({ schema: 1, users: 'real', unchecked_tables: 1 }) === null && resultMod.cleanUserData({ schema: 1, users: 'dummy', unchecked_tables: 'x' }) === null, 'a user-data file that is not "dummy" with a number is not shown');
    }

    // ================================================================ the wizard and the command line
    group('the wizard: the user-accounts question (exact text), answers 1 and 0, and the one terminal line with the password');
    const WIZ_SITE = path.join(tmp, 'wsite', 'wp'); trees.duplicateFunction(WIZ_SITE); write(WIZ_SITE, 'wp-content/themes/acme/style.css', '/* Theme Name: Acme */');
    const realVerify = require('../issue/verify-fixes').run;
    require('../issue/verify-fixes').run = async () => ({ steps: [], results: 0 });   // no second sandbox in this test (it would need real Docker)
    const realProbe = probe.runSandbox; probe.runSandbox = async () => ({ ok: true, pages: [], status_codes: [200], oracle: { result: 'no' } });
    async function wiz(name, answers, flags, { tty = true, fake = withAdmin() } = {}) {
        const F = fakeEnv('wiz-' + name, { wp: fake });
        const input = new PassThrough(), output = new PassThrough();
        let text = ''; output.on('data', d => { text += d; });
        input.end(answers.join('\n') + (answers.length ? '\n' : ''));
        const saved = process.env.PLUGIN_GUARD_ISSUES, log = console.log, err = console.error, ew = process.stderr.write;
        let logged = '', errs = '';
        console.log = (...a) => { logged += a.join(' ') + '\n'; }; console.error = (...a) => { errs += a.join(' ') + '\n'; }; process.stderr.write = (c, ...r) => { errs += String(c); return true; };
        let error = null, code = null;
        const out = path.join(tmp, 'out-' + name);
        try { code = await wizard.run({ _: [], description: 'The shop page is white since the update', root: WIZ_SITE, 'no-probe': true, out, ...flags }, { input, output, tty, cwd: tmp, env: { HOME: tmp }, preflight: () => ({ ok: true }), siteRoots: [], sandboxOptions: F.base({ pageCheck: () => ({ status: 200 }) }) }); }
        catch (e) { error = e; } finally { console.log = log; console.error = err; process.stderr.write = ew; if (saved === undefined) delete process.env.PLUGIN_GUARD_ISSUES; else process.env.PLUGIN_GUARD_ISSUES = saved; }
        const ids = fs.existsSync(out) ? fs.readdirSync(out).filter(x => store.ISSUE_RE.test(x)) : [];
        return { F, text: text + logged, errs, error, code, dir: ids.length ? path.join(out, ids[0]) : null, out };
    }
    const Qtext = wizard.USERS_QUESTION.join('\n');
    ok(Qtext === 'Your database file contains user accounts. How should the test copy handle them?\n  1) Use dummy users only. Your real users are not copied.\n  0) Skip the test copy\nKeeping real or named accounts is not available in this version. The database stays on this computer, is deleted afterwards and is never sent anywhere.', 'the question text is exactly the agreed text (no option 2 or 3)');
    {
        const r = await wiz('one', ['', '', '1'], { sandbox: true, 'db-dump': SQL, 'keep-sandbox': true });
        const wp1 = r.F.password();
        ok(!r.error && r.text.includes(Qtext) && occurrences(r.text, 'Your database file contains user accounts') === 1, `asked once with a terminal and a database file${r.error ? ` (error: ${r.error.message})` : ''}`);
        ok(wp1 && occurrences(r.text, `Test login for the copy: pgadmin / ${wp1}  (shown only here, never saved)`) === 1 && occurrences(r.text, wp1) === 1 && !r.errs.includes(wp1), 'answer 1: the copy is built and the one terminal line shows the password, exactly once; it is nowhere else in stdout or stderr');
        ok(occurrences(r.text, '2 tables could not be checked and are copied as they are.') === 1 && occurrences(r.text, cli.OTHER_TABLES_NOTE) === 1 && /FOR A DEVELOPER[\s\S]*2 tables could not be checked/.test(r.text), 'the unchecked-tables line and the other-tables note are printed once, in the summary after the build (FOR A DEVELOPER)');
        ok(r.text.indexOf(Qtext) < r.text.indexOf('Test login for the copy'), 'order: the question, then (after the build) the test login');
        const sbDir = r.dir && path.join(r.F.sandboxesRoot, path.basename(r.dir));
        ok(r.dir && fs.existsSync(sbDir) && filesWith(sbDir, wp1).length === 0 && countFiles(sbDir) > 5, `the kept sandbox folder (${sbDir ? countFiles(sbDir) : 0} files) does not contain the password`);
        ok(r.dir && filesWith(r.out, wp1).length === 0 && fs.existsSync(path.join(r.dir, 'result', 'findings.json')), `no file under the reports folder (${countFiles(r.out)} files: findings.json, report, work files, site copy) contains it`);
        const f1 = JSON.parse(fs.readFileSync(path.join(r.dir, 'result', 'findings.json'), 'utf8'));
        ok(f1.sandbox.summary.unchecked_tables === 2 && f1.sandbox.summary.users === 'dummy', 'findings.json records users dummy and 2 unchecked tables');
        if (r.dir) sandbox.destroy(path.basename(r.dir), r.F.base());
        ok(leftovers(r.F) === 0 && !fs.existsSync(sbDir), 'the kept sandbox is destroyed afterwards');
    }
    {
        const r = await wiz('zero', ['', '', '0'], { sandbox: true, 'db-dump': SQL });
        const f0 = r.dir ? JSON.parse(fs.readFileSync(path.join(r.dir, 'result', 'findings.json'), 'utf8')) : null;
        ok(!r.error && r.text.includes(Qtext) && !r.F.log().some(l => l.args[0] === 'compose') && !/Test login for the copy/.test(r.text) && f0 && f0.timeline.some(s => s.id === 'sandbox' && s.status === 'NOT_RUN'), 'answer 0: no test copy (no compose call, the sandbox step is NOT_RUN), no password line; the rest of the check still runs');
        ok(!r.text.includes(cli.OTHER_TABLES_NOTE), 'answer 0: no other-tables note (no database is used)');
    }
    {
        const r = await wiz('retry', ['', '', '2', 'REAL', '1'], { sandbox: true, 'db-dump': SQL });
        ok(!r.error && occurrences(r.text, 'Please type 1 (dummy users only) or 0 (skip the test copy).') === 2 && /Test login for the copy: pgadmin \//.test(r.text), 'answers 2 and REAL are not accepted (asked again), then 1 builds');
    }
    for (const [name, flags, tty] of [['yes', { yes: true }, true], ['noq', { 'no-questions': true }, true], ['noprompt', { 'no-prompt': true }, true], ['notty', {}, false], ['users-flag', { users: 'dummy' }, true]]) {
        const r = await wiz(name, name === 'users-flag' ? ['', ''] : [], { sandbox: true, 'db-dump': SQL, ...flags }, { tty });
        const pwx = r.F.password();
        ok(!r.error && !r.text.includes('Your database file contains user accounts') && pwx && r.F.log().some(l => /pg_admins/.test(l.stdin || '')), `${name}: not asked, the answer is 1 (the copy is built with dummy users)${r.error ? ` (error: ${r.error.message})` : ''}`);
        ok(tty ? occurrences(r.text, pwx) === 1 : !r.text.includes(pwx) && !r.errs.includes(pwx) && !/Test login for the copy/.test(r.text), tty ? `${name}: with a terminal the password line is printed once` : `${name}: without a terminal the password is never printed`);
        ok(r.dir && filesWith(r.out, pwx).length === 0, `${name}: no file under the reports folder contains the password`);
    }
    {
        const r = await wiz('nodump', ['', ''], { sandbox: true }, { fake: base() });
        ok(!r.error && !r.text.includes('Your database file contains user accounts') && !/Test login|tables could not be checked/.test(r.text) && !r.text.includes(cli.OTHER_TABLES_NOTE), 'without a database file: no question, no user-data lines');
    }
    {
        const r = await wiz('noadmin', ['', '', '1'], { sandbox: true, 'db-dump': SQL }, { fake: base(COUNTS) });
        ok(!r.error && r.text.includes('The test copy has no test login: no administrator account was found in your database file.') && !/Test login for the copy/.test(r.text), 'no administrator in the database: the terminal says there is no test login');
    }
    group('the command line without the wizard (issue investigate --sandbox --db-dump, no --gate): the lines are printed by issue-cli');
    {
        const F = fakeEnv('cli', { wp: withAdmin() });
        const iss = store.create({ title: 'CLI', description: 'white page', symptom: 'white-screen', environment: 'local', root: WIZ_SITE, pages: ['/'] });
        const log = console.log; let logged = ''; console.log = (...a) => { logged += a.join(' ') + '\n'; };
        const lines = [];
        let error = null;
        try { await cli.investigate(iss.id, { _: [], sandbox: true, 'db-dump': SQL, 'no-probe': true, 'no-questions': true }, 'investigate', { interactive: false, loginOut: { tty: false, write: t => lines.push(t) }, sandboxOptions: F.base({ pageCheck: () => ({ status: 200 }) }) }); }
        catch (e) { error = e; } finally { console.log = log; }
        const pc = F.password();
        ok(!error && occurrences(logged, cli.OTHER_TABLES_NOTE) === 1 && occurrences(logged, '2 tables could not be checked and are copied as they are.') === 1, `the other-tables note and the unchecked-tables line are printed once each${error ? ` (error: ${error.message})` : ''}`);
        ok(pc && !logged.includes(pc) && !lines.length, 'not a terminal: the password is not printed (nothing was written to the terminal line)');
        ok(filesWith(store.dirOf(iss.id), pc).length === 0, 'and it is in no file of the issue folder');
        const lines2 = [];
        const F2 = fakeEnv('cli-tty', { wp: withAdmin() });
        const iss2 = store.create({ title: 'CLI tty', description: 'white page', symptom: 'white-screen', environment: 'local', root: WIZ_SITE, pages: ['/'] });
        console.log = () => {};
        try { await cli.investigate(iss2.id, { _: [], sandbox: true, 'db-dump': SQL, 'no-probe': true, 'no-questions': true }, 'investigate', { interactive: false, loginOut: { tty: true, write: t => lines2.push(t) }, sandboxOptions: F2.base({ pageCheck: () => ({ status: 200 }) }) }); } finally { console.log = log; }
        ok(lines2.length === 1 && lines2[0] === `Test login for the copy: pgadmin / ${F2.password()}  (shown only here, never saved)`, 'on a terminal: exactly one line, in the agreed words');
    }
    require('../issue/verify-fixes').run = realVerify; probe.runSandbox = realProbe;

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(failures ? `\n${failures} FAILED` : '\nAll checks passed');
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
