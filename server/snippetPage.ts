import type { Snippet } from "./types.ts";

// Origins snippets may load external resources from. Mirrors the allowlist
// agents already know from Claude's inline widget surface.
export const CDN_ALLOWLIST = [
  "https://cdnjs.cloudflare.com",
  "https://esm.sh",
  "https://cdn.jsdelivr.net",
  "https://unpkg.com",
  "https://fonts.googleapis.com",
  "https://fonts.gstatic.com",
];

const cdns = CDN_ALLOWLIST.join(" ");

const CSP = [
  `default-src 'none'`,
  `script-src 'unsafe-inline' ${cdns}`,
  `style-src 'unsafe-inline' ${cdns}`,
  `font-src ${cdns} data:`,
  `img-src https: data: blob:`,
  `connect-src ${cdns}`,
  `media-src https: data: blob:`,
].join("; ");

// Design tokens exposed to snippets. Names match Claude's widget surface so
// agents can reuse the same muscle memory. Both modes are always defined.
const TOKENS_CSS = `
:root {
  --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --font-serif: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --border-radius-md: 8px;
  --border-radius-lg: 12px;
  --border-radius-xl: 16px;
  --color-background-primary: #ffffff;
  --color-background-secondary: #f5f4ed;
  --color-background-tertiary: #faf9f5;
  --color-background-info: #e6f1fb;
  --color-background-danger: #fcebeb;
  --color-background-success: #eaf3de;
  --color-background-warning: #faeeda;
  --color-text-primary: #1a1915;
  --color-text-secondary: #5f5e56;
  --color-text-tertiary: #8e8d83;
  --color-text-info: #185fa5;
  --color-text-danger: #a32d2d;
  --color-text-success: #3b6d11;
  --color-text-warning: #854f0b;
  --color-border-primary: rgba(20, 20, 10, 0.4);
  --color-border-secondary: rgba(20, 20, 10, 0.25);
  --color-border-tertiary: rgba(20, 20, 10, 0.12);
  --color-border-info: #378add;
  --color-border-danger: #e24b4a;
  --color-border-success: #97c459;
  --color-border-warning: #ef9f27;
}
@media (prefers-color-scheme: dark) {
  :root {
    --color-background-primary: #2a2925;
    --color-background-secondary: #21201c;
    --color-background-tertiary: #1b1a17;
    --color-background-info: rgba(55, 138, 221, 0.18);
    --color-background-danger: rgba(226, 75, 74, 0.18);
    --color-background-success: rgba(151, 196, 89, 0.18);
    --color-background-warning: rgba(239, 159, 39, 0.18);
    --color-text-primary: #eceadf;
    --color-text-secondary: #b3b1a4;
    --color-text-tertiary: #8a887c;
    --color-text-info: #85b7eb;
    --color-text-danger: #f09595;
    --color-text-success: #c0dd97;
    --color-text-warning: #fac775;
    --color-border-primary: rgba(255, 255, 250, 0.4);
    --color-border-secondary: rgba(255, 255, 250, 0.25);
    --color-border-tertiary: rgba(255, 255, 250, 0.12);
  }
}
html { box-sizing: border-box; scrollbar-width: none; }
html::-webkit-scrollbar, body::-webkit-scrollbar { display: none; }
*, *::before, *::after { box-sizing: inherit; }
body {
  margin: 0;
  padding: 16px;
  background: var(--color-background-primary);
  color: var(--color-text-primary);
  font: 16px/1.6 var(--font-sans);
}
`;

// Bridge to the host viewer: sendPrompt/openLink mirror Claude's widget
// globals, and a ResizeObserver reports content height so the parent can
// size the sandboxed (opaque-origin) iframe.
const BRIDGE_JS = `
window.sendPrompt = function (text) {
  parent.postMessage({ __sideshow: true, type: 'send-prompt', text: String(text) }, '*');
};
window.openLink = function (url) {
  parent.postMessage({ __sideshow: true, type: 'open-link', url: String(url) }, '*');
};
document.addEventListener('click', function (e) {
  var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
  if (a && /^https?:/.test(a.href)) { e.preventDefault(); window.openLink(a.href); }
});
var __lastH = 0;
function __report() {
  var h = document.body
    ? document.body.scrollHeight
    : document.documentElement.scrollHeight;
  if (h > 0 && h !== __lastH) {
    __lastH = h;
    parent.postMessage({ __sideshow: true, type: 'resize', height: h }, '*');
  }
}
if (document.readyState === 'complete') __report();
else window.addEventListener('load', function () { requestAnimationFrame(__report); });
setTimeout(__report, 60);
setTimeout(__report, 350);
setTimeout(__report, 1500);
if (window.ResizeObserver) {
  window.__ssRO = new ResizeObserver(__report);
  window.__ssRO.observe(document.documentElement);
  if (document.body) window.__ssRO.observe(document.body);
}
`;

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function renderSnippetPage(snippet: Snippet): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<title>${escapeHtml(snippet.title)}</title>
<style>${TOKENS_CSS}</style>
</head>
<body>
${snippet.html}
<script>${BRIDGE_JS}</script>
</body>
</html>`;
}
