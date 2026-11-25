/** Blur / pixelate: whole image, chosen regions (rectangle or ellipse), detected faces, or the background. */
import { gaussianBlur } from '../fx.js';
import { Img, OpError, keepAlpha, mixByMask } from '../img.js';
import { Face, detectFaces } from './faces.js';
import { pixelateImg } from './filters.js';

type Box = [number, number, number, number];

export interface BlurParams {
    radius?: number | null; style?: 'gaussian' | 'pixelate'; x?: number | null; y?: number | null; width?: number | null; height?: number | null;
    regions?: { x: number; y: number; width: number; height: number }[] | null; shape?: 'auto' | 'rectangle' | 'ellipse';
    feather?: number | null; invert?: boolean; detect?: 'none' | 'faces'; padding?: number | null; sensitivity?: 'strict' | 'balanced' | 'loose';
}

function grow(boxes: Box[], pad: number): Box[] {
    if (!pad) return boxes;
    return boxes.map(([x, y, w, h]) => [Math.round(x - (w * pad) / 2), Math.round(y - (h * pad) / 2), Math.round(w * (1 + pad)), Math.round(h * (1 + pad))]);
}

function parseRegions(regions: BlurParams['regions'], W: number, H: number): Box[] {
    return (regions ?? []).map((r, i) => {
        const v = [r?.x, r?.y, r?.width, r?.height].map(Number);
        if (v.some(n => !Number.isFinite(n))) throw new OpError(`Region ${i + 1} must have numeric x, y, width and height.`);
        const [x, y, w, h] = v.map(Math.round);
        if (w <= 0 || h <= 0 || x >= W || y >= H || x + w <= 0 || y + h <= 0)
            throw new OpError(`Region ${i + 1} (${x},${y},${w}x${h}) is empty or outside the image (${W}x${H}).`);
        return [x, y, w, h] as Box;
    });
}

/**
 * 1.0 inside the shape, smoothly falling to 0 over `feather` px OUTSIDE it. The region itself is always fully
 * covered (safe for hiding faces/text); feather only softens the border. Max-combined into `mask`.
 */
function addRegion(mask: Float32Array, W: number, H: number, [x, y, w, h]: Box, shape: string, feather: number): void {
    const pad = Math.ceil(feather) + 1;
    const x0 = Math.max(0, x - pad), y0 = Math.max(0, y - pad), x1 = Math.min(W, x + w + pad), y1 = Math.min(H, y + h + pad);
    const cx = x + w / 2, cy = y + h / 2, a = Math.max(w / 2, 0.5), b = Math.max(h / 2, 0.5), minab = Math.min(a, b);
    for (let py = y0; py < y1; py++) {
        const fy = py + 0.5;
        for (let px = x0; px < x1; px++) {
            const fx = px + 0.5;
            let dist: number;
            if (shape === 'ellipse') {
                const r = Math.sqrt(((fx - cx) / a) ** 2 + ((fy - cy) / b) ** 2);
                dist = Math.max(r - 1, 0) * minab;
            } else {
                const dx = Math.max(x - fx, fx - (x + w), 0), dy = Math.max(y - fy, fy - (y + h), 0);
                dist = Math.hypot(dx, dy);
            }
            let alpha: number;
            if (feather <= 0) alpha = dist <= 0 ? 1 : 0;
            else {
                const t = Math.min(1, dist / feather);
                alpha = 1 - t * t * (3 - 2 * t); // smoothstep fade
            }
            const i = py * W + px;
            if (alpha > mask[i]) mask[i] = alpha;
        }
    }
}

export async function blurWithInfo(img: Img, p: BlurParams = {}): Promise<{ img: Img; info: Record<string, unknown> }> {
    const style = p.style ?? 'gaussian', shape = p.shape ?? 'auto', detect = p.detect ?? 'none', invert = !!p.invert;
    if (!['gaussian', 'pixelate'].includes(style)) throw new OpError("style must be 'gaussian' or 'pixelate'.");
    if (!['auto', 'rectangle', 'ellipse'].includes(shape)) throw new OpError("shape must be 'auto', 'rectangle' or 'ellipse'.");
    if (!['none', 'faces'].includes(detect)) throw new OpError("detect must be 'none' or 'faces'.");
    if (p.padding != null && !(p.padding >= 0 && p.padding <= 1)) throw new OpError("padding must be between 0 and 1 (fraction of each region's size).");
    const W = img.width, H = img.height;
    const padManual = p.padding ?? 0, padFaces = p.padding ?? 0.2;

    let boxes = parseRegions(p.regions, W, H);
    const single = [p.x, p.y, p.width, p.height];
    if (single.some(v => v != null)) {
        if (single.some(v => v == null)) throw new OpError('For one region give all of x, y, width and height (or use regions=[...]).');
        boxes.push(...parseRegions([{ x: p.x!, y: p.y!, width: p.width!, height: p.height! }], W, H));
    }
    boxes = grow(boxes, padManual);
    let faces: Face[] = [];
    if (detect === 'faces') {
        faces = await detectFaces(img, p.sensitivity ?? 'balanced');
        if (!faces.length)
            throw new OpError("No faces were detected. The detector works on real photos (not drawings); try sensitivity='loose', or pass the region(s) yourself with x/y/width/height or regions.");
        boxes.push(...grow(faces.map(f => [f.x, f.y, f.width, f.height] as Box), padFaces));
    }
    if (invert && !boxes.length) throw new OpError("invert=true (background blur) needs a region to keep sharp, or detect='faces'.");
    const shapeUsed = shape !== 'auto' ? shape : detect === 'faces' ? 'ellipse' : 'rectangle';
    const smallest = boxes.length ? Math.min(...boxes.map(b => Math.min(b[2], b[3]))) : 0;
    const radius = p.radius ?? (boxes.length ? Math.max(6, smallest / 7) : 8);
    if (!(radius >= 0.5 && radius <= 300)) throw new OpError('radius must be between 0.5 and 300.');
    const feather = p.feather ?? (boxes.length ? Math.max(6, smallest * 0.25) : 0);
    if (!(feather >= 0 && feather <= 2000)) throw new OpError('feather must be between 0 (hard edge) and 2000 pixels.');

    const blurred = keepAlpha(style === 'pixelate' ? await pixelateImg(img, radius) : await gaussianBlur(img, radius), img);
    const info: Record<string, unknown> = {
        radius: Math.round(radius * 10) / 10, feather_px: Math.round(feather * 10) / 10, shape: shapeUsed,
        [invert ? 'regions_kept_sharp' : 'regions_blurred']: boxes.length,
    };
    if (faces.length) info.faces_detected = faces;
    if (!boxes.length) return { img: blurred, info: { ...info, area: 'whole image' } };

    const mask = new Float32Array(W * H);
    for (const b of boxes) addRegion(mask, W, H, b, shapeUsed, feather);
    if (invert) for (let i = 0; i < mask.length; i++) mask[i] = 1 - mask[i];
    return { img: mixByMask(img, blurred, mask), info };
}

export async function blur(img: Img, p: BlurParams = {}): Promise<Img> {
    return (await blurWithInfo(img, p)).img;
}
