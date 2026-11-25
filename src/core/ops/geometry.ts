/** Crop, circle, resize, upscale, rotate/flip, social presets, borders, rounded corners, trim, collage. */
import { unsharp, gaussianBlur, scaleRgb } from '../fx.js';
import {
    Img, OpError, checkSize, clamp, compositeOver, crop, flatten, focusBox, hasAlpha, newImg, parseAspect,
    parseColor, unit, viaSharp,
} from '../img.js';

const LANCZOS = { kernel: 'lanczos3' as const };
const bg = (c: string) => {
    const [r, g, b, a] = parseColor(c);
    return { r, g, b, alpha: a / 255 };
};

export function cropBox(img: Img, p: { x: number; y: number; width: number; height: number }): Img {
    const { x, y, width, height } = p;
    if (!(width > 0 && height > 0)) throw new OpError('Crop width and height must be positive.');
    if (x < 0 || y < 0 || x + width > img.width || y + height > img.height)
        throw new OpError(`Crop box x=${x}, y=${y}, ${width}x${height} goes outside the image (${img.width}x${img.height}). Use get_image_info to check the size.`);
    return crop(img, Math.round(x), Math.round(y), Math.round(width), Math.round(height));
}

export function cropAspect(img: Img, p: { aspect_ratio?: string; focus_x?: number; focus_y?: number; zoom?: number } = {}): Img {
    const r = parseAspect(p.aspect_ratio ?? '1:1');
    const fx = unit('focus_x', p.focus_x ?? 0.5), fy = unit('focus_y', p.focus_y ?? 0.5);
    const zoom = p.zoom ?? 1;
    if (!(zoom >= 1 && zoom <= 10)) throw new OpError('zoom must be between 1 (no zoom) and 10.');
    const W = img.width, H = img.height;
    let bw: number, bh: number;
    if (W / H > r) { bh = H; bw = H * r; } else { bw = W; bh = W / r; }
    bw = Math.max(1, bw / zoom);
    bh = Math.max(1, bh / zoom);
    const [x, y, w, h] = focusBox(W, H, bw, bh, fx, fy);
    return crop(img, x, y, Math.max(1, w), Math.max(1, h));
}

/** Anti-aliased disc coverage for a pixel at distance d from the centre of a circle of radius R. */
const cover = (R: number, d: number) => clamp(R - d + 0.5, 0, 1);

export async function cropCircle(img: Img, p: {
    size?: number | null; focus_x?: number; focus_y?: number; zoom?: number; border_width?: number; border_color?: string; background?: string;
} = {}): Promise<Img> {
    let sq = cropAspect(img, { aspect_ratio: '1:1', focus_x: p.focus_x, focus_y: p.focus_y, zoom: p.zoom });
    if (p.size) {
        checkSize(p.size, p.size);
        sq = await viaSharp(sq, s => s.resize(p.size!, p.size!, LANCZOS));
    }
    const n = sq.width, R = n / 2;
    const bw = p.border_width ?? 0;
    if (bw * 2 >= n) throw new OpError('border_width is too large for this image size.');
    const border = parseColor(p.border_color ?? 'white');
    const out = sq;
    for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
            const i = (y * n + x) * 4;
            const d = Math.hypot(x + 0.5 - R, y + 0.5 - R);
            out.data[i + 3] = Math.round(out.data[i + 3] * cover(R, d));
            if (bw > 0) {
                const ring = (cover(R, d) - cover(R - bw, d)) * (border[3] / 255);
                if (ring > 0) {
                    const a = out.data[i + 3] / 255, oa = ring + a * (1 - ring);
                    for (let c = 0; c < 3; c++) out.data[i + c] = Math.round((border[c] * ring + out.data[i + c] * a * (1 - ring)) / (oa || 1));
                    out.data[i + 3] = Math.round(oa * 255);
                }
            }
        }
    }
    const back = parseColor(p.background ?? 'transparent');
    if (back[3] > 0) return compositeOver(newImg(n, n, back), out, 0, 0);
    return out;
}

export async function resize(img: Img, p: { width?: number | null; height?: number | null; scale?: number | null; fit?: string; background?: string } = {}): Promise<Img> {
    const W = img.width, H = img.height;
    const fit = p.fit ?? 'contain';
    if (p.scale != null) {
        if (!(p.scale >= 0.01 && p.scale <= 10)) throw new OpError('scale must be between 0.01 and 10.');
        const w = Math.max(1, Math.round(W * p.scale)), h = Math.max(1, Math.round(H * p.scale));
        checkSize(w, h);
        return viaSharp(img, s => s.resize(w, h, { ...LANCZOS, fit: 'fill' }));
    }
    const { width, height } = p;
    if (width && height) {
        checkSize(width, height);
        const map: Record<string, 'fill' | 'cover' | 'contain' | 'inside'> = { stretch: 'fill', cover: 'cover', pad: 'contain', contain: 'inside' };
        if (!map[fit]) throw new OpError('fit must be one of: contain, cover, pad, stretch.');
        if (fit === 'pad') return padTo(img, width, height, p.background ?? 'transparent');
        return viaSharp(img, s => s.resize(width, height, { ...LANCZOS, fit: map[fit] }));
    }
    if (width) {
        const h = Math.max(1, Math.round((H * width) / W));
        checkSize(width, h);
        return viaSharp(img, s => s.resize(width, h, { ...LANCZOS, fit: 'fill' }));
    }
    if (height) {
        const w = Math.max(1, Math.round((W * height) / H));
        checkSize(w, height);
        return viaSharp(img, s => s.resize(w, height, { ...LANCZOS, fit: 'fill' }));
    }
    throw new OpError('Give width, height, both, or scale.');
}

async function padTo(img: Img, width: number, height: number, background: string): Promise<Img> {
    const inner = await viaSharp(img, s => s.resize(width, height, { ...LANCZOS, fit: 'inside' }));
    const base = newImg(width, height, parseColor(background));
    return compositeOver(base, inner, Math.floor((width - inner.width) / 2), Math.floor((height - inner.height) / 2));
}

export async function upscale(img: Img, p: { factor?: number; sharpen?: number } = {}): Promise<Img> {
    const factor = p.factor ?? 2, sharpen = unit('sharpen', p.sharpen ?? 0.6);
    if (!(factor > 1 && factor <= 4)) throw new OpError('factor must be greater than 1 and at most 4.');
    const w = Math.round(img.width * factor), h = Math.round(img.height * factor);
    checkSize(w, h);
    const up = await viaSharp(img, s => s.resize(w, h, { ...LANCZOS, fit: 'fill' }));
    if (sharpen <= 0) return up;
    return unsharp(up, 1.0 + factor * 0.4, (40 + 110 * sharpen) / 100, 2);
}

export async function rotateFlip(img: Img, p: { angle?: number; flip?: string; background?: string } = {}): Promise<Img> {
    const flip = p.flip ?? 'none';
    if (!['none', 'horizontal', 'vertical', 'both'].includes(flip)) throw new OpError('flip must be one of: none, horizontal, vertical, both.');
    const a = (((p.angle ?? 0) % 360) + 360) % 360;
    let out = img;
    if (a) out = await viaSharp(out, s => (a % 90 === 0 ? s.rotate(a) : s.rotate(a, { background: bg(p.background ?? 'transparent') })));
    if (flip === 'horizontal' || flip === 'both') out = await viaSharp(out, s => s.flop());
    if (flip === 'vertical' || flip === 'both') out = await viaSharp(out, s => s.flip());
    return out;
}

export const SOCIAL_PRESETS: Record<string, [number, number, string]> = {
    instagram_post: [1080, 1080, 'Instagram square feed post'],
    instagram_portrait: [1080, 1350, 'Instagram 4:5 portrait post'],
    instagram_story: [1080, 1920, 'Instagram / Facebook story, Reels cover'],
    youtube_thumbnail: [1280, 720, 'YouTube thumbnail'],
    youtube_banner: [2560, 1440, 'YouTube channel banner'],
    linkedin_profile: [800, 800, 'LinkedIn profile photo'],
    linkedin_banner: [1584, 396, 'LinkedIn profile background'],
    linkedin_post: [1200, 627, 'LinkedIn shared image / link post'],
    x_post: [1600, 900, 'X (Twitter) in-feed image'],
    x_header: [1500, 500, 'X (Twitter) header'],
    facebook_post: [1200, 630, 'Facebook feed image'],
    facebook_cover: [851, 315, 'Facebook page cover'],
    pinterest_pin: [1000, 1500, 'Pinterest 2:3 pin'],
    tiktok: [1080, 1920, 'TikTok / Shorts vertical'],
    whatsapp_dp: [500, 500, 'WhatsApp profile picture'],
    og_image: [1200, 630, 'Website link-preview (Open Graph) image'],
    passport_2x2in: [600, 600, 'US passport 2x2 inch at 300 DPI'],
};

export async function socialResize(img: Img, p: { preset: string; fit?: string; focus_x?: number; focus_y?: number; background?: string }): Promise<Img> {
    const preset = SOCIAL_PRESETS[p.preset];
    if (!preset) throw new OpError(`Unknown preset "${p.preset}". Options: ${Object.keys(SOCIAL_PRESETS).join(', ')}.`);
    const [w, h] = preset;
    const fit = p.fit ?? 'cover';
    if (fit === 'cover') {
        const c = cropAspect(img, { aspect_ratio: `${w}:${h}`, focus_x: p.focus_x, focus_y: p.focus_y });
        return viaSharp(c, s => s.resize(w, h, { ...LANCZOS, fit: 'fill' }));
    }
    if (fit === 'pad') return padTo(img, w, h, p.background ?? 'white');
    if (fit === 'blur_pad') {
        const filled = await viaSharp(cropAspect(flatten(img), { aspect_ratio: `${w}:${h}` }), s => s.resize(w, h, { ...LANCZOS, fit: 'fill' }));
        const back = scaleRgb(await gaussianBlur(filled, Math.max(w, h) / 30), 0.8);
        const inner = await viaSharp(img, s => s.resize(w, h, { ...LANCZOS, fit: 'inside' }));
        return flatten(compositeOver(back, inner, Math.floor((w - inner.width) / 2), Math.floor((h - inner.height) / 2)));
    }
    throw new OpError('fit must be one of: cover, pad, blur_pad.');
}

export async function addBorder(img: Img, p: { width?: number; color?: string } = {}): Promise<Img> {
    const width = p.width ?? 20;
    if (!(width >= 1 && width <= 2000)) throw new OpError('width must be between 1 and 2000 pixels.');
    checkSize(img.width + 2 * width, img.height + 2 * width);
    const c = parseColor(p.color ?? 'white');
    const out = newImg(img.width + 2 * width, img.height + 2 * width, c);
    // copy the image in (not composite: keep its own transparency semantics inside)
    for (let y = 0; y < img.height; y++) img.data.copy(out.data, ((y + width) * out.width + width) * 4, y * img.width * 4, (y + 1) * img.width * 4);
    return out;
}

export function roundCorners(img: Img, p: { radius?: number } = {}): Img {
    const W = img.width, H = img.height;
    let r = p.radius ?? 0.08;
    r = r < 1 ? r * Math.min(W, H) : r;
    r = Math.max(0, Math.min(r, Math.min(W, H) / 2));
    const out = { ...img, data: Buffer.from(img.data) };
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const cx = x + 0.5 < r ? r : x + 0.5 > W - r ? W - r : null;
            const cy = y + 0.5 < r ? r : y + 0.5 > H - r ? H - r : null;
            if (cx === null || cy === null) continue;
            const a = cover(r, Math.hypot(x + 0.5 - cx, y + 0.5 - cy));
            const i = (y * W + x) * 4 + 3;
            out.data[i] = Math.round(out.data[i] * a);
        }
    }
    return out;
}

export function trimBorders(img: Img, p: { tolerance?: number; padding?: number } = {}): Img {
    const tol = p.tolerance ?? 12, pad = p.padding ?? 0;
    const W = img.width, H = img.height, d = img.data;
    const transparentCorner = d[3] < 10;
    const r0 = d[0], g0 = d[1], b0 = d[2];
    let minX = W, minY = H, maxX = -1, maxY = -1;
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const i = (y * W + x) * 4;
            const content = transparentCorner ? d[i + 3] > 10
                : Math.max(Math.abs(d[i] - r0), Math.abs(d[i + 1] - g0), Math.abs(d[i + 2] - b0)) > tol;
            if (content) {
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
            }
        }
    }
    if (maxX < 0) throw new OpError('The image looks like one solid color, so there is nothing to trim.');
    const x0 = Math.max(0, minX - pad), y0 = Math.max(0, minY - pad);
    const x1 = Math.min(W, maxX + 1 + pad), y1 = Math.min(H, maxY + 1 + pad);
    return crop(img, x0, y0, x1 - x0, y1 - y0);
}

export async function collage(images: Img[], p: { columns?: number | null; cell_size?: number; gap?: number; background?: string; fit?: string } = {}): Promise<Img> {
    if (images.length < 2) throw new OpError('A collage needs at least 2 images.');
    const n = images.length, cell = p.cell_size ?? 600, gap = p.gap ?? 12;
    const cols = p.columns ?? Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    const W = cols * cell + (cols + 1) * gap, H = rows * cell + (rows + 1) * gap;
    checkSize(W, H);
    const sheet = newImg(W, H, parseColor(p.background ?? 'white'));
    for (let i = 0; i < n; i++) {
        const r = Math.floor(i / cols), c = i % cols;
        const tile = await viaSharp(images[i], s => s.resize(cell, cell, { ...LANCZOS, fit: p.fit === 'contain' ? 'inside' : 'cover' }));
        compositeOver(sheet, tile, gap + c * (cell + gap) + Math.floor((cell - tile.width) / 2), gap + r * (cell + gap) + Math.floor((cell - tile.height) / 2));
    }
    return sheet;
}

export { hasAlpha };
