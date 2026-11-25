# yt-mcp: Image tools MCP server (Node.js)

An MCP server with **29 image tools** for Claude and any MCP client: crop, circular avatars with LinkedIn-style
**#OPENTOWORK / #HIRING rings**, resize, upscale, **HEIC → JPG/PNG/WebP/AVIF**, compression to a target size,
19 filters, adjustments, **smart blur** (regions, soft edges, automatic face detection, background blur), text,
watermarks, background removal for plain backgrounds, collages, icon sets and multi-step pipelines.

It runs two ways from the same code:

| Mode | Command | Use it for |
|---|---|---|
| **Remote** (Streamable HTTP at **`/mcp`**) | `node dist/server.js` | Hostinger, any VPS or Docker host; claude.ai, Claude Desktop/mobile custom connectors, Claude Code |
| **Local** (stdio) | `node dist/server.js --stdio` | Claude Desktop config, Claude Code, Cursor on your own computer |

Originals are never modified: every result is a **new** file (never overwritten), returned with an inline preview.
Remote results come back as download links that expire after 24 h.

## Tools (29)

R = read-only. W = writes a new result file.

| # | Tool | R/W | What it does | Typical use |
|---|---|---|---|---|
| 1 | `get_image_info` | R | Size, megapixels, ratio, format, file size, transparency, EXIF, GPS check | "Does this photo reveal my location?" |
| 2 | `list_images` | R | Local: images in a folder. Remote: your recent uploads/results | "Use my latest screenshot" |
| 3 | `extract_color_palette` | R | Dominant colors as hex + %, with swatch | Brand / ring colors |
| 4 | `detect_faces` | R | Numbered face boxes + focus points + preview | Blur one person; frame a profile photo |
| 5 | `crop_image` | W | Crop by aspect ratio (focus/zoom) or exact box | Square post, 16:9 frame |
| 6 | `crop_to_circle` | W | Round transparent PNG, optional outline | Avatar |
| 7 | `create_profile_ring` | W | Circle photo + ring/arc with curved label, 7 styles, custom colors | LinkedIn #OPENTOWORK / #HIRING |
| 8 | `resize_image` | W | Width/height/scale; contain, cover, pad, stretch | Upload size rules |
| 9 | `upscale_image` | W | 1.1-4x Lanczos + sharpening (classic, not AI) | Enlarge a small logo 2x |
| 10 | `rotate_or_flip_image` | W | Rotate any angle, mirror | Fix scans, un-mirror selfies |
| 11 | `resize_for_social` | W | 17 platform presets; cover / pad / blur-pad | IG story, YouTube thumbnail, LinkedIn banner |
| 12 | `add_border` | W | Solid border / padding | Framed look |
| 13 | `round_corners` | W | Rounded transparent corners | App-style screenshots |
| 14 | `trim_borders` | W | Auto-cut empty edges | Scans, signatures |
| 15 | `convert_image_format` | W | PNG/JPG/WebP/AVIF/GIF/TIFF/BMP/ICO/PDF (reads HEIC) | iPhone HEIC → JPG |
| 16 | `compress_image` | W | Lossless/high/balanced/small or exact target KB (MozJPEG, WebP, AVIF, palette PNG) | "Under 200 KB" |
| 17 | `batch_convert_images` | W | Local: whole folder. Remote: list of images | All HEIC → JPG |
| 18 | `strip_image_metadata` | W | Removes EXIF/GPS; JPEG image data kept bit-for-bit | Share without location |
| 19 | `create_icon_set` | W | favicon.ico + PNG icons | Website/app icons |
| 20 | `apply_filter` | W | 19 filters with intensity | B&W, vintage, sketch, cartoon |
| 21 | `adjust_image` | W | Brightness, contrast, saturation, sharpness, exposure, gamma, warmth | Manual fixes |
| 22 | `auto_enhance_image` | W | One-click levels/brightness/color/crispness | Dark phone photos |
| 23 | `blur_image` | W | Blur/pixelate: whole, boxes, ellipses, auto-detected faces, or background; `feather` = soft edge | Hide faces/emails/plates; portrait blur |
| 24 | `add_text_to_image` | W | Caption/headline with outline and box | Thumbnails, quote cards |
| 25 | `add_watermark` | W | Text or logo, corner or tiled | Protect photos |
| 26 | `remove_solid_background` | W | Plain backgrounds → transparent PNG | Logos, products on white |
| 27 | `create_collage` | W | Grid of 2-36 images | Before/after, photo dumps |
| 28 | `run_image_pipeline` | W | Many edits, one save | "Crop + filter + text + WebP" |
| 29 | `create_upload_link` (remote) / `save_image_to_folder` (local) | W | Remote: private expiring upload page. Local: copy a result anywhere | Getting images in / out |

Also: 4 resources (`image-mcp://presets/social`, `…/filters`, `…/profile-rings`, `image-mcp://config`) and
3 prompts (`linkedin_profile_photo`, `optimize_for_web`, `blur_faces_for_privacy`).

### Getting images into a remote server

A remote server cannot read your computer, and an image attached in a Claude chat is not passed to tools. So:

1. Ask Claude for an upload link: it calls `create_upload_link` and gives you a private page (expires in 60 min).
2. Upload the image there (works on phone too, HEIC included) and paste the link it shows back into the chat.
3. That link works as `image` in every tool. Public `https://` image URLs and base64 work too.

## Requirements

Node.js **20.9+** (22 recommended). No native build step: image processing uses `sharp`'s prebuilt binaries,
HEIC decoding and face detection run in WebAssembly, and text uses a bundled font, so output looks the same everywhere.

```bash
npm install
npm run build
npm test          # builds, then runs 70 unit + end-to-end tests (HTTP and stdio)
```

## Deploy on Hostinger (Business or Cloud web hosting, Node.js app)

Hostinger's web hosting runs Node.js apps (Python needs a VPS), which is why this server is written in Node.

1. **hPanel → Websites → Add website → Node.js app**, connect GitHub and pick this repository, branch `main`.
2. Build settings:
   - Framework preset: **Express** (or "Other")
   - Node version: **22.x** (20.x also works)
   - Build command: **`npm run build`**
   - Entry file: **`dist/server.js`**
3. **Environment variables** (Hostinger asks for these during deployment):
   - `MCP_AUTH_TOKEN`: a long random secret. Generate one with `openssl rand -hex 32` and keep it private.
   - `PUBLIC_BASE_URL`: your app's address, e.g. `https://mcp.yourdomain.com` (no trailing slash).
   - Optional: anything from [`.env.example`](.env.example). `PORT` is set by Hostinger automatically.
4. Deploy, then check `https://mcp.yourdomain.com/health` returns `{"ok":true,...}`.
5. Test the MCP endpoint (replace the URL and token):

   ```bash
   npx @modelcontextprotocol/inspector --cli https://mcp.yourdomain.com/mcp --transport http --header "Authorization: Bearer YOUR_TOKEN" --method tools/list
   ```

   You should see 29 tools. Without the header you must get `401`.

If the server refuses to start, check the logs in hPanel: it exits on purpose when `MCP_AUTH_TOKEN` is missing.

### VPS / Docker instead

```bash
docker build -t yt-mcp .
docker run -d -p 3000:3000 -e MCP_AUTH_TOKEN=... -e PUBLIC_BASE_URL=https://mcp.yourdomain.com -v yt-mcp-data:/data yt-mcp
```

Put it behind HTTPS (Caddy, Nginx + Let's Encrypt, or Cloudflare Tunnel).

## Connect clients

**Claude Code**

```bash
claude mcp add --transport http yt-mcp https://mcp.yourdomain.com/mcp --header "Authorization: Bearer YOUR_TOKEN"
```

**claude.ai / Claude Desktop / Claude mobile (custom connector):** Customize → Connectors → Add custom connector →
URL `https://mcp.yourdomain.com/mcp?key=YOUR_TOKEN`. The connector form takes a URL only, so the token rides in the
URL (`ALLOW_QUERY_TOKEN=1`, the default). Treat that URL like a password; rotate `MCP_AUTH_TOKEN` if it leaks.
(OAuth is not implemented in this version.)

**Local, no server (Claude Desktop config):** build once, then add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "yt-mcp": {
      "command": "/ABSOLUTE/PATH/TO/node",
      "args": ["/ABSOLUTE/PATH/yt-mcp/dist/server.js", "--stdio"]
    }
  }
}
```

Local results go to `~/ImageMCP/output`; local mode can read files under your home folder (`ALLOWED_DIRS` to change).

## Security

- Every `/mcp` request needs the bearer token (constant-time compare). Wrong tokens are rate-limited per IP (20/min);
  valid traffic has a global budget (`RATE_LIMIT_PER_MINUTE`, default 600).
- Host-header validation (DNS-rebinding protection) uses `PUBLIC_BASE_URL` / `ALLOWED_HOSTS`.
- Remote mode never reads server files: local paths are rejected; URL fetching blocks private/loopback addresses
  (SSRF protection, re-checked on every redirect), with size and time limits.
- Uploads need a signed, expiring link (HMAC) or the bearer token, and must decode as a real image.
- Result files have unguessable names (96-bit random) and are deleted after `FILE_TTL_HOURS`.
- Limits on input size, megapixels, output size and concurrent jobs keep a small host responsive.

## Limits

- HEIC can be **read** but not written (HEVC encoding is patent-encumbered); use `avif` (same efficiency) or `jpg`.
- Upscaling and background removal are classic algorithms: no AI detail generation, no subject cut-outs on busy photos.
- Face detection (OpenCV Haar cascades) works on real photos, frontal and profile, not on drawings or cartoons.
- Text uses DejaVu Sans (Latin, Greek, Cyrillic); complex scripts such as Devanagari are not shaped.

## Third-party data

- OpenCV Haar cascade files in `assets/haarcascades/` are redistributed under the Intel License Agreement, whose text
  is kept in each file's header.
- DejaVu fonts (installed from npm, `dejavu-fonts-ttf`) are under the Bitstream Vera / DejaVu free license.
- `tests/fixtures/astronaut.jpg` is a public-domain NASA portrait (as bundled with scikit-image).
