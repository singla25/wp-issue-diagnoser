#!/usr/bin/env node
// SECOND-SITE tests for generality (offline). A second made-up site (scripts/fixtures/second-site/sites.js, not the site the earlier fixtures were
// written around) goes through the plain wizard exactly as a person would run it: the tool makes its own read-only copy of the site
// (lib/site-intake.js), scans and investigates it, and writes the report with the gate on. The assertions below are about what the REPORT says.
// They were written BEFORE the first run against the tool (owner rule) and not adjusted to the output, with ONE owner-approved exception: three of
// MY checks were badly written (they matched the page script, or the true sentence 'No confirmed breaking cause was found') and were narrowed
// after the owner approved it (old and new text in docs/HANDOFF.md row 62). The case 3 checks were never changed; a failing check here is
// information about the tool, reported to the owner, not something to hide.
//
// Nothing live: the "real site" that the live check loads is a tiny HTTP server on 127.0.0.1 in this process (only for the cases that need a
// live answer); the test copy is the fake `docker` (scripts/fixtures/issue/fake-docker.js) plus a stand-in for the copy's page loads that
// models the fixture's own PHP (see `fakeSandbox`): the real containers run in scripts/selftest-second-site-docker.js.
//
// FOUR CASES (owner decisions; MUST = must say, NEVER = must never say):
//   1 PLUGIN PAIR (two plugins that only fail together)
//       MUST   the bisection names BOTH plugins as the pair, or its status is "inconclusive" stated honestly
//       NEVER  a single plugin as the sole cause; "NOT A PLUGIN CONFLICT"; a theme / core / database cause
//   2 HEALTHY SITE (page 200, no log errors)
//       MUST   nothing was reproduced / no failing page found; no cause named
//       NEVER  any cause; CONFIRMED; a plugin conflict; any "How sure" entry for a cause; "FIXED"
//   3 REDIRECT LOOP made by a PLUGIN (template_redirect + wp_redirect to the home page itself; not .htaccess)
//       MUST   "the page redirects to itself" in plain words. The probe records a loop as loaded=false with rec.error holding
//              ERR_TOO_MANY_REDIRECTS (probe/worker.js; issue/oracle.js redirectSigns: "redirect loop: the browser gave up (ERR_TOO_MANY_REDIRECTS)");
//              the plugin may be named as the cause ONLY when the bisection proves it (removing it clears the loop)
//       NEVER  5xx / "server error"; "did not answer with an error"; an invented fatal; a database / theme cause
//   4 DATABASE ERROR (wrong credentials in wp-config.php)
//       HOW THE TOOL'S COPY TREATS THE DATABASE CONSTANTS (read from the code, and checked in group 4a below):
//         - the wizard's copy (lib/site-intake.js copyForIssue -> lib/wp-config-redact.js redact): wp-config.php is reduced to an allow-list
//           (KEEP: WP_HOME, WP_SITEURL, WP_DEBUG*, ... ; no DB_NAME / DB_USER / DB_PASSWORD / DB_HOST) plus $table_prefix, so the copy has NO
//           database settings at all;
//         - the test copy (issue/sandbox-copy.js skips every wp-config*.php; issue/sandbox.js writes issue/sandbox-config.js wpConfig() into
//           the copy): a FRESH wp-config.php with its own random credentials and DB_HOST 'db:3306' (the copy's own database container),
//           never the site's.
//         So a copy CANNOT reproduce a wrong-credentials failure: the wrong values never reach it.
//       MUST   "could not confirm on a copy" (the copy does not reproduce it); no plugin named; not a plugin conflict; not CONFIRMED as a plugin
//              cause; the database clue may be shown as read from the log, labelled as not tested on a copy
//       NEVER  a plugin / theme conflict cause; REPRODUCIBLE / CONFIRMED for a plugin; "NOT A PLUGIN CONFLICT" as proven
//
// What stays untested here (HANDOFF row 62): a theme fatal, a missing plugin dependency.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { PassThrough } = require('stream');

// ================================================================ the assertions (shared with selftest-second-site-docker.js)
const FINE = 'did not answer with an error';
const CONFLICT = /plugin conflict|plugins clash|theme and a plugin clash/i;
const lc = s => String(s || '').toLowerCase();
const mentions = (text, slug, name) => lc(text).includes(lc(slug)) || (!!name && lc(text).includes(lc(name)));
const caseText = c => [c.heading, ...c.rows.map(([k, v]) => `${k}: ${(v || []).join(' | ')}`)].join('\n');
const rowText = (c, keys) => c.rows.filter(([k]) => keys.includes(k)).map(([, v]) => (v || []).join(' | ')).join('\n');
const STRONG = ['CONFIRMED', 'REPRODUCIBLE', 'FIXED_VERIFIED'];

// what a run produced, as the reader sees it. CF: the case-file renders (STATUS, the level, What you see, the cases, What was checked, For a developer);
// RT: the Markdown report and the text summary; ALL: RT plus the page (its source, client script included); SHOWN: RT plus the page's DATA (findings.json,
// the one object issue.html is generated from), never the page's script.
function view(R) {
    const caseFile = require('../issue/case-file');
    const cf = R.f && R.f.case_file ? R.f.case_file : null;
    const CF = cf ? `${caseFile.markdown(cf, t => String(t)).join('\n')}\n${caseFile.cli(cf)}` : '';
    const RT = `${R.md || ''}\n${(R.f && R.f.summary && R.f.summary.text_report) || ''}`;
    const causeCases = cf ? cf.cases.filter(c => c.kind === 'likely' || c.kind === 'confirmed') : [];
    return { cf, CF, RT, ALL: `${RT}\n${R.html || ''}`, SHOWN: `${RT}\n${JSON.stringify(R.f || {})}`, causeCases, hyps: (R.f && R.f.hypotheses) || [] };
}
const hypNames = h => JSON.stringify([h.components || [], h.title || '']);

// 1. PLUGIN PAIR
function pairChecks(R, ok, { info, label, bisectRan }) {
    const V = view(R), [a, b] = info.pair, [an, bn] = info.pairNames;
    ok(!!V.cf, `${label}: the report has its case file (gate on)`);
    if (bisectRan) {
        const bis = R.bis;
        const pairFound = !!bis && /^cause-found/.test(bis.status || '') && bis.causes.length >= 1 && JSON.stringify([...bis.causes[0].plugins].sort()) === JSON.stringify([...info.pair].sort());
        const inconclusive = !!bis && bis.status === 'inconclusive';
        ok(pairFound || inconclusive, `${label} MUST: the bisection names BOTH plugins as the pair, or is inconclusive (${bis ? `${bis.status}: ${JSON.stringify(bis.causes.map(c => c.plugins))}` : 'no bisect.json'})`);
        const named = pairFound && mentions(V.RT, a, an) && mentions(V.RT, b, bn);
        const honest = inconclusive && /no cause is named|does not show that plugins are not involved/i.test(V.RT);
        ok(named || honest, `${label} MUST: the report itself names both plugins of the pair (or says honestly that no cause is named)`);
    }
    const single = V.causeCases.filter(c => mentions(caseText(c), a, an) !== mentions(caseText(c), b, bn));
    ok(single.length === 0, `${label} NEVER: a case that names only one plugin of the pair as the cause (${single.map(c => `${c.heading}: ${rowText(c, ['Components', 'Where']).slice(0, 120)}`).join(' | ') || 'none'})`);
    const singleH = V.hyps.filter(h => STRONG.includes(h.status) && mentions(hypNames(h), a, an) !== mentions(hypNames(h), b, bn));
    ok(singleH.length === 0, `${label} NEVER: a CONFIRMED / REPRODUCIBLE hypothesis about one plugin of the pair alone (${singleH.map(h => `${h.status} ${h.title}`).join(' | ') || 'none'})`);
    // NARROWED 2026-11-12 (owner decision; old and new text in HANDOFF row 62): the first version scanned V.ALL, which includes issue.html's client
    // script (the label as code, rendered only when the data says so). Now: the visible report text and the page's DATA.
    ok(!/NOT A PLUGIN CONFLICT/i.test(V.SHOWN) && !(R.bis && R.bis.symptom_without_plugins), `${label} NEVER: "NOT A PLUGIN CONFLICT"`);
    const tcd = V.causeCases.filter(c => /\bthe theme\b|wp-content\/themes\/|WordPress itself|wp-includes|database/i.test(rowText(c, ['Components', 'Where'])));
    ok(!(R.bis && ['theme-is-the-cause', 'mu-plugin-is-the-cause', 'not-explained'].includes(R.bis.status)) && tcd.length === 0 && !/cause is in the theme|core, the database,? or the server/i.test(V.RT),
        `${label} NEVER: a theme / core / database cause (${R.bis ? `bisect ${R.bis.status}` : 'no bisection'}; ${tcd.map(c => c.heading).join(', ') || 'no such case'})`);
}

// 2. HEALTHY SITE
function healthyChecks(R, ok, { label, probeRan }) {
    const V = view(R);
    ok(!!V.cf, `${label}: the report has its case file (gate on)`);
    ok(V.cf && V.cf.status.likely === 0 && V.cf.status.confirmed === 0 && V.causeCases.length === 0, `${label} MUST: no cause named (${V.cf ? `"${V.cf.status.line}"` : 'no case file'})`);
    ok(/did not answer with an error|not reproduced|did not reproduce|no failing page/i.test(V.RT) && !(R.sbx && R.sbx.reproduced_in_sandbox === 'yes'), `${label} MUST: the report says nothing was reproduced / no failing page was found`);
    if (probeRan) ok(V.cf && V.cf.see.includes('The live pages that were loaded did not answer with an error.'), `${label} MUST: "What you see" says the loaded pages answered without an error`);
    const strong = V.hyps.filter(h => STRONG.includes(h.status));
    ok(strong.length === 0, `${label} NEVER: CONFIRMED / REPRODUCIBLE / FIXED_VERIFIED (${strong.map(h => `${h.status} ${h.title}`).join(' | ') || 'none'})`);
    const sure = V.causeCases.filter(c => c.rows.some(([k]) => k === 'How sure'));
    ok(sure.length === 0, `${label} NEVER: a "How sure" entry for a cause (${sure.map(c => c.heading).join(', ') || 'none'})`);
    ok(!CONFLICT.test(V.RT), `${label} NEVER: a plugin conflict`);
    ok(!/(?<!NOT )\bCONFIRMED\b|Confirmed cause/.test(V.RT), `${label} NEVER: "CONFIRMED" or "Confirmed cause"`);
    ok(!/\bFIXED\b|FIXED_VERIFIED|Fixed and verified/.test(V.RT), `${label} NEVER: "FIXED"`);
    // NARROWED 2026-11-12 (owner decision; old and new text in HANDOFF row 62): the first version (/cause found|confirmed|fixed/i) also matched the true,
    // negative "No confirmed breaking cause was found". Now only a POSITIVE claim fails (a label starting Confirmed / Reproduced / Fixed, or "cause found").
    ok(R.f && !/^\s*(Confirmed|Reproduced|Fixed)\b|\bcause found\b/i.test(String(R.f.verdict && R.f.verdict.label)), `${label} NEVER: a verdict that claims a cause (${R.f && R.f.verdict && R.f.verdict.label})`);
}

// 3. REDIRECT LOOP made by a plugin
function redirectChecks(R, ok, { info, label }) {
    const V = view(R), p = info.plugin, pn = info.pluginName;
    ok(!!V.cf, `${label}: the report has its case file (gate on)`);
    // RESULT OF THE FIRST RUN (2026-11-12): FAILED, a TOOL fault (STOP item, HANDOFF row 62), fixed after the owner approved it (reporting only, gate on). The probe records the loop (probe.json: loaded=false,
    // ERR_TOO_MANY_REDIRECTS; the oracle says yes), but issue/result.js counts the live check as run only when a page LOADED (ran.probe), so the
    // report says "No live check was run, so nothing was seen on the live page." and "Not looked at: the live page"; no sentence says the page
    // redirects to itself (with a test copy the case only says "the page ended in a redirect problem").
    ok(/redirects? (back )?to itself/i.test(V.RT), `${label} MUST: the report says, in plain words, that the page redirects to itself`);
    const proven = !!R.bis && /^cause-found/.test(R.bis.status || '') && R.bis.causes.length >= 1 && JSON.stringify(R.bis.causes[0].plugins) === JSON.stringify([p]);
    const confirmedNaming = [...V.causeCases.filter(c => c.kind === 'confirmed' && mentions(caseText(c), p, pn)), ...V.hyps.filter(h => STRONG.includes(h.status) && mentions(hypNames(h), p, pn))];
    ok(proven || confirmedNaming.length === 0, `${label} NEVER: the plugin as a CONFIRMED / REPRODUCIBLE cause without the bisection proving it (bisect ${R.bis ? R.bis.status : 'not run'}; ${confirmedNaming.length} naming it)`);
    const likelyNaming = V.causeCases.filter(c => c.kind === 'likely' && mentions(caseText(c), p, pn));
    ok(proven || likelyNaming.length === 0, `${label} NEVER: the plugin named as a cause (even "likely") without the bisection proving it; otherwise only "the page redirects to itself" (bisect ${R.bis ? R.bis.status : 'not run'}; ${likelyNaming.map(c => c.heading).join(', ') || 'no likely case names it'})`);
    ok(!(R.bis && R.bis.causes.some(c => c.plugins.some(x => info.innocent.includes(x)))), `${label} NEVER: the bisection names the uninvolved plugin`);
    ok(!/\bHTTP 5\d\d\b|\b5xx\b|server error/i.test(V.CF), `${label} NEVER: a 5xx or "server error"`);
    ok(!V.RT.includes(FINE), `${label} NEVER: "${FINE}"`);
    ok(!/fatal/i.test(V.CF), `${label} NEVER: an invented fatal error`);
    const dt = V.causeCases.filter(c => /\bthe theme\b|wp-content\/themes\/|database/i.test(rowText(c, ['Components', 'Where', 'Why'])));
    ok(dt.length === 0 && !(R.bis && R.bis.status === 'theme-is-the-cause') && !/cause is in the theme|core, the database,? or the server/i.test(V.RT), `${label} NEVER: a database / theme cause (${dt.map(c => c.heading).join(', ') || 'none'})`);
}

// 4. DATABASE ERROR
function dbChecks(R, ok, { info, label }) {
    const V = view(R), caseFile = require('../issue/case-file');
    ok(!!V.cf, `${label}: the report has its case file (gate on)`);
    const notOnCopy = /Not tested on a copy|The test copy could not confirm this|Not reproduced on a test copy|did not reproduce/.test(V.CF);
    ok(!(R.sbx && R.sbx.reproduced_in_sandbox === 'yes') && notOnCopy && !(V.cf && V.cf.level && V.cf.level.n === 1) && !V.CF.includes(caseFile.MATCHED_LINE), `${label} MUST: the report says it could not confirm this on a copy (level ${V.cf && V.cf.level ? `${V.cf.level.n} "${V.cf.level.heading}"` : 'none'}; reproduced_in_sandbox ${R.sbx ? JSON.stringify(R.sbx.reproduced_in_sandbox) : 'no sandbox.json'})`);
    const plug = V.causeCases.filter(c => /\bthe plugin\b|wp-content\/plugins\//i.test(rowText(c, ['Components', 'Where'])) || info.plugins.some(s => mentions(caseText(c), s)));
    ok(plug.length === 0, `${label} MUST: no plugin is named as a cause (${plug.map(c => `${c.heading}: ${rowText(c, ['Components', 'Where']).slice(0, 100)}`).join(' | ') || 'none'})`);
    const strongPlug = V.hyps.filter(h => STRONG.includes(h.status) && /plugin/i.test(JSON.stringify(h.components || [])));
    ok(strongPlug.length === 0, `${label} NEVER: REPRODUCIBLE / CONFIRMED for a plugin (${strongPlug.map(h => `${h.status} ${h.title}`).join(' | ') || 'none'})`);
    // NARROWED 2026-11-12 (owner decision; old and new text in HANDOFF row 62): V.ALL (page script included) -> V.SHOWN (visible text and page data)
    ok(!CONFLICT.test(V.RT) && !/NOT A PLUGIN CONFLICT/i.test(V.SHOWN), `${label} NEVER: a plugin / theme conflict cause, or "NOT A PLUGIN CONFLICT"`);
    if (V.CF.includes(info.phrase)) ok(V.CF.includes(caseFile.NOT_TESTED_LABEL) || /Not reproduced on a test copy|not tested|could not confirm/i.test(V.CF), `${label} MUST: the database clue is shown with a "not tested on a copy" label`);
    else console.log(`NOTE  ${label}: the database clue ("${info.phrase}") is not shown in the case file (allowed: "may be shown")`);
}

module.exports = { view, pairChecks, healthyChecks, redirectChecks, dbChecks, mentions, caseText, FINE };

// ================================================================ the runs (only when this file is run, not when the Docker suite loads the checks)
if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });

async function main() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-2site-'));
    process.env.PLUGIN_GUARD_ISSUES = path.join(tmp, 'issues'); fs.mkdirSync(process.env.PLUGIN_GUARD_ISSUES, { mode: 0o700 });
    Object.assign(process.env, { PG_PROBE_COOLDOWN_FILE: path.join(tmp, 'probe-cooldown.json'), PG_PROBE_NAV_DELAY_MS: '0', PG_PROBE_REQUEST_DELAY_MS: '0', PG_PROBE_5XX_RETRY_DELAY_MS: '0' });
    const sites = require('./fixtures/second-site/sites');
    const wizard = require('../lib/wizard'), store = require('../lib/issue-store'), probe = require('../issue/probe');
    let failures = 0;
    const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; return c; };
    const group = t => console.log(`\n== ${t}`);
    const hashTree = dir => { const h = crypto.createHash('sha256'); (function walk(d) { for (const n of fs.readdirSync(d).sort()) { const f = path.join(d, n), st = fs.lstatSync(f); h.update(`${path.relative(dir, f)}|${st.isSymbolicLink() ? 'l' : st.isDirectory() ? 'd' : 'f'}|${st.mode}|${st.mtimeMs}|`); if (st.isDirectory()) walk(f); else if (st.isFile()) h.update(fs.readFileSync(f)); } })(dir); return h.digest('hex'); };
    const browser = probe.browserReady();
    if (!browser.ok) console.log(`SKIP  the live-check parts need plugin-guard's own browser (${browser.reason}); those runs are made without a live check`);

    // ---- the "real site" for the live check: a tiny server on 127.0.0.1 (never a real site). /: per kind; anything else: a normal page ----
    const servers = [];
    async function serve(kind) {
        const hits = [];
        const page = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(`<!doctype html><html><head><title>${sites.SHOP}</title></head><body>${body}</body></html>`); };
        const server = http.createServer((req, res) => {
            const p = req.url.split('?')[0]; hits.push({ method: req.method, path: p });
            if (kind === 'loop' && p === '/') { res.writeHead(302, { Location: `http://127.0.0.1:${server.address().port}/` }); return res.end(); }
            if (kind === 'db') return page(res, 500, '<h1>Error establishing a database connection</h1>');
            return page(res, 200, `<h1>${sites.SHOP}</h1><p>Loose leaf teas, packed by hand.</p>`);
        });
        await new Promise(r => server.listen(0, '127.0.0.1', r)); servers.push(server);
        return { url: `http://127.0.0.1:${server.address().port}/`, hits };
    }

    // ---- the test copy, offline: the fake docker, and a stand-in for the copy's page loads that models the fixture's own PHP ----
    // The stand-in reads the fake docker's call log to know which plugins are switched on in the copy right now (fresh install: none; then every
    // `wp plugin activate` / `deactivate` the sandbox ran), and answers what that PHP does: rule(active) -> a page record like probe/worker.js writes.
    const vf = require('../issue/verify-fixes'), realVf = vf.run, realRun = probe.runSandbox;
    let nFake = 0;
    function fakeSandbox(pluginSlugs, rule) {
        const dir = path.join(tmp, `fake-${++nFake}`); fs.mkdirSync(dir, { recursive: true });
        fs.copyFileSync(path.join(__dirname, 'fixtures', 'issue', 'fake-docker.js'), path.join(dir, 'docker')); fs.chmodSync(path.join(dir, 'docker'), 0o755);
        const sbx = path.join(tmp, `sbx-${nFake}`); fs.mkdirSync(sbx, { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(dir, 'fake.json'), JSON.stringify({ wp: [{ match: 'plugin list', out: pluginSlugs.slice().sort().join('\n') + '\n' }, { match: 'theme list', out: 'twentytwentyfive\ntwentytwentyfour\n' }, { match: 'option get stylesheet', out: 'twentytwentyfive\n' }] }));
        const active = () => {
            const on = new Set();
            const lines = fs.existsSync(path.join(dir, 'fake.log')) ? fs.readFileSync(path.join(dir, 'fake.log'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
            for (const l of lines) {
                const at = l.args.indexOf('wp'); if (l.args[0] !== 'compose' || at < 0) continue;
                const t = l.args.slice(at + 1).filter(x => !x.startsWith('-'));
                if (t[0] === 'plugin' && t[1] === 'activate') t.slice(2).forEach(x => on.add(x));
                if (t[0] === 'plugin' && t[1] === 'deactivate') t.slice(2).forEach(x => on.delete(x));
            }
            return on;
        };
        const stand = async (id, o) => {
            const rec = { url: `${o.url}/`, viewport: { name: 'laptop', width: 1280, height: 800 }, console_errors: [], page_errors: [], error_responses: [], failed_requests: [], scroll: { doc_width: 1280, viewport_width: 1280 }, ...rule(active()) };
            return { ok: true, pages: [rec], status_codes: rec.status ? [rec.status] : [], oracle: { result: 'no' } };
        };
        const leftovers = () => { try { const s = JSON.parse(fs.readFileSync(path.join(dir, 'fake.state.json'), 'utf8')); return s.containers.length + s.volumes.length + s.networks.length; } catch { return 0; } };
        return { stand, leftovers, opts: { dockerBin: path.join(dir, 'docker'), sandboxesRoot: sbx, env: { PATH: process.env.PATH, HOME: process.env.HOME }, pageCheck: () => ({ status: 200 }) } };
    }
    const OK_PAGE = { loaded: true, status: 200, text: `${sites.SHOP} Loose leaf teas, packed by hand.` };

    // ---- one run of the plain wizard (flags only, as `plugin-guard --description ... --root ... --yes`) ----
    let nRun = 0;
    async function run(name, builder, { live = null, fake = null } = {}) {
        const root = path.join(tmp, `${name}-${++nRun}`, 'wp'), info = builder(root), before = hashTree(root);
        const out = path.join(tmp, `out-${name}-${nRun}`);
        const input = new PassThrough(), output = new PassThrough(); let text = ''; output.on('data', d => { text += d; }); input.end('');
        const saved = process.env.PLUGIN_GUARD_ISSUES, log = console.log; console.log = (...a) => { text += a.join(' ') + '\n'; };
        let error = null;
        if (fake) { probe.runSandbox = fake.stand; vf.run = async () => ({ steps: [], results: 0 }); }
        try {
            await wizard.run({ _: [], description: info.description, root, out, yes: true, viewports: 'laptop', ...(live ? { url: live.url, env: 'local' } : { 'no-probe': true }), ...(fake ? { sandbox: true } : {}) },
                { input, output, tty: false, cwd: tmp, env: { HOME: tmp }, preflight: () => ({ ok: !!fake }), siteRoots: [], ...(fake ? { sandboxOptions: fake.opts } : {}) });
        } catch (e) { error = e; } finally { console.log = log; probe.runSandbox = realRun; vf.run = realVf; if (saved === undefined) delete process.env.PLUGIN_GUARD_ISSUES; else process.env.PLUGIN_GUARD_ISSUES = saved; }
        const ids = fs.existsSync(out) ? fs.readdirSync(out).filter(x => store.ISSUE_RE.test(x)) : [];
        const idir = ids.length ? path.join(out, ids[0]) : null;
        const rd = rel => { try { return JSON.parse(fs.readFileSync(path.join(idir, rel), 'utf8')); } catch { return null; } };
        const rt = rel => { try { return fs.readFileSync(path.join(idir, rel), 'utf8'); } catch { return ''; } };
        const R = { info, root, idir, error, text, f: rd('result/findings.json'), md: rt('result/ISSUE-REPORT.md'), html: rt('result/issue.html'), bis: rd('work/bisect.json'), sbx: rd('work/sandbox.json'), probe: rd('work/probe.json'), copyCfg: rt('site-copy/wp-config.php') };
        ok(!error && !!R.f, `${name}: the wizard made its own copy of the site and wrote the report${error ? ` (${error.message})` : ''}`);
        ok(hashTree(root) === before, `${name}: the original site folder is unchanged (files, modes, times)`);
        if (fake) ok(fake.leftovers() === 0, `${name}: the fake test copy was torn down`);
        if (live) ok(live.hits.length > 0 && live.hits.every(h => h.method === 'GET'), `${name}: the live check reached the 127.0.0.1 stand-in with GET requests only (${live.hits.length})`);
        return R;
    }
    const liveOr = async kind => (browser.ok ? serve(kind) : null);

    // ============================================================ 0. the wording for a page that redirects to itself (owner, 2026-11-12; gate-on case file only)
    group('0. a page that redirects to itself is a live check that ran (wording only)');
    {
        const caseFile = require('../issue/case-file');
        const mkF = () => ({ issue: { title: 'Home page loops', id: 'iss-x' }, issue_title_short: 'Home page loops', hypotheses: [], findings: [], likely: [], advisories: [], reported: { images: [] }, checkpoints: null });
        const U = 'http://127.0.0.1:9/', vp = { name: 'laptop', width: 1280 };
        const LOOP = { url: U, viewport: vp, loaded: false, status: 0, error: `page.goto: net::ERR_TOO_MANY_REDIRECTS at ${U}` };
        const build = (pages, probeRan) => caseFile.build(mkF(), { comps: [], facts: { hasLog: false, hasCode: true, probeRan }, issueUrl: U, probePages: pages });
        const text = cf => `${caseFile.markdown(cf, t => String(t)).join('\n')}\n${caseFile.cli(cf)}`;
        const l = build([LOOP, { ...LOOP, viewport: { name: 'mobile', width: 390 } }], false), lt = text(l);
        ok(JSON.stringify(l.see) === JSON.stringify(['The page / redirects to itself, so it never loads.']), `the loop: "What you see" is exactly the owner sentence, once for two screen sizes (${JSON.stringify(l.see)})`);
        ok(l.status.looked.startsWith('Looked at: the live page (it redirects to itself), the code.') && !/Not looked at:[^.]*the live page/.test(l.status.looked), `STATUS: "${l.status.looked}"`);
        ok(!lt.includes('No live check was run, so nothing was seen on the live page.') && !lt.includes(FINE) && !/\b5xx\b|HTTP 5\d\d|server error/i.test(lt), 'the loop: never "No live check was run", "did not answer with an error", 5xx or server error');
        const sub = build([{ ...LOOP, url: `${U}shop/?a=1` }], false);
        ok(sub.see[0] === 'The page /shop redirects to itself, so it never loads.', `the path comes from pathText (no query): "${sub.see[0]}"`);
        const both = build([LOOP, { url: `${U}about/`, viewport: vp, loaded: true, status: 200 }], true);
        ok(both.see.includes('The page / redirects to itself, so it never loads.') && !both.see.some(x => x.includes(FINE)) && both.status.looked.startsWith('Looked at: the live page, the code.'), 'a loop next to a page that loaded: the loop sentence, no "did not answer with an error", "the live page" as before');
        const fine = build([{ url: U, viewport: vp, loaded: true, status: 200 }], true);
        ok(JSON.stringify(fine.see) === JSON.stringify(['The live pages that were loaded did not answer with an error.']) && fine.status.looked.startsWith('Looked at: the live page, the code.'), 'a normal loaded page: unchanged');
        const four = build([{ url: U, viewport: vp, loaded: true, status: 404 }], true);
        ok(JSON.stringify(four.see) === JSON.stringify([caseFile.addressSentence(404)]), 'a 4xx page: unchanged (the address sentence)');
        const tout = build([{ url: U, viewport: vp, loaded: false, status: 0, error: 'page.goto: Timeout 45000ms exceeded' }], false);
        ok(JSON.stringify(tout.see) === JSON.stringify(['No live check was run, so nothing was seen on the live page.']) && /Not looked at: [^.]*the live page/.test(tout.status.looked), 'a failed load that is not a loop (a timeout): unchanged');
        const chain = build([{ url: U, viewport: vp, loaded: true, status: 200, redirects: [U, `${U}a/`, U, `${U}b/`] }], true);
        ok(!chain.see.some(x => /redirects to itself/.test(x)), 'a page that loaded after a chain is not called a self-redirect');
        ok(caseFile.lookedAt({ hasLog: true, hasCode: true, probeRan: false }).line === 'Looked at: your log, the code. Not looked at: the live page, a throwaway test copy.', 'lookedAt without the new option: unchanged');
    }

    // ============================================================ 1. PLUGIN PAIR
    group('1. plugin pair: two plugins that only fail together');
    {
        const R0 = await run('pair-static', sites.pluginPair);
        pairChecks(R0, ok, { info: R0.info, label: 'pair, no test copy', bisectRan: false });
        const probeInfo = sites.pluginPair(path.join(tmp, 'pair-probe-info'));
        const F = fakeSandbox([...probeInfo.pair, ...probeInfo.innocent], on => (probeInfo.pair.every(s => on.has(s)) ? { loaded: true, status: 500, text: 'The price badge could not be built.' } : OK_PAGE));
        const R1 = await run('pair-copy', sites.pluginPair, { fake: F });
        ok(R1.bis !== null, `pair, test copy: a bisection ran (${R1.bis ? `${R1.bis.status}, ${R1.bis.loads} loads` : 'no bisect.json'})`);
        pairChecks(R1, ok, { info: R1.info, label: 'pair, test copy (offline stand-in)', bisectRan: true });
    }

    // ============================================================ 2. HEALTHY SITE
    group('2. healthy site: nothing is wrong');
    {
        const live = await liveOr('ok');
        const R0 = await run('healthy-live', sites.healthy, { live });
        healthyChecks(R0, ok, { label: 'healthy, live check', probeRan: !!live });
        const hInfo = sites.healthy(path.join(tmp, 'healthy-info'));
        const F = fakeSandbox(hInfo.plugins, () => OK_PAGE);
        const R1 = await run('healthy-copy', sites.healthy, { live: await liveOr('ok'), fake: F });
        healthyChecks(R1, ok, { label: 'healthy, live check and test copy (offline stand-in)', probeRan: browser.ok });
        ok(R1.sbx && R1.sbx.reproduced_in_sandbox === 'no' && !R1.bis, `healthy, test copy: the copy did not show a problem and nothing was bisected (reproduced_in_sandbox ${R1.sbx && JSON.stringify(R1.sbx.reproduced_in_sandbox)})`);
    }

    // ============================================================ 3. REDIRECT LOOP by a plugin
    group('3. redirect loop made by a plugin (template_redirect -> the home page itself)');
    {
        const live = await liveOr('loop');
        const R0 = await run('redirect-live', sites.pluginRedirect, { live });
        if (live) {
            const loop = ((R0.probe && R0.probe.pages) || []).find(p => /ERR_TOO_MANY_REDIRECTS/.test(p.error || ''));
            ok(!!loop && loop.loaded === false, `redirect, live check: the probe recorded the loop as the browser records it (loaded=false, ${loop ? loop.error.slice(0, 60) : 'no ERR_TOO_MANY_REDIRECTS page'})`);
        }
        redirectChecks(R0, ok, { info: R0.info, label: 'redirect, live check, no test copy' });
        const rInfo = sites.pluginRedirect(path.join(tmp, 'redirect-info'));
        const F = fakeSandbox([rInfo.plugin, ...rInfo.innocent], on => (on.has(rInfo.plugin) ? { loaded: false, status: 0, error: 'page.goto: net::ERR_TOO_MANY_REDIRECTS at http://127.0.0.1:38080/' } : OK_PAGE));
        const R1 = await run('redirect-copy', sites.pluginRedirect, { live: await liveOr('loop'), fake: F });
        ok(R1.bis !== null, `redirect, test copy: a bisection ran (${R1.bis ? `${R1.bis.status}: ${JSON.stringify(R1.bis.causes.map(c => c.plugins))}` : 'no bisect.json'})`);
        redirectChecks(R1, ok, { info: R1.info, label: 'redirect, live check and test copy (offline stand-in)' });
    }

    // ============================================================ 4. DATABASE ERROR
    group('4a. how the copies treat the database constants (code facts the case-4 expectation rests on)');
    {
        const KEEP = require('../lib/wp-config-redact').KEEP;
        ok(!['DB_NAME', 'DB_USER', 'DB_PASSWORD', 'DB_HOST'].some(k => KEEP.has(k)), 'lib/wp-config-redact.js: no DB_* constant is on the allow-list of the wizard\'s copy');
        const cfgText = require('../issue/sandbox-config').wpConfig({ creds: { name: 'n1', user: 'u1', pass: 'p1' } });
        ok(cfgText.includes("define( 'DB_HOST', 'db:3306' );") && cfgText.includes("define( 'DB_USER', 'u1' );") && /nothing in it comes from the original/.test(cfgText), 'issue/sandbox-config.js: the test copy gets a FRESH wp-config.php, its own credentials and DB_HOST db:3306');
        const r = path.join(tmp, 'db-facts', 'wp'); sites.dbError(r);
        const sbDir = path.join(tmp, 'db-facts-sbx'); fs.mkdirSync(sbDir, { recursive: true, mode: 0o700 });
        require('../issue/sandbox-copy').copySite(r, path.join(sbDir, 'site'), { sandboxDir: sbDir });
        ok(!fs.existsSync(path.join(sbDir, 'site', 'wp-config.php')), 'issue/sandbox-copy.js: the site\'s wp-config.php is never copied into a test copy');
        ok(/wp-config\.php'\), cfg\.wpConfig\(/.test(fs.readFileSync(path.join(__dirname, '..', 'issue', 'sandbox.js'), 'utf8')), 'issue/sandbox.js writes the generated wp-config.php into the test copy');
    }
    group('4. database error: wrong credentials in wp-config.php');
    {
        const live = await liveOr('db');
        const R0 = await run('db-live', sites.dbError, { live });
        ok(R0.copyCfg && !/DB_(NAME|USER|PASSWORD|HOST)/.test(R0.copyCfg) && !R0.copyCfg.includes('wrong-fixture-pass-after-move') && !R0.copyCfg.includes('db.larkspur.invalid'), 'db: the tool-made copy\'s wp-config.php has no database setting (so the wrong credentials cannot reach any copy)');
        dbChecks(R0, ok, { info: R0.info, label: 'db, live check, no test copy' });
        const dInfo = sites.dbError(path.join(tmp, 'db-info'));
        const F = fakeSandbox(dInfo.plugins, () => OK_PAGE);   // the copy runs with its own fresh database settings: its pages load
        const R1 = await run('db-copy', sites.dbError, { live: await liveOr('db'), fake: F });
        dbChecks(R1, ok, { info: R1.info, label: 'db, live check and test copy (offline stand-in)' });
    }

    for (const s of servers) s.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
    process.exit(failures ? 1 : 0);
}
