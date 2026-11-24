#!/usr/bin/env node
// Self-test of lib/address-check.js: a website address (or page address) with hidden characters is REFUSED, never cleaned.
// Seen on a real run: arrow-key codes (ESC [ D) typed into the address question were accepted, the probe loaded /path/%1B[D%1B[D, and the report said the address
// answered HTTP 404 although the real page was never tested.
//
// The refused set (the same list is in the comment of lib/address-check.js):
//   C0 controls U+0000-U+001F, DEL U+007F, C1 controls U+0080-U+009F, any whitespace inside (ASCII space and all Unicode whitespace such as U+00A0, U+2028, U+2029),
//   U+200B-U+200F, U+2060, U+FEFF, the direction overrides U+202A-U+202E and U+2066-U+2069, and percent-encoded control codes %00-%1F and %7F (any letter case).
//   Allowed: a typed %20, ordinary and international addresses, and trimming of ASCII space, tab, CR and LF at the two ends.
// Covered here:
//   - addressProblem on every class (and the sentence never repeats the address);
//   - the store (lib/issue-store.js create), the wizard question (asks again; closed input does not loop), the --url flag (exit 2, nothing created);
//   - the probe on a SAVED bad address: no request reaches a fixture server, the step says the exact sentence, the verdict is not stronger, never "no address was given";
//   - retest on such an issue never gives FIXED_VERIFIED; `issue show` and `issue list` on it do not crash;
//   - normal addresses still work (a guard that also passes on old code).
// Chromium and a fixture server on 127.0.0.1 only. Never touches a real site.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { PassThrough } = require('stream');
const { spawnSync, spawn } = require('child_process');

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pg-addr-')));
process.env.PLUGIN_GUARD_ISSUES = path.join(tmp, 'issues');
const ENVX = { PG_PROBE_NAV_DELAY_MS: '0', PG_PROBE_REQUEST_DELAY_MS: '0', PG_PROBE_5XX_RETRY_DELAY_MS: '0', PG_PROBE_COOLDOWN_FILE: path.join(tmp, 'cool.json') };
Object.assign(process.env, ENVX);
const store = require('../lib/issue-store');
const wizard = require('../lib/wizard');
const probeMod = require('../issue/probe');
const retest = require('../issue/retest');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const group = t => console.log(`\n== ${t}`);
const CMD = path.join(__dirname, 'plugin-guard.js'), GUARD = path.join(__dirname, 'guard.js');
const SENTENCE = 'The address has hidden characters or spaces, maybe from arrow keys. Type it again.';
const STEP = 'The saved address has hidden characters, so the live page was not checked.';
const ESC = '\x1b';
const OK200 = '<!doctype html><html><head><title>Fixture</title></head><body><h1>Fixture shop</h1><p>The page works and has enough text to look like a real page.</p></body></html>';

// ---- the module may not exist on old code: every check then FAILS (it is a new feature), it does not crash the file ----
let A = null; try { A = require('../lib/address-check'); } catch { /* old code */ }
const bad = s => !!A && typeof A.addressProblem === 'function' && A.addressProblem(s) === SENTENCE;
const fine = s => !!A && typeof A.addressProblem === 'function' && A.addressProblem(s) === null;

const server = () => new Promise(resolve => {
    const st = { hits: [], sv: null };
    st.sv = http.createServer((q, res) => { st.hits.push(q.url); res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(OK200); });
    st.sv.listen(0, '127.0.0.1', () => { st.port = st.sv.address().port; resolve(st); });
});
const runAsync = (cmd, args, extra = {}) => new Promise(resolve => {
    const c = spawn(process.execPath, [cmd, ...args], { cwd: tmp, env: { ...process.env, ...extra } }); let stdout = '', stderr = '';
    c.stdout.on('data', d => { stdout += d; }); c.stderr.on('data', d => { stderr += d; }); c.on('close', code => resolve({ status: code, stdout, stderr }));
});
const issueDirs = () => { try { return fs.readdirSync(path.join(tmp, 'issues')).filter(n => /^iss-/.test(n)); } catch { return []; } };
const editIssue = (id, fn) => { const f = path.join(store.dirOf(id), 'issue.json'); const d = JSON.parse(fs.readFileSync(f, 'utf8')); fn(d); fs.writeFileSync(f, JSON.stringify(d, null, 2)); };
const newIssue = (name, url, extra = {}) => store.create({ title: name, description: 'fixture', symptom: 'other', environment: 'local', url, pages: [], oracle: { type: 'console-error', value: 'zzz-never-seen' }, ...extra });
const wiz = async (answers, flags) => {
    const input = new PassThrough(), output = new PassThrough(); let text = ''; output.on('data', d => { text += d; });
    input.end(answers.join('\n') + (answers.length ? '\n' : ''));
    let error = null, code = null;
    try { code = await Promise.race([wizard.run({ _: [], description: 'x', 'no-files': true, 'no-probe': true, 'no-questions': true, ...flags }, { input, output, tty: true, cwd: tmp, env: { HOME: tmp }, preflight: () => ({ ok: false }), siteRoots: [] }), new Promise((_, r) => setTimeout(() => r(new Error('HANG: the wizard did not end')), 20000))]); } catch (e) { error = e; }
    return { text, error, code };
};

(async () => {
    group('addressProblem: the refused set, class by class (and the allowed ones)');
    const cls = (name, ch) => ok(bad(`https://a.test/p${ch}x`), `${name} inside the address: refused with the plain sentence`);
    cls('ESC with arrow-key codes', `${ESC}[D${ESC}[D`);
    cls('NUL (U+0000)', '\u0000'); cls('C0 U+0001', '\u0001'); cls('tab (U+0009)', '\t'); cls('line feed (U+000A)', '\n'); cls('carriage return (U+000D)', '\r'); cls('C0 U+001F', '\u001f');
    cls('DEL (U+007F)', '\u007f'); cls('C1 U+0080', '\u0080'); cls('C1 U+0085', '\u0085'); cls('C1 U+009F', '\u009f');
    cls('an ASCII space', ' '); cls('no-break space (U+00A0)', '\u00a0'); cls('line separator (U+2028)', '\u2028'); cls('paragraph separator (U+2029)', '\u2029'); cls('ideographic space (U+3000)', '\u3000'); cls('narrow no-break space (U+202F)', '\u202f'); cls('en space (U+2002)', '\u2002');
    cls('zero width space (U+200B)', '\u200b'); cls('zero width joiner (U+200D)', '\u200d'); cls('left-to-right mark (U+200E)', '\u200e'); cls('right-to-left mark (U+200F)', '\u200f');
    cls('word joiner (U+2060)', '\u2060'); cls('byte order mark (U+FEFF)', '\ufeff'); cls('direction override (U+202E)', '\u202e'); cls('direction isolate (U+2066)', '\u2066');
    ok(bad('https://a.test/%1B[D') && bad('https://a.test/%1b[d') && bad('https://a.test/%00') && bad('https://a.test/%0A') && bad('https://a.test/%1F') && bad('https://a.test/%7F') && bad('https://a.test/%7f') && bad('https://a.test/?q=a%09b'), 'percent-encoded control codes %00-%1F and %7F (any letter case) are refused: %1B[D, %0A, %09, %7F');
    ok(fine('https://a.test/a%20b') && fine('https://a.test/%7E') && fine('https://a.test/%20') && fine('https://a.test/a%2Fb') && fine('https://a.test/%80') && fine('https://a.test/%C3%BC'), 'a typed %20 and other percent codes outside the control range stay allowed (%20, %7E, %2F, %80, %C3%BC)');
    ok(fine('https://example.com/') && fine('http://127.0.0.1:8080/a/b?x=1&y=2#frag') && fine('https://[::1]:8443/path') && fine('https://münchen.example/ü?q=ä') && fine('example.test/a_b-c.d~e'), 'ordinary addresses: https with path, query, fragment, port, IPv6 and an international name stay allowed');
    ok(fine('  https://a.test/  ') && fine('https://a.test/\n') && fine('\thttps://a.test/\r\n') && fine(''), 'only the two ends are trimmed: ASCII space, tab, CR and LF at an end are allowed; an empty answer is not an error');
    ok(bad('\u00a0https://a.test/') && bad('https://a.test/\u00a0') && bad('\u200bhttps://a.test/'), 'but any other hidden or Unicode-space character at an END is refused (it is not trimmed): U+00A0, U+200B');
    ok(A && A.addressProblem(`https://a.test/${ESC}[D`) && !A.addressProblem(`https://a.test/${ESC}[D`).includes(ESC) && !A.addressProblem('https://secret-host.test/x y').includes('secret-host'), 'the sentence never repeats the address (no ESC, no host name in it)');
    ok(A && A.addressProblem(null) === null && A.addressProblem(undefined) === null, 'null and undefined: no problem (nothing to check)');

    group('the store refuses it (lib/issue-store.js create)');
    const tryCreate = input => { try { const r = store.create({ title: 't', description: 'd', symptom: 'other', environment: 'local', oracle: { type: 'console-error', value: 'x' }, ...input }); return { ok: true, r }; } catch (e) { return { ok: false, msg: String(e.message) }; } };
    const st1 = tryCreate({ url: `http://127.0.0.1:9/p/${ESC}[D${ESC}[D` });
    ok(!st1.ok && st1.msg.includes(SENTENCE) && !st1.msg.includes(ESC) && issueDirs().length === 0, 'url with arrow-key codes: create refuses with the plain sentence (no ESC in it) and no issue folder is made');
    const st2 = tryCreate({ url: 'http://127.0.0.1:9/p/%1B[D%1B[D' });
    ok(!st2.ok && st2.msg.includes(SENTENCE) && issueDirs().length === 0, 'url with percent-encoded control codes (%1B[D): refused');
    const st3 = tryCreate({ url: 'http://127.0.0.1:9/a b' });
    ok(!st3.ok && st3.msg.includes(SENTENCE), 'url with a space inside: refused');
    const st4 = tryCreate({ url: 'http://127.0.0.1:9/', pages: [`/p/${ESC}[D`] });
    ok(!st4.ok && st4.msg.includes(SENTENCE) && !st4.msg.includes(ESC), 'a page path with arrow-key codes: refused');
    const st5 = tryCreate({ url: 'http://127.0.0.1:9/', pages: ['http://127.0.0.1:9/x%00y'] });
    ok(!st5.ok && st5.msg.includes(SENTENCE), 'a page address with %00: refused');
    const st6 = tryCreate({ url: '  http://127.0.0.1:9/a%20b/  ', pages: ['/ok?x=1', 'http://127.0.0.1:9/two'] });
    ok(st6.ok && st6.r.url === 'http://127.0.0.1:9/a%20b/' && st6.r.pages.length === 2, 'guard: a normal address with a typed %20 and spaces at the ends is accepted and stored trimmed; normal pages too');

    group('the --url flag: exit 2, the same sentence, nothing created, no request');
    const before = issueDirs().length;
    const sv = await server();
    const f1 = await runAsync(CMD, ['--description', 'x', '--no-files', '--yes', '--url', `http://127.0.0.1:${sv.port}/p/${ESC}[D${ESC}[D`, '--env', 'local'], ENVX);
    ok(f1.status === 2 && f1.stderr.includes(SENTENCE) && !f1.stderr.includes(ESC) && issueDirs().length === before && sv.hits.length === 0, `--url with arrow-key codes: exit ${f1.status}, the sentence, no ESC echoed, no issue folder, no request (${sv.hits.length})`);
    const f2 = await runAsync(CMD, ['--description', 'x', '--no-files', '--yes', '--url', `http://127.0.0.1:${sv.port}/p/%1B[D`, '--env', 'local'], ENVX);
    ok(f2.status === 2 && f2.stderr.includes(SENTENCE) && issueDirs().length === before && sv.hits.length === 0, `--url with %1B[D: exit ${f2.status}, the sentence, nothing created, no request`);
    const f3 = await runAsync(GUARD, ['issue', 'new', '--title', 't', '--description', 'd', '--symptom', 'other', '--no-prompt', '--no-questions', '--url', `http://127.0.0.1:${sv.port}/a%1B[D`, '--env', 'local', '--no-files'], ENVX);
    ok(f3.status === 2 && (f3.stderr + f3.stdout).includes(SENTENCE) && issueDirs().length === before && sv.hits.length === 0, `guard issue new --url with hidden characters: refused (exit ${f3.status}), nothing created, no request`);
    const f4 = await runAsync(CMD, ['--description', 'x', '--no-files', '--yes', '--url', `http://127.0.0.1:${sv.port}/a%20b`, '--env', 'local', '--no-probe'], ENVX);
    ok(f4.status === 0 && issueDirs().length === before + 1, `guard: --url with a typed %20 still works (exit ${f4.status}, one issue folder)`);
    sv.sv.close();

    group('the wizard question: it asks again, and closed input does not loop');
    const w1 = await wiz(['', `${ESC}[D${ESC}[D`, 'http://127.0.0.1:9/', '', '', 'n'], {});
    const asks = (w1.text.match(/Website address \(https:\/\/\.\.\.\)/g) || []).length;
    ok(!w1.error && w1.text.includes(SENTENCE) && asks === 2 && !/http:\/\/127\.0\.0\.1:9\//.test(w1.text.split(SENTENCE)[0]) && /LOCAL site \(127\.0\.0\.1\)/.test(w1.text), `a bad answer: the sentence is shown, the question is asked again (${asks} times), the next good answer is used (it goes on to the kind question)`);
    const w2 = await wiz(['', 'http://127.0.0.1:9/a b', 'http://127.0.0.1:9/', '', '', 'n'], {});
    ok(!w2.error && w2.text.includes(SENTENCE) && /LOCAL site/.test(w2.text), 'a space inside is refused the same way, and the next good answer is used');
    const w3 = await wiz(['', `${ESC}[D`], {});
    ok(w3.error && w3.error.exitCode === 2 && w3.error.message === 'The input ended before a usable website address was typed.' && w3.text.includes(SENTENCE), `closed input after a bad answer: it ends at once with exit 2 and "${w3.error && w3.error.message}" (it does not loop)`);
    const w4 = await wiz(['', `${ESC}[D`, `${ESC}[D`], {});
    ok(w4.error && w4.error.exitCode === 2 && /usable website address/.test(w4.error.message) && (w4.text.match(new RegExp(SENTENCE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length === 2, 'two bad answers and then the end of the input: the sentence is shown twice, then exit 2 (no endless loop)');
    const w5 = await wiz(['', ''], {});
    ok(!(w5.error && /HANG|usable website address/.test(w5.error.message)) && w5.text.split('Website address').length === 2, 'guard: Enter (skip) at the address question is unchanged: asked once, no refusal message');
    const w6 = await wiz([''], { url: `http://127.0.0.1:9/${ESC}[D` });
    ok(w6.error && w6.error.exitCode === 2 && w6.error.message.includes(SENTENCE) && !w6.error.message.includes(ESC), 'the wizard with the --url value (not asked): refused with exit 2 and the sentence');

    group('the probe on a SAVED bad address: no request, the exact sentence, no stronger verdict');
    const run = async (id, extra = {}) => probeMod.run(id, { root: null, options: { viewports: 'laptop', layout: false }, env: { ...process.env, ...ENVX }, ...extra });
    const readProbe = id => { try { return JSON.parse(fs.readFileSync(path.join(store.dirOf(id), 'work', 'probe.json'), 'utf8')); } catch { return null; } };
    const stepOf = (r, id) => (r.steps || []).find(s => s.id === id);
    const S1 = await server();
    const i1 = newIssue('saved-pct', `http://127.0.0.1:${S1.port}/`);
    editIssue(i1.id, d => { d.url = `http://127.0.0.1:${S1.port}/p/%1B[D%1B[D`; });
    const r1 = await run(i1.id), s1 = stepOf(r1, 'live-probe'), p1 = readProbe(i1.id);
    ok(S1.hits.length === 0 && s1 && s1.status === 'NOT_RUN' && s1.reason === 'The saved address has hidden characters, so the live page was not checked.', `a saved address with %1B[D%1B[D: no request reached the server (${S1.hits.length}); the step is NOT_RUN with the exact sentence`);
    ok(s1 && s1.status === 'NOT_RUN' && !/no (site )?address was given|--url/.test(s1.reason) && !s1.reason.includes(String(S1.port)) && !s1.reason.includes('%1B'), 'the sentence does not say that no address was given, and does not repeat the address');
    const o1 = (p1 && p1.oracle) || (stepOf(r1, 'oracle') && { result: stepOf(r1, 'oracle').reproduced });
    ok(!!o1 && (o1.result === 'could-not-test' || (stepOf(r1, 'oracle').data || stepOf(r1, 'oracle')).reproduced === 'could-not-test'), 'the oracle answer is "could-not-test" (the symptom is never reported as seen or as absent)');
    const i2 = newIssue('saved-raw', `http://127.0.0.1:${S1.port}/`);
    editIssue(i2.id, d => { d.url = `http://127.0.0.1:${S1.port}/p/${ESC}[D${ESC}[D`; });
    const r2 = await run(i2.id), s2 = stepOf(r2, 'live-probe');
    ok(S1.hits.length === 0 && s2 && s2.status === 'NOT_RUN' && s2.reason === STEP, 'a saved address with raw ESC characters: no request, the same sentence');
    const i3 = newIssue('saved-space', `http://127.0.0.1:${S1.port}/`);
    editIssue(i3.id, d => { d.url = `http://127.0.0.1:${S1.port}/a b`; });
    const r3 = await run(i3.id), s3 = stepOf(r3, 'live-probe');
    ok(S1.hits.length === 0 && s3 && s3.status === 'NOT_RUN' && s3.reason === STEP, 'a saved address with a space inside: no request, the same sentence');
    const i4 = newIssue('saved-page', `http://127.0.0.1:${S1.port}/`, { pages: ['/ok'] });
    editIssue(i4.id, d => { d.pages = [`/p/${ESC}[D`]; });
    const r4 = await run(i4.id), s4 = stepOf(r4, 'live-probe');
    ok(S1.hits.length === 0 && s4 && s4.status === 'NOT_RUN' && s4.reason === 'A saved page address has hidden characters, so the live page was not checked.', 'a saved PAGE address with hidden characters: no request, "A saved page address has hidden characters, so the live page was not checked."');
    const i5 = newIssue('saved-page-pct', `http://127.0.0.1:${S1.port}/`, { pages: ['/ok'] });
    editIssue(i5.id, d => { d.pages = ['http://127.0.0.1:' + S1.port + '/x%0Ay']; });
    const r5 = await run(i5.id), s5 = stepOf(r5, 'live-probe');
    ok(S1.hits.length === 0 && s5 && s5.status === 'NOT_RUN' && /hidden characters/.test(s5.reason), 'a saved page address with %0A: no request');
    const sb = await probeMod.runSandbox(i4.id, { url: 'http://127.0.0.1:9/', stateDir: path.join(tmp, 'sb-state'), options: {}, env: { ...process.env, ...ENVX } });
    ok(sb && sb.ok === false && sb.reason === 'A saved page address has hidden characters, so the live page was not checked.' && S1.hits.length === 0, 'the sandbox probe also refuses a saved page address with hidden characters (not ok, same sentence, no request)');
    // the test copy for several issues at once (issue/sandbox-many.js) reads every issue's saved pages: a bad one must stop it before any page is loaded
    const many = require('../issue/sandbox-many');
    let observed = 0; const stubObserve = async () => { observed++; return { ok: false, reason: 'stub' }; };
    const mBad = await many.runMany([i4.id], { root: null, options: {}, env: { ...process.env, ...ENVX }, observe: stubObserve });
    ok(typeof mBad.unavailable === 'string' && /hidden characters/.test(mBad.unavailable) && mBad.unavailable.includes(i4.id) && !/--root/.test(mBad.unavailable) && observed === 0 && S1.hits.length === 0, `the multi-issue test copy refuses a saved page with hidden characters before anything is loaded: "${mBad.unavailable}"`);
    // guard: a normal address is probed, with a typed %20 in the path
    const i6 = newIssue('normal', `http://127.0.0.1:${S1.port}/a%20b/`);
    const r6 = await run(i6.id), s6 = stepOf(r6, 'live-probe');
    ok(S1.hits.length > 0 && s6 && s6.status !== 'NOT_RUN', `guard: a normal address (with a typed %20) is still probed (${S1.hits.length} requests, step ${s6 && s6.status})`);
    const mGood = await many.runMany([i6.id], { root: null, options: {}, env: { ...process.env, ...ENVX }, observe: stubObserve });
    ok(/--root/.test(String(mGood.unavailable)) && !/hidden characters/.test(String(mGood.unavailable)), 'guard: a normal issue in the multi-issue test copy still goes the old way (here: "a local copy of the site (--root) is needed")');
    S1.sv.close();

    group('the report: the verdict is not stronger, and it never says "no address was given"');
    const S2 = await server();
    const mk = await runAsync(CMD, ['--description', 'x', '--no-files', '--yes', '--url', `http://127.0.0.1:${S2.port}/`, '--env', 'local', '--no-probe'], ENVX);
    const rid = issueDirs().filter(n => n !== i1.id && !/^$/.test(n)).filter(n => { try { return JSON.parse(fs.readFileSync(path.join(tmp, 'issues', n, 'issue.json'), 'utf8')).url === `http://127.0.0.1:${S2.port}/`; } catch { return false; } })[0];
    ok(mk.status === 0 && !!rid, 'setup: a no-files issue with a good address was made (no probe)');
    editIssue(rid, d => { d.url = `http://127.0.0.1:${S2.port}/p/%1B[D%1B[D`; });
    const inv = await runAsync(GUARD, ['issue', 'investigate', rid, '--no-prompt', '--gate'], ENVX);
    const fj = path.join(tmp, 'issues', rid, 'result', 'findings.json');
    const f = fs.existsSync(fj) ? JSON.parse(fs.readFileSync(fj, 'utf8')) : null;
    const all = ['ISSUE-REPORT.md', 'issue.html', 'findings.json'].map(n => { try { return fs.readFileSync(path.join(tmp, 'issues', rid, 'result', n), 'utf8'); } catch { return ''; } }).join('\n');
    ok(S2.hits.length === 0 && !!f && f.live_checks && /hidden characters/.test(f.live_checks.sentence) && !/no address was given|no site address/.test(f.live_checks.sentence) && f.live_checks.gave_a_result === 0, `investigate on the issue with a saved bad address: no request (${S2.hits.length}), the live-check sentence names the hidden characters: "${f && f.live_checks && f.live_checks.sentence}"`);
    ok(!!f && f.verdict.label === 'Nothing could be checked' && f.confidence_text.includes('no live check was run, because a saved address has hidden characters') && !/found nothing wrong|No confirmed breaking cause/.test(f.verdict.label + f.confidence_text) && !/no address was given/.test(all) && !all.includes(ESC), 'the verdict stays "Nothing could be checked" (not stronger) and says why: "no live check was run, because a saved address has hidden characters"; no report file says "no address was given" or holds a raw ESC character');
    S2.sv.close();

    group('retest on such an issue never gives FIXED_VERIFIED; show and list do not crash');
    const S3 = await server();
    const rt = newIssue('retest', `http://127.0.0.1:${S3.port}/`);
    fs.mkdirSync(path.join(store.dirOf(rt.id), 'work'), { recursive: true });
    fs.writeFileSync(path.join(store.dirOf(rt.id), 'work', 'probe.initial.json'), JSON.stringify({ oracle: { result: 'yes', matches: [{ page: `http://127.0.0.1:${S3.port}/`, viewport: 'laptop' }] }, pages: [] }));
    editIssue(rt.id, d => { d.url = `http://127.0.0.1:${S3.port}/p/${ESC}[D${ESC}[D`; });
    const rr = await retest.run(rt.id, { root: null, options: {}, env: { ...process.env, ...ENVX }, now: () => 'T' });
    ok(S3.hits.length === 0 && rr.entry && rr.entry.fixed_verified === false && rr.entry.verdict === 'Could not test', `retest: no request (${S3.hits.length}), verdict "${rr.entry && rr.entry.verdict}", fixed_verified ${rr.entry && rr.entry.fixed_verified} (a failing page was on record, and still it is never FIXED_VERIFIED)`);
    const rr2 = await retest.run(rt.id, { root: null, options: { sandbox: true }, env: { ...process.env, ...ENVX }, now: () => 'T' });
    ok(rr2.entry && rr2.entry.fixed_verified === false, 'retest with --sandbox and no copy: fixed_verified is false too');
    const show = await runAsync(GUARD, ['issue', 'show', rt.id], ENVX), list = await runAsync(GUARD, ['issue', 'list'], ENVX);
    ok(show.status === 0 && !/TypeError|ReferenceError|at .*\.js:\d+/.test(show.stderr + show.stdout), `issue show on an issue with a saved bad address: exit ${show.status}, no crash text`);
    ok(list.status === 0 && !/TypeError|ReferenceError|at .*\.js:\d+/.test(list.stderr + list.stdout), `issue list: exit ${list.status}, no crash text`);
    ok(!show.stdout.includes(ESC) && !list.stdout.includes(ESC), 'neither command prints a raw ESC character from the saved address (it would move the cursor in a terminal)');
    S3.sv.close();

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll address checks passed');
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } process.exit(1); });
