#!/usr/bin/env node
// Self-test of issue/probe-plan.js: how many page loads the probe PLANNED, read from probe.json. ONE number for the stored oracle answer (issue/probe.js), for the oracle
// recomputation (issue/validate.js) and for the check rows (issue/checkpoints.js). Runs the REAL probe worker (Chromium) against a local fixture server on 127.0.0.1
// (page loads are not paced here: PG_PROBE_NAV_DELAY_MS is 0), then reads the real probe.json. Never touches a real site.
//   - observedPlanned on every shape (a plain number, the real object, a skipped second screen size, a partial probe, missing or odd);
//   - the table: for five shapes the number the probe stored with its oracle answer (probe.json oracle.pages_planned) is EQUAL to observedPlanned(probe.json);
//   - validate.js: the recomputed oracle answer agrees with the stored one for each real probe.json (a partial probe says "could-not-test", never "no", and no downgrade).
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-plan-'));
process.env.PLUGIN_GUARD_ISSUES = path.join(tmp, 'issues');
const store = require('../lib/issue-store');
const probeMod = require('../issue/probe');
const validate = require('../issue/validate');
const plan = require('../issue/probe-plan');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const group = t => console.log(`\n== ${t}`);
const J = JSON.stringify;
const OK200 = '<!doctype html><html><head><title>Fixture</title></head><body><h1>Fixture shop</h1><p>The page works and has enough text to look like a real page.</p></body></html>';
const CRIT = '<html><body>There has been a critical error on this website.</body></html>';

(async () => {
    group('observedPlanned on every shape (no browser)');
    const pg = (o = {}) => ({ url: 'http://127.0.0.1:9/', viewport: { name: 'laptop', width: 1280, height: 800 }, loaded: true, status: 200, ...o });
    const SK = pg({ viewport: { name: 'mobile', width: 390, height: 844 }, loaded: false, status: 0, skipped: 'answered HTTP 500 at laptop; not requested again at another screen size', reused_status: 500 });
    const real = loads => ({ pages: ['http://127.0.0.1:9/'], viewports: ['laptop 1280x800', 'mobile 390x844'], loads, notes: [] });
    ok(plan.observedPlanned({ planned: real(2), pages: [pg(), pg({ viewport: { name: 'mobile' } })] }) === 2, 'the real object, every load done: 2');
    ok(plan.observedPlanned({ planned: real(2), pages: [pg({ status: 500 }), SK] }) === 1, 'the real object, the second screen size skipped after a 5xx: 2 - 1 = 1');
    ok(plan.observedPlanned({ planned: real(2), protection: { reason: '429' }, pages: [pg()] }) === 2, 'the real object, a partial probe (one load done, then a stop): the FULL plan, 2');
    ok(plan.observedPlanned({ planned: 3, pages: [pg(), SK] }) === 3, 'a plain number stays as it is (older data), also with a skipped page');
    ok(plan.observedPlanned({ pages: [pg(), pg()] }) === 2 && plan.observedPlanned({ planned: null, pages: [pg()] }) === 1, 'planned missing: the number of page records (as before)');
    ok([0, -1, 1.5, '2', NaN, {}, { loads: 0 }, { loads: '2' }, { loads: 1.5 }, [], true].every(v => plan.observedPlanned({ planned: v, pages: [pg(), pg(), pg()] }) === 3), 'planned odd or not usable (0, negative, fractional, text, NaN, {}, bad loads): the number of page records');
    ok(plan.observedPlanned(null) === 0 && plan.observedPlanned({}) === 0 && plan.observedPlanned({ planned: real(1), pages: [SK, SK] }) === 0, 'no probe, no pages, more skipped than planned: 0 (the oracle then uses the page records)');
    const src = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    ok(/require\('\.\/probe-plan'\)/.test(src('issue/checkpoints.js')) && /require\('\.\/probe-plan'\)/.test(src('issue/validate.js')) && /require\('\.\/probe-plan'\)/.test(src('issue/probe.js')) && !/const plannedLoads = v =>/.test(src('issue/checkpoints.js')) && !/probe\.planned \|\| probe\.pages\.length/.test(src('issue/validate.js')) && !/const plannedLoads = typeof raw\.planned/.test(src('issue/probe.js')), 'checkpoints.js, validate.js and probe.js import the module; the old copies of the logic are gone');

    group('the table: stored number = observedPlanned, for five shapes (real probe.json from the real probe)');
    let docCount = 0;
    const makeServer = mode => new Promise(resolve => {
        const sv = http.createServer((q, res) => {
            if (q.url !== '/') { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('nope'); }
            docCount++;
            if (mode === '200') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(OK200); }
            if (mode === '500') { res.writeHead(500, { 'Content-Type': 'text/html' }); return res.end(CRIT); }
            if (docCount === 1) { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(OK200); }   // 429: the first load works, the second one is rate limited
            res.writeHead(429, { 'Content-Type': 'text/plain', 'Retry-After': '1' }); res.end('slow down');
        });
        sv.listen(0, '127.0.0.1', () => resolve(sv));
    });
    const runCase = async (name, mode, oracle) => {
        docCount = 0;
        const sv = await makeServer(mode);
        try {
            const issue = store.create({ title: name, description: 'fixture', symptom: 'other', environment: 'local', url: `http://127.0.0.1:${sv.address().port}/`, pages: [], oracle });
            const env = { ...process.env, PG_PROBE_NAV_DELAY_MS: '0', PG_PROBE_REQUEST_DELAY_MS: '0', PG_PROBE_5XX_RETRY_DELAY_MS: '0', PG_PROBE_COOLDOWN_FILE: path.join(tmp, `cool-${name}.json`) };
            await probeMod.run(issue.id, { root: null, options: { viewports: 'laptop,mobile', layout: false }, env });
            const dir = store.dirOf(issue.id), pj = JSON.parse(fs.readFileSync(path.join(dir, 'work', 'probe.json'), 'utf8'));
            fs.writeFileSync(path.join(dir, 'work', 'hypotheses.json'), JSON.stringify({ symptom_reproduced: { result: 'not-tested' }, hypotheses: [] }));
            fs.writeFileSync(path.join(dir, 'work', 'evidence.json'), JSON.stringify({ clues: [], steps: [] }));
            return { id: issue.id, dir, pj };
        } finally { sv.close(); }
    };
    const stored = pj => pj.oracle && pj.oracle.pages_planned;
    const C200 = await runCase('complete-200', '200', { type: 'console-error', value: 'zzz-never-seen' });
    const C500 = await runCase('five-hundred-skipped', '500', { type: 'console-error', value: 'zzz-never-seen' });
    const C429 = await runCase('rate-limited-partial', '429', { type: 'console-error', value: 'zzz-never-seen' });
    const rows = [['a complete 200 page (2 of 2 loads)', C200.pj, 2], ['a 500 page, the second screen size skipped', C500.pj, 1], ['a 429 stop after one load (partial)', C429.pj, 2]];
    // the plain number and the missing shape: the same real probe.json with `planned` replaced (what older data looks like); the stored number is what the old formula gave
    const asNumber = { ...C200.pj, planned: 2 }, asMissing = (() => { const c = { ...C200.pj }; delete c.planned; return c; })();
    rows.push(['`planned` as a plain number (older data)', asNumber, 2], ['`planned` missing', asMissing, C200.pj.pages.length]);
    for (const [name, pj, want] of rows) {
        const got = plan.observedPlanned(pj), st = stored(pj);
        ok(got === want && st === want && got === st, `${name}: the stored number ${st} = observedPlanned ${got} = ${want}`);
    }
    ok(C200.pj.pages.every(p => p.loaded) && C500.pj.pages.filter(p => p.skipped).length === 1 && C429.pj.protection && C429.pj.pages.filter(p => p.loaded).length === 1 && C429.pj.oracle.result === 'could-not-test', 'the three real probes are what the table says: complete; one page skipped; one page loaded then a protection stop with the answer "could-not-test"');
    ok(J(C200.pj.planned.loads) === '2' && typeof C429.pj.planned === 'object', 'in real data `planned` is the object, and `loads` is the FULL plan (2) even for the partial probe');

    group('validate.js: the recomputed oracle answer agrees with the stored one, and a partial probe is never "no"');
    const val = c => validate.run(c.id, { root: null });
    const v200 = val(C200), v500 = val(C500), v429 = val(C429);
    const oc = v => (v.checks.find(x => x.id === 'oracle') || {});
    ok(v200.oracle.agrees === true && oc(v200).status === 'PASSED' && v200.oracle.recomputed === 'no', 'complete 200 page: agrees, the check PASSED, answer "no" (unchanged)');
    ok(v500.oracle.agrees === true && oc(v500).status === 'PASSED' && v500.oracle.recomputed === C500.pj.oracle.result, 'a 500 page with a skipped second screen size: agrees (the skipped load is not counted as planned), the check PASSED');
    ok(C429.pj.oracle.result === 'could-not-test' && v429.oracle.recomputed === 'could-not-test' && v429.oracle.agrees === true && oc(v429).status === 'PASSED', 'a partial 429 probe: the stored answer and the recomputation are both "could-not-test", they agree, the oracle check is PASSED');
    ok(v429.symptom_reproduced === 'could-not-test' && !v429.checks.some(x => x.status === 'FAILED'), 'and the symptom stays "could-not-test" with no FAILED check: nothing is downgraded because of a false disagreement');
    ok([v200, v500, v429].every((v, i) => v.oracle.recomputed === [C200, C500, C429][i].pj.oracle.result), 'for every real probe the recomputed answer is the stored answer: it is never stronger and never weaker');
    for (const [name, pj] of [['a plain number', asNumber], ['missing', asMissing]]) {
        fs.writeFileSync(path.join(C200.dir, 'work', 'probe.json'), J(pj));
        const v = val(C200);
        ok(v.oracle.agrees === true && v.oracle.recomputed === 'no' && oc(v).status === 'PASSED', `\`planned\` ${name}: today's behaviour is kept (agrees, "no", PASSED)`);
    }
    const partialNoPlan = { ...C429.pj }; delete partialNoPlan.planned;
    fs.writeFileSync(path.join(C429.dir, 'work', 'probe.json'), J(partialNoPlan));
    const vNo = val(C429);
    ok(vNo.oracle.recomputed === 'could-not-test' && vNo.oracle.agrees === true, 'a partial probe with no `planned` at all: the page records (one loaded, one rate limited = 2) are the plan, so it is still partial: "could-not-test", agrees, as before');

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll probe-plan checks passed');
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } process.exit(1); });
