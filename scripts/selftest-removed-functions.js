#!/usr/bin/env node
// Step 5-C: data/removed-wp-functions.json and the matching of calls to removed functions (issue/compat.js + the call recording of issue/phpast.js).
// Offline fixtures only. Positive, negative and clean-site cases for every rule.
const fs = require('fs');
const os = require('os');
const path = require('path');

const compat = require('../issue/compat');
const phpast = require('../issue/phpast');
const custom = require('../issue/custom');
const ownership = require('../lib/ownership');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const group = t => console.log(`\n== ${t}`);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-removed-'));
const head = (n, x = '') => `<?php\n/**\n * Plugin Name: ${n}\n * Version: 1.0.0\n${x} */\ndefined('ABSPATH') || exit;\n`;
let n = 0;
function tree(parts) {
    const root = path.join(tmp, `wp${++n}`); const w = (rel, body) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); };
    w('wp-config.php', '<?php\n'); w('wp-includes/version.php', "<?php\n$wp_version = '6.8.1';\n"); fs.mkdirSync(path.join(root, 'wp-admin'), { recursive: true });
    for (const [rel, body] of Object.entries(parts)) w(rel, body);
    return root;
}
const CUSTOM = { customPaths: ['wp-content/plugins/plugin-a', 'wp-content/plugins/plugin-b'] };
const analyse = (root, cfg = CUSTOM) => custom.analyse(root, { policy: ownership.loadPolicy(root, cfg).policy });
const run = (root, o = {}, cfg = CUSTOM) => compat.run(root, analyse(root, cfg), { issue: {}, ...o });
const removed = r => r.observations.filter(o => o.type === 'removed-function-call');

group('the data file');
const data = compat.load();
const E = data.entries;
ok(Array.isArray(E) && E.length >= 5 && new Set(E.map(e => e.id)).size === E.length, `${E.length} entries, unique ids`);
ok(E.every(e => e.id && ['php', 'wordpress'].includes(e.kind) && e.match && /^\d+\.\d+$/.test(e.removed_in) && /^https:\/\//.test(e.source.url) && e.claim && typeof e.verified === 'boolean' && e.verified_note), 'every entry has an id, kind, match, removed_in, source URL, claim phrase, verified flag and a note');
const by = id => E.find(e => e.id === id);
ok(by('php-each').removed_in === '8.0' && by('php-create-function').removed_in === '8.0' && by('php-mysql').removed_in === '7.0' && by('php-ereg').removed_in === '7.0' && by('php-split').removed_in === '7.0', 'each / create_function are removed in 8.0; mysql_*, ereg*, split in 7.0');
ok(by('php-split').verified === false && E.filter(e => e.verified).length === 4, 'split is NOT verified (no page that could be read states it); the other four are');
ok(!E.some(e => e.kind === 'wordpress'), 'no WordPress-level entry: none is verified yet');
ok(!JSON.stringify(E).includes('get_currentuserinfo') || E.every(e => !((e.match.exact || []).includes('get_currentuserinfo'))), 'get_currentuserinfo (deprecated but still defined) is not listed');
ok(fs.readFileSync(path.join(__dirname, '..', 'KNOWLEDGE-REVIEW.md'), 'utf8').includes('Appendix: removed functions') && E.every(e => fs.readFileSync(path.join(__dirname, '..', 'KNOWLEDGE-REVIEW.md'), 'utf8').includes('`' + e.id + '`')), 'KNOWLEDGE-REVIEW.md lists every entry (it is generated; a test in selftest-issue-evidence.js fails if it is stale)');

group('the matcher: exact names, a prefix with exceptions, unverified entries');
const w = compat.watch;
ok(w('each') && w('create_function') && w('mysql_connect') && w('mysql_query') && w('ereg') && w('eregi_replace'), 'each, create_function, mysql_*, the four ereg functions match');
ok(!w('mysql_to_rfc3339'), 'mysql_to_rfc3339 (a WordPress function) is excepted from mysql_*');
ok(!w('split') && !w('spliti'), 'split is unverified: never matched');
ok(!w('eachother') && !w('eregister') && !w('mysqli_connect') && !w('str_split') && !w('strlen'), 'near misses do not match (eachother, eregister, mysqli_connect, str_split)');
ok(compat.matcher([{ id: 'x', kind: 'php', match: { exact: ['foo'] }, removed_in: '8.0', verified: false }])('foo') === null, 'a verified:false entry is never matched, whatever it lists');

group('call recording in phpast.js: plain calls only');
const rec = src => phpast.analyse(`<?php\n${src}`, 'f.php', { watch: compat.watch }).calls;
ok(rec('each($a);').length === 1 && rec('each($a);')[0].name === 'each' && rec('each($a);')[0].line === 2 && rec('each($a);')[0].guarded === false, 'a plain call is recorded, with its line');
ok(rec('$x->each();').length === 0 && rec('$this->each($a);').length === 0, 'a method call is not recorded');
ok(rec('Foo::split($a);').length === 0 && rec('static::each($a);').length === 0, 'a static call is not recorded');
ok(rec('Ns\\each($a);').length === 0, 'a namespaced call is not recorded');
ok(rec('\\each($a);').length === 1, 'a fully-qualified global call (\\each) is');
ok(rec("// each($a);\n$s = 'each($a)';").length === 0, 'a call inside a comment or a string is not');
ok(rec("if ( ! function_exists( 'each' ) ) { each($a); }")[0].guarded === false && rec("if ( function_exists( 'each' ) ) { each($a); }")[0].guarded === true, 'a call inside an if that tests function_exists( the same name ) is guarded only by a positive test (a negated test runs its body exactly when the function is missing)');
ok(rec("if ( ! function_exists( 'each' ) ) { $x = 1; } else { each($a); }")[0].guarded === true, 'the else of if ( ! function_exists( the same name ) ) is guarded');
ok(rec("if ( ! function_exists( 'other' ) ) { each($a); }")[0].guarded === false, 'a guard on a different name guards nothing');
ok(rec('strlen($a); each($a);').length === 1, 'only watched names are recorded');
ok(phpast.analyse('<?php each($a);', 'f.php').calls.length === 0, 'without a watch function nothing is recorded (all other callers are unchanged)');

group('compat.run: which PHP version, which calls fire');
const BAD = { 'wp-content/plugins/plugin-a/plugin-a.php': head('A') + "function a_run( $list ) { while ( list( $k, $v ) = each( $list ) ) { echo $k; } $f = create_function( '$a', 'return $a;' ); mysql_connect( 'h' ); }\n" };
const rt = tree(BAD);
const d83 = removed(run(rt));
ok(d83.map(o => o.function).sort().join() === 'create_function,each,mysql_connect', `no version given: the sandbox PHP (8.3) applies and all three fire (${d83.map(o => o.function).sort().join()})`);
ok(d83.every(o => o.advisory === true && o.components.join() === 'plugin-a' && o.evidence[0].file === 'wp-content/plugins/plugin-a/plugin-a.php' && o.evidence[0].line && /sandbox/.test(o.php_source) && o.source_url && o.claim), 'every one is advisory, cites file and line, names the source of the PHP version, the data source and the claim');
ok(removed(run(rt, { issue: { php_version: '8.1' } })).length === 3 && /reporter/.test(removed(run(rt, { issue: { php_version: '8.1' } }))[0].php_source), 'the reporter says 8.1: all three fire, and the source says it was the reporter');
ok(removed(run(rt, { issue: { php_version: '7.4' } })).map(o => o.function).sort().join() === 'mysql_connect', 'the reporter says 7.4: each and create_function still exist there, mysql_connect does not');
ok(removed(run(rt, { issue: { php_version: '5.6' } })).length === 0, 'the reporter says 5.6: nothing fires');
const noPhp = run(rt, { php: null });
ok(removed(noPhp).length === 0 && /no PHP version is known/.test(noPhp.step.reason), 'no PHP version known at all: no PHP rule fires, and the step says so (the host PHP is never used)');
const src = fs.readFileSync(path.join(__dirname, '..', 'issue', 'compat.js'), 'utf8').replace(/\/\/.*$/gm, '');
ok(!/child_process|spawnSync|execSync|execFile|process\.version|php -v/.test(src), 'compat.js never asks the machine for its PHP version');
const calls = analyse(rt).facts['plugin-a'].calls;
ok(calls.length === 3 && calls.every(c => c.file && c.line), 'the calls are kept in custom-code.json facts, with file and line');

group('negative cases');
const NEG = {
    'wp-content/plugins/plugin-a/plugin-a.php': head('A') + "class A { function go( $o, $s ) { $o->each( $s ); Foo::split( $s ); return \\Ns\\each( $s ); } }\nif ( function_exists( 'each' ) ) { each( $x ); }\nsplit( 'a', 'b' );\nmysql_to_rfc3339( '2026-01-01' );\nstrlen( 'x' );\n",
    'wp-content/plugins/plugin-b/plugin-b.php': head('B') + "function ereg( $p, $s ) { return preg_match( '/' . $p . '/', $s ); }\nfunction a_two() { return ereg( 'a', 'b' ); }\n"
};
const rn = run(tree(NEG));
ok(removed(rn).length === 0, `method call, static call, namespaced call, guarded call, unverified split, mysql_to_rfc3339 and a function the site defines itself (a polyfill in another component): nothing fires (${removed(rn).map(o => o.function).join() || 'none'})`);
const poly = tree({ 'wp-content/plugins/plugin-a/plugin-a.php': head('A') + "function a() { return each( $x ); }\n", 'wp-content/plugins/plugin-b/plugin-b.php': head('B') + "function each( &$a ) { return false; }\n" });
ok(removed(run(poly)).length === 0, 'plugin-b polyfills each(): plugin-a\'s call to it is harmless, so it does not fire');
const third = tree({ 'wp-content/plugins/plugin-c/plugin-c.php': head('C') + "function c() { return each( $x ); }\n" });
ok(removed(run(third, {}, { customPaths: [] })).length === 0, 'a third-party plugin nothing points at is not read with the syntax tree: no calls, nothing fires');
ok(removed(run(tree({ 'wp-content/plugins/plugin-c/plugin-c.php': head('C') + "function c() { return each( $x ); }\n" }), {}, { customPaths: ['wp-content/plugins/plugin-c'] })).length === 1, '...the same plugin as custom code is read, and it fires');

group('clean site');
const clean = run(tree({ 'wp-content/plugins/plugin-a/plugin-a.php': head('A') + "function a() { return strlen( 'x' ); }\n" }));
ok(clean.observations.length === 0 && clean.step.status === 'PASSED', 'a clean site: no observation, step PASSED');
ok(JSON.stringify(run(rt)) === JSON.stringify(run(rt)), 'deterministic: the same tree gives the identical result');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
