// The one file OCR needs from the internet: eng.traineddata. It is fetched ONLY by `npm run guard:setup-ocr`, stored in data/ocr/,
// and checked against the SHA-256 pinned in data/ocr-pin.json (and listed in THIRD-PARTY.md) every time it is loaded.
// tesseract.js loads its worker and core (WASM) from node_modules, never from a network.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = process.env.PLUGIN_GUARD_OCR_DIR || path.join(__dirname, '..', 'data', 'ocr'); // the override exists for tests only
const PIN_FILE = path.join(__dirname, '..', 'data', 'ocr-pin.json');
const file = (lang = 'eng') => path.join(DIR, `${lang}.traineddata`);
const sha256File = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const pin = () => JSON.parse(fs.readFileSync(PIN_FILE, 'utf8'));
const fail = msg => Object.assign(new Error(msg), { exitCode: 2 });

const cache = new Map(); // verified once per process per file+mtime+size: still re-read and re-hashed if the file changes
// -> the folder to pass as langPath. Throws (exit 2) when the file is missing or does not match the pinned hash.
function verified(lang = 'eng') {
    const f = file(lang);
    if (!fs.existsSync(f)) throw fail(`OCR language data is not installed (${f}).\nRun once from the repository root:  npm run guard:setup-ocr\n(it downloads one ~4 MB file and checks its SHA-256)`);
    const st = fs.statSync(f), key = `${f}|${st.mtimeMs}|${st.size}`;
    if (!cache.has(key)) {
        const want = (pin().files[`${lang}.traineddata`] || {}).sha256, got = sha256File(f);
        if (!want) throw fail(`No pinned SHA-256 for ${lang}.traineddata in data/ocr-pin.json`);
        if (got !== want) throw fail(`${f} does not match the pinned SHA-256 (expected ${want}, found ${got}). It was changed or damaged: delete it and run  npm run guard:setup-ocr`);
        cache.clear(); cache.set(key, true);
    }
    return DIR;
}
function status(lang = 'eng') { try { verified(lang); return { ok: true, file: file(lang) }; } catch (e) { return { ok: false, reason: e.message.split('\n')[0] }; } }

module.exports = { DIR, PIN_FILE, file, sha256File, pin, verified, status };
