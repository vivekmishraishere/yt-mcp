/** Shared argument schemas + the wrapper that registers a tool with clean errors and a concurrency limit. */
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { config } from '../config.js';
import { OpError } from '../core/img.js';
import { ToolReply } from '../core/io.js';
import { POSITIONS } from '../core/ops/overlay.js';

export { z };

export const imageSource = () => z.string().min(1).describe(config.mode === 'http'
    ? 'The image: an https URL, a link returned by an earlier tool (`output`), or base64 / data-URI text. To use a file from your computer, call create_upload_link first.'
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

// ------------------------------------------------------------------ registration

export interface ToolDef<S extends z.ZodObject> {
    title: string;
    description: string;
    input: S;
    readOnly?: boolean;
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
        description: def.description,
        inputSchema: def.input,
        annotations: {
            title: def.title,
            readOnlyHint: !!def.readOnly,
            destructiveHint: false, // never modifies or deletes originals; results are new files
            idempotentHint: !!def.readOnly,
            openWorldHint: true, // may fetch image URLs
        },
    }, (async (args: z.infer<S>) => {
        try {
            return await withSlot(() => handler(args));
        } catch (e) {
            return errorReply(e, name);
        }
    }) as any);
}
