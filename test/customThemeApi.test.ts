// The private runtime's custom-theme surface: validation at the door, the
// palette reaching chrome AND sandboxed surfaces, and the revision defeating
// every cache that is keyed on the (unchanging) theme id.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../server/app.ts";
import { CUSTOM_THEME_ID, CUSTOM_THEME_VERSION } from "../server/customTheme.ts";
import { JsonFileStore } from "../server/storage.ts";

const makeApp = () =>
  createApp({
    store: new JsonFileStore(join(mkdtempSync(join(tmpdir(), "sideshow-theme-")), "data.json")),
    viewerHtml: "<html><head></head><body>viewer</body></html>",
    guideMarkdown: "# guide",
    setupText: "# setup",
    version: "9.9.9",
  });

const accent = (bg: string) => ({ bg, text: "#112233", border: "#334455" });
const palette = (bg: string) => ({
  bg,
  panel: "#222222",
  surface: bg,
  text: "#ffffff",
  muted: "#cccccc",
  faint: "#999999",
  border: "#444444",
  border2: "#555555",
  hover: "rgba(255, 255, 255, 0.1)",
  info: accent("#001122"),
  success: accent("#002200"),
  warning: accent("#222200"),
  danger: accent("#220000"),
});

const push = (app: ReturnType<typeof createApp>, body: unknown, method = "PUT") =>
  app.request("/api/theme/custom", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const themePayload = (bg: string, over: Record<string, unknown> = {}) => ({
  version: CUSTOM_THEME_VERSION,
  label: "Monotheme",
  dark: { palette: palette(bg) },
  light: { palette: palette(bg) },
  ...over,
});

const publishHtml = async (app: ReturnType<typeof createApp>) => {
  const res = await app.request("/api/posts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Themed", surfaces: [{ kind: "html", html: "<b>hi</b>" }] }),
  });
  return ((await res.json()) as { id: string }).id;
};

test("a malformed custom theme is refused with a reason and changes nothing", async () => {
  const app = makeApp();
  for (const bad of [
    "not-json-object",
    { version: 999, label: "x", dark: { palette: palette("#000000") } },
    { version: CUSTOM_THEME_VERSION, label: "x" },
    { version: CUSTOM_THEME_VERSION, label: "x", dark: { palette: palette("javascript:1") } },
  ]) {
    const res = await push(app, bad);
    assert.equal(res.status, 400, JSON.stringify(bad));
    const body = (await res.json()) as { error: string; version: number };
    assert.ok(body.error.length > 0);
    assert.equal(body.version, CUSTOM_THEME_VERSION);
  }
  const theme = (await (await app.request("/api/theme")).json()) as {
    id: string;
    custom: unknown;
    customRevision: number;
  };
  assert.equal(theme.id, "github");
  assert.equal(theme.custom, null);
  assert.equal(theme.customRevision, 0);
});

test("an accepted push becomes the active theme and is offered in the picker", async () => {
  const app = makeApp();
  const res = await push(app, themePayload("#0a0b0c"));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { id: CUSTOM_THEME_ID, revision: 1, label: "Monotheme" });

  const theme = (await (await app.request("/api/theme")).json()) as any;
  assert.equal(theme.id, CUSTOM_THEME_ID);
  assert.equal(theme.customRevision, 1);
  assert.equal(theme.custom.label, "Monotheme");
  assert.equal(theme.custom.dark.bg, "#0a0b0c");
  assert.ok(theme.themes.some((t: { id: string }) => t.id === CUSTOM_THEME_ID));

  // PUT /api/theme accepts the custom id only because the record exists.
  const select = await app.request("/api/theme", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: CUSTOM_THEME_ID }),
  });
  assert.equal(select.status, 200);
});

test("the custom id is not selectable when no custom theme has been pushed", async () => {
  const app = makeApp();
  const res = await app.request("/api/theme", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: CUSTOM_THEME_ID }),
  });
  assert.equal(res.status, 400);
});

// The acceptance criterion in one test: same post, same version, same theme id,
// different content — the render cache must not answer with the first palette.
test("a re-push under the same id cannot be served from the render cache", async () => {
  const app = makeApp();
  const id = await publishHtml(app);

  await push(app, themePayload("#010203"));
  const first = await app.request(`/s/${id}?part=0&ver=1&theme=${CUSTOM_THEME_ID}&mode=dark`);
  const firstDoc = await first.text();
  assert.match(firstDoc, /#010203/);

  await push(app, themePayload("#0f0e0d"));
  const second = await app.request(`/s/${id}?part=0&ver=1&theme=${CUSTOM_THEME_ID}&mode=dark`);
  const secondDoc = await second.text();
  assert.match(secondDoc, /#0f0e0d/);
  assert.doesNotMatch(secondDoc, /#010203/);
  assert.notEqual(firstDoc, secondDoc);

  // …and the identical request is still cacheable when nothing changed.
  const repeat = await app.request(`/s/${id}?part=0&ver=1&theme=${CUSTOM_THEME_ID}&mode=dark`);
  assert.equal(await repeat.text(), secondDoc);
});

test("a custom-theme surface is only immutable when the caller pinned the revision", async () => {
  const app = makeApp();
  const id = await publishHtml(app);
  await push(app, themePayload("#123456"));

  const unpinned = await app.request(`/s/${id}?part=0&ver=1&theme=${CUSTOM_THEME_ID}`);
  assert.equal(unpinned.headers.get("cache-control"), "private, no-cache");

  const stale = await app.request(`/s/${id}?part=0&ver=1&theme=${CUSTOM_THEME_ID}&trev=0`);
  assert.equal(stale.headers.get("cache-control"), "private, no-cache");

  const pinned = await app.request(`/s/${id}?part=0&ver=1&theme=${CUSTOM_THEME_ID}&trev=1`);
  assert.match(pinned.headers.get("cache-control") ?? "", /immutable/);

  // A registry theme has no revision, so it keeps the long-lived header.
  const builtin = await app.request(`/s/${id}?part=0&ver=1&theme=github`);
  assert.match(builtin.headers.get("cache-control") ?? "", /immutable/);
});

test("the advertised social-card URL changes when the pushed palette does", async () => {
  const app = makeApp();
  const id = await publishHtml(app);
  const generation = async () => {
    const html = await (await app.request(`/p/${id}`)).text();
    return /property="og:image" content="([^"]+)"/.exec(html)?.[1] ?? "";
  };
  await push(app, themePayload("#010203"));
  const first = await generation();
  await push(app, themePayload("#0f0e0d"));
  const second = await generation();
  assert.match(first, /g=9\.9\.9-t1/);
  assert.match(second, /g=9\.9\.9-t2/);
  assert.notEqual(first, second);
});

test("a pushed syntax theme highlights a rich surface without failing the render", async () => {
  const app = makeApp();
  const res = await app.request("/api/posts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: "Rich",
      surfaces: [{ kind: "markdown", markdown: "```js\nconst a = 1;\n```" }],
    }),
  });
  const id = ((await res.json()) as { id: string }).id;
  await push(
    app,
    themePayload("#101112", {
      dark: {
        palette: palette("#101112"),
        syntax: {
          bg: "#101112",
          fg: "#eeeeee",
          tokenColors: [
            { scope: "keyword", settings: { foreground: "#ff00ff", fontStyle: "bold" } },
          ],
        },
      },
    }),
  );
  const doc = await (
    await app.request(`/s/${id}?part=0&ver=1&theme=${CUSTOM_THEME_ID}&mode=dark`)
  ).text();
  assert.equal(doc.includes("<code"), true);
  assert.match(doc, /#101112/);
});

test("deleting the custom theme restores the default and forgets the palette", async () => {
  const app = makeApp();
  await push(app, themePayload("#0a0b0c"));
  const removed = await push(app, null, "DELETE");
  assert.equal(removed.status, 200);
  assert.deepEqual(await removed.json(), { id: "github", removed: true });

  const theme = (await (await app.request("/api/theme")).json()) as any;
  assert.equal(theme.id, "github");
  assert.equal(theme.custom, null);
  assert.equal(theme.customRevision, 0);
  assert.equal(
    theme.themes.some((t: { id: string }) => t.id === CUSTOM_THEME_ID),
    false,
  );

  // Deleting again is harmless, and a non-custom selection is left alone.
  const again = await push(app, null, "DELETE");
  assert.deepEqual(await again.json(), { id: "github", removed: false });
});

test("a selected non-custom theme survives deleting the custom one", async () => {
  const app = makeApp();
  await push(app, themePayload("#0a0b0c"));
  await app.request("/api/theme", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "gruvbox" }),
  });
  await push(app, null, "DELETE");
  assert.equal(((await (await app.request("/api/theme")).json()) as any).id, "gruvbox");
});

test("the custom-theme routes require the workspace token", async () => {
  const app = createApp({
    store: new JsonFileStore(join(mkdtempSync(join(tmpdir(), "sideshow-theme-")), "data.json")),
    viewerHtml: "<html><head></head><body>viewer</body></html>",
    guideMarkdown: "# guide",
    setupText: "# setup",
    authToken: "secret",
  });
  for (const method of ["PUT", "DELETE"]) {
    const res = await app.request("/api/theme/custom", {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(themePayload("#0a0b0c")),
    });
    assert.equal(res.status, 401, method);
  }
});
