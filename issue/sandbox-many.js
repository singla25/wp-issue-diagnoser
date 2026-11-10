// ONE sandbox for SEVERAL issues (`guard:auto`). The expensive part of a bisection is loading pages with a plugin set applied. Here a plugin set is
// applied once and the union of every issue's pages and screen sizes is loaded once; the observation is cached by the hash of the set, and each
// issue's own oracle is evaluated on the cached observation. So issue 2 and issue 3 reuse the page loads that issue 1's bisection already did.
// Every sandbox safeguard is the single-issue one: the same sandbox.create() (rootless-aware preflight, digest-pinned images, policy-validated
// specification, SandboxWpCli path checks, anonymised database when a dump is given) and a teardown that always runs.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('../lib/issue-store');
const sandbox = require('./sandbox');
const probe = require('./probe');
const bisect = require('./bisect');
const oracleMod = require('./oracle');
const phase = require('./sandbox-phase');
const { WpCli } = require('../lib/wpcli');
const readdir = require('../lib/sorted-dir');

const { step, names, pluginFolders, makeApplier } = phase;
const MAX_UNION_PAGES = 12;
const vpName = p => (p.viewport && p.viewport.name) || p.viewport;
const pathOf = u => { try { const x = new URL(u); return x.pathname + x.search; } catch { return String(u); } };

async function runMany(ids, { root, options = {}, env = process.env, sandboxOptions = {}, components = [], top = [], observe = probe.observeSandbox } = {}) {
    const out = { steps: [], sandbox: null, per: {}, shared: { page_loads: 0, cache_hits: 0, sets: 0, issues: ids.length }, unavailable: null };
    const issues = ids.map(id => store.load(id));
    // a LIVE site is never copied with its database (sandbox-phase.js LIVE_NO_DB): with any live issue the database file is not used
    const liveDb = issues.some(i => i.environment === 'live') && !!(options.dump || options.exportDb);
    if (liveDb) { options = { ...options, dump: undefined, exportDb: false }; out.steps.push(phase.liveDbStep()); }
    // TEST-COPY-SPEC 6d-2: with a database file every issue gets the fidelity check (issue/fidelity.js); the same producer rule as sandbox-phase.js:
    // unless the copy matched (or showed the same kind of failure), reproduced_in_sandbox stays null and the issue is not bisected
    const fid = require('./fidelity'), dbIntent = !!(options.dump || options.exportDb);
    if (dbIntent) for (const id of ids) phase.removeFidelity(store.dirOf(id));
    const fidelityFor = (id, copy) => { const issue = issues.find(i => i.id === id), dir = store.dirOf(id), fd = fid.compare({ real: phase.realSide(dir, issue), copy }); phase.writeFidelity(dir, fd); return fd; };
    const none = (reason, copy = { error: reason }) => { out.unavailable = reason; for (const id of ids) { out.per[id] = { reproduced_in_sandbox: null, bisect: null, baseline: null, steps: [step('sandbox', 'Sandbox (throwaway copy in Docker)', 'NOT_RUN', reason)] }; if (dbIntent) { const fd = fidelityFor(id, copy); out.per[id].fidelity = fd; out.per[id].steps.push(phase.fidelityStep(fd)); } } return out; };
    if (!ids.length) return none('there is no issue to test');
    if (!root) return none('a local copy of the site (--root) is needed', { built: false });
    const pf = sandbox.preflight(sandboxOptions);
    if (!pf.ok) return none(`${pf.reason} Static-only mode: not reproduced, sandbox unavailable.`, { error: pf.reason });

    let handle; const t0 = Date.now();
    try {
        const so = { ...sandboxOptions, root, dump: options.dump, neutralisePayments: !!options.neutralisePayments, withUploads: !!options.withUploads, maxMb: options.maxSizeMb ? Number(options.maxSizeMb) : undefined };
        if (options.exportDb && !options.dump) so.exportDatabase = file => new WpCli({ path: root }).exportDatabase(file, sandbox.sandboxesRoot());
        handle = sandbox.create(store.newId('auto-run'), so);
        for (const s of handle.steps) out.steps.push(step(`sandbox-${s.id}`, `Sandbox: ${s.id}`, s.status, s.reason));
        for (const w of handle.warnings) out.steps.push(step('sandbox-warning', 'Sandbox warning', 'PASSED', `WARNING: ${w}`));
        const policy = require('./sandbox-policy');
        out.steps.push(step('sandbox-notice', 'Sandbox: what is NOT blocked', 'PASSED', `NOTICE: ${handle.topology === 'proxied' ? policy.NOTICE_DUMP : policy.NOTICE} ${policy.RECOMMENDATION}`));
        out.sandbox = { url: handle.url, project: handle.project, anonymised: handle.anonymised, unscrubbed_tables: handle.tables_unscrubbed, limits: handle.limits, notice: policy.NOTICE, recommendation: policy.RECOMMENDATION, copy: { files: handle.copy.files, symlinks_skipped: handle.copy.symlinks_skipped, skipped_by_reason: handle.copy.skipped_by_reason } };

        // ---- plugins, in a fixed order ----
        const slugs = new Set([...components.filter(c => c.kind === 'plugin').map(c => c.slug), ...pluginFolders(path.join(handle.dir, 'site', 'wp-content', 'plugins'))]);
        // TEST-COPY-SPEC 6d-1: a build from a database file never switches plugins on to start with (sandbox-phase.js isDbBuild / baselineSet)
        const fresh = !phase.isDbBuild(handle) && handle.steps.find(s => s.id === 'database' && /fresh WordPress install/.test(s.reason || ''));
        if (fresh) { const all = [...slugs].sort(); if (all.length) { const r = handle.wp.run(['plugin', 'activate', ...all]); if (!r.ok) { const why = r.stderr.trim().split('\n')[0]; out.could_not_run = `the plugins of your site could not be switched on in it: ${why.slice(0, 160)}`; out.steps.push(step('sandbox-activate', 'Sandbox: activate the plugins of the copy', 'FAILED', why)); } } }
        const active = phase.baselineSet(handle, names(handle.wp.run(['plugin', 'list', '--status=active', '--field=name'])).sort());
        // the active plugins of the real site vs the copy (read by sandbox.js from the imported database): into every issue's own work folder
        for (const id of ids) { const d = store.dirOf(id); if (handle.active_plugins) sandbox.writeActivePlugins(d, handle.active_plugins); else sandbox.removeActivePlugins(d); }
        const requires = {};
        for (const p of active) { const c = components.find(x => x.kind === 'plugin' && x.slug === p); if (!c) continue; requires[p] = [...new Set([...(c.requires_plugins || []), ...(c.implied || []).filter(i => !i.soft).map(i => i.slug)])].filter(d => active.includes(d) && d !== p).sort(); }
        const themes = names(handle.wp.run(['theme', 'list', '--field=name'])).sort();
        const siteTheme = names(handle.wp.run(['option', 'get', 'stylesheet']))[0] || null;
        const defaultTheme = themes.filter(t => /^twenty/.test(t) && t !== siteTheme).sort().pop() || null;
        const muDirAbs = path.join(handle.dir, 'site', 'wp-content', 'mu-plugins');
        const muAll = (fs.existsSync(muDirAbs) ? readdir(muDirAbs).filter(f => f.endsWith('.php') && f !== 'pg-sandbox-guard.php').map(f => f.replace(/\.php$/, '')) : []);
        const apply = makeApplier({ handle, plugins: active, requires, defaultTheme, siteTheme, muAll });

        // ---- the union of what every issue loads, and the shared cache of observations ----
        const base = probe.sandboxBase(handle.url);
        const pageSet = []; for (const i of issues) for (const p of (i.pages.length ? i.pages : ['/'])) { const q = /^https?:/.test(p) ? pathOf(p) : p; if (!pageSet.includes(q) && pageSet.length < MAX_UNION_PAGES) pageSet.push(q); }
        const pages = probe.absPages(pageSet, base, MAX_UNION_PAGES);
        const vpAll = new Map(); for (const i of issues) for (const v of probe.viewportsFor(i.oracle, options)) vpAll.set(v.name, v);
        const vp = [...vpAll.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
        const cache = new Map(), logAbs = path.join(handle.dir, 'logs', 'debug.log');
        const hashOf = s => crypto.createHash('sha256').update(JSON.stringify([s.plugins, s.theme, s.mu])).digest('hex').slice(0, 12);
        async function observed(set) {
            const h = hashOf(set);
            if (cache.has(h)) { out.shared.cache_hits++; return cache.get(h); }
            let r;
            if (apply(set) === 'unresolved') r = { ok: false, unresolved: true, reason: 'no default theme in the sandbox' };
            else {
                // 'Same fatal required': the new fatals in the copy's log while THIS set loaded, kept with the cached observation (shared by every issue)
                let size = 0; try { size = fs.statSync(logAbs).size; } catch { /* no log yet */ }
                out.shared.page_loads++; r = await observe({ base, pages, vp, stateDir: path.join(handle.dir, 'probe'), tag: `s${out.shared.page_loads}`, env, options: {} });
                let grown = ''; try { const st = fs.statSync(logAbs), len = Math.max(0, Math.min(st.size - size, 256 * 1024)), b = Buffer.alloc(len), fd = fs.openSync(logAbs, 'r'); try { fs.readSync(fd, b, 0, len, size); } finally { fs.closeSync(fd); } grown = b.toString('utf8'); } catch { /* no log */ }
                if (r && typeof r === 'object') r.pg_fatals = phase.fatalsOfText(grown);
            }
            cache.set(h, r); out.shared.sets = cache.size;
            return r;
        }
        const wantedPages = i => new Set((i.pages.length ? i.pages : ['/']).map(p => (/^https?:/.test(p) ? pathOf(p) : p)));
        function testFor(issue, last) {
            const want = wantedPages(issue), vps = new Set(probe.viewportsFor(issue.oracle, options).map(v => v.name));
            last.history = [];
            return async set => {
                const o = await observed(set);
                last.history.push({ fatals: (o && o.pg_fatals) || [], five: !!(o && o.ok && (o.pagesFull || []).some(p => want.has(pathOf(p.url)) && vps.has(vpName(p)) && Number(p.reused_status || p.status) >= 500)) });
                if (!o.ok) { last.v = null; last.obs = null; last.err = o.unresolved ? 'the test copy could not be set up for the test' : `the pages of the test copy could not be loaded${o.reason ? `: ${o.reason}` : ''}`; return 'unresolved'; }
                const sub = o.pagesFull.filter(p => want.has(pathOf(p.url)) && vps.has(vpName(p)));
                last.obs = sub; last.err = null;   // 6d-2: the observed pages (status, text) for the fidelity check of the baseline
                const res = oracleMod.evaluate(issue.oracle, { pages: sub, planned: want.size * vps.size, protection: o.protection, sandbox: true, logged_in: false }, { needsLogin: false, symptom: issue.symptom });
                last.v = { result: res.result, matches: res.matches || [], pages: sub.map(p => ({ url: p.url, viewport: vpName(p), loaded: !!p.loaded })) };
                if (res.result === 'yes') return 'fail';
                if (res.result === 'could-not-test') return 'unresolved';
                if (!['http-5xx', 'generic'].includes(issue.oracle.type) && (sub.some(p => (p.reused_status || p.status) >= 500) || sub.some(p => /There has been a critical error|Fatal error|Parse error/i.test(p.text || '')))) return 'unresolved';
                return 'pass';
            };
        }

        // ---- each issue: does the sandbox show the symptom, and if so which plugins cause it ----
        // a FIXED cap per issue (so bisect.json is reproducible), and one limit for the whole run
        const capMs = options.maxMinutes ? Number(options.maxMinutes) * 60000 : 15 * 60000, totalMs = capMs * 3;
        const dbBuild = phase.isDbBuild(handle);
        let copyLog = null;   // the copy's own log, read ONCE right after the first baseline load (before any bisection switched plugins off)
        for (const issue of issues) {
            const id = issue.id, dir = store.dirOf(id), steps = [], last = {};
            const test = testFor(issue, last);
            if (Date.now() - t0 > totalMs) { const r0 = { reproduced_in_sandbox: null, bisect: null, baseline: null, steps: [step('sandbox', 'Sandbox test', 'NOT_RUN', `the time limit for the whole run (${Math.round(totalMs / 60000)} minutes) was reached before this issue`)] }; out.per[id] = r0; continue; }
            const res = { reproduced_in_sandbox: null, bisect: null, baseline: null };
            try {
                if (out.could_not_run) {   // no evidence either way (see sandbox-phase.js): reproduced_in_sandbox stays null
                    res.could_not_run = out.could_not_run;
                    steps.push(step('sandbox-oracle', 'Oracle in the sandbox: is the symptom present?', 'NOT_RUN', `not run: ${out.could_not_run}. This is no evidence either way.`));
                    steps.push(step('bisect', 'Bisection', 'NOT_RUN', 'the sandbox could not activate the plugins, so there is nothing to bisect'));
                } else {
                const base0 = await test({ plugins: active, theme: null, mu: null });
                const raw = base0 === 'fail' ? 'yes' : base0 === 'pass' ? 'no' : 'could-not-test';
                if (dbBuild && !copyLog) copyLog = phase.readCopyLog(path.join(handle.dir, 'logs', 'debug.log'), { secrets: handle.test_login ? [handle.test_login.password] : [] });
                if (dbBuild) res.fidelity = fidelityFor(id, fid.copyFrom({ pages: last.obs, copyLog, error: last.obs ? null : last.err || 'the pages of the test copy could not be loaded' }));
                const use = !res.fidelity || res.fidelity.counts;
                res.reproduced_in_sandbox = use ? raw : null;
                res.baseline = last.v ? { ...last.v, active_plugins: [...active] } : null;
                steps.push(step('sandbox-oracle', 'Oracle in the sandbox: is the symptom present?', base0 === 'unresolved' ? 'NOT_RUN' : 'PASSED', `symptom reproduced in the sandbox: ${raw}${use && base0 === 'pass' ? '. NOT reproduced: every hypothesis stays PROBABLE_NEEDS_REVIEW or below, nothing can be REPRODUCIBLE.' : ''}${use ? '' : '. Not used as evidence: the test copy did not show the same problem as your site (see the fidelity step)'}`));
                if (res.fidelity) steps.push(phase.fidelityStep(res.fidelity));
                if (base0 === 'fail' && !use) steps.push(step('bisect', 'Bisection', 'NOT_RUN', 'the test copy did not show the same problem as your site, so it is not bisected and nothing from it is used'));
                else if (base0 === 'fail' && !options.noBisect) {
                    const k0 = last.history.length;
                    const b = await bisect.run({ plugins: active, requires, mu: muAll, top, test, caps: { maxLoads: Number(options.maxLoads) || undefined, maxMs: capMs }, logFile: path.join(dir, 'work', 'bisect.log'), label: { oracle: issue.oracle.type },
                        bareCheck: phase.bareCheckFor(last.history, { oracleType: issue.oracle.type, cause: phase.realSide(dir, issue).cause_fatal }) });
                    phase.annotateBisect(b, { steps: last.history.slice(k0) });
                    fs.writeFileSync(path.join(dir, 'work', 'bisect.json'), JSON.stringify({ ...b, log: undefined }, null, 2) + '\n', { mode: 0o600 });
                    res.bisect = b;
                    steps.push(step('bisect', 'Bisection (delta debugging in the sandbox)', b.status === 'not-reproduced-at-start' ? 'NOT_RUN' : 'PASSED',
                        `${phase.bisectBanner(b)}${b.status}: ${phase.bisectCause(b)}; ${b.loads} tests, ${b.cache_hits} from this issue's cache${b.capped ? `; STOPPED by the ${b.capped} cap, so the result is not proven minimal` : ''}; log in work/bisect.log`));
                } else steps.push(step('bisect', 'Bisection', 'NOT_RUN', options.noBisect ? 'switched off' : base0 === 'pass' ? 'the symptom is not present in the sandbox, so there is nothing to bisect' : 'the symptom could not be evaluated in the sandbox'));
                }
            } catch (e) {
                steps.push(step('sandbox', 'Sandbox test', 'FAILED', String(e.message).split('\n')[0].slice(0, 300)));
                if (dbIntent && !res.fidelity) { res.reproduced_in_sandbox = null; res.fidelity = fidelityFor(id, { error: e.message }); steps.push(phase.fidelityStep(res.fidelity)); }
            }
            res.steps = steps;
            fs.writeFileSync(path.join(dir, 'work', 'sandbox.json'), JSON.stringify({ steps: [...out.steps, ...steps], sandbox: out.sandbox, could_not_run: res.could_not_run || undefined, reproduced_in_sandbox: res.reproduced_in_sandbox, baseline: res.baseline, shared: out.shared, fidelity: res.fidelity || undefined }, null, 2) + '\n', { mode: 0o600 });
            out.per[id] = res;
        }
    } catch (e) {
        out.steps.push(step('sandbox', 'Sandbox (throwaway copy in Docker)', e.name === 'SandboxRefusal' || e.name === 'SandboxUnavailable' ? 'BLOCKED' : 'FAILED', String(e.message).replace(/\s*\n\s*/g, ' ').slice(0, 600)));
        for (const id of ids) if (!out.per[id]) { out.per[id] = { reproduced_in_sandbox: null, bisect: null, baseline: null, steps: [step('sandbox', 'Sandbox (throwaway copy in Docker)', 'NOT_RUN', 'the sandbox did not start or failed')] }; if (dbIntent) { const fd = fidelityFor(id, { error: e.message }); out.per[id].fidelity = fd; out.per[id].steps.push(phase.fidelityStep(fd)); } }
    } finally {
        if (handle) {
            const rep = handle.destroy();
            out.steps.push(step('sandbox-teardown', 'Sandbox: teardown', rep.leftovers.length ? 'FAILED' : 'PASSED', rep.leftovers.length ? `LEFTOVERS: ${rep.leftovers.join(', ')} (run: issue sandbox sweep)` : 'containers, volumes, networks and the sandbox folder were removed'));
        }
    }
    // every issue's sandbox.json is written last, so it holds the shared steps including the teardown
    for (const id of ids) { const r = out.per[id]; try { fs.writeFileSync(path.join(store.dirOf(id), 'work', 'sandbox.json'), JSON.stringify({ steps: [...out.steps, ...((r && r.steps) || [])], sandbox: out.sandbox, reproduced_in_sandbox: r ? r.reproduced_in_sandbox : null, baseline: r ? r.baseline : null, shared: out.shared, fidelity: (r && r.fidelity) || undefined }, null, 2) + '\n', { mode: 0o600 }); } catch { /* work folder missing */ } }
    return out;
}
module.exports = { runMany };
