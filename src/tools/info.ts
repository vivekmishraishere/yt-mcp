/** Read-only tools: image info, listing, color palette, face detection. */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/server';
import { config } from '../config.js';
import { OpError, hasAlpha } from '../core/img.js';
import { IMAGE_EXTENSIONS, humanSize, loadImage, reply, resolveLocalPath } from '../core/io.js';
import { detectFaces } from '../core/ops/faces.js';
import { drawBoxes, drawGrid, palette, paletteSwatch } from '../core/ops/overlay.js';
import { listStored } from '../core/storage.js';
import { imageSource, registerTool, z } from './common.js';

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
function ratio(w: number, h: number): string {
    const g = gcd(w, h), a = w / g, b = h / g;
    return a <= 50 && b <= 50 ? `${a}:${b}` : `${(w / h).toFixed(3)}:1`;
}

export function register(server: McpServer): void {
    registerTool(server, 'get_image_info', {
        title: 'Get image info',
        readOnly: true,
        description: "Reads an image's details without changing it: width, height, megapixels, aspect ratio, format, file size, " +
            'transparency, DPI, camera EXIF (make, model, date) and whether it contains GPS location, plus a preview so you can see ' +
            'the image. With grid=true the preview has a labelled pixel grid (red = x, blue = y, every 10%): use it to read off ' +
            'exact coordinates for crop_image boxes or blur_image regions, e.g. on drawings where face detection does not work.',
        input: z.object({
            image: imageSource(),
            preview: z.boolean().default(true).describe('Attach a preview image (default true).'),
            grid: z.boolean().default(false).describe('Draw a labelled pixel-coordinate grid on the preview, to pick exact regions.'),
        }),
    }, async ({ image, preview, grid }) => {
        const l = await loadImage(image);
        const { width: w, height: h } = l.img;
        const info: Record<string, unknown> = {
            source: l.path ?? (image.startsWith('http') ? image.slice(0, 200) : 'base64'),
            width: w, height: h, megapixels: Math.round((w * h) / 10_000) / 100, aspect_ratio: ratio(w, h),
            orientation: w > h ? 'landscape' : h > w ? 'portrait' : 'square',
            format: l.sourceFormat, file_size: humanSize(l.raw.length), has_transparency: hasAlpha(l.img), frames: l.frames,
            dpi: l.dpi, has_color_profile: l.hasIcc, has_gps_location: l.exif?.hasGps ?? false,
            exif: l.exif && Object.keys(l.exif.fields).length ? l.exif.fields : null,
        };
        if (l.exif?.hasGps) info.privacy_note = 'This photo contains GPS location. Use strip_image_metadata before sharing.';
        if (grid) info.grid = `Lines every 10%: red labels = x in pixels, blue labels = y in pixels, of the full ${w}x${h} image.`;
        return reply(info, preview || grid ? (grid ? await drawGrid(l.img) : l.img) : null);
    });

    registerTool(server, 'list_images', {
        title: config.mode === 'http' ? (config.openAccess ? 'List images (not available on a public server)' : 'List recent images on the server') : 'List images in a folder',
        readOnly: true,
        description: config.mode === 'http' && config.openAccess
            ? 'Not available on this public server (files are private to whoever has their link), so do not use it to find the ' +
              "user's image. Use the `output` link of an earlier result, or call create_upload_link to get a new image in."
            : config.mode === 'http'
            ? 'Lists the most recent images stored on this server (your uploads and every tool result), newest first, with links ' +
              'you can pass to any other tool. Files expire after ' + config.fileTtlHours + ' hours.'
            : "Lists image files (JPG, PNG, HEIC, WebP, AVIF, GIF, TIFF, BMP) in a folder with size and date, newest first by default. " +
              "Use it to find the file path when the user says 'my latest screenshot' or 'the photo in Downloads'.",
        input: z.object({
            folder: z.string().optional().describe(config.mode === 'http' ? 'Ignored on the remote server.' : "Absolute folder path, e.g. '/Users/me/Downloads' or '~/Desktop'."),
            sort: z.enum(['newest', 'oldest', 'name', 'largest']).default('newest').describe('Sort order.'),
            limit: z.number().int().min(1).max(200).default(20).describe('Max files to return (default 20).'),
            offset: z.number().int().min(0).default(0).describe('Skip this many files, for paging (default 0).'),
            recursive: z.boolean().default(false).describe('Also look inside sub-folders (local only).'),
        }),
    }, async ({ folder, sort, limit, offset, recursive }) => {
        if (config.mode === 'http' && config.openAccess) {
            throw new OpError('This is a public server, so stored images are not listed (they are private to whoever has the link). ' +
                'Use the `output` link from an earlier result, or call create_upload_link and ask the user to upload the image.');
        }
        if (config.mode === 'http') {
            const items = await listStored(offset + limit);
            return reply({ total_shown: items.slice(offset).length, images: items.slice(offset).map(i => ({ image: i.ref, file_size: humanSize(i.size), modified: i.modified.toISOString() })) });
        }
        if (!folder) throw new OpError('Give the folder to list, e.g. ~/Downloads.');
        const root = await resolveLocalPath(folder);
        if (!(await fs.stat(root)).isDirectory()) throw new OpError(`${root} is not a folder.`);
        const names = recursive ? (await fs.readdir(root, { recursive: true })) as string[] : await fs.readdir(root);
        const files = (await Promise.all(names.filter(n => IMAGE_EXTENSIONS.has(path.extname(n).toLowerCase()) && !path.basename(n).startsWith('.'))
            .map(async n => ({ p: path.join(root, n), s: await fs.stat(path.join(root, n)).catch(() => null) }))))
            .filter(f => f.s?.isFile());
        const key = { newest: (f: any) => -f.s.mtimeMs, oldest: (f: any) => f.s.mtimeMs, name: (f: any) => f.p.toLowerCase(), largest: (f: any) => -f.s.size }[sort];
        files.sort((a, b) => { const ka = key(a), kb = key(b); return ka < kb ? -1 : ka > kb ? 1 : 0; });
        const page = files.slice(offset, offset + limit);
        return reply({
            folder: root, total_images: files.length, returned: page.length, offset,
            images: page.map(f => ({ path: f.p, file_size: humanSize(f.s!.size), modified: f.s!.mtime.toISOString().slice(0, 16).replace('T', ' ') })),
            next_offset: offset + limit < files.length ? offset + limit : undefined,
        });
    });

    registerTool(server, 'extract_color_palette', {
        title: 'Extract color palette',
        readOnly: true,
        description: 'Finds the dominant colors of an image and returns them as hex codes with their share (%), plus a swatch preview. ' +
            'Useful for picking brand colors, text colors, or a matching profile-ring color. Does not save any file.',
        input: z.object({ image: imageSource(), count: z.number().int().min(1).max(16).default(6).describe('How many colors (default 6).') }),
    }, async ({ image, count }) => {
        const colors = await palette((await loadImage(image)).img, count);
        return reply({ colors: colors.map(([hex, percent]) => ({ hex, percent })) }, paletteSwatch(colors));
    });

    registerTool(server, 'detect_faces', {
        title: 'Detect faces',
        readOnly: true,
        description: "Finds faces in a photo and returns each one's box (x, y, width, height), numbered biggest first, plus a preview " +
            'with numbered boxes drawn on it. Does not save a file. Use the boxes with blur_image(regions=[...]) to blur only some faces, ' +
            'with crop_image to crop a face, or focus_x/focus_y for profile pictures. Classic detector: works on real photos; for drawings ' +
            'and cartoons it returns a grid preview so you can give blur_image the regions by hand.',
        input: z.object({
            image: imageSource(),
            sensitivity: z.enum(['strict', 'balanced', 'loose']).default('balanced').describe('strict = fewer false hits, loose = finds more small or angled faces.'),
        }),
    }, async ({ image, sensitivity }) => {
        const l = await loadImage(image);
        const faces = await detectFaces(l.img, sensitivity);
        const W = l.img.width, H = l.img.height;
        const out = faces.map(f => ({ ...f, focus_x: Math.round(((f.x + f.width / 2) / W) * 1000) / 1000, focus_y: Math.round(((f.y + f.height / 2) / H) * 1000) / 1000 }));
        return reply({
            faces_found: faces.length, image_size: [W, H], faces: out,
            hint: faces.length ? undefined
                : "No faces found. For a photo, try sensitivity='loose'. For drawings, cartoons, logos or anything the detector " +
                  'missed: the attached preview has a labelled pixel grid (red = x, blue = y); read the area from it and call ' +
                  'blur_image with regions=[{x, y, width, height}] (shape "ellipse" suits faces).',
        }, faces.length ? await drawBoxes(l.img, faces) : await drawGrid(l.img));
    });
}
