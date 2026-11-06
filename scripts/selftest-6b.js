#!/usr/bin/env node
// Self-test of TEST-COPY-SPEC Part 6b, offline: the version parsers (lib/version-detect.js), the image choice and its statuses
// (issue/version-match.js), the pin-file matrix and the MySQL database service (issue/sandbox-policy.js), guard:setup-sandbox (selective pull,
// --check with sizes; a fake docker runner, nothing is pulled), the probe's response-header allow-list (probe/recorder.js), the sandbox writing
// versions.json and using the chosen images (fake docker), and the 'Versions' block of the report (only when a test copy was built).
// Fixtures: scripts/fixtures/issue/versions/ (manifest.json says which were produced by a real tool and which are TO VERIFY).
// The real-container proof (a WP-CLI container connecting to and importing into MySQL 8.0) is selftest-6b-docker.js.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-6b-'));
process.env.PLUGIN_GUARD_SANDBOXES = path.join(tmp, 'sbx-default');
process.env.PLUGIN_GUARD_ISSUES = path.join(tmp, 'issues');
fs.mkdirSync(process.env.PLUGIN_GUARD_SANDBOXES, { mode: 0o700 }); fs.mkdirSync(process.env.PLUGIN_GUARD_ISSUES, { mode: 0o700 });
const vd = require('../lib/version-detect');
const vm = require('../issue/version-match');
const policy = require('../issue/sandbox-policy');
const setup = require('./setup-sandbox');
const recorder = require('../probe/recorder');
const sandbox = require('../issue/sandbox');
const caseFile = require('../issue/case-file');
const store = require('../lib/issue-store');

let failures = 0, toVerify = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const verifyLater = m => { console.log(`TO VERIFY  ${m}`); toVerify++; };
const group = t => console.log(`\n== ${t}`);
const FX = path.join(__dirname, 'fixtures', 'issue', 'versions');
const fx = f => fs.readFileSync(path.join(FX, f), 'utf8');
const manifest = JSON.parse(fx('manifest.json'));
const write = (root, rel, body) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); return f; };
const src = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const throws = fn => { try { fn(); return null; } catch (e) { return e; } };
const SRC = new Set(vd.SOURCE_LIST);

// a pin file with a matrix: fake digests (never started; the fake docker reports them present unless told otherwise)
const dg = c => `sha256:${c.repeat(64)}`;
const realPins = policy.images();
const pinEntry = (repo, tag, c, extra = {}) => ({ repo, tag, digest: dg(c), ref: `${repo}@${dg(c)}`, status: 'pinned', tag_verified: true, ...extra });
const unpinned = (repo, tag, extra = {}) => ({ repo, tag, digest: null, ref: null, status: 'unpinned', tag_verified: false, ...extra });
function fixturePins({ php82 = true, php74 = false, mysql = true } = {}) {
    const p = JSON.parse(JSON.stringify(realPins));
    p.matrix = {
        default_php: '8.3', default_db: 'mariadb',
        php: {
            '7.4': php74 ? { wordpress: pinEntry('wordpress', '6.1.1-php7.4-apache', '7', { php: '7.4', wp_version: '6.1.1' }), cli: pinEntry('wordpress', 'cli-2.7.1-php7.4', '8', { php: '7.4' }) } : { wordpress: unpinned('wordpress', null, { php: '7.4' }), cli: unpinned('wordpress', null, { php: '7.4' }) },
            '8.1': { wordpress: unpinned('wordpress', '7.1.3-php8.1-apache', { php: '8.1', wp_version: '7.1.3' }), cli: unpinned('wordpress', 'cli-2.12.0-php8.1', { php: '8.1' }) },
            '8.2': php82 ? { wordpress: pinEntry('wordpress', '7.1.3-php8.2-apache', 'a', { php: '8.2', wp_version: '7.1.3' }), cli: pinEntry('wordpress', 'cli-2.12.0-php8.2', 'b', { php: '8.2' }) } : { wordpress: unpinned('wordpress', '7.1.3-php8.2-apache', { php: '8.2' }), cli: unpinned('wordpress', 'cli-2.12.0-php8.2', { php: '8.2' }) },
            '8.3': { wordpress: { ...realPins.images.wordpress, status: 'pinned', tag_verified: true }, cli: { ...realPins.images.cli, status: 'pinned', tag_verified: true } }
        },
        db: { mariadb: { ...realPins.images.db, family: 'MariaDB', version: '11.8.9', status: 'pinned', tag_verified: true }, mysql: mysql ? pinEntry('mysql', '8.0.46', 'c', { family: 'MySQL', version: '8.0.46' }) : unpinned('mysql', '8.0.46', { family: 'MySQL', version: '8.0.46' }) }
    };
    return p;
}
const all = () => true;

(async () => {
    // ================================================================ parsers
    group('database version from the export header (first 8 KB), with its source');
    const real = vd.parseDumpHeader(fx('mariadb-dump-11.8.9.head.sql.txt'));
    ok(manifest['mariadb-dump-11.8.9.head.sql.txt'].verified === true && real && real.family === 'MariaDB' && real.value === '11.8.9' && real.source === 'from the database file header', `the REAL mariadb-dump header (pinned mariadb 11.8.9 container): MariaDB 11.8.9 from the database file header (${JSON.stringify(real)})`);
    const my = vd.parseDumpHeader(fx('mysqldump-8.0.46.head.sql.txt'));
    ok(my && my.family === 'MySQL' && my.value === '8.0.46', 'mysqldump "-- Server version\\t8.0.46" -> MySQL 8.0.46');
    verifyLater('the mysqldump header fixture is written from the documented format; re-record it from a real mysql 8.0 image (selftest-6b-docker.js does once the image is pulled)');
    const old = vd.parseDumpHeader(fx('mariadb-dump-10.11.head.sql.txt'));
    ok(old && old.family === 'MariaDB' && old.value === '10.11.6', `"Server version 5.5.5-10.11.6-MariaDB" -> MariaDB 10.11.6 (the 5.5.5- compatibility prefix is dropped)`);
    const pma = vd.parseDumpHeader(fx('phpmyadmin-mariadb.head.sql.txt'));
    ok(pma && pma.family === 'MariaDB' && pma.value === '10.6.16', 'phpMyAdmin "-- Server version: 10.6.16-MariaDB-..." -> MariaDB 10.6.16');
    const cross = vd.parseDumpHeader(fx('mariadb-client-mysql-server.head.sql.txt'));
    ok(cross && cross.family === 'MySQL' && cross.value === '8.0.46', 'a MariaDB client exporting a MySQL server: the SERVER line wins (MySQL 8.0.46), not the tool\'s "MariaDB dump" line');
    const distrib = vd.parseDumpHeader('-- MariaDB dump 10.19  Distrib 10.11.6-MariaDB, for debian-linux-gnu (x86_64)\n--\n-- Host: localhost    Database: wp\n');
    ok(distrib && distrib.family === 'MariaDB' && distrib.value === '10.11.6' && /tool/.test(distrib.how), 'no server line: the "Distrib" line of the export tool is used, and the result says it is the tool\'s version');
    const tool11 = vd.parseDumpHeader('-- MariaDB dump 10.20-11.8.9-MariaDB, for debian-linux-gnu (x86_64)\n');
    ok(tool11 && tool11.value === '11.8.9', 'the mariadb-dump 11.x tool line "10.20-11.8.9-MariaDB" -> 11.8.9');
    ok(vd.parseDumpHeader('-- Host: 127.0.0.1    Database: wp    Server version: 8.0.46\n').value === '8.0.46', 'a "-- Host: ... Server version" line on one line is read');
    ok(vd.parseDumpHeader('-- Adminer 4.8.1 MySQL 8.0.46 dump\n').family === 'MySQL', 'the Adminer export line is read');
    ok(vd.parseDumpHeader('/*M!999999\\- enable the sandbox mode */\nCREATE TABLE `x` (a int);').family === 'MariaDB', 'no version line but MariaDB-only /*M! syntax -> MariaDB (version unknown), from the database file header');
    const far = 'x'.repeat(9000) + '\n-- Server version\t8.0.46\n';
    ok(vd.parseDumpHeader(far) === null, 'a version line after the first 8 KB is not read');
    ok(vd.parseDumpHeader('-- Server version\t8.0.46<script>\n') === null && vd.parseDumpHeader('-- Server version\t99.0.1\n') === null, 'a hostile or impossible server version is refused, never shown');
    ok(vd.parseDumpHeader('') === null && vd.parseDumpHeader(null) === null, 'no header -> nothing');
    // owner request (6d-1 brief): the phpMyAdmin colon form with distro suffixes, the tab form, hostile text, a header beyond 8 KB (synthetic headers only)
    const PMA = (v, nl = '\n') => `-- phpMyAdmin SQL Dump${nl}-- version 5.2.1${nl}-- https://www.phpmyadmin.net/${nl}--${nl}-- Host: localhost${nl}-- Generation Time: Jan 01, 2026 at 10:00 AM${nl}-- Server version: ${v}${nl}-- PHP Version: 8.2.30${nl}`;
    const hv = t => { const r = vd.parseDumpHeader(t); return r ? `${r.family} ${r.value} (${r.source})` : 'null'; };
    ok(hv(PMA('8.0.46-0ubuntu0.22.04.1')) === 'MySQL 8.0.46 (from the database file header)', `phpMyAdmin "-- Server version: 8.0.46-0ubuntu0.22.04.1" -> MySQL 8.0.46, the distro suffix is not part of the version (${hv(PMA('8.0.46-0ubuntu0.22.04.1'))})`);
    ok(hv(PMA('8.0.46-0ubuntu0.22.04.1', '\r\n')) === 'MySQL 8.0.46 (from the database file header)', 'the same with CRLF line ends');
    ok(hv(PMA('8.0.46-log')) === 'MySQL 8.0.46 (from the database file header)' && hv(PMA('8.0.46')) === 'MySQL 8.0.46 (from the database file header)', 'phpMyAdmin "8.0.46-log" and plain "8.0.46" (no MariaDB marker) -> MySQL 8.0.46');
    ok(hv(PMA('10.11.6-MariaDB-1:10.11.6+maria~ubu2204')) === 'MariaDB 10.11.6 (from the database file header)', `phpMyAdmin "10.11.6-MariaDB-1:10.11.6+maria~ubu2204" -> MariaDB 10.11.6 (${hv(PMA('10.11.6-MariaDB-1:10.11.6+maria~ubu2204'))})`);
    ok(hv(PMA('10.11.6-MariaDB')) === 'MariaDB 10.11.6 (from the database file header)' && hv(PMA('10.11.6-MariaDB-log')) === 'MariaDB 10.11.6 (from the database file header)', 'phpMyAdmin "10.11.6-MariaDB" and "10.11.6-MariaDB-log" -> MariaDB 10.11.6');
    ok(hv('-- MySQL dump 10.13  Distrib 8.0.46, for Linux (x86_64)\n--\n-- Host: localhost    Database: wp\n-- ------------------------------------------------------\n-- Server version\t8.0.46\n') === 'MySQL 8.0.46 (from the database file header)', 'the mysqldump tab form "-- Server version<TAB>8.0.46" -> MySQL 8.0.46');
    for (const bad of ['8.0.46<script>', 'abc8.0', '99.0.1', '8..46', '-8.0.46', '8.0.46"; DROP TABLE x; --', '‮8.0.46', 'MariaDB', ''])
        ok(vd.parseDumpHeader(`-- Server version: ${bad}\n`) === null, `hostile or garbled phpMyAdmin version text gives no version: ${JSON.stringify(bad)}`);
    ok(vd.parseDumpHeader('-- phpMyAdmin SQL Dump\n' + '-- padding line\n'.repeat(700) + '-- Server version: 8.0.46-0ubuntu0.22.04.1\n') === null, 'a phpMyAdmin "Server version:" line beyond the first 8 KB is not read');

    group('the collation hint, verified against the pinned MariaDB');
    const hint = vd.collationHint(fx('mysql-no-header.sql.txt'));
    ok(hint && hint.family === 'MySQL' && hint.value === '8' && hint.source === 'from the collation', 'no header, utf8mb4_0900_ai_ci present -> MySQL 8, labelled "from the collation"');
    verifyLater('the header-less mysqldump fixture (--skip-comments) is written from the documented format; re-check against a real mysql 8.0 image');
    ok(vd.collationHint(fx('mariadb-dump-11.8.9.head.sql.txt')) === null, 'VERIFIED: MariaDB 11.8.9 writes utf8mb4_0900_ai_ci too (a real mariadb-dump of a table created with it), so the hint is refused when the file has MariaDB-only syntax');
    ok(vd.collationHint('CREATE TABLE `a` (x int) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_520_ci;') === null, 'no 0900 collation -> no hint ("unknown")');
    const noHead = vd.detect({ dumpHead: 'CREATE TABLE `a` (x int) DEFAULT CHARSET=utf8mb4;' });
    ok(noHead.db.family === null && noHead.db.source === 'unknown', 'no header, no Site Health, no collation -> database "unknown"');

    group('Site Health text (untrusted): strict patterns per section');
    const shm = vd.parseSiteHealth(fx('site-health-mysql.txt'));
    ok(shm.php.value === '8.2.30' && shm.php.source === 'from Site Health' && shm.db.family === 'MySQL' && shm.db.value === '8.0.46' && shm.wp.value === '7.1.4', 'PHP 8.2.30, MySQL 8.0.46 and WordPress 7.1.4 from Site Health');
    ok(shm.active_plugins.map(p => `${p.name} ${p.version}`).join('|') === 'Elementor 3.18.3|Ivory Search 5.5.4|WooCommerce 9.4.1' && shm.active_plugins_count === 3, 'the active plugin list is parsed (name and version) and kept for Part 6d');
    const shd = vd.parseSiteHealth(fx('site-health-mariadb.txt'));
    ok(shd.db.family === 'MariaDB' && shd.db.value === '10.11.6' && shd.php.value === '7.4.33' && shd.active_plugins[0].name === 'Akismet Anti-spam: Spam Protection', 'MariaDB from Site Health; a plugin name that contains ": " keeps it');
    const hos = vd.parseSiteHealth(fx('site-health-hostile.txt'));
    ok(hos.php.value === null && hos.wp.value === null && hos.db.value === null, 'hostile Site Health: "8.2.30$(rm -rf /)", "9.9.9<script>" and "8.0.46\'; DROP TABLE" give NO version');
    ok(hos.active_plugins.every(p => !/[\u0000-\u001f]/.test(p.name) && p.name.length <= 120) && !hos.active_plugins.some(p => /Not a plugin/.test(p.name)), 'hostile plugin lines are kept only as capped plain text (they are data; nothing is executed or shown unescaped)');
    ok(vd.parseSiteHealth(fx('site-health-no-sections.txt')).found === false, 'lines outside the Site Health sections are not read');
    ok(vd.parseSiteHealth(`### wp-server ###\nphp_version: 8.1.2 64bit\n${'y'.repeat(300 * 1024)}\n### wp-core ###\nversion: 7.1.4\n`).wp.value === null, 'only the first 256 KB of the text is read');
    const SH = write(tmp, 'sh/site-health.txt', fx('site-health-mysql.txt') + '\nadmin_email: owner@example.com\n');
    const idir = path.join(tmp, 'issue-like'); fs.mkdirSync(idir);
    const saved = vm.saveSiteHealth(idir, SH);
    const savedText = fs.readFileSync(path.join(idir, 'work', 'site-health.json'), 'utf8');
    ok(saved.php.value === '8.2.30' && !/owner@example\.com/.test(savedText) && (fs.statSync(path.join(idir, 'work', 'site-health.json')).mode & 0o777) === 0o600, 'saved: only the parsed values, owner-only (0600); the paste itself (e-mail address included) is not stored');
    ok(throws(() => vm.readSiteHealthFile(write(tmp, 'sh/big.txt', 'x'.repeat(256 * 1024 + 1)))) instanceof vm.SiteHealthRefused, 'a Site Health file over 256 KB is refused');
    ok(throws(() => vm.readSiteHealthFile(write(tmp, 'sh/bin.txt', Buffer.from([0x23, 0, 1, 2])))) instanceof vm.SiteHealthRefused, 'a binary file is refused');
    fs.symlinkSync(SH, path.join(tmp, 'sh', 'link.txt'));
    ok(throws(() => vm.readSiteHealthFile(path.join(tmp, 'sh', 'link.txt'))) instanceof vm.SiteHealthRefused, 'a symbolic link is refused (not followed)');
    const tampered = vm.saneSiteHealth({ schema: 1, php: { value: '8.2.30; rm', source: 'you told us' }, db: { family: 'Oracle', value: '1.0' }, wp: { value: '7.1.4' } });
    ok(tampered.php.value === null && tampered.db.family === null && tampered.wp.source === 'from Site Health', 'site-health.json is checked again when read back (a tampered value is dropped, the source is fixed)');

    group('PHP: response header, .htaccess handler lines, version.php');
    ok(vd.parsePoweredBy('PHP/8.2.30').value === '8.2.30' && vd.parsePoweredBy('PHP/8.2.30').source === 'from the response header' && vd.parsePoweredBy('PleskLin') === null && vd.parsePoweredBy('PHP/8.2.30x') === null && vd.parsePoweredBy('PHP/8.1.2-1ubuntu2.14').value === '8.1.2', 'X-Powered-By "PHP/8.2.30" -> 8.2.30 from the response header; other values give nothing');
    ok(vd.parseHtaccess(fx('htaccess-cpanel.txt')).value === '8.2', 'cPanel "AddHandler application/x-httpd-ea-php82___lsphp" -> PHP 8.2 from .htaccess');
    ok(vd.parseHtaccess(fx('htaccess-last-wins.txt')).value === '8.1', 'commented lines are ignored and the LAST handler line wins (AddType x-httpd-php81)');
    ok(vd.parseHtaccess(fx('htaccess-sethandler.txt')).value === '8.0', 'SetHandler application/x-httpd-php80 -> 8.0');
    ok(vd.parseHtaccess(fx('htaccess-none.txt')) === null, 'handlers without a minor version (x-httpd-php8, x-mapp-php6) and FPM proxies give nothing');
    ok(vd.parseVersionPhp(fx('version.php.txt')).value === '7.1.4' && vd.parseVersionPhp(fx('version.php.txt')).source === "from the site's files", "wp-includes/version.php -> WordPress 7.1.4 from the site's files ($required_php_version is not read)");
    ok(vd.statedPhp('8.2', null).source === 'you told us' && vd.statedPhp('8.3', 'you confirmed').source === 'you confirmed' && vd.statedPhp('8.x', null) === null, '--php is "you told us"; a confirmed folder hint is "you confirmed"');

    group('PHP: best source first');
    const order = vd.detect({ stated: vd.statedPhp('7.4'), siteHealth: shm, poweredBy: 'PHP/8.1.1', htaccess: fx('htaccess-sethandler.txt') });
    ok(order.php.value === '7.4' && order.php.source === 'you told us', 'stated wins over Site Health, the header and .htaccess');
    ok(vd.detect({ siteHealth: shm, poweredBy: 'PHP/8.1.1' }).php.source === 'from Site Health', 'Site Health wins over the header');
    ok(vd.detect({ poweredBy: 'PHP/8.1.1', htaccess: fx('htaccess-sethandler.txt') }).php.source === 'from the response header', 'the header wins over .htaccess');
    ok(vd.detect({ htaccess: fx('htaccess-sethandler.txt') }).php.source === 'from .htaccess', '.htaccess when nothing else');
    const ROOT = path.join(tmp, 'site-rp');
    write(ROOT, 'wp-content/plugins/old/old.php', "<?php\n/**\n * Plugin Name: Old\n * Requires PHP: 7.4\n */\n");
    write(ROOT, 'wp-content/themes/t/style.css', '/* Theme Name: T\nRequires PHP: 8.1 */');
    const rp = vd.detect(vm.gather({ root: ROOT }));
    ok(rp.php.value === null && rp.php.source === 'assumed', '"Requires PHP" headers (7.4 in a plugin, 8.1 in the theme) are never the version in use: PHP stays "assumed"');
    ok([order.php, order.db, order.wp, rp.php, rp.db, rp.wp, shm.php, shm.db, shm.wp].every(x => SRC.has(x.source)), `every value carries one of the ${vd.SOURCE_LIST.length} named sources`);

    group('review fixes: MariaDB syntax anywhere, UpdraftPlus header not parsed, the hint labelled as a hint');
    const midLine = 'CREATE TABLE `wp_x` (\n  `data` blob /*M!100301 COMPRESSED*/ DEFAULT NULL\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;\n';
    ok(vd.collationHint(midLine) === null && vd.detect({ dumpHead: midLine, dumpScan: midLine }).db.family === 'MariaDB', 'a mid-line "blob /*M!100301 COMPRESSED*/" with a 0900 collation -> MariaDB syntax, NOT MySQL from the collation');
    ok(vd.collationHint('x'.repeat(20000) + midLine) === null, 'MariaDB syntax is found anywhere in the scanned text, not only at a line start or in the first 8 KB');
    const upd = fx('updraftplus-mysql.sql.txt');
    ok(manifest['updraftplus-mysql.sql.txt'].verified === false && vd.parseDumpHeader(upd) === null, 'UpdraftPlus-style "# MySQL Version: 8.0.36" header: NOT parsed (its format is not confirmed from the plugin source)');
    const updDet = vd.detect({ dumpHead: upd, dumpScan: upd });
    ok(updDet.db.family === 'MySQL' && updDet.db.value === '8' && updDet.db.source === 'from the collation' && updDet.php.source === 'assumed', 'the UpdraftPlus file gives only the collation hint (MySQL 8, from the collation); its "running on PHP 8.2.30" is not read either');
    const updSel = vm.select(updDet, fixturePins(), { present: all });
    ok(/^MySQL 8 \(a hint, from the collation\): /.test(updSel.db.text) && updSel.db.status === 'nearest' && caseFile.versionLines(updSel)[1].includes('MySQL 8 (a hint, from the collation)'), `the text says it is a hint (${updSel.db.text})`);
    const updNo = vd.detect({ dumpHead: upd.replace(/utf8mb4_0900_ai_ci/g, 'utf8mb4_unicode_520_ci'), dumpScan: upd.replace(/utf8mb4_0900_ai_ci/g, 'utf8mb4_unicode_520_ci') });
    ok(updNo.db.family === null && updNo.db.source === 'unknown', 'the same file without a 0900 collation -> database "unknown"');

    group('review fixes: a null tag needs WANT_PHP first; "matched" only from the image\'s own PHP; tag_verified; the 8.4 auth flag guard');
    const r74 = vm.select(vd.detect({ stated: vd.statedPhp('7.4') }), realPins, { present: all });
    ok(!r74.commands.some(c => /--php 7\.4/.test(c)) && r74.todos.length === 1 && /^PHP 7\.4: no image tag is chosen yet: name a tag that exists on Docker Hub in WANT_PHP in scripts\/setup-sandbox\.js first/.test(r74.todos[0]) && vm.lines(r74).includes(r74.todos[0]) && caseFile.versionLines(r74).some(l => l.includes('WANT_PHP')), 'PHP 7.4 (no tag chosen): no impossible "--repin && --php 7.4" command; the step says to name a tag in WANT_PHP first');
    const p99 = fixturePins(); p99.matrix.default_php = '9.9';
    const r99 = vm.select(vd.detect({ stated: vd.statedPhp('9.9') }), p99, { present: all });
    ok(r99.php.status === 'not matched' && r99.images.wordpress === 'wordpress:7.1.3-php8.3-apache' && policy.matrix(p99).default_php === '8.3', 'matrix.default_php "9.9" and PHP 9.9 requested -> NOT matched (the default image records 8.3; default_php is not trusted)');
    const pNoDef = fixturePins(); delete pNoDef.matrix.default_php;
    ok(vm.select(vd.detect({}), pNoDef, { present: all }).php.text === 'PHP 8.3 assumed (the default image; nothing stated the PHP version of your site)', 'a missing default_php: the default image\'s own PHP (8.3) is named');
    const pLie = fixturePins(); pLie.matrix.php['8.2'].wordpress.php = '8.3'; pLie.matrix.php['8.2'].wordpress.tag = '7.1.3-php8.3-apache';
    ok(vm.select(vd.detect({ siteHealth: shm }), pLie, { present: all }).php.status !== 'matched', 'a matrix key 8.2 whose image records PHP 8.3 is never "matched" for 8.2');
    const base = pinEntry('mysql', '8.0.46', 'c');
    ok(policy.usable(base) && !policy.usable({ ...base, tag_verified: false }) && !policy.usable((({ tag_verified, ...rest }) => rest)(base)), 'usable() refuses tag_verified false and a missing tag_verified');
    ok(!setup.pinned({ ...base, tag_verified: false }) && setup.pinned(base), 'guard:setup-sandbox applies the same rule before a pull');
    const pNoMatrix = { ...realPins }; delete pNoMatrix.matrix;
    const rNo = vm.select(vd.detect({ siteHealth: shm, dumpHead: fx('mysqldump-8.0.46.head.sql.txt') }), pNoMatrix, { present: all });
    ok(rNo.images.wordpress === 'wordpress:7.1.3-php8.3-apache' && rNo.images.db === 'mariadb:11.8.9' && Object.values(rNo.refs).every(policy.usable) && rNo.php.status === 'nearest' && rNo.db.status === 'not matched', 'the three original default keys alone (no matrix, no tag_verified field) still work: the defaults are used and usable');
    const authFlag = policy.dbService('MySQL', 'x', { root: 'a', user: 'b', pass: 'c', name: 'd' }).command.includes('--default-authentication-plugin=mysql_native_password');
    const at84 = t => { const m = /^(\d+)\.(\d+)/.exec(String(t || '')); return !!m && (Number(m[1]) > 8 || (Number(m[1]) === 8 && Number(m[2]) >= 4)); };
    const shipped = JSON.parse(src('data/sandbox-images.json')).matrix.db.mysql;
    ok(!(authFlag && (at84(shipped.tag) || at84(shipped.version) || at84(setup.WANT_DB.mysql.tag))), `the MySQL pin (${shipped.tag}, WANT_DB ${setup.WANT_DB.mysql.tag}) is below 8.4 while --default-authentication-plugin is used (8.4 removed that flag)`);
    ok(at84('8.4.3') && at84('9.1') && !at84('8.0.46'), 'control: the 8.4 check itself recognises 8.4 and later');
    ok(/REMOVED in MySQL 8\.4/.test(src('issue/sandbox-policy.js')), 'the code comment at the flag says it was removed in 8.4');

    // ================================================================ selection
    group('choice of images and statuses (fixture matrices)');
    const P = fixturePins();
    const sel = (det, pins = P, present = all) => vm.select(det, pins, { present });
    const exact = sel(vd.detect({ siteHealth: shm, dumpHead: fx('mysqldump-8.0.46.head.sql.txt'), versionPhp: fx('version.php.txt') }));
    ok(exact.php.status === 'matched' && exact.php.used === '8.2' && exact.images.wordpress === 'wordpress:7.1.3-php8.2-apache' && exact.images.cli === 'wordpress:cli-2.12.0-php8.2' && exact.php.text === 'PHP 8.2.30 (from Site Health): PHP 8.2 used (matched)', `exact minor -> matched, the PHP 8.2 images (${exact.php.text})`);
    ok(exact.db.status === 'matched' && exact.images.db === 'mysql:8.0.46' && exact.images.db_family === 'MySQL', 'MySQL 8.0.46 from the header -> the MySQL image, matched');
    ok(exact.wordpress.status === 'nearest' && /WordPress 7\.1\.4 .*7\.1\.3 used/.test(exact.wordpress.text), `WordPress core comes from the image: 7.1.4 vs 7.1.3 -> nearest, both named (${exact.wordpress.text})`);
    const near = sel(vd.detect({ siteHealth: shm }), fixturePins({ php82: false }));
    ok(near.php.status === 'nearest' && near.php.used === '8.3' && /PHP 8\.2 requested, 8\.3 used \(nearest available/.test(near.php.text) && near.php.command === 'npm run guard:setup-sandbox -- --repin && npm run guard:setup-sandbox -- --php 8.2', `another minor of the same major -> nearest, NAMED, with the command (${near.php.text})`);
    const missing = sel(vd.detect({ siteHealth: shm }), P, e => !String(e.tag).includes('php8.2'));
    ok(missing.php.status === 'nearest' && /not on this computer/.test(missing.php.text) && missing.php.command === 'npm run guard:setup-sandbox -- --php 8.2', 'the PHP 8.2 image is pinned but not pulled -> nearest available, and exactly: npm run guard:setup-sandbox -- --php 8.2');
    const seven = sel(vd.detect({ stated: vd.statedPhp('7.4') }));
    ok(seven.php.status === 'not matched' && seven.php.used === '8.3' && seven.images.wordpress === 'wordpress:7.1.3-php8.3-apache' && /not matched/.test(seven.php.text), 'PHP 7.4 requested, no 7.x image -> the default image, "not matched" (a different MAJOR is never "nearest")');
    const seven2 = sel(vd.detect({ stated: vd.statedPhp('7.4') }), fixturePins({ php74: true }));
    ok(seven2.php.status === 'matched' && seven2.images.wordpress === 'wordpress:6.1.1-php7.4-apache' && seven2.wordpress.status === 'unknown', 'with a pinned 7.4 image: matched, its own WordPress version (6.1.1); site version unknown -> "unknown"');
    const assumed = sel(vd.detect({}));
    ok(assumed.php.status === 'assumed' && /assumed/.test(assumed.php.text) && assumed.images.wordpress === 'wordpress:7.1.3-php8.3-apache' && assumed.db.status === 'assumed' && /assumed/.test(assumed.db.text) && assumed.images.db === 'mariadb:11.8.9', 'nothing stated -> the default images, and "assumed" in every result text');
    const fam = sel(vd.detect({ dumpHead: fx('mysqldump-8.0.46.head.sql.txt') }), fixturePins({ mysql: false }));
    ok(fam.db.status === 'not matched' && fam.images.db === 'mariadb:11.8.9' && /MySQL 8\.0\.46 .*MariaDB 11\.8\.9 used \(not matched/.test(fam.db.text) && /--db mysql/.test(fam.db.command), `MySQL site, no usable MySQL image -> the default MariaDB, "not matched", with the command (${fam.db.text})`);
    const famMissing = sel(vd.detect({ dumpHead: fx('mysqldump-8.0.46.head.sql.txt') }), P, e => e.repo !== 'mysql');
    ok(famMissing.db.status === 'not matched' && famMissing.db.command === 'npm run guard:setup-sandbox -- --db mysql', 'MySQL image pinned but not pulled -> not matched + npm run guard:setup-sandbox -- --db mysql');
    const maria10 = sel(vd.detect({ dumpHead: fx('mariadb-dump-10.11.head.sql.txt') }));
    ok(maria10.db.status === 'nearest' && maria10.images.db === 'mariadb:11.8.9', 'MariaDB 10.11 site -> MariaDB 11.8.9, nearest (same family, other version)');
    const maria11 = sel(vd.detect({ dumpHead: fx('mariadb-dump-11.8.9.head.sql.txt') }));
    ok(maria11.db.status === 'matched', 'MariaDB 11.8.9 site -> matched');
    const colla = sel(vd.detect({ dumpScan: fx('mysql-no-header.sql.txt') }));
    ok(colla.db.status === 'nearest' && colla.db.source === 'from the collation', 'MySQL known only from the collation ("8") -> never "matched": nearest');
    const combined = sel(vd.detect({ siteHealth: shm, dumpHead: fx('mysqldump-8.0.46.head.sql.txt') }), fixturePins({ php82: false, mysql: false }));
    ok(combined.commands.length === 1 && combined.commands[0] === 'npm run guard:setup-sandbox -- --repin && npm run guard:setup-sandbox -- --php 8.2 --db mysql', `one command line for everything missing (${combined.commands[0]})`);
    const real0 = sel(vd.detect({ siteHealth: shm, dumpHead: fx('mysqldump-8.0.46.head.sql.txt') }), realPins);
    const shipPinned = k => { const e = realPins.matrix && realPins.matrix.php[k]; return !!(e && policy.usable(e.wordpress) && policy.usable(e.cli)); }, shipMysql = !!(realPins.matrix && policy.usable(realPins.matrix.db.mysql));
    ok(real0.php.status === (shipPinned('8.2') ? 'matched' : 'nearest') && real0.db.status === (shipMysql ? 'matched' : 'not matched') && (shipPinned('8.2') || real0.images.wordpress === `${realPins.images.wordpress.repo}:${realPins.images.wordpress.tag}`), `the shipped pin file, as --repin wrote it: PHP 8.2 ${shipPinned('8.2') ? 'matched (pinned)' : 'nearest 8.3'}, MySQL ${shipMysql ? 'matched (pinned)' : 'not matched'}`);
    const statusOk = r => [r.php, r.db, r.wordpress].every(x => vm.STATUSES.includes(x.status));
    ok([exact, near, missing, seven, seven2, assumed, fam, famMissing, maria10, maria11, colla, combined, real0].every(statusOk), `every status is one of: ${vm.STATUSES.join(' | ')}`);
    const noClaim = [exact, near, missing, seven, seven2, assumed, fam, famMissing, maria10, maria11, colla, combined, real0].every(r => Object.values(r.refs).every(policy.usable));
    ok(noClaim, 'every chosen image is pinned by digest (no result can rest on an unpinned image)');
    const noneUsable = sel(vd.detect({ siteHealth: shm, dumpHead: fx('mysqldump-8.0.46.head.sql.txt') }), P, () => false);
    ok(noneUsable.php.status !== 'matched' && noneUsable.db.status !== 'matched', 'when no matrix image is present, nothing is "matched"');

    // ================================================================ pins and policy
    group('pin file: the three defaults unchanged, the matrix never used unpinned');
    const pinsFile = JSON.parse(src('data/sandbox-images.json'));
    ok(Object.keys(pinsFile.images).sort().join() === 'cli,db,wordpress' && pinsFile.images.wordpress.tag === '7.1.3-php8.3-apache', 'the "images" block still holds exactly the three default images');
    const phpKeys = Object.keys(pinsFile.matrix.php).sort(vd.cmpVersion);
    ok(phpKeys.join() === '7.4,8.0,8.1,8.2,8.3,8.4' && phpKeys.every(k => pinsFile.matrix.php[k].wordpress.php === k), 'the matrix lists PHP 7.4, 8.0, 8.1, 8.2, 8.3 and 8.4');
    ok(Object.entries(pinsFile.matrix.php).every(([k, v]) => ['wordpress', 'cli'].every(r => policy.usable(v[r]) ? v[r].php === k : v[r].status === 'unpinned' && v[r].digest === null && v[r].tag_verified === false)) && pinsFile.matrix.php['8.3'].wordpress.ref === pinsFile.images.wordpress.ref, 'every matrix entry is either pinned (digest, tag_verified true, recording its own PHP) or "unpinned" with no digest and tag_verified false; the 8.3 entry is the default image');
    ok((policy.usable(pinsFile.matrix.db.mysql) || pinsFile.matrix.db.mysql.status === 'unpinned') && pinsFile.matrix.db.mysql.repo === 'mysql' && /^8\.0\./.test(pinsFile.matrix.db.mysql.tag) && policy.usable(pinsFile.matrix.db.mariadb), 'mariadb 11.8.9 pinned; mysql 8.0.x listed (pinned or unpinned)');
    ok(Object.values(pinsFile.matrix.php).every(v => v.wordpress.tag === null || /^\d+\.\d+\.\d+-php\d\.\d-apache$/.test(v.wordpress.tag)) && Object.values(pinsFile.matrix.php).every(v => v.cli.tag === null || /^cli-\d+\.\d+\.\d+-php\d\.\d$/.test(v.cli.tag)), 'tags follow wordpress:<wp>-php<x>-apache and wordpress:cli-<ver>-php<x>; PHP 7.4 / 8.0 have NO tag chosen (not guessed)');
    ok(!policy.usable(unpinned('mysql', '8.0.46')) && !policy.usable({ status: 'pinned', digest: 'sha256:abc', ref: 'mysql@sha256:abc' }) && !policy.usable({ status: 'unpinned', digest: dg('d'), ref: `mysql@${dg('d')}` }) && !policy.usable({ status: 'pinned', digest: dg('d'), ref: `mysql@${dg('e')}` }), 'usable() refuses: unpinned, a short digest, status not pinned, a ref that does not carry the digest');
    ok(!throws(() => policy.images()) && policy.matrix(realPins).php['8.3'] && policy.matrix({ images: realPins.images }).db.mariadb, 'images() still validates the defaults; a pin file without a matrix (before 6b) still works');

    group('database service: MariaDB unchanged, a MySQL variant with the same safeguards');
    const mk = (pins, extra = {}) => policy.buildSpec({ project: 'pgsb0a1b2c3d', issueId: 'iss-20261105-100000-abcdef', siteDir: path.join(tmp, 'sb', 'site'), logDir: path.join(tmp, 'sb', 'logs'), themes: ['acme'], hasLanguages: true, creds: { root: 'R', user: 'wp', pass: 'P', name: 'wordpress' }, images: pins, ...extra });
    const SBD = path.join(tmp, 'sb');
    const maria = mk(realPins);
    ok(JSON.stringify(maria.services.db.environment) === JSON.stringify({ MARIADB_ROOT_PASSWORD: 'R', MARIADB_DATABASE: 'wordpress', MARIADB_USER: 'wp', MARIADB_PASSWORD: 'P' }) && maria.services.db.command.join(' ') === '--skip-name-resolve --max-connections=50' && maria.services.db.healthcheck.test.join(' ') === 'CMD healthcheck.sh --connect --innodb_initialized', 'the default (MariaDB) database service is exactly what it was');
    ok(JSON.stringify(mk(realPins)) === JSON.stringify(mk({ ...realPins, images: { ...realPins.images, db: { ...realPins.images.db, family: 'MariaDB' } } })), 'family "MariaDB" given explicitly -> byte-identical specification');
    const mysqlPins = vm.pinsFor(exact, P);
    const mys = mk(mysqlPins);
    ok(policy.validateSpec(mys, { sandboxDir: SBD }).length === 0, `the MySQL specification passes every check (${policy.validateSpec(mys, { sandboxDir: SBD }).join('; ') || 'no violation'})`);
    ok(mys.services.db.image === `mysql@${dg('c')}` && mys.services.wordpress.image === `wordpress@${dg('a')}` && mys.services.cli.image === `wordpress@${dg('b')}`, 'the chosen images (PHP 8.2 web + CLI, MySQL) are what the containers run');
    ok(Object.keys(mys.services.db.environment).sort().join() === 'MYSQL_DATABASE,MYSQL_PASSWORD,MYSQL_ROOT_PASSWORD,MYSQL_USER' && mys.services.db.command.includes('--default-authentication-plugin=mysql_native_password') && mys.services.db.command.includes('--skip-name-resolve') && mys.services.db.command.includes('--max-connections=50'), 'MySQL: MYSQL_* variables, --skip-name-resolve, --max-connections=50, --default-authentication-plugin=mysql_native_password');
    ok(mys.services.db.healthcheck.test.join(' ') === 'CMD mysqladmin ping -h 127.0.0.1 --silent' && !/\$|password/i.test(JSON.stringify(mys.services.db.healthcheck)), 'MySQL healthcheck: mysqladmin ping over TCP, no password in the check');
    ok(JSON.stringify(mys.services.db.cap_add) === JSON.stringify(policy.ALLOWED_CAPS) && JSON.stringify(policy.ALLOWED_CAPS) === JSON.stringify(['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETGID', 'SETUID']), 'MySQL uses the SAME capability allow-list (CHOWN, DAC_OVERRIDE, FOWNER, SETGID, SETUID); nothing was added');
    ok(JSON.stringify(mys.services.db.networks) === '["back"]' && mys.networks.back.internal === true && !(mys.services.db.ports || []).length, 'the MySQL container is on the internal network only, no port');
    const bad = (mut, re, msg) => { const s = JSON.parse(JSON.stringify(mys)); mut(s); const v = policy.validateSpec(s, { sandboxDir: SBD }); ok(v.some(x => re.test(x)), `MySQL: ${msg} -> refused`); };
    bad(s => { s.services.db.privileged = true; }, /privileged/, 'privileged');
    bad(s => { s.services.db.cap_add.push('SYS_NICE'); }, /capability SYS_NICE/, 'cap_add SYS_NICE (the mysql image warns without it; it is not needed)');
    bad(s => { s.services.db.image = 'mysql:8.0.46'; }, /not pinned by digest/, 'the image by tag');
    bad(s => { s.services.db.networks = ['front']; }, /route out/, 'a network with a route out');
    bad(s => { s.services.db.environment.MYSQL_ROOT_PASSWORD = null; }, /literal string/, 'a password taken from the host');
    const unp = { ...realPins, images: { ...realPins.images, db: { ...unpinned('mysql', '8.0.46'), family: 'MySQL' } } };
    ok(policy.validateSpec(mk(unp), { sandboxDir: SBD }).some(x => /not pinned by digest/.test(x)), 'an unpinned matrix entry can never pass validateSpec (its image is not repo@sha256)');
    ok(throws(() => policy.dbService('Oracle', 'x', { root: 'a', user: 'b', pass: 'c', name: 'd' })), 'an unknown database family is refused');

    // ================================================================ guard:setup-sandbox
    group('guard:setup-sandbox: arguments, selective pull, --check with sizes (fake docker runner, nothing pulled)');
    const pa = setup.parseArgs(['--php', '8.2', '--php=7.4', '--db', 'MySQL', '--php', '8.2,8.4']);
    ok(pa.php.join() === '8.2,7.4,8.4' && pa.db.join() === 'mysql' && !pa.check && !pa.repin, 'repeatable and combinable: --php 8.2 --php=7.4 --db MySQL --php 8.2,8.4 -> php 8.2, 7.4, 8.4 and db mysql');
    ok(['--php', '--php 8', '--db oracle', '--check --php 8.2', '--repin --db mysql', '--pull'].every(a => throws(() => setup.parseArgs(a.split(' '))) instanceof setup.UsageError), 'refused: a missing value, "8", an unknown database, --check or --repin combined, unknown options');
    ok(setup.WANT.wordpress.tag === '7.1.3-php8.3-apache' && setup.WANT.db.tag === '11.8.9' && Object.keys(setup.WANT_PHP).join() === '7.4,8.0,8.1,8.2,8.3,8.4' && setup.WANT_DB.mysql.repo === 'library/mysql', 'WANT keeps the three defaults and lists the PHP matrix and mysql');
    const calls = [];
    const fakeRun = (presentRefs, sizes = {}) => args => { calls.push(args); if (args[0] === 'info') return { status: 0, stdout: '29.9.2\n', stderr: '' }; if (args[0] === 'image' && args[1] === 'inspect') { const ref = args[args.length - 1]; return presentRefs.includes(ref) ? { status: 0, stdout: `${JSON.stringify([ref])}\t${sizes[ref] || 300000000}\n`, stderr: '' } : { status: 1, stdout: '', stderr: 'No such image' }; } if (args[0] === 'pull') { presentRefs.push(args[1]); return { status: 0, stdout: '', stderr: '' }; } return { status: 1, stdout: '', stderr: 'unexpected' }; };
    const PF = write(tmp, 'pins/fixture.json', JSON.stringify(fixturePins({ php82: true, mysql: true })));
    const outL = [], errL = [];
    const present = [realPins.images.wordpress.ref, realPins.images.cli.ref, realPins.images.db.ref];
    const code = setup.main(['--check'], { run: fakeRun(present, { [realPins.images.wordpress.ref]: 1120000000 }), out: s => outL.push(s), err: s => errL.push(s), pinFile: PF });
    const line = k => outL.find(l => l.startsWith(k)) || '';
    ok(code === 0 && /present\s+1068\.1 MB/.test(line('default wordpress')) && /missing/.test(line('php 8.2 wordpress')) && /missing/.test(line('db mysql')) && /unpinned \(no tag chosen; run --repin\)/.test(line('php 7.4 wordpress')) && /unpinned \(tag not yet confirmed/.test(line('php 8.1 wordpress')), `--check lists every image: present + size in MB, missing, unpinned (e.g. "${line('default wordpress').replace(/\s+/g, ' ')}")`);
    ok(!calls.some(a => a[0] === 'pull'), '--check pulls nothing');
    calls.length = 0; outL.length = 0; errL.length = 0;
    ok(setup.main(['--check'], { run: fakeRun([realPins.images.wordpress.ref]), out: () => {}, err: () => {}, pinFile: PF }) === 2, '--check exits 2 when a DEFAULT image is missing (as before)');
    calls.length = 0;
    const pulled = [];
    const runP = a => { if (a[0] === 'pull') pulled.push(a[1]); return fakeRun([...present])(a); };
    setup.main(['--php', '8.2', '--db', 'mysql'], { run: runP, out: s => outL.push(s), err: s => errL.push(s), pinFile: PF });
    ok(pulled.join() === [`wordpress@${dg('a')}`, `wordpress@${dg('b')}`, `mysql@${dg('c')}`].join(), `selective pull: only the PHP 8.2 web + CLI images and mysql, each BY DIGEST (${pulled.length} pulls)`);
    pulled.length = 0; errL.length = 0;
    const c2 = setup.main(['--php', '8.1', '--php', '7.4'], { run: runP, out: () => {}, err: s => errL.push(s), pinFile: PF });
    ok(c2 === 2 && pulled.length === 0 && errL.some(l => /php 8\.1 wordpress: wordpress:7\.1\.3-php8\.1-apache is not pinned yet\. Run:\s+npm run guard:setup-sandbox -- --repin && npm run guard:setup-sandbox -- --php 8\.1/.test(l)) && errL.some(l => /no tag chosen/.test(l)), 'an unpinned entry is never pulled: the exact commands are printed instead, exit 2');
    pulled.length = 0;
    setup.main([], { run: runP, out: () => {}, err: () => {}, pinFile: PF });
    ok(pulled.join() === present.join(), 'no flag: the three default images, by digest (as before)');
    const rp1 = await setup.repin(async (repo, tag) => (/php8\.1|mysql/.test(`${repo}:${tag}`) ? { status: 404, digest: null } : { status: 200, digest: dg(crypto.createHash('sha1').update(`${repo}:${tag}`).digest('hex')[0]), media_type: 'x' }), false);
    ok(rp1.images.wordpress.status === undefined && policy.DIGEST_REF.test(rp1.images.wordpress.ref) && rp1.matrix.php['8.2'].wordpress.status === 'pinned' && rp1.matrix.php['8.2'].wordpress.tag_verified === true && rp1.matrix.php['8.2'].cli.tag_verified === true && rp1.matrix.db.mariadb.tag_verified === true && rp1.matrix.php['8.1'].wordpress.tag_verified === false && rp1.matrix.php['8.1'].wordpress.status === 'unpinned' && /does not know/.test(rp1.matrix.php['8.1'].wordpress.note) && rp1.matrix.db.mysql.status === 'unpinned' && rp1.matrix.php['7.4'].wordpress.tag === null, '--repin (fake registry): a tag the registry does not know stays unpinned with the reason; an entry without a tag is not guessed');

    // ================================================================ probe headers
    group('probe: only server and x-powered-by are kept (allow-list, static and behaviour)');
    ok(JSON.stringify(recorder.RESPONSE_HEADER_ALLOW) === '["server","x-powered-by"]' && Object.isFrozen(recorder.RESPONSE_HEADER_ALLOW) && recorder.HEADER_VALUE_MAX === 200, 'the allow-list is exactly ["server", "x-powered-by"], frozen; values capped at 200');
    const picked = recorder.pickHeaders({ 'Set-Cookie': 'wordpress_logged_in=abc', cookie: 'x', 'X-Powered-By': `PHP/8.2.30\u0000\u001b[31m${'z'.repeat(400)}`, Server: 'Apache', authorization: 'Bearer t', 'x-litespeed-cache': 'hit', 'cf-ray': '1' });
    ok(Object.keys(picked).sort().join() === 'server,x-powered-by' && !JSON.stringify(picked).includes('wordpress_logged_in') && picked['x-powered-by'].length === 200 && !/[\u0000-\u001f]/.test(picked['x-powered-by']), 'set-cookie, cookie, authorization and every other header are never stored; names lowercase; control characters stripped; value cut to 200');
    const wsrc = fs.readFileSync(path.join(__dirname, '..', 'probe', 'worker.js'), 'utf8');
    const hdrLines = wsrc.split('\n').filter(l => /headers\(\)/.test(l));
    ok(hdrLines.length === 1 && /rec\.response_headers = pickHeaders\(nav\.response\.headers\(\)\)/.test(hdrLines[0]) && !/set-cookie/i.test(wsrc), 'worker.js reads response headers in exactly one place, through pickHeaders, from the navigation response it already has (no new request)');
    ok(vm.poweredByFrom({ pages: [{ loaded: true }, { response_headers: { 'x-powered-by': 'PHP/8.2.30', server: 'nginx' } }] }) === 'PHP/8.2.30', 'version-match reads X-Powered-By from probe.json');

    group('no network, no process, no browser in the version code');
    for (const f of ['lib/version-detect.js', 'issue/version-match.js']) {
        const t = src(f).replace(/\/\/.*$/gm, '');
        ok(!/require\(['"](https?|net|dns|tls|dgram|child_process)['"]\)|\bfetch\(|XMLHttpRequest|\bspawn(Sync)?\(|(?<!\.)\bexec(Sync|File)?\(|newContext|chromium/.test(t), `${f}: no http/https/net/dns/child_process, no fetch, no browser`);
    }
    ok(!/require\(/.test(src('lib/version-detect.js').replace(/\/\/.*$/gm, '')), 'lib/version-detect.js requires nothing at all (pure functions)');

    // ================================================================ the sandbox (fake docker)
    group('sandbox: versions.json, the build step and the chosen images (fake docker)');
    const SITE = path.join(tmp, 'site');
    write(SITE, 'wp-content/plugins/alpha/alpha.php', "<?php\n/* Plugin Name: Alpha */\n");
    write(SITE, 'wp-content/themes/acme/style.css', '/* Theme Name: Acme */');
    write(SITE, 'wp-includes/version.php', fx('version.php.txt'));
    write(SITE, '.htaccess', fx('htaccess-cpanel.txt'));
    const TINY = fs.readFileSync(path.join(__dirname, 'fixtures', 'issue', 'dump', 'tiny.sql.txt'), 'utf8');
    const MYSQL_DUMP = write(tmp, 'in/mysql.sql', fx('mysqldump-8.0.46.head.sql.txt').replace(/CREATE TABLE `wp_options`[\s\S]*?;\n/, '') + TINY.split('\n').filter(l => !/MariaDB dump/.test(l)).join('\n'));
    const fakeEnv = (name, cfg = {}) => {
        const dir = path.join(tmp, `fake-${name}`); fs.mkdirSync(dir, { recursive: true });
        fs.copyFileSync(path.join(__dirname, 'fixtures', 'issue', 'fake-docker.js'), path.join(dir, 'docker')); fs.chmodSync(path.join(dir, 'docker'), 0o755);
        fs.writeFileSync(path.join(dir, 'fake.json'), JSON.stringify(cfg));
        const sbx = path.join(tmp, `sbx-${name}`); fs.mkdirSync(sbx, { recursive: true, mode: 0o700 });
        return { dir, sbx, log: () => (fs.existsSync(path.join(dir, 'fake.log')) ? fs.readFileSync(path.join(dir, 'fake.log'), 'utf8').split('\n').filter(Boolean).map(JSON.parse) : []), opts: extra => ({ dockerBin: path.join(dir, 'docker'), sandboxesRoot: sbx, root: SITE, env: { PATH: process.env.PATH, HOME: process.env.HOME }, pageCheck: () => ({ status: 200 }), ...extra }) };
    };
    const TABLES = 'Tables_in_wordpress\npgf_options\npgf_users\npgf_posts\npgf_usermeta\n';
    const rules = [{ match: 'db query', stdin: 'SHOW TABLES', out: TABLES }, { match: 'db query', stdin: "option_name = 'siteurl'", out: 'option_value\nhttps://shop.example.com\n' }, { match: 'db query', stdin: "option_name = 'home'", out: 'option_value\nhttps://shop.example.com\n' }];
    // an issue with a Site Health file (PHP 8.2.30) and a probe.json (X-Powered-By PHP/8.1.1): Site Health wins
    const issue = store.create({ title: 'versions', description: 'fixture', symptom: 'white-screen', environment: 'local', root: SITE, pages: ['/'] });
    const cli = require('../lib/issue-cli');
    const shc = cli.siteHealthFlag(issue.id, { 'site-health': SH });
    ok(shc && shc.php.value === '8.2.30' && fs.existsSync(path.join(store.dirOf(issue.id), 'work', 'site-health.json')), 'issue-cli --site-health <file>: read, parsed, saved in the issue\'s work folder');
    ok(cli.siteHealthFlag(issue.id, {}) === null && /--site-health: the Site Health file is/.test((throws(() => cli.siteHealthFlag(issue.id, { 'site-health': path.join(tmp, 'sh', 'big.txt') })) || {}).message || '') && /needs a file/.test((throws(() => cli.siteHealthFlag(issue.id, { 'site-health': true })) || {}).message || ''), 'no flag -> nothing; a refused file or a missing value -> a plain usage error');
    const { parse } = require('./guard');
    const parsed = parse(['issue', 'investigate', 'iss-x', '--site-health', SH]), parsedEq = parse(['--site-health=sh.txt']);
    ok(parsed['site-health'] === SH && parsedEq['site-health'] === 'sh.txt' && parsed._.join() === 'issue,investigate,iss-x', 'the CLI parser (scripts/guard.js FLAGS) accepts --site-health <file> and --site-health=<file>');
    ok(/Unknown option "--site-healthx"/.test((throws(() => parse(['--site-healthx', 'a'])) || {}).message || '') && /Unknown option "--no-such-flag"/.test((throws(() => parse(['--no-such-flag'])) || {}).message || '') && /--site-health needs a value/.test((throws(() => parse(['--site-health'])) || {}).message || ''), 'and still rejects an unknown flag; --site-health without a value is refused');
    ok(/'site-health': abs\(o\['site-health'\]\)/.test(src('lib/wizard.js')) && !/askRaw\([^)]*Site Health/i.test(src('lib/wizard.js')), 'the plugin-guard wizard passes --site-health through (made absolute) and asks no new question');
    fs.writeFileSync(path.join(store.dirOf(issue.id), 'work', 'probe.json'), JSON.stringify({ pages: [{ loaded: true, response_headers: { 'x-powered-by': 'PHP/8.1.1' } }] }));
    const PF2 = write(tmp, 'pins/fixture2.json', JSON.stringify(fixturePins()));
    const E = fakeEnv('match', { wp: rules });
    const h = sandbox.create(issue.id, E.opts({ dump: MYSQL_DUMP, pinFile: PF2 }));
    const vjson = JSON.parse(fs.readFileSync(path.join(h.dir, 'versions.json'), 'utf8'));
    const compose = JSON.parse(fs.readFileSync(h.composeFile, 'utf8'));
    ok((fs.statSync(path.join(h.dir, 'versions.json')).mode & 0o777) === 0o600 && vjson.php.status === 'matched' && vjson.php.source === 'from Site Health' && vjson.db.status === 'matched' && vjson.db.source === 'from the database file header' && vjson.wordpress.status === 'nearest', `versions.json (0600) in the sandbox folder: PHP matched from Site Health, MySQL matched from the header, WordPress nearest`);
    ok(compose.services.db.image === `mysql@${dg('c')}` && compose.services.wordpress.image === `wordpress@${dg('a')}` && compose.services.cli.image === `wordpress@${dg('b')}` && compose.services.db.environment.MYSQL_DATABASE === 'wordpress', 'compose.json runs the chosen images: PHP 8.2 web + CLI and the MySQL service variant');
    const vstep = h.steps.find(s => s.id === 'versions');
    ok(vstep && vstep.status === 'PASSED' && /PHP 8\.2\.30 \(from Site Health\): PHP 8\.2 used \(matched\)/.test(vstep.reason) && /MySQL 8\.0\.46 \(from the database file header\)/.test(vstep.reason) && h.steps.findIndex(s => s.id === 'versions') < h.steps.findIndex(s => s.id === 'spec'), 'the build steps carry the versions line, before the specification step');
    ok(JSON.stringify(JSON.parse(fs.readFileSync(path.join(store.dirOf(issue.id), 'work', 'versions.json'), 'utf8'))) === JSON.stringify(vjson), 'the same versions.json is kept in the issue\'s work folder (the sandbox folder is removed at teardown)');
    ok(E.log().filter(l => l.args[0] === 'image' && l.args[1] === 'inspect').length >= 3 && !E.log().some(l => ['pull', 'run', 'build', 'push'].includes(l.args[0])), 'image presence is checked with image inspect; nothing is pulled, run or built');
    const nBefore = E.log().length, repM = h.destroy(), tail = E.log().slice(nBefore);
    const iShut = tail.findIndex(l => l.args[0] === 'compose' && l.args.includes('exec') && l.args.includes('db') && l.args.join(' ').includes('mysqladmin -uroot -h127.0.0.1 --silent shutdown')), iDown = tail.findIndex(l => l.args[0] === 'compose' && l.args.includes('down'));
    ok(repM.mysql_shutdown === true && iShut >= 0 && iShut < iDown && !tail[iShut].args.some(a => a.includes(compose.services.db.environment.MYSQL_ROOT_PASSWORD)), 'MySQL teardown: mysqladmin shutdown inside the db container BEFORE compose down (a host AppArmor mysqld profile can refuse the runtime\'s signals); the password is read inside the container, never on this command line');
    const E2 = fakeEnv('fallback', { wp: rules, images: { missing: ['mysql@', `wordpress@${dg('a')}`] } });
    const h2 = sandbox.create(issue.id, E2.opts({ dump: MYSQL_DUMP, pinFile: PF2 }));
    const v2 = h2.versions, c2j = JSON.parse(fs.readFileSync(h2.composeFile, 'utf8'));
    ok(v2.php.status === 'nearest' && v2.db.status === 'not matched' && c2j.services.db.image === realPins.images.db.ref && c2j.services.wordpress.image === realPins.images.wordpress.ref && c2j.services.db.environment.MARIADB_DATABASE === 'wordpress', 'images not on this computer -> the defaults, "nearest" / "not matched", MariaDB service');
    ok(v2.commands.join() === 'npm run guard:setup-sandbox -- --php 8.2 --db mysql' && h2.steps.find(s => s.id === 'versions').reason.includes('npm run guard:setup-sandbox -- --php 8.2 --db mysql'), 'and the exact command to get them is in the result and the step');
    const n2 = E2.log().length, rep2 = h2.destroy();
    ok(rep2.mysql_shutdown === false && !E2.log().slice(n2).some(l => l.args.join(' ').includes('mysqladmin')), 'MariaDB teardown: no mysqladmin step (unchanged)');
    const E3 = fakeEnv('nodump', { wp: rules });
    const h3 = sandbox.create(store.create({ title: 'n', description: 'n', symptom: 'white-screen', environment: 'local', root: SITE, pages: ['/'] }).id, E3.opts({}));
    ok(h3.versions.php.source === 'from .htaccess' && h3.versions.php.status === (shipPinned('8.2') ? 'matched' : 'nearest') && h3.versions.db.status === 'assumed' && JSON.parse(fs.readFileSync(h3.composeFile, 'utf8')).services.db.environment.MARIADB_USER === 'wp', 'no dump and no Site Health: PHP from .htaccess (8.2; matched or nearest depending on the shipped pins), database assumed (default MariaDB)');
    h3.destroy();

    // ================================================================ the report
    group("the 'Versions' block under 'For a developer', only where intended");
    const lines = caseFile.versionLines(vjson);
    ok(lines.length === 3 && lines[0] === 'Versions of the test copy: PHP 8.2.30 (from Site Health): PHP 8.2 used (matched)' && /^Versions of the test copy: MySQL 8\.0\.46 \(from the database file header\)/.test(lines[1]), `the block lines name each version and its source ("${lines[0]}")`);
    ok(caseFile.versionLines(null).length === 0 && caseFile.versionLines({ schema: 1, php: { status: 'proven', text: 'x' }, db: vjson.db, wordpress: vjson.wordpress }).length === 0, 'no versions.json, or a status outside the closed list -> no block');
    const pipe = require('./fixtures/issue/gate-pipeline');
    const G = await pipe.run({ tmp: fs.mkdtempSync(path.join(tmp, 'gp-')), result: { gate: true } });
    const res = require('../issue/result'), validate = require('../issue/validate');
    const pol = validate.policyFor(G.root, path.join(G.root, 'plugin-guard.config.json'));
    const md = () => fs.readFileSync(path.join(G.dir, 'result', 'ISSUE-REPORT.md'), 'utf8');
    const rewrite = gate => res.write(G.id, { validation: G.validation, plans: G.plans, dir: G.dir, root: G.root, policy: pol, gate });
    rewrite(true); const before = md();
    fs.writeFileSync(path.join(G.dir, 'work', 'versions.json'), JSON.stringify(vjson));
    rewrite(true);
    ok(md() === before, 'versions.json present but no test copy was built (no sandbox.json): the report is unchanged');
    fs.writeFileSync(path.join(G.dir, 'work', 'sandbox.json'), JSON.stringify({ steps: [], sandbox: null, reproduced_in_sandbox: null }));
    rewrite(true);
    ok(!/Versions of the test copy/.test(md()), 'a sandbox that did not start (sandbox: null): no block');
    fs.writeFileSync(path.join(G.dir, 'work', 'sandbox.json'), JSON.stringify({ steps: [], sandbox: { url: 'http://127.0.0.1:1', notice: policy.NOTICE, recommendation: policy.RECOMMENDATION, limits: [] }, reproduced_in_sandbox: null }));
    rewrite(true);
    const withBlock = md(), dev = withBlock.slice(withBlock.indexOf('## For a developer'));
    ok(withBlock.includes('## For a developer') && /- Versions of the test copy: PHP 8\.2\.30 \(from Site Health\): PHP 8\.2 used \(matched\)/.test(dev), "a test copy was built: the block is under 'For a developer'");
    ok(withBlock.slice(0, withBlock.indexOf('## What you see')) === before.slice(0, before.indexOf('## What you see')) && !withBlock.slice(0, withBlock.indexOf('## For a developer')).includes('Versions of the test copy'), 'the top of the report (status) is unchanged; the versions appear only in the developer part');
    const fj = JSON.parse(fs.readFileSync(path.join(G.dir, 'result', 'findings.json'), 'utf8'));
    ok(fj.case_file.developer.some(l => /^Versions of the test copy: /.test(l)) && /FOR A DEVELOPER[\s\S]*Versions of the test copy/.test(fj.summary.text_report), 'the same lines are in findings.json (the page data) and the command-line summary');
    const offBefore = (() => { fs.rmSync(path.join(G.dir, 'work', 'versions.json')); rewrite(false); return fs.readFileSync(path.join(G.dir, 'result', 'ISSUE-REPORT.md'), 'utf8'); })();
    fs.writeFileSync(path.join(G.dir, 'work', 'versions.json'), JSON.stringify(vjson)); rewrite(false);
    const norm = t => t.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, '<TIME>');
    ok(norm(fs.readFileSync(path.join(G.dir, 'result', 'ISSUE-REPORT.md'), 'utf8')) === norm(offBefore), 'gate off: the report is byte-identical with or without versions.json');

    console.log(failures ? `\n${failures} check(s) FAILED` : `\nAll checks passed${toVerify ? ` (${toVerify} item(s) TO VERIFY once a mysql 8.0 image is present: see the TO VERIFY lines)` : ''}`);
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
