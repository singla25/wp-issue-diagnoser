#!/usr/bin/env node
// Self-test of TEST-COPY-SPEC 6c-2 (dummy users only) against a REAL Docker daemon: a sandbox built from the fixture database export
// (scripts/fixtures/issue/dump/wp-site.sql.txt: user 1 is an administrator, user 2 a subscriber). It SKIPS LOUDLY (exit 0, a SKIP line saying
// nothing was verified) when Docker is not usable or the pinned images are missing (`npm run guard:setup-sandbox`). Nothing is pulled.
// What it proves on MySQL: every account is rewritten in place (IDs kept) and exactly the lowest-ID administrator is pgadmin /
// pgadmin@example.invalid; its new password (generated at run time, set with `wp user update <id> --user_pass=...`) is accepted by WordPress's own
// wp_check_password and a wrong one is not; the other accounts keep the unusable '!' hash; the per-table counts match the rows; the re-check SQL
// counts what it must (a real row, a pgadmin row with another e-mail, a second pgadmin row) on the real server; and the password is in no file of
// the sandbox or issue folder, no step, warning or audit line.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const sandbox = require('../issue/sandbox');

const pf = sandbox.preflight({});
if (!pf.ok) { console.log(`SKIP  selftest-6c2-docker was NOT run: it needs a usable Docker daemon and the pinned sandbox images.\n  reason: ${pf.reason}\n  Nothing in this suite is claimed as verified in this environment.`); process.exit(0); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-6c2-dk-'));
process.env.PLUGIN_GUARD_ISSUES = path.join(tmp, 'issues');
fs.mkdirSync(process.env.PLUGIN_GUARD_ISSUES, { mode: 0o700 });
const store = require('../lib/issue-store');
const cfg = require('../issue/sandbox-config');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const group = t => console.log(`\n== ${t}`);
function hashTree(dir) { const h = crypto.createHash('sha256'); (function walk(d) { for (const n of fs.readdirSync(d).sort()) { const f = path.join(d, n), st = fs.lstatSync(f); h.update(`${path.relative(dir, f)}|${st.isSymbolicLink() ? 'l' : st.isDirectory() ? 'd' : 'f'}|${st.mode}|`); if (st.isDirectory()) walk(f); else if (st.isFile()) h.update(fs.readFileSync(f)); } })(dir); return h.digest('hex'); }
const filesWith = (dir, needle) => { const hits = []; (function walk(d) { let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (e.isFile()) { try { if (fs.readFileSync(f).includes(needle)) hits.push(f); } catch { /* a file of the container user that this user cannot read: listed as unreadable below */ } } } })(dir); return hits; };
const unreadable = dir => { const out = []; (function walk(d) { let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { out.push(d); return; } for (const e of es) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (e.isFile()) { try { fs.accessSync(f, fs.constants.R_OK); } catch { out.push(f); } } } })(dir); return out; };
const countFiles = dir => { let n = 0; (function walk(d) { let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { if (e.isDirectory()) walk(path.join(d, e.name)); else n++; } })(dir); return n; };
const labelled = () => { const l = sandbox.labelled({ dockerBin: 'docker', runner: spawnSync, env: process.env }); return l.containers.length + l.volumes.length + l.networks.length; };

const SITE = path.join(tmp, 'site');
fs.mkdirSync(path.join(SITE, 'wp-content', 'plugins', 'probe-plugin'), { recursive: true });
fs.mkdirSync(path.join(SITE, 'wp-content', 'themes'), { recursive: true });
fs.writeFileSync(path.join(SITE, 'wp-content', 'plugins', 'probe-plugin', 'probe-plugin.php'), "<?php\n/* Plugin Name: Probe Plugin */\n");
const SITE_HASH = hashTree(SITE);
const SB = path.join(tmp, 'sandboxes');
const DUMP = path.join(tmp, 'in', 'site.sql');
fs.mkdirSync(path.dirname(DUMP)); fs.copyFileSync(path.join(__dirname, 'fixtures', 'issue', 'dump', 'wp-site.sql.txt'), DUMP);
const rows = r => (r.ok ? r.stdout.split('\n').slice(1).filter(Boolean) : null);
const one = r => (r.ok ? (r.stdout.split('\n')[1] || '').trim() : null);

(async () => {
    const before = labelled();
    const issue = store.create({ title: '6c-2 docker', description: 'white page', symptom: 'white-screen', environment: 'local', root: SITE, pages: ['/'] });
    const idir = store.dirOf(issue.id);
    group('a sandbox built from the fixture export: dummy users in place, one known dummy admin, a password in memory only');
    const got = [];
    const h = sandbox.create(issue.id, { root: SITE, sandboxesRoot: SB, dump: DUMP, onTestLogin: l => got.push(l) });
    try {
        const pw = h.test_login && h.test_login.password;
        ok(got.length === 1 && got[0].user === 'pgadmin' && cfg.TEST_PASSWORD.test(pw || '') && got[0].password === pw, `onTestLogin got pgadmin and a ${pw ? pw.length : 0}-character generated password`);
        const users = rows(h.wp.sql('SELECT ID, user_login, user_email, user_nicename FROM `wp_users` ORDER BY ID'));
        ok(users && users.join('|') === '1\tpgadmin\tpgadmin@example.invalid\tpgadmin|2\tuser2\tuser2@example.invalid\tuser-2', `users rewritten in place, IDs kept: ${users && users.join(' | ')}`);
        const hashes = rows(h.wp.sql("SELECT ID, user_pass = '!' AS unusable FROM `wp_users` ORDER BY ID"));
        ok(hashes && hashes.join('|') === '1\t0|2\t1', 'the dummy admin has a new password hash; every other account keeps the unusable "!" hash');
        // WordPress's own check, inside the web container; the password goes on stdin (not on this computer's command line) in this test
        const check = p => spawnSync('docker', ['compose', '-p', h.project, '-f', h.composeFile, 'exec', '-T', 'wordpress', 'php'], { encoding: 'utf8', timeout: 120000, input: `<?php\nrequire '/var/www/html/wp-load.php';\n$u = get_user_by( 'login', 'pgadmin' );\necho ( $u && wp_check_password( ${JSON.stringify(p)}, $u->user_pass, $u->ID ) ) ? 'PG-LOGIN-OK' : 'PG-LOGIN-NO';\n` });
        const good = check(pw), bad = check(cfg.testPassword());
        ok(/PG-LOGIN-OK/.test(good.stdout) && /PG-LOGIN-NO/.test(bad.stdout), `WordPress accepts the generated password for pgadmin and refuses another one (${good.stdout.trim().slice(-20)} / ${bad.stdout.trim().slice(-20)})`);
        const role = one(h.wp.sql("SELECT meta_value FROM `wp_usermeta` WHERE user_id = 1 AND meta_key = 'wp_capabilities'"));
        ok(/s:13:"administrator";b:1;/.test(role || ''), 'pgadmin is the account that was the administrator (its role is untouched)');

        group('counts: numbers only, matching the rows');
        const nUsers = Number(one(h.wp.sql('SELECT COUNT(*) AS n FROM `wp_users`'))), nComments = Number(one(h.wp.sql('SELECT COUNT(*) AS n FROM `wp_comments`')));
        ok(h.removal_counts && h.removal_counts.users === nUsers && h.removal_counts.comments === nComments && nUsers === 2 && nComments >= 1, `removal_counts users ${h.removal_counts && h.removal_counts.users} (table has ${nUsers}), comments ${h.removal_counts && h.removal_counts.comments} (table has ${nComments})`);
        const st = h.steps.find(s => s.id === 'anonymise');
        ok(st && new RegExp(`rewritten or removed: users ${nUsers}, usermeta \\d+, comments ${nComments}`).test(st.reason) && h.unchecked_tables === h.tables_unscrubbed.length, `the anonymise step: "${st && st.reason.slice(0, 200)}"`);
        const ud = JSON.parse(fs.readFileSync(path.join(idir, 'work', 'user-data.json'), 'utf8'));
        ok(ud.users === 'dummy' && ud.dummy_admin === true && ud.removal_counts.users === nUsers && ud.unchecked_tables === h.unchecked_tables, 'work/user-data.json in the issue folder holds the same numbers');

        group('the re-check SQL on the real server: what it counts');
        const q = cfg.usersCheckSql('wp_');
        const ins = (id, login, mail) => h.wp.sql(`INSERT INTO \`wp_users\` (ID, user_login, user_pass, user_nicename, user_email, user_url, user_registered, user_activation_key, user_status, display_name) VALUES (${id}, '${login}', '!', '${login}', '${mail}', '', '2026-01-01 00:00:00', '', 0, 'x')`);
        const del = id => h.wp.sql(`DELETE FROM \`wp_users\` WHERE ID = ${id}`);
        const counts = () => [one(h.wp.sql(q.unscrubbed)), one(h.wp.sql(q.admins))].join('/');
        ok(counts() === '0/1', `as built: 0 unscrubbed, 1 pgadmin (${counts()})`);
        ins(100, 'jane', 'jane@example.com'); ok(counts() === '1/1', `a second real row is counted (${counts()})`); del(100);
        h.wp.sql("UPDATE `wp_users` SET user_email = 'pgadmin@example.com' WHERE ID = 1"); ok(counts() === '1/1', `a pgadmin row with another e-mail is counted as unscrubbed (${counts()})`); h.wp.sql("UPDATE `wp_users` SET user_email = 'pgadmin@example.invalid' WHERE ID = 1");
        h.wp.sql("UPDATE `wp_users` SET user_email = 'real.person@example.com@example.invalid' WHERE ID = 1"); ok(counts() === '1/1', `a pgadmin row whose e-mail only ENDS in @example.invalid is counted as unscrubbed (${counts()})`); h.wp.sql("UPDATE `wp_users` SET user_email = 'pgadmin@example.invalid' WHERE ID = 1");
        ins(101, 'pgadmin2', 'pgadmin@example.invalid'); ok(counts() === '1/2', `a second row with the dummy admin's e-mail is counted twice (${counts()})`); del(101);
        ins(102, 'user5', 'user5@example.invalid'); ok(counts() === '1/1', `a placeholder that does not match its own ID is counted (${counts()})`); del(102);
        ok(counts() === '0/1', `back to the built state (${counts()})`);

        group('the password is nowhere but in memory');
        const sbFiles = countFiles(h.dir), cant = unreadable(h.dir);
        ok(pw && filesWith(h.dir, pw).length === 0 && sbFiles > 20, `none of the ${sbFiles} files of the sandbox folder contains it (state.json, compose.json, wp-config.php, proxy.conf, logs, the site copy)${cant.length ? `; ${cant.length} file(s) owned by the container user could not be read` : ''}`);
        ok(filesWith(idir, pw).length === 0 && countFiles(idir) >= 2, `none of the ${countFiles(idir)} files of the issue folder contains it`);
        ok(!JSON.stringify([h.steps, h.warnings]).includes(pw) && !h.wp.commands.some(c => c.includes(pw)) && h.wp.commands.includes('wp user update … --user_pass=[REDACTED]'), 'no step, warning or audit line contains it; the audit line shows [REDACTED]');
        ok(!JSON.stringify(h, (k, v) => (k === 'wp' ? undefined : v)).includes(pw), 'JSON.stringify(handle) does not contain it');
        const logs = spawnSync('docker', ['compose', '-p', h.project, '-f', h.composeFile, 'logs', '--no-color'], { encoding: 'utf8', timeout: 120000, maxBuffer: 50 * 1024 * 1024 });
        ok(logs.status === 0 && !logs.stdout.includes(pw) && !logs.stderr.includes(pw), 'the containers\' own logs do not contain it');
    } finally { h.destroy(); }
    ok(labelled() === before && !fs.existsSync(h.dir), 'after destroy no labelled container, volume or network is left, and the folder is gone');
    ok(hashTree(SITE) === SITE_HASH, 'the original site tree is byte-for-byte unchanged');
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(failures ? `\n${failures} FAILED` : '\nAll checks passed');
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); try { sandbox.sweep({}); } catch { /* ignore */ } process.exit(1); });
