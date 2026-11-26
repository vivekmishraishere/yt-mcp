/**
 * End-to-end: start the BUILT server (run `npm run build` first; `npm test` does it) in HTTP and stdio mode and drive it
 * with the official MCP client, exactly like Claude would.
 */
import { spawn, ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY = path.join(ROOT, 'dist', 'server.js');
const FIX = (n: string) => path.join(ROOT, 'tests', 'fixtures', n);
const TOKEN = 'test-token-' + Math.random().toString(36).slice(2);
const PORT = 3400 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-mcp-e2e-'));

const text = (r: any) => r.content.find((c: any) => c.type === 'text')?.text as string;
const data = (r: any) => JSON.parse(text(r));

let server: ChildProcess;
let client: Client;

async function waitForHealth(): Promise<void> {
    for (let i = 0; i < 100; i++) {
        try {
            if ((await fetch(`${BASE}/health`)).ok) return;
        } catch { /* not up yet */ }
        await new Promise(r => setTimeout(r, 100));
    }
    throw new Error('server did not start');
}

describe('remote (Streamable HTTP at /mcp)', () => {
    beforeAll(async () => {
        if (!fs.existsSync(ENTRY)) throw new Error('Run `npm run build` first.');
        server = spawn(process.execPath, [ENTRY], {
            env: { ...process.env, PORT: String(PORT), MCP_AUTH_TOKEN: TOKEN, PUBLIC_BASE_URL: BASE, STORAGE_DIR: path.join(WORK, 'files'), HOST: '127.0.0.1' },
            stdio: ['ignore', 'ignore', 'pipe'],
        });
        await waitForHealth();
        client = new Client({ name: 'e2e', version: '1.0.0' });
        await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }));
    }, 30_000);
    afterAll(async () => {
        await client?.close().catch(() => {});
        server?.kill();
    });

    it('rejects requests without the token', async () => {
        const r = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' });
        expect(r.status).toBe(401);
        const bad = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { authorization: 'Bearer wrong' }, body: '{}' });
        expect(bad.status).toBe(401);
    });

    it('rejects a foreign Host header (DNS-rebinding protection)', async () => {
        const { request } = await import('node:http');
        const status = await new Promise<number>(resolve => {
            request({ host: '127.0.0.1', port: PORT, path: '/health', headers: { host: 'evil.example.com' } }, res => resolve(res.statusCode!)).end();
        });
        expect(status).toBe(403);
    });

    it('lists 31 tools with real descriptions, including the three upload tools', async () => {
        const { tools } = await client.listTools();
        expect(tools.length).toBe(31);
        expect(tools.map(t => t.name)).toContain('upload_image_file');
        expect(tools.map(t => t.name)).toContain('upload_image_data');
        expect(tools.map(t => t.name)).toContain('create_upload_link');
        expect(tools.map(t => t.name)).not.toContain('save_image_to_folder');
        for (const t of tools) expect((t.description ?? '').length).toBeGreaterThan(40);
        for (const t of tools.filter(t => t.name !== 'list_images')) expect(t.description, t.name).toContain('Use for:');
        expect(tools.find(t => t.name === 'create_upload_link')!.description).toMatch(/upload_image_data/);
        expect(tools.find(t => t.name === 'upload_image_data')!.description).toMatch(/checksum/);
        expect((tools.find(t => t.name === 'upload_image_file')!.inputSchema as any).properties.file['x-mcp-file'].maxSize).toBeGreaterThan(0);
        expect(client.getInstructions()).toMatch(/STEP 1[\s\S]*create_upload_link[\s\S]*download_url/);
    });

    it('upload link -> upload HEIC -> edit -> download', async () => {
        const link = data(await client.callTool({ name: 'create_upload_link', arguments: {} }));
        expect(link.message_for_user).toContain(link.upload_page);
        expect(link.direct_upload).toMatch(/^curl .*-F "file=@/);
        const page = await fetch(link.upload_page);
        expect(page.status).toBe(200);
        const t = new URL(link.upload_page).searchParams.get('t')!;
        const up = await fetch(`${BASE}/upload?t=${encodeURIComponent(t)}&name=photo.heic`, { method: 'POST', body: fs.readFileSync(FIX('sample.heic')) });
        const uploaded = await up.json();
        expect(up.status).toBe(200);
        expect(uploaded.format).toBe('heic');

        const res = await client.callTool({ name: 'convert_image_format', arguments: { image: uploaded.image, format: 'jpg' } });
        expect(res.isError).toBeFalsy();
        const out = data(res);
        expect(out.format).toBe('jpg');
        expect(res.content.some((c: any) => c.type === 'image')).toBe(true);
        const dl = await fetch(out.download_url);
        expect(dl.status).toBe(200);
        expect(dl.headers.get('content-type')).toBe('image/jpeg');
        expect(dl.headers.get('content-disposition')).toMatch(/^attachment/);
        expect(dl.headers.get('cache-control')).toMatch(/no-transform/); // CDNs must not re-compress results
        expect((await fetch(out.output)).headers.get('content-disposition')).toMatch(/^inline/);

        // multipart form upload (curl -F file=@...), as printed in direct_upload
        const form = new FormData();
        form.append('file', new Blob([fs.readFileSync(FIX('astronaut.jpg'))], { type: 'image/jpeg' }), 'me photo.jpg');
        const mp = await fetch(`${BASE}/upload?t=${encodeURIComponent(t)}`, { method: 'POST', body: form });
        const mpj = await mp.json();
        expect(mp.status).toBe(200);
        expect(mpj.format).toBe('jpg');
        expect(mpj.image).toMatch(/me_photo_upload\.jpg$/);

        expect((await fetch(`${BASE}/upload?t=123.abc`)).status).toBe(403);
        const junk = await fetch(`${BASE}/upload?t=${encodeURIComponent(t)}&name=x.png`, { method: 'POST', body: 'hello' });
        expect(junk.status).toBe(400);
    });

    it('chains tools: base64 in, faces blurred, ring, pipeline', async () => {
        const b64 = fs.readFileSync(FIX('astronaut.jpg')).toString('base64');
        const faces = data(await client.callTool({ name: 'detect_faces', arguments: { image: b64 } }));
        expect(faces.faces_found).toBe(1);
        const blurred = data(await client.callTool({ name: 'blur_image', arguments: { image: b64, detect: 'faces', style: 'pixelate' } }));
        expect(blurred.regions_blurred).toBe(1);
        const ring = data(await client.callTool({ name: 'create_profile_ring', arguments: { image: blurred.output, style: 'hiring', size: 400 } }));
        expect([ring.width, ring.format]).toEqual([400, 'png']);
        const pipe = data(await client.callTool({
            name: 'run_image_pipeline', arguments: {
                image: b64, output_format: 'webp',
                steps: [{ op: 'crop_aspect', aspect_ratio: '1:1' }, { op: 'apply_filter', filter: 'vintage' }, { op: 'add_text', text: 'Day 1' }, { op: 'resize', width: 200 }],
            },
        }));
        expect([pipe.width, pipe.format]).toEqual([200, 'webp']);
    }, 30_000);

    it('get_image_info shows a preview and a coordinate grid; no-face images get a grid to pick regions', async () => {
        const b64 = fs.readFileSync(FIX('astronaut.jpg')).toString('base64');
        const info = await client.callTool({ name: 'get_image_info', arguments: { image: b64, grid: true } });
        expect(info.content.some((c: any) => c.type === 'image')).toBe(true);
        expect(data(info).grid).toMatch(/red labels = x/);
        const plain = await client.callTool({ name: 'get_image_info', arguments: { image: b64, preview: false } });
        expect(plain.content.some((c: any) => c.type === 'image')).toBe(false);
        // a flat drawing: no faces, but a grid preview comes back and manual regions blur fine
        const { default: sharp } = await import('sharp');
        const drawing = (await sharp({ create: { width: 300, height: 200, channels: 3, background: '#ffcc00' } }).png().toBuffer()).toString('base64');
        const nf = await client.callTool({ name: 'detect_faces', arguments: { image: drawing } });
        expect(data(nf).faces_found).toBe(0);
        expect(data(nf).hint).toMatch(/regions/);
        expect(nf.content.some((c: any) => c.type === 'image')).toBe(true);
        const bl = data(await client.callTool({ name: 'blur_image', arguments: { image: drawing, regions: [{ x: 50, y: 40, width: 100, height: 80 }], shape: 'ellipse' } }));
        expect(bl.regions_blurred).toBe(1);
    }, 30_000);

    it('accepts typed values sent as text ("true", "8", JSON strings) and still advertises real types', async () => {
        const b64 = fs.readFileSync(FIX('astronaut.jpg')).toString('base64');
        const info = await client.callTool({ name: 'get_image_info', arguments: { image: b64, grid: 'true' as any } });
        expect(info.isError).toBeFalsy();
        expect(data(info).grid).toBeTruthy();
        const bl = await client.callTool({ name: 'blur_image', arguments: { image: b64, radius: '8' as any, regions: '[{"x":10,"y":10,"width":50,"height":50}]' as any } });
        expect(bl.isError).toBeFalsy();
        expect(data(bl).regions_blurred).toBe(1);
        const bad = await client.callTool({ name: 'blur_image', arguments: { image: b64, radius: 'strong' as any } });
        expect(bad.isError).toBe(true);
        const { tools } = await client.listTools();
        const schema = tools.find(t => t.name === 'get_image_info')!.inputSchema as any;
        expect(schema.properties.grid.type).toBe('boolean');
        expect(schema.required).toEqual(['image']);
    });

    it('compress_image warns when a format change makes the file bigger', async () => {
        const b64 = fs.readFileSync(FIX('astronaut.jpg')).toString('base64');
        const webp = data(await client.callTool({ name: 'compress_image', arguments: { image: b64, format: 'webp', level: 'small' } }));
        const back = data(await client.callTool({ name: 'compress_image', arguments: { image: webp.output, format: 'png', level: 'lossless' } }));
        expect(back.saved_percent).toBeLessThan(0);
        expect(back.warning).toMatch(/LARGER/);
        expect(webp.warning).toBeUndefined();
    }, 30_000);

    it('upload_image_data: the AI uploads in checksummed blocks; only bad blocks are resent', async () => {
        const { createHash } = await import('node:crypto');
        const sum = (t: string) => createHash('sha256').update(t).digest('hex').slice(0, 8);
        const { default: sharp } = await import('sharp');
        const orig = await sharp(FIX('astronaut.jpg')).resize(128).jpeg({ quality: 80 }).toBuffer(); // icon-sized
        const b64 = orig.toString('base64');
        const blocks = Array.from({ length: Math.ceil(b64.length / 1000) }, (_, i) => b64.slice(i * 1000, (i + 1) * 1000));
        expect(b64.length).toBeLessThan(20_000);
        const total = blocks.length;
        // first call: blocks 1-10, with copy mistakes in 3 and 7 (one changed letter, one doubled digit)
        const send = blocks.slice(0, 10).map((d, i) => ({ n: i + 1, data: d, checksum: sum(d) }));
        send[2] = { ...send[2], data: send[2].data.slice(0, 50) + (send[2].data[50] === 'Q' ? 'R' : 'Q') + send[2].data.slice(51) };
        send[6] = { ...send[6], data: send[6].data.slice(0, 80) + '0' + send[6].data.slice(80) };
        const r1 = data(await client.callTool({ name: 'upload_image_data', arguments: { blocks: send, total_blocks: total, filename: 'IMG 2041.jpg' } }));
        expect(r1.rejected).toBe('3, 7');
        expect(r1.received).toBe(Math.min(10, total) - 2);
        expect(r1.next_step).toMatch(/Resend block\(s\) 3, 7/);
        // resend the two bad blocks plus the rest, in any order
        const rest = [3, 7, ...Array.from({ length: total - 10 }, (_, i) => i + 11)].map(n => ({ n, data: blocks[n - 1], checksum: sum(blocks[n - 1]) })).reverse();
        const done = await client.callTool({ name: 'upload_image_data', arguments: { blocks: rest, upload_id: r1.upload_id } });
        const up = data(done);
        expect([up.width, up.height, up.format, up.blocks]).toEqual([128, 128, 'jpg', total]);
        expect(up.image).toMatch(/IMG_2041_upload\.jpg$/);
        const stored = Buffer.from(await (await fetch(up.image)).arrayBuffer());
        expect(stored.equals(orig)).toBe(true); // byte-exact
        expect((await client.callTool({ name: 'apply_filter', arguments: { image: up.image, filter: 'grayscale' } })).isError).toBeFalsy();
        // first call must say how many blocks; unknown ids are refused clearly
        const noTotal = await client.callTool({ name: 'upload_image_data', arguments: { blocks: [{ n: 1, data: blocks[0], checksum: sum(blocks[0]) }] } });
        expect(text(noTotal)).toMatch(/total_blocks/);
        const tooBig = await client.callTool({ name: 'upload_image_data', arguments: { total_blocks: 39, blocks: [{ n: 1, data: blocks[0], checksum: sum(blocks[0]) }] } });
        expect(text(tooBig)).toMatch(/too big to copy by hand.*create_upload_link/);
        const badId = await client.callTool({ name: 'upload_image_data', arguments: { blocks: [{ n: 1, data: 'AAAA', checksum: sum('AAAA') }], upload_id: 'ffffffffffffffff' } });
        expect(text(badId)).toMatch(/expired|does not exist/);
    }, 30_000);

    it('returns clean errors, never crashes', async () => {
        const cases: [string, Record<string, unknown>, RegExp][] = [
            ['get_image_info', { image: '/etc/passwd' }, /file name or path.*create_upload_link/],
            ['get_image_info', { image: '/mnt/user-data/uploads/IMG_2041.jpeg' }, /create_upload_link/],
            ['get_image_info', { image: 'A'.repeat(400) }, /base64 text is not a valid image.*create_upload_link/],
            ['get_image_info', { image: 'http://127.0.0.1:22/x.png' }, /private\/local address/],
            ['get_image_info', { image: `${BASE}/files/0123456789abcdef01234567__gone.png` }, /expired/],
            ['crop_image', { image: fs.readFileSync(FIX('astronaut.jpg')).toString('base64'), x: 9000, y: 0, width: 5, height: 5 }, /outside the image/],
        ];
        for (const [name, args, re] of cases) {
            const r = await client.callTool({ name, arguments: args });
            expect(r.isError, name).toBe(true);
            expect(text(r)).toMatch(re);
        }
        expect((await fetch(`${BASE}/health`)).ok).toBe(true);
    });
});

describe('public server (OPEN_ACCESS=1, no token)', () => {
    const OPEN_PORT = PORT + 1;
    const OPEN = `http://127.0.0.1:${OPEN_PORT}`;
    const DIR = path.join(WORK, 'open-files');
    let open: ChildProcess;
    let anon: Client;
    beforeAll(async () => {
        // 3 MB of old files in a 2 MB cap: the startup sweep must delete the oldest until it fits.
        fs.mkdirSync(DIR, { recursive: true });
        for (let i = 0; i < 3; i++) {
            const f = path.join(DIR, `${String(i).repeat(24)}__old${i}.png`);
            fs.writeFileSync(f, Buffer.alloc(1024 * 1024));
            const t = new Date(Date.now() - (10 - i) * 60_000);
            fs.utimesSync(f, t, t);
        }
        const env = { ...process.env, PORT: String(OPEN_PORT), OPEN_ACCESS: '1', PUBLIC_BASE_URL: OPEN, STORAGE_DIR: DIR, HOST: '127.0.0.1', MAX_STORAGE_MB: '2', SWEEP_SECONDS: '1' };
        delete env.MCP_AUTH_TOKEN;
        open = spawn(process.execPath, [ENTRY], { env, stdio: ['ignore', 'ignore', 'pipe'] });
        for (let i = 0; i < 100; i++) {
            try { if ((await fetch(`${OPEN}/health`)).ok) break; } catch { /* not up yet */ }
            await new Promise(r => setTimeout(r, 100));
        }
        anon = new Client({ name: 'anon', version: '1.0.0' });
        await anon.connect(new StreamableHTTPClientTransport(new URL(`${OPEN}/mcp`)));
    }, 30_000);
    afterAll(async () => {
        await anon?.close().catch(() => {});
        open?.kill();
    });

    it('works with no token and says it is public', async () => {
        const { tools } = await anon.listTools();
        expect(tools.length).toBe(31);
        expect((await (await fetch(OPEN)).json()).access).toBe('public');
    });

    it('never lists other people\'s files', async () => {
        const r = await anon.callTool({ name: 'list_images', arguments: {} });
        expect(r.isError).toBe(true);
        expect(text(r)).toMatch(/public server/);
    });

    it('upload link -> edit -> download, with no token', async () => {
        const link = data(await anon.callTool({ name: 'create_upload_link', arguments: {} }));
        const t = new URL(link.upload_page).searchParams.get('t')!;
        const up = await (await fetch(`${OPEN}/upload?t=${encodeURIComponent(t)}&name=a.jpg`, { method: 'POST', body: fs.readFileSync(FIX('astronaut.jpg')) })).json();
        const out = data(await anon.callTool({ name: 'apply_filter', arguments: { image: up.image, filter: 'grayscale' } }));
        expect((await fetch(out.download_url)).status).toBe(200);
        // a raw upload without a signed link is still refused (no anonymous file hosting)
        expect((await fetch(`${OPEN}/upload`, { method: 'POST', body: fs.readFileSync(FIX('astronaut.jpg')) })).status).toBe(403);
    });

    it('deletes uploads 5 minutes after their last use; using one resets the clock', async () => {
        const b64 = fs.readFileSync(FIX('astronaut.jpg')).toString('base64');
        const { createHash } = await import('node:crypto');
        const sum = (t: string) => createHash('sha256').update(t).digest('hex').slice(0, 8);
        const { default: sharp } = await import('sharp');
        const small = (await sharp(FIX('astronaut.jpg')).resize(128).jpeg({ quality: 80 }).toBuffer()).toString('base64');
        const one = async (name: string) => {
            const blocks = Array.from({ length: Math.ceil(small.length / 1000) }, (_, i) => small.slice(i * 1000, (i + 1) * 1000));
            return data(await anon.callTool({ name: 'upload_image_data', arguments: { total_blocks: blocks.length, filename: name, blocks: blocks.map((d, i) => ({ n: i + 1, data: d, checksum: sum(d) })) } }));
        };
        const old = await one('old.jpg');
        const used = await one('used.jpg');
        const result = data(await anon.callTool({ name: 'apply_filter', arguments: { image: used.image, filter: 'sepia' } }));
        const file = (u: string) => path.join(DIR, u.split('/files/')[1]);
        const sixMinAgo = new Date(Date.now() - 6 * 60_000), fourMinAgo = new Date(Date.now() - 4 * 60_000);
        fs.utimesSync(file(old.image), sixMinAgo, sixMinAgo);
        fs.utimesSync(file(used.image), fourMinAgo, fourMinAgo);
        expect((await anon.callTool({ name: 'get_image_info', arguments: { image: used.image, preview: false } })).isError).toBeFalsy(); // use resets clock
        await new Promise(r => setTimeout(r, 2500)); // > one sweep
        expect(fs.existsSync(file(old.image))).toBe(false);
        expect(fs.existsSync(file(used.image))).toBe(true);
        expect(fs.existsSync(file(result.output))).toBe(true); // results keep their own, longer lifetime
        const gone = await anon.callTool({ name: 'get_image_info', arguments: { image: old.image } });
        expect(text(gone)).toMatch(/deleted: uploads are removed 5 minutes after/);
    }, 20_000);

    it('upload_image_file: Claude file-transfer extension (upload target, PUT, second call)', async () => {
        const { createHash } = await import('node:crypto');
        const bytes = fs.readFileSync(FIX('astronaut.jpg'));
        const file = { id: 'file-1', name: 'me.jpg', mimeType: 'image/jpeg', size: bytes.length, digest: { algorithm: 'sha-256', value: createHash('sha256').update(bytes).digest('base64url') } };
        const meta = (upload = true) => ({ 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 't', version: '1' },
            'io.modelcontextprotocol/clientCapabilities': { extensions: upload ? { 'io.modelcontextprotocol/files': { upload: {} } } : {} } });
        const rpc = async (id: number, method: string, params: any, upload = true) => {
            const r = await fetch(`${OPEN}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
                'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': method, ...(params.name ? { 'Mcp-Name': params.name } : {}) },
                body: JSON.stringify({ jsonrpc: '2.0', id, method, params: { ...params, _meta: meta(upload) } }) });
            const t = await r.text();
            const line = t.split('\n').find(l => l.startsWith('data:'));
            return { status: r.status, body: JSON.parse(line ? line.slice(5) : t) };
        };
        const disc = await rpc(1, 'server/discover', {});
        expect(disc.body.result.capabilities.extensions['io.modelcontextprotocol/files']).toEqual({ upload: {} });
        const first = (await rpc(2, 'tools/call', { name: 'upload_image_file', arguments: { file } })).body.result;
        expect(first.resultType).toBe('upload_required');
        expect(first.uploads[0]).toMatchObject({ fileId: 'file-1', method: 'PUT', credentials: 'omit' });
        expect((await fetch(first.uploads[0].url, { method: 'PUT', headers: first.uploads[0].headers, body: bytes.subarray(0, 10) })).status).toBe(400);
        expect((await fetch(first.uploads[0].url.replace(/sig=[^&]+/, 'sig=x'), { method: 'PUT', headers: first.uploads[0].headers, body: bytes })).status).toBe(403);
        expect((await fetch(first.uploads[0].url, { method: 'PUT', headers: first.uploads[0].headers, body: bytes })).status).toBe(200);
        const changed = await rpc(3, 'tools/call', { name: 'upload_image_file', arguments: { file: { ...file, name: 'x.jpg' } }, requestState: first.requestState });
        expect(changed.body.error.code).toBe(-32602);
        const second = (await rpc(4, 'tools/call', { name: 'upload_image_file', arguments: { file }, requestState: first.requestState })).body.result;
        expect(second.isError).toBeFalsy();
        const info = JSON.parse(second.content[0].text);
        expect(Buffer.from(await (await fetch(info.image)).arrayBuffer()).equals(bytes)).toBe(true);
        expect((await rpc(5, 'tools/call', { name: 'upload_image_file', arguments: { file }, requestState: first.requestState })).body.error.code).toBe(-32602); // replay
        const noExt = await rpc(6, 'tools/call', { name: 'upload_image_file', arguments: { file } }, false);
        expect([noExt.status, noExt.body.error.code]).toEqual([400, -32021]);
        expect(noExt.body.error.message).toMatch(/upload_image_data or create_upload_link/);
    });

    it('keeps storage under MAX_STORAGE_MB by deleting the oldest files', () => {
        const left = fs.readdirSync(DIR).filter(n => n.includes('__old'));
        expect(left).not.toContain(`${'0'.repeat(24)}__old0.png`);
        expect(left).toContain(`${'2'.repeat(24)}__old2.png`);
    });
});

describe('local (stdio)', () => {
    let local: Client;
    beforeAll(async () => {
        local = new Client({ name: 'e2e-stdio', version: '1.0.0' });
        await local.connect(new StdioClientTransport({
            command: process.execPath, args: [ENTRY, '--stdio'],
            env: { ...(process.env as Record<string, string>), STORAGE_DIR: path.join(WORK, 'out'), ALLOWED_DIRS: ROOT + path.delimiter + WORK },
            stderr: 'ignore',
        }));
    }, 30_000);
    afterAll(async () => { await local?.close().catch(() => {}); });

    it('lists 29 tools including save_image_to_folder', async () => {
        const { tools } = await local.listTools();
        expect(tools.length).toBe(29);
        expect(tools.map(t => t.name)).toContain('save_image_to_folder');
    });

    it('reads local paths, writes new files, never overwrites', async () => {
        const r = data(await local.callTool({ name: 'resize_image', arguments: { image: FIX('astronaut.jpg'), width: 100 } }));
        expect(fs.existsSync(r.output_path)).toBe(true);
        const a = data(await local.callTool({ name: 'save_image_to_folder', arguments: { image: r.output_path, folder: path.join(WORK, 'final'), filename: 'pic' } }));
        const b = data(await local.callTool({ name: 'save_image_to_folder', arguments: { image: r.output_path, folder: path.join(WORK, 'final'), filename: 'pic' } }));
        expect(path.basename(a.saved_to)).toBe('pic.jpg');
        expect(path.basename(b.saved_to)).toBe('pic-2.jpg');
        const denied = await local.callTool({ name: 'get_image_info', arguments: { image: '/etc/hosts' } });
        expect(denied.isError).toBe(true);
        expect(text(denied)).toMatch(/outside the allowed folders/);
    });
});
