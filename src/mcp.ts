/** Builds a fresh McpServer with all tools, resources and prompts (called once per HTTP request, or once for stdio). */
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { config } from './config.js';
import { FORMAT_KEYS, INPUT_FORMATS } from './core/codec.js';
import { SOCIAL_PRESETS } from './core/ops/geometry.js';
import { FILTERS } from './core/ops/filters.js';
import { RING_STYLES } from './core/ops/ring.js';
import { register as registerFormats } from './tools/formats.js';
import { register as registerGeometry } from './tools/geometry.js';
import { register as registerInfo } from './tools/info.js';
import { register as registerLook } from './tools/look.js';
import { register as registerOverlay } from './tools/overlay.js';

const INSTRUCTIONS = config.mode === 'http'
    ? `Image editing tools on a remote server. Inputs: an https URL, a link returned by an earlier tool (\`output\`), or base64.
This server cannot read the user's computer, and images attached in chat cannot be passed to tools: call create_upload_link and
give the user the page; they upload and paste back the image link. Every result is a NEW file: the reply has \`output\` (pass it to
the next tool), \`download_url\` (give it to the user) and an inline preview. Files expire after ${config.fileTtlHours} hours.
For 2+ edits on one image prefer run_image_pipeline (one save, no quality loss).${config.openAccess ? `
This is a public server shared by many people: links are private to whoever holds them, and list_images is not available.` : ''}`
    : `Local image editing tools. Inputs: an absolute file path, an http(s) URL, or base64.
Originals are never modified: every edit is saved as a NEW file in ${config.storageDir} and the reply includes its output_path
(pass it to the next tool) plus an inline preview. For 2+ edits on one image prefer run_image_pipeline (one save, no quality loss).
If the user only attached an image in chat, you cannot read the file itself: ask for its path (e.g. use list_images on ~/Downloads).`;

const json = (uri: string, data: unknown) => ({ contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(data, null, 2) }] });

export function createServer(): McpServer {
    const server = new McpServer({ name: 'yt-mcp', title: 'YT Image MCP', version: config.version }, { instructions: INSTRUCTIONS });
    registerInfo(server);
    registerGeometry(server);
    registerFormats(server);
    registerLook(server);
    registerOverlay(server);

    server.registerResource('social_presets', 'image-mcp://presets/social', { description: 'Every resize_for_social preset with its exact pixel size.', mimeType: 'application/json' },
        async uri => json(uri.href, Object.fromEntries(Object.entries(SOCIAL_PRESETS).map(([k, [w, h, d]]) => [k, { width: w, height: h, use: d }]))));
    server.registerResource('filters', 'image-mcp://presets/filters', { description: 'Every apply_filter name with a one-line description.', mimeType: 'application/json' },
        async uri => json(uri.href, Object.fromEntries(Object.entries(FILTERS).map(([k, v]) => [k, v[1]]))));
    server.registerResource('profile_ring_styles', 'image-mcp://presets/profile-rings', { description: 'create_profile_ring styles, colors, label and shape.', mimeType: 'application/json' },
        async uri => json(uri.href, RING_STYLES));
    server.registerResource('server_config', 'image-mcp://config', { description: 'Mode, limits and supported formats of this server.', mimeType: 'application/json' },
        async uri => json(uri.href, {
            mode: config.mode, public_open_access: config.mode === 'http' ? config.openAccess : false, max_input_mb: config.maxInputMb, max_megapixels: config.maxPixels / 1e6, urls_allowed: config.allowUrls,
            local_paths_allowed: config.allowLocalPaths, file_ttl_hours: config.mode === 'http' ? config.fileTtlHours : null,
            input_formats: INPUT_FORMATS, output_formats: FORMAT_KEYS,
        }));

    server.registerPrompt('linkedin_profile_photo', {
        title: 'LinkedIn profile photo',
        description: 'Turn a photo into a polished LinkedIn profile picture with a ring.',
        argsSchema: z.object({ image: z.string().describe('Path, URL or link of the photo'), style: z.string().default('open_to_work').describe('Ring style') }),
    }, ({ image, style }) => ({
        messages: [{
            role: 'user' as const, content: {
                type: 'text' as const, text: `Make a LinkedIn profile picture from ${image}.\n1. Call detect_faces to find the face (use its focus_x/focus_y).\n` +
                    `2. Call auto_enhance_image with strength 0.5.\n3. Call create_profile_ring on the result with style='${style}', size=800 and the face's focus point.\n` +
                    '4. Show me the result and its link/path, and tell me how to upload it to LinkedIn.',
            },
        }],
    }));
    server.registerPrompt('optimize_for_web', {
        title: 'Optimise image for the web',
        description: 'Shrink an image for a website or upload limit without visible quality loss.',
        argsSchema: z.object({ image: z.string(), max_kb: z.string().default('300'), max_width: z.string().default('1920') }),
    }, ({ image, max_kb, max_width }) => ({
        messages: [{
            role: 'user' as const, content: {
                type: 'text' as const, text: `Optimise ${image} for the web: keep it under ${max_kb} KB and at most ${max_width}px wide. ` +
                    `Call compress_image with format='webp', target_kb=${max_kb}, max_dimension=${max_width}, then report the before/after size.`,
            },
        }],
    }));
    server.registerPrompt('blur_faces_for_privacy', {
        title: 'Blur faces for privacy',
        description: 'Blur every face in a photo before sharing it, and remove location data.',
        argsSchema: z.object({ image: z.string() }),
    }, ({ image }) => ({
        messages: [{
            role: 'user' as const, content: {
                type: 'text' as const, text: `Make ${image} safe to share: call blur_image with detect='faces' and style='pixelate', ` +
                    'then strip_image_metadata on the result. Show me the final image and tell me how many faces were hidden.',
            },
        }],
    }));
    return server;
}
