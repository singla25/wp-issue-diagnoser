// The oracle: the explicit, cheap-to-write test of "is the symptom present". Stored in issue.json as DATA and evaluated here against what
// the live probe observed (and, for debug-log, against new lines in a local debug.log). Never code, never an AI judgement.
//
// Every oracle answers one question the same way: IS THE SYMPTOM PRESENT?   yes / no / could not test (reason)
//   console-error   yes when a console or page error matching the pattern appeared
//   request-failed  yes when a request whose address matches the pattern failed or was answered with an error status
//   http-5xx        yes when a probed page answered with a 5xx status
//   debug-log       yes when debug.log gained a line matching the pattern while the pages loaded
//   visible-width   yes when the element is missing, hidden, or not wider than N px
//   no-hscroll      yes when the page scrolls horizontally at N px
//   text-present    yes when the text does NOT appear on the page (missing content)
//   lcp-over        yes when the largest contentful paint took longer than N ms
//   click-changes   yes when clicking <from> does NOT change <to>. Could not test on a live site: clicking happens only in the sandbox
//   redirect        yes when a probed page ends in a redirect loop (ERR_TOO_MANY_REDIRECTS), follows more than N redirects in a row (default 3),
//                   or is redirected to another host (www.x <-> x counts as the same host). The value is optional: the chain limit N.
//   generic         yes when any of: console/page error, failing same-site request, 5xx, horizontal scroll, new PHP error in debug.log.
//                   For the symptoms white-screen, redirect and other (callers pass the issue's symptom) it also says yes for a redirect loop,
//                   a long or cross-host redirect chain, a blank page and a critical-error text, each served with a success status.
// "no" is only said when every planned page loaded; if the site's protection stopped the probe early, the answer is "could not test".
// Patterns are plain text unless written re:, and go through safe-pattern.js.

const safe = require('../lib/safe-pattern');

const MAX_EVIDENCE = 12;
const cut = (s, n = 160) => String(s).replace(/\s+/g, ' ').trim().slice(0, n);
const PHP_ERROR = /\b(Fatal error|Parse error|Uncaught|Warning|Notice|Deprecated)\b/i;
const LOOP_ERROR = /ERR_TOO_MANY_REDIRECTS/i;   // what probe/worker.js already records in rec.error when Chrome gives up on a loop
const CRITICAL_TEXT = /There has been a critical error on this (?:website|site)|(?:^|\n)\s*(?:PHP )?(?:Fatal error|Parse error)\s*:/i;
const DEFAULT_MAX_HOPS = 3;
// symptoms for which `generic` also judges redirects and blank / critical pages (a layout complaint must not be answered with "blank page")
const NEW_GENERIC_SYMPTOMS = new Set(['white-screen', 'redirect', 'other']);
const hostKey = u => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; } };

// What the visible text of a page says about it. Kept on the stored page record (text itself is dropped when a probe is saved), so the answer can be
// recomputed later by the validation step.
const textFlags = text => { const t = String(text == null ? '' : text); return { blank: t.trim() === '', critical: CRITICAL_TEXT.test(t) }; };
const flagsOf = p => (typeof p.text === 'string' ? textFlags(p.text) : p.text_flags || (p.text_chars === 0 ? { blank: true, critical: false } : null));

// Signs of a redirect problem on one page record. -> [string]
function redirectSigns(p, maxHops = DEFAULT_MAX_HOPS) {
    const signs = [];
    if (p.error && LOOP_ERROR.test(p.error)) signs.push('redirect loop: the browser gave up (ERR_TOO_MANY_REDIRECTS)');
    const chain = Array.isArray(p.redirects) ? p.redirects : [];
    if (chain.length > 1) {
        if (new Set(chain).size < chain.length) signs.push(`redirect loop: ${cut(chain[0], 80)} is visited twice in the chain`);
        if (chain.length - 1 > maxHops) signs.push(`${chain.length - 1} redirects in a row (limit ${maxHops}): ${cut(chain[0], 60)} -> ... -> ${cut(chain[chain.length - 1], 60)}`);
        const first = hostKey(chain[0]), other = chain.find(u => hostKey(u) && first && hostKey(u) !== first);
        if (other) signs.push(`redirected to another host: ${cut(chain[0], 70)} -> ${cut(other, 70)}`);
    }
    return signs;
}

function ctxOf(obs) {
    const loaded = obs.pages.filter(p => p.loaded);
    return { loaded, planned: obs.planned || obs.pages.length, partial: loaded.length < (obs.planned || obs.pages.length) };
}
const yes = (reason, matches, c) => ({ result: 'yes', reason, matches: matches.slice(0, MAX_EVIDENCE), pages_loaded: c.loaded.length, pages_planned: c.planned });
const no = (reason, c) => ({ result: 'no', reason, matches: [], pages_loaded: c.loaded.length, pages_planned: c.planned });
const cant = (reason, c) => ({ result: 'could-not-test', reason, matches: [], pages_loaded: c ? c.loaded.length : 0, pages_planned: c ? c.planned : 0 });

// obs: { pages: [{ url, viewport:{name,width}, loaded, status, console_errors, page_errors, error_responses, scroll:{doc_width,viewport_width}, text, measure, lcp }], planned,
//        protection, debug_log: { available, reason, new_text } }
const CRASH_SYMPTOMS = new Set(['white-screen']);
function evaluate(spec, obs, { needsLogin = false, symptom = null } = {}) {
    const c = ctxOf(obs);
    const base = { type: spec.type, value: spec.value, defaulted: !!spec.defaulted, ...(symptom ? { symptom } : {}) };
    const newGeneric = spec.type === 'generic' && NEW_GENERIC_SYMPTOMS.has(symptom);
    const done = r => ({ ...base, ...r, partial: c.partial, protection: obs.protection ? obs.protection.reason || true : null });
    if (needsLogin && !obs.logged_in) return done(cant('the problem needs a logged-in user, and a live probe never logs in. The sandbox (a throwaway copy) can create a test user and test this.', c));
    if (spec.type === 'click-changes' && !obs.sandbox) return done(cant('clicking is allowed only in the sandbox (a throwaway copy), never on a live site', c));
    const needsPages = spec.type !== 'debug-log';
    const loopSeen = (spec.type === 'redirect' || newGeneric) && obs.pages.some(p => p.error && LOOP_ERROR.test(p.error));   // a loop leaves no loaded page, and is the answer
    if (needsPages && !c.loaded.length && !loopSeen) return done(cant(obs.protection ? `the site\'s protection stopped the probe before any page loaded (${obs.protection.reason || 'see probe.json'})` : obs.skipped || 'no page was loaded', c));

    const incomplete = `only ${c.loaded.length} of ${c.planned} planned page loads completed${obs.protection ? ` (the site's protection stopped the probe)` : ''}`;
    const conclude = (hits, yesText, noText) => hits.length ? done(yes(yesText, hits, c)) : done(c.partial ? cant(`not seen, but ${incomplete}, so "no" cannot be said`, c) : no(noText, c));

    switch (spec.type) {
        case 'console-error': {
            const pat = safe.compile(spec.value);
            if (!pat.ok) return done(cant(`the pattern was refused: ${pat.problem}`, c));
            const hits = [];
            for (const p of c.loaded) for (const e of [...p.console_errors, ...p.page_errors]) if (pat.test(e.text)) hits.push({ page: p.url, viewport: p.viewport.name, detail: cut(e.text) });
            return conclude(hits, `a console / page error matching ${pat.kind === 'regex' ? 'the regular expression' : 'the text'} appeared (${hits.length} time(s))`, 'no console or page error matched on any probed page');
        }
        case 'request-failed': {
            const pat = safe.compile(spec.value);
            if (!pat.ok) return done(cant(`the pattern was refused: ${pat.problem}`, c));
            const hits = [];
            for (const p of c.loaded) {
                for (const r of p.error_responses || []) if (pat.test(r.url)) hits.push({ page: p.url, viewport: p.viewport.name, detail: `HTTP ${r.status} for ${cut(r.url, 120)}` });
                for (const r of p.failed_requests || []) if (pat.test(r.url)) hits.push({ page: p.url, viewport: p.viewport.name, detail: `request failed: ${cut(r.url, 120)}${r.errorText ? ' (' + cut(r.errorText, 40) + ')' : ''}` });
            }
            return conclude(hits, `${hits.length} matching request(s) failed or returned an error status`, 'no matching request failed on any probed page');
        }
        case 'http-5xx': {
            const hits = [...c.loaded.filter(p => p.status >= 500).map(p => ({ page: p.url, viewport: p.viewport.name, detail: `HTTP ${p.status}` })), ...obs.pages.filter(p => !p.loaded && p.reused_status >= 500).map(p => ({ page: p.url, viewport: p.viewport.name, detail: `HTTP ${p.reused_status} (seen at another screen size; not requested again)` }))];
            return conclude(hits, `${hits.length} probed page(s) answered with a 5xx status`, 'every probed page answered below 500');
        }
        case 'no-hscroll': {
            const want = Number(spec.value), pages = c.loaded.filter(p => p.viewport.width === want);
            if (!pages.length) return done(cant(`no page was loaded at ${want}px wide`, c));
            const hits = pages.filter(p => p.scroll && p.scroll.doc_width > p.scroll.viewport_width + 1).map(p => ({ page: p.url, viewport: p.viewport.name, detail: `the page is ${p.scroll.doc_width}px wide in a ${p.scroll.viewport_width}px viewport` }));
            return hits.length ? done(yes(`${hits.length} page(s) scroll horizontally at ${want}px`, hits, c)) : done(c.partial ? cant(`no horizontal scroll seen, but ${incomplete}`, c) : no(`no horizontal scroll at ${want}px on ${pages.length} page load(s)`, c));
        }
        case 'text-present': {
            const pat = safe.compile(spec.value);
            if (!pat.ok) return done(cant(`the pattern was refused: ${pat.problem}`, c));
            const missing = c.loaded.filter(p => p.status < 400 && !pat.test(p.text || '')).map(p => ({ page: p.url, viewport: p.viewport.name, detail: `the text was not found in the ${(p.text || '').length} characters of visible text` }));
            const present = c.loaded.filter(p => p.status < 400 && pat.test(p.text || ''));
            if (!present.length && !missing.length) return done(cant('no probed page answered successfully', c));
            return missing.length ? done(yes(`the text is missing on ${missing.length} of ${missing.length + present.length} page load(s)`, missing, c)) : done(c.partial ? cant(`the text is present, but ${incomplete}`, c) : no('the text appears on every probed page', c));
        }
        case 'visible-width': {
            const m = /^(.*),\s*(\d+)$/.exec(spec.value || '');
            if (!m) return done(cant('the value must be "selector,minimum width"', c));
            const [, sel, min] = m;
            const hits = [];
            for (const p of c.loaded) { const r = p.measure && p.measure[sel]; if (!r || !r.found || !r.visible || !(r.width > Number(min))) hits.push({ page: p.url, viewport: p.viewport.name, detail: !r || !r.found ? `"${sel}" was not found` : !r.visible ? `"${sel}" is hidden` : `"${sel}" is ${r.width}px wide (needs more than ${min}px)` }); }
            return conclude(hits, `"${sel}" is missing, hidden or too narrow on ${hits.length} page load(s)`, `"${sel}" is visible and wider than ${min}px everywhere it was probed`);
        }
        case 'lcp-over': {
            const lim = Number(spec.value), vals = c.loaded.filter(p => typeof p.lcp === 'number');
            if (!vals.length) return done(cant('the browser reported no largest-contentful-paint value', c));
            const hits = vals.filter(p => p.lcp > lim).map(p => ({ page: p.url, viewport: p.viewport.name, detail: `LCP ${Math.round(p.lcp)} ms` }));
            return conclude(hits, `LCP exceeded ${lim} ms on ${hits.length} page load(s)`, `LCP stayed under ${lim} ms (highest ${Math.round(Math.max(...vals.map(p => p.lcp)))} ms)`);
        }
        case 'debug-log': {
            const pat = safe.compile(spec.value);
            if (!pat.ok) return done(cant(`the pattern was refused: ${pat.problem}`, c));
            const d = obs.debug_log;
            if (!d || !d.available) return done(cant(d ? d.reason : 'debug.log could not be read (a local copy of the site and WP_DEBUG_LOG are needed); missing data is not "clean"', c));
            if (!c.loaded.length) return done(cant('no page was loaded, so nothing could have been written to debug.log', c));
            const lines = String(d.new_text || '').split(/\r?\n/).filter(Boolean), hits = lines.filter(l => pat.test(l)).map(l => ({ page: '(debug.log)', viewport: '-', detail: cut(l) }));
            // A page that answered 5xx is a failure whatever debug.log did (the fatal may already be logged by an earlier request, or the log not written at all): this oracle must never turn
            // it into "no". For a crash symptom it is the symptom, for any other symptom it is "could not test" (the 5xx may be unrelated to the pattern asked for).
            const five = c.loaded.filter(p => p.status >= 500 && p.status < 600);
            if (!hits.length && five.length) {
                const why = `a probed page answered HTTP ${five[0].status} while debug.log gained no matching line (${lines.length} line(s) gained)`;
                return CRASH_SYMPTOMS.has(symptom) ? done(yes(why, five.map(p => ({ page: p.url, viewport: p.viewport.name, detail: `the page itself answered HTTP ${p.status}` })), c)) : done(cant(`${why}; this symptom is not a crash, so the 5xx is not taken as the answer`, c));
            }
            return conclude(hits, `debug.log gained ${hits.length} matching line(s) while the pages loaded`, `debug.log gained ${lines.length} line(s) while the pages loaded, none matching`);
        }
        case 'click-changes': {
            const tested = c.loaded.filter(p => p.click);
            if (!tested.length) return done(cant('no page was clicked', c));
            const notClicked = tested.filter(p => !p.click.clicked);
            const dead = tested.filter(p => p.click.clicked && !p.click.changed).map(p => ({ page: p.url, viewport: p.viewport.name, detail: `clicking "${p.click.from}" did not change "${p.click.to}"` }));
            if (dead.length) return done(yes(`clicking did nothing on ${dead.length} page load(s)`, dead, c));
            if (notClicked.length) return done(cant(`could not click: ${notClicked[0].click.error || 'unknown'}`, c));
            return done(c.partial ? cant(`the click changed the page, but ${incomplete}`, c) : no('clicking changed the target on every page', c));
        }
        case 'redirect': {
            const max = Number(spec.value) > 0 ? Number(spec.value) : DEFAULT_MAX_HOPS, hits = [];
            for (const p of obs.pages) for (const sign of redirectSigns(p, max)) hits.push({ page: p.url, viewport: (p.viewport || {}).name, detail: sign });
            return conclude(hits, `${hits.length} redirect problem(s) on the probed pages`, `no redirect loop, long chain or cross-host redirect on the ${c.loaded.length} page load(s)`);
        }
        case 'generic': {
            const hits = [], notes = [];
            for (const p of c.loaded) {
                for (const e of [...p.page_errors, ...p.console_errors.filter(e => !/^Failed to load resource/i.test(e.text))]) hits.push({ page: p.url, viewport: p.viewport.name, detail: `JavaScript: ${cut(e.text)}` });
                for (const r of p.error_responses.filter(r => r.same_site)) hits.push({ page: p.url, viewport: p.viewport.name, detail: `HTTP ${r.status} for ${cut(r.url, 100)}${r.source ? ` (${r.source})` : ''}` });
                if (p.status >= 500) hits.push({ page: p.url, viewport: p.viewport.name, detail: `the page itself answered HTTP ${p.status}` });
                if (p.scroll && p.scroll.doc_width > p.scroll.viewport_width + 1) hits.push({ page: p.url, viewport: p.viewport.name, detail: `horizontal scroll: ${p.scroll.doc_width}px in a ${p.scroll.viewport_width}px viewport` });
            }
            if (newGeneric) {
                for (const p of obs.pages) {
                    for (const sign of redirectSigns(p)) hits.push({ page: p.url, viewport: (p.viewport || {}).name, detail: sign });
                    if (p.loaded && p.status >= 200 && p.status < 400) {
                        const f = flagsOf(p);
                        if (f && f.critical) hits.push({ page: p.url, viewport: p.viewport.name, detail: `a critical-error text is shown with HTTP ${p.status}` });
                        else if (f && f.blank) hits.push({ page: p.url, viewport: p.viewport.name, detail: `the page is blank (no visible text) with HTTP ${p.status}` });
                    }
                }
            }
            const d = obs.debug_log;
            if (d && d.available) for (const l of String(d.new_text || '').split(/\r?\n/).filter(l => PHP_ERROR.test(l))) hits.push({ page: '(debug.log)', viewport: '-', detail: cut(l) });
            else notes.push(`debug.log was not checked${d ? ` (${d.reason})` : ''}`);
            return conclude(hits, `the generic oracle found ${hits.length} sign(s) of a problem`, `no console error, failing same-site request, 5xx, horizontal scroll or new PHP error was seen${notes.length ? `; ${notes.join('; ')}` : ''}`);
        }
        default: return done(cant(`unknown oracle type "${spec.type}"`, c));
    }
}

module.exports = { evaluate, textFlags, redirectSigns, NEW_GENERIC_SYMPTOMS, CRASH_SYMPTOMS };
