// Screenshot comparison (pixelmatch + pngjs): which regions of an "actual" image differ from an "expected" one.
// Pure computation on two images; no network. PNG and JPEG are decoded (WEBP has no decoder here and is reported, not guessed).
//
// Images of different size are compared on their common top-left area and the mismatch is reported: a different size usually means a
// different screen width, which is itself a finding, and a partial comparison must never read as "identical".

const { PNG } = require('pngjs');
const variants = require('./imgvariants');
const { sniff } = require('../lib/issue-store');

const CELL = 16;               // regions are found on a 16px grid
const MIN_CELL_RATIO = 0.02;   // a cell counts when at least 2% of its pixels differ
const MAX_REGIONS = 10;
const DIFF = [255, 0, 0];

function decode(buf) {
    const kind = sniff(buf);
    if (kind !== 'png' && kind !== 'jpg') return { ok: false, reason: kind ? `${kind.toUpperCase()} cannot be decoded for comparison (PNG and JPEG only)` : 'not an image' };
    try { const d = variants.decode(buf, kind); return { ok: true, w: d.w, h: d.h, data: Buffer.from(d.data.buffer, d.data.byteOffset, d.data.length), kind }; }
    catch (e) { return { ok: false, reason: `could not decode (${String(e.message).slice(0, 80)})` }; }
}
function crop(img, w, h) {
    if (img.w === w && img.h === h) return img.data;
    const out = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) img.data.copy(out, y * w * 4, y * img.w * 4, y * img.w * 4 + w * 4);
    return out;
}

// connected groups of active grid cells (8-neighbourhood) -> pixel boxes
function regionsOf(mask, w, h) {
    const cw = Math.ceil(w / CELL), ch = Math.ceil(h / CELL), count = new Uint32Array(cw * ch);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) count[Math.floor(y / CELL) * cw + Math.floor(x / CELL)]++;
    const active = new Uint8Array(cw * ch);
    for (let i = 0; i < active.length; i++) if (count[i] >= CELL * CELL * MIN_CELL_RATIO) active[i] = 1;
    const seen = new Uint8Array(cw * ch), out = [];
    for (let i = 0; i < active.length; i++) {
        if (!active[i] || seen[i]) continue;
        const stack = [i]; seen[i] = 1;
        let x0 = cw, y0 = ch, x1 = 0, y1 = 0, px = 0;
        while (stack.length) {
            const c = stack.pop(), cx = c % cw, cy = Math.floor(c / cw);
            x0 = Math.min(x0, cx); y0 = Math.min(y0, cy); x1 = Math.max(x1, cx); y1 = Math.max(y1, cy); px += count[c];
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
                const nx = cx + dx, ny = cy + dy;
                if (nx < 0 || ny < 0 || nx >= cw || ny >= ch) continue;
                const n = ny * cw + nx;
                if (active[n] && !seen[n]) { seen[n] = 1; stack.push(n); }
            }
        }
        const x = x0 * CELL, y = y0 * CELL;
        out.push({ x, y, width: Math.min(w, (x1 + 1) * CELL) - x, height: Math.min(h, (y1 + 1) * CELL) - y, diff_pixels: px });
    }
    out.sort((a, b) => b.diff_pixels - a.diff_pixels || a.y - b.y || a.x - b.x);
    return out.slice(0, MAX_REGIONS).map(r => ({ ...r, share_of_image: Math.round(1000 * r.diff_pixels / (w * h)) / 10, center: { x: r.x + Math.floor(r.width / 2), y: r.y + Math.floor(r.height / 2) } }));
}

// -> { ok, reason?, size:{expected,actual,compared}, size_mismatch, diff_pixels, diff_percent, regions, diff_png }
async function compare(expectedBuf, actualBuf, { threshold = 0.1 } = {}) {
    const a = decode(expectedBuf), b = decode(actualBuf);
    if (!a.ok) return { ok: false, reason: `expected image: ${a.reason}` };
    if (!b.ok) return { ok: false, reason: `actual image: ${b.reason}` };
    const w = Math.min(a.w, b.w), h = Math.min(a.h, b.h);
    if (!(w > 0 && h > 0)) return { ok: false, reason: 'an image has no pixels' };
    const pixelmatch = (await import('pixelmatch')).default;
    const out = Buffer.alloc(w * h * 4);
    const n = pixelmatch(crop(a, w, h), crop(b, w, h), out, w, h, { threshold, includeAA: false, diffColor: DIFF });
    const mask = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) if (out[i * 4] === DIFF[0] && out[i * 4 + 1] === DIFF[1] && out[i * 4 + 2] === DIFF[2]) mask[i] = 1;
    const png = new PNG({ width: w, height: h }); out.copy(png.data);
    return { ok: true, size: { expected: [a.w, a.h], actual: [b.w, b.h], compared: [w, h] }, size_mismatch: a.w !== b.w || a.h !== b.h,
        diff_pixels: n, diff_percent: Math.round(10000 * n / (w * h)) / 100, regions: regionsOf(mask, w, h), diff_png: PNG.sync.write(png) };
}

// Which of an issue's images are "expected" and which "actual", from the file names the reporter chose (the stored name keeps them):
//   expected-home.png / baseline-... / before-...      actual-home.png / broken-... / after-...
const EXPECTED = /^(expected|baseline|before|good|working)/i, ACTUAL = /^(actual|broken|after|bad|current)/i;
const stem = name => name.replace(/^\d\d-/, '').replace(/\.(png|jpg|webp)$/i, '');
const roleOf = name => (EXPECTED.test(stem(name)) ? 'expected' : ACTUAL.test(stem(name)) ? 'actual' : 'screenshot');
const rest = name => stem(name).replace(EXPECTED, '').replace(ACTUAL, '').replace(/^[-_ ]+/, '').toLowerCase();
// -> [{ expected: meta, actual: meta|null }]; an actual is paired by the rest of the name, or when there is exactly one of each
function pairs(images) {
    const exp = images.filter(m => roleOf(m.name) === 'expected'), act = images.filter(m => roleOf(m.name) === 'actual');
    return exp.map(e => ({ expected: e, actual: act.find(a => rest(a.name) === rest(e.name)) || (exp.length === 1 && act.length === 1 ? act[0] : null) }));
}

module.exports = { compare, pairs, roleOf, decode, regionsOf, CELL, MAX_REGIONS };
