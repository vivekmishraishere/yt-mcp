/** Bearer-token check for /mcp and signed, expiring upload links for /upload. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

// Upload links are signed with a key derived from UPLOAD_SECRET or MCP_AUTH_TOKEN. In open mode without either, a random
// key is kept in the storage folder so links survive a restart (and a new random key is used if it cannot be stored).
function loadSigningSecret(): string {
    if (config.uploadSecret || config.authToken) return config.uploadSecret || config.authToken;
    if (config.mode !== 'http') return crypto.randomBytes(32).toString('hex');
    const file = path.join(config.storageDir, '.upload-secret');
    try {
        return fs.readFileSync(file, 'utf8').trim() || '';
    } catch { /* first start */ }
    const secret = crypto.randomBytes(32).toString('hex');
    try {
        fs.mkdirSync(config.storageDir, { recursive: true });
        fs.writeFileSync(file, secret, { mode: 0o600, flag: 'wx' });
        return secret;
    } catch {
        try { return fs.readFileSync(file, 'utf8').trim() || secret; } catch { return secret; }
    }
}
const signingKey = crypto.createHash('sha256').update('yt-mcp-upload:' + loadSigningSecret()).digest();

function safeEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a), bb = Buffer.from(b);
    return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/** True if the request carries the right token (Authorization: Bearer, or ?key= when allowed). */
export function isAuthorized(headers: Record<string, string | string[] | undefined>, query: Record<string, unknown>): boolean {
    if (!config.authToken) return config.openAccess;
    const h = headers['authorization'];
    const header = Array.isArray(h) ? h[0] : h;
    if (header && /^bearer\s+/i.test(header) && safeEqual(header.replace(/^bearer\s+/i, '').trim(), config.authToken)) return true;
    const key = typeof query.key === 'string' ? query.key : '';
    return config.allowQueryToken && !!key && safeEqual(key, config.authToken);
}

export function makeUploadToken(minutes: number): { token: string; expiresAt: Date } {
    const exp = Math.floor(Date.now() / 1000) + Math.round(minutes * 60);
    const sig = crypto.createHmac('sha256', signingKey).update(`upload:${exp}`).digest('base64url');
    return { token: `${exp}.${sig}`, expiresAt: new Date(exp * 1000) };
}

export function verifyUploadToken(token: unknown): boolean {
    if (typeof token !== 'string' || !/^\d+\.[A-Za-z0-9_-]+$/.test(token)) return false;
    const [expStr, sig] = token.split('.');
    if (Number(expStr) * 1000 < Date.now()) return false;
    const expected = crypto.createHmac('sha256', signingKey).update(`upload:${expStr}`).digest('base64url');
    return safeEqual(sig, expected);
}

/** HMAC signature for short-lived upload-target URLs (file-transfer extension). */
export function signTarget(value: string): string {
    return crypto.createHmac('sha256', signingKey).update(`target:${value}`).digest('base64url');
}

export function verifyTarget(value: string, sig: unknown): boolean {
    return typeof sig === 'string' && safeEqual(sig, signTarget(value));
}
