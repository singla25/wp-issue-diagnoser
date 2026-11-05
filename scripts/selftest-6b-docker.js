#!/usr/bin/env node
// Self-test of TEST-COPY-SPEC Part 6b against a REAL Docker daemon. It SKIPS LOUDLY (exit 0, SKIP lines that say what was NOT verified) when Docker is
// not usable or an image it needs is missing. Plugin Guard never pulls anything on its own: the owner runs  npm run guard:setup-sandbox -- --repin
// and then  npm run guard:setup-sandbox -- --php <x.y> --db mysql .
//   1. the real mariadb-dump header (pinned mariadb container, no network) is read as MariaDB 11.8.9, and MariaDB writes utf8mb4_0900_ai_ci too;
//   2. a real sandbox from a MariaDB export: versions.json says MariaDB matched, compose.json runs the default images;
//   3. MySQL 8.0 (only when the mysql entry is pinned AND present): a sandbox from a MySQL export starts the MySQL service variant, and the
//      WP-CLI container CONNECTS to it and IMPORTS into it (rows queried back through WP-CLI), the real mysqldump header is read as MySQL;
//   4. every pinned and present PHP image of the matrix runs the PHP minor version it claims.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const sandbox = require('../issue/sandbox');
const policy = require('../issue/sandbox-policy');
const vd = require('../lib/version-detect');

let failures = 0, skipped = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const skip = m => { console.log(`SKIP  ${m}`); skipped++; };
const group = t => console.log(`\n== ${t}`);
const dk = (args, o = {}) => spawnSync('docker', args, { encoding: 'utf8', timeout: o.timeout || 300000, input: o.input });

const pf = sandbox.preflight({});
if (!pf.ok) { console.log(`SKIP  selftest-6b-docker was NOT run: it needs a usable Docker daemon and the three default pinned images.\n  reason: ${pf.reason}\n  Nothing in this suite is claimed as verified in this environment.`); process.exit(0); }
const pins = policy.images();
const M = policy.matrix(pins);
const present = e => { if (!policy.usable(e)) return false; const r = dk(['image', 'inspect', '--format', '{{json .RepoDigests}}', e.ref]); try { return r.status === 0 && JSON.parse(r.stdout).some(d => d.endsWith(`@${e.digest}`)); } catch { return false; } };
const labelled = () => { const l = sandbox.labelled({ dockerBin: 'docker', runner: spawnSync, env: process.env }); return l.containers.length + l.volumes.length + l.networks.length; };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-6b-dk-'));
process.env.PLUGIN_GUARD_ISSUES = path.join(tmp, 'issues'); fs.mkdirSync(process.env.PLUGIN_GUARD_ISSUES, { mode: 0o700 });
const SB = path.join(tmp, 'sandboxes');
const SITE = path.join(tmp, 'site');
fs.mkdirSync(path.join(SITE, 'wp-content', 'plugins', 'probe-plugin'), { recursive: true });
fs.mkdirSync(path.join(SITE, 'wp-content', 'themes'), { recursive: true });
fs.writeFileSync(path.join(SITE, 'wp-content', 'plugins', 'probe-plugin', 'probe-plugin.php'), "<?php\n/* Plugin Name: Probe Plugin */\n");
const mariaSql = fs.readFileSync(path.join(__dirname, 'fixtures', 'issue', 'dump', 'wp-site.sql.txt'), 'utf8');
let seq = 0;
const newId = () => `iss-20261105-6100${String(seq++).padStart(2, "0")}-${crypto.randomBytes(3).toString('hex')}`;

(async () => {
    const before = labelled();
    // ================================================================ 1
    group('the real mariadb-dump header (pinned mariadb 11.8.9, no network)');
    const name = `pg6b-${crypto.randomBytes(4).toString('hex')}`;
    try {
        const run = dk(['run', '-d', '--rm', '--name', name, '--network', 'none', '--cap-drop', 'ALL', ...policy.ALLOWED_CAPS.flatMap(c => ['--cap-add', c]), '--security-opt', 'no-new-privileges:true', '--memory', '512m', '--pids-limit', '256', '-e', 'MARIADB_ROOT_PASSWORD=pg6btest', '-e', 'MARIADB_DATABASE=t', pins.images.db.ref]);
        ok(run.status === 0, `a throwaway mariadb container started (network none, cap_drop ALL + the allow-list): ${(run.stderr || '').trim().split('\n')[0] || 'ok'}`);
        let up = false; for (let i = 0; i < 60 && !up; i++) { up = dk(['exec', name, 'healthcheck.sh', '--connect', '--innodb_initialized']).status === 0; if (!up) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000); }
        dk(['exec', '-i', name, 'mariadb', '-uroot', '-ppg6btest', 't'], { input: 'CREATE TABLE a (x varchar(10)) DEFAULT CHARSET=utf8mb4; CREATE TABLE b (x varchar(10)) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;' });
        const dump = dk(['exec', name, 'mariadb-dump', '-uroot', '-ppg6btest', 't']).stdout || '';
        const h = vd.parseDumpHeader(dump);
        ok(h && h.family === 'MariaDB' && h.value === '11.8.9' && h.source === 'from the database file header', `parsed: ${JSON.stringify(h)}`);
        ok(/COLLATE=utf8mb4_0900_ai_ci/.test(dump) && vd.collationHint(dump) === null, 'MariaDB writes utf8mb4_0900_ai_ci too, and the collation hint is refused for this file (MariaDB-only syntax present)');
        const bare = dk(['exec', name, 'mariadb-dump', '--skip-comments', '-uroot', '-ppg6btest', 't']).stdout || '';
        ok(vd.parseDumpHeader(bare) && vd.parseDumpHeader(bare).family === 'MariaDB' && vd.collationHint(bare) === null, 'mariadb-dump --skip-comments: no version line, still recognised as MariaDB by its /*M! syntax, no MySQL hint');
    } finally { dk(['rm', '-f', name]); }

    // ================================================================ 2
    group('a real sandbox from a MariaDB export: versions.json and the default images');
    const sqlFile = path.join(tmp, 'maria.sql'); fs.writeFileSync(sqlFile, mariaSql);
    const h2 = sandbox.create(newId(), { root: SITE, sandboxesRoot: SB, dump: sqlFile });
    try {
        const v = JSON.parse(fs.readFileSync(path.join(h2.dir, 'versions.json'), 'utf8')), c = JSON.parse(fs.readFileSync(h2.composeFile, 'utf8'));
        ok(v.db.status === 'matched' && v.db.family === 'MariaDB' && v.db.source === 'from the database file header' && c.services.db.image === pins.images.db.ref, `MariaDB 11.8.9 from the header -> matched, the pinned mariadb image (${v.db.text})`);
        ok(v.php.status === 'assumed' && c.services.wordpress.image === pins.images.wordpress.ref && /assumed/.test(v.php.text), `nothing stated the PHP version -> the default image, "assumed" (${v.php.text})`);
        const ver = h2.wp.run(['core', 'version']);
        ok(ver.ok && v.wordpress.image === ver.stdout.trim(), `the image's WordPress (${ver.stdout.trim()}) is what versions.json names`);
    } finally { h2.destroy(); }

    // ================================================================ 3
    group('MySQL 8.0: the WP-CLI container connects to and imports into MySQL');
    const my = M.db.mysql;
    if (!policy.usable(my)) skip(`TO VERIFY AFTER PULL: the mysql entry (${my ? `${my.repo}:${my.tag}` : 'none'}) is not pinned yet. Run  npm run guard:setup-sandbox -- --repin  then  npm run guard:setup-sandbox -- --db mysql  and re-run this suite. NOT verified here: the MySQL service starts with the same capability allow-list, the mysql_native_password server flag lets the WP-CLI (MariaDB) client log in, wp db import works against MySQL 8.0, and the real mysqldump header parses.`);
    else if (!present(my)) skip(`TO VERIFY AFTER PULL: ${my.repo}:${my.tag} is pinned but not on this computer. Run  npm run guard:setup-sandbox -- --db mysql  and re-run this suite.`);
    else {
        const mysqlSql = '-- MySQL dump 10.13  Distrib 8.0.46, for Linux (x86_64)\n--\n-- Host: localhost    Database: wordpress\n-- ------------------------------------------------------\n-- Server version\t8.0.46\n\n'
            + mariaSql.split('\n').filter(l => !/^\/\*M!|^-- MariaDB dump|^-- Server version/.test(l)).join('\n');
        const f3 = path.join(tmp, 'mysql.sql'); fs.writeFileSync(f3, mysqlSql);
        let h3;
        try { h3 = sandbox.create(newId(), { root: SITE, sandboxesRoot: SB, dump: f3 }); }
        catch (e) { ok(false, `the MySQL sandbox did not build: ${e.message.split('\n')[0]}`); }
        if (h3) {
            try {
                const c = JSON.parse(fs.readFileSync(h3.composeFile, 'utf8'));
                ok(c.services.db.image === my.ref && c.services.db.environment.MYSQL_DATABASE && JSON.stringify(c.services.db.cap_add) === JSON.stringify(policy.ALLOWED_CAPS), 'the MySQL service variant ran with the same capability allow-list');
                const ver = h3.wp.sql('SELECT VERSION() AS v');
                ok(ver.ok && /^8\.0\./.test((ver.stdout.split('\n')[1] || '').trim()), `the WP-CLI container connected to MySQL (${(ver.stdout.split('\n')[1] || ver.stderr).trim()})`);
                const rows = h3.wp.sql("SELECT COUNT(*) FROM `wp_posts` WHERE post_content LIKE '%PG-FIXTURE-MARKER-6A%'");
                ok(rows.ok && Number((rows.stdout.split('\n')[1] || '').trim()) === 1, 'the export was IMPORTED into MySQL (the marker post is there, read back through WP-CLI)');
                const v = JSON.parse(fs.readFileSync(path.join(h3.dir, 'versions.json'), 'utf8'));
                ok(v.db.status === 'matched' && v.db.family === 'MySQL', `versions.json: ${v.db.text}`);
                const creds = c.services.db.environment;
                const real = dk(['compose', '-p', h3.project, '-f', h3.composeFile, 'exec', '-T', 'db', 'mysqldump', '--no-data', '-h', '127.0.0.1', '-u', creds.MYSQL_USER, `-p${creds.MYSQL_PASSWORD}`, creds.MYSQL_DATABASE]).stdout || '';
                const ph = vd.parseDumpHeader(real);
                ok(ph && ph.family === 'MySQL' && /^8\.0\./.test(ph.value), `the REAL mysqldump header parses as MySQL ${ph && ph.value} (resolves the TO VERIFY of the fixture)`);
                const bare = dk(['compose', '-p', h3.project, '-f', h3.composeFile, 'exec', '-T', 'db', 'mysqldump', '--no-data', '--skip-comments', '-h', '127.0.0.1', '-u', creds.MYSQL_USER, `-p${creds.MYSQL_PASSWORD}`, creds.MYSQL_DATABASE]).stdout || '';
                const hint = vd.collationHint(bare.replace(/utf8mb4_unicode_520_ci/g, 'utf8mb4_0900_ai_ci'));
                ok(vd.parseDumpHeader(bare) === null && hint && hint.family === 'MySQL', 'a real mysqldump --skip-comments has no header and no MariaDB syntax, so a 0900 collation gives the MySQL hint');
            } finally { const rep = h3.destroy(); ok(rep.mysql_shutdown === true && rep.leftovers.length === 0, `teardown: the MySQL server was shut down by mysqladmin (no signal needed) and nothing was left (${rep.leftovers.join(', ') || 'no leftovers'})`); }
        }
    }

    // ================================================================ 4
    group('PHP images of the matrix run the version they claim');
    let checked = 0;
    for (const [minor, e] of Object.entries(M.php).sort()) {
        if (!policy.usable(e.wordpress) || !present(e.wordpress)) { if (minor !== M.default_php) skip(`PHP ${minor}: ${policy.usable(e.wordpress) ? `pinned but not pulled (npm run guard:setup-sandbox -- --php ${minor})` : !e.wordpress.tag ? 'no image tag chosen: name one that exists on Docker Hub in WANT_PHP in scripts/setup-sandbox.js first, then --repin and --php ' + minor : `not pinned: ${e.wordpress.tag} ${e.wordpress.note || 'is not confirmed by the registry'}`}`); continue; }
        const r = dk(['run', '--rm', '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--entrypoint', 'php', e.wordpress.ref, '-r', 'echo PHP_MAJOR_VERSION.".".PHP_MINOR_VERSION;']);
        ok(r.status === 0 && r.stdout.trim() === minor, `${e.wordpress.repo}:${e.wordpress.tag} runs PHP ${r.stdout.trim() || '?'} (claims ${minor})`);
        checked++;
    }
    ok(checked >= 1, `${checked} PHP image(s) checked (at least the default)`);

    ok(labelled() === before, 'no labelled container, volume or network is left');
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(failures ? `\n${failures} FAILED` : `\nAll checks passed${skipped ? ` (${skipped} SKIPPED: see the SKIP lines; those parts are NOT verified here)` : ''}`);
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); try { sandbox.sweep({}); } catch { /* ignore */ } process.exit(1); });
