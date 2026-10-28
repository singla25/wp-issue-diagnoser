#!/usr/bin/env node
// Live page probe worker. Runs as its OWN process because the frontend's governor binds to the site at load time (TEST_URL).
// Everything that touches the site goes through src/frontend/lib/governor.js: every navigation (pacing, concurrency cap, 429 / 403 / WAF
// challenge detection, persisted state) and the single "is the original public" GET. READ-ONLY by construction:
//   - non-GET requests made by the page are aborted (installReadOnlyGuard) and counted;
//   - nothing is clicked, typed, hovered or submitted; no cookie, login or consent is touched;
//   - the first 429 or challenge ends the probe (STOP_AFTER_429=1, no retry); the cooldown is recorded and honoured by the next run.
// SANDBOX MODE (job.sandbox): the target is a throwaway copy on 127.0.0.1. Only there may the page be clicked and a test user logged in; every request to any
// other origin is aborted, and the same governor paces everything. Credentials come from the environment (PG_TEST_USER / PG_TEST_PASSWORD), never from files.
// Input: a job JSON file (argv[2]). Output: the result JSON file named in the job. Text from the site is data: it is cut and never executed.

const fs = require('fs');
const path = require('path');

const jobFile = process.argv[2];
const job = JSON.parse(fs.readFileSync(jobFile, 'utf8'));
process.env.TEST_URL = job.base;
process.env.QA_REPORTS_DIR = job.stateRoot;
process.env.QA_LIVE_QUIET = '1';
process.env.STOP_AFTER_429 = '1';
// The governor counts each 5xx twice (the navigation and the browser's own observation of the response), so one broken page plus its single
// retry scores 4. The default limit of 3 would end every probe of a white-screen page at once. 5 is the most the frontend's own config allows:
// one broken page can be observed, a second one stops the probe as "server instability". A lower value set by the user is kept.
process.env.STOP_AFTER_5XX = process.env.STOP_AFTER_5XX || '5';
const FRONT = job.frontendDir;
const fe = m => require(path.join(FRONT, m));

// Layout checks compare elements with each other (overlap checks are quadratic), so a very large page could keep the probe busy for minutes.
// Two limits, both visible in the result: pages above MAX_ELEMENTS skip the heavy checks, and each page load gets a time budget.
const LAYOUT_MAX_ELEMENTS = Number(process.env.PG_LAYOUT_MAX_ELEMENTS) || 6000;
const LAYOUT_BUDGET_MS = Number(process.env.PG_LAYOUT_BUDGET_MS) || 20000;
const out = { schema: 1, base: job.base, planned: job.pages.length * job.viewports.length, pages: [], protection: null, unreachable: null, error: null, public_check: null, image_diff: null, layout_notes: [], governor: null };
const save = () => fs.writeFileSync(job.out, JSON.stringify(out));
const cut = (s, n = 300) => String(s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, n);

(async () => {
    const config = fe('qa.config');
    config.cooldownFile = job.cooldownFile;
    config.liveFrames = false;
    const governor = fe('lib/governor');
    const { NetworkRecorder, installReadOnlyGuard, applyDenyList } = fe('lib/network');
    const { INIT_SCRIPT, pageContext, assetSource } = fe('lib/wp-context');
    const { readJsonl, files } = fe('lib/findings');
    const visual = fe('lib/visual-checks');
    const pageChecks = fe('lib/page-checks');
    const collide = require('./collide');
    const imgdiff = require('./imgdiff');
    const { chromium, request } = require(path.join(FRONT, 'node_modules', '@playwright', 'test'));

    governor.resetState();
    fs.mkdirSync(config.screenshotsDir, { recursive: true });

    // ---- cooldown: a previous run (frontend agent or probe) was limited by site protection -> not one request ----
    try {
        const all = JSON.parse(fs.readFileSync(config.cooldownFile, 'utf8'));
        const last = all.at ? all : all[config.origin];
        if (last) {
            const until = new Date(last.at).getTime() + config.protectionCooldownMinutes * 60000;
            if (Date.now() < until) { out.protection = { kind: 'cooldown', reason: `cooling down after site protection at ${last.at} (${last.reason}); next run allowed after ${new Date(until).toISOString()}`, requests_sent: 0 }; save(); return; }
        }
    } catch { /* no cooldown file */ }

    const browser = await chromium.launch();
    const ua = await (async () => { const c = await browser.newContext(); const p = await c.newPage(); const u = await p.evaluate(() => navigator.userAgent); await c.close(); return `${u} ${config.userAgentSuffix}`; })();
    const stopReasonNow = () => (governor.isStopped() ? governor.stopReason() : null);
    const sourceOf = url => { const s = assetSource(url); return s.type === 'plugin' ? { type: 'plugin', ref: `plugin:${s.name}`, name: s.name } : s.type === 'theme' ? { type: 'theme', ref: `theme:${s.name}`, name: s.name } : s.type === 'core' ? { type: 'core', ref: 'wordpress-core', name: 'WordPress core' } : { type: s.type, ref: null, name: s.name }; };
    const urlIn = text => (/https?:\/\/[^\s)'"]+/.exec(text || '') || [])[0] || null;
    const slug = s => String(s).replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 40);

    let stopAll = false, pageIndex = 0;
    const answered5xx = new Map(); // a page that answered 5xx is not loaded again at other screen sizes: no new information, more load on a broken server
    const expected = job.expected ? { ...job.expected, buf: fs.readFileSync(job.expected.file) } : null;

    for (const vp of job.viewports) {
        if (stopAll) break;
        const mobile = vp.width <= 480;
        const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: mobile, hasTouch: mobile, userAgent: ua, reducedMotion: 'reduce', serviceWorkers: 'block' });
        let blocked;
        if (job.sandbox) {   // the sandbox may be written to and clicked; nothing outside it may be reached
            blocked = [];
            const origin = new URL(job.base).origin;
            await context.route('**/*', route => { const r = route.request(); if (new URL(r.url()).origin === origin || r.url().startsWith('data:') || r.url().startsWith('blob:')) return route.continue(); blocked.push({ method: r.method(), url: r.url().split('?')[0] }); return route.abort('blockedbyclient'); });
        } else blocked = await installReadOnlyGuard(context);
        await context.addInitScript(INIT_SCRIPT);
        const page = await context.newPage();
        const recorder = new NetworkRecorder(page);
        if (job.sandbox && job.login && process.env.PG_TEST_USER && process.env.PG_TEST_PASSWORD) {
            try {
                await governor.navigate(page, new URL('wp-login.php', job.base).href, { waitUntil: 'load', settleMs: 300 });
                await page.fill('#user_login', process.env.PG_TEST_USER); await page.fill('#user_pass', process.env.PG_TEST_PASSWORD);
                await Promise.all([page.waitForNavigation({ waitUntil: 'load', timeout: 20000 }).catch(() => {}), page.click('#wp-submit')]);
                const cookies = await context.cookies();
                out.login = { attempted: true, ok: cookies.some(c => /^wordpress_logged_in/.test(c.name)) };
            } catch (e) { out.login = { attempted: true, ok: false, error: cut(e.message, 120) }; }
        }
        let blockedSeen = 0, findingsSeen = readJsonl(files.FINDINGS_FILE).length;
        for (const url of job.pages) {
            if (stopAll) break;
            const rec = { url, viewport: { name: vp.name, width: vp.width, height: vp.height }, loaded: false, status: 0 };
            out.pages.push(rec);
            if (answered5xx.has(url)) { rec.skipped = `answered HTTP ${answered5xx.get(url).status} at ${answered5xx.get(url).vp}; not requested again at another screen size`; rec.reused_status = answered5xx.get(url).status; out.planned -= 1; pageIndex++; continue; }
            try {
                await applyDenyList(page);
                recorder.reset();
                const nav = await governor.navigate(page, url, { waitUntil: 'load', settleMs: 1500 });
                Object.assign(rec, { loaded: nav.status > 0, status: nav.status, first_status: nav.firstStatus, retried: !!nav.retried, outcome: nav.outcome, title: cut(nav.title, 160), final_url: page.url() });
                const chain = []; for (let r = nav.response && nav.response.request().redirectedFrom(); r; r = r.redirectedFrom()) chain.unshift(r.url());
                rec.redirects = [...chain, page.url()].length > 1 ? [...chain, page.url()] : [];
                if (nav.status === 0) { rec.error = cut(nav.error, 200); continue; }
                if (nav.status >= 500) answered5xx.set(url, { status: nav.status, vp: vp.name });

                rec.console_errors = recorder.meaningfulConsoleErrors().slice(0, 20).map(e => ({ text: cut(e.text), url: e.url || '', source: e.url ? sourceOf(e.url) : null }));
                rec.page_errors = recorder.pageErrors.slice(0, 20).map(e => { const u = urlIn(e.stack); return { text: cut(e.text), stack: cut(e.stack, 400), url: u, source: u ? sourceOf(u) : null }; });
                rec.failed_requests = recorder.failed.filter(f => !f.benign).slice(0, 30).map(f => ({ url: f.url, type: f.type, errorText: cut(f.errorText, 80), source: sourceOf(f.url) }));
                rec.error_responses = recorder.errorResponses().slice(0, 40).map(r => ({ url: r.url, status: r.status, type: r.type, same_site: governor.isTargetHost ? governor.isTargetHost(r.url) : new URL(r.url).origin === config.origin, source: sourceOf(r.url) }));
                const assets = recorder.responses.filter(r => ['script', 'stylesheet'].includes(r.type)).slice(0, 120).map(r => ({ url: r.url, status: r.status, type: r.type, source: sourceOf(r.url), library: collide.libOf(r.url, '') }));
                rec.assets = assets;
                const byLib = new Map();
                for (const a of assets) if (a.library && a.status < 400) { const k = a.library.id; if (!byLib.has(k)) byLib.set(k, []); byLib.get(k).push(a); }
                rec.duplicate_libraries = [...byLib].map(([id, list]) => ({ id, list: list.filter((a, i) => list.findIndex(b => new URL(b.url).pathname === new URL(a.url).pathname) === i) })).filter(x => x.list.length > 1).map(x => ({ library: x.id, urls: x.list.map(a => a.url), versions: [...new Set(x.list.map(a => a.library.version).filter(Boolean))], components: [...new Set(x.list.map(a => a.source.ref).filter(Boolean))] }));
                rec.runtime = await page.evaluate(() => ({ jquery: window.jQuery && window.jQuery.fn ? window.jQuery.fn.jquery : null, dollar_is_jquery: typeof window.$ !== 'undefined' && window.$ === window.jQuery })).catch(() => null);
                rec.scroll = await page.evaluate(() => ({ doc_width: Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0), viewport_width: document.documentElement.clientWidth }));
                rec.text = cut(await page.evaluate(() => (document.body ? document.body.innerText : '')), 200000);
                rec.lcp = await page.evaluate(() => (window.__qaPerf && typeof window.__qaPerf.lcp === 'number' ? Math.round(window.__qaPerf.lcp) : null)).catch(() => null);
                rec.measure = {};
                for (const sel of job.measure || []) rec.measure[sel] = await page.evaluate(s => { try { const el = document.querySelector(s); if (!el) return { found: false }; const b = el.getBoundingClientRect(), st = getComputedStyle(el); return { found: true, visible: b.width > 0 && b.height > 0 && st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) > 0.05, width: Math.round(b.width) }; } catch { return { found: false, error: 'invalid selector' }; } }, sel);
                if (job.sandbox && job.click) {
                    const snap = sel => page.evaluate(q => { try { const e = document.querySelector(q); if (!e) return { found: false }; const b = e.getBoundingClientRect(), st = getComputedStyle(e); return { found: true, visible: b.width > 0 && b.height > 0 && st.display !== 'none' && st.visibility !== 'hidden', text: (e.innerText || '').slice(0, 300), html: e.outerHTML.slice(0, 3000), cls: e.className && String(e.className) }; } catch { return { found: false }; } }, sel);
                    const before = await snap(job.click.to), from = await snap(job.click.from);
                    rec.click = { from: job.click.from, to: job.click.to, clicked: false, changed: false };
                    if (!from.found || !before.found) rec.click.error = !from.found ? 'the element to click was not found' : 'the element that should change was not found';
                    else { try { await page.click(job.click.from, { timeout: 5000 }); rec.click.clicked = true; await page.waitForTimeout(1500); const after = await snap(job.click.to); rec.click.changed = JSON.stringify(before) !== JSON.stringify(after); } catch (e) { rec.click.error = cut(e.message, 120); } }
                }
                const wp = await pageContext(page).catch(() => null);
                rec.context = wp ? { post_id: wp.postId, post_type: wp.postType, template: wp.template, builders: wp.builders, plugins: wp.plugins, themes: wp.themes } : null;
                rec.blocked_non_get = blocked.slice(blockedSeen).map(b => ({ method: b.method, url: b.url })); blockedSeen = blocked.length;

                const shot = path.join(config.screenshotsDir, `p${String(pageIndex).padStart(2, '0')}-${slug(vp.name)}.png`);
                await page.screenshot({ path: shot, fullPage: false });
                rec.screenshot = shot;

                // ---- the frontend agent's own layout checks (overflow, overlap, clipped text, squeezed columns): they only read the DOM ----
                if (job.layout !== false) {
                    const elements = await page.evaluate(() => document.getElementsByTagName('*').length).catch(() => 0);
                    rec.elements = elements;
                    if (elements > LAYOUT_MAX_ELEMENTS) {
                        rec.layout_status = `skipped: the page has ${elements} elements (cap ${LAYOUT_MAX_ELEMENTS}); the horizontal-scroll measurement above still ran`;
                        out.layout_notes.push(`layout checks skipped on ${url} at ${vp.name}: ${elements} elements (cap ${LAYOUT_MAX_ELEMENTS})`);
                    } else {
                        const opts = { url, viewport: `${vp.name} ${vp.width}x${vp.height}`, viewportName: vp.name, ctx: wp || {}, vw: vp.width };
                        const deadline = Date.now() + LAYOUT_BUDGET_MS;
                        let cut_short = null;
                        const run = async (name, fn) => {
                            if (cut_short) return;
                            const left = deadline - Date.now();
                            if (left <= 0) { cut_short = `before ${name}`; return; }
                            let timer;
                            try { await Promise.race([fn(), new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error('budget'), { budget: true })), left); })]); }
                            catch (e) { if (e.budget) cut_short = `during ${name}`; else out.layout_notes.push(`${name} failed on ${url} at ${vp.name}: ${cut(e.message, 120)}`); }
                            finally { clearTimeout(timer); }
                        };
                        await run('checkLayout', () => pageChecks.checkLayout(page, opts));
                        let groups = []; await run('groups', async () => { groups = await visual.collectGroupIssues(page); });
                        await run('overflow', () => visual.checkOverflowExtras(page, opts, groups));
                        await run('responsive', () => visual.checkResponsiveExtras(page, opts));
                        await run('images', () => visual.checkImagesVisual(page, opts));
                        rec.layout_status = cut_short ? `cut short ${cut_short}: the ${LAYOUT_BUDGET_MS} ms budget for this page load ran out` : 'ran';
                        if (cut_short) out.layout_notes.push(`layout checks cut short ${cut_short} on ${url} at ${vp.name} (budget ${LAYOUT_BUDGET_MS} ms)`);
                    }
                    const all = readJsonl(files.FINDINGS_FILE);
                    rec.layout = all.slice(findingsSeen).map(f => ({ title: cut(f.title, 140), category: f.category, severity: f.severity, status: f.status, actual: cut(f.actual, 240), near: f.near || null, selector: f.fix && f.fix.element || null, where: f.fix && f.fix.where ? cut(f.fix.where, 200) : null, screenshot: f.evidence && f.evidence.screenshot || null }));
                    findingsSeen = all.length;
                }

                // ---- screenshot comparison against the reporter's "expected" image, same screen width, regions mapped to page elements ----
                if (expected && !out.image_diff && vp.width === expected.width && pageIndex === (expected.page_index || 0)) {
                    const cmp = await imgdiff.compare(expected.buf, fs.readFileSync(shot));
                    if (!cmp.ok) out.image_diff = { ok: false, reason: cmp.reason, expected: expected.name };
                    else {
                        const diffFile = path.join(config.screenshotsDir, `diff-${slug(expected.name)}.png`);
                        fs.writeFileSync(diffFile, cmp.diff_png);
                        const regions = await page.evaluate(rs => rs.map(r => {
                            const el = document.elementFromPoint(r.center.x, r.center.y);
                            if (!el) return { ...r, element: null };
                            const loc = window.__qaLocate ? window.__qaLocate(el) : null;
                            return { ...r, element: { tag: el.tagName.toLowerCase(), id: el.id || null, classes: [...el.classList].slice(0, 4), text: (el.innerText || '').trim().slice(0, 40), selector: loc && loc.selector || null, builder: loc && loc.builder || null, heading: loc && loc.heading || null } };
                        }), cmp.regions).catch(() => cmp.regions);
                        out.image_diff = { ok: true, expected: expected.name, actual: `probe screenshot of ${url} at ${vp.name} ${vp.width}px`, page: url, viewport: vp.name, size: cmp.size, size_mismatch: cmp.size_mismatch, diff_pixels: cmp.diff_pixels, diff_percent: cmp.diff_percent, regions, diff_image: diffFile };
                    }
                }
            } catch (e) {
                if (e.name === 'ProtectionStop' || e.name === 'TestStopped') { out.protection = { kind: e.name, reason: e.reason, page: url, viewport: vp.name }; stopAll = true; }
                else if (e.name === 'SiteUnreachable') { out.unreachable = cut(e.message, 300); stopAll = true; }
                else rec.error = cut(e.message, 200);
            }
            const stopped = stopReasonNow();
            if (!out.protection && stopped) { out.protection = { kind: 'breaker', reason: stopped, page: url, viewport: vp.name }; stopAll = true; }
            pageIndex++;
            save();
        }
        await context.close();
    }
    out.pages = out.pages.filter(p => p.url);

    // ---- "is the original public": ONE paced, governed GET ----
    if (job.publicCheck && !stopAll) {
        const api = await request.newContext({ extraHTTPHeaders: { 'User-Agent': `Mozilla/5.0 (compatible; ${config.userAgentSuffix})` } });
        try {
            const r = await governor.request(api, job.publicCheck.url, { method: 'GET', maxRedirects: 0 });
            const ct = String(r.headers['content-type'] || '');
            out.public_check = { url: job.publicCheck.url, status: r.status, content_type: ct.split(';')[0], outcome: r.outcome, public: r.status === 200 && /^(image\/|application\/pdf)/i.test(ct), answered_with_page: r.status === 200 && /text\/html/i.test(ct) };
        } catch (e) {
            if (e.name === 'ProtectionStop' || e.name === 'TestStopped') out.protection = { kind: e.name, reason: e.reason, page: job.publicCheck.url, viewport: null };
            else out.public_check = { url: job.publicCheck.url, error: cut(e.message, 200), public: null };
        } finally { await api.dispose(); }
    } else if (job.publicCheck) out.public_check = { url: job.publicCheck.url, skipped: out.protection ? 'the probe was stopped by the site\'s protection before this request' : 'the probe stopped early', public: null };

    await browser.close();
    const st = governor.snapshot();
    out.governor = { requests_made: st.requestsMade, ok_responses: st.okResponses, status_429: st.status429, status_403: st.status403, status_5xx: st.status5xx, challenges: st.challenges || 0, stopped: !!st.stopped, stop_reason: st.stopReason || null, navigation_delay_ms: config.navigationDelayMs, request_delay_ms: config.requestDelayMs };

    // remember a protection event so the next run (probe or frontend agent) cools down before sending any request
    if (st.stopped && !/^Cooling down/.test(st.stopReason || '')) {
        let cd = {}; try { cd = JSON.parse(fs.readFileSync(config.cooldownFile, 'utf8')); } catch { /* none yet */ }
        if (cd.at) cd = {};
        cd[config.origin] = { at: new Date().toISOString(), reason: st.stopReason };
        fs.mkdirSync(path.dirname(config.cooldownFile), { recursive: true });
        fs.writeFileSync(config.cooldownFile, JSON.stringify(cd, null, 2));
    }
    save();
})().catch(e => { out.error = cut(e && e.stack || e, 600); save(); process.exit(0); });
