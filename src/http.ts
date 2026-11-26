/**
 * Remote mode: Express app with
 *   POST/GET/DELETE /mcp   MCP Streamable HTTP endpoint (bearer token, or open to anyone with OPEN_ACCESS=1)
 *   GET  /files/:name      download / view a result (unguessable names, expire after FILE_TTL_HOURS)
 *   GET  /upload?t=...     upload page (signed, expiring link from the create_upload_link tool)
 *   POST /upload?t=...     raw image upload -> returns an image link usable by every tool
 *   GET  /health           health check
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { hostHeaderValidation } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import express, { NextFunction, Request, Response } from 'express';
import { isAuthorized, verifyUploadToken } from './auth.js';
import { config } from './config.js';
import { FORMATS } from './core/codec.js';
import { decode } from './core/codec.js';
import { humanSize } from './core/io.js';
import { STORED_NAME, cleanupExpired, requestContext, saveFile, safeStem } from './core/storage.js';
import { createServer } from './mcp.js';

const MIME_BY_EXT: Record<string, string> = Object.fromEntries(Object.values(FORMATS).map(f => [f.ext, f.mime]));

/** Fixed-window counter. keyFn decides what is limited (an IP, or one global bucket). */
function makeLimiter(perMinute: number) {
    const hits = new Map<string, { n: number; reset: number }>();
    setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.reset < now) hits.delete(k); }, 60_000).unref();
    return {
        /** Count one hit; returns seconds to wait if over the limit, else 0. */
        hit(key: string): number {
            const now = Date.now();
            const h = hits.get(key) ?? { n: 0, reset: now + 60_000 };
            if (h.reset < now) { h.n = 0; h.reset = now + 60_000; }
            h.n++;
            hits.set(key, h);
            return h.n > perMinute ? Math.ceil((h.reset - now) / 1000) : 0;
        },
        blocked(key: string): number {
            const h = hits.get(key);
            return h && h.reset > Date.now() && h.n >= perMinute ? Math.ceil((h.reset - Date.now()) / 1000) : 0;
        },
    };
}

/** First file part of a multipart/form-data body (curl -F file=@photo.png). Returns null if there is none. */
export function firstMultipartFile(body: Buffer, contentType: string): { data: Buffer; filename: string } | null {
    const m = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
    if (!m) return null;
    const delim = Buffer.from('--' + (m[1] ?? m[2]).trim());
    let pos = body.indexOf(delim);
    while (pos >= 0) {
        const start = pos + delim.length;
        if (body.slice(start, start + 2).toString() === '--') break; // closing delimiter
        const headEnd = body.indexOf('\r\n\r\n', start);
        if (headEnd < 0) break;
        const headers = body.slice(start, headEnd).toString('utf8');
        const next = body.indexOf(delim, headEnd + 4);
        if (next < 0) break;
        const fn = headers.match(/filename\*?=(?:UTF-8'')?"?([^";\r\n]*)"?/i);
        if (fn) return { data: body.slice(headEnd + 4, next - 2), filename: decodeURIComponent(fn[1]) || 'upload' };
        pos = next;
    }
    return null;
}

function tooMany(res: Response, wait: number) {
    res.setHeader('Retry-After', wait);
    return res.status(429).json({ error: 'Too many requests, slow down.' });
}

function requestBase(req: Request): string {
    if (config.publicBaseUrl) return config.publicBaseUrl;
    const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim() || req.protocol;
    return `${proto}://${req.get('host')}`;
}

function allowedHostnames(): string[] | null {
    const hosts = new Set(config.allowedHosts);
    if (config.publicBaseUrl) hosts.add(new URL(config.publicBaseUrl).hostname);
    if (!hosts.size) return null; // not configured: accept any Host (logged at startup)
    for (const h of ['localhost', '127.0.0.1', '[::1]']) hosts.add(h);
    return [...hosts];
}

const UPLOAD_PAGE = (maxMb: number) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Upload an image</title><style>
:root{color-scheme:light dark;--bg:#f6f7f9;--card:#fff;--fg:#14171a;--muted:#5b6470;--accent:#0a66c2;--border:#d8dde3}
@media (prefers-color-scheme:dark){:root{--bg:#0f1216;--card:#181c21;--fg:#e8ecf0;--muted:#9aa4ae;--accent:#4b9bf0;--border:#2a3038}}
body{margin:0;font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--fg);display:grid;place-items:center;min-height:100vh;padding:16px;box-sizing:border-box}
.card{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:28px;max-width:520px;width:100%}
h1{font-size:20px;margin:0 0 6px}p{color:var(--muted);margin:0 0 18px}
label{display:block;border:2px dashed var(--border);border-radius:12px;padding:28px;text-align:center;cursor:pointer}
label:hover{border-color:var(--accent)}input[type=file]{display:none}
#out{margin-top:18px;display:none}#link{width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--fg);font:13px ui-monospace,monospace}
button{margin-top:10px;background:var(--accent);color:#fff;border:0;border-radius:8px;padding:10px 16px;font-weight:600;cursor:pointer}
img{max-width:100%;border-radius:8px;margin-top:12px}.err{color:#d93025}
</style></head><body><div class="card"><h1>Upload an image</h1>
<p>JPG, PNG, WebP, HEIC, AVIF, GIF, TIFF or BMP, up to ${maxMb} MB. After uploading, copy the link and paste it back into your Claude chat.</p>
<label id="drop">Choose or drop an image<input id="file" type="file" accept="image/*,.heic,.heif"></label>
<div id="status"></div><div id="out"><input id="link" readonly><button id="copy">Copy link</button><img id="prev" alt=""></div></div>
<script>
const t=new URLSearchParams(location.search).get('t');const st=document.getElementById('status');
async function send(f){st.className='';st.textContent='Uploading '+f.name+'...';
 const r=await fetch('/upload?t='+encodeURIComponent(t)+'&name='+encodeURIComponent(f.name),{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:f});
 const j=await r.json().catch(()=>({error:'Upload failed ('+r.status+')'}));
 if(!r.ok){st.className='err';st.textContent=j.error||'Upload failed';return}
 st.textContent='Uploaded ('+j.width+'x'+j.height+', '+j.file_size+'). Copy this link and paste it into your Claude chat:';
 document.getElementById('out').style.display='block';document.getElementById('link').value=j.image;document.getElementById('prev').src=j.image;}
document.getElementById('file').onchange=e=>e.target.files[0]&&send(e.target.files[0]);
const d=document.getElementById('drop');d.ondragover=e=>{e.preventDefault()};d.ondrop=e=>{e.preventDefault();e.dataTransfer.files[0]&&send(e.dataTransfer.files[0])};
document.getElementById('copy').onclick=async()=>{const l=document.getElementById('link');l.select();await navigator.clipboard.writeText(l.value).catch(()=>{});document.getElementById('copy').textContent='Copied'};
</script></body></html>`;

export async function startHttp(): Promise<void> {
    if (!config.authToken && !config.openAccess) {
        console.error('[yt-mcp] Refusing to start: set MCP_AUTH_TOKEN (a long random secret) for a private server, ' +
            'or OPEN_ACCESS=1 for a public server that anyone with the URL can use.');
        process.exit(1);
    }
    if (config.openAccess) {
        console.error(`[yt-mcp] OPEN_ACCESS: public server, no token needed. Limits: ${config.rateLimitPerMinute} MCP requests/min, ` +
            `${config.maxConcurrentJobs} jobs at a time, ${config.maxStorageMb} MB storage, files kept ${config.fileTtlHours} h.`);
    }
    try {
        await fs.mkdir(config.storageDir, { recursive: true });
        await fs.access(config.storageDir, (await import('node:fs')).constants.W_OK);
    } catch (e) {
        const fallback = path.join((await import('node:os')).tmpdir(), 'yt-mcp-files');
        console.error(`[yt-mcp] STORAGE_DIR ${config.storageDir} is not writable (${(e as Error).message}); using ${fallback}`);
        config.storageDir = fallback;
        await fs.mkdir(fallback, { recursive: true });
    }
    console.error(`[yt-mcp] storing uploads and results in ${config.storageDir}`);

    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', 1); // behind Hostinger's / any reverse proxy: use X-Forwarded-For / -Proto
    const hosts = allowedHostnames();
    if (hosts) app.use(hostHeaderValidation(hosts));
    else console.error('[yt-mcp] Warning: PUBLIC_BASE_URL / ALLOWED_HOSTS not set, so the Host header is not validated.');
    app.use((req, _res, next) => requestContext.run({ baseUrl: requestBase(req) }, next));
    app.use((req, res, next) => {
        const t = Date.now();
        res.on('finish', () => console.error(`[yt-mcp] ${req.method} ${req.path} ${res.statusCode} ${Date.now() - t}ms`));
        next();
    });

    app.get('/', (_req, res) => {
        res.json({
            name: 'yt-mcp', version: config.version, mcp_endpoint: '/mcp', access: config.openAccess ? 'public' : 'token',
            docs: config.openAccess
                ? 'Public MCP server with 29 image tools. Add this URL + /mcp as a custom connector in Claude (no token needed).'
                : 'Connect an MCP client to /mcp with Authorization: Bearer <token>.',
        });
    });
    app.get('/health', (_req, res) => { res.json({ ok: true, version: config.version, uptime_s: Math.round(process.uptime()) }); });

    // ---- MCP endpoint
    const handler = createMcpHandler(() => createServer());
    const node = toNodeHandler(handler);
    const jsonLimit = `${Math.ceil(config.maxInputMb * 1.4) + 1}mb`; // base64 images inside tool arguments
    // Claude's cloud sends many users' traffic from shared IPs, so authorised traffic gets one generous global budget,
    // while failed logins are limited per IP (brute-force protection).
    const authFailures = makeLimiter(20);
    const mcpBudget = makeLimiter(config.rateLimitPerMinute);
    const perIp = config.rateLimitPerIp > 0 ? makeLimiter(config.rateLimitPerIp) : null;
    app.all('/mcp', (req, res, next) => {
        if (!isAuthorized(req.headers, req.query as Record<string, unknown>)) {
            // only failures are counted, so a valid token is never locked out by someone else's bad attempts
            const ip = req.ip ?? 'unknown';
            const wait = authFailures.blocked(ip);
            if (wait) return tooMany(res, wait);
            authFailures.hit(ip);
            res.setHeader('WWW-Authenticate', 'Bearer realm="yt-mcp"');
            return res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized: send Authorization: Bearer <MCP_AUTH_TOKEN>' }, id: null });
        }
        const ipWait = perIp?.hit(req.ip ?? 'unknown') ?? 0;
        if (ipWait) return tooMany(res, ipWait);
        const over = mcpBudget.hit('all');
        if (over) return tooMany(res, over);
        next();
    }, express.json({ limit: jsonLimit }), (req, res) => {
        const base = requestBase(req);
        requestContext.run({ baseUrl: base }, () => void node(req as any, res as any, req.body));
    });

    // ---- results download
    app.get('/files/:name', async (req, res) => {
        const name = String(req.params.name);
        if (!STORED_NAME.test(name)) return res.status(404).json({ error: 'Not found' });
        const file = path.join(config.storageDir, name);
        try {
            const data = await fs.readFile(file);
            res.setHeader('Content-Type', MIME_BY_EXT[path.extname(name).toLowerCase()] ?? 'application/octet-stream');
            res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${name.replace(/^[a-f0-9]{24}__/, '')}"`);
            res.setHeader('Cache-Control', 'private, max-age=3600');
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
            res.send(data);
        } catch {
            res.status(404).json({ error: 'This file has expired or does not exist.' });
        }
    });

    // ---- uploads (signed link from create_upload_link, or the bearer token)
    const uploadAllowed = (req: Request) => verifyUploadToken(req.query.t) || (config.authToken !== '' && isAuthorized(req.headers, {}));
    app.get('/upload', (req, res) => {
        if (!verifyUploadToken(req.query.t)) return res.status(403).type('text/plain').send('This upload link is invalid or has expired. Ask Claude for a new one (create_upload_link).');
        res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' blob: data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'");
        res.type('html').send(UPLOAD_PAGE(config.maxInputMb));
    });
    const uploads = makeLimiter(config.uploadsPerMinute);
    app.post('/upload', (req, res, next) => {
        if (!uploadAllowed(req)) return res.status(403).json({ error: 'Upload link invalid or expired.' });
        const over = uploads.hit('all');
        if (over) return tooMany(res, over);
        next();
    }, express.raw({ type: () => true, limit: `${config.maxInputMb}mb` }), async (req, res) => {
        try {
            let buf = req.body as Buffer;
            if (!Buffer.isBuffer(buf) || !buf.length) return res.status(400).json({ error: 'Empty upload.' });
            let orig = String(req.query.name ?? 'upload');
            const ctype = String(req.headers['content-type'] ?? '');
            if (/^multipart\/form-data/i.test(ctype)) {
                const part = firstMultipartFile(buf, ctype);
                if (!part || !part.data.length) return res.status(400).json({ error: 'No file found in the form upload (use -F "file=@photo.png").' });
                buf = part.data;
                if (!req.query.name) orig = part.filename;
            }
            const decoded = await decode(buf); // validates it is a real, supported image within the pixel limit
            const ext = path.extname(orig).toLowerCase().replace('.jpeg', '.jpg').replace('.heif', '.heic');
            const keepExt = /^\.(jpg|png|webp|heic|avif|gif|tif|tiff|bmp)$/.test(ext) ? ext : '.' + (decoded.sourceFormat ?? 'img');
            const stored = await requestContext.run({ baseUrl: requestBase(req) }, () => saveFile(buf, safeStem(path.basename(orig, path.extname(orig))), 'upload', keepExt));
            res.json({ image: stored.ref, next_step: 'Pass `image` to any yt-mcp tool.', width: decoded.img.width, height: decoded.img.height, format: decoded.sourceFormat, file_size: humanSize(buf.length) });
        } catch (e) {
            res.status(400).json({ error: (e as Error).message });
        }
    });

    app.use((err: Error & { status?: number; type?: string }, _req: Request, res: Response, _next: NextFunction) => {
        if (err.type === 'entity.too.large') return res.status(413).json({ error: `Too large (max ${config.maxInputMb} MB image).` });
        console.error('[yt-mcp] HTTP error:', err.stack ?? err);
        res.status(err.status ?? 500).json({ error: err.status && err.status < 500 ? err.message : 'Internal error' });
    });

    // ---- periodic cleanup of expired files
    const sweep = async () => { const n = await cleanupExpired().catch(() => 0); if (n) console.error(`[yt-mcp] cleaned up ${n} expired files`); };
    void sweep();
    setInterval(sweep, 5 * 60_000).unref();

    const listener = app.listen(config.port, config.host, () => {
        console.error(`[yt-mcp] ${config.version} listening on http://${config.host}:${config.port}  (MCP endpoint: /mcp)` +
            (config.publicBaseUrl ? `  public: ${config.publicBaseUrl}/mcp` : ''));
    });
    const shutdown = async () => {
        listener.close();
        await handler.close?.();
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}
