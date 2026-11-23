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

// ---------------------------------------------------------------- S0c: the defects D1 to D4 and the minor items (made-up values only)
group('S0c D3: a full stop, a slash or a dash in a value never leaves a tail; neighbouring parameters survive');
{
    const D3 = [
        ['access_token with dots', 'access_token=ya29.a0AfH6SMBsample-1/2_3.more', `access_token=${M}`],
        ['access_token ends a sentence', 'The access_token=ya29.a0AfH6SMBsample. Next sentence.', `The access_token=${M}. Next sentence.`],
        ['client_secret with a dot', 'client_secret=GOCSPX-abc.def&x=1', `client_secret=${M}&x=1`],
        ['refresh_token with // and a dot', 'refresh_token=1//0gabc-def_ghiJKL.more', `refresh_token=${M}`],
        ['_wpnonce ends a sentence', `Link has _wpnonce=${N}.`, `Link has _wpnonce=${M}.`],
        ['any *_token name', 'form_token=SAMPLEvalue.12-34 end', `form_token=${M} end`],
        ['any *_secret name in JSON', '{"stripe_secret":"SAMPLE.val/ue-1234"}', `{"stripe_secret":"${M}"}`],
        ['a token before another parameter', 'https://e.test/?token=SAMPLEabc.123&page=2', `https://e.test/?token=${M}&page=2`]
    ];
    for (const [name, input, want] of D3) { const got = redact.text(input); ok(got === want && redact.text(got) === got, `${name}: ${got === want ? 'masked, no tail, masking twice changes nothing' : got}`); }
    const fid = require('../issue/fidelity');
    ok(fid.pageKeyOf('https://e.test/?token=abcdef&page=2') !== fid.pageKeyOf('https://e.test/?token=abcdef&page=3'), 'pageKeyOf: ?token=abcdef&page=2 and &page=3 are two different pages');
    ok(fid.pageKeyOf('https://e.test/?token=abcdef&page=2') === fid.pageKeyOf('https://e.test/?token=ghijkl&page=2'), 'pageKeyOf: the same page with another secret value is the same page');
}

group('S0c D4: pwd, user_pass, pass1, pass2 and the Authorization family in JSON, colon and PHP-dump forms');
{
    const P = 'S3cretPass';
    const D4 = [
        ['pwd in JSON', `{"pwd":"${P}"}`, `{"pwd":"${M}"}`], ['pwd in JSON with a space after the colon', `{"pwd": "${P}"}`, `{"pwd": "${M}"}`],
        ['user_pass, colon', `user_pass: ${P}`, `user_pass: ${M}`], ['pass1 in JSON', `{"pass1":"${P}","pass2":"${P}"}`, `{"pass1":"${M}","pass2":"${M}"}`],
        ['pwd, PHP dump', `[pwd] => hunter22`, `[pwd] => ${M}`], ['user_pass, PHP dump', `[user_pass] => hunter22`, `[user_pass] => ${M}`],
        ['PHP_AUTH_PW, PHP dump', `[PHP_AUTH_PW] => hunter22`, `[PHP_AUTH_PW] => ${M}`], ['PHP_AUTH_PW with =', `PHP_AUTH_PW=hunter22`, `PHP_AUTH_PW=${M}`],
        ['HTTP_AUTHORIZATION Basic, PHP dump', `[HTTP_AUTHORIZATION] => Basic dXNlcjpwYXNzd29yZA==`, `[HTTP_AUTHORIZATION] => Basic ${M}`],
        ['HTTP_AUTHORIZATION Bearer, PHP dump', `[HTTP_AUTHORIZATION] => Bearer abcdefghijklmnop`, `[HTTP_AUTHORIZATION] => Bearer ${M}`],
        ['Authorization in JSON', `{"Authorization":"Basic dXNlcjpwYXNzd29yZA=="}`, `{"Authorization":"Basic ${M}"}`],
        ['HTTP_AUTHORIZATION without a scheme', `HTTP_AUTHORIZATION=dXNlcjpwYXNzd29yZA==`, `HTTP_AUTHORIZATION=${M}`],
        ['the = form still works', `pwd=${P}&x=1`, `pwd=${M}&x=1`]
    ];
    for (const [name, input, want] of D4) { const got = redact.text(input); ok(got === want && redact.text(got) === got, `${name}: ${got === want ? 'masked' : got}`); }
}

group('S0c minor items');
{
    const cases = [
        ['a quoted cookie value', `Cookie: wordpress_logged_in_0123abcd="${V}|1700000000|abc"; a=b`, v => !v.includes(V) && !v.includes('1700000000')],
        ['security= as a nonce', `admin-ajax.php?action=x&security=${N}&y=1`, v => v === `admin-ajax.php?action=x&security=${M}&y=1`],
        ['"nonce" in JSON', `{"nonce":"${N}","a":1}`, v => v === `{"nonce":"${M}","a":1}`],
        ['a <name>-nonce form field', `woocommerce-login-nonce=${N}&_wp_http_referer=%2Fmy-account%2F`, v => v === `woocommerce-login-nonce=${M}&_wp_http_referer=%2Fmy-account%2F`],
        ['double encoding (%253D, %2526)', `x?a%253D1%2526access_token%253D${V}%2526b%253D2`, v => v === `x?a%253D1%2526access_token%253D${M}%2526b%253D2`],
        ['double encoded rm_token', `x%2526rm_token%253D${TOK}%2526b`, v => !v.includes(TOK) && v.endsWith('%2526b')],
        ['an &amp;-escaped address', `https://e.test/?a=1&amp;access_token=${V}&amp;b=2`, v => v === `https://e.test/?a=1&amp;access_token=${M}&amp;b=2`],
        ['an &amp;-escaped key parameter', `https://e.test/wp-login.php?action=rp&amp;key=${V}&amp;login=a`, v => v === `https://e.test/wp-login.php?action=rp&amp;key=${M}&amp;login=a`],
        ['a JWT with = padding', `jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.SAMPLEsignature12345678== end`, v => v === `jwt ${M} end`],
        ['a Markdown code span keeps its closing backtick', '`api_key=abc123456` and `password=hunter2hunter2`', v => v === `\`api_key=${M}\` and \`password=${M}\``],
        ['a quoted password with a space', `{"pwd":"two words ${V}"}`, v => v === `{"pwd":"${M}"}`]
    ];
    for (const [name, input, check] of cases) { const got = redact.text(input); ok(check(got) && redact.text(got) === got, `${name}: ${check(got) ? 'masked' : got}`); }
    const keep = ['pwd=wp_hash_password($x)', 'pwd=wp_hash_password(x)', 'user_pass = wp_hash_password( $pass )', 'pwd: /srv/site', 'nonce: wpApiSettings.nonce', 'security: high', 'form_token=getToken()'];
    for (const t of keep) ok(redact.text(t) === t, `not a secret, unchanged: ${t}`);
    // known limit (docs/SAFETY.md section 6): an UNQUOTED password that contains a space keeps the part after the first space
    ok(redact.text('user_pass=ab cd').startsWith(`user_pass=${M}`), 'known limit: an unquoted password with a space is masked only up to the first space (documented)');
    // the output is still valid JSON when a JSON text with secrets is masked string by string (deep) and when it is masked as one text
    const j = { a: `{"pwd":"${V}"}`, b: [`token=${V}&x=1`], c: { d: 'ok' } };
    ok(JSON.parse(JSON.stringify(redact.deep(j))).c.d === 'ok' && !JSON.stringify(redact.deep(j)).includes(V), 'deep() keeps the structure and masks the values');
    const big = 'GET /a?x=1&token=SAMPLEvalue.123 HTTP/1.1 pwd=abc "a":"b" '.repeat(3500);
    const t0 = Date.now(); redact.text(big);
    ok(big.length > 200000 && Date.now() - t0 < 200, `speed: ${big.length} characters with many secrets took ${Date.now() - t0} ms (under 200 ms)`);
    const hostile = ['access_token='.repeat(15000), 'pwd=' + '"'.repeat(60000), '1_'.repeat(60000) + 'token=x', 'a1'.repeat(70000) + '_token=abcdefghij', '[pwd] => '.repeat(15000)];
    const t1 = Date.now(); hostile.forEach(h => redact.text(h));
    ok(Date.now() - t1 < 2000, `hostile inputs (${hostile.length}, up to 140 KB) took ${Date.now() - t1} ms (under 2 s)`);
}

group('S0c review round 1: short values with a tail, long quoted values, escaped JSON, code in patches, a slow input');
{
    const cases = [
        ['a short password ending in !!!', 'password=Abc12!!!', `password=${M}`], ['a password with :digits', 'password=pass:1234', `password=${M}`],
        ['an api_key with :digits', 'api_key=abcd:123456', `api_key=${M}`], ['a client_secret with :digits', 'client_secret=AKID:5839201945', `client_secret=${M}`],
        ['a value with a port-like tail', 'password=hunter2:443', `password=${M}`],
        ['a stack-trace address keeps :line:column', `at https://e.test/x.js?access_token=${V}:1:2`, `at https://e.test/x.js?access_token=${M}:1:2`],
        ['a quoted value longer than 2000 characters', `password="${'x'.repeat(2100)}TAILSECRET"`, `password="${M}"`],
        ['escaped JSON inside a log string', '{\\"password\\":\\"hunter2abc\\"}', `{\\"password\\":\\"${M}\\"}`],
        ['an escaped quote inside a JSON value', '{"pwd":"a\\"bcdef"}', `{"pwd":"${M}"}`]
    ];
    for (const [name, input, want] of cases) { const got = redact.text(input); ok(got === want && redact.text(got) === got, `${name}: ${got === want ? 'masked' : got}`); }
    const code = ['+    $token = sanitize_text_field( $_GET["token"] );', '+    $secret = get_option( "x_secret" );', '+    $password = wp_generate_password( 12 );', '-    $token = $this->get_token();'];
    for (const t of code) ok(redact.text(t) === t, `code in a patch is not changed: ${t}`);
    ok(redact.text("+    $token = 'abcdefghijkl';").includes(M), 'a literal secret in a patch line is masked');
    const t0 = Date.now();
    for (const h of ['token=a' + '!'.repeat(200000) + 'b', 'password=a' + '.'.repeat(200000) + 'b', 'token=a' + ':1'.repeat(100000), 'pwd="'.repeat(40000), 'pwd=\\"'.repeat(40000), 'password="' + 'a'.repeat(200000)]) redact.text(h);
    ok(Date.now() - t0 < 1000, `six hostile 200 KB inputs (long runs of ! . :1 and quotes) took ${Date.now() - t0} ms (under 1 s)`);
}

group('S0c review round 2: nonce tails, backtick values, hashes, unclosed quotes, more code forms');
{
    const mask = [
        ['a nonce followed by #fragment', '/wp-admin/post.php?action=trash&_wpnonce=a1b2c3d4e5#top', `/wp-admin/post.php?action=trash&_wpnonce=${M}`],
        ['a nonce followed by !', '_wpnonce=a1b2c3d4e5!', `_wpnonce=${M}`], ['X-WP-Nonce followed by |', 'X-WP-Nonce: a1b2c3d4e5|x', `X-WP-Nonce: ${M}`],
        ['a value in backticks', 'password: `hunter22`', `password: \`${M}\``], ['a token in backticks', 'token: `abcdef123456`', `token: \`${M}\``],
        ['a phpass hash', '"password":"$P$BabcdefGhijklmnop"', `"password":"${M}"`], ['a bcrypt hash', 'password=$2y$10$abcdefghijklmnopqrstuv', `password=${M}`],
        ['%s followed by letters is a value', 'secret=%s3cr3tvalue', `secret=${M}`],
        ['an unclosed quote keeps the rest of a Markdown table row', "| log | token: 'abc12345 seen | **High** |", `| log | token: '${M} seen | **High** |`],
        ['an unclosed quote keeps a later link', "The session's cookie='x1234567 expired; see [docs](https://x.org)", `The session's cookie='${M} expired; see [docs](https://x.org)`]
    ];
    for (const [name, input, want] of mask) { const got = redact.text(input); ok(got === want && redact.text(got) === got, `${name}: ${got === want ? 'masked' : got}`); }
    for (const t of ['$token = (string) $raw;', '$password = !empty($p) ? 1 : 2;', '$token = sanitize_key ( $x );', '$secret = self::SECRET_KEY;', '$password = PASSWORD_DEFAULT;', '$cookie = COOKIEHASH;', '-    $token = $this->get_token();', 'secret = %s', 'token = ?'])
        ok(redact.text(t) === t, `code or a placeholder is not changed: ${t}`);
}

group('S0c review round 3: code-looking values are skipped only in a code context; name=value and quoted values are always masked');
{
    const mask = [
        ['a value followed by a space and (', 'password=hunter22 (changed yesterday)', `password=${M} (changed yesterday)`],
        ['an all-capital password', 'password=SUPERSECRET', `password=${M}`], ['an all-capital quoted password', 'password: "SUPERSECRET"', `password: "${M}"`],
        ['an all-capital token', 'token=ABCDEFGHIJ', `token=${M}`],
        ['a password that starts with $ (query)', 'password=$uperman1', `password=${M}`], ['a password that starts with $ (JSON)', '"password":"$uperman1"', `"password":"${M}"`],
        ['a password that looks like this.x', 'pwd=this.isMyPass9', `pwd=${M}`], ['a password that looks like Options-2024', 'pwd=Options-2024', `pwd=${M}`],
        ['a client_secret that starts with env-', 'client_secret=env-prod-abc123', `client_secret=${M}`],
        ['a quoted null-looking word is still a word', 'token: "abcdefgh"', `token: "${M}"`]
    ];
    for (const [name, input, want] of mask) { const got = redact.text(input); ok(got === want && redact.text(got) === got, `${name}: ${got === want ? 'masked' : got}`); }
    for (const t of ['$password = $_POST["x"];', '$token = $this->get_token();', 'auth_token = this.get();', 'api_secret: process.env.API_SECRET;', '$secret = self::SECRET_KEY;', 'token = getToken();'])
        ok(redact.text(t) === t, `still unchanged in a code context: ${t}`);
}

group('S0c D2: probe output is masked everywhere it is stored, and a failed mask leaves no raw file (fail closed)');
{
    const probeMod = require('../issue/probe');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-redact-fc-'));
    const f = path.join(tmp, 'result.json');
    // a partial file (the worker was killed in the middle of writing): not JSON, still holds a raw secret
    fs.writeFileSync(f, `{"pages":[{"url":"https://e.test/?_wpnonce=${N}&access_token=${V}","text":"`);
    ok(probeMod.maskRaw(null, f) === null && (!fs.existsSync(f) || !fs.readFileSync(f, 'utf8').includes(V)), 'a partial raw file: it is deleted (or emptied), no raw secret stays on disk');
    // masking throws (a getter that throws) -> the raw file is deleted too
    fs.writeFileSync(f, `{"raw":"${V}"}`);
    const bad = { get boom() { throw new Error('mask failed'); } };
    let thrown = false, gotBad; try { gotBad = probeMod.maskRaw(bad, f); } catch { thrown = true; }
    ok(!thrown && gotBad === null && !fs.existsSync(f), 'masking that fails: nothing is thrown, null is returned and the raw file is deleted');
    // the rewrite fails (the target is a directory) -> null, and nothing raw is left in the folder
    fs.mkdirSync(path.join(tmp, 'dir.json'));
    ok(probeMod.maskRaw({ a: `token=${V}` }, path.join(tmp, 'dir.json')) === null, 'a rewrite that fails: null is returned (nothing is reported as stored)');
    ok(typeof probeMod.NOT_STORED === 'string' && /not stored/.test(probeMod.NOT_STORED), 'the plain reason for "not stored" is exported');
    fs.rmSync(tmp, { recursive: true, force: true });
}

group('S0c patches, shims and the FIX-PLAN evidence line are masked');
{
    const resultSrc = fs.readFileSync(path.join(__dirname, '..', 'issue', 'result.js'), 'utf8');
    ok(/redact\.text\(o\.diff\)/.test(resultSrc) && /redact\.text\(o\.php\)/.test(resultSrc), 'issue/result.js writes the patch (.diff) and the shim (.php) through redact.text');
    const fixplan = require('../issue/fix-plan');
    const tmpR = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-redact-fp-'));
    fs.mkdirSync(path.join(tmpR, 'wp-content', 'plugins', 'acme'), { recursive: true });
    fs.writeFileSync(path.join(tmpR, 'wp-content', 'plugins', 'acme', 'changelog.txt'), `1.0 compatible with Woo version 8.1.2 api_key=${V}\n`);
    const ev = fixplan.compatEvidence(tmpR, { comp: { kind: 'plugin', rel: 'wp-content/plugins/acme' }, provider: { name: 'Woo' } });
    ok(ev && /compatible with Woo version 8\.1\.2/.test(ev.text) && !ev.text.includes(V) && ev.text.includes(`api_key=${M}`), `the compatibility-evidence line (read from the site's own files) is masked: ${ev && ev.text}`);
    fs.rmSync(tmpR, { recursive: true, force: true });
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

    // ---- S0c D1: end to end. A failing page whose address holds a secret-looking part (?token=abcdef123&page=2) must be matched by the retest:
    // "Fixed" when fixed, "Still failing" when not, never "Could not test ... not loaded this time". Real probe worker (Chromium) against a fixture on 127.0.0.1.
    group('S0c D1: retest matches a failing page whose address has a maskable part (end to end)');
    {
        const http = require('http');
        const probeMod = require('../issue/probe'), retest = require('../issue/retest');
        const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-redact-e2e-'));
        process.env.PLUGIN_GUARD_ISSUES = path.join(tmp2, 'issues');
        delete require.cache[require.resolve('../lib/issue-store')];
        const store2 = require('../lib/issue-store');
        let broken = true;
        const server = http.createServer((req, res) => {
            if (req.method === 'GET' && req.url.startsWith('/cart/')) {
                res.writeHead(broken ? 500 : 200, { 'Content-Type': 'text/html' });
                res.end(broken ? '<html><body>There has been a critical error on this website.</body></html>' : '<!doctype html><html><head><title>Cart</title></head><body><p>Your cart works and this page has enough text to look real.</p></body></html>');
            } else { res.writeHead(404, { 'Content-Type': 'text/html' }); res.end('<html><body>Nothing here.</body></html>'); }
        });
        await new Promise(r => server.listen(0, '127.0.0.1', r));
        const url = `http://127.0.0.1:${server.address().port}`;
        const ENV = { ...process.env, PG_PROBE_NAV_DELAY_MS: '0', PG_PROBE_REQUEST_DELAY_MS: '0', PG_PROBE_5XX_RETRY_DELAY_MS: '0', PG_PROBE_COOLDOWN_FILE: path.join(tmp2, 'cool.json') };
        const PAGE = '/cart/?token=abcdef123&page=2';
        const make = () => store2.create({ title: 'Cart fails', description: 'the cart shows an error', symptom: 'white-screen', environment: 'local', url, pages: [PAGE], oracle: { type: 'http-5xx' } });
        try {
            for (const fixed of [true, false]) {
                broken = true;
                const iss = make(), dir2 = store2.dirOf(iss.id);
                const r0 = await probeMod.run(iss.id, { root: null, options: { viewports: 'laptop', layout: false }, env: ENV });
                const pj = JSON.parse(fs.readFileSync(path.join(dir2, 'work', 'probe.json'), 'utf8'));
                ok(r0.oracle && r0.oracle.result === 'yes' && pj.oracle.matches.length >= 1, `[${fixed ? 'fixed' : 'not fixed'}] the first run saw the failure on the page with ?token=...&page=2 (oracle yes)`);
                const stored = JSON.stringify(pj) + JSON.stringify(r0.clues) + JSON.stringify(r0.steps);
                ok(!stored.includes('abcdef123') && pj.oracle.matches.every(m => m.page.includes('token=[REDACTED]') && m.page.includes('page=2')), `[${fixed ? 'fixed' : 'not fixed'}] probe.json, the clues and the steps hold the page address masked (oracle matches included), the other parameter kept`);
                broken = !fixed;
                const rt = await retest.run(iss.id, { root: null, options: { viewports: 'laptop', layout: false }, env: ENV });
                const history = JSON.parse(fs.readFileSync(path.join(dir2, 'result', 'retests.json'), 'utf8'));
                ok(rt.entry.verdict === (fixed ? 'Fixed' : 'Still failing'), `[${fixed ? 'fixed' : 'not fixed'}] the retest says "${fixed ? 'Fixed' : 'Still failing'}" (got "${rt.entry.verdict}": ${rt.entry.reason.slice(0, 160)})`);
                ok(!/not loaded this time|Could not test/.test(rt.entry.verdict + rt.entry.reason), `[${fixed ? 'fixed' : 'not fixed'}] never "Could not test ... not loaded this time"`);
                const found = []; (function walk(d) { for (const n of fs.readdirSync(d)) { const f = path.join(d, n), st = fs.lstatSync(f); if (st.isDirectory()) walk(f); else if (st.isFile() && !/\.(png|jpe?g)$/.test(n) && fs.readFileSync(f, 'utf8').includes('abcdef123')) found.push(path.relative(dir2, f)); } })(dir2);
                ok(found.sort().join(',') === 'issue.json,issue.md', `[${fixed ? 'fixed' : 'not fixed'}] known limit (docs/SAFETY.md section 6): only issue.json and issue.md keep the page address as the reporter typed it (the probe needs it to load the page); found in: ${found.join(', ') || 'none'}`);
                ok(!fs.existsSync(path.join(dir2, 'work', 'probe', 'job.json')) && !fs.existsSync(path.join(dir2, 'work', 'probe', 'result.json')) || !fs.readFileSync(path.join(dir2, 'work', 'probe', 'result.json'), 'utf8').includes('abcdef123'), `[${fixed ? 'fixed' : 'not fixed'}] the worker's job file is not kept and the stored worker result is masked`);
                ok(!JSON.stringify(history).includes('abcdef123'), `[${fixed ? 'fixed' : 'not fixed'}] retests.json holds no raw secret`);
            }
            // an investigation made by the older version (raw match address, masked page address) is also matched, because both sides are masked
            const cmp = retest.compare([{ page: `${url}/cart/?token=abcdef123&page=2`, viewport: 'laptop' }], { result: 'no', pages: [{ url: `${url}/cart/?token=[REDACTED]&page=2`, viewport: 'laptop', loaded: true }], matches: [] });
            ok(cmp.verdict === 'Fixed' && !cmp.reason.includes('abcdef123'), 'compare(): a raw failing address and a masked loaded address are the same page; the reason holds no raw secret');
            const cmp2 = retest.compare([{ page: `${url}/cart/?token=abcdef123&page=2`, viewport: 'laptop' }], { result: 'no', pages: [{ url: `${url}/cart/?token=[REDACTED]&page=3`, viewport: 'laptop', loaded: true }], matches: [] });
            ok(cmp2.verdict === 'Could not test', 'compare(): &page=2 and &page=3 stay two different pages');
        } finally { server.close(); fs.rmSync(tmp2, { recursive: true, force: true }); }
    }
    console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll redact checks passed');
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
