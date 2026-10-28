// Browser tests of issue.html and the Issues index, opened from file://. Called from selftest-html.js (Playwright from src/frontend).
// Checks: every section, untrusted text shown as text, offline, no innerHTML, keyboard use (graph, screenshot dialog), 375 px without sideways
// scrolling, and a computed colour-contrast check (WCAG 2 AA) in the light and the dark scheme.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const html = require('../lib/issue-html');

const XSS = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script></script><script>window.__pwned=3</script>';
// a 2x2 red PNG, built here so the test needs no fixture file
const PNG = (() => { const zlib = require('zlib'); const crc = b => { let c, n, t = []; for (n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } let x = 0xFFFFFFFF; for (const v of b) x = t[(x ^ v) & 255] ^ (x >>> 8); return (x ^ 0xFFFFFFFF) >>> 0; };
    const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(2, 4); ihdr[8] = 8; ihdr[9] = 2; const raw = Buffer.from([0, 255, 0, 0, 255, 0, 0, 0, 255, 0, 0, 255, 0, 0]);
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]); })();

function sample() {
    const hyp = (id, title, status, extra = {}) => ({ id, title, status, score: 9.5, family: 'hook', components: ['plugin-a', 'plugin-b'], mechanism: `${XSS} Plugin A and plugin B both add a callback. Second sentence.`, supports: [], contradicts: [], score_breakdown: [], oracle: {}, checks: [{ id: 'evidence:x.php:3', status: 'PASSED', reason: 'construct found at line 3' }], validation_notes: [XSS], independent_kinds: ['log', 'observation'], ownership: [], fix_eligible: true, ...extra });
    const diff = '--- a/wp-content/plugins/plugin-b/plugin-b.php\n+++ b/wp-content/plugins/plugin-b/plugin-b.php\n@@ -5,4 +5,6 @@\n context\n-old line <script>\n+new line\n context\n';
    return {
        schema: 1, generator: 'plugin-guard issue mode', generated_at: '2026-10-28T10:00:00.000Z',
        issue: { id: 'iss-20261028-100000-abcdef', title: `Cart broken ${XSS}`, symptom: 'js-error', environment: 'local', oracle: { type: 'generic', value: null }, pages: ['/cart/'], needs_login: false },
        verdict: { label: 'Reproduced and cause found', confidence: 'high', symptom_reproduced: 'yes' },
        hypotheses: [hyp('hyp-1', `Same hook ${XSS}`, 'REPRODUCIBLE'), hyp('hyp-2', 'Second', 'PROBABLE_NEEDS_REVIEW'), hyp('hyp-3', 'Rejected one', 'REJECTED_FALSE_POSITIVE')],
        resolution: [{ hypothesis: 'hyp-1', options: [
            { type: 'patch', who: 'send-to-claude-code', title: 'Wrap function in guard', detail: XSS, file: 'plugin-b.php', diff, verified: true, verification: [{ id: 'php-l', status: 'PASSED', reason: 'ok' }], verified_in_sandbox: true, sandbox_verification: { status: 'VERIFIED', reason: 'applied in the sandbox and the oracle passed' }, not_verified: [] },
            { type: 'shim', who: 'you-can-do-this', title: 'mu-plugin candidate', detail: 'x', file: 'pg-order.php', php: "<?php\n// <script>alert(1)</script>\nadd_action('x', 'y');\n", verified: true, verification: [], verified_in_sandbox: false, sandbox_verification: { status: 'TESTED_NO_FIX', reason: 'still failing' }, not_verified: ['NOT verified in sandbox: x'] },
            { type: 'settings', who: 'you-can-do-this', title: 'Setting: Autoptimize > Aggregate JS-files', detail: 'Untick it', setting: { id: 's', label: 'Aggregate JS-files', admin_path: 'Settings > Autoptimize', stored_key: 'autoptimize_js_aggregate', verified_against: 'Autoptimize 3.1.17' }, installed_version: '3.1.17', version_status: 'in-range', verification: [], not_verified: ['Not applied or tested in the sandbox'] },
            { type: 'plugin', who: 'needs-a-human', title: 'Deactivate Plugin A', detail: 'Would stop X', verification: [], not_verified: [] }] }, { hypothesis: 'hyp-2', options: [] }],
        validation: { checks: [], oracle: {} },
        timeline: [{ id: 'a', label: 'Logs', status: 'PASSED', reason: null }, { id: 'b', label: `Sandbox ${XSS}`, status: 'NOT_RUN', reason: 'no docker' }, { id: 'c', label: 'Probe', status: 'FAILED', reason: 'boom' }],
        sandbox: { reproduced_in_sandbox: 'yes', summary: { notice: 'The WordPress (web) container can still make RAW OUTBOUND connections.', recommendation: 'Run sandboxes only for your own copies.', limits: [] } },
        bisect: { status: 'cause-found', causes: [{ plugins: ['plugin-a', 'plugin-b'], minimal: true }], necessary: [], theme: null, loads: 5, cache_hits: 1, capped: null, executed: [], tests: [{ n: 1, hash: 'x', plugins: ['plugin-a', 'plugin-b'], theme: null, mu: null, result: 'fail', why: 'baseline' }, { n: 2, hash: 'y', plugins: [], theme: null, mu: null, result: 'pass', why: null }, { n: 3, hash: 'z', plugins: ['plugin-a'], theme: 'twentytwentyfive', mu: [], result: 'unresolved', why: XSS }] },
        probe: null,
        notices: [{ severity: 'INFO', kind: 'markup', source: 'log:x', note: 'n' }],
        reported: { description: `The cart does nothing.\n${XSS}\n`, since: '2026-10-01', changed_before: 'updated plugin B', pages: ['/cart/'], url: 'http://localhost/', images: [{ name: 'shot-1.png', kind: 'png', width: 2, height: 2, ocr_text: `Fatal error ${XSS}` }, { name: 'shot-2.png', kind: 'png', width: 2, height: 2, ocr_text: null }] },
        components: [{ ref: 'plugin-a', name: `Plugin A ${XSS}`, kind: 'plugin', version: '1.0.0', ownership: 'third-party', roles: ['provides: Cart'], in_hypotheses: ['Same hook'], evidence: ['a.php:3'] }, { ref: 'plugin-b', name: 'Plugin B', kind: 'plugin', version: '2.1', ownership: 'custom', roles: [], in_hypotheses: [], evidence: [] }],
        graph: { nodes: [{ ref: 'plugin-a', distance: 0 }, { ref: 'plugin-b', distance: 0 }, { ref: 'a-very-long-component-name', distance: 1 }, { ref: XSS, distance: 2 }], edges: [{ id: 'e1', type: 'hook-same-priority', from: 'plugin-a', to: 'plugin-b', why: 'both add to the_content at 10' }, { id: 'e2', type: 'observation:duplicate-declaration', from: 'plugin-b', to: 'a-very-long-component-name', why: 'f() twice' }, { id: 'e3', type: 'asset', from: 'plugin-a', to: XSS, why: XSS }], dropped: 2 },
        also_found: { observations: [{ id: 'o1', type: 'x', message: `elsewhere ${XSS}` }], collisions: [] },
        retests: [{ n: 1, at: 'T1', where: 'sandbox', verdict: 'Still failing', reason: 'still', fixed_verified: false, hypothesis: 'hyp-1' }, { n: 2, at: 'T2', where: 'sandbox', verdict: 'Fixed', reason: 'ok', fixed_verified: true, hypothesis: 'hyp-1' }],
        limits: ['A limit', XSS], counts: {}, finding_ids: []
    };
}

async function contrast(page) {
    return page.evaluate(() => {
        const parse = c => { const m = /rgba?\(([^)]+)\)/.exec(c); if (!m) return null; const p = m[1].split(',').map(s => parseFloat(s)); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
        const lin = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
        const L = c => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
        const over = (f, b) => ({ r: f.r * f.a + b.r * (1 - f.a), g: f.g * f.a + b.g * (1 - f.a), b: f.b * f.a + b.b * (1 - f.a), a: 1 });
        const bgOf = e => { const stack = []; for (let n = e; n; n = n.parentElement) { const c = parse(getComputedStyle(n).backgroundColor); if (c && c.a > 0) { stack.push(c); if (c.a >= 0.99) break; } } let bg = { r: 255, g: 255, b: 255, a: 1 }; if (stack.length && stack[stack.length - 1].a < 0.99) bg = parse(getComputedStyle(document.body).backgroundColor); for (const c of stack.reverse()) bg = over(c, bg); return bg; };
        const bad = [];
        const els = [...document.querySelectorAll('body *')].filter(e => ![...e.childNodes].every(n => n.nodeType !== 3 || !n.textContent.trim()) && e.getClientRects().length && !e.closest('dialog:not([open])') && !['SCRIPT', 'STYLE'].includes(e.tagName));
        for (const e of els) {
            const cs = getComputedStyle(e), fg0 = parse(e instanceof SVGElement ? cs.fill : cs.color); if (!fg0) continue;
            const circle = e instanceof SVGTextElement && e.parentElement ? e.parentElement.querySelector('circle') : null, bg = circle ? parse(getComputedStyle(circle).fill) : bgOf(e), fg = over(fg0, bg), l1 = L(fg), l2 = L(bg), ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
            const size = parseFloat(cs.fontSize), bold = parseInt(cs.fontWeight, 10) >= 700, need = size >= 24 || (size >= 18.66 && bold) ? 3 : 4.5;
            if (ratio < need) bad.push(`${e.tagName.toLowerCase()}.${(e.getAttribute('class') || '').slice(0, 20)} "${e.textContent.trim().slice(0, 25)}" ${ratio.toFixed(2)} < ${need}`);
        }
        return { checked: els.length, bad: bad.slice(0, 8), count: bad.length };
    });
}

async function run(pw, browser, dir) {
    let failures = 0;
    const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
    console.log('\n== issue.html and the Issues index');
    const data = sample();
    const images = [{ name: 'shot-1.png', uri: `data:image/png;base64,${PNG.toString('base64')}`, note: null }, { name: 'shot-2.png', uri: null, note: '900 KB is above the 300 KB embedding limit' }];
    const file = path.join(dir, 'issue.html'); fs.writeFileSync(file, html.build(data, images));
    const src = fs.readFileSync(file, 'utf8');
    ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|XMLHttpRequest|fetch\(|importScripts|WebSocket/.test(src), 'the generated page contains no innerHTML / eval / document.write / network API');
    ok(!/(src|href)=["']https?:|url\(\s*["']?https?:|@import/.test(src) && (src.match(/<script/g) || []).length === 2, 'no external resource, and exactly two script elements (data and code)');
    ok(/Content-Security-Policy[^>]*default-src 'none'/.test(src), 'a Content-Security-Policy forbids every network load');
    const ctx = await browser.newContext(); const requests = [];
    await ctx.route('**/*', r => { const u = r.request().url(); if (!u.startsWith('file://')) { requests.push(u); return r.abort(); } return r.continue(); });
    const page = await ctx.newPage(); const errors = [];
    page.on('pageerror', e => errors.push(e.message)); page.on('dialog', d => { errors.push(`dialog: ${d.message()}`); d.dismiss(); });
    await page.goto(`file://${file}`);
    ok(errors.length === 0 && requests.length === 0, `opens from file:// without script errors or network requests (${errors.join('; ') || 'none'})`);
    const heads = await page.locator('main h2').allInnerTexts();
    ok(JSON.stringify(heads) === JSON.stringify(['Verdict', 'The issue as reported', 'Involved components', 'Dependency and conflict graph for this issue', 'Investigation timeline', 'Bisect log', 'Resolution options', 'Also found, not related to this issue', 'Retest history', 'Limits']), `the sections appear top to bottom in the required order (${heads.length})`);
    const vt = await page.locator('#verdict').innerText();
    ok(/Reproduced and cause found/.test(vt) && /Confidence: high/.test(vt) && /Cause/.test(vt) && /VERIFIED IN SANDBOX/.test(vt) && /Not tested/.test(vt) && /RAW OUTBOUND/.test(vt), 'verdict card: status, confidence, cause, fix (verified in sandbox), what was not tested, and the raw-outbound sandbox limit');
    ok(await page.evaluate(() => window.__pwned === undefined) && await page.locator('img[src="x"]').count() === 0 && await page.locator('main script').count() === 0, 'hostile text (markup, script tags) in every field is displayed as text and did not execute or create elements');
    ok((await page.locator('h1').innerText()).includes('<img src=x'), 'the title shows the markup as characters');
    // screenshots
    ok(await page.locator('.thumb img').count() === 1 && /not embedded: 900 KB/.test(await page.locator('#reported').innerText()), 'the embedded screenshot is a thumbnail; the one over the limit is named with the reason');
    ok(/read by OCR \(may contain mistakes\)/i.test(await page.locator('#reported summary').first().innerText()) , 'OCR text is marked "may contain mistakes"');
    await page.locator('.thumb').focus(); await page.keyboard.press('Enter');
    ok(await page.locator('dialog').evaluate(d => d.open) && (await page.locator('dialog img').getAttribute('src')).startsWith('data:image/png'), 'a thumbnail opens the larger image (keyboard: Enter)');
    await page.keyboard.press('Escape');
    ok(!(await page.locator('dialog').evaluate(d => d.open)) && await page.evaluate(() => document.activeElement.classList.contains('thumb')), 'Escape closes it and focus returns to the thumbnail');
    // components
    ok(await page.locator('#components tbody tr').count() === 2 && /custom/.test(await page.locator('#components tbody tr').nth(1).innerText()) && await page.locator('#components th[scope=col]').count() === 5, 'components table: columns, custom / third-party shown, header cells scoped');
    // graph
    const nodes = page.locator('svg.graph g.node');
    ok(await nodes.count() === 4 && await page.locator('svg.graph line').count() === 3 && /Graph of 4 components and 3 relations/.test(await page.locator('svg.graph').getAttribute('aria-label')), 'inline SVG graph: 4 nodes, 3 edges, accessible name');
    ok(/plugin-a — hook-same-priority — plugin-b/.test(await page.locator('#graph details').innerText().catch(() => '')) || (await page.locator('#graph details li').count()) === 3, 'text alternative lists every relation');
    await nodes.first().focus(); await page.keyboard.press('Enter');
    ok(/with plugin-b/.test(await page.locator('#node-info').innerText()) && /both add to the_content/.test(await page.locator('#node-info').innerText()) && (await nodes.first().getAttribute('aria-pressed')) === 'true', 'a node (keyboard: Tab + Enter) shows why it is in the graph');
    await nodes.nth(3).click();
    ok((await page.locator('#node-info').innerText()).includes('<img src=x') && await page.evaluate(() => window.__pwned === undefined), 'a hostile component name is shown as text in the graph and in the detail panel');
    ok(await page.evaluate(() => [...document.querySelectorAll('svg.graph .node')].every(n => n.getAttribute('tabindex') === '0' && n.getAttribute('role') === 'button')), 'every graph node is keyboard-focusable and has a button role');
    // timeline, bisect, resolution
    ok(await page.locator('#timeline li').count() === 3 && /NOT_RUN/.test(await page.locator('#timeline').innerText()), 'timeline lists every step with its status and what could not run');
    ok(await page.locator('#bisect tbody tr').count() === 3 && /symptom present/.test(await page.locator('#bisect').innerText()) && /symptom absent/.test(await page.locator('#bisect').innerText()) && /could not tell/.test(await page.locator('#bisect').innerText()), 'bisect table: one row per plugin set tested, with its result');
    const res = await page.locator('#resolution').innerText();
    ok(/You can do this/.test(res) && /Send to Claude Code/.test(res) && /Needs a human/.test(res), 'options are labelled "You can do this", "Send to Claude Code", "Needs a human"');
    ok(/VERIFIED IN SANDBOX/.test(res) && /TESTED IN SANDBOX: DID NOT HELP/.test(res) && /SANDBOX VERIFIED: applied/.test(res) && /Stored key/.test(res) && /autoptimize_js_aggregate/.test(res), 'the verification result of each option is shown, including "did not help" and the setting\'s stored key');
    ok(await page.locator('pre.diff .add').count() === 1 && await page.locator('pre.diff .del').count() === 1 && (await page.locator('pre.diff .del').innerText()).startsWith('-'), 'the diff marks added and removed lines (and keeps the +/- characters, so colour is not the only cue)');
    ok(!/Rejected one/.test(res), 'a rejected hypothesis is not offered a resolution');
    ok(await page.locator('#also details').evaluate(d => !d.open) && /1 item/.test(await page.locator('#also summary').innerText()), '"Also found" is collapsed by default');
    ok(await page.locator('#retests tbody tr').count() === 2 && /Fixed/.test(await page.locator('#retests').innerText()), 'retest history lists each attempt');
    // layout, scheme, contrast
    await page.setViewportSize({ width: 375, height: 700 });
    ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no horizontal scrolling at 375px width');
    ok(await page.evaluate(() => [...document.querySelectorAll('pre.diff, pre.code, .scroll')].every(e => e.scrollWidth <= e.clientWidth || getComputedStyle(e).overflowX === 'auto')), 'wide tables and diffs scroll inside their own box at 375px');
    for (const scheme of ['light', 'dark']) {
        await page.emulateMedia({ colorScheme: scheme }); await page.setViewportSize({ width: 1000, height: 800 });
        const c = await contrast(page);
        ok(c.count === 0 && c.checked > 100, `colour contrast (WCAG AA) in the ${scheme} scheme: ${c.checked} text elements checked, ${c.count} below the limit${c.bad.length ? ': ' + c.bad.join(' | ') : ''}`);
    }
    ok(errors.length === 0 && requests.length === 0, 'still no script error and no network request after all interactions');
    // empty and minimal data
    const min = sample(); Object.assign(min, { hypotheses: [], resolution: [], bisect: null, sandbox: null, notices: [], components: [], graph: { nodes: [], edges: [], dropped: 0 }, timeline: [], retests: [], reported: { ...min.reported, images: [] }, verdict: { label: 'Could not test', confidence: 'none', symptom_reproduced: 'not-tested' }, also_found: { observations: [], collisions: [] } });
    const f2 = path.join(dir, 'issue-empty.html'); fs.writeFileSync(f2, html.build(min, [])); await page.goto(`file://${f2}`);
    ok(await page.locator('.empty').count() >= 5 && /Could not test/.test(await page.locator('#verdict').innerText()) && errors.length === 0, 'an issue with nothing found renders explicit empty states, not blank sections');

    // two unverified candidate orders: the Fix line must not name one of them as the answer
    const cand = sample(); cand.resolution = [{ hypothesis: 'hyp-1', options: ['A after B', 'B after A'].map((c, i) => ({ type: 'shim', who: 'you-can-do-this', title: `mu-plugin candidate ${i + 1}: ${c}`, detail: 'TEST TO CHOOSE', file: `pg-${i}.php`, php: '<?php\n', candidate: c, test_to_choose: true, verified: true, verified_in_sandbox: null, verification: [], not_verified: ['TEST TO CHOOSE'] })) }];
    const f3 = path.join(dir, 'issue-cand.html'); fs.writeFileSync(f3, html.build(cand, [])); await page.goto(`file://${f3}`);
    const vtc = await page.locator('#verdict').innerText();
    ok(/Not decided: 2 candidate shim orders, test to choose \(A after B \| B after A\)/.test(vtc) && !/VERIFIED IN SANDBOX/.test(vtc) && (await page.locator('#resolution').innerText()).match(/TEST TO CHOOSE/g).length >= 2, 'two unverified candidate shim orders: the Fix line says "Not decided ... test to choose" and lists both, and each option carries a TEST TO CHOOSE tag');
    const nopl = sample(); nopl.verdict = { ...nopl.verdict, notes: ['NOT A PLUGIN CONFLICT: the symptom is still present with every plugin switched off.'] }; nopl.bisect = { ...nopl.bisect, symptom_without_plugins: true };
    const f4 = path.join(dir, 'issue-nopl.html'); fs.writeFileSync(f4, html.build(nopl, [])); await page.goto(`file://${f4}`);
    ok((await page.locator('#verdict').innerText()).includes('NOT A PLUGIN CONFLICT') && (await page.locator('#bisect').innerText()).includes('NOT A PLUGIN CONFLICT'), 'the page states "NOT A PLUGIN CONFLICT" in the verdict card and again in the bisect section');
    const c3 = await contrast(page); ok(c3.count === 0, `colour contrast with the new note (${c3.count} below the limit)`);

    // ---- the Issues index
    const list = [{ id: 'iss-20261028-100000-abcdef', title: `Cart ${XSS}`, symptom: 'js-error', environment: 'local', created_at: '2026-10-28T10:00:00Z', verdict: 'Fixed and verified', top_status: 'FIXED_VERIFIED', retests: 2, last_retest: 'Fixed', has_report: true }, { id: 'iss-20261027-090000-123456', title: 'Slider', symptom: 'layout', environment: 'staging', created_at: '2026-10-27T09:00:00Z', verdict: null, top_status: null, retests: 0, last_retest: null, has_report: false }];
    const fi = path.join(dir, 'index.html'); fs.writeFileSync(fi, html.buildIndex(list));
    await page.goto(`file://${fi}`); await page.setViewportSize({ width: 1000, height: 800 });
    ok(await page.locator('#rows tr').count() === 2 && /Showing 2 of 2/.test(await page.locator('#count').innerText()), 'index: one row per issue');
    ok(await page.locator('#rows a').count() === 1 && (await page.locator('#rows a').getAttribute('href')) === 'iss-20261028-100000-abcdef/result/issue.html', 'index: only an investigated issue links to its report, with a relative path');
    ok((await page.locator('#rows tr').nth(1).innerText()).includes('Not investigated yet') && (await page.locator('#rows').innerText()).includes('<img src=x') && await page.evaluate(() => window.__pwned === undefined), 'index: un-investigated issues say so; hostile titles are shown as text');
    await page.fill('#q', 'slider'); ok(await page.locator('#rows tr').count() === 1 && /Showing 1 of 2/.test(await page.locator('#count').innerText()), 'index: search narrows the list and announces the count');
    await page.fill('#q', 'nomatch'); ok(/No issue matches/.test(await page.locator('#rows').innerText()), 'index: empty search result is explained');
    await page.fill('#q', ''); await page.setViewportSize({ width: 375, height: 700 });
    ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1) && await page.locator('#q').evaluate(e => !!e.labels.length), 'index: no horizontal scrolling at 375px; the search box has a label');
    for (const scheme of ['light', 'dark']) { await page.emulateMedia({ colorScheme: scheme }); await page.setViewportSize({ width: 1000, height: 800 }); const c = await contrast(page); ok(c.count === 0, `index: colour contrast in the ${scheme} scheme (${c.checked} elements, ${c.count} below the limit${c.bad.length ? ': ' + c.bad.join(' | ') : ''})`); }
    const idxSrc = fs.readFileSync(fi, 'utf8'); ok(!/innerHTML|eval\(|fetch\(|https?:\/\//.test(idxSrc.replace(/https?:\/\/(?=['"])/g, '')), 'index: no innerHTML, eval, network API or external URL');
    // the client files themselves
    for (const f of ['issue-html-client.js', 'issue-index-client.js', 'issue-html.js']) ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(/.test(fs.readFileSync(path.join(__dirname, '..', 'lib', f), 'utf8').replace(/\/\/.*$/gm, '')), `lib/${f}: no innerHTML / eval / document.write in the source`);
    await ctx.close();
    return failures;
}
module.exports = { run, sample, PNG, contrast };
