// The hygiene rules, shared so that the same patterns and bans cover the whole repository:
//   scripts/selftest-hygiene.js (src/plugin-guard, also in a copy of this package on its own) and the root scripts/selftest-repo.js
//   (everything else in the repository: the other modules, docs, .claude, root files and scripts). Not a test by itself.
// The patterns are assembled from pieces so this file does not match itself.
const fs = require('fs');
const os = require('os');
const path = require('path');

const SKIP_DIR = new Set(['node_modules', '.git', 'reports', 'plugin-guard-reports', 'issues', 'sandboxes', 'playwright-report', 'test-results', 'coverage', 'dist', 'build']);
const SKIP_FILE = /(^package-lock\.json$|\.(png|jpe?g|webp|pdf|traineddata|ico|woff2?)$|^knowledge-verification\.json$|^KNOWLEDGE-REVIEW\.md$)/;

// -> the files to scan under root; skipRel: folders (relative to root, "/" separated) that are not walked
function collect(root, skipRel = []) {
    const out = [];
    (function walk(dir) {
        for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
            if (e.isSymbolicLink()) continue;
            const f = path.join(dir, e.name);
            if (e.isDirectory()) { if (!SKIP_DIR.has(e.name) && !skipRel.includes(path.relative(root, f).split(path.sep).join('/'))) walk(f); }
            else if (!SKIP_FILE.test(e.name)) out.push(f);
        }
    })(root);
    return out.filter(f => { try { return fs.statSync(f).size < 3 * 1024 * 1024; } catch { return false; } });
}

// the content checks, in order, each reported through ok(cond, message). projNames: client / site names to ban (from projects/).
function contentChecks(root, files, ok, projNames = []) {
    const text = new Map(files.map(f => [f, (() => { try { const b = fs.readFileSync(f); return b.includes(0) ? '' : b.toString('utf8'); } catch { return ''; } })()]));
    const hits = (re, allow = () => false) => { const out = []; for (const [f, t] of text) { const lines = t.split('\n'); lines.forEach((l, i) => { const m = l.match(re); if (m && !allow(l, m, f)) out.push(`${path.relative(root, f)}:${i + 1}: ${l.trim().slice(0, 110)}`); }); } return out; };
    const found = {};
    // secrets
    const SECRET = new RegExp([`AKIA[0-9A-Z]{16}`, `sk_${'live'}_[0-9A-Za-z]{10,}`, `gh${'p'}_[0-9A-Za-z]{20,}`, `xox[baprs]-[0-9A-Za-z-]{10,}`, `-----BEGIN [A-Z ]*PRIVATE ${'KEY'}`, `AIza[0-9A-Za-z_-]{30,}`].join('|'));
    // an obviously made-up value (a run of the alphabet, repeated characters) used by the redaction tests is not a secret
    const FAKE = /(abcdefgh|sk_live_x\b|xxxx|0000|1234567|not-a-real|must-not-reach|fake|dummy)/i;
    const secrets = found.secrets = hits(SECRET, (l, m, f) => /selftest/.test(f) && FAKE.test(l));
    ok(secrets.length === 0, `no API key, token or private key (${secrets.length}${secrets.length ? ': ' + secrets.slice(0, 3).join(' | ') : ''})`);
    const ASSIGN = /(api[_-]?key|secret|token|passw(?:or)?d|auth[_-]?key)["']?\s*[:=]\s*["']([A-Za-z0-9_\-+/=]{20,})["']/i;
    const assigns = found.assigns = hits(ASSIGN, (l, m) => /^(process\.env|\$|x{4,}|0{4,}|<|\{|changeme|your|example|test|fake|dummy|secret|placeholder)/i.test(m[2]) || /selftest|fixtures|\.test\./.test(l) || FAKE.test(l));
    ok(assigns.length === 0, `no credential-looking assignment outside test data (${assigns.length}${assigns.length ? ': ' + assigns.slice(0, 3).join(' | ') : ''})`);

    // who and where
    const user = os.userInfo().username, host = os.hostname();
    const mine = [user, host].filter(x => x && x.length > 3 && !['root', 'localhost'].includes(x));
    const me = found.me = hits(new RegExp(mine.map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')));
    ok(me.length === 0, `this computer's user name and host name appear nowhere (${me.length}${me.length ? ': ' + me.slice(0, 3).join(' | ') : ''})`);
    const HOME = /\/(?:home|Users)\/(?!me\/|x\b|you\/|user\/|name\/|example|\.\.\.|<|\$|\*|\{|\.claude|\.\w)([A-Za-z0-9._-]+)/;
    const homes = found.homes = hits(HOME);
    ok(homes.length === 0, `no absolute home-folder path of a real person (${homes.length}${homes.length ? ': ' + homes.slice(0, 3).join(' | ') : ''})`);
    // a container path (/var/www/html/wp-...) or a placeholder (/var/www/x/...) is not a real site
    const WEBROOT = found.webroot = hits(/\/var\/www\/(?:html\/)?[0-9A-Za-z_.-]+\/[A-Za-z0-9_.-]+/, (l, m) => /\/var\/www\/html\/(wp-|wordpress\b|site\b)|\/var\/www\/(x|site|wp|example|html)\//.test(m[0] + '/') && !/\/var\/www\/html\/[0-9]/.test(m[0]));
    ok(WEBROOT.length === 0, `no real web-root path (${WEBROOT.length}${WEBROOT.length ? ': ' + WEBROOT.slice(0, 3).join(' | ') : ''})`);

    // e-mail addresses and domains
    const MAIL = found.mail = hits(/[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+\.)+[a-z]{2,}/i, (l, m) => /@(example\.(com|org|net|test|invalid)|[a-z0-9-]+\.(test|example|invalid|local)|noreply\.github\.com)\b|@(types|playwright|wordpress|tesseract|testing-library)\/|\.php\b|@[0-9]|@(latin|cyrillic|devanagari|iqtelif|arab|hans|hant)\b/i.test(m[0] + ' ' + l) || /^\S*@\S*\.(png|jpg|js|css)/.test(m[0]) || /(a@b|@corp\.com)/.test(m[0]) || /anthropic\.com/.test(m[0]));
    ok(MAIL.length === 0, `no real-looking e-mail address (${MAIL.length}${MAIL.length ? ': ' + MAIL.slice(0, 4).join(' | ') : ''})`);

    // client / site data: a site name that is not a placeholder, in the repository's committed files
    // the names come from this computer's own project folders (everything in projects/ except the shared example), so none is written here
    const CLIENT = found.client = projNames.length ? hits(new RegExp(`\\b(${projNames.join('|')})\\b`, 'i')) : [];
    ok(CLIENT.length === 0, `no client or site name from this computer's own projects (${projNames.length} checked) (${CLIENT.length}${CLIENT.length ? ': ' + CLIENT.slice(0, 3).join(' | ') : ''})`);
    return found;
}

// the client / site names: the folders of a projects/ directory, except the shared example
const projectNames = dir => (fs.existsSync(dir) ? fs.readdirSync(dir).filter(n => n !== 'acme' && n.length > 3) : []);

// no database dump or archive lying around
function strayCheck(root, files, ok) {
    const stray = files.filter(f => /\.(sql|sql\.gz|zip|tar|tgz|gz|bak|dump|sqlite|db)$/i.test(f)).map(f => path.relative(root, f));
    ok(stray.length === 0, `no database dump or archive among the repository files (${stray.join(', ') || 'none'})`);
    return stray;
}

module.exports = { SKIP_DIR, SKIP_FILE, collect, contentChecks, projectNames, strayCheck };
