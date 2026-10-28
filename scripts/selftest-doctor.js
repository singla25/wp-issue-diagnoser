#!/usr/bin/env node
// Self-test of the doctor checks (rootless Docker, Compose, php, Chromium, OCR data, packages) with a fake docker and temporary package folders.
const fs = require('fs');
const os = require('os');
const path = require('path');
const dc = require('../lib/doctor-checks');
const workflow = require('../lib/workflow');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-doc-'));
function fake(name, cfg) { const d = path.join(tmp, name); fs.mkdirSync(d); fs.copyFileSync(path.join(__dirname, 'fixtures', 'issue', 'fake-docker.js'), path.join(d, 'docker')); fs.chmodSync(path.join(d, 'docker'), 0o755); fs.writeFileSync(path.join(d, 'fake.json'), JSON.stringify(cfg)); return path.join(d, 'docker'); }
const by = (list, n) => list.find(c => c.name === n);

console.log('== Docker, Compose, rootless');
let r = dc.dockerChecks({ bin: fake('rootless', {}), env: {} });
ok(by(r, 'Docker CLI').ok && by(r, 'Docker Compose').ok && by(r, 'Docker (rootless)').ok && /rootless daemon/.test(by(r, 'Docker (rootless)').detail), 'rootless daemon: CLI, Compose and "rootless" all pass');
r = dc.dockerChecks({ bin: fake('rootful', { security_options: '[name=seccomp,profile=builtin]' }), env: {} });
ok(by(r, 'Docker (rootless)').ok === false && /ROOTFUL/.test(by(r, 'Docker (rootless)').detail) && /root-equivalent/.test(by(r, 'Docker (rootless)').detail), 'a rootful daemon is reported as such, with the root-equivalent warning');
r = dc.dockerChecks({ bin: fake('denied', { info: { fail: true } }), env: {} });
ok(by(r, 'Docker (rootless)').ok === false && /permission denied/.test(by(r, 'Docker (rootless)').detail) && /never does it for you/.test(by(r, 'Docker (rootless)').detail), 'permission denied: explained, and Plugin Guard says it never changes group membership');
r = dc.dockerChecks({ bin: fake('nocompose', { no_compose: true }), env: {} });
ok(by(r, 'Docker Compose').ok === false && /Compose v2/.test(by(r, 'Docker Compose').detail), 'a missing Compose plugin is reported');
r = dc.dockerChecks({ bin: fake('remote', { context_host: 'tcp://203.0.113.9:2376' }), env: {} });
ok(by(r, 'Docker (rootless)').ok === false && /NOT a local socket/.test(by(r, 'Docker (rootless)').detail), 'a remote Docker context is reported as refused');
r = dc.dockerChecks({ bin: fake('remote2', {}), env: { DOCKER_HOST: 'ssh://me@elsewhere' } });
ok(by(r, 'Docker (rootless)').ok === false && /NOT a local socket/.test(by(r, 'Docker (rootless)').detail), 'DOCKER_HOST=ssh:// is reported as refused');
r = dc.dockerChecks({ bin: path.join(tmp, 'nope'), env: {} });
ok(by(r, 'Docker CLI').ok === false && /not installed/.test(by(r, 'Docker CLI').detail) && r.length === 3 && r.every(c => c.required === false), 'no docker command: reported, and Docker is never "required" (static analysis still works)');

console.log('\n== the user Docker service (used by guard:auto)');
const sc = (code, active = 'active') => { const f = path.join(tmp, `sc-${code}`); fs.writeFileSync(f, `#!/bin/sh\ncase "$*" in\n  "--user cat docker.service") exit ${code};;\n  "--user is-active docker.service") echo ${active}; exit 0;;\nesac\nexit 9\n`); fs.chmodSync(f, 0o755); return f; };
let sv = dc.dockerServiceCheck({ systemctlBin: sc(0, 'inactive') });
ok(sv.ok && /is inactive/.test(sv.detail) && /systemctl --user start docker\.service/.test(sv.detail) && /never sudo/.test(sv.detail), 'the user service exists: reported, with what guard:auto would do (and that it never uses sudo)');
sv = dc.dockerServiceCheck({ systemctlBin: sc(1) }); ok(!sv.ok && /no user service/.test(sv.detail) && /static-only/.test(sv.detail), 'no user service: reported, with the consequence');
sv = dc.dockerServiceCheck({ systemctlBin: path.join(tmp, 'none') }); ok(!sv.ok && /systemctl is not available/.test(sv.detail), 'no systemctl: reported');

console.log('\n== packages');
const pkgDir = path.join(tmp, 'pkgs'); fs.mkdirSync(path.join(pkgDir, 'node_modules', 'present'), { recursive: true });
fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ dependencies: { present: '1.0.0', 'absent-one': '1.0.0' }, devDependencies: { 'absent-two': '1.0.0' } }));
fs.writeFileSync(path.join(pkgDir, 'node_modules', 'present', 'package.json'), JSON.stringify({ name: 'present', version: '1.0.0', main: 'index.js' })); fs.writeFileSync(path.join(pkgDir, 'node_modules', 'present', 'index.js'), '');
let pc = dc.packageCheck(pkgDir, 'issue mode (src/plugin-guard)');
ok(pc.ok === false && /2 of 3 missing \(absent-one, absent-two\)/.test(pc.detail) && /npm run setup:guard/.test(pc.detail), 'missing packages are counted and named, with the command that installs them');
fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ dependencies: { present: '1.0.0' } }));
ok(dc.packageCheck(pkgDir, 'x').ok === true && dc.packageCheck(path.join(tmp, 'none'), 'x').ok === false, 'all present: ok; no package.json: reported');

console.log('\n== the doctor lists all of them');
const names = workflow.doctorChecks(null).map(c => c.name);
for (const want of ['PHP CLI', 'Chromium browser', 'Docker CLI', 'Docker Compose', 'Docker (rootless)', 'Docker sandbox images', 'Rootless Docker user service (guard:auto)', 'OCR language data', 'Packages: issue mode (src/plugin-guard)', 'Packages: frontend agent (src/frontend)']) ok(names.includes(want), `doctor reports: ${want}`);
fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
