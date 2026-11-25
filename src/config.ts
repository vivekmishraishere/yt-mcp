/** Settings from environment variables (see .env.example). Read once at startup. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type Mode = 'stdio' | 'http';

const env = process.env;

function flag(name: string, def: boolean): boolean {
    const v = env[name];
    if (v === undefined || v.trim() === '') return def;
    return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
}

function num(name: string, def: number): number {
    const v = env[name];
    if (v === undefined || v.trim() === '') return def;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`Environment variable ${name} must be a number (got "${v}")`);
    return n;
}

/** Expand ~ and resolve symlinks when the folder exists (e.g. macOS /var -> /private/var), so path checks compare like with like. */
function expand(p: string): string {
    const abs = path.resolve(p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);
    try {
        return fs.realpathSync(abs);
    } catch {
        return abs;
    }
}

export const MODE: Mode = process.argv.includes('--stdio') || env.MCP_TRANSPORT === 'stdio' ? 'stdio' : 'http';

export const config = {
    mode: MODE,
    version: '1.0.0',

    // ---- HTTP (remote) ----
    port: num('PORT', 3000),
    host: env.HOST ?? '0.0.0.0',
    /** Public URL of this deployment, e.g. https://mcp.example.com (used to build download / upload links). */
    publicBaseUrl: (env.PUBLIC_BASE_URL ?? '').replace(/\/+$/, ''),
    /** Hostnames allowed in the Host header (DNS-rebinding protection). Empty = derive from PUBLIC_BASE_URL. */
    allowedHosts: (env.ALLOWED_HOSTS ?? '').split(',').map(s => s.trim()).filter(Boolean),
    /** Shared secret clients must send as `Authorization: Bearer <token>` (or ?key=<token>). Required in HTTP mode. */
    authToken: env.MCP_AUTH_TOKEN ?? '',
    allowNoAuth: flag('ALLOW_NO_AUTH', false),
    /** Accept the token as ?key=... in the URL, for clients that can only take a URL (e.g. claude.ai custom connectors). */
    allowQueryToken: flag('ALLOW_QUERY_TOKEN', true),
    /** Max authorised MCP requests per minute for the whole server (one tool call = 1-3 requests). */
    rateLimitPerMinute: num('RATE_LIMIT_PER_MINUTE', 600),
    maxConcurrentJobs: num('MAX_CONCURRENT_JOBS', 2),
    fileTtlHours: num('FILE_TTL_HOURS', 24),

    // ---- storage ----
    storageDir: expand(env.STORAGE_DIR ?? (MODE === 'stdio' ? '~/ImageMCP/output' : path.join(os.tmpdir(), 'yt-mcp-files'))),

    // ---- inputs ----
    maxInputMb: num('MAX_INPUT_MB', 25),
    maxPixels: num('MAX_PIXELS', 60_000_000),
    allowUrls: flag('ALLOW_URLS', true),
    blockPrivateUrls: flag('BLOCK_PRIVATE_URLS', true),
    urlTimeoutMs: num('URL_TIMEOUT_MS', 20_000),
    /** Local file paths are only allowed in stdio (local) mode unless explicitly enabled. */
    allowLocalPaths: flag('ALLOW_LOCAL_PATHS', MODE === 'stdio'),
    allowedDirs: (env.ALLOWED_DIRS ? env.ALLOWED_DIRS.split(path.delimiter) : [os.homedir()]).filter(Boolean).map(expand),

    previewMaxPx: num('PREVIEW_MAX_PX', 768),
    sharpThreads: num('SHARP_THREADS', 2),
};

if (!config.allowedDirs.includes(config.storageDir)) config.allowedDirs.push(config.storageDir);
