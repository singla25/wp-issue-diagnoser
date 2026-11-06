#!/usr/bin/env node
// Self-test of TEST-COPY-SPEC 6d-1, against the fake `docker` (scripts/fixtures/issue/fake-docker.js). No daemon, no network.
//   - the active_plugins option parser (lib/version-detect.js): valid, nested, hostile, huge, truncated, non-string entries
//   - the comparison with the plugins in the copy (issue/version-match.js activePlugins): source labels, missing files, Site Health fallback, unknown
//   - a build from a database file reads the option right after the import (web container stopped, before the anonymisation) and NEVER runs
//     `wp plugin activate`; the baseline is the database's own active set; work/active-plugins.json and findings.json sandbox.summary.active_plugins
//   - a build without a database file is unchanged (golden spec equal, the plugins of the copy are activated as before, no new file)
//   - the copy's own debug log: last 2 MB, redacted, fatal lines with paths relative to wp-content, labelled 'unverified' (work/copy-log.json)
//   - adding the copy log changes no status or verdict field of findings.json (with and without)
// The real-container proof (password search over every file and log) is selftest-6d1-docker.js.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-6d1-'));
process.env.PLUGIN_GUARD_ISSUES = path.join(tmp, 'issues');
fs.mkdirSync(process.env.PLUGIN_GUARD_ISSUES, { mode: 0o700 });
const sandbox = require('../issue/sandbox');
const policy = require('../issue/sandbox-policy');
const phase = require('../issue/sandbox-phase');
const vd = require('../lib/version-detect');
const vm = require('../issue/version-match');
const store = require('../lib/issue-store');
const caseFile = require('../issue/case-file');
const resultMod = require('../issue/result');
const probe = require('../issue/probe');
const trees = require('./fixtures/issue/trees');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const group = t => console.log(`\n== ${t}`);
const write = (root, rel, body) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); return f; };
const ser = list => `a:${list.length}:{${list.map((s, i) => `i:${i};s:${Buffer.byteLength(s)}:"${s}";`).join('')}}`;
const hex = s => Buffer.from(s, 'utf8').toString('hex').toUpperCase();
const MISSING = vm.MISSING_FILES_NOTE;

const SQL = write(tmp, 'in/site.sql', fs.readFileSync(path.join(__dirname, 'fixtures', 'issue', 'dump', 'tiny.sql.txt')));
const TABLES = 'Tables_in_wordpress\npgf_options\npgf_users\npgf_usermeta\npgf_posts\npgf_postmeta\npgf_comments\n';
const base = (extra = []) => [...extra,
    { match: 'db query', stdin: 'SHOW TABLES', out: TABLES }, { match: 'db query', stdin: "option_name = 'siteurl'", out: 'option_value\nhttps://shop.example.com\n' }, { match: 'db query', stdin: "option_name = 'home'", out: 'option_value\nhttps://shop.example.com\n' },
    { match: 'db query', stdin: 'AS pg_admin FROM', out: 'pg_admin\n1\n' }, { match: 'db query', stdin: 'AS pg_admins FROM', out: 'pg_admins\n1\n' }];
const activeRule = value => ({ match: 'db query', stdin: 'AS pg_active FROM', out: value === null ? 'pg_active\n' : `pg_active\n${hex(value)}\n` });

function fakeEnv(name, fake = {}) {
    const dir = path.join(tmp, 'fake-' + name); fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(path.join(__dirname, 'fixtures', 'issue', 'fake-docker.js'), path.join(dir, 'docker')); fs.chmodSync(path.join(dir, 'docker'), 0o755);
    const sbx = path.join(tmp, 'sbx-' + name); fs.mkdirSync(sbx, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, 'fake.json'), JSON.stringify(fake));
    return {
        dir, sandboxesRoot: sbx,
        log: () => (fs.existsSync(path.join(dir, 'fake.log')) ? fs.readFileSync(path.join(dir, 'fake.log'), 'utf8').split('\n').filter(Boolean).map(JSON.parse) : []),
        state: () => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'fake.state.json'), 'utf8')); } catch { return { containers: [], volumes: [], networks: [] }; } },
        base: (extra = {}) => ({ dockerBin: path.join(dir, 'docker'), sandboxesRoot: sbx, env: { PATH: process.env.PATH, HOME: process.env.HOME }, pageCheck: () => ({ status: 200 }), ...extra })
    };
}
const wpArgs = l => { const at = l.args.indexOf('wp'); return at < 0 ? '' : l.args.slice(at + 1).filter(a => !a.startsWith('--path=')).join(' '); };
const activations = F => F.log().filter(l => /^plugin activate\b/.test(wpArgs(l)));
const leftovers = F => { const s = F.state(); return s.containers.length + s.volumes.length + s.networks.length; };
// a site with three plugins (two in folders, one single file) and one theme
function site(name) {
    const root = path.join(tmp, name, 'wp');
    write(root, 'wp-config.php', "<?php define('DB_NAME','x');");
    write(root, 'wp-content/plugins/alpha/alpha.php', "<?php\n/* Plugin Name: Alpha */\n");
    write(root, 'wp-content/plugins/beta/beta.php', "<?php\n/**\n * Plugin Name: Beta Tools\n */\n");
    write(root, 'wp-content/plugins/solo.php', "<?php\n/* Plugin Name: Solo */\n");
    write(root, 'wp-content/plugins/nohead/nohead.php', '<?php // no header\n');
    write(root, 'wp-content/themes/acme/style.css', '/* Theme Name: Acme */');
    return root;
}

(async () => {
    // ================================================================ the parser
    group('the active_plugins option parser: only an array of strings; anything else is "unknown"');
    const P = v => vd.parseActivePluginsOption(Buffer.isBuffer(v) ? v : Buffer.from(v, 'utf8'));
    let r = P(ser(['akismet/akismet.php', 'hello.php', 'woocommerce/woocommerce.php']));
    ok(r.ok && JSON.stringify(r.plugins) === JSON.stringify(['akismet/akismet.php', 'hello.php', 'woocommerce/woocommerce.php']) && r.invalid === 0, `a valid list is read, sorted: ${JSON.stringify(r.plugins)}`);
    r = P('a:0:{}'); ok(r.ok && r.plugins.length === 0, 'an empty array is a valid list with no active plugin');
    r = P('a:2:{i:3;s:11:"a/alpha.php";i:7;s:11:"a/alpha.php";}'); ok(r.ok && r.plugins.length === 1, 'any integer keys; a duplicate is kept once');
    r = P('a:1:{s:1:"x";s:11:"a/alpha.php";}'); ok(r.ok && r.plugins[0] === 'a/alpha.php', 'string keys are accepted (values must be strings)');
    r = P('a:2:{i:0;s:11:"a/alpha.php";i:1;a:1:{i:0;s:9:"hello.php";}}'); ok(!r.ok && r.plugins.length === 0 && /not a string/.test(r.reason), `nested array -> not read (${r.reason})`);
    for (const [what, v] of [['an integer entry', 'a:1:{i:0;i:5;}'], ['a boolean entry', 'a:1:{i:0;b:1;}'], ['a null entry', 'a:1:{i:0;N;}'], ['an object', 'O:8:"stdClass":1:{s:1:"a";s:9:"hello.php";}'], ['an object entry', 'a:1:{i:0;O:8:"stdClass":0:{}}'], ['a float key', 'a:1:{d:0.5;s:9:"hello.php";}']])
        ok(!P(v).ok && P(v).plugins.length === 0, `${what} -> not read`);
    for (const [what, v] of [['truncated in a string', 'a:2:{i:0;s:11:"a/alpha.php";i:1;s:9:"hel'], ['truncated before the end', 'a:1:{i:0;s:11:"a/alpha.php";'], ['a wrong length', 'a:1:{i:0;s:12:"a/alpha.php";}'], ['too few entries', 'a:3:{i:0;s:11:"a/alpha.php";}'], ['trailing bytes', 'a:1:{i:0;s:11:"a/alpha.php";}x'], ['two arrays', 'a:0:{}a:0:{}'], ['not serialized', 'akismet/akismet.php'], ['empty', ''], ['JSON', '["a/alpha.php"]']])
        ok(!P(v).ok, `${what} -> not read`);
    const many = Array.from({ length: 2001 }, (_, i) => `p${i}/p${i}.php`);
    ok(!P(ser(many)).ok && /more than 2000/.test(P(ser(many)).reason), 'more than 2000 entries -> not read (capped, never cut silently)');
    ok(P(ser(many.slice(0, 2000))).ok && P(ser(many.slice(0, 2000))).plugins.length === 2000, 'exactly 2000 entries are read');
    ok(!P(Buffer.alloc(vd.ACTIVE_MAX_BYTES + 1, 0x61)).ok, 'a value over 1 MB -> not read');
    ok(!P('a:9999999:{').ok, 'a huge declared count with no data -> not read');
    r = P(ser(['../../etc/passwd.php', 'a/../b.php', '/abs/x.php', 'x/y/z.php', 'a b/c.php', '<b>/x.php', 'ok/ok.php', 'no-ext', '.hidden/x.php', 'é/x.php']));
    ok(r.ok && JSON.stringify(r.plugins) === '["ok/ok.php"]' && r.invalid === 9, `names not shaped like "slug/file.php" are dropped and counted (${r.invalid} dropped)`);
    ok(!vd.isPluginPath('..') && !vd.isPluginPath('a/..php') && vd.isPluginPath('Hello.php') && vd.isPluginPath('my.plugin/main.php'), 'isPluginPath: traversal refused, ordinary names accepted');

    // ================================================================ the comparison
    group('the comparison with the copy: source labels, missing files, plugins present but not active');
    const S = site('cmp'), PD = path.join(S, 'wp-content', 'plugins');
    ok(JSON.stringify(vm.copyPlugins(PD)) === JSON.stringify([{ path: 'alpha/alpha.php', name: 'Alpha' }, { path: 'beta/beta.php', name: 'Beta Tools' }, { path: 'solo.php', name: 'Solo' }]), `plugins of the copy (header only; a file without "Plugin Name" is not a plugin): ${JSON.stringify(vm.copyPlugins(PD).map(p => p.path))}`);
    let a = vm.activePlugins({ db: P(ser(['alpha/alpha.php', 'gone/gone.php', 'solo.php'])), pluginsDir: PD });
    ok(a.source === 'from the database' && a.active_count === 3 && JSON.stringify(a.missing_files) === '["gone/gone.php"]' && a.not_active_present === 1, `from the database: 3 active, missing ["gone/gone.php"], 1 present but not active (${JSON.stringify(a)})`);
    a = vm.activePlugins({ db: P('a:1:{i:0;a:0:{}}'), siteHealth: [{ name: 'Alpha', version: '1.0' }, { name: 'Missing One', version: '2.0' }], pluginsDir: PD });
    ok(a.source === 'from Site Health' && JSON.stringify(a.active) === '["Alpha","Missing One"]' && JSON.stringify(a.missing_files) === '["Missing One"]' && a.not_active_present === 2 && /could not be read/.test(a.unknown_reason), 'unreadable option + Site Health list -> "from Site Health", names compared with the plugin headers');
    a = vm.activePlugins({ db: null, dbWhy: 'the database has no active_plugins value', siteHealth: [{ name: 'alpha' }], pluginsDir: PD });
    ok(a.source === 'from Site Health' && a.missing_files.length === 0, 'absent option + Site Health -> from Site Health (names compared without case)');
    a = vm.activePlugins({ db: null, dbWhy: 'the database has no active_plugins value', siteHealth: [], pluginsDir: PD });
    ok(a.source === 'unknown' && a.active.length === 0 && a.active_count === null && a.not_active_present === null && /no Site Health list/.test(a.unknown_reason), `nothing known -> "unknown", and it says so: "${a.unknown_reason}"`);
    a = vm.activePlugins({ db: P('a:0:{}'), siteHealth: [{ name: 'Alpha' }], pluginsDir: PD });
    ok(a.source === 'from the database' && a.active_count === 0 && a.not_active_present === 3, 'an empty list in the database wins over Site Health (the database is the better source)');
    ok(caseFile.activePluginLines(resultMod.cleanActivePlugins({ schema: 1, source: 'from the database', active: ['a/a.php'], missing_files: ['a/a.php'], not_active_present: 0 }))[0] === MISSING && caseFile.activePluginLines(resultMod.cleanActivePlugins({ schema: 1, source: 'from the database', active: ['a/a.php'], missing_files: [], not_active_present: 0 })).length === 0, 'the developer sentence appears only when an active plugin has no file in the copy');
    {   // the names after the sentence: folder names, at most 20 then "and N more", escaped in the Markdown report
        const L1 = caseFile.activePluginLines(resultMod.cleanActivePlugins({ schema: 1, source: 'from the database', active: ['gone/gone.php', 'hello.php', 'gone/other.php'], missing_files: ['gone/gone.php', 'hello.php', 'gone/other.php'], not_active_present: 0 }));
        ok(L1.length === 2 && L1[0] === MISSING && L1[1] === 'Active plugins with no files in the copy: gone, hello.php.', `folder names after the sentence (a folder once): "${L1[1]}"`);
        const many = Array.from({ length: 25 }, (_, i) => `p${String(i).padStart(2, '0')}/x.php`);
        const L2 = caseFile.activePluginLines(resultMod.cleanActivePlugins({ schema: 1, source: 'from the database', active: many, missing_files: many, not_active_present: 0 }));
        ok(L2[1] === `Active plugins with no files in the copy: ${many.slice(0, 20).map(p => p.split('/')[0]).join(', ')} and 5 more.` && caseFile.MISSING_SHOWN === 20, `at most 20 names, then "and 5 more": "${L2[1]}"`);
        const L3 = caseFile.activePluginLines(resultMod.cleanActivePlugins({ schema: 1, source: 'from Site Health', active: ['<script>alert(1)</script>', 'Alpha'], missing_files: ['<script>alert(1)</script>'], not_active_present: 0 }));
        const md = caseFile.markdownDeveloper({ developer: L3, excerpt: null }, t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));
        ok(L3[1] === 'Active plugins with no files in the copy: <script>alert(1)</script>.' && md.join('\n').includes('&lt;script&gt;alert(1)&lt;/script&gt;') && !md.join('\n').includes('<script>'), 'a hostile Site Health name is kept as data and escaped in the Markdown developer block');
        ok(caseFile.activePluginLines(resultMod.cleanActivePlugins({ schema: 1, source: 'from the database', active: ['a/a.php', '<b>/x.php'], missing_files: ['<b>/x.php'], not_active_present: 0 })).length === 0, 'a database name that is not plugin-shaped never reaches the block');
    }
    ok(resultMod.cleanActivePlugins({ schema: 1, source: 'from somewhere', active: [], missing_files: [] }) === null && JSON.stringify(resultMod.cleanActivePlugins({ schema: 1, source: 'from the database', active: ['a/a.php', '../x.php', '<b>.php'], missing_files: ['../x.php', 'a/a.php'], not_active_present: -1 })) === '{"source":"from the database","active":["a/a.php"],"active_count":1,"missing_files":["a/a.php"],"not_active_present":null}', 'findings.json takes only the closed source list, plugin-shaped names and whole numbers');

    // ================================================================ a database build: read, never activate
    group('a build from a database file: the option is read after the import, before the anonymisation, with the web container stopped');
    {
        const root = site('db1');
        const iss = store.create({ title: '6d-1 db', description: 'the shop page is white', symptom: 'white-screen', environment: 'local', root, pages: ['/'] });
        const F = fakeEnv('db1', { wp: base([activeRule(ser(['alpha/alpha.php', 'gone/gone.php', 'solo.php']))]) });
        const h = sandbox.create(iss.id, F.base({ root, dump: SQL }));
        const L = F.log();
        const iImp = L.findIndex(l => wpArgs(l) === 'db import -'), iAct = L.findIndex(l => /AS pg_active FROM `pgf_options` WHERE option_name = 'active_plugins'/.test(l.stdin || ''));
        const iAnon = L.findIndex(l => /user_email = CONCAT/.test(l.stdin || '')), iPay = L.findIndex(l => /woocommerce/.test(l.stdin || '')), iStart = L.findIndex(l => l.args[0] === 'compose' && l.args[5] === 'start');
        ok(iImp >= 0 && iImp < iAct && iAct < iPay && iPay < iAnon && iAnon < iStart && L[iAct].web_running === false, `order: import (${iImp}) -> active_plugins read (${iAct}) -> payments (${iPay}) -> anonymise (${iAnon}) -> start web (${iStart}); web stopped during the read`);
        ok(/SELECT HEX\(LEFT\(option_value, 1048577\)\)/.test(L[iAct].stdin) && L[iAct].args.includes('query'), 'one SELECT through wp db query (no WordPress or plugin code is loaded), bounded with LEFT()');
        ok(activations(F).length === 0 && !L.some(l => /^option (get|update) active_plugins/.test(wpArgs(l))), 'no `wp plugin activate`, and active_plugins is never written');
        const ap = h.active_plugins;
        ok(ap && ap.source === 'from the database' && JSON.stringify(ap.active) === '["alpha/alpha.php","gone/gone.php","solo.php"]' && JSON.stringify(ap.missing_files) === '["gone/gone.php"]' && ap.not_active_present === 1, `handle.active_plugins: ${JSON.stringify(ap)}`);
        const fileAp = path.join(store.dirOf(iss.id), 'work', 'active-plugins.json');
        ok(fs.existsSync(fileAp) && (fs.statSync(fileAp).mode & 0o777) === 0o600 && JSON.parse(fs.readFileSync(fileAp, 'utf8')).source === 'from the database', 'work/active-plugins.json (0600) in the issue folder');
        h.destroy(); ok(leftovers(F) === 0, 'destroy leaves nothing');
    }
    group('work/active-plugins.json cannot be written: a warning, not a failed build');
    {
        const root = site('db-nowrite');
        const iss = store.create({ title: '6d-1 nowrite', description: 'white page', symptom: 'white-screen', environment: 'local', root, pages: ['/'] });
        fs.mkdirSync(path.join(store.dirOf(iss.id), 'work', 'active-plugins.json'));   // a folder where the file should go: the write fails (EISDIR)
        const F = fakeEnv('db-nowrite', { wp: base([activeRule(ser(['alpha/alpha.php']))]) });
        let h = null, err = null; try { h = sandbox.create(iss.id, F.base({ root, dump: SQL })); } catch (e) { err = e; }
        ok(h && !err && h.active_plugins && h.active_plugins.source === 'from the database', `the build goes on and the handle still carries the list${err ? ` (error: ${err.message})` : ''}`);
        ok(h && h.warnings.some(w => /^work\/active-plugins\.json could not be written \(EISDIR\)/.test(w)) && h.steps.some(s => s.id === 'page' && s.status === 'PASSED'), `one warning names the write error: "${h && (h.warnings.find(w => /active-plugins/.test(w)) || '')}"`);
        if (h) h.destroy(); ok(leftovers(F) === 0, 'destroy leaves nothing');
    }

    group('the option is absent, unreadable or hostile: Site Health, else "unknown"; the build goes on');
    for (const [name, rule, sh, want] of [['absent', activeRule(null), null, 'unknown'], ['hostile', activeRule('a:1:{i:0;O:8:"stdClass":0:{}}'), null, 'unknown'], ['failing', { match: 'db query', stdin: 'AS pg_active FROM', status: 1, stderr: 'ERROR 1146 (42S02)\n' }, null, 'unknown'], ['garbage', { match: 'db query', stdin: 'AS pg_active FROM', out: 'pg_active\nZZ<b>\n' }, null, 'unknown'], ['site-health', activeRule(null), '### wp-active-plugins (2) ###\n\nAlpha: version: 1.0, author: A\nGone Plugin: version: 2.0, author: B\n', 'from Site Health']]) {
        const root = site('db-' + name);
        const iss = store.create({ title: '6d-1 ' + name, description: 'white page', symptom: 'white-screen', environment: 'local', root, pages: ['/'] });
        if (sh) vm.saveSiteHealth(store.dirOf(iss.id), write(tmp, `sh-${name}.txt`, sh));
        const F = fakeEnv('db-' + name, { wp: base([rule]) });
        let h = null, err = null; try { h = sandbox.create(iss.id, F.base({ root, dump: SQL })); } catch (e) { err = e; }
        ok(h && !err && h.active_plugins.source === want && activations(F).length === 0, `${name}: the build goes on, source "${h && h.active_plugins.source}"${err ? ` (error: ${err.message})` : ''}, no activation`);
        if (name === 'site-health') ok(JSON.stringify(h.active_plugins.missing_files) === '["Gone Plugin"]' && JSON.stringify(h.active_plugins.active) === '["Alpha","Gone Plugin"]', 'Site Health: names compared with the copy, "Gone Plugin" has no file');
        if (h) h.destroy();
    }

    // ================================================================ the sandbox phase + findings.json
    group('the sandbox phase with a database file: baseline = the database\'s own set, no `plugin activate`, copy log as unverified data');
    const LOG = [
        '[06-Nov-2026 10:00:00 UTC] PHP Warning:  Undefined variable $x in /var/www/html/wp-content/plugins/plugin-b/plugin-b.php on line 4',
        '[06-Nov-2026 10:00:01 UTC] PHP Fatal error:  Uncaught Error: Class "Acme\\Thing" not found in /var/www/html/wp-content/plugins/plugin-a/plugin-a.php:7',
        'Stack trace:', '#0 /var/www/html/wp-includes/class-wp-hook.php(324): my_helper()', '#1 {main}', '  thrown in /var/www/html/wp-content/plugins/plugin-a/plugin-a.php on line 7',
        '[06-Nov-2026 10:00:02 UTC] PHP Fatal error:  bad settings api_key=SuperSecretValue123 in /var/www/html/wp-content/themes/acme/functions.php on line 3',
        '[06-Nov-2026 10:00:03 UTC] PHP Fatal error:  Allowed memory size exhausted in /var/www/html/wp-includes/plugin.php on line 205', ''].join('\n');
    async function pipeline(name, { dump = true, activeOpt = ser(['plugin-a/plugin-a.php', 'gone/gone.php']), log = LOG } = {}) {
        const root = path.join(tmp, 'pipe-' + name, 'wp'); const tc = trees.duplicateFunction(root);
        fs.writeFileSync(path.join(root, 'plugin-guard.config.json'), JSON.stringify(tc.config));
        const config = path.join(root, 'plugin-guard.config.json');
        const iss = store.create({ title: 'Pipeline ' + name, description: tc.description, symptom: tc.symptom, environment: 'local', root, pages: ['/'] });
        await require('../issue/evidence').run(iss.id, { root, probeOptions: { probe: false } });
        const anz = require('../issue/analysis').run(iss.id, { root, config });
        const F = fakeEnv('pipe-' + name, { wp: base([activeRule(activeOpt), { match: 'plugin list', out: 'plugin-a\nplugin-b\n' }, { match: 'theme list', out: 'acme\ntwentytwentysix\n' }, { match: 'option get stylesheet', out: 'acme\n' }]) });
        const real = probe.runSandbox;
        probe.runSandbox = async (id, o) => { if (log) fs.appendFileSync(path.join(o.stateDir, '..', 'logs', 'debug.log'), log); return { ok: true, pages: [], status_codes: [200], oracle: { result: 'no' } }; };
        let sb; try { sb = await phase.run(iss.id, { root, options: { sandbox: true, ...(dump ? { dump: SQL } : {}) }, analysis: { ...anz.analysis, components: anz.analysis.components, top: anz.analysis.top }, sandboxOptions: F.base() }); } finally { probe.runSandbox = real; }
        const validate = require('../issue/validate'), resolve = require('../issue/resolve');
        const dir = store.dirOf(iss.id);
        const build = () => { const val = validate.run(iss.id, { root, config, lint: () => ({ ok: true, message: '' }) }), pol = validate.policyFor(root, config); resultMod.write(iss.id, { validation: val, plans: resolve.build(iss.id, val, { root, policy: pol, dir }), dir, root, policy: pol, gate: true }); return { val, f: JSON.parse(fs.readFileSync(path.join(dir, 'result', 'findings.json'), 'utf8')), md: fs.readFileSync(path.join(dir, 'result', 'ISSUE-REPORT.md'), 'utf8') }; };
        return { F, sb, dir, build, leftovers: () => leftovers(F) };
    }
    {
        const p = await pipeline('db');
        ok(activations(p.F).length === 0, 'no `wp plugin activate` in the whole sandbox phase (fake-docker log)');
        ok(p.sb.baseline && JSON.stringify(p.sb.baseline.active_plugins) === '["plugin-a"]', `the baseline is the database's own active set (plugin-a; gone/gone.php has no file; plugin-b is listed by WP-CLI but not in the database): ${JSON.stringify(p.sb.baseline && p.sb.baseline.active_plugins)}`);
        const cl = JSON.parse(fs.readFileSync(path.join(p.dir, 'work', 'copy-log.json'), 'utf8'));
        ok(cl.label === 'unverified' && cl.available === true && cl.fatal_count === 3 && (fs.statSync(path.join(p.dir, 'work', 'copy-log.json')).mode & 0o777) === 0o600, `work/copy-log.json (0600): unverified, available, ${cl.fatal_count} fatal lines (the warning is not one)`);
        const f0 = cl.last_fatals[0];
        ok(f0 && f0.file === 'plugins/plugin-a/plugin-a.php' && f0.line === 7 && f0.message === 'PHP Fatal error: Uncaught Error: Class "Acme\\Thing" not found in plugins/plugin-a/plugin-a.php:7', `paths relative to wp-content: ${JSON.stringify(f0)}`);
        ok(cl.last_fatals[1].file === 'themes/acme/functions.php' && cl.last_fatals[2].file === null && /in wp-includes\/plugin\.php on line 205/.test(cl.last_fatals[2].message), 'a theme file is relative to wp-content; a core file has no file field (it is outside wp-content) and its message keeps wp-includes/...');
        const raw = fs.readFileSync(path.join(p.dir, 'work', 'copy-log.json'), 'utf8');
        ok(!raw.includes('SuperSecretValue123') && raw.includes('api_key=[REDACTED]') && !raw.includes('/var/www/html'), 'redacted like other logs (lib/redact.js) and no absolute container path');
        ok(!JSON.stringify(p.sb).includes('Acme') && p.sb.reproduced_in_sandbox === 'no', 'the sandbox phase result (steps, reproduced_in_sandbox) does not carry the copy log');
        const A = p.build();
        const sm = A.f.sandbox && A.f.sandbox.summary;
        ok(sm && sm.active_plugins && sm.active_plugins.source === 'from the database' && JSON.stringify(sm.active_plugins.missing_files) === '["gone/gone.php"]' && sm.active_plugins.active_count === 2 && sm.active_plugins.not_active_present === 1, `findings.json sandbox.summary.active_plugins: ${JSON.stringify(sm && sm.active_plugins)}`);
        ok(A.f.sandbox.copy_log && A.f.sandbox.copy_log.label === 'unverified' && A.f.sandbox.copy_log.fatal_count === 3, 'findings.json sandbox.copy_log is labelled unverified');
        ok(A.f.case_file.developer.includes(MISSING) && A.md.includes(MISSING) && A.f.case_file.developer.includes('Active plugins with no files in the copy: gone.') && A.md.includes('Active plugins with no files in the copy: gone.'), 'the developer block (and ISSUE-REPORT.md) has the missing-files sentence, then the folder name');
        const top = JSON.stringify([A.f.case_file.status, A.f.case_file.see, A.f.case_file.cases, A.f.summary && A.f.summary.lines]);
        ok(!top.includes('Acme') && !top.includes(MISSING) && !/active_plugins|copy log/i.test(top), 'nothing of it is in the top of the report (status, what you see, cases, summary)');

        group('the copy log changes no status and no verdict (findings.json with and without it)');
        fs.rmSync(path.join(p.dir, 'work', 'copy-log.json'));
        const B = p.build();
        const strip = f => JSON.parse(JSON.stringify(f, (k, v) => (k === 'generated_at' || k === 'copy_log' ? undefined : v)));
        ok(!B.f.sandbox.copy_log && JSON.stringify(strip(A.f)) === JSON.stringify(strip(B.f)), 'findings.json is identical with and without the copy log, except the copy_log field (and the generation time)');
        ok(JSON.stringify(A.f.verdict) === JSON.stringify(B.f.verdict) && JSON.stringify(A.f.hypotheses.map(h => [h.id, h.status])) === JSON.stringify(B.f.hypotheses.map(h => [h.id, h.status])) && JSON.stringify(A.f.counts) === JSON.stringify(B.f.counts) && A.f.sandbox.reproduced_in_sandbox === B.f.sandbox.reproduced_in_sandbox, 'verdict, hypothesis statuses, counts and reproduced_in_sandbox are equal');
        ok(JSON.stringify(A.val.hypotheses.map(h => [h.id, h.status])) === JSON.stringify(B.val.hypotheses.map(h => [h.id, h.status])), 'issue/validate.js gives the same statuses');
        ok(A.md === B.md.replace(/\n/g, '\n') && A.md.replace(/generated[^\n]*/gi, '') === B.md.replace(/generated[^\n]*/gi, ''), 'ISSUE-REPORT.md is the same');
        ok(p.leftovers() === 0, 'the sandbox was torn down');
    }
    {
        const p = await pipeline('nolog', { log: null });
        const cl = JSON.parse(fs.readFileSync(path.join(p.dir, 'work', 'copy-log.json'), 'utf8'));
        ok(cl.available === false && cl.fatal_count === 0 && cl.last_fatals.length === 0 && cl.label === 'unverified', 'no debug.log in the copy: available false');
        const A = p.build();
        ok(!A.f.case_file.developer.includes(MISSING) || A.f.sandbox.summary.active_plugins.missing_files.length > 0, 'the developer sentence follows missing_files only');
    }
    {
        const p = await pipeline('allpresent', { activeOpt: ser(['plugin-a/plugin-a.php', 'plugin-b/plugin-b.php']) });
        const A = p.build();
        ok(JSON.stringify(p.sb.baseline.active_plugins) === '["plugin-a","plugin-b"]' && activations(p.F).length === 0 && !A.f.case_file.developer.includes(MISSING), 'every active plugin has its file: both in the baseline, no activation, no missing-files sentence');
    }

    // ================================================================ without a database: unchanged
    group('a build WITHOUT a database file is unchanged');
    {
        const GOLD = path.join(__dirname, 'fixtures', 'issue', 'golden', 'no-dump-spec.json');
        const gdg = c => `sha256:${c.repeat(64)}`;
        const gin = { project: 'pgsb0a1b2c3d', issueId: 'iss-20261105-100000-abcdef', siteDir: '/golden/sandboxes/iss-20261105-100000-abcdef/site', logDir: '/golden/sandboxes/iss-20261105-100000-abcdef/logs', themes: ['acme', 'twentytwentyfive'], hasLanguages: true, images: { images: { wordpress: { ref: `wordpress@${gdg('1')}` }, cli: { ref: `wordpress@${gdg('2')}` }, db: { ref: `mariadb@${gdg('3')}`, family: 'MariaDB' } } }, creds: { root: 'GoldenRootPass', user: 'wp', pass: 'GoldenUserPass', name: 'wordpress' } };
        ok(JSON.stringify(policy.buildSpec(gin), null, 2) + '\n' === fs.readFileSync(GOLD, 'utf8'), 'the no-dump specification still equals the golden file byte for byte');
        const p = await pipeline('nodump', { dump: false });
        const acts = activations(p.F);
        ok(acts.length === 1 && wpArgs(acts[0]) === 'plugin activate plugin-a plugin-b', `the plugins of the copy are activated as before: "${acts.length ? wpArgs(acts[0]) : 'none'}"`);
        ok(!p.F.log().some(l => /pg_active/.test(l.stdin || '')) && !fs.existsSync(path.join(p.dir, 'work', 'active-plugins.json')) && !fs.existsSync(path.join(p.dir, 'work', 'copy-log.json')), 'no active_plugins read, no active-plugins.json, no copy-log.json');
        const A = p.build();
        ok(!('active_plugins' in A.f.sandbox.summary) && !('copy_log' in A.f.sandbox) && !A.f.case_file.developer.includes(MISSING), 'findings.json has no new field');
        ok(p.sb.baseline && JSON.stringify(p.sb.baseline.active_plugins) === '["plugin-a","plugin-b"]', 'the baseline is the listed set, as before');
    }

    // ================================================================ sandbox-many (guard:auto): the same rules
    group('one shared sandbox (sandbox-many.js) with a database file: no activation, active-plugins.json in every issue');
    {
        const root = site('many');
        const ids = [1, 2].map(n => store.create({ title: `many ${n}`, description: 'white page', symptom: 'white-screen', environment: 'local', root, pages: ['/'] }).id);
        const F = fakeEnv('many', { wp: base([activeRule(ser(['alpha/alpha.php', 'gone/gone.php'])), { match: 'plugin list', out: 'alpha\nbeta\n' }, { match: 'theme list', out: 'acme\ntwentytwentysix\n' }, { match: 'option get stylesheet', out: 'acme\n' }]) });
        const out = await require('../issue/sandbox-many').runMany(ids, { root, options: { dump: SQL, noBisect: true }, sandboxOptions: F.base(), observe: async () => ({ ok: true, pagesFull: [], protection: null }) });
        ok(activations(F).length === 0, 'no `wp plugin activate`');
        ok(ids.every(id => { try { return JSON.parse(fs.readFileSync(path.join(store.dirOf(id), 'work', 'active-plugins.json'), 'utf8')).source === 'from the database'; } catch { return false; } }), 'work/active-plugins.json in both issues');
        ok(ids.every(id => !out.per[id].baseline || JSON.stringify(out.per[id].baseline.active_plugins) === '["alpha"]'), 'the baseline (where one was taken) is the database\'s own set');
        ok(leftovers(F) === 0, 'torn down');
    }

    group('the copy log reader on its own');
    {
        const f = write(tmp, 'cl/debug.log', 'x'.repeat(3 * 1024 * 1024) + '\n' + LOG);
        const cl = phase.readCopyLog(f);
        ok(cl.available && cl.fatal_count === 3, 'only the last 2 MB is read (a 3 MB log still gives the 3 fatal lines at its end)');
        const pw = 'Pw' + crypto.randomBytes(12).toString('hex');
        const cl2 = phase.readCopyLog(write(tmp, 'cl/pw.log', `[06-Nov-2026 10:00:00 UTC] PHP Fatal error:  boom ${pw} in /var/www/html/wp-content/plugins/a/a.php on line 1\n`), { secrets: [pw] });
        ok(!JSON.stringify(cl2).includes(pw) && cl2.last_fatals[0].message.includes('[REDACTED]'), 'a secret handed in (the test password) is masked');
        const lines = Array.from({ length: 30 }, (_, i) => `[06-Nov-2026 10:00:${String(i).padStart(2, '0')} UTC] PHP Fatal error:  e${i} in /var/www/html/wp-content/plugins/a/a.php on line ${i + 1}`).join('\n');
        const cl3 = phase.readCopyLog(write(tmp, 'cl/many.log', lines));
        ok(cl3.fatal_count === 30 && cl3.last_fatals.length === phase.COPY_LOG_MAX && cl3.last_fatals[phase.COPY_LOG_MAX - 1].line === 30, 'at most the last 10 distinct fatals, newest last');
        fs.symlinkSync(f, path.join(tmp, 'cl', 'link.log'));
        ok(phase.readCopyLog(path.join(tmp, 'cl', 'link.log')).available === false && phase.readCopyLog(path.join(tmp, 'cl', 'none.log')).available === false, 'a symbolic link or a missing file: available false');
    }

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(failures ? `\n${failures} FAILED` : '\nAll checks passed');
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
