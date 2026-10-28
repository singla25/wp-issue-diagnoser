// OCR of screenshots with tesseract.js, fully local: the worker and the WASM core load from node_modules, the language data from
// data/ocr/ after its SHA-256 has been checked against the pin. Nothing is fetched at run time (langPath is always set, so the
// library's CDN fallback can never trigger). Tesseract is not a language model; same image in, same text out.

const path = require('path');
const fs = require('fs');
const redact = require('../lib/redact');
const ocrData = require('../lib/ocr-data');
const variants = require('./imgvariants');
const { sniff } = require('../lib/issue-store');

const MAX_TEXT = 20000;
const clean = s => redact.text(String(s).replace(/\0/g, '').replace(/[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')).slice(0, MAX_TEXT);

// files: absolute paths of PNG/JPG/WEBP files.
// -> [{ file, text, confidence, variants: [{ variant, text, confidence }], notes, dark }]; `text` is the original's text (kept for callers
// that want one string). Each image is read with several deterministic variants (see imgvariants.js); the caller unions the clues.
// opts.langPath / opts.gzip / opts.skipVerify exist for scripts/measure-ocr.js (comparing language-data files) and are not used by the pipeline.
async function recognize(files, { lang = 'eng', variants: useVariants = true, langPath = null, gzip = false, skipVerify = false } = {}) {
    const dir = skipVerify && langPath ? langPath : ocrData.verified(lang); // throws (exit 2) when missing or the hash does not match, BEFORE any worker starts
    if (!files.length) return [];
    const { createWorker } = require('tesseract.js');
    const worker = await createWorker(lang, 1, { langPath: dir, gzip, cacheMethod: 'none', logger: () => {} });
    const out = [];
    try {
        for (const file of files) {
            const bytes = fs.readFileSync(file);
            const set = useVariants ? variants.build(bytes, sniff(bytes)) : { list: [{ name: 'original', buf: bytes }], notes: [], dark: null };
            const vs = [];
            for (const v of set.list) {
                const r = await worker.recognize(v.buf);
                vs.push({ variant: v.name, text: clean(r.data.text || ''), confidence: Math.round(r.data.confidence || 0) });
            }
            out.push({ file, text: vs[0].text, confidence: vs[0].confidence, variants: vs, notes: set.notes, dark: set.dark });
        }
    } finally { await worker.terminate(); }
    return out;
}

module.exports = { recognize, clean, MAX_TEXT };
