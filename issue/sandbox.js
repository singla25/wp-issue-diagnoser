// The sandbox lifecycle: create a throwaway copy of a site in Docker, hand back a WP-CLI that can only act on it, and ALWAYS tear it down.
//
// Order of work in create():  preflight (daemon reachable, pinned images present locally: nothing is pulled) -> sweep leftovers of earlier
// crashed runs -> sandbox folder (0700) with state.json -> copy the site (sandbox-copy.js) -> generated wp-config.php (fresh salts, random
// DB credentials) and must-use guard plugin -> compose.json, checked by validateSpec() and by `docker compose config` -> up (database still
// empty) -> the port must be on 127.0.0.1 -> core present. Without a dump: fresh install -> payment gateways -> (nothing to anonymise).
// With a dump (checked and unpacked by lib/dump-intake.js): STOP the web container -> import (streamed over stdin, never mounted; the temporary
// copy is deleted right after) -> payment gateways -> anonymise -> START the web container -> read its new port (127.0.0.1 only) -> rewrite
// siteurl and home -> front-page check. No web container runs while real rows are in the database (unless --keep-real-data was chosen);
// if the import or anonymisation fails, the web container is never started again and everything is destroyed.
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
const intake = require('../lib/dump-intake');

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
    if (/^iss-[0-9A-Za-z-]+$/.test(String(issueId)) && fs.existsSync(dir)) removeDumpCopy(dir);   // the raw dump copy first, whatever happens to the rest
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
// The published port of the web container, checked to be on 127.0.0.1 (read after `up` and again after every start: it changes).
function readPort(ctx, project, composeFile) {
    const portOut = docker(ctx, ['compose', '-p', project, '-f', composeFile, 'port', 'wordpress', '80']);
    const m = /^(\d+\.\d+\.\d+\.\d+|\[[0-9a-f:]+\]):(\d+)$/.exec(portOut.stdout.trim().split('\n')[0] || '');
    if (!m || m[1] !== '127.0.0.1') throw new SandboxRefusal(`the WordPress port is published on "${portOut.stdout.trim()}", not on 127.0.0.1: refusing`);
    return { url: `http://127.0.0.1:${m[2]}`, port: Number(m[2]) };
}
// true / false / null (cannot tell): is this project's web container running?
function webRunning(ctx, project, composeFile) {
    const r = docker(ctx, ['compose', '-p', project, '-f', composeFile, 'ps', '-q', '--status', 'running', 'wordpress']);
    if (!r.ok) return null;
    return r.stdout.trim().length > 0;
}
// Apache answers inside the web container (any HTTP status counts, redirects are not followed): asked with the image's own PHP, no host request.
const READY_PHP = "$c=stream_context_create(['http'=>['timeout'=>3,'follow_location'=>0,'ignore_errors'=>true]]);@file_get_contents('http://127.0.0.1/',false,$c);$h=function_exists('http_get_last_response_headers')?http_get_last_response_headers():(isset($http_response_header)?$http_response_header:null);exit($h?0:1);";
function waitForWeb(ctx, project, composeFile, tries = 90) {
    for (let i = 0; i < tries; i++) {
        if (docker(ctx, ['compose', '-p', project, '-f', composeFile, 'exec', '-T', 'wordpress', 'php', '-r', READY_PHP], { timeoutMs: 20000 }).ok) return true;
        sleep(1000);
    }
    return false;
}
// One GET of the sandbox's front page from this computer, 127.0.0.1 only, no redirect followed. -> { status } or { error }
function httpStatus(url, timeoutMs = 20000) {
    if (!/^http:\/\/127\.0\.0\.1:\d{2,5}\/?$/.test(url)) return { error: 'not a sandbox address' };
    const js = "const h=require('http');const q=h.get(process.argv[1],{timeout:15000},r=>{process.stdout.write(String(r.statusCode));r.resume();r.on('end',()=>process.exit(0));});q.on('timeout',()=>q.destroy(new Error('timeout')));q.on('error',e=>{process.stderr.write(String(e.code||e.message));process.exit(1);});";
    const r = spawnSync(process.execPath, ['-e', js, url.replace(/\/?$/, '/')], { encoding: 'utf8', timeout: timeoutMs, env: { PATH: '/usr/local/bin:/usr/bin:/bin' }, shell: false });
    const status = Number((r.stdout || '').trim());
    return r.status === 0 && status > 0 ? { status } : { error: (r.stderr || '').trim() || (r.error && r.error.message) || 'no response' };
}
// the temporary dump copy, removed on its own (lstat: only a plain file is unlinked; a symlink there is unlinked, never followed)
function removeDumpCopy(dir) {
    const f = path.join(dir, 'db', 'dump.sql');
    try { fs.lstatSync(f); fs.rmSync(f, { force: true }); return true; } catch { return false; }
}

function create(issueId, o = {}) {
    const ctx = context(o), steps = [], warnings = [];
    const hooks = o.hooks || {};   // test-only observation points (beforeImport, afterImport, beforeWebStart); never set by a command
    const pageCheck = typeof o.pageCheck === 'function' ? o.pageCheck : httpStatus;
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
            // a checked, owner-only (0600) copy, unpacked when it is a .gz; the cap counts unpacked bytes (lib/dump-intake.js). The original is only read.
            dumpFile = path.join(dir, 'db', 'dump.sql');
            let got;
            try { got = intake.intake(o.dump, dumpFile, { maxMb: o.maxDumpMb || intake.DEFAULT_CAP_MB }); }
            catch (e) { if (e.name === 'DumpRefused') throw new SandboxUnavailable(e.message); throw e; }
            step('dump', 'PASSED', `database file accepted (${got.gzip ? 'gzip, unpacked as a stream' : 'plain SQL'}; ${Math.max(1, Math.round(got.bytes / 1048576))} MB unpacked, cap ${o.maxDumpMb || intake.DEFAULT_CAP_MB} MB); temporary owner-only copy in the sandbox folder, never mounted`);
            const p = detectPrefix(dumpFile); if (p) prefix = p; else warnings.push('the table prefix could not be read from the dump; "wp_" was assumed');
        } else if (o.exportDatabase) {   // a read of the ORIGINAL database by WP-CLI on this computer, to the fixed dump path (see lib/wpcli.js)
            dumpFile = path.join(dir, 'db', 'dump.sql');
            const ex = o.exportDatabase(dumpFile);
            if (!ex.ok) throw new SandboxUnavailable(`wp db export failed: ${ex.error || 'unknown error'}`);
            fs.chmodSync(dumpFile, 0o600);
            try { intake.checkFile(dumpFile, { maxMb: o.maxDumpMb || intake.DEFAULT_CAP_MB }); } catch (e) { if (e.name === 'DumpRefused') throw new SandboxUnavailable(e.message); throw e; }
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

        // ---- start: all three containers, the database still EMPTY ----
        const up = docker(ctx, ['compose', '-p', project, '-f', composeFile, 'up', '-d', '--wait', '--wait-timeout', '240'], { timeoutMs: 300000 });
        if (!up.ok) throw new SandboxUnavailable(`the containers did not start: ${up.stderr.trim().split('\n').slice(-3).join(' | ')}`);
        let { url, port } = readPort(ctx, project, composeFile);
        fs.writeFileSync(path.join(dir, 'logs', 'url.txt'), url, { mode: 0o644 });
        const wp = new SandboxWpCli({ sandboxesRoot: ctx.sandboxesRoot, sandboxDir: dir, project, originals: ctx.originals, dockerBin: ctx.dockerBin, runner: ctx.runner, env: ctx.env });
        // the web image's entrypoint fills the shared core volume on its first start; the WP-CLI container needs it
        for (let i = 0; i < 90; i++) { if (wp.run(['core', 'version']).ok) break; if (i === 89) throw new SandboxUnavailable('WordPress core did not become available in the sandbox'); sleep(1000); }
        step('start', 'PASSED', `containers up; WordPress on ${url} (bound to 127.0.0.1 only)`);
        writeState({ status: 'starting', url, port });

        // ---- database ----
        // With a dump, real rows exist from the import until the anonymisation is done. During that time the web container is STOPPED, so no
        // page can run against them: stop web -> import -> payment check -> anonymise (all through the WP-CLI container) -> start web again.
        // If anything in between fails, the web container is never started again and the sandbox is destroyed (catch below).
        let realData = false;
        if (dumpFile) {
            releaseOwnership(ctx, project, composeFile);   // while the web container still runs: files its first start created go back to this user
            const stop = docker(ctx, ['compose', '-p', project, '-f', composeFile, 'stop', '--timeout', '10', 'wordpress'], { timeoutMs: 120000 });
            if (!stop.ok) throw new SandboxUnavailable(`the web container could not be stopped before the import, so the import was not started: ${stop.stderr.trim().split('\n')[0]}`);
            if (webRunning(ctx, project, composeFile) !== false) throw new SandboxRefusal('the web container is still running (or its state cannot be read) after it was stopped: the database was not imported');
            writeState({ status: 'importing', web: 'stopped' });
            step('web-stopped', 'PASSED', 'the web container was stopped before the import: no page can run while real rows are in the database');
            if (hooks.beforeImport) hooks.beforeImport({ project, composeFile, wp });
            let imp;
            try { imp = wp.importDump({ file: dumpFile }); }
            finally { fs.rmSync(dumpFile, { force: true }); }   // the raw dump (real data) is gone as soon as the import ends, also when it failed
            if (!imp.ok) throw new SandboxUnavailable(`the database import failed: ${imp.stderr.trim().split('\n')[0]}`);
            if (hooks.afterImport) hooks.afterImport({ project, composeFile, wp });
            realData = true; step('database', 'PASSED', 'dump streamed over stdin into the database while the web container was stopped (never mounted into a container); the temporary dump copy was deleted right after the import');
        } else {
            const pass = policy.rand(16) + 'aA1';
            const inst = wp.run(['core', 'install', `--url=${url}`, '--title=Plugin Guard sandbox', '--admin_user=pgadmin', `--admin_password=${pass}`, '--admin_email=admin@example.invalid', '--skip-email']);
            if (!inst.ok) throw new SandboxUnavailable(`WordPress could not be installed in the sandbox: ${inst.stderr.trim().split('\n')[0]}`);
            step('database', 'PASSED', 'no dump was given: fresh WordPress install (the plugins of the copy are not active; activate them with the bisect or --activate-all)');
        }
        const personal = !o.keepRealData;
        const NOT_STARTED = 'The web container was not started again and the test copy was removed.';
        const tablesOut = wp.sql('SHOW TABLES');
        const tables = tablesOut.ok ? tablesOut.stdout.split('\n').slice(1).map(s => s.trim()).filter(t => t.startsWith(prefix)).map(t => t.slice(prefix.length)) : [];
        // with real rows, personal data can only be removed from tables that are known: fail closed when they are not
        if (realData && personal) {
            if (!tablesOut.ok) throw new SandboxUnavailable(`the tables of the imported database could not be listed (${tablesOut.stderr.trim().split('\n')[0] || 'no answer'}), so personal data could not be removed. ${NOT_STARTED}`);
            if (!tables.length) throw new SandboxUnavailable(`the imported database has no table with the prefix "${prefix}", so personal data could not be removed (is this the export of this site?). ${NOT_STARTED}`);
            if (!tables.includes('users')) throw new SandboxUnavailable(`the users table "${prefix}users" was not found in the imported database (the table prefix may be wrong), so user accounts could not be removed. ${NOT_STARTED}`);
        }

        // ---- payment gateways: BEFORE anything is blanked, so a live gateway cannot hide ----
        const rows = wp.sql(`SELECT option_name, option_value FROM \`${prefix}options\` WHERE option_name LIKE 'woocommerce\\_%\\_settings'`);
        if (!rows.ok) throw new SandboxUnavailable(`the payment gateway settings could not be read (${rows.stderr.trim().split('\n')[0] || 'no answer'}), so it cannot be shown that no live gateway is switched on. ${NOT_STARTED}`);
        const modes = cfg.gatewayModes(rows.stdout.split('\n').slice(1).filter(Boolean).map(l => { const [option_name, ...v] = l.split('\t'); return { option_name, option_value: v.join('\t') }; }));
        const blocking = cfg.blockingGateways(modes);
        if (blocking.length && !o.neutralisePayments) throw new SandboxRefusal(`payment gateway(s) enabled in LIVE or UNKNOWN mode: ${blocking.map(g => `${g.gateway} (${g.why})`).join('; ')}. The sandbox will not start with a gateway that could take a real payment. Re-run with --neutralise-payments to switch them off in the sandbox copy.`);
        if (blocking.length) {
            const nz = wp.sql(cfg.neutraliseSql(prefix));
            if (!nz.ok) throw new SandboxUnavailable(`the live payment gateway(s) ${blocking.map(g => g.gateway).join(', ')} could not be switched off (${nz.stderr.trim().split('\n')[0] || 'no answer'}). ${NOT_STARTED}`);
            step('payments', 'PASSED', `NEUTRALISED: ${blocking.map(g => g.gateway).join(', ')} switched off in the sandbox database (the original is untouched)`);
        }
        else step('payments', 'PASSED', modes.length ? `${modes.length} gateway setting(s) found, none enabled in live mode` : 'no payment gateway settings found');

        // ---- anonymise: the default ----
        const an = cfg.anonymiseSql(prefix, tables, { personal, secrets: true });
        for (const s of an.statements) { const r = wp.sql(s); if (!r.ok) throw new SandboxUnavailable(`anonymisation failed: ${r.stderr.trim().split('\n')[0]}`); }
        if (realData && personal) {
            if (!an.covered.includes('users')) throw new SandboxUnavailable(`the users table was not anonymised. ${NOT_STARTED}`);
            // re-check: every user row must now carry the placeholder login and address
            const chk = wp.sql(`SELECT COUNT(*) AS pg_unscrubbed FROM \`${prefix}users\` WHERE user_login <> CONCAT('user', ID) OR user_email <> CONCAT('user', ID, '@example.invalid')`);
            const n = chk.ok ? (chk.stdout.split('\n')[1] || '').trim() : '';
            if (!/^\d+$/.test(n)) throw new SandboxUnavailable(`the anonymisation of the users table could not be checked (${chk.ok ? 'unexpected answer' : chk.stderr.trim().split('\n')[0] || 'no answer'}). ${NOT_STARTED}`);
            if (n !== '0') throw new SandboxUnavailable(`after the anonymisation ${n} user row(s) still had a real login or e-mail address. ${NOT_STARTED}`);
        }
        if (!realData) step('anonymise', 'SKIPPED', 'no real database was imported, so there is nothing to anonymise');
        else if (personal) step('anonymise', 'PASSED', `users, e-mail addresses, password hashes, comments and WooCommerce orders scrubbed (${an.covered.join(', ')}); API keys, tokens and payment settings blanked. NOT scrubbed (tables of other plugins): ${an.unscrubbed.length ? an.unscrubbed.slice(0, 15).join(', ') : 'none'}${an.unscrubbed.length > 15 ? ', ...' : ''}`);
        else { warnings.push('REAL PERSONAL DATA is in this sandbox (--keep-real-data): user names, e-mail addresses and password hashes of the original site were kept. API keys and payment settings were still blanked. Destroy the sandbox as soon as you are done; it is deleted when the investigation ends.'); step('anonymise', 'PASSED', 'KEPT REAL DATA on request (--keep-real-data); secrets still blanked'); }

        // ---- web container back, then the address ----
        if (dumpFile) {
            if (hooks.beforeWebStart) hooks.beforeWebStart({ project, composeFile, wp, prefix });
            const start = docker(ctx, ['compose', '-p', project, '-f', composeFile, 'start', 'wordpress'], { timeoutMs: 180000 });
            if (!start.ok) throw new SandboxUnavailable(`the web container did not start again after the import: ${start.stderr.trim().split('\n')[0]}`);
            ({ url, port } = readPort(ctx, project, composeFile));   // the host port is chosen anew on every start: read it again, 127.0.0.1 only
            fs.writeFileSync(path.join(dir, 'logs', 'url.txt'), url, { mode: 0o644 });
            writeState({ status: 'starting', web: 'running', url, port });
            if (!waitForWeb(ctx, project, composeFile)) throw new SandboxUnavailable('the web container started again but Apache did not answer within 90 seconds');
            step('web-started', 'PASSED', `the web container was started again after the ${personal ? 'anonymisation' : 'import (real data kept on request)'}; WordPress on ${url} (bound to 127.0.0.1 only)`);
            // siteurl and home are read and replaced separately (they can differ, e.g. WordPress in a sub-folder); the longer one first
            const readOpt = name => { const r = wp.sql(`SELECT option_value FROM \`${prefix}options\` WHERE option_name = '${name}'`); return r.ok ? (r.stdout.split('\n')[1] || '').trim() : ''; };
            const olds = { siteurl: readOpt('siteurl'), home: readOpt('home') };
            const done = [], failed = [];
            for (const old of [...new Set(Object.values(olds).map(v => v.replace(/\/$/, '')).filter(v => /^https?:\/\//.test(v) && v !== url))].sort((a, b) => b.length - a.length || (a < b ? -1 : 1))) {
                const sr = wp.run(['search-replace', old, url, '--all-tables', '--skip-columns=guid']);
                (sr.ok ? done : failed).push(sr.ok ? old : `${old}: ${sr.stderr.trim().split('\n')[0]}`);
            }
            for (const name of ['siteurl', 'home']) { const r = wp.run(['option', 'update', name, url]); if (!r.ok) failed.push(`${name}: ${r.stderr.trim().split('\n')[0]}`); }
            if (done.length || failed.length) step('address', failed.length ? 'FAILED' : 'PASSED', failed.length ? failed.join('; ') : `${done.join(' and ')} replaced by ${url} in the sandbox database (all tables, serialised values included, guid column skipped); siteurl and home set to ${url}`);
            else step('address', 'PASSED', `siteurl and home set to ${url}`);
        }
        wp.run(['option', 'update', 'blog_public', '0']);
        if (dumpFile) {
            const pc = pageCheck(url);
            step('page', pc.status ? 'PASSED' : 'FAILED', pc.status ? `the front page of the sandbox answered HTTP ${pc.status}${pc.status >= 500 ? ' (an error page: this may be the reported problem)' : ''}` : `the front page of the sandbox did not answer: ${pc.error || 'no response'}`);
        }
        writeState({ status: 'ready', url, port });
        const handle = {
            id: issueId, project, dir, url, port, prefix, wp, steps, warnings, composeFile, real_data: realData && !personal,
            anonymised: realData && personal, limits: policy.LIMITS, copy: rep, tables_unscrubbed: an.unscrubbed,
            destroy: () => destroy(issueId, o)
        };
        return handle;
    } catch (e) {
        removeDumpCopy(dir);   // first, on its own: the raw dump must go even if the folder cannot be removed
        try { destroy(issueId, o); } catch { /* the sweep will finish it */ }
        throw e;
    }
}

function list(o = {}) {
    const ctx = context(o); let dirs = [];
    try { dirs = readdir(ctx.sandboxesRoot).filter(n => /^iss-/.test(n)); } catch { /* none */ }
    return dirs.map(n => ({ issue: n, ...(readState(path.join(ctx.sandboxesRoot, n)) || {}), alive: pidAlive((readState(path.join(ctx.sandboxesRoot, n)) || {}).pid) }));
}

module.exports = { create, destroy, sweep, preflight, list, detectPrefix, labelled, removeProject, sandboxesRoot, SandboxUnavailable, SandboxRefusal, active, docker, context, readPort, webRunning, httpStatus };
