#!/usr/bin/env node
// `npm run guard:setup-sandbox`: the explicit, one-time preparation of the issue-mode sandbox images. Nothing else pulls anything.
//   (default)   pull the three pinned images BY DIGEST and check that Docker reports the same digest      (needs the Docker daemon)
//   --check     list which pinned images are already present locally                                       (needs the Docker daemon)
//   --repin     resolve the tags below to content digests from the registry and write data/sandbox-images.json   (network only, no daemon)
// Images are always referenced as  repo@sha256:...  : a tag can be re-pointed, a digest cannot. The three images are the official
// Docker Hub images: wordpress (Apache, PHP 8.3), wordpress:cli (WP-CLI) and mariadb. No other image is ever started by Plugin Guard.

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
const ACCEPT = ['application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json', 'application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json'].join(', ');

const get = (url, headers = {}, method = 'GET') => new Promise((resolve, reject) => {
    const u = new URL(url);
    if (u.protocol !== 'https:' || !/(^|\.)docker\.io$/.test(u.hostname)) return reject(new Error(`refusing ${u.hostname}`));
    https.request(u, { method, headers, timeout: 30000 }, res => { let b = ''; res.on('data', c => { b += c; if (b.length > 2e6) res.destroy(); }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b })); }).on('error', reject).on('timeout', function () { this.destroy(new Error('timed out')); }).end();
});

async function repin() {
    const pins = { _about: 'Official Docker Hub images used by the issue-mode sandbox, pinned by content digest. Written by `npm run guard:setup-sandbox -- --repin` (registry lookup, no Docker daemon needed). A digest names exactly one image; tags can move. Update by running --repin and re-running the tests.', schema: 1, resolved_at: new Date().toISOString().slice(0, 10), registry: 'registry-1.docker.io', images: {} };
    for (const [key, w] of Object.entries(WANT)) {
        const tok = JSON.parse((await get(`https://auth.docker.io/token?service=registry.docker.io&scope=repository:${w.repo}:pull`)).body).token;
        const r = await get(`https://registry-1.docker.io/v2/${w.repo}/manifests/${w.tag}`, { Authorization: `Bearer ${tok}`, Accept: ACCEPT }, 'HEAD');
        const digest = r.headers['docker-content-digest'];
        if (r.status !== 200 || !/^sha256:[0-9a-f]{64}$/.test(digest || '')) throw new Error(`${w.repo}:${w.tag}: registry answered HTTP ${r.status} without a digest`);
        const name = w.repo.replace('library/', '');
        pins.images[key] = { repo: name, tag: w.tag, digest, ref: `${name}@${digest}`, ...(w.wp_version ? { wp_version: w.wp_version } : {}), ...(w.php ? { php: w.php } : {}), media_type: r.headers['content-type'] || null };
        console.log(`${key.padEnd(10)} ${name}:${w.tag} -> ${digest}`);
    }
    fs.writeFileSync(PIN_FILE, JSON.stringify(pins, null, 2) + '\n');
    console.log(`\nWrote ${PIN_FILE}`);
}

function docker(args) { return spawnSync('docker', args, { encoding: 'utf8', timeout: 15 * 60 * 1000 }); }
function needDaemon() {
    const r = docker(['info', '--format', '{{.ServerVersion}}']);
    if (r.error) { console.error('Docker is not installed (no `docker` command).'); process.exit(2); }
    if (r.status !== 0) {
        const denied = /permission denied/i.test(r.stderr);
        console.error(`Docker is installed but its daemon cannot be used by this user${denied ? ' (permission denied on the Docker socket)' : ''}: ${r.stderr.trim().split('\n')[0]}\n${denied ? 'Either add this user to the "docker" group (that gives the user root-equivalent access to this machine, so it is your decision) or use rootless Docker. Plugin Guard changes nothing on its own.' : ''}`);
        process.exit(2);
    }
}

(async () => {
    if (process.argv.includes('--repin')) return repin();
    if (!fs.existsSync(PIN_FILE)) { console.error('data/sandbox-images.json is missing. Run:  npm run guard:setup-sandbox -- --repin'); process.exit(2); }
    const pins = JSON.parse(fs.readFileSync(PIN_FILE, 'utf8'));
    needDaemon();
    const check = process.argv.includes('--check');
    let bad = 0;
    for (const [key, img] of Object.entries(pins.images)) {
        if (!check) { console.log(`pulling ${img.ref} ...`); const p = docker(['pull', img.ref]); if (p.status !== 0) { console.error(`  FAILED: ${p.stderr.trim().split('\n').pop()}`); bad++; continue; } }
        const i = docker(['image', 'inspect', '--format', '{{json .RepoDigests}}', img.ref]);
        const present = i.status === 0 && JSON.parse(i.stdout).some(d => d.endsWith(`@${img.digest}`));
        console.log(`${key.padEnd(10)} ${present ? 'present, digest verified' : 'NOT present'}  ${img.ref}`);
        if (!present) bad++;
    }
    process.exit(bad ? 2 : 0);
})().catch(e => { console.error(`guard:setup-sandbox failed: ${e.message}`); process.exit(2); });
