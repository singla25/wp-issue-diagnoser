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

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll redact checks passed');
process.exit(failures ? 1 : 0);
