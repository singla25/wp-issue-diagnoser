#!/usr/bin/env node
// Self-test of issue mode, step 8, part 1: the validation step (Phase H). The first group is the REGRESSION TEST for the known verifier trap:
// the verifier's keyword map must be at least as broad as what the scanner records.
const fs = require('fs');
const path = require('path');
const v = require('../issue/validate');
let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const group = t => console.log(`\n== ${t}`);

group('KEYWORD trap: the verifier accepts every spelling the scanner records');
const hook = (role, lines) => lines.forEach(l => ok(v.keywordFor({ type: 'remove-wrong-priority' }, { role })?.test(l), `${role}: ${JSON.stringify(l)}`));
hook('adds', ["add_action('init', 'f');", "\\add_action('init', 'f');", "add_filter( 'the_content', 'f', 20 );", "add_action ( 'admin_post_save_x', 'f' );", "add_action('wp_ajax_nopriv_foo', 'f');", "\tadd_action(", "if ($a) { add_action('x','y'); }"]);
hook('removes', ["remove_action('init', 'f', 5);", "\\remove_action('init', 'f');", "remove_filter( 'the_content', 'wpautop' );", "remove_action ( 'admin_post_x', 'f' );", "\tremove_action("]);
const asset = l => ok(v.keywordFor({ type: 'handle-replaced' }, { role: 'deregister' })?.test(l), `asset: ${JSON.stringify(l)}`);
["wp_deregister_script('jquery');", "\\wp_deregister_script( 'jquery' );", "wp_dequeue_style('x');", "wp_register_script('a','b');", "\\wp_enqueue_style ('a');", "wp_deregister_style('x');", "wp_enqueue_script('a');", "wp_dequeue_script('a');"].forEach(asset);
ok(v.keywordFor({ type: 'duplicate-declaration', declaration: { kind: 'function', name: 'my_helper' } }, {}).test('function my_helper() {') && v.keywordFor({ type: 'duplicate-declaration', declaration: { kind: 'function', name: 'Acme\\my_helper' } }, {}).test('function my_helper($a) {') && v.keywordFor({ type: 'duplicate-declaration', declaration: { kind: 'class', name: 'Acme_Box' } }, {}).test('final class Acme_Box extends X {'), 'declarations: function, namespaced function, class');
ok(!v.keywordFor({ type: 'remove-wrong-priority' }, { role: 'removes' }).test('// we used to call remove_action here'), 'a bare mention inside a comment word does not need a "(" call: still not a call');

group('derived from the scanner source: every call family phpast.js recognises is covered');
const src = fs.readFileSync(path.join(__dirname, '..', 'issue', 'phpast.js'), 'utf8');
const assetFns = Object.keys(eval('(' + /const ASSET_FN = (\{[^}]*\})/.exec(src)[1].replace(/\[[^\]]*\]/g, '0') + ')'));
ok(assetFns.length >= 8, `phpast.js records ${assetFns.length} asset functions`);
for (const fn of assetFns) ok(v.keywordFor({ type: 'handle-removed' }, { role: 'enqueue' }).test(`${fn}('h');`) && v.keywordFor({ type: 'handle-removed' }, { role: 'enqueue' }).test(`\\${fn} ('h');`), `scanner records ${fn}(): verifier accepts it`);
ok(/\^\(add\|remove\)_\(action\|filter\)\$/.test(src), 'phpast.js still recognises exactly add_/remove_ action|filter (if this changes, extend the verifier map)');


group('determinism: no unsorted directory listing in issue mode');
const files = [...fs.readdirSync(path.join(__dirname, '..', 'issue')).filter(f => f.endsWith('.js')).map(f => path.join('issue', f)), 'lib/components.js'];
const raw = files.filter(f => /fs\.readdirSync\(/.test(fs.readFileSync(path.join(__dirname, '..', f), 'utf8')) && !/result\.js$/.test(f));
ok(raw.length === 0, `no issue-mode file calls fs.readdirSync directly (all go through lib/sorted-dir.js)${raw.length ? ': ' + raw.join(', ') : ''}`);
const sd = require('../lib/sorted-dir'), os = require('os'), tdir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-sd-'));
for (const n of ['b', 'B', 'a', '_x', 'Z', 'a2', 'a10']) fs.writeFileSync(path.join(tdir, n), '');
ok(sd(tdir).join() === ['B', 'Z', '_x', 'a', 'a10', 'a2', 'b'].join() && sd(tdir, { withFileTypes: true }).map(e => e.name).join() === 'B,Z,_x,a,a10,a2,b', 'sorted-dir: fixed code-point order, with and without withFileTypes');
fs.rmSync(tdir, { recursive: true, force: true });

console.log(failures ? `\n${failures} FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
