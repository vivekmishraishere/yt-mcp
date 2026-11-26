# yt-mcp: Image tools MCP server (Node.js)

An MCP server with **29 image tools** (31 in remote mode) for Claude and any MCP client: crop, circular avatars with LinkedIn-style
**#OPENTOWORK / #HIRING rings**, resize, upscale, **HEIC → JPG/PNG/WebP/AVIF**, compression to a target size,
19 filters, adjustments, **smart blur** (regions, soft edges, automatic face detection, background blur), text,
watermarks, background removal for plain backgrounds, collages, icon sets and multi-step pipelines.

It runs two ways from the same code:

| Mode | Command | Use it for |
|---|---|---|
| **Remote** (Streamable HTTP at **`/mcp`**) | `node dist/server.js` | Hostinger, any VPS or Docker host; claude.ai, Claude Desktop/mobile custom connectors, Claude Code. Public (`OPEN_ACCESS=1`, no login) or private (token) |
| **Local** (stdio) | `node dist/server.js --stdio` | Claude Desktop config, Claude Code, Cursor on your own computer |

Originals are never modified: every result is a **new** file (never overwritten), returned with an inline preview.
Remote results come back as download links that expire after 24 h.

## Tools (29 + 2 remote-only)

R = read-only. W = writes a new result file.

| # | Tool | R/W | What it does | Typical use |
|---|---|---|---|---|
| 1 | `get_image_info` | R | Size, format, EXIF, GPS check, preview; `grid=true` adds a labelled pixel grid for picking regions | "Does this photo reveal my location?" |
| 2 | `list_images` | R | Local: images in a folder. Remote with a token: recent uploads/results. Public server: disabled, for privacy | "Use my latest screenshot" |
| 3 | `extract_color_palette` | R | Dominant colors as hex + %, with swatch | Brand / ring colors |
| 4 | `detect_faces` | R | Numbered face boxes + focus points + preview (a pixel grid when none are found, e.g. cartoons) | Blur one person; frame a profile photo |
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
| 29 | `create_upload_link` (remote) / `save_image_to_folder` (local) | W | Remote: private expiring upload page + curl command. Local: copy a result anywhere | Getting images in / out |
| 30 | `upload_image_file` (remote) | W | **Instant**: the Claude app sends the attached file itself (Claude's file-transfer extension) | Chat attachments, in about a second |
| 31 | `upload_image_data` (remote) | W | Tiny images only: the AI sends base64 itself in checksummed blocks; only damaged blocks are resent | Icons/logos when nothing else works |

Also: 4 resources (`image-mcp://presets/social`, `…/filters`, `…/profile-rings`, `image-mcp://config`) and
3 prompts (`linkedin_profile_photo`, `optimize_for_web`, `blur_faces_for_privacy`).

### Getting images into a remote server

MCP tools receive only text from the model, so an attachment cannot simply be passed as an argument. In order of speed:

0. **Instant, official (`upload_image_file`)**: Claude's *File Uploads and Downloads* extension
   (`io.modelcontextprotocol/files`, beta). Claude calls the tool with the file's name, type, size and SHA-256; the
   server answers `upload_required` with a signed, single-use PUT URL on this server; Anthropic's servers upload the
   bytes; Claude calls again and gets the `image` link. About a second, byte-exact, no copying by the model.
   **Claude only enables this for connectors listed in its Connectors Directory whose hosts Anthropic approved** (see
   "Enable instant uploads in Claude" below). Other clients can send the bytes inline in `file.data`.
1. **Shell with internet** (Claude Code, agents): `create_upload_link` returns a `curl -F "file=@..."` command.
2. **Upload page** (claude.ai today): `create_upload_link` gives the user a private page; one tap, full quality; they
   paste back the link.
3. **Tiny images only** (icons, small logos; base64 under 20,000 characters): `upload_image_data`, where the AI copies
   base64 itself in 1,000-character checksummed blocks and resends only the rejected ones. Live tests showed models
   mis-copy long base64 (about 3 typos per 10,000 characters, and roughly 1 block in 4), so photos are refused with a
   pointer to the upload page.

Public direct image URLs and base64 work as `image` too.

#### Enable instant uploads in Claude

1. Submit the connector to Anthropic's Connectors Directory (one server URL, e.g. `https://mcp.yourdomain.com/mcp`).
2. Email `mcp-review@anthropic.com`, subject `Connector file hosts: <connector name>`: listing name and server URL,
   the host that receives files (`mcp.yourdomain.com`, production, not shared, not behind a CDN), proof the domain is
   yours, and the Claude account email you test with. Wait for approval.
3. Add the connector **from the directory** (not by URL) and attach an image: Claude uploads it to `upload_image_file`.

The server already implements everything else the extension requires: it advertises `{"upload": {}}` on
`server/discover`, reads each call's declared capabilities, returns `-32021` (HTTP 400) to apps that cannot upload,
issues one signed write-once target per file (30 min) and a single-use `requestState` (60 min), checks the size and
SHA-256, and answers `-32602` to replays or changed arguments.

**Privacy:** uploaded originals are deleted **5 minutes after their last use** (`UPLOAD_TTL_MINUTES`; every tool call that
reads one restarts the clock, so a long editing session keeps working). Results last `FILE_TTL_HOURS`. Unfinished
part-uploads are dropped after 15 minutes.

Every tool call is logged as one line (tool name, kind of input, duration, error text; never image data), so you can see
in hPanel → Node.js → Runtime logs what a client actually sent when something does not work.

## Requirements

Node.js **20.9+** (22 recommended). No native build step: image processing uses `sharp`'s prebuilt binaries,
HEIC decoding and face detection run in WebAssembly, and text uses a bundled font, so output looks the same everywhere.

```bash
npm install
npm run build
npm test          # builds, then runs 80 unit + end-to-end tests (private HTTP, public HTTP and stdio)
```

## Deploy on Hostinger (Business or Cloud web hosting, Node.js app)

Hostinger's web hosting runs Node.js apps (Python needs a VPS), which is why this server is written in Node.

1. **hPanel → Websites → Add website → Node.js app**, connect GitHub and pick this repository, branch `main`.
2. Build settings:
   - Framework preset: **Express** (or "Other")
   - Node version: **22.x** (20.x also works)
   - Build command: **`npm run build`**
   - Entry file: **`dist/server.js`**
3. **Environment variables** (Hostinger asks for these during deployment). Choose one access mode:

   | | Public server (anyone with the URL) | Private server (token) |
   |---|---|---|
   | Set | `OPEN_ACCESS=1` | `MCP_AUTH_TOKEN=<openssl rand -hex 32>` |
   | Connect with | `https://mcp.yourdomain.com/mcp` | the URL plus the token (see below) |

   Always also set `PUBLIC_BASE_URL` to your app's address, e.g. `https://mcp.yourdomain.com` (no trailing slash).
   Recommended on Hostinger: `STORAGE_DIR=/home/<your-user>/yt-mcp-files` (a folder that survives restarts and is shared by
   all app processes) and `UPLOAD_SECRET=<openssl rand -hex 32>` (so upload links keep working across restarts).
   Optional: anything from [`.env.example`](.env.example). `PORT` is set by Hostinger automatically.
4. Deploy, then check `https://mcp.yourdomain.com/health` returns `{"ok":true,...}` and `https://mcp.yourdomain.com/`
   shows `"access":"public"` (or `"token"`).
5. Test the MCP endpoint (drop the `--header` part for a public server):

   ```bash
   npx @modelcontextprotocol/inspector --cli https://mcp.yourdomain.com/mcp --transport http --header "Authorization: Bearer YOUR_TOKEN" --method tools/list
   ```

   You should see 29 tools. On a private server, a request without the header must get `401`.

If the server refuses to start, check the logs in hPanel: it exits on purpose when neither `OPEN_ACCESS=1` nor
`MCP_AUTH_TOKEN` is set, so it is never public by accident.

### Running it as a public server

With `OPEN_ACCESS=1` anyone who knows the URL can use the tools. What protects you and your users:

- The server never reads its own files: local paths are refused, and URL fetching blocks private/loopback addresses.
- Every upload and result has an unguessable link (96-bit random), so users cannot see each other's images, and
  `list_images` is disabled. Uploads still need a signed, expiring link from `create_upload_link`, so the server cannot be
  used as anonymous file hosting.
- Limits keep a shared host responsive: `RATE_LIMIT_PER_MINUTE` (600 requests/min for everyone), `MAX_CONCURRENT_JOBS`
  (2 images at a time, others wait up to 60 s), `UPLOADS_PER_MINUTE` (60), `MAX_INPUT_MB` (25), `MAX_PIXELS` (60 MP).
- Disk use is capped by `MAX_STORAGE_MB` (1 GB): files are deleted after `FILE_TTL_HOURS` (24 h), and the oldest go first
  when the cap is reached, so your hosting quota cannot fill up.
- What it cannot stop: someone using up the shared request budget. If that happens, set `MCP_AUTH_TOKEN` to make it
  private again (restart applies it), or put Cloudflare in front for per-visitor limits.

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

**Public server:** in Claude Code `claude mcp add --transport http yt-mcp https://mcp.yourdomain.com/mcp`; in
claude.ai / Claude Desktop / Claude mobile: Customize → Connectors → Add custom connector → URL
`https://mcp.yourdomain.com/mcp`. Share that URL with anyone.

**claude.ai / Claude Desktop / Claude mobile, private server (custom connector):** Customize → Connectors → Add custom connector →
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

- Private mode: every `/mcp` request needs the bearer token (constant-time compare). Wrong tokens are rate-limited per IP
  (20/min). Public mode (`OPEN_ACCESS=1`): no token; see "Running it as a public server". Both share a global budget
  (`RATE_LIMIT_PER_MINUTE`, default 600) and an optional per-IP limit (`RATE_LIMIT_PER_IP`).
- Host-header validation (DNS-rebinding protection) uses `PUBLIC_BASE_URL` / `ALLOWED_HOSTS`.
- Remote mode never reads server files: local paths are rejected; URL fetching blocks private/loopback addresses
  (SSRF protection, re-checked on every redirect), with size and time limits.
- Uploads need a signed, expiring link (HMAC) or the bearer token, and must decode as a real image.
- Result files have unguessable names (96-bit random), are deleted after `FILE_TTL_HOURS`, and the folder is capped at
  `MAX_STORAGE_MB` (oldest deleted first).
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
