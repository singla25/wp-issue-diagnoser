#!/usr/bin/env node
// Self-test of the `guard:auto` preflight: when Docker is started, never with sudo, the 30-second wait, static-only fallbacks, live = no sandbox.
// A fake `docker` and a fake `systemctl` (which "starts" the fake daemon) stand in for the real ones; time is injected.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const pre = require('../lib/auto-preflight');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-apf-'));
const FD = path.join(tmp, 'fake'); fs.mkdirSync(FD); fs.copyFileSync(path.join(__dirname, 'fixtures', 'issue', 'fake-docker.js'), path.join(FD, 'docker')); fs.chmodSync(path.join(FD, 'docker'), 0o755);
const SC = path.join(tmp, 'systemctl'); const SCLOG = path.join(tmp, 'systemctl.log');
fs.writeFileSync(SC, `#!/bin/sh\necho "$@" >> ${SCLOG}\ncase "$*" in\n  "--user cat docker.service") [ -f ${tmp}/unit ] && exit 0 || exit 1;;\n  "--user start docker.service") [ -f ${tmp}/starts ] && echo '{}' > ${FD}/fake.json; exit 0;;\n  *) echo "unexpected: $*" >&2; exit 9;;\nesac\n`); fs.chmodSync(SC, 0o755);
const dockerLog = () => (fs.existsSync(path.join(FD, 'fake.log')) ? fs.readFileSync(path.join(FD, 'fake.log'), 'utf8').split('\n').filter(Boolean).length : 0);
function reset({ down = true, unit = true, starts = true, missingImage = false } = {}) {
    for (const f of ['fake.log', 'fake.state.json']) fs.rmSync(path.join(FD, f), { force: true }); fs.rmSync(SCLOG, { force: true });
    for (const f of ['unit', 'starts']) fs.rmSync(path.join(tmp, f), { force: true });
    if (unit) fs.writeFileSync(path.join(tmp, 'unit'), ''); if (starts) fs.writeFileSync(path.join(tmp, 'starts'), '');
    fs.writeFileSync(path.join(FD, 'fake.json'), JSON.stringify({ ...(down ? { info: { fail: true, stderr: 'Cannot connect to the Docker daemon at unix:///run/user/1000/docker.sock. Is the docker daemon running?\n' } } : {}), ...(missingImage ? { images: { missing: ['mariadb'] } } : {}) }));
}
const sc = () => (fs.existsSync(SCLOG) ? fs.readFileSync(SCLOG, 'utf8').trim().split('\n') : []);
let clock = 0; const fakeNow = () => clock, fakeSleep = ms => { clock += ms; };
const go = (o = {}) => { clock = 0; return pre.run({ environment: 'local', root: '/x', dockerBin: path.join(FD, 'docker'), systemctlBin: SC, env: { PATH: process.env.PATH, HOME: process.env.HOME }, now: fakeNow, sleep: fakeSleep, ...o }); };

console.log('== the sandbox is wanted only for a local copy');
reset({ down: false }); let r = go({ environment: 'live' });
ok(!r.wanted && r.mode === 'static-only' && /live/.test(r.reason) && dockerLog() === 0 && sc().length === 0, 'live: no sandbox, and Docker/systemctl are not even touched');
r = go({ noSandbox: true }); ok(!r.wanted && /--no-sandbox/.test(r.reason) && dockerLog() === 0, '--no-sandbox: no sandbox, nothing touched');
r = go({ root: null }); ok(!r.wanted && /--root/.test(r.reason), 'no --root: no sandbox');

console.log('\n== the daemon is already running');
reset({ down: false }); r = go();
ok(r.wanted && r.ok && r.mode === 'sandbox' && !r.started_docker && sc().length === 0, 'running: sandbox mode, systemctl never called');
r = go({ environment: 'staging' }); ok(r.mode === 'sandbox', 'staging is allowed');

console.log('\n== the daemon is down: start the USER service, nothing else');
reset({ down: true }); r = go();
ok(r.ok && r.mode === 'sandbox' && r.started_docker, 'down + user service exists: started it, then the daemon answered -> sandbox mode');
ok(sc().join('|') === '--user cat docker.service|--user start docker.service', `systemctl was called with exactly: ${sc().join(' ; ')}`);
const code = fs.readFileSync(path.join(__dirname, '..', 'lib', 'auto-preflight.js'), 'utf8').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n').replace(/\/\/ .*$/gm, '');
ok(!/sudo|pkexec|\bsu\b|doas/.test(code), 'neither sudo nor any other privilege escalation appears in the code (comments aside)');
ok(!sc().some(l => !l.startsWith('--user')), 'every systemctl call is a --user call (never the system service)');

console.log('\n== the daemon does not come up: 30 seconds, then static-only');
reset({ down: true, starts: false }); r = go();
ok(!r.ok && r.mode === 'static-only' && !r.started_docker && clock >= 30000 && clock <= 32000 && /did not answer within 30 seconds/.test(r.reason) && r.attempts.some(a => a.what === 'wait for the daemon' && !a.ok), `waited ${Math.round(clock / 1000)} s (fake clock), then continued in static-only mode and said why`);
ok(sc().filter(l => /start/.test(l)).length === 1, 'the service was started once, not repeatedly');

console.log('\n== cases where starting would not help');
reset({ down: true, unit: false }); r = go();
ok(!r.ok && r.mode === 'static-only' && sc().join('|') === '--user cat docker.service' && /No rootless Docker service was found/.test(r.reason), 'no user service docker.service: nothing is started (only the check ran)');
reset({ down: true }); r = go({ systemctlBin: path.join(tmp, 'no-such-systemctl') });
ok(!r.ok && r.mode === 'static-only' && /systemctl is not available|No rootless Docker service/.test(JSON.stringify(r.attempts) + r.reason), 'no systemctl: static-only');
reset({ down: false, missingImage: true }); r = go();
ok(!r.ok && r.mode === 'static-only' && /guard:setup-sandbox/.test(r.reason) && sc().length === 0, 'the daemon is up but an image is missing: static-only with the setup command; the service is not touched');
reset({ down: true }); fs.writeFileSync(path.join(FD, 'fake.json'), JSON.stringify({ info: { fail: true, stderr: 'permission denied while trying to connect to the docker API at unix:///var/run/docker.sock\n' } }));
r = go(); ok(!r.ok && /permission denied/.test(r.reason) && sc().length === 0, 'permission denied on the system socket: the user service is not started (it would not help), static-only');
r = go({ dockerBin: path.join(tmp, 'no-docker') }); ok(!r.ok && /not installed/.test(r.reason) && sc().length === 0, 'Docker not installed: static-only, nothing started');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
