#!/usr/bin/env node
// Self-test of TEST-COPY-SPEC Part 6a against a REAL Docker daemon: a sandbox built from a WordPress database export (fixture
// scripts/fixtures/issue/dump/wp-site.sql.txt, as .sql and as .sql.gz), with the safe start order. It SKIPS (exit 0, a clear SKIP line) when
// Docker is not usable or the pinned images are missing (`npm run guard:setup-sandbox`). Plugin Guard never pulls anything on its own.
// What it proves: the web container was NOT running during the import and the anonymisation (docker inspect at those moments, and its
// StartedAt after the import ended); no real e-mail address was in the database when the web container started (queried just before);
// then a page loads on 127.0.0.1 with the marker text, and siteurl, home and a serialised option were rewritten to the sandbox address.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const sandbox = require('../issue/sandbox');

const pf = sandbox.preflight({});
if (!pf.ok) { console.log(`SKIP  selftest-6a-docker was NOT run: it needs a usable Docker daemon and the pinned sandbox images.\n  reason: ${pf.reason}\n  Nothing in this suite is claimed as verified in this environment.`); process.exit(0); }

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const group = t => console.log(`\n== ${t}`);
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
function hashTree(dir) { const h = crypto.createHash('sha256'); (function walk(d) { for (const n of fs.readdirSync(d).sort()) { const f = path.join(d, n), st = fs.lstatSync(f); h.update(`${path.relative(dir, f)}|${st.isSymbolicLink() ? 'l' : st.isDirectory() ? 'd' : 'f'}|${st.mode}|`); if (st.isDirectory()) walk(f); else if (st.isFile()) h.update(fs.readFileSync(f)); } })(dir); return h.digest('hex'); }
const dk = args => spawnSync('docker', args, { encoding: 'utf8' });
const labelled = () => { const l = sandbox.labelled({ dockerBin: 'docker', runner: spawnSync, env: process.env }); return l.containers.length + l.volumes.length + l.networks.length; };
const webState = project => {
    const id = dk(['ps', '-a', '-q', '--filter', `label=pg.project=${project}`, '--filter', 'label=pg.role=wordpress']).stdout.trim().split('\n')[0];
    const [running, startedAt] = dk(['inspect', '--format', '{{.State.Running}}|{{.State.StartedAt}}', id]).stdout.trim().split('|');
    return { id, running: running === 'true', startedAt: Date.parse(String(startedAt).replace(/(\.\d{3})\d*/, '$1')) };
};
const get = url => new Promise(res => { const q = http.get(url, { timeout: 30000 }, r => { let b = ''; r.setEncoding('utf8'); r.on('data', c => { b += c; }); r.on('end', () => res({ status: r.statusCode, body: b, location: r.headers.location })); }); q.on('timeout', () => q.destroy(new Error('timeout'))); q.on('error', e => res({ status: 0, body: '', error: e.message })); });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-6a-dk-'));
const SITE = path.join(tmp, 'site');
fs.mkdirSync(path.join(SITE, 'wp-content', 'plugins', 'probe-plugin'), { recursive: true });
fs.mkdirSync(path.join(SITE, 'wp-content', 'themes'), { recursive: true });
fs.writeFileSync(path.join(SITE, 'wp-content', 'plugins', 'probe-plugin', 'probe-plugin.php'), "<?php\n/* Plugin Name: Probe Plugin */\n");
const SITE_HASH = hashTree(SITE);
const SB = path.join(tmp, 'sandboxes');
// the customer's address in the fixture: a reserved domain (RFC 2606), standing in for a real person's address that the anonymisation must remove
const REAL = 'maria.lopez@example.com';
const OLD = 'https://shop.example.com';
const sqlText = fs.readFileSync(path.join(__dirname, 'fixtures', 'issue', 'dump', 'wp-site.sql.txt'), 'utf8');
const DUMPS = { sql: path.join(tmp, 'in', 'site.sql'), gz: path.join(tmp, 'in', 'site.sql.gz') };
fs.mkdirSync(path.join(tmp, 'in'));
fs.writeFileSync(DUMPS.sql, sqlText); fs.writeFileSync(DUMPS.gz, zlib.gzipSync(Buffer.from(sqlText)));
const DUMP_HASH = { sql: sha(fs.readFileSync(DUMPS.sql)), gz: sha(fs.readFileSync(DUMPS.gz)) };
let seq = 0;
const newId = () => `iss-20261105-3000${String(seq++).padStart(2, '0')}-abcde${seq}`;

(async () => {
    ok(sqlText.includes(REAL) && /INSERT INTO `wp_users`/.test(sqlText), `control: the fixture export holds the customer address ${REAL} in its users and comments rows`);
    const before = labelled();
    for (const kind of ['sql', 'gz']) {
        group(`a sandbox built from the fixture export (.${kind === 'gz' ? 'sql.gz' : 'sql'})`);
        const obs = {};
        const hooks = {
            beforeImport: ({ project, composeFile }) => { obs.atImport = webState(project); obs.copyBefore = fs.existsSync(path.join(path.dirname(composeFile), 'db', 'dump.sql')); obs.tImport = Date.now(); },
            afterImport: ({ project, composeFile }) => { obs.afterImport = webState(project); obs.copyAfter = fs.existsSync(path.join(path.dirname(composeFile), 'db', 'dump.sql')); obs.tImportEnd = Date.now(); },
            beforeWebStart: ({ project, wp, prefix }) => {
                obs.beforeStart = webState(project);
                const mails = wp.sql(`SELECT user_email FROM \`${prefix}users\` UNION ALL SELECT comment_author_email FROM \`${prefix}comments\``);
                obs.mails = mails.ok ? mails.stdout.split('\n').slice(1).filter(Boolean) : null;
                const marker = wp.sql(`SELECT COUNT(*) FROM \`${prefix}posts\` WHERE post_content LIKE '%PG-FIXTURE-MARKER-6A%'`);
                obs.markerRows = marker.ok ? Number(marker.stdout.split('\n')[1]) : null;
                obs.tBeforeStart = Date.now();
            }
        };
        const h = sandbox.create(newId(), { root: SITE, sandboxesRoot: SB, dump: DUMPS[kind], hooks });
        try {
            ok(obs.atImport && obs.atImport.running === false && obs.copyBefore, `when the import began the web container was NOT running (docker inspect: Running=${obs.atImport && obs.atImport.running}) and the temporary copy was in place`);
            ok(obs.afterImport && obs.afterImport.running === false && obs.copyAfter === false, 'right after the import: still not running, and the temporary dump copy was already deleted');
            ok(obs.beforeStart && obs.beforeStart.running === false && obs.markerRows === 1, `after the anonymisation, before the second start: not running, and the imported rows are there (marker post found ${obs.markerRows} time(s))`);
            ok(Array.isArray(obs.mails) && obs.mails.length >= 2 && !obs.mails.includes(REAL) && obs.mails.every(m => /@example\.invalid$/.test(m)), `no real e-mail address was in the database when the web container was started (${obs.mails ? obs.mails.length : 0} addresses in users and comments, all @example.invalid)`);
            const ws = webState(h.project);
            ok(ws.running && ws.startedAt >= obs.tImportEnd - 1000 && ws.startedAt >= obs.tBeforeStart - 1000, `the web container's current start (StartedAt ${new Date(ws.startedAt).toISOString()}) is AFTER the import ended (${new Date(obs.tImportEnd).toISOString()}) and after the anonymisation`);
            ok(/^http:\/\/127\.0\.0\.1:\d+$/.test(h.url) && fs.readFileSync(path.join(h.dir, 'logs', 'url.txt'), 'utf8') === h.url, `the address after the restart is on 127.0.0.1 (${h.url}) and url.txt holds it`);
            const ports = JSON.parse(dk(['inspect', ws.id]).stdout)[0].HostConfig.PortBindings || {};
            ok(Object.values(ports).flat().every(b => b.HostIp === '127.0.0.1'), 'the restarted web container publishes its port on 127.0.0.1 only');
            const page = await get(`${h.url}/?p=4`);
            ok(page.status === 200 && page.body.includes('PG-FIXTURE-MARKER-6A'), `a page loads on 127.0.0.1 and shows the marker text from the imported post (HTTP ${page.status}${page.error ? ' ' + page.error : ''})`);
            const opt = n => { const r = h.wp.run(['option', 'get', n]); return r.ok ? r.stdout.trim() : `(error: ${r.stderr.trim()})`; };
            ok(opt('siteurl') === h.url && opt('home') === h.url, `siteurl (was ${OLD}/wp) and home (was ${OLD}) are both ${h.url}`);
            const ser = h.wp.sql("SELECT option_value FROM `wp_options` WHERE option_name = 'pg_fixture_settings'");
            const v = ser.ok ? ser.stdout.split('\n')[1] : '';
            const s = str => `s:${Buffer.byteLength(str)}:"${str}"`;
            ok(v.includes(s(`${h.url}/wp-content/uploads/logo.png`)) && v.includes(s(h.url)) && !v.includes('shop.example.com'), `the serialised option was rewritten with correct lengths (${v.slice(0, 120)})`);
            ok(/127\.0\.0\.1/.test(opt('pg_fixture_settings')), 'and WordPress still reads it as a value (not a broken serialised string)');
            ok(opt('blog_public') === '0', 'blog_public is 0');
            const after = h.wp.sql('SELECT user_email FROM `wp_users` UNION ALL SELECT comment_author_email FROM `wp_comments`');
            ok(after.ok && !after.stdout.includes(REAL), 'the customer address of the fixture is in no user or comment row');
            ok(['dump', 'web-stopped', 'database', 'anonymise', 'web-started', 'address', 'page'].every(id => h.steps.some(x => x.id === id && x.status === 'PASSED')), `steps: ${h.steps.map(x => `${x.id}=${x.status}`).join(', ')}`);
        } finally { h.destroy(); }
        ok(labelled() === before && !fs.existsSync(h.dir), 'after destroy no labelled container, volume (the database) or network is left, and the folder is gone');
        ok(sha(fs.readFileSync(DUMPS[kind])) === DUMP_HASH[kind], 'the original database file is unchanged');
    }
    ok(hashTree(SITE) === SITE_HASH, 'the original site tree is byte-for-byte unchanged');
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(failures ? `\n${failures} FAILED` : '\nAll checks passed');
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); try { sandbox.sweep({}); } catch { /* ignore */ } process.exit(1); });
