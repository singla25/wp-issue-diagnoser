#!/usr/bin/env node
// REPORT-SPEC Part 5 (5.5): after the report the person sees the status line and a file link, is offered to open the report (issue.html, nothing else),
// and after FIX-PLAN.md may leave feedback + a score (feedback.md in the issue folder, never sent anywhere). Terminal only. Offline; the spawn is injected.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { PassThrough } = require('stream');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-part5-'));
process.env.PLUGIN_GUARD_ISSUES = path.join(tmp, 'issues');
const wizard = require('../lib/wizard');
const OR = require('../lib/open-report');
const FB = require('../lib/feedback');
const store = require('../lib/issue-store');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const group = t => console.log(`\n== ${t}`);
const w = (root, rel, body = '<?php\n') => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); };
const HEADING = fs.readFileSync(path.join(__dirname, 'fixtures', 'issue', 'names-class', 'heading.php'), 'utf8');
const FILE = 'wp-content/themes/unicamp/elementor/widgets/original/heading.php';
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const stamp = d => `${String(d.getUTCDate()).padStart(2, '0')}-${MON[d.getUTCMonth()]}-${d.getUTCFullYear()} ${d.toISOString().slice(11, 19)}`;
function build(root) {
    w(root, 'wp-includes/version.php', "<?php\n$wp_version = '6.8.1';\n"); w(root, 'wp-config.php', '<?php\n');
    w(root, 'wp-content/plugins/elementor/elementor.php', '<?php\n/**\n * Plugin Name: Elementor\n * Version: 3.35.7\n */\nnamespace Elementor;\nclass Plugin {}\n');
    w(root, 'wp-content/themes/unicamp/style.css', '/*\nTheme Name: Unicamp\nVersion: 2.2.0\n*/');
    w(root, 'wp-content/plugins/woocommerce/woocommerce.php', '<?php\n/**\n * Plugin Name: WooCommerce\n * Version: 10.6.1\n */\n');
    w(root, FILE, HEADING);
    const d = new Date(Date.now() - 2 * 3600e3), d2 = new Date(d.getTime() + 1000);
    const one = t => `[${stamp(t)} UTC] PHP Fatal error:  Uncaught Error: Class "Elementor\\Core\\Schemes\\Color" not found in ${root}/${FILE}:48\nStack trace:\n#0 {main}\n  thrown in ${root}/${FILE} on line 48\n`;
    w(root, 'wp-content/debug.log', one(d) + one(d2));
}
async function wiz(answers, flags, extra = {}) {
    const input = new PassThrough(), output = new PassThrough();
    let text = ''; output.on('data', d => { text += d; });
    input.end(answers.join('\n') + (answers.length ? '\n' : ''));
    const log = console.log; console.log = (...a) => { text += a.join(' ') + '\n'; };
    let error = null;
    try { await wizard.run({ _: [], ...flags }, { input, output, tty: true, cwd: tmp, env: { HOME: tmp }, preflight: () => ({ ok: false }), siteRoots: [], ...extra }); }
    catch (e) { error = e; } finally { console.log = log; }
    return { text, error };
}
const issuesIn = d => (fs.existsSync(d) ? fs.readdirSync(d).filter(x => store.ISSUE_RE.test(x)).sort() : []);
const NOTICE = 'Saved only on this computer, in the report folder. It is never sent anywhere. Passwords, keys, tokens, email addresses and IP addresses are removed first; names and street addresses are not, so please leave them out.';

(async () => {
    group('file URL');
    ok(OR.fileUrl('/a/b c/issue.html') === 'file:///a/b%20c/issue.html', 'space -> %20');
    ok(OR.fileUrl('/a/b#c/issue.html') === 'file:///a/b%23c/issue.html', '# -> %23');
    ok(OR.fileUrl('/a/b?c/x') === 'file:///a/b%3Fc/x' && OR.fileUrl('/a/50%/x') === 'file:///a/50%25/x', '? -> %3F, % -> %25');
    ok(OR.fileUrl('/a/caf\u00e9/x') === 'file:///a/caf%C3%A9/x', 'non-ASCII as UTF-8');
    ok(OR.fileUrl('D:\\Sites\\a b\\x.html') === 'file:///D:/Sites/a%20b/x.html', 'Windows drive');

    group('the opener refuses what is not the report page');
    const root = path.join(tmp, 'root'), outside = path.join(tmp, 'outside');
    fs.mkdirSync(path.join(root, 'iss-20261105-010101-aaaaaa', 'result'), { recursive: true }); fs.mkdirSync(outside, { recursive: true });
    const good = path.join(root, 'iss-20261105-010101-aaaaaa', 'result', 'issue.html'); fs.writeFileSync(good, '<html></html>');
    fs.writeFileSync(path.join(outside, 'issue.html'), 'x'); fs.writeFileSync(path.join(root, 'iss-20261105-010101-aaaaaa', 'result', 'other.html'), 'x');
    fs.mkdirSync(path.join(root, 'iss-20261105-010101-bbbbbb', 'result'), { recursive: true }); fs.symlinkSync(good, path.join(root, 'iss-20261105-010101-bbbbbb', 'result', 'issue.html'));
    fs.symlinkSync(outside, path.join(root, 'iss-20261105-010101-cccccc'));
    const calls = [];
    const spawn = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { unref() {} }; };
    const env = { DISPLAY: ':0' };
    const go = f => OR.open(f, { issuesRoot: root, env, platform: 'linux', tty: true, spawn });
    let r = await go(good);
    ok(r.opened && calls.length === 1 && Array.isArray(calls[0].args) && calls[0].cmd === 'xdg-open' && calls[0].args[0] === fs.realpathSync(good), 'the real report page is opened with an argument array');
    ok(calls[0].opts.shell === false && calls[0].opts.detached === true && calls[0].opts.stdio === 'ignore', 'shell false, detached, stdio ignore');
    ok(OR.openerFor('darwin', '/x').cmd === 'open' && OR.openerFor('win32', 'C:\\x').cmd === 'rundll32' && OR.openerFor('win32', 'C:\\x').args[0] === 'url.dll,FileProtocolHandler', 'macOS open, Windows rundll32 (arrays)');
    calls.length = 0;
    r = await go(path.join(root, 'iss-20261105-010101-bbbbbb', 'result', 'issue.html')); ok(!r.opened, 'a symlink named issue.html is refused');
    r = await go(path.join(outside, 'issue.html')); ok(!r.opened, 'a path outside the issues root is refused');
    r = await go(path.join(root, 'iss-20261105-010101-aaaaaa', 'result', 'other.html')); ok(!r.opened, 'a different file name is refused');
    r = await go(path.join(root, 'iss-20261105-010101-cccccc', 'issue.html')); ok(!r.opened, 'a directory symlink that escapes the root is refused');
    fs.mkdirSync(path.join(root, 'iss-20261105-010101-dddddd', 'result', 'issue.html'), { recursive: true });
    r = await go(path.join(root, 'iss-20261105-010101-dddddd', 'result', 'issue.html')); ok(!r.opened, 'a directory named issue.html is refused');
    r = await go(path.join(root, 'iss-20261105-010101-dddddd', 'result', 'issue.html') + '/'); ok(!r.opened, 'a directory named issue.html with a trailing slash is refused');
    fs.mkdirSync(path.join(root, 'anything', 'result'), { recursive: true }); fs.writeFileSync(path.join(root, 'anything', 'result', 'issue.html'), 'x');
    r = await go(path.join(root, 'anything', 'result', 'issue.html')); ok(!r.opened, 'a first folder that is not an issue id is refused');
    ok(calls.length === 0, 'none of the refusals started a program');
    r = await OR.open(good, { issuesRoot: root, env: {}, platform: 'linux', tty: true, spawn }); ok(!r.opened && r.reason === 'no display' && calls.length === 0, 'no display (Linux): no spawn');
    r = await OR.open(good, { issuesRoot: root, env, platform: 'linux', tty: false, spawn }); ok(!r.opened && calls.length === 0 && /^file:\/\//.test(r.url), 'no terminal: no spawn, the link is returned');
    r = await OR.open(good, { issuesRoot: root, env, platform: 'linux', tty: true, spawn: () => { throw new Error('boom'); } }); ok(!r.opened, 'a spawn that throws -> not opened');
    r = await OR.open(good, { issuesRoot: root, env, platform: 'linux', tty: true, spawn: () => { const { EventEmitter } = require('events'); const e = new EventEmitter(); e.unref = () => {}; setImmediate(() => e.emit('error', new Error('ENOENT'))); return e; } }); ok(!r.opened, 'an opener that fails to start (error event) -> not opened');

    group('feedback: masking');
    const secretText = 'Mail me at jane.doe@example.com, server 192.168.1.20 and 2001:db8::8a2e:370:7334, token=abcdef123456789, office at 12 Baker Street, London';
    const m = FB.mask(secretText);
    ok(!/jane\.doe@example\.com/.test(m.text) && !/192\.168\.1\.20/.test(m.text) && !/2001:db8/.test(m.text) && !/abcdef123456789/.test(m.text), 'email, IPv4, IPv6 and a token are masked');
    ok(['email address', 'IPv4 address', 'IPv6 address', 'secret'].every(k => m.removed.includes(k)), `the function reports what it removed: ${m.removed.join(', ')}`);
    ok(m.text.includes('12 Baker Street, London'), 'LIMIT (documented): a street address is NOT removed');
    ok(FB.mask('at 12:30:45 on 1.2.3').text === 'at 12:30:45 on 1.2.3', 'times and short version numbers are left alone');
    ok(FB.parseScore('3') === 3 && FB.parseScore('0') === null && FB.parseScore('6') === null && FB.parseScore('2.5') === null && FB.parseScore('abc') === null, 'score 1-5 integers only');

    group('feedback: asking');
    const fdir = path.join(tmp, 'fb'); fs.mkdirSync(fdir);
    const mk = ans => { const said = [], asked = []; const q = [...ans]; return { said, asked, io: { say: t => said.push(t), ask: async p => { asked.push(p); return q.length ? q.shift() : null; } } }; };
    let t = mk(['Too long', '9', 'x', '2.5', '4']);
    let res = await FB.collect({ io: t.io, dir: fdir });
    ok(t.said[0] === NOTICE && t.asked[0] === 'Anything we should improve? (type it, or Enter to skip)' && t.asked[1] === 'How useful was this report? 1 = not useful, 5 = very useful (Enter to skip)', 'the notice is printed first, then the two exact questions');
    ok(t.asked.length === 5 && res.score === 4, 'a score outside 1-5 or not an integer is asked again');
    const body = fs.readFileSync(path.join(fdir, 'feedback.md'), 'utf8');
    ok(res.file === path.join(fdir, 'feedback.md') && /^# Feedback on the report\n\nDate: \d{1,2} [A-Z][a-z]{2} \d{4}, \d\d:\d\d\nScore: 4 of 5\n\nToo long\n$/.test(body) && !/iss-|\.json/.test(body), 'feedback.md: heading, readable date, score, text; no ids');
    fs.rmSync(path.join(fdir, 'feedback.md'));
    t = mk(['', '']); res = await FB.collect({ io: t.io, dir: fdir }); ok(!res.file && !fs.existsSync(path.join(fdir, 'feedback.md')), 'nothing given: no file');
    t = mk(['', '5']); res = await FB.collect({ io: t.io, dir: fdir }); ok(res.file && /Score: 5 of 5/.test(fs.readFileSync(res.file, 'utf8')), 'a score alone is saved');
    fs.rmSync(path.join(fdir, 'feedback.md'));
    t = mk(['mail a@b.org', '']); res = await FB.collect({ io: t.io, dir: fdir }); ok(!/a@b\.org/.test(fs.readFileSync(res.file, 'utf8')), 'the file holds the masked text');

    group('the plugin-guard command');
    const site = path.join(tmp, 'site', 'wp'); build(site);
    const base = { description: 'The home page shows a critical error', root: site };
    const run1 = async (name, flags, answers, extra) => { const out = path.join(tmp, name); const R = await wiz(answers, { ...base, out, ...flags }, extra); const id = issuesIn(out)[0]; return { ...R, out, id, dir: id ? path.join(out, id) : null }; };
    const spawnCalls = [];
    const A = await run1('A', {}, ['', '', 'stop', '', '2', '2', '2', '1', 'Make it shorter', '3'], { env: { HOME: tmp, DISPLAY: ':0' }, spawn: (c, a, o) => { spawnCalls.push({ c, a, o }); return { unref() {} }; } });
    // answers: the first lines may be consumed by earlier questions; the order is what matters, so look at the text
    if (process.env.P5_DEBUG) console.log(A.text);
    ok(!A.error && A.dir, `interactive run completes${A.error ? ' (' + A.error.message + ')' : ''}`);
    const txt = A.text, linkAt = txt.indexOf('Full report: file://');
    ok(linkAt > 0 && !/Status: /.test(txt) && txt.includes(JSON.parse(fs.readFileSync(path.join(A.dir, 'result', 'findings.json'), 'utf8')).case_file.status.line + '\nFull report: file://'), 'the report status line (case_file.status.line, no prefix), then "Full report: <file URL>"');
    ok(txt.indexOf('Open it in your browser now? [Y/n]') > linkAt, 'the open question follows the link');
    ok(txt.indexOf('Which plan do you want?') > txt.indexOf('Open it in your browser now?') && txt.indexOf(NOTICE) > txt.indexOf('Which plan do you want?'), 'order: link, open question, plan questions, then the feedback notice');
    ok(txt.indexOf('Anything we should improve?') > txt.indexOf(NOTICE) && txt.indexOf('How useful was this report?') > txt.indexOf('Anything we should improve?'), 'notice before the free-text question, then the score');
    ok(txt.includes(`Plan saved at ${path.join(A.dir, 'result', 'FIX-PLAN.md')}. To have Claude Code carry it out on a copy, give it that file.`), 'closing line with the plan path');
    ok(spawnCalls.length === 1 && spawnCalls[0].a[0] === fs.realpathSync(path.join(A.dir, 'result', 'issue.html')) && spawnCalls[0].o.shell === false, 'Enter at the open question opens the report page (injected spawn, argument array)');
    const fbA = path.join(A.dir, 'feedback.md');
    ok(fs.existsSync(fbA) && /Score: 3 of 5/.test(fs.readFileSync(fbA, 'utf8')) && /Make it shorter/.test(fs.readFileSync(fbA, 'utf8')), 'feedback.md is written into the issue folder with the text and score');
    const F = await run1('F', {}, ['', '', 'stop', 'n', '', '', '', '', '', ''], { env: { HOME: tmp, DISPLAY: ':0' }, spawn: () => { throw new Error('no'); } });
    ok(/Open it in your browser now\? \[Y\/n\]/.test(F.text), 'F: the open question is asked');
    const G = await run1('G', {}, ['', '', 'stop', '', '', '', '', '', '', ''], { env: { HOME: tmp, DISPLAY: ':0' }, spawn: () => { throw new Error('no'); } });
    ok(G.text.includes('I could not open a browser here. Open this file in your browser: file://'), 'a failing opener -> the exact fallback sentence');
    // wiring cannot know which answer fed which question, so assert only what must hold
    ok(!fs.existsSync(path.join(A.dir, 'work', 'feedback.md')), 'feedback.md is not under work/');
    const B = await run1('B', { 'no-questions': true }, [], { env: { HOME: tmp, DISPLAY: ':0' } });
    const Y = await run1('Y', { yes: true }, [], { env: { HOME: tmp, DISPLAY: ':0' } });
    const NP = await run1('NP', { 'no-prompt': true }, [], { env: { HOME: tmp, DISPLAY: ':0' } });
    const NT = await run1('NT', {}, [], { tty: false, env: { HOME: tmp, DISPLAY: ':0' } });
    const quiet = x => !/Full report:|Open it in your browser|Anything we should improve|How useful was this report|Plan saved at|Saved only on this computer/.test(x.text);
    ok([B, Y, NP, NT].every(x => x.dir && !x.error && quiet(x)), '--no-questions, --yes, --no-prompt, no terminal: none of the new lines, no questions');
    ok([B, Y, NP, NT].every(x => !fs.existsSync(path.join(x.dir, 'feedback.md'))), 'and no feedback.md');
    const D = await run1('D', {}, ['', '', 'stop', '2', '2', '2', '1'], { env: { HOME: tmp } });
    ok(D.dir && /Full report: file:\/\//.test(D.text) && D.text.includes(`I could not open a browser here. Open this file in your browser: ${OR.fileUrl(fs.realpathSync(path.join(D.dir, 'result', 'issue.html')))}`) && !/Open it in your browser now\?/.test(D.text), 'no display: no question, the exact fallback sentence with the link');

    group('feedback does not change statuses; plan-less closing line');
    const E = await run1('E', {}, [], { env: { HOME: tmp } });   // nothing answered: all prompts get end-of-input
    const stat = d => { const f = JSON.parse(fs.readFileSync(path.join(d, 'result', 'findings.json'), 'utf8')); const i = JSON.parse(fs.readFileSync(path.join(d, 'issue.json'), 'utf8')); return JSON.stringify({ v: f.verdict.label, c: f.verdict.confidence, h: (f.hypotheses || []).map(x => x.status), s: i.status }); };
    ok(E.dir && A.dir && stat(E.dir) === stat(A.dir), 'status / verdict fields identical with and without feedback answers');
    ok(!/Plan saved at/.test(E.text) || fs.existsSync(path.join(E.dir, 'result', 'FIX-PLAN.md')), 'the closing line appears only when FIX-PLAN.md exists');
    const fp = path.join(A.dir, 'result', 'FIX-PLAN.md'); const keep = fs.readFileSync(fp); fs.rmSync(fp);
    fs.writeFileSync(fp, keep);

    group('static: the spawn lives in one module');
    const files = ['open-report.js', 'feedback.js', 'wizard.js'].map(n => [n, fs.readFileSync(path.join(__dirname, '..', 'lib', n), 'utf8')]);
    files.push(['selftest-part5.js(none)', '']);
    const withCp = files.filter(([, s]) => /require\(['"](node:)?child_process['"]\)/.test(s)).map(([n]) => n);
    ok(withCp.length === 1 && withCp[0] === 'open-report.js', `only lib/open-report.js requires child_process (${withCp.join(',')})`);
    ok(!/shell:\s*true|\bexec(Sync)?\(/.test(files[0][1]), 'open-report.js: no shell, no exec');
    ok(!/require\(['"](https?|net|dns)['"]\)|fetch\(/.test(files[1][1]), 'feedback.js: no network');

    console.log(failures ? `\n${failures} FAILED` : '\nAll Part 5 checks passed.');
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
