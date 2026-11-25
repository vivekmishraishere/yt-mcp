/** LinkedIn-style profile picture: circular photo + colored ring or #OPENTOWORK-style arc with curved text. */
import { Img, OpError, clamp, compositeOver, newImg, parseColor, cssColor } from '../img.js';
import { getFont, pathData, renderSvg, textWidth } from '../text.js';
import { cropCircle } from './geometry.js';

export const RING_STYLES: Record<string, { colors: string[]; label: string | null; shape: 'full' | 'arc'; about: string }> = {
    open_to_work: { colors: ['#057642'], label: '#OPENTOWORK', shape: 'arc', about: "Green arc with #OPENTOWORK, like LinkedIn's frame" },
    hiring: { colors: ['#7C3AED'], label: '#HIRING', shape: 'arc', about: 'Purple arc with #HIRING' },
    linkedin_blue: { colors: ['#0A66C2'], label: null, shape: 'full', about: 'Solid LinkedIn-blue ring' },
    sunset_gradient: { colors: ['#FEDA75', '#FA7E1E', '#D62976', '#962FBF', '#4F5BD5'], label: null, shape: 'full', about: 'Yellow-orange-pink-purple gradient ring (story style)' },
    gold: { colors: ['#FFE9A8', '#D4A017', '#8C6A0B', '#FFE9A8'], label: null, shape: 'full', about: 'Metallic gold ring' },
    ocean: { colors: ['#00C6FF', '#0072FF'], label: null, shape: 'full', about: 'Cyan to blue gradient' },
    custom: { colors: ['#0A66C2'], label: null, shape: 'full', about: 'Your own colors / label' },
};

function gradientAt(stops: number[][], t: number): number[] {
    if (stops.length === 1) return stops[0];
    const pos = clamp(t, 0, 1) * (stops.length - 1);
    const i = Math.min(Math.floor(pos), stops.length - 2);
    const f = pos - i;
    return [0, 1, 2].map(c => stops[i][c] * (1 - f) + stops[i + 1][c] * f);
}

export interface RingParams {
    style?: string; colors?: string[] | null; label?: string | null; label_color?: string; shape?: 'full' | 'arc' | null;
    ring_width?: number; size?: number; focus_x?: number; focus_y?: number; zoom?: number;
    arc_center?: number; arc_span?: number; gap?: number; background?: string;
}

export async function profileRing(img: Img, p: RingParams = {}): Promise<Img> {
    const style = p.style ?? 'open_to_work';
    const preset = RING_STYLES[style];
    if (!preset) throw new OpError(`Unknown style "${style}". Options: ${Object.keys(RING_STYLES).join(', ')}.`);
    const colors = p.colors?.length ? p.colors : preset.colors;
    const label = p.label === undefined || p.label === null ? preset.label : p.label || null;
    const shape = p.shape ?? preset.shape;
    const ringWidth = p.ring_width ?? 0.09, N = Math.round(p.size ?? 800);
    const arcCenter = p.arc_center ?? 115, arcSpan = p.arc_span ?? 230, gap = p.gap ?? 0.012;
    if (!['full', 'arc'].includes(shape)) throw new OpError("shape must be 'full' or 'arc'.");
    if (!(ringWidth >= 0.02 && ringWidth <= 0.3)) throw new OpError('ring_width is a fraction of the diameter, between 0.02 and 0.3.');
    if (!(N >= 64 && N <= 4096)) throw new OpError('size must be between 64 and 4096 pixels.');
    if (!(arcSpan >= 20 && arcSpan <= 360)) throw new OpError('arc_span must be between 20 and 360 degrees.');
    const stops = colors.map(c => parseColor(c).slice(0, 3));

    const R = N / 2, w = ringWidth * N;
    const canvas = newImg(N, N, parseColor(p.background ?? 'transparent'));

    // 1) photo: inside the ring (full) or full size with the band over its edge (arc, like LinkedIn)
    const photoR = shape === 'full' ? R - w - gap * N : R;
    const pd = Math.max(8, Math.round(photoR * 2));
    const photo = await cropCircle(img, { size: pd, focus_x: p.focus_x ?? 0.5, focus_y: p.focus_y ?? 0.45, zoom: p.zoom ?? 1 });
    const off = Math.round(R - pd / 2);
    compositeOver(canvas, photo, off, off);

    // 2) ring band per pixel: anti-aliased edges, angular gradient, faded arc ends
    const band = newImg(N, N);
    const half = arcSpan / 2, fade = Math.max(6, Math.min(28, half * 0.3));
    for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
            const dx = x + 0.5 - R, dy = y + 0.5 - R;
            const r = Math.hypot(dx, dy);
            const aRad = clamp(R - r + 0.5, 0, 1) * clamp(r - (R - w) + 0.5, 0, 1);
            if (aRad <= 0) continue;
            const theta = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360; // 0 = 3 o'clock, clockwise
            let aAng = 1, t: number;
            if (shape === 'arc' && arcSpan < 360) {
                const signed = ((theta - arcCenter + 540) % 360) - 180;
                aAng = clamp((half - Math.abs(signed)) / fade, 0, 1);
                t = (signed + half) / arcSpan;
            } else {
                const u = ((theta - 270 + 360) % 360) / 360;
                t = 1 - Math.abs(2 * u - 1); // mirrored: no seam
            }
            const a = aRad * aAng;
            if (a <= 0) continue;
            const c = gradientAt(stops, t), i = (y * N + x) * 4;
            band.data[i] = Math.round(c[0]);
            band.data[i + 1] = Math.round(c[1]);
            band.data[i + 2] = Math.round(c[2]);
            band.data[i + 3] = Math.round(a * 255);
        }
    }
    compositeOver(canvas, band, 0, 0);

    // 3) curved label along the band
    if (label) {
        const center = shape === 'arc' ? ((arcCenter % 360) + 360) % 360 : 90;
        const overlay = await arcText(label, N, R, R - w / 2, w, center, shape === 'arc' ? arcSpan - 16 : 320, p.label_color ?? 'white');
        compositeOver(canvas, overlay, 0, 0);
    }
    return canvas;
}

async function arcText(text: string, N: number, R: number, rt: number, band: number, centerDeg: number, maxSpanDeg: number, color: string): Promise<Img> {
    const font = getFont('bold');
    let fs = Math.floor(band * 0.52);
    let widths: number[] = [], spacing = 0, span = 0;
    for (;;) {
        spacing = fs * 0.06;
        widths = [...text].map(ch => textWidth(ch, fs));
        const total = widths.reduce((a, b) => a + b, 0) + spacing * (text.length - 1);
        span = total / rt;
        if ((span * 180) / Math.PI <= maxSpanDeg || fs <= 8) break;
        fs = Math.floor(fs * 0.9);
    }
    const k = fs / font.unitsPerEm;
    const midY = ((font.ascender + font.descender) / 2) * k; // vertical centre of the glyph box
    const bottom = centerDeg > 0 && centerDeg < 180; // lower half reads left->right counter-clockwise
    const dir = bottom ? -1 : 1;
    let theta = (centerDeg * Math.PI) / 180 - (dir * span) / 2;
    const parts: string[] = [];
    [...text].forEach((ch, idx) => {
        const wch = widths[idx];
        const mid = theta + (dir * (wch / 2)) / rt;
        const px = R + rt * Math.cos(mid), py = R + rt * Math.sin(mid);
        // glyph "up" points to the centre on the bottom half, away from it on the top half
        const rotDeg = bottom ? (mid * 180) / Math.PI - 90 : (mid * 180) / Math.PI - 270;
        const d = pathData(ch, -wch / 2, midY, fs);
        if (d) parts.push(`<path d="${d}" transform="translate(${px.toFixed(2)} ${py.toFixed(2)}) rotate(${rotDeg.toFixed(2)})"/>`);
        theta += (dir * (wch + spacing)) / rt;
    });
    return renderSvg(`<g fill="${cssColor(parseColor(color))}">${parts.join('')}</g>`, N, N);
}
