// Step 1 of `guard:auto`: the doctor checks, and the decision whether the sandbox can run. No question is ever asked.
//   - The sandbox is wanted only for --env local|staging with a local copy, and not with --no-sandbox. For live sites it is never built.
//   - If it is wanted and the Docker daemon cannot be reached, ONE attempt is made to start the USER's Docker service:
//         systemctl --user start docker.service
//     never sudo, never the system service, only when that unit exists for this user. Then it waits up to 30 seconds for the daemon.
//   - Otherwise the run continues in static-only mode, and says so and why (it ends up in the report under "what did not run").
const { spawnSync } = require('child_process');
const sandbox = require('../issue/sandbox');

const sleepSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const FIXABLE = /cannot be used|daemon|connect|no such file|is the docker daemon running|did not answer/i;

function plan({ environment, noSandbox, root }) {
    if (noSandbox) return { wanted: false, why: 'the sandbox was switched off (--no-sandbox)' };
    if (environment === 'live') return { wanted: false, why: 'the environment is live: the sandbox is never built for a live run (it would be a copy of a site that is being tested live; use --env staging or local with a copy)' };
    if (!root) return { wanted: false, why: 'no local copy of the site (--root)' };
    return { wanted: true };
}

// -> { wanted, mode: 'sandbox' | 'static-only', ok, reason, started_docker, attempts: [...] }
function run({ environment, noSandbox, root, runner = spawnSync, sleep = sleepSync, now = Date.now, dockerBin = 'docker', env = process.env, waitMs = 30000, systemctlBin = 'systemctl' } = {}) {
    const p = plan({ environment, noSandbox, root });
    const out = { wanted: p.wanted, mode: 'static-only', ok: false, reason: p.why || null, started_docker: false, attempts: [] };
    if (!p.wanted) return out;
    const so = { dockerBin, runner, env };
    let pf = sandbox.preflight(so);
    if (pf.ok) return { ...out, mode: 'sandbox', ok: true, reason: null, docker: pf.docker };
    out.reason = pf.reason;
    // only a daemon that is not running can be fixed by starting the user's service
    if (!FIXABLE.test(pf.reason) || /not installed|pinned sandbox image|permission denied/i.test(pf.reason)) { out.reason = `${pf.reason}`; return out; }
    const unit = runner(systemctlBin, ['--user', 'cat', 'docker.service'], { encoding: 'utf8', timeout: 15000, shell: false });
    if (unit.error || unit.status !== 0) { out.attempts.push({ what: 'check for the user service docker.service', ok: false, detail: unit.error ? 'systemctl is not available' : 'there is no user service docker.service (rootless Docker is not set up for this user)' }); out.reason = `${pf.reason} No rootless Docker service was found to start (systemctl --user cat docker.service failed), so nothing was started.`; return out; }
    const start = runner(systemctlBin, ['--user', 'start', 'docker.service'], { encoding: 'utf8', timeout: 30000, shell: false });
    out.attempts.push({ what: 'systemctl --user start docker.service', ok: !start.error && start.status === 0, detail: start.error ? String(start.error.message) : (start.stderr || '').trim().split('\n')[0] || null });
    const t0 = now();
    while (now() - t0 <= waitMs) {
        pf = sandbox.preflight(so);
        if (pf.ok) { out.attempts.push({ what: 'wait for the daemon', ok: true, detail: `answered after ${Math.round((now() - t0) / 1000)} s` }); return { ...out, mode: 'sandbox', ok: true, reason: null, started_docker: true, docker: pf.docker }; }
        sleep(1000);
    }
    out.attempts.push({ what: 'wait for the daemon', ok: false, detail: `no answer within ${Math.round(waitMs / 1000)} s` });
    out.reason = `${pf.reason} The user service was started with systemctl --user, but the daemon did not answer within ${Math.round(waitMs / 1000)} seconds.`;
    return out;
}
module.exports = { run, plan };
