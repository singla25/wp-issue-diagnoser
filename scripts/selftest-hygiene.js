#!/usr/bin/env node
// Hygiene scan of the repository's own files: no secrets, no real user names / host names / absolute home paths, no real e-mail addresses or
// client/site names, and the .gitignore keeps issue data, sandboxes and the OCR language file out. Runs offline over the files themselves.
// Not scanned: node_modules, generated output (reports, issues, sandboxes), lock files, binary data, the verification record of public pages, and
// `projects/` (a person's own project settings and decisions: reported as a WARNING, they are client records and stay local, git-ignored).
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const SKIP_DIR = new Set(['node_modules', '.git', 'reports', 'issues', 'sandboxes', 'playwright-report', 'test-results', 'coverage', 'dist', 'build']);
const SKIP_FILE = /(^package-lock\.json$|\.(png|jpe?g|webp|pdf|traineddata|ico|woff2?)$|^knowledge-verification\.json$|^KNOWLEDGE-REVIEW\.md$)/;
let failures = 0, warnings = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const warn = m => { console.log(`WARN  ${m}`); warnings++; };

function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        if (e.isSymbolicLink()) continue;
        const f = path.join(dir, e.name);
        if (e.isDirectory()) { if (!SKIP_DIR.has(e.name) && !(path.relative(ROOT, f) === 'src/plugin-guard/projects')) walk(f, out); }
        else if (!SKIP_FILE.test(e.name)) out.push(f);
    }
    return out;
}
const files = walk(ROOT).filter(f => { try { return fs.statSync(f).size < 3 * 1024 * 1024; } catch { return false; } });
const text = new Map(files.map(f => [f, (() => { try { const b = fs.readFileSync(f); return b.includes(0) ? '' : b.toString('utf8'); } catch { return ''; } })()]));
const hits = (re, allow = () => false) => { const out = []; for (const [f, t] of text) { const lines = t.split('\n'); lines.forEach((l, i) => { const m = l.match(re); if (m && !allow(l, m, f)) out.push(`${path.relative(ROOT, f)}:${i + 1}: ${l.trim().slice(0, 110)}`); }); } return out; };
const part = s => new RegExp(s);

console.log(`== scanning ${files.length} files`);
// secrets (patterns are assembled from pieces so this file does not match itself)
const SECRET = new RegExp([`AKIA[0-9A-Z]{16}`, `sk_${'live'}_[0-9A-Za-z]{10,}`, `gh${'p'}_[0-9A-Za-z]{20,}`, `xox[baprs]-[0-9A-Za-z-]{10,}`, `-----BEGIN [A-Z ]*PRIVATE ${'KEY'}`, `AIza[0-9A-Za-z_-]{30,}`].join('|'));
// an obviously made-up value (a run of the alphabet, repeated characters) used by the redaction tests is not a secret
const FAKE = /(abcdefgh|sk_live_x\b|xxxx|0000|1234567|not-a-real|must-not-reach|fake|dummy)/i;
const secrets = hits(SECRET, (l, m, f) => /selftest/.test(f) && FAKE.test(l));
ok(secrets.length === 0, `no API key, token or private key (${secrets.length}${secrets.length ? ': ' + secrets.slice(0, 3).join(' | ') : ''})`);
const ASSIGN = /(api[_-]?key|secret|token|passw(?:or)?d|auth[_-]?key)["']?\s*[:=]\s*["']([A-Za-z0-9_\-+/=]{20,})["']/i;
const assigns = hits(ASSIGN, (l, m) => /^(process\.env|\$|x{4,}|0{4,}|<|\{|changeme|your|example|test|fake|dummy|secret|placeholder)/i.test(m[2]) || /selftest|fixtures|\.test\./.test(l) || FAKE.test(l));
ok(assigns.length === 0, `no credential-looking assignment outside test data (${assigns.length}${assigns.length ? ': ' + assigns.slice(0, 3).join(' | ') : ''})`);

// who and where
const user = os.userInfo().username, host = os.hostname();
const mine = [user, host].filter(x => x && x.length > 3 && !['root', 'localhost'].includes(x));
const me = hits(new RegExp(mine.map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')));
ok(me.length === 0, `this computer's user name and host name appear nowhere (${me.length}${me.length ? ': ' + me.slice(0, 3).join(' | ') : ''})`);
const HOME = /\/(?:home|Users)\/(?!me\/|x\b|you\/|user\/|name\/|example|\.\.\.|<|\$|\*|\{|\.claude|\.\w)([A-Za-z0-9._-]+)/;
const homes = hits(HOME);
ok(homes.length === 0, `no absolute home-folder path of a real person (${homes.length}${homes.length ? ': ' + homes.slice(0, 3).join(' | ') : ''})`);
// a container path (/var/www/html/wp-...) or a placeholder (/var/www/x/...) is not a real site
const WEBROOT = hits(/\/var\/www\/(?:html\/)?[0-9A-Za-z_.-]+\/[A-Za-z0-9_.-]+/, (l, m) => /\/var\/www\/html\/(wp-|wordpress\b|site\b)|\/var\/www\/(x|site|wp|example|html)\//.test(m[0] + '/') && !/\/var\/www\/html\/[0-9]/.test(m[0]));
ok(WEBROOT.length === 0, `no real web-root path (${WEBROOT.length}${WEBROOT.length ? ': ' + WEBROOT.slice(0, 3).join(' | ') : ''})`);

// e-mail addresses and domains
const MAIL = hits(/[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+\.)+[a-z]{2,}/i, (l, m) => /@(example\.(com|org|net|test|invalid)|[a-z0-9-]+\.(test|example|invalid|local)|noreply\.github\.com)\b|@(types|playwright|wordpress|tesseract|testing-library)\/|\.php\b|@[0-9]|@(latin|cyrillic|devanagari|iqtelif|arab|hans|hant)\b/i.test(m[0] + ' ' + l) || /^\S*@\S*\.(png|jpg|js|css)/.test(m[0]) || /(a@b|@corp\.com)/.test(m[0]) || /anthropic\.com/.test(m[0]));
ok(MAIL.length === 0, `no real-looking e-mail address (${MAIL.length}${MAIL.length ? ': ' + MAIL.slice(0, 4).join(' | ') : ''})`);

// client / site data: a site name that is not a placeholder, in the repository's committed files
// the names come from this computer's own project folders (everything in projects/ except the shared example), so none is written here
const projNames = fs.existsSync(path.join(ROOT, 'src', 'plugin-guard', 'projects')) ? fs.readdirSync(path.join(ROOT, 'src', 'plugin-guard', 'projects')).filter(n => n !== 'acme' && n.length > 3) : [];
const CLIENT = projNames.length ? hits(new RegExp(`\\b(${projNames.join('|')})\\b`, 'i')) : [];
ok(CLIENT.length === 0, `no client or site name from this computer's own projects (${projNames.length} checked) (${CLIENT.length}${CLIENT.length ? ': ' + CLIENT.slice(0, 3).join(' | ') : ''})`);

// .gitignore
const gi = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8').split('\n').map(l => l.trim());
for (const [pat, why] of [['src/plugin-guard/issues/', 'issue folders (reports, screenshots, OCR text)'], ['src/plugin-guard/sandboxes/', 'sandbox copies of sites'], ['src/plugin-guard/data/ocr/*.traineddata', 'the OCR language file'], ['.env', 'environment files'], ['.env.*', 'environment files'], ['node_modules/', 'dependencies'], ['reports/*', 'run output'], ['src/plugin-guard/projects/*/history/', 'scan history']]) ok(gi.includes(pat), `.gitignore covers ${pat} (${why})`);
// the OCR file really is not present as a tracked-looking file outside data/ocr, and no dump / archive is lying around
const stray = files.filter(f => /\.(sql|sql\.gz|zip|tar|tgz|gz|bak|dump|sqlite|db)$/i.test(f)).map(f => path.relative(ROOT, f));
ok(stray.length === 0, `no database dump or archive among the repository files (${stray.join(', ') || 'none'})`);

// projects/ : user data, WARN only
const pdir = path.join(ROOT, 'src', 'plugin-guard', 'projects');
if (fs.existsSync(pdir)) for (const p of fs.readdirSync(pdir).sort()) {
    const pj = path.join(pdir, p, 'project.json'); let j = null; try { j = JSON.parse(fs.readFileSync(pj, 'utf8')); } catch { /* none */ }
    if (j && (j.path || j.url) && p !== 'acme') warn(`projects/${p}/project.json holds a local path or a site address. Per-project settings and decisions.txt are client records and stay local (projects/* is git-ignored).`);
}
console.log(`\n${warnings} warning(s)`);
console.log(failures ? `\n${failures} FAILED` : 'All checks passed');
process.exit(failures ? 1 : 0);
