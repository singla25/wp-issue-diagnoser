// Orchestrator: project settings -> (live probe) -> (local checks) -> findings -> decisions + history.
// Read-only: nothing here changes the site. Reports and the fix file are built from the result elsewhere.

const fs = require('fs');
const path = require('path');
const projectLib = require('./lib/project');
const components = require('./lib/components');
const { Outside } = require('./lib/outside');
const { WpCli } = require('./lib/wpcli');
const history = require('./lib/history');
const decisions = require('./lib/decisions');
const live = require('./lib/live');
const { categoryOf } = require('./lib/categories');
const dependencies = require('./checks/dependencies');
const conflicts = require('./checks/conflicts');
const exposure = require('./checks/exposure');
const themesCheck = require('./checks/themes');
const dropins = require('./checks/dropins');
const serversettings = require('./checks/serversettings');
const integrity = require('./checks/integrity');
const database = require('./checks/database');
const lifecycle = require('./checks/lifecycle');
const vulns = require('./checks/vulns');

// exit code 3: the tool could not read the site and the admin must do something (set up a local copy, fix the URL)
class GuardError extends Error {
    constructor(code, message) { super(message); this.code = code; this.exitCode = 3; }
}

const NEEDS_LOCAL = 'needs a local copy of the site (--path); URL mode only sees what a visitor sees';
const LOCAL_ONLY = [
    ['deps', 'Plugin and theme dependencies'], ['conflicts', 'Conflicts between plugins, themes and mu-plugins'], ['exposure', 'Unsafe code in plugins and themes'],
    ['themes', 'Theme parent / child'], ['dropins', 'Drop-ins and must-use plugins'], ['server-config', 'wp-config.php settings'], ['server-permissions', 'File permissions'],
    ['server-stray-files', 'Backups, debug and leftover files in the web folder'], ['integrity-patterns', 'Malware and backdoor patterns, PHP in uploads'],
    ['integrity-core', 'WordPress core files vs official copy'], ['integrity-plugins', 'Plugin files vs official copy'],
    ['db-users', 'Administrator accounts'], ['db-options', 'Registration and role settings'], ['db-cron', 'Scheduled jobs'], ['db-injected', 'Injected code in posts and options'], ['db-multisite', 'Multisite'],
    ['lifecycle-autoupdate', 'Auto-updates']
];

async function scan(name, opts = {}) {
    const project = opts.project ? projectLib.normalise(opts.project, name) : projectLib.load(name); // opts.project: ad-hoc run (scan --root), no files kept in projects/
    if (opts.url) project.url = opts.url;
    if (opts.path) project.path = path.resolve(opts.path);
    if (project.path && !fs.existsSync(path.join(project.path, 'wp-content'))) throw new Error(`${project.path} has no wp-content folder: --path must be the WordPress root`);
    const now = opts.now || new Date();
    const type = opts.type || 'scan';
    const mode = project.path ? (project.url ? 'local + live' : 'local') : 'url';
    if (!project.path && !project.url) throw new Error('Nothing to scan: the project has neither url nor path');

    const checks = [];
    const record = (id, label, status, reason) => { const i = checks.findIndex(c => c.id === id); const row = { id, label, status, reason: reason || '' }; if (i >= 0) checks[i] = row; else checks.push(row); };
    const notes = [];
    const outside = new Outside(project, { fetchImpl: opts.fetchImpl, delayMs: opts.outsideDelayMs });
    const lastAny = history.last(name);
    const baseline = history.last(name, 'scan');

    // advisories: offline files from the project (+ bundled, empty by default)
    let advisories = vulns.loadFiles([path.join(__dirname, 'data', 'advisories.json'), ...project.advisories.map(f => path.resolve(f))]);

    // ---------------- live probe first: its PHP/theme hints feed the local checks ----------------
    let liveResult = null;
    if (project.url) {
        try {
            liveResult = await live.run(project.url, { delayMs: opts.delayMs, fetchImpl: opts.fetchImpl, certProbe: opts.certProbe, record });
        } catch (e) {
            if (e.code !== 'UNREACHABLE') throw e;
            if (!project.path) throw new GuardError('UNREACHABLE', `${e.message}\nCheck the address in the project settings. If the site is only reachable from inside a network, set it up locally and run: guard.js scan ${name} --path <folder>`);
            record('live', 'Live site checks', 'skipped', e.message);
        }
        if (liveResult && liveResult.blocked) {
            const msg = `The site blocked the scan (${liveResult.blocked}). Nothing was read.`;
            if (!project.path) throw new GuardError('BLOCKED', `${msg}\nThe scanner did not try to get around the protection.\nSet the project up locally (files + database export in a local WordPress) and run:\n  node scripts/guard.js scan ${name} --path <local WordPress folder>`);
            record('live', 'Live site checks', 'skipped', msg);
            liveResult = null;
        } else if (liveResult && liveResult.notWordPress) {
            if (!project.path) throw new GuardError('NOT_WORDPRESS', `${project.url} does not look like a WordPress site (no wp-content, wp-json or WordPress plugin traces found). Check the address in the project settings.`);
            notes.push('The live address does not look like WordPress.');
        } else if (liveResult && liveResult.stopped) notes.push(`Live checks stopped early: ${liveResult.stopped}`);
    }

    // ---------------- context ----------------
    const ctx = {
        project, config: { precedence: project.precedence, prefer: project.prefer, categories: project.categories }, now, outside, record,
        wpRoot: project.path ? path.resolve(project.path) : null, lastScanAt: lastAny && lastAny.at, wp: null, inventory: null,
        plugins: [], themes: [], mu: [], dropins: [], components: [], active: [], allHooks: new Set(), prefixes: new Set(),
        wpVersion: null, phpVersion: null, themesKnown: false
    };
    ctx.bySlug = new Map();
    ctx.isActive = ref => { const c = ctx.bySlug.get(ref); return !!(c && c.active); };

    const header = liveResult && liveResult.phpFromHeader;
    ctx.phpVersion = project.phpVersion ? { version: project.phpVersion, source: 'project setting' } : header ? { version: header, source: 'X-Powered-By header of the live site' } : components.phpVersion();

    let findings = [];
    let graph = { nodes: [], edges: [] };
    const safe = async (id, label, fn) => {
        try { return await fn(); } catch (e) { record(id, label, 'skipped', `this check crashed: ${e.message}`); notes.push(`${label}: crashed (${e.message}). The rest of the report is unaffected.`); return []; }
    };

    if (project.path) {
        const found = components.discover(ctx.wpRoot);
        ctx.plugins = found.plugins; ctx.themes = found.themes; ctx.mu = found.mu; ctx.dropins = found.dropins;
        ctx.wpVersion = components.wpVersion(ctx.wpRoot);

        // WP-CLI: the real active list, updates, users, database
        const bin = opts.wpBin || project.wpCliBin || process.env.WP_CLI_BIN || 'wp';
        const wp = new WpCli({ bin, path: ctx.wpRoot });
        const inv = wp.json(['plugin', 'list', '--fields=name,status,version,update,auto_update']);
        const themeInv = inv.ok ? wp.json(['theme', 'list', '--fields=name,status,version,update']) : null;
        if (inv.ok) { ctx.wp = wp; ctx.inventory = { plugins: inv.data, themes: themeInv && themeInv.ok ? themeInv.data : [] }; }
        else if (/not installed/.test(inv.error || '')) notes.push('WP-CLI is not installed on this computer: the active plugin list and all database checks were skipped.');
        else { ctx.wp = wp; notes.push(`WP-CLI could not read the local copy (${inv.error}). Import the database export into it to enable the database checks.`); }
        ctx.wpReason = inv.ok ? null : /not installed/.test(inv.error || '') ? 'WP-CLI is not installed on this computer' : null;

        let activeList = project.active;
        if (!activeList && ctx.inventory) activeList = ctx.inventory.plugins.filter(p => /^active/.test(p.status)).map(p => p.name);
        ctx.activeKnown = !!activeList;
        for (const p of ctx.plugins) p.active = !activeList || activeList.includes(p.slug);
        for (const m of ctx.mu) m.active = true;
        for (const d of ctx.dropins) d.active = true;

        let activeThemes = project.activeTheme ? [project.activeTheme] : ctx.inventory ? ctx.inventory.themes.filter(t => /^active/.test(t.status)).map(t => t.name) : null;
        if (!activeThemes && liveResult && liveResult.detectedThemes.length) activeThemes = liveResult.detectedThemes.filter(t => ctx.themes.some(x => x.slug === t));
        ctx.themesKnown = !!(activeThemes && activeThemes.length);
        if (ctx.themesKnown) {
            const act = new Set(activeThemes);
            for (const t of ctx.themes) if (act.has(t.slug) && t.template) act.add(t.template); // parent of a child theme
            for (const t of ctx.themes) t.active = act.has(t.slug);
        } else {
            for (const t of ctx.themes) t.active = true; // unknown: assume used for exposure, but keep out of conflicts
            notes.push('The active theme could not be determined (no WP-CLI, no activeTheme setting, none detected live): themes were scanned for unsafe code but not compared with plugins.');
        }

        ctx.components = [...ctx.plugins, ...ctx.mu, ...ctx.themes, ...ctx.dropins];
        for (const c of ctx.components) ctx.bySlug.set(c.ref, c);
        ctx.active = ctx.components.filter(c => c.active && c.kind !== 'dropin' && !(c.kind === 'theme' && !ctx.themesKnown));
        for (const c of ctx.components) {
            c.category = categoryOf(c, ctx.config);
            ctx.prefixes.add(c.slug.replace(/[^a-z0-9]+/gi, '_').toLowerCase() + '_');
            for (const s of c.scans) for (const h of s.hooks) ctx.allHooks.add(h.hook);
        }
        ctx.prefixes = new Set([...ctx.prefixes].filter(p => p.length > 3));

        const dep = await safe('deps', 'Plugin and theme dependencies', async () => { const r = dependencies.run(ctx); record('deps', 'Plugin and theme dependencies', 'done'); return r; });
        if (dep.findings) { findings.push(...dep.findings); graph = dep.graph; }
        findings.push(...await safe('conflicts', 'Conflicts', async () => { const r = conflicts.run(ctx); record('conflicts', 'Conflicts between plugins, themes and mu-plugins', 'done', ctx.themesKnown ? '' : 'themes not compared (active theme unknown)'); return r; }));
        findings.push(...await safe('exposure', 'Unsafe code', async () => { const r = exposure.run(ctx); record('exposure', 'Unsafe code in plugins and themes', 'done'); return r; }));
        findings.push(...await safe('themes', 'Themes', async () => { const r = themesCheck.run(ctx); record('themes', 'Theme parent / child', 'done'); return r; }));
        findings.push(...await safe('dropins', 'Drop-ins', async () => { const r = dropins.run(ctx); record('dropins', 'Drop-ins and must-use plugins', 'done'); return r; }));
        findings.push(...await safe('server-config', 'Server settings', () => serversettings.run(ctx)));
        findings.push(...await safe('integrity', 'File integrity', () => integrity.run(ctx)));
        findings.push(...await safe('db', 'Database and users', () => database.run(ctx)));
        findings.push(...await safe('lifecycle', 'Plugin lifecycle', () => lifecycle.run(ctx)));
    } else {
        // URL mode: the visible plugins stand in for the install, so wordpress.org lifecycle + vulnerability checks still work
        for (const [id, label] of LOCAL_ONLY) record(id, label, 'skipped', NEEDS_LOCAL);
        ctx.plugins = (liveResult ? liveResult.detected : []).map(d => ({
            kind: 'plugin', slug: d.slug, ref: d.slug, name: d.slug, version: d.version, versionTrusted: !/cache-buster/.test(d.source), active: true, scans: [], requiresPlugins: [],
            loc: f => f, category: null
        }));
        ctx.components = ctx.plugins;
        for (const c of ctx.components) ctx.bySlug.set(c.ref, c);
        ctx.activeKnown = false;
        findings.push(...await safe('php', 'PHP support', async () => { const r = serversettings.phpSupport(ctx); record('php-support', 'PHP version still supported', ctx.phpVersion ? 'done' : 'skipped', ctx.phpVersion ? ctx.phpVersion.source : 'the server PHP version is not announced (set phpVersion in the project settings)'); return r; }));
        findings.push(...await safe('lifecycle', 'Plugin lifecycle', () => lifecycle.run(ctx)));
    }

    // ---------------- live findings and vulnerabilities ----------------
    if (liveResult) {
        findings.push(...liveResult.findings);
        if (project.path) findings.push(...live.compareWithLocal(liveResult.detected, ctx.plugins.filter(p => p.kind === 'plugin')));
    }
    const versions = new Map(ctx.plugins.filter(p => p.version).map(p => [p.slug, { version: p.version, source: project.path ? 'plugin header' : 'detected from the live site', active: p.active }]));
    if (outside.allowed('vulnerabilityDb')) {
        let hits = 0, why = null;
        for (const p of ctx.plugins.filter(x => x.kind === 'plugin')) {
            const v = await outside.vulnerabilities(p.slug);
            if (v.skipped) { why = v.reason; break; }
            if (v.error) { notes.push(`Vulnerability database: ${v.error} for ${p.slug}`); continue; }
            advisories = advisories.concat(v.list); hits += v.list.length;
        }
        record('vulns', 'Known vulnerabilities', why ? 'skipped' : 'done', why || `vulnerability database queried, ${hits} advisories fetched, ${advisories.length - hits} offline advisories`);
    } else if (advisories.length) record('vulns', 'Known vulnerabilities', 'done', `matched against ${advisories.length} offline advisories (the vulnerability database is not allowed for this project)`);
    else record('vulns', 'Known vulnerabilities', 'skipped', 'no vulnerability data: add advisory files to the project settings ("advisories") or allow the vulnerability database (outsideLookups.vulnerabilityDb)');
    findings.push(...vulns.match(versions, advisories));

    // ---------------- finish ----------------
    const ignoreRules = new Set(project.ignoreRules);
    const seen = new Set();
    findings = findings.filter(f => !ignoreRules.has(f.rule) && !seen.has(f.id) && seen.add(f.id));
    const rank = { P0: 0, P1: 1, P2: 2, P3: 3 };
    findings.sort((a, b) => rank[a.severity] - rank[b.severity] || a.title.localeCompare(b.title));

    const result = {
        name, at: now.toISOString(), type, mode, target: { url: project.url, path: project.path },
        wpVersion: ctx.wpVersion, phpVersion: ctx.phpVersion, activeKnown: !!ctx.activeKnown,
        components: ctx.components.filter(c => c.kind !== 'dropin').map(c => ({ ref: c.ref, kind: c.kind, slug: c.slug, name: c.name, version: c.version, active: c.active, category: c.category && c.category.label, noHeader: c.noHeader })),
        dropins: ctx.dropins.map(d => d.slug),
        findings, graph, checks, notes,
        outside: outside.summary(), wpCliCommands: ctx.wp ? ctx.wp.commands : [],
        live: liveResult && { requests: liveResult.requests, stopped: liveResult.stopped, detected: liveResult.detected },
        copyModified: project.path ? newestChange(ctx) : null, dbExportedAt: project.dbExportedAt || null,
        baselineAt: baseline && baseline.at,
        policy: { customPaths: project.customPaths, protectedPaths: project.protectedPaths }
    };

    // history first (diff needs the previous snapshot), then decisions
    const d = history.diff(baseline, findings, result.components);
    for (const f of findings) { f.status = d.isNew.has(f.id) ? 'new' : d.open.has(f.id) ? 'open' : (baseline ? 'new' : 'first'); f.cause = d.cause.get(f.id) || ''; }
    result.diff = { baseline: d.baseline, fixed: d.fixed, updates: d.updates, newCount: d.isNew.size };
    if (opts.save !== false && !opts.project) {
        history.save(name, history.snapshotOf(result, type));
        decisions.sync(name, findings, now);
    }
    result.decisionProblems = opts.project ? [] : decisions.apply(name, findings);
    if (opts.project) for (const f of findings) { f.decision = 'pending'; f.decisionReason = ''; f.decidedOn = ''; }
    return result;
}

function newestChange(ctx) {
    let newest = 0;
    for (const c of ctx.components) { try { newest = Math.max(newest, fs.statSync(path.join(c.dir, c.main)).mtimeMs); } catch { /* gone */ } }
    try { newest = Math.max(newest, fs.statSync(path.join(ctx.wpRoot, 'wp-config.php')).mtimeMs); } catch { /* none */ }
    return newest ? new Date(newest).toISOString().slice(0, 10) : null;
}

// Findings that still need work: not ignored, not accepted.
const isOpen = f => f.decision !== 'ignore' && f.decision !== 'accept';

module.exports = { scan, GuardError, isOpen };
