import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../server/app.ts";
import { DestinationClient } from "../server/destination.ts";
import { createPublicApp } from "../server/publicApp.ts";
import type { SnapshotItem } from "../server/publicationTypes.ts";
import { frozenItem, publishableSurfaces, uploadItemAssets } from "../server/publishFlow.ts";
import { createSqliteStorage } from "../server/sqliteStorage.ts";
import { SqlStore } from "../server/sqlStore.ts";
import { JsonFileStore } from "../server/storage.ts";
import type { Asset, Post, Store, Surface } from "../server/types.ts";

// The two runtimes wired together in process: the private workspace publishes
// over its destination client, and the shim answers those server-to-server
// calls with the real public app instead of the network.

const DEST_ORIGIN = "https://pub.test";
const OWNER_TOKEN = "owner-token-value";
const IMAGE_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

type TestApp = { request: (u: string, i?: RequestInit) => Response | Promise<Response> };

/** Fail one destination call. Return a Response to answer it instead. */
type Interceptor = (path: string, init: RequestInit) => Response | null;

function makeStack() {
  const publicStore = new SqlStore(createSqliteStorage());
  const publicApp = createPublicApp({
    store: publicStore,
    ownerToken: OWNER_TOKEN,
    visitorSecret: "visitor-secret",
  });

  const dir = mkdtempSync(join(tmpdir(), "sideshow-publish-"));
  const privateStore = new JsonFileStore(join(dir, "data.json"));

  const calls: { method: string; path: string }[] = [];
  let intercept: Interceptor | null = null;

  const destinationFetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const target = String(url);
    assert.ok(target.startsWith(DEST_ORIGIN), `unexpected destination call to ${target}`);
    const path = target.slice(DEST_ORIGIN.length);
    calls.push({ method: init.method ?? "GET", path });
    // The token must actually travel on every server-to-server call.
    assert.equal(
      new Headers(init.headers).get("authorization"),
      `Bearer ${OWNER_TOKEN}`,
      `${path} was called unauthenticated`,
    );
    return intercept?.(path, init) ?? publicApp.request(target, init);
  }) as unknown as typeof fetch;

  const app = createApp({
    store: privateStore,
    viewerHtml: "<html><head></head><body>viewer</body></html>",
    guideMarkdown: "# guide",
    setupText: "# setup",
    destination: { origin: DEST_ORIGIN, token: OWNER_TOKEN },
    destinationFetch,
  });

  return {
    app: app as unknown as TestApp,
    publicApp: publicApp as unknown as TestApp,
    publicStore,
    privateStore,
    calls,
    setIntercept: (fn: Interceptor | null) => {
      intercept = fn;
    },
  };
}

const json = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
  body: JSON.stringify(body),
});

const publish = (app: TestApp, body: unknown) => app.request("/api/publish/post", json(body));

const owner = (publicApp: TestApp, path: string) =>
  publicApp.request(`${DEST_ORIGIN}${path}`, {
    headers: { authorization: `Bearer ${OWNER_TOKEN}` },
  });

/** A post carrying html + markdown + one image backed by real private bytes. */
async function seedPost(stack: ReturnType<typeof makeStack>, title = "Quarterly report") {
  const session = await stack.privateStore.createSession({ agent: "pi", title: "work" });
  const asset = await stack.privateStore.putAsset({
    sessionId: session.id,
    kind: "image",
    contentType: "image/png",
    filename: "shot.png",
    data: IMAGE_BYTES,
  });
  assert.ok(asset);
  const res = await stack.app.request(
    "/api/posts",
    json({
      session: session.id,
      title,
      surfaces: [
        { kind: "html", html: `<p id="v1">first cut</p>` },
        { kind: "markdown", markdown: "# First\n\nprose" },
        { kind: "image", assetId: asset.id, alt: "a shot" },
      ],
    }),
  );
  assert.equal(res.status, 201);
  return { post: (await res.json()) as { id: string; sessionId: string }, asset, session };
}

// --- 1 & 2. the first publish -------------------------------------------

test("publishing a post freezes it into a reachable public URL", async () => {
  const stack = makeStack();
  const { post, asset } = await seedPost(stack);

  // The asset is private until publishing copies its bytes across.
  assert.equal((await stack.publicApp.request(`${DEST_ORIGIN}/a/${asset.id}`)).status, 404);

  const res = await publish(stack.app, { postId: post.id });
  assert.equal(res.status, 201);
  const result = (await res.json()) as any;
  assert.equal(result.updated, false);
  assert.equal(result.revision, 1);
  assert.ok(result.publicationId);
  assert.ok(result.snapshotId);
  assert.equal(result.url, `${DEST_ORIGIN}/v/${result.slug}`);

  // The URL the caller was handed actually resolves on the public runtime.
  const page = await stack.publicApp.request(result.url);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /<h1>Quarterly report<\/h1>/);
  // Agent markup is referenced, never inlined into the trusted page.
  assert.equal(html.includes(`<p id="v1">`), false);
  assert.match(html, new RegExp(`/api/v/${result.slug}/s/0/0`));

  // The image bytes were copied into the public workspace and are pinned.
  const served = await stack.publicApp.request(`${DEST_ORIGIN}/a/${asset.id}`);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get("content-type"), "image/png");
  assert.deepEqual(new Uint8Array(await served.arrayBuffer()), IMAGE_BYTES);

  // Ordering is what makes a failure safe: bytes, then publication, then the
  // snapshot, and only then a share link.
  assert.deepEqual(
    stack.calls.map((c) => `${c.method} ${c.path.split("?")[0]}`),
    [
      "POST /api/owner/assets",
      "GET /api/owner/publications",
      "POST /api/owner/publications",
      `POST /api/owner/publications/${result.publicationId}/snapshots`,
      `GET /api/owner/publications/${result.publicationId}/links`,
      `POST /api/owner/publications/${result.publicationId}/links`,
    ],
  );
});

// --- 3. re-publishing ----------------------------------------------------

test("re-publishing keeps the URL, mints revision 2 and freezes the old snapshot", async () => {
  const stack = makeStack();
  const { post } = await seedPost(stack);

  const first = (await (await publish(stack.app, { postId: post.id })).json()) as any;

  await stack.app.request(`/api/posts/${post.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: JSON.stringify({
      title: "Quarterly report v2",
      surfaces: [{ kind: "html", html: `<p id="v2">second cut</p>` }],
    }),
  });

  const second = (await (await publish(stack.app, { postId: post.id })).json()) as any;
  assert.equal(second.publicationId, first.publicationId, "the same publication is reused");
  assert.equal(second.slug, first.slug, "the shared URL never moves");
  assert.equal(second.url, first.url);
  assert.equal(second.updated, true);
  assert.equal(second.revision, 2);
  assert.notEqual(second.snapshotId, first.snapshotId);

  // The public read now shows the new content.
  const page = await stack.publicApp.request(second.url);
  assert.match(await page.text(), /<h1>Quarterly report v2<\/h1>/);

  // …and the frozen revision 1 is intact, exactly as it was published.
  const kept = await owner(stack.publicApp, `/api/owner/snapshots/${first.snapshotId}`);
  assert.equal(kept.status, 200);
  const snapshot = (await kept.json()) as any;
  assert.equal(snapshot.revision, 1);
  assert.equal(snapshot.title, "Quarterly report");
  assert.equal(snapshot.items.length, 1);
  assert.equal(snapshot.items[0].version, 1);
  assert.equal(snapshot.items[0].surfaces.length, 3);
  assert.equal(snapshot.items[0].surfaces[0].html, `<p id="v1">first cut</p>`);
});

// --- 4. frozenItem / publishableSurfaces --------------------------------

const post = (over: Partial<Post> = {}): Post =>
  ({
    id: "post-1",
    sessionId: "session-1",
    title: "Current",
    version: 3,
    surfaces: [{ kind: "html", html: "<p>now</p>" }],
    history: [
      { version: 1, title: "One", surfaces: [{ kind: "markdown", markdown: "one" }] },
      { version: 2, title: "Two", surfaces: [{ kind: "markdown", markdown: "two" }] },
    ],
    ...over,
  }) as unknown as Post;

test("frozenItem defaults to the current version", () => {
  const item = frozenItem(post());
  assert.deepEqual(item, {
    postId: "post-1",
    title: "Current",
    version: 3,
    surfaces: [{ kind: "html", html: "<p>now</p>" }],
  });
  // Asking for the current version by number is the same thing.
  assert.deepEqual(frozenItem(post(), 3), item);
});

test("frozenItem freezes a historical version, and null for one that is gone", () => {
  assert.deepEqual(frozenItem(post(), 2), {
    postId: "post-1",
    title: "Two",
    version: 2,
    surfaces: [{ kind: "markdown", markdown: "two" }],
  });
  assert.equal(frozenItem(post(), 99), null);
  assert.equal(frozenItem(post(), 0), null);
});

test("publishableSurfaces drops the experimental trace path", () => {
  const surfaces = [
    { kind: "html", html: "<p>a</p>" },
    { kind: "trace", assetId: "t-1" },
    { kind: "json", data: 1 },
  ] as unknown as Surface[];
  assert.deepEqual(
    publishableSurfaces(surfaces).map((s) => s.kind),
    ["html", "json"],
  );
  assert.deepEqual(publishableSurfaces([]), []);
  // It applies to history too, not just the live surfaces.
  assert.deepEqual(
    frozenItem(post({ history: [{ version: 1, title: "T", surfaces }] } as Partial<Post>), 1)
      ?.surfaces.length,
    2,
  );
});

// --- 5. publishing a historical version ---------------------------------

test("publishing an explicit version freezes that revision, not the current one", async () => {
  const stack = makeStack();
  const { post: created } = await seedPost(stack);
  await stack.app.request(`/api/posts/${created.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: JSON.stringify({
      title: "Latest",
      surfaces: [{ kind: "html", html: `<p id="v2">second cut</p>` }],
    }),
  });

  const result = (await (
    await publish(stack.app, { postId: created.id, version: 1 })
  ).json()) as any;
  const snapshot = (await (
    await owner(stack.publicApp, `/api/owner/snapshots/${result.snapshotId}`)
  ).json()) as any;
  assert.equal(snapshot.items[0].version, 1);
  assert.equal(snapshot.items[0].title, "Quarterly report");
  assert.equal(snapshot.items[0].surfaces[0].html, `<p id="v1">first cut</p>`);
  assert.equal(snapshot.title, "Quarterly report", "the frozen title, not the live one");

  const missing = await publish(stack.app, { postId: created.id, version: 42 });
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: "that version is not available" });
});

// --- 6 & 7. refusals -----------------------------------------------------

test("a post with nothing publishable is refused before any destination call", async () => {
  const stack = makeStack();
  const session = await stack.privateStore.createSession({ agent: "pi", title: "traces" });
  const traceOnly = await stack.privateStore.createPost({
    sessionId: session.id,
    title: "Just a trace",
    surfaces: [{ kind: "trace", assetId: "trace-1" } as unknown as Surface],
  });
  assert.ok(traceOnly);

  const res = await publish(stack.app, { postId: traceOnly.id });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "this post has nothing publishable" });
  assert.deepEqual(stack.calls, [], "nothing was sent to the destination");
});

test("an unknown post is a 404 and touches the destination not at all", async () => {
  const stack = makeStack();
  const res = await publish(stack.app, { postId: "no-such-post" });
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "post not found" });

  const noId = await publish(stack.app, {});
  assert.equal(noId.status, 404);
  assert.deepEqual(stack.calls, []);
});

test("with no destination configured, publishing is 503 and status says so", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sideshow-nodest-"));
  const app = createApp({
    store: new JsonFileStore(join(dir, "data.json")),
    viewerHtml: "<html></html>",
    guideMarkdown: "# guide",
    setupText: "# setup",
  }) as unknown as TestApp;

  const res = await publish(app, { postId: "anything" });
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: "no publication destination" });

  const status = await app.request("/api/publish/post/anything");
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), { published: false, configured: false });
});

test("a destination failure is a 502 that never echoes the write token", async () => {
  const stack = makeStack();
  const { post: created } = await seedPost(stack);
  stack.setIntercept(() =>
    Response.json({ error: `upstream exploded with ${OWNER_TOKEN}` }, { status: 500 }),
  );

  const res = await publish(stack.app, { postId: created.id });
  assert.equal(res.status, 502);
  const body = await res.text();
  assert.equal(body.includes(OWNER_TOKEN), false, "the destination token must never come back");
  // A message carrying the credential is dropped for the generic one.
  assert.deepEqual(JSON.parse(body), { error: "destination returned 500" });

  const status = await stack.app.request(`/api/publish/post/${created.id}`);
  assert.equal(status.status, 502);
  const statusBody = await status.text();
  assert.equal(statusBody.includes(OWNER_TOKEN), false);
  assert.deepEqual(JSON.parse(statusBody), { error: "destination returned 500" });
});

test("a destination error message of its own is passed through, without the token", async () => {
  const stack = makeStack();
  const { post: created } = await seedPost(stack);
  stack.setIntercept((path) =>
    path.startsWith("/api/owner/assets")
      ? Response.json({ error: "asset store is full" }, { status: 507 })
      : null,
  );
  const res = await publish(stack.app, { postId: created.id });
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: "asset store is full" });
});

// --- 8. publication status ----------------------------------------------

test("publication status reports the URL, revision and link count once published", async () => {
  const stack = makeStack();
  const { post: created } = await seedPost(stack);

  const before = await stack.app.request(`/api/publish/post/${created.id}`);
  assert.equal(before.status, 200);
  assert.deepEqual(await before.json(), { configured: true, published: false });

  const result = (await (await publish(stack.app, { postId: created.id })).json()) as any;

  const after = (await (await stack.app.request(`/api/publish/post/${created.id}`)).json()) as any;
  assert.equal(after.configured, true);
  assert.equal(after.published, true);
  assert.equal(after.publicationId, result.publicationId);
  assert.equal(after.url, result.url);
  assert.equal(after.revision, 1);
  assert.equal(after.links, 1);
  assert.ok(after.updatedAt);
  // The status is a read of the destination; it must not carry the token.
  assert.equal(JSON.stringify(after).includes(OWNER_TOKEN), false);

  // A second revision is reflected without the URL moving.
  await stack.app.request(`/api/posts/${created.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: JSON.stringify({ surfaces: [{ kind: "html", html: "<p>again</p>" }] }),
  });
  await publish(stack.app, { postId: created.id });
  const bumped = (await (await stack.app.request(`/api/publish/post/${created.id}`)).json()) as any;
  assert.equal(bumped.revision, 2);
  assert.equal(bumped.url, result.url);
});

// --- 9. uploadItemAssets -------------------------------------------------

test("uploadItemAssets skips an asset the private store no longer holds", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sideshow-upload-"));
  const store = new JsonFileStore(join(dir, "data.json"));
  const session = await store.createSession({ agent: "pi", title: "work" });
  const asset = await store.putAsset({
    sessionId: session.id,
    kind: "image",
    contentType: "image/png",
    data: IMAGE_BYTES,
  });
  assert.ok(asset);

  const uploads: unknown[] = [];
  const client = new DestinationClient({ origin: DEST_ORIGIN, token: OWNER_TOKEN }, (async (
    _url: string,
    init: RequestInit = {},
  ) => {
    uploads.push(JSON.parse(String(init.body)));
    return Response.json({ id: "stored" }, { status: 201 });
  }) as unknown as typeof fetch);

  const items: SnapshotItem[] = [
    {
      postId: "p",
      title: "t",
      version: 1,
      surfaces: [
        { kind: "image", assetId: asset.id },
        // An evicted or never-uploaded reference must not break publishing.
        { kind: "image", assetId: "evicted-asset-id" },
        // The same asset twice is uploaded once.
        { kind: "image", assetId: asset.id },
        { kind: "html", html: "<p>no assets here</p>" },
      ],
    },
  ];

  assert.deepEqual(await uploadItemAssets(store, client, items), [asset.id]);
  assert.equal(uploads.length, 1);
  assert.deepEqual(uploads[0], {
    data: Buffer.from(IMAGE_BYTES).toString("base64"),
    contentType: "image/png",
    kind: "image",
  });
});

test("uploadItemAssets normalises a trace asset to a plain file upload", async () => {
  const traceAsset: Asset = {
    id: "trace-asset",
    sessionId: "s",
    kind: "trace",
    contentType: "application/json",
    filename: "trace.json",
    byteLength: 2,
    data: new Uint8Array([123, 125]),
    createdAt: new Date().toISOString(),
    lastAccessedAt: new Date().toISOString(),
  } as unknown as Asset;
  const store = { getAsset: async () => traceAsset } as unknown as Store;

  const uploads: any[] = [];
  const client = new DestinationClient({ origin: DEST_ORIGIN, token: OWNER_TOKEN }, (async (
    _url: string,
    init: RequestInit = {},
  ) => {
    uploads.push(JSON.parse(String(init.body)));
    return Response.json({ id: traceAsset.id }, { status: 201 });
  }) as unknown as typeof fetch);

  const uploaded = await uploadItemAssets(store, client, [
    {
      postId: "p",
      title: "t",
      version: 1,
      surfaces: [{ kind: "trace", assetId: "trace-asset" } as unknown as Surface],
    },
  ]);
  assert.deepEqual(uploaded, ["trace-asset"]);
  assert.equal(uploads[0].kind, "file");
  assert.equal(uploads[0].filename, "trace.json");
});

// --- 10. atomicity -------------------------------------------------------

test("a snapshot failure leaves nothing reachable behind", async () => {
  const stack = makeStack();
  const { post: created } = await seedPost(stack);

  stack.setIntercept((path, init) =>
    init.method === "POST" && path.endsWith("/snapshots")
      ? Response.json({ error: "snapshot write failed" }, { status: 500 })
      : null,
  );

  const res = await publish(stack.app, { postId: created.id });
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: "snapshot write failed" });
  stack.setIntercept(null);

  // No share link was ever created — the publication cannot be reached at all.
  const links = await stack.publicStore.publications!.listShareLinks();
  assert.deepEqual(links, []);

  const publications = (await (
    await owner(stack.publicApp, "/api/owner/publications")
  ).json()) as any[];
  for (const publication of publications) {
    assert.equal(
      publication.currentSnapshotId,
      null,
      "a half-built publication must have no live revision",
    );
    const detail = (await (
      await owner(stack.publicApp, `/api/owner/publications/${publication.id}`)
    ).json()) as any;
    assert.deepEqual(detail.links, [], "and no way in");
    assert.deepEqual(detail.snapshots, []);

    // Even if a link is minted afterwards, it resolves to nothing.
    const link = await stack.publicStore.publications!.createShareLink({
      publicationId: publication.id,
      slug: `probe-${publication.id.slice(0, 8)}`,
    });
    assert.ok(link);
    const page = await stack.publicApp.request(`${DEST_ORIGIN}/v/${link.slug}`);
    assert.equal(page.status, 404);
    assert.equal((await stack.publicApp.request(`${DEST_ORIGIN}/api/v/${link.slug}`)).status, 404);
  }

  // The private post is untouched and still publishable once the destination
  // recovers.
  const retry = (await (await publish(stack.app, { postId: created.id })).json()) as any;
  assert.equal(retry.revision, 1, "the failed attempt consumed no revision");
  assert.equal((await stack.publicApp.request(retry.url)).status, 200);
});
