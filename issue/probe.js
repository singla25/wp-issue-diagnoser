// Phase B4 + B5: the live page probe, the oracle, the "is the original public" check and the screenshot comparison.
//
// Read-only on the site, always. The browser work happens in probe/worker.js (a separate process); every request it makes goes through
// the probe's own request safety layer (probe/safety.js: pacing, concurrency 1, 429 / 403 / WAF-challenge detection, persisted state, cooldown file).
// Nothing is clicked, typed or submitted; non-GET requests made by the page are aborted. The first 429 or challenge ends the probe.
// The probe runs only for a site the reporter named AND stated the environment of (live needs --authorized; see lib/issue-store.js).
// A live probe never logs in: problems that need a logged-in user are "could not test" until the sandbox (a later step).

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const store = require('../lib/issue-store');
const redact = require('../lib/redact');
const schema = require('../lib/schema');
const oracleMod = require('./oracle');
const imgdiff = require('./imgdiff');
const ownership = require('../lib/ownership');

const WORKER = path.join(__dirname, '..', 'probe', 'worker.js');
const VIEWPORTS = { desktop: [1440, 900], laptop: [1280, 800], tablet: [768, 1024], mobile: [390, 844], 'small-mobile': [375, 812] };
const DEFAULTS = { probePages: 3, viewports: ['laptop', 'mobile'], maxLoads: 8, timeoutMs: 10 * 60 * 1000 };
const STRIP_ENV = /^(PSI_API_KEY|WPSCAN_API_TOKEN|PG_TEST_.*)$/;
const cooldownFile = env => env.PG_PROBE_COOLDOWN_FILE || path.join(__dirname, '..', 'state', 'probe-cooldown.json');
const cut = (s, n = 200) => redact.text(String(s ?? '').replace(/\s+/g, ' ').trim()).slice(0, n);
const step = (id, label, status, reason = null, extra = {}) => ({ ...extra, id, label, status, reason }); // the fixed fields win: an extra field can never overwrite the status

// The probe's own browser: plugin-guard's Playwright and Chromium (lib/playwright.js), never another module's.
function browserReady() {
    const st = require('../lib/playwright').status();
    return st.ok ? { ok: true } : { ok: false, reason: st.reason };
}

// debug.log of the LOCAL copy: size now, and later the bytes added since. Read-only, never through a symlink, never outside the root.
function logMark(root) {
    if (!root) return { available: false, reason: 'no local WordPress copy was given (--root), so debug.log cannot be read' };
    const r = ownership.resolveInside(root, 'wp-content/debug.log');
    if (!r.ok || r.symlink) return { available: false, reason: r.ok ? 'debug.log is a symbolic link and is not read' : r.reason };
    let size = 0, exists = fs.existsSync(r.abs);
    if (exists) { try { size = fs.statSync(r.abs).size; } catch { exists = false; } }
    return { available: true, abs: r.abs, size, exists };
}
function logGrowth(mark) {
    if (!mark.available) return mark;
    let st; try { st = fs.statSync(mark.abs); } catch { return { available: false, reason: 'wp-content/debug.log does not exist (WP_DEBUG_LOG may be off); missing data is not "clean"' }; }
    if (!mark.exists && st.size === 0) return { available: false, reason: 'wp-content/debug.log is empty and did not exist before (WP_DEBUG_LOG may be off); missing data is not "clean"' };
    const from = Math.min(mark.size, st.size), len = Math.min(st.size - from, 256 * 1024), fd = fs.openSync(mark.abs, 'r');
    try { const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, from); return { available: true, new_bytes: st.size - from, new_text: redact.text(b.toString('utf8')) }; } finally { fs.closeSync(fd); }
}

function plan(issue, options, images) {
    const notes = [];
    const base = new URL(issue.url); if (!base.pathname.endsWith('/')) base.pathname += '/';
    const pages = [];
    for (const p of issue.pages.length ? issue.pages : ['/']) {
        let u; try { u = new URL(p, base); if (/^\//.test(p) && !p.startsWith('//')) u = new URL(p.replace(/^\//, ''), base); } catch { continue; }
        if (u.origin !== base.origin) { notes.push(`not probed: ${u.origin} is a different site than ${base.origin}`); continue; }
        u.hash = ''; if (!pages.includes(u.href)) pages.push(u.href);
    }
    const maxPages = Math.max(1, Math.min(Number(options.probePages) || DEFAULTS.probePages, 10));
    if (pages.length > maxPages) { notes.push(`only the first ${maxPages} of ${pages.length} pages are probed (--probe-pages)`); pages.length = maxPages; }
    const wanted = (options.viewports ? String(options.viewports).split(',') : DEFAULTS.viewports).map(s => s.trim()).filter(n => VIEWPORTS[n]);
    const vps = wanted.map(n => ({ name: n, width: VIEWPORTS[n][0], height: VIEWPORTS[n][1] }));
    const extra = [];
    if (issue.oracle.type === 'no-hscroll') { const w = Number(issue.oracle.value); if (w >= 280 && w <= 3000 && !vps.some(v => v.width === w)) extra.push({ name: `width-${w}`, width: w, height: 800 }); }
    const exp = imgdiff.pairs(images).concat(images.filter(m => imgdiff.roleOf(m.name) === 'expected' && !imgdiff.pairs(images).some(p => p.expected.name === m.name)).map(m => ({ expected: m, actual: null })))[0];
    let expected = null;
    if (exp && exp.expected) {
        const d = exp.expected.width ? exp.expected : null;
        const dim = store.dimensions(fs.readFileSync(path.join(store.dirOf(issue.id), 'images', exp.expected.name)), exp.expected.kind);
        if (dim && dim.w >= 320 && dim.w <= 2560) { expected = { name: exp.expected.name, file: path.join(store.dirOf(issue.id), 'images', exp.expected.name), width: dim.w, page_index: 0 }; if (!vps.concat(extra).some(v => v.width === dim.w)) extra.push({ name: `expected-${dim.w}`, width: dim.w, height: Math.min(dim.h, 1600) }); }
        else notes.push(`the expected image ${exp.expected.name} is ${dim ? dim.w + 'px' : 'of unknown'} wide: outside 320-2560px, so it is not compared with a live page`);
    }
    let viewports = [...vps, ...extra];
    const maxLoads = Math.max(1, Number(options.maxLoads) || DEFAULTS.maxLoads);
    while (viewports.length > 1 && pages.length * viewports.length > maxLoads) { const drop = viewports.findIndex(v => !extra.includes(v)); if (drop < 0 || viewports.filter(v => !extra.includes(v)).length <= 1) break; notes.push(`viewport ${viewports[drop].name} dropped: the probe is limited to ${maxLoads} page loads`); viewports.splice(drop, 1); }
    if (pages.length * viewports.length > maxLoads) { pages.length = Math.max(1, Math.floor(maxLoads / viewports.length)); notes.push(`pages cut to ${pages.length} to stay within ${maxLoads} page loads`); }
    return { base: base.href, pages, viewports, expected, notes, planned: pages.length * viewports.length };
}

function runWorker(job, env, timeoutMs) {
    return new Promise(resolve => {
        const childEnv = Object.fromEntries(Object.entries(env).filter(([k]) => !STRIP_ENV.test(k)));
        const child = spawn(process.execPath, [WORKER, job.file], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
        let err = '', killed = false;
        child.stderr.on('data', d => { err = (err + d).slice(-2000); });
        child.stdout.on('data', () => {});
        const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, timeoutMs);
        child.on('close', code => { clearTimeout(timer); resolve({ code, killed, err }); });
        child.on('error', e => { clearTimeout(timer); resolve({ code: -1, killed, err: e.message }); });
    });
}

// observations for the oracle, with defaults so a page that failed to load never breaks it
const norm = p => ({ console_errors: [], page_errors: [], error_responses: [], failed_requests: [], ...p });

function cluesFrom(pages) {
    const out = [], seen = new Map();
    const add = (type, value, ref, detail, snippet, p) => {
        const key = `${type}|${value}|${ref}`;
        if (seen.has(key)) { const c = seen.get(key); if (!c.detail.viewports.includes(p.viewport.name)) c.detail.viewports.push(p.viewport.name); return; }
        const c = { id: schema.stableId('clue', type, value, ref, 'probe'), type, value: cut(value, 200), detail: { ...detail, viewports: [p.viewport.name] }, source: { kind: 'probe', ref, line: null }, confidence: 'certain', snippet: cut(snippet || value, 220) };
        seen.set(key, c); out.push(c);
    };
    const comp = (ref, p, why) => { if (ref && ref !== 'wordpress-core') add('component-path', ref, p.url, { why }, `observed on the live page: ${why}`, p); };
    for (const p of pages.filter(x => x.loaded)) {
        const where = new URL(p.url).pathname;
        if (p.status >= 400) add('probe-http-status', `HTTP ${p.status} ${where}`, p.url, { status: p.status, retried: !!p.retried, first_status: p.first_status }, `the page answered HTTP ${p.status}`, p);
        for (const e of p.console_errors) { add('probe-console-error', e.text, p.url, { script: e.url || null, component: e.source && e.source.ref, source_name: e.source && e.source.name }, e.text, p); comp(e.source && e.source.ref, p, `a console error came from ${e.url}`); }
        for (const e of p.page_errors) { add('probe-page-error', e.text, p.url, { script: e.url || null, component: e.source && e.source.ref, source_name: e.source && e.source.name, stack: cut(e.stack, 300) }, e.text, p); comp(e.source && e.source.ref, p, `an uncaught error came from ${e.url}`); }
        for (const r of p.error_responses.filter(x => x.same_site && ['script', 'stylesheet', 'image', 'font', 'xhr', 'fetch'].includes(x.type))) { add('probe-failed-asset', `HTTP ${r.status} ${new URL(r.url).pathname}`, p.url, { status: r.status, type: r.type, url: r.url, component: r.source && r.source.ref, source_name: r.source && r.source.name }, `${r.type} ${r.url} answered ${r.status}`, p); comp(r.source && r.source.ref, p, `${r.url} answered ${r.status}`); }
        for (const d of p.duplicate_libraries || []) add('probe-duplicate-library', `${d.library} loaded ${d.urls.length} times`, p.url, { library: d.library, urls: d.urls.map(u => new URL(u).pathname), versions: d.versions, components: d.components }, `${d.library}: ${d.urls.join(', ')}`, p);
        for (const l of p.layout || []) add('probe-layout', `${l.title}${l.near ? ` near "${l.near}"` : ''}`, p.url, { severity: l.severity, status: l.status, selector: l.selector, where: l.where, actual: l.actual }, l.actual, p);
        for (const b of p.blocked_non_get || []) add('probe-blocked-write', `${b.method} ${new URL(b.url, p.url).pathname}`, p.url, { method: b.method }, `the page tried to send ${b.method} ${b.url}; the read-only guard aborted it`, p);
    }
    return out;
}

async function run(id, { root = null, options = {}, env = process.env, imageFiles = null } = {}) {
    const issue = store.load(id), dir = store.dirOf(id);
    const steps = [], clues = [];
    const images = issue.images || [];
    const result = { schema: 1, issue_id: id, planned: null, protection: null, pages: [], oracle: null, public_check: null, image_diff: null, governor: null, notes: [] };
    const finish = (extra = {}) => { fs.mkdirSync(path.join(dir, 'work'), { recursive: true, mode: 0o700 }); fs.writeFileSync(path.join(dir, 'work', 'probe.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 }); return { steps, clues, result, oracle: result.oracle, ...extra }; };

    // ---- screenshot pair mode: expected vs actual, no website needed ----
    const pairList = imgdiff.pairs(images).filter(p => p.actual);
    const pairResults = [];
    for (const p of pairList) {
        const r = await imgdiff.compare(fs.readFileSync(path.join(dir, 'images', p.expected.name)), fs.readFileSync(path.join(dir, 'images', p.actual.name)));
        if (r.ok) { fs.mkdirSync(path.join(dir, 'work', 'imgdiff'), { recursive: true, mode: 0o700 }); const f = `work/imgdiff/${p.expected.name}.vs.${p.actual.name}.diff.png`; fs.writeFileSync(path.join(dir, f), r.diff_png, { mode: 0o600 }); delete r.diff_png; r.diff_image = f; r.regions = r.regions.map(g => ({ ...g, element: null, element_note: 'needs the live page' })); }
        pairResults.push({ expected: p.expected.name, actual: p.actual.name, ...r });
    }
    if (pairResults.length) result.image_diff = { mode: 'pair', pairs: pairResults };

    // ---- gate: is there a site, was its environment stated, is the browser there ----
    const gate = (() => {
        if (options.probe === false) return { status: 'NOT_RUN', reason: 'the live probe was switched off (--no-probe)' };
        if (!issue.url) return { status: 'NOT_RUN', reason: 'no site address was given (--url), so no page could be loaded' };
        const a = store.authorization(issue);
        if (!a.ok) return { status: 'BLOCKED', reason: a.message };
        const br = browserReady(); if (!br.ok) return { status: 'NOT_RUN', reason: br.reason };
        return null;
    })();
    const imageDiffStep = () => steps.push(pairResults.length
        ? step('image-diff', 'Screenshot comparison (expected vs actual)', pairResults.every(r => r.ok) ? 'PASSED' : 'FAILED', pairResults.map(r => r.ok ? `${r.expected} vs ${r.actual}: ${r.diff_percent}% of pixels differ in ${r.regions.length} region(s)${r.size_mismatch ? `; sizes differ (${r.size.expected.join('x')} vs ${r.size.actual.join('x')}), only the common ${r.size.compared.join('x')} area was compared` : ''}` : `${r.expected} vs ${r.actual}: ${r.reason}`).join('; ') + '. Regions are not tied to page elements without a live page.', { pairs: pairResults.length })
        : step('image-diff', 'Screenshot comparison (expected vs actual)', 'NOT_RUN', 'no image pair was given: name two screenshots expected-<name> and actual-<name> (or baseline-/before- and broken-/after-) to compare them'));

    if (gate) {
        steps.push(step('live-probe', 'Live page probe', gate.status, gate.reason));
        steps.push(step('original-public', 'Are the originals of the screenshots public?', issue.public_originals && issue.public_originals.length ? 'NOT_RUN' : 'NOT_RUN', issue.public_originals && issue.public_originals.length ? `${gate.reason}; the originals (${issue.public_originals.length}) are probably downloadable by anyone until deleted` : 'no screenshot came from inside the WordPress folder'));
        result.oracle = oracleMod.evaluate(issue.oracle, { pages: [], planned: 0, skipped: gate.reason, debug_log: logGrowth(logMark(root)) }, { needsLogin: issue.needs_login, symptom: issue.symptom });
        if (issue.oracle.type === 'debug-log' && result.oracle.result === 'could-not-test' && !root) result.oracle.reason = 'no local WordPress copy (--root) and no live probe';
        steps.push(step('oracle', 'Oracle: is the symptom present?', 'NOT_RUN', `symptom reproduced: ${result.oracle.result.replace(/-/g, ' ')} (${result.oracle.reason})`, { reproduced: result.oracle.result }));
        imageDiffStep();
        return finish();
    }

    // ---- plan, run ----
    const pl = plan(issue, options, images);
    result.planned = { pages: pl.pages, viewports: pl.viewports.map(v => `${v.name} ${v.width}x${v.height}`), loads: pl.planned, notes: pl.notes };
    const stateRoot = path.join(dir, 'work', 'probe');
    fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
    const pub = (issue.public_originals || [])[0];
    let publicUrl = null;
    if (pub && !/(^|\/)\.\.(\/|$)/.test(pub)) { try { const u = new URL(pub.split('/').map(encodeURIComponent).join('/'), pl.base); if (u.origin === new URL(pl.base).origin) publicUrl = u.href; } catch { /* not a URL */ } }
    const jobFile = path.join(stateRoot, 'job.json'), outFile = path.join(stateRoot, 'result.json');
    const measure = issue.oracle.type === 'visible-width' ? [String(issue.oracle.value).replace(/,\s*\d+$/, '')] : [];
    fs.writeFileSync(jobFile, JSON.stringify({ base: pl.base, pages: pl.pages, viewports: pl.viewports, measure, layout: options.layout !== false, expected: pl.expected, publicCheck: publicUrl ? { url: publicUrl } : null,
        stateRoot, cooldownFile: cooldownFile(env), out: outFile }), { mode: 0o600 });
    fs.rmSync(outFile, { force: true });
    const mark = logMark(root);
    const w = await runWorker({ file: jobFile }, env, options.timeoutMs || DEFAULTS.timeoutMs);
    const growth = logGrowth(mark);
    let raw = null; try { raw = JSON.parse(fs.readFileSync(outFile, 'utf8')); } catch { /* worker died */ }

    if (!raw || raw.error) {
        const why = w.killed ? `the probe worker ran longer than ${Math.round((options.timeoutMs || DEFAULTS.timeoutMs) / 60000)} minutes and was stopped` : `the probe worker failed: ${cut((raw && raw.error) || w.err || `exit ${w.code}`, 240)}`;
        steps.push(step('live-probe', 'Live page probe', 'FAILED', why));
        steps.push(step('oracle', 'Oracle: is the symptom present?', 'NOT_RUN', `symptom reproduced: could not test (${why})`, { reproduced: 'could-not-test' }));
        result.oracle = oracleMod.evaluate(issue.oracle, { pages: [], planned: pl.planned, skipped: why }, { needsLogin: issue.needs_login, symptom: issue.symptom });
        steps.push(step('original-public', 'Are the originals of the screenshots public?', 'NOT_RUN', publicUrl ? why : 'no screenshot came from inside the WordPress folder'));
        imageDiffStep();
        return finish();
    }

    // keep the screenshots and diff image with the issue; strip raw page text before anything is written
    const keep = f => { if (!f || !fs.existsSync(f)) return null; const dest = path.join('work', 'probe', 'screenshots', path.basename(f)); return path.relative(dir, f) === dest ? dest : dest; };
    const pagesFull = raw.pages.map(norm);
    result.pages = pagesFull.map(({ text, ...p }) => ({ ...p, text_chars: (text || '').length, text_flags: oracleMod.textFlags(text), text_preview: cut(text, 300), screenshot: keep(p.screenshot),
        console_errors: p.console_errors.map(e => ({ ...e, text: cut(e.text, 400) })), page_errors: p.page_errors.map(e => ({ ...e, text: cut(e.text, 400) })) }));
    result.protection = raw.protection; result.governor = raw.governor; result.public_check = raw.public_check; result.notes = [...pl.notes, ...(raw.layout_notes || [])];
    if (raw.image_diff) result.image_diff = { ...(result.image_diff || {}), ...(raw.image_diff.ok ? { mode: 'probe', ...raw.image_diff, diff_image: keep(raw.image_diff.diff_image) } : { mode: 'probe', ...raw.image_diff }) };
    if (pl.expected && !raw.image_diff && !raw.protection) result.image_diff = { ...(result.image_diff || {}), mode: 'probe', ok: false, reason: 'the page for the expected image was not loaded' };

    const loaded = pagesFull.filter(p => p.loaded);
    const plannedLoads = typeof raw.planned === 'number' ? raw.planned : pl.planned; // pages already seen answering 5xx are not loaded again
    const probeStatus = raw.unreachable ? 'FAILED' : raw.protection ? 'BLOCKED' : loaded.length ? 'PASSED' : 'FAILED';
    const reqs = raw.governor ? raw.governor.requests_made : 0;
    steps.push(step('live-probe', 'Live page probe', probeStatus,
        raw.unreachable ? `the site could not be reached (${raw.unreachable}); this is not site protection`
            : raw.protection ? `Testing limited by site protection/rate limiting: ${raw.protection.reason}. The probe stopped at the first sign and sent no further request (${reqs} governed request(s) were made; ${loaded.length} of ${plannedLoads} planned page loads completed). Not a website defect; try later or from a staging copy.${raw.protection.kind === 'cooldown' ? ' No request was sent at all.' : ' A cooldown was recorded and the next run (probe or frontend agent) will wait.'}`
                : `${loaded.length} of ${plannedLoads} planned page loads completed (${pl.pages.length} page(s) x ${pl.viewports.length} screen size(s)${plannedLoads < pl.planned ? `; ${pl.planned - plannedLoads} not repeated because the page had already answered 5xx` : ''}); ${reqs} governed request(s); paced at ${raw.governor ? raw.governor.navigation_delay_ms : '?'} ms per page load; read-only: ${pagesFull.reduce((n, p) => n + (p.blocked_non_get || []).length, 0)} write request(s) by the page were aborted${pagesFull.some(p => p.layout_status && p.layout_status !== 'ran') ? `; layout checks were skipped or cut short on ${pagesFull.filter(p => p.layout_status && p.layout_status !== 'ran').length} page load(s) (see probe.json)` : ''}${pl.notes.length ? `; ${pl.notes.join('; ')}` : ''}`,
        { pages: loaded.length, planned: plannedLoads, requests: reqs, protection: raw.protection ? raw.protection.kind : null }));

    // ---- the single "is the original public" answer ----
    if (!publicUrl) steps.push(step('original-public', 'Are the originals of the screenshots public?', 'NOT_RUN', pub ? 'the original path could not be turned into an address on the same site' : 'no screenshot came from inside the WordPress folder'));
    else if (!raw.public_check || raw.public_check.skipped) steps.push(step('original-public', 'Are the originals of the screenshots public?', 'SKIPPED', (raw.public_check && raw.public_check.skipped) || 'not checked'));
    else if (raw.public_check.error) steps.push(step('original-public', 'Are the originals of the screenshots public?', 'FAILED', raw.public_check.error));
    else {
        const pc = raw.public_check;
        const text = pc.public ? `YES: ${publicUrl} answered HTTP ${pc.status} (${pc.content_type}); anyone can download it. Delete the original from the WordPress folder (the copy in the issue folder is outside the web root).`
            : pc.answered_with_page ? `${publicUrl} answered HTTP ${pc.status} with a web page, not the file (probably a catch-all); the original does not appear to be downloadable at that address.`
            : `no: ${publicUrl} answered HTTP ${pc.status}; the original does not appear to be downloadable at that address. Delete it anyway if you do not need it there.`;
        steps.push(step('original-public', 'Are the originals of the screenshots public?', 'PASSED', `${text}${(issue.public_originals || []).length > 1 ? ` Only the first of ${issue.public_originals.length} originals was checked (one request).` : ''}`, { public: pc.public, http_status: pc.status }));
        issue.public_check = { url: publicUrl, status: pc.status, content_type: pc.content_type, public: pc.public, answered_with_page: !!pc.answered_with_page };
        issue.notes = issue.notes.filter(n => !/^original (is|is not)/.test(n)).concat(pc.public ? `original is PUBLIC: ${publicUrl} answers HTTP ${pc.status}; delete it` : `original is not downloadable at ${publicUrl} (HTTP ${pc.status})`);
        store.save(issue);
    }

    // ---- oracle ----
    const obs = { pages: pagesFull, planned: plannedLoads, protection: raw.protection, debug_log: growth };
    result.oracle = oracleMod.evaluate(issue.oracle, obs, { needsLogin: issue.needs_login, symptom: issue.symptom });
    const o = result.oracle;
    steps.push(step('oracle', 'Oracle: is the symptom present?', o.result === 'could-not-test' ? (raw.protection ? 'BLOCKED' : 'NOT_RUN') : 'PASSED',
        `symptom reproduced: ${o.result.replace(/-/g, ' ')} (${o.reason})${o.defaulted ? '; this is the generic oracle for the symptom type, because none was given' : ''}${o.result === 'no' ? '. NOT reproduced: every conclusion in this investigation stays PROBABLE_NEEDS_REVIEW or below.' : ''}`,
        { reproduced: o.result, generic: o.defaulted }));
    if (growth.available) result.debug_log = { new_bytes: growth.new_bytes, lines: String(growth.new_text || '').split(/\r?\n/).filter(Boolean).length };

    if (result.image_diff && result.image_diff.mode === 'probe' && result.image_diff.ok === false) result.image_diff.note = result.image_diff.reason;
    const probeDiff = result.image_diff && result.image_diff.regions && result.image_diff.mode === 'probe' ? result.image_diff : null;
    const kinds = [];
    if (pairResults.length) kinds.push(`${pairResults.length} pair(s) compared`);
    if (probeDiff) kinds.push(`the expected image vs the live page at ${probeDiff.viewport}: ${probeDiff.diff_percent}% of pixels differ in ${probeDiff.regions.length} region(s)${probeDiff.size_mismatch ? `; sizes differ, only the common ${probeDiff.size.compared.join('x')} area was compared` : ''}; ${probeDiff.regions.filter(r => r.element && (r.element.selector || r.element.tag)).length} region(s) tied to a page element`);
    else if (pl.expected && result.image_diff && result.image_diff.ok === false) kinds.push(`expected image vs live page: ${result.image_diff.reason}`);
    if (pairResults.length || probeDiff || (pl.expected && result.image_diff)) steps.push(step('image-diff', 'Screenshot comparison (expected vs actual)', (probeDiff || pairResults.length) ? 'PASSED' : 'FAILED', kinds.join('; ')));
    else imageDiffStep();

    clues.push(...cluesFrom(pagesFull));
    return finish();
}

// One oracle test against a SANDBOX (a throwaway copy on 127.0.0.1): clicks and a test login are allowed there. Used by the bisection for every
// set it tries. Same worker, same governor pacing; the cooldown file is private to the sandbox so it never touches the real site's.
// Loads pages in a sandbox (127.0.0.1 only) and returns the raw observations; no oracle is evaluated here, so ONE load can serve several oracles.
async function observeSandbox({ base, pages, vp, measure = [], click = null, stateDir, tag = 'probe', login = false, env = process.env, options = {} }) {
    const dir = path.join(stateDir, tag); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const jobFile = path.join(dir, 'job.json'), outFile = path.join(dir, 'result.json');
    fs.writeFileSync(jobFile, JSON.stringify({ base: base.href, pages, viewports: vp, measure, layout: false, sandbox: true, login: !!login, click, expected: null, publicCheck: null, stateRoot: dir, cooldownFile: path.join(dir, 'cooldown.json'), out: outFile }), { mode: 0o600 });
    fs.rmSync(outFile, { force: true });
    const childEnv = { ...env }; if (!login) { delete childEnv.PG_TEST_USER; delete childEnv.PG_TEST_PASSWORD; }
    const w = await new Promise(resolve => { const c = spawn(process.execPath, [WORKER, jobFile], { env: Object.fromEntries(Object.entries(childEnv).filter(([k]) => !/^(PSI_API_KEY|WPSCAN_API_TOKEN)$/.test(k) && (login || !/^PG_TEST_/.test(k)))), stdio: ['ignore', 'ignore', 'pipe'] }); let err = ''; c.stderr.on('data', d => { err = (err + d).slice(-1000); }); const t = setTimeout(() => c.kill('SIGKILL'), options.timeoutMs || 5 * 60 * 1000); c.on('close', code => { clearTimeout(t); resolve({ code, err }); }); });
    let raw = null; try { raw = JSON.parse(fs.readFileSync(outFile, 'utf8')); } catch { /* worker died */ }
    if (!raw || raw.error) return { ok: false, reason: `the sandbox probe failed: ${cut((raw && raw.error) || w.err || `exit ${w.code}`, 200)}` };
    return { ok: true, pagesFull: raw.pages.map(norm), planned: typeof raw.planned === 'number' ? raw.planned : pages.length * vp.length, protection: raw.protection, login: raw.login || null };
}
// the viewports a given oracle needs (a horizontal-scroll oracle measures at exactly its own width)
function viewportsFor(oracle, options = {}) {
    const oracleVp = oracle.type === 'no-hscroll' && Number(oracle.value) >= 280 ? [{ name: `width-${oracle.value}`, width: Number(oracle.value), height: 800 }] : null;
    return oracleVp || (options.viewports ? String(options.viewports).split(',').filter(n => VIEWPORTS[n]).map(n => ({ name: n, width: VIEWPORTS[n][0], height: VIEWPORTS[n][1] })) : [{ name: 'laptop', width: 1280, height: 800 }]);
}
const sandboxBase = url => { const base = new URL(url); if (!base.pathname.endsWith('/')) base.pathname += '/'; if (base.hostname !== '127.0.0.1') throw new Error(`the sandbox probe only runs against 127.0.0.1, not ${base.hostname}`); return base; };
const absPages = (list, base, max) => (list.length ? list : ['/']).slice(0, max).map(p => new URL(String(p).replace(/^\//, ''), base).href).filter(u => new URL(u).origin === base.origin);

async function runSandbox(id, { url, stateDir, options = {}, env = process.env, tag = 'probe', login = false }) {
    const issue = store.load(id);
    const base = sandboxBase(url);
    const pages = absPages(issue.pages, base, options.probePages || 2);
    const vp = viewportsFor(issue.oracle, options);
    const measure = issue.oracle.type === 'visible-width' ? [String(issue.oracle.value).replace(/,\s*\d+$/, '')] : [];
    const click = issue.oracle.type === 'click-changes' ? (() => { const [from, to] = String(issue.oracle.value).split('=>').map(s => s.trim()); return from && to ? { from, to } : null; })() : null;
    const o = await observeSandbox({ base, pages, vp, measure, click, stateDir, tag, login, env, options });
    if (!o.ok) return { ok: false, reason: o.reason, oracle: null, pages: [] };
    const pagesFull = o.pagesFull;
    const oracle = oracleMod.evaluate(issue.oracle, { pages: pagesFull, planned: o.planned, protection: o.protection, sandbox: true, logged_in: !!(o.login && o.login.ok), debug_log: options.debugLog }, { needsLogin: issue.needs_login, symptom: issue.symptom });
    return { ok: true, oracle, status_codes: pagesFull.map(p => p.reused_status || p.status), fatal_text: pagesFull.some(p => /There has been a critical error|Fatal error|Parse error/i.test(p.text || '')), login: o.login || null, pages: pagesFull.map(({ text, ...p }) => ({ ...p, text_chars: (text || '').length, text_flags: oracleMod.textFlags(text) })) };
}

module.exports = { runSandbox, observeSandbox, viewportsFor, sandboxBase, absPages, run, plan, cluesFrom, logMark, logGrowth, browserReady, VIEWPORTS, DEFAULTS, cooldownFile };
