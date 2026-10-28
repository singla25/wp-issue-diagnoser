#!/usr/bin/env node
// Seeded-bug test on REAL code: copy a real plugin (and WordPress's own script-loader.php) from a real local WordPress tree into a temp
// folder, insert known bugs into the COPY, and prove each one is found with the right components and file:line, and that the unseeded
// copy has none of them. The original tree is fingerprinted (path, size, mtime of every file) before and after and must not change.
//
//   PG_REAL_SITE=/path/to/a/wordpress/root  PG_REAL_PLUGIN=<slug of one of its plugins>  node scripts/selftest-issue-seeded.js
// Both are required and there is NO default: a real site's name and path must not be written into the repository.
// If they are not set, or the plugin is not there, the test is SKIPPED, loudly, and exits 0: a skipped test proves nothing.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const SITE = process.env.PG_REAL_SITE || '', SLUG = process.env.PG_REAL_PLUGIN || '';
if (!SITE || !SLUG || !fs.existsSync(path.join(SITE, 'wp-content', 'plugins', SLUG))) { console.log(`SKIP  PG_REAL_SITE / PG_REAL_PLUGIN are ${SITE && SLUG ? 'set but the plugin is not there' : 'not set'}: the seeded-bug test did NOT run (set both to a real site root and one of its plugin slugs)`); process.exit(0); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-seed-'));
const custom = require('../issue/custom');
const phpast = require('../issue/phpast');
const ownership = require('../lib/ownership');

let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) failures++; };
const group = t => console.log(`\n== ${t}`);
function fingerprint(dir) {
    const h = crypto.createHash('sha256'); let n = 0;
    (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) { const f = path.join(d, e.name), st = fs.lstatSync(f); h.update(`${path.relative(dir, f)}|${st.size}|${st.mtimeMs}|`); n++; if (e.isDirectory() && !e.isSymbolicLink()) walk(f); } })(dir);
    return { hash: h.digest('hex'), files: n };
}

group(`real code: ${SITE} / ${SLUG}`);
const before = fingerprint(SITE);
console.log(`      original tree fingerprint ${before.hash.slice(0, 16)} (${before.files} entries)`);

// ---- the copy: the real plugin + the real core loader files ----
const copy = path.join(tmp, 'site');
fs.mkdirSync(path.join(copy, 'wp-includes', 'assets'), { recursive: true });
fs.writeFileSync(path.join(copy, 'wp-config.php'), '<?php // copy');
for (const f of ['wp-includes/version.php', 'wp-includes/script-loader.php', 'wp-includes/assets/script-loader-packages.php']) if (fs.existsSync(path.join(SITE, f))) fs.copyFileSync(path.join(SITE, f), path.join(copy, f));
fs.cpSync(path.join(SITE, 'wp-content', 'plugins', SLUG), path.join(copy, 'wp-content', 'plugins', SLUG), { recursive: true, dereference: false, filter: s => !fs.lstatSync(s).isSymbolicLink() });
const pluginDir = path.join(copy, 'wp-content', 'plugins', SLUG);
const policyFor = list => ownership.loadPolicy(copy, { customPaths: list }).policy;

// ---- pick real things to attack ----
const baseline = custom.analyse(copy, { policy: policyFor([`wp-content/plugins/${SLUG}`]) });
const facts = baseline.facts[SLUG];
const cls = facts.classes.find(c => c.kind === 'class' && !c.guarded && /\\/.test(c.name) && !/vendor/.test(c.file));
const fnHook = facts.hooks.find(h => h.op === 'add' && h.hook && h.callback.kind === 'function' && h.callback.name && typeof h.priority === 'number');
const asset = facts.assets.find(a => (a.op === 'enqueue' || a.op === 'register') && a.handle);
console.log(`      real class to duplicate:   ${cls && cls.name}  (${cls && cls.file}:${cls && cls.line})`);
console.log(`      real hook to mis-remove:   ${fnHook && fnHook.hook} -> ${fnHook && fnHook.callback.name} @${fnHook && fnHook.priority}  (${fnHook && fnHook.file}:${fnHook && fnHook.line})`);
console.log(`      real handle to dequeue:    ${asset && asset.handle} (${asset && asset.type})  (${asset && asset.file}:${asset && asset.line})`);
ok(!!cls && !!fnHook && !!asset, 'the real plugin offers a class, a function-callback hook and a script/style handle to attack');

group('control: the unseeded copy');
const O = (res, type) => res.observations.filter(o => o.type === type);
ok(O(baseline, 'duplicate-declaration').length === 0 && O(baseline, 'remove-wrong-priority').length === 0 && O(baseline, 'removes-other-component-hook').length === 0, 'the real plugin alone has no duplicate declaration and no hook removal aimed at another component');
ok(!O(baseline, 'handle-removed').some(o => o.handle === asset.handle), `nothing dequeues "${asset.handle}" in the unseeded copy`);
console.log(`      (the unseeded real plugin yields ${baseline.observations.length} observation(s): ${[...new Set(baseline.observations.map(o => o.type))].join(', ') || 'none'})`);

group('seeding three bugs into the COPY');
const SEED = 'seed-b';
const ns = cls.name.replace(/\\[^\\]+$/, ''), short = cls.name.split('\\').pop();
const dequeueFn = asset.type === 'style' ? 'wp_dequeue_style' : 'wp_dequeue_script';
fs.mkdirSync(path.join(copy, 'wp-content', 'plugins', SEED), { recursive: true });
fs.writeFileSync(path.join(copy, 'wp-content', 'plugins', SEED, `${SEED}.php`), `<?php
/**
 * Plugin Name: Seed B
 * Version: 0.0.1
 */
namespace ${ns} { class ${short} {} }          // BUG 1: the same class as the real plugin declares
namespace {
	remove_action( '${fnHook.hook}', '${fnHook.callback.name}', ${fnHook.priority + 9} );   // BUG 2: the real callback was added at priority ${fnHook.priority}
	${dequeueFn}( '${asset.handle}' );             // BUG 3: removes a handle the real plugin registers
}
`);
const seededRes = custom.analyse(copy, { policy: policyFor([`wp-content/plugins/${SLUG}`, `wp-content/plugins/${SEED}`]) });

group('each seeded bug is found');
const dup = O(seededRes, 'duplicate-declaration').find(o => o.declaration.kind === 'class' && o.declaration.name.toLowerCase() === cls.name.toLowerCase());
ok(dup && dup.components.slice().sort().join() === [SEED, SLUG].sort().join() && dup.risk === 'fatal-if-both-load', `BUG 1 found: class ${cls.name} declared in both ${SLUG} and ${SEED} (${dup && dup.risk})`);
const real = dup && dup.evidence.find(e => e.component === SLUG), seed = dup && dup.evidence.find(e => e.component === SEED);
ok(real && real.file === cls.file && real.line === cls.line && seed && /seed-b\.php$/.test(seed.file) && seed.line === 6, 'BUG 1 evidence: the real file:line and the seed file:line');
const lineText = real && fs.readFileSync(path.join(copy, real.file), 'utf8').split('\n')[real.line - 1];
ok(new RegExp(`\\bclass\\s+${short}\\b`).test(lineText || ''), `BUG 1: the real line ${real && real.line} really contains "class ${short}" (${(lineText || '').trim().slice(0, 60)})`);
const wp = O(seededRes, 'remove-wrong-priority').find(o => o.hook === fnHook.hook);
ok(wp && wp.removed_priority === fnHook.priority + 9 && wp.added_priority === fnHook.priority && wp.callback === fnHook.callback.name && wp.components.slice().sort().join() === [SEED, SLUG].sort().join(), `BUG 2 found: removal at priority ${fnHook.priority + 9} of a callback added at ${fnHook.priority} (${wp && wp.message.slice(0, 90)})`);
ok(wp && wp.evidence.some(e => e.component === SLUG && e.file === fnHook.file && e.line === fnHook.line) && wp.evidence.some(e => e.component === SEED && e.line === 8), 'BUG 2 evidence: the real add_action file:line and the seed remove_action file:line');
const hr = O(seededRes, 'handle-removed').find(o => o.handle === asset.handle);
ok(hr && hr.removed_by === SEED && hr.registered_by.includes(SLUG) && hr.components.slice().sort().join() === [SEED, SLUG].sort().join(), `BUG 3 found: ${SEED} removes "${asset.handle}", which ${SLUG} registers`);
ok(hr && hr.evidence.some(e => e.component === SEED && e.line === 9), 'BUG 3 evidence: the seed file:line');
ok(O(seededRes, 'duplicate-declaration').length === 1, 'exactly one duplicate was reported (no extra noise from the other 123 real classes)');
ok(seededRes.observations.filter(o => !['duplicate-declaration', 'remove-wrong-priority', 'handle-removed'].includes(o.type)).length === baseline.observations.length, 'nothing else changed: only the three seeded problems are new');

group('the original tree');
const after = fingerprint(SITE);
ok(after.hash === before.hash && after.files === before.files, `fingerprint of all ${after.files} entries (path, size, mtime) is unchanged: ${after.hash.slice(0, 16)}`);
ok(!fs.existsSync(path.join(SITE, 'wp-content', 'plugins', SEED)), 'no seed was written into the original tree');

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
