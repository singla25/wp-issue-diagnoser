#!/usr/bin/env node
// `npm run guard:setup-sandbox`: the explicit, one-time preparation of the issue-mode sandbox images. Nothing else pulls anything.
//   (default)            pull the three default pinned images BY DIGEST and check that Docker reports the same digest   (needs the Docker daemon)
//   --php 8.2 [--php 7.4] / --php 8.2,7.4    pull only the WordPress + WP-CLI images for those PHP versions (pinned entries of the matrix)
//   --db mysql [--db mariadb]               pull only the database image(s) named; --php and --db combine
//   --check              list every image (defaults and matrix): present or missing, and its size; nothing is pulled          (needs the Docker daemon)
//   --repin              resolve the tags below to content digests from the registry and write data/sandbox-images.json   (network only, no daemon)
// Images are always referenced as  repo@sha256:...  : a tag can be re-pointed, a digest cannot. All are official Docker Hub images: wordpress
// (Apache, one per PHP version), wordpress:cli (WP-CLI) and mariadb / mysql. An entry that is not pinned (no digest yet) is never pulled or used.
// TEST-COPY-SPEC Part 6b: the PHP and database matrix. Tags whose existence was not confirmed when this list was written carry tag_verified false;
// --repin confirms them (a tag the registry does not know stays unpinned, with the reason) and never invents one.

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawnSync } = require('child_process');

const PIN_FILE = path.join(__dirname, '..', 'data', 'sandbox-images.json');
const WANT = {
    wordpress: { repo: 'library/wordpress', tag: '7.1.3-php8.3-apache', wp_version: '7.1.3', php: '8.3' },
    cli: { repo: 'library/wordpress', tag: 'cli-2.12.0-php8.3', php: '8.3' },
    db: { repo: 'library/mariadb', tag: '11.8.9' }
};
// tag null: no tag that is known to exist was chosen (the official image may no longer publish that PHP version for current WordPress); the owner
// names one that exists on Docker Hub here, then runs --repin. Until then the entry is listed as unpinned and never used.
const WANT_PHP = {
    '7.4': { wordpress: { tag: null, wp_version: null }, cli: { tag: null } },
    '8.0': { wordpress: { tag: null, wp_version: null }, cli: { tag: null } },
    '8.1': { wordpress: { tag: '7.1.3-php8.1-apache', wp_version: '7.1.3' }, cli: { tag: 'cli-2.12.0-php8.1' } },
    '8.2': { wordpress: { tag: '7.1.3-php8.2-apache', wp_version: '7.1.3' }, cli: { tag: 'cli-2.12.0-php8.2' } },
    '8.3': { wordpress: { tag: '7.1.3-php8.3-apache', wp_version: '7.1.3' }, cli: { tag: 'cli-2.12.0-php8.3' } },
    '8.4': { wordpress: { tag: '7.1.3-php8.4-apache', wp_version: '7.1.3' }, cli: { tag: 'cli-2.12.0-php8.4' } }
};
const WANT_DB = { mariadb: { repo: 'library/mariadb', tag: '11.8.9', family: 'MariaDB', version: '11.8.9' }, mysql: { repo: 'library/mysql', tag: '8.0.46', family: 'MySQL', version: '8.0.46' } };
const ACCEPT = ['application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json', 'application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json'].join(', ');
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const ABOUT = 'Official Docker Hub images used by the issue-mode sandbox, pinned by content digest. Written by `npm run guard:setup-sandbox -- --repin` (registry lookup, no Docker daemon needed). A digest names exactly one image; tags can move. Update by running --repin and re-running the tests.';
const MATRIX_ABOUT = 'Images per PHP minor version and per database family (TEST-COPY-SPEC Part 6b). An entry is used only when it is pinned by digest (status "pinned") AND present locally; "unpinned" entries (no digest yet, tag not yet confirmed on Docker Hub: tag_verified false) are never started. The owner runs  npm run guard:setup-sandbox -- --repin  (registry lookup) and then pulls what is needed, e.g.  npm run guard:setup-sandbox -- --php 8.2 --db mysql . The "images" block above stays the default set (PHP 8.3, MariaDB).';

// ---------------------------------------------------------------- arguments (pure)
class UsageError extends Error { constructor(m) { super(m); this.name = 'UsageError'; } }
function parseArgs(argv) {
    const o = { check: false, repin: false, php: [], db: [] };
    const list = v => String(v).split(',').map(s => s.trim()).filter(Boolean);
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i], m = /^--(php|db)(?:=(.*))?$/.exec(a);
        if (a === '--check') o.check = true;
        else if (a === '--repin') o.repin = true;
        else if (m) {
            const v = m[2] !== undefined ? m[2] : argv[++i];
            if (v === undefined || v.startsWith('--')) throw new UsageError(`--${m[1]} needs a value (e.g. --php 8.2, --db mysql)`);
            for (const x of list(v)) {
                if (m[1] === 'php' && !/^\d{1,2}\.\d{1,2}$/.test(x)) throw new UsageError(`--php ${x}: give a PHP minor version such as 8.2`);
                if (m[1] === 'db' && !WANT_DB[x.toLowerCase()]) throw new UsageError(`--db ${x}: one of ${Object.keys(WANT_DB).join(', ')}`);
                const val = m[1] === 'db' ? x.toLowerCase() : x;
                if (!o[m[1]].includes(val)) o[m[1]].push(val);
            }
        } else throw new UsageError(`unknown option "${a}" (use --check, --repin, --php <x.y>, --db <mariadb|mysql>)`);
    }
    if (o.repin && (o.check || o.php.length || o.db.length)) throw new UsageError('--repin runs on its own');
    if (o.check && (o.php.length || o.db.length)) throw new UsageError('--check lists every image; it takes no --php or --db');
    return o;
}

// every image of the pin file, in a fixed order: the three defaults, then the PHP matrix (by version), then the databases
function entries(pins) {
    const out = [];
    for (const k of ['wordpress', 'cli', 'db']) if (pins.images && pins.images[k]) out.push({ key: `default ${k}`, group: 'default', kind: k, entry: { status: 'pinned', tag_verified: true, ...pins.images[k] } });   // the defaults are validated by images()
    const m = pins.matrix || {};
    const cmp = (a, b) => { const [a1, a2] = a.split('.').map(Number), [b1, b2] = b.split('.').map(Number); return a1 - b1 || a2 - b2; };
    for (const v of Object.keys(m.php || {}).filter(x => /^\d{1,2}\.\d{1,2}$/.test(x)).sort(cmp)) for (const k of ['wordpress', 'cli']) if (m.php[v][k]) out.push({ key: `php ${v} ${k}`, group: 'php', version: v, kind: k, entry: m.php[v][k] });
    for (const d of Object.keys(m.db || {}).sort()) out.push({ key: `db ${d}`, group: 'db', name: d, kind: 'db', entry: m.db[d] });
    return out;
}
// pinned AND the tag confirmed by the registry (tag_verified exactly true; a missing field counts as not verified), as issue/sandbox-policy.js usable()
const pinned = e => !!(e && e.status === 'pinned' && e.tag_verified === true && DIGEST.test(String(e.digest || '')) && typeof e.ref === 'string' && e.ref.endsWith(`@${e.digest}`));
const label = e => `${e.repo || '?'}:${e.tag || '(no tag chosen)'}`;
const mb = bytes => `${(Number(bytes) / 1048576).toFixed(1)} MB`;

// which entries a pull touches. -> { pull: [...entries], refused: [{ key, reason, command }] }
function plan(pins, o) {
    const all = entries(pins);
    if (!o.php.length && !o.db.length) return { pull: all.filter(x => x.group === 'default'), refused: [] };
    const pull = [], refused = [];
    const take = (list, what, flag) => {
        if (!list.length) { refused.push({ key: what, reason: `${what} is not in data/sandbox-images.json`, command: null }); return; }
        for (const x of list) {
            if (pinned(x.entry)) pull.push(x);
            else refused.push({ key: x.key, reason: `${label(x.entry)} is not pinned yet${x.entry.tag ? '' : ' (no tag chosen)'}`, command: 'npm run guard:setup-sandbox -- --repin' + (flag ? ` && npm run guard:setup-sandbox -- ${flag}` : '') });
        }
    };
    for (const v of o.php) take(all.filter(x => x.group === 'php' && x.version === v), `PHP ${v}`, `--php ${v}`);
    for (const d of o.db) take(all.filter(x => x.group === 'db' && x.name === d), `database ${d}`, `--db ${d}`);
    const seen = new Set();
    return { pull: pull.filter(x => !seen.has(x.entry.ref) && seen.add(x.entry.ref)), refused };
}

// one inspect per image: present (with the pinned digest) and its size. run(args) -> spawnSync-like result
function inspect(run, entry) {
    if (!pinned(entry)) return { present: false, size: null, unpinned: true };
    const r = run(['image', 'inspect', '--format', '{{json .RepoDigests}}\t{{.Size}}', entry.ref]);
    if (!r || r.status !== 0) return { present: false, size: null };
    const [dig, size] = String(r.stdout || '').trim().split('\t');
    let present = false; try { present = JSON.parse(dig).some(d => d.endsWith(`@${entry.digest}`)); } catch { /* not JSON */ }
    return { present, size: present && /^\d+$/.test(size || '') ? Number(size) : null };
}
// --check: one line per image. -> { lines, missingDefaults }
function check(run, pins) {
    const lines = []; let missingDefaults = 0;
    for (const x of entries(pins)) {
        const r = inspect(run, x.entry);
        const state = r.unpinned ? `unpinned (${x.entry.tag ? 'tag not yet confirmed' : 'no tag chosen'}; run --repin)` : r.present ? `present  ${mb(r.size || 0)}` : 'missing';
        lines.push(`${x.key.padEnd(18)} ${state.padEnd(44)} ${label(x.entry)}`);
        if (x.group === 'default' && !r.present) missingDefaults++;
    }
    return { lines, missingDefaults };
}

// ---------------------------------------------------------------- --repin (network: Docker Hub only)
const get = (url, headers = {}, method = 'GET') => new Promise((resolve, reject) => {
    const u = new URL(url);
    if (u.protocol !== 'https:' || !/(^|\.)docker\.io$/.test(u.hostname)) return reject(new Error(`refusing ${u.hostname}`));
    https.request(u, { method, headers, timeout: 30000 }, res => { let b = ''; res.on('data', c => { b += c; if (b.length > 2e6) res.destroy(); }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b })); }).on('error', reject).on('timeout', function () { this.destroy(new Error('timed out')); }).end();
});
async function resolveDigest(repo, tag) {
    const tok = JSON.parse((await get(`https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repo}:pull`)).body).token;
    const r = await get(`https://registry-1.docker.io/v2/${repo}/manifests/${tag}`, { Authorization: `Bearer ${tok}`, Accept: ACCEPT }, 'HEAD');
    const digest = r.headers['docker-content-digest'];
    return { status: r.status, digest: r.status === 200 && DIGEST.test(digest || '') ? digest : null, media_type: r.headers['content-type'] || null };
}
async function repin(resolve = resolveDigest, write = true) {
    const pins = { _about: ABOUT, schema: 1, resolved_at: new Date().toISOString().slice(0, 10), registry: 'registry-1.docker.io', images: {} };
    for (const [key, w] of Object.entries(WANT)) {   // the defaults: any failure stops (as before)
        const r = await resolve(w.repo, w.tag);
        if (!r.digest) throw new Error(`${w.repo}:${w.tag}: registry answered HTTP ${r.status} without a digest`);
        const name = w.repo.replace('library/', '');
        pins.images[key] = { repo: name, tag: w.tag, digest: r.digest, ref: `${name}@${r.digest}`, ...(w.wp_version ? { wp_version: w.wp_version } : {}), ...(w.php ? { php: w.php } : {}), media_type: r.media_type };
        console.log(`${key.padEnd(10)} ${name}:${w.tag} -> ${r.digest}`);
    }
    // the matrix: a tag the registry does not know stays unpinned with the reason; nothing is guessed
    const one = async (repo, tag, extra) => {
        const name = repo.replace('library/', '');
        if (!tag) return { repo: name, tag: null, digest: null, ref: null, media_type: null, ...extra, status: 'unpinned', tag_verified: false, note: 'no tag chosen: name a tag that exists on Docker Hub in scripts/setup-sandbox.js, then run --repin' };
        let r; try { r = await resolve(repo, tag); } catch (e) { r = { status: 0, digest: null, error: e.message }; }
        if (!r.digest) { console.log(`  ${name}:${tag}: not pinned (HTTP ${r.status}${r.error ? `, ${r.error}` : ''})`); return { repo: name, tag, digest: null, ref: null, media_type: null, ...extra, status: 'unpinned', tag_verified: false, note: r.status === 404 ? 'the registry does not know this tag' : `the registry answered HTTP ${r.status}` }; }
        console.log(`  ${name}:${tag} -> ${r.digest}`);
        return { repo: name, tag, digest: r.digest, ref: `${name}@${r.digest}`, media_type: r.media_type, ...extra, status: 'pinned', tag_verified: true };
    };
    const php = {};
    for (const [v, w] of Object.entries(WANT_PHP)) php[v] = { wordpress: await one('library/wordpress', w.wordpress.tag, { wp_version: w.wordpress.wp_version, php: v }), cli: await one('library/wordpress', w.cli.tag, { php: v }) };
    const db = {};
    for (const [k, w] of Object.entries(WANT_DB)) db[k] = await one(w.repo, w.tag, { family: w.family, version: w.version });
    pins.matrix = { _about: MATRIX_ABOUT, default_php: WANT.wordpress.php, default_db: 'mariadb', php, db };
    if (write) { fs.writeFileSync(PIN_FILE, JSON.stringify(pins, null, 2) + '\n'); console.log(`\nWrote ${PIN_FILE}`); }
    return pins;
}

// ---------------------------------------------------------------- daemon commands
function dockerRun(args) { return spawnSync('docker', args, { encoding: 'utf8', timeout: 15 * 60 * 1000 }); }
function needDaemon(run) {
    const r = run(['info', '--format', '{{.ServerVersion}}']);
    if (r.error) return 'Docker is not installed (no `docker` command).';
    if (r.status !== 0) {
        const denied = /permission denied/i.test(r.stderr);
        return `Docker is installed but its daemon cannot be used by this user${denied ? ' (permission denied on the Docker socket)' : ''}: ${String(r.stderr).trim().split('\n')[0]}\n${denied ? 'Either add this user to the "docker" group (that gives the user root-equivalent access to this machine, so it is your decision) or use rootless Docker. Plugin Guard changes nothing on its own.' : ''}`;
    }
    return null;
}
// -> exit code. run(args): the docker runner; out / err: line writers
function main(argv, { run = dockerRun, out = s => console.log(s), err = s => console.error(s), pinFile = PIN_FILE } = {}) {
    let o; try { o = parseArgs(argv); } catch (e) { err(`guard:setup-sandbox: ${e.message}`); return 2; }
    if (!fs.existsSync(pinFile)) { err('data/sandbox-images.json is missing. Run:  npm run guard:setup-sandbox -- --repin'); return 2; }
    const pins = JSON.parse(fs.readFileSync(pinFile, 'utf8'));
    const nd = needDaemon(run); if (nd) { err(nd); return 2; }
    if (o.check) { const c = check(run, pins); for (const l of c.lines) out(l); return c.missingDefaults ? 2 : 0; }
    const p = plan(pins, o);
    let bad = 0;
    for (const r of p.refused) { err(`not pulled: ${r.key}: ${r.reason}${r.command ? `. Run:  ${r.command}` : ''}`); bad++; }
    for (const x of p.pull) {
        out(`pulling ${x.entry.ref} (${label(x.entry)}) ...`);
        const pr = run(['pull', x.entry.ref]);
        if (!pr || pr.status !== 0) { err(`  FAILED: ${String((pr && pr.stderr) || '').trim().split('\n').pop()}`); bad++; continue; }
        const i = inspect(run, x.entry);
        out(`${x.key.padEnd(18)} ${i.present ? `present, digest verified  ${mb(i.size || 0)}` : 'NOT present'}  ${x.entry.ref}`);
        if (!i.present) bad++;
    }
    return bad ? 2 : 0;
}

module.exports = { WANT, WANT_PHP, WANT_DB, parseArgs, entries, plan, check, inspect, pinned, main, repin, UsageError, mb };

if (require.main === module) {
    (async () => {
        if (process.argv.includes('--repin')) { try { parseArgs(process.argv.slice(2)); } catch (e) { console.error(`guard:setup-sandbox: ${e.message}`); process.exit(2); } await repin(); return; }
        process.exit(main(process.argv.slice(2)));
    })().catch(e => { console.error(`guard:setup-sandbox failed: ${e.message}`); process.exit(2); });
}
