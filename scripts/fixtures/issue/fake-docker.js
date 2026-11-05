#!/usr/bin/env node
// A fake `docker` for tests. It talks to no daemon. Beside this script it reads fake.json (behaviour), keeps fake.state.json (labelled
// containers / volumes / networks) and appends one JSON line per call to fake.log: the arguments, the NAMES of the environment variables it
// received, whether stdin carried data, and the stdin text itself (cut). Unsupported commands exit 1 so a test notices them.
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const rd = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return d; } };
const cfg = rd('fake.json', {});
const state = rd('fake.state.json', { containers: [], volumes: [], networks: [] });
const args = process.argv.slice(2);
let stdin = '';
try { if (!process.stdin.isTTY) stdin = fs.readFileSync(0, 'utf8'); } catch { /* no stdin */ }
const save = () => fs.writeFileSync(path.join(dir, 'fake.state.json'), JSON.stringify(state));
// web_running: was this project's wordpress container running when the call arrived (null for calls without a project)
const projArg = args[0] === 'compose' && args.indexOf('-p') > 0 ? args[args.indexOf('-p') + 1] : null;
const webState = projArg ? (state.containers.find(c => c.id === `c-${projArg}-wordpress`) || null) : null;
fs.appendFileSync(path.join(dir, 'fake.log'), JSON.stringify({ args, web_running: webState ? webState.running !== false : null, cwd: process.cwd(), env_names: Object.keys(process.env).sort(), env: { DOCKER_HOST: process.env.DOCKER_HOST || null, COMPOSE_FILE: process.env.COMPOSE_FILE || null, COMPOSE_PROJECT_NAME: process.env.COMPOSE_PROJECT_NAME || null, WP_CLI_CONFIG_PATH: process.env.WP_CLI_CONFIG_PATH || null, PATH: process.env.PATH }, stdin_bytes: stdin.length, stdin: stdin.slice(0, 6000) }) + '\n');
const out = s => { process.stdout.write(s); process.exit(0); };
const fail = (s, code = 1) => { process.stderr.write(s); process.exit(code); };

const filters = () => { const f = []; for (let i = 0; i < args.length; i++) if (args[i] === '--filter') f.push(args[++i]); return f; };
const match = (labels, fl) => fl.every(x => { const m = /^label=([^=]+)=(.*)$/.exec(x); return m && labels[m[1]] === m[2]; });
const flagIndex = f => args.indexOf(f);

if (args[0] === '--version') out('Docker version 29.9.2, build fake\n');
if (args[0] === 'compose' && args[1] === 'version') { if (cfg.no_compose) fail('docker: \'compose\' is not a docker command.\n'); out('Docker Compose version v5.0.0\n'); }
if (args[0] === 'info' && args.includes('{{.SecurityOptions}}')) { if (cfg.info && cfg.info.fail) fail(cfg.info.stderr || 'permission denied while trying to connect to the docker API\n'); out((cfg.security_options || '[name=seccomp,profile=builtin name=rootless name=cgroupns]') + '\n'); }
if (args[0] === 'context' && args[1] === 'inspect') out((cfg.context_host || 'unix:///var/run/docker.sock') + '\n');
if (args[0] === 'info') { if (cfg.info && cfg.info.fail) fail(cfg.info.stderr || 'permission denied while trying to connect to the docker API at unix:///var/run/docker.sock\n'); out('29.9.2\n'); }
if (args[0] === 'image' && args[1] === 'inspect') { const ref = args[args.length - 1]; if (cfg.images && cfg.images.missing && cfg.images.missing.some(k => ref.startsWith(k))) fail('Error: No such image\n'); out(JSON.stringify([ref]) + '\n'); }
if (args[0] === 'compose') {
    const p = args[args.indexOf('-p') + 1], f = args[args.indexOf('-f') + 1];
    const sub = args.find((a, i) => i > 4 && ['config', 'up', 'down', 'port', 'exec', 'stop', 'start', 'ps'].includes(a));
    const svcArgs = () => { const at = args.indexOf(sub), out = []; for (let i = at + 1; i < args.length; i++) { if (args[i] === '--timeout' || args[i] === '--status') { i++; continue; } if (!args[i].startsWith('-')) out.push(args[i]); } return out; };
    const setRunning = (svcs, v) => { for (const c of state.containers) if (c.labels['pg.project'] === p && svcs.some(s => c.id === `c-${p}-${s}`)) c.running = v; };
    if (sub === 'config') { if (cfg.config_fail) fail('services.wordpress.image must be a string\n'); out(''); }
    if (sub === 'up') {
        if (cfg.up_fail) fail('Error response from daemon: boom\n');
        let spec = {}; try { spec = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* none */ }
        const issue = Object.values(spec.services || {}).map(s => (s.labels || {})['pg.issue'])[0];
        const L = { 'pg.sandbox': '1', 'pg.owner': 'plugin-guard', 'pg.project': p, 'pg.issue': issue };
        for (const svc of Object.keys(spec.services || {})) state.containers.push({ id: `c-${p}-${svc}`, labels: L, running: true });
        for (const v of Object.keys(spec.volumes || {})) state.volumes.push({ name: `${p}_${v}`, labels: L });
        for (const n of Object.keys(spec.networks || {})) state.networks.push({ id: `n-${p}-${n}`, labels: L });
        save(); out('');
    }
    // ports: one published address per start of the web container (index = number of `start` calls so far); port: the same for every start
    if (sub === 'port') { const n = (state.starts || {})[p] || 0; out(`${cfg.ports ? cfg.ports[Math.min(n, cfg.ports.length - 1)] : (cfg.port || '127.0.0.1:38080')}\n`); }
    if (sub === 'stop') { if (cfg.stop_fail) fail('Error: cannot stop\n'); setRunning(svcArgs(), false); save(); out(''); }
    if (sub === 'start') { if (cfg.start_fail) fail('Error: cannot start\n'); setRunning(svcArgs(), true); state.starts = { ...(state.starts || {}), [p]: ((state.starts || {})[p] || 0) + 1 }; save(); out(''); }
    // ps -q --status running <svc>: the ids of this project's running containers (ps_lies: always claims the web container runs)
    if (sub === 'ps') { if (cfg.ps_fail) fail('Error: cannot list\n'); const want = svcArgs(); const l = state.containers.filter(c => c.labels['pg.project'] === p && c.running !== false && (!want.length || want.some(w => c.id === `c-${p}-${w}`))); out(cfg.ps_lies ? `c-${p}-wordpress\n` : l.map(c => c.id).join('\n') + (l.length ? '\n' : '')); }
    if (sub === 'down') { for (const k of ['containers', 'volumes', 'networks']) state[k] = state[k].filter(x => x.labels['pg.project'] !== p); save(); out(''); }
    if (sub === 'exec') {
        const svc = args[args.indexOf('exec') + 1 + args.slice(args.indexOf('exec') + 1).findIndex(a => !a.startsWith('-') && a !== '0')];
        const sc = state.containers.find(c => c.id === `c-${p}-${svc}`);
        if (sc && sc.running === false) fail(`service "${svc}" is not running\n`);
        const wpAt = args.indexOf('wp'), wp = args.slice(wpAt + 1).filter(a => !a.startsWith('--path=')).join(' ');
        // a rule may also: write a marker file (marker: name beside this script) and wait (sleep_ms), to let a test interrupt a running import
        for (const r of cfg.wp || []) if (wp.startsWith(r.match) && (!r.stdin || stdin.includes(r.stdin))) { if (r.marker) fs.writeFileSync(path.join(dir, r.marker), '1'); if (r.sleep_ms) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, r.sleep_ms); if (r.status) fail(r.stderr || 'Error\n', r.status); out(r.out || ''); }
        // a count query (SELECT COUNT(*) AS <name> ...) with no matching rule answers 0, like a database where nothing is left to find
        const cnt = /SELECT COUNT\(\*\) AS ([a-z_]+)/.exec(stdin); if (cnt) out(`${cnt[1]}\n0\n`);
        out('');
    }
    fail(`fake docker: unsupported compose command: ${args.join(' ')}\n`);
}
const fmtRows = (list, cols) => list.map(x => cols.map(c => x[c] ?? x.labels[c.replace('label:', '')] ?? '').join('\t')).join('\n') + (list.length ? '\n' : '');
if (args[0] === 'ps') { const l = state.containers.filter(c => match(c.labels, filters())); out(l.map(c => `${c.id}\t${c.labels['pg.project']}\t${c.labels['pg.issue']}`).join('\n') + (l.length ? '\n' : '')); }
if (args[0] === 'volume' && args[1] === 'ls') { const l = state.volumes.filter(c => match(c.labels, filters())); out(l.map(c => `${c.name}\t${c.labels['pg.project']}\t${c.labels['pg.issue']}`).join('\n') + (l.length ? '\n' : '')); }
if (args[0] === 'network' && args[1] === 'ls') { const l = state.networks.filter(c => match(c.labels, filters())); out(l.map(c => `${c.id}\t${c.labels['pg.project']}\t${c.labels['pg.issue']}`).join('\n') + (l.length ? '\n' : '')); }
if (args[0] === 'rm') { const ids = args.filter(a => !a.startsWith('-')).slice(1); state.containers = state.containers.filter(c => !ids.includes(c.id)); save(); out(ids.join('\n') + '\n'); }
if (args[0] === 'volume' && args[1] === 'rm') { const ids = args.slice(2).filter(a => !a.startsWith('-')); state.volumes = state.volumes.filter(c => !ids.includes(c.name)); save(); out(ids.join('\n') + '\n'); }
if (args[0] === 'network' && args[1] === 'rm') { const ids = args.slice(2); state.networks = state.networks.filter(c => !ids.includes(c.id)); save(); out(ids.join('\n') + '\n'); }
fail(`fake docker: unsupported command: ${args.join(' ')}\n`);
