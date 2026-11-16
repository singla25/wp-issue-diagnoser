#!/usr/bin/env node
// SECOND-SITE tests for generality, on REAL containers. The same four cases and the SAME assertions as scripts/selftest-second-site.js (loaded
// from there, written before the first run; see that file's header for the MUST / NEVER list, the database-constant facts and what stays
// untested), but the test copy is a real Docker sandbox built by the plain wizard (`plugin-guard ... --sandbox --yes`, no database file: a
// fresh WordPress install with the plugins of the copy switched on), and the bisection loads real pages in it.
// Added 2026-11-12 (owner): cases 5 (a theme fatal) and 6 (a missing dependency, unguarded and guarded), and the fourth report state ("Tested on a
// test site built from your files") checked on every run here, since each builds its copy from the files only.
// The "real site" of the live check is a tiny HTTP server on 127.0.0.1 in this process (never a real site).
// It SKIPS LOUDLY (exit 0, a SKIP line saying nothing was verified) when Docker is not usable, the pinned images are missing
// (`npm run guard:setup-sandbox`) or the browser is missing. Nothing is pulled. It must leave no labelled container, volume or network and
// no new Docker volume behind.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { PassThrough } = require('stream');
const sandbox = require('../issue/sandbox');

const pf = sandbox.preflight({});
if (!pf.ok) { console.log(`SKIP  selftest-second-site-docker was NOT run: it needs a usable Docker daemon and the pinned sandbox images.\n  reason: ${pf.reason}\n  Nothing in this suite is claimed as verified in this environment.`); process.exit(0); }
const br = (() => { try { return require('../issue/probe').browserReady(); } catch (e) { return { ok: false, reason: e.message }; } })();
if (br && br.ok === false) { console.log(`SKIP  selftest-second-site-docker was NOT run: the sandbox probe needs Chromium (npm run setup-browser).\n  reason: ${br.reason}\n  Nothing in this suite is claimed as verified in this environment.`); process.exit(0); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-2site-dk-'));
process.env.PLUGIN_GUARD_ISSUES = path.join(tmp, 'issues'); fs.mkdirSync(process.env.PLUGIN_GUARD_ISSUES, { mode: 0o700 });
process.env.PLUGIN_GUARD_SANDBOXES = path.join(tmp, 'sandboxes');
Object.assign(process.env, { PG_PROBE_COOLDOWN_FILE: path.join(tmp, 'probe-cooldown.json'), PG_PROBE_NAV_DELAY_MS: '0', PG_PROBE_REQUEST_DELAY_MS: '0', PG_PROBE_5XX_RETRY_DELAY_MS: '0' });
const sites = require('./fixtures/second-site/sites');
const checks = require('./selftest-second-site');
const wizard = require('../lib/wizard'), store = require('../lib/issue-store');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; return c; };
const group = t => console.log(`\n== ${t}`);
const hashTree = dir => { const h = crypto.createHash('sha256'); (function walk(d) { for (const n of fs.readdirSync(d).sort()) { const f = path.join(d, n), st = fs.lstatSync(f); h.update(`${path.relative(dir, f)}|${st.isSymbolicLink() ? 'l' : st.isDirectory() ? 'd' : 'f'}|${st.mode}|${st.mtimeMs}|`); if (st.isDirectory()) walk(f); else if (st.isFile()) h.update(fs.readFileSync(f)); } })(dir); return h.digest('hex'); };
const labelled = () => { const l = sandbox.labelled({ dockerBin: 'docker', runner: spawnSync, env: process.env }); return l.containers.length + l.volumes.length + l.networks.length; };
const volumes = () => { const r = spawnSync('docker', ['volume', 'ls', '-q'], { encoding: 'utf8' }); return r.status === 0 ? r.stdout.split('\n').filter(Boolean).sort() : null; };

const servers = [];
async function serve(kind) {
    const hits = [];
    const page = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(`<!doctype html><html><head><title>${sites.SHOP}</title></head><body>${body}</body></html>`); };
    const server = http.createServer((req, res) => {
        const p = req.url.split('?')[0]; hits.push({ method: req.method, path: p });
        if (kind === 'loop' && p === '/') { res.writeHead(302, { Location: `http://127.0.0.1:${server.address().port}/` }); return res.end(); }
        if (kind === 'db') return page(res, 500, '<h1>Error establishing a database connection</h1>');
        if (kind === 'crit') return page(res, 500, '<p>There has been a critical error on this website.</p>');
        return page(res, 200, `<h1>${sites.SHOP}</h1><p>Loose leaf teas, packed by hand.</p>`);
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r)); servers.push(server);
    return { url: `http://127.0.0.1:${server.address().port}/`, hits };
}

async function run(name, builder, { live = null } = {}) {
    const root = path.join(tmp, name, 'wp'), info = builder(root), before = hashTree(root);
    const out = path.join(tmp, `out-${name}`);
    const input = new PassThrough(), output = new PassThrough(); let text = ''; output.on('data', d => { text += d; }); input.end('');
    const saved = process.env.PLUGIN_GUARD_ISSUES, log = console.log; console.log = (...a) => { text += a.join(' ') + '\n'; };
    const t0 = Date.now();
    let error = null;
    try { await wizard.run({ _: [], description: info.description, root, out, yes: true, sandbox: true, viewports: 'laptop', ...(live ? { url: live.url, env: 'local' } : { 'no-probe': true }) }, { input, output, tty: false, cwd: tmp, env: { HOME: tmp }, siteRoots: [] }); }
    catch (e) { error = e; } finally { console.log = log; if (saved === undefined) delete process.env.PLUGIN_GUARD_ISSUES; else process.env.PLUGIN_GUARD_ISSUES = saved; }
    const ids = fs.existsSync(out) ? fs.readdirSync(out).filter(x => store.ISSUE_RE.test(x)) : [];
    const idir = ids.length ? path.join(out, ids[0]) : null;
    const rd = rel => { try { return JSON.parse(fs.readFileSync(path.join(idir, rel), 'utf8')); } catch { return null; } };
    const rt = rel => { try { return fs.readFileSync(path.join(idir, rel), 'utf8'); } catch { return ''; } };
    const R = { info, root, idir, error, text, f: rd('result/findings.json'), md: rt('result/ISSUE-REPORT.md'), html: rt('result/issue.html'), bis: rd('work/bisect.json'), sbx: rd('work/sandbox.json'), probe: rd('work/probe.json') };
    const notPassed = ((R.sbx && R.sbx.steps) || []).filter(s => s.status !== 'PASSED').map(s => `${s.id} ${s.status}: ${String(s.reason || '').slice(0, 110)}`);
    console.log(`      ${name}: ${Math.round((Date.now() - t0) / 1000)} s; reproduced_in_sandbox ${R.sbx ? JSON.stringify(R.sbx.reproduced_in_sandbox) : 'none'}; bisect ${R.bis ? `${R.bis.status} ${JSON.stringify(R.bis.causes.map(c => c.plugins))}, ${R.bis.loads} loads` : 'none'}; verdict "${R.f && R.f.verdict && R.f.verdict.label}"${notPassed.length ? `; steps: ${notPassed.join(' | ')}` : ''}`);
    ok(!error && !!R.f, `${name}: the wizard made its own copy, built a real test copy and wrote the report${error ? ` (${error.message})` : ''}`);
    ok(!!(R.sbx && R.sbx.sandbox), `${name}: a real test copy was built (sandbox.json has the sandbox)`);
    ok(hashTree(root) === before, `${name}: the original site folder is unchanged (files, modes, times)`);
    if (live) ok(live.hits.length > 0 && live.hits.every(h => h.method === 'GET'), `${name}: the live check reached the 127.0.0.1 stand-in with GET requests only (${live.hits.length})`);
    ok(labelled() === 0, `${name}: no labelled container, volume or network is left`);
    return R;
}

(async () => {
    const before = labelled(), vols = volumes();
    ok(before === 0, `before: no labelled Plugin Guard container, volume or network (${before})`);

    group('1. plugin pair on real containers');
    const P = await run('pair', sites.pluginPair);
    ok(P.bis !== null, `pair: a bisection ran on the real copy (${P.bis ? P.bis.status : 'no bisect.json'})`);
    checks.pairChecks(P, ok, { info: P.info, label: 'pair, real test copy', bisectRan: true });
    checks.filesOnlyLevel(P, ok, { label: 'pair, real test copy', expect: 'yes' });

    group('2. healthy site on real containers');
    const H = await run('healthy', sites.healthy, { live: await serve('ok') });
    checks.healthyChecks(H, ok, { label: 'healthy, live check and real test copy', probeRan: true });
    checks.filesOnlyLevel(H, ok, { label: 'healthy, real test copy', expect: 'no' });

    group('3. redirect loop made by a plugin, on real containers');
    const D3 = await run('redirect', sites.pluginRedirect, { live: await serve('loop') });
    ok(D3.bis !== null, `redirect: a bisection ran on the real copy (${D3.bis ? `${D3.bis.status} ${JSON.stringify(D3.bis.causes.map(c => c.plugins))}` : 'no bisect.json'})`);
    checks.redirectChecks(D3, ok, { info: D3.info, label: 'redirect, live check and real test copy' });
    checks.filesOnlyLevel(D3, ok, { label: 'redirect, real test copy', expect: 'yes' });

    group('4. database error on real containers (the copy gets its own fresh wp-config.php, so it cannot show the wrong credentials)');
    const D4 = await run('db', sites.dbError, { live: await serve('db') });
    checks.dbChecks(D4, ok, { info: D4.info, label: 'db, live check and real test copy' });
    // CHANGED 2026-11-12 (owner decision: the database case keeps the old rule; old text in HANDOFF row 62)
    ok(D4.f && D4.f.case_file && D4.f.case_file.level && D4.f.case_file.level.n === 2 && D4.f.case_file.level.heading === 'Not tested on a copy', `db, real test copy: level 2 "Not tested on a copy", not the fourth state (${D4.f && D4.f.case_file && D4.f.case_file.level ? D4.f.case_file.level.heading : 'no level'})`);

    group('5. a fatal error in the active theme, on real containers');
    const T5 = await run('theme', sites.themeFatal, { live: await serve('crit') });
    ok(T5.bis !== null, `theme: a bisection ran on the real copy (${T5.bis ? `${T5.bis.status}, theme ${JSON.stringify(T5.bis.theme)}` : 'no bisect.json'})`);
    checks.themeChecks(T5, ok, { info: T5.info, label: 'theme, live check and real test copy', bisectRan: true });
    checks.filesOnlyLevel(T5, ok, { label: 'theme, real test copy', expect: 'yes' });

    group('6. a missing dependency on real containers: unguarded and guarded');
    const Da = await run('dep-unguarded', root => sites.missingDep(root, { guarded: false }), { live: await serve('crit') });
    checks.depChecks(Da, ok, { info: Da.info, label: 'dependency, unguarded, real test copy' });
    checks.filesOnlyLevel(Da, ok, { label: 'dependency, unguarded, real test copy', expect: 'yes' });
    const Db = await run('dep-guarded', root => sites.missingDep(root, { guarded: true }), { live: await serve('ok') });
    checks.depChecks(Db, ok, { info: Db.info, label: 'dependency, guarded, real test copy' });
    checks.filesOnlyLevel(Db, ok, { label: 'dependency, guarded, real test copy', expect: 'no' });

    group('nothing left behind');
    const after = volumes();
    ok(labelled() === 0, 'no labelled container, volume or network is left after the four runs');
    ok(vols !== null && after !== null && after.length === vols.length && after.every((v, i) => v === vols[i]), `no new Docker volume (${vols ? vols.length : '?'} before, ${after ? after.length : '?'} after)`);
    ok(!fs.existsSync(process.env.PLUGIN_GUARD_SANDBOXES) || fs.readdirSync(process.env.PLUGIN_GUARD_SANDBOXES).length === 0, 'no sandbox folder is left');
    for (const s of servers) s.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); try { sandbox.sweep({}); } catch { /* ignore */ } process.exit(1); });
