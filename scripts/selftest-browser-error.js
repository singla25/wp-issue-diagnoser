#!/usr/bin/env node
// Self-test of step 4i-b: a browser error named in the description or in the screenshot text is a CLUE ("possible, not confirmed"), never a cause.
// Seen on a real run: the description and the screenshot text named a browser error code and the report did not use it.
// The rules (lib/browser-error.js) accept OCR damage: "NET:ERR_CERT_DATE INVALID" (one colon, a space for an underscore) must work like the clean form.
// Each rule maps to ONE fixed label; the raw words are never kept or shown. Covered here:
//   - find(): clean forms, the damaged form, every family, and ordinary text gives nothing; no label says "expired";
//   - clues.extract: type browser-error, confidence 'possible'; a log source gives no clue, value/detail/snippet hold only the label, one clue per label and source;
//   - the report line (plainNames.browserErrorLines): exact sentence, at most 3, only that clue type;
//   - a real no-files run: the line is in ISSUE-REPORT.md, issue.html, findings.json and the terminal; the verdict is the SAME as for a neutral description.
// No browser or network is needed. Never touches a real site.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pg-beerr-')));
process.env.PLUGIN_GUARD_ISSUES = path.join(tmp, 'issues');
let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const group = t => console.log(`\n== ${t}`);
const CMD = path.join(__dirname, 'plugin-guard.js');
const NOTE = 'Possible, not confirmed: this is a clue, not a cause.';
let B = null; try { B = require('../lib/browser-error'); } catch { /* old code: every check FAILS, the file does not crash */ }
const find = t => (B && typeof B.find === 'function' ? B.find(t) : null);
const ids = t => { const r = find(t); return r ? r.map(x => x.id).join(',') : 'N/A'; };
const clues = require('../issue/clues'), plainNames = require('../lib/plain-names');

const run = description => new Promise(resolve => {
    const before = new Set(fs.existsSync(path.join(tmp, 'issues')) ? fs.readdirSync(path.join(tmp, 'issues')) : []);
    const c = spawn(process.execPath, [CMD, '--description', description, '--no-files', '--yes'], { cwd: tmp, env: { ...process.env } }); let so = '';
    c.stdout.on('data', d => { so += d; }); c.stderr.on('data', () => {});
    c.on('close', code => {
        const dir = fs.readdirSync(path.join(tmp, 'issues')).filter(n => /^iss-/.test(n) && !before.has(n)).map(n => path.join(tmp, 'issues', n))[0] || path.join(tmp, 'none');
        const rd = n => { try { return fs.readFileSync(path.join(dir, 'result', n), 'utf8'); } catch { return ''; } };
        resolve({ status: code, stdout: so, md: rd('ISSUE-REPORT.md'), html: rd('issue.html'), json: rd('findings.json') });
    });
});

(async () => {
    group('find(): one fixed label per family, tolerant to OCR damage');
    ok(ids('NET::ERR_CERT_DATE_INVALID') === 'cert-date', 'the clean form: cert-date');
    ok(ids('NET:ERR_CERT_DATE INVALID') === 'cert-date', 'the damaged form from a real screenshot (one colon, a space for an underscore): cert-date');
    ok(ids('net::err cert date invalid') === 'cert-date' && ids('NET : : ERR-CERT-DATE-INVALID') === 'cert-date', 'lower case, spaces and dashes instead of underscores: still found');
    ok(ids('NET::ERR_CERT_AUTHORITY_INVALID') === 'cert-other' && ids('NET::ERR_CERT_COMMON_NAME_INVALID') === 'cert-other', 'other certificate codes: cert-other (and not cert-date)');
    ok(ids('Your connection is not private') === 'not-private' && ids("Your connection isn't private") === 'not-private' && ids('Your  connection is not   private.') === 'not-private', 'the clean sentence and a spaced one: not-private');
    ok(ids("Your connection isn't private") === 'not-private' && ids('Your connection isn\u2019t private') === 'not-private' && ids('YOUR CONNECTION ISN\'T PRIVATE.') === 'not-private' && ids('This connection isnt private') === '', 'the Edge wording "Your connection isn\'t private" (straight or curly apostrophe, any case) gives not-private; a different sentence does not');
    ok(ids('ERR_TOO_MANY_REDIRECTS') === 'redirects' && ids('example.test redirected you too many times.') === 'redirects', 'too many redirects (code and sentence)');
    ok(ids('ERR_SSL_PROTOCOL_ERROR') === 'ssl' && ids("This site can't provide a secure connection") === 'ssl' && ids('This site can\u2019t provide a secure connection') === 'ssl', 'SSL protocol error and the "can\'t provide a secure connection" sentence');
    ok(ids('The shop page is blank after the update') === '' && ids('') === '' && ids(null) === '' && ids('error 404 not found') === '', 'ordinary text (and empty) gives nothing');
    ok(!!B && B.RULES.every(r => !/expire/i.test(r[2])) && find('NET::ERR_CERT_DATE_INVALID').every(x => !/expire/i.test(x.label)), 'no label says "expired"');
    ok(!!B && JSON.stringify(find('NET::ERR_CERT_DATE_INVALID and Your connection is not private')) === JSON.stringify([{ id: 'cert-date', label: 'a certificate date error' }, { id: 'not-private', label: 'the browser page "your connection is not private"' }]), 'two families in one text: two fixed labels in table order');

    group('clues.extract');
    const DMG = 'The browser shows NET:ERR_CERT_DATE INVALID when I open the site';
    const cd = clues.extract(DMG, { kind: 'description', ref: 'description' }, { confidence: 'possible' }).filter(c => c.type === 'browser-error');
    ok(cd.length === 1 && cd[0].detail.family === 'cert-date' && cd[0].value === 'a certificate date error' && cd[0].confidence === 'possible', 'a description gives one browser-error clue, possible, with the fixed label');
    ok(cd.length === 1 && cd[0].snippet === cd[0].value && !/ERR|NET|INVALID/.test(JSON.stringify(cd[0])), 'value, detail and snippet hold only the label: the raw words are not kept');
    const co = clues.extract('Your connection is not private\nNET::ERR_CERT_DATE_INVALID\nNET::ERR_CERT_DATE_INVALID', { kind: 'ocr', ref: 'shot.png' }, { confidence: 'possible' }).filter(c => c.type === 'browser-error');
    ok(co.length === 2 && co.every(c => c.confidence === 'possible' && c.source.kind === 'ocr'), 'OCR text: one clue per label (a repeated line gives no second clue)');
    const cdc = clues.extract(DMG, { kind: 'description', ref: 'description' }, { confidence: 'certain' }).filter(c => c.type === 'browser-error');
    ok(cdc.length === 1 && cdc[0].confidence === 'possible', 'even when the caller asks for "certain", this clue is only "possible"');
    const cl = clues.extract('cURL error 60: SSL certificate problem: certificate has expired\nhttp_request_failed: Too many redirects\n' + DMG, { kind: 'log', ref: 'debug.log' }, { confidence: 'certain' }).filter(c => c.type === 'browser-error');
    ok(cl.length === 0 && (plainNames.browserErrorLines || (() => ['x']))(cl).length === 0, 'a LOG source gives no browser-error clue: a server cURL error is not a browser error page');
    ok(['concert expired', 'xerr_cert_foo', 'a plugin folder fix-too-many-redirects', 'wp-content/plugins/too-many-redirects/x.php', 'the concert certificate'].every(t => find(t).length === 0), 'ordinary words and plugin folder names do not match (word boundary, hyphen kept)');
    ok(clues.extract('The shop page is blank', { kind: 'description', ref: 'description' }, {}).filter(c => c.type === 'browser-error').length === 0, 'no clue for ordinary text');

    group('the report line');
    const L = plainNames.browserErrorLines ? plainNames.browserErrorLines(cd.concat(co)) : null;
    ok(Array.isArray(L) && L.length === 2 && L[0] === `Your description or screenshot mentions a browser error: a certificate date error. ${NOTE}` && L[1] === `Your description or screenshot mentions a browser error: the browser page "your connection is not private". ${NOTE}`, 'exact sentences, one per label');
    ok(Array.isArray(L) && L.every(x => !/expire|caused by|the cause is|because/i.test(x)), 'the line names no cause and does not say "expired"');
    ok(plainNames.browserErrorLines && plainNames.browserErrorLines([{ type: 'php-fatal', value: 'x' }, null, { type: 'browser-error' }]).length === 0 && plainNames.browserErrorLines(undefined).length === 0, 'other clue types, null and broken entries give no line');
    const many = ['a', 'b', 'c', 'd', 'e'].map(x => ({ type: 'browser-error', value: `label ${x}` }));
    ok(plainNames.browserErrorLines && plainNames.browserErrorLines(many).length === 3, 'at most 3 lines');

    group('a real no-files run');
    const withErr = await run(`The browser says ${'NET:ERR_CERT_DATE INVALID'} when I open the site`), control = await run('The browser shows a warning when I open the site');
    const fe = withErr.json ? JSON.parse(withErr.json) : null, fc = control.json ? JSON.parse(control.json) : null;
    ok(withErr.status === 0 && !!fe && !!fc, 'both runs end with exit 0 and a findings.json');
    const line = `Your description or screenshot mentions a browser error: a certificate date error. ${NOTE}`;
    for (const [name, text] of [['ISSUE-REPORT.md', withErr.md], ['issue.html', withErr.html], ['findings.json', withErr.json], ['terminal output', withErr.stdout]]) ok(text.includes(line.slice(0, 90)) && text.includes('clue, not a cause'), `${name} shows the clue line`);
    ok(fe && fe.browser_error_clues && fe.browser_error_clues.lines[0] === line, 'findings.json browser_error_clues has the line, and only the line');
    ok(fe && fc && JSON.stringify(fe.verdict) === JSON.stringify(fc.verdict) && fe.confidence_text === fc.confidence_text && fe.level === fc.level, `the verdict is the SAME as for a neutral description (label "${fe && fe.verdict.label}", confidence "${fe && fe.verdict.confidence}")`);
    ok(fc && !fc.browser_error_clues && !control.md.includes('mentions a browser error'), 'a neutral description gives no clue line');

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll browser-error checks passed');
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } process.exit(1); });
