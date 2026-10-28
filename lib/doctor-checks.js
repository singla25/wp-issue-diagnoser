// Prerequisite checks that `guard.js doctor` prints, as functions that take their commands as a parameter so they can be tested without Docker.
// Each check: { name, ok, required, detail }. Nothing here changes anything: it runs `--version`/`info` style queries and reads package files.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { checkLocalSocket } = require('../issue/sandbox-wpcli');

const run = (bin, args, runner = spawnSync) => { const r = runner(bin, args, { encoding: 'utf8', timeout: 20000, shell: false }); return r.error ? { ok: false, missing: r.error.code === 'ENOENT', out: '', err: String(r.error.message) } : { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() }; };

// docker CLI, Compose, whether the daemon is rootless, and whether the active context is a local socket
function dockerChecks({ bin = 'docker', runner = spawnSync, env = process.env } = {}) {
    const out = [];
    const v = run(bin, ['--version'], runner);
    out.push({ name: 'Docker CLI', ok: v.ok, required: false, detail: v.ok ? v.out.split('\n')[0] : 'not installed: the issue-mode sandbox and bisection will not run (static analysis and the live probe still do)' });
    if (!v.ok) { out.push({ name: 'Docker Compose', ok: false, required: false, detail: 'needs Docker' }, { name: 'Docker (rootless)', ok: false, required: false, detail: 'needs Docker' }); return out; }
    const c = run(bin, ['compose', 'version'], runner);
    out.push({ name: 'Docker Compose', ok: c.ok, required: false, detail: c.ok ? c.out.split('\n')[0] : 'the "docker compose" plugin is missing: the sandbox needs Compose v2' });
    const info = run(bin, ['info', '--format', '{{.SecurityOptions}}'], runner);
    if (!info.ok) {
        const denied = /permission denied/i.test(info.err);
        out.push({ name: 'Docker (rootless)', ok: false, required: false, detail: denied ? 'the daemon cannot be used by this user (permission denied on the socket). Preferred fix: rootless Docker for this user. Adding the user to the "docker" group also works but gives that user root-equivalent access to the machine, so Plugin Guard never does it for you.' : `the daemon did not answer: ${info.err.split('\n')[0]}` });
        return out;
    }
    const rootless = /rootless/.test(info.out);
    let where = '';
    const host = env.DOCKER_HOST || (() => { const x = run(bin, ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], runner); return x.ok ? x.out : ''; })();
    if (host) { const s = checkLocalSocket(host); where = s.ok ? ` (socket ${host.replace(/^unix:\/\//, '')})` : ` — but the endpoint ${host} is NOT a local socket: Plugin Guard refuses it`; if (!s.ok) { out.push({ name: 'Docker (rootless)', ok: false, required: false, detail: `${rootless ? 'rootless' : 'rootful'} daemon${where}` }); return out; } }
    out.push({ name: 'Docker (rootless)', ok: rootless, required: false, detail: rootless ? `rootless daemon${where}: containers run as an unprivileged user` : `a ROOTFUL daemon${where}: whoever can use it has root-equivalent access to this machine. It works, but rootless Docker is the recommended setup.` });
    return out;
}


// guard:auto may start the USER's rootless Docker service when the daemon is down. Does that service exist for this user? (never sudo)
function dockerServiceCheck({ runner = spawnSync, systemctlBin = 'systemctl' } = {}) {
    const name = 'Rootless Docker user service (guard:auto)';
    const v = run(systemctlBin, ['--user', 'cat', 'docker.service'], runner);
    if (v.missing) return { name, ok: false, required: false, detail: 'systemctl is not available: guard:auto cannot start Docker for you (start it yourself, or it runs in static-only mode)' };
    if (!v.ok) return { name, ok: false, required: false, detail: 'there is no user service "docker.service": if the daemon is not running, guard:auto cannot start it and runs in static-only mode. Rootless Docker installs one with: dockerd-rootless-setuptool.sh install' };
    const a = run(systemctlBin, ['--user', 'is-active', 'docker.service'], runner);
    return { name, ok: true, required: false, detail: `docker.service exists for this user and is ${a.out || 'not active'}; if the daemon is down, guard:auto runs "systemctl --user start docker.service" (never sudo) and waits up to 30 s` };
}

// every dependency a package.json lists must resolve from that package's folder
function packageCheck(dir, label) {
    let pkg; try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { return { name: `Packages: ${label}`, ok: false, required: false, detail: `${dir}/package.json is missing` }; }
    const names = Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) });
    const missing = names.filter(n => { try { require.resolve(`${n}/package.json`, { paths: [dir] }); return false; } catch (e) { try { require.resolve(n, { paths: [dir] }); return false; } catch { return true; } } });
    return { name: `Packages: ${label}`, ok: !missing.length, required: false, detail: missing.length ? `${missing.length} of ${names.length} missing (${missing.slice(0, 6).join(', ')}${missing.length > 6 ? ', …' : ''}): run ${label === 'issue mode (src/plugin-guard)' ? 'npm run setup:guard' : 'npm run setup:frontend'}` : `${names.length} installed` };
}

module.exports = { dockerChecks, packageCheck, dockerServiceCheck };
