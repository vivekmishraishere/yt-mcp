/**
 * upload_image_file: Claude's official file-transfer extension (io.modelcontextprotocol/files, beta).
 *
 * The Claude app itself sends the attached file to this server, so the AI copies nothing and the upload is as fast as a
 * normal upload. Flow (two tool calls, bytes in between):
 *   1. Claude calls the tool with the file's name, type, size and digest (no bytes).
 *   2. We answer resultType "upload_required" with a signed, single-use PUT target on this server + a requestState.
 *   3. Anthropic's servers PUT the bytes to /upload-target/<id>.
 *   4. Claude calls the tool again with the same arguments + requestState; we verify and store the image.
 * Claude only does this for connectors listed in its Connectors Directory whose hosts Anthropic approved.
 * Clients without the extension may send the bytes inline in file.data (base64).
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ProtocolError, type McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { signTarget } from '../auth.js';
import { config } from '../config.js';
import { decode } from '../core/codec.js';
import { OpError } from '../core/img.js';
import { humanSize, previewContent } from '../core/io.js';
import { baseUrl, pendingDir, safeStem, saveFile } from '../core/storage.js';

export const FILES_EXT = 'io.modelcontextprotocol/files';
const ACCEPT = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/avif', 'image/gif', 'image/tiff', 'image/bmp', 'application/octet-stream'];
const TARGET_MINUTES = 30;   // the doc asks for >= 20
const STATE_MINUTES = 60;

const fileSchema = z.object({
    id: z.string().min(1).max(128),
    name: z.string().optional(),
    mimeType: z.string(),
    size: z.number().int().min(0),
    digest: z.object({ algorithm: z.literal('sha-256'), value: z.string() }).optional(),
    data: z.string().optional(),
}).meta({
    description: `The image file (JPG, PNG, WebP, HEIC, AVIF, GIF, TIFF or BMP, up to ${config.maxInputMb} MB).`,
    'x-mcp-file': { accept: ACCEPT.filter(t => t !== 'application/octet-stream'), maxSize: config.maxInputMb * 1024 * 1024 },
});

type FileArg = z.infer<typeof fileSchema>;
interface State { tool: string; args: string; fileId: string; staging: string; size: number; expires: number }

/** Canonical JSON (sorted keys) so the second call's arguments compare equal regardless of member order. */
function canonical(v: unknown): string {
    if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
    if (v && typeof v === 'object') return `{${Object.keys(v as object).sort().map(k => `${JSON.stringify(k)}:${canonical((v as any)[k])}`).join(',')}}`;
    return JSON.stringify(v);
}

const stagingPath = (id: string) => path.join(pendingDir(), `t-${id}.bin`);
const targetMetaPath = (id: string) => path.join(pendingDir(), `t-${id}.json`);
const statePath = (id: string) => path.join(pendingDir(), `s-${id}.json`);

/** Signed upload target for staging id `id`; also used by the HTTP route to check what it receives. */
export function targetUrl(id: string, expires: number): string {
    return `${baseUrl()}/upload-target/${id}?exp=${expires}&sig=${encodeURIComponent(signTarget(`${id}.${expires}`))}`;
}
export async function targetLimits(id: string): Promise<{ size: number } | null> {
    try { return JSON.parse(await fs.readFile(targetMetaPath(id), 'utf8')); } catch { return null; }
}
export const stagingFile = stagingPath;

function declaredFiles(ctx: any): Record<string, unknown> {
    const env = (ctx?.mcpReq?.envelope ?? {}) as Record<string, any>;
    const isNew = String(env['io.modelcontextprotocol/protocolVersion'] ?? '') >= '2026-07-28';
    const settings = env['io.modelcontextprotocol/clientCapabilities']?.extensions?.[FILES_EXT] ?? {};
    return !isNew || 'revision' in settings ? {} : settings;
}

async function store(buf: Buffer, file: FileArg) {
    let decoded;
    try {
        decoded = await decode(buf);
    } catch (e) {
        throw new OpError(`The file is not a supported image (${(e as Error).message}).`);
    }
    const stem = safeStem(path.basename(file.name ?? 'image', path.extname(file.name ?? '')));
    const stored = await saveFile(buf, stem, 'upload', '.' + (decoded.sourceFormat ?? 'img'));
    return {
        resultType: 'complete',
        content: [
            { type: 'text', text: JSON.stringify({
                image: stored.ref, width: decoded.img.width, height: decoded.img.height, format: decoded.sourceFormat,
                file_size: humanSize(buf.length),
                note: `Pass \`image\` to any tool. This upload is deleted ${config.uploadTtlMinutes} minutes after its last use; results last ${config.fileTtlHours} h.`,
            }, null, 2) },
            await previewContent(decoded.img),
        ],
    };
}

const refuse = (text: string) => ({ resultType: 'complete', isError: true, content: [{ type: 'text', text }] });

const inputSchema = z.object({ file: fileSchema });

/**
 * Routes tools/call for upload_image_file to our own handler, so protocol errors (-32602, -32021) reach the client as
 * real JSON-RPC errors; McpServer would turn them into ordinary isError results. Other tools go through McpServer.
 */
export function routeUploadCalls(server: McpServer): void {
    const low = server.server as any;
    const inner = low._requestHandlers.get('tools/call');
    if (!inner) return;
    low.setRequestHandler('tools/call', async (request: any, ctx: any) => {
        if (request?.params?.name !== 'upload_image_file') return inner(request, ctx);
        const parsed = inputSchema.safeParse(request.params.arguments ?? {});
        if (!parsed.success) throw new ProtocolError(-32602, `Invalid arguments for upload_image_file: ${parsed.error.issues.map(i => i.path.join('.') + ' ' + i.message).join('; ')}`);
        return handleUpload(parsed.data, ctx);
    });
}

export function register(server: McpServer): void {
    server.registerTool('upload_image_file', {
        title: 'Upload an attached image (instant)',
        description:
            "Receives the image the user attached in the chat directly from the Claude app, in a second or two, with no copying " +
            'by you. Pass the attachment as `file`; the app sends the bytes itself. Returns an `image` link that works in every ' +
            'tool. Only works in apps that support MCP file transfers; if this tool reports that the app cannot send files, use ' +
            `upload_image_data or create_upload_link instead. Uploads are deleted ${config.uploadTtlMinutes} minutes after their last use. ` +
            'Use for: any image the user attached in this chat, before editing it.',
        inputSchema,
        annotations: { title: 'Upload an attached image (instant)', readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    }, ((args: { file: FileArg }, ctx: any) => handleUpload(args, ctx)) as any);
}

async function handleUpload(args: { file: FileArg }, ctx: any): Promise<any> {
    {
        const t0 = Date.now();
        const file = args.file;
        try {
            const sizeOk = file.size <= config.maxInputMb * 1024 * 1024;
            if (!sizeOk) return refuse(`That file is ${humanSize(file.size)}; the limit is ${config.maxInputMb} MB.`);
            if (!ACCEPT.includes(file.mimeType.toLowerCase()) && !/^image\//i.test(file.mimeType))
                return refuse(`That file is ${file.mimeType}, not an image. Send a JPG, PNG, WebP, HEIC, AVIF, GIF, TIFF or BMP file.`);

            // bytes sent inline (clients without the upload extension)
            if (file.data !== undefined) return await store(Buffer.from(file.data, 'base64'), file);

            const declared = declaredFiles(ctx);
            const canUpload = declared.upload instanceof Object && !Array.isArray(declared.upload);
            if (!canUpload && file.size > 0) {
                throw new ProtocolError(-32021,
                    "This app can't send files to this connector, so the tool didn't run. Use upload_image_data or create_upload_link instead.",
                    { requiredCapabilities: { extensions: { [FILES_EXT]: { upload: {} } } } });
            }
            if (file.size === 0) return refuse('That file is empty.');
            await fs.mkdir(pendingDir(), { recursive: true });
            const argsJson = canonical(args);
            const rawState = ctx?.mcpReq?.requestState?.();

            if (rawState === undefined) {
                // first call: issue a single-use upload target and a requestState
                const staging = crypto.randomBytes(16).toString('hex');
                const rid = crypto.randomBytes(24).toString('hex');
                const expires = Math.floor(Date.now() / 1000) + TARGET_MINUTES * 60;
                await fs.writeFile(targetMetaPath(staging), JSON.stringify({ size: file.size }));
                const state: State = { tool: 'upload_image_file', args: argsJson, fileId: file.id, staging, size: file.size, expires: Date.now() + STATE_MINUTES * 60_000 };
                await fs.writeFile(statePath(rid), JSON.stringify(state));
                console.error(`[yt-mcp] tool upload_image_file first-call size=${file.size} ${Date.now() - t0}ms`);
                return {
                    resultType: 'upload_required',
                    content: [],
                    uploads: [{ fileId: file.id, url: targetUrl(staging, expires), method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, credentials: 'omit' }],
                    requestState: rid,
                };
            }

            // second call: verify the state, claim it once, check the bytes, store the image
            const rid = String(rawState);
            if (!/^[a-f0-9]{48}$/.test(rid)) throw new ProtocolError(-32602, 'Invalid or expired requestState');
            let state: State;
            try {
                state = JSON.parse(await fs.readFile(statePath(rid), 'utf8'));
            } catch {
                throw new ProtocolError(-32602, 'Invalid or expired requestState');
            }
            if (state.expires < Date.now() || state.tool !== 'upload_image_file' || state.args !== argsJson)
                throw new ProtocolError(-32602, 'Invalid or expired requestState');
            try {
                await fs.rename(statePath(rid), statePath(rid) + '.used'); // atomic: only one second call wins
            } catch {
                throw new ProtocolError(-32602, 'Invalid or expired requestState');
            }
            const staged = stagingPath(state.staging);
            const buf = await fs.readFile(staged).catch(() => null);
            await fs.rm(staged, { force: true }); await fs.rm(targetMetaPath(state.staging), { force: true });
            if (!buf) return refuse('The file did not arrive. Please try attaching it again.');
            if (buf.length !== state.size) return refuse(`The file arrived with ${buf.length} bytes instead of ${state.size}. Please try again.`);
            if (file.digest) {
                const got = crypto.createHash('sha256').update(buf).digest('base64url');
                if (got !== file.digest.value.replace(/=+$/, '')) return refuse('The file arrived damaged (its SHA-256 does not match). Please try again.');
            }
            const result = await store(buf, file);
            console.error(`[yt-mcp] tool upload_image_file second-call size=${buf.length} ${Date.now() - t0}ms ok`);
            return result;
        } catch (e) {
            if (e instanceof ProtocolError) throw e;
            if (e instanceof OpError) return refuse(e.message);
            console.error('[yt-mcp] upload_image_file failed:', (e as Error)?.name); // never log URLs or state
            return refuse('The upload failed. Please try again.');
        }
    }
}
