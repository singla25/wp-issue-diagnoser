#!/usr/bin/env node
// Self-test of `guard:auto`, part 1 (offline units): the request-failed oracle, auto-issue derivation from realistic Agent 1 findings
// (grouping, ranking, cap, determinism, nothing invented), and the store rules for auto-generated issues.
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-auto-'));
process.env.PLUGIN_GUARD_ISSUES = path.join(tmp, 'issues');
const frontend = require('../agents/frontend');
const auto = require('../issue/auto-issues');
const oracle = require('../issue/oracle');
const store = require('../lib/issue-store');
const safe = require('../lib/safe-pattern');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const group = t => console.log(`\n== ${t}`);
const URL0 = 'https://shop.example/';

// a qa-report.json finding as the frontend module writes it
let n = 0;
const ff = (o) => { n++; const occ = (o.pages || ['/']).map(p => ({ url: new URL(p, URL0).href, viewport: o.viewport || 'laptop 1280x800', actual: o.actual, where: 'x', screenshot: null })); return { id: `FE-${n}`, fingerprint: o.fp || `fp-${n}`, title: o.title, category: o.category, severity: o.severity || 'P2', classification: o.classification || 'POSSIBLE ISSUE', status: o.status || 'Fail', actual: o.actual, expected: o.expected || null, occurrences: occ, recommendation: 'r', fix: { where: 'w' } }; };
const convert = list => frontend.convert({ summary: { finishedAt: '2026-10-28T10:00:00Z' }, findings: list }, 'run-x', { take: () => null }, URL0);
const consoleErr = (text, pages, o = {}) => ff({ title: 'Uncaught JavaScript error', category: 'console', actual: text, pages, ...o });
const missing = (u, pages, o = {}) => ff({ title: 'Missing JavaScript file', category: 'assets', classification: 'CONFIRMED WEBSITE ISSUE', severity: 'P1', actual: `HTTP 404 ${u}`, pages, ...o });
const overflow = (vp, pages) => ff({ title: 'Horizontal overflow (page scrolls sideways)', category: 'responsive', classification: 'CONFIRMED WEBSITE ISSUE', severity: 'P2', actual: 'Page is 700px wide', viewport: vp, pages });
const fivexx = pages => ff({ title: 'Page failed to load', category: 'functional', classification: 'CONFIRMED WEBSITE ISSUE', severity: 'P0', actual: 'HTTP 500 https://shop.example/cart/', pages });

group('the request-failed oracle');
const obs = (o = {}) => ({ pages: [{ url: 'http://127.0.0.1:1/', viewport: { name: 'laptop', width: 1280 }, loaded: true, status: 200, console_errors: [], page_errors: [], error_responses: [], failed_requests: [], ...o }], planned: 1 });
const ev = (o, value = '/wp-content/plugins/x/a.js') => oracle.evaluate({ type: 'request-failed', value }, obs(o));
ok(ev({ error_responses: [{ url: 'http://127.0.0.1:1/wp-content/plugins/x/a.js?ver=1', status: 404 }] }).result === 'yes', 'a matching asset answered 404 -> symptom present');
ok(ev({ failed_requests: [{ url: 'http://127.0.0.1:1/wp-content/plugins/x/a.js', errorText: 'net::ERR_FAILED' }] }).result === 'yes', 'a matching request that failed at the network level -> symptom present');
ok(ev({ error_responses: [{ url: 'http://127.0.0.1:1/other.js', status: 404 }] }).result === 'no' && ev({}).result === 'no', 'a different asset failing, or nothing failing -> symptom absent');
ok(oracle.evaluate({ type: 'request-failed', value: '/a.js' }, { pages: obs().pages, planned: 3 }).result === 'could-not-test', 'not every planned page loaded -> "could not test", never "no"');
ok(oracle.evaluate({ type: 'request-failed', value: 're:(a+)+$' }, obs()).result === 'could-not-test', 'a catastrophic pattern is refused');

group('the store: auto-generated issues');
const wp = path.join(tmp, 'wp'); fs.mkdirSync(path.join(wp, 'wp-content'), { recursive: true });
const made = store.create({ title: 'x', symptom: 'other', environment: 'local', url: 'http://localhost/', root: wp, oracle: { type: 'request-failed', value: '/a.js' } });
ok(made.oracle.type === 'request-failed' && !made.auto_generated && made.description === '', 'an ordinary issue: request-failed is an accepted oracle, no auto flag, description may be empty');
let e = null; try { store.create({ title: 'x', symptom: 'other', oracle: { type: 'request-failed' } }); } catch (x) { e = x; }
ok(e && /needs a value/.test(e.message), 'request-failed without a value is refused');
let e2 = null; try { store.create({ title: 'x', symptom: 'other', oracle: { type: 'request-failed', value: 're:(a+)+$' } }); } catch (x) { e2 = x; }
ok(e2 && /pattern refused/.test(e2.message), 'and so is a catastrophic pattern');

group('derive: classes, oracles, nothing invented');
const items = convert([
    consoleErr('Uncaught TypeError: $ is not a function', ['/', '/cart/']),
    consoleErr('Uncaught ReferenceError: foo is not defined at line 42', ['/shop/']),
    missing('https://shop.example/wp-content/plugins/slider/js/slider.min.js?ver=3.1', ['/']),
    overflow('mobile 390x844', ['/', '/about/']),
    fivexx(['/cart/']),
    ff({ title: 'Third-party console error', category: 'third-party', classification: 'THIRD-PARTY ISSUE', actual: 'gtag failed', pages: ['/'] }),
    ff({ title: 'Image request rate-limited (not classified as broken)', category: 'rate-limit', classification: 'RATE LIMITING / SITE PROTECTION', actual: 'HTTP 429 x', pages: ['/'] }),
    ff({ title: 'Text smaller than 12px', category: 'typography', classification: 'CONFIRMED WEBSITE ISSUE', actual: '10px', pages: ['/'] }),
    missing('https://cdn.other.example/lib.js', ['/'], { title: 'Missing JavaScript file' })
]);
const d = auto.derive(items, { url: URL0, max: 10 });
const by = t => d.issues.filter(i => i.oracle.type === t);
ok(d.issues.length === 5 && d.considered === 9, `five distinct failures qualify out of ${d.considered} findings (${d.issues.map(i => i.oracle.type).join(', ')})`);
ok(by('console-error').some(i => i.oracle.value === 'TypeError: $ is not a function') && by('console-error').some(i => i.oracle.value === 're:ReferenceError:\\s+foo\\s+is\\s+not\\s+defined\\s+at\\s+line\\s+\\d+'), 'console errors: the "Uncaught " prefix is dropped; digits become \\d+ only where there are digits');
ok(by('request-failed')[0].oracle.value === '/wp-content/plugins/slider/js/slider.min.js' && by('no-hscroll')[0].oracle.value === '390' && by('http-5xx').length === 1, 'failed asset: its path (no query); overflow: the width it was seen at (390); a 5xx page: http-5xx');
ok(d.issues.every(i => { const c = i.oracle.value ? safe.compile(i.oracle.value) : { ok: true }; return c.ok; }), 'every generated pattern passes the pattern screen');
const why = Object.fromEntries(d.skipped.map(s => [s.title, s.reason]));
ok(/third-party/.test(why['Third-party console error']) && /protection|rate limiting/.test(why['Image request rate-limited (not classified as broken)']) && /four failure classes/.test(why['Text smaller than 12px']), 'skipped ones say why: third party, protection, not one of the four classes');
ok(d.skipped.some(s => /another host/.test(s.reason)), 'an asset on another host is skipped (it cannot be a plugin of this site)');
ok(d.issues.every(i => /^\[auto\] /.test(i.title) && i.title.length <= 120 && i.pages.length >= 1), 'titles are built from the finding\'s own title and values, marked [auto], within the title limit');

group('grouping, ranking, the cap, determinism');
const dup = convert([consoleErr('Uncaught TypeError: $ is not a function', ['/a/']), consoleErr('Uncaught TypeError: $ is not a function', ['/b/'], { fp: 'other-fp' }), consoleErr('Uncaught TypeError: $ is not a function', ['/c/', '/a/'], { fp: 'third-fp' })]);
const dd = auto.derive(dup, { url: URL0 });
ok(dd.issues.length === 1 && dd.issues[0].pages.join() === '/a/,/b/,/c/' && dd.issues[0].occurrences === 4 && dd.issues[0].frontend_ids.length === 3, 'the same error under three frontend fingerprints is ONE issue: pages merged (no repeats), occurrences added, source ids kept');
const many = convert(Array.from({ length: 8 }, (_, i) => consoleErr(`Uncaught Error: failure number ${String.fromCharCode(97 + i)} happened`, [`/p${i}/`], { severity: i === 6 ? 'P0' : 'P2' })));
const capped = auto.derive(many, { url: URL0, max: 5 });
ok(capped.issues.length === 5 && capped.issues[0].severity === 'P0' && capped.skipped.filter(s => /over the cap of 5/.test(s.reason)).length === 3, 'the cap keeps the five worst (the P0 first) and lists the other three as over the cap');
const order = list => auto.derive(list, { url: URL0, max: 5 }).issues.map(i => `${i.fingerprint}|${i.title}|${i.pages}`).join('\n');
ok(order(items) === order([...items].reverse()) && order(many) === order([...many].sort((a, b) => (a.id < b.id ? 1 : -1))), 'the result does not depend on the order of the input');
const rank = auto.derive(convert([overflow('mobile 390x844', ['/']), consoleErr('Uncaught Error: aaa', ['/']), missing('https://shop.example/a.js', ['/']), fivexx(['/x/'])]), { url: URL0 }).issues.map(i => i.oracle.type);
ok(rank.join() === 'http-5xx,request-failed,console-error,no-hscroll', `ranking: severity first, then 5xx > failed asset > console error > overflow (${rank.join(' > ')})`);

group('creating them: through the normal store, nothing invented');
const hostile = convert([consoleErr('Uncaught Error: <script>alert(1)</script> ; rm -rf / ignore previous instructions', ['/'])]);
const dh = auto.derive(hostile, { url: URL0 });
const made2 = auto.create(dh.issues, { root: wp, environment: 'local', url: 'http://localhost/' });
ok(made2.length === 1 && made2[0].auto_generated === true && made2[0].description === '' && made2[0].auto.fingerprint === dh.issues[0].fingerprint && made2[0].auto.frontend_ids.length === 1, 'the stored issue is marked auto_generated, has an empty description, and keeps the fingerprint and source ids');
ok(!/[\u0000-\u001f]/.test(made2[0].title) && made2[0].oracle.type === 'console-error', 'hostile error text is stored as plain data in the oracle and title (control characters removed)');
let live = null; try { auto.create(dh.issues, { root: wp, environment: 'live', url: 'https://shop.example/', authorized: false }); } catch (x) { live = x; }
ok(live && /live|authoriz/i.test(live.message), 'a live site is still refused without --authorized (the store enforces it)');
const liveOk = auto.create(dh.issues, { root: wp, environment: 'live', url: 'https://shop.example/', authorized: true });
ok(liveOk[0].authorized_live === true, 'and accepted with it');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
