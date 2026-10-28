// "Verified in sandbox": take the patches and shims of the resolution plans, apply each one to the SANDBOX COPY (never the original), run
// `php -l`, run the oracle again on the same pages and screen sizes that failed, and mark the option verified ONLY if the symptom is gone there
// (retest.compare, with the same page / screen size rule). Anything else stays labelled as not verified, with the reason:
//   verified_in_sandbox: true   the symptom was present before, and absent after, on every page and screen size that failed
//   verified_in_sandbox: false  tested, and it did NOT help (still failing, or a new problem appeared)
//   verified_in_sandbox: null   not tested (no Docker, symptom not reproduced in the sandbox, the diff did not apply, ...)
// One sandbox is built for all options; each option is applied, tested and reverted in a fixed order.

const fs = require('fs');
const path = require('path');
const phase = require('./sandbox-phase');
const patchgen = require('./patchgen');
const phpast = require('./phpast');
const retest = require('./retest');
const store = require('../lib/issue-store');

const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const OPCACHE_WAIT_MS = 3500;   // the official image revalidates cached PHP files every 2 seconds

const candidates = plans => plans.flatMap(p => p.options.map((o, i) => ({ plan: p, o, i }))).filter(x => (x.o.type === 'patch' || x.o.type === 'shim') && x.o.verified);

function label(o, status, reason, extra = {}) {
    o.sandbox_verification = { status, reason, ...extra };
    o.verified_in_sandbox = status === 'VERIFIED' ? true : status === 'TESTED_NO_FIX' ? false : null;
    if (status === 'TESTED_NO_FIX' && o.who === 'send-to-claude-code') o.who = 'needs-a-human';   // a patch that did not help is not a task
    const decided = status === 'VERIFIED' || status === 'TESTED_NO_FIX';
    o.not_verified = (o.not_verified || []).filter(n => !/oracle has not been re-run|Not yet run in the sandbox/.test(n) && !(decided && /TEST TO CHOOSE/.test(n)));
    if (status !== 'VERIFIED') o.not_verified.push(`NOT verified in sandbox: ${reason}`);
    if (o.test_to_choose) {
        o.test_to_choose = !decided;   // decided only when the sandbox ran this candidate
        if (decided) { o.title = o.title.replace(' (candidate; test to choose)', ` (candidate; ${status === 'VERIFIED' ? 'the one that worked' : 'tested, did not help'})`); o.detail = String(o.detail).replace(/^TEST TO CHOOSE: this is one of TWO candidate orders and neither is the answer yet\. /, `Tested in the sandbox: ${status === 'VERIFIED' ? 'this order made the symptom disappear' : 'this order did not make the symptom disappear'}. `); }
    }
}

async function run(id, { root, plans, options = {}, env = process.env, sandboxOptions = {} }) {
    const list = candidates(plans);
    if (!list.length) return { steps: [{ id: 'verify-fixes', label: 'Verify patches and shims in the sandbox', status: 'NOT_RUN', reason: 'no patch or shim to verify' }], results: 0 };
    if (!options.sandbox || !root) {
        for (const x of list) label(x.o, 'NOT_RUN', !options.sandbox ? 'the sandbox was not requested (--sandbox), so this was checked statically only' : 'a local copy of the site (--root) is needed');
        return { steps: [{ id: 'verify-fixes', label: 'Verify patches and shims in the sandbox', status: 'NOT_RUN', reason: 'no sandbox: patches and shims stay "not verified in sandbox"' }], results: 0 };
    }
    const results = [];
    const verify = async ({ handle, tester, baseline }) => {
        const before = (baseline.matches || []).map(m => ({ page: m.page, viewport: m.viewport }));
        const active = baseline.active_plugins;
        for (const { o } of list) {
            if (!before.length) { label(o, 'NOT_RUN', 'the symptom was present in the sandbox but no failing page and screen size was recorded'); continue; }
            const target = o.type === 'patch' ? path.join(handle.dir, 'site', o.file) : path.join(handle.dir, 'site', 'wp-content', 'mu-plugins', o.file);
            let restore = null;
            try {
                if (o.type === 'patch') {
                    if (path.relative(path.join(handle.dir, 'site'), target).startsWith('..')) { label(o, 'NOT_RUN', 'the file is outside the sandbox copy'); continue; }
                    let orig; try { orig = fs.readFileSync(target, 'utf8'); } catch { label(o, 'NOT_RUN', 'the file is not in the sandbox copy'); continue; }
                    let patched; try { patched = patchgen.applyUnified(orig, o.diff); } catch (e) { label(o, 'NOT_RUN', `the diff does not apply to the sandbox copy (${e.message})`); continue; }
                    fs.writeFileSync(target, patched); restore = () => fs.writeFileSync(target, orig);
                } else {
                    fs.writeFileSync(target, o.php); restore = () => fs.rmSync(target, { force: true });
                }
                const lint = phpast.phpLint(target);
                if (lint && !lint.ok) { label(o, 'TESTED_NO_FIX', `php -l fails on the applied file: ${lint.message}`); continue; }
                sleep(OPCACHE_WAIT_MS);
                const r = await tester({ plugins: active, theme: null, mu: null });
                const now = tester.last ? { ...tester.last } : null;
                const cmp = retest.compare(before, now, { sandbox: true });
                if (cmp.verdict === 'Fixed') label(o, 'VERIFIED', `applied in the sandbox, php -l passed, and the oracle passed on every page and screen size that failed before (${before.map(b => `${new URL(b.page, 'http://x').pathname + new URL(b.page, 'http://x').search} @ ${b.viewport}`).join('; ')})`, { compared: before });
                else if (cmp.verdict === 'Could not test') label(o, 'NOT_RUN', cmp.reason);
                else label(o, 'TESTED_NO_FIX', `applied in the sandbox; ${cmp.verdict}: ${cmp.reason}`);
                results.push({ file: o.file, result: r });
            } catch (e) {
                label(o, 'NOT_RUN', `the test failed: ${String(e.message).split('\n')[0].slice(0, 160)}`);
            } finally { if (restore) { try { restore(); } catch { /* the sandbox is destroyed next */ } sleep(OPCACHE_WAIT_MS); } }
        }
    };
    const sb = await phase.run(id, { root, options: { ...options, sandbox: true, noBisect: true, keepSandbox: false }, analysis: { components: [], top: [] }, env, sandboxOptions, verify, noWrite: true });
    const done = list.filter(x => x.o.sandbox_verification).length;
    for (const x of list) if (!x.o.sandbox_verification) label(x.o, 'NOT_RUN', (sb.steps.find(s => s.id === 'sandbox') || sb.steps.find(s => s.id === 'bisect') || {}).reason || (sb.reproduced_in_sandbox === 'no' ? 'the symptom was not reproduced in the sandbox, so a fix cannot be shown to remove it' : 'the sandbox did not run'));
    return { steps: [{ id: 'verify-fixes', label: 'Verify patches and shims in the sandbox', status: done ? 'PASSED' : 'NOT_RUN', reason: `${list.filter(x => x.o.verified_in_sandbox === true).length} verified, ${list.filter(x => x.o.verified_in_sandbox === false).length} tested without effect, ${list.filter(x => x.o.verified_in_sandbox === null).length} not tested` }], results: done };
}

module.exports = { run, candidates, label };
