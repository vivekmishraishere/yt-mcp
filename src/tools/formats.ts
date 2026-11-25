/** Format conversion (incl. HEIC input), compression, batch conversion, metadata stripping, icon sets. */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/server';
import { config } from '../config.js';
import { FORMATS, FormatKey, defaultFormat, encode, normalizeFormat, stripJpegMetadata } from '../core/codec.js';
import { Img, OpError, hasAlpha, viaSharp } from '../core/img.js';
import { IMAGE_EXTENSIONS, Saved, humanSize, loadImage, reply, resolveLocalPath, saveBytes, savedReply } from '../core/io.js';
import { resize } from '../core/ops/geometry.js';
import { safeStem } from '../core/storage.js';
import { imageSource, registerTool, z } from './common.js';

const TARGETS = ['png', 'jpg', 'webp', 'avif', 'gif', 'tiff', 'bmp', 'ico', 'pdf'] as const;
const LOSSY = new Set<FormatKey>(['jpg', 'webp', 'avif']);
const LEVEL_Q = { high: 90, balanced: 80, small: 66 } as const;

async function shrink(img: Img, maxDim?: number | null): Promise<Img> {
    if (!maxDim || Math.max(img.width, img.height) <= maxDim) return img;
    return viaSharp(img, s => s.resize(maxDim, maxDim, { fit: 'inside', kernel: 'lanczos3' }));
}

export function register(server: McpServer): void {
    registerTool(server, 'convert_image_format', {
        title: 'Convert image format',
        description: 'Creates a copy of an image in another file format: HEIC -> JPG/PNG, PNG -> JPG/WebP, JPG -> PNG, anything -> WebP/AVIF/' +
            'GIF/TIFF/BMP/ICO (favicon)/PDF. Camera metadata is removed. (HEIC can be read but not written: use avif or jpg.)',
        input: z.object({
            image: imageSource(),
            format: z.enum(TARGETS).describe('Target format. jpg is the most compatible, webp/avif are smallest for the web, png keeps transparency.'),
            quality: z.number().int().min(1).max(100).default(92).describe('Quality for jpg/webp/avif (default 92 = visually lossless).'),
            background: z.string().default('white').describe('Color used behind transparent areas when converting to jpg/bmp/pdf.'),
        }),
    }, async a => {
        const l = await loadImage(a.image);
        const key = normalizeFormat(a.format);
        const data = await encode(l.img, key, { quality: a.quality, background: a.background });
        return savedReply(await saveBytes(data, l.img, l.name, 'converted', key), l, { converted: `${l.sourceFormat} -> ${key}` });
    });

    registerTool(server, 'compress_image', {
        title: 'Compress image',
        description: 'Creates a smaller copy of an image while keeping quality as high as possible: strips metadata, uses optimised encoders ' +
            '(MozJPEG, libwebp, AVIF, palette PNG) and can hit a target file size. Reports before/after size and % saved. If the image is ' +
            'already optimal, it keeps the original instead of making it worse.',
        input: z.object({
            image: imageSource(),
            level: z.enum(['lossless', 'high', 'balanced', 'small']).default('high').describe('lossless = zero quality loss; high = visually identical (~q90, default); balanced = tiny differences, much smaller (~q80); small = smallest (~q66).'),
            target_kb: z.number().int().min(5).max(50000).optional().describe('Aim for a maximum file size in KB (e.g. 200 for a 200 KB upload limit). Overrides level.'),
            format: z.enum(['keep', 'jpg', 'webp', 'avif', 'png']).default('keep').describe("Output format. 'keep' = same as input (HEIC -> jpg). webp/avif usually give the smallest files."),
            max_dimension: z.number().int().min(16).max(16000).optional().describe('Also shrink so the longest side is at most this many pixels (e.g. 2048).'),
        }),
    }, async a => {
        const l = await loadImage(a.image);
        let img = await shrink(l.img, a.max_dimension);
        let key: FormatKey = a.format === 'keep' ? defaultFormat(l.sourceFormat, img, l.frames) : normalizeFormat(a.format);
        if (!['jpg', 'webp', 'avif', 'png'].includes(key)) key = hasAlpha(img) ? 'png' : 'jpg';
        if (hasAlpha(img) && key === 'jpg') key = 'png';
        const notes: string[] = [];
        let data: Buffer | null = null;

        if (a.target_kb) {
            const limit = a.target_kb * 1024;
            for (let round = 0; round < 10 && !data; round++) {
                if (LOSSY.has(key)) {
                    let lo = 25, hi = 95, best: Buffer | null = null, bestQ = 0;
                    while (lo <= hi) {
                        const mid = (lo + hi) >> 1;
                        const attempt = await encode(img, key, { quality: mid });
                        if (attempt.length <= limit) { best = attempt; bestQ = mid; lo = mid + 1; } else hi = mid - 1;
                    }
                    if (best) { data = best; notes.push(`quality ${bestQ}`); }
                } else {
                    for (const colors of [0, 256, 128, 64]) {
                        const attempt = await encode(img, 'png', { paletteColors: colors || undefined });
                        if (attempt.length <= limit) { data = attempt; if (colors) notes.push(`reduced to ${colors} colors`); break; }
                    }
                }
                if (!data) img = await resize(img, { width: Math.max(1, Math.floor(img.width * 0.85)), height: Math.max(1, Math.floor(img.height * 0.85)), fit: 'stretch' });
            }
            if (!data) throw new OpError(`Could not reach ${a.target_kb} KB even after shrinking. Try format='webp' or a larger target.`);
            if (img.width !== l.img.width) notes.push(`downscaled to ${img.width}x${img.height}`);
        } else if (a.level === 'lossless') {
            const kept = key === 'jpg' && l.sourceFormat === 'jpg' && img === l.img ? stripJpegMetadata(l.raw, l.orientation) : null;
            if (kept) { data = kept; notes.push('original JPEG data kept bit-for-bit, only metadata removed'); }
            else if (key === 'jpg') { data = await encode(img, 'jpg', { quality: 95 }); notes.push('re-encoded at q95 (EXIF rotation or resize prevented a bit-exact save)'); }
            else if (key === 'webp') data = await encode(img, 'webp', { lossless: true });
            else if (key === 'avif') { data = await encode(img, 'avif', { quality: 100 }); notes.push('AVIF at q100 (near-lossless)'); }
            else data = await encode(img, 'png');
        } else {
            if (key === 'png') {
                data = await encode(img, 'png', { paletteColors: a.level === 'high' ? undefined : a.level === 'balanced' ? 256 : 128 });
                if (a.level !== 'high') notes.push('PNG color palette reduced (like TinyPNG)');
            } else data = await encode(img, key, { quality: LEVEL_Q[a.level] });
        }

        const sameShape = img.width === l.img.width && img.height === l.img.height && key === (l.sourceFormat ?? key);
        if (sameShape && data.length >= l.raw.length) {
            data = l.raw;
            notes.push('already well compressed: kept the original bytes (any other setting would be larger)');
        }
        const saved = await saveBytes(data, img, l.name, 'compressed', key);
        return savedReply(saved, l, {
            level: a.target_kb ? undefined : a.level, target_kb: a.target_kb,
            saved_percent: Math.round(1000 * (1 - data.length / Math.max(1, l.raw.length))) / 10,
            size_change: `${humanSize(l.raw.length)} -> ${humanSize(data.length)}`, notes: notes.length ? notes : undefined,
        });
    });

    registerTool(server, 'batch_convert_images', {
        title: 'Batch convert images',
        description: config.mode === 'http'
            ? 'Converts a list of images (URLs / links from earlier tools, up to 50) to one format, e.g. HEIC -> JPG. Returns a link for each result and any failures.'
            : 'Converts every image in a folder to one format (for example all iPhone HEIC photos to JPG) into a new batch folder inside the output directory. Originals are untouched.',
        input: z.object({
            folder: z.string().optional().describe("Local mode: absolute folder path, e.g. '/Users/me/Pictures/iPhone'."),
            images: z.array(z.string()).max(50).optional().describe('Remote mode (or local): list of images to convert.'),
            to_format: z.enum(TARGETS).describe("Format to convert every image to, e.g. 'jpg' for HEIC photos."),
            only_extension: z.string().optional().describe("Folder mode: only convert files with this extension, e.g. 'heic'."),
            quality: z.number().int().min(1).max(100).default(92).describe('Quality for lossy formats (default 92).'),
            max_dimension: z.number().int().min(16).max(16000).optional().describe('Optionally shrink so the longest side is at most this.'),
            recursive: z.boolean().default(false).describe('Folder mode: include sub-folders.'),
            limit: z.number().int().min(1).max(500).default(100).describe('Maximum files to process (default 100).'),
        }),
    }, async a => {
        const key = normalizeFormat(a.to_format);
        let sources: string[] = a.images ?? [];
        let outDir: string | undefined;
        if (a.folder) {
            const root = await resolveLocalPath(a.folder);
            const ext = a.only_extension ? '.' + a.only_extension.toLowerCase().replace(/^\./, '') : null;
            const names = a.recursive ? (await fs.readdir(root, { recursive: true })) as string[] : await fs.readdir(root);
            sources = names.filter(n => !path.basename(n).startsWith('.') && IMAGE_EXTENSIONS.has(path.extname(n).toLowerCase()) && (!ext || path.extname(n).toLowerCase() === ext))
                .sort().map(n => path.join(root, n));
            if (config.mode === 'stdio') outDir = path.join(config.storageDir, `batch_${key}_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`);
        }
        if (!sources.length) throw new OpError(a.folder ? 'No matching images in that folder.' : 'Give images=[...] (or, locally, a folder).');
        const done: string[] = [], failed: { file: string; error: string }[] = [];
        let before = 0, after = 0;
        for (const src of sources.slice(0, a.limit)) {
            try {
                const l = await loadImage(src);
                const img = await shrink(l.img, a.max_dimension);
                const data = await encode(img, key, { quality: a.quality });
                const saved: Saved = await saveBytes(data, img, l.name, '', key, outDir);
                done.push(saved.ref);
                before += l.raw.length;
                after += data.length;
            } catch (e) {
                failed.push({ file: src.length > 120 ? src.slice(0, 117) + '...' : src, error: String((e as Error).message).slice(0, 160) });
            }
        }
        return reply({
            output_folder: outDir, converted: done.length, failed: failed.length ? failed : undefined,
            skipped_over_limit: sources.length > a.limit ? sources.length - a.limit : undefined,
            total_size: `${humanSize(before)} -> ${humanSize(after)}`,
            files: done.slice(0, 50).concat(done.length > 50 ? [`... and ${done.length - 50} more`] : []),
        });
    });

    registerTool(server, 'strip_image_metadata', {
        title: 'Strip metadata',
        description: 'Creates a copy with all EXIF metadata removed: GPS location, camera, date, software. JPEGs keep their exact image data ' +
            '(no re-compression) when possible. Use before sharing photos publicly.',
        input: z.object({ image: imageSource() }),
    }, async a => {
        const l = await loadImage(a.image);
        const key = defaultFormat(l.sourceFormat, l.img, l.frames);
        let data = key === 'jpg' && l.sourceFormat === 'jpg' ? stripJpegMetadata(l.raw, l.orientation) : null;
        let method = 'original image data kept, metadata removed';
        if (!data) {
            const lossless = ['png', 'gif', 'tiff', 'bmp'].includes(key);
            data = await encode(l.img, key, { quality: 95, lossless: key === 'webp' });
            method = lossless || key === 'webp' ? 'lossless re-save' : 're-encoded at quality 95';
        }
        const saved = await saveBytes(data, l.img, l.name, 'clean', key);
        return savedReply(saved, l, { removed_exif_fields: l.exif ? Object.keys(l.exif.fields).length : 0, removed_gps_location: l.exif?.hasGps ?? false, method }, false);
    });

    registerTool(server, 'create_icon_set', {
        title: 'Create icon set',
        description: 'Creates square app/website icons from one image: PNGs at each size plus a multi-size favicon.ico. Non-square images are centred and padded.',
        input: z.object({
            image: imageSource(),
            sizes: z.array(z.number().int().min(8).max(2048)).max(20).optional().describe('PNG sizes in pixels. Default: 16, 32, 48, 64, 128, 180 (Apple touch), 192, 256, 512.'),
            background: z.string().default('transparent').describe('Fill if the image is not square.'),
        }),
    }, async a => {
        const l = await loadImage(a.image);
        const sizes = [...new Set(a.sizes ?? [16, 32, 48, 64, 128, 180, 192, 256, 512])].sort((x, y) => x - y);
        const side = Math.max(l.img.width, l.img.height);
        const square = await resize(l.img, { width: side, height: side, fit: 'pad', background: a.background });
        const dir = config.mode === 'stdio' ? path.join(config.storageDir, `${safeStem(l.name)}_icons-${Date.now().toString(36)}`) : undefined;
        const files: string[] = [];
        for (const s of sizes) {
            const icon = await viaSharp(square, x => x.resize(s, s, { kernel: 'lanczos3' }));
            files.push((await saveBytes(await encode(icon, 'png'), icon, config.mode === 'stdio' ? 'icon' : l.name, `${s}x${s}`, 'png', dir)).ref);
        }
        const fav = await viaSharp(square, x => x.resize(256, 256, { kernel: 'lanczos3' }));
        files.push((await saveBytes(await encode(fav, 'ico'), fav, config.mode === 'stdio' ? 'favicon' : l.name, config.mode === 'stdio' ? '' : 'favicon', 'ico', dir)).ref);
        return reply({ output_folder: dir, files }, fav);
    });
}

export { FORMATS };
