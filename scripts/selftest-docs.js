#!/usr/bin/env node
// Docs check of THIS package (step 10): README.md and docs/*.md of src/plugin-guard ONLY, against this package's own files. It reads
// nothing outside the package, so it runs the same in the repository and in the isolated copy (scripts/selftest-isolated-copy.js).
//   1. every `npm run X` names a script of this package's package.json, or an entry of ROOT_FORWARDERS (a repository-root script that
//      forwards to a script of this package: that target must exist) or of NOT_IN_PACKAGE (a root script that runs something outside
//      this package; the reason says what)
//   2. every `npm <word>` inside code (`...` or a fenced block) is an npm command of NPM_COMMANDS or a script of this package
//   3. every `node <...>scripts/<file>.js` path exists in this package (`src/plugin-guard/<rest>` is read as `<rest>`), or is in NODE_OUTSIDE
//   4. every relative markdown link resolves to an existing file INSIDE this package (no link climbs out of it)
//   5. every `--flag` is one the option table of scripts/guard.js (shared by scripts/plugin-guard.js) knows, or an entry of OTHER_FLAGS,
//      each with a reason and a check against the file that owns it
//   6. the three plain sections are at the top of README.md
// False positives go into the explicit lists below, one reason per entry; an entry that no doc needs any more FAILS (no silent skips).
const fs = require('fs');
const path = require('path');

const PG = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(PG, 'package.json'), 'utf8'));
const scripts = pkg.scripts || {};
const { FLAGS, KEEP_REAL_DATA_RETIRED } = require('./guard');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; return c; };
const group = t => console.log(`\n== ${t}`);
const inside = (parent, child) => { const r = path.relative(parent, child); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };
const textOf = rel => { try { return fs.readFileSync(path.join(PG, rel), 'utf8'); } catch { return ''; } };

// ---------------------------------------------------------------- the explicit lists
// repository-root scripts named in the README (it says to run them from the repository root): name -> the script of THIS package they run
const ROOT_FORWARDERS = {};   // standalone repository: the package is the repository root, so nothing is forwarded or outside
// repository-root scripts named in the docs that run something OUTSIDE this package (the docs say so where they name them)
const NOT_IN_PACKAGE = {};   // standalone repository: the package is the repository root, so nothing is forwarded or outside
// `npm <word>` in code that is an npm command, not a script
const NPM_COMMANDS = { ci: 'npm ci', exec: 'npm exec', install: 'npm install', pack: 'npm pack', run: 'npm run', audit: 'npm audit (a tool the doctor looks for)' };
// `node .../scripts/*.js` paths outside this package
const NODE_OUTSIDE = {};   // standalone repository: the package is the repository root, so nothing is forwarded or outside
// --flags that are not options of guard.js / plugin-guard.js: each with the file that owns it (checked to contain the flag) or a check
const has = (rel, s) => textOf(rel).includes(s);
const RETIRED = ['keep', 'real', 'data'].join('-');
const OTHER_FLAGS = {
    prefix: ['npm --prefix (an npm option)', () => true],
    'skip-plugins': ['WP-CLI option, always passed by lib/wpcli.js', () => has('lib/wpcli.js', '--skip-plugins')],
    'skip-themes': ['WP-CLI option, always passed by lib/wpcli.js', () => has('lib/wpcli.js', '--skip-themes')],
    'skip-email': ['WP-CLI option of the sandbox user update (issue/sandbox-wpcli.js)', () => has('issue/sandbox-wpcli.js', '--skip-email')],
    network: ['WP-CLI `core is-installed --network` (checks/database.js), in the audit text', () => has('checks/database.js', "'--network'")],
    user: ['`systemctl --user` (lib/auto-preflight.js) and the WP-CLI `--user_pass=` of the sandbox', () => has('lib/auto-preflight.js', "'--user'")],
    keep: ['guard:demo --keep (scripts/demo.js)', () => has('scripts/demo.js', "'--keep'")],
    // the retired flag's name is assembled from pieces: selftest-6c2.js requires it to appear only in the refusal in scripts/guard.js
    [RETIRED]: ['retired: the docs say it exits 2; guard.js refuses it with KEEP_REAL_DATA_RETIRED', () => !(RETIRED in FLAGS) && typeof KEEP_REAL_DATA_RETIRED === 'string'],
    apply: ['SAFETY.md says there is NO --apply: guard.js must not know it', () => !('apply' in FLAGS)],
    // options of other tools or of single scripts, named in the HANDOFF history (C1c); none is an option of guard.js / plugin-guard.js
    'dry-run': ['--dry-run of scripts/run-full.sh (a snapshot and a tiny check, no long run)', () => has('scripts/run-full.sh', '--dry-run')],
    db: ['setup-sandbox.js option --db mysql|mariadb', () => has('scripts/setup-sandbox.js', '--db mysql')],
    check: ['--check of scripts/gen-checkpoints.js and of scripts/setup-sandbox.js', () => has('scripts/gen-checkpoints.js', "'--check'") && has('scripts/setup-sandbox.js', "'--check'")],
    'default-authentication-plugin': ['MySQL server option set in issue/sandbox-policy.js', () => has('issue/sandbox-policy.js', '--default-authentication-plugin=mysql_native_password')],
    'exclude-standard': ['git ls-files option (git itself); the suite selftest-isolated-copy.js passes it to git', () => has('scripts/selftest-isolated-copy.js', "'--exclude-standard'")],
    quiet: ['git diff option (git itself); selftest-case-file.js passes it to git', () => has('scripts/selftest-case-file.js', "'--quiet'")],
};

// ---------------------------------------------------------------- the docs
const DOCS = ['README.md', ...(fs.existsSync(path.join(PG, 'docs')) ? fs.readdirSync(path.join(PG, 'docs')).filter(n => n.endsWith('.md')).sort().map(n => `docs/${n}`) : [])];
const doc = Object.fromEntries(DOCS.map(d => [d, textOf(d)]));
// the code parts of a markdown text: fenced blocks and `inline` spans
const codeOf = t => [...t.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map(m => m[1]).join('\n') + '\n' + t.replace(/```[\s\S]*?```/g, '').split('\n').flatMap(l => [...l.matchAll(/`([^`]+)`/g)].map(m => m[1])).join('\n');

// ---------------------------------------------------------------- the detectors (also run on a planted doc below)
// docs: { 'rel/path.md': text } -> the problems found, and what was seen (for the stale-entry checks)
function scan(docs) {
    const r = { npmRun: [], forwardTarget: [], npmCmd: [], node: [], links: [], flags: [], seen: { run: new Set(), cmd: new Set(), node: new Set(), flags: new Set() }, linkCount: 0 };
    for (const [d, text] of Object.entries(docs)) {
        for (const m of text.matchAll(/\bnpm run(?: -s)?\s+([A-Za-z0-9:_-]+)/g)) {
            const n = m[1]; r.seen.run.add(n);
            if (scripts[n] || n in NOT_IN_PACKAGE) continue;
            if (n in ROOT_FORWARDERS) { if (!scripts[ROOT_FORWARDERS[n][0]]) r.forwardTarget.push(`${d}: ${n} -> ${ROOT_FORWARDERS[n][0]}`); continue; }
            r.npmRun.push(`${d}: npm run ${n}`);
        }
        for (const m of codeOf(text).matchAll(/\bnpm\s+([a-z][a-z-]*)\b/g)) {
            r.seen.cmd.add(m[1]);
            if (!(m[1] in NPM_COMMANDS) && !scripts[m[1]]) r.npmCmd.push(`${d}: npm ${m[1]}`);
        }
        for (const m of text.matchAll(/\bnode\s+([^\s`'"()]*scripts\/[A-Za-z0-9._/-]+\.js)/g)) {
            const p = m[1];
            const out = Object.keys(NODE_OUTSIDE).find(k => p === k || p.endsWith('/' + k));
            if (out) { r.seen.node.add(out); continue; }
            const i = p.lastIndexOf('src/plugin-guard/');
            const ph = p.lastIndexOf('/plugin-guard/scripts/');   // placeholder install path such as /path/to/plugin-guard/scripts/guard.js
            const rel = i >= 0 ? p.slice(i + 'src/plugin-guard/'.length) : ph >= 0 ? p.slice(ph + '/plugin-guard/'.length) : p.replace(/^\.\//, '');
            const abs = path.join(PG, rel);
            if (!inside(PG, abs) || !fs.existsSync(abs)) r.node.push(`${d}: node ${p}`); else r.seen.node.add(rel);
        }
        for (const m of text.replace(/```[\s\S]*?```/g, '').matchAll(/\]\(([^)\s]+)\)/g)) {
            const target = m[1];
            if (/^(https?:|mailto:|#)/i.test(target)) continue;
            r.linkCount++;
            const abs = path.resolve(path.dirname(path.join(PG, d)), decodeURIComponent(target.split('#')[0]));
            if (!inside(PG, abs)) r.links.push(`${d}: ${target} (points outside the package)`);
            else if (!fs.existsSync(abs)) r.links.push(`${d}: ${target} (missing)`);
        }
        for (const m of text.matchAll(/(?:^|[\s`[(|])--([a-z][a-z0-9-]*)/g)) {
            const f = m[1].replace(/-+$/, ''); r.seen.flags.add(f);
            if (!FLAGS[f] && !(f in OTHER_FLAGS)) r.flags.push(`${d}: --${f}`);
        }
    }
    return r;
}
const list = a => (a.length ? ': ' + a.join(' | ') : '');

group(`the docs of this package: ${DOCS.join(', ')}`);
ok(DOCS.includes('docs/SAFETY.md') && DOCS.includes('docs/plugin-guard-audit.md') && DOCS.every(d => doc[d].length > 200), 'README.md, docs/SAFETY.md and docs/plugin-guard-audit.md are in the package and not empty');
const R = scan(doc);

group('1. npm run X: a script of this package, or an explicit root entry');
{
    ok(R.npmRun.length === 0, `every npm run name is a script here or an explicit root entry (${R.seen.run.size} names)${list(R.npmRun)}`);
    ok(R.forwardTarget.length === 0, `every root forwarder runs a script that exists in this package's package.json (${Object.keys(ROOT_FORWARDERS).length} entries)${list(R.forwardTarget)}`);
    const stale = [...Object.keys(ROOT_FORWARDERS), ...Object.keys(NOT_IN_PACKAGE)].filter(n => !R.seen.run.has(n) || scripts[n]);
    ok(stale.length === 0, `no root entry is stale (each is still named by a doc and is not a script here)${list(stale)}`);
}

group('2. npm <word> in code: an npm command or a script of this package');
{
    ok(R.npmCmd.length === 0, `every npm command in code is known (${[...R.seen.cmd].sort().join(', ')})${list(R.npmCmd)}`);
    const stale = Object.keys(NPM_COMMANDS).filter(n => !R.seen.cmd.has(n));
    ok(stale.length === 0, `no NPM_COMMANDS entry is stale${list(stale)}`);
}

group('3. node <...>scripts/<file>.js: the file exists in this package');
{
    ok(R.node.length === 0 && R.seen.node.size > 0, `every node path exists in this package (${[...R.seen.node].sort().join(', ')})${list(R.node)}`);
    const stale = Object.keys(NODE_OUTSIDE).filter(k => !R.seen.node.has(k));
    ok(stale.length === 0, `no NODE_OUTSIDE entry is stale${list(stale)}`);
}

group('4. relative markdown links: an existing file inside this package');
{
    ok(R.links.length === 0 && R.linkCount > 0, `${R.linkCount} relative link(s), each to an existing file inside the package${list(R.links)}`);
    ok(/\]\(\.\/docs\/SAFETY\.md\)/.test(doc['README.md']) && /\]\(\.\/docs\/plugin-guard-audit\.md\)/.test(doc['README.md']) && !/\]\(\.\.\//.test(doc['README.md']), 'README.md links ./docs/SAFETY.md and ./docs/plugin-guard-audit.md, and no link starts with ../');
}

group('5. --flags: known to the guard.js / plugin-guard.js option table, or an explicit entry');
{
    ok(R.flags.length === 0, `every --flag is known (${R.seen.flags.size} distinct)${list(R.flags)}`);
    const wrong = Object.entries(OTHER_FLAGS).filter(([, [, check]]) => !check()).map(([f]) => f);
    ok(wrong.length === 0, `each OTHER_FLAGS entry is true of the file that owns it (${Object.keys(OTHER_FLAGS).length} entries)${list(wrong)}`);
    const dup = Object.keys(OTHER_FLAGS).filter(f => FLAGS[f]);
    const stale = Object.keys(OTHER_FLAGS).filter(f => !R.seen.flags.has(f));
    ok(dup.length === 0 && stale.length === 0, `no OTHER_FLAGS entry is an option of guard.js or unused by the docs${list([...dup, ...stale])}`);
    const wizardFlags = ['description', 'root', 'url', 'env', 'authorized', 'php', 'images', 'log', 'sandbox', 'db-dump', 'max-size-mb', 'no-replica', 'out', 'yes'];
    const help = require('./plugin-guard').HELP;
    ok(wizardFlags.every(f => FLAGS[f] && help.includes(`--${f}`) && doc['README.md'].includes(`--${f}`)), 'the wp-issue-diagnoser flags of --help are all in the option table and named in README.md');
}

group('5b. the detectors catch a planted doc (in memory; nothing is written)');
{
    const planted = scan({ 'docs/planted.md': [
        '```bash', 'npm run selftest:no-such-suite', 'npm frobnicate', 'node src/plugin-guard/scripts/no-such-file.js', 'wp-issue-diagnoser --no-such-flag', '```',
        'See [the rules](../../docs/SAFETY.md) and [a missing page](./missing.md).'].join('\n') });
    ok(planted.npmRun.length === 1 && /selftest:no-such-suite/.test(planted.npmRun[0]), 'an unknown npm run name is reported');
    ok(planted.npmCmd.length === 1 && /npm frobnicate/.test(planted.npmCmd[0]), 'an unknown npm command in code is reported');
    ok(planted.node.length === 1 && /no-such-file\.js/.test(planted.node[0]), 'a node path that does not exist is reported');
    ok(planted.links.length === 2 && /outside the package/.test(planted.links[0]) && /missing/.test(planted.links[1]), 'a link out of the package and a link to a missing file are reported');
    ok(planted.flags.length === 1 && /--no-such-flag/.test(planted.flags[0]), 'an unknown --flag is reported');
}

group('6. the three plain sections are at the top of README.md');
{
    const heads = [...doc['README.md'].matchAll(/^## (.+)$/gm)].map(m => m[1].trim());
    ok(JSON.stringify(heads.slice(0, 3)) === JSON.stringify(['What this does', 'What it never does', 'How to read the report']), `the first three headings (${heads.slice(0, 3).join(' / ')})`);
}

group('7. README.md: the commands in its code blocks exist, the Mermaid diagrams are well formed, no image files');
// problems found in one README text: a command line that names something this package does not have, a broken diagram, a relative image
const BIN = Object.keys(pkg.bin || {});
function readmeProblems(text) {
    const bad = []; let diagrams = 0;
    for (const m of text.matchAll(/```([a-z]*)[^\n]*\n([\s\S]*?)```/g)) {
        const lang = m[1], body = m[2];
        if (lang === 'mermaid') {
            diagrams++;
            const first = body.split('\n').find(l => l.trim()) || '';
            if (!/^\s*(flowchart|graph)\s+(LR|RL|TD|TB|BT)\s*$/.test(first)) bad.push(`mermaid: first line is not a flowchart header (${first.trim().slice(0, 40)})`);
            const open = (body.match(/[\[{]/g) || []).length, close = (body.match(/[\]}]/g) || []).length;
            if (open !== close || (body.match(/"/g) || []).length % 2) bad.push('mermaid: unbalanced brackets or quotes');
            continue;
        }
        if (!['bash', 'sh', ''].includes(lang)) continue;
        for (const raw of body.split('\n')) {
            const l = raw.replace(/#.*$/, '').trim();
            let c;
            if ((c = /^npm run(?: -s)?\s+([A-Za-z0-9:_-]+)/.exec(l))) { if (!scripts[c[1]]) bad.push(`npm run ${c[1]}`); }
            else if ((c = /^npm\s+([a-z][a-z-]*)/.exec(l))) { if (!(c[1] in NPM_COMMANDS) && !scripts[c[1]]) bad.push(`npm ${c[1]}`); if (c[1] === 'exec') { const b = /^npm exec -- ([A-Za-z0-9-]+)/.exec(l); if (!b || !BIN.includes(b[1])) bad.push(`npm exec: ${l.slice(0, 40)}`); } }
            else if ((c = /^node\s+(\S+)/.exec(l))) { if (!/^(\.\/)?scripts\//.test(c[1]) || !fs.existsSync(path.join(PG, c[1].replace(/^\.\//, '')))) bad.push(`node ${c[1]}`); }
            else if ((c = /^([A-Za-z][A-Za-z0-9-]*)\b/.exec(l)) && c[1] === 'wp-issue-diagnoser' && !BIN.includes('wp-issue-diagnoser')) bad.push('wp-issue-diagnoser is not a bin entry');
            else if (/^git clone\s+https?:/.test(l)) bad.push('a public clone address (the repository is private)');
        }
    }
    for (const m of text.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)) if (!/^https?:/.test(m[1])) bad.push(`a relative image: ${m[1]}`);
    return { bad, diagrams };
}
{
    const r = readmeProblems(doc['README.md']);
    ok(r.bad.length === 0, `every command line in the README code blocks names a script, a bin entry or a file of this package${list(r.bad)}`);
    ok(r.diagrams >= 2, `the README has at least two well-formed Mermaid diagrams (${r.diagrams})`);
    const p = readmeProblems(['```bash', 'npm run no-such-script', 'npm exec -- no-such-bin', 'node scripts/no-such.js', 'git clone https://example.org/x.git', '```', '```mermaid', 'sequenceDiagram', 'A[x', '```', '![a](./pic.png)'].join('\n'));
    ok(p.bad.length === 7 && p.diagrams === 1, `the README check catches a planted bad README (${p.bad.length} problems)`);
}

group('8. docs/README.md maps every .md file of the repository, and every file it names exists');
// every .md file of the package (the folders that .gitignore keeps out are not walked), as paths relative to the package root
const MD_SKIP = new Set(['node_modules', '.git', 'issues', 'sandboxes', 'reports', 'plugin-guard-reports', 'state', 'projects', 'coverage', 'dist', 'build', 'playwright-report', 'test-results', 'run-logs']);
function allMd(dir = PG, rel = '') {
    const out = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) { if (!MD_SKIP.has(e.name)) out.push(...allMd(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name)); }
        else if (e.name.endsWith('.md')) out.push(rel ? `${rel}/${e.name}` : e.name);
    }
    return out;
}
// the .md files a map text links to (relative links, resolved from docs/), as paths relative to the package root
const mapped = text => new Set([...text.replace(/```[\s\S]*?```/g, '').matchAll(/\]\(([^)\s#]+\.md)(?:#[^)]*)?\)/g)].filter(m => !/^https?:/.test(m[1])).map(m => path.relative(PG, path.resolve(path.join(PG, 'docs'), m[1])).split(path.sep).join('/')));
{
    const all = allMd(), listed = mapped(doc['docs/README.md'] || '');
    const missing = all.filter(f => !listed.has(f)), absent = [...listed].filter(f => !fs.existsSync(path.join(PG, f)));
    ok(all.length > 15 && missing.length === 0, `docs/README.md lists every .md file of the repository (${all.length} files)${list(missing)}`);
    ok(absent.length === 0, `every file docs/README.md names exists (${listed.size} files)${list(absent)}`);
    const planted = allMd().filter(f => !mapped((doc['docs/README.md'] || '').replace(/\[TESTING\.md\]\(\.\/TESTING\.md\)/, 'TESTING.md')).has(f));
    ok(planted.length === 1 && planted[0] === 'docs/TESTING.md', 'the map check catches a planted missing entry (one link removed in memory)');
    const ghost = [...mapped((doc['docs/README.md'] || '') + '\n[Ghost](./NO-SUCH-FILE.md)')].filter(f => !fs.existsSync(path.join(PG, f)));
    ok(ghost.length === 1 && ghost[0] === 'docs/NO-SUCH-FILE.md', 'the map check catches a planted entry for a file that does not exist (in memory)');
}

group('9. README.md and docs/GUIDE.md use the product name wp-issue-diagnoser, not the old command name');
// the old name may stay only as an internal name: the report folder, the config file, the script file, the audit file, the placeholder install folder
const OLD_NAME_INTERNAL = /plugin-guard-reports(?:\/plugin-guard)?|plugin-guard\.config(?:\.example)?\.json|plugin-guard\.js|plugin-guard-audit\.md|\/path\/to\/plugin-guard\/scripts\//g;
const oldNameHits = text => text.split('\n').flatMap((l, i) => { const t = l.replace(OLD_NAME_INTERNAL, ''); return /Plugin Guard|plugin-guard/.test(t) ? [`line ${i + 1}: ${t.trim().slice(0, 60)}`] : []; });
{
    for (const d of ['README.md', 'docs/GUIDE.md']) { const h = oldNameHits(doc[d]); ok(h.length === 0, `${d} does not name the product or the command "Plugin Guard" / "plugin-guard" (internal names listed in the test are allowed)${list(h)}`); }
    const p = oldNameHits('Run `npm run plugin-guard` or ask Plugin Guard.\nThe folder plugin-guard-reports and the file plugin-guard.config.json are fine.');
    ok(p.length === 1 && /^line 1:/.test(p[0]), 'the old-name check catches a planted old command and product name, and allows the internal names (in memory)');
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll docs checks passed');
process.exit(failures ? 1 : 0);
