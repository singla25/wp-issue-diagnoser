#!/usr/bin/env node
// Step 5-B: (1) the cross-component comparisons in issue/custom.js (shortcode, AJAX action, REST route, script handle, constant);
// (2) the status rules of validate.js: two verified declaration sites can reach CONFIRMED, one cannot; a compromise finding never does;
// (3) families: a duplicate constant is never the "fatal" family; third-party duplicates need a clue. Offline fixtures only.
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-dups-'));
process.env.PLUGIN_GUARD_ISSUES = path.join(tmp, 'issues');
const store = require('../lib/issue-store');
const custom = require('../issue/custom');
const analysis = require('../issue/analysis');
const validate = require('../issue/validate');
const ownership = require('../lib/ownership');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const group = t => console.log(`\n== ${t}`);
const head = (n, x = '') => `<?php\n/**\n * Plugin Name: ${n}\n * Version: 1.0.0\n${x} */\ndefined('ABSPATH') || exit;\n`;
let n = 0;
function tree(parts) {
    const root = path.join(tmp, `wp${++n}`); const w = (rel, body) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); };
    w('wp-config.php', '<?php\n'); w('wp-includes/version.php', "<?php\n$wp_version = '6.8.1';\n"); fs.mkdirSync(path.join(root, 'wp-admin'), { recursive: true });
    w('wp-includes/script-loader.php', "<?php\nfunction wp_default_scripts( $scripts ) {\n\t$scripts->add( 'jquery', false, array( 'jquery-core' ) );\n\t$scripts->add( 'jquery-core', '/wp-includes/js/jquery/jquery.js', array(), '3.7.1' );\n}\n");
    for (const [rel, body] of Object.entries(parts)) w(rel, body);
    return { root, w };
}
const CUSTOM = { customPaths: ['wp-content/plugins/plugin-a', 'wp-content/plugins/plugin-b'] };
const policyOf = (root, cfg = CUSTOM) => ownership.loadPolicy(root, cfg).policy;
const obsOf = (root, cfg = CUSTOM) => custom.analyse(root, { policy: policyOf(root, cfg) }).observations;
const mkIssue = (root, symptom = 'other') => store.create({ title: 'dups', description: 'fixture', symptom, environment: 'local', url: 'http://127.0.0.1:9/', root, pages: ['/'] });

group('the facts are recorded (phpast.js) before they are compared');
const phpast = require('../issue/phpast');
const f = phpast.analyse("<?php\nif ( ! defined( 'X_G' ) ) { define( 'X_G', 1 ); }\ndefine( 'X_U', 2 );\nadd_shortcode( 'x_tag', 'cb' );\nadd_action( 'wp_ajax_nopriv_x_act', 'cb' );\nadd_action( 'admin_post_x_post', 'cb' );\nregister_rest_route( 'x/v1', '/r', array() );\nwp_register_script( 'x-h', plugins_url( 'a.js', __FILE__ ), array(), '1' );", 'p.php');
ok(f.shortcodes[0].tag === 'x_tag' && f.ajax.some(a => a.action === 'x_act' && a.nopriv) && f.ajax.some(a => a.action === 'admin-post:x_post') && f.rest[0].namespace === 'x/v1' && f.rest[0].route === '/r' && f.assets[0].handle === 'x-h' && f.assets[0].src.rel === 'a.js', 'shortcode tag, AJAX action (nopriv, admin-post), REST namespace + route and a script handle with its source are recorded');
ok(f.constants.find(c => c.name === 'X_G').guarded === true && f.constants.find(c => c.name === 'X_U').guarded === false, 'a define() inside if ( ! defined( NAME ) ) is recorded as guarded, a bare one is not');

group('custom.js: the five comparisons');
const T = tree({
    'wp-content/plugins/plugin-a/plugin-a.php': head('A') + "add_shortcode( 'acme_form', 'a_form' );\nadd_action( 'wp_ajax_acme_save', 'a_save' );\nadd_action( 'wp_ajax_nopriv_acme_pub', 'a_pub' );\nregister_rest_route( 'acme/v1', '/save', array() );\nwp_register_script( 'acme-js', plugins_url( 'js/a.js', __FILE__ ), array(), '1' );\nwp_register_script( 'jquery', plugins_url( 'js/jq.js', __FILE__ ) );\nwp_register_script( 'shared-name', plugins_url( 'shared/x.js' ) );\ndefine( 'ACME_X', 1 );\ndefine( 'ACME_G', 1 );\nfunction a_form() {}\nfunction a_save() {}\nfunction a_pub() {}\n",
    'wp-content/plugins/plugin-b/plugin-b.php': head('B') + "add_shortcode( 'ACME_FORM', 'b_form' );\nadd_action( 'wp_ajax_acme_save', 'b_save' );\nadd_action( 'wp_ajax_acme_pub', 'b_pub' );\nregister_rest_route( 'acme/v1', 'save', array() );\nwp_register_script( 'acme-js', plugins_url( 'js/b.js', __FILE__ ), array(), '1' );\nwp_register_script( 'jquery', plugins_url( 'js/jq2.js', __FILE__ ) );\nwp_register_script( 'shared-name', plugins_url( 'shared/x.js' ) );\ndefine( 'ACME_X', 2 );\nif ( ! defined( 'ACME_G' ) ) { define( 'ACME_G', 2 ); }\nfunction b_form() {}\nfunction b_save() {}\nfunction b_pub() {}\n",
    'wp-content/plugins/plugin-c/plugin-c.php': head('C') + "add_shortcode( 'zz_tag', 'c_cb' );\nfunction c_cb() {}\n",
    'wp-content/plugins/plugin-d/plugin-d.php': head('D') + "add_shortcode( 'zz_tag', 'd_cb' );\nfunction d_cb() {}\n"
});
const O = obsOf(T.root), by = t => O.filter(o => o.type === t);
ok(by('duplicate-shortcode').some(o => o.shortcode === 'acme_form' && o.components.join() === 'plugin-a,plugin-b' && o.evidence.length === 2 && o.dup_key === 'duplicate-shortcode:acme_form') , 'duplicate shortcode (tags compared without case)');
ok(by('duplicate-ajax-action').length === 1 && by('duplicate-ajax-action')[0].action === 'acme_save', 'duplicate AJAX action; the same action for logged-in vs nopriv visitors is NOT a duplicate');
ok(by('duplicate-rest-route').length === 1 && by('duplicate-rest-route')[0].route === 'acme/v1/save', 'duplicate REST route (a leading slash does not matter)');
ok(by('duplicate-script-handle').map(o => o.handle).join() === 'acme-js', 'duplicate script handle with two different files; the same file in both, and a core handle (jquery), are not reported');
ok(by('duplicate-constant').map(o => o.constant).join() === 'ACME_X' && by('duplicate-constant')[0].risk === 'warning-only', 'duplicate constant, marked warning-only; a constant guarded by defined() is not reported');
ok(by('duplicate-declaration').length === 0, 'no function is declared twice here (the check for that is separate)');
const third = by('duplicate-shortcode').find(o => o.shortcode === 'zz_tag');
ok(third && third.custom === false && third.trusted === false, 'a pair of third-party plugins is recorded but marked custom: false, trusted: false (regex surface only)');
ok(O.every(o => o.evidence.every(e => e.file && e.line)), 'every one of them cites file and line');
ok(JSON.stringify(obsOf(T.root)) === JSON.stringify(O), 'deterministic: a second analysis gives the identical observations');

group('families and the clue requirement (through the real hypotheses step)');
const hypsOf = (parts, { symptom = 'other', hints = null, cfg = CUSTOM } = {}) => {
    const t = tree(parts); const issue = mkIssue(t.root, symptom);
    if (hints) { const d = path.join(store.dirOf(issue.id), 'work'); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'evidence.json'), JSON.stringify({ clues: [], features: [], component_hints: hints.map(c => ({ component: c })) })); }
    fs.writeFileSync(path.join(t.root, 'plugin-guard.config.json'), JSON.stringify(cfg));
    const r = analysis.run(issue.id, { root: t.root });
    return { id: issue.id, root: t.root, hyps: r.hypotheses.hypotheses, considered: r.hypotheses.considered };
};
const constOnly = hypsOf({ 'wp-content/plugins/plugin-a/plugin-a.php': head('A') + "define( 'ACME_X', 1 );\n", 'wp-content/plugins/plugin-b/plugin-b.php': head('B') + "define( 'ACME_X', 2 );\n" });
const hc = constOnly.hyps.find(h => h.type === 'duplicate-constant');
ok(hc && hc.family === 'config' && hc.family !== 'fatal' && /not a crash/.test(hc.mechanism), 'duplicate constant: family "config", never "fatal", and the mechanism says it is not a crash');
ok(hc && hc.score_breakdown.every(b => b.rule !== 'contradiction'), 'it is not penalised as a "fatal" problem that the log disproves');
const tp = { 'wp-content/plugins/plugin-c/plugin-c.php': head('C') + "add_shortcode( 'zz_tag', 'c_cb' );\nfunction c_cb() {}\n", 'wp-content/plugins/plugin-d/plugin-d.php': head('D') + "add_shortcode( 'zz_tag', 'd_cb' );\nfunction d_cb() {}\n" };
ok(!hypsOf(tp, { cfg: { customPaths: [] } }).hyps.some(h => h.type === 'duplicate-shortcode'), 'two third-party plugins sharing a shortcode, nothing in the report points at them: no hypothesis');
ok(hypsOf(tp, { cfg: { customPaths: [] }, hints: ['plugin:plugin-c'] }).hyps.some(h => h.type === 'duplicate-shortcode'), '...the same pair becomes a hypothesis once the evidence names one of them');
ok(!hypsOf(tp, { cfg: { customPaths: [] }, symptom: 'layout' }).hyps.some(h => h.type === 'duplicate-shortcode') , '...and a layout complaint does not pull it in either');

group('validate.js: two verified declaration sites can be CONFIRMED, one cannot');
const dupTree = { 'wp-content/plugins/plugin-a/plugin-a.php': head('A') + "function my_helper() { return 1; }\n", 'wp-content/plugins/plugin-b/plugin-b.php': head('B') + "function my_helper() { return 2; }\n" };
const okLint = () => ({ ok: true, message: '' });
const D = hypsOf(dupTree, { symptom: 'white-screen' });
const dd = D.hyps.find(h => h.type === 'duplicate-declaration');
ok(dd && /^fatal/.test(dd.mechanism ? 'fatal' : '') && !dd.supports.some(s => s.kind === 'log'), 'the fixture has a duplicate declaration and NO log line: the observation is the only kind of support');
const V = validate.run(D.id, { root: D.root, lint: okLint });
const vd = V.hypotheses.find(h => h.type === 'duplicate-declaration');
ok(vd.status === 'CONFIRMED' && vd.checks.some(c => c.id === 'declaration-sites' && c.status === 'PASSED') && vd.validation_notes.some(x => /two deterministic supports/.test(x)), 'both sites re-read and verified: CONFIRMED, with the check and the note');
// one site stops being true after the analysis (the file changed): the same hypothesis must not be CONFIRMED
fs.writeFileSync(path.join(D.root, 'wp-content/plugins/plugin-b/plugin-b.php'), head('B') + "function something_else() { return 2; }\n");
const V2 = validate.run(D.id, { root: D.root, lint: okLint });
const vd2 = V2.hypotheses.find(h => h.type === 'duplicate-declaration');
ok(vd2.status !== 'CONFIRMED' && !vd2.checks.some(c => c.id === 'declaration-sites') && ['UNVERIFIED', 'PROBABLE_NEEDS_REVIEW'].includes(vd2.status), `one site no longer declares the name: not CONFIRMED (${vd2.status})`);
// a finding that cites ONE site only
const one = hypsOf(dupTree, { symptom: 'white-screen' });
const dir = path.join(store.dirOf(one.id), 'work');
const hj = JSON.parse(fs.readFileSync(path.join(dir, 'hypotheses.json'), 'utf8'));
const h1 = hj.hypotheses.find(h => h.type === 'duplicate-declaration'); h1.evidence = [h1.evidence[0]];
fs.writeFileSync(path.join(dir, 'hypotheses.json'), JSON.stringify(hj));
const V3 = validate.run(one.id, { root: one.root, lint: okLint }).hypotheses.find(h => h.type === 'duplicate-declaration');
ok(V3.status !== 'CONFIRMED' && V3.status !== 'REJECTED_FALSE_POSITIVE', `a finding that cites a single site: not CONFIRMED, not rejected either (${V3.status})`);
// guarded on one side: conditional, never "fatal if both load"
const guardedTree = { 'wp-content/plugins/plugin-a/plugin-a.php': head('A') + "function my_helper() { return 1; }\n", 'wp-content/plugins/plugin-b/plugin-b.php': head('B') + "if ( ! function_exists( 'my_helper' ) ) {\nfunction my_helper() { return 2; }\n}\n" };
const G = hypsOf(guardedTree, { symptom: 'white-screen' });
const vg = validate.run(G.id, { root: G.root, lint: okLint }).hypotheses.find(h => h.type === 'duplicate-declaration');
ok(!vg || vg.status !== 'CONFIRMED', `a duplicate that is guarded on one side is not CONFIRMED (${vg ? vg.status : 'not listed'})`);

group('compromise findings carry class "compromise" and are never CONFIRMED by a pattern match');
const shell = { 'wp-content/uploads/2026/shell.php': "<?php eval(base64_decode('ZWNobyAxOw==')); ?>", 'wp-content/plugins/plugin-a/plugin-a.php': head('A') };
const S = hypsOf(shell, { symptom: 'white-screen' });
const sh = S.hyps.filter(h => h.class === 'compromise');
ok(sh.length === 2 && sh.every(h => h.severity === 'P0' && h.type.startsWith('classic:integrity-')), 'the hypotheses for the shell have class "compromise" and severity P0 (the gate of step 7 reads these two fields)');
const VS = validate.run(S.id, { root: S.root, lint: okLint }).hypotheses.filter(h => h.class === 'compromise');
ok(VS.length === 2 && VS.every(h => h.status === 'PROBABLE_NEEDS_REVIEW' || h.status === 'UNVERIFIED'), `validated against the file: ${VS.map(h => h.status).join(', ')} (never CONFIRMED)`);
const pat = VS.find(h => h.type === 'classic:integrity-obfuscated-exec');
ok(pat.evidence_checked.every(e => e.status === 'verified'), 'the obfuscated-exec pattern was re-found in the file near the cited line');
// control: give the SAME hypothesis a second deterministic kind (a log clue). Without class "compromise" it becomes CONFIRMED; with it, it must not.
function craft(cls) {
    const issue = mkIssue(S.root, 'white-screen'), d = path.join(store.dirOf(issue.id), 'work'); fs.mkdirSync(d, { recursive: true });
    const o = JSON.parse(fs.readFileSync(path.join(store.dirOf(S.id), 'work', 'custom-code.json'), 'utf8')).observations.find(x => x.classic_rule === 'integrity-obfuscated-exec');
    fs.writeFileSync(path.join(d, 'custom-code.json'), JSON.stringify({ observations: [o] }));
    fs.writeFileSync(path.join(d, 'evidence.json'), JSON.stringify({ clues: [{ id: 'clue-1', type: 'php-fatal', source: { kind: 'log', ref: 'debug.log' } }] }));
    fs.writeFileSync(path.join(d, 'hypotheses.json'), JSON.stringify({ symptom_reproduced: null, hypotheses: [{ id: 'h1', type: o.type, class: cls, title: o.message, components: [], status: 'PROBABLE_NEEDS_REVIEW', evidence: o.evidence, supports: [{ kind: 'observation', ref: o.id }, { kind: 'log', ref: 'clue-1' }] }] }));
    return validate.run(issue.id, { root: S.root, lint: okLint }).hypotheses[0];
}
ok(craft(null).status === 'CONFIRMED', 'control: the same finding with a second deterministic support and no class would be CONFIRMED');
const capped = craft('compromise');
ok(capped.status === 'PROBABLE_NEEDS_REVIEW' && capped.validation_notes.some(x => /never CONFIRMED/.test(x)), 'with class "compromise" it stays PROBABLE_NEEDS_REVIEW, and the note says why');
// a pattern that is no longer in the file: the finding goes away
fs.writeFileSync(path.join(S.root, 'wp-content/uploads/2026/shell.php'), '<?php // cleaned ?>');
const cleaned = validate.run(S.id, { root: S.root, lint: okLint }).hypotheses.find(h => h.type === 'classic:integrity-obfuscated-exec');
ok(cleaned.status === 'REJECTED_FALSE_POSITIVE', `after the file is cleaned the pattern is gone: ${cleaned.status}`);

group('KEYWORD map covers the new observation types');
for (const [t, line] of [['duplicate-shortcode', "add_shortcode( 'a', 'cb' );"], ['duplicate-rest-route', "register_rest_route( 'a/v1', '/b', array() );"], ['duplicate-ajax-action', "add_action( 'wp_ajax_x', 'cb' );"], ['duplicate-script-handle', "wp_register_script( 'h', 'x.js' );"], ['duplicate-constant', "define( 'X', 1 );"]])
    ok(validate.keywordFor({ type: t }, {}).test(line) && validate.keywordFor({ type: t }, {}).test(`\\${line}`), `${t}: the verifier accepts ${line}`);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
