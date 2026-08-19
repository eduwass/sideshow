import assert from "node:assert/strict";
import { test } from "node:test";
import { renderPasswordPage, renderPublicationPage } from "../server/publicationPage.ts";
import type { IdentityHeader, SnapshotItem } from "../server/publicationTypes.ts";
import type { Surface } from "../server/types.ts";

const NONCE = "abc123nonce";
const XSS = `<script>alert(1)</script>"`;

const item = (over: Partial<SnapshotItem> = {}): SnapshotItem => ({
  postId: "post-1",
  title: "Frozen post",
  version: 1,
  surfaces: [],
  ...over,
});

const render = (
  over: {
    title?: string;
    identity?: IdentityHeader | null;
    slug?: string;
    items?: SnapshotItem[];
    trackOpens?: boolean;
    basePath?: string;
    snapshotId?: string;
  } = {},
) =>
  renderPublicationPage({
    title: over.title ?? "Quarterly report",
    identity: over.identity ?? null,
    slug: over.slug ?? "demo-slug",
    snapshot: {
      id: over.snapshotId ?? "snap-1",
      revision: 1,
      items: over.items ?? [item()],
    },
    trackOpens: over.trackOpens ?? false,
    ...(over.basePath !== undefined && { basePath: over.basePath }),
    nonce: NONCE,
  });

// --- shell --------------------------------------------------------------

test("the page shell carries the title, noindex and the nonce on both inline blocks", () => {
  const html = render({ title: "Q3 & <report>" });
  assert.match(html, /<title>Q3 &amp; &lt;report&gt;<\/title>/);
  assert.match(html, /<meta name="robots" content="noindex, nofollow, noarchive">/);
  assert.match(html, new RegExp(`<style nonce="${NONCE}">`));
  assert.match(html, new RegExp(`<script nonce="${NONCE}">`));
  // The visible heading is escaped too, not just the <title>.
  assert.match(html, /<h1>Q3 &amp; &lt;report&gt;<\/h1>/);
});

test("every agent- and owner-authored string is escaped, never markup", () => {
  const html = render({
    title: XSS,
    identity: { name: XSS },
    items: [
      item({
        title: XSS,
        surfaces: [
          { kind: "image", assetId: "asset-1", alt: XSS, caption: XSS },
          { kind: "html", html: "<p>ignored</p>" },
        ],
      }),
      item({ title: XSS, surfaces: [] }),
    ],
  });
  assert.equal(html.includes("<script>alert"), false, "no raw script tag anywhere");
  assert.equal(html.includes(`alt="${XSS}"`), false);
  // Each occurrence survived as escaped text instead.
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;&quot;/);
  assert.match(html, /alt="&lt;script&gt;alert\(1\)&lt;\/script&gt;&quot;"/);
  assert.match(html, /<figcaption>&lt;script&gt;alert\(1\)&lt;\/script&gt;&quot;<\/figcaption>/);
  assert.match(html, /title="&lt;script&gt;alert\(1\)&lt;\/script&gt;&quot;"/);
});

// --- surfaces -----------------------------------------------------------

const SANDBOXED: [string, Surface][] = [
  ["html", { kind: "html", html: `<p id="agent-markup">hi</p>` }],
  ["markdown", { kind: "markdown", markdown: "# agent-markup" }],
  ["code", { kind: "code", code: "const agentMarkup = 1;", language: "ts" }],
  ["diff", { kind: "diff", patch: "--- a\n+++ b\n@@ -1 +1 @@\n-agent-markup\n+x\n" }],
  ["terminal", { kind: "terminal", text: "$ agent-markup" }],
  ["mermaid", { kind: "mermaid", mermaid: "graph TD; agentMarkup-->B;" }],
];

for (const [kind, surface] of SANDBOXED) {
  test(`a ${kind} surface is only ever an opaque-origin iframe, never inlined`, () => {
    const html = render({ items: [item({ surfaces: [surface] })] });
    assert.match(
      html,
      /<iframe data-surface data-item="0" data-si="0" sandbox="allow-scripts allow-popups" loading="lazy" title="Frozen post" src="\/api\/v\/demo-slug\/s\/0\/0\?fb=1">/,
    );
    assert.equal(html.includes("allow-same-origin"), false, "never same-origin");
    // None of the surface's own content reached the trusted document.
    for (const marker of ["agent-markup", "agentMarkup"]) {
      assert.equal(html.includes(marker), false, `${kind} content leaked via ${marker}`);
    }
  });
}

test("surface iframe srcs are indexed by item and surface position", () => {
  const html = render({
    items: [
      item({ surfaces: [{ kind: "html", html: "<p>a</p>" }] }),
      item({
        surfaces: [
          { kind: "json", data: 1 },
          { kind: "markdown", markdown: "b" },
        ],
      }),
    ],
  });
  assert.match(html, /src="\/api\/v\/demo-slug\/s\/0\/0\?fb=1"/);
  assert.match(html, /src="\/api\/v\/demo-slug\/s\/1\/1\?fb=1"/);
});

test("an image surface renders an escaped img, with the figcaption only when captioned", () => {
  const withCaption = render({
    items: [
      item({
        surfaces: [{ kind: "image", assetId: "asset id/1", alt: "a png", caption: "figure 1" }],
      }),
    ],
  });
  assert.match(
    withCaption,
    /<figure class="surface"><img src="\/a\/asset%20id%2F1" alt="a png" loading="lazy"><figcaption>figure 1<\/figcaption><\/figure>/,
  );

  const bare = render({ items: [item({ surfaces: [{ kind: "image", assetId: "asset-1" }] })] });
  assert.match(bare, /<img src="\/a\/asset-1" alt="" loading="lazy">/);
  assert.equal(bare.includes("<figcaption>"), false);
});

test("a json surface renders escaped JSON in a pre, and undefined data as null", () => {
  const html = render({
    items: [item({ surfaces: [{ kind: "json", data: { a: "<b>", c: [1, 2] } }] })],
  });
  assert.match(html, /<div class="surface"><pre>\{\n  &quot;a&quot;: &quot;&lt;b&gt;&quot;/);
  assert.equal(html.includes("<b>"), false);

  const undef = render({
    items: [item({ surfaces: [{ kind: "json", data: undefined } as unknown as Surface] })],
  });
  assert.match(undef, /<pre>null<\/pre>/);
});

test("a trace surface renders nothing at all", () => {
  const html = render({
    items: [
      item({
        surfaces: [{ kind: "trace", assetId: "trace-1", steps: [] } as unknown as Surface],
      }),
    ],
  });
  assert.match(html, /<section class="item"><\/section>/);
  assert.equal(html.includes("trace-1"), false);
});

test("basePath prefixes every URL the page builds", () => {
  const html = render({
    basePath: "/show",
    trackOpens: true,
    identity: { name: "Edu", avatarAssetId: "av-1" },
    items: [
      item({
        surfaces: [
          { kind: "html", html: "<p>x</p>" },
          { kind: "image", assetId: "asset-1" },
        ],
      }),
    ],
  });
  assert.match(html, /src="\/show\/api\/v\/demo-slug\/s\/0\/0\?fb=1"/);
  assert.match(html, /<img src="\/show\/a\/asset-1"/);
  assert.match(html, /src="\/show\/a\/av-1" alt=""/);
  assert.match(html, /"\/show\/api\/v\/demo-slug\/open"/);
  assert.match(html, /"\/show\/api\/v\/demo-slug\/feedback"/);
});

// --- item headings ------------------------------------------------------

test("item headings appear only when a snapshot holds more than one item", () => {
  const single = render({ items: [item({ title: "Only one" })] });
  assert.equal(single.includes("<h2"), false);
  assert.equal(single.includes("Only one"), false, "a lone item's title is not repeated");

  const many = render({ items: [item({ title: "First" }), item({ title: "Second" })] });
  assert.match(many, /<h2 id="item-0">First<\/h2>/);
  assert.match(many, /<h2 id="item-1">Second<\/h2>/);
});

// --- contents nav -------------------------------------------------------

test("a collection gets a contents nav whose anchors match the item headings", () => {
  const html = render({
    items: [item({ title: "First" }), item({ title: "Second" }), item({ title: "Third" })],
  });
  assert.match(
    html,
    /<nav class="contents"><p>Contents<\/p><ol><li><a href="#item-0">First<\/a><\/li><li><a href="#item-1">Second<\/a><\/li><li><a href="#item-2">Third<\/a><\/li><\/ol><\/nav>/,
  );
  // The nav sits between the title and the items it links to.
  assert.ok(html.indexOf("<h1>") < html.indexOf('nav class="contents"'));
  assert.ok(html.indexOf('nav class="contents"') < html.indexOf('<section class="item">'));
  // Every anchor has a heading to land on — no link into nowhere.
  for (const index of [0, 1, 2]) {
    assert.equal(html.split(`href="#item-${index}"`).length - 1, 1);
    assert.equal(html.split(`<h2 id="item-${index}">`).length - 1, 1);
  }
});

test("a single-item snapshot has no contents nav and nothing to anchor", () => {
  const html = render({ items: [item({ title: "Only one" })] });
  assert.equal(html.includes('nav class="contents"'), false);
  assert.equal(html.includes("#item-0"), false);
  assert.equal(html.includes("<h2"), false);
});

test("a malicious item title is escaped in the contents nav too", () => {
  const html = render({ items: [item({ title: XSS }), item({ title: "Second" })] });
  assert.equal(html.includes("<script>alert"), false);
  assert.match(
    html,
    /<li><a href="#item-0">&lt;script&gt;alert\(1\)&lt;\/script&gt;&quot;<\/a><\/li>/,
  );
});

// --- identity header ----------------------------------------------------

test("no identity means no header element at all", () => {
  const html = render({ identity: null });
  assert.equal(html.includes('header class="identity"'), false);
  assert.match(html, /<div class="wrap"><h1>/);
});

test("an identity renders its avatar, name and link", () => {
  const html = render({
    identity: {
      name: "Edu Wass",
      avatarAssetId: "avatar-1",
      linkUrl: "https://example.com/edu",
      linkLabel: "example.com",
    },
  });
  assert.match(html, /<header class="identity"><img src="\/a\/avatar-1" alt=""><div>/);
  assert.match(html, /<div class="who">Edu Wass<\/div>/);
  assert.match(
    html,
    /<a href="https:\/\/example.com\/edu" rel="noopener noreferrer nofollow" target="_blank">example.com<\/a>/,
  );
});

test("an identity link with no label falls back to the URL host", () => {
  const html = render({ identity: { name: "Edu", linkUrl: "https://blog.example.com/a/b?q=1" } });
  assert.match(html, />blog\.example\.com<\/a>/);
});

test("an identity with neither avatar nor link renders just the name", () => {
  const html = render({ identity: { name: "Edu" } });
  assert.match(html, /<header class="identity"><div><div class="who">Edu<\/div><\/div><\/header>/);
});

// --- open tracking ------------------------------------------------------

test("trackOpens:false omits the confirmed-open fetch entirely", () => {
  const html = render({ trackOpens: false, snapshotId: "snap-xyz" });
  assert.equal(html.includes("confirmOpen"), false);
  assert.equal(html.includes("/open"), false);
  // The snapshot id is still in the page: the feedback composer submits against
  // the exact revision the reader is looking at. Tracking is what is off.
  assert.match(html, /"\/api\/v\/demo-slug\/feedback"/);
  // The message bridge is still there — resize is not tracking.
  assert.match(html, /d\.type === 'resize'/);
});

test("trackOpens:true posts the snapshot id to the confirmed-open route", () => {
  const html = render({ trackOpens: true, slug: "demo-slug", snapshotId: "snap-xyz" });
  assert.match(html, /fetch\("\/api\/v\/demo-slug\/open"/);
  assert.match(html, /JSON\.stringify\(\{ snapshotId: "snap-xyz" \}\)/);
  assert.match(html, /keepalive: true/);
});

// --- password gate ------------------------------------------------------

test("the password gate asks for a password and reveals nothing behind it", () => {
  const html = renderPasswordPage("demo-slug", NONCE);
  assert.match(html, /<title>Protected<\/title>/);
  assert.match(html, /<input id="p" name="password" type="password"/);
  assert.match(html, /"\/api\/v\/demo-slug\/unlock"/);
  assert.match(html, new RegExp(`<style nonce="${NONCE}">`));
  assert.match(html, new RegExp(`<script nonce="${NONCE}">`));

  // Nothing about the publication behind the gate leaks; the slug the caller
  // already holds appears only in the form action it must post to.
  for (const secret of ["Quarterly report", "snap-1", "Edu Wass", "Frozen post", "asset-1"]) {
    assert.equal(html.includes(secret), false, secret);
  }
  assert.equal(html.split("demo-slug").length - 1, 1, "the slug appears once, in the action");
});

test("the password gate escapes the slug into its action and honours basePath", () => {
  const html = renderPasswordPage(`a"b`, NONCE, "/show");
  assert.match(html, /"\/show\/api\/v\/a%22b\/unlock"/);
  assert.equal(html.includes(`a"b`), false);
});

// --- neutrality: no product branding, no private chrome ------------------

// The one thing a client page must never do is look like a Sideshow page. This
// used to allow two protocol identifiers through — the localStorage key for the
// reader's scheme override, and the postMessage marker the surface bridge
// stamps its messages with. A production smoke test flagged both: a reader who
// opens devtools should find nothing naming the tool this was published from.
// The key is now neutral, and the message handler trusts frame IDENTITY rather
// than a magic word (which was always the real control), so the assertion can
// be what it should have been: the product name appears nowhere at all.
function assertNoBranding(html: string, label: string) {
  assert.equal(/sideshow/i.test(html), false, `${label}: the product name reached the page`);
  // Nor any of the usual ways a product signs its own pages.
  for (const marketing of [/powered by/i, /made with/i, /built with/i, /\bbrand\b/i]) {
    assert.equal(marketing.test(html), false, `${label}: ${marketing}`);
  }
}

// Private-runtime surfaces that must have no representative on a client page.
const PRIVATE_CHROME = [
  "/api/sessions",
  "/api/posts",
  "/api/comments",
  "/api/events",
  "/api/snippets",
  "/api/surfaces",
  "/api/theme",
  "/api/publications",
  "/api/owner",
  "/mcp",
  "/setup",
  "/guide",
  "/connect",
  "/agent-howto",
  "session",
  "workspace",
  "viewer/dist",
  "engine.js",
];

function assertNoPrivateChrome(html: string, label: string) {
  const lower = html.toLowerCase();
  for (const marker of PRIVATE_CHROME) {
    assert.equal(lower.includes(marker.toLowerCase()), false, `${label}: leaked ${marker}`);
  }
  // No script the page did not build itself: the viewer bundle, or anything
  // else with a src, would be a second origin's code running here.
  assert.equal(/<script[^>]+src=/i.test(html), false, `${label}: an external script`);
  assert.equal(/<link[^>]+href=/i.test(html), false, `${label}: an external stylesheet`);
}

test("a publication page carries no product branding and no private chrome", () => {
  const html = render({
    identity: {
      name: "Edu Wass",
      avatarAssetId: "avatar-1",
      linkUrl: "https://example.com/edu",
      linkLabel: "example.com",
    },
    trackOpens: true,
    items: [
      item({
        title: "First",
        surfaces: [
          { kind: "html", html: "<p>x</p>" },
          { kind: "markdown", markdown: "# x" },
          { kind: "image", assetId: "asset-1", caption: "a figure" },
          { kind: "json", data: { ok: true } },
        ],
      }),
      item({ title: "Second", surfaces: [{ kind: "terminal", text: "$ x" }] }),
    ],
  });
  assertNoBranding(html, "publication page");
  assertNoPrivateChrome(html, "publication page");

  // Every link the page offers is either an in-page anchor or the identity's
  // own external URL — never a route back into the product.
  const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(hrefs, ["https://example.com/edu", "#item-0", "#item-1"]);

  // The only URLs the page fetches or frames are publication-scoped.
  const urls = [...html.matchAll(/(?:src|fetch\()="?([^"')]+)/g)].map((m) => m[1]);
  for (const url of urls) {
    assert.match(url, /^\/(api\/v\/demo-slug\/|a\/)/, `unexpected URL ${url}`);
  }
});

test("the password gate carries no product branding and no private chrome", () => {
  const html = renderPasswordPage("demo-slug", NONCE);
  assertNoBranding(html, "password gate");
  assertNoPrivateChrome(html, "password gate");
  assert.deepEqual([...html.matchAll(/href="([^"]*)"/g)], []);
});

// --- the neutral palette and its local override -------------------------

test("the palette is defined on bare :root, then overridden by scheme", () => {
  const html = render();

  // Light is the bare default, so a reader with no system preference and no
  // override still gets a complete palette.
  const bare = /:root\{([^}]*)\}/.exec(html)?.[1] ?? "";
  assert.match(bare, /--bg:#ffffff/);
  assert.match(bare, /--text:#1b1b1f/);
  assert.match(bare, /color-scheme: light dark/);

  // System dark follows — but guarded, so an explicit light override wins.
  assert.match(
    html,
    /@media \(prefers-color-scheme: dark\)\{\s*:root:not\(\[data-scheme="light"\]\)\{[^}]*--bg:#111114/,
  );
  // And an explicit dark override wins over a light system preference.
  assert.match(html, /:root\[data-scheme="dark"\]\{[^}]*--bg:#111114/);
  assert.match(html, /:root\[data-scheme="light"\]\{[^}]*color-scheme: light/);

  // body paints its own ground from a token rather than inheriting one.
  const body = /\bbody\{([^}]*)\}/.exec(html)?.[1] ?? "";
  assert.match(body, /background:var\(--bg\)/);
  assert.match(body, /color:var\(--text\)/);

  // No brand hue anywhere in the palette — the neutral greys only.
  for (const [, value] of html.matchAll(
    /--(?:bg|surface|border|text|muted|accent):(#[0-9a-f]{6})/g,
  )) {
    const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(value.slice(i, i + 2), 16));
    assert.ok(Math.max(r, g, b) - Math.min(r, g, b) <= 12, `${value} is not neutral`);
  }
});

test("the scheme toggle is a labelled control that persists the reader's choice locally", () => {
  const html = render();
  assert.match(
    html,
    /<button id="scheme-toggle" type="button" aria-label="Switch between light and dark">/,
  );
  // The choice is stored on the reader's device and never posted anywhere.
  assert.match(html, /localStorage\.setItem\(KEY, next\)/);
  assert.match(html, /var KEY = 'pub\.scheme'/);
  // Switching re-requests each surface with an explicit mode: a sandboxed
  // surface bakes its colours in, so it must re-render rather than restyle.
  assert.match(html, /'mode=' \+ mode/);
  assert.match(html, /root\.setAttribute\('data-scheme', scheme\)/);
  // With nothing stored, the system preference decides.
  assert.match(html, /prefers-color-scheme: dark/);
});

// --- isolation ----------------------------------------------------------

test("an html surface's script never reaches the trusted page, only its iframe reference", () => {
  const html = render({
    items: [
      item({
        surfaces: [{ kind: "html", html: `<script>window.__pwned = 1;</script><p>hi</p>` }],
      }),
    ],
  });
  assert.equal(html.includes("__pwned"), false);
  assert.equal(html.includes("<script>window"), false);
  // Exactly one script in the document: the page's own nonced bridge.
  assert.equal(html.split("<script").length - 1, 1);
  assert.match(
    html,
    /<iframe data-surface data-item="0" data-si="0" sandbox="allow-scripts allow-popups"/,
  );
  assert.equal(html.includes("allow-same-origin"), false);
  assert.equal(html.includes("allow-forms"), false);
  assert.equal(html.includes("allow-top-navigation"), false);
});
