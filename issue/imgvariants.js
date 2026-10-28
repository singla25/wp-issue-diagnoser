// Deterministic image variants for OCR: the original, grayscale, 2x upscale and (for dark themes) inverted. Plain integer/float
// arithmetic in JavaScript, no native code, no randomness: the same bytes always give the same variants.
// PNG and JPEG are decoded (pngjs, jpeg-js). WEBP has no decoder here, so it is OCR'd as it is and the report says so.

const { PNG } = require('pngjs');

const MAX_PIXELS = 16e6;      // above this only the original is used (a 40 MP image would need ~160 MB per copy)
const MAX_UPSCALED_SIDE = 4096;
const DARK_BELOW = 110;       // mean luminance (0..255) under which the inverted variants are added

function decode(buf, kind) {
    if (kind === 'png') { const p = PNG.sync.read(buf); return { w: p.width, h: p.height, data: p.data }; }
    if (kind === 'jpg') { const j = require('jpeg-js').decode(buf, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 600 }); return { w: j.width, h: j.height, data: j.data }; }
    return null;
}
const encode = img => PNG.sync.write({ width: img.w, height: img.h, data: Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length) });

// luminance, transparent pixels composited over white (a transparent screenshot would otherwise turn black)
function gray(img) {
    const out = new Uint8Array(img.w * img.h * 4);
    for (let i = 0; i < img.w * img.h; i++) {
        const a = img.data[i * 4 + 3];
        const c = k => (img.data[i * 4 + k] * a + 255 * (255 - a) + 127) / 255 | 0;
        const y = (77 * c(0) + 150 * c(1) + 29 * c(2) + 128) >> 8;
        out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = y; out[i * 4 + 3] = 255;
    }
    return { w: img.w, h: img.h, data: out };
}
const invert = img => { const o = new Uint8Array(img.data); for (let i = 0; i < o.length; i += 4) { o[i] = 255 - o[i]; o[i + 1] = 255 - o[i + 1]; o[i + 2] = 255 - o[i + 2]; } return { w: img.w, h: img.h, data: o }; };
const meanLuma = g => { let s = 0; for (let i = 0; i < g.w * g.h; i++) s += g.data[i * 4]; return s / (g.w * g.h); };

// bilinear 2x on a grayscale image (R channel carries the value)
function upscale2(g) {
    const W = g.w * 2, H = g.h * 2, out = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) {
        const fy = H > 1 ? y * (g.h - 1) / (H - 1) : 0, y0 = Math.floor(fy), y1 = Math.min(y0 + 1, g.h - 1), wy = fy - y0;
        for (let x = 0; x < W; x++) {
            const fx = W > 1 ? x * (g.w - 1) / (W - 1) : 0, x0 = Math.floor(fx), x1 = Math.min(x0 + 1, g.w - 1), wx = fx - x0;
            const v = (g.data[(y0 * g.w + x0) * 4] * (1 - wx) + g.data[(y0 * g.w + x1) * 4] * wx) * (1 - wy) + (g.data[(y1 * g.w + x0) * 4] * (1 - wx) + g.data[(y1 * g.w + x1) * 4] * wx) * wy;
            const o = (y * W + x) * 4; out[o] = out[o + 1] = out[o + 2] = Math.round(v); out[o + 3] = 255;
        }
    }
    return { w: W, h: H, data: out };
}

// -> { list: [{ name, buf }], notes: [string], dark: bool|null }; 'original' is always first and is the bytes as stored
function build(buf, kind) {
    const list = [{ name: 'original', buf }], notes = [];
    if (kind !== 'png' && kind !== 'jpg') return { list, notes: [`${kind}: no decoder for variants, original only`], dark: null };
    let img;
    try { img = decode(buf, kind); } catch (e) { return { list, notes: [`could not decode for variants (${String(e.message).slice(0, 80)}), original only`], dark: null }; }
    if (img.w * img.h > MAX_PIXELS) return { list, notes: [`${(img.w * img.h / 1e6).toFixed(1)} MP is above the ${MAX_PIXELS / 1e6} MP variant limit, original only`], dark: null };
    const g = gray(img), dark = meanLuma(g) < DARK_BELOW;
    list.push({ name: 'gray', buf: encode(g) });
    if (Math.max(g.w, g.h) * 2 <= MAX_UPSCALED_SIDE) list.push({ name: 'x2', buf: encode(upscale2(g)) });
    else notes.push(`x2 skipped: ${g.w}x${g.h} would exceed ${MAX_UPSCALED_SIDE}px`);
    if (dark) {
        const inv = invert(g);
        list.push({ name: 'inverted', buf: encode(inv) });
        if (Math.max(g.w, g.h) * 2 <= MAX_UPSCALED_SIDE) list.push({ name: 'inverted-x2', buf: encode(upscale2(inv)) });
    }
    return { list, notes, dark };
}

module.exports = { build, decode, gray, invert, upscale2, meanLuma, MAX_PIXELS, DARK_BELOW };
