// TEST-COPY-SPEC Part 6b: gather what is known about the real site's PHP, database and WordPress versions (bounded, read-only reads of data that is
// already on this computer: the issue file, the Site Health paste, the probe's recorded response header, .htaccess and wp-includes/version.php of the
// copy, the head of the decompressed dump copy), then choose the pinned sandbox images that match best, and say how close they are.
//
// Statuses (one per version): matched | nearest | assumed | not matched | unknown.
//   PHP:  only the same MINOR is "matched"; another minor of the same major that is pinned AND present is "nearest" and named; nothing stated ->
//         the default image, "assumed"; the needed image not present (or not pinned) and no near one -> the default image, "not matched", plus the
//         exact command that gets it. "Requires PHP" headers are never read (they are a minimum, not the version in use).
//   DB:   the family must match (MySQL vs MariaDB) to be "matched" or "nearest"; a mismatch, or a missing image -> the default MariaDB, "not matched";
//         nothing known -> the default MariaDB, "assumed".
//   WordPress: core always comes from the image: "matched" only for the same version, "nearest" for the same major.minor, else "not matched".
// Nothing is ever "matched" unless a pinned image was actually chosen. No network, no Docker call except through the `present` function given.

const fs = require('fs');
const path = require('path');
const vd = require('../lib/version-detect');
const policy = require('./sandbox-policy');

const STATUSES = Object.freeze(['matched', 'nearest', 'assumed', 'not matched', 'unknown']);
const SETUP = 'npm run guard:setup-sandbox --';

// a bounded read of a plain file: no symbolic link, a regular file, at most `cap` bytes. -> string or null
function readCapped(file, cap) {
    try {
        const st = fs.lstatSync(file);
        if (st.isSymbolicLink() || !st.isFile()) return null;
        const fd = fs.openSync(file, 'r');
        try { const b = Buffer.alloc(Math.min(cap, st.size)); const n = fs.readSync(fd, b, 0, b.length, 0); return b.toString('utf8', 0, n); } finally { fs.closeSync(fd); }
    } catch { return null; }
}

class SiteHealthRefused extends Error { constructor(m) { super(m); this.name = 'SiteHealthRefused'; this.exitCode = 2; } }
// --site-health <file>: a plain text file of at most 256 KB, no NUL bytes. Its text is untrusted: only the parsed values are kept (never the paste
// itself, which can hold e-mail addresses and paths). -> the parsed object of version-detect.parseSiteHealth, plus the file's base name
function readSiteHealthFile(file) {
    let st; try { st = fs.lstatSync(file); } catch { throw new SiteHealthRefused(`the Site Health file ${file} does not exist`); }
    if (st.isSymbolicLink() || !st.isFile()) throw new SiteHealthRefused(`the Site Health file ${file} is not a plain file`);
    if (st.size > vd.CAPS.siteHealth) throw new SiteHealthRefused(`the Site Health file is ${Math.ceil(st.size / 1024)} KB; at most ${vd.CAPS.siteHealth / 1024} KB is read. Paste only the text of "Copy site info to clipboard".`);
    const buf = fs.readFileSync(file);
    if (buf.includes(0)) throw new SiteHealthRefused('the Site Health file is not plain text (it contains binary data)');
    const parsed = vd.parseSiteHealth(buf.toString('utf8'));
    return { schema: 1, file: vd.clean(path.basename(file), 80), ...parsed };
}
// writes work/site-health.json of an issue (parsed values only, owner-only). -> the object written
function saveSiteHealth(issueDir, file) {
    const sh = readSiteHealthFile(file);
    fs.mkdirSync(path.join(issueDir, 'work'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(issueDir, 'work', 'site-health.json'), JSON.stringify(sh, null, 2) + '\n', { mode: 0o600 });
    return sh;
}

// the X-Powered-By value recorded by the probe (probe.json, allow-listed headers only): the first loaded page's main document
function poweredByFrom(probe) {
    for (const p of (probe && probe.pages) || []) { const h = p && p.response_headers; if (h && typeof h['x-powered-by'] === 'string') return h['x-powered-by']; }
    return null;
}

// -> the inputs of version-detect.detect(), each bounded. issueDir may be null (an auto-run sandbox without an issue folder).
function gather({ issue = null, issueDir = null, root = null, dumpFile = null } = {}) {
    const json = f => { try { return JSON.parse(readCapped(path.join(issueDir, 'work', f), 4 * 1024 * 1024)); } catch { return null; } };
    const sh = issueDir ? json('site-health.json') : null;
    const probe = issueDir ? json('probe.json') : null;
    const inputs = {
        stated: issue && issue.php_version ? vd.statedPhp(issue.php_version, issue.php_source) : null,
        siteHealth: sh && sh.schema === 1 ? saneSiteHealth(sh) : null,
        poweredBy: poweredByFrom(probe),
        htaccess: root ? readCapped(path.join(root, '.htaccess'), vd.CAPS.htaccess) : null,
        versionPhp: root ? readCapped(path.join(root, 'wp-includes', 'version.php'), vd.CAPS.versionPhp) : null,
        dumpHead: dumpFile ? readCapped(dumpFile, vd.CAPS.dumpHead) : null,
        dumpScan: dumpFile ? readCapped(dumpFile, vd.CAPS.dumpScan) : null
    };
    return inputs;
}

// work/site-health.json is our own file, but it is read back as data: every value is checked again and the source is fixed
const VER = /^\d{1,2}\.\d{1,2}(?:\.\d{1,3})?$/;
function saneSiteHealth(sh) {
    const v = x => (x && typeof x.value === 'string' && VER.test(x.value) ? x.value : null);
    const php = v(sh.php), wp = v(sh.wp), dbv = v(sh.db), fam = sh.db && ['MySQL', 'MariaDB'].includes(sh.db.family) ? sh.db.family : null;
    return {
        php: php ? { value: php, source: vd.SOURCES.SITE_HEALTH } : { value: null, source: vd.SOURCES.UNKNOWN },
        wp: wp ? { value: wp, source: vd.SOURCES.SITE_HEALTH } : { value: null, source: vd.SOURCES.UNKNOWN },
        db: fam && dbv ? { family: fam, value: dbv, source: vd.SOURCES.SITE_HEALTH } : { family: null, value: null, source: vd.SOURCES.UNKNOWN },
        active_plugins: Array.isArray(sh.active_plugins) ? sh.active_plugins.slice(0, vd.CAPS.plugins).filter(p => p && typeof p.name === 'string').map(p => ({ name: vd.clean(p.name, vd.CAPS.pluginName), version: typeof p.version === 'string' && /^[0-9][0-9A-Za-z.+-]{0,30}$/.test(p.version) ? p.version : null })) : []
    };
}
const refOf = e => (e ? `${e.repo}:${e.tag}` : null);
const nearestMinor = (want, list) => {
    const [wM, wm] = want.split('.').map(Number);
    const same = list.filter(v => Number(v.split('.')[0]) === wM);
    if (!same.length) return null;
    // the closest minor; on a tie the newer one (a newer PHP keeps more old code running than an older PHP runs new code)
    return same.slice().sort((a, b) => Math.abs(Number(a.split('.')[1]) - wm) - Math.abs(Number(b.split('.')[1]) - wm) || vd.cmpVersion(b, a))[0];
};
// the collation is only a hint, and the text says so; every other source is shown as it is named
const srcLabel = source => (source === vd.SOURCES.COLLATION ? `a hint, ${source}` : source);
const shown = d => (d && d.value ? `${d.family ? `${d.family} ` : ''}${d.value} (${d.source})` : null);

// det: version-detect.detect(); pins: the pin file (policy.images()); present(entry) -> true when the pinned image is present locally
function select(det, pins, { present = () => true } = {}) {
    const M = policy.matrix(pins);
    const ok = e => policy.usable(e) && present(e);
    const notes = [];
    // ---------------- PHP
    // an entry counts for PHP x.y only when BOTH of its images record x.y themselves (policy.phpOf): never because of a key or matrix.default_php
    const defEntry = M.default_entry, defPhp = M.default_php, defName = defPhp ? `PHP ${defPhp}` : 'the PHP of the default image';
    const own = (k, e) => e && policy.phpOf(e.wordpress) === k && policy.phpOf(e.cli) === k;
    const usablePhp = Object.keys(M.php).filter(k => own(k, M.php[k]) && ok(M.php[k].wordpress) && ok(M.php[k].cli)).sort(vd.cmpVersion);
    const req = det.php && det.php.value ? det.php : null;
    const wantMinor = req ? vd.minorOf(req.value) : null;
    const todos = [];
    let php;
    // the exact next step for a PHP version: an entry without a tag needs one named in WANT_PHP first (no --repin can pin a tag that is not chosen)
    const cmdPhp = minor => {
        const e = M.php[minor];
        if (!e || !e.wordpress || !e.cli) { todos.push(`PHP ${minor}: there is no image for it in the list yet: add a tag that exists on Docker Hub to WANT_PHP in scripts/setup-sandbox.js first, then run ${SETUP} --repin and ${SETUP} --php ${minor}`); return null; }
        if (!e.wordpress.tag || !e.cli.tag) { todos.push(`PHP ${minor}: no image tag is chosen yet: name a tag that exists on Docker Hub in WANT_PHP in scripts/setup-sandbox.js first, then run ${SETUP} --repin and ${SETUP} --php ${minor}`); return null; }
        return policy.usable(e.wordpress) && policy.usable(e.cli) ? `${SETUP} --php ${minor}` : `${SETUP} --repin && ${SETUP} --php ${minor}`;
    };
    if (!req || !wantMinor) {
        php = { requested: null, source: vd.SOURCES.ASSUMED, used: defPhp, status: 'assumed', text: `${defName} assumed (the default image; nothing stated the PHP version of your site)` };
    } else if (usablePhp.includes(wantMinor)) {
        php = { requested: req.value, source: req.source, used: wantMinor, status: 'matched', text: `PHP ${req.value} (${req.source}): PHP ${wantMinor} used (matched)` };
    } else {
        const near = nearestMinor(wantMinor, usablePhp);
        const cmd = cmdPhp(wantMinor);
        const e = M.php[wantMinor];
        const why = !e || !own(wantMinor, e) ? `there is no PHP ${wantMinor} image in the list` : !e.wordpress.tag || !e.cli.tag ? `no PHP ${wantMinor} image tag is chosen yet` : !(policy.usable(e.wordpress) && policy.usable(e.cli)) ? `the PHP ${wantMinor} image is not pinned yet` : `the PHP ${wantMinor} image is not on this computer`;
        if (near) php = { requested: req.value, source: req.source, used: near, status: 'nearest', text: `PHP ${req.value} (${req.source}): PHP ${wantMinor} requested, ${near} used (nearest available; ${why})`, ...(cmd ? { command: cmd } : {}) };
        else php = { requested: req.value, source: req.source, used: defPhp, status: 'not matched', text: `PHP ${req.value} (${req.source}): ${defName} used (not matched; ${why})`, ...(cmd ? { command: cmd } : {}) };
    }
    const phpEntry = php.used && usablePhp.includes(php.used) ? M.php[php.used] : defEntry;
    // belt and braces: "matched" / "nearest" only ever with the entry that records that version
    if ((php.status === 'matched' || php.status === 'nearest') && (phpEntry === defEntry ? policy.phpOf(defEntry.wordpress) !== php.used : !own(php.used, phpEntry))) php = { ...php, used: defPhp, status: 'not matched' };
    // ---------------- database
    const dbDef = M.db.mariadb;
    const d = det.db || { family: null, value: null, source: vd.SOURCES.UNKNOWN };
    let db, dbEntry = dbDef;
    const defLabel = `MariaDB ${dbDef.version || dbDef.tag}`;
    if (!d.family) db = { requested: null, family: null, source: d.source === vd.SOURCES.UNKNOWN ? vd.SOURCES.ASSUMED : d.source, used: defLabel, status: 'assumed', text: `${defLabel} assumed (the default image; the database version of your site is not known)` };
    else {
        const key = d.family === 'MySQL' ? 'mysql' : 'mariadb', e = M.db[key];
        const want = `${d.family}${d.value ? ` ${d.value}` : ''}`;
        const src = srcLabel(d.source);
        if (e && ok(e)) {
            dbEntry = e;
            // a major version alone (the collation hint says only "MySQL 8") is never "matched": 8 could be 8.0 or 8.4
            const same = !!(d.value && e.version && vd.minorOf(d.value) && vd.minorOf(d.value) === vd.minorOf(e.version));
            const status = same ? 'matched' : 'nearest';
            db = { requested: d.value, family: d.family, source: d.source, used: `${e.family} ${e.version || e.tag}`, status, text: `${want} (${src}): ${e.family} ${e.version || e.tag} used (${status === 'nearest' ? 'nearest available, same family' : 'matched'})` };
        } else {
            let cmd = e ? (policy.usable(e) ? `${SETUP} --db ${key}` : `${SETUP} --repin && ${SETUP} --db ${key}`) : null;
            if (e && !e.tag) { cmd = null; todos.push(`${d.family}: no image tag is chosen yet: name a tag that exists on Docker Hub in WANT_DB in scripts/setup-sandbox.js first, then run ${SETUP} --repin and ${SETUP} --db ${key}`); }
            const why = !e ? `there is no ${d.family} image in the list` : !policy.usable(e) ? `the ${d.family} image is not pinned yet` : `the ${d.family} image is not on this computer`;
            db = { requested: d.value, family: d.family, source: d.source, used: defLabel, status: 'not matched', text: `${want} (${src}): ${defLabel} used (not matched; ${why}${key === 'mysql' ? '; a MySQL export can fail to import into MariaDB' : ''})`, ...(cmd ? { command: cmd } : {}) };
        }
    }
    // ---------------- WordPress (always the image's core)
    const imgWp = (phpEntry.wordpress && phpEntry.wordpress.wp_version) || null;
    const w = det.wp && det.wp.value ? det.wp : null;
    let wp;
    if (!w) wp = { site: null, source: vd.SOURCES.UNKNOWN, image: imgWp, status: 'unknown', text: `WordPress version of your site unknown (wp-includes/version.php is not in the copy); WordPress ${imgWp || 'of the image'} used` };
    else {
        const status = imgWp && vd.cmpVersion(w.value, imgWp) === 0 ? 'matched' : imgWp && vd.minorOf(w.value) === vd.minorOf(imgWp) ? 'nearest' : 'not matched';
        wp = { site: w.value, source: w.source, image: imgWp, status, text: `WordPress ${w.value} (${w.source}): WordPress ${imgWp || 'of the image'} used (${status === 'nearest' ? 'nearest: same major version, the core files come from the image' : status === 'matched' ? 'matched; the core files come from the image' : 'not matched; the core files come from the image'})` };
    }
    const images = { wordpress: phpEntry.wordpress, cli: phpEntry.cli, db: { ...dbEntry } };
    for (const k of ['wordpress', 'cli', 'db']) if (!policy.usable(images[k])) notes.push(`${k} image ${refOf(images[k])} is not pinned`);
    // one command line for everything that is missing: --repin first when an entry is not pinned yet, then ONE pull with every flag
    const parts = [php.command, db.command].filter(Boolean);
    const flags = parts.map(c => c.split(`${SETUP} `).pop());
    const commands = parts.length ? [`${parts.some(c => c.includes('--repin')) ? `${SETUP} --repin && ` : ''}${SETUP} ${flags.join(' ')}`] : [];
    return {
        schema: 1, php, db, wordpress: wp, statuses: STATUSES,
        images: { wordpress: refOf(images.wordpress), cli: refOf(images.cli), db: refOf(images.db), db_family: images.db.family || 'MariaDB' },
        refs: images, commands, todos, notes,
        active_plugins: det.active_plugins ? det.active_plugins.slice(0, vd.CAPS.plugins) : null
    };
}

// the lines of the 'Versions' block (For a developer) and of the build step
function lines(res) {
    if (!res) return [];
    return [res.php.text, res.db.text, res.wordpress.text, ...(res.todos || []), ...(res.commands.length ? [`To test with the same versions, get the images once (the owner pulls; nothing is pulled during a run): ${res.commands.join('  ;  ')}`] : [])];
}
// the pins object buildSpec() takes: the chosen images in the "images" shape (db carries its family)
function pinsFor(res, pins) {
    return { ...pins, images: { wordpress: res.refs.wordpress, cli: res.refs.cli, db: { ...res.refs.db, family: res.images.db_family } } };
}

module.exports = { srcLabel, saneSiteHealth, STATUSES, SETUP, readCapped, readSiteHealthFile, saveSiteHealth, SiteHealthRefused, poweredByFrom, gather, select, lines, pinsFor, nearestMinor };
