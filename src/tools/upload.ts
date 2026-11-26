/**
 * upload_image_data (remote mode): lets the AI itself send an image to the server as base64 text, in parts.
 *
 * Why: an image attached in a chat cannot be passed to a tool, and an AI's code sandbox often has no internet access.
 * The tool call itself is the one channel that always works. Big images are split into parts; each part can carry a
 * short checksum, so a copying mistake is caught and only that part is sent again.
 * Uploads are deleted UPLOAD_TTL_MINUTES after their last use.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/server';
import { config } from '../config.js';
import { decode } from '../core/codec.js';
import { OpError } from '../core/img.js';
import { humanSize, reply } from '../core/io.js';
import { pendingDir, safeStem, saveFile } from '../core/storage.js';
import { registerTool, z } from './common.js';

const MAX_PART_CHARS = 200_000;
const ID = /^[a-f0-9]{16}$/;

/** First 8 hex characters of SHA-256 of the part text, exactly as sent (after removing whitespace). */
export const partChecksum = (text: string) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 8);

function cleanPart(data: string, first: boolean): string {
    let s = data.trim();
    if (first && /^data:/i.test(s)) {
        const comma = s.indexOf(',');
        if (comma < 0) throw new OpError('The data URI has no comma before the base64 data.');
        s = s.slice(comma + 1);
    }
    s = s.replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(s)) throw new OpError('This part is not base64 text (only A-Z, a-z, 0-9, +, /, = are allowed).');
    return s;
}

export function register(server: McpServer): void {
    registerTool(server, 'upload_image_data', {
        title: 'Upload image data (by the AI)',
        description:
            'Lets YOU (the AI) put an image on this server yourself, as base64 text, without the user doing anything. Use it when ' +
            'you can read the image file (for example a chat attachment in your code sandbox at /mnt/user-data/uploads/...) but ' +
            'cannot reach this server over the network. Returns an `image` link that works in every tool. ' +
            'How: (1) in your sandbox, if the file is over ~300 KB, shrink it first (e.g. longest side 2000 px, JPEG quality 90) ' +
            'and tell the user; (2) base64-encode it and split it into parts of at most 40,000 characters; (3) for each part compute ' +
            "checksum = first 8 hex chars of sha256(part text), e.g. Python hashlib.sha256(part.encode()).hexdigest()[:8]; " +
            '(4) send part 1 without upload_id, then the rest with the returned upload_id and part numbers, last=true on the final ' +
            'part. Copy each part exactly; if a checksum does not match, resend only that part. A small image fits in one call ' +
            `(part 1, last=true). Uploads are deleted ${config.uploadTtlMinutes} minutes after their last use.`,
        input: z.object({
            data: z.string().min(1).max(MAX_PART_CHARS).describe('This part of the base64 text (a data:image/...;base64, prefix is fine on part 1).'),
            part: z.number().int().min(1).max(500).default(1).describe('Part number, starting at 1.'),
            last: z.boolean().describe('true if this is the final (or only) part.'),
            upload_id: z.string().optional().describe('From the reply to part 1. Omit it on part 1.'),
            checksum: z.string().optional().describe('First 8 hex characters of sha256 of this part text. Strongly recommended for multi-part uploads.'),
            filename: z.string().max(120).optional().describe("Original file name, e.g. 'IMG_2041.png' (part 1 only)."),
        }),
    }, async a => {
        const first = a.part === 1;
        if (first && a.upload_id) throw new OpError('Part 1 starts a new upload: leave upload_id out.');
        if (!first && !a.upload_id) throw new OpError(`Part ${a.part} needs the upload_id returned for part 1.`);
        const text = cleanPart(a.data, first);
        if (a.checksum && partChecksum(text) !== a.checksum.trim().toLowerCase())
            throw new OpError(`Part ${a.part} arrived damaged (checksum ${partChecksum(text)} does not match ${a.checksum}). ` +
                `Resend part ${a.part} exactly as produced, with the same upload_id.`);

        const dir = pendingDir();
        await fs.mkdir(dir, { recursive: true });
        const id = first ? crypto.randomBytes(8).toString('hex') : String(a.upload_id);
        if (!ID.test(id)) throw new OpError('Unknown upload_id. Start again with part 1.');
        const dataFile = path.join(dir, `${id}.b64`);
        const metaFile = path.join(dir, `${id}.json`);
        let meta = { next: 1, filename: a.filename ?? 'image', chars: 0 };
        if (!first) {
            try {
                meta = JSON.parse(await fs.readFile(metaFile, 'utf8'));
            } catch {
                throw new OpError('This upload_id has expired (15 minutes without a new part) or does not exist. Start again with part 1.');
            }
            if (a.part < meta.next) return reply({ upload_id: id, note: `Part ${a.part} was already received; continue with part ${meta.next}.`, next_part: meta.next });
            if (a.part > meta.next) throw new OpError(`Expected part ${meta.next}, got part ${a.part}. Send part ${meta.next} next.`);
        }
        const limitChars = Math.ceil((config.maxInputMb * 1024 * 1024 * 4) / 3) + 4;
        if (meta.chars + text.length > limitChars) {
            await fs.rm(dataFile, { force: true }); await fs.rm(metaFile, { force: true });
            throw new OpError(`The image is larger than ${config.maxInputMb} MB. Shrink it first (e.g. longest side 2000 px, JPEG quality 90).`);
        }
        await fs.appendFile(dataFile, text);
        meta = { ...meta, next: a.part + 1, chars: meta.chars + text.length };

        if (!a.last) {
            await fs.writeFile(metaFile, JSON.stringify(meta));
            return reply({ upload_id: id, received_parts: a.part, received_characters: meta.chars, next_part: meta.next,
                next_step: `Send part ${meta.next} with upload_id "${id}" (last=true on the final part).` });
        }

        const b64 = await fs.readFile(dataFile, 'utf8');
        await fs.rm(dataFile, { force: true }); await fs.rm(metaFile, { force: true });
        const buf = Buffer.from(b64, 'base64');
        let decoded;
        try {
            decoded = await decode(buf);
        } catch (e) {
            throw new OpError(`All ${a.part} part(s) arrived, but together they are not a valid image (${(e as Error).message}). ` +
                'A part was probably changed while copying: start again with part 1 and send a checksum with every part.');
        }
        const ext = '.' + (decoded.sourceFormat ?? 'img');
        const stem = safeStem(path.basename(meta.filename, path.extname(meta.filename)));
        const stored = await saveFile(buf, stem, 'upload', ext);
        return reply({
            image: stored.ref, width: decoded.img.width, height: decoded.img.height, format: decoded.sourceFormat,
            file_size: humanSize(buf.length), parts: a.part,
            note: `Pass \`image\` to any tool. This upload is deleted ${config.uploadTtlMinutes} minutes after its last use; results last ${config.fileTtlHours} h.`,
        }, decoded.img);
    });
}
