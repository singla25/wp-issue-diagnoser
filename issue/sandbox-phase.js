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
    // 'Same fatal required': every call records ONE entry in test.history (the new fatals in the copy's log during this call, and whether a page
    // answered 5xx), in call order, so the producer can put them next to the bisection's tests[] (issue/bisect.js calls the test once per new set)
    async function test(set) {
        const rec = { fatals: [], five: false };
        try { return await once(set, rec); } finally { test.history.push(rec); }
    }
    test.history = [];
    return test;
    async function once(set, rec) {
        test.lastObs = null; test.lastError = null;   // 6d-2: the observed pages of THIS call (status and text flags), for the fidelity check of the baseline
        if (apply(set) === 'unresolved') { test.lastError = 'the test copy could not be set up for the test'; return 'unresolved'; }
        // ---- run the oracle ----
        let size = 0; try { size = fs.statSync(logFile).size; } catch { /* no log yet */ }
        n++;
        const r = await probe.runSandbox(issueId, { url: handle.url, stateDir: path.join(handle.dir, 'probe'), tag: `t${n}`, env, login, options: { ...options } });
        if (!r.ok) { log(`probe failed: ${r.reason}`); test.lastError = `the pages of the test copy could not be loaded: ${String(r.reason || 'the probe failed')}`; return 'unresolved'; }
        test.lastObs = (r.pages || []).map(p => ({ url: p.url, loaded: !!p.loaded, status: p.status, reused_status: p.reused_status, text_flags: p.text_flags, text_chars: p.text_chars }));
        let growth = null; try { const st = fs.statSync(logFile); const fd = fs.openSync(logFile, 'r'); const len = Math.min(st.size - size, 256 * 1024), b = Buffer.alloc(Math.max(0, len)); fs.readSync(fd, b, 0, b.length, size); fs.closeSync(fd); growth = { available: true, new_text: b.toString('utf8') }; } catch { growth = { available: false, reason: 'no debug.log in the sandbox yet' }; }
        rec.fatals = growth.available ? fatalsOfText(growth.new_text) : [];
        rec.five = (r.pages || []).some(p => Number(p.reused_status || p.status) >= 500) || (r.status_codes || []).some(x => x >= 500);
        const issue = store.load(issueId);
        const res = issue.oracle.type === 'debug-log' || issue.oracle.type === 'generic' ? require('./oracle').evaluate(issue.oracle, { pages: r.pages.map(p => ({ ...p, console_errors: p.console_errors || [], page_errors: p.page_errors || [], error_responses: p.error_responses || [] })), planned: r.pages.length, sandbox: true, logged_in: !!(r.login && r.login.ok), debug_log: growth }, { needsLogin: issue.needs_login, symptom: issue.symptom }) : r.oracle;
        if (r.pages.some(p => require('./oracle').redirectSigns(p).length)) test.redirectSeen = true;   // a redirect loop, a long chain or a cross-host redirect in the sandbox
        test.last = { result: res.result, matches: res.matches || [], pages: r.pages.map(p => ({ url: p.url, viewport: p.viewport && p.viewport.name, loaded: !!p.loaded })) };
        if (res.result === 'yes') return 'fail';
        if (res.result === 'could-not-test') return 'unresolved';
        // the symptom is absent, but the page may be broken some OTHER way (a fatal error, a 500): that says nothing about this symptom
        if (!['http-5xx', 'debug-log', 'generic'].includes(issue.oracle.type) && (r.status_codes.some(s => s >= 500) || r.fatal_text)) return 'unresolved';
        return 'pass';
    }
}

// ---- 'Same fatal required' (owner-approved verdict text): "NOT A PLUGIN CONFLICT" only when the no-plugin step shows the SAME fatal ----
// The fatals of a piece of the copy's log: fatal lines only (issue/logs.js parseLog, redacted), each as { kind, name, file, line } by the same
// parsing the fidelity check uses (issue/fidelity.js fatalOf: class / function name, file relative to wp-content). Text from the log is data.
const STEP_FATALS_MAX = 5;
function fatalsOfText(text) {
    if (!text) return [];
    const fid = require('./fidelity'), out = [];
    for (const e of require('./logs').parseLog(String(text), 'copy:debug.log')) {
        if (!(e.level === 'fatal error' || e.level === 'parse error' || /Uncaught\s+\w*(?:Error|Exception)/.test(e.message))) continue;
        const f = fid.fatalOf(e.message, e.file, e.line);
        if (f && !out.some(x => x.kind === f.kind && x.name === f.name && x.file === f.file && x.line === f.line)) out.push(f);
        if (out.length >= STEP_FATALS_MAX) break;
    }
    return out;
}
// An oracle that fails on ANY server failure counts any 5xx: there, a failing no-plugin step is the reported symptom only when it shows the same
// fatal as the reported cause. http-5xx always; generic and debug-log only when the no-plugin step had a page that answered 5xx.
const BARE_ALWAYS = new Set(['http-5xx']), BARE_IF_5XX = new Set(['generic', 'debug-log']);
// rec: the tester's history entry of the failing no-plugin step -> null (the same fatal, or the rule does not apply) | true | 'unknown' (issue/bisect.js bareCheck)
function bareVerdict(rec, { oracleType = null, cause = null } = {}) {
    if (!(BARE_ALWAYS.has(oracleType) || (BARE_IF_5XX.has(oracleType) && !!(rec && rec.five)))) return null;
    const fats = rec && Array.isArray(rec.fatals) ? rec.fatals : [];
    if (cause && fats.some(f => require('./fidelity').sameFatal(cause, f))) return null;   // the same fatal: "not a plugin conflict" stands
    return cause && fats.length ? true : 'unknown';
}
// the bareCheck for issue/bisect.js: the LAST history entry is the no-plugin step that just ran
const bareCheckFor = (history, ctx) => () => bareVerdict(history[history.length - 1], ctx);
// res: bisect.run() result; steps: the tester's history entries of the bisection's own calls, one per res.tests[i] -> each test gets its fatals
function annotateBisect(res, { steps = [] } = {}) {
    if (!res || !Array.isArray(res.tests)) return res;
    res.tests.forEach((t, i) => { const s = steps[i]; t.fatals = s && Array.isArray(s.fatals) ? s.fatals.slice(0, STEP_FATALS_MAX) : []; });
    return res;
}
// the plain sentence (result.js BARE_DIFFERENT / BARE_UNKNOWN) for the bisection step, or the old banner, or nothing
const bisectBanner = res => (res.symptom_without_plugins ? 'NOT A PLUGIN CONFLICT: the symptom is present with every plugin switched off. '
    : bisect.bareSentence(res.bare_different_failure) ? `${bisect.bareSentence(res.bare_different_failure)} ` : '');
// the cause part of the bisection step: an inconclusive bisection names no cause
const bisectCause = res => (res.status === 'inconclusive' ? 'no cause is named' : res.causes.length ? res.causes.map(c => `[${c.plugins.join(', ')}]`).join(' and ') : res.theme && res.theme.involved ? 'the theme' : 'no plugin set');

// top-level plugin folders that contain a PHP file with a "Plugin Name:" header (sorted: a fixed order)
function pluginFolders(dir) {
    let names = []; try { names = readdir(dir, { withFileTypes: true }).filter(e => e.isDirectory() && /^[A-Za-z0-9._-]+$/.test(e.name)).map(e => e.name).sort(); } catch { return []; }
    return names.filter(n => { try { return readdir(path.join(dir, n)).filter(f => f.endsWith('.php')).some(f => { const fd = fs.openSync(path.join(dir, n, f), 'r'); try { const b = Buffer.alloc(8192), k = fs.readSync(fd, b, 0, 8192, 0); return /Plugin Name:/i.test(b.toString('utf8', 0, k)); } finally { fs.closeSync(fd); } }); } catch { return false; } });
}

// o: { root, options: { sandbox, dump, exportDb, neutralisePayments, withUploads, maxSizeMb, keepSandbox, maxLoads, maxMinutes, noBisect }, analysis, env }
// An activation that stops with "Failed to open stream" / "Failed opening required" on a file: is that file in the ORIGINAL site but not in the copy? Then the copy step
// dropped it, and the report says so instead of leaving the reader to blame the plugin. Read-only on the original; null when it cannot be told.
function missingFromCopy(stderr, originalRoot, copyRoot) {
    const text = String(stderr);
    if (!originalRoot || !/(No such file or directory|Failed opening required)/i.test(text)) return null;
    for (const m of text.matchAll(/\/var\/www\/html\/(wp-content\/[^'"\s:)(]+)/g)) {
        const rel = m[1];
        if (rel.split('/').includes('..')) continue;
        try { if (fs.lstatSync(path.join(originalRoot, rel)).isFile() && !fs.existsSync(path.join(copyRoot, rel))) return rel; } catch { /* not in the original either */ }
    }
    return null;
}

// ---- TEST-COPY-SPEC 6d-1 ----
// a build from a database file (a dump given, or exported): its plugins are the ones the imported database has switched on, never activated by us
const isDbBuild = handle => !!handle && (handle.anonymised === true || handle.topology === 'proxied');
// The starting plugin set of a database build: what WordPress lists as active (it reads the database's active_plugins), kept only where the
// database's own list (sandbox.js, read right after the import) names it. Nothing is added, so the first apply() never switches a plugin on.
// Without a database, or when the list is not from the database, the listed set is used as before.
function baselineSet(handle, listed) {
    const ap = handle && handle.active_plugins;
    if (!isDbBuild(handle) || !ap || ap.source !== require('./version-match').ACTIVE_SOURCES.DATABASE) return listed;
    const missing = new Set(ap.missing_files || []);
    const fromDb = new Set(ap.active.filter(p => !missing.has(p)).map(p => require('./version-match').slugOf(p)));
    return listed.filter(p => fromDb.has(p));
}
// The copy's own debug log (/var/log/pg/debug.log in the containers, <sandbox>/logs/debug.log here) as DATA: the last 2 MB, redacted line by line
// (issue/logs.js parseLog uses lib/redact.js), fatal lines only, paths relative to wp-content. Labelled 'unverified': it decides nothing.
const COPY_LOG_MAX = 10;
function readCopyLog(file, { maxBytes = 2 * 1024 * 1024, secrets = [] } = {}) {
    const logs = require('./logs');
    const none = { schema: 1, label: 'unverified', available: false, fatal_count: 0, last_fatals: [] };
    let t; try { const st = fs.lstatSync(file); if (!st.isFile() || st.isSymbolicLink()) return none; t = logs.readTail(file, maxBytes); } catch { return none; }
    if (!t) return none;
    let text = t.text; for (const s of secrets) if (typeof s === 'string' && s.length >= 8) text = text.split(s).join('[REDACTED]');
    const rel = s => String(s || '').split('/var/www/html/wp-content/').join('').split('/var/www/html/').join('');
    const fatals = logs.parseLog(text, 'copy:debug.log').filter(e => e.level === 'fatal error' || e.level === 'parse error' || /Uncaught\s+\w*(?:Error|Exception)/.test(e.message));
    const last = new Map();   // the same message at the same place once, at its last position
    for (const e of fatals) { const v = { message: rel(e.message).slice(0, 300), file: e.file && e.file.startsWith('wp-content/') ? e.file.slice('wp-content/'.length) : null, line: Number.isInteger(e.line) ? e.line : null }; const k = `${v.message}|${v.file}|${v.line}`; last.delete(k); last.set(k, v); }
    return { schema: 1, label: 'unverified', available: true, fatal_count: fatals.length, last_fatals: [...last.values()].slice(-COPY_LOG_MAX) };
}
const copyLogFile = dir => path.join(dir, 'work', 'copy-log.json');
function writeCopyLog(dir, data) { try { if (!fs.lstatSync(path.join(dir, 'work')).isDirectory()) return; fs.writeFileSync(copyLogFile(dir), JSON.stringify(data, null, 2) + '\n', { mode: 0o600 }); } catch { /* no work folder */ } }
function removeCopyLog(dir) { try { if (fs.lstatSync(copyLogFile(dir)).isFile()) fs.rmSync(copyLogFile(dir)); } catch { /* none */ } }

// ---- TEST-COPY-SPEC 6d-2: the fidelity check (issue/fidelity.js) of a copy built from a database file ----
// Its result is DATA in work/fidelity.json and in sandbox.json `fidelity`. The producer rule: unless the level is 'matched' or 'status-only',
// reproduced_in_sandbox is written as null ('no evidence', exactly what a run without a test copy writes), never 'no', and the copy is not bisected.
const fidelityFile = dir => path.join(dir, 'work', 'fidelity.json');
function writeFidelity(dir, fd) { try { if (!fs.lstatSync(path.join(dir, 'work')).isDirectory()) return; fs.writeFileSync(fidelityFile(dir), JSON.stringify(fd, null, 2) + '\n', { mode: 0o600 }); } catch { /* no work folder */ } }
function removeFidelity(dir) { try { if (fs.lstatSync(fidelityFile(dir)).isFile()) fs.rmSync(fidelityFile(dir)); } catch { /* none */ } }
// a retest (issue/retest.js) copies sandbox.json to sandbox.initial.json first and keeps the first evidence: the first fidelity result stays too
const keepsFirstEvidence = dir => { try { return fs.lstatSync(path.join(dir, 'work', 'sandbox.initial.json')).isFile(); } catch { return false; } };
const readWork = (dir, f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'work', f), 'utf8')); } catch { return null; } };
// the real side, read-only: the live probe's failing pages and the fatal the report calls the cause (hypotheses.json + evidence.json)
const realSide = (dir, issue) => require('./fidelity').realFrom({ probe: readWork(dir, 'probe.json'), hypotheses: readWork(dir, 'hypotheses.json'), evidence: readWork(dir, 'evidence.json'), issue });
const FIDELITY_WORD = { matched: 'the same problem as your site', 'status-only': 'the same kind of failure only (weaker)', 'did-not-match': 'did not show the same problem, so nothing from it is used', 'could-not-test': 'could not be tested', 'not-tested': 'not compared, nothing from it is used' };
const fidelityStep = fd => step('sandbox-fidelity', 'Test copy: does it show the same problem as your site?', fd.level === 'matched' || fd.level === 'status-only' || fd.level === 'did-not-match' ? 'PASSED' : 'NOT_RUN', `${FIDELITY_WORD[fd.level]}${fd.reasons.length ? `: ${fd.reasons.join('; ')}` : ''}`, { level: fd.level });

// a LIVE site is never copied with its database, whatever path asked for it (issue investigate, issue retest, the wizard, --yes): the database file
// and --export-db are dropped here, centrally, before anything else; what live does without a database file is not changed
const LIVE_NO_DB = 'A live site is never copied with its database.';
const liveDbStep = () => step('sandbox-database', 'Sandbox: database file', 'NOT_RUN', LIVE_NO_DB);
async function run(id, o) {
    const issue = store.load(id), dir = store.dirOf(id), steps = [];
    let opt = o.options || {};
    const liveDb = issue.environment === 'live' && !!(opt.dump || opt.exportDb);
    if (liveDb) { opt = { ...opt, dump: undefined, exportDb: false }; steps.push(liveDbStep()); }
    if (!o.noWrite) removeCopyLog(dir);   // a copy log of an earlier build never describes this one
    const keepFirst = keepsFirstEvidence(dir);
    if (!o.noWrite && !keepFirst) removeFidelity(dir);   // nor does a fidelity result
    const out = { steps, bisect: null, sandbox: null, reproduced_in_sandbox: null };
    const dbIntent = !!opt.sandbox && !!(opt.dump || opt.exportDb);   // a test copy from a database file was asked for: the fidelity check applies
    const setFidelity = fd => { out.fidelity = fd; if (!o.noWrite && !keepFirst) writeFidelity(dir, fd); steps.push(fidelityStep(fd)); };
    const done = () => { if (o.noWrite) return out; try { fs.writeFileSync(path.join(dir, 'work', 'sandbox.json'), JSON.stringify({ steps, sandbox: out.sandbox, could_not_run: out.could_not_run || undefined, reproduced_in_sandbox: out.reproduced_in_sandbox, baseline: out.baseline || null, redirect_observed: !!out.redirect_observed, fidelity: out.fidelity || undefined, replica: out.replica }, null, 2) + '\n', { mode: 0o600 }); } catch { /* work folder missing */ } return out; };
    // 6d-3: what the report's level needs to say what is missing: was a test copy asked for, with a database file, and did Docker work (null: not checked)
    out.replica = { requested: !!opt.sandbox, database_file: !!(opt.dump || opt.exportDb), docker: null, ...(liveDb ? { db_dropped_live: true } : {}) };
    if (!opt.sandbox) { steps.push(step('sandbox', 'Sandbox (throwaway copy in Docker)', 'NOT_RUN', 'not requested: add --sandbox (needs Docker and a local copy of the site)')); return done(); }
    if (!o.root) { steps.push(step('sandbox', 'Sandbox (throwaway copy in Docker)', 'NOT_RUN', 'a local copy of the site (--root) is needed')); if (dbIntent) setFidelity(require('./fidelity').compare({ real: realSide(dir, issue), copy: { built: false } })); return done(); }
    const pf = sandbox.preflight(o.sandboxOptions || {});
    out.replica.docker = !!pf.ok;
    if (!pf.ok) { steps.push(step('sandbox', 'Sandbox (throwaway copy in Docker)', 'NOT_RUN', `${pf.reason} Static-only mode: not reproduced, sandbox unavailable; every hypothesis stays UNVERIFIED or PROBABLE_NEEDS_REVIEW.`), step('bisect', 'Bisection', 'NOT_RUN', 'needs the sandbox')); if (dbIntent) setFidelity(require('./fidelity').compare({ real: realSide(dir, issue), copy: { error: pf.reason } })); return done(); }

    let handle;
    try {
        const so = { ...(o.sandboxOptions || {}), root: o.root, dump: opt.dump, neutralisePayments: !!opt.neutralisePayments, withUploads: !!opt.withUploads, maxMb: opt.maxSizeMb ? Number(opt.maxSizeMb) : undefined };
        if (opt.exportDb && !opt.dump) so.exportDatabase = file => new WpCli({ path: o.root }).exportDatabase(file, sandbox.sandboxesRoot());
        handle = sandbox.create(id, so);
        for (const s of handle.steps) steps.push(step(`sandbox-${s.id}`, `Sandbox: ${s.id}`, s.status, s.reason));
        steps.push(step('sandbox-notice', 'Sandbox: what is NOT blocked', 'PASSED', `NOTICE: ${handle.topology === 'proxied' ? policy.NOTICE_DUMP : policy.NOTICE} ${policy.RECOMMENDATION}`));
        for (const w of handle.warnings) steps.push(step('sandbox-warning', 'Sandbox warning', 'PASSED', `WARNING: ${w}`));
        out.sandbox = { url: handle.url, project: handle.project, anonymised: handle.anonymised, unscrubbed_tables: handle.tables_unscrubbed, limits: handle.limits, notice: policy.NOTICE, recommendation: policy.RECOMMENDATION, copy: { files: handle.copy.files, symlinks_skipped: handle.copy.symlinks_skipped, skipped_by_reason: handle.copy.skipped_by_reason } };

        // ---- which plugins, and in which fixed order ----
        const comps = o.analysis ? o.analysis.components : [];
        // the plugins are those of the COPY itself (folders with a plugin header), plus whatever the analysis named: never an empty set by accident
        const slugs = new Set([...comps.filter(c => c.kind === 'plugin').map(c => c.slug), ...pluginFolders(path.join(handle.dir, 'site', 'wp-content', 'plugins'))]);
        let actFailed = null;   // the plugins of the site could not be switched on: the sandbox does not match the site, so it gives NO evidence either way
        // TEST-COPY-SPEC 6d-1: a build from a database file NEVER switches plugins on to start with: the imported database says which are active
        const dbBuild = isDbBuild(handle);
        const fresh = !dbBuild && handle.steps.find(s => s.id === 'database' && /fresh WordPress install/.test(s.reason || ''));
        if (fresh) { const all = [...slugs].sort(); if (all.length) { const r = handle.wp.run(['plugin', 'activate', ...all]); if (!r.ok) { actFailed = r.stderr.trim().split('\n')[0]; steps.push(step('sandbox-activate', 'Sandbox: activate the plugins of the copy', 'FAILED', actFailed)); } } }
        const active = baselineSet(handle, names(handle.wp.run(['plugin', 'list', '--status=active', '--field=name'])).filter(p => slugs.has(p) || true).sort());
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
            const lost = missingFromCopy(actFailed, o.root, path.join(handle.dir, 'site'));
            out.could_not_run = `the plugins of your site could not be switched on in it: ${actFailed.slice(0, 160)}${lost ? `. The file ${lost} exists in your site but was not in the copy, so this is a copy problem, not a problem in your plugin` : ''}`;
            steps.push(step('sandbox-oracle', 'Oracle in the sandbox: is the symptom present?', 'NOT_RUN', `not run: ${out.could_not_run}. This is no evidence either way; the verdict is the one a run without the sandbox gives.`));
            steps.push(step('bisect', 'Bisection', 'NOT_RUN', 'the sandbox could not activate the plugins, so there is nothing to bisect'));
            throw Object.assign(new Error('sandbox could not activate the plugins'), { pgSkip: true });   // jumps to the teardown below; nothing else runs
        }
        const base = await tester({ plugins: active, theme: null, mu: null });
        out.baseline = tester.last ? { ...tester.last, active_plugins: [...active] } : null;
        out.redirect_observed = !!tester.redirectSeen;   // only the baseline run has happened here: the sandbox as it is
        const raw = base === 'fail' ? 'yes' : base === 'pass' ? 'no' : 'could-not-test';
        // 6d-1: the copy's OWN debug log after the front page and the baseline pages (work/copy-log.json). 6d-2: it is compared with the fatal the
        // report calls the cause (issue/fidelity.js); it is labelled 'verified' only when the copy matched the real site, else it stays 'unverified'.
        let fd = null;
        if (dbBuild) {
            const fid = require('./fidelity');
            const cl = readCopyLog(path.join(handle.dir, 'logs', 'debug.log'), { secrets: handle.test_login ? [handle.test_login.password] : [] });
            fd = fid.compare({ real: realSide(dir, issue), copy: fid.copyFrom({ pages: tester.lastObs, copyLog: cl, error: tester.lastObs ? null : tester.lastError || 'the pages of the test copy could not be loaded' }) });
            if (fd.level === 'matched') cl.label = 'verified';
            if (!o.noWrite) writeCopyLog(dir, cl);
        }
        const use = !fd || fd.counts;   // the producer rule: a copy that did not show the same problem gives NO evidence, never 'no'
        out.reproduced_in_sandbox = use ? raw : null;
        steps.push(step('sandbox-oracle', 'Oracle in the sandbox: is the symptom present?', base === 'unresolved' ? 'NOT_RUN' : 'PASSED', `symptom reproduced in the sandbox: ${raw}${use && base === 'pass' ? '. NOT reproduced: every hypothesis stays PROBABLE_NEEDS_REVIEW or below, nothing can be REPRODUCIBLE.' : ''}${base === 'unresolved' ? ' (the page failed in a different way, or the oracle could not be evaluated)' : ''}${use ? '' : '. Not used as evidence: the test copy did not show the same problem as your site (see the fidelity step)'}`, { reproduced: out.reproduced_in_sandbox }));
        if (fd) setFidelity(fd);

        // a caller (verify-fixes.js) may use this running sandbox, with the symptom present, to test candidate fixes before the teardown
        if (o.verify && base === 'fail' && use) out.verification = await o.verify({ handle, tester, baseline: out.baseline, issue, steps });
        if (base === 'fail' && !use) steps.push(step('bisect', 'Bisection', 'NOT_RUN', 'the test copy did not show the same problem as your site, so it is not bisected and nothing from it is used'));
        else if (base === 'fail' && !opt.noBisect) {
            const top = (o.analysis && o.analysis.top) || [];
            const k0 = tester.history.length;
            const res = await bisect.run({ plugins: active, requires, mu: muAll, top, test: tester, caps: { maxLoads: Number(opt.maxLoads) || undefined, maxMs: opt.maxMinutes ? Number(opt.maxMinutes) * 60000 : undefined }, logFile: path.join(dir, 'work', 'bisect.log'), label: { oracle: issue.oracle.type },
                bareCheck: bareCheckFor(tester.history, { oracleType: issue.oracle.type, cause: realSide(dir, issue).cause_fatal }) });
            annotateBisect(res, { steps: tester.history.slice(k0) });
            fs.writeFileSync(path.join(dir, 'work', 'bisect.json'), JSON.stringify({ ...res, log: undefined, executed: res.executed }, null, 2) + '\n', { mode: 0o600 });
            out.bisect = res;
            steps.push(step('bisect', 'Bisection (delta debugging in the sandbox)', res.status.startsWith('cause-found') ? 'PASSED' : res.status === 'not-reproduced-at-start' ? 'NOT_RUN' : 'PASSED',
                `${bisectBanner(res)}${res.status}: ${bisectCause(res)}; ${res.loads} page loads, ${res.cache_hits} from the cache${res.capped ? `; STOPPED by the ${res.capped} cap, so the result is not proven minimal` : ''}; log in work/bisect.log`, { status_detail: res.status, loads: res.loads }));
        } else if (base === 'fail') steps.push(step('bisect', 'Bisection', 'NOT_RUN', 'switched off with --no-bisect'));
        else steps.push(step('bisect', 'Bisection', 'NOT_RUN', base === 'pass' ? 'the symptom is not present in the sandbox, so there is nothing to bisect' : 'the symptom could not be evaluated in the sandbox'));
    } catch (e) {
        if (e.pgSkip) { /* already reported above: no sandbox evidence */ } else {
        steps.push(step('sandbox', 'Sandbox (throwaway copy in Docker)', e.name === 'SandboxRefusal' || e.name === 'SandboxUnavailable' ? 'BLOCKED' : 'FAILED', e.message.replace(/\s*\n\s*/g, ' ').slice(0, 600)));
        if (!steps.some(s => s.id === 'bisect')) steps.push(step('bisect', 'Bisection', 'NOT_RUN', 'the sandbox did not start'));
        // 6d-2: a copy from a database file that failed before its comparison was made: 'could not test', never 'not reproduced'
        if (dbIntent && !out.fidelity) { out.reproduced_in_sandbox = null; setFidelity(require('./fidelity').compare({ real: realSide(dir, issue), copy: { error: e.message } })); }
        }
    } finally {
        if (handle && !opt.keepSandbox) {
            const rep = handle.destroy();
            steps.push(step('sandbox-teardown', 'Sandbox: teardown', rep.leftovers.length ? 'FAILED' : 'PASSED', rep.leftovers.length ? `LEFTOVERS: ${rep.leftovers.join(', ')} (run: issue sandbox sweep)` : `containers, volumes, networks and the sandbox folder (compose file, wp-config.php, any dump) were removed`));
        } else if (handle) steps.push(step('sandbox-teardown', 'Sandbox: teardown', 'SKIPPED', `kept on request (--keep-sandbox) at ${handle.url}; remove it with: issue sandbox destroy ${id}`));
    }
    return done();
}

module.exports = { LIVE_NO_DB, liveDbStep, fatalsOfText, annotateBisect, bareVerdict, bareCheckFor, bisectBanner, bisectCause, run, missingFromCopy, makeTester, makeApplier, pluginFolders, names, step, isDbBuild, baselineSet, readCopyLog, writeCopyLog, removeCopyLog, COPY_LOG_MAX, writeFidelity, removeFidelity, keepsFirstEvidence, realSide, fidelityStep };
