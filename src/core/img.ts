/**
 * Core image type: always 8-bit RGBA, raw pixels in a Buffer. Every operation takes and returns this,
 * so operations are easy to chain and test. sharp (libvips) does the heavy lifting where it can.
 */
import sharp, { type Sharp, type Metadata } from 'sharp';

export interface Img {
    data: Buffer; // RGBA, row-major, width*height*4 bytes
    width: number;
    height: number;
}

export type RGBA = [number, number, number, number];

/** Bad parameters or input. The message is shown to the model, so make it actionable. */
export class OpError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'OpError';
    }
}

export const MAX_SIDE = 16000;
export const MAX_RESULT_PIXELS = 120_000_000;

export function checkSize(w: number, h: number): void {
    if (!(w >= 1 && h >= 1)) throw new OpError('The result must be at least 1x1 pixel.');
    if (w > MAX_SIDE || h > MAX_SIDE || w * h > MAX_RESULT_PIXELS)
        throw new OpError(`The result would be ${w}x${h}, which is too large (max ${MAX_SIDE}px per side and ${MAX_RESULT_PIXELS / 1e6} megapixels).`);
}

export function unit(name: string, v: number): number {
    if (!(v >= 0 && v <= 1)) throw new OpError(`${name} must be between 0 and 1 (got ${v}).`);
    return v;
}

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const clamp255 = (v: number) => (v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v));

// ------------------------------------------------------------------ construction / sharp bridge

export function newImg(width: number, height: number, fill: RGBA = [0, 0, 0, 0]): Img {
    const data = Buffer.alloc(width * height * 4);
    if (fill.some(v => v !== 0)) for (let i = 0; i < data.length; i += 4) data.set(fill, i);
    return { data, width, height };
}

export function cloneImg(img: Img): Img {
    return { data: Buffer.from(img.data), width: img.width, height: img.height };
}

export function toSharp(img: Img): Sharp {
    return sharp(img.data, { raw: { width: img.width, height: img.height, channels: 4 }, limitInputPixels: false });
}

export async function fromSharp(s: Sharp): Promise<Img> {
    const { data, info } = await s.toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    if (info.channels !== 4) throw new Error(`Unexpected channel count ${info.channels}`);
    return { data, width: info.width, height: info.height };
}

/** Run a sharp transform on an Img and get an Img back. */
export async function viaSharp(img: Img, fn: (s: Sharp) => Sharp): Promise<Img> {
    return fromSharp(fn(toSharp(img)));
}

// ------------------------------------------------------------------ alpha helpers

const alphaCache = new WeakMap<Buffer, boolean>();

export function hasAlpha(img: Img): boolean {
    const cached = alphaCache.get(img.data);
    if (cached !== undefined) return cached;
    let found = false;
    for (let i = 3; i < img.data.length; i += 4) if (img.data[i] !== 255) { found = true; break; }
    alphaCache.set(img.data, found);
    return found;
}

export function alphaChannel(img: Img): Uint8Array {
    const a = new Uint8Array(img.width * img.height);
    for (let p = 0, i = 3; p < a.length; p++, i += 4) a[p] = img.data[i];
    return a;
}

export function setAlpha(img: Img, alpha: Uint8Array): Img {
    const out = cloneImg(img);
    for (let p = 0, i = 3; p < alpha.length; p++, i += 4) out.data[i] = alpha[p];
    return out;
}

/** Copy the original alpha onto a processed image of the same size (filters must not change transparency). */
export function keepAlpha(processed: Img, original: Img): Img {
    if (!hasAlpha(original)) {
        for (let i = 3; i < processed.data.length; i += 4) processed.data[i] = 255;
        return processed;
    }
    for (let i = 3; i < processed.data.length; i += 4) processed.data[i] = original.data[i];
    return processed;
}

/** Remove transparency by placing the image on a solid color. */
export function flatten(img: Img, background = 'white'): Img {
    if (!hasAlpha(img)) return img;
    let bg = parseColor(background);
    if (bg[3] === 0) bg = [255, 255, 255, 255];
    const out = newImg(img.width, img.height, bg);
    compositeOver(out, img, 0, 0);
    return out;
}

/** Alpha-composite `src` over `dst` (in place) at (dx, dy) with an extra opacity multiplier. */
export function compositeOver(dst: Img, src: Img, dx: number, dy: number, opacity = 1): Img {
    const x0 = Math.max(0, dx), y0 = Math.max(0, dy);
    const x1 = Math.min(dst.width, dx + src.width), y1 = Math.min(dst.height, dy + src.height);
    const d = dst.data, s = src.data;
    for (let y = y0; y < y1; y++) {
        let di = (y * dst.width + x0) * 4;
        let si = ((y - dy) * src.width + (x0 - dx)) * 4;
        for (let x = x0; x < x1; x++, di += 4, si += 4) {
            const sa = (s[si + 3] / 255) * opacity;
            if (sa <= 0) continue;
            const da = d[di + 3] / 255;
            const oa = sa + da * (1 - sa);
            if (oa <= 0) continue;
            for (let c = 0; c < 3; c++) d[di + c] = clamp255((s[si + c] * sa + d[di + c] * da * (1 - sa)) / oa);
            d[di + 3] = clamp255(oa * 255);
        }
    }
    return dst;
}

/** Linear mix of two same-size images: t=0 -> a, t=1 -> b. */
export function blend(a: Img, b: Img, t: number): Img {
    const out = cloneImg(a);
    for (let i = 0; i < out.data.length; i++) out.data[i] = clamp255(a.data[i] + (b.data[i] - a.data[i]) * t);
    return out;
}

/** Per-pixel mix with a 0..1 mask: mask=1 -> b, mask=0 -> a. */
export function mixByMask(a: Img, b: Img, mask: Float32Array): Img {
    const out = cloneImg(a);
    for (let p = 0, i = 0; p < mask.length; p++, i += 4) {
        const m = mask[p];
        if (m <= 0) continue;
        for (let c = 0; c < 4; c++) out.data[i + c] = clamp255(a.data[i + c] + (b.data[i + c] - a.data[i + c]) * m);
    }
    return out;
}

/** Apply a 256-entry lookup table to R, G and B. */
export function applyLut(img: Img, lut: Uint8Array | number[], lutG?: Uint8Array | number[], lutB?: Uint8Array | number[]): Img {
    const out = cloneImg(img);
    const g = lutG ?? lut, b = lutB ?? lut;
    for (let i = 0; i < out.data.length; i += 4) {
        out.data[i] = lut[out.data[i]];
        out.data[i + 1] = g[out.data[i + 1]];
        out.data[i + 2] = b[out.data[i + 2]];
    }
    return out;
}

export function makeLut(fn: (v: number) => number): Uint8Array {
    const lut = new Uint8Array(256);
    for (let v = 0; v < 256; v++) lut[v] = clamp255(fn(v));
    return lut;
}

export function luminance(img: Img): Float32Array {
    const L = new Float32Array(img.width * img.height);
    for (let p = 0, i = 0; p < L.length; p++, i += 4) L[p] = 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
    return L;
}

export function crop(img: Img, x: number, y: number, w: number, h: number): Img {
    const out = newImg(w, h);
    for (let row = 0; row < h; row++) {
        const s = ((y + row) * img.width + x) * 4;
        img.data.copy(out.data, row * w * 4, s, s + w * 4);
    }
    return out;
}

// ------------------------------------------------------------------ colors

const NAMED: Record<string, string> = {
    white: '#ffffff', black: '#000000', red: '#ff0000', green: '#008000', lime: '#00ff00', blue: '#0000ff',
    yellow: '#ffff00', orange: '#ffa500', purple: '#800080', pink: '#ffc0cb', gray: '#808080', grey: '#808080',
    silver: '#c0c0c0', gold: '#ffd700', navy: '#000080', teal: '#008080', cyan: '#00ffff', magenta: '#ff00ff',
    brown: '#a52a2a', maroon: '#800000', olive: '#808000', beige: '#f5f5dc', ivory: '#fffff0', violet: '#ee82ee',
    indigo: '#4b0082', coral: '#ff7f50', salmon: '#fa8072', crimson: '#dc143c', turquoise: '#40e0d0',
    lightgray: '#d3d3d3', darkgray: '#a9a9a9', skyblue: '#87ceeb', royalblue: '#4169e1', tomato: '#ff6347',
};

export function parseColor(value: string | null | undefined, def = 'white'): RGBA {
    const v = (value ?? def).trim().toLowerCase();
    if (v === 'transparent' || v === 'none' || v === '') return [0, 0, 0, 0];
    const hex = (NAMED[v] ?? v).replace(/^#/, '');
    let m: RegExpMatchArray | null;
    if (/^[0-9a-f]{3,4}$/.test(hex)) {
        const p = hex.split('').map(c => parseInt(c + c, 16));
        return [p[0], p[1], p[2], p[3] ?? 255];
    }
    if (/^[0-9a-f]{6}([0-9a-f]{2})?$/.test(hex)) {
        const p = hex.match(/../g)!.map(h => parseInt(h, 16));
        return [p[0], p[1], p[2], p[3] ?? 255];
    }
    if ((m = v.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/))) {
        const a = m[4] === undefined ? 255 : clamp255(Number(m[4]) <= 1 ? Number(m[4]) * 255 : Number(m[4]));
        return [clamp255(+m[1]), clamp255(+m[2]), clamp255(+m[3]), a];
    }
    throw new OpError(`Unknown color "${value}". Use a hex code like '#0A66C2' (or '#00000080' with alpha), ` +
        `rgb(10,102,194), or a name like 'white', 'black', 'transparent'.`);
}

export function toHex(c: RGBA | number[]): string {
    return '#' + c.slice(0, 3).map(v => clamp255(v).toString(16).padStart(2, '0')).join('').toUpperCase();
}

export function cssColor(c: RGBA): string {
    return `rgba(${c[0]},${c[1]},${c[2]},${(c[3] / 255).toFixed(3)})`;
}

// ------------------------------------------------------------------ geometry helpers

export function parseAspect(value: string | number): number {
    const v = String(value).trim().toLowerCase().replace(/[x/]/g, ':');
    let r: number;
    if (v.includes(':')) {
        const [a, b] = v.split(':', 2).map(Number);
        r = a / b;
    } else r = Number(v);
    if (!Number.isFinite(r) || r <= 0)
        throw new OpError(`Bad aspect ratio "${value}". Use '1:1', '16:9', '4:5', '9:16' or a number like 1.5.`);
    if (r < 0.05 || r > 20) throw new OpError(`Aspect ratio "${value}" is out of range.`);
    return r;
}

/** A bw x bh box centred on the focus point (fractions of W/H), kept inside the image. */
export function focusBox(W: number, H: number, bw: number, bh: number, fx: number, fy: number): [number, number, number, number] {
    const left = clamp(fx * W - bw / 2, 0, W - bw);
    const top = clamp(fy * H - bh / 2, 0, H - bh);
    const x = Math.round(left), y = Math.round(top);
    return [x, y, Math.min(W - x, Math.round(bw)), Math.min(H - y, Math.round(bh))];
}

/** Deterministic PRNG (mulberry32) so results are reproducible. */
export function rng(seed = 1): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
