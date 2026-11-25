/** Crop, circle, profile ring, resize, upscale, rotate, social presets, border, corners, trim. */
import type { McpServer } from '@modelcontextprotocol/server';
import { OpError } from '../core/img.js';
import { loadImage, saveResult, savedReply } from '../core/io.js';
import {
    SOCIAL_PRESETS, addBorder, cropAspect, cropBox, cropCircle, resize, rotateFlip, roundCorners, socialResize, trimBorders, upscale,
} from '../core/ops/geometry.js';
import { RING_STYLES, profileRing } from '../core/ops/ring.js';
import { color, focusX, focusY, imageSource, outputFormat, registerTool, z, zoom } from './common.js';

const presetNames = Object.keys(SOCIAL_PRESETS) as [string, ...string[]];
const ringNames = Object.keys(RING_STYLES) as [string, ...string[]];

export function register(server: McpServer): void {
    registerTool(server, 'crop_image', {
        title: 'Crop image',
        description: 'Creates a cropped copy of an image. Either give aspect_ratio (largest crop of that shape, centred on focus_x/focus_y, ' +
            'optionally zoomed) or an exact pixel box (x, y, width, height). Call get_image_info first if you need the pixel size.',
        input: z.object({
            image: imageSource(),
            aspect_ratio: z.string().optional().describe("Crop to a ratio instead of a box, e.g. '1:1', '16:9', '4:5', '9:16', '3:2'."),
            x: z.number().int().min(0).optional().describe('Box crop: left edge in pixels.'),
            y: z.number().int().min(0).optional().describe('Box crop: top edge in pixels.'),
            width: z.number().int().positive().optional().describe('Box crop: width in pixels.'),
            height: z.number().int().positive().optional().describe('Box crop: height in pixels.'),
            focus_x: focusX(), focus_y: focusY(), zoom: zoom(), output_format: outputFormat(),
        }),
    }, async a => {
        const l = await loadImage(a.image);
        let out;
        if (a.x != null && a.y != null && a.width != null && a.height != null) out = cropBox(l.img, { x: a.x, y: a.y, width: a.width, height: a.height });
        else if (a.aspect_ratio) out = cropAspect(l.img, a);
        else throw new OpError("Give aspect_ratio (e.g. '1:1') or all four of x, y, width, height.");
        return savedReply(await saveResult(out, l, 'crop', a.output_format), l);
    });

    registerTool(server, 'crop_to_circle', {
        title: 'Crop to circle',
        description: 'Creates a circular crop of an image (round avatar / profile picture) as a transparent PNG. Use focus_x/focus_y/zoom to ' +
            'centre the face. For a colored ring or #OPENTOWORK frame use create_profile_ring.',
        input: z.object({
            image: imageSource(),
            size: z.number().int().min(16).max(4096).optional().describe('Output diameter in pixels (default: as large as the image allows).'),
            focus_x: focusX(), focus_y: focusY(), zoom: zoom(),
            border_width: z.number().int().min(0).max(500).default(0).describe('Optional plain outline in pixels (0 = none).'),
            border_color: color('white', 'Outline color'),
            background: z.string().default('transparent').describe("Corner color outside the circle; 'transparent' (default) gives see-through corners."),
        }),
    }, async a => {
        const l = await loadImage(a.image);
        return savedReply(await saveResult(await cropCircle(l.img, a), l, 'circle', 'png'), l);
    });

    registerTool(server, 'create_profile_ring', {
        title: 'Create profile picture ring',
        description: 'Creates a circular profile picture with a colored ring, ready for LinkedIn and other networks. Presets: open_to_work ' +
            '(green #OPENTOWORK arc), hiring (purple #HIRING arc), linkedin_blue, sunset_gradient, gold, ocean, or custom colors/label. ' +
            "The ring sits inside the circle so it survives LinkedIn's own round crop. Saved as PNG. Adjust focus_x/focus_y/zoom to frame the face.",
        input: z.object({
            image: imageSource(),
            style: z.enum(ringNames).default('open_to_work').describe('Ring preset: ' + Object.entries(RING_STYLES).map(([k, v]) => `${k} = ${v.about}`).join('; ')),
            colors: z.array(z.string()).optional().describe("Override ring colors: one hex for solid, 2+ for a gradient, e.g. ['#0A66C2', '#00C6FF']."),
            label: z.string().max(40).optional().describe("Curved text on the ring, e.g. '#OPENTOWORK', '#HIRING', 'FREELANCER'. Empty string removes the preset label."),
            label_color: color('white', 'Label color'),
            shape: z.enum(['full', 'arc']).optional().describe('full = complete ring around the photo; arc = LinkedIn-style band over the lower-left edge. Default comes from the style.'),
            ring_width: z.number().min(0.02).max(0.3).default(0.09).describe('Ring thickness as a fraction of the diameter (default 0.09).'),
            size: z.number().int().min(64).max(4096).default(800).describe('Output size in pixels (square). LinkedIn recommends 400-800.'),
            focus_x: focusX(), focus_y: focusY(0.45), zoom: zoom(),
            arc_center: z.number().min(0).max(360).default(115).describe("Arc only: where the band is centred, degrees clockwise from 3 o'clock (90 = bottom, 115 = lower-left)."),
            arc_span: z.number().min(20).max(360).default(230).describe('Arc only: how far the band wraps around, in degrees.'),
            background: z.string().default('transparent').describe('Color of the square corners outside the circle (default transparent).'),
        }),
    }, async a => {
        const l = await loadImage(a.image);
        const out = await profileRing(l.img, a);
        return savedReply(await saveResult(out, l, `ring_${a.style}`, 'png'), l, {
            style: a.style, upload_tip: "On LinkedIn: profile photo > Edit > upload this PNG. Turn off LinkedIn's own frame to avoid a double ring.",
        });
    });

    registerTool(server, 'resize_image', {
        title: 'Resize image',
        description: 'Creates a resized copy of an image by width, height, both, or a scale factor, using high-quality Lanczos resampling. ' +
            'To make an image bigger with sharpening use upscale_image; for social sizes use resize_for_social.',
        input: z.object({
            image: imageSource(),
            width: z.number().int().min(1).max(16000).optional().describe('Target width in pixels. Alone: height follows the aspect ratio.'),
            height: z.number().int().min(1).max(16000).optional().describe('Target height in pixels. Alone: width follows the aspect ratio.'),
            scale: z.number().gt(0).max(10).optional().describe('Scale factor instead of sizes, e.g. 0.5 = half size.'),
            fit: z.enum(['contain', 'cover', 'pad', 'stretch']).default('contain').describe('When both width and height are given: contain = fit inside, cover = fill and crop, pad = fit and fill the rest with background, stretch = distort.'),
            background: z.string().default('transparent').describe("Fill color for fit='pad'."),
            output_format: outputFormat(),
        }),
    }, async a => {
        const l = await loadImage(a.image);
        const out = await resize(l.img, a);
        return savedReply(await saveResult(out, l, `${out.width}x${out.height}`, a.output_format), l);
    });

    registerTool(server, 'upscale_image', {
        title: 'Upscale image',
        description: 'Creates an enlarged copy (1.1x-4x) using Lanczos resampling plus edge-aware sharpening. Classic (non-AI) upscale: ' +
            'great for 2x, it cannot invent new detail.',
        input: z.object({
            image: imageSource(),
            factor: z.number().gt(1).max(4).default(2).describe('How much bigger: 2 = double width and height (default), up to 4.'),
            sharpen: z.number().min(0).max(1).default(0.6).describe('Detail sharpening after enlarging, 0 = none, 0.6 = default, 1 = strong.'),
            output_format: outputFormat(),
        }),
    }, async a => {
        const l = await loadImage(a.image);
        return savedReply(await saveResult(await upscale(l.img, a), l, `upscaled${a.factor}x`, a.output_format), l, { method: 'Lanczos + unsharp mask (classic, not AI)' });
    });

    registerTool(server, 'rotate_or_flip_image', {
        title: 'Rotate or flip image',
        description: "Creates a rotated and/or mirrored copy of an image. Use flip='horizontal' to un-mirror a selfie.",
        input: z.object({
            image: imageSource(),
            angle: z.number().min(-360).max(360).default(0).describe('Degrees CLOCKWISE (90, 180, 270 are lossless; other angles expand the canvas).'),
            flip: z.enum(['none', 'horizontal', 'vertical', 'both']).default('none').describe('Mirror: horizontal = left-right (selfie fix), vertical = upside down.'),
            background: z.string().default('transparent').describe('Fill for empty corners after a non-90 rotation.'),
            output_format: outputFormat(),
        }),
    }, async a => {
        if (!a.angle && a.flip === 'none') throw new OpError('Nothing to do: set angle and/or flip.');
        const l = await loadImage(a.image);
        return savedReply(await saveResult(await rotateFlip(l.img, a), l, a.angle ? 'rotated' : 'flipped', a.output_format), l);
    });

    registerTool(server, 'resize_for_social', {
        title: 'Resize for social media',
        description: 'Creates a copy sized exactly for a social platform: Instagram post/portrait/story, YouTube thumbnail and banner, LinkedIn ' +
            'profile/banner/post, X post/header, Facebook, Pinterest, TikTok, WhatsApp, Open Graph.',
        input: z.object({
            image: imageSource(),
            preset: z.enum(presetNames).describe('Target size: ' + Object.entries(SOCIAL_PRESETS).map(([k, [w, h]]) => `${k} ${w}x${h}`).join('; ')),
            fit: z.enum(['cover', 'pad', 'blur_pad']).default('cover').describe('cover = fill and crop; pad = whole image with solid bars; blur_pad = whole image over a blurred copy of itself.'),
            focus_x: focusX(), focus_y: focusY(),
            background: z.string().default('white').describe("Bar color for fit='pad'."),
            output_format: outputFormat(),
        }),
    }, async a => {
        const l = await loadImage(a.image);
        return savedReply(await saveResult(await socialResize(l.img, a), l, a.preset, a.output_format), l, { preset: `${a.preset}: ${SOCIAL_PRESETS[a.preset][2]}` });
    });

    registerTool(server, 'add_border', {
        title: 'Add border',
        description: 'Creates a copy with a solid border / padding of the given width and color around all sides.',
        input: z.object({
            image: imageSource(),
            width: z.number().int().min(1).max(2000).default(20).describe('Border thickness in pixels.'),
            color: color('white', 'Border color'),
            output_format: outputFormat(),
        }),
    }, async a => {
        const l = await loadImage(a.image);
        return savedReply(await saveResult(await addBorder(l.img, a), l, 'border', a.output_format), l);
    });

    registerTool(server, 'round_corners', {
        title: 'Round corners',
        description: 'Creates a copy with rounded, transparent corners (saved as PNG). Good for app-style screenshots and cards.',
        input: z.object({
            image: imageSource(),
            radius: z.number().gt(0).max(4000).default(0.08).describe('Corner radius: below 1 = fraction of the short side (0.08 default), 1 or more = pixels.'),
        }),
    }, async a => {
        const l = await loadImage(a.image);
        return savedReply(await saveResult(roundCorners(l.img, a), l, 'rounded', 'png'), l);
    });

    registerTool(server, 'trim_borders', {
        title: 'Trim borders',
        description: 'Creates a copy with uniform empty edges (white space, black bars, transparent margins) cut away automatically.',
        input: z.object({
            image: imageSource(),
            tolerance: z.number().int().min(0).max(128).default(12).describe('How different a pixel must be from the edge color to count as content.'),
            padding: z.number().int().min(0).max(500).default(0).describe('Pixels of margin to keep around the content.'),
            output_format: outputFormat(),
        }),
    }, async a => {
        const l = await loadImage(a.image);
        return savedReply(await saveResult(trimBorders(l.img, a), l, 'trimmed', a.output_format), l);
    });
}
