/**
 * In-chat upload box (an MCP App). Hosts that support MCP Apps (Claude, ChatGPT...) render this HTML inside the
 * conversation when create_upload_link runs. The user drops an image in; the box uploads it straight to this server and
 * then sends Claude a message with the image link, so the AI carries on with no copy-paste.
 * Hosts without MCP Apps ignore it and use the text result (an upload page link).
 */
import type { McpServer } from '@modelcontextprotocol/server';
import { config } from '../config.js';
import { baseUrl } from '../core/storage.js';

export const UPLOADER_URI = 'ui://yt-mcp/uploader.html';
const MCP_APP_MIME = 'text/html;profile=mcp-app';
/** Served by http.ts from node_modules, same origin as the uploads, so one CSP domain covers both. */
export const APP_CLIENT_PATH = '/static/mcp-app-client.js';

function html(origin: string): string {
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><title>Upload an image</title>
<style>
  :root { --bg: transparent; --fg: #14171a; --muted: #5b6470; --border: #c9d0d8; --accent: #0a66c2; --ok: #1e8e3e; --err: #d93025; --card: #ffffff; }
  @media (prefers-color-scheme: dark) { :root { --fg: #e8ecf0; --muted: #9aa4ae; --border: #3a424c; --accent: #4b9bf0; --ok: #5bd17a; --err: #ff7b72; --card: #1b1f24; } }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 4px; font: 14px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--fg); background: var(--bg); }
  .drop { display: flex; align-items: center; gap: 14px; border: 2px dashed var(--border); border-radius: 12px; padding: 16px;
          cursor: pointer; background: var(--card); transition: border-color .15s; }
  .drop:hover, .drop.over { border-color: var(--accent); }
  .drop input { display: none; }
  .icon { width: 40px; height: 40px; flex: none; border-radius: 10px; display: grid; place-items: center; background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--accent); font-size: 22px; }
  .title { font-weight: 600; }
  .sub { color: var(--muted); font-size: 12.5px; }
  .bar { height: 6px; border-radius: 3px; background: var(--border); overflow: hidden; margin-top: 8px; display: none; }
  .bar > i { display: block; height: 100%; width: 0; background: var(--accent); transition: width .1s; }
  .done { display: none; align-items: center; gap: 12px; margin-top: 10px; }
  .done img { width: 56px; height: 56px; object-fit: cover; border-radius: 8px; border: 1px solid var(--border); }
  .ok { color: var(--ok); font-weight: 600; } .err { color: var(--err); }
  a { color: var(--accent); }
</style></head>
<body>
<label class="drop" id="drop">
  <div class="icon" aria-hidden="true">&#8679;</div>
  <div>
    <div class="title" id="title">Drop your image here, or click to choose</div>
    <div class="sub" id="sub">JPG, PNG, HEIC, WebP, AVIF, GIF, TIFF or BMP, up to ${config.maxInputMb} MB. Deleted ${config.uploadTtlMinutes} min after last use.</div>
    <div class="bar" id="bar"><i id="fill"></i></div>
  </div>
  <input id="file" type="file" accept="image/*,.heic,.heif">
</label>
<div class="done" id="done"><img id="thumb" alt=""><div><div class="ok" id="okmsg">Uploaded</div><div class="sub" id="okinfo"></div></div></div>
<script type="module">
  import { App } from "${origin}${APP_CLIENT_PATH}";
  const $ = (id) => document.getElementById(id);
  const app = new App({ name: "yt-mcp uploader", version: "${config.version}" });
  let target = null;   // { upload_url, upload_page } from the tool result
  let busy = false;

  app.ontoolresult = (r) => {
    const sc = r && r.structuredContent;
    if (sc && sc.upload_url) target = sc;
  };

  function fail(msg) {
    busy = false;
    $("title").innerHTML = '<span class="err">' + msg + '</span>';
    $("bar").style.display = "none";
    if (target && target.upload_page) {
      $("sub").innerHTML = 'You can also <a href="#" id="alt">open the upload page</a> instead.';
      $("alt").onclick = (e) => { e.preventDefault(); app.openLink({ url: target.upload_page }).catch(() => {}); };
    }
  }

  function upload(file) {
    if (busy || !file) return;
    if (!target) return fail("This upload box is not ready yet. Wait a second and try again.");
    if (file.size > ${config.maxInputMb} * 1024 * 1024) return fail("That file is larger than ${config.maxInputMb} MB.");
    busy = true;
    $("title").textContent = "Uploading " + file.name + "...";
    $("bar").style.display = "block";
    const xhr = new XMLHttpRequest();
    xhr.open("POST", target.upload_url + "&name=" + encodeURIComponent(file.name));
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) $("fill").style.width = Math.round(100 * e.loaded / e.total) + "%"; };
    xhr.onerror = () => fail("Upload failed (network). Please try again.");
    xhr.onload = async () => {
      let j = {};
      try { j = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status !== 200 || !j.image) return fail(j.error || ("Upload failed (" + xhr.status + ")."));
      $("drop").style.display = "none";
      $("done").style.display = "flex";
      $("thumb").src = j.image;
      $("okinfo").textContent = file.name + " - " + j.width + "x" + j.height + ", " + j.file_size;
      const text = "I uploaded my image: " + j.image;
      try {
        await app.updateModelContext({ content: [{ type: "text", text: "The user's uploaded image (use as the image argument): " + j.image }] });
      } catch {}
      try {
        const res = await app.sendMessage({ role: "user", content: [{ type: "text", text }] });
        $("okmsg").textContent = res && res.isError ? "Uploaded - tell Claude to continue" : "Uploaded - Claude is continuing";
      } catch {
        $("okmsg").textContent = "Uploaded - tell Claude to continue";
      }
    };
    xhr.send(file);
  }

  $("file").onchange = (e) => upload(e.target.files[0]);
  const d = $("drop");
  d.ondragover = (e) => { e.preventDefault(); d.classList.add("over"); };
  d.ondragleave = () => d.classList.remove("over");
  d.ondrop = (e) => { e.preventDefault(); d.classList.remove("over"); upload(e.dataTransfer.files[0]); };
  await app.connect();
</script>
</body></html>`;
}

export function registerUploaderUi(server: McpServer): void {
    server.registerResource('uploader', UPLOADER_URI, {
        title: 'Image upload box',
        description: 'In-chat upload box shown by create_upload_link.',
        mimeType: MCP_APP_MIME,
        _meta: { ui: { csp: { connectDomains: [baseUrlOrigin()], resourceDomains: [baseUrlOrigin()] } } },
    }, async uri => {
        const origin = baseUrlOrigin();
        return {
            contents: [{
                uri: uri.href,
                mimeType: MCP_APP_MIME,
                text: html(origin),
                // let the sandbox load the client script and send the upload to this server only
                _meta: { ui: { csp: { connectDomains: [origin], resourceDomains: [origin] }, prefersBorder: false } },
            }],
        };
    });
}

function baseUrlOrigin(): string {
    return new URL(baseUrl()).origin;
}
