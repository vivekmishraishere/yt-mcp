/** Filters, adjustments, smart blur, auto enhance. */
import type { McpServer } from '@modelcontextprotocol/server';
import { loadImage, saveResult, savedReply } from '../core/io.js';
import { blurWithInfo } from '../core/ops/blur.js';
import { FILTERS, adjust, applyFilter, autoEnhance } from '../core/ops/filters.js';
import { imageSource, outputFormat, registerTool, z } from './common.js';

const filterNames = Object.keys(FILTERS) as [string, ...string[]];
const factor = (what: string) => z.number().min(0).max(4).default(1).describe(what);

export function register(server: McpServer): void {
    registerTool(server, 'apply_filter', {
        title: 'Apply filter',
        description: 'Creates a copy of an image with a photo filter / effect: grayscale, noir, sepia, vintage, warm, cool, vivid, dramatic, fade, ' +
            'invert, posterize, solarize, emboss, sketch, cartoon, blur, sharpen, vignette, pixelate. Transparency is preserved.',
        input: z.object({
            image: imageSource(),
            filter: z.enum(filterNames).describe('Filter: ' + Object.entries(FILTERS).map(([k, v]) => `${k} = ${v[1]}`).join('; ')),
            intensity: z.number().min(0).max(1).default(1).describe('Strength, 0 = none, 0.5 = half-blended, 1 = full (default).'),
            output_format: outputFormat(),
        }),
    }, async a => {
        const l = await loadImage(a.image);
        return savedReply(await saveResult(await applyFilter(l.img, a), l, a.filter, a.output_format), l, { filter: a.filter, intensity: a.intensity });
    });

    registerTool(server, 'adjust_image', {
        title: 'Adjust image',
        description: 'Creates a copy with manual light and color adjustments: brightness, contrast, saturation, sharpness, exposure, gamma and ' +
            'warmth. Leave any value at its default to keep it unchanged.',
        input: z.object({
            image: imageSource(),
            brightness: factor('1.0 = unchanged, 1.2 = 20% brighter, 0.8 = darker.'),
            contrast: factor('1.0 = unchanged, >1 = more contrast.'),
            saturation: factor('1.0 = unchanged, 0 = black and white, >1 = more colorful.'),
            sharpness: factor('1.0 = unchanged, 2 = sharper, <1 = softer.'),
            exposure: z.number().min(-3).max(3).default(0).describe('Exposure in stops (EV): +1 = twice as bright, -1 = half.'),
            gamma: z.number().min(0.2).max(5).default(1).describe('1.0 = unchanged, >1 lifts shadows/midtones, <1 deepens them.'),
            warmth: z.number().min(-1).max(1).default(0).describe('-1 = much cooler/bluer, 0 = unchanged, 1 = much warmer/golden.'),
            output_format: outputFormat(),
        }),
    }, async a => {
        const l = await loadImage(a.image);
        return savedReply(await saveResult(await adjust(l.img, a), l, 'adjusted', a.output_format), l);
    });

    registerTool(server, 'blur_image', {
        title: 'Blur or pixelate (regions, soft edges, auto face detect)',
        description: 'Creates a copy with blur or pixelation on: the whole image; one or more chosen regions (hide a name, email, number plate); ' +
            "every face found automatically (detect='faces'); or everything EXCEPT the regions/faces (invert=true, background blur). Regions " +
            'can be rectangles or ellipses, and `feather` controls how smoothly the blur fades out at the edges. Face detection is classic ' +
            '(no AI download): it works on real photos, not drawings. Use detect_faces first to see the faces and blur only some of them. ' +
            'For drawings, cartoons, logos or text, pass `regions` yourself: get_image_info(grid=true) shows a pixel grid to read them from. ' +
            'With no regions and no detection, the whole image is blurred.',
        input: z.object({
            image: imageSource(),
            detect: z.enum(['none', 'faces']).default('none').describe("'faces' = automatically find every face in a photo and blur it. Combine with invert=true to keep faces sharp and blur the background."),
            x: z.number().int().min(0).optional().describe('One region: left edge in pixels.'),
            y: z.number().int().min(0).optional().describe('One region: top edge in pixels.'),
            width: z.number().int().positive().optional().describe('One region: width in pixels.'),
            height: z.number().int().positive().optional().describe('One region: height in pixels.'),
            regions: z.array(z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })).max(100).optional()
                .describe('Several regions at once, e.g. [{"x":10,"y":20,"width":200,"height":40}]. Boxes from detect_faces work directly.'),
            shape: z.enum(['auto', 'rectangle', 'ellipse']).default('auto').describe('Region shape. auto = ellipse for faces, rectangle for boxes.'),
            feather: z.number().min(0).max(2000).optional().describe('Edge smoothness in pixels: width of the soft fade around each region. 0 = hard edge; default = 25% of the region size. The region itself is always fully blurred.'),
            radius: z.number().min(0.5).max(300).optional().describe("Blur strength in pixels (block size for pixelate). Default: strong enough to hide the region's content (8 for the whole image)."),
            style: z.enum(['gaussian', 'pixelate']).default('gaussian').describe('gaussian = smooth blur; pixelate = mosaic blocks.'),
            invert: z.boolean().default(false).describe('true = keep the region(s) sharp and blur EVERYTHING ELSE (portrait-style background blur).'),
            padding: z.number().min(0).max(1).optional().describe('Grow each region by this fraction so edges are covered. Default 0.2 for detected faces, 0 for your boxes.'),
            sensitivity: z.enum(['strict', 'balanced', 'loose']).default('balanced').describe('Face detection: strict = fewer false hits, loose = finds more faces.'),
            output_format: outputFormat(),
        }),
    }, async a => {
        const l = await loadImage(a.image);
        const { img, info } = await blurWithInfo(l.img, a);
        const tag = a.invert ? 'bg-blur' : a.detect === 'faces' ? 'faces-blurred' : a.style === 'pixelate' ? 'pixelated' : 'blurred';
        return savedReply(await saveResult(img, l, tag, a.output_format), l, info);
    });

    registerTool(server, 'auto_enhance_image', {
        title: 'Auto enhance',
        description: 'Creates an automatically improved copy: balances contrast and levels, brightens dark photos, adds a little color and ' +
            'crispness. A quick one-click fix for dull or dark photos.',
        input: z.object({
            image: imageSource(),
            strength: z.number().min(0).max(1).default(0.7).describe('How strong the fix is, 0-1 (default 0.7).'),
            output_format: outputFormat(),
        }),
    }, async a => {
        const l = await loadImage(a.image);
        return savedReply(await saveResult(await autoEnhance(l.img, a), l, 'enhanced', a.output_format), l);
    });
}
