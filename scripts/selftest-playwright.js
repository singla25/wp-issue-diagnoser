#!/usr/bin/env node
// plugin-guard's own Playwright resolver (lib/playwright.js): it finds Playwright in plugin-guard's own node_modules, gives a precise message and
// exit code when it is missing, and the PDF report and the doctor use it.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const pw = require('../lib/playwright');
const PG = path.join(__dirname, '..');

console.log('== resolved from plugin-guard itself');
const p = pw.resolvePath();
ok(p && p.startsWith(path.join(PG, 'node_modules') + path.sep), `@playwright/test resolves inside src/plugin-guard/node_modules (${p && path.relative(PG, p)})`);
const pkg = JSON.parse(fs.readFileSync(path.join(PG, 'package.json'), 'utf8'));
ok(pkg.dependencies['@playwright/test'] === '1.64.1' && /^\d+\.\d+\.\d+$/.test(pkg.dependencies['@playwright/test']), `package.json pins an exact version (${pkg.dependencies['@playwright/test']})`);
const st = pw.status();
ok(st.version === pkg.dependencies['@playwright/test'], `the installed version is the pinned one (${st.version})`);
ok(typeof pw.load().chromium.launch === 'function', 'load() returns the Playwright module');

console.log('\n== the browser');
if (!st.chromium) console.log('      (Chromium is not installed here: the launch checks below are skipped)');
else {
    ok(st.ok && st.executable && fs.existsSync(st.executable), 'status(): Chromium is installed');
    (async () => {
        const b = await pw.load().chromium.launch(); const pg = await b.newPage(); await pg.setContent('<title>x</title><p>hi</p>'); const t = await pg.title(); await b.close();
        ok(t === 'x', 'the module launches Chromium and drives a page');
        finish();
    })().catch(e => { ok(false, `launch failed: ${e.message}`); finish(); });
}

console.log('\n== when Playwright is missing');
// a copy of the resolver in a folder that has no node_modules anywhere above it
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-pw-'));
fs.mkdirSync(path.join(tmp, 'lib')); fs.copyFileSync(path.join(PG, 'lib', 'playwright.js'), path.join(tmp, 'lib', 'playwright.js'));
const probe = spawnSync(process.execPath, ['-e', `const p=require(${JSON.stringify(path.join(tmp, 'lib', 'playwright.js'))});let e=null;try{p.load()}catch(x){e=x}const s=p.status();console.log(JSON.stringify({name:e&&e.name,code:e&&e.exitCode,msg:e&&e.message,ok:s.ok,reason:s.reason}))`], { encoding: 'utf8' });
const r = JSON.parse(probe.stdout.trim());
ok(r.name === 'PlaywrightMissing' && r.code === 3 && /npm run setup:guard/.test(r.msg), 'load() throws PlaywrightMissing (exit code 3) naming the command that fixes it');
ok(r.ok === false && /not installed in src\/plugin-guard/.test(r.reason) && !/frontend/i.test(r.msg + r.reason), 'status() reports it without throwing, and never mentions another module');
fs.rmSync(tmp, { recursive: true, force: true });

console.log('\n== the users of the resolver');
const src = f => fs.readFileSync(path.join(PG, f), 'utf8');
ok(/require\('\.\/playwright'\)\.load\(\)/.test(src('lib/report-pdf.js')), 'the PDF report (lib/report-pdf.js) uses it');
ok(/require\('\.\/playwright'\)\.status\(\)/.test(src('lib/workflow.js')), 'the doctor uses it (the PDF of the auto run: see src/combined/scripts/selftest-doctor.js)');
const doc = spawnSync(process.execPath, [path.join(__dirname, 'guard.js'), 'doctor'], { encoding: 'utf8' }).stdout;
ok(/Chromium browser: (installed \(Playwright 1\.64\.1, plugin-guard's own\)|Playwright .* not)/.test(doc), 'the doctor reports plugin-guard\'s own Chromium');

function finish() { console.log(failures ? `\n${failures} FAILED` : '\nAll checks passed'); process.exit(failures ? 1 : 0); }
if (!st.chromium) finish();
