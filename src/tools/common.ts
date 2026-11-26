/** Shared argument schemas + the wrapper that registers a tool with clean errors and a concurrency limit. */
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { config } from '../config.js';
import { OpError } from '../core/img.js';
import { ToolReply } from '../core/io.js';
import { POSITIONS } from '../core/ops/overlay.js';

export { z };

export const imageSource = () => z.string().min(1).describe(config.mode === 'http'
    ? 'Image to use. One of: (a) a link to this server\'s files (".../files/...") from the upload page or an earlier result\'s `output`; ' +
      '(b) a public direct image URL (the image file itself, not a web page); (c) base64 / data:image/...;base64 text you actually have. ' +
      'NOT accepted: images attached in chat, file names or paths (/Users/..., /mnt/...), or base64 typed out from an image you can see. ' +
      'If the user\'s image is in the chat or on their device, call create_upload_link first.'
    : "The image: an absolute file path (e.g. '/Users/me/Downloads/IMG_0042.HEIC'), an http(s) URL, or base64 / data-URI text. The output_path returned by any earlier tool also works.");

export const focusX = () => z.number().min(0).max(1).default(0.5)
    .describe('Horizontal point to keep centred, 0 = left edge, 0.5 = middle, 1 = right edge. Move it toward a face that is off-centre.');
export const focusY = (def = 0.5) => z.number().min(0).max(1).default(def)
    .describe('Vertical point to keep centred, 0 = top, 0.5 = middle, 1 = bottom. For portraits ~0.35-0.4 keeps the face in frame.');
export const zoom = () => z.number().min(1).max(10).default(1).describe('Zoom in before cropping. 1 = no zoom, 1.5 = tighter crop.');
export const color = (def: string, what = 'Color') => z.string().default(def)
    .describe(`${what} as hex ('#0A66C2', '#00000080' with alpha), rgb(...), or a name ('white', 'black', 'transparent').`);
export const position = (def: (typeof POSITIONS)[number]) => z.enum(POSITIONS).default(def);
export const outputFormat = () => z.enum(['keep', 'png', 'jpg', 'webp', 'avif', 'gif', 'tiff', 'bmp']).default('keep')
    .describe("File format of the result. 'keep' = same as the input (HEIC becomes JPG; transparent results become PNG).");

// ------------------------------------------------------------------ concurrency limit

let running = 0;
const waiting: (() => void)[] = [];

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (running >= Math.max(1, config.maxConcurrentJobs)) {
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                const i = waiting.indexOf(go);
                if (i >= 0) waiting.splice(i, 1);
                reject(new OpError('The server is busy with other images. Please try again in a moment.'));
            }, 60_000);
            const go = () => { clearTimeout(timer); resolve(); };
            waiting.push(go);
        });
    }
    running++;
    try {
        return await fn();
    } finally {
        running--;
        waiting.shift()?.();
    }
}


// ------------------------------------------------------------------ "use when" lines (help the model pick the right tool)

/** Typical user requests per tool, appended to each description as "Use for: ...". Keep them short and concrete. */
const USE_FOR: Record<string, string> = {
    get_image_info: '"how big is this image", "what format/resolution is it", "does this photo contain my location".',
    list_images: '"use my latest screenshot", "what images are in Downloads" (local folders only).',
    extract_color_palette: '"what colors are in this logo", "give me the hex codes", "pick a matching ring/text color".',
    detect_faces: '"how many people are in this photo", finding a face before blurring only some faces or framing a profile photo.',
    crop_image: '"make it square", "crop to 16:9 / 4:5", "cut out this area", "remove the edges".',
    crop_to_circle: '"make a round profile picture / avatar" with no ring.',
    create_profile_ring: '"LinkedIn profile photo", "#OPENTOWORK / #HIRING frame", "add a colored ring/border around my round photo".',
    resize_image: '"resize to 1080 px wide", "make it half the size", "exactly 800x600".',
    upscale_image: '"upscale", "make it bigger / higher resolution", "enlarge this small logo 2x" (classic, no AI detail).',
    rotate_or_flip_image: '"rotate 90 degrees", "it is sideways/upside down", "mirror / un-mirror my selfie".',
    resize_for_social: '"make it fit an Instagram story / post", "YouTube thumbnail", "LinkedIn banner", "X header".',
    add_border: '"add a white border / frame", "add padding around it".',
    round_corners: '"round the corners", "app-icon / card look".',
    trim_borders: '"remove the white space / black bars around it", "auto-crop the empty edges".',
    convert_image_format: '"convert HEIC to JPG", "make it PNG / WebP / AVIF", "turn it into a PDF or favicon .ico".',
    compress_image: '"reduce the file size", "make it under 200 KB", "optimize for the web / email" without visible quality loss.',
    batch_convert_images: 'converting or compressing several images at once ("all these HEIC photos to JPG").',
    strip_image_metadata: '"remove location / EXIF data", "make it safe to share publicly".',
    create_icon_set: '"make a favicon", "app icons in all sizes".',
    apply_filter: '"black and white / B&W / monochrome" (grayscale or noir), "old photo / retro" (sepia, vintage), "sketch", "cartoon", "warmer / cooler look".',
    adjust_image: '"brighter / darker", "more contrast", "more / less saturated", "sharper", "warmer / cooler" by a chosen amount.',
    blur_image: '"blur the faces", "hide this name / email / number plate", "blur the background", "pixelate part of it", soft blur edges.',
    auto_enhance_image: '"fix / improve / enhance this photo", "it is too dark or dull" when no specific setting is named.',
    add_text_to_image: '"add a caption / title / headline", "write my name on it", meme or quote text.',
    add_watermark: '"add my watermark / logo", "protect this photo", "\u00a9 name in the corner" or tiled.',
    remove_solid_background: '"remove the white / plain background", "make the logo transparent" (not busy photo backgrounds).',
    create_collage: '"combine these photos into a grid", "before/after side by side".',
    run_image_pipeline: 'any request with 2+ edits on one image, e.g. "crop square, make B&W, add text, export WebP".',
    save_image_to_folder: '"save it to my Desktop / Downloads".',
    create_upload_link: 'an image in the chat or on the user\'s device that you cannot read as a file yourself; or to get a curl upload command.',
    upload_image_data: 'an image file you can read (chat attachment in your code sandbox, a file you created) when you cannot reach this server over the network.',
};

// ------------------------------------------------------------------ registration

/** Base type of a zod field, looking through optional/default/nullable wrappers. */
function baseType(field: any): string {
    let f = field;
    for (let i = 0; i < 5 && f?._zod?.def; i++) {
        const d = f._zod.def;
        if (['optional', 'default', 'nullable', 'prefault', 'readonly'].includes(d.type) && d.innerType) f = d.innerType;
        else return d.type;
    }
    return 'unknown';
}

/**
 * Models and older clients sometimes send typed values as text: "true", "8", or a JSON array as a string. Convert those
 * before validation, so a call does not fail on formatting alone. Only clear-cut cases are converted.
 */
function coerceArgs(shape: Record<string, unknown>, args: unknown): unknown {
    if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
    const out: Record<string, unknown> = { ...(args as Record<string, unknown>) };
    for (const [k, v] of Object.entries(out)) {
        if (typeof v !== 'string' || !(k in shape)) continue;
        const t = baseType(shape[k]);
        const s = v.trim();
        if (t === 'boolean' && /^(true|false)$/i.test(s)) out[k] = s.toLowerCase() === 'true';
        else if (t === 'number' && s !== '' && Number.isFinite(Number(s))) out[k] = Number(s);
        else if ((t === 'array' && s.startsWith('[')) || (t === 'object' && s.startsWith('{'))) {
            try { out[k] = JSON.parse(s); } catch { /* leave it, validation reports the problem */ }
        }
    }
    return out;
}

/** The zod schema with lenient input coercion; JSON Schema advertised to clients is unchanged. */
function lenient<S extends z.ZodObject>(schema: S): S {
    const std = schema['~standard'];
    const shape = schema.shape as Record<string, unknown>;
    return { '~standard': { ...std, validate: (v: unknown) => std.validate(coerceArgs(shape, v)) } } as unknown as S;
}

export interface ToolDef<S extends z.ZodObject> {
    title: string;
    description: string;
    input: S;
    readOnly?: boolean;
}

/** What kind of image input a call used, for logs (never the data itself). */
function describeInput(v: unknown): string {
    if (typeof v !== 'string') return '-';
    const s = v.trim();
    if (/\/files\/[a-f0-9]{24}__/.test(s)) return 'stored-link';
    if (/^https?:\/\//i.test(s)) { try { return 'url:' + new URL(s).hostname; } catch { return 'bad-url'; } }
    if (/^data:/i.test(s)) return `data-uri(${s.length})`;
    if (s.length > 200 && !s.includes('.')) return `base64(${s.length})`;
    return `other:${JSON.stringify(s.slice(0, 40))}`;
}

export function errorReply(e: unknown, tool: string): ToolReply {
    if (e instanceof OpError) return { content: [{ type: 'text', text: e.message }], isError: true };
    const err = e as Error;
    console.error(`[yt-mcp] ${tool} failed:`, err?.stack ?? err); // stderr only: stdout is the MCP channel in stdio mode
    return { content: [{ type: 'text', text: `${tool} failed unexpectedly (${err?.name ?? 'Error'}: ${String(err?.message ?? err).slice(0, 300)}).` }], isError: true };
}

export function registerTool<S extends z.ZodObject>(server: McpServer, name: string, def: ToolDef<S>,
    handler: (args: z.infer<S>) => Promise<ToolReply>): void {
    server.registerTool(name, {
        title: def.title,
        description: USE_FOR[name] && !(name === 'list_images' && config.mode === 'http') ? `${def.description} Use for: ${USE_FOR[name]}` : def.description,
        inputSchema: lenient(def.input),
        annotations: {
            title: def.title,
            readOnlyHint: !!def.readOnly,
            destructiveHint: false, // never modifies or deletes originals; results are new files
            idempotentHint: !!def.readOnly,
            openWorldHint: true, // may fetch image URLs
        },
    }, (async (args: z.infer<S>) => {
        const t = Date.now();
        let result: ToolReply;
        try {
            result = await withSlot(() => handler(args));
        } catch (e) {
            result = errorReply(e, name);
        }
        if (config.mode === 'http') {
            const err = result.isError ? ` ERROR: ${String((result.content[0] as { text?: string })?.text ?? '').slice(0, 160)}` : ' ok';
            console.error(`[yt-mcp] tool ${name} image=${describeInput((args as { image?: unknown }).image)} ${Date.now() - t}ms${err}`);
        }
        return result;
    }) as any);
}
