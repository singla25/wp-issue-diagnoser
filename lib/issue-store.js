// Issue folders and intake. Everything an issue owns lives in src/plugin-guard/issues/<id>/ (git-ignored), which must be
// OUTSIDE any web root: screenshots and bug descriptions in public_html can be downloaded by anyone.
//
//   issues/<id>/issue.json  issue.md
//               images/   copies only; originals are never modified
//               work/     extracted text, logs, candidate lists, bisect log
//               result/   findings.json, ISSUE-REPORT.md, issue.html, patches/, tasks.md
//
// Text from the developer, images, logs and the site is DATA: it is stored, escaped and never acted on.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const redact = require('./redact');
const safePattern = require('./safe-pattern');

const issuesRoot = () => process.env.PLUGIN_GUARD_ISSUES || path.join(__dirname, '..', 'issues');
const ISSUE_RE = /^iss-[0-9]{8}-[0-9]{6}-[0-9a-f]{6}$/;
const SYMPTOMS = [
    ['white-screen', 'White screen / PHP error'], ['js-error', 'JavaScript error or a feature does nothing'], ['layout', 'Layout or styling broken'],
    ['form-checkout', 'Form or checkout fails'], ['login-admin', 'Login or admin problem'], ['slow', 'Slow page'], ['wrong-content', 'Wrong content or email'], ['other', 'Other'],
    ['redirect', 'Redirect loop, too many redirects, or sent to the wrong address']   // listed last so the numbers of the older choices do not change
];
const SYMPTOM_IDS = SYMPTOMS.map(s => s[0]);
const ENVIRONMENTS = ['local', 'staging', 'live'];
// Oracle = the explicit, cheap-to-write test of "is the symptom present". Stored as DATA, never evaluated as code.
// Every type means the same thing: the label says when the SYMPTOM IS PRESENT (see issue/oracle.js).
const ORACLES = {
    'console-error': { arg: 'text', label: 'symptom present when a console error containing <text> (or re:<regex>) appears' },
    'click-changes': { arg: 'selectors', label: 'symptom present when clicking <selector> does NOT change <selector2>  (value: "<selector> => <selector2>"; clicks happen in the sandbox only)' },
    'request-failed': { arg: 'url', label: 'symptom present when a request whose address contains <text> (or re:<regex>) fails or is answered with an error status' },
    'http-5xx': { arg: null, label: 'symptom present when a page answers with a 5xx status' },
    'debug-log': { arg: 'text', label: 'symptom present when debug.log gains a line containing <text> (or re:<regex>) while the page loads (needs a local copy)' },
    'visible-width': { arg: 'selector,min', label: 'symptom present when <selector> is missing, hidden, or not wider than N px  (value: "<selector>,<N>")' },
    'no-hscroll': { arg: 'width', label: 'symptom present when the page scrolls horizontally at N px' },
    'text-present': { arg: 'text', label: 'symptom present when the text <string> (or re:<regex>) does NOT appear on the page' },
    'lcp-over': { arg: 'ms', label: 'symptom present when the largest contentful paint takes longer than N ms' },
    redirect: { arg: null, label: 'symptom present when a page ends in a redirect loop, follows more than N redirects in a row (value: N, default 3) or is redirected to another host' },
    generic: { arg: null, label: 'generic: symptom present when the page shows a console error, a failing same-site request, a 5xx status, horizontal scrolling or a new PHP error in debug.log' }
};
const DEFAULT_ORACLE = { 'white-screen': 'http-5xx', 'js-error': 'console-error', layout: 'no-hscroll', 'form-checkout': 'generic', 'login-admin': 'generic', slow: 'lcp-over', 'wrong-content': 'text-present', other: 'generic', redirect: 'redirect' };

const LIMITS = { images: 30, imageBytes: 10 * 1024 * 1024, megapixels: 40, title: 120, description: 5000, pages: 10, oracleArg: 200 };
const IMAGE_KINDS = ['png', 'jpg', 'webp'];
const DENY_PREFIX = ['/proc', '/sys', '/dev'];

const inside = (parent, child) => child === parent || child.startsWith(parent + path.sep);
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');
const userError = (msg, exitCode = 2) => Object.assign(new Error(msg), { exitCode });

// strip control characters (keep \n and \t), redact credential-looking text
const clean = (s, max) => redact.text(String(s ?? '').replace(/\0/g, '').replace(/[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')).slice(0, max).trim();

function newId(seed = '', now = new Date()) {
    const d = now.toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
    return `iss-${d}-${crypto.createHash('sha1').update(`${seed}|${now.toISOString()}|${process.pid}|${crypto.randomBytes(4).toString('hex')}`).digest('hex').slice(0, 6)}`;
}
function dirOf(id) {
    if (!ISSUE_RE.test(String(id))) throw userError(`"${id}" is not an issue id (expected iss-YYYYMMDD-HHMMSS-xxxxxx). List them with: issue list`);
    return path.join(issuesRoot(), id);
}

// The issue store must never sit inside the WordPress tree being investigated.
function assertOutsideWebRoot(wpRoot) {
    if (!wpRoot) return;
    let real; try { real = fs.realpathSync(wpRoot); } catch { return; }
    fs.mkdirSync(issuesRoot(), { recursive: true, mode: 0o700 });
    if (inside(real, fs.realpathSync(issuesRoot()))) throw userError(`The issue folder (${issuesRoot()}) is inside the WordPress root ${real}. Files there can be downloaded by visitors. Set PLUGIN_GUARD_ISSUES to a folder outside the web root.`);
}

// -> { issue, problems }. Does not touch the disk.
function normalise(input = {}) {
    const problems = [];
    const title = clean(input.title, LIMITS.title);
    if (!title) problems.push('title is required');
    const symptom = input.symptom || 'other';
    if (!SYMPTOM_IDS.includes(symptom)) problems.push(`symptom must be one of ${SYMPTOM_IDS.join(', ')}`);
    const environment = input.environment || null;
    if (environment && !ENVIRONMENTS.includes(environment)) problems.push(`environment must be one of ${ENVIRONMENTS.join(', ')}`);

    let site = null;
    if (input.url) { try { const u = new URL(input.url); if (!/^https?:$/.test(u.protocol)) throw new Error('x'); site = u.href; } catch { problems.push(`url "${String(input.url).slice(0, 80)}" is not a valid http(s) address`); } }
    const pages = [];
    for (const p of [].concat(input.pages || [])) {
        const s = String(p).trim();
        if (!s) continue;
        if (/^https?:\/\//i.test(s)) { try { pages.push(new URL(s).href); } catch { problems.push(`page "${s.slice(0, 80)}" is not a valid address`); } }
        else if (s.startsWith('/') && !s.startsWith('//') && !/[\0\s]/.test(s)) pages.push(s.slice(0, 500));
        else problems.push(`page "${s.slice(0, 80)}" must be an http(s) address or a path starting with "/"`);
    }
    if (pages.length > LIMITS.pages) problems.push(`at most ${LIMITS.pages} pages`);

    const kind = input.oracle && input.oracle.type ? input.oracle.type : null;
    let oracle = { type: DEFAULT_ORACLE[symptom] || 'generic', value: null, defaulted: true };
    if (kind) {
        if (!ORACLES[kind]) problems.push(`oracle type must be one of ${Object.keys(ORACLES).join(', ')}`);
        else {
            const value = input.oracle.value == null ? null : String(input.oracle.value).replace(/\0/g, '').slice(0, 1000); // not cut to the limit: an over-long pattern must be refused, not silently shortened
            if (ORACLES[kind].arg && !value) problems.push(`oracle "${kind}" needs a value (${ORACLES[kind].arg})`);
            if (kind === 'visible-width' && value && !/^.{1,150},\s*\d{1,5}$/.test(value)) problems.push('oracle "visible-width" needs "<selector>,<minimum width in px>", for example ".hero img,300"');
            if (kind === 'click-changes' && value && !/^.+=>.+$/.test(value)) problems.push('oracle "click-changes" needs "<selector> => <selector that should change>"');
            if (['console-error', 'debug-log', 'text-present', 'request-failed'].includes(kind) && value) { const c = safePattern.compile(value); if (!c.ok) problems.push(`oracle "${kind}": pattern refused: ${c.problem}. Plain text is matched as typed; start with re: for a regular expression.`); }
            if (['no-hscroll', 'lcp-over'].includes(kind) && !(Number(value) > 0)) problems.push(`oracle "${kind}" needs a positive number`);
            if (kind === 'redirect' && value && !(Number(value) > 0)) problems.push('oracle "redirect" takes an optional positive number (the chain limit)');
            oracle = { type: kind, value, defaulted: false };
        }
    }
    const issue = {
        schema: 1, id: null, created_at: null, status: 'NEW',
        title, description: clean(input.description, LIMITS.description), since: clean(input.since, 300), changed_before: clean(input.changedBefore, 600),
        symptom, environment, authorized_live: !!input.authorized, url: site, pages, needs_login: !!input.needsLogin, oracle,
        root: input.root || null, images: [], notes: [],
        ...(input.auto ? { auto_generated: true, auto: { fingerprint: String(input.auto.fingerprint || '').slice(0, 40), source: String(input.auto.source || '').slice(0, 80), occurrences: Number(input.auto.occurrences) || 0, severity: String(input.auto.severity || '').slice(0, 4), frontend_ids: [].concat(input.auto.frontend_ids || []).map(x => String(x).slice(0, 80)).slice(0, 10) } } : {})
    };
    return { issue, problems };
}

// A live site is never touched unless the owner said so (same rule as qa-url).
function authorization(issue) {
    if (!issue.url) return { ok: true, probe: false };
    if (!issue.environment) return { ok: false, message: `Say what kind of site ${issue.url} is: --env local | staging | live. The tool will not guess that a public site may be probed.` };
    if (issue.environment === 'live' && !issue.authorized_live) return { ok: false, message: `${issue.url} is marked live. Probing a live site needs the owner's permission: re-run with --authorized (prefer a staging copy).` };
    return { ok: true, probe: true };
}

function create(input, { now = new Date() } = {}) {
    const { issue, problems } = normalise(input);
    if (problems.length) throw userError(`Cannot create the issue:\n  - ${problems.join('\n  - ')}`);
    const auth = authorization(issue);
    if (!auth.ok) throw userError(auth.message, 3);
    assertOutsideWebRoot(issue.root);
    issue.id = newId(issue.title, now);
    issue.created_at = now.toISOString();
    const dir = dirOf(issue.id);
    for (const d of ['images', 'work', 'result']) fs.mkdirSync(path.join(dir, d), { recursive: true, mode: 0o700 });
    save(issue);
    return issue;
}

const fileOf = id => path.join(dirOf(id), 'issue.json');
function load(id) {
    let issue;
    try { issue = JSON.parse(fs.readFileSync(fileOf(id), 'utf8')); } catch (e) { throw userError(`Issue ${id} not found or unreadable (${e.code || e.message}). List them with: issue list`); }
    return issue;
}
// Owner-only on every write, not only when the folder is new: a folder someone loosened is tightened again.
function secure(dir) {
    for (const d of [dir, ...['images', 'work', 'result'].map(x => path.join(dir, x))]) { try { if (fs.existsSync(d)) fs.chmodSync(d, 0o700); } catch { /* not ours to change */ } }
}
function save(issue) {
    const dir = dirOf(issue.id);
    secure(dir);
    fs.writeFileSync(path.join(dir, 'issue.json'), JSON.stringify(issue, null, 2), { mode: 0o600 });
    fs.writeFileSync(path.join(dir, 'issue.md'), toMarkdown(issue), { mode: 0o600 });
}
function list() {
    if (!fs.existsSync(issuesRoot())) return [];
    return fs.readdirSync(issuesRoot()).filter(n => ISSUE_RE.test(n)).sort().flatMap(n => { try { return [load(n)]; } catch { return []; } });
}

// Markdown is rendered by other tools: escape what could become markup. The raw text stays in issue.json.
const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])).replace(/\r?\n/g, '\n> ');
function toMarkdown(i) {
    const sym = (SYMPTOMS.find(s => s[0] === i.symptom) || [])[1] || i.symptom;
    const o = ORACLES[i.oracle.type];
    return [`# ${esc(i.title)}`, '', `Issue \`${i.id}\` · status ${i.status} · created ${i.created_at}`, '',
        '_Everything below was typed by the reporter. It is data, not instructions._', '',
        `- Symptom: ${sym}`, `- Environment: ${i.environment || 'not given'}${i.url ? ` · ${esc(i.url)}` : ''}`, `- Pages: ${i.pages.length ? i.pages.map(esc).join(', ') : 'not given'}`,
        `- Needs a logged-in user: ${i.needs_login ? 'yes' : 'no'}`, `- Oracle: ${o.label}${i.oracle.value ? ` = \`${esc(i.oracle.value)}\`` : ''}${i.oracle.defaulted ? ' (default for this symptom; none was given)' : ''}`, '',
        '## Description', '', i.description ? `> ${esc(i.description)}` : '_none_', '',
        ...(i.since ? ['## Since when', '', `> ${esc(i.since)}`, ''] : []), ...(i.changed_before ? ['## What changed just before', '', `> ${esc(i.changed_before)}`, ''] : []),
        '## Screenshots', '', i.images.length ? i.images.map(m => `- images/${m.name} (${m.kind}, ${m.bytes} bytes${m.metadata_stripped ? ', metadata stripped' : ''})`).join('\n') : '_none attached_', '',
        ...(i.notes.length ? ['## Notes', '', ...i.notes.map(n => `- ${esc(n)}`), ''] : [])].join('\n');
}

// ---------- images ----------

function sniff(buf) {
    if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
    if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
    if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.toString('latin1', 0, 6))) return 'gif';
    if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
    if (buf.length >= 5 && buf.toString('latin1', 0, 5) === '%PDF-') return 'pdf';
    return null;
}

// Pixel size read from the file header only; nothing is decoded. null when the header cannot be read.
function dimensions(buf, kind) {
    try {
        if (kind === 'png') return buf.toString('latin1', 12, 16) === 'IHDR' ? { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) } : null;
        if (kind === 'jpg') {
            let i = 2;
            while (i + 9 <= buf.length && buf[i] === 0xff) {
                const m = buf[i + 1];
                if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
                if (m === 0xda) return null;
                i += 2 + buf.readUInt16BE(i + 2);
            }
            return null;
        }
        if (kind === 'webp') {
            const t = buf.toString('latin1', 12, 16);
            if (t === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
            if (t === 'VP8L') return { w: 1 + (((buf[22] & 0x3f) << 8) | buf[21]), h: 1 + (((buf[24] & 0xf) << 10) | (buf[23] << 2) | ((buf[22] & 0xc0) >> 6)) };
            if (t === 'VP8X') return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
        }
    } catch { /* truncated header */ }
    return null;
}

// Remove metadata (EXIF, XMP, IPTC, text chunks). Returns { buf, stripped }. Pixels are untouched. PDF/GIF are copied as they are.
function stripMetadata(buf, kind) {
    try {
        if (kind === 'jpg') {
            const out = [buf.subarray(0, 2)]; let i = 2, stripped = false;
            while (i + 4 <= buf.length && buf[i] === 0xff) {
                const marker = buf[i + 1];
                if (marker === 0xda) break; // start of scan: the rest is image data
                const len = buf.readUInt16BE(i + 2), seg = buf.subarray(i, i + 2 + len);
                if (marker === 0xe1 || marker === 0xed || marker === 0xfe) stripped = true; else out.push(seg); // APP1 (EXIF/XMP), APP13 (IPTC), comments
                i += 2 + len;
            }
            out.push(buf.subarray(i));
            return { buf: Buffer.concat(out), stripped };
        }
        if (kind === 'png') {
            const out = [buf.subarray(0, 8)]; let i = 8, stripped = false;
            while (i + 12 <= buf.length) {
                const len = buf.readUInt32BE(i), type = buf.toString('latin1', i + 4, i + 8), end = i + 12 + len;
                if (['eXIf', 'tEXt', 'iTXt', 'zTXt', 'tIME'].includes(type)) stripped = true; else out.push(buf.subarray(i, end));
                i = end;
            }
            return { buf: Buffer.concat(out), stripped };
        }
        if (kind === 'webp') {
            const out = [buf.subarray(0, 12)]; let i = 12, stripped = false;
            while (i + 8 <= buf.length) {
                const type = buf.toString('latin1', i, i + 4), len = buf.readUInt32LE(i + 4), end = i + 8 + len + (len % 2);
                if (type === 'EXIF' || type === 'XMP ') stripped = true; else out.push(buf.subarray(i, Math.min(end, buf.length)));
                i = end;
            }
            const body = Buffer.concat(out); body.writeUInt32LE(body.length - 8, 4);
            return { buf: body, stripped };
        }
    } catch { /* malformed container: fall through and copy unchanged, the type check already passed */ }
    return { buf, stripped: false };
}

const safeName = s => path.basename(String(s)).normalize('NFKD').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '').slice(0, 60) || 'image';

// sources: files or folders (a folder contributes its direct image files only). Never follows symlinks, never recurses.
// -> { accepted, refused: [{path, reason}], warnings }
function intakeImages(id, sources, { wpRoot = null } = {}) {
    const issue = load(id), dir = dirOf(id), imgDir = path.join(dir, 'images');
    secure(dir);
    const refused = [], warnings = [], accepted = [];
    let realRoot = null; if (wpRoot) { try { realRoot = fs.realpathSync(wpRoot); } catch { /* checked elsewhere */ } }

    const candidates = [];
    for (const src of [].concat(sources || [])) {
        const s = String(src);
        if (!s.trim()) continue;
        if (s.includes('\0')) { refused.push({ path: s.replace(/\0/g, '\\0'), reason: 'path contains a NUL byte' }); continue; }
        const abs = path.resolve(s);
        if (DENY_PREFIX.some(p => inside(p, abs))) { refused.push({ path: s, reason: 'system folder' }); continue; }
        let st; try { st = fs.lstatSync(abs); } catch { refused.push({ path: s, reason: 'does not exist' }); continue; }
        if (st.isSymbolicLink()) { refused.push({ path: s, reason: 'is a symbolic link (links are never followed)' }); continue; }
        if (st.isDirectory()) {
            const names = fs.readdirSync(abs).sort();
            for (const n of names) {
                const f = path.join(abs, n); let fs2; try { fs2 = fs.lstatSync(f); } catch { continue; }
                if (fs2.isFile() && /\.(png|jpe?g|webp|gif|pdf)$/i.test(n)) candidates.push(f);
            }
        } else if (st.isFile()) candidates.push(abs);
        else refused.push({ path: s, reason: 'not a regular file' });
    }

    let n = issue.images.length;
    const seen = new Set(issue.images.map(m => m.sha256));
    const publicOriginals = [];
    for (const f of candidates) {
        if (n >= LIMITS.images) { refused.push({ path: f, reason: `more than ${LIMITS.images} files` }); continue; }
        let st; try { st = fs.lstatSync(f); } catch { refused.push({ path: f, reason: 'unreadable' }); continue; }
        if (st.isSymbolicLink() || !st.isFile()) { refused.push({ path: f, reason: 'not a regular file' }); continue; }
        if (st.size > LIMITS.imageBytes) { refused.push({ path: f, reason: `larger than ${LIMITS.imageBytes / 1048576} MB` }); continue; }
        const buf = fs.readFileSync(f), kind = sniff(buf);
        if (kind === 'gif' || kind === 'pdf') { refused.push({ path: f, reason: `${kind.toUpperCase()} is not accepted: only PNG, JPG or WEBP screenshots (export the page or take a screenshot instead)` }); continue; }
        if (!kind) { refused.push({ path: f, reason: `content is not ${IMAGE_KINDS.join('/').toUpperCase()} (the file name is not trusted)` }); continue; }
        const dim = dimensions(buf, kind);
        if (!dim || !(dim.w > 0 && dim.h > 0)) { refused.push({ path: f, reason: 'image size could not be read from the file header' }); continue; }
        if (dim.w * dim.h > LIMITS.megapixels * 1e6) { refused.push({ path: f, reason: `${dim.w}x${dim.h} is ${(dim.w * dim.h / 1e6).toFixed(1)} megapixels, above the ${LIMITS.megapixels} MP limit (checked from the header, the image was not decoded)` }); continue; }
        const ext = path.extname(f).toLowerCase().replace('jpeg', 'jpg').slice(1);
        if (ext && ext !== kind) warnings.push(`${path.basename(f)}: extension .${ext} but the content is ${kind}; stored as .${kind}`);
        const { buf: out, stripped } = stripMetadata(buf, kind);
        const digest = sha256(out);
        if (seen.has(digest)) { warnings.push(`${path.basename(f)}: identical to an image already attached, skipped`); continue; }
        seen.add(digest);
        const name = `${String(++n).padStart(2, '0')}-${safeName(path.basename(f, path.extname(f)))}.${kind}`;
        fs.writeFileSync(path.join(imgDir, name), out, { mode: 0o600 });
        const meta = { name, kind, bytes: out.length, sha256: digest, metadata_stripped: stripped, from_web_root: false };
        let real; try { real = fs.realpathSync(f); } catch { real = f; }
        if (realRoot && inside(realRoot, real)) {
            meta.from_web_root = true; publicOriginals.push(path.relative(realRoot, real).split(path.sep).join('/'));
        }
        issue.images.push(meta); accepted.push(meta);
    }
    if (publicOriginals.length) {
        warnings.push(`${publicOriginals.length} original(s) are inside the WordPress folder (${publicOriginals.slice(0, 3).join(', ')}${publicOriginals.length > 3 ? ', ...' : ''}) and are probably downloadable by anyone. Copies were made in the issue folder; delete the originals. They were NOT modified or deleted by this tool.`);
        issue.public_originals = publicOriginals;
    }
    for (const r of refused) issue.notes.push(`image refused: ${r.path.slice(0, 120)}: ${r.reason}`);
    save(issue);
    return { accepted, refused, warnings };
}

// Files the developer dropped straight into issues/<id>/images/ (the "default folder" choice): validate, strip metadata,
// rename, and remove the raw drop. Refused files are moved to work/refused/ and never kept in images/.
function adoptDropped(id, opts = {}) {
    secure(dirOf(id));
    const issue = load(id), imgDir = path.join(dirOf(id), 'images'), known = new Set(issue.images.map(m => m.name));
    const stage = path.join(dirOf(id), 'work', 'dropped');
    const names = fs.readdirSync(imgDir).filter(n => !known.has(n)).sort();
    if (!names.length) return { accepted: [], refused: [], warnings: [] };
    fs.mkdirSync(stage, { recursive: true, mode: 0o700 });
    const moved = names.map(n => { const to = path.join(stage, n); fs.renameSync(path.join(imgDir, n), to); return to; });
    const res = intakeImages(id, moved, opts);
    const refusedDir = path.join(dirOf(id), 'work', 'refused');
    for (const r of res.refused) { fs.mkdirSync(refusedDir, { recursive: true, mode: 0o700 }); try { fs.renameSync(r.path, path.join(refusedDir, path.basename(r.path))); } catch { /* already gone */ } }
    fs.rmSync(stage, { recursive: true, force: true });
    return res;
}

module.exports = { dimensions, adoptDropped, issuesRoot, ISSUE_RE, SYMPTOMS, SYMPTOM_IDS, ENVIRONMENTS, ORACLES, DEFAULT_ORACLE, LIMITS, newId, dirOf, normalise, authorization, create, load, save, list, intakeImages, sniff, stripMetadata, toMarkdown, assertOutsideWebRoot, userError, sha256 };
