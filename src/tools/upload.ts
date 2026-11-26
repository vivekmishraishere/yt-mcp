/**
 * upload_image_data (remote mode): lets the AI itself send an image to the server as base64 text.
 *
 * Why: an image attached in a chat cannot be passed to a tool, and an AI's code sandbox often has no internet access.
 * The tool call itself is the one channel that always works.
 *
 * Models copy long base64 imperfectly (measured: ~3 small errors per 10,000 characters), so the text is sent as small
 * numbered blocks, each with its own checksum. The server keeps every block that checks out and replies with exactly
 * which blocks to send again. A copying mistake therefore costs one small block, and an inserted or dropped character
 * never shifts into the next block. Uploads are deleted UPLOAD_TTL_MINUTES after their last use.
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

const ID = /^[a-f0-9]{16}$/;
const MAX_BLOCK_CHARS = 4000;
const MAX_BLOCKS = 2000;

/** First 8 hex characters of SHA-256 of the block text (whitespace removed). */
export const blockChecksum = (text: string) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 8);

function cleanBlock(data: string): string {
    let s = data.trim();
    if (/^data:/i.test(s)) s = s.slice(s.indexOf(',') + 1); // tolerate a data-URI prefix on the first block
    return s.replace(/\s+/g, '');
}

/** Compact list for replies: [3,4,5,9] -> "3-5, 9". */
function ranges(nums: number[]): string {
    const out: string[] = [];
    for (let i = 0; i < nums.length; i++) {
        let j = i;
        while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
        out.push(i === j ? `${nums[i]}` : `${nums[i]}-${nums[j]}`);
        i = j;
    }
    return out.join(', ');
}

const HOW_TO =
    'Steps in your sandbox (Python): b = base64.b64encode(open(path,"rb").read()).decode(); split b into blocks of 1000 ' +
    'characters; for each block print its number, checksum = hashlib.sha256(block.encode()).hexdigest()[:8], and the block. ' +
    'Then send the blocks, about 10-20 per call, copying each exactly. Copy mistakes are normal (roughly 1 block in 4): the ' +
    'reply lists the blocks to resend; resend just those until it returns the `image` link. Do not give up after a rejection.';

export function register(server: McpServer): void {
    registerTool(server, 'upload_image_data', {
        title: 'Upload image data (by the AI)',
        description:
            'Lets YOU (the AI) put an image on this server yourself, with no action from the user. Use it when you can read the ' +
            'image file (e.g. a chat attachment in your code sandbox at /mnt/user-data/uploads/...) but cannot reach this server ' +
            'over the network. The image travels as base64 text in numbered blocks of ~1000 characters, each with a checksum, so ' +
            'copying mistakes are caught and only the bad blocks are resent. Returns an `image` link that works in every tool. ' +
            HOW_TO + ' Size: every character costs output tokens, so if the base64 is over ~60,000 characters, first shrink the ' +
            'image (e.g. longest side 1600 px, JPEG quality 85) and tell the user; for full original quality of a big image, ' +
            `create_upload_link is better. Uploads are deleted ${config.uploadTtlMinutes} minutes after their last use.`,
        input: z.object({
            blocks: z.array(z.object({
                n: z.number().int().min(1).max(MAX_BLOCKS).describe('Block number, starting at 1.'),
                data: z.string().min(1).max(MAX_BLOCK_CHARS).describe('The block text, copied exactly.'),
                checksum: z.string().min(8).max(64).describe('First 8 hex characters of sha256 of the block text.'),
            })).min(1).max(100).describe('One or more blocks, in any order. 10-20 per call is a good size.'),
            total_blocks: z.number().int().min(1).max(MAX_BLOCKS).optional().describe('How many blocks the whole image has. Required on the first call.'),
            upload_id: z.string().optional().describe('From the reply to the first call. Omit it on the first call.'),
            filename: z.string().max(120).optional().describe("Original file name, e.g. 'IMG_2041.png' (first call only)."),
        }),
    }, async a => {
        const dir = pendingDir();
        await fs.mkdir(dir, { recursive: true });
        let id: string;
        let meta: { total: number; filename: string };
        if (!a.upload_id) {
            if (!a.total_blocks) throw new OpError('First call: give total_blocks (how many blocks the whole image has).');
            id = crypto.randomBytes(8).toString('hex');
            meta = { total: a.total_blocks, filename: a.filename ?? 'image' };
            await fs.mkdir(path.join(dir, id));
            await fs.writeFile(path.join(dir, `${id}.json`), JSON.stringify(meta));
        } else {
            id = a.upload_id.trim();
            if (!ID.test(id)) throw new OpError('Unknown upload_id. Start a new upload without upload_id.');
            try {
                meta = JSON.parse(await fs.readFile(path.join(dir, `${id}.json`), 'utf8'));
            } catch {
                throw new OpError('This upload_id has expired (15 minutes without new blocks) or does not exist. Start a new upload without upload_id.');
            }
        }
        const blockDir = path.join(dir, id);
        const maxChars = Math.ceil((config.maxInputMb * 1024 * 1024 * 4) / 3) + 4;
        if (meta.total * MAX_BLOCK_CHARS > maxChars * 2 && meta.total > Math.ceil(maxChars / 1000) + 10)
            throw new OpError(`That is more than ${config.maxInputMb} MB. Shrink the image first (e.g. longest side 1600 px, JPEG quality 85).`);

        const rejected: number[] = [];
        for (const b of a.blocks) {
            if (b.n > meta.total) throw new OpError(`Block ${b.n} is beyond total_blocks (${meta.total}).`);
            const text = cleanBlock(b.data);
            if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(text) || blockChecksum(text) !== b.checksum.trim().toLowerCase().slice(0, 8)) {
                rejected.push(b.n);
                continue;
            }
            await fs.writeFile(path.join(blockDir, String(b.n)), text);
        }
        await fs.utimes(path.join(dir, `${id}.json`), new Date(), new Date()).catch(() => {}); // keep alive while blocks arrive
        await fs.utimes(blockDir, new Date(), new Date()).catch(() => {});

        const have = new Set((await fs.readdir(blockDir)).map(Number));
        const missing: number[] = [];
        for (let i = 1; i <= meta.total; i++) if (!have.has(i)) missing.push(i);
        rejected.sort((x, y) => x - y);

        if (missing.length) {
            const resend = rejected.length ? `Resend block(s) ${ranges(rejected)} (copy mistakes, this is normal). ` : '';
            const notYet = missing.filter(m => !rejected.includes(m));
            return reply({
                upload_id: id, total_blocks: meta.total, received: have.size,
                rejected: rejected.length ? ranges(rejected) : undefined,
                still_needed: ranges(missing),
                next_step: resend + (notYet.length ? `Then send block(s) ${ranges(notYet.slice(0, 20))}${notYet.length > 20 ? ' and onward' : ''}. ` : '') +
                    `Use upload_id "${id}".`,
            });
        }

        // all blocks present: assemble, check it is a real image, store it
        let b64 = '';
        for (let i = 1; i <= meta.total; i++) b64 += await fs.readFile(path.join(blockDir, String(i)), 'utf8');
        await fs.rm(blockDir, { recursive: true, force: true });
        await fs.rm(path.join(dir, `${id}.json`), { force: true });
        if (b64.length > maxChars) throw new OpError(`The image is larger than ${config.maxInputMb} MB.`);
        const buf = Buffer.from(b64, 'base64');
        let decoded;
        try {
            decoded = await decode(buf);
        } catch (e) {
            throw new OpError(`All ${meta.total} blocks arrived, but together they are not a valid image (${(e as Error).message}). ` +
                'Check the blocks were cut from one base64 string in order, then start a new upload.');
        }
        const stem = safeStem(path.basename(meta.filename, path.extname(meta.filename)));
        const stored = await saveFile(buf, stem, 'upload', '.' + (decoded.sourceFormat ?? 'img'));
        return reply({
            image: stored.ref, width: decoded.img.width, height: decoded.img.height, format: decoded.sourceFormat,
            file_size: humanSize(buf.length), blocks: meta.total,
            note: `Pass \`image\` to any tool. This upload is deleted ${config.uploadTtlMinutes} minutes after its last use; results last ${config.fileTtlHours} h.`,
        }, decoded.img);
    });
}
