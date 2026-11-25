/** Small shared pixel effects used by several operations. */
import { Img, clamp255, cloneImg, keepAlpha, viaSharp } from './img.js';

export async function gaussianBlur(img: Img, sigma: number): Promise<Img> {
    if (sigma < 0.3) return cloneImg(img);
    return viaSharp(img, s => s.blur(Math.min(sigma, 1000)));
}

/** Unsharp mask: out = orig + amount * (orig - blurred), skipping differences below `threshold`. Alpha unchanged. */
export async function unsharp(img: Img, sigma: number, amount: number, threshold = 0): Promise<Img> {
    const b = await gaussianBlur(img, sigma);
    const out = cloneImg(img);
    for (let i = 0; i < out.data.length; i += 4) {
        for (let c = 0; c < 3; c++) {
            const d = img.data[i + c] - b.data[i + c];
            if (Math.abs(d) >= threshold) out.data[i + c] = clamp255(img.data[i + c] + amount * d);
        }
    }
    return out;
}

/** Multiply RGB by a factor (brightness). */
export function scaleRgb(img: Img, f: number): Img {
    const out = cloneImg(img);
    for (let i = 0; i < out.data.length; i += 4) for (let c = 0; c < 3; c++) out.data[i + c] = clamp255(out.data[i + c] * f);
    return out;
}

/** Saturation: blend each pixel with its own luminance (f=0 gray, 1 unchanged, >1 more colorful). */
export function saturate(img: Img, f: number): Img {
    const out = cloneImg(img);
    const d = out.data;
    for (let i = 0; i < d.length; i += 4) {
        const L = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        for (let c = 0; c < 3; c++) d[i + c] = clamp255(L + (d[i + c] - L) * f);
    }
    return out;
}

/** Contrast around the image's mean luminance (same idea as Pillow's ImageEnhance.Contrast). */
export function contrast(img: Img, f: number): Img {
    const d = img.data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    const mean = Math.round(sum / (d.length / 4));
    const out = cloneImg(img);
    for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) out.data[i + c] = clamp255(mean + (d[i + c] - mean) * f);
    return out;
}

/** Sharpness: f=1 unchanged, >1 sharper, <1 softer. */
export async function sharpness(img: Img, f: number): Promise<Img> {
    const soft = await gaussianBlur(img, 1);
    const out = cloneImg(img);
    for (let i = 0; i < out.data.length; i += 4) for (let c = 0; c < 3; c++) out.data[i + c] = clamp255(soft.data[i + c] + (img.data[i + c] - soft.data[i + c]) * f);
    return keepAlpha(out, img);
}
