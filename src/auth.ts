/** Bearer-token check for /mcp and signed, expiring upload links for /upload. */
import crypto from 'node:crypto';
import { config } from './config.js';

// Upload links are signed with a key derived from MCP_AUTH_TOKEN (or a random per-process key if auth is off).
const signingKey = crypto.createHash('sha256').update('yt-mcp-upload:' + (config.authToken || crypto.randomBytes(32).toString('hex'))).digest();

function safeEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a), bb = Buffer.from(b);
    return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/** True if the request carries the right token (Authorization: Bearer, or ?key= when allowed). */
export function isAuthorized(headers: Record<string, string | string[] | undefined>, query: Record<string, unknown>): boolean {
    if (!config.authToken) return config.allowNoAuth;
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
