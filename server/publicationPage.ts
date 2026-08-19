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

// A stable neutral palette: no brand hues. It follows the reader's system
// scheme by default, and a local override (stored on their device only) pins it
// either way. The light values are the bare defaults so a reader with no
// preference and no override still gets a complete palette.
const PAGE_CSS = `
:root{
  color-scheme: light dark;
  --bg:#ffffff; --surface:#ffffff; --border:#e2e2e5; --text:#1b1b1f;
  --muted:#6b6b73; --accent:#3a3a42; --radius:10px;
}
@media (prefers-color-scheme: dark){
  :root:not([data-scheme="light"]){ --bg:#111114; --surface:#17171b; --border:#2b2b31; --text:#ececef; --muted:#9a9aa3; --accent:#d6d6dc; }
}
:root[data-scheme="dark"]{ color-scheme: dark; --bg:#111114; --surface:#17171b; --border:#2b2b31; --text:#ececef; --muted:#9a9aa3; --accent:#d6d6dc; }
:root[data-scheme="light"]{ color-scheme: light; }
.scheme{position:fixed;top:12px;right:12px;z-index:2}
.scheme button{
  display:flex;align-items:center;justify-content:center;width:32px;height:32px;
  border:1px solid var(--border);border-radius:8px;background:var(--surface);
  color:var(--muted);cursor:pointer;font-size:14px;line-height:1;padding:0;
}
.scheme button:hover{color:var(--text)}
@media print{ .scheme{display:none} }
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

/* Feedback composer (issue #9). Fixed to the viewport so it is reachable from
   anywhere in a long publication, and a full-width sheet on a phone. Widths are
   capped against the containing block (the viewport, scrollbar excluded) rather
   than 100vw, so the panel can never push the page into horizontal scroll. */
.fb-add{
  position:fixed;left:12px;bottom:12px;z-index:3;
  padding:9px 14px;border:1px solid var(--border);border-radius:999px;
  background:var(--surface);color:var(--text);font-size:14px;cursor:pointer;
  box-shadow:0 2px 10px rgba(0,0,0,.10);max-width:calc(100% - 24px);
}
.fb-add[aria-pressed="true"]{background:var(--accent);color:var(--bg);border-color:var(--accent)}
.fb-panel{
  position:fixed;right:12px;bottom:12px;z-index:4;width:340px;max-width:calc(100% - 24px);
  background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);
  padding:14px;box-shadow:0 8px 30px rgba(0,0,0,.20);
}
.fb-panel[hidden]{display:none}
.fb-title{font-size:14px;margin:0 0 8px;font-weight:600;color:var(--text)}
.fb-quote{
  margin:0 0 10px;padding:8px 10px;border-left:2px solid var(--border);
  color:var(--muted);font-size:13px;max-height:5.4em;overflow:auto;overflow-wrap:anywhere;
}
.fb-panel label{display:block;font-size:12px;color:var(--muted);margin:0 0 8px}
/* The class rule above outranks the UA's [hidden] rule, so say it explicitly —
   the name row is hidden once a browser has answered it. */
.fb-panel label[hidden]{display:none}
.fb-panel input,.fb-panel textarea{
  display:block;width:100%;margin-top:4px;padding:8px 10px;border:1px solid var(--border);
  border-radius:8px;background:var(--bg);color:var(--text);font:14px/1.5 inherit;
}
.fb-panel textarea{min-height:84px;resize:vertical}
.fb-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:4px}
.fb-actions button{padding:8px 14px;border-radius:8px;font-size:14px;cursor:pointer}
.fb-actions .primary{border:0;background:var(--accent);color:var(--bg);font-weight:600}
.fb-actions .ghost{border:1px solid var(--border);background:var(--surface);color:var(--text)}
.fb-status{margin:8px 0 0;font-size:13px;color:var(--muted);min-height:18px}
.fb-done{
  position:fixed;left:50%;transform:translateX(-50%);bottom:14px;z-index:5;
  max-width:calc(100% - 24px);padding:10px 16px;border-radius:999px;
  background:var(--accent);color:var(--bg);font-size:14px;box-shadow:0 4px 18px rgba(0,0,0,.20);
}
.fb-done[hidden]{display:none}
/* Honeypot: off-screen for a person, filled in by a bot. Clipped rather than
   pushed off to the side so it can never widen the page. */
.fb-hp{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.fb-hp input{width:1px;height:1px;min-width:0;padding:0;margin:0;border:0}
@media (max-width:600px){
  .fb-panel{left:8px;right:8px;bottom:8px;width:auto;max-width:none}
  .fb-add{left:8px;bottom:8px}
}
@media print{ .fb-add,.fb-panel,.fb-done{display:none} }
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

  // Light/dark. The default is the reader's system scheme; a local override is
  // stored on their device only and never reaches the server. A sandboxed
  // surface bakes its colours into the document it was served as, so switching
  // has to RELOAD each frame with an explicit mode rather than restyle it.
  // Neutral key: a reader who opens devtools should find nothing that names the
  // tool this was published from.
  var KEY = 'pub.scheme';
  var root = document.documentElement;
  function stored(){
    try { return localStorage.getItem(KEY); } catch (e) { return null; }
  }
  function systemScheme(){
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';
  }
  function applyFrames(mode){
    for (var i = 0; i < frames.length; i++) {
      var f = frames[i];
      var base = f.getAttribute('data-src') || f.getAttribute('src');
      if (!base) continue;
      f.setAttribute('data-src', base);
      var next = base + (base.indexOf('?') < 0 ? '?' : '&') + 'mode=' + mode;
      if (f.getAttribute('src') !== next) f.setAttribute('src', next);
    }
  }
  function apply(scheme, reframe){
    if (scheme) root.setAttribute('data-scheme', scheme);
    else root.removeAttribute('data-scheme');
    if (reframe) applyFrames(scheme || systemScheme());
  }
  apply(stored(), !!stored());
  var toggle = document.getElementById('scheme-toggle');
  if (toggle) {
    toggle.addEventListener('click', function(){
      var next = (stored() || systemScheme()) === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem(KEY, next); } catch (e) {}
      apply(next, true);
    });
  }

  window.addEventListener('message', function(e){
    var d = e.data;
    if (!d || typeof d !== 'object') return;
    // Identity, not a magic word, is what makes a message trustworthy here: it
    // has to come from one of THIS page's own surface frames. The bridge's own
    // discriminator is deliberately not checked, so the product name never
    // appears in a client-facing document.
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
      return;
    }
    // Feedback capture. The anchor arrives as DATA and is only ever read as
    // data: nothing from a frame is inserted as markup anywhere below.
    // A lazy frame can finish loading after point mode was armed; catch it up.
    if (d.type === 'feedback-ready') {
      if (armed && frame.contentWindow) {
        frame.contentWindow.postMessage({ __pub: true, type: 'feedback-arm', mode: 'point' }, '*');
      }
      return;
    }
    if (d.type === 'feedback-select' && d.anchor) { openComposer(frame, d.anchor); return; }
    if (d.type === 'feedback-point' && d.anchor) { armPoint(false); openComposer(frame, d.anchor); }
  });

  // --- feedback composer ------------------------------------------------
  //
  // The selection itself is captured inside the sandboxed frame (the trusted
  // page cannot read across an opaque origin, and must not be able to). This
  // half owns identity, the note, and the single submission. Submissions are
  // private to the publication's owner: nothing here ever reads feedback back,
  // so one reader can never see another's note.
  var NAME_KEY = 'pub.feedback.name';
  var EMAIL_KEY = 'pub.feedback.email';
  var panel = document.getElementById('fb-panel');
  var form = document.getElementById('fb-form');
  var quoteEl = document.getElementById('fb-quote');
  var nameRow = document.getElementById('fb-name-row');
  var nameInput = document.getElementById('fb-name');
  var emailInput = document.getElementById('fb-email');
  var noteInput = document.getElementById('fb-note');
  var honeypot = document.getElementById('fb-website');
  var statusEl = document.getElementById('fb-status');
  var doneEl = document.getElementById('fb-done');
  var addBtn = document.getElementById('fb-add');
  var pending = null;
  var pendingFrame = null;
  var armed = false;
  var doneTimer = 0;

  function remembered(key){
    try { return localStorage.getItem(key) || ''; } catch (e) { return ''; }
  }
  function remember(key, value){
    try { localStorage.setItem(key, value); } catch (e) {}
  }
  function tellFrames(message){
    for (var i = 0; i < frames.length; i++) {
      var win = frames[i].contentWindow;
      if (win) win.postMessage(message, '*');
    }
  }
  function armPoint(next){
    armed = next;
    addBtn.setAttribute('aria-pressed', next ? 'true' : 'false');
    addBtn.textContent = next ? 'Click a spot \u2014 or press Esc' : 'Add a note';
    tellFrames({ __pub: true, type: 'feedback-arm', mode: next ? 'point' : 'none' });
  }
  function closeComposer(clearFrame){
    panel.hidden = true;
    if (clearFrame && pendingFrame && pendingFrame.contentWindow) {
      pendingFrame.contentWindow.postMessage({ __pub: true, type: 'feedback-clear' }, '*');
    }
    pending = null;
    pendingFrame = null;
  }
  function openComposer(frame, raw){
    var anchor = {
      itemIndex: Number(frame.getAttribute('data-item')),
      surfaceIndex: Number(frame.getAttribute('data-si')),
    };
    var surfaceId = frame.getAttribute('data-sid');
    if (surfaceId) anchor.surfaceId = surfaceId;
    var label;
    if (raw.kind === 'text') {
      anchor.kind = 'text';
      anchor.quote = String(raw.quote == null ? '' : raw.quote);
      if (!anchor.quote.trim()) return;
      // The frame drops start/end meta when its own quote check failed, so an
      // unverifiable structural position is never stored.
      if (raw.startMeta && raw.endMeta) {
        anchor.startMeta = raw.startMeta;
        anchor.endMeta = raw.endMeta;
      }
      if (typeof raw.prefix === 'string') anchor.prefix = raw.prefix;
      if (typeof raw.suffix === 'string') anchor.suffix = raw.suffix;
      label = '\u201c' + anchor.quote + '\u201d';
    } else {
      anchor.kind = 'point';
      anchor.x = Number(raw.x);
      anchor.y = Number(raw.y);
      if (!isFinite(anchor.x) || !isFinite(anchor.y)) return;
      label = 'A spot on \u201c' + (frame.getAttribute('title') || 'this') + '\u201d';
    }
    pending = anchor;
    pendingFrame = frame;
    // Everything a reader or an agent produced goes in as TEXT, never markup.
    quoteEl.textContent = label;
    statusEl.textContent = '';
    noteInput.value = '';
    var knownName = remembered(NAME_KEY);
    nameInput.value = knownName;
    emailInput.value = remembered(EMAIL_KEY);
    // Asked once per browser, then never again.
    nameRow.hidden = !!knownName;
    nameInput.required = !knownName;
    panel.hidden = false;
    (knownName ? noteInput : nameInput).focus();
  }
  function showDone(){
    doneEl.textContent = 'Thanks \u2014 your note went to the author.';
    doneEl.hidden = false;
    if (doneTimer) clearTimeout(doneTimer);
    doneTimer = setTimeout(function(){ doneEl.hidden = true; }, 6000);
  }

  addBtn.addEventListener('click', function(){
    if (!panel.hidden) closeComposer(true);
    armPoint(!armed);
  });
  document.getElementById('fb-cancel').addEventListener('click', function(){ closeComposer(true); });
  document.addEventListener('keydown', function(e){
    if (e.key !== 'Escape') return;
    if (armed) armPoint(false);
    if (!panel.hidden) closeComposer(true);
  });

  form.addEventListener('submit', function(ev){
    ev.preventDefault();
    if (!pending) return;
    var name = (nameInput.value || '').trim();
    var note = (noteInput.value || '').trim();
    if (!name) { statusEl.textContent = 'Please add your name.'; return; }
    if (!note) { statusEl.textContent = 'Please write a note.'; return; }
    statusEl.textContent = 'Sending\u2026';
    fetch(${JSON.stringify(`${base}/api/v/${slug}/feedback`)}, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        snapshotId: ${JSON.stringify(snapshotId)},
        anchor: pending,
        note: note,
        name: name,
        email: (emailInput.value || '').trim(),
        website: honeypot.value,
      }),
    }).then(function(res){
      if (res.status === 201) {
        remember(NAME_KEY, name);
        remember(EMAIL_KEY, (emailInput.value || '').trim());
        closeComposer(true);
        showDone();
        return;
      }
      if (res.status === 429) {
        statusEl.textContent = 'That is a lot of notes at once \u2014 please try again in a few minutes.';
        return;
      }
      if (res.status === 409) {
        statusEl.textContent = 'This page was updated while you were writing. Reload it, then send your note again.';
        return;
      }
      statusEl.textContent = 'That did not send. Please try again.';
    }).catch(function(){
      statusEl.textContent = 'That did not send \u2014 check your connection and try again.';
    });
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

// The composer. Static markup only — every value a reader or an agent produced
// is written into it later with textContent / .value, never as HTML. There is
// deliberately no thread, no reply and no list of other people's notes: a
// submission is private to the publication's owner, and this page has no route
// that could read one back.
const COMPOSER_HTML =
  `<button class="fb-add" id="fb-add" type="button" aria-pressed="false">Add a note</button>` +
  `<div class="fb-panel" id="fb-panel" role="dialog" aria-label="Send a note" hidden>` +
  `<form id="fb-form"><p class="fb-title">Send a note</p>` +
  `<p class="fb-quote" id="fb-quote"></p>` +
  `<label id="fb-name-row">Your name<input id="fb-name" name="name" maxlength="120" autocomplete="name"></label>` +
  `<label>Email <span>(optional)</span><input id="fb-email" name="email" type="email" maxlength="120" autocomplete="email"></label>` +
  `<label>Note<textarea id="fb-note" name="note" maxlength="4000" required></textarea></label>` +
  `<label class="fb-hp" aria-hidden="true">Website<input id="fb-website" name="website" type="text" tabindex="-1" autocomplete="off"></label>` +
  `<div class="fb-actions">` +
  `<button class="ghost" id="fb-cancel" type="button">Cancel</button>` +
  `<button class="primary" id="fb-send" type="submit">Send</button></div>` +
  `<p class="fb-status" id="fb-status" role="status" aria-live="polite"></p>` +
  `</form></div>` +
  `<div class="fb-done" id="fb-done" role="status" aria-live="polite" hidden></div>`;

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
          // `fb=1` asks the surface document for feedback capture. Only this
          // page ever sets it; a private workspace surface never carries it.
          const src = `${base}/api/v/${encodeURIComponent(input.slug)}/s/${itemIndex}/${surfaceIndex}?fb=1`;
          // The frame reports a selection or a click, but knows nothing about
          // where it sits — the anchor's surface identity is read back off
          // these attributes, in the trusted page.
          const surfaceId = surface.id ? ` data-sid="${escapeHtml(surface.id)}"` : "";
          // No allow-same-origin: the frame runs at an opaque origin and cannot
          // touch this page, its cookies or the API.
          return `<div class="surface"><iframe data-surface data-item="${itemIndex}" data-si="${surfaceIndex}"${surfaceId} sandbox="allow-scripts allow-popups" loading="lazy" title="${escapeHtml(
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
    `<div class="scheme"><button id="scheme-toggle" type="button" aria-label="Switch between light and dark">\u25d1</button></div>` +
      `<div class="wrap">${identityHeader(input.identity, base)}<h1>${escapeHtml(
        input.title,
      )}</h1>${contents}${items}</div>` +
      COMPOSER_HTML,
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
