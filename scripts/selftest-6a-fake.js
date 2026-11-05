#!/usr/bin/env node
// Self-test of TEST-COPY-SPEC Part 6a against the fake `docker` (scripts/fixtures/issue/fake-docker.js): the safe start order of a sandbox
// built from a database file, and the intake of that file (lib/dump-intake.js). No daemon is involved; the fake records, for every call,
// whether the web container was running at that moment, so "no web container runs while real rows are in the database" is checked per call.
// The real-container proof is selftest-6a-docker.js.

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawn } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-6a-'));
process.env.PLUGIN_GUARD_SANDBOXES = path.join(tmp, 'sbx-cleanup');
process.env.PLUGIN_GUARD_ISSUES = path.join(tmp, 'issues');
fs.mkdirSync(process.env.PLUGIN_GUARD_SANDBOXES, { mode: 0o700 }); fs.mkdirSync(process.env.PLUGIN_GUARD_ISSUES, { mode: 0o700 });
const sandbox = require('../issue/sandbox');
const intake = require('../lib/dump-intake');
const wpcli = require('../issue/sandbox-wpcli');
const cleanup = require('../issue/cleanup');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const group = t => console.log(`\n== ${t}`);
const write = (root, rel, body) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); return f; };
const rejects = async (fn, re) => { try { await fn(); return null; } catch (e) { return re.test(`${e.name}: ${e.message}`) ? e : null; } };
const sleepMs = ms => new Promise(r => setTimeout(r, ms));
let seq = 0;
const newId = () => `iss-20261105-1000${String(seq++).padStart(2, '0')}-${crypto.randomBytes(3).toString('hex')}`;

// ---- fixtures ----
const SITE = path.join(tmp, 'site');
write(SITE, 'wp-config.php', "<?php define('DB_NAME','x');");
write(SITE, 'wp-content/plugins/alpha/alpha.php', "<?php\n/* Plugin Name: Alpha */\n");
write(SITE, 'wp-content/themes/acme/style.css', '/* Theme Name: Acme */');
const TINY = fs.readFileSync(path.join(__dirname, 'fixtures', 'issue', 'dump', 'tiny.sql.txt'));
const SQL = write(tmp, 'in/site.sql', TINY);
const GZ = write(tmp, 'in/site.sql.gz', zlib.gzipSync(TINY));

function fakeEnv(name, cfg = {}) {
    const dir = path.join(tmp, 'fake-' + name); fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(path.join(__dirname, 'fixtures', 'issue', 'fake-docker.js'), path.join(dir, 'docker')); fs.chmodSync(path.join(dir, 'docker'), 0o755);
    const sbx = path.join(tmp, 'sbx-' + name); fs.mkdirSync(sbx, { recursive: true, mode: 0o700 });
    const f = {
        dir, sandboxesRoot: sbx, pages: [],
        log: () => (fs.existsSync(path.join(dir, 'fake.log')) ? fs.readFileSync(path.join(dir, 'fake.log'), 'utf8').split('\n').filter(Boolean).map(JSON.parse) : []),
        state: () => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'fake.state.json'), 'utf8')); } catch { return { containers: [], volumes: [], networks: [] }; } },
        jsonOpts: (extra = {}) => ({ dockerBin: path.join(dir, 'docker'), sandboxesRoot: sbx, root: SITE, env: { PATH: process.env.PATH, HOME: process.env.HOME }, ...extra })
    };
    f.opts = (extra = {}) => f.jsonOpts({ pageCheck: u => { f.pages.push(u); return { status: 200 }; }, ...extra });
    fs.writeFileSync(path.join(dir, 'fake.json'), JSON.stringify(cfg));
    return f;
}
const leftovers = f => { const s = f.state(); return s.containers.length + s.volumes.length + s.networks.length; };
const TABLES = 'Tables_in_wordpress\npgf_options\npgf_users\npgf_posts\npgf_usermeta\n';
const wpRules = (extra = [], { siteurl = 'https://shop.example.com', home = 'https://shop.example.com' } = {}) => [...extra,
    { match: 'db query', stdin: 'SHOW TABLES', out: TABLES }, { match: 'db query', stdin: "option_name = 'siteurl'", out: `option_value\n${siteurl}\n` }, { match: 'db query', stdin: "option_name = 'home'", out: `option_value\n${home}\n` }];
const sub = (l, s, svc) => l.args[0] === 'compose' && l.args[5] === s && (!svc || l.args.includes(svc));
const isImport = l => l.args.join(' ').includes('wp db import -');
const isAnon = l => /user_email = CONCAT/.test(l.stdin || '');
const noDumpLeft = root => { let found = false; (function w(d) { let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory()) w(p); else if (e.name === 'dump.sql') found = true; } })(root); return !found; };

(async () => {
    // ================================================================ order
    group('start order with a database file: stop web -> import -> payments -> anonymise -> start web -> new port -> address');
    const A = fakeEnv('order', { ports: ['127.0.0.1:38080', '127.0.0.1:38999'], wp: wpRules([], { siteurl: 'https://shop.example.com/wp', home: 'https://shop.example.com' }) });
    const realRead = fs.readFileSync, reads = [];
    fs.readFileSync = function (f, ...rest) { if (typeof f === 'string' && (f === SQL || /dump\.sql$/.test(f))) reads.push(f); return realRead.call(this, f, ...rest); };
    let h; try { h = sandbox.create(newId(), A.opts({ dump: SQL })); } finally { fs.readFileSync = realRead; }
    const L = A.log(), at = pred => L.findIndex(pred), last = pred => { let i = -1; L.forEach((l, k) => { if (pred(l)) i = k; }); return i; };
    const iUp = at(l => sub(l, 'up')), iChown = at(l => sub(l, 'exec', 'wordpress') && l.args.includes('chown')), iStop = at(l => sub(l, 'stop', 'wordpress')), iImp = at(isImport);
    const iPay = at(l => /'woocommerce/.test(l.stdin || '')), iAnon = at(isAnon), iAnonLast = last(l => /^(UPDATE|DELETE)/.test(l.stdin || '') && !/'woocommerce/.test(l.stdin || '')), iStart = at(l => sub(l, 'start', 'wordpress'));
    const ports = L.map((l, i) => (sub(l, 'port') ? i : -1)).filter(i => i >= 0), iSR = at(l => l.args.includes('search-replace'));
    ok(iUp >= 0 && iUp < iStop && iStop < iImp && iImp < iPay && iPay < iAnon && iAnon <= iAnonLast && iAnonLast < iStart && iStart < ports[1] && ports[1] < iSR, `order: up (${iUp}) -> stop wordpress (${iStop}) -> db import (${iImp}) -> payment check (${iPay}) -> anonymise (${iAnon}..${iAnonLast}) -> start wordpress (${iStart}) -> port read again (${ports[1]}) -> search-replace (${iSR})`);
    ok(iChown >= 0 && iChown < iStop, 'the container user\'s files are handed back while the web container still runs (before the stop)');
    ok(L.filter(l => sub(l, 'up')).length === 1 && L.filter(l => sub(l, 'start')).length === 1 && L.filter(l => sub(l, 'stop')).length === 1, 'exactly one up, one stop and one start');
    const during = L.slice(iImp, iStart);
    ok(during.length > 3 && during.every(l => l.web_running === false), `the web container was NOT running for any of the ${during.length} calls between the import and the second start (import, payment check, anonymisation)`);
    ok(L.slice(iStart + 1).filter(l => l.web_running !== null).every(l => l.web_running === true), 'after the second start the web container is running');
    ok(at(l => sub(l, 'ps', 'wordpress')) > iStop && at(l => sub(l, 'ps', 'wordpress')) < iImp, 'the stop is checked (compose ps --status running) before the import begins');
    ok(ports.length === 2 && h.url === 'http://127.0.0.1:38999' && h.port === 38999, `the port is read again after the restart (it changed from 38080 to ${h.port})`);
    ok(fs.readFileSync(path.join(h.dir, 'logs', 'url.txt'), 'utf8') === 'http://127.0.0.1:38999' && JSON.parse(fs.readFileSync(path.join(h.dir, 'state.json'), 'utf8')).port === 38999, 'url.txt and state.json carry the new address');
    const srs = L.filter(l => l.args.includes('search-replace')).map(l => l.args.slice(l.args.indexOf('search-replace') + 1, l.args.indexOf('search-replace') + 3).join(' -> '));
    ok(srs.join(' | ') === 'https://shop.example.com/wp -> http://127.0.0.1:38999 | https://shop.example.com -> http://127.0.0.1:38999', `siteurl and home are replaced separately, the longer one first (${srs.join(' | ')})`);
    ok(L.filter(l => l.args.includes('search-replace')).every(l => l.args.includes('--all-tables') && l.args.includes('--skip-columns=guid')), 'search-replace runs on all tables and skips the guid column');
    const upd = n => L.some(l => { const i = l.args.indexOf('option'); return i > 0 && l.args[i + 1] === 'update' && l.args[i + 2] === n && l.args[i + 3] === 'http://127.0.0.1:38999'; });
    ok(upd('siteurl') && upd('home') && L.some(l => l.args.includes('blog_public')), 'siteurl and home are set to the new address and blog_public is 0');
    ok(A.pages.join() === 'http://127.0.0.1:38999' && h.steps.some(s => s.id === 'page' && s.status === 'PASSED'), 'the front page is checked once, on the new address');
    ok(reads.length === 0, `no whole-file read of the dump or its copy during create() (${reads.length} readFileSync call(s))`);
    const imp = L[iImp];
    ok(imp.stdin_bytes === TINY.length && imp.stdin.includes('PG-FIXTURE-MARKER') && !imp.args.some(a => /dump\.sql/.test(a)), 'the import got the dump on stdin (streamed from the file descriptor), not as an argument');
    ok(!fs.existsSync(path.join(h.dir, 'db', 'dump.sql')) && h.prefix === 'pgf_', 'the temporary copy is gone after the import; the prefix was read from it');
    ok(['web-stopped', 'database', 'anonymise', 'web-started', 'address', 'page'].every(s => h.steps.some(x => x.id === s)), `the steps are reported (${h.steps.map(s => s.id).join(', ')})`);
    h.destroy(); ok(leftovers(A) === 0 && !fs.existsSync(h.dir), 'destroy leaves nothing');

    group('without a database file the old flow is unchanged');
    const N = fakeEnv('nodump', { wp: wpRules() });
    const hn = sandbox.create(newId(), N.opts());
    const NL = N.log();
    ok(!NL.some(l => sub(l, 'stop') || sub(l, 'start')) && NL.filter(l => sub(l, 'port')).length === 1 && NL.some(l => l.args.includes('install')) && N.pages.length === 0, 'no stop, no start, one port read, a fresh install, no page check');
    hn.destroy();

    group('--keep-real-data keeps working: same order, warning as before');
    const K = fakeEnv('keep', { wp: wpRules() });
    const hk = sandbox.create(newId(), K.opts({ dump: SQL, keepRealData: true }));
    const KL = K.log(), kImp = KL.findIndex(isImport), kStart = KL.findIndex(l => sub(l, 'start', 'wordpress'));
    ok(hk.real_data === true && hk.warnings.some(w => /REAL PERSONAL DATA/.test(w)) && kImp >= 0 && kStart > kImp && !KL.some(isAnon), 'real data kept on request: no personal scrubbing, web started after the import, warning shown');
    hk.destroy();

    group('.sql.gz: unpacked as a stream; the prefix is read from the unpacked copy');
    const G = fakeEnv('gz', { wp: wpRules() });
    const hg = sandbox.create(newId(), G.opts({ dump: GZ }));
    const gi = G.log().find(isImport);
    ok(hg.prefix === 'pgf_' && gi.stdin_bytes === TINY.length && gi.stdin.includes('PG-FIXTURE-MARKER') && hg.steps.some(s => s.id === 'dump' && /gzip/.test(s.reason)), 'the unpacked SQL (not the gzip bytes) went to the import, prefix pgf_');
    hg.destroy();

    // ================================================================ failures between stop and start
    group('a failure while real rows are in the database: the web container is never started again');
    for (const [name, rule, re] of [
        ['anon', { match: 'db query', stdin: 'user_email = CONCAT', status: 1, stderr: 'ERROR 1146 (42S02): no such table\n' }, /anonymisation failed/],
        ['import', { match: 'db import', status: 1, stderr: 'ERROR 1064 syntax\n' }, /import failed/],
        ['pay', { match: 'db query', stdin: "'woocommerce", out: 'option_name\toption_value\nwoocommerce_stripe_settings\ta:2:{s:7:"enabled";s:3:"yes";s:8:"testmode";s:2:"no";}\n' }, /LIVE/]]) {
        const F = fakeEnv('fail-' + name, { wp: wpRules([rule]) });
        const id = newId();
        const e = await rejects(() => sandbox.create(id, F.opts({ dump: SQL })), re);
        const FL = F.log();
        ok(e && !FL.some(l => sub(l, 'start')) && FL.some(l => sub(l, 'stop', 'wordpress')), `${name}: refused (${e && e.message.split('\n')[0].slice(0, 70)}), and no \`start wordpress\` was ever sent`);
        ok(leftovers(F) === 0 && !fs.existsSync(path.join(F.sandboxesRoot, id)) && noDumpLeft(F.sandboxesRoot) && F.pages.length === 0, `${name}: containers, volumes (the database), networks, folder and dump copy are removed; no page was loaded`);
    }
    group('fail closed: personal data cannot be shown to be removed, or a live gateway cannot be shown to be off');
    const LIVE = { match: 'db query', stdin: "'woocommerce", out: 'option_name\toption_value\nwoocommerce_stripe_settings\ta:2:{s:7:"enabled";s:3:"yes";s:8:"testmode";s:2:"no";}\n' };
    const NOPREFIX = write(tmp, 'in/noprefix.sql', 'CREATE TABLE `misc` (a int);\nINSERT INTO `misc` VALUES (1);\n');
    for (const [name, rules, extra, re] of [
        ['show-tables-fails', [{ match: 'db query', stdin: 'SHOW TABLES', status: 1, stderr: 'ERROR 2002 cannot connect\n' }], {}, /tables of the imported database could not be listed/],
        ['no-tables', [{ match: 'db query', stdin: 'SHOW TABLES', out: 'Tables_in_wordpress\n' }], {}, /no table with the prefix "pgf_"/],
        ['users-missing', [{ match: 'db query', stdin: 'SHOW TABLES', out: 'Tables_in_wordpress\npgf_options\npgf_posts\n' }], {}, /users table "pgf_users" was not found/],
        ['wrong-prefix', [], { dump: NOPREFIX }, /no table with the prefix "wp_"/],   // prefix not detected -> wp_ assumed, but the database holds pgf_ tables
        ['payment-query-fails', [{ match: 'db query', stdin: "'woocommerce", status: 1, stderr: 'ERROR 1146\n' }], {}, /payment gateway settings could not be read/],
        ['neutralise-fails', [{ match: 'db query', stdin: 'REPLACE(option_value', status: 1, stderr: 'ERROR 1205 lock wait\n' }, LIVE], { neutralisePayments: true }, /could not be switched off/],
        ['users-still-real', [{ match: 'db query', stdin: 'pg_unscrubbed', out: 'pg_unscrubbed\n2\n' }], {}, /2 user row\(s\) still had a real login/],
        ['users-check-fails', [{ match: 'db query', stdin: 'pg_unscrubbed', status: 1, stderr: 'ERROR 1054\n' }], {}, /could not be checked/]]) {
        const F = fakeEnv('closed-' + name, { wp: wpRules(rules) });
        const id = newId();
        const e = await rejects(() => sandbox.create(id, F.opts({ dump: SQL, ...extra })), re);
        const FL = F.log();
        ok(e && FL.some(isImport) && !FL.some(l => sub(l, 'start')), `${name}: refused after the import (${e ? e.message.slice(0, 90) : 'NOT refused as expected'}), and the web container was never started again`);
        ok(leftovers(F) === 0 && !fs.existsSync(path.join(F.sandboxesRoot, id)) && noDumpLeft(F.sandboxesRoot) && F.pages.length === 0, `${name}: the sandbox is destroyed (containers, database volume, networks, folder, dump copy) and no page was loaded`);
    }
    const Ok2 = fakeEnv('closed-control', { wp: wpRules() });
    const hc = sandbox.create(newId(), Ok2.opts({ dump: SQL }));
    ok(Ok2.log().some(l => /pg_unscrubbed/.test(l.stdin || '') && l.web_running === false) && hc.steps.some(s => s.id === 'web-started'), 'control: the users re-check runs while the web container is stopped, and with 0 rows left the build goes on');
    hc.destroy();
    const Kp = fakeEnv('closed-keep', { wp: wpRules([{ match: 'db query', stdin: 'SHOW TABLES', out: 'Tables_in_wordpress\n' }]) });
    const hkp = sandbox.create(newId(), Kp.opts({ dump: SQL, keepRealData: true }));
    ok(hkp.real_data === true && !Kp.log().some(l => /pg_unscrubbed/.test(l.stdin || '')), '--keep-real-data (explicit choice) is not blocked by the personal-data checks, as before');
    hkp.destroy();

    const S1 = fakeEnv('stopfail', { stop_fail: true, wp: wpRules() });
    ok(await rejects(() => sandbox.create(newId(), S1.opts({ dump: SQL })), /could not be stopped/) && !S1.log().some(isImport) && leftovers(S1) === 0 && noDumpLeft(S1.sandboxesRoot), 'the stop fails -> nothing is imported, all removed');
    const S2 = fakeEnv('pslies', { ps_lies: true, wp: wpRules() });
    ok(await rejects(() => sandbox.create(newId(), S2.opts({ dump: SQL })), /still running/) && !S2.log().some(isImport) && leftovers(S2) === 0, 'the web container still reported running after the stop -> refused before the import');
    const S3 = fakeEnv('psfail', { ps_fail: true, wp: wpRules() });
    ok(await rejects(() => sandbox.create(newId(), S3.opts({ dump: SQL })), /cannot be read/) && !S3.log().some(isImport), 'the state of the web container cannot be read -> refused before the import');
    const S4 = fakeEnv('port2', { ports: ['127.0.0.1:38080', '0.0.0.0:38999'], wp: wpRules() });
    ok(await rejects(() => sandbox.create(newId(), S4.opts({ dump: SQL })), /not on 127\.0\.0\.1/) && !S4.log().some(l => l.args.includes('search-replace')) && leftovers(S4) === 0 && S4.pages.length === 0, 'the port after the restart is checked again: 0.0.0.0 -> refused, torn down, no page loaded');

    // ================================================================ intake
    group('database file intake (lib/dump-intake.js)');
    const dest = () => path.join(tmp, 'dest', `d${seq++}.sql`);
    fs.mkdirSync(path.join(tmp, 'dest'), { mode: 0o700 });
    const refusedWith = (src, re, o) => { const d = dest(); let e = null; try { intake.intake(src, d, o); } catch (x) { e = x; } return e && e.name === 'DumpRefused' && re.test(e.message) && !fs.existsSync(d) ? e : null; };
    const big = write(tmp, 'in/big.sql.gz', zlib.gzipSync(Buffer.from('INSERT INTO t VALUES (1);\n'.repeat(120000))));
    ok(refusedWith(big, /larger than 1 MB once unpacked/, { maxMb: 1 }) && fs.statSync(big).size < 1048576, `the cap counts unpacked bytes: a ${Math.round(fs.statSync(big).size / 1024)} KB .gz that unpacks to 3 MB is refused at a 1 MB cap, with the plain message`);
    ok(/larger than 1024 MB once unpacked/.test(intake.capMessage(1024)), 'the default message names 1024 MB');
    const bomb = path.join(tmp, 'in/bomb.sql.gz');
    { const gz = zlib.createGzip({ level: 9 }), out = fs.createWriteStream(bomb); gz.pipe(out); const chunk = Buffer.alloc(1 << 20, 0x20); for (let i = 0; i < 256; i++) gz.write(chunk); gz.end(); await new Promise(r => out.on('finish', r)); }
    const t0 = Date.now(); const eb = refusedWith(bomb, /once unpacked/, { maxMb: 2 }); const tb = Date.now() - t0;
    ok(eb && fs.statSync(bomb).size < 2 * 1048576, `gzip bomb (${Math.round(fs.statSync(bomb).size / 1024)} KB that unpacks to 256 MB) stops at the 2 MB cap in ${tb} ms; no copy is left`);
    const okCopy = dest(); const g1 = intake.intake(GZ, okCopy);
    ok(g1.gzip && g1.bytes === TINY.length && (fs.statSync(okCopy).mode & 0o777) === 0o600 && realRead(okCopy).equals(TINY), 'a valid .gz is unpacked to a 0600 copy, byte for byte');
    const u16 = write(tmp, 'in/u16.sql', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('CREATE TABLE x (a int);', 'utf16le')]));
    const u16be = write(tmp, 'in/u16be.sql', Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('C\0R\0', 'latin1')]));
    const u16gz = write(tmp, 'in/u16.sql.gz', zlib.gzipSync(realRead(u16)));
    ok(refusedWith(u16, /this file was saved as UTF-16: export it as UTF-8/) && refusedWith(u16be, /UTF-16: export it as UTF-8/) && refusedWith(u16gz, /UTF-16: export it as UTF-8/), 'UTF-16 (ff fe, fe ff, and inside a .gz) is refused: "this file was saved as UTF-16: export it as UTF-8"');
    const crypt = write(tmp, 'in/backup_2026-11-01-1200_Site_abc123-db.gz.crypt', crypto.randomBytes(4096));
    const cryptTxt = write(tmp, 'in/plain-looking.crypt', 'CREATE TABLE x (a int);');
    const zip = write(tmp, 'in/site.zip', Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('dump.sql')]));
    const bin = write(tmp, 'in/binary.sql', Buffer.concat([Buffer.from('CREATE TABLE'), Buffer.from([0, 1, 2, 3])]));
    const badgz = write(tmp, 'in/broken.sql.gz', Buffer.concat([Buffer.from([0x1f, 0x8b, 8, 0]), crypto.randomBytes(200)]));
    for (const [f, what] of [[crypt, 'an UpdraftPlus .crypt file'], [cryptTxt, 'a .crypt name even with text inside'], [zip, 'a .zip archive'], [bin, 'binary data (a NUL byte in the first 64 KB)'], [badgz, 'a broken .gz']]) ok(refusedWith(f, /export a fresh, unencrypted copy/), `${what} is refused: "export a fresh, unencrypted copy"`);
    fs.symlinkSync(SQL, path.join(tmp, 'in/link.sql'));
    ok(refusedWith(path.join(tmp, 'in/link.sql'), /is not a plain file/) && refusedWith(path.join(tmp, 'in'), /is not a plain file/) && refusedWith(path.join(tmp, 'in/missing.sql'), /does not exist/), 'a symbolic link, a folder and a missing file are refused');
    const Z = fakeEnv('intake-sb', { wp: wpRules() });
    ok(await rejects(() => sandbox.create(newId(), Z.opts({ dump: u16 })), /SandboxUnavailable.*UTF-16/) && !Z.log().some(l => sub(l, 'up')) && fs.readdirSync(Z.sandboxesRoot).length === 0, 'through create(): a refused file stops the sandbox before anything starts, and no folder is left');
    ok(await rejects(() => sandbox.create(newId(), Z.opts({ dump: path.join(tmp, 'in/link.sql') })), /not a plain file/), 'through create(): a symlinked --db-dump is refused');
    const pre = dest(); fs.writeFileSync(pre, 'old');
    let ex = null; try { intake.intake(SQL, pre); } catch (e) { ex = e; } ok(ex && realRead(pre, 'utf8') === 'old', 'an existing copy is never overwritten (O_EXCL)');

    group('static: no whole-file read of the dump; the import streams from a file descriptor');
    const src = f => realRead(path.join(__dirname, '..', f), 'utf8');
    const sbSrc = src('issue/sandbox.js'), inSrc = src('lib/dump-intake.js'), wcSrc = src('issue/sandbox-wpcli.js');
    ok(!/readFileSync\(\s*(dumpFile|o\.dump)/.test(sbSrc) && /importDump\(\{ file: dumpFile \}\)/.test(sbSrc), 'sandbox.js never calls readFileSync on the dump and imports with { file: dumpFile }');
    ok(!/readFileSync|gunzipSync|inflateSync|unzipSync/.test(inSrc) && /createGunzip/.test(inSrc), 'lib/dump-intake.js reads in chunks only (no readFileSync, no gunzipSync) and unpacks with a zlib stream');
    ok(/stdio: \[stdinFd, 'pipe', 'pipe'\]/.test(wcSrc), 'sandbox-wpcli.js hands the open file to docker as its stdin');
    {
        const calls = []; const sbr = path.join(tmp, 'wc'); const d = path.join(sbr, 'iss-20261105-000000-abcdef'); fs.mkdirSync(path.join(d, 'db'), { recursive: true });
        fs.writeFileSync(path.join(d, 'compose.json'), '{}'); fs.writeFileSync(path.join(d, 'state.json'), JSON.stringify({ project: 'pgsb0000abcd' })); fs.writeFileSync(path.join(d, 'db', 'dump.sql'), 'SELECT 1;');
        const w = new wpcli.SandboxWpCli({ sandboxesRoot: sbr, sandboxDir: d, project: 'pgsb0000abcd', dockerBin: '/bin/true', runner: (b, a, o) => { calls.push(o); return { status: 0, stdout: '', stderr: '' }; } });
        const r = w.importDump({ file: path.join(d, 'db', 'dump.sql') });
        ok(r.ok && Number.isInteger(calls[0].stdio[0]) && calls[0].input === undefined, 'importDump({ file }) passes a file descriptor as stdin, no buffer');
        const thr = fn => { try { fn(); return false; } catch (e) { return e.name === 'SandboxRefusal'; } };
        fs.writeFileSync(path.join(d, 'db', 'other.sql'), 'x');
        ok(thr(() => w.importDump({ file: path.join(d, 'db', 'other.sql') })) && thr(() => w.importDump({ file: SQL })) && thr(() => w.importDump({ file: path.join(d, 'db', '..', 'db', 'dump.sql', '..') })), 'importDump({ file }) refuses any path other than <sandbox>/db/dump.sql');
        fs.rmSync(path.join(d, 'db', 'dump.sql')); fs.symlinkSync(SQL, path.join(d, 'db', 'dump.sql'));
        ok(thr(() => w.importDump({ file: path.join(d, 'db', 'dump.sql') })), 'a dump.sql that is a symbolic link is refused');
    }

    // ================================================================ interrupted runs
    group('an interrupted run during the import: teardown removes the database, containers and the dump copy');
    const childRun = async (sig) => {
        const E = fakeEnv('int-' + sig, { wp: wpRules([{ match: 'db import', marker: 'importing', sleep_ms: 8000 }]) });
        const idc = newId();
        const script = `const sb=require(${JSON.stringify(path.join(__dirname, '..', 'issue', 'sandbox'))});sb.create(${JSON.stringify(idc)},${JSON.stringify(E.jsonOpts({ dump: SQL }))});setInterval(()=>{},1000);`;
        const c = spawn(process.execPath, ['-e', script], { stdio: 'ignore', detached: true });
        const done = new Promise(r => c.on('exit', (code, s) => r({ code, s })));
        for (let i = 0; i < 150 && !fs.existsSync(path.join(E.dir, 'importing')); i++) await sleepMs(100);
        const before = leftovers(E), copyThere = fs.existsSync(path.join(E.sandboxesRoot, idc, 'db', 'dump.sql'));
        process.kill(-c.pid, sig);   // the whole process group, as Ctrl-C in a terminal does
        const r = await done;
        return { E, idc, r, before, copyThere };
    };
    for (const sig of ['SIGINT', 'SIGTERM']) {
        const x = await childRun(sig);
        ok(x.before > 0 && x.copyThere, `${sig}: interrupted while importing (${x.before} resources, the dump copy present)`);
        ok(leftovers(x.E) === 0 && !fs.existsSync(path.join(x.E.sandboxesRoot, x.idc)) && noDumpLeft(x.E.sandboxesRoot) && !x.E.log().some(l => sub(l, 'start')), `${sig}: afterwards nothing is left (database volume, containers, networks, folder, dump copy) and the web container was never started again (exit ${x.r.code ?? x.r.s})`);
    }

    group('a run killed with SIGKILL (cannot be caught) leaves a sandbox with a dump copy: `issue cleanup` lists and removes it');
    {
        const SB = process.env.PLUGIN_GUARD_SANDBOXES;
        const E = fakeEnv('kill', { wp: wpRules([{ match: 'db import', marker: 'importing', sleep_ms: 8000 }]) });
        const idc = newId();
        const script = `const sb=require(${JSON.stringify(path.join(__dirname, '..', 'issue', 'sandbox'))});sb.create(${JSON.stringify(idc)},${JSON.stringify(E.jsonOpts({ dump: SQL, sandboxesRoot: SB }))});`;
        const c = spawn(process.execPath, ['-e', script], { stdio: 'ignore', detached: true });
        const done = new Promise(r => c.on('exit', r));
        for (let i = 0; i < 150 && !fs.existsSync(path.join(E.dir, 'importing')); i++) await sleepMs(100);
        process.kill(-c.pid, 'SIGKILL'); await done;
        const copy = path.join(SB, idc, 'db', 'dump.sql');
        ok(fs.existsSync(copy) && (fs.statSync(copy).mode & 0o777) === 0o600 && leftovers(E) > 0, 'control: the killed run left its folder, a 0600 dump copy and labelled containers/volumes');
        const p = cleanup.plan({ issues: false });
        const item = p.sandboxes.find(s => s.id === idc);
        ok(item && /database copy/.test(item.reason), `issue cleanup lists it${item ? ` (${item.reason})` : ''}`);
        const r = await cleanup.apply(p, { confirm: async () => true, sandboxOptions: { dockerBin: path.join(E.dir, 'docker'), env: { PATH: process.env.PATH, HOME: process.env.HOME }, sandboxesRoot: SB } });
        ok(r.removed.some(x => x.path.endsWith(idc)) && !fs.existsSync(path.join(SB, idc)) && leftovers(E) === 0, 'and after "yes" removes the folder with the dump copy and its labelled containers, volumes and networks');
    }

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(failures ? `\n${failures} FAILED` : '\nAll checks passed');
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
