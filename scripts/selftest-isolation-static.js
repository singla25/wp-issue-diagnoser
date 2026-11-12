#!/usr/bin/env node
// Static isolation test: src/plugin-guard must not depend on src/frontend. It looks for CODE references (a path to the frontend folder, its
// identifiers, its files, the env var and the cooldown file it shares), not for the word "frontend" in prose.
//
// Transition rule: scripts/isolation-allowlist.json lists the references that still exist, file by file, with the number of matching lines.
//   - a reference in a file that is not listed, or more matches than listed, FAILS (no new dependency may appear);
//   - a listed file that no longer has that many matches FAILS as "stale" (the allowlist must shrink as the code is cleaned up);
//   - the goal is an EMPTY allowlist; the plan (docs/HANDOFF.md) removes entries step by step.
// `node scripts/selftest-isolation-static.js --write-allowlist` rewrites the allowlist from the current state (use only when a step has removed references).
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ALLOW_FILE = path.join(__dirname, 'isolation-allowlist.json');
const SKIP_DIR = new Set(['node_modules', 'issues', 'sandboxes', 'reports', 'projects', '.git']);
const SELF = new Set(['scripts/selftest-isolation-static.js', 'scripts/isolation-allowlist.json']);
const SKIP_FILE = /\.(png|jpe?g|webp|pdf|traineddata|part)$|(^|\/)package-lock\.json$|^data\/(knowledge-verification\.json)$|^KNOWLEDGE-REVIEW\.md$|^docs\/SAFETY\.md$|^docs\/plugin-guard-audit\.md$/;
// what counts as a dependency on src/frontend
const REFERENCE = [
    /src\/frontend/,                                  // a path
    /['"`]frontend['"`]/,                             // path.join(__dirname, '..', '..', 'frontend'), a 'frontend' segment
    /\.\.\/frontend/,                                 // a relative path
    /agents\/frontend/,                               // the module that spawns the frontend agent
    /\bFRONT(END)?\b/,                                // the identifiers that hold the frontend folder
    /\bfrontend(Dir|Ready)\b/,                        // job.frontendDir, frontendReady()
    /run-qa\.js|qa-report\.json|QA_REPORTS_DIR|\.protection-cooldown/   // its entry script, its report, the env var and cooldown file it owns
];

// src/plugin-guard must not depend on src/combined either (messages and documentation may name it; code may not load or open it)
const COMBINED = [/require\([^)]*combined/, /['"`]combined['"`]/, /\.\.\/combined/];

function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        if (e.isSymbolicLink()) continue;
        const f = path.join(dir, e.name), rel = path.relative(ROOT, f).split(path.sep).join('/');
        if (e.isDirectory()) { if (!SKIP_DIR.has(e.name) && !(rel === 'data/ocr')) walk(f, out); }
        else if (!SKIP_FILE.test(rel) && !SELF.has(rel)) out.push(rel);
    }
    return out;
}
function scan() {
    const found = {};
    for (const rel of walk(ROOT)) {
        let text; try { text = fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch { continue; }
        if (text.includes('\0')) continue;
        const lines = text.split('\n').map((l, i) => ({ l, n: i + 1 })).filter(x => REFERENCE.some(re => re.test(x.l)));
        if (lines.length) found[rel] = { count: lines.length, lines: lines.slice(0, 3).map(x => `${x.n}: ${x.l.trim().slice(0, 100)}`) };
    }
    return found;
}

const found = scan();
if (process.argv.includes('--write-allowlist')) {
    const out = Object.fromEntries(Object.entries(found).map(([f, v]) => [f, v.count]));
    fs.writeFileSync(ALLOW_FILE, JSON.stringify({ _about: 'References from src/plugin-guard to src/frontend that still exist (file -> number of matching lines). Must shrink to {} (see docs/HANDOFF.md). Rewritten by: node scripts/selftest-isolation-static.js --write-allowlist', allowed: out }, null, 2) + '\n');
    console.log(`Wrote ${ALLOW_FILE}: ${Object.keys(out).length} file(s), ${Object.values(out).reduce((a, b) => a + b, 0)} reference line(s).`);
    process.exit(0);
}
let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const allowed = (JSON.parse(fs.readFileSync(ALLOW_FILE, 'utf8')).allowed) || {};
const total = Object.values(found).reduce((a, v) => a + v.count, 0), allowedTotal = Object.values(allowed).reduce((a, b) => a + b, 0);

console.log(`== references from src/plugin-guard to src/frontend: ${total} line(s) in ${Object.keys(found).length} file(s); allowlist ${allowedTotal} in ${Object.keys(allowed).length}`);
const added = Object.entries(found).filter(([f, v]) => v.count > (allowed[f] || 0));
ok(added.length === 0, `no NEW dependency on src/frontend${added.length ? ': ' + added.map(([f, v]) => `${f} (${v.count} > ${allowed[f] || 0}) e.g. ${v.lines[0]}`).join(' | ') : ''}`);
const stale = Object.entries(allowed).filter(([f, n]) => (found[f] ? found[f].count : 0) < n);
ok(stale.length === 0, `the allowlist is not stale (shrink it: --write-allowlist)${stale.length ? ': ' + stale.map(([f, n]) => `${f} allows ${n}, has ${found[f] ? found[f].count : 0}`).join(' | ') : ''}`);
ok(JSON.stringify(Object.keys(allowed)) === JSON.stringify(Object.keys(allowed).sort()), 'the allowlist is sorted (stable diffs)');
// the detector itself must work: each kind of reference is recognised
const probe = ["path.join(__dirname, '..', '..', 'frontend')", "require('../../frontend/lib/governor')", "const x = 'src/frontend/reports'", "const FRONT = 1", "job.frontendDir", "require('../agents/frontend')", "spawn(node, ['run-qa.js'])", "process.env.QA_REPORTS_DIR", "'.protection-cooldown.json'"];
ok(probe.every(s => REFERENCE.some(re => re.test(s))), 'the detector recognises every kind of reference (path, relative path, identifiers, entry script, shared env var and cooldown file)');
ok(!["// the Frontend QA findings are shown in the report", "const frontendFindings = 1", "Frontend QA did not run"].some(s => REFERENCE.some(re => re.test(s))), 'and it ignores the word "frontend" in prose and unrelated identifiers');
const loads = [];
for (const rel of walk(ROOT)) { if (/\.(js|json)$/.test(rel)) fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n').forEach((l, i) => { if (COMBINED.some(re => re.test(l))) loads.push(`${rel}:${i + 1}`); }); }
ok(loads.length === 0, `no code in src/plugin-guard loads src/combined${loads.length ? ': ' + loads.slice(0, 5).join(', ') : ''}`);
ok(["require('../../combined/lib/auto')", "path.join(__dirname, '..', '..', 'combined')"].every(x => COMBINED.some(re => re.test(x))) && !COMBINED.some(re => re.test('// provided by src/combined (message only)')), 'the detector for src/combined recognises a load and ignores a message');
console.log(failures ? `\n${failures} FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
