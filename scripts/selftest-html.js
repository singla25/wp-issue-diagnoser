#!/usr/bin/env node
// Browser test of report.html opened from a file:// path (Playwright from src/frontend). No network: every request is counted and aborted.
// Verifies search, combined filters, clear-all, counts, empty state, untrusted-text handling, offline use.

const fs = require('fs');
const os = require('os');
const path = require('path');
const schema = require('../lib/schema');
const html = require('../lib/report-html');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };

function mk(i, o) { return schema.makeFinding({ id: `F-${i}`, run_id: 'r', title: `finding ${i}`, ...o }); }
const XSS = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script></script><script>window.__pwned=3</script>';
const findings = [
    mk(1, { title: 'SQL built from variables', severity: 'HIGH', status: 'CONFIRMED', category: 'custom-code', finding_type: 'security', source_agent: 'code-security', component: 'plugin:mine', file_path: 'wp-content/plugins/mine/a.php', line_start: 7, fix_eligible: true, allowed_fix_paths: ['wp-content/plugins/mine/a.php'], evidence: ['wp-content/plugins/mine/a.php:7'], description: 'alpha-needle' }),
    mk(2, { title: 'Console error on /shop', severity: 'MEDIUM', status: 'PROBABLE_NEEDS_REVIEW', category: 'console', finding_type: 'defect', source_agent: 'user-frontend', url: 'https://example.test/shop', component: 'plugin:shop', description: 'Uncaught TypeError' }),
    mk(3, { title: 'Blocked by Cloudflare challenge', severity: 'INFO', status: 'BLOCKED', category: 'access', finding_type: 'access-restriction', source_agent: 'user-frontend', blocked_reason: 'challenge page' }),
    mk(4, { title: 'eval in clean.php', severity: 'INFO', status: 'REJECTED_FALSE_POSITIVE', category: 'custom-code', finding_type: 'security', source_agent: 'code-security', component: 'plugin:mine', file_path: 'wp-content/plugins/mine/clean.php' }),
    mk(5, { title: XSS, severity: 'LOW', status: 'UNVERIFIED', category: 'custom-code', finding_type: 'security', source_agent: 'code-security', component: XSS, description: XSS, evidence: [XSS], file_path: XSS }),
    mk(6, { title: 'Hook priority clash', severity: 'MEDIUM', status: 'PROBABLE_NEEDS_REVIEW', category: 'conflict', finding_type: 'conflict', source_agent: 'code-security', component: 'plugin:other', file_path: 'wp-content/plugins/other/o.php' })
];
const checks = [{ id: 'c1', label: 'php -l', status: 'PASSED', reason: '3 files' }, { id: 'c2', label: 'login', status: 'NEEDS_AUTHORIZATION', reason: 'staging needed' }];
const data = { schema_version: '1.0', run_id: 'r', generated_at: new Date().toISOString(), complete: false, target: { url: 'https://example.test/', root: '/x' }, stages: [{ id: 'agent1', name: 'Agent 1', state: 'completed' }, { id: 'agent2', name: 'Agent 2', state: 'missing' }], checks, input_problems: [], findings, summary: schema.summarize(findings, checks), limits: ['l1'] };

async function main() {
    let pw;
    try { pw = require(require.resolve('@playwright/test', { paths: [path.join(__dirname, '..', '..', 'frontend')] })); } catch { console.log('NOT RUN  Playwright is not installed (npm run setup:frontend): the dashboard was not tested in a browser'); process.exit(0); }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-html-'));
    const file = path.join(dir, 'report.html');
    fs.writeFileSync(file, html.build(data));
    let browser;
    try { browser = await pw.chromium.launch(); } catch (e) { console.log(`NOT RUN  Chromium cannot start (${e.message.split('\n')[0]})`); process.exit(0); }
    const ctx = await browser.newContext();
    const requests = [];
    await ctx.route('**/*', route => { const u = route.request().url(); if (!u.startsWith('file://')) { requests.push(u); return route.abort(); } return route.continue(); });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', d => { errors.push(`dialog: ${d.message()}`); d.dismiss(); });
    await page.goto(`file://${file}`);
    const shown = () => page.locator('details.f').count();
    const count = () => page.locator('#count').innerText();

    ok(await shown() === 6 && /Showing 6 of 6/.test(await count()), 'opens from file:// and lists every finding');
    ok(errors.length === 0, `no script errors or dialogs (${errors.join('; ') || 'none'})`);
    ok(requests.length === 0, `no network request was attempted (${requests.length})`);
    const cards = await page.locator('#cards .card').allInnerTexts();
    ok(cards[0].startsWith(String(data.summary.total)) && cards.find(t => /^1\s*\nHigh/.test(t)) && cards.find(t => /Blocked/.test(t)).startsWith('1'), 'summary cards show the counts embedded from the validated findings');
    ok(await page.locator('#banner').isVisible() && /Agent 2/.test(await page.locator('#banner').innerText()), 'a partial run shows a banner naming the missing stage');

    await page.fill('#q', 'alpha-needle');
    ok(await shown() === 1 && /Showing 1 of 6/.test(await count()), 'search matches the description and excludes the others');
    await page.fill('#q', 'plugins/mine');
    ok(await shown() === 2, 'search covers file paths');
    await page.fill('#q', 'mine clean');
    ok(await shown() === 1, 'several search words must all match');
    await page.fill('#q', '');
    await page.selectOption('#f-severity', 'MEDIUM');
    ok(await shown() === 2, 'severity filter');
    await page.selectOption('#f-agent', 'code-security');
    ok(await shown() === 1, 'severity + agent filters combine');
    await page.selectOption('#f-status', 'CONFIRMED');
    ok(await shown() === 0, 'contradicting filters give an empty result');
    ok(await page.locator('.empty').isVisible() && /No findings match/.test(await page.locator('.empty').innerText()) && /Showing 0 of 6/.test(await count()), 'empty state is shown with a zero count');
    await page.click('#clear');
    ok(await shown() === 6 && (await page.inputValue('#f-severity')) === '' && (await page.inputValue('#f-status')) === '' && (await page.inputValue('#f-agent')) === '' && (await page.inputValue('#q')) === '', 'clear-all resets search and every filter');
    await page.check('input[name=view][value=blocked]');
    ok(await shown() === 1 && /Cloudflare/.test(await page.locator('details.f').first().innerText()), 'view: blocked checks');
    await page.check('input[name=view][value=actionable]');
    ok(await shown() === 1, 'view: actionable shows only fix-eligible findings');
    await page.check('input[name=view][value=security]');
    ok(await shown() === 3, 'view: unresolved security excludes rejected false positives');
    await page.selectOption('#f-component', 'plugin:mine');
    ok(await shown() === 1, 'a view and a filter combine');
    await page.check('input[name=view][value=rejected]');
    ok(await shown() === 1 && /eval in clean/.test(await page.locator('details.f').first().innerText()), 'view: rejected false positives');
    await page.click('#clear');
    await page.check('input[name=view][value=review]');
    ok(await shown() === 3, 'view: needs review (probable + unverified)');
    await page.click('#clear');

    // untrusted text
    const xssCard = page.locator('details.f[data-id="F-5"]');
    ok(await xssCard.count() === 1 && (await xssCard.locator('summary').innerText()).includes('<img src=x'), 'markup-like text is displayed as text');
    await xssCard.locator('summary').click();
    ok(await page.evaluate(() => window.__pwned === undefined) && await page.locator('img[src="x"]').count() === 0, 'untrusted text did not execute or create elements');
    ok(await page.locator('script').count() === 2, 'only the two original script elements exist (data and code)');
    const detailsOpen = await page.locator('details.f[data-id="F-1"]').evaluate(d => { d.open = false; return d.open; });
    await page.locator('details.f[data-id="F-1"] summary').click();
    ok(detailsOpen === false && await page.locator('details.f[data-id="F-1"]').evaluate(d => d.open), 'a finding expands and collapses');

    // keyboard + accessibility basics
    await page.focus('#q');
    await page.keyboard.press('Tab');
    ok(await page.evaluate(() => document.activeElement && document.activeElement.tagName === 'SELECT'), 'controls are reachable with the keyboard');
    ok(await page.locator('#q').evaluate(e => !!e.labels.length) && await page.locator('#f-severity').evaluate(e => !!e.labels.length), 'inputs have labels');
    ok(await page.locator('#count').getAttribute('aria-live') === 'polite', 'the match count is announced to screen readers');
    await page.setViewportSize({ width: 375, height: 700 });
    ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no horizontal scrolling at 375px width');
    await page.emulateMedia({ colorScheme: 'dark' });
    ok(await page.evaluate(() => getComputedStyle(document.body).backgroundColor) !== 'rgb(246, 247, 249)', 'dark colour scheme is honoured');
    ok(requests.length === 0 && errors.length === 0, 'still no network request and no script error after all interactions');

    // empty report
    const empty = path.join(dir, 'empty.html');
    fs.writeFileSync(empty, html.build({ ...data, findings: [], summary: schema.summarize([], []), checks: [], complete: true }));
    await page.goto(`file://${empty}`);
    ok(/No findings were recorded/.test(await page.locator('.empty').innerText()), 'a run with zero findings renders an explicit empty state');

    failures += await require('./selftest-html-issue').run(pw, browser, dir);
    failures += await require('./selftest-html-auto').run(pw, browser, dir, data);

    await browser.close();
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
    process.exit(failures ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
