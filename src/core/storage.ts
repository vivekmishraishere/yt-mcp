/**
 * Where results (and uploads) are written.
 * - stdio (local): readable names in STORAGE_DIR (default ~/ImageMCP/output); the "ref" is the file path.
 * - http (remote): unguessable names `<24 hex>__<name>.<ext>`; the "ref" is a download URL /files/<name>.
 * Files are never overwritten. In HTTP mode they expire after FILE_TTL_HOURS.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

export const STORED_NAME = /^[a-f0-9]{24}__[A-Za-z0-9._-]{1,140}$/;

/** Base URL of the current HTTP request (used when PUBLIC_BASE_URL is not set). */
export const requestContext = new AsyncLocalStorage<{ baseUrl: string }>();

export function baseUrl(): string {
    return config.publicBaseUrl || requestContext.getStore()?.baseUrl || `http://localhost:${config.port}`;
}

export function safeStem(text: string): string {
    const s = text.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._-]+|[._-]+$/g, '');
    return (s || 'image').slice(0, 60);
}

export interface Stored {
    path: string;
    name: string;
    /** What the user / model passes to the next tool: a path (local) or a URL (remote). */
    ref: string;
    url?: string;
}

async function writeNew(file: string, data: Buffer): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, data, { flag: 'wx' }); // 'x' = fail if it exists, never overwrite
}

export async function saveFile(data: Buffer, stem: string, tag: string, ext: string, dir = config.storageDir): Promise<Stored> {
    const base = `${safeStem(stem)}${tag ? '_' + tag : ''}`;
    if (config.mode === 'http') {
        const name = `${crypto.randomBytes(12).toString('hex')}__${base}${ext}`;
        const file = path.join(config.storageDir, name);
        await writeNew(file, data);
        const url = `${baseUrl()}/files/${name}`;
        return { path: file, name, ref: url, url };
    }
    for (let n = 1; n < 10_000; n++) {
        const name = `${base}${n === 1 ? '' : '-' + n}${ext}`;
        const file = path.join(dir, name);
        try {
            await writeNew(file, data);
            return { path: file, name, ref: file };
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        }
    }
    throw new Error('Could not find a free file name.');
}

/** If `source` points at one of our stored files (URL, /files/<name>, or bare name), return its path. */
export function storedPathFromRef(source: string): string | null {
    const m = source.match(/(?:^|\/files\/)([a-f0-9]{24}__[A-Za-z0-9._-]{1,140})(?:[?#].*)?$/);
    if (!m || !STORED_NAME.test(m[1])) return null;
    return path.join(config.storageDir, m[1]);
}

export async function listStored(limit = 50): Promise<{ name: string; ref: string; size: number; modified: Date }[]> {
    let names: string[] = [];
    try {
        names = (await fs.readdir(config.storageDir)).filter(n => STORED_NAME.test(n));
    } catch {
        return [];
    }
    const stats = await Promise.all(names.map(async n => ({ n, s: await fs.stat(path.join(config.storageDir, n)).catch(() => null) })));
    return stats
        .filter(x => x.s?.isFile())
        .sort((a, b) => b.s!.mtimeMs - a.s!.mtimeMs)
        .slice(0, limit)
        .map(x => ({ name: x.n, ref: `${baseUrl()}/files/${x.n}`, size: x.s!.size, modified: x.s!.mtime }));
}

/** Delete expired files (HTTP mode only). Returns how many were removed. */
export async function cleanupExpired(now = Date.now()): Promise<number> {
    const ttlMs = config.fileTtlHours * 3600_000;
    let removed = 0;
    let names: string[] = [];
    try {
        names = await fs.readdir(config.storageDir);
    } catch {
        return 0;
    }
    for (const n of names) {
        if (!STORED_NAME.test(n)) continue;
        const f = path.join(config.storageDir, n);
        const st = await fs.stat(f).catch(() => null);
        if (st && now - st.mtimeMs > ttlMs) {
            await fs.rm(f, { force: true });
            removed++;
        }
    }
    return removed;
}
