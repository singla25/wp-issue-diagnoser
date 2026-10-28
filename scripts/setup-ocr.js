#!/usr/bin/env node
// `npm run guard:setup-ocr`: the explicit, one-time download of the OCR language data. Nothing else in Plugin Guard downloads anything.
//   source   tesseract-ocr/tessdata_fast, tag 4.1.0 (Apache-2.0), pinned URL, https only
//   checks   size limit and SHA-256 against data/ocr-pin.json (the pin itself is trust-on-first-download: nothing independent confirms it)
//   --pin    first-time use only: write the hash of what was downloaded into data/ocr-pin.json (trust on first download)

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const ocr = require('../lib/ocr-data');

const URL_ = 'https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/4.1.0/eng.traineddata';
const MAX = 30 * 1024 * 1024;

function get(url, hops = 0) {
    return new Promise((resolve, reject) => {
        if (hops > 3) return reject(new Error('too many redirects'));
        const u = new URL(url);
        if (u.protocol !== 'https:' || !/(^|\.)githubusercontent\.com$|(^|\.)github\.com$/.test(u.hostname)) return reject(new Error(`refusing to download from ${u.protocol}//${u.hostname}`));
        https.get(u, { headers: { 'user-agent': 'plugin-guard-setup-ocr' }, timeout: 60000 }, res => {
            if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) { res.resume(); return resolve(get(new URL(res.headers.location, u).href, hops + 1)); }
            if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} from ${u.hostname}`)); }
            const chunks = []; let n = 0;
            res.on('data', c => { n += c.length; if (n > MAX) { res.destroy(new Error('file is larger than the 30 MB limit')); } else chunks.push(c); });
            res.on('end', () => resolve({ body: Buffer.concat(chunks), etag: String(res.headers.etag || '').replace(/^W\/|"/g, '') }));
            res.on('error', reject);
        }).on('error', reject).on('timeout', function () { this.destroy(new Error('timed out')); });
    });
}

(async () => {
    const wantPin = process.argv.includes('--pin');
    console.log(`Downloading ${URL_}\n(this is the only download Plugin Guard makes; run it once)`);
    const { body, etag } = await get(URL_);
    const sum = crypto.createHash('sha256').update(body).digest('hex');
    const pinned = fs.existsSync(ocr.PIN_FILE) ? (ocr.pin().files['eng.traineddata'] || {}).sha256 : null;
    console.log(`  size ${body.length} bytes\n  sha256 ${sum}`);
    if (pinned && pinned !== sum) { console.error(`\nREFUSED: the download does not match the pinned SHA-256 ${pinned}. Nothing was saved.`); process.exit(2); }
    if (!pinned && !wantPin) { console.error('\nREFUSED: no pinned SHA-256 yet (data/ocr-pin.json). Re-run with --pin to trust this download and record its hash.'); process.exit(2); }
    if (!pinned) fs.writeFileSync(ocr.PIN_FILE, JSON.stringify({ note: 'SHA-256 of the OCR language data, checked on every load. Also listed in THIRD-PARTY.md.', files: { 'eng.traineddata': { sha256: sum, bytes: body.length, source: URL_, licence: 'Apache-2.0', pinned_from_first_download: true } } }, null, 2) + '\n');
    fs.mkdirSync(ocr.DIR, { recursive: true });
    const tmp = ocr.file() + '.part';
    fs.writeFileSync(tmp, body); fs.renameSync(tmp, ocr.file());
    ocr.verified();
    console.log(`\nSaved ${ocr.file()} and verified it against the pinned hash.`);
})().catch(e => { console.error(`\nguard:setup-ocr failed: ${e.message}\nNothing was saved. If you are offline, copy eng.traineddata (tessdata_fast 4.1.0) to ${ocr.DIR} yourself; its SHA-256 is checked on every load.`); process.exit(2); });
