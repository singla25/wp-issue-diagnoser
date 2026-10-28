#!/usr/bin/env node
// The demo (`npm run guard:demo`, offline form) must run end to end and clean up after itself; `--keep` must keep the files.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const demoDirs = () => fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('pg-demo-')).sort();
const before = demoDirs();
const run = (...a) => spawnSync(process.execPath, [path.join(__dirname, 'demo.js'), ...a], { encoding: 'utf8', timeout: 240000 });
let r = run();
ok(r.status === 0 && /Demo finished\./.test(r.stdout), `the offline demo runs end to end (exit ${r.status})`);
ok(/\[CONFIRMED\] Duplicate declaration: plugin-a \+ plugin-b/.test(r.stdout) && /function_exists/.test(r.stdout) && /fixture hash before == after: yes/.test(r.stdout), 'it shows the confirmed cause, the patch, and proves the fixture was not changed');
ok(JSON.stringify(demoDirs()) === JSON.stringify(before), 'it deletes its temporary folder afterwards');
r = run('--keep');
const kept = demoDirs().filter(n => !before.includes(n));
ok(r.status === 0 && kept.length === 1 && /Kept: /.test(r.stdout) && fs.existsSync(path.join(os.tmpdir(), kept[0], 'issues', 'index.html')), '--keep leaves the folder, with the Issues index in it');
for (const k of kept) fs.rmSync(path.join(os.tmpdir(), k), { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
