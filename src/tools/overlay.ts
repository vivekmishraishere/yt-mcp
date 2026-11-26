/** Text, watermark, solid background removal, collage, pipeline, and saving / uploading. */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/server';
import { makeUploadToken } from '../auth.js';
import { config } from '../config.js';
import { defaultFormat, encode, FORMATS } from '../core/codec.js';
import { OpError, hasAlpha } from '../core/img.js';
import { humanSize, loadImage, reply, resolveLocalPath, saveResult, savedReply } from '../core/io.js';
import { collage } from '../core/ops/geometry.js';
import { addText, addWatermark, removeSolidBackground } from '../core/ops/overlay.js';
import { PIPELINE_OPS, runPipeline } from '../core/ops/pipeline.js';
import { baseUrl, safeStem } from '../core/storage.js';
import { color, imageSource, outputFormat, position, registerTool, z } from './common.js';

export function register(server: McpServer): void {
    registerTool(server, 'add_text_to_image', {
        title: 'Add text',
        description: 'Creates a copy of an image with a caption, title or label drawn on it (meme text, thumbnail headline, quote card). ' +
            'Supports position, size, color, outline and a background box.',
        input: z.object({
            image: imageSource(),
            text: z.string().min(1).max(500).describe('The text. Long lines wrap automatically; use \\n for a manual line break.'),
            position: position('bottom').describe('Where to place it (default bottom).'),
            font_size: z.number().int().min(6).max(1000).optional().describe('Font size in pixels (default ~7% of the short side).'),
            color: color('white', 'Text color'),
            stroke_color: z.string().nullable().default('black').describe('Outline color for readability (default black). null = no outline.'),
            box_color: z.string().optional().describe("Optional rounded box behind the text, e.g. '#000000A0' for translucent black."),
            weight: z.enum(['bold', 'regular']).default('bold').describe('Font weight.'),
            output_format: outputFormat(),
        }),
    }, async a => {
        const l = await loadImage(a.image);
        return savedReply(await saveResult(await addText(l.img, a), l, 'text', a.output_format), l);
    });

    registerTool(server, 'add_watermark', {
        title: 'Add watermark',
        description: 'Creates a copy of an image with a text and/or logo watermark, in a corner or tiled across the image, with adjustable ' +
            'opacity and size. Use it to protect photos before posting.',
        input: z.object({
            image: imageSource(),
            text: z.string().max(100).optional().describe("Watermark text, e.g. '© Vivek Mishra' or '@handle'."),
            logo: z.string().optional().describe('Optional logo image (URL / link / base64, or a path locally); PNG with transparency works best.'),
            position: position('bottom_right').describe('Where to place a single watermark.'),
            opacity: z.number().min(0).max(1).default(0.35).describe('0 = invisible, 1 = solid (default 0.35).'),
            tiled: z.boolean().default(false).describe('Repeat the watermark across the whole image (harder to crop out).'),
            scale: z.number().min(0.02).max(1).default(0.2).describe('Size: logo width as a fraction of the image width; for text, larger = bigger.'),
            color: color('white', 'Text color'),
            output_format: outputFormat(),
        }),
    }, async a => {
        const l = await loadImage(a.image);
        const logo = a.logo ? (await loadImage(a.logo)).img : null;
        return savedReply(await saveResult(await addWatermark(l.img, a, logo), l, 'watermarked', a.output_format), l);
    });

    registerTool(server, 'remove_solid_background', {
        title: 'Remove solid background',
        description: 'Creates a transparent PNG by removing a plain, solid-color background (white, green screen, a flat color). Best for logos, ' +
            'signatures, product shots on white and screenshots. Classic color-keying, not AI: busy photo backgrounds will not be removed cleanly.',
        input: z.object({
            image: imageSource(),
            color: z.string().default('auto').describe("Background color to remove, or 'auto' (default) to detect it from the corners."),
            tolerance: z.number().int().min(0).max(255).default(40).describe('How close a pixel must be to that color to be removed (raise for shadows/gradients).'),
            mode: z.enum(['edges', 'everywhere']).default('edges').describe('edges = only background connected to the border (keeps white inside the subject); everywhere = every matching pixel.'),
            feather: z.number().min(0).max(10).default(1).describe('Softens the cut edge in pixels (default 1).'),
        }),
    }, async a => {
        const l = await loadImage(a.image);
        return savedReply(await saveResult(await removeSolidBackground(l.img, a), l, 'nobg', 'png'), l);
    });

    registerTool(server, 'create_collage', {
        title: 'Create collage',
        description: 'Creates a grid collage from several images (photo dump, before/after, product grid).',
        input: z.object({
            images: z.array(z.string()).min(2).max(36).describe('2-36 images, placed left-to-right, top-to-bottom.'),
            columns: z.number().int().min(1).max(12).optional().describe('Number of columns (default: a near-square grid).'),
            cell_size: z.number().int().min(64).max(2000).default(600).describe('Size of each square cell in pixels.'),
            gap: z.number().int().min(0).max(200).default(12).describe('Space between cells in pixels.'),
            background: color('white', 'Background color'),
            fit: z.enum(['cover', 'contain']).default('cover').describe('cover = fill each cell (crops), contain = show whole image.'),
            output_format: outputFormat(),
        }),
    }, async a => {
        const loaded = [];
        for (const s of a.images) loaded.push(await loadImage(s));
        const out = await collage(loaded.map(x => x.img), a);
        const fmt = a.output_format !== 'keep' ? a.output_format : hasAlpha(out) ? 'png' : 'jpg';
        return savedReply(await saveResult(out, loaded[0], `collage${loaded.length}`, fmt), null, { images_used: loaded.length });
    });

    registerTool(server, 'run_image_pipeline', {
        title: 'Run an image pipeline',
        description: 'Applies several edits in one go and saves once (faster, no quality loss from saving in between). Use it whenever the ' +
            "user asks for 2+ edits, e.g. 'crop to square, make it warmer, add my name, convert to webp'.",
        input: z.object({
            image: imageSource(),
            steps: z.array(z.record(z.string(), z.unknown())).min(1).max(25).describe(
                'Ordered steps, each {"op": <name>, ...params}. Ops and params match the single tools: ' + Object.keys(PIPELINE_OPS).join(', ') +
                '. Example: [{"op":"crop_aspect","aspect_ratio":"4:5","focus_y":0.4}, {"op":"auto_enhance"}, {"op":"apply_filter","filter":"warm","intensity":0.5}, ' +
                '{"op":"add_text","text":"Day 1","position":"top"}, {"op":"resize","width":1080}]'),
            output_format: outputFormat(),
            quality: z.number().int().min(1).max(100).default(92).describe('Quality for lossy output formats (default 92).'),
        }),
    }, async a => {
        const l = await loadImage(a.image);
        const out = await runPipeline(l.img, a.steps);
        return savedReply(await saveResult(out, l, 'edited', a.output_format, { quality: a.quality }), l, { steps_applied: a.steps.map(s => s.op) });
    });

    if (config.mode === 'stdio') {
        registerTool(server, 'save_image_to_folder', {
            title: 'Save image to a folder',
            description: "Copies a result (or any image) into a folder you choose, e.g. the Desktop, keeping the exact bytes. Never overwrites: if the name exists, '-2', '-3' is added.",
            input: z.object({
                image: imageSource(),
                folder: z.string().describe("Absolute destination folder, e.g. '/Users/me/Desktop'. Created if missing."),
                filename: z.string().optional().describe('New file name without extension (default: keep the current name).'),
            }),
        }, async a => {
            const l = await loadImage(a.image);
            const dir = await resolveLocalPath(a.folder, false);
            const st = await fs.stat(dir).catch(() => null);
            if (st && !st.isDirectory()) throw new OpError(`${dir} is a file, not a folder.`);
            let ext: string, data: Buffer;
            if (l.path) { ext = path.extname(l.path).toLowerCase(); data = l.raw; }
            else {
                const key = defaultFormat(l.sourceFormat, l.img, l.frames);
                ext = FORMATS[key].ext;
                data = l.sourceFormat === key ? l.raw : await encode(l.img, key);
            }
            const stem = a.filename ? safeStem(a.filename) : l.path ? path.basename(l.path, path.extname(l.path)) : l.name;
            await fs.mkdir(dir, { recursive: true });
            for (let n = 1; n < 10_000; n++) {
                const dest = path.join(dir, `${stem}${n === 1 ? '' : '-' + n}${ext}`);
                try {
                    await fs.writeFile(dest, data, { flag: 'wx' });
                    return reply({ saved_to: dest, file_size: humanSize(data.length) });
                } catch (e) {
                    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
                }
            }
            throw new OpError('Could not find a free file name.');
        });
    } else {
        registerTool(server, 'create_upload_link', {
            title: 'Create upload link',
            description: 'Call this FIRST whenever the user wants to edit an image that is attached in the chat or stored on their ' +
                'computer or phone (those cannot be passed to tools directly). Returns an upload page link: send it to the user and ' +
                "wait. They upload the image there (JPG, PNG, HEIC, WebP...) and paste back a link ending in the file name; pass that " +
                'link as `image` to any tool. Also returns `direct_upload`, a curl command for agents that can run shell commands.',
            input: z.object({ expires_minutes: z.number().int().min(5).max(1440).default(60).describe('How long the link works (default 60 minutes).') }),
        }, async a => {
            const { token, expiresAt } = makeUploadToken(a.expires_minutes);
            const page = `${baseUrl()}/upload?t=${token}`;
            return reply({
                upload_page: page,
                expires_at: expiresAt.toISOString(),
                message_for_user: `Please upload your image here: ${page}\nAfter it uploads, tap "Copy link" and paste the link back into this chat.`,
                direct_upload: `curl -sS -F "file=@/path/to/image.jpg" "${baseUrl()}/upload?t=${token}"`,
                direct_upload_note: `Only for agents with a shell whose network can reach ${new URL(baseUrl()).hostname} (claude.ai's code sandbox ` +
                    'usually cannot unless the user allows that domain for code execution). It prints JSON whose `image` field is the link to use. ' +
                    'Do not upload the user\'s image to third-party hosts (gists, image hosts) without asking them.',
                next_step: 'Send message_for_user to the user and wait for the pasted link (it contains /files/). Then call the edit tool with image=<that link>.',
            });
        });
    }
}
