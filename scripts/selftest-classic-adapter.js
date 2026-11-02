#!/usr/bin/env node
// Step 5-B: the classic checks as issue-mode observations (issue/classic-adapter.js). Offline fixtures only.
//   - what is taken, in which order, how many (cap 3, compromise exempt), and why a finding is left out (no clue, inactive plugin, over the cap)
//   - negative cases: no clue, inactive plugin, clean tree
//   - nothing is written to the tree and nothing goes to the network
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const adapter = require('../issue/classic-adapter');
const ownership = require('../lib/ownership');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const group = t => console.log(`\n== ${t}`);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-adapter-'));
const head = (n, x = '') => `<?php\n/**\n * Plugin Name: ${n}\n * Version: 1.0.0\n${x} */\n`;
const hashTree = dir => { const h = crypto.createHash('sha256'); (function walk(d) { for (const n of fs.readdirSync(d).sort()) { const f = path.join(d, n), st = fs.lstatSync(f); h.update(path.relative(dir, f)); if (st.isDirectory()) walk(f); else h.update(fs.readFileSync(f)); } })(dir); return h.digest('hex'); };
function tree(name, parts = {}) {
    const root = path.join(tmp, name); const w = (rel, body) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); };
    w('wp-config.php', parts.config || '<?php\n'); w('wp-includes/version.php', "<?php\n$wp_version = '6.8.1';\n"); fs.mkdirSync(path.join(root, 'wp-admin'), { recursive: true });
    w('wp-content/plugins/clean/clean.php', head('Clean') + "defined('ABSPATH') || exit;\nfunction clean_fn() {}\n");
    if (parts.full) {
        w('wp-content/plugins/needy/needy.php', head('Needy', ' * Requires Plugins: base-plugin\n') + "defined('ABSPATH') || exit;\n");
        w('wp-content/plugins/pa/pa.php', head('Pa') + "add_filter('authenticate','pa_auth',10);\nfunction pa_auth($u){return $u;}\n");
        w('wp-content/plugins/pb/pb.php', head('Pb') + "add_filter('authenticate','pb_auth',10);\nfunction pb_auth($u){return $u;}\n");
        w('wp-content/themes/kid/style.css', '/*\nTheme Name: Kid\nTemplate: parent-x\nVersion: 1.0\n*/\n'); w('wp-content/themes/kid/index.php', '<?php\n');
        w('wp-content/db.php', '<?php // mystery drop-in\n');
        w('wp-content/uploads/2026/shell.php', "<?php eval(base64_decode('ZWNobyAxOw==')); ?>");
    }
    return root;
}
const policyOf = root => ownership.loadPolicy(root, { customPaths: [] }).policy;
const run = (root, o = {}) => adapter.adapt(root, { policy: policyOf(root), issue: { symptom: 'white-screen' }, evidence: { clues: [], component_hints: [] }, ...o });
const types = r => r.observations.map(o => o.type);

group('what is taken (a site with a missing dependency, two authenticate hooks, a missing parent theme, a drop-in and a shell in uploads)');
const full = tree('full', { full: true, config: "<?php\ndefine('WP_HOME','http://shop.example');\n" });
const before = hashTree(full);
const r = run(full);
ok(types(r).includes('classic:dep-missing') && types(r).includes('classic:hook-priority') && types(r).includes('classic:theme-parent-missing'), `conflict, dependency and theme findings are taken (${types(r).join(', ')})`);
ok(r.observations.filter(o => o.class === 'compromise').map(o => o.classic_rule).sort().join() === 'integrity-obfuscated-exec,integrity-php-in-uploads', 'the shell in uploads gives two compromise findings');
ok(r.observations.every(o => o.type.startsWith('classic:') && o.evidence.length && o.evidence.every(e => e.file)), 'every observation cites a file');
ok(r.observations.find(o => o.type === 'classic:dep-missing').evidence[0].file === 'wp-content/plugins/needy/needy.php', 'a finding about a whole component cites that component\'s main file');
ok(r.observations.every(o => o.active_state === 'unknown'), 'without a list of active plugins every finding says "active state unknown"');
ok(r.skipped.some(s => s.rule === 'dropin-unrecognised' && /nothing in the report/.test(s.reason)) && r.skipped.some(s => s.rule === 'cfg-http-url'), 'the drop-in and the http WP_HOME are left out, and the reason is listed');
ok(['classic:redeclare-function', 'classic:shared-constant', 'classic:shared-shortcode'].every(t => !types(r).includes(t)), 'the rules issue/custom.js already covers are not taken');
const sev = { P0: 0, P1: 1, P2: 2, P3: 3 };
ok(r.observations.every((o, i, a) => !i || sev[a[i - 1].severity] <= sev[o.severity]), 'sorted by severity first (P0 before P1)');
ok(JSON.stringify(run(full)) === JSON.stringify(r), 'deterministic: a second run gives the identical result');
ok(hashTree(full) === before, 'the tree was not changed (hash before and after)');
const src = fs.readFileSync(path.join(__dirname, '..', 'issue', 'classic-adapter.js'), 'utf8').replace(/\/\/.*$/gm, '');
ok(!/\bfetch\(|https?\.(get|request)|child_process|\bWpCli\b|lib\/live|lib\/outside/.test(src), 'the adapter has no network, WP-CLI, shell or live-probe code');

group('negative: no clue');
const none = run(full, { issue: { symptom: 'other' } });
ok(types(none).join() === 'classic:integrity-obfuscated-exec,classic:integrity-php-in-uploads', `symptom "other" and no evidence: only the P0 compromise findings pass (${types(none).join(', ')})`);
ok(none.skipped.filter(s => /nothing in the report/.test(s.reason)).length >= 3, 'the others are listed as left out because nothing points at them');
const nothing = run(full, { issue: { symptom: 'layout' } });
ok(!types(nothing).includes('classic:dep-missing') && !types(nothing).includes('classic:hook-priority'), 'a layout complaint does not pull in a missing dependency or a hook-priority tie (not the same family)');

group('a clue brings a finding in');
ok(types(run(full, { issue: { symptom: 'other' }, evidence: { clues: [], component_hints: [{ component: 'plugin:needy' }] } })).includes('classic:dep-missing'), 'a component named by the evidence: its missing dependency is taken');
const logEv = { clues: [{ type: 'php-location', source: { kind: 'log', ref: 'debug.log' }, detail: { file: 'wp-content/plugins/pa/pa.php', line: 6 } }], component_hints: [] };
const viaLog = run(full, { issue: { symptom: 'other' }, evidence: logEv });
ok(types(viaLog).includes('classic:hook-priority') && /a log names/.test(viaLog.observations.find(o => o.type === 'classic:hook-priority').matched), 'a file named in a log: the hook finding in that file is taken');

group('cap of 3, compromise exempt');
const many = tree('many', {});
for (let i = 0; i < 5; i++) { const f = path.join(many, `wp-content/plugins/n${i}/n${i}.php`); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, head(`N${i}`, ` * Requires Plugins: gone-${i}\n`) + "defined('ABSPATH') || exit;\n"); }
for (let i = 0; i < 4; i++) { const f = path.join(many, `wp-content/uploads/s${i}.php`); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, `<?php eval(base64_decode('${i}')); ?>`); }
const capped = run(many);
ok(capped.observations.filter(o => o.class !== 'compromise').length === 3, `5 missing dependencies: 3 kept (cap)`);
ok(capped.skipped.filter(s => /over the cap of 3/.test(s.reason)).length === 2, '...and the other 2 are listed as over the cap');
ok(capped.observations.filter(o => o.class === 'compromise').length === 8, 'all 8 compromise findings of the 4 shells are kept: exempt from the cap');
ok(capped.observations.filter(o => o.class !== 'compromise').map(o => o.components.join('+')).join() === 'gone-0+n0,gone-1+n1,gone-2+n2', 'ties are broken by component name, so the 3 kept are the same every time');

const redir = run(full, { issue: { symptom: 'redirect' } });
ok(types(redir).includes('classic:cfg-http-url') && redir.observations.find(o => o.type === 'classic:cfg-http-url').evidence[0].file === 'wp-config.php', 'symptom "redirect": the http:// WP_HOME in wp-config.php is taken (a redirect problem family), and it cites wp-config.php');

group('negative: inactive plugin');
const inactive = run(full, { activePlugins: ['clean', 'needy'] });
ok(!types(inactive).includes('classic:hook-priority') && !inactive.observations.some(o => o.components.some(c => c === 'pa' || c === 'pb')), 'pa and pb are inactive: the classic checks look at active plugins only, so their hook tie is not reported at all');
ok(types(inactive).includes('classic:dep-missing') && inactive.observations.find(o => o.type === 'classic:dep-missing').active_state === 'active', 'needy is active: its finding stays and says "active"');
ok(types(run(full, { activePlugins: ['clean', 'pa', 'pb', 'needy'] })).includes('classic:hook-priority'), 'with pa and pb active the tie is back');

group('negative: clean tree');
const clean = tree('clean', {});
const rc = run(clean, { issue: { symptom: 'white-screen' } });
ok(rc.observations.length === 0 && rc.considered === 0 && rc.crashed.length === 0 && rc.skipped.length === 0, 'a clean tree gives no observation, no skip, no crash');

group('compromise findings carry what the gate and the validator need');
const c0 = r.observations.find(o => o.class === 'compromise');
ok(c0.family === 'compromise' && c0.severity === 'P0' && !c0.components.length, 'class "compromise", family "compromise", severity kept; a file in uploads belongs to no component');
const eo = r.observations.find(o => o.classic_rule === 'integrity-obfuscated-exec');
ok(eo.pattern && eo.pattern.source && new RegExp(eo.pattern.source, eo.pattern.flags).test("eval(base64_decode('x'))"), 'the obfuscated-exec finding carries its pattern, so validate.js can re-find it in the file');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
