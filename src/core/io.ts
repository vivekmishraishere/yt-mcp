/** Load an image from a path / URL / base64 / stored file, save results, and build tool replies. */
import dns from 'node:dns/promises';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.js';
import { Decoded, FormatKey, FORMATS, decode, defaultFormat, encode, EncodeOptions, normalizeFormat } from './codec.js';
import { Img, OpError, hasAlpha, toSharp } from './img.js';
import { Stored, UPLOAD_NAME, safeStem, saveFile, storedPathFromRef, touchUpload } from './storage.js';

export interface Loaded extends Decoded {
    name: string;
    raw: Buffer;
    path: string | null;
}

export interface Saved extends Stored {
    format: FormatKey;
    sizeBytes: number;
    width: number;
    height: number;
    img: Img;
}

const UPLOAD_HINT = 'Next step: call create_upload_link, send the user the upload page, and use the link they paste back.';

export const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif', '.avif', '.gif', '.bmp', '.tif', '.tiff']);

// ------------------------------------------------------------------ local paths

export async function resolveLocalPath(raw: string, mustExist = true): Promise<string> {
    if (!config.allowLocalPaths)
        throw new OpError(`"${raw.slice(0, 80)}" is a file name or path, and this remote server cannot read files from the user's ` +
            "device or from the chat (attachments included). " + UPLOAD_HINT);
    let p = raw.trim().replace(/^["']|["']$/g, '');
    if (p.startsWith('~')) p = path.join(os.homedir(), p.slice(1));
    if (!path.isAbsolute(p)) throw new OpError(`Please pass an absolute path (got "${raw}"), e.g. /Users/you/Downloads/photo.jpg.`);
    const real = await realpathLoose(path.resolve(p));
    checkAllowed(real);
    if (mustExist && !(await fs.stat(real).catch(() => null))) throw new OpError(`File not found: ${real}. Use list_images to see what is in a folder.`);
    return real;
}

/** realpath that also works for paths that do not exist yet: resolve the nearest existing parent, append the rest. */
async function realpathLoose(abs: string): Promise<string> {
    let head = abs;
    const tail: string[] = [];
    for (;;) {
        try {
            return path.join(await fs.realpath(head), ...tail.reverse());
        } catch {
            const parent = path.dirname(head);
            if (parent === head) return abs;
            tail.push(path.basename(head));
            head = parent;
        }
    }
}

function checkAllowed(p: string): void {
    const ok = config.allowedDirs.some(root => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep));
    if (!ok) throw new OpError(`Access denied: ${p} is outside the allowed folders (${config.allowedDirs.join(', ')}). Set ALLOWED_DIRS to allow more.`);
}

// ------------------------------------------------------------------ URLs (with SSRF protection)

const privateRanges = new net.BlockList();
for (const [a, b] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
    ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) privateRanges.addSubnet(a, b, 'ipv4');
for (const [a, b] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) privateRanges.addSubnet(a, b, 'ipv6');

async function assertPublicHost(url: URL): Promise<void> {
    if (!['http:', 'https:'].includes(url.protocol)) throw new OpError(`Only http(s) URLs are supported (got ${url.protocol}).`);
    if (!config.blockPrivateUrls) return;
    let addrs: { address: string; family: number }[];
    try {
        addrs = net.isIP(url.hostname.replace(/^\[|\]$/g, '')) ? [{ address: url.hostname.replace(/^\[|\]$/g, ''), family: net.isIPv6(url.hostname.replace(/^\[|\]$/g, '')) ? 6 : 4 }]
            : await dns.lookup(url.hostname, { all: true });
    } catch {
        throw new OpError(`Could not resolve host "${url.hostname}". Check the URL.`);
    }
    for (const { address, family } of addrs) {
        const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
        const blocked = mapped ? privateRanges.check(mapped[1], 'ipv4') : privateRanges.check(address, family === 6 ? 'ipv6' : 'ipv4');
        if (blocked) throw new OpError(`URL host "${url.hostname}" points to a private/local address, which is blocked.`);
    }
}

async function fetchUrl(source: string): Promise<Buffer> {
    if (!config.allowUrls) throw new OpError('Loading images from URLs is disabled on this server.');
    const limit = config.maxInputMb * 1024 * 1024;
    let url: URL;
    try {
        url = new URL(source);
    } catch {
        throw new OpError(`Invalid URL: ${source}`);
    }
    for (let hop = 0; hop < 6; hop++) {
        await assertPublicHost(url);
        let res: Response;
        try {
            res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(config.urlTimeoutMs), headers: { 'user-agent': 'yt-mcp/1.0 (image tools)' } });
        } catch (e) {
            if ((e as Error).name === 'TimeoutError') throw new OpError(`Timed out after ${config.urlTimeoutMs / 1000}s downloading ${url.href}`);
            throw new OpError(`Could not download ${url.href}: ${(e as Error).message}`);
        }
        if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
            url = new URL(res.headers.get('location')!, url);
            continue;
        }
        if (!res.ok) throw new OpError(`Could not download the image: ${url.href} answered HTTP ${res.status}` +
            (res.status === 401 || res.status === 403 ? ' (it needs a login or blocks downloads). ' + UPLOAD_HINT : '.'));
        if (/text\/html/i.test(res.headers.get('content-type') ?? ''))
            throw new OpError(`${url.href} is a web page, not an image file. Use the direct image address (right-click the image -> ` +
                '"Copy image address"), or ' + UPLOAD_HINT.charAt(0).toLowerCase() + UPLOAD_HINT.slice(1));
        const declared = Number(res.headers.get('content-length') ?? 0);
        if (declared > limit) throw new OpError(`Remote image is larger than ${config.maxInputMb} MB.`);
        const chunks: Buffer[] = [];
        let total = 0;
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
            total += chunk.length;
            if (total > limit) throw new OpError(`Remote image is larger than ${config.maxInputMb} MB.`);
            chunks.push(Buffer.from(chunk));
        }
        return Buffer.concat(chunks);
    }
    throw new OpError('Too many redirects.');
}

// ------------------------------------------------------------------ loading

/**
 * Base64 vs file path: base64 never contains '.', while an image path always has a '.ext'.
 * (Base64 JPEGs start with "/9j/", so "starts with /" is NOT a safe path test.)
 */
function looksLikeBase64(s: string): boolean {
    if (s.length <= 200 || s.includes('.') || /^[A-Za-z]:[\\/]/.test(s)) return false;
    return /^[A-Za-z0-9+/=\s_-]+$/.test(s);
}

export async function loadImage(source: string): Promise<Loaded> {
    if (!source || !source.trim()) throw new OpError(config.mode === 'http' ? 'No image given. ' + UPLOAD_HINT : 'No image given. Pass a file path, an https URL or base64 data.');
    const s = source.trim();
    let raw: Buffer;
    let name = 'image';
    let filePath: string | null = null;
    const stored = storedPathFromRef(s);

    if (stored) {
        try {
            raw = await fs.readFile(stored);
            await touchUpload(stored);
        } catch {
            if (UPLOAD_NAME.test(stored))
                throw new OpError(`That uploaded image has been deleted: uploads are removed ${config.uploadTtlMinutes} minutes after ` +
                    'their last use, for privacy. Upload it again (upload_image_data, or create_upload_link for the user), or keep ' +
                    'editing from a result link (`output`), which lasts ' + config.fileTtlHours + ' h.');
            throw new OpError(`That file link has expired (files are kept ${config.fileTtlHours} h) or does not exist. ` +
                'If it was an upload, ' + UPLOAD_HINT.charAt(0).toLowerCase() + UPLOAD_HINT.slice(1) + ' If it was a result, run that step again on the original.');
        }
        name = path.basename(stored).replace(/^[a-f0-9]{24}__/, '').replace(/\.[^.]+$/, '');
        if (config.mode === 'stdio') filePath = stored;
    } else if (/^https?:\/\//i.test(s)) {
        raw = await fetchUrl(s);
        name = safeStem(path.basename(new URL(s).pathname).replace(/\.[^.]+$/, '') || 'download');
    } else if (/^data:/i.test(s)) {
        const comma = s.indexOf(',');
        if (comma < 0) throw new OpError('Could not decode the data URI.');
        raw = Buffer.from(s.slice(comma + 1), 'base64');
        name = 'pasted';
    } else if (looksLikeBase64(s)) {
        raw = Buffer.from(s.replace(/\s+/g, ''), 'base64');
        name = 'pasted';
    } else {
        filePath = await resolveLocalPath(s);
        const st = await fs.stat(filePath);
        if (st.isDirectory()) throw new OpError(`${filePath} is a folder. Pass an image file, or use list_images / batch_convert_images.`);
        if (st.size > config.maxInputMb * 1024 * 1024)
            throw new OpError(`${path.basename(filePath)} is ${(st.size / 1048576).toFixed(1)} MB; the limit is ${config.maxInputMb} MB.`);
        raw = await fs.readFile(filePath);
        name = safeStem(path.basename(filePath).replace(/\.[^.]+$/, ''));
    }
    if (raw.length === 0) throw new OpError('The image data is empty.');
    if (raw.length > config.maxInputMb * 1024 * 1024) throw new OpError(`Image data is larger than ${config.maxInputMb} MB.`);
    let decoded: Decoded;
    try {
        decoded = await decode(raw);
    } catch (e) {
        if (name === 'pasted' && e instanceof OpError && /Could not read/.test(e.message))
            throw new OpError('The base64 text is not a valid image (it may be cut off, or typed out from an image you can only see). ' + UPLOAD_HINT);
        throw e;
    }
    return { ...decoded, name: safeStem(name), raw, path: filePath };
}

// ------------------------------------------------------------------ saving

export async function saveResult(img: Img, loaded: Pick<Loaded, 'name' | 'sourceFormat' | 'frames'>, tag: string,
    fmt?: string | null, opts: EncodeOptions = {}): Promise<Saved> {
    const key = fmt && fmt !== 'keep' ? normalizeFormat(fmt) : defaultFormat(loaded.sourceFormat, img, loaded.frames);
    const data = await encode(img, key, opts);
    return saveBytes(data, img, loaded.name, tag, key);
}

export async function saveBytes(data: Buffer, img: Img, stem: string, tag: string, key: FormatKey, dir?: string): Promise<Saved> {
    const stored = await saveFile(data, stem, tag, FORMATS[key].ext, dir);
    return { ...stored, format: key, sizeBytes: data.length, width: img.width, height: img.height, img };
}

// ------------------------------------------------------------------ replies

export type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
export interface ToolReply { content: Content[]; isError?: boolean; [k: string]: unknown }

export function humanSize(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1048576).toFixed(2)} MB`;
}

export async function previewContent(img: Img): Promise<Content> {
    const max = config.previewMaxPx;
    const s = toSharp(img).resize(max, max, { fit: 'inside', withoutEnlargement: true });
    if (hasAlpha(img)) return { type: 'image', data: (await s.png({ compressionLevel: 9 }).toBuffer()).toString('base64'), mimeType: 'image/png' };
    return { type: 'image', data: (await s.removeAlpha().jpeg({ quality: 82 }).toBuffer()).toString('base64'), mimeType: 'image/jpeg' };
}

export async function reply(summary: Record<string, unknown>, preview?: Img | null): Promise<ToolReply> {
    const clean = Object.fromEntries(Object.entries(summary).filter(([, v]) => v !== undefined && v !== null));
    const content: Content[] = [{ type: 'text', text: JSON.stringify(clean, null, 2) }];
    if (preview) content.push(await previewContent(preview));
    return { content };
}

export function outputFields(saved: Saved): Record<string, unknown> {
    return config.mode === 'http'
        ? { output: saved.ref, download_url: `${saved.url}?download=1`, format: saved.format, width: saved.width, height: saved.height, file_size: humanSize(saved.sizeBytes) }
        : { output_path: saved.path, format: saved.format, width: saved.width, height: saved.height, file_size: humanSize(saved.sizeBytes) };
}

export async function savedReply(saved: Saved, loaded?: Loaded | null, extra: Record<string, unknown> = {}, preview = true): Promise<ToolReply> {
    const summary: Record<string, unknown> = { ...outputFields(saved) };
    if (loaded) summary.original = { width: loaded.img.width, height: loaded.img.height, format: loaded.sourceFormat, file_size: humanSize(loaded.raw.length) };
    Object.assign(summary, extra);
    summary.tip = config.mode === 'http'
        ? 'Give the user download_url as a clickable link (expires in ' + config.fileTtlHours + ' h). To keep editing, pass `output` as `image` to the next tool.'
        : 'Pass output_path to another tool to keep editing, or save_image_to_folder to keep it.';
    return reply(summary, preview ? saved.img : null);
}
