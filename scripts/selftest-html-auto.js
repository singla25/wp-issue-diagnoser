// Browser test of the guard:auto sections of report.html (called from selftest-html.js with the Playwright objects and the base report data).
const fs = require('fs');
const path = require('path');
const html = require('../lib/report-html');
const { contrast } = require('./selftest-html-issue');
const XSS = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>';

async function run(pw, browser, dir, base) {
    let failures = 0;
    const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
    console.log('\n== report.html: guard:auto sections');
    const issue = (o = {}) => ({ id: 'iss-20261028-100000-abcdef', title: `[auto] Console error: “${XSS}” on /shop/`, oracle: { type: 'console-error', value: XSS }, pages: ['/shop/', '/cart/'], occurrences: 3, severity: 'P2', fingerprint: 'abc123', verdict: 'Reproduced and cause found', confidence: 'high', reproduced_in_sandbox: 'yes', sandbox_reason: null, not_plugin_conflict: false, cause: '[REPRODUCIBLE] Sandbox bisection: pg-a + pg-b. They break together.', bisect: 'cause-found: [pg-a, pg-b] (6 tests, 2 cached)', options: ['[you-can-do-this] shim: candidate (VERIFIED IN SANDBOX)', `[needs-a-human] plugin: ${XSS}`], report: '../../issues/iss-x/result/issue.html', ...o });
    const auto = {
        inputs: { url: 'https://staging.example/', environment: 'staging', root: '/srv/copy', max_issues: 5, sandbox_max_issues: 3 }, mode: 'sandbox', mode_reason: null, preflight: { started_docker: false, attempts: [] },
        counts: { considered: 9, groups: 3, issues: 2, reproduced: 2, not_plugin: 1 },
        issues: [issue(), issue({ id: 'iss-20261028-100001-abcdef', title: '[auto] Uncaught JavaScript error: “themebug” on /legacy/', oracle: { type: 'console-error', value: 'themebug' }, verdict: 'Probable cause', not_plugin_conflict: true, cause: null, bisect: 'not-explained (3 tests, 0 cached)', options: [] })],
        issues_none: null, skipped: [], shared: { page_loads: 7, sets: 7, cache_hits: 9, issues: 2 }, sandbox_steps: [],
        integrity: { same: true, files: 120, detail: '' },
        did_not_run: [{ what: 'Login / registration with test accounts', why: 'The frontend agent is read-only and never logs in.' }, { what: `Sandbox test of "${XSS}"`, why: 'over --sandbox-max-issues (3)' }]
    };
    const d = { ...base, complete: true, auto };
    const file = path.join(dir, 'report-auto.html'); fs.writeFileSync(file, html.build(d));
    const ctx = await browser.newContext(); const requests = [];
    await ctx.route('**/*', r => { const u = r.request().url(); if (!u.startsWith('file://')) { requests.push(u); return r.abort(); } return r.continue(); });
    const page = await ctx.newPage(); const errors = [];
    page.on('pageerror', e => errors.push(e.message)); page.on('dialog', x => { errors.push(`dialog: ${x.message()}`); x.dismiss(); });
    await page.goto(`file://${file}`);
    ok(errors.length === 0 && requests.length === 0, `opens from file:// without script errors or network requests (${errors.join('; ') || 'none'})`);
    const heads = await page.locator('main h2').allInnerTexts();
    const want = ['Summary', 'Run summary (guard:auto)', 'Frontend findings', 'Code and conflict findings', 'Auto-issues: causes and fixes', 'Not a plugin conflict', 'What did not run, and why', 'Findings'];
    ok(want.every((w, i) => heads[i] === w), `the sections come in the required order: ${heads.slice(0, 8).join(' > ')}`);
    ok(/Sandbox: ONE throwaway copy/.test(await page.locator('#auto-summary').innerText()) && /7 page load\(s\) for 7 plugin set\(s\); 9 answer/.test(await page.locator('#auto-summary').innerText()) && /unchanged \(120 files/.test(await page.locator('#auto-summary').innerText()), 'summary: mode, shared page loads, and the original-site check');
    const cards = page.locator('#auto-issues details.f');
    ok(await cards.count() === 2 && /Reproduced and cause found/.test(await cards.first().innerText()) && /\[pg-a, pg-b\]/.test(await cards.first().innerText()) && /VERIFIED IN SANDBOX/.test(await cards.first().innerText()), 'auto-issue cards: verdict, bisect cause and fix');
    ok(/NOT A PLUGIN CONFLICT/.test(await cards.nth(1).innerText()) && /themebug/.test(await page.locator('#auto-not-plugin').innerText()) && /still present with EVERY plugin switched off/.test(await page.locator('#auto-not-plugin').innerText()), '"not a plugin conflict" is flagged on the card and listed in its own section with the plain explanation');
    ok(/Login/.test(await page.locator('#auto-notrun').innerText()) && /over --sandbox-max-issues/.test(await page.locator('#auto-notrun').innerText()), '"what did not run" lists each step with its reason');
    ok(await page.evaluate(() => window.__pwned === undefined) && await page.locator('img[src="x"]').count() === 0 && (await page.locator('#auto-issues').innerText()).includes('<img src=x'), 'hostile text in titles, oracles and options is shown as text and did not execute');
    ok(await page.locator('script').count() === 2, 'still exactly two script elements');
    await page.locator('#auto-frontend button').click();
    ok(await page.inputValue('#f-agent') === 'user-frontend' && /Showing \d+ of/.test(await page.locator('#count').innerText()), '"Show these in the full findings list" applies the agent filter');
    await page.setViewportSize({ width: 375, height: 700 });
    ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no horizontal scrolling at 375px');
    for (const scheme of ['light', 'dark']) { await page.emulateMedia({ colorScheme: scheme }); await page.setViewportSize({ width: 1000, height: 800 }); const c = await contrast(page); ok(c.count === 0, `colour contrast in the ${scheme} scheme (${c.checked} elements, ${c.count} below the limit${c.bad.length ? ': ' + c.bad.join(' | ') : ''})`); }
    // empty auto block
    const e = path.join(dir, 'report-auto-empty.html'); fs.writeFileSync(e, html.build({ ...base, complete: true, auto: { ...auto, issues: [], counts: { considered: 0, groups: 0, issues: 0, reproduced: 0, not_plugin: 0 }, issues_none: 'Frontend QA did not run, so there was nothing to turn into issues.', did_not_run: [], mode: 'static-only', mode_reason: 'the sandbox was switched off (--no-sandbox)', shared: null, integrity: { same: null, files: 0, detail: 'too many files' } } }));
    await page.goto(`file://${e}`);
    ok(await page.locator('#auto-issues .empty').count() === 1 && /did not run/.test(await page.locator('#auto-issues').innerText()) && /Static-only: no sandbox \(the sandbox was switched off/.test(await page.locator('#auto-summary').innerText()) && await page.locator('#auto-notrun .empty').count() === 1, 'no issues and nothing skipped: explicit empty states, static-only mode explained');
    // a normal report is unchanged
    const n = path.join(dir, 'report-plain.html'); fs.writeFileSync(n, html.build(base)); await page.goto(`file://${n}`);
    ok(await page.locator('#auto-summary').count() === 0 && errors.length === 0, 'a report without the auto block shows none of these sections');
    await ctx.close();
    return failures;
}
module.exports = { run };
