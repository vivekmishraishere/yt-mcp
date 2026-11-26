/** Text captions, watermarks, solid-background removal, color palette, face-box drawing. */
import { gaussianBlur } from '../fx.js';
import {
    Img, OpError, RGBA, cloneImg, compositeOver, cssColor, flatten, newImg, parseColor, rng, toHex, unit, viaSharp,
} from '../img.js';
import { Weight, escapeAttr, metrics, pathData, renderSvg, textWidth, wrap } from '../text.js';

export const POSITIONS = ['top_left', 'top', 'top_right', 'left', 'center', 'right', 'bottom_left', 'bottom', 'bottom_right'] as const;
export type Position = (typeof POSITIONS)[number];

function anchor(pos: string, W: number, H: number, w: number, h: number, m: number): [number, number] {
    if (!(POSITIONS as readonly string[]).includes(pos)) throw new OpError(`position must be one of: ${POSITIONS.join(', ')}.`);
    const col = pos.endsWith('left') ? 0 : pos.endsWith('right') ? 2 : 1;
    const row = pos.startsWith('top') ? 0 : pos.startsWith('bottom') ? 2 : 1;
    return [[m, (W - w) / 2, W - w - m][col], [m, (H - h) / 2, H - h - m][row]];
}

export interface TextParams {
    text: string; position?: string; font_size?: number | null; color?: string; stroke_color?: string | null; stroke_width?: number | null;
    box_color?: string | null; weight?: Weight; margin?: number | null; max_width?: number;
}

export async function addText(img: Img, p: TextParams): Promise<Img> {
    if (!p.text || !p.text.trim()) throw new OpError('text is empty.');
    const W = img.width, H = img.height, weight = p.weight ?? 'bold';
    const fs = p.font_size ?? Math.max(12, Math.floor(Math.min(W, H) * 0.07));
    const m = p.margin ?? Math.floor(Math.min(W, H) * 0.04);
    const strokeColor = p.stroke_color === undefined ? 'black' : p.stroke_color;
    const sw = p.stroke_width ?? (strokeColor ? Math.max(1, Math.floor(fs / 18)) : 0);
    const lines = wrap(p.text, fs, W * (p.max_width ?? 0.9), weight);
    const { ascent, descent } = metrics(fs, weight);
    const lineH = ascent + descent + fs * 0.2;
    const blockW = Math.max(...lines.map(l => textWidth(l, fs, weight))) + sw * 2;
    const blockH = lineH * lines.length - fs * 0.2 + sw * 2;
    const pad = p.box_color ? fs * 0.35 : 0;
    const [x, y] = anchor(p.position ?? 'bottom', W, H, blockW + 2 * pad, blockH + 2 * pad, m);
    let svg = '';
    if (p.box_color) svg += `<rect x="${x}" y="${y}" width="${blockW + 2 * pad}" height="${blockH + 2 * pad}" rx="${pad}" fill="${cssColor(parseColor(p.box_color))}"/>`;
    const fill = cssColor(parseColor(p.color ?? 'white'));
    const stroke = strokeColor && sw ? `stroke="${cssColor(parseColor(strokeColor))}" stroke-width="${sw * 2}" stroke-linejoin="round" paint-order="stroke"` : '';
    lines.forEach((line, i) => {
        const lw = textWidth(line, fs, weight);
        const lx = x + pad + sw + (blockW - 2 * sw - lw) / 2;
        const ly = y + pad + sw + ascent + i * lineH;
        svg += `<path d="${pathData(line, lx, ly, fs, weight)}" fill="${fill}" ${stroke}/>`;
    });
    return compositeOver(cloneImg(img), await renderSvg(svg, W, H), 0, 0);
}

export interface WatermarkParams {
    text?: string | null; position?: string; opacity?: number; tiled?: boolean; scale?: number; color?: string; angle?: number;
}

export async function addWatermark(img: Img, p: WatermarkParams, logo?: Img | null): Promise<Img> {
    const text = p.text ?? null;
    if (!text && !logo) throw new OpError('Give watermark text, a logo image, or both.');
    const opacity = unit('opacity', p.opacity ?? 0.35), scale = p.scale ?? 0.2, angle = p.angle ?? -30;
    if (!(scale >= 0.02 && scale <= 1)) throw new OpError('scale must be between 0.02 and 1.');
    const W = img.width, H = img.height, m = Math.floor(Math.min(W, H) * 0.03);
    const pos = p.position ?? 'bottom_right';
    const out = cloneImg(img);

    if (logo) {
        const lw = Math.max(8, Math.floor(W * scale));
        const mark = await viaSharp(logo, s => s.resize(lw, Math.max(1, Math.round((logo.height * lw) / logo.width)), { kernel: 'lanczos3', fit: 'fill' }));
        if (p.tiled) {
            for (let yy = m; yy < H; yy += mark.height * 2) for (let xx = m; xx < W; xx += mark.width * 2) compositeOver(out, mark, xx, yy, opacity);
        } else {
            const [x, y] = anchor(pos, W, H, mark.width, mark.height, m);
            compositeOver(out, mark, Math.max(0, Math.round(x)), Math.max(0, Math.round(y)), opacity);
        }
    }
    if (text) {
        const fs = Math.max(12, Math.floor(Math.min(W, H) * scale * 0.25));
        const tw = textWidth(text, fs), { ascent, descent } = metrics(fs);
        const sw = Math.max(1, Math.floor(fs / 20));
        const style = `fill="${cssColor(parseColor(p.color ?? 'white'))}" stroke="rgba(0,0,0,0.63)" stroke-width="${sw * 2}" paint-order="stroke" stroke-linejoin="round"`;
        let svg: string;
        if (p.tiled) {
            const diag = Math.ceil(Math.hypot(W, H));
            const sx = tw + Math.max(40, tw / 2), sy = ascent + descent + Math.max(60, (ascent + descent) * 2);
            const d = pathData(text, 0, ascent, fs);
            let uses = '';
            for (let row = 0, yy = -diag / 2; yy < diag; row++, yy += sy)
                for (let xx = -diag / 2 - (row % 2) * (sx / 2); xx < diag; xx += sx) uses += `<use href="#m" x="${xx.toFixed(1)}" y="${yy.toFixed(1)}"/>`;
            svg = `<defs><path id="m" d="${d}" ${style}/></defs><g opacity="${opacity}" transform="rotate(${-angle} ${W / 2} ${H / 2})">${uses}</g>`;
        } else {
            const [x, y] = anchor(pos, W, H, tw + 2 * sw, ascent + descent + 2 * sw, m);
            svg = `<g opacity="${opacity}"><path d="${pathData(text, x + sw, y + sw + ascent, fs)}" ${style}/></g>`;
        }
        compositeOver(out, await renderSvg(svg, W, H), 0, 0);
    }
    return out;
}

export async function removeSolidBackground(img: Img, p: { color?: string; tolerance?: number; mode?: string; feather?: number } = {}): Promise<Img> {
    const tol = p.tolerance ?? 40, mode = p.mode ?? 'edges', feather = p.feather ?? 1;
    if (!(tol >= 0 && tol <= 255)) throw new OpError('tolerance must be between 0 and 255.');
    if (!['edges', 'everywhere'].includes(mode)) throw new OpError("mode must be 'edges' (only background touching the border) or 'everywhere'.");
    const W = img.width, H = img.height, d = img.data;
    const corners = [[0, 0], [W - 1, 0], [0, H - 1], [W - 1, H - 1]];
    let target: number[];
    if (!p.color || p.color === 'auto') {
        const samples = corners.map(([x, y]) => d.subarray((y * W + x) * 4, (y * W + x) * 4 + 3));
        target = [0, 1, 2].map(c => samples.map(s => s[c]).sort((a, b) => a - b)[1]); // median-ish of 4
    } else target = parseColor(p.color).slice(0, 3);
    const diff = (i: number) => Math.max(Math.abs(d[i] - target[0]), Math.abs(d[i + 1] - target[1]), Math.abs(d[i + 2] - target[2]));
    const mask = new Uint8Array(W * H).fill(255); // 255 = keep

    if (mode === 'everywhere') {
        for (let pI = 0; pI < W * H; pI++) {
            const soft = Math.min(1, Math.max(0, (diff(pI * 4) - tol) / Math.max(1, tol * 0.5)));
            mask[pI] = Math.round(soft * 255);
        }
    } else {
        const stack: number[] = [];
        for (const [x, y] of corners) if (diff((y * W + x) * 4) <= tol) stack.push(y * W + x);
        while (stack.length) {
            const pI = stack.pop()!;
            if (mask[pI] === 0 || diff(pI * 4) > tol) continue;
            mask[pI] = 0;
            const x = pI % W, y = (pI - x) / W;
            if (x > 0) stack.push(pI - 1);
            if (x < W - 1) stack.push(pI + 1);
            if (y > 0) stack.push(pI - W);
            if (y < H - 1) stack.push(pI + W);
        }
    }
    let m = mask;
    if (feather > 0) {
        const mImg = newImg(W, H);
        for (let i = 0; i < W * H; i++) mImg.data[i * 4] = mImg.data[i * 4 + 1] = mImg.data[i * 4 + 2] = mask[i], mImg.data[i * 4 + 3] = 255;
        const b = await gaussianBlur(mImg, feather);
        m = new Uint8Array(W * H);
        for (let i = 0; i < W * H; i++) m[i] = b.data[i * 4];
    }
    const out = cloneImg(img);
    for (let i = 0; i < W * H; i++) out.data[i * 4 + 3] = Math.min(out.data[i * 4 + 3], m[i]);
    return out;
}

/** Dominant colors with k-means (k-means++ seeding, deterministic). Reports real pixel colors, not blends. */
export async function palette(img: Img, count = 6): Promise<[string, number][]> {
    if (!(count >= 1 && count <= 16)) throw new OpError('count must be between 1 and 16.');
    const small = await viaSharp(flatten(img), s => s.resize(160, 160, { fit: 'inside', withoutEnlargement: true }));
    const n = small.width * small.height;
    const px = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) px[i * 3 + c] = small.data[i * 4 + c];
    const uniq = new Set<number>();
    for (let i = 0; i < n && uniq.size <= count; i++) uniq.add((px[i * 3] << 16) | (px[i * 3 + 1] << 8) | px[i * 3 + 2]);
    const k = Math.min(count, uniq.size);
    const rand = rng(0);
    const dist2 = (i: number, c: number[]) => (px[i * 3] - c[0]) ** 2 + (px[i * 3 + 1] - c[1]) ** 2 + (px[i * 3 + 2] - c[2]) ** 2;
    const pick = (i: number) => [px[i * 3], px[i * 3 + 1], px[i * 3 + 2]];
    const centers: number[][] = [pick(Math.floor(rand() * n))];
    const dmin = new Float64Array(n).fill(Infinity);
    while (centers.length < k) {
        let total = 0;
        for (let i = 0; i < n; i++) { dmin[i] = Math.min(dmin[i], dist2(i, centers[centers.length - 1])); total += dmin[i]; }
        if (total === 0) break;
        let r = rand() * total, i = 0;
        for (; i < n - 1 && (r -= dmin[i]) > 0; i++);
        centers.push(pick(i));
    }
    const labels = new Int32Array(n);
    for (let iter = 0; iter < 15; iter++) {
        const sums = centers.map(() => [0, 0, 0, 0]);
        for (let i = 0; i < n; i++) {
            let best = 0, bd = Infinity;
            for (let j = 0; j < centers.length; j++) { const dd = dist2(i, centers[j]); if (dd < bd) { bd = dd; best = j; } }
            labels[i] = best;
            const s = sums[best];
            s[0] += px[i * 3]; s[1] += px[i * 3 + 1]; s[2] += px[i * 3 + 2]; s[3]++;
        }
        let moved = 0;
        centers.forEach((c, j) => {
            if (!sums[j][3]) return;
            const nc = [sums[j][0] / sums[j][3], sums[j][1] / sums[j][3], sums[j][2] / sums[j][3]];
            moved = Math.max(moved, Math.abs(nc[0] - c[0]), Math.abs(nc[1] - c[1]), Math.abs(nc[2] - c[2]));
            centers[j] = nc;
        });
        if (moved < 0.5) break;
    }
    const out: [string, number][] = [];
    centers.forEach((c, j) => {
        let count = 0, best = -1, bd = Infinity;
        for (let i = 0; i < n; i++) if (labels[i] === j) { count++; const dd = dist2(i, c); if (dd < bd) { bd = dd; best = i; } }
        if (count) out.push([toHex(pick(best)), Math.round((1000 * count) / n) / 10]);
    });
    return out.sort((a, b) => b[1] - a[1]);
}

export function paletteSwatch(colors: [string, number][], width = 600, height = 120): Img {
    const sw = newImg(width, height, [255, 255, 255, 255]);
    let x = 0;
    for (const [hex, pct] of colors) {
        const c = parseColor(hex);
        const w = Math.round((width * pct) / 100);
        for (let yy = 0; yy < height; yy++) for (let xx = x; xx < Math.min(width, x + w + 1); xx++) sw.data.set(c, (yy * width + xx) * 4);
        x += w;
    }
    return sw;
}

export async function drawBoxes(img: Img, boxes: { x: number; y: number; width: number; height: number }[], color = '#00E676'): Promise<Img> {
    const base = flatten(img);
    const lw = Math.max(2, Math.floor(Math.min(img.width, img.height) / 250));
    const fs = Math.max(14, Math.floor(Math.min(img.width, img.height) / 30));
    const c = cssColor(parseColor(color) as RGBA);
    let svg = '';
    boxes.forEach((b, i) => {
        svg += `<rect x="${b.x}" y="${b.y}" width="${b.width}" height="${b.height}" fill="none" stroke="${c}" stroke-width="${lw}"/>`;
        svg += `<path d="${pathData(String(i + 1), b.x + lw * 2, Math.max(fs, b.y - lw), fs)}" fill="${c}" stroke="black" stroke-width="3" paint-order="stroke"/>`;
    });
    return compositeOver(cloneImg(base), await renderSvg(svg, img.width, img.height), 0, 0);
}

/**
 * Copy of the image with a labelled pixel grid (lines every 10%), so a model looking at the preview can read off the
 * pixel coordinates of any area, e.g. for blur_image regions on drawings where face detection cannot help.
 */
export async function drawGrid(img: Img, divisions = 10): Promise<Img> {
    const base = flatten(img);
    const W = img.width, H = img.height;
    // sizes relative to the longer side, so labels stay readable after the preview is scaled down to ~768 px
    const long = Math.max(W, H);
    const lw = Math.max(1, Math.round(long / 700));
    const fs = Math.max(11, Math.round(long / 45));
    let svg = '';
    for (let i = 1; i < divisions; i++) {
        const x = Math.round((W * i) / divisions), y = Math.round((H * i) / divisions);
        svg += `<line x1="${x}" y1="0" x2="${x}" y2="${H}" stroke="#FF1744" stroke-opacity="0.75" stroke-width="${lw}"/>`;
        svg += `<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="#2979FF" stroke-opacity="0.75" stroke-width="${lw}"/>`;
        svg += `<path d="${pathData(String(x), x + lw * 2, fs + lw, fs)}" fill="#FF1744" stroke="white" stroke-width="${Math.max(2, fs / 6)}" paint-order="stroke"/>`;
        svg += `<path d="${pathData(String(y), lw * 2, y - lw * 2, fs)}" fill="#2979FF" stroke="white" stroke-width="${Math.max(2, fs / 6)}" paint-order="stroke"/>`;
    }
    return compositeOver(cloneImg(base), await renderSvg(svg, W, H), 0, 0);
}

export { escapeAttr };
