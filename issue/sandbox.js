// The sandbox lifecycle: create a throwaway copy of a site in Docker, hand back a WP-CLI that can only act on it, and ALWAYS tear it down.
//
// Order of work in create():  preflight (daemon reachable, pinned images present locally: nothing is pulled) -> sweep leftovers of earlier
// crashed runs -> sandbox folder (0700) with state.json -> copy the site (sandbox-copy.js) -> generated wp-config.php (fresh salts, random
// DB credentials) and must-use guard plugin -> compose.json, checked by validateSpec() and by `docker compose config` -> up -> the port
// must be on 127.0.0.1 -> database (dump over stdin, never mounted; or a fresh install) -> payment gateways -> anonymise -> URL.
// Teardown (destroy) runs on success, on any error, on SIGINT/SIGTERM/SIGHUP, on an uncaught exception and on process exit. A SIGKILL cannot
// be caught, so the next create() (or `issue sandbox sweep`) removes whatever a dead process left, found by labels, never by guessing.
// Docker is always called with an argument array and no shell, with a rebuilt environment (see sandbox-wpcli.js).

const fs = require('fs');
const readdir = require('../lib/sorted-dir');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const policy = require('./sandbox-policy');
const copy = require('./sandbox-copy');
const cfg = require('./sandbox-config');
const { SandboxWpCli, SandboxRefusal, cleanEnv, checkLocalSocket } = require('./sandbox-wpcli');

class SandboxUnavailable extends Error { constructor(msg) { super(msg); this.name = 'SandboxUnavailable'; this.exitCode = 3; } }
const sandboxesRoot = () => process.env.PLUGIN_GUARD_SANDBOXES || path.join(__dirname, '..', 'sandboxes');
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const inside = (parent, child) => child === parent || child.startsWith(parent + path.sep);

function context(o = {}) {
    const env = o.env || process.env;
    const bin = o.dockerBin || 'docker';
    return { dockerBin: bin, runner: o.runner || spawnSync, env, sandboxesRoot: o.sandboxesRoot || sandboxesRoot(), originals: o.originals || [] };
}
function docker(ctx, args, o = {}) {
    const r = ctx.runner(ctx.dockerBin, args, { encoding: 'utf8', timeout: o.timeoutMs || 120000, env: cleanEnv(ctx.env), shell: false, input: o.input, cwd: o.cwd, maxBuffer: 100 * 1024 * 1024 });
    if (r.error) return { ok: false, status: -1, stdout: '', stderr: r.error.code === 'ENOENT' ? 'docker is not installed' : String(r.error.message) };
    return { ok: r.status === 0, status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// ---------------------------------------------------------------- preflight
function preflight(o = {}) {
    const ctx = context(o);
    let pins; try { pins = policy.images(); } catch (e) { return { ok: false, reason: e.message }; }
    try { cleanEnv(ctx.env); } catch (e) { return { ok: false, reason: e.message }; }
    // the daemon the CLI would talk to when DOCKER_HOST is not set comes from the active Docker context: it must also be a local socket
    if (!ctx.env.DOCKER_HOST) {
        const c = docker(ctx, ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']);
        if (c.ok) { const chk = checkLocalSocket(c.stdout.trim()); if (!chk.ok) return { ok: false, reason: `The active Docker context points to a daemon that is not local: ${chk.reason}. Nothing was changed.` }; }
        else if (c.status !== -1 && !/permission denied/i.test(c.stderr)) return { ok: false, reason: `The active Docker context could not be read (${c.stderr.trim().split('\n')[0]}), so it cannot be shown to be local. Nothing was changed.` };
    }
    const info = docker(ctx, ['info', '--format', '{{.ServerVersion}}']);
    if (!info.ok) {
        const denied = /permission denied/i.test(info.stderr);
        return { ok: false, reason: info.status === -1 && /not installed/.test(info.stderr) ? 'Docker is not installed. The sandbox needs it; without it only the static analysis and the live probe run.'
            : `Docker is installed but its daemon cannot be used${denied ? ' (permission denied on the Docker socket: this user is not in the "docker" group)' : ''}: ${info.stderr.trim().split('\n')[0]}. Nothing was changed.` };
    }
    const missing = [];
    for (const [k, img] of Object.entries(pins.images)) {
        const r = docker(ctx, ['image', 'inspect', '--format', '{{json .RepoDigests}}', img.ref]);
        let present = false; try { present = r.ok && JSON.parse(r.stdout).some(d => d.endsWith(`@${img.digest}`)); } catch { /* not JSON */ }
        if (!present) missing.push(k);
    }
    if (missing.length) return { ok: false, reason: `The pinned sandbox image(s) ${missing.join(', ')} are not present locally. Plugin Guard never pulls on its own: run  npm run guard:setup-sandbox` };
    return { ok: true, docker: info.stdout.trim(), pins };
}

// ---------------------------------------------------------------- labelled resources, teardown, sweep
function labelled(ctx, project) {
    const f = project ? `label=pg.project=${project}` : 'label=pg.sandbox=1';
    const lines = (args, cols) => { const r = docker(ctx, args); return r.ok ? r.stdout.split('\n').filter(Boolean).map(l => l.split('\t')) : []; };
    const guard = rows => rows.filter(r => r.every(Boolean));
    return {
        containers: guard(lines(['ps', '-a', '--filter', f, '--filter', 'label=pg.owner=plugin-guard', '--format', '{{.ID}}\t{{.Label "pg.project"}}\t{{.Label "pg.issue"}}'])).map(([id, project, issue]) => ({ id, project, issue })),
        volumes: guard(lines(['volume', 'ls', '--filter', f, '--filter', 'label=pg.owner=plugin-guard', '--format', '{{.Name}}\t{{.Label "pg.project"}}\t{{.Label "pg.issue"}}'])).map(([name, project, issue]) => ({ name, project, issue })),
        networks: guard(lines(['network', 'ls', '--filter', f, '--filter', 'label=pg.owner=plugin-guard', '--format', '{{.ID}}\t{{.Label "pg.project"}}\t{{.Label "pg.issue"}}'])).map(([id, project, issue]) => ({ id, project, issue }))
    };
}
// Files that the WordPress container creates inside the bind-mounted folders (the image seeds wp-content/plugins, PHP writes uploads and logs)
// belong to the container's user, which the host user cannot delete. Before the containers go, give them back: to container root under
// rootless Docker (root there IS the host user), to the host uid/gid otherwise. Runs only inside this project's own wordpress container.
function releaseOwnership(ctx, project, composeFile) {
    if (!composeFile || !fs.existsSync(composeFile) || !PROJECT_OK.test(project)) return false;
    const sec = docker(ctx, ['info', '--format', '{{.SecurityOptions}}']);
    const owner = /rootless/.test(sec.stdout) ? '0:0' : `${process.getuid()}:${process.getgid()}`;
    return docker(ctx, ['compose', '-p', project, '-f', composeFile, 'exec', '-T', '-u', '0', 'wordpress', 'chown', '-R', owner, '/var/www/html/wp-content', '/var/log/pg'], { timeoutMs: 120000 }).ok;
}
const PROJECT_OK = /^pgsb[0-9a-f]{8}$/;
function removeProject(ctx, project, composeFile) {
    const report = { project, compose_down: null, containers: 0, volumes: 0, networks: 0, leftovers: [] };
    report.ownership_released = releaseOwnership(ctx, project, composeFile);
    if (composeFile && fs.existsSync(composeFile)) report.compose_down = docker(ctx, ['compose', '-p', project, '-f', composeFile, 'down', '-v', '--remove-orphans', '--timeout', '5'], { timeoutMs: 180000 }).ok;
    // belt and braces: whatever still carries this project's label (only ours: both labels must match)
    const left = labelled(ctx, project);
    if (left.containers.length) { docker(ctx, ['rm', '-f', '-v', ...left.containers.map(c => c.id)]); report.containers = left.containers.length; }
    if (left.networks.length) { docker(ctx, ['network', 'rm', ...left.networks.map(n => n.id)]); report.networks = left.networks.length; }
    if (left.volumes.length) { docker(ctx, ['volume', 'rm', '-f', ...left.volumes.map(v => v.name)]); report.volumes = left.volumes.length; }
    const after = labelled(ctx, project);
    report.leftovers = [...after.containers.map(c => `container ${c.id}`), ...after.volumes.map(v => `volume ${v.name}`), ...after.networks.map(n => `network ${n.id}`)];
    return report;
}
function readState(dir) { try { return JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')); } catch { return null; } }
function removeDir(ctx, dir) {
    let st; try { st = fs.lstatSync(dir); } catch { return false; }
    const root = fs.realpathSync(ctx.sandboxesRoot);
    if (st.isSymbolicLink() || path.dirname(path.resolve(dir)) !== path.resolve(ctx.sandboxesRoot) || !inside(root, fs.realpathSync(dir))) throw new SandboxRefusal(`will not delete ${dir}: it is not a plain sandbox folder directly inside ${root}`);
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
}
// Removes one sandbox completely: containers, volumes, networks, and the folder (compose.json, wp-config.php, any dump, logs).
function destroy(issueId, o = {}) {
    const ctx = context(o), dir = path.join(ctx.sandboxesRoot, issueId);
    const state = readState(dir);
    const project = state && state.project;
    const report = project ? removeProject(ctx, project, path.join(dir, 'compose.json')) : { project: null, leftovers: [] };
    report.dir_removed = fs.existsSync(dir) ? removeDir(ctx, dir) : false;
    active.delete(issueId);
    return report;
}
const pidAlive = pid => { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
// Removes what a crashed run left behind. Never touches an unlabelled resource and never a sandbox whose owner process is alive.
function sweep(o = {}) {
    const ctx = context(o), out = { removed: [], kept: [], dirs_removed: [] };
    let dirs = []; try { dirs = readdir(ctx.sandboxesRoot).filter(n => /^iss-/.test(n)); } catch { /* no sandboxes yet */ }
    const byProject = new Map();
    for (const n of dirs) { const st = readState(path.join(ctx.sandboxesRoot, n)); if (st && st.project) byProject.set(st.project, { dir: path.join(ctx.sandboxesRoot, n), issue: n, state: st }); }
    const all = labelled(ctx);
    const projects = new Set([...all.containers, ...all.volumes, ...all.networks].map(r => r.project));
    for (const project of [...projects].sort()) {
        const owner = byProject.get(project);
        if (owner && pidAlive(owner.state.pid) && owner.state.pid !== process.pid) { out.kept.push({ project, reason: `its owner process ${owner.state.pid} is still running` }); continue; }
        if (owner && owner.state.pid === process.pid && active.has(owner.issue)) { out.kept.push({ project, reason: 'owned by this process' }); continue; }
        const r = removeProject(ctx, project, owner && path.join(owner.dir, 'compose.json'));
        out.removed.push({ project, containers: r.containers, volumes: r.volumes, networks: r.networks, leftovers: r.leftovers });
        if (owner) { try { if (removeDir(ctx, owner.dir)) out.dirs_removed.push(owner.issue); } catch { /* reported by leftovers */ } byProject.delete(project); }
    }
    for (const [project, owner] of byProject) { // folders with no containers left, whose owner is gone
        if (pidAlive(owner.state.pid) && owner.state.pid !== process.pid) continue;
        if (owner.state.pid === process.pid && active.has(owner.issue)) continue;
        try { if (removeDir(ctx, owner.dir)) out.dirs_removed.push(owner.issue); } catch { /* not a plain folder: left alone */ }
    }
    return out;
}

// ---------------------------------------------------------------- teardown that cannot be skipped
const active = new Map(); // issueId -> { opts }
let handlersInstalled = false;
function installHandlers() {
    if (handlersInstalled) return; handlersInstalled = true;
    const teardownAll = () => { for (const [id, a] of [...active]) { try { destroy(id, a.opts); } catch { /* best effort: the next sweep will finish it */ } } };
    for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) process.on(sig, () => { teardownAll(); process.exit(code); });
    process.on('uncaughtException', e => { teardownAll(); console.error(e && e.stack || e); process.exit(1); });
    process.on('exit', teardownAll); // synchronous: Docker is driven with spawnSync, so this works inside an exit handler
}

// ---------------------------------------------------------------- creation
function detectPrefix(file) {
    const fd = fs.openSync(file, 'r'), buf = Buffer.alloc(1 << 20);
    const names = new Set(); let tail = '';
    try {
        for (let pos = 0; ; pos += buf.length) {
            const n = fs.readSync(fd, buf, 0, buf.length, pos); if (!n) break;
            const text = tail + buf.toString('utf8', 0, n);
            for (const m of text.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?`([A-Za-z0-9_]+)`/g)) names.add(m[1]);
            tail = text.slice(-200);
            for (const nm of names) { const m = /^(.*)options$/.exec(nm); if (m && names.has(`${m[1]}users`) && names.has(`${m[1]}posts`)) return m[1]; }
        }
    } finally { fs.closeSync(fd); }
    return null;
}

const USER_STEPS = []; // documented for the report
function create(issueId, o = {}) {
    const ctx = context(o), steps = [], warnings = [];
    const step = (id, status, reason) => steps.push({ id, status, reason: reason || null });
    if (!/^iss-[0-9]{8}-[0-9]{6}-[0-9a-f]{6}$/.test(issueId)) throw new SandboxUnavailable(`"${issueId}" is not an issue id`);
    if (!o.root) throw new SandboxUnavailable('a local copy of the WordPress site is needed (--root)');
    const root = fs.realpathSync(o.root);
    if (!fs.existsSync(path.join(root, 'wp-content'))) throw new SandboxUnavailable(`${root} has no wp-content folder`);
    // the overlap check comes BEFORE anything is created: refusing must not leave even an empty folder inside the original site
    const wanted = path.resolve(ctx.sandboxesRoot);
    if (inside(root, wanted) || inside(wanted, root)) throw new SandboxRefusal(`the sandboxes folder ${wanted} and the site ${root} overlap: files there could be downloaded by visitors, or copied into themselves`);
    fs.mkdirSync(ctx.sandboxesRoot, { recursive: true, mode: 0o700 });
    const sbRoot = fs.realpathSync(ctx.sandboxesRoot);
    if (inside(root, sbRoot) || inside(sbRoot, root)) throw new SandboxRefusal(`the sandboxes folder ${sbRoot} and the site ${root} overlap: files there could be downloaded by visitors, or copied into themselves`);
    ctx.originals = [root, ...(ctx.originals || [])];

    const pf = preflight(o);
    if (!pf.ok) throw new SandboxUnavailable(pf.reason);
    step('preflight', 'PASSED', `Docker ${pf.docker}; the 3 pinned images (${Object.values(pf.pins.images).map(i => i.tag).join(', ')}) are present locally`);
    const sw = sweep(o); if (sw.removed.length || sw.dirs_removed.length) step('sweep', 'PASSED', `removed ${sw.removed.length} leftover sandbox(es) of earlier runs`);

    const dir = path.join(sbRoot, issueId);
    if (fs.existsSync(dir)) throw new SandboxUnavailable(`a sandbox folder for ${issueId} already exists: run  issue sandbox destroy ${issueId}`);
    const project = policy.newProject();
    fs.mkdirSync(dir, { mode: 0o700 });
    for (const d of ['site', 'db', 'logs']) fs.mkdirSync(path.join(dir, d), { mode: d === 'logs' ? 0o777 : 0o700 });
    fs.chmodSync(path.join(dir, 'logs'), 0o777); // the container user writes the debug and block logs here; the parent folder is 0700
    const writeState = patch => { const st = { ...(readState(dir) || {}), ...patch }; fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(st, null, 2), { mode: 0o600 }); return st; };
    writeState({ project, issue: issueId, pid: process.pid, created_at: new Date().toISOString(), status: 'creating' });
    active.set(issueId, { opts: o }); installHandlers();

    try {
        // ---- the copy ----
        const rep = copy.copySite(root, path.join(dir, 'site'), { sandboxDir: dir, withUploads: !!o.withUploads, maxBytes: o.maxMb ? o.maxMb * 1048576 : undefined });
        step('copy', 'PASSED', `${rep.files} files (${Math.round(rep.bytes / 1048576)} MB) copied; ${rep.symlinks_skipped} symbolic link(s) not followed; ${rep.skipped_total} item(s) skipped (${Object.entries(rep.skipped_by_reason).map(([k, v]) => `${v} ${k}`).join('; ') || 'none'}); uploads ${rep.uploads_copied ? 'copied' : 'not copied'}`);
        // ---- generated files ----
        let prefix = 'wp_';
        let dumpFile = null;
        if (o.dump) {
            const st = fs.lstatSync(o.dump);
            if (!st.isFile() || st.isSymbolicLink()) throw new SandboxUnavailable(`--db-dump ${o.dump} is not a plain file`);
            if (st.size > (o.maxDumpMb || 1024) * 1048576) throw new SandboxUnavailable(`the dump is ${Math.round(st.size / 1048576)} MB, above the ${o.maxDumpMb || 1024} MB cap`);
            dumpFile = path.join(dir, 'db', 'dump.sql');
            fs.copyFileSync(o.dump, dumpFile); fs.chmodSync(dumpFile, 0o600);   // a copy: the original dump is never modified
            const p = detectPrefix(dumpFile); if (p) prefix = p; else warnings.push('the table prefix could not be read from the dump; "wp_" was assumed');
        } else if (o.exportDatabase) {   // a read of the ORIGINAL database by WP-CLI on this computer, to the fixed dump path (see lib/wpcli.js)
            dumpFile = path.join(dir, 'db', 'dump.sql');
            const ex = o.exportDatabase(dumpFile);
            if (!ex.ok) throw new SandboxUnavailable(`wp db export failed: ${ex.error || 'unknown error'}`);
            fs.chmodSync(dumpFile, 0o600);
            const p = detectPrefix(dumpFile); if (p) prefix = p; else warnings.push('the table prefix could not be read from the export; "wp_" was assumed');
        }
        const creds = { root: policy.rand(), user: 'wp', pass: policy.rand(), name: 'wordpress' };
        fs.writeFileSync(path.join(dir, 'site', 'wp-config.php'), cfg.wpConfig({ creds, prefix }), { mode: 0o644 });
        fs.writeFileSync(path.join(dir, 'site', 'wp-content', 'mu-plugins', 'pg-sandbox-guard.php'), cfg.MU_PLUGIN, { mode: 0o644 });
        const themes = fs.existsSync(path.join(dir, 'site', 'wp-content', 'themes')) ? readdir(path.join(dir, 'site', 'wp-content', 'themes'), { withFileTypes: true }).filter(e => e.isDirectory() && /^[A-Za-z0-9._-]+$/.test(e.name)).map(e => e.name).sort() : [];
        const spec = policy.buildSpec({ project, issueId, siteDir: path.join(dir, 'site'), logDir: path.join(dir, 'logs'), themes, hasLanguages: fs.existsSync(path.join(dir, 'site', 'wp-content', 'languages')), creds });
        const violations = policy.validateSpec(spec, { sandboxDir: dir });
        if (violations.length) throw new SandboxRefusal(`the container specification breaks a safeguard, nothing was started:\n  - ${violations.join('\n  - ')}`);
        const composeFile = path.join(dir, 'compose.json');
        fs.writeFileSync(composeFile, JSON.stringify(spec, null, 2), { mode: 0o600 });
        const chk = docker(ctx, ['compose', '-p', project, '-f', composeFile, 'config', '--quiet']);
        if (!chk.ok) throw new SandboxUnavailable(`Docker Compose rejected the specification: ${chk.stderr.trim().split('\n')[0]}`);
        step('spec', 'PASSED', `container specification checked against ${Object.keys(spec.services).length * 12}+ safeguards and by Docker Compose; project ${project}`);

        // ---- start ----
        const up = docker(ctx, ['compose', '-p', project, '-f', composeFile, 'up', '-d', '--wait', '--wait-timeout', '240'], { timeoutMs: 300000 });
        if (!up.ok) throw new SandboxUnavailable(`the containers did not start: ${up.stderr.trim().split('\n').slice(-3).join(' | ')}`);
        const portOut = docker(ctx, ['compose', '-p', project, '-f', composeFile, 'port', 'wordpress', '80']);
        const m = /^(\d+\.\d+\.\d+\.\d+|\[[0-9a-f:]+\]):(\d+)$/.exec(portOut.stdout.trim().split('\n')[0] || '');
        if (!m || m[1] !== '127.0.0.1') throw new SandboxRefusal(`the WordPress port is published on "${portOut.stdout.trim()}", not on 127.0.0.1: refusing`);
        const url = `http://127.0.0.1:${m[2]}`;
        fs.writeFileSync(path.join(dir, 'logs', 'url.txt'), url, { mode: 0o644 });
        const wp = new SandboxWpCli({ sandboxesRoot: ctx.sandboxesRoot, sandboxDir: dir, project, originals: ctx.originals, dockerBin: ctx.dockerBin, runner: ctx.runner, env: ctx.env });
        for (let i = 0; i < 90; i++) { if (wp.run(['core', 'version']).ok) break; if (i === 89) throw new SandboxUnavailable('WordPress core did not become available in the sandbox'); sleep(1000); }
        step('start', 'PASSED', `containers up; WordPress on ${url} (bound to 127.0.0.1 only)`);
        writeState({ status: 'starting', url, port: Number(m[2]) });

        // ---- database ----
        let realData = false;
        if (dumpFile) {
            const imp = wp.importDump(fs.readFileSync(dumpFile));
            if (!imp.ok) throw new SandboxUnavailable(`the database import failed: ${imp.stderr.trim().split('\n')[0]}`);
            fs.rmSync(dumpFile, { force: true });   // the raw dump (real data) is gone as soon as it is imported
            realData = true; step('database', 'PASSED', 'dump imported over stdin (never mounted into a container); the raw dump file was deleted right after the import');
        } else {
            const pass = policy.rand(16) + 'aA1';
            const inst = wp.run(['core', 'install', `--url=${url}`, '--title=Plugin Guard sandbox', '--admin_user=pgadmin', `--admin_password=${pass}`, '--admin_email=admin@example.invalid', '--skip-email']);
            if (!inst.ok) throw new SandboxUnavailable(`WordPress could not be installed in the sandbox: ${inst.stderr.trim().split('\n')[0]}`);
            step('database', 'PASSED', 'no dump was given: fresh WordPress install (the plugins of the copy are not active; activate them with the bisect or --activate-all)');
        }
        const tablesOut = wp.sql('SHOW TABLES');
        const tables = tablesOut.ok ? tablesOut.stdout.split('\n').slice(1).map(s => s.trim()).filter(t => t.startsWith(prefix)).map(t => t.slice(prefix.length)) : [];

        // ---- payment gateways: BEFORE anything is blanked, so a live gateway cannot hide ----
        const rows = wp.sql(`SELECT option_name, option_value FROM \`${prefix}options\` WHERE option_name LIKE 'woocommerce\\_%\\_settings'`);
        const modes = cfg.gatewayModes(rows.ok ? rows.stdout.split('\n').slice(1).filter(Boolean).map(l => { const [option_name, ...v] = l.split('\t'); return { option_name, option_value: v.join('\t') }; }) : []);
        const blocking = cfg.blockingGateways(modes);
        if (blocking.length && !o.neutralisePayments) throw new SandboxRefusal(`payment gateway(s) enabled in LIVE or UNKNOWN mode: ${blocking.map(g => `${g.gateway} (${g.why})`).join('; ')}. The sandbox will not start with a gateway that could take a real payment. Re-run with --neutralise-payments to switch them off in the sandbox copy.`);
        if (blocking.length) { wp.sql(cfg.neutraliseSql(prefix)); step('payments', 'PASSED', `NEUTRALISED: ${blocking.map(g => g.gateway).join(', ')} switched off in the sandbox database (the original is untouched)`); }
        else step('payments', 'PASSED', modes.length ? `${modes.length} gateway setting(s) found, none enabled in live mode` : 'no payment gateway settings found');

        // ---- anonymise: the default ----
        const personal = !o.keepRealData;
        const an = cfg.anonymiseSql(prefix, tables, { personal, secrets: true });
        for (const s of an.statements) { const r = wp.sql(s); if (!r.ok) throw new SandboxUnavailable(`anonymisation failed: ${r.stderr.trim().split('\n')[0]}`); }
        if (!realData) step('anonymise', 'SKIPPED', 'no real database was imported, so there is nothing to anonymise');
        else if (personal) step('anonymise', 'PASSED', `users, e-mail addresses, password hashes, comments and WooCommerce orders scrubbed (${an.covered.join(', ')}); API keys, tokens and payment settings blanked. NOT scrubbed (tables of other plugins): ${an.unscrubbed.length ? an.unscrubbed.slice(0, 15).join(', ') : 'none'}${an.unscrubbed.length > 15 ? ', ...' : ''}`);
        else { warnings.push('REAL PERSONAL DATA is in this sandbox (--keep-real-data): user names, e-mail addresses and password hashes of the original site were kept. API keys and payment settings were still blanked. Destroy the sandbox as soon as you are done; it is deleted when the investigation ends.'); step('anonymise', 'PASSED', 'KEPT REAL DATA on request (--keep-real-data); secrets still blanked'); }

        // ---- address ----
        if (realData) {
            const old = wp.sql(`SELECT option_value FROM \`${prefix}options\` WHERE option_name = 'siteurl'`);
            const oldUrl = old.ok ? (old.stdout.split('\n')[1] || '').trim() : '';
            if (/^https?:\/\//.test(oldUrl) && oldUrl.replace(/\/$/, '') !== url) {
                const sr = wp.run(['search-replace', oldUrl.replace(/\/$/, ''), url, '--all-tables', '--skip-columns=guid']);
                step('address', sr.ok ? 'PASSED' : 'FAILED', sr.ok ? `${oldUrl} replaced by ${url} in the sandbox database` : sr.stderr.trim().split('\n')[0]);
            }
        }
        wp.run(['option', 'update', 'blog_public', '0']);
        writeState({ status: 'ready' });
        const handle = {
            id: issueId, project, dir, url, port: Number(m[2]), prefix, wp, steps, warnings, composeFile, real_data: realData && !personal,
            anonymised: realData && personal, limits: policy.LIMITS, copy: rep, tables_unscrubbed: an.unscrubbed,
            destroy: () => destroy(issueId, o)
        };
        return handle;
    } catch (e) {
        try { destroy(issueId, o); } catch { /* the sweep will finish it */ }
        throw e;
    }
}

function list(o = {}) {
    const ctx = context(o); let dirs = [];
    try { dirs = readdir(ctx.sandboxesRoot).filter(n => /^iss-/.test(n)); } catch { /* none */ }
    return dirs.map(n => ({ issue: n, ...(readState(path.join(ctx.sandboxesRoot, n)) || {}), alive: pidAlive((readState(path.join(ctx.sandboxesRoot, n)) || {}).pid) }));
}

module.exports = { create, destroy, sweep, preflight, list, detectPrefix, labelled, removeProject, sandboxesRoot, SandboxUnavailable, SandboxRefusal, active, docker, context };
