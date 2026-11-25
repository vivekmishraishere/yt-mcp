/** 19 photo filters, manual adjustments and one-click auto enhance. Transparency is always preserved. */
import sharp from 'sharp';
import { contrast, gaussianBlur, saturate, scaleRgb, sharpness, unsharp } from '../fx.js';
import {
    Img, OpError, applyLut, blend, clamp255, cloneImg, fromSharp, keepAlpha, luminance, makeLut, newImg, toSharp, unit, viaSharp,
} from '../img.js';

function grayscale(img: Img): Img {
    const out = cloneImg(img), L = luminance(img);
    for (let p = 0, i = 0; p < L.length; p++, i += 4) out.data[i] = out.data[i + 1] = out.data[i + 2] = clamp255(L[p]);
    return out;
}

/** Map luminance to a 3-color gradient (black -> mid -> white), like Pillow's ImageOps.colorize. */
function colorize(img: Img, black: number[], mid: number[], white: number[]): Img {
    const out = cloneImg(img), L = luminance(img);
    for (let p = 0, i = 0; p < L.length; p++, i += 4) {
        const v = L[p];
        const [a, b, t] = v < 128 ? [black, mid, v / 127] : [mid, white, (v - 128) / 127];
        for (let c = 0; c < 3; c++) out.data[i + c] = clamp255(a[c] + (b[c] - a[c]) * t);
    }
    return out;
}

/** Auto-levels on luminance, ignoring `cutoff` % at each end, same curve for R, G, B (keeps the color tone). */
function autocontrast(img: Img, cutoff = 0.5): Img {
    const L = luminance(img), hist = new Array(256).fill(0);
    for (const v of L) hist[clamp255(v)]++;
    const cut = (L.length * cutoff) / 100;
    let lo = 0, hi = 255, acc = 0;
    while (lo < 255 && (acc += hist[lo]) <= cut) lo++;
    acc = 0;
    while (hi > 0 && (acc += hist[hi]) <= cut) hi--;
    if (hi <= lo) return cloneImg(img);
    const scale = 255 / (hi - lo);
    return applyLut(img, makeLut(v => (v - lo) * scale));
}

function vignette(img: Img, strength = 0.5): Img {
    const out = cloneImg(img), W = img.width, H = img.height;
    for (let y = 0; y < H; y++) {
        const ny = (y - H / 2) / (H / 2);
        for (let x = 0; x < W; x++) {
            const nx = (x - W / 2) / (W / 2);
            const d = Math.min(1, Math.sqrt(nx * nx + ny * ny) / Math.SQRT2);
            const m = 1 - strength * Math.pow(Math.min(1, Math.max(0, (d - 0.35) / 0.65)), 1.6);
            const i = (y * W + x) * 4;
            for (let c = 0; c < 3; c++) out.data[i + c] = clamp255(out.data[i + c] * m);
        }
    }
    return out;
}

const sepia = (im: Img) => colorize(im, [0x2b, 0x1d, 0x0e], [0xa8, 0x80, 0x5c], [0xff, 0xf1, 0xd6]);
const channelScale = (im: Img, r: number, g: number, b: number) => applyLut(im, makeLut(v => v * r), makeLut(v => v * g), makeLut(v => v * b));

async function sketch(img: Img): Promise<Img> {
    const gray = grayscale(img);
    const inv = applyLut(gray, makeLut(v => 255 - v));
    const blur = await gaussianBlur(inv, Math.max(3, Math.min(img.width, img.height) / 120));
    const out = cloneImg(gray);
    for (let i = 0; i < out.data.length; i += 4) {
        const v = clamp255((gray.data[i] * 255) / Math.max(255 - blur.data[i], 1));
        out.data[i] = out.data[i + 1] = out.data[i + 2] = v;
    }
    return out;
}

async function cartoon(img: Img): Promise<Img> {
    const smooth = await viaSharp(img, s => s.median(5).blur(1));
    // flatten colors with libimagequant (via PNG palette quantisation)
    const pngBuf = await toSharp(smooth).png({ palette: true, colours: 24, dither: 0 }).toBuffer();
    const flat = await fromSharp(sharp(pngBuf));
    const vivid = saturate(flat, 1.3);
    // Ink lines: Laplacian edge strength on a median-smoothed gray copy, computed in JS (predictable order).
    const W = img.width, H = img.height;
    const grayMed = await viaSharp(grayscale(img), s => s.median(5));
    const g = (x: number, y: number) => grayMed.data[(Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))) * 4];
    const line = new Uint8Array(W * H);
    for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
            const e = 8 * g(x, y) - g(x - 1, y - 1) - g(x, y - 1) - g(x + 1, y - 1) - g(x - 1, y) - g(x + 1, y) - g(x - 1, y + 1) - g(x, y + 1) - g(x + 1, y + 1);
            line[y * W + x] = e > 40 ? 0 : 255;
        }
    const out = cloneImg(vivid);
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            let m = 255; // 3x3 min filter thickens the ink lines
            for (let yy = Math.max(0, y - 1); yy <= Math.min(H - 1, y + 1); yy++)
                for (let xx = Math.max(0, x - 1); xx <= Math.min(W - 1, x + 1); xx++) m = Math.min(m, line[yy * W + xx]);
            const i = (y * W + x) * 4;
            for (let c = 0; c < 3; c++) out.data[i + c] = Math.round((out.data[i + c] * m) / 255);
        }
    }
    return out;
}

/** Relief: each pixel minus its upper-left neighbour, centred on mid-gray (Pillow's EMBOSS kernel). */
function emboss(img: Img): Img {
    const out = cloneImg(img), W = img.width, H = img.height, d = img.data;
    for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
            const i = (y * W + x) * 4, j = (Math.max(0, y - 1) * W + Math.max(0, x - 1)) * 4;
            for (let c = 0; c < 3; c++) out.data[i + c] = clamp255(128 + d[i + c] - d[j + c]);
        }
    return out;
}

export async function pixelateImg(img: Img, block?: number): Promise<Img> {
    const b = Math.max(2, Math.round(block ?? Math.max(4, Math.floor(Math.min(img.width, img.height) / 60))));
    const small = await viaSharp(img, s => s.resize(Math.max(1, Math.floor(img.width / b)), Math.max(1, Math.floor(img.height / b)), { kernel: 'linear', fit: 'fill' }));
    return viaSharp(small, s => s.resize(img.width, img.height, { kernel: 'nearest', fit: 'fill' }));
}

type Filter = (img: Img) => Img | Promise<Img>;

export const FILTERS: Record<string, [Filter, string]> = {
    grayscale: [grayscale, 'Black and white'],
    noir: [im => contrast(autocontrast(grayscale(im), 2), 1.4), 'High-contrast black and white'],
    sepia: [sepia, 'Warm brown old-photo tone'],
    vintage: [im => vignette(applyLut(contrast(blend(im, sepia(im), 0.45), 0.9), makeLut(v => 18 + v * 0.9)), 0.45), 'Faded sepia film look with vignette'],
    warm: [im => channelScale(im, 1.08, 1.02, 0.9), 'Golden, warmer tones'],
    cool: [im => channelScale(im, 0.92, 1.0, 1.1), 'Bluer, cooler tones'],
    vivid: [im => contrast(saturate(im, 1.45), 1.1), 'Punchy, saturated colors'],
    dramatic: [async im => vignette(await unsharp(contrast(saturate(im, 1.15), 1.35), 3, 0.8, 3), 0.35), 'Moody contrast + vignette'],
    fade: [im => applyLut(saturate(im, 0.75), makeLut(v => 32 + v * 0.82)), 'Matte, lifted blacks'],
    invert: [im => applyLut(im, makeLut(v => 255 - v)), 'Negative'],
    posterize: [im => applyLut(im, makeLut(v => v & 0b11100000)), 'Flat poster colors'],
    solarize: [im => applyLut(im, makeLut(v => (v >= 128 ? 255 - v : v))), 'Partially inverted, surreal'],
    emboss: [emboss, 'Raised relief effect'],
    sketch: [sketch, 'Pencil sketch'],
    cartoon: [cartoon, 'Flat colors with ink outlines'],
    blur: [im => gaussianBlur(im, Math.max(2, Math.min(im.width, im.height) / 200)), 'Soft blur'],
    sharpen: [im => unsharp(im, 2, 1.5, 3), 'Crisper details'],
    vignette: [im => vignette(im, 0.55), 'Darker edges'],
    pixelate: [im => pixelateImg(im), 'Big pixel blocks'],
};

export async function applyFilter(img: Img, p: { filter?: string; intensity?: number } = {}): Promise<Img> {
    const name = p.filter ?? 'grayscale';
    const f = FILTERS[name];
    if (!f) throw new OpError(`Unknown filter "${name}". Options: ${Object.keys(FILTERS).join(', ')}.`);
    const intensity = unit('intensity', p.intensity ?? 1);
    let out = await f[0](img);
    if (intensity < 1) out = blend(img, out, intensity);
    return keepAlpha(out, img);
}

export async function adjust(img: Img, p: {
    brightness?: number; contrast?: number; saturation?: number; sharpness?: number; exposure?: number; gamma?: number; warmth?: number;
} = {}): Promise<Img> {
    const { brightness = 1, contrast: con = 1, saturation = 1, sharpness: sharp = 1, exposure = 0, gamma = 1, warmth = 0 } = p;
    for (const [n, v] of Object.entries({ brightness, contrast: con, saturation, sharpness: sharp }))
        if (!(v >= 0 && v <= 4)) throw new OpError(`${n} must be between 0 and 4 (1.0 = unchanged).`);
    if (!(exposure >= -3 && exposure <= 3)) throw new OpError('exposure is in stops (EV), between -3 and 3.');
    if (!(gamma >= 0.2 && gamma <= 5)) throw new OpError('gamma must be between 0.2 and 5 (1.0 = unchanged; >1 brightens shadows).');
    if (!(warmth >= -1 && warmth <= 1)) throw new OpError('warmth must be between -1 (cooler) and 1 (warmer).');
    let out = img;
    if (exposure) out = applyLut(out, makeLut(v => v * 2 ** exposure));
    if (gamma !== 1) out = applyLut(out, makeLut(v => 255 * (v / 255) ** (1 / gamma)));
    if (brightness !== 1) out = scaleRgb(out, brightness);
    if (con !== 1) out = contrast(out, con);
    if (saturation !== 1) out = saturate(out, saturation);
    if (sharp !== 1) out = await sharpness(out, sharp);
    if (warmth) out = channelScale(out, 1 + 0.12 * warmth, 1 + 0.02 * warmth, 1 - 0.12 * warmth);
    return keepAlpha(out === img ? cloneImg(img) : out, img);
}

export async function autoEnhance(img: Img, p: { strength?: number } = {}): Promise<Img> {
    const strength = unit('strength', p.strength ?? 0.7);
    let out = autocontrast(img, 0.5);
    const L = luminance(out);
    const mean = L.reduce((a, b) => a + b, 0) / L.length;
    if (mean < 95) {
        const g = Math.min(1.6, (95 / Math.max(mean, 20)) * 0.9 + 0.3);
        out = applyLut(out, makeLut(v => 255 * (v / 255) ** (1 / g)));
    }
    out = await unsharp(saturate(out, 1.12), 1.6, 0.6, 3);
    if (strength < 1) out = blend(img, out, strength);
    return keepAlpha(out, img);
}

export { newImg };
