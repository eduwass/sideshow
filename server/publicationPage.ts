import type { IdentityHeader, Snapshot } from "./publicationTypes.ts";
import { escapeHtml } from "./surfacePage.ts";

// The client-facing publication page. Server-rendered from the public runtime
// rather than reusing the Solid viewer, so no product chrome, no workspace
// navigation and no cross-publication discovery can leak into it by accident —
// there is simply nothing else in the document.
//
// The isolation rule is unchanged from the private viewer: agent-authored
// markup NEVER becomes HTML in this trusted page. Sandboxed kinds are embedded
// as opaque-origin iframes pointing at /api/v/:slug/s/:item/:surface, which is
// served under a `sandbox` CSP header; data kinds (image, json) are rendered by
// escaping them here. The only thing this page builds from publication content
// is escaped text and element attributes.

export interface PublicationPageInput {
  title: string;
  identity: IdentityHeader | null;
  slug: string;
  snapshot: Pick<Snapshot, "id" | "revision" | "items">;
  trackOpens: boolean;
  basePath?: string;
  /** CSP nonce for this response's inline <style>/<script>. */
  nonce: string;
}

// A stable neutral palette: no brand hues, follows the reader's system scheme.
const PAGE_CSS = `
:root{
  color-scheme: light dark;
  --bg:#ffffff; --surface:#ffffff; --border:#e2e2e5; --text:#1b1b1f;
  --muted:#6b6b73; --accent:#3a3a42; --radius:10px;
}
@media (prefers-color-scheme: dark){
  :root{ --bg:#111114; --surface:#17171b; --border:#2b2b31; --text:#ececef; --muted:#9a9aa3; --accent:#d6d6dc; }
}
*{box-sizing:border-box}
body{
  margin:0; background:var(--bg); color:var(--text);
  font:15px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  -webkit-text-size-adjust:100%;
}
.wrap{max-width:900px;margin:0 auto;padding:32px 20px 96px}
nav.contents{margin:0 0 32px;padding:14px 16px;border:1px solid var(--border);border-radius:var(--radius);background:var(--surface)}
nav.contents p{margin:0 0 8px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
nav.contents ol{margin:0;padding:0 0 0 20px;display:grid;gap:4px}
nav.contents a{color:var(--text);text-decoration:none}
nav.contents a:hover{text-decoration:underline}
section.item{scroll-margin-top:16px}
header.identity{display:flex;align-items:center;gap:12px;margin-bottom:28px}
header.identity img{width:36px;height:36px;border-radius:50%;object-fit:cover;background:var(--border)}
header.identity .who{font-weight:600}
header.identity a{color:var(--muted);text-decoration:none;font-size:13px}
header.identity a:hover{text-decoration:underline}
h1{font-size:26px;line-height:1.25;margin:0 0 28px;font-weight:650;letter-spacing:-0.01em}
section.item{margin:0 0 36px}
section.item > h2{font-size:17px;margin:0 0 12px;font-weight:600}
.surface{border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;background:var(--surface);margin:0 0 14px}
.surface iframe{display:block;width:100%;border:0;height:220px}
.surface img{display:block;max-width:100%;height:auto}
.surface figcaption{padding:8px 12px;color:var(--muted);font-size:13px;border-top:1px solid var(--border)}
.surface pre{margin:0;padding:12px 14px;overflow-x:auto;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre}
.gate{max-width:360px;margin:18vh auto;padding:0 20px}
.gate h1{font-size:19px;margin:0 0 6px}
.gate p{color:var(--muted);margin:0 0 18px;font-size:14px}
.gate label{display:block;font-size:13px;color:var(--muted);margin:0 0 6px}
.gate input{width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--text);font-size:15px}
.gate button{margin-top:12px;width:100%;padding:10px 12px;border:0;border-radius:8px;background:var(--accent);color:var(--bg);font-size:15px;font-weight:600;cursor:pointer}
.gate .error{color:#c0392b;font-size:13px;margin-top:10px;min-height:18px}
@media (max-width:600px){ .wrap{padding:20px 14px 72px} h1{font-size:22px} }
`;

// Height bridge + confirmed open. Deliberately narrow: the sandboxed surfaces
// share the private viewer's bridge script, which can also ask for a prompt to
// be sent to an agent, for text to be copied, or for a session switch. None of
// those exist out here, and an untrusted publication reader must not be able to
// reach an agent (docs/adr/0003) — so only `resize` and `open-link` are handled
// and every other message is dropped on the floor.
const PAGE_JS = (slug: string, snapshotId: string, trackOpens: boolean, base: string) => `
(function(){
  var frames = document.querySelectorAll('iframe[data-surface]');
  window.addEventListener('message', function(e){
    var d = e.data;
    if (!d || d.__sideshow !== true) return;
    var frame = null;
    for (var i = 0; i < frames.length; i++) {
      if (frames[i].contentWindow === e.source) { frame = frames[i]; break; }
    }
    if (!frame) return;
    if (d.type === 'resize') {
      var h = Number(d.height);
      if (h > 0 && h < 20000) frame.style.height = Math.ceil(h) + 'px';
      return;
    }
    if (d.type === 'open-link' && typeof d.url === 'string' && /^https?:/.test(d.url)) {
      window.open(d.url, '_blank', 'noopener,noreferrer');
    }
  });
  ${
    trackOpens
      ? `
  // A confirmed open: after the page has actually rendered and only when it is
  // really on screen, so a prefetch or a link preview does not count as a read.
  function confirmOpen(){
    if (document.visibilityState !== 'visible') return;
    document.removeEventListener('visibilitychange', confirmOpen);
    fetch(${JSON.stringify(`${base}/api/v/${slug}/open`)}, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ snapshotId: ${JSON.stringify(snapshotId)} }),
      keepalive: true,
    }).catch(function(){});
  }
  window.addEventListener('load', function(){ setTimeout(confirmOpen, 1200); });
  document.addEventListener('visibilitychange', confirmOpen);
  `
      : ""
  }
})();
`;

function identityHeader(identity: IdentityHeader | null, base: string): string {
  if (!identity) return "";
  const avatar = identity.avatarAssetId
    ? `<img src="${escapeHtml(`${base}/a/${encodeURIComponent(identity.avatarAssetId)}`)}" alt="">`
    : "";
  const link = identity.linkUrl
    ? `<a href="${escapeHtml(identity.linkUrl)}" rel="noopener noreferrer nofollow" target="_blank">${escapeHtml(
        identity.linkLabel || new URL(identity.linkUrl).host,
      )}</a>`
    : "";
  return `<header class="identity">${avatar}<div><div class="who">${escapeHtml(
    identity.name,
  )}</div>${link}</div></header>`;
}

// Every inline block carries the response's nonce, so the page can be served
// under a strict CSP with no 'unsafe-inline'.
const shell = (title: string, nonce: string, body: string, script = "") =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<meta name="robots" content="noindex, nofollow, noarchive">` +
  `<title>${escapeHtml(title)}</title><style nonce="${escapeHtml(nonce)}">${PAGE_CSS}</style></head>` +
  `<body>${body}${script ? `<script nonce="${escapeHtml(nonce)}">${script}</script>` : ""}</body></html>`;

export function renderPublicationPage(input: PublicationPageInput): string {
  const base = input.basePath ?? "";
  const items = input.snapshot.items
    .map((item, itemIndex) => {
      const surfaces = item.surfaces
        .map((surface, surfaceIndex) => {
          if (surface.kind === "image") {
            const caption = surface.caption
              ? `<figcaption>${escapeHtml(surface.caption)}</figcaption>`
              : "";
            return `<figure class="surface"><img src="${escapeHtml(
              `${base}/a/${encodeURIComponent(surface.assetId)}`,
            )}" alt="${escapeHtml(surface.alt ?? "")}" loading="lazy">${caption}</figure>`;
          }
          if (surface.kind === "json") {
            // Data, escaped here — never markup.
            return `<div class="surface"><pre>${escapeHtml(
              JSON.stringify(surface.data, null, 2) ?? "null",
            )}</pre></div>`;
          }
          if (surface.kind === "trace") return "";
          const src = `${base}/api/v/${encodeURIComponent(input.slug)}/s/${itemIndex}/${surfaceIndex}`;
          // No allow-same-origin: the frame runs at an opaque origin and cannot
          // touch this page, its cookies or the API.
          return `<div class="surface"><iframe data-surface sandbox="allow-scripts allow-popups" loading="lazy" title="${escapeHtml(
            item.title,
          )}" src="${escapeHtml(src)}"></iframe></div>`;
        })
        .join("");
      // The id the contents nav links to — so a heading exists for every anchor.
      const heading =
        input.snapshot.items.length > 1
          ? `<h2 id="item-${itemIndex}">${escapeHtml(item.title)}</h2>`
          : "";
      return `<section class="item">${heading}${surfaces}</section>`;
    })
    .join("");
  // Navigation for a collection. A plain anchor list: it needs no script, works
  // at any width, and reflows to a single column on a phone.
  const contents =
    input.snapshot.items.length > 1
      ? `<nav class="contents"><p>Contents</p><ol>${input.snapshot.items
          .map((item, index) => `<li><a href="#item-${index}">${escapeHtml(item.title)}</a></li>`)
          .join("")}</ol></nav>`
      : "";
  return shell(
    input.title,
    input.nonce,
    `<div class="wrap">${identityHeader(input.identity, base)}<h1>${escapeHtml(
      input.title,
    )}</h1>${contents}${items}</div>`,
    PAGE_JS(input.slug, input.snapshot.id, input.trackOpens, base),
  );
}

// The password gate. Says nothing about the publication behind it.
export function renderPasswordPage(slug: string, nonce: string, basePath = ""): string {
  const action = `${basePath}/api/v/${encodeURIComponent(slug)}/unlock`;
  return shell(
    "Protected",
    nonce,
    `<div class="gate"><h1>This link is protected</h1>` +
      `<p>Enter the password you were given.</p>` +
      `<form id="f"><label for="p">Password</label>` +
      `<input id="p" name="password" type="password" autocomplete="current-password" autofocus>` +
      `<button type="submit">Open</button><div class="error" id="e"></div></form></div>`,
    `document.getElementById('f').addEventListener('submit', async function(ev){
  ev.preventDefault();
  var e = document.getElementById('e');
  e.textContent = '';
  var res = await fetch(${JSON.stringify(action)}, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: document.getElementById('p').value }),
  });
  if (res.ok) { location.reload(); return; }
  e.textContent = res.status === 429 ? 'Too many attempts — try again later.' : 'That password did not work.';
});`,
  );
}
