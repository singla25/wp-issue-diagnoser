#!/usr/bin/env node
// Self-test of lib/redact.js, the last line of defence before text is written to a report. Offline; made-up sample values only (never a real token).
// This suite covers the WordPress recovery-mode parameters rm_token and rm_key (the key in the link of the "technical issue" e-mail) in every form
// they can arrive in, that nothing else is changed, and the real paths a pasted link takes (the issue file, the reporter's log).
const fs = require('fs');
const os = require('os');
const path = require('path');

const redact = require('../lib/redact');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const group = t => console.log(`\n== ${t}`);
const TOK = 'SAMPLEtoken1234567', KEY = 'SAMPLEkey7654321';
const gone = out => !out.includes(TOK) && !out.includes(KEY);

group('rm_token and rm_key are masked in every form');
const FORMS = {
    'plain text': `Use rm_token=${TOK} and rm_key=${KEY} to enter.`,
    'a URL with other parameters': `https://example.test/wp-login.php?action=enter_recovery_mode&rm_token=${TOK}&rm_key=${KEY}&redirect_to=%2Fwp-admin%2F`,
    'URL-encoded (%26 and %3D)': `https://example.test/x?next=%2Fwp-login.php%3Faction%3Denter_recovery_mode%26rm_token%3D${TOK}%26rm_key%3D${KEY}`,
    'upper case': `RM_TOKEN=${TOK}&RM_KEY=${KEY}`,
    'mixed case': `Rm_Token=${TOK}&rM_kEy=${KEY}`,
    'JSON': `{"rm_token":"${TOK}","rm_key":"${KEY}"}`,
    'colon and space': `rm_token: ${TOK}\nrm_key: ${KEY}`,
    'inside a link in markup': `<a href="https://example.test/wp-login.php?action=enter_recovery_mode&rm_token=${TOK}&rm_key=${KEY}">link</a>`
};
for (const [name, text] of Object.entries(FORMS)) {
    const out = redact.text(text);
    ok(gone(out) && out.includes('[REDACTED]') && /rm_token/i.test(out) && /rm_key/i.test(out), `${name}: both values are gone, the names stay, "[REDACTED]" takes their place`);
}

group('only the two values change');
{
    const out = redact.text(FORMS['a URL with other parameters']);
    ok(out === 'https://example.test/wp-login.php?action=enter_recovery_mode&rm_token=[REDACTED]&rm_key=[REDACTED]&redirect_to=%2Fwp-admin%2F', `the other parameters are untouched: ${out}`);
    const enc = redact.text(FORMS['URL-encoded (%26 and %3D)']);
    ok(enc === 'https://example.test/x?next=%2Fwp-login.php%3Faction%3Denter_recovery_mode%26rm_token%3D[REDACTED]%26rm_key%3D[REDACTED]', `the encoded form keeps its encoding: ${enc}`);
    const same = 'a setting called rm_token_prefix, a function format_rm_key() and the word rm_token without a value';
    ok(redact.text(same) === same, 'names that merely contain rm_token or rm_key, and a bare name, are not changed');
    ok(redact.text('token=ABCDEF123456 and password=hunter2hunter2') === 'token=[REDACTED] and password=[REDACTED]', 'the existing masks work as before (token, password)');
    const d = redact.deep({ a: [`x?rm_token=${TOK}`], b: { c: `rm_key=${KEY}`, n: 5 } });
    ok(gone(JSON.stringify(d)) && d.b.n === 5, 'deep() masks them inside arrays and objects and leaves numbers alone');
}

group('the real paths: a pasted recovery link never reaches the stored files');
{
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-redact-'));
    process.env.PLUGIN_GUARD_ISSUES = path.join(tmp, 'issues');
    const store = require('../lib/issue-store');
    const link = `https://example.test/wp-login.php?action=enter_recovery_mode&rm_token=${TOK}&rm_key=${KEY}`;
    const issue = store.create({ title: 'White screen', description: `WordPress e-mailed me this link: ${link}`, symptom: 'white-screen', environment: 'local', pages: [] });
    const saved = fs.readFileSync(path.join(store.dirOf(issue.id), 'issue.json'), 'utf8');
    ok(gone(saved) && saved.includes('rm_token=[REDACTED]'), 'the description in issue.json is masked');
    const log = path.join(tmp, 'debug.log');
    fs.writeFileSync(log, `[27-Oct-2026 10:00:01 UTC] PHP Fatal error:  Uncaught Error in /var/www/x/wp-content/plugins/p/p.php:5\n[27-Oct-2026 10:00:02 UTC] recovery link ${link}\n`);
    const got = require('../lib/site-intake').readLogRedacted(log);
    ok(gone(JSON.stringify(got)), 'the reporter\'s log copy is masked line by line');
    fs.rmSync(tmp, { recursive: true, force: true });
}
// ---------------------------------------------------------------- S0b: the other WordPress secrets (made-up values only)
const V = 'SAMPLEvalue12345678', M = '[REDACTED]', N = '0a1b2c3d4e5f';   // N: a made-up nonce (a WordPress nonce is 10 hex characters)
group('S0b: each secret form is masked, in the style of the existing masks (name and separator stay)');
const B64 = Buffer.from('user:' + V).toString('base64');
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.SAMPLEsignature12345678';
const FORMS2 = [
    ['_wpnonce in a query', `https://e.test/wp-admin/admin-ajax.php?action=x&_wpnonce=${N}&y=1`, `https://e.test/wp-admin/admin-ajax.php?action=x&_wpnonce=${M}&y=1`],
    ['_ajax_nonce parameter', `_ajax_nonce=${N}`, `_ajax_nonce=${M}`],
    ['X-WP-Nonce header', `X-WP-Nonce: ${N}`, `X-WP-Nonce: ${M}`],
    ['nonce in JSON', `{"_wpnonce":"${N}"}`, `{"_wpnonce":"${M}"}`],
    ['nonce, URL-encoded', `x?a%3D1%26_wpnonce%3D${N}%26b%3D2`, `x?a%3D1%26_wpnonce%3D${M}%26b%3D2`],
    ['logged-in cookie, not the first value', `Cookie: a=b; wordpress_logged_in_0123abcd=${V}%7C1700000000%7Chash; wp-settings-1=x`, `Cookie: a=b; wordpress_logged_in_0123abcd=${M}; wp-settings-1=x`],
    ['secure cookie in the middle of a Cookie line', `Cookie: x=1; wordpress_sec_0123abcd=${V}; y=2`, `Cookie: x=1; wordpress_sec_0123abcd=${M}; y=2`],
    ['hash-named WordPress cookie', `wordpress_0123456789abcdef0123=${V}`, `wordpress_0123456789abcdef0123=${M}`],
    ['pwd parameter', `log=admin&pwd=${V}&wp-submit=Log+In`, `log=admin&pwd=${M}&wp-submit=Log+In`],
    ['user_pass parameter', `user_login=a&user_pass=${V}`, `user_login=a&user_pass=${M}`],
    ['access_token parameter', `https://e.test/?access_token=${V}&x=1`, `https://e.test/?access_token=${M}&x=1`],
    ['refresh_token and client_secret', `refresh_token: ${V} client_secret=${V}`, `refresh_token: ${M} client_secret=${M}`],
    ['key in a query (password reset link)', `https://e.test/wp-login.php?action=rp&key=${V}&login=a`, `https://e.test/wp-login.php?action=rp&key=${M}&login=a`],
    ['DB_PASSWORD as plain text', `DB_PASSWORD = ${V}`, `DB_PASSWORD = ${M}`],
    ['Authorization: Basic', `Authorization: Basic ${B64}`, `Authorization: Basic ${M}`],
    ['password inside a URL', `https://user:${V}@e.test/path?x=1`, `https://user:${M}@e.test/path?x=1`],
    ['JSON Web Token', `jwt ${JWT} end`, `jwt ${M} end`]
];
for (const [name, input, want] of FORMS2) ok(redact.text(input) === want, `${name}: ${redact.text(input) === want ? 'masked as expected' : redact.text(input)}`);

group('S0b: normal text is not changed (false-positive checks)');
const PLAIN = [
    'The password reset page asks for your e-mail. A token is a short string.',
    'plugin: jwt-authentication-for-wp-rest-api 1.3, theme: twentytwentyfour, slug wp-security-nonce-helper',
    'GET /wp-json/wp/v2/posts?per_page=5&page=2&search=key HTTP/1.1',
    '/wp-json/jwt-auth/v1/token is the route of the plugin',
    'Content-Type: application/json\nUser-Agent: Mozilla/5.0\nAccept: text/html\nHost: example.test',
    'Authorization: required for this route, and Authorization-free headers are fine',
    'type pwd in a terminal to print the working directory; pwd: /srv/site',
    'https://example.test:8080/path?x=1 and mailto:a@example.test and http://user@example.test/',
    'a nonce is a number used once; monkey=1; turkey=2; wordpress_test_cookie=WP%20Cookie%20check',
    'version 1.2.3, eyJ is the start of a token but eyJ alone is not one',
    '$user_pass = wp_generate_password(); $pwd = $_POST["pwd"]; $pass1 != $pass2; id_token is read here',
    "headers: { 'X-WP-Nonce': wpApiSettings.nonce }, and the value $_REQUEST['_wpnonce'] is checked",
    'DB_PASSWORD = env and the word key in ?key words',
    'var id_token = getToken(); auth_token = this.get(); api_secret: process.env.API_SECRET; auth_token: null; api_token: undefined',
    'SELECT * FROM wp_users WHERE user_pass = %s AND user_pass=%s AND pwd = ?'
];
for (const t of PLAIN) ok(redact.text(t) === t, `unchanged: ${t.slice(0, 60).replace(/\n/g, ' ')}`);

group('S0b: the old masks still work (controls)');
for (const [input, want] of [
    [`token=${V}`, `token=${M}`], [`password=${V}`, `password=${M}`], [`api_key=${V}`, `api_key=${M}`], [`Authorization: Bearer ${V}abcdef`, `Authorization: Bearer ${M}`],
    [`define('AUTH_KEY', '${V}');`, `define('AUTH_KEY', '${M}');`], [`define( 'DB_PASSWORD', '${V}' );`, `define( 'DB_PASSWORD', '${M}' );`], ['AKIAABCDEFGHIJKLMNOP', M]
]) ok(redact.text(input) === want, `still masked: ${input.slice(0, 40)}`);

group('S0b: hostile input stays fast');
{
    const t0 = Date.now();
    redact.text('wordpress_logged_in_' + 'a'.repeat(100000) + '=') ; redact.text('https://' + 'a:'.repeat(50000)); redact.text('eyJ' + 'a'.repeat(100000)); redact.text('_wpnonce='.repeat(20000)); redact.text('authorization: basic ' + 'A'.repeat(200000));
    redact.text('a.'.repeat(50000)); redact.text('eyJaaaaaaaa.'.repeat(100000)); redact.text('http://u:'.repeat(30000)); redact.text('x://' + 'a'.repeat(300000));
    ok(Date.now() - t0 < 3000, `nine hostile inputs of 100 KB and more (long runs of letters and dots, a million-character token-like text) took ${Date.now() - t0} ms (under 3 s)`);
}

group('S0b: the probe data is masked where it is stored, and an address keeps its path');
{
    const probeMod = require('../issue/probe');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-redact-probe-'));
    const outFile = path.join(tmp, 'result.json');
    const raw = { pages: [{ url: `https://e.test/shop/cart/?_wpnonce=${N}&page=2`, final_url: `https://e.test/shop/cart/?rm_token=${TOK}`, status: 500, assets: [{ url: `https://e.test/wp-content/plugins/acme/a.js?ver=1.2&key=${V}` }], page_errors: [{ text: 'Uncaught Error', stack: `at https://e.test/x.js?access_token=${V}:1:2` }] }] };
    fs.writeFileSync(outFile, JSON.stringify(raw));
    const maskRaw = probeMod.maskRaw || (r => r), got = maskRaw(raw, outFile), stored = fs.readFileSync(outFile, 'utf8');
    ok(got.pages[0].url === `https://e.test/shop/cart/?_wpnonce=${M}&page=2` && got.pages[0].final_url === `https://e.test/shop/cart/?rm_token=${M}` && got.pages[0].status === 500, 'the addresses keep their path and the other parameters, only the secret values change');
    ok(got.pages[0].assets[0].url === `https://e.test/wp-content/plugins/acme/a.js?ver=1.2&key=${M}` && got.pages[0].page_errors[0].stack === `at https://e.test/x.js?access_token=${M}:1:2`, 'asset addresses and page-error stacks are masked (the line and column after the secret stay)');
    ok(!stored.includes(V) && !stored.includes(TOK) && JSON.parse(stored).pages[0].status === 500, 'the stored result.json holds only the masked copy and is still valid JSON');
    ok(raw.pages[0].url.includes(N) && raw.pages[0].page_errors[0].stack.includes(V), 'the caller\'s raw data is not changed (the oracle and the page matching keep using it): only the stored copy is masked');
    const fid = require('../issue/fidelity');
    ok(fid.pageKeyOf(`https://e.test/shop/?_wpnonce=${N}&page=2`) === fid.pageKeyOf(`https://e.test/shop/?_wpnonce=${M}&page=2`) && fid.pageKeyOf(`https://e.test/shop/?_wpnonce=${N}&page=2`) !== null, 'the page key used to compare the live page with the test copy is the same for a masked and an unmasked address');
    ok(maskRaw(null, outFile) === null, 'no result (the worker died): nothing to mask');
    fs.rmSync(tmp, { recursive: true, force: true });
}

group('S0b: the last pass over the files the report writes');
(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-redact-pass-'));
    process.env.PLUGIN_GUARD_ISSUES = path.join(tmp, 'issues');
    delete require.cache[require.resolve('../lib/issue-store')];
    const store = require('../lib/issue-store');
    const evidence = require('../issue/evidence'), analysis = require('../issue/analysis'), validate = require('../issue/validate'), resolve = require('../issue/resolve'), result = require('../issue/result');
    const w = (root, rel, body) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); };
    const root = path.join(tmp, 'wp');
    w(root, 'wp-includes/version.php', "<?php\n$wp_version = '6.8.1';\n"); w(root, 'wp-config.php', '<?php\n');
    // a plugin whose own header carries a secret-looking text: it is read from the code, not from user text, so only the last pass can mask it
    w(root, 'wp-content/plugins/acme/acme.php', `<?php\n/**\n * Plugin Name: Acme pwd=${V}\n * Version: 1.0.0\n */\nfunction acme_helper() {}\n`);
    w(root, 'wp-content/plugins/other/other.php', `<?php\n/**\n * Plugin Name: Other\n * Version: 1.0.0\n */\nfunction acme_helper() {}\n`);
    w(root, 'wp-content/debug.log', `[27-Oct-2026 10:00:01 UTC] PHP Fatal error:  Cannot redeclare acme_helper() (previously declared in ${root}/wp-content/plugins/acme/acme.php:6) in ${root}/wp-content/plugins/other/other.php on line 6\n`);
    const config = path.join(tmp, 'plugin-guard.config.json'); fs.writeFileSync(config, '{}');
    const issue = store.create({ title: 'Critical error', description: 'The site shows a critical error', symptom: 'white-screen', environment: 'local', root, pages: [] });
    await evidence.run(issue.id, { root, probeOptions: { probe: false } });
    analysis.run(issue.id, { root, config });
    const dir = store.dirOf(issue.id);
    const val = validate.run(issue.id, { root, config, lint: () => ({ ok: true, message: '' }) });
    const policy = validate.policyFor(root, config), plans = resolve.build(issue.id, val, { root, policy, dir });
    result.write(issue.id, { validation: val, plans, dir, root, policy, gate: true });
    const R = n => fs.readFileSync(path.join(dir, 'result', n), 'utf8');
    const files = { 'findings.json': R('findings.json'), 'issue.html': R('issue.html'), 'ISSUE-REPORT.md': R('ISSUE-REPORT.md'), 'tasks.md': R('tasks.md') };
    ok(Object.entries(files).every(([, t]) => !t.includes(V)), 'the secret from the plugin header is in none of findings.json, issue.html, ISSUE-REPORT.md, tasks.md');
    ok(files['findings.json'].includes(`pwd=${M}`) || files['ISSUE-REPORT.md'].includes(`pwd=${M}`), 'the masked text is there instead (the name stays, "[REDACTED]" takes the value)');
    let valid = true; try { JSON.parse(files['findings.json']); } catch { valid = false; }
    const embedded = /<script type="application\/json" id="pg-data">([\s\S]*?)<\/script>/.exec(files['issue.html']);
    let embeddedOk = false; try { embeddedOk = !!embedded && !!JSON.parse(embedded[1].replace(/\\u003c/g, '<')); } catch { embeddedOk = false; }
    ok(valid && embeddedOk && /^<!doctype html>/i.test(files['issue.html']) && /<\/html>\s*$/.test(files['issue.html']), 'findings.json is valid JSON and issue.html still has its embedded data (valid JSON) and its start and end');
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll redact checks passed');
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
