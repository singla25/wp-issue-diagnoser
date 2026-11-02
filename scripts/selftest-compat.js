#!/usr/bin/env node
// Step 5-C: version headers (Requires PHP, Requires at least, Tested up to), the issue's php_version / --php, and how an ADVISORY travels through
// hypotheses and validate: it needs a clue to become a hypothesis, it never outranks a real one, it is never CONFIRMED, and a removed-function
// call that a log fatal (or a probe, or the bisection) corroborates loses the flag and takes the normal path. Offline fixtures only.
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-compat-'));
process.env.PLUGIN_GUARD_ISSUES = path.join(tmp, 'issues');
const store = require('../lib/issue-store');
const compat = require('../issue/compat');
const custom = require('../issue/custom');
const analysis = require('../issue/analysis');
const validate = require('../issue/validate');
const ownership = require('../lib/ownership');
const { parse } = require('./guard');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const group = t => console.log(`\n== ${t}`);
const head = (n, x = '') => `<?php\n/**\n * Plugin Name: ${n}\n * Version: 1.0.0\n${x} */\ndefined('ABSPATH') || exit;\n`;
let n = 0;
function tree(parts, wp = '6.8.1') {
    const root = path.join(tmp, `wp${++n}`); const w = (rel, body) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); };
    w('wp-config.php', '<?php\n'); w('wp-includes/version.php', `<?php\n$wp_version = '${wp}';\n`); fs.mkdirSync(path.join(root, 'wp-admin'), { recursive: true });
    for (const [rel, body] of Object.entries(parts)) w(rel, body);
    return root;
}
const CUSTOM = { customPaths: ['wp-content/plugins/plugin-a', 'wp-content/plugins/plugin-b'] };
const compatOf = (root, o = {}) => compat.run(root, custom.analyse(root, { policy: ownership.loadPolicy(root, CUSTOM).policy }), { issue: {}, ...o });
const types = r => r.observations.map(o => o.type).sort();
const okLint = () => ({ ok: true, message: '' });

group('headers');
const HDR = tree({
    'wp-content/plugins/plugin-a/plugin-a.php': head('A', ' * Requires PHP: 9.0\n * Requires at least: 99.0\n') + "function a() {}\n",
    'wp-content/plugins/plugin-a/readme.txt': '=== A ===\nTested up to: 5.9\nStable tag: 1.0.0\n',
    'wp-content/plugins/plugin-b/plugin-b.php': head('B', ' * Requires PHP: 7.0\n * Requires at least: 5.0\n') + "function b() {}\n",
    'wp-content/plugins/plugin-b/readme.txt': '=== B ===\nTested up to: 6.8\n'
});
const rh = compatOf(HDR);
ok(types(rh).join() === 'requires-php-mismatch,requires-wp-mismatch,tested-up-to-older', `plugin-a: Requires PHP 9.0 (sandbox 8.3), Requires at least 99.0 (site 6.8.1) and Tested up to 5.9 are reported (${types(rh).join(', ')})`);
ok(rh.observations.every(o => o.components.join() === 'plugin-a' && o.advisory === true), 'plugin-b (PHP 7.0, WordPress 5.0, tested 6.8) is not reported; everything reported is advisory');
ok(rh.observations.find(o => o.type === 'requires-php-mismatch').evidence[0].file === 'wp-content/plugins/plugin-a/plugin-a.php' && rh.observations.find(o => o.type === 'tested-up-to-older').evidence[0].file === 'wp-content/plugins/plugin-a/readme.txt', 'each cites the file that says it: the plugin file, or readme.txt for Tested up to');
ok(types(compatOf(HDR, { issue: { php_version: '9.1' } })).join() === 'requires-wp-mismatch,tested-up-to-older', 'the reporter says PHP 9.1: the PHP requirement is met');
ok(/WordPress 6\.8\.1/.test(rh.step.reason) && /PHP 8\.3/.test(rh.step.reason), 'the step says which PHP and WordPress versions it compared with');
const cleanH = compatOf(tree({ 'wp-content/plugins/plugin-a/plugin-a.php': head('A', ' * Requires PHP: 7.4\n * Requires at least: 6.0\n') + "function a() {}\n", 'wp-content/plugins/plugin-a/readme.txt': '=== A ===\nTested up to: 6.8\n' }));
ok(cleanH.observations.length === 0, 'clean site: PHP 7.4, WordPress 6.0, tested 6.8 on WordPress 6.8.1: nothing');
ok(types(compatOf(tree({ 'wp-content/plugins/plugin-a/plugin-a.php': head('A') + "function a() {}\n", 'wp-content/plugins/plugin-a/readme.txt': '=== A ===\nTested up to: 6.8.0\n' }), {})).length === 0, '"Tested up to" is compared by major.minor: 6.8.0 on 6.8.1 is fine');
ok(compatOf(HDR, { php: null }).observations.every(o => o.type !== 'requires-php-mismatch'), 'with no PHP version known, the PHP header is not compared (the host PHP is never used)');

group('php_version in the issue record and --php');
const mk = (extra = {}) => store.create({ title: 't', description: 'd', symptom: 'white-screen', environment: 'local', url: 'http://127.0.0.1:9/', root: HDR, pages: ['/'], ...extra });
ok(mk({ phpVersion: '8.1' }).php_version === '8.1' && mk({ phpVersion: ' 7.4.33 ' }).php_version === '7.4.33' && mk().php_version === null, 'the issue stores the PHP version the reporter gave (or null)');
let bad = null; try { mk({ phpVersion: 'eight' }); } catch (e) { bad = e.message; }
ok(bad && /PHP version/.test(bad), `a PHP version that is not a version is refused (${bad ? bad.split('\n')[0] : 'accepted'})`);
ok(parse(['issue', 'new', '--php', '8.1']).php === '8.1', 'the command line takes --php');
ok(/--php/.test(fs.readFileSync(path.join(__dirname, '..', 'lib', 'issue-cli.js'), 'utf8')), 'the usage text mentions --php');

group('an advisory needs a clue to become a hypothesis (through the real hypotheses step)');
const PARTS = {
    'wp-content/plugins/plugin-a/plugin-a.php': head('A', ' * Requires PHP: 9.0\n') + "function a_run( $list ) { while ( list( $k, $v ) = each( $list ) ) { echo $k; } }\nfunction dup_helper() { return 1; }\n",
    'wp-content/plugins/plugin-b/plugin-b.php': head('B') + "function dup_helper() { return 2; }\n"
};
function pipeline(parts, { clues = [], hints = [], symptom = 'white-screen' } = {}) {
    const root = tree(parts); fs.writeFileSync(path.join(root, 'plugin-guard.config.json'), JSON.stringify(CUSTOM));
    const issue = store.create({ title: 't', description: 'd', symptom, environment: 'local', url: 'http://127.0.0.1:9/', root, pages: ['/'] });
    const d = path.join(store.dirOf(issue.id), 'work'); fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'evidence.json'), JSON.stringify({ clues, features: [], component_hints: hints.map(c => ({ component: c })) }));
    const r = analysis.run(issue.id, { root });
    return { id: issue.id, root, hyps: r.hypotheses.hypotheses, obs: r.analysis.observations, dir: d };
}
const none = pipeline(PARTS, {});
ok(none.obs.some(o => o.type === 'removed-function-call') && none.obs.some(o => o.type === 'requires-php-mismatch'), 'with no clue the observations exist (in custom-code.json)...');
ok(!none.hyps.some(h => h.advisory) && !none.hyps.some(h => /removed-function|requires-php/.test(h.type)), '...but none becomes a hypothesis');
ok(JSON.parse(fs.readFileSync(path.join(store.dirOf(none.id), 'work', 'custom-code.json'), 'utf8')).observations.some(o => o.type === 'removed-function-call' && o.advisory === true), 'custom-code.json keeps them, marked advisory');
const named = pipeline(PARTS, { hints: ['plugin:plugin-a'] });
const adv = named.hyps.filter(h => h.advisory);
ok(adv.some(h => h.type === 'removed-function-call') && adv.some(h => h.type === 'requires-php-mismatch'), 'once the evidence names plugin-a, both advisories become hypotheses, with advisory: true');
ok(adv.every(h => h.status === 'UNVERIFIED'), 'an advisory hypothesis starts UNVERIFIED');
const realIdx = named.hyps.findIndex(h => h.type === 'duplicate-declaration'), firstAdv = named.hyps.findIndex(h => h.advisory);
ok(realIdx >= 0 && firstAdv > realIdx && named.hyps.slice(0, firstAdv).every(h => !h.advisory), 'a real hypothesis (the duplicate function) is listed before every advisory, whatever the scores');
const V = validate.run(named.id, { root: named.root, lint: okLint }).hypotheses.filter(h => h.advisory);
ok(V.length === adv.length && V.every(h => h.status !== 'CONFIRMED' && h.status !== 'REPRODUCIBLE' && h.advisory === true), `validate keeps the flag and never confirms an uncorroborated advisory (${V.map(h => h.status).join(', ')})`);
ok(/advisory/.test(fs.readFileSync(path.join(__dirname, '..', 'issue', 'result.js'), 'utf8')), 'result.js carries the flag to the result');

group('a log fatal that names the function corroborates a removed-function call');
const logClues = [
    { id: 'clue-undef', type: 'php-undefined-function', value: 'each', detail: { kind: 'function' }, source: { kind: 'log', ref: 'wp-content/debug.log', line: 3 }, confidence: 'certain', snippet: 'PHP Fatal error: Uncaught Error: Call to undefined function each()' },
    { id: 'clue-path', type: 'component-path', value: 'plugin:plugin-a', detail: { path: 'wp-content/plugins/plugin-a/plugin-a.php' }, source: { kind: 'log', ref: 'wp-content/debug.log', line: 3 }, confidence: 'certain', snippet: '' }
];
const corr = pipeline(PARTS, { clues: logClues });
const hr = corr.hyps.find(h => h.type === 'removed-function-call');
ok(hr && hr.advisory === false && hr.supports.some(s => s.kind === 'log' && s.ref === 'clue-undef'), 'the log fatal "Call to undefined function each()" is a support and the advisory flag is cleared');
ok(corr.hyps.find(h => h.type === 'requires-php-mismatch') && corr.hyps.find(h => h.type === 'requires-php-mismatch').advisory === true, 'a version header stays advisory even then (it is the plugin\'s own statement)');
const vr = validate.run(corr.id, { root: corr.root, lint: okLint }).hypotheses.find(h => h.type === 'removed-function-call');
ok(vr.advisory === false && vr.status === 'CONFIRMED', `validate: the call is re-read in the file and the log clue is still in evidence.json: ${vr.status}`);
const other = pipeline(PARTS, { clues: [{ ...logClues[0], id: 'clue-other', value: 'other_fn' }, logClues[1]] });
ok(other.hyps.find(h => h.type === 'removed-function-call').advisory === true, 'a log fatal that names a DIFFERENT function does not corroborate it');
// control for the cap: the same corroborated hypothesis, flagged advisory by hand, must not be CONFIRMED
const dd = path.join(store.dirOf(corr.id), 'work'); const hj = JSON.parse(fs.readFileSync(path.join(dd, 'hypotheses.json'), 'utf8'));
hj.hypotheses.find(h => h.type === 'removed-function-call').advisory = true; fs.writeFileSync(path.join(dd, 'hypotheses.json'), JSON.stringify(hj));
const capped = validate.run(corr.id, { root: corr.root, lint: okLint }).hypotheses.find(h => h.type === 'removed-function-call');
ok(capped.status === 'PROBABLE_NEEDS_REVIEW' && capped.validation_notes.some(x => /advisory/.test(x)), 'control: the same hypothesis with advisory: true is capped at PROBABLE_NEEDS_REVIEW, with the note');

group('wording: a finding that rests on the sandbox default says so');
const PHRASE = "on PHP 8.3 (sandbox); the site's own PHP version is unknown";
const defObs = compatOf(tree({ ...PARTS }));
const rem = defObs.observations.find(o => o.type === 'removed-function-call'), req = defObs.observations.find(o => o.type === 'requires-php-mismatch');
ok(rem.message.includes(PHRASE) && req.message.includes(PHRASE), 'the observation messages (removed function, Requires PHP) carry the exact sentence when the reporter gave no PHP version');
ok(defObs.step.reason.includes(PHRASE), 'the step line carries it too');
const hDef = pipeline(PARTS, { hints: ['plugin:plugin-a'] }).hyps.filter(h => /removed-function|requires-php/.test(h.type));
ok(hDef.length === 2 && hDef.every(h => h.mechanism.includes(PHRASE)), 'both hypotheses (the text a report prints) carry it');
const rv = validate.run(pipeline(PARTS, { hints: ['plugin:plugin-a'] }).id, { root: tree(PARTS), lint: okLint });
ok(typeof rv.hypotheses === 'object', 'validate still runs on them');
const stated = compat.run(tree(PARTS), custom.analyse(tree(PARTS), { policy: ownership.loadPolicy(tree(PARTS), CUSTOM).policy }), { issue: { php_version: '8.1' } });
const sObs = stated.observations.find(o => o.type === 'removed-function-call');
ok(sObs.message.includes('on PHP 8.1 (stated by the reporter)') && !/sandbox|unknown/.test(sObs.message + stated.step.reason), 'with a stated PHP version the text says "stated by the reporter" and never mentions the sandbox or "unknown"');
const sPipe = (() => { const root = tree(PARTS); fs.writeFileSync(path.join(root, 'plugin-guard.config.json'), JSON.stringify(CUSTOM)); const issue = store.create({ title: 't', description: 'd', symptom: 'white-screen', environment: 'local', url: 'http://127.0.0.1:9/', root, pages: ['/'], phpVersion: '8.1' }); const d = path.join(store.dirOf(issue.id), 'work'); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'evidence.json'), JSON.stringify({ clues: [], features: [], component_hints: [{ component: 'plugin:plugin-a' }] })); return analysis.run(issue.id, { root }).hypotheses.hypotheses; })();
ok(sPipe.filter(h => /removed-function|requires-php/.test(h.type)).every(h => h.mechanism.includes('on PHP 8.1 (stated by the reporter)') && !/sandbox/.test(h.mechanism)), 'through the whole step: the issue\'s php_version reaches the hypothesis text');

group('clean site through the whole step');
const cleanP = pipeline({ 'wp-content/plugins/plugin-a/plugin-a.php': head('A') + "function a() { return 1; }\n" }, { hints: ['plugin:plugin-a'] });
ok(!cleanP.hyps.some(h => h.advisory) && cleanP.obs.every(o => !o.advisory), 'a clean site gives no advisory observation and no advisory hypothesis, even with the plugin named');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
