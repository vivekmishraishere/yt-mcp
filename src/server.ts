#!/usr/bin/env node
/**
 * Entry point.
 *   node dist/server.js            -> remote mode: Streamable HTTP at /mcp on $PORT (Hostinger, VPS, Docker...)
 *   node dist/server.js --stdio    -> local mode for Claude Desktop / Claude Code / Cursor (stdin/stdout)
 */
import fs from 'node:fs/promises';
import { config } from './config.js';

async function main(): Promise<void> {
    if (config.mode === 'stdio') {
        // stdout carries the MCP protocol in this mode: never console.log; everything else goes to stderr.
        const { serveStdio } = await import('@modelcontextprotocol/server/stdio');
        const { createServer } = await import('./mcp.js');
        await fs.mkdir(config.storageDir, { recursive: true });
        const handle = serveStdio(() => createServer());
        console.error(`[yt-mcp] ${config.version} running on stdio; results go to ${config.storageDir}`);
        process.on('SIGINT', () => { void handle.close(); process.exit(0); });
        return;
    }
    const { startHttp } = await import('./http.js');
    await startHttp();
}

main().catch(e => {
    console.error('[yt-mcp] fatal:', e);
    process.exit(1);
});
