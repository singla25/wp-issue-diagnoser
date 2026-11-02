// Phase G for one issue: reproduce the symptom in a throwaway sandbox and bisect it. Everything that changes anything happens in the sandbox
// (a copy, in Docker); the original site is only read. The sandbox is destroyed when this returns, however it returns.
//
//   no Docker / no permission / no images  -> static-only mode: every step says NOT_RUN with the reason, the hypotheses stay as they were
//   Docker ok                              -> create sandbox -> baseline oracle -> bisection (unless --no-bisect) -> destroy

const fs = require('fs');
const readdir = require('../lib/sorted-dir');
const path = require('path');
const store = require('../lib/issue-store');
const sandbox = require('./sandbox');
const policy = require('./sandbox-policy');
const probe = require('./probe');
const bisect = require('./bisect');
const { WpCli } = require('../lib/wpcli');

const step = (id, label, status, reason = null, extra = {}) => ({ ...extra, id, label, status, reason });
const names = r => (r.ok ? r.stdout.split('\n').map(s => s.trim()).filter(Boolean) : []);

// Applies a set to the running sandbox, changing only what differs from the current state. -> apply(set): true, or 'unresolved' when it cannot be applied
function makeApplier({ handle, plugins, requires, defaultTheme, siteTheme, muAll }) {
    const wp = handle.wp;
    const state = { plugins: null, theme: null, mu: null };
    const topo = set => { const done = [], seen = new Set(); const visit = p => { if (seen.has(p)) return; seen.add(p); for (const d of requires[p] || []) if (set.includes(d)) visit(d); done.push(p); }; for (const p of set) visit(p); return done; };
    const muDir = path.join(handle.dir, 'site', 'wp-content', 'mu-plugins');
    const must = (r, what) => { if (!r.ok) throw new Error(`${what} failed in the sandbox: ${r.stderr.trim().split('\n')[0]}`); };
    return function apply(set) {
        // ---- plugins ----
        const want = set.plugins;
        const have = state.plugins === null ? names(wp.run(['plugin', 'list', '--status=active', '--field=name'])) : state.plugins;
        const off = topo(have).reverse().filter(p => !want.includes(p)), on = topo(want).filter(p => !have.includes(p));
        if (off.length) must(wp.run(['plugin', 'deactivate', ...off]), 'deactivating plugins');
        if (on.length) must(wp.run(['plugin', 'activate', ...on]), `activating ${on.join(', ')}`);
        state.plugins = [...want];
        // ---- theme ----
        const theme = set.theme === null ? siteTheme : defaultTheme;
        if (theme && state.theme !== theme) { must(wp.run(['theme', 'activate', theme]), `activating theme ${theme}`); state.theme = theme; }
        else if (!theme) return 'unresolved';   // no default theme in the sandbox: this set cannot be tested
        // ---- must-use plugins: renamed inside the sandbox copy (a host file operation, confined to the sandbox folder) ----
        const wantMu = set.mu === null ? muAll : set.mu;
        for (const f of muAll) {
            const on_ = path.join(muDir, `${f}.php`), off_ = path.join(muDir, `${f}.php.off`);
            if (path.dirname(on_) !== muDir || !/^[A-Za-z0-9._-]+$/.test(f)) throw new Error(`unsafe must-use plugin name ${f}`);
            if (wantMu.includes(f) && fs.existsSync(off_)) fs.renameSync(off_, on_);
            else if (!wantMu.includes(f) && fs.existsSync(on_)) fs.renameSync(on_, off_);
        }
        return true;
    };
}

// Applies a set to the running sandbox, loads the pages and evaluates the oracle of ONE issue.
function makeTester({ handle, issueId, env, plugins, requires, defaultTheme, siteTheme, muAll, login, options, log = () => {} }) {
    const wp = handle.wp;
    const apply = makeApplier({ handle, plugins, requires, defaultTheme, siteTheme, muAll });
    const logFile = path.join(handle.dir, 'logs', 'debug.log');
    let n = 0;
    return async function test(set) {
        if (apply(set) === 'unresolved') return 'unresolved';
        // ---- run the oracle ----
        let size = 0; try { size = fs.statSync(logFile).size; } catch { /* no log yet */ }
        n++;
        const r = await probe.runSandbox(issueId, { url: handle.url, stateDir: path.join(handle.dir, 'probe'), tag: `t${n}`, env, login, options: { ...options } });
        if (!r.ok) { log(`probe failed: ${r.reason}`); return 'unresolved'; }
        let growth = null; try { const st = fs.statSync(logFile); const fd = fs.openSync(logFile, 'r'); const len = Math.min(st.size - size, 256 * 1024), b = Buffer.alloc(Math.max(0, len)); fs.readSync(fd, b, 0, b.length, size); fs.closeSync(fd); growth = { available: true, new_text: b.toString('utf8') }; } catch { growth = { available: false, reason: 'no debug.log in the sandbox yet' }; }
        const issue = store.load(issueId);
        const res = issue.oracle.type === 'debug-log' || issue.oracle.type === 'generic' ? require('./oracle').evaluate(issue.oracle, { pages: r.pages.map(p => ({ ...p, console_errors: p.console_errors || [], page_errors: p.page_errors || [], error_responses: p.error_responses || [] })), planned: r.pages.length, sandbox: true, logged_in: !!(r.login && r.login.ok), debug_log: growth }, { needsLogin: issue.needs_login, symptom: issue.symptom }) : r.oracle;
        if (r.pages.some(p => require('./oracle').redirectSigns(p).length)) test.redirectSeen = true;   // a redirect loop, a long chain or a cross-host redirect in the sandbox
        test.last = { result: res.result, matches: res.matches || [], pages: r.pages.map(p => ({ url: p.url, viewport: p.viewport && p.viewport.name, loaded: !!p.loaded })) };
        if (res.result === 'yes') return 'fail';
        if (res.result === 'could-not-test') return 'unresolved';
        // the symptom is absent, but the page may be broken some OTHER way (a fatal error, a 500): that says nothing about this symptom
        if (!['http-5xx', 'debug-log', 'generic'].includes(issue.oracle.type) && (r.status_codes.some(s => s >= 500) || r.fatal_text)) return 'unresolved';
        return 'pass';
    };
}

// top-level plugin folders that contain a PHP file with a "Plugin Name:" header (sorted: a fixed order)
function pluginFolders(dir) {
    let names = []; try { names = readdir(dir, { withFileTypes: true }).filter(e => e.isDirectory() && /^[A-Za-z0-9._-]+$/.test(e.name)).map(e => e.name).sort(); } catch { return []; }
    return names.filter(n => { try { return readdir(path.join(dir, n)).filter(f => f.endsWith('.php')).some(f => { const fd = fs.openSync(path.join(dir, n, f), 'r'); try { const b = Buffer.alloc(8192), k = fs.readSync(fd, b, 0, 8192, 0); return /Plugin Name:/i.test(b.toString('utf8', 0, k)); } finally { fs.closeSync(fd); } }); } catch { return false; } });
}

// o: { root, options: { sandbox, dump, exportDb, keepRealData, neutralisePayments, withUploads, maxSizeMb, keepSandbox, maxLoads, maxMinutes, noBisect }, analysis, env }
async function run(id, o) {
    const issue = store.load(id), dir = store.dirOf(id), opt = o.options || {}, steps = [];
    const out = { steps, bisect: null, sandbox: null, reproduced_in_sandbox: null };
    const done = () => { if (o.noWrite) return out; try { fs.writeFileSync(path.join(dir, 'work', 'sandbox.json'), JSON.stringify({ steps, sandbox: out.sandbox, could_not_run: out.could_not_run || undefined, reproduced_in_sandbox: out.reproduced_in_sandbox, baseline: out.baseline || null, redirect_observed: !!out.redirect_observed }, null, 2) + '\n', { mode: 0o600 }); } catch { /* work folder missing */ } return out; };
    if (!opt.sandbox) { steps.push(step('sandbox', 'Sandbox (throwaway copy in Docker)', 'NOT_RUN', 'not requested: add --sandbox (needs Docker and a local copy of the site)')); return done(); }
    if (!o.root) { steps.push(step('sandbox', 'Sandbox (throwaway copy in Docker)', 'NOT_RUN', 'a local copy of the site (--root) is needed')); return done(); }
    const pf = sandbox.preflight(o.sandboxOptions || {});
    if (!pf.ok) { steps.push(step('sandbox', 'Sandbox (throwaway copy in Docker)', 'NOT_RUN', `${pf.reason} Static-only mode: not reproduced, sandbox unavailable; every hypothesis stays UNVERIFIED or PROBABLE_NEEDS_REVIEW.`), step('bisect', 'Bisection', 'NOT_RUN', 'needs the sandbox')); return done(); }

    let handle;
    try {
        const so = { ...(o.sandboxOptions || {}), root: o.root, dump: opt.dump, keepRealData: !!opt.keepRealData, neutralisePayments: !!opt.neutralisePayments, withUploads: !!opt.withUploads, maxMb: opt.maxSizeMb ? Number(opt.maxSizeMb) : undefined };
        if (opt.exportDb && !opt.dump) so.exportDatabase = file => new WpCli({ path: o.root }).exportDatabase(file, sandbox.sandboxesRoot());
        handle = sandbox.create(id, so);
        for (const s of handle.steps) steps.push(step(`sandbox-${s.id}`, `Sandbox: ${s.id}`, s.status, s.reason));
        steps.push(step('sandbox-notice', 'Sandbox: what is NOT blocked', 'PASSED', `NOTICE: ${policy.NOTICE} ${policy.RECOMMENDATION}`));
        for (const w of handle.warnings) steps.push(step('sandbox-warning', 'Sandbox warning', 'PASSED', `WARNING: ${w}`));
        out.sandbox = { url: handle.url, project: handle.project, anonymised: handle.anonymised, real_data_kept: handle.real_data, unscrubbed_tables: handle.tables_unscrubbed, limits: handle.limits, notice: policy.NOTICE, recommendation: policy.RECOMMENDATION, copy: { files: handle.copy.files, symlinks_skipped: handle.copy.symlinks_skipped, skipped_by_reason: handle.copy.skipped_by_reason } };

        // ---- which plugins, and in which fixed order ----
        const comps = o.analysis ? o.analysis.components : [];
        // the plugins are those of the COPY itself (folders with a plugin header), plus whatever the analysis named: never an empty set by accident
        const slugs = new Set([...comps.filter(c => c.kind === 'plugin').map(c => c.slug), ...pluginFolders(path.join(handle.dir, 'site', 'wp-content', 'plugins'))]);
        let actFailed = null;   // the plugins of the site could not be switched on: the sandbox does not match the site, so it gives NO evidence either way
        const fresh = handle.steps.find(s => s.id === 'database' && /fresh WordPress install/.test(s.reason || ''));
        if (fresh) { const all = [...slugs].sort(); if (all.length) { const r = handle.wp.run(['plugin', 'activate', ...all]); if (!r.ok) { actFailed = r.stderr.trim().split('\n')[0]; steps.push(step('sandbox-activate', 'Sandbox: activate the plugins of the copy', 'FAILED', actFailed)); } } }
        const active = names(handle.wp.run(['plugin', 'list', '--status=active', '--field=name'])).filter(p => slugs.has(p) || true).sort();
        const requires = {};
        for (const p of active) { const c = comps.find(x => x.kind === 'plugin' && x.slug === p); if (!c) continue; requires[p] = [...new Set([...(c.requires_plugins || []), ...(c.implied || []).filter(i => !i.soft).map(i => i.slug)])].filter(d => active.includes(d) && d !== p).sort(); }
        const themes = names(handle.wp.run(['theme', 'list', '--field=name'])).sort();
        const siteTheme = names(handle.wp.run(['option', 'get', 'stylesheet']))[0] || null;
        const defaultTheme = themes.filter(t => /^twenty/.test(t) && t !== siteTheme).sort().pop() || null;
        const muAll = fs.existsSync(path.join(handle.dir, 'site', 'wp-content', 'mu-plugins')) ? readdir(path.join(handle.dir, 'site', 'wp-content', 'mu-plugins')).filter(f => f.endsWith('.php') && f !== 'pg-sandbox-guard.php').map(f => f.replace(/\.php$/, '')).sort() : [];

        // ---- test user for problems that need a login (sandbox only; credentials from the environment, never printed) ----
        let login = false;
        const env = o.env || process.env;
        if (issue.needs_login && env.PG_TEST_USER && env.PG_TEST_PASSWORD && /^[A-Za-z0-9_]{3,30}$/.test(env.PG_TEST_USER) && env.PG_TEST_PASSWORD.length >= 8) {
            const r = handle.wp.run(['user', 'create', env.PG_TEST_USER, `${env.PG_TEST_USER}@example.test`, '--role=administrator', `--user_pass=${env.PG_TEST_PASSWORD}`]);
            login = r.ok; steps.push(step('sandbox-login', 'Sandbox: test user', r.ok ? 'PASSED' : 'FAILED', r.ok ? 'a temporary administrator was created in the sandbox only (credentials from PG_TEST_USER / PG_TEST_PASSWORD; never printed or stored)' : r.stderr.trim().split('\n')[0]));
        } else if (issue.needs_login) steps.push(step('sandbox-login', 'Sandbox: test user', 'NOT_RUN', 'the problem needs a logged-in user: set PG_TEST_USER and PG_TEST_PASSWORD (at least 8 characters) in the environment'));

        const tester = makeTester({ handle, issueId: id, env, plugins: active, requires, defaultTheme, siteTheme, muAll, login, options: { viewports: opt.viewports, probePages: opt.probePages }, log: m => steps.push(step('sandbox-note', 'Sandbox note', 'PASSED', m)) });

        // ---- does the sandbox show the symptom at all? ----
        // A failed activation is NOT "the symptom did not appear": without the site's plugins the page proves nothing. No baseline, no bisection, and
        // reproduced_in_sandbox stays null, which every later stage reads as "no sandbox evidence" (same as a run without --sandbox).
        if (actFailed) {
            out.could_not_run = `the plugins of your site could not be switched on in it: ${actFailed.slice(0, 160)}`;
            steps.push(step('sandbox-oracle', 'Oracle in the sandbox: is the symptom present?', 'NOT_RUN', `not run: ${out.could_not_run}. This is no evidence either way; the verdict is the one a run without the sandbox gives.`));
            steps.push(step('bisect', 'Bisection', 'NOT_RUN', 'the sandbox could not activate the plugins, so there is nothing to bisect'));
            throw Object.assign(new Error('sandbox could not activate the plugins'), { pgSkip: true });   // jumps to the teardown below; nothing else runs
        }
        const base = await tester({ plugins: active, theme: null, mu: null });
        out.baseline = tester.last ? { ...tester.last, active_plugins: [...active] } : null;
        out.redirect_observed = !!tester.redirectSeen;   // only the baseline run has happened here: the sandbox as it is
        out.reproduced_in_sandbox = base === 'fail' ? 'yes' : base === 'pass' ? 'no' : 'could-not-test';
        steps.push(step('sandbox-oracle', 'Oracle in the sandbox: is the symptom present?', base === 'unresolved' ? 'NOT_RUN' : 'PASSED', `symptom reproduced in the sandbox: ${out.reproduced_in_sandbox}${base === 'pass' ? '. NOT reproduced: every hypothesis stays PROBABLE_NEEDS_REVIEW or below, nothing can be REPRODUCIBLE.' : ''}${base === 'unresolved' ? ' (the page failed in a different way, or the oracle could not be evaluated)' : ''}`, { reproduced: out.reproduced_in_sandbox }));

        // a caller (verify-fixes.js) may use this running sandbox, with the symptom present, to test candidate fixes before the teardown
        if (o.verify && base === 'fail') out.verification = await o.verify({ handle, tester, baseline: out.baseline, issue, steps });
        if (base === 'fail' && !opt.noBisect) {
            const top = (o.analysis && o.analysis.top) || [];
            const res = await bisect.run({ plugins: active, requires, mu: muAll, top, test: tester, caps: { maxLoads: Number(opt.maxLoads) || undefined, maxMs: opt.maxMinutes ? Number(opt.maxMinutes) * 60000 : undefined }, logFile: path.join(dir, 'work', 'bisect.log'), label: { oracle: issue.oracle.type } });
            fs.writeFileSync(path.join(dir, 'work', 'bisect.json'), JSON.stringify({ ...res, log: undefined, executed: res.executed }, null, 2) + '\n', { mode: 0o600 });
            out.bisect = res;
            steps.push(step('bisect', 'Bisection (delta debugging in the sandbox)', res.status.startsWith('cause-found') ? 'PASSED' : res.status === 'not-reproduced-at-start' ? 'NOT_RUN' : 'PASSED',
                `${res.symptom_without_plugins ? 'NOT A PLUGIN CONFLICT: the symptom is present with every plugin switched off. ' : ''}${res.status}: ${res.causes.length ? res.causes.map(c => `[${c.plugins.join(', ')}]`).join(' and ') : res.theme && res.theme.involved ? 'the theme' : 'no plugin set'}; ${res.loads} page loads, ${res.cache_hits} from the cache${res.capped ? `; STOPPED by the ${res.capped} cap, so the result is not proven minimal` : ''}; log in work/bisect.log`, { status_detail: res.status, loads: res.loads }));
        } else if (base === 'fail') steps.push(step('bisect', 'Bisection', 'NOT_RUN', 'switched off with --no-bisect'));
        else steps.push(step('bisect', 'Bisection', 'NOT_RUN', base === 'pass' ? 'the symptom is not present in the sandbox, so there is nothing to bisect' : 'the symptom could not be evaluated in the sandbox'));
    } catch (e) {
        if (e.pgSkip) { /* already reported above: no sandbox evidence */ } else {
        steps.push(step('sandbox', 'Sandbox (throwaway copy in Docker)', e.name === 'SandboxRefusal' || e.name === 'SandboxUnavailable' ? 'BLOCKED' : 'FAILED', e.message.replace(/\s*\n\s*/g, ' ').slice(0, 600)));
        if (!steps.some(s => s.id === 'bisect')) steps.push(step('bisect', 'Bisection', 'NOT_RUN', 'the sandbox did not start'));
        }
    } finally {
        if (handle && !opt.keepSandbox) {
            const rep = handle.destroy();
            steps.push(step('sandbox-teardown', 'Sandbox: teardown', rep.leftovers.length ? 'FAILED' : 'PASSED', rep.leftovers.length ? `LEFTOVERS: ${rep.leftovers.join(', ')} (run: issue sandbox sweep)` : `containers, volumes, networks and the sandbox folder (compose file, wp-config.php, any dump) were removed`));
        } else if (handle) steps.push(step('sandbox-teardown', 'Sandbox: teardown', 'SKIPPED', `kept on request (--keep-sandbox) at ${handle.url}; remove it with: issue sandbox destroy ${id}`));
    }
    return done();
}

module.exports = { run, makeTester, makeApplier, pluginFolders, names, step };
