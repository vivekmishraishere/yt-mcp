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

    it('lists 29 tools with real descriptions, including create_upload_link', async () => {
        const { tools } = await client.listTools();
        expect(tools.length).toBe(29);
        expect(tools.map(t => t.name)).toContain('create_upload_link');
        expect(tools.map(t => t.name)).not.toContain('save_image_to_folder');
        for (const t of tools) expect((t.description ?? '').length).toBeGreaterThan(40);
    });

    it('upload link -> upload HEIC -> edit -> download', async () => {
        const link = data(await client.callTool({ name: 'create_upload_link', arguments: {} }));
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

    it('returns clean errors, never crashes', async () => {
        const cases: [string, Record<string, unknown>, RegExp][] = [
            ['get_image_info', { image: '/etc/passwd' }, /not available on this remote server/],
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
        const env = { ...process.env, PORT: String(OPEN_PORT), OPEN_ACCESS: '1', PUBLIC_BASE_URL: OPEN, STORAGE_DIR: DIR, HOST: '127.0.0.1', MAX_STORAGE_MB: '2' };
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
        expect(tools.length).toBe(29);
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
