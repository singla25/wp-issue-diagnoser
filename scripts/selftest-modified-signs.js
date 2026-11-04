#!/usr/bin/env node
// REPORT-SPEC Part 3: Case 3 "Signs that a copy was modified" (issue/modified-signs.js, issue/case-file.js). STRONG signs only, read from the copy:
//   (a) the eval-of-an-encoded-string pattern of checks/integrity.js (obfuscated-exec) in the PHP files of third-party themes and plugins;
//   (b) "nulled" / "cracked" (whole words) in a folder name, a header field, the readme name or a top-level file name.
// Must NOT fire: minified JavaScript, a Freemius SDK folder, a file encoded by a vendor loader (ionCube / Zend Guard / SourceGuardian), a licence call to the vendor's
// domain, a long encoded string, base64_decode without eval. The split with "Possible compromise signs": a match in a third-party theme or plugin file is listed ONCE,
// under Case 3; custom code (customPaths) and must-use plugins stay with the compromise case. Statuses never change (the scan is not read by validate.js).
// Offline, fixtures only, read-only (fingerprint before and after).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-modsigns-'));
process.env.PLUGIN_GUARD_ISSUES = path.join(tmp, 'issues');
const store = require('../lib/issue-store');
const evidence = require('../issue/evidence'), analysis = require('../issue/analysis'), validate = require('../issue/validate'), resolve = require('../issue/resolve'), result = require('../issue/result');
const ms = require('../issue/modified-signs'), caseFile = require('../issue/case-file'), integrity = require('../checks/integrity');
const cli = require('../lib/issue-cli');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const group = t => console.log(`\n== ${t}`);
const w = (root, rel, body = '<?php\n') => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); };
const fingerprint = root => { const h = crypto.createHash('sha256'); const walk = d => { for (const n of fs.readdirSync(d).sort()) { const p = path.join(d, n), st = fs.lstatSync(p); h.update(path.relative(root, p) + ':' + st.size + ':'); if (st.isDirectory()) walk(p); else h.update(fs.readFileSync(p)); } }; walk(root); return h.digest('hex'); };
const ph = (name, extra = '') => `<?php\n/**\n * Plugin Name: ${name}\n * Version: 1.0.0\n${extra} */\n`;
const B64 = 'ZWNobyAnaGVsbG8nOw==';

function base(root) {
    w(root, 'wp-includes/version.php', "<?php\n$wp_version = '6.8.1';\n"); w(root, 'wp-config.php', '<?php\n');
    w(root, 'wp-content/themes/clean/style.css', '/*\nTheme Name: Clean\nVersion: 1.0\n*/'); w(root, 'wp-content/themes/clean/functions.php', '<?php\n');
    w(root, 'wp-content/plugins/plain/plain.php', ph('Plain', ' * Description: An ordinary plugin.\n') + 'function plain_x() { return 1; }\n');
}
// a premium-style plugin with everything that must NOT fire
function premium(root) {
    w(root, 'wp-content/plugins/premium-pro/premium-pro.php', ph('Premium Pro', ' * Author: Vendor Ltd\n * Plugin URI: https://vendor.example.com/premium\n') + "$r = wp_remote_post( 'https://licensing.vendor.example.com/v1/check', array( 'body' => array( 'key' => get_option( 'premium_key' ) ) ) );\n$data = base64_decode( get_option( 'premium_blob' ) );\n");
    w(root, 'wp-content/plugins/premium-pro/assets/app.min.js', '!function(e){var t=atob("' + B64 + '");eval(t)}(window);' + 'x'.repeat(4000));
    w(root, 'wp-content/plugins/premium-pro/freemius/includes/class-fs-helper.php', `<?php\neval(base64_decode('${B64}'));\n`);
    w(root, 'wp-content/plugins/premium-pro/encoded/loader.php', `<?php //0046a\nif(!extension_loaded('ionCube Loader')){die('The file needs the ionCube Loader');}\neval(base64_decode('${B64}'));\n`);
    w(root, 'wp-content/plugins/premium-pro/encoded/sg.php', `<?php\n// SourceGuardian\nif(!function_exists('sg_load')){die('needs SourceGuardian');} return sg_load('abc'); eval(gzinflate(base64_decode('${B64}')));\n`);
    w(root, 'wp-content/plugins/premium-pro/includes/data.php', `<?php\n$font = '${'A'.repeat(3000)}';\n`);
    w(root, 'wp-content/plugins/premium-pro/readme.txt', '=== Premium Pro ===\nContributors: vendor\n');
    w(root, 'wp-content/plugins/annulled-tools/annulled-tools.php', ph('Annulled Tools', ' * Description: Handles uncrackedness and nulledx values.\n'));
}
const EWS = 'http://localhost82.local.com/ews/';
async function run(name, build, { config = '{}' } = {}) {
    const root = path.join(tmp, name, 'wp'); base(root); build(root);
    const cfg = path.join(path.dirname(root), 'plugin-guard.config.json'); fs.writeFileSync(cfg, config);
    const before = fingerprint(root);
    const issue = store.create({ title: 'The site shows an error', description: 'The site shows a critical error', symptom: 'white-screen', environment: 'local', url: EWS, root, pages: [] });
    await evidence.run(issue.id, { root, probeOptions: { probe: false } });
    const dir = store.dirOf(issue.id);
    analysis.run(issue.id, { root, config: cfg });
    const val = validate.run(issue.id, { root, config: cfg, lint: () => ({ ok: true, message: '' }) });
    const policy = validate.policyFor(root, cfg), plans = resolve.build(issue.id, val, { root, policy, dir });
    const res = result.write(issue.id, { validation: val, plans, dir, root, policy, gate: true });
    const R = n => fs.readFileSync(path.join(dir, 'result', n), 'utf8');
    const out = []; cli.printGate(res, plans, { gate: true }, t => out.push(t), dir);
    const signs = (res.findings.case_file.cases || []).find(c => c.kind === 'signs') || null;
    return { root, dir, val, policy, f: res.findings, md: R('ISSUE-REPORT.md'), html: R('issue.html'), cli: out.join('\n'), signs, same: before === fingerprint(root), plan: fs.existsSync(path.join(dir, 'result', 'FIX-PLAN.md')) ? R('FIX-PLAN.md') : null };
}
const rows = (c, k) => ((c.rows.find(r => r[0] === k) || [0, []])[1]);
// the words that must never be a claim about the copy: only allowed inside a quoted name or header found on the site
const CLAIM = /\b(cracked|pirated|malware|nulled|hacked|infected)\b/i;
// names found on the site are data: quoted names, the file paths and the "(the plugin <name>)" label are taken out before the check
const unquoted = t => String(t).replace(/"[^"]*"/g, '""').replace(/wp-content\/\S+/g, 'PATH').replace(/\(the (plugin|theme) [^)]*\)/g, '(NAME)');

(async () => {
    group('the pattern is the integrity check\'s own eval / base64 family, and only that one');
    const ev = integrity.PATTERNS.find(p => p.id === 'obfuscated-exec');
    ok(ms.EVAL_PATTERN_ID === 'obfuscated-exec' && /base64_decode/.test(ev.re.source) && /eval/.test(ev.re.source), 'modified-signs.js takes integrity.PATTERNS "obfuscated-exec" (eval / assert of base64_decode, gzinflate, ...)');
    const src = fs.readFileSync(path.join(__dirname, '..', 'issue', 'modified-signs.js'), 'utf8').replace(/\/\/.*$/gm, '');
    ok(!['request-exec', 'request-as-function', 'known-webshell', 'file-write-request', 'preg-e', 'include-image', 'create-function', 'long-base64'].some(id => src.includes(`'${id}'`)), 'no other integrity pattern is used');

    group('premium-style code does NOT fire');
    const prem = await run('premium', premium);
    const pScan = ms.scan(prem.root, { policy: prem.policy });
    ok(pScan.count === 0 && !prem.signs && !prem.f.modified_signs, `minified JS, a freemius/ SDK folder, ionCube and SourceGuardian files, a licence call to the vendor, a long encoded string, base64_decode without eval, "Annulled" / "nulledx": no sign (${pScan.count})`);
    ok(pScan.files_read >= 6, `the PHP files were read (${pScan.files_read})`);
    ok(!/Signs that a copy was modified/.test(prem.md + prem.cli + JSON.stringify(prem.f.case_file)) && !/that a copy was modified/.test(prem.f.case_file.status.line), 'no Case 3 in the Markdown, the command line or the case file; the status line names no sign');

    group('eval(base64_decode(...)) in a plugin file fires and names the file');
    const evalSite = await run('eval', root => w(root, 'wp-content/plugins/shady/shady.php', ph('Shady') + `$a = 1;\neval(base64_decode('${B64}'));\n`));
    const c3 = evalSite.signs;
    ok(!!c3 && c3.heading === 'Signs that a copy was modified' && c3.heading === caseFile.SIGNS, 'Case 3 is shown, headed "Signs that a copy was modified"');
    ok(c3 && rows(c3, 'Signs').length === 1 && rows(c3, 'Signs')[0] === 'wp-content/plugins/shady/shady.php, line 7, contains eval(base64_decode(...)): it runs code that is hidden in an encoded string (the plugin Shady).', `the file, the line and the kind of pattern: "${c3 && rows(c3, 'Signs')[0]}"`);
    ok(c3 && rows(c3, 'How sure')[0] === "This copy shows signs of being changed from the vendor's version. It cannot be verified against the vendor." && rows(c3, 'What to do')[0] === 'If this copy did not come from the vendor, replace it with a licensed copy from the vendor.', 'the owner\'s wording: the "cannot be verified" sentence and the conditional advice');
    ok(evalSite.f.case_file.status.line === '0 likely cause · 0 thing to check · 0 confirmed · 1 sign that a copy was modified. This does not mean the site is healthy.', `the status line counts it: "${evalSite.f.case_file.status.line}"`);
    ok(evalSite.md.includes('## Case 1: Signs that a copy was modified') && /\nCASE 1  SIGNS THAT A COPY WAS MODIFIED\n/.test(evalSite.cli), 'Markdown and command line show the case');
    ok(evalSite.f.modified_signs && evalSite.f.modified_signs.signs[0].file === 'wp-content/plugins/shady/shady.php' && evalSite.f.modified_signs.signs[0].line === 7 && evalSite.f.modified_signs.signs[0].kind === 'eval-encoded', 'findings.json modified_signs keeps the file, the line and the kind');

    group('the split with "Possible compromise signs": one file, listed once');
    const comp = evalSite.f.findings.filter(x => x.label === 'compromise');
    ok(comp.length === 1 && comp[0].evidence[0].file === 'wp-content/plugins/shady/shady.php', 'the integrity check still makes its compromise finding for the file (findings.json unchanged)');
    ok(!evalSite.f.case_file.cases.some(c => /^Possible compromise signs/.test(c.heading)) && !/## Case \d+: Possible compromise signs/.test(evalSite.md) && !/POSSIBLE COMPROMISE SIGNS/.test(evalSite.cli), 'the report does not list the same file a second time as "Possible compromise signs"');
    const own = await run('custom', root => w(root, 'wp-content/plugins/my-own/my-own.php', ph('My Own') + `eval(base64_decode('${B64}'));\n`), { config: JSON.stringify({ customPaths: ['wp-content/plugins/my-own'] }) });
    ok(!own.signs && own.f.case_file.cases.some(c => /^Possible compromise signs/.test(c.heading)), 'custom code (customPaths): no Case 3; the compromise case keeps it');
    const mu = await run('mu', root => w(root, 'wp-content/mu-plugins/loader.php', `<?php\neval(base64_decode('${B64}'));\n`));
    ok(!mu.signs && mu.f.case_file.cases.some(c => /^Possible compromise signs/.test(c.heading)), 'a must-use plugin: no Case 3; the compromise case keeps it');
    const valOf = r => JSON.stringify(r.val.hypotheses.map(h => [h.type, h.status]));
    const shadyNoScan = JSON.stringify(validate.run(store.list().find(i => i.root === evalSite.root).id, { root: evalSite.root, config: path.join(path.dirname(evalSite.root), 'plugin-guard.config.json'), lint: () => ({ ok: true, message: '' }) }).hypotheses.map(h => [h.type, h.status]));
    ok(valOf(evalSite) === shadyNoScan && comp[0].status === evalSite.val.hypotheses.find(h => h.class === 'compromise').status, 'the statuses are the validator\'s alone (the same on a second validation; the scan is not part of it)');
    ok(!/modified-signs|case-file/.test(fs.readFileSync(path.join(__dirname, '..', 'issue', 'validate.js'), 'utf8')), 'validate.js does not read the signs');

    group('the words "nulled" / "cracked" in names and headers');
    const nul = await run('nulled', root => w(root, 'wp-content/plugins/gallery-pro/gallery-pro.php', ph('Gallery Pro Nulled')));
    ok(nul.signs && rows(nul.signs, 'Signs')[0] === 'wp-content/plugins/gallery-pro/gallery-pro.php: the "Plugin Name" header ("Gallery Pro Nulled") contains the word "Nulled" (the plugin Gallery Pro Nulled).', `"Nulled" in a plugin header fires: "${nul.signs && rows(nul.signs, 'Signs')[0]}"`);
    const cr = await run('cracked', root => { w(root, 'wp-content/themes/astra-cracked/style.css', '/*\nTheme Name: Astra\nAuthor: Someone\nVersion: 4.0\n*/'); w(root, 'wp-content/themes/astra-cracked/functions.php', '<?php\n'); });
    ok(cr.signs && /^wp-content\/themes\/astra-cracked: the folder name "astra-cracked" contains the word "cracked" \(the theme Astra\)\.$/.test(rows(cr.signs, 'Signs')[0]), 'a theme folder name with "cracked" fires');
    const more = await run('more', root => {
        w(root, 'wp-content/plugins/seo-x/seo-x.php', ph('SEO X', ' * Author: Cracked by Team X\n'));
        w(root, 'wp-content/plugins/forms-y/forms-y.php', ph('Forms Y', ' * Description: GPL release, nulled for you\n'));
        w(root, 'wp-content/plugins/cache-z/cache-z.php', ph('Cache Z')); w(root, 'wp-content/plugins/cache-z/readme.txt', '=== Cache Z Nulled ===\n');
        w(root, 'wp-content/plugins/slider-q/slider-q.php', ph('Slider Q')); w(root, 'wp-content/plugins/slider-q/nulled-by-site.txt', 'x');
    });
    const ml = rows(more.signs || { rows: [] }, 'Signs');
    ok(ml.length === 4 && ml.some(l => /"Author" header \("Cracked by Team X"\)/.test(l)) && ml.some(l => /"Description" header/.test(l)) && ml.some(l => /readme\.txt: the name in the readme \("Cache Z Nulled"\)/.test(l)) && ml.some(l => /nulled-by-site\.txt: the file name contains the word "nulled"/.test(l)), 'Author and Description headers, the readme name and a top-level file name each fire');

    group('a clean site');
    const clean = await run('clean', () => {});
    ok(!clean.signs && !clean.f.modified_signs && !/sign/.test(clean.f.case_file.status.line) && clean.f.case_file.status.line === caseFile.statusLine({ likely: 0, confirmed: 0, check: 0 }), 'no Case 3, and the status line is the one without signs');
    ok(caseFile.statusLine({ likely: 1, confirmed: 0, check: 1 }) === '1 likely cause (not confirmed) · 1 thing to check · 0 confirmed' && caseFile.statusLine({ likely: 1, confirmed: 0, check: 1, signs: 3 }) === '1 likely cause (not confirmed) · 1 thing to check · 0 confirmed · 3 signs that a copy was modified', 'the status line: unchanged without signs; "N signs that a copy was modified" added when there are');

    group('the list is capped; the wording never makes a claim about the copy');
    const many = await run('many', root => { for (let i = 1; i <= 10; i++) w(root, `wp-content/plugins/p${String(i).padStart(2, '0')}/p.php`, ph(`P ${i}`) + `eval(base64_decode('${B64}'));\n`); });
    const mm = rows(many.signs, 'Signs');
    ok(mm.length === ms.MAX_LISTED + 1 && mm[mm.length - 1] === 'And 2 more.' && many.f.case_file.status.line.includes('10 signs that a copy was modified'), `10 signs: ${ms.MAX_LISTED} listed, "And 2 more.", all 10 counted`);
    for (const [n, r] of [['eval', evalSite], ['nulled', nul], ['cracked', cr], ['more', more], ['many', many]]) {
        const t = [r.signs.heading, ...r.signs.rows.flatMap(([k, v]) => [k, ...v])].join('\n');
        ok(!CLAIM.test(unquoted(t)), `${n}: no "cracked", "pirated", "malware", "nulled", "hacked" as a claim (only inside a quoted name found on the site)`);
    }

    group('read-only, deterministic, no network, no status');
    ok([prem, evalSite, own, mu, nul, cr, more, clean, many].every(r => r.same), 'no site folder was written (fingerprint before and after)');
    ok(JSON.stringify(ms.scan(more.root, { policy: more.policy })) === JSON.stringify(ms.scan(more.root, { policy: more.policy })), 'two scans of the same copy give the same result');
    ok(!/writeFileSync|appendFileSync|mkdirSync|rmSync|unlinkSync|renameSync|chmodSync|require\(['"](https?|net|dns|child_process)['"]\)|fetch\(/.test(src) && !/status\s*=|CONFIRMED|REPRODUCIBLE|REJECTED|FIXED_VERIFIED/.test(src), 'modified-signs.js only reads: no write, no network, no process, no status');
    ok(/readdir = require\('\.\.\/lib\/sorted-dir'\)/.test(src) && !/fs\.readdirSync/.test(src), 'every listing goes through lib/sorted-dir.js');
    ok(ms.scan(null).count === 0 && ms.scan(path.join(tmp, 'nothing-here')).count === 0, 'no copy: no sign (and no error)');

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(failures ? `\n${failures} FAILED` : '\nAll modified-signs checks passed.');
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
