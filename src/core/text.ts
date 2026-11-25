/**
 * Text rendering that works the same on every machine: glyphs are converted to vector paths with
 * opentype.js from a bundled DejaVu font, then rasterised by sharp (librsvg). No system fonts needed.
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import opentype from 'opentype.js';
import sharp from 'sharp';
import { Img, fromSharp } from './img.js';

const require = createRequire(import.meta.url);
const FONT_FILES = {
    bold: 'dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf',
    regular: 'dejavu-fonts-ttf/ttf/DejaVuSans.ttf',
} as const;
export type Weight = keyof typeof FONT_FILES;

const cache = new Map<Weight, opentype.Font>();

export function getFont(weight: Weight = 'bold'): opentype.Font {
    let f = cache.get(weight);
    if (!f) {
        const buf = fs.readFileSync(require.resolve(FONT_FILES[weight]));
        f = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
        cache.set(weight, f);
    }
    return f;
}

/**
 * Simple left-to-right layout: glyph lookup + kerning, no OpenType shaping. (opentype.js's shaper throws on some
 * DejaVu substitution tables; Latin text does not need shaping.)
 */
function layout(text: string, size: number, weight: Weight): { glyphs: opentype.Glyph[]; xs: number[]; width: number } {
    const font = getFont(weight);
    const k = size / font.unitsPerEm;
    const glyphs = [...text].map(ch => font.charToGlyph(ch));
    const xs: number[] = [];
    let x = 0;
    glyphs.forEach((g, i) => {
        if (i > 0) x += font.getKerningValue(glyphs[i - 1], g) * k;
        xs.push(x);
        x += (g.advanceWidth ?? font.unitsPerEm * 0.5) * k;
    });
    return { glyphs, xs, width: x };
}

export function textWidth(text: string, size: number, weight: Weight = 'bold'): number {
    return layout(text, size, weight).width;
}

/** Vertical metrics in pixels for a font size. */
export function metrics(size: number, weight: Weight = 'bold') {
    const f = getFont(weight);
    const k = size / f.unitsPerEm;
    return { ascent: f.ascender * k, descent: -f.descender * k, lineHeight: (f.ascender - f.descender) * k + size * 0.2 };
}

/** SVG path data for `text` with its baseline-left at (x, y). */
export function pathData(text: string, x: number, y: number, size: number, weight: Weight = 'bold'): string {
    const { glyphs, xs } = layout(text, size, weight);
    const n = (v: number) => (Math.abs(v) < 0.005 ? '0' : v.toFixed(2));
    const parts: string[] = [];
    glyphs.forEach((g, i) => {
        // Write commands ourselves with explicit separators and close every contour (Z). opentype's compact
        // toPathData() output leaves contours open, which librsvg mis-fills for some glyphs (e.g. "O").
        let open = false;
        for (const c of g.getPath(x + xs[i], y, size).commands as any[]) {
            if (c.type === 'M') {
                if (open) parts.push('Z');
                parts.push(`M ${n(c.x)} ${n(c.y)}`);
                open = true;
            } else if (c.type === 'L') parts.push(`L ${n(c.x)} ${n(c.y)}`);
            else if (c.type === 'Q') parts.push(`Q ${n(c.x1)} ${n(c.y1)} ${n(c.x)} ${n(c.y)}`);
            else if (c.type === 'C') parts.push(`C ${n(c.x1)} ${n(c.y1)} ${n(c.x2)} ${n(c.y2)} ${n(c.x)} ${n(c.y)}`);
            else if (c.type === 'Z') { parts.push('Z'); open = false; }
        }
        if (open) parts.push('Z');
    });
    return parts.join(' ');
}

export function escapeAttr(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/** Rasterise an SVG of exactly width x height pixels into an RGBA Img. */
export async function renderSvg(svgBody: string, width: number, height: number): Promise<Img> {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${svgBody}</svg>`;
    return fromSharp(sharp(Buffer.from(svg), { density: 72, limitInputPixels: false }).resize(width, height, { fit: 'fill' }));
}

/** Greedy word wrap to a maximum pixel width; keeps manual line breaks. */
export function wrap(text: string, size: number, maxWidth: number, weight: Weight = 'bold'): string[] {
    const lines: string[] = [];
    for (const para of text.split('\n')) {
        let line = '';
        for (const word of para.split(' ')) {
            const trial = line ? `${line} ${word}` : word;
            if (!line || textWidth(trial, size, weight) <= maxWidth) line = trial;
            else {
                lines.push(line);
                line = word;
            }
        }
        lines.push(line);
    }
    return lines;
}
