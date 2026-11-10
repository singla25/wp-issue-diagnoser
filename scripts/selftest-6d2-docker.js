#!/usr/bin/env node
// Self-test of TEST-COPY-SPEC 6d-2 (the fidelity check) against a REAL Docker daemon: issue/sandbox-phase.js builds the test copy from a database file
// (scripts/fixtures/issue/dump/wp-site.sql.txt with a synthetic active_plugins list written at test time), the sandbox probe loads its front page and
// the copy's own debug log is compared with the fatal the report calls the cause. The site, its plugin and its made-up class are generated here:
// a plugin whose file calls \Zq\Made\UpClass21::go() on a class that does not exist, so the copy shows a real fatal of its own.
// It SKIPS LOUDLY (exit 0, a SKIP line saying nothing was verified) when Docker is not usable or the pinned images are missing
// (`npm run guard:setup-sandbox`). Nothing is pulled.
//   - both sides fail the same way (HTTP 500 on /, the same class in the same file)        -> matched, reproduced_in_sandbox "yes", the copy log "verified"
//   - the copy lacks the break (its plugin file does not call the class), the site failed  -> did-not-match, reproduced_in_sandbox null (never "no")
//   - HTTP 500 on / on both sides and no log on the real site                              -> status-only (counts, weaker)

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const sandbox = require('../issue/sandbox');

const pf = sandbox.preflight({});
if (!pf.ok) { console.log(`SKIP  selftest-6d2-docker was NOT run: it needs a usable Docker daemon and the pinned sandbox images.\n  reason: ${pf.reason}\n  Nothing in this suite is claimed as verified in this environment.`); process.exit(0); }
const br = (() => { try { return require('../issue/probe').browserReady ? require('../issue/probe').browserReady() : { ok: true }; } catch (e) { return { ok: false, reason: e.message }; } })();
if (br && br.ok === false) { console.log(`SKIP  selftest-6d2-docker was NOT run: the sandbox probe needs Chromium (npm run setup:frontend).\n  reason: ${br.reason}\n  Nothing in this suite is claimed as verified in this environment.`); process.exit(0); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-6d2-dk-'));
process.env.PLUGIN_GUARD_ISSUES = path.join(tmp, 'issues');
fs.mkdirSync(process.env.PLUGIN_GUARD_ISSUES, { mode: 0o700 });
const store = require('../lib/issue-store');
const phase = require('../issue/sandbox-phase');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const group = t => console.log(`\n== ${t}`);
const write = (root, rel, body) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); return f; };
function hashTree(dir) { const h = crypto.createHash('sha256'); (function walk(d) { for (const n of fs.readdirSync(d).sort()) { const f = path.join(d, n), st = fs.lstatSync(f); h.update(`${path.relative(dir, f)}|${st.isSymbolicLink() ? 'l' : st.isDirectory() ? 'd' : 'f'}|${st.mode}|`); if (st.isDirectory()) walk(f); else if (st.isFile()) h.update(fs.readFileSync(f)); } })(dir); return h.digest('hex'); }
const labelled = () => { const l = sandbox.labelled({ dockerBin: 'docker', runner: spawnSync, env: process.env }); return l.containers.length + l.volumes.length + l.networks.length; };
const ser = list => `a:${list.length}:{${list.map((s, i) => `i:${i};s:${Buffer.byteLength(s)}:"${s}";`).join('')}}`;
const rd = (dir, f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'work', f), 'utf8')); } catch { return null; } };

const CLASS = 'Zq\\Made\\UpClass21';
const PLUGIN = 'wp-content/plugins/zq-made-up/zq-made-up.php';
const SB = path.join(tmp, 'sandboxes');
const DUMP = path.join(tmp, 'in', 'site.sql');
const sqlText = fs.readFileSync(path.join(__dirname, 'fixtures', 'issue', 'dump', 'wp-site.sql.txt'), 'utf8');
fs.mkdirSync(path.dirname(DUMP)); fs.writeFileSync(DUMP, sqlText.replace("'active_plugins','a:0:{}'", `'active_plugins','${ser(['zq-made-up/zq-made-up.php']).replace(/"/g, '\\"')}'`));

// a made-up site: the plugin (broken or not), a tiny theme of the name the database uses, and (optionally) the real site's log with the fatal twice
function site(name, { broken = true, log = true } = {}) {
    const root = path.join(tmp, name, 'wp');
    write(root, 'wp-includes/version.php', "<?php\n$wp_version = '6.8.1';\n"); write(root, 'wp-config.php', '<?php\n');
    write(root, PLUGIN, `<?php\n/* Plugin Name: Zq Made Up */\n${broken ? `add_action( 'template_redirect', function () { \\${CLASS}::go(); } );` : "add_action( 'template_redirect', function () { return; } );"}\n`);
    write(root, 'wp-content/themes/twentytwentyfive/style.css', '/*\nTheme Name: Twenty Twenty-Five\nVersion: 1.0\n*/');
    write(root, 'wp-content/themes/twentytwentyfive/index.php', "<?php\necho '<!doctype html><html><body><p>PG6D2 page body</p></body></html>';\n");
    if (log) { const one = t => `[${t} UTC] PHP Fatal error:  Uncaught Error: Class "${CLASS}" not found in ${root}/${PLUGIN}:3\nStack trace:\n#0 {main}\n  thrown in ${root}/${PLUGIN} on line 3\n`; write(root, 'wp-content/debug.log', one('06-Nov-2026 09:00:00') + one('06-Nov-2026 09:00:30')); }
    return root;
}

async function caseRun(name, siteOpts) {
    const root = site(name, siteOpts);
    const config = path.join(root, 'plugin-guard.config.json'); fs.writeFileSync(config, '{}');
    const hash = hashTree(root);   // the site as the person has it (after this test wrote its own config file)
    const iss = store.create({ title: `6d-2 ${name}`, description: 'The home page shows a critical error', symptom: 'white-screen', environment: 'local', url: 'http://127.0.0.1:9/', root, pages: ['/'] });
    const dir = store.dirOf(iss.id);
    await require('../issue/evidence').run(iss.id, { root, probeOptions: { probe: false } });
    const anz = require('../issue/analysis').run(iss.id, { root, config });
    // what the live probe saw on the real site: HTTP 500 on the front page
    fs.writeFileSync(path.join(dir, 'work', 'probe.json'), JSON.stringify({ schema: 1, pages: [{ url: 'http://127.0.0.1:9/', status: 500, viewport: { name: 'laptop' }, loaded: true }] }));
    const t0 = Date.now();
    const sb = await phase.run(iss.id, { root, options: { sandbox: true, dump: DUMP, noBisect: true, viewports: 'laptop' }, analysis: { ...anz.analysis, components: anz.analysis.components, top: anz.analysis.top }, sandboxOptions: { sandboxesRoot: SB } });
    const sbx = rd(dir, 'sandbox.json'), fd = rd(dir, 'fidelity.json'), cl = rd(dir, 'copy-log.json');
    const pages = (sbx && sbx.baseline && sbx.baseline.pages) || [];
    console.log(`      ${name}: ${Math.round((Date.now() - t0) / 1000)} s; fidelity ${fd && fd.level}${fd ? ` (${fd.reasons.join('; ')})` : ''}; steps: ${sb.steps.filter(s => s.status !== 'PASSED').map(s => `${s.id} ${s.status}: ${String(s.reason || '').slice(0, 120)}`).join(' | ') || 'all passed'}`);
    return { sb, sbx, fd, cl, pages, dir, unchanged: hashTree(root) === hash };
}

(async () => {
    const before = labelled();

    group('both sides fail the same way: HTTP 500 on /, the same made-up class in the same plugin file');
    const m = await caseRun('matched', { broken: true, log: true });
    ok(m.fd && m.fd.level === 'matched' && m.fd.page === '/' && m.fd.status_class === '5xx', `matched: ${m.fd && m.fd.reasons[0]}`);
    ok(m.fd && m.fd.copy_fatal && m.fd.copy_fatal.name === CLASS && m.fd.copy_fatal.file === 'plugins/zq-made-up/zq-made-up.php' && m.fd.real_fatal.file === m.fd.copy_fatal.file, 'the copy\'s own fatal names the class at the same file relative to wp-content (the real site\'s root and /var/www/html removed)');
    ok(m.sb.reproduced_in_sandbox === 'yes' && m.sbx.reproduced_in_sandbox === 'yes', 'reproduced_in_sandbox "yes"');
    ok(m.cl && m.cl.label === 'verified' && !JSON.stringify(m.cl).includes('/var/www/html'), 'work/copy-log.json is "verified", paths relative');
    ok(m.unchanged, 'the original site tree is unchanged');

    group('the copy lacks the break: the site failed, the copy loads');
    const d = await caseRun('mismatch', { broken: false, log: true });
    ok(d.fd && d.fd.level === 'did-not-match' && d.fd.likely_reasons.length === 4, `did-not-match: ${d.fd && d.fd.reasons[0]}`);
    ok(d.sb.reproduced_in_sandbox === null && d.sbx.reproduced_in_sandbox === null && d.sbx.baseline, 'reproduced_in_sandbox null, never "no" (the baseline is kept as data)');
    ok(d.cl && d.cl.label === 'unverified', 'the copy log stays "unverified"');
    ok(d.unchanged, 'the original site tree is unchanged');

    group('HTTP 500 on / on both sides, and no log on the real site');
    const s = await caseRun('status-only', { broken: true, log: false });
    ok(s.fd && s.fd.level === 'status-only' && s.fd.status_class === '5xx' && s.fd.counts === true, `status-only: ${s.fd && s.fd.reasons[0]}`);
    ok(s.sb.reproduced_in_sandbox !== null, `it counts: reproduced_in_sandbox "${s.sb.reproduced_in_sandbox}"`);

    ok(labelled() === before && (!fs.existsSync(SB) || fs.readdirSync(SB).length === 0), 'after the three runs no labelled container, volume or network is left, and no sandbox folder');
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(failures ? `\n${failures} FAILED` : '\nAll checks passed');
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); try { sandbox.sweep({}); } catch { /* ignore */ } process.exit(1); });
