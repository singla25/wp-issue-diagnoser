#!/usr/bin/env node
// Offline self-test of the three-agent workflow. Uses a disposable fake WordPress tree under the OS temp folder.
// Makes no network request, does not start a browser, and touches no real site.
// (Agent 1 against a live page is covered by selftest-agent1.js; the HTML dashboard in a browser by selftest-html.js.)

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-agents-'));
process.env.PLUGIN_GUARD_RUNS = path.join(tmp, 'runs');
process.env.PLUGIN_GUARD_HOME = path.join(tmp, 'projects');
process.env.PLUGIN_GUARD_REPORTS = path.join(tmp, 'reports');
const SECRET = 'sk_live_abcdefghijklmnopqrstuv1234';

const ownership = require('../lib/ownership');
const configLib = require('../lib/config');
const schema = require('../lib/schema');
const runs = require('../lib/runs');
const codeAgent = require('../agents/code');
const validateAgent = require('../agents/validate');
const workflow = require('../lib/workflow');
const html = require('../lib/report-html');
const tasksLib = require('../lib/claude-tasks');
const { scan } = require('../guard');
const projectLib = require('../lib/project');
const fixfile = require('../lib/fixfile');

let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) failures++; };
const group = t => console.log(`\n== ${t}`);
const write = (root, rel, body, mode) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); if (mode) fs.chmodSync(f, mode); };
const hdr = (name, v = '1.0.0') => `<?php\n/**\n * Plugin Name: ${name}\n * Version: ${v}\n */\n`;
const throws = async fn => { try { await fn(); return null; } catch (e) { return e; } };
function quiet(fn) { const old = console.log; const lines = []; console.log = (...a) => lines.push(a.join(' ')); return Promise.resolve().then(fn).then(r => { console.log = old; return { r, out: lines.join('\n') }; }, e => { console.log = old; throw e; }); }

// ------------------------------------------------------------------ fixture
const root = path.join(tmp, 'site');
const outside = path.join(tmp, 'outside');
write(root, 'wp-config.php', `<?php\n$table_prefix = 'wp_';\ndefine('DB_PASSWORD', 'hunter2-db-password');\n`, 0o644);
write(root, 'wp-includes/version.php', "<?php $wp_version = '6.4.2'; $wp_local_package = 'en_US';");
write(root, 'wp-admin/index.php', '<?php // core');
write(root, 'wp-content/uploads/.keep', '', 0o644);
fs.chmodSync(path.join(root, 'wp-content/uploads'), 0o777);
write(root, 'wp-content/plugins/mine/mine.php', hdr('Mine') + `defined('ABSPATH') || exit;
add_action('wp_ajax_mine_save', 'mine_save');
function mine_save() { check_ajax_referer('mine'); update_option('mine_opt', $_POST['v']); }
function mine_show() { echo $_GET['q']; echo esc_html($_GET['safe']); }
function mine_conf() { return array('api_key' => '${SECRET}'); }
function mine_sql($id) { global $wpdb; return $wpdb->get_results("SELECT * FROM {$wpdb->prefix}mine WHERE id=" . $id); }
function mine_table() { global $wpdb; return $wpdb->get_results("SELECT * FROM {$wpdb->prefix}mine"); }
`);
write(root, 'wp-content/plugins/mine/broken.php', '<?php\nfunction broken( {\n');
write(root, 'wp-content/plugins/mine/vendor/lib/bad.php', "<?php\necho $_GET['v'];\n");
write(root, 'wp-content/plugins/mine/clean.php', "<?php\ndefined('ABSPATH') || exit;\nfunction mine_ok() { return 1; }\n");
write(outside, 'evil.php', "<?php echo $_GET['e'];\n");
fs.symlinkSync(outside, path.join(root, 'wp-content/plugins/mine/escape'));
write(root, 'wp-content/plugins/thirdparty/tp.php', hdr('Third Party') + "add_action('admin_notices', array($this, 'admin_notices'));\nremove_action('admin_notices', array($this, 'admin_notices'));\n");
write(root, 'wp-content/plugins/thirdparty/direct.php', "<?php\necho $_GET['x'];\nregister_rest_route('tp/v1','/w',array('methods'=>'POST','callback'=>'f','permission_callback'=>'__return_true'));\n");
write(root, 'wp-content/plugins/thirdparty/direct2.php', "<?php\necho $_GET['y'];\n");
write(root, 'wp-content/plugins/thirdparty/vendor/x/Tests/Dep.inc', "<?php\n$f = create_function('$a', 'return 1;');\n");
write(root, 'wp-content/plugins/other/other.php', hdr('Other') + "defined('ABSPATH') || exit;\nadd_action('admin_notices', array($this, 'admin_notices'));\nadd_action('init', 'shared_fn');\n");
write(root, 'wp-content/plugins/remover/remover.php', hdr('Remover') + "defined('ABSPATH') || exit;\nremove_action('init', 'shared_fn');\n");

const CUSTOM = ['wp-content/plugins/mine'];
const cfgFile = path.join(tmp, 'cfg.json');
fs.writeFileSync(cfgFile, JSON.stringify({ customPaths: CUSTOM }));

(async () => {
    group('Ownership: custom-code allowlist, protected paths, traversal, symlinks');
    const { policy, errors } = ownership.loadPolicy(root, { customPaths: CUSTOM });
    ok(errors.length === 0, 'a specific plugin folder is accepted as custom code');
    const c = p => ownership.classify(policy, p);
    ok(c('wp-content/plugins/mine/mine.php').owner === 'custom', 'file inside the allowlisted folder is custom');
    ok(c('wp-content/plugins/mine/vendor/lib/bad.php').owner === 'protected', 'vendor/ inside a custom plugin stays protected');
    ok(c('wp-content/plugins/thirdparty/tp.php').owner === 'unknown', 'a plugin that is not listed is NOT assumed to be ours (needs an allowlist entry)');
    ok(c('wp-includes/version.php').owner === 'protected' && c('wp-admin/index.php').owner === 'protected' && c('wp-config.php').owner === 'protected', 'core files are protected');
    ok(c('../site/wp-config.php').owner === 'rejected' || c('../../etc/passwd').owner === 'rejected', 'path traversal is rejected');
    ok(c('/etc/passwd').owner === 'rejected', 'an absolute path outside the root is rejected');
    ok(c('wp-content/plugins/mine/escape/evil.php').owner === 'rejected', 'a symlink that leaves the project is rejected');
    ok(c('wp-content/plugins/mine/mine.php\0.png').owner === 'rejected', 'a NUL byte in a path is rejected');
    const broad = ownership.loadPolicy(root, { customPaths: ['wp-content/plugins', 'wp-content', '.', '../..', 'wp-includes', 'wp-content/plugins/mine/vendor'] });
    ok(broad.errors.length === 6, `too-broad, traversal, core and vendor entries cannot be declared custom (${broad.errors.length}/6 rejected)`);
    const prot = ownership.loadPolicy(root, { customPaths: CUSTOM, protectedPaths: ['wp-content/plugins/mine/broken.php'] }).policy;
    ok(ownership.classify(prot, 'wp-content/plugins/mine/broken.php').owner === 'protected', 'an explicit protectedPaths entry beats the allowlist');
    ok(ownership.classify(ownership.loadPolicy(root, {}).policy, 'wp-content/plugins/mine/mine.php').owner === 'unknown', 'with no allowlist nothing is custom');
    ok(ownership.componentOf('wp-content/themes/t/a.php') === 'theme:t', 'component names derive from the path');

    group('Configuration');
    const noCred = configLib.resolve({ root, config: path.join(tmp, 'cred.json') });
    fs.writeFileSync(path.join(tmp, 'cred.json'), JSON.stringify({ customPaths: CUSTOM, password: 'x' }));
    ok(configLib.resolve({ root, config: path.join(tmp, 'cred.json') }).errors.some(e => /credentials/.test(e)), 'credentials in the config file are refused');
    ok(configLib.resolve({ root: path.join(tmp, 'nope') }).errors.length > 0, 'a missing root is a configuration error');
    ok(configLib.resolve({ root: outside }).errors.some(e => /wp-content/.test(e)), 'a folder without wp-content is not accepted as a WordPress root');
    ok(configLib.resolve({ root, config: cfgFile, url: 'ftp://x' }).errors.some(e => /url/.test(e)), 'a non-http URL is refused');
    ok(configLib.urlAuthorization({ url: 'https://example.com/', environment: null }).code === 'NEEDS_AUTHORIZATION', 'a public URL with no stated environment is not tested');
    ok(configLib.urlAuthorization({ url: 'https://example.com/', environment: 'live', authorizedLive: false }).code === 'NEEDS_AUTHORIZATION', 'a live site needs --authorized');
    ok(configLib.urlAuthorization({ url: 'https://example.com/', environment: 'staging' }).ok, 'staging is allowed');
    process.env.INIT_CWD = tmp;
    ok(configLib.userPath('site') === root, 'relative paths resolve against where the user typed the command (npm --prefix changes the cwd)');
    delete process.env.INIT_CWD;

    group('Regressions in the original scanner');
    const proj = projectLib.normalise({ url: null, path: root }, 'adhoc');
    const r = await scan('adhoc', { project: proj, save: false });
    const removed = r.findings.filter(f => f.rule === 'hook-removed');
    ok(!removed.some(f => /admin_notices/.test(f.title)), 'remove_action(..., [$this,"m"]) is not reported as removing another plugin\'s method of the same name');
    ok(removed.some(f => /shared_fn/.test(f.title)), 'a real removal of another plugin\'s function callback is still reported');
    ok(!r.findings.some(f => f.rule === 'integrity-create-function' && /Tests\/Dep\.inc/.test(JSON.stringify(f))), 'create_function in a vendor library\'s test fixture is not reported as malware');
    write(root, 'wp-content/plugins/other/legacy.php', "<?php\n$f = create_function('$a', 'return 1;');\n");
    const r2 = await scan('adhoc', { project: proj, save: false });
    ok(r2.findings.some(f => f.rule === 'integrity-create-function' && /other\/legacy\.php/.test(JSON.stringify(f))), 'create_function in real plugin code is still reported');
    fs.rmSync(path.join(root, 'wp-content/plugins/other/legacy.php'));
    ok(r.findings.every(f => f.decision === 'pending') && !fs.existsSync(path.join(tmp, 'projects', 'adhoc')), 'an ad-hoc scan writes no project, history or decision files');

    group('Fix file: custom-code-only gate (legacy FIXES-FOR-CLAUDE.md)');
    const gated = JSON.parse(JSON.stringify(r));
    gated.policy = { customPaths: CUSTOM, protectedPaths: [] };
    for (const f of gated.findings) f.decision = 'fix';
    const noRest = gated.findings.filter(f => f.rule === 'rest-no-permission');
    ok(noRest.length > 0, 'fixture has a public write REST route in third-party code');
    const mineItem = { id: 'aaaaaaaaaa', rule: 'code-eval', severity: 'P2', category: 'exposure', title: 'eval in mine', detail: 'd', plugins: ['mine'], evidence: ['wp-content/plugins/mine/mine.php:4'], fix: 'remove it', commands: [], patch: null, confidence: 'likely', owner: 'code', done: 'gone', decision: 'fix' };
    const md = fixfile.build({ ...gated, findings: [mineItem, ...noRest] });
    const [itemsPart, notEditable] = md.split('## Not editable');
    ok(/PG-aaaaaaaaaa/.test(itemsPart) && !/tp\/v1/.test(itemsPart) && /needs an allowlist decision/.test(md) && /tp\/v1/.test(notEditable || ''), 'a fix approved for third-party code is moved to "Not editable", the custom one stays');
    const allBlocked = await throws(() => fixfile.build({ ...gated, findings: gated.findings.filter(f => f.rule === 'rest-no-permission') }));
    ok(allBlocked && /custom-code allowlist/.test(allBlocked.message), 'if every approved item is outside the allowlist, no fix file is produced');

    group('Agent 2: code and security');
    const cfg = configLib.resolve({ root, config: cfgFile }).config;
    const run = runs.create(root);
    const a2 = await quiet(() => workflow.stageCode({}, cfg, run)).then(x => x.r);
    const byRule = rule => a2.findings.filter(f => f.rule === rule);
    ok(byRule('php-syntax-error').some(f => f.file_path === 'wp-content/plugins/mine/broken.php'), 'php -l finds the syntax error in custom code');
    ok(byRule('xss-request-output').length === 1 && byRule('xss-request-output')[0].line_start, 'unescaped request output is found once; esc_html() output is not');
    ok(byRule('hardcoded-secret').length === 1, 'hard-coded secret found');
    ok(byRule('sql-unprepared-variable').length === 1 && !JSON.stringify(byRule('sql-unprepared-variable')).includes('prefix}mine"'), 'unprepared SQL with a variable is found; a query with only a table prefix is not');
    ok(byRule('nonce-without-capability').length === 1, '"a nonce is not authorization": nonce without capability check found');
    ok(!a2.findings.some(f => /vendor\/lib\/bad\.php/.test(f.file_path || '') && f.category === 'custom-code'), 'vendor code inside the custom plugin is not scanned as custom code');
    ok(!JSON.stringify(a2).includes(SECRET), 'the hard-coded secret value is never copied into the agent output');
    ok(a2.checks.some(x => x.id === 'tool-phpcs' && ['NOT_RUN'].includes(x.status)) && a2.checks.some(x => x.id === 'runtime' && x.status === 'NOT_RUN'), 'unavailable tools and a missing runtime are reported NOT_RUN, never passed');
    ok(a2.findings.every(f => schema.validate(f).length === 0), 'every Agent 2 finding follows the shared schema');
    const grouped = a2.findings.filter(f => f.rule === 'code-no-abspath' && f.component === 'plugin:thirdparty');
    ok(grouped.length === 1 && grouped[0].original.grouped >= 2, 'several findings of one rule in one third-party plugin are grouped into a single finding');

    group('Agent 3: validation');
    // inject claims Agent 3 must NOT accept
    const planted = [
        schema.makeFinding({ id: 'PGC-fake1', run_id: run.id, title: 'eval() in clean.php', severity: 'CRITICAL', status: 'UNVERIFIED', source_agent: 'code-security', file_path: 'wp-content/plugins/mine/clean.php', line_start: 3, rule: 'code-eval', recommended_fix: 'remove eval', evidence: ['wp-content/plugins/mine/clean.php:3'], component: 'plugin:mine' }),
        schema.makeFinding({ id: 'PGC-fake2', run_id: run.id, title: 'traversal', severity: 'HIGH', source_agent: 'code-security', file_path: '../../etc/passwd', line_start: 1, rule: 'code-eval', recommended_fix: 'x', evidence: ['../../etc/passwd:1'] }),
        schema.makeFinding({ id: 'PGC-fake3', run_id: run.id, title: 'pattern-only critical', severity: 'CRITICAL', source_agent: 'code-security', file_path: 'wp-content/plugins/mine/mine.php', line_start: 4, rule: 'xss-request-output', recommended_fix: 'escape', evidence: ['wp-content/plugins/mine/mine.php:4'], component: 'plugin:mine' }),
        { id: 'broken', title: 'no schema' }
    ];
    const a2p = JSON.parse(JSON.stringify(a2)); a2p.findings.push(...planted);
    runs.write(run.id, 'agent2.json', a2p);
    const v = await validateAgent.run({ runId: run.id });
    const F = id => v.findings.find(f => f.id === id);
    const rule = rl => v.findings.filter(f => f.rule === rl);
    ok(F('PGC-fake1').status === 'REJECTED_FALSE_POSITIVE' && F('PGC-fake1').severity === 'INFO', 'a claim whose cited file contains no such pattern is REJECTED_FALSE_POSITIVE with the reason recorded');
    ok(F('PGC-fake2').file_path === null && F('PGC-fake2').status === 'UNVERIFIED' && !F('PGC-fake2').fix_eligible, 'a path-traversal file_path is dropped and the finding is not actionable');
    ok(F('PGC-fake3').severity === 'HIGH' && F('PGC-fake3').status === 'PROBABLE_NEEDS_REVIEW', 'a pattern-only CRITICAL is capped at HIGH');
    ok(v.input_problems.some(p => /broken/.test(p)), 'a malformed finding is reported as an input problem, not a crash');
    ok(rule('php-syntax-error')[0].status === 'REPRODUCIBLE' && rule('php-syntax-error')[0].reproduction_steps[0].startsWith('php -l'), 'Agent 3 re-ran php -l: REPRODUCIBLE with a documented procedure');
    ok(rule('xss-request-output')[0].status === 'PROBABLE_NEEDS_REVIEW', 'a source pattern is "needs review", never CONFIRMED without evidence of exploitability');
    ok(v.findings.some(f => f.status === 'UNVERIFIED'), 'UNVERIFIED findings are kept, not dropped');
    const perm = v.findings.find(f => f.rule === 'perm-world-writable');
    ok(perm && perm.status === 'CONFIRMED', 'a file-mode fact is re-checked on disk and CONFIRMED');
    ok(v.findings.filter(f => f.fix_eligible).every(f => f.ownership.owner === 'custom' && f.allowed_fix_paths.length === 1 && f.allowed_fix_paths[0] === f.file_path), 'only custom-code findings are fix-eligible, each limited to its own file');
    ok(v.findings.filter(f => f.component && /thirdparty|other|remover/.test(f.component)).every(f => !f.fix_eligible), 'no third-party finding is fix-eligible');
    ok(rule('rest-no-permission').every(f => !f.fix_eligible && /allowlist|Protected/.test(f.blocked_reason || '')), 'third-party findings say why they are not tasks');
    ok(v.findings.filter(f => f.fix_eligible).every(f => ['CONFIRMED', 'REPRODUCIBLE', 'PROBABLE_NEEDS_REVIEW'].includes(f.status)), 'rejected / unverified findings never become tasks');
    ok(v.complete === false && v.stages.find(s => s.id === 'agent1').state === 'missing', 'with no Agent 1 result the report is PARTIAL and says which stage is missing');
    ok(JSON.stringify(v.summary) === JSON.stringify(schema.summarize(v.findings, v.checks)), 'summary counts equal a recount of the findings');

    group('Outputs: one source of truth, no secrets, offline HTML');
    const res = await quiet(() => workflow.stageValidate(run.id, {}));
    const dir = runs.dirOf(run.id);
    const finalJson = JSON.parse(fs.readFileSync(path.join(dir, 'findings.json'), 'utf8'));
    const htmlText = fs.readFileSync(path.join(dir, 'report.html'), 'utf8');
    const embedded = JSON.parse(/<script type="application\/json" id="pg-data">([\s\S]*?)<\/script>/.exec(htmlText)[1]);
    ok(['01-user-test-report.md', '02-code-test-report.md', '03-final-validation-report.md', 'findings.json', 'claude-tasks.md', 'report.html', 'evidence'].every(f => fs.existsSync(path.join(dir, f)) || f === '01-user-test-report.md'), 'all required outputs exist in reports/runs/<run-id>/');
    ok(JSON.stringify(embedded.findings) === JSON.stringify(finalJson.findings) && JSON.stringify(embedded.summary) === JSON.stringify(finalJson.summary), 'the HTML embeds exactly the findings and summary of findings.json');
    const mdFinal = fs.readFileSync(path.join(dir, '03-final-validation-report.md'), 'utf8');
    ok(mdFinal.includes(`Total findings: **${finalJson.summary.total}**`) && /PARTIAL REPORT/.test(mdFinal), 'the Markdown report shows the same total and is labelled PARTIAL');
    const tasksMd = fs.readFileSync(path.join(dir, 'claude-tasks.md'), 'utf8');
    const allowed = [...tasksMd.matchAll(/\*\*Allowed files:\*\* (.*)/g)].flatMap(m => [...m[1].matchAll(/`([^`]+)`/g)].map(x => x[1]));
    ok(allowed.length > 0 && allowed.every(p => ownership.classify(policy, p).owner === 'custom'), `claude-tasks.md lists only allowlisted custom files (${allowed.length} file(s))`);
    ok(!/## Tasks[\s\S]*thirdparty[\s\S]*## Not tasks/.test(tasksMd), 'no third-party file appears among the tasks');
    ok(/Do not modify/.test(tasksMd) && /WordPress core/.test(tasksMd) && /third-party plugins or themes/.test(tasksMd), 'the task file tells Claude to leave core, third-party code and vendor files unchanged');
    ok(!/PGC-fake1/.test(tasksMd.split('## Not tasks')[0]), 'rejected false positives are not tasks');
    const everything = [htmlText, mdFinal, tasksMd, fs.readFileSync(path.join(dir, 'findings.json'), 'utf8'), fs.readFileSync(path.join(dir, '02-code-test-report.md'), 'utf8')].join('\n');
    ok(!everything.includes(SECRET) && !everything.includes('hunter2-db-password'), 'no secret value appears in any report');
    ok(!/<script[^>]+src=|<link[^>]|@import|\bfetch\s*\(|XMLHttpRequest|https?:\/\/[^\s"'<]*\.(js|css|woff2?)/i.test(htmlText.replace(/<script type="application\/json"[\s\S]*?<\/script>/, '')), 'report.html references no external script, stylesheet, font or fetch');
    ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/.test(htmlText.replace(/<script type="application\/json"[\s\S]*?<\/script>/, '')), 'report.html never inserts data as HTML');
    const evil = html.build({ ...finalJson, findings: [{ ...finalJson.findings[0], title: '</script><script>window.pwn=1</script><img src=x onerror=alert(1)>' }] });
    ok(!evil.includes('</script><script>window.pwn') && !/<img src=x/.test(evil), 'script-closing text inside a finding cannot break out of the embedded JSON');

    group('Correlation and de-duplication');
    const src = schema.makeFinding({ id: 'S1', title: 'syntax error', source_agent: 'code-security', status: 'REPRODUCIBLE', component: 'plugin:shop', file_path: 'wp-content/plugins/shop/a.php', line_start: 2, rule: 'php-syntax-error' });
    const src2 = JSON.parse(JSON.stringify(src)); src2.id = 'S1b';
    const web = schema.makeFinding({ id: 'W1', title: 'Failed request', source_agent: 'user-frontend', status: 'PROBABLE_NEEDS_REVIEW', url: 'https://x.test/', evidence: ['https://x.test/wp-content/plugins/shop/js/app.js 500'] });
    const unrelated = schema.makeFinding({ id: 'W2', title: 'Other', source_agent: 'user-frontend', status: 'PROBABLE_NEEDS_REVIEW', url: 'https://x.test/', evidence: ['https://x.test/wp-content/plugins/zzz/a.js 404'] });
    const merged = validateAgent.dedupe([src, src2, web, unrelated]);
    validateAgent.correlate(merged);
    ok(merged.length === 3 && merged[0].related_finding_ids.includes('S1b'), 'identical source findings are merged and the duplicate id is kept as related');
    ok(web.related_finding_ids.includes('S1') && src.related_finding_ids.includes('W1') && /Possible cause in plugin:shop/.test(web.root_cause) && /not proof/.test(web.root_cause), 'a failing asset under /plugins/shop/ is linked both ways to the finding in plugin:shop, described as correlation not proof');
    ok(unrelated.related_finding_ids.length === 0 && !unrelated.root_cause, 'an unrelated browser finding is not linked to anything');

    // regression: the scanner records admin_post_* handlers under the AJAX rules; Agent 3 once rejected such a finding because it only looked for wp_ajax_
    write(root, 'wp-content/plugins/mine/post.php', "<?php\ndefined('ABSPATH') || exit;\nadd_action( 'admin_post_mine_resolve', 'mine_resolve' );\n");
    const adminPost = schema.makeFinding({ id: 'PGC-ap', run_id: run.id, title: 'ajax action shared', severity: 'MEDIUM', source_agent: 'code-security', file_path: 'wp-content/plugins/mine/post.php', line_start: 3, rule: 'shared-ajax-action', evidence: ['wp-content/plugins/mine/post.php:3'], component: 'plugin:mine' });
    const apDir = JSON.parse(JSON.stringify(a2)); apDir.findings = [adminPost];
    const apRun = runs.create('ap'); runs.write(apRun.id, 'agent2.json', apDir);
    runs.updateManifest(apRun.id, { stage: { name: 'agent2', data: { at: new Date().toISOString(), root } } });
    const apv = await validateAgent.run({ runId: apRun.id });
    ok(apv.findings[0].status === 'PROBABLE_NEEDS_REVIEW', 'an admin_post_ handler cited under shared-ajax-action is NOT rejected as a false positive');

    group('Workflows');
    const staleRun = runs.create('stale');
    runs.write(staleRun.id, 'agent2.json', a2); // same content, but the manifest says it ran 3 days ago
    runs.updateManifest(staleRun.id, { stage: { name: 'agent2', data: { at: new Date(Date.now() - 72 * 3600 * 1000).toISOString(), root } } });
    const stale = await validateAgent.run({ runId: staleRun.id });
    ok(stale.findings.length === 0 && stale.stages.find(s => s.id === 'agent2').state === 'stale' && stale.input_problems.some(p => /old/.test(p)), 'a 72-hour-old Agent 2 result is refused, not silently reused');
    const staleOk = await validateAgent.run({ runId: staleRun.id, allowStale: true });
    ok(staleOk.findings.length > 0, '--allow-stale lets the user override that explicitly');
    const mix = runs.create('mix');
    runs.write(mix.id, 'agent2.json', a2);
    runs.write(mix.id, 'agent1.json', { agent: 'user-frontend', run_id: mix.id, tests_ran: true, checks: [], findings: [] });
    runs.updateManifest(mix.id, { stage: { name: 'agent1', data: { at: new Date().toISOString(), url: 'https://a.example/' } } });
    runs.updateManifest(mix.id, { stage: { name: 'agent2', data: { at: new Date().toISOString(), root, url: 'https://b.example/' } } });
    const mixed = await validateAgent.run({ runId: mix.id });
    ok(mixed.input_problems.some(p => /Agent 1 tested/.test(p)) && !mixed.complete, 'results for two different sites are not combined');

    const local = await quiet(() => workflow.scanLocal({ root, config: cfgFile }));
    ok(local.r === 1 || local.r === 0, `local-first scan completes (exit ${local.r})`);
    ok(/Agent 1 skipped: a source checkout is not a running website/.test(local.out), 'local-first says a source checkout is not a running site and skips browser tests');
    const lr = /Run id: (\S+)|run (\d{8}-\d{6}-[0-9a-f]{6})/.exec(local.out); const lrId = lr[1] || lr[2];
    const lf = runs.read(lrId, 'findings.json');
    ok(lf.complete === false && lf.checks.some(x => x.id === 'frontend-run' && x.status === 'NOT_RUN'), 'local-first without a URL: report is PARTIAL with the browser check NOT_RUN');
    ok(lf.checks.some(x => x.id === 'runtime' && x.status === 'NOT_RUN'), 'local-first reports that no runnable WordPress was detected');

    group('CLI exit codes');
    const cli = (...args) => spawnSync(process.execPath, [path.join(__dirname, 'guard.js'), ...args], { encoding: 'utf8', env: { ...process.env, INIT_CWD: tmp } });
    ok(cli('scan', '--root', path.join(tmp, 'nope')).status === 2, 'unusable --root: exit 2');
    ok(cli('qa-code').status === 2, 'qa-code without --root: exit 2');
    const sc = cli('scan', '--root', 'site', '--config', cfgFile);
    ok([0, 1].includes(sc.status) && /report\.html/.test(sc.stdout) && !/opened/i.test(sc.stdout.replace(/not opened/, '')), `scan --root with a root relative to INIT_CWD works and only PRINTS the open command (exit ${sc.status})`);
    ok(cli('doctor').status === 0 && cli('config', '--root', root, '--config', cfgFile).status === 0, 'doctor and config commands run');

    console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
