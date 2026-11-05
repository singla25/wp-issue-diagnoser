#!/usr/bin/env node
// Guard polarity in issue/phpast.js (offline, fixtures only; nothing here changes a status or a verdict).
//   1  a watched CALL is guarded only when the code around it proves the function exists: the body of a positive test (function_exists( 'x' ),
//      through && and an even number of !), or the else of a negated test that is the whole condition or a term of an || chain.
//      !x && y in an else, x || y in a body, elseif, early returns and ternaries prove nothing: those calls stay unguarded (reported).
//   2  DEFINITIONS (functions, classes, constants) keep the old rule: any guard on the same name, in either polarity, marks them guarded
//      (a function defined inside if ( ! function_exists() ) is a polyfill, not a call; duplicate detection depends on it).
//   3  frozen consumers: every output that reads guard data (syntax-tree facts, custom.js duplicate detection, the redirect map, compat, the
//      patch generator's scanner re-run, surface.js and the regex scanner that checks/conflicts.js reads) is compared byte for byte with the
//      output of the code BEFORE this change (fixtures/issue/guard-polarity/frozen-head.json). Only calls[].guarded may differ, and only at
//      the listed places.
// `node scripts/selftest-guard-polarity.js --freeze` rewrites frozen-head.json; it was run once on the code before the change.
const fs = require('fs');
const os = require('os');
const path = require('path');

const phpast = require('../issue/phpast');
const compat = require('../issue/compat');
const custom = require('../issue/custom');
const redirects = require('../issue/redirects');
const patchgen = require('../issue/patchgen');
const surface = require('../issue/surface');
const php = require('../lib/php');
const ownership = require('../lib/ownership');
const readdir = require('../lib/sorted-dir');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const group = t => console.log(`\n== ${t}`);

const FIX = path.join(__dirname, 'fixtures', 'issue', 'guard-polarity');
const FROZEN = path.join(FIX, 'frozen-head.json');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-polarity-'));
const root = path.join(tmp, 'wp');
const w = (rel, body) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); };
w('wp-config.php', '<?php\n'); w('wp-includes/version.php', "<?php\n$wp_version = '6.8.1';\n"); fs.mkdirSync(path.join(root, 'wp-admin'), { recursive: true });
w('wp-includes/script-loader.php', "<?php\nfunction wp_default_scripts( $scripts ) {\n\t$scripts->add( 'jquery-core', '/wp-includes/js/jquery/jquery.js', array(), '3.7.1' );\n}\n");
const files = []; // [rel inside the fixture folder, source]
for (const plugin of readdir(path.join(FIX, 'tree'))) for (const name of readdir(path.join(FIX, 'tree', plugin))) {
    const body = fs.readFileSync(path.join(FIX, 'tree', plugin, name), 'utf8');
    w(`wp-content/plugins/${plugin}/${name}`, body);
    files.push([`wp-content/plugins/${plugin}/${name}`, body]);
}
for (const name of readdir(path.join(FIX, 'single'))) files.push([`single/${name}`, fs.readFileSync(path.join(FIX, 'single', name), 'utf8')]);

// ---- everything that reads guard data ----
const policy = ownership.loadPolicy(root, { customPaths: ['wp-content/plugins/plugin-a', 'wp-content/plugins/plugin-b'] }).policy;
const ast = Object.fromEntries(files.map(([rel, body]) => [rel, phpast.analyse(body, rel, { watch: compat.watch })]));
const analysis = custom.analyse(root, { policy });
for (const c of analysis.components) delete c.updated_at; // file times of the temporary copy
const comp = compat.run(root, analysis, { issue: {} });
const redirectMap = redirects.build(analysis);
const patches = [['function', 'pg_dup_fn', 2], ['function', 'pg_pos_fn', 5], ['class', 'PG_Dup_Class', 11], ['class', 'PG_Pos_Class', 13], ['function', 'pgb_plain_dup', 2]].map(([kind, name, ln]) => {
    const file = name === 'pgb_plain_dup' ? 'wp-content/plugins/plugin-b/plain-dup.php' : 'wp-content/plugins/plugin-b/dup.php';
    return { kind, name, file, line: ln, out: patchgen.generate({ type: 'duplicate-declaration', declaration: { kind, name } }, { file, line: ln }, { root, policy }) };
});
const regex = Object.fromEntries(files.map(([rel, body]) => { const s = php.scanSource(body, rel); return [rel, { functions: s.functions, classes: s.classes, constants: s.constants, hooks: s.hooks, removals: s.removals }]; }));
const surf = Object.fromEntries(files.map(([rel, body]) => [rel, surface.scan(body, rel)]));
const current = JSON.parse(JSON.stringify({ ast, custom: { components: analysis.components, facts: analysis.facts, observations: analysis.observations, steps: analysis.steps }, compat: comp, redirect_map: redirectMap, patches, regex, surface: surf }).split(root).join('<root>'));

if (process.argv.includes('--freeze')) {
    fs.writeFileSync(FROZEN, JSON.stringify(current, null, 1) + '\n');
    console.log(`wrote ${path.relative(process.cwd(), FROZEN)}`);
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(0);
}
const frozen = JSON.parse(fs.readFileSync(FROZEN, 'utf8'));

// calls[].guarded taken out (everything else must be identical)
const strip = v => JSON.parse(JSON.stringify(v), (k, x) => {
    if (k === 'calls' && Array.isArray(x)) return x.map(c => { const { guarded, ...rest } = c; return rest; });
    return x;
});
const callMap = facts => { const m = new Map(); for (const [rel, f] of Object.entries(facts)) for (const c of f.calls) m.set(`${rel}:${c.line}:${c.name}`, c.guarded); return m; };
const g = (rel, line) => { const c = current.ast[rel].calls.filter(x => x.line === line); return c.length === 1 ? c[0].guarded : `no single call on line ${line} (${c.length})`; };
const A = n => `wp-content/plugins/plugin-a/${n}.php`;

group('1. calls: only a provable positive guard counts');
ok(g(A('positive'), 3) === true && g(A('positive'), 6) === true, "if ( function_exists( 'each' ) ) { each() } is guarded, the name compared case-insensitively");
ok(g(A('negated'), 3) === false, "if ( ! function_exists( 'each' ) ) { each() } is NOT guarded: the body runs exactly when each() does not exist");
ok(g(A('else-negated'), 5) === true, 'the else of a test that is the whole negation is guarded');
ok(g(A('else-negated'), 10) === false, 'the else of a positive test is not');
ok(g(A('and-chain'), 3) === true && g(A('and-chain'), 6) === true && g(A('and-chain'), 14) === true, 'a positive test anywhere in an && (or `and`) chain guards the body');
ok(g(A('and-chain'), 11) === false, "the else of ! function_exists( 'x' ) && \$ok is NOT guarded (the && test is false for any reason)");
ok(g(A('or-chain'), 5) === true && g(A('or-chain'), 10) === true, "the else of ! function_exists( 'x' ) || \$off is guarded, whichever term the negation is");
ok(g(A('or-chain'), 13) === false, "\$ok || function_exists( 'x' ) in a body proves nothing: not guarded");
ok(g(A('or-chain'), 16) === true, 'an || chain whose every term is a positive test of the same name does guard the body');
ok(g(A('double-negation'), 3) === true && g(A('double-negation'), 6) === true, 'an even number of ! keeps a positive test positive (! ! and !!)');
ok(g(A('double-negation'), 9) === false && g(A('double-negation'), 14) === true, 'an odd number is a negation: the body is not guarded, the else is');
ok(g(A('elseif'), 5) === false, 'an elseif branch is NOT guarded by the negation of the if before it');
ok(g(A('elseif'), 10) === true, 'an elseif whose own test is positive guards its own body');
ok(g(A('elseif'), 17) === false && g(A('elseif'), 22) === false, 'the else after an elseif, and `else if`, are not guarded by the outer negation (reported)');
ok(g(A('early-return'), 6) === false && g(A('early-return'), 9) === false, 'an early return ( if ( ! function_exists() ) return; x(); ) is not followed: the call stays unguarded (reported)');
ok(g(A('ternary'), 2) === false && g(A('ternary'), 3) === false && g(A('ternary'), 4) === false, 'a ternary, and a call inside the if test itself, stay unguarded (reported)');
ok(g(A('other-name'), 3) === false && g(A('other-name'), 8) === false, 'a guard on a different name guards nothing, body or else');
ok(g(A('nested'), 4) === true && g(A('nested'), 6) === true && g(A('nested'), 13) === true, 'inner ifs keep the guard of the body or else around them');
ok(g(A('nested'), 19) === true, "the else of ! ( function_exists( 'x' ) && \$ok ) is guarded (the else runs only when both are true)");
ok(g(A('class-and-defined'), 3) === true && g(A('class-and-defined'), 6) === false, 'class_exists: positive guards, negated does not');
ok(g(A('class-and-defined'), 9) === true && g(A('class-and-defined'), 12) === false, 'defined: positive guards, negated does not');

group('2. definitions keep the old rule (any polarity)');
const P = current.ast['single/polyfill-each.php'];
ok(P.functions.map(f => `${f.name}:${f.guarded}`).join() === 'each:true,create_function:true', 'a polyfill function defined inside if ( ! function_exists() ) is a guarded definition');
ok(P.calls.length === 1 && P.calls[0].name === 'create_function' && P.calls[0].line === 12 && P.calls[0].guarded === true, 'the polyfill definition itself is not recorded as a call; the call in the else is, and is guarded');
const D = current.ast[A('definitions')];
const fnG = n => (D.functions.find(f => f.name === n) || {}).guarded, clG = n => (D.classes.find(f => f.name === n) || {}).guarded, coG = n => (D.constants.find(f => f.name === n) || {}).guarded;
ok(fnG('pg_dup_fn') === true && fnG('pg_pos_fn') === true && fnG('pg_and_fn') === true && fnG('pg_else_fn') === false, 'functions: guarded under a negated, a positive and an && test; an else is not (unchanged)');
ok(clG('PG_Dup_Class') === true && clG('PG_Pos_Class') === true, 'classes: guarded under either polarity (unchanged)');
ok(coG('PG_DUP_CONST') === true && coG('PG_POS_CONST') === true && coG('PG_ELSE_CONST') === false && coG('PG_BARE_CONST') === false, 'constants: guarded under either polarity, not in an else or bare (unchanged)');

group('3. frozen consumers: identical to the code before the change, except calls[].guarded');
for (const k of ['ast', 'custom', 'redirect_map', 'patches', 'regex', 'surface']) ok(JSON.stringify(strip(current[k])) === JSON.stringify(strip(frozen[k])), `${k}: byte for byte the same (calls[].guarded left out)`);
ok(current.patches.every(p => p.out.validation && p.out.validation.find(v => v.id === 'scanner-rerun').status === 'PASSED'), "patchgen's scanner re-run still sees every wrapped declaration as guarded");
const obsNoRemoved = r => ({ observations: r.observations.filter(o => o.type !== 'removed-function-call'), step: { ...r.step, reason: undefined } });
ok(JSON.stringify(obsNoRemoved(current.compat)) === JSON.stringify(obsNoRemoved(frozen.compat)), 'compat: everything but the removed-function observations (and their count in the step text) is the same');
const EXPECTED_CHANGES = [ // rel:line:name -> before => after
    [A('negated'), 3, 'each', true, false], [A('else-negated'), 5, 'create_function', false, true],
    [A('or-chain'), 5, 'mysql_query', false, true], [A('or-chain'), 10, 'mysql_query', false, true], [A('or-chain'), 13, 'mysql_query', true, false],
    [A('double-negation'), 9, 'ereg', true, false], [A('double-negation'), 14, 'ereg', false, true],
    [A('nested'), 13, 'mysql_select_db', false, true], [A('nested'), 19, 'mysql_select_db', false, true],
    [A('class-and-defined'), 6, 'mysql_fetch_array', true, false], [A('class-and-defined'), 12, 'mysql_fetch_array', true, false],
    ['single/polyfill-each.php', 12, 'create_function', false, true]
].map(([rel, line, name, a, b]) => `${rel}:${line}:${name} ${a}=>${b}`).sort();
const before = callMap(frozen.ast), after = callMap(current.ast);
const changed = [...after].filter(([k, v]) => before.get(k) !== v).map(([k, v]) => `${k} ${before.get(k)}=>${v}`).sort();
ok(before.size === after.size && [...before.keys()].every(k => after.has(k)), `the same ${after.size} calls are recorded`);
ok(JSON.stringify(changed) === JSON.stringify(EXPECTED_CHANGES), `calls[].guarded differs only at the ${EXPECTED_CHANGES.length} listed places${JSON.stringify(changed) === JSON.stringify(EXPECTED_CHANGES) ? '' : `: ${changed.join(' | ')}`}`);
const mergedCalls = new Map(); for (const [ref, m] of Object.entries(current.custom.facts)) for (const c of m.calls) mergedCalls.set(`${c.file}:${c.line}:${c.name}`, c.guarded);
ok([...mergedCalls].every(([k, v]) => after.get(k) === v), 'custom.js merged facts carry the same calls[].guarded as the per-file facts');
const defined = new Set(); for (const m of Object.values(current.custom.facts)) for (const f of m.functions) defined.add(String(f.name).toLowerCase());
const want = new Map();
for (const [ref, m] of Object.entries(current.custom.facts)) for (const c of m.calls) if (!c.guarded && compat.watch(c.name) && !defined.has(c.name)) { const k = `${ref}|${c.name}`; if (!want.has(k)) want.set(k, []); want.get(k).push(`${c.file}:${c.line}`); }
const got = new Map(current.compat.observations.filter(o => o.type === 'removed-function-call').map(o => [`${o.components[0]}|${o.function}`, o.evidence.map(e => `${e.file}:${e.line}`)]));
ok(got.size === want.size && [...want].every(([k, v]) => JSON.stringify(got.get(k)) === JSON.stringify(v.slice(0, 5))), `compat reports exactly the unguarded watched calls (${got.size} observation(s))`);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${failures ? `${failures} FAILED` : 'all passed'}`);
process.exit(failures ? 1 : 0);
