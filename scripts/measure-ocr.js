#!/usr/bin/env node
// Clue recall of the OCR step, per variant and for the union of all variants.
//   node scripts/measure-ocr.js [--dir <folder>] [--lang-path <folder> --gzip]
// Each <image>.png/.jpg in the folder needs a <image>.expected.json:
//   { "expect": [ { "type": "php-fatal", "contains": "undefined function" }, ... ] }
// An expectation is met when some clue has that type and (if given) its value contains the text, case-insensitively.
// Recall = met / expected. Nothing is downloaded. --lang-path compares another language-data folder (measurement only).

const fs = require('fs');
const path = require('path');
const ocr = require('../issue/ocr');
const clues = require('../issue/clues');

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? d : process.argv[i + 1]; };
const dir = path.resolve(arg('dir', path.join(__dirname, 'fixtures', 'real-screens')));
const langPath = arg('lang-path', null), gzip = process.argv.includes('--gzip');
const asJson = process.argv.includes('--json');

(async () => {
    if (!fs.existsSync(dir)) { console.error(`No folder ${dir}`); process.exit(2); }
    const images = fs.readdirSync(dir).filter(n => /\.(png|jpe?g)$/i.test(n)).sort();
    const rows = [], tot = {};
    let expectedTotal = 0;
    for (const n of images) {
        const ef = path.join(dir, n.replace(/\.[^.]+$/, '') + '.expected.json');
        if (!fs.existsSync(ef)) { console.error(`skip ${n}: no ${path.basename(ef)}`); continue; }
        const expect = JSON.parse(fs.readFileSync(ef, 'utf8')).expect;
        const [r] = await ocr.recognize([path.join(dir, n)], langPath ? { langPath, gzip, skipVerify: true } : {});
        const hit = text => expect.map(e => clues.extract(text, { kind: 'ocr', ref: n }).some(c => c.type === e.type && (!e.contains || c.value.toLowerCase().includes(e.contains.toLowerCase()))));
        const per = {}, any = expect.map(() => false);
        for (const v of r.variants) { const h = hit(v.text); per[v.variant] = h.filter(Boolean).length; h.forEach((x, i) => { any[i] = any[i] || x; }); }
        per.union = any.filter(Boolean).length;
        for (const [k, v] of Object.entries(per)) tot[k] = (tot[k] || 0) + v;
        expectedTotal += expect.length;
        rows.push({ image: n, expected: expect.length, ...per, missed: expect.filter((e, i) => !any[i]).map(e => `${e.type}:${e.contains || ''}`) });
    }
    if (asJson) { console.log(JSON.stringify({ expected: expectedTotal, found: tot, rows }, null, 1)); return; }
    const names = [...new Set(rows.flatMap(r => Object.keys(r).filter(k => !['image', 'expected', 'missed'].includes(k))))];
    console.log(`Folder: ${dir}${langPath ? `\nLanguage data: ${langPath}` : ''}\n`);
    console.log(['image'.padEnd(24), 'exp', ...names.map(n => n.padStart(11))].join(' '));
    for (const r of rows) console.log([r.image.padEnd(24), String(r.expected).padStart(3), ...names.map(n => (r[n] === undefined ? '-' : `${r[n]}/${r.expected}`).padStart(11))].join(' ') + (r.missed.length ? `   missed by all: ${r.missed.join(', ')}` : ''));
    console.log(['TOTAL recall'.padEnd(24), String(expectedTotal).padStart(3), ...names.map(n => (tot[n] === undefined ? '-' : `${Math.round(100 * tot[n] / expectedTotal)}%`).padStart(11))].join(' '));
})().catch(e => { console.error(e.message); process.exit(1); });
