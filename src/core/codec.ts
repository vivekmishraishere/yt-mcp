/**
 * Decoding (JPG, PNG, WebP, AVIF, GIF, TIFF, SVG via sharp; HEIC/HEIF via libheif WASM; BMP built-in)
 * and encoding to PNG, JPG, WebP, AVIF, GIF, TIFF, BMP, ICO and PDF.
 */
import sharp, { type Sharp, type Metadata } from 'sharp';
import exifReader from 'exif-reader';
import { config } from '../config.js';
import { Img, OpError, flatten, fromSharp, hasAlpha, newImg, toSharp } from './img.js';

sharp.cache(false); // lower memory use on small hosts
sharp.concurrency(Math.max(1, config.sharpThreads));

export const FORMATS = {
    png: { ext: '.png', mime: 'image/png' },
    jpg: { ext: '.jpg', mime: 'image/jpeg' },
    webp: { ext: '.webp', mime: 'image/webp' },
    avif: { ext: '.avif', mime: 'image/avif' },
    gif: { ext: '.gif', mime: 'image/gif' },
    tiff: { ext: '.tif', mime: 'image/tiff' },
    bmp: { ext: '.bmp', mime: 'image/bmp' },
    ico: { ext: '.ico', mime: 'image/x-icon' },
    pdf: { ext: '.pdf', mime: 'application/pdf' },
} as const;
export type FormatKey = keyof typeof FORMATS;
export const FORMAT_KEYS = Object.keys(FORMATS) as FormatKey[];
export const INPUT_FORMATS = ['jpg', 'png', 'webp', 'heic', 'avif', 'gif', 'tiff', 'bmp', 'svg'];

const ALIASES: Record<string, string> = { jpeg: 'jpg', jpe: 'jpg', tif: 'tiff' };

export function normalizeFormat(value: string): FormatKey {
    const k = value.trim().toLowerCase().replace(/^\./, '');
    const key = ALIASES[k] ?? k;
    if (key === 'heic' || key === 'heif')
        throw new OpError("HEIC output isn't supported on this server (HEVC encoding is patent-encumbered). Use 'avif' (same modern efficiency) or 'jpg'.");
    if (!(key in FORMATS)) throw new OpError(`Unsupported format "${value}". Use one of: ${FORMAT_KEYS.join(', ')}.`);
    return key as FormatKey;
}

// ------------------------------------------------------------------ decode

export interface ExifSummary {
    fields: Record<string, string>;
    hasGps: boolean;
}

export interface Decoded {
    img: Img;
    sourceFormat: string | null; // jpg, png, heic, avif, ...
    frames: number;
    exif: ExifSummary | null;
    hasIcc: boolean;
    orientation: number;
    dpi: number | null;
}

const HEIF_BRANDS = ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1', 'avif', 'avis'];

function heifBrand(buf: Buffer): string | null {
    if (buf.length < 12 || buf.toString('ascii', 4, 8) !== 'ftyp') return null;
    const major = buf.toString('ascii', 8, 12);
    return HEIF_BRANDS.includes(major) ? major : null;
}

function summarizeExif(raw: Buffer | undefined): ExifSummary | null {
    if (!raw) return null;
    try {
        const e = exifReader(raw) as unknown as Record<string, Record<string, unknown> | undefined>;
        const fields: Record<string, string> = {};
        const pick = (group: string, keys: string[]) => {
            for (const k of keys) {
                const v = e[group]?.[k];
                if (v !== undefined && v !== null && v !== '') fields[k] = (v instanceof Date ? v.toISOString() : String(v)).slice(0, 80);
            }
        };
        pick('Image', ['Make', 'Model', 'DateTime', 'Software', 'Artist', 'Copyright']);
        pick('Photo', ['DateTimeOriginal', 'LensModel']);
        const gps = e.GPSInfo;
        const hasGps = !!gps && Object.keys(gps).some(k => /Latitude|Longitude/.test(k));
        return { fields, hasGps };
    } catch {
        return null;
    }
}

async function decodeHeif(buf: Buffer): Promise<Img> {
    const { default: decodeHeic } = await import('heic-decode');
    const res = await decodeHeic({ buffer: buf });
    if (res.width * res.height > config.maxPixels)
        throw new OpError(`Image is ${res.width}x${res.height}, above the ${Math.round(config.maxPixels / 1e6)} MP limit.`);
    return { data: Buffer.from(res.data.buffer, res.data.byteOffset, res.data.byteLength), width: res.width, height: res.height };
}

function decodeBmp(buf: Buffer): Img {
    const offset = buf.readUInt32LE(10);
    const headerSize = buf.readUInt32LE(14);
    const width = buf.readInt32LE(18);
    let height = buf.readInt32LE(22);
    const bpp = buf.readUInt16LE(28);
    const compression = buf.readUInt32LE(30);
    if (headerSize < 40 || ![24, 32].includes(bpp) || ![0, 3].includes(compression))
        throw new OpError('Only uncompressed 24/32-bit BMP files are supported.');
    const topDown = height < 0;
    height = Math.abs(height);
    if (width <= 0 || width * height > config.maxPixels) throw new OpError('BMP size is invalid or too large.');
    const bytesPP = bpp / 8;
    const rowSize = Math.ceil((width * bytesPP) / 4) * 4;
    const out = newImg(width, height);
    for (let y = 0; y < height; y++) {
        const srcRow = offset + (topDown ? y : height - 1 - y) * rowSize;
        for (let x = 0; x < width; x++) {
            const s = srcRow + x * bytesPP, d = (y * width + x) * 4;
            out.data[d] = buf[s + 2];
            out.data[d + 1] = buf[s + 1];
            out.data[d + 2] = buf[s];
            out.data[d + 3] = bpp === 32 && compression === 3 ? buf[s + 3] : 255;
        }
    }
    return out;
}

export async function decode(buf: Buffer): Promise<Decoded> {
    if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) {
        return { img: decodeBmp(buf), sourceFormat: 'bmp', frames: 1, exif: null, hasIcc: false, orientation: 1, dpi: null };
    }
    const brand = heifBrand(buf);
    let meta: Metadata | null = null;
    try {
        meta = await sharp(buf, { limitInputPixels: config.maxPixels }).metadata();
    } catch (e) {
        if (!brand) {
            const msg = String((e as Error).message);
            if (/pixel limit/i.test(msg)) throw new OpError(`Image is larger than the ${Math.round(config.maxPixels / 1e6)} megapixel limit.`);
            throw new OpError('Could not read this as an image. Supported inputs: JPG, PNG, WebP, HEIC, AVIF, GIF, TIFF, BMP, SVG.');
        }
    }
    if (meta && (meta.width ?? 0) * (meta.height ?? 0) > config.maxPixels)
        throw new OpError(`Image is ${meta.width}x${meta.height}, above the ${Math.round(config.maxPixels / 1e6)} megapixel limit.`);

    const exif = summarizeExif(meta?.exif);
    const base = { exif, hasIcc: !!meta?.icc, orientation: meta?.orientation ?? 1, dpi: meta?.density ?? null };
    if (meta && meta.format !== 'heif') {
        const img = await fromSharp(sharp(buf, { limitInputPixels: config.maxPixels }).rotate());
        const fmt = meta.format === 'jpeg' ? 'jpg' : meta.format === 'tiff' ? 'tiff' : meta.format;
        return { img, sourceFormat: fmt ?? null, frames: meta.pages ?? 1, ...base };
    }
    // HEIF family: sharp handles AVIF; HEIC (HEVC) needs the libheif WASM decoder.
    if (meta && meta.compression === 'av1') {
        try {
            const img = await fromSharp(sharp(buf, { limitInputPixels: config.maxPixels }).rotate());
            return { img, sourceFormat: 'avif', frames: 1, ...base };
        } catch { /* fall through to libheif */ }
    }
    try {
        return { img: await decodeHeif(buf), sourceFormat: 'heic', frames: 1, ...base };
    } catch (e) {
        if (e instanceof OpError) throw e;
        throw new OpError('Could not decode this HEIC/HEIF file. It may be damaged or use an unsupported variant.');
    }
}

// ------------------------------------------------------------------ encode

export interface EncodeOptions {
    quality?: number;
    lossless?: boolean;
    background?: string;
    /** PNG only: reduce to a palette of this many colors (lossy, much smaller, like TinyPNG). */
    paletteColors?: number;
}

export async function encode(img: Img, fmt: FormatKey, opts: EncodeOptions = {}): Promise<Buffer> {
    const q = Math.round(opts.quality ?? 92);
    const noAlpha = fmt === 'jpg' || fmt === 'bmp' || fmt === 'pdf';
    const src = noAlpha ? flatten(img, opts.background ?? 'white') : img;
    switch (fmt) {
        case 'png':
            return toSharp(src).png(opts.paletteColors
                ? { palette: true, colours: opts.paletteColors, quality: 90, compressionLevel: 9, effort: 8, dither: 1 }
                : { compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
        case 'jpg':
            return toSharp(src).removeAlpha().jpeg({ quality: q, mozjpeg: true, progressive: true, chromaSubsampling: q >= 88 ? '4:4:4' : '4:2:0' }).toBuffer();
        case 'webp':
            return toSharp(src).webp({ quality: q, lossless: !!opts.lossless, effort: 5, alphaQuality: 100 }).toBuffer();
        case 'avif':
            return toSharp(src).avif({ quality: q, lossless: !!opts.lossless, effort: 4 }).toBuffer();
        case 'gif':
            return toSharp(src).gif({ effort: 7, dither: 0.5 }).toBuffer();
        case 'tiff':
            return toSharp(src).tiff({ compression: 'lzw' }).toBuffer();
        case 'bmp':
            return encodeBmp(src);
        case 'ico':
            return encodeIco(img);
        case 'pdf':
            return encodePdf(await toSharp(src).removeAlpha().jpeg({ quality: Math.max(q, 90), mozjpeg: true }).toBuffer(), src.width, src.height);
    }
}

function encodeBmp(img: Img): Buffer {
    const rowSize = Math.ceil((img.width * 3) / 4) * 4;
    const size = 54 + rowSize * img.height;
    const b = Buffer.alloc(size);
    b.write('BM', 0, 'ascii');
    b.writeUInt32LE(size, 2);
    b.writeUInt32LE(54, 10);
    b.writeUInt32LE(40, 14);
    b.writeInt32LE(img.width, 18);
    b.writeInt32LE(img.height, 22);
    b.writeUInt16LE(1, 26);
    b.writeUInt16LE(24, 28);
    b.writeUInt32LE(rowSize * img.height, 34);
    b.writeInt32LE(2835, 38);
    b.writeInt32LE(2835, 42);
    for (let y = 0; y < img.height; y++) {
        const row = 54 + (img.height - 1 - y) * rowSize;
        for (let x = 0; x < img.width; x++) {
            const s = (y * img.width + x) * 4, d = row + x * 3;
            b[d] = img.data[s + 2];
            b[d + 1] = img.data[s + 1];
            b[d + 2] = img.data[s];
        }
    }
    return b;
}

async function encodeIco(img: Img): Promise<Buffer> {
    const side = Math.max(img.width, img.height);
    const sizes = [16, 24, 32, 48, 64, 128, 256].filter(s => s <= Math.max(16, side));
    const pngs: Buffer[] = [];
    for (const s of sizes) {
        pngs.push(await toSharp(img).resize(s, s, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 }, kernel: 'lanczos3' }).png().toBuffer());
    }
    const header = Buffer.alloc(6 + 16 * sizes.length);
    header.writeUInt16LE(0, 0);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(sizes.length, 4);
    let offset = header.length;
    sizes.forEach((s, i) => {
        const e = 6 + i * 16;
        header[e] = s >= 256 ? 0 : s;
        header[e + 1] = s >= 256 ? 0 : s;
        header.writeUInt16LE(1, e + 4); // planes
        header.writeUInt16LE(32, e + 6); // bpp
        header.writeUInt32LE(pngs[i].length, e + 8);
        header.writeUInt32LE(offset, e + 12);
        offset += pngs[i].length;
    });
    return Buffer.concat([header, ...pngs]);
}

function encodePdf(jpeg: Buffer, w: number, h: number): Buffer {
    // One page, image placed at 300 DPI.
    const pw = ((w * 72) / 300).toFixed(2), ph = ((h * 72) / 300).toFixed(2);
    const content = `q ${pw} 0 0 ${ph} 0 0 cm /Im0 Do Q`;
    const parts: (string | Buffer)[] = [];
    const offsets: number[] = [];
    let len = 0;
    const push = (p: string | Buffer) => { parts.push(p); len += typeof p === 'string' ? Buffer.byteLength(p, 'latin1') : p.length; };
    push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
    const obj = (n: number, body: string | (string | Buffer)[]) => {
        offsets[n] = len;
        push(`${n} 0 obj\n`);
        (Array.isArray(body) ? body : [body]).forEach(push);
        push('\nendobj\n');
    };
    obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
    obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
    obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`);
    obj(4, [`<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`, jpeg, '\nendstream']);
    obj(5, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    const xref = len;
    let x = 'xref\n0 6\n0000000000 65535 f \n';
    for (let n = 1; n <= 5; n++) x += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
    push(x + `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    return Buffer.concat(parts.map(p => (typeof p === 'string' ? Buffer.from(p, 'latin1') : p)));
}

/**
 * Remove EXIF/XMP/IPTC/comments from a JPEG without re-compressing (bit-exact image data).
 * Returns null when the photo relies on EXIF orientation (removing it would show the photo sideways).
 */
export function stripJpegMetadata(buf: Buffer, orientation: number): Buffer | null {
    if (orientation && orientation !== 1) return null;
    if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
    const keep: Buffer[] = [buf.subarray(0, 2)];
    let i = 2;
    while (i + 4 <= buf.length) {
        if (buf[i] !== 0xff) return null;
        const marker = buf[i + 1];
        if (marker === 0xda) { keep.push(buf.subarray(i)); return Buffer.concat(keep); } // start of scan: rest is image data
        const segLen = buf.readUInt16BE(i + 2);
        const drop = marker === 0xe1 || marker === 0xed || marker === 0xfe; // APP1 (EXIF/XMP), APP13 (IPTC), COM
        if (!drop) keep.push(buf.subarray(i, i + 2 + segLen));
        i += 2 + segLen;
    }
    return null;
}

export function defaultFormat(sourceFormat: string | null, img: Img, frames = 1): FormatKey {
    let key: string = sourceFormat ?? 'png';
    if (['heic', 'ico', 'pdf', 'svg'].includes(key)) key = 'jpg';
    if (key === 'gif' && frames <= 1) key = 'png';
    if (!(key in FORMATS)) key = 'png';
    if (hasAlpha(img) && (key === 'jpg' || key === 'bmp')) key = 'png';
    return key as FormatKey;
}
