#!/usr/bin/env node
// Step 5-D: the redirect caller map. phpast.js records wp_redirect / wp_safe_redirect / header( 'Location: ...' ) with the function, method or class around them;
// issue/redirects.js matches them to the hooks of the SAME component (named functions, static and instance methods; closures stay unmatched); hypotheses.js joins the
// map with what the probe or the sandbox OBSERVED (or the symptom "redirect"). validate.js remains the only owner of CONFIRMED / REPRODUCIBLE / REJECTED.
// Offline fixtures only; every rule has a positive, a negative and a clean-site case.
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-redir-map-'));
process.env.PLUGIN_GUARD_ISSUES = path.join(tmp, 'issues');
const store = require('../lib/issue-store');
const phpast = require('../issue/phpast');
const custom = require('../issue/custom');
const redirects = require('../issue/redirects');
const analysis = require('../issue/analysis');
const validate = require('../issue/validate');
const probe = require('../issue/probe');
const ownership = require('../lib/ownership');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const group = t => console.log(`\n== ${t}`);
const head = (n, x = '') => `<?php\n/**\n * Plugin Name: ${n}\n * Version: 1.0.0\n${x} */\n`;
let n = 0;
function tree(parts) {
    const root = path.join(tmp, `wp${++n}`); const w = (rel, body) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); };
    w('wp-config.php', '<?php\n'); w('wp-includes/version.php', "<?php\n$wp_version = '6.8.1';\n"); fs.mkdirSync(path.join(root, 'wp-admin'), { recursive: true });
    for (const [rel, body] of Object.entries(parts)) w(rel, body);
    return root;
}
const CUSTOM = { customPaths: ['wp-content/plugins/plugin-a', 'wp-content/plugins/plugin-b'] };
const analyseTree = root => custom.analyse(root, { policy: ownership.loadPolicy(root, CUSTOM).policy });

group('phpast.js records the calls with the code around them');
const rec = src => phpast.analyse(`<?php\n${src}`, 'f.php').redirects;
const r1 = rec("function f() { wp_redirect( '/a', 301 ); wp_safe_redirect( '/b' ); header( 'Location: /c' ); }");
ok(r1.map(r => r.call).join() === 'wp_redirect,wp_safe_redirect,header' && r1[0].target === '/a' && r1[0].status === 301 && r1[2].target === '/c' && r1.every(r => r.in.kind === 'function' && r1[0].in.name === 'f'), 'wp_redirect, wp_safe_redirect and header( Location ) are recorded with target, status and the function around them');
ok(rec("function f() { header( 'Content-Type: text/html' ); header( 'X-Frame-Options: DENY' ); }").length === 0, 'other header() calls are not redirects');
ok(rec("class K { function m() { wp_redirect( '/m' ); } static function s() { wp_redirect( '/s' ); } }").map(r => `${r.in.kind}:${r.in.class}::${r.in.name}`).join() === 'method:K::m,method:K::s', 'the class and the method are recorded');
const rc = rec("class K { function m() { add_action( 'init', function () { wp_redirect( '/x' ); } ); } }");
ok(rc.length === 1 && rc[0].in.kind === 'closure', 'a redirect inside a closure is recorded as a closure (even inside a method)');
ok(rec("wp_redirect( '/top' );")[0].in === null, 'a redirect at file scope has no enclosing function');
const rd = rec("function f( $u ) { wp_redirect( $u ); header( 'Location: ' . $u ); }");
ok(rd.length === 2 && rd.every(r => r.dynamic) && rd[1].target === null, 'a target built at run time is marked dynamic');
ok(rec("function f() { // wp_redirect('/x');\n $s = 'wp_redirect(1)'; }").length === 0 && rec("function f() { strlen('x'); }").length === 0, 'comments, strings and other calls are not redirects');

group('matching to hooks, same component only');
const PA = head('A') + `namespace Acme;
class Guard {
    function boot() {
        add_action( 'template_redirect', [ $this, 'on_template' ] );
        add_action( 'init', [ self::class, 'on_init' ] );
        add_action( 'wp_login', 'Acme\\\\Guard::on_login' );
        add_action( 'admin_init', [ Guard::class, 'on_admin' ] );
        add_action( 'wp_loaded', function () { wp_safe_redirect( '/closure' ); } );
    }
    function on_template() { wp_redirect( '/t' ); }
    static function on_init() { header( 'Location: /i' ); }
    static function on_login() { wp_safe_redirect( '/l' ); }
    static function on_admin() { wp_redirect( '/a' ); }
    function never_hooked() { wp_redirect( '/n' ); }
}
function free_fn() { wp_redirect( '/f', 301 ); }
add_action( 'wp_head', 'free_fn' );
wp_redirect( '/top' );
`;
const PB = head('B') + `class Other { function boot() { add_action( 'init', [ $this, 'on_template' ] ); add_action( 'init', 'free_fn' ); add_action( 'init', 'never_hooked' ); } function on_template() {} }\nfunction never_hooked() {}\n`;
const MAP = redirects.build(analyseTree(tree({ 'wp-content/plugins/plugin-a/plugin-a.php': PA, 'wp-content/plugins/plugin-b/plugin-b.php': PB })));
const at = t => MAP.find(e => e.target === t);
ok(MAP.length === 8 && MAP.every(e => e.component === 'plugin-a' && e.file === 'wp-content/plugins/plugin-a/plugin-a.php' && e.line), 'eight redirect calls, all in plugin-a, each with file and line');
ok(at('/t').hooks.map(h => h.hook).join() === 'template_redirect' && at('/t').context === 'hook', 'instance method registered as [ $this, \'m\' ]');
ok(at('/i').hooks.map(h => h.hook).join() === 'init', 'static method registered as [ self::class, \'m\' ]');
ok(at('/l').hooks.map(h => h.hook).join() === 'wp_login', 'static method registered as the string \'Class::m\'');
ok(at('/a').hooks.map(h => h.hook).join() === 'admin_init', 'static method registered as [ Class::class, \'m\' ]');
ok(at('/f').hooks.map(h => h.hook).join() === 'wp_head', 'a named function registered by its name');
ok(at('/closure').context === 'unknown' && /closure/.test(at('/closure').unknown_reason) && /unknown hook context/.test(at('/closure').unknown_reason), 'a closure stays unmatched: "unknown hook context"');
ok(at('/n').context === 'unknown' && /nothing in plugin-a registers/.test(at('/n').unknown_reason), 'a method nothing registers is unmatched, and plugin-b\'s function of the same name does not count');
ok(at('/top').context === 'unknown' && /file scope/.test(at('/top').unknown_reason), 'a redirect at file scope is unmatched');
ok(at('/t').common && at('/l').common && !at('/i').common && !at('/a').common && !at('/f').common, 'template_redirect and login hooks are flagged common; init, admin_init, wp_head are not');
ok(!MAP.some(e => e.hooks.some(h => h.file.includes('plugin-b'))), 'no hook of plugin-b is attached to plugin-a\'s redirects (same component only: free_fn and on_template exist there too)');
ok(JSON.stringify(redirects.build(analyseTree(tree({ 'wp-content/plugins/plugin-a/plugin-a.php': PA, 'wp-content/plugins/plugin-b/plugin-b.php': PB })))) === JSON.stringify(MAP), 'deterministic');

group('the join: observed redirect, symptom "redirect", or neither');
const j = o => redirects.join(MAP, { refOf: {}, ...o });
ok(j({ observed: false, symptom: 'white-screen' }).length === 0, 'nothing observed and another symptom: no candidate (the map stays a map)');
ok(j({ observed: false, symptom: 'redirect' }).map(o => o.hook).sort().join() === 'admin_init,init,wp_head', 'symptom "redirect" without an observation: only the hooks that are NOT common (init, admin_init, wp_head)');
ok(j({ observed: true, symptom: 'white-screen' }).length === 5 && j({ observed: true, symptom: 'other' }).some(o => o.hook === 'template_redirect' && o.common), 'an observed redirect: all five matched calls, the common ones included');
ok(j({ observed: true }).every(o => o.type === 'redirect-on-hook' && o.evidence[0].line && !/closure/.test(o.message) ), 'closures and unmatched calls never become candidates');
ok(redirects.join([], { observed: true, symptom: 'redirect' }).length === 0, 'a clean site (no redirect at all): nothing');

group('through the real steps (probe clue -> hypotheses -> validate)');
function pipeline(parts, { clues = [], symptom = 'white-screen' } = {}) {
    const root = tree(parts); fs.writeFileSync(path.join(root, 'plugin-guard.config.json'), JSON.stringify(CUSTOM));
    const issue = store.create({ title: 't', description: 'd', symptom, environment: 'local', url: 'http://127.0.0.1:9/', root, pages: ['/'] });
    const d = path.join(store.dirOf(issue.id), 'work'); fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'evidence.json'), JSON.stringify({ clues, features: [], component_hints: [] }));
    const r = analysis.run(issue.id, { root });
    return { id: issue.id, root, r, hyps: r.hypotheses.hypotheses.filter(h => h.type === 'redirect-on-hook'), dir: d };
}
const PARTS = { 'wp-content/plugins/plugin-a/plugin-a.php': PA, 'wp-content/plugins/plugin-b/plugin-b.php': PB };
const none = pipeline(PARTS);
ok(none.hyps.length === 0, 'no redirect observed, symptom white-screen: no hypothesis...');
const cc = JSON.parse(fs.readFileSync(path.join(store.dirOf(none.id), 'work', 'custom-code.json'), 'utf8'));
ok(Array.isArray(cc.redirect_map) && cc.redirect_map.length === 8 && cc.redirect_map.filter(e => e.context === 'hook').length === 5, '...but custom-code.json keeps the whole map (8 calls, 5 matched)');
ok(none.r.steps.some(s => s.id === 'redirect-map' && /8 redirect call/.test(s.reason) && /3 with an unknown hook context/.test(s.reason)), 'the step line counts matched and unknown calls');
const sym = pipeline(PARTS, { symptom: 'redirect' });
ok(sym.hyps.length === 3 && sym.hyps.every(h => !/template_redirect|wp_login/.test(h.mechanism.split('runs on')[1].split('(')[0] || '')), `symptom "redirect": three hypotheses, none for a common hook (${sym.hyps.length})`);
const LOOP = { id: 'clue-redir', type: 'probe-redirect', value: 'redirect loop: the browser gave up (ERR_TOO_MANY_REDIRECTS)', detail: { chain: [], error: 'ERR_TOO_MANY_REDIRECTS', viewports: ['laptop'] }, source: { kind: 'probe', ref: 'http://127.0.0.1:9/', line: null }, confidence: 'certain', snippet: '' };
const seen = pipeline(PARTS, { clues: [LOOP], symptom: 'white-screen' });
ok(seen.hyps.length === 5 && seen.hyps.some(h => /template_redirect/.test(h.mechanism)), 'a redirect observed by the probe: five hypotheses, the common hooks included');
ok(seen.hyps.every(h => h.supports.some(s => s.kind === 'probe' && s.ref === 'clue-redir') && h.supports.some(s => s.kind === 'observation')), 'each rests on the code (observation) and on the probe');
ok(seen.hyps.every(h => ['UNVERIFIED', 'PROBABLE_NEEDS_REVIEW'].includes(h.status)), `hypotheses.js assigns at most PROBABLE_NEEDS_REVIEW (${[...new Set(seen.hyps.map(h => h.status))].join(', ')})`);
const withCommon = seen.hyps.find(h => /template_redirect/.test(h.mechanism));
ok(/common in legitimate plugins/.test(withCommon.mechanism), 'the text for a common hook says it is common in legitimate plugins');
const V = validate.run(seen.id, { root: seen.root, lint: () => ({ ok: true, message: '' }) }).hypotheses.filter(h => h.type === 'redirect-on-hook');
ok(V.length === 5 && V.every(h => h.status === 'CONFIRMED'), 'validate.js re-reads each file and, with the code and the probe agreeing, is the one that says CONFIRMED');
fs.writeFileSync(path.join(seen.root, 'wp-content/plugins/plugin-a/plugin-a.php'), head('A') + '// cleaned\n');
const V2 = validate.run(seen.id, { root: seen.root, lint: () => ({ ok: true, message: '' }) }).hypotheses.filter(h => h.type === 'redirect-on-hook');
ok(V2.every(h => h.status === 'REJECTED_FALSE_POSITIVE'), 'once the redirect calls are gone from the files, validate.js rejects them');
for (const f of ['hypotheses.js', 'redirects.js']) ok(!/status\s*[:=]\s*'(CONFIRMED|REPRODUCIBLE|REJECTED_FALSE_POSITIVE|FIXED_VERIFIED)'/.test(fs.readFileSync(path.join(__dirname, '..', 'issue', f), 'utf8')), `${f} never assigns CONFIRMED / REPRODUCIBLE / REJECTED / FIXED_VERIFIED`);

group('the sandbox sees a redirect (after the bisection step)');
const sb = pipeline(PARTS);
const h2 = analysis.applyBisect(sb.id, sb.r, { bisect: null, sandboxReproduced: 'yes', sandboxRedirect: true });
ok(h2.hypotheses.filter(h => h.type === 'redirect-on-hook').length === 5 && h2.hypotheses.filter(h => h.type === 'redirect-on-hook').every(h => /sandbox copy showed a redirect/.test(h.mechanism)), 'applyBisect with sandboxRedirect: true rebuilds the hypotheses with the five candidates, and the text says the sandbox showed it');
ok(analysis.applyBisect(sb.id, sb.r, { bisect: null, sandboxReproduced: 'yes', sandboxRedirect: false }).hypotheses.every(h => h.type !== 'redirect-on-hook'), '...and with sandboxRedirect: false there are none');
const phase = fs.readFileSync(path.join(__dirname, '..', 'issue', 'sandbox-phase.js'), 'utf8'), cli = fs.readFileSync(path.join(__dirname, '..', 'lib', 'issue-cli.js'), 'utf8');
ok(/redirectSeen/.test(phase) && /redirect_observed/.test(phase) && /sandboxRedirect: !!sb\.redirect_observed/.test(cli), 'the sandbox phase records a redirect seen in the baseline run and issue investigate passes it on');

group('the probe turns a redirect problem into a clue');
const P = (o = {}) => ({ url: 'http://a.test/x', viewport: { name: 'laptop', width: 1280 }, loaded: true, status: 200, console_errors: [], page_errors: [], error_responses: [], ...o });
const cf = probe.cluesFrom([P({ loaded: false, status: 0, error: 'page.goto: net::ERR_TOO_MANY_REDIRECTS at http://a.test/x' }), P({ url: 'http://a.test/y', redirects: ['http://a.test/y', 'http://evil.test/'] }), P({ url: 'http://a.test/ok' })]).filter(c => c.type === 'probe-redirect');
ok(cf.length === 2 && cf.some(c => /loop/.test(c.value)) && cf.some(c => /another host/.test(c.value)) && cf.every(c => c.source.kind === 'probe'), 'a loop and a cross-host redirect give probe-redirect clues; the normal page gives none');
ok(probe.cluesFrom([P()]).filter(c => c.type === 'probe-redirect').length === 0, 'a clean page: no clue');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
