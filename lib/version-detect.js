// TEST-COPY-SPEC Part 6b: which PHP, database and WordPress versions does the real site run, and how do we know? Pure functions only: every input is
// DATA (text from a database file, a Site Health paste, a response header, .htaccess, wp-includes/version.php). Nothing here reads a file, starts a
// process or makes a request; issue/version-match.js does the bounded reading and the image choice. Every value is cut, control characters are
// removed, and a version is only ever taken when it matches a strict pattern, so a hostile text can neither inject markup nor invent a version.
//
// Every detected value is { value, source } where source is one of SOURCES. 'Requires PHP' in a plugin or theme header is a MINIMUM and is never
// read as the version in use (there is deliberately no parser for it here).

const SOURCES = Object.freeze({
    TOLD: 'you told us', CONFIRMED: 'you confirmed', SITE_HEALTH: 'from Site Health', DUMP: 'from the database file header', COLLATION: 'from the collation',
    HEADER: 'from the response header', HTACCESS: 'from .htaccess', FILES: "from the site's files", ASSUMED: 'assumed', UNKNOWN: 'unknown'
});
const SOURCE_LIST = Object.freeze(Object.values(SOURCES));
const CAPS = Object.freeze({ dumpHead: 8 * 1024, dumpScan: 1024 * 1024, siteHealth: 256 * 1024, htaccess: 64 * 1024, versionPhp: 64 * 1024, header: 200, line: 400, plugins: 300, pluginName: 120 });

// control characters (and the Unicode line/paragraph separators) removed, length capped
const clean = (s, n = CAPS.line) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '').slice(0, n);
const VERSION = /^(\d{1,2})\.(\d{1,2})(?:\.(\d{1,3}))?$/;
// "8.2.30" -> "8.2"; anything that is not a plain version -> null
function minorOf(v) { const m = VERSION.exec(String(v || '').trim()); return m ? `${Number(m[1])}.${Number(m[2])}` : null; }
function cmpVersion(a, b) {
    const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d < 0 ? -1 : 1; }
    return 0;
}
const value = (v, source, extra = {}) => ({ value: v === undefined ? null : v, source, ...extra });
const unknown = () => value(null, SOURCES.UNKNOWN);

// ---------------------------------------------------------------- database server, from a server version string
// "8.0.46" | "8.0.36-28" (Percona) | "10.11.6-MariaDB-1:10.11.6+maria~ubu2204" | "5.5.5-10.11.6-MariaDB" (the old MariaDB compatibility prefix) | "11.8.9-MariaDB-ubu2404"
function serverOf(raw) {
    const s = clean(raw, 120).trim();
    const maria = /mariadb/i.test(s);
    const m = (maria ? /^(?:5\.5\.5-)?(\d{1,2}\.\d{1,2}(?:\.\d{1,3})?)(?=$|[-+~_\s,])/ : /^(\d{1,2}\.\d{1,2}(?:\.\d{1,3})?)(?=$|[-+~_\s,])/).exec(s);
    if (!m) return null;
    const major = Number(m[1].split('.')[0]);
    if (!maria && (major < 4 || major > 9)) return null;   // a MySQL server is 4.x to 9.x; anything else is not trusted
    return { family: maria ? 'MariaDB' : 'MySQL', version: m[1] };
}

// The header comment of a database export. text: the first bytes of the (decompressed) file; only the first 8 KB are read.
//   mysqldump:     "-- MySQL dump 10.13  Distrib 8.0.46, for Linux (x86_64)" ... "-- Server version\t8.0.46"
//   mariadb-dump:  "-- MariaDB dump 10.19  Distrib 10.11.6-MariaDB, ..." or (11.x) "-- MariaDB dump 10.20-11.8.9-MariaDB, for debian-linux-gnu" ... "-- Server version\t11.8.9-MariaDB-ubu2404"
//   phpMyAdmin:    "-- Server version: 10.6.16-MariaDB-0ubuntu0.22.04.1";   Adminer: "-- Adminer 4.8.1 MySQL 8.0.46 dump"
//   mariadb-dump since 2024 starts with "/*M!999999\- enable the sandbox mode */"; "/*M!" comments are MariaDB-only syntax (also with --skip-comments)
// -> { family, value, source, how } or null. The SERVER line wins; a Distrib line is the export tool's own version and only a fallback.
// MariaDB-only executable comments, ANYWHERE in the scanned text (also mid-line, e.g. a column "blob /*M!100301 COMPRESSED*/")
const MARIA_SYNTAX = /\/\*M!\d{6}/;
function parseDumpHeader(text) {
    const head = String(text == null ? '' : text).slice(0, CAPS.dumpHead);
    const line = re => { const m = re.exec(head); return m ? m : null; };
    let m = line(/^--[ \t]*Server version:?[ \t]+([0-9][^\r\n]{0,100})$/m) || line(/^--[ \t]*Host:[^\r\n]{0,200}?Server version:?[ \t]+([0-9][^\r\n]{0,100})$/m);
    if (m) { const s = serverOf(m[1]); if (s) return { family: s.family, value: s.version, source: SOURCES.DUMP, how: 'the "Server version" line of the export' }; }
    m = line(/^--[ \t]*Adminer [0-9.]{1,12} (?:MySQL|MariaDB) ([0-9][^\s\r\n]{0,80}) dump/m);
    if (m) { const s = serverOf(m[1]); if (s) return { family: s.family, value: s.version, source: SOURCES.DUMP, how: 'the Adminer export line' }; }
    m = line(/^--[ \t]*MariaDB dump [0-9.]{1,10}-([0-9][0-9.]{2,12}-MariaDB)\b/m) || line(/^--[ \t]*MariaDB dump [0-9.]{1,10}[ \t]+Distrib[ \t]+([0-9][^\s,\r\n]{0,80})/m);
    if (m) { const s = serverOf(m[1]); if (s) return { family: 'MariaDB', value: s.version, source: SOURCES.DUMP, how: 'the export tool line (mariadb-dump); the server version line is missing, so this is the version of the tool that made the export' }; }
    m = line(/^--[ \t]*MySQL dump [0-9.]{1,10}[ \t]+Distrib[ \t]+([0-9][^\s,\r\n]{0,80})/m);
    if (m) { const s = serverOf(m[1]); if (s && s.family === 'MySQL') return { family: 'MySQL', value: s.version, source: SOURCES.DUMP, how: 'the export tool line (mysqldump); the server version line is missing, so this is the version of the tool that made the export' }; }
    if (MARIA_SYNTAX.test(head)) return { family: 'MariaDB', value: null, source: SOURCES.DUMP, how: 'MariaDB-only comment syntax (/*M!...*/) in the export; no version line' };
    return null;
}

// The collation hint, used ONLY when the header says nothing: utf8mb4_0900_* collations are MySQL 8's. MariaDB 11.8.9 also accepts and writes
// utf8mb4_0900_ai_ci (checked against the pinned mariadb container: a table created with it is dumped with it), so the hint is refused when the
// file carries MariaDB-only syntax. text: up to the first 1 MB. -> { family: 'MySQL', value: '8', source: 'from the collation', how } or null
function collationHint(text) {
    const t = String(text == null ? '' : text).slice(0, CAPS.dumpScan);
    if (MARIA_SYNTAX.test(t) || /-MariaDB\b/.test(t.slice(0, CAPS.dumpHead))) return null;
    if (!/\butf8mb4_0900_(?:ai_ci|as_ci|as_cs|bin)\b/.test(t)) return null;
    return { family: 'MySQL', value: '8', source: SOURCES.COLLATION, how: 'a hint only: a utf8mb4_0900 collation (MySQL 8) in the table definitions; no version line in the export' };
}

// ---------------------------------------------------------------- Site Health (wp-admin > Tools > Site Health > Info > "Copy site info to clipboard")
// The paste is untrusted: only lines inside the named sections are read, and only strict patterns are taken.
//   ### wp-core ###            version: 7.1.4
//   ### wp-active-plugins (24) ###   Elementor: version: 3.18.3, author: Elementor.com, Auto-updates disabled
//   ### wp-server ###          php_version: 8.2.30 64bit
//   ### wp-database ###        server_version: 8.0.46   (newer WordPress also: database_type: MySQL / database_version: 8.0.46)
function sections(text) {
    const out = new Map(); let cur = null;
    for (const raw of String(text == null ? '' : text).slice(0, CAPS.siteHealth).split(/\r?\n/)) {
        const line = clean(raw, CAPS.line);
        const h = /^###[ \t]+([a-z0-9-]{1,40})(?:[ \t]+\((\d{1,4})\))?[ \t]+###$/.exec(line.trim());
        if (h) { cur = h[1]; if (!out.has(cur)) out.set(cur, { count: h[2] ? Number(h[2]) : null, lines: [] }); continue; }
        if (cur && line.trim()) out.get(cur).lines.push(line.trim());
    }
    return out;
}
const field = (sec, key) => { if (!sec) return null; const re = new RegExp(`^${key}:[ \\t]*(.{0,200})$`); for (const l of sec.lines) { const m = re.exec(l); if (m) return m[1].trim(); } return null; };
// -> { php, db, wp, active_plugins, active_plugins_count, found } ; each of php/db/wp is { value, source } (db also has family)
function parseSiteHealth(text) {
    const S = sections(text);
    const out = { php: unknown(), db: { family: null, ...unknown() }, wp: unknown(), active_plugins: [], active_plugins_count: null, found: false };
    const php = field(S.get('wp-server'), 'php_version');
    const pm = php && /^(\d{1,2}\.\d{1,2}(?:\.\d{1,3})?)(?:[ \t]|$)/.exec(php);
    if (pm) out.php = value(pm[1], SOURCES.SITE_HEALTH);
    const wp = field(S.get('wp-core'), 'version');
    const wm = wp && /^(\d{1,2}\.\d{1,2}(?:\.\d{1,3})?)(?:-[A-Za-z0-9.]{1,20})?$/.exec(wp);
    if (wm) out.wp = value(wm[1], SOURCES.SITE_HEALTH);
    const dbSec = S.get('wp-database');
    const sv = field(dbSec, 'server_version') || field(dbSec, 'database_version');
    const type = field(dbSec, 'database_type');
    if (sv) {
        const s = serverOf(/^mariadb$/i.test(type || '') && !/mariadb/i.test(sv) ? `${sv}-MariaDB` : sv);
        if (s) out.db = { family: s.family, value: s.version, source: SOURCES.SITE_HEALTH };
    }
    const ap = S.get('wp-active-plugins');
    if (ap) {
        out.active_plugins_count = ap.count;
        for (const l of ap.lines.slice(0, CAPS.plugins)) {
            // the name may itself contain ": " (e.g. "Akismet Anti-spam: Spam Protection"): the LAST ": version:" separates it
            const m = /^(.{1,120}):[ \t]*(?:version:[ \t]*|Version[ \t]+)([0-9][0-9A-Za-z.+-]{0,30})(?=$|[ ,;])/.exec(l);
            if (m) out.active_plugins.push({ name: clean(m[1], CAPS.pluginName).trim(), version: m[2] });
        }
    }
    out.found = !!(pm || wm || out.db.value || out.active_plugins.length);
    return out;
}

// ---------------------------------------------------------------- PHP from the X-Powered-By response header ("PHP/8.2.30"); the value is capped first
function parsePoweredBy(v) {
    const m = /^PHP\/(\d{1,2}\.\d{1,2}(?:\.\d{1,3})?)(?=$|[-\s,;(+~])/i.exec(clean(v, CAPS.header).trim());
    return m ? value(m[1], SOURCES.HEADER) : null;
}

// ---------------------------------------------------------------- PHP from a handler line in .htaccess (read-only); commented lines are ignored
//   AddHandler application/x-httpd-php82 .php        AddHandler application/x-httpd-ea-php81 .php .php8 .phtml   (cPanel EasyApache 4, also with ___lsphp)
//   SetHandler application/x-httpd-php74             AddType application/x-httpd-php80 .php
// The LAST matching line wins (Apache applies the later directive). A handler without a minor version (x-httpd-php8, x-mapp-php6) gives nothing.
function parseHtaccess(text) {
    let found = null;
    for (const raw of String(text == null ? '' : text).slice(0, CAPS.htaccess).split(/\r?\n/)) {
        const l = clean(raw, CAPS.line).trim();
        if (!l || l.startsWith('#')) continue;
        const m = /^(AddHandler|SetHandler|AddType)[ \t]+(?:application\/)?x-httpd-(?:ea-|alt-)?php(\d)(\d{1,2})(?:___lsphp)?(?=[ \t]|$)/i.exec(l);
        if (m) found = value(`${Number(m[2])}.${Number(m[3])}`, SOURCES.HTACCESS, { how: `${m[1]} line in .htaccess` });
    }
    return found;
}

// ---------------------------------------------------------------- WordPress from wp-includes/version.php ($wp_version = '7.1.4';)
function parseVersionPhp(text) {
    const m = /^[ \t]*\$wp_version[ \t]*=[ \t]*'(\d{1,2}\.\d{1,2}(?:\.\d{1,3})?)(?:-[A-Za-z0-9.-]{1,30})?'[ \t]*;/m.exec(String(text == null ? '' : text).slice(0, CAPS.versionPhp));
    return m ? value(m[1], SOURCES.FILES) : null;
}

// ---------------------------------------------------------------- the stated PHP version (issue.php_version + issue.php_source)
function statedPhp(version, source) {
    const v = clean(version, 20).trim();
    if (!/^\d{1,2}\.\d{1,2}(?:\.\d{1,3})?$/.test(v)) return null;
    return value(v, source === SOURCES.CONFIRMED ? SOURCES.CONFIRMED : SOURCES.TOLD);
}

// best source first. inputs: { stated, siteHealth, poweredBy, htaccess, dumpHead, dumpScan, versionPhp } (each already bounded text or a parsed value)
function detect(inputs = {}) {
    const sh = inputs.siteHealth || null;
    const php = inputs.stated || (sh && sh.php && sh.php.value ? sh.php : null) || (inputs.poweredBy ? parsePoweredBy(inputs.poweredBy) : null) || (inputs.htaccess ? parseHtaccess(inputs.htaccess) : null) || value(null, SOURCES.ASSUMED);
    const fromDump = inputs.dumpHead ? parseDumpHeader(inputs.dumpHead) : null;
    const db = fromDump || (sh && sh.db && sh.db.family ? sh.db : null) || (inputs.dumpScan || inputs.dumpHead ? collationHint(inputs.dumpScan || inputs.dumpHead) : null) || { family: null, value: null, source: SOURCES.UNKNOWN };
    const wp = (inputs.versionPhp ? parseVersionPhp(inputs.versionPhp) : null) || unknown();
    return { php, db, wp, active_plugins: sh ? sh.active_plugins : null };
}

// ---------------------------------------------------------------- TEST-COPY-SPEC 6d-1: the active_plugins option of the imported database
// The raw bytes of the option value (PHP serialize format), e.g. a:2:{i:0;s:19:"akismet/akismet.php";i:1;s:9:"hello.php";}
// Only ONE shape is accepted: an array whose keys are integers (or strings) and whose values are all strings. Anything else (a nested array, an
// object, a number, a truncated or over-long value, trailing bytes, more than ACTIVE_CAP entries) gives { ok: false, plugins: [] }: the caller then
// says the list is unknown. Entries that are not shaped like a plugin path ("slug/file.php" or "file.php") are dropped and counted.
const ACTIVE_CAP = 2000;
const ACTIVE_MAX_BYTES = 1024 * 1024;
const PLUGIN_PATH = /^(?:[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/)?[A-Za-z0-9_][A-Za-z0-9._-]{0,99}\.php$/;
const isPluginPath = s => typeof s === 'string' && PLUGIN_PATH.test(s) && !s.split('/').some(p => p === '.' || p === '..' || p.startsWith('..'));
function parseActivePluginsOption(raw, { max = ACTIVE_CAP, maxBytes = ACTIVE_MAX_BYTES } = {}) {
    const fail = reason => ({ ok: false, plugins: [], invalid: 0, reason });
    // byte semantics: the s:<n> lengths count BYTES, so the value is handled as latin1 (one character per byte)
    const s = Buffer.isBuffer(raw) ? raw.toString('latin1') : typeof raw === 'string' ? Buffer.from(raw, 'utf8').toString('latin1') : null;
    if (s === null) return fail('the value is not text');
    if (s.length > maxBytes) return fail(`the value is longer than ${maxBytes} bytes`);
    const head = /^a:(\d{1,7}):\{/.exec(s);
    if (!head) return fail('the value is not a serialized array');
    const n = Number(head[1]);
    if (n > max) return fail(`the list has more than ${max} entries`);
    let i = head[0].length;
    const readInt = () => { const m = /^i:-?\d{1,19};/.exec(s.slice(i, i + 24)); if (!m) return false; i += m[0].length; return true; };
    const readStr = () => {
        const m = /^s:(\d{1,7}):"/.exec(s.slice(i, i + 12)); if (!m) return null;
        const len = Number(m[1]), start = i + m[0].length;
        if (start + len + 2 > s.length || s.slice(start + len, start + len + 2) !== '";') return null;
        i = start + len + 2; return s.slice(start, start + len);
    };
    const out = new Set(); let invalid = 0;
    for (let k = 0; k < n; k++) {
        if (!readInt() && readStr() === null) return fail('an entry has no integer or string key');
        const v = readStr();
        if (v === null) return fail('an entry is not a string');
        if (isPluginPath(v)) out.add(v); else invalid++;
    }
    if (s[i] !== '}' || i + 1 !== s.length) return fail('the value does not end where the array ends');
    return { ok: true, plugins: [...out].sort(), invalid, reason: null };
}

module.exports = { MARIA_SYNTAX, SOURCES, SOURCE_LIST, CAPS, clean, minorOf, cmpVersion, serverOf, parseDumpHeader, collationHint, parseSiteHealth, parsePoweredBy, parseHtaccess, parseVersionPhp, statedPhp, detect, parseActivePluginsOption, isPluginPath, ACTIVE_CAP, ACTIVE_MAX_BYTES };
