#!/usr/bin/env node
// Self-test of plugin-guard's OWN page probe (probe/): the request safety layer, its settings and the layout checks, without a website.
// The probe against a fixture site (pacing, read-only, stop at the first 429, record shape) is covered by selftest-issue-probe.js.
const fs = require('fs');
const os = require('os');
const path = require('path');

const cfgMod = require('../probe/config');
const { Safety, classify } = require('../probe/safety');
const layout = require('../probe/layout');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const group = t => console.log(`\n== ${t}`);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-probe-unit-'));
const ORIGIN = 'http://127.0.0.1:9';
const mk = (o = {}, name = 'c') => new Safety(cfgMod.resolve({ cooldownFile: path.join(tmp, `${name}.json`), navigationDelayMs: 0, requestDelayMs: 0, ...o }), { origin: ORIGIN, stateDir: path.join(tmp, `s-${name}`) });

group('settings');
const c = cfgMod.resolve();
ok(c.stopAfter429 === 1 && c.concurrency === 1, 'the first 429 stops the probe and there is one request at a time');
ok(c.navigationDelayMs === 2000 && c.stopAfter403 === 3 && c.stopAfter5xx === 3 && c.protectionCooldownMinutes === 30, 'default pacing (2 s) and thresholds');
ok(!/frontend/.test(c.cooldownFile) && c.cooldownFile.startsWith(path.join(__dirname, '..')), 'the default cooldown file is inside plugin-guard, not in another module');

group('classification');
ok(classify({ status: 200 }) === 'ok' && classify({ status: 429 }) === 'rate-limited' && classify({ status: 403 }) === 'forbidden' && classify({ status: 502 }) === 'server-error', 'ok / 429 / 403 / 5xx');
ok(classify({ status: 200, headers: { 'CF-Mitigated': 'challenge' } }) === 'challenge', 'the cf-mitigated header is a challenge, whatever the case');
ok(classify({ status: 403, title: 'Just a moment...' }) === 'challenge' && classify({ status: 200, title: 'Just a moment...' }) === 'ok', 'challenge text counts only on 403 / 429 / 503');

group('stopping');
let s = mk();
s.recordOutcome('rate-limited', { url: ORIGIN + '/a', status: 429 });
ok(s.isStopped() && /429/.test(s.stopReason()), 'the first 429 stops the probe');
s = mk(); s.recordOutcome('challenge', { url: ORIGIN + '/a', status: 403 });
ok(s.isStopped() && /challenge/i.test(s.stopReason()), 'a challenge on a page stops at once');
s = mk(); s.recordOutcome('forbidden', {}); s.recordOutcome('forbidden', {});
ok(!s.isStopped(), 'two 403 answers do not stop it yet');
s.recordOutcome('forbidden', {});
ok(s.isStopped() && /403/.test(s.stopReason()), 'the third does');
s = mk(); s.recordOutcome('server-error', {}); s.recordOutcome('server-error', {});
ok(!s.isStopped(), 'a broken page and its one retry (2 x 5xx) are observed');
s.recordOutcome('server-error', {});
ok(s.isStopped() && /5xx/.test(s.stopReason()), 'a second broken page stops it (server instability)');
s = mk(); s.recordOutcome('connection-error', {}); ok(!s.isStopped(), 'one connection error: continue'); s.recordOutcome('connection-error', {});
ok(s.isStopped(), 'two connection errors: stop');

group('cooldown file (the probe\'s own)');
s = mk({}, 'cool'); ok(s.readCooldown() === null, 'no cooldown before anything happened');
s.recordOutcome('rate-limited', { url: ORIGIN + '/a', status: 429 }); s.writeCooldown();
const next = mk({}, 'cool');
ok(next.readCooldown() && /429/.test(next.readCooldown().reason), 'the next run sees the cooldown for the same origin');
const other = new Safety(cfgMod.resolve({ cooldownFile: path.join(tmp, 'cool.json') }), { origin: 'http://127.0.0.1:10', stateDir: path.join(tmp, 's-o') });
ok(other.readCooldown() === null, 'a different origin is not held back');
const written = JSON.parse(fs.readFileSync(path.join(tmp, 'cool.json'), 'utf8'));
ok(Object.keys(written).join() === ORIGIN, 'only the origin and the reason are stored');
s = mk({}, 'clean'); s.writeCooldown(); ok(!fs.existsSync(path.join(tmp, 'clean.json')), 'nothing is written when nothing went wrong');

group('layout checks (names and order)');
ok(layout.ORDER.join() === 'overflow,text-edge,overlap,broken-words,unreachable', 'five DOM-only checks in a fixed order');
ok(typeof layout.runCheck === 'function', 'runCheck is exported');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
