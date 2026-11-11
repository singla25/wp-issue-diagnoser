#!/usr/bin/env node
// Hygiene scan of Plugin Guard's own files (src/plugin-guard; step 9: it no longer walks the rest of the repository, so it runs the same
// in a copy of this package on its own; the rest is scanned with the SAME rules, scripts/hygiene-rules.js, by the root scripts/selftest-repo.js): no secrets, no real user names / host names / absolute home paths, no real e-mail addresses or
// client/site names, and the .gitignore keeps issue data, sandboxes and the OCR language file out. Runs offline over the files themselves.
// Not scanned: node_modules, generated output (reports, issues, sandboxes), lock files, binary data, the verification record of public pages, and
// `projects/` (a person's own project settings and decisions: reported as a WARNING, they are client records and stay local, git-ignored).
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');                       // the walked folder: src/plugin-guard (or the isolated copy of it)
const REPO = require('../lib/repo-layout').repoRoot();          // the repository around it, or null in a copy on its own (.gitignore lives there)
const rules = require('./hygiene-rules');   // the patterns and bans, shared with the root scripts/selftest-repo.js (the rest of the repository)
let failures = 0, warnings = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const warn = m => { console.log(`WARN  ${m}`); warnings++; };

const files = rules.collect(ROOT, ['projects']);
console.log(`== scanning ${files.length} files`);
rules.contentChecks(ROOT, files, ok, rules.projectNames(path.join(ROOT, 'projects')));

// .gitignore (the repository's; a copy of this package on its own has none, so these checks are skipped there, loudly)
if (!REPO) console.log('SKIP  .gitignore checks: this is a copy of src/plugin-guard on its own, the repository .gitignore is not part of it');
else for (const [pat, why] of [['src/plugin-guard/issues/', 'issue folders (reports, screenshots, OCR text)'], ['src/plugin-guard/sandboxes/', 'sandbox copies of sites'], ['src/plugin-guard/plugin-guard-reports/', 'classic reports of a copy of this package on its own'], ['src/plugin-guard/data/ocr/*.traineddata', 'the OCR language file'], ['.env', 'environment files'], ['.env.*', 'environment files'], ['node_modules/', 'dependencies'], ['reports/*', 'run output'], ['src/plugin-guard/projects/*/history/', 'scan history']]) ok(fs.readFileSync(path.join(REPO, '.gitignore'), 'utf8').split('\n').map(l => l.trim()).includes(pat), `.gitignore covers ${pat} (${why})`);
// the OCR file really is not present as a tracked-looking file outside data/ocr, and no dump / archive is lying around
rules.strayCheck(ROOT, files, ok);

// projects/ : user data, WARN only
const pdir = path.join(ROOT, 'projects');
if (fs.existsSync(pdir)) for (const p of fs.readdirSync(pdir).sort()) {
    const pj = path.join(pdir, p, 'project.json'); let j = null; try { j = JSON.parse(fs.readFileSync(pj, 'utf8')); } catch { /* none */ }
    if (j && (j.path || j.url) && p !== 'acme') warn(`projects/${p}/project.json holds a local path or a site address. Per-project settings and decisions.txt are client records and stay local (projects/* is git-ignored).`);
}
console.log(`\n${warnings} warning(s)`);
console.log(failures ? `\n${failures} FAILED` : 'All checks passed');
process.exit(failures ? 1 : 0);
