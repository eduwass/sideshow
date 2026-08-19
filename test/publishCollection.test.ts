import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../server/app.ts";
import {
  collectionPreview,
  frozenCollection,
  sessionCollectionTitle,
} from "../server/publishFlow.ts";
import { JsonFileStore } from "../server/storage.ts";
import type { Post, Session, Surface } from "../server/types.ts";
import {
  DEST_ORIGIN,
  IMAGE_BYTES,
  json,
  makeStack,
  owner,
  OWNER_TOKEN,
  patch,
  type Stack,
  type TestApp,
} from "./publishStack.ts";

// Publishing a whole session as one reviewed collection (issue #5). The
// contract under test is the confirmation loop: preview the session, confirm a
// subset, and get exactly that subset frozen behind one stable URL.

const publishSession = (app: TestApp, body: unknown) =>
  app.request("/api/publish/session", json(body));

const preview = async (stack: Stack, sessionId: string) => {
  const res = await stack.app.request(`/api/publish/session/${sessionId}/preview`);
  return { status: res.status, body: (await res.json()) as any };
};

/** Create the posts, in the order given, and return their ids in that order. */
async function addPosts(
  stack: Stack,
  sessionId: string,
  posts: { title: string; surfaces: unknown[] }[],
) {
  const ids: string[] = [];
  for (const spec of posts) {
    const res = await stack.app.request(
      "/api/posts",
      json({ session: sessionId, title: spec.title, surfaces: spec.surfaces }),
    );
    assert.equal(res.status, 201, `seeding "${spec.title}" failed`);
    ids.push(((await res.json()) as { id: string }).id);
  }
  return ids;
}

/** Create a session and its posts, in the order given. */
async function seedSession(
  stack: Stack,
  posts: { title: string; surfaces: unknown[] }[],
  session: { agent?: string; title?: string } = { agent: "pi", title: "Refactor sweep" },
) {
  const created = await stack.privateStore.createSession({
    agent: session.agent ?? "pi",
    title: session.title,
  });
  return { session: created, ids: await addPosts(stack, created.id, posts) };
}

/** One image asset, uploaded into a fresh session of its own. */
async function seedImageSession(stack: Stack) {
  const created = await stack.privateStore.createSession({ agent: "pi", title: "Refactor sweep" });
  const asset = await stack.privateStore.putAsset({
    sessionId: created.id,
    kind: "image",
    contentType: "image/png",
    filename: "shot.png",
    data: IMAGE_BYTES,
  });
  assert.ok(asset);
  return { session: created, asset };
}

const html = (marker: string) => ({ kind: "html", html: `<p id="${marker}">${marker}</p>` });

// --- 1. the preview defaults to the whole session, in order ---------------

test("the preview lists every current post of the session, in session order", async () => {
  const stack = makeStack();
  const { session, ids } = await seedSession(stack, [
    { title: "One", surfaces: [html("m-one")] },
    { title: "Two", surfaces: [{ kind: "markdown", markdown: "# two" }] },
    { title: "Three", surfaces: [html("m-three"), { kind: "json", data: { a: 1 } }] },
  ]);

  const { status, body } = await preview(stack, session.id);
  assert.equal(status, 200);
  assert.equal(body.sessionId, session.id);
  assert.equal(body.title, "Refactor sweep");
  assert.deepEqual(
    body.posts.map((p: any) => p.postId),
    ids,
    "the default selection is the session's own order",
  );
  assert.deepEqual(
    body.posts.map((p: any) => p.title),
    ["One", "Two", "Three"],
  );
  for (const post of body.posts) {
    assert.equal(post.version, 1);
    assert.equal(post.publishable, true);
    assert.ok(post.updatedAt, "each entry carries when it last changed");
    assert.ok(Array.isArray(post.surfaceKinds));
  }
  assert.deepEqual(body.posts[2].surfaceKinds, ["html", "json"]);

  // Metadata only: the confirmation view never ships the bodies it lists.
  const serialised = JSON.stringify(body);
  assert.equal(serialised.includes("m-one"), false, "html markup leaked into the preview");
  assert.equal(serialised.includes("m-three"), false);
  assert.equal(serialised.includes("# two"), false);
});

test("a post with nothing but a trace reports itself unpublishable", async () => {
  const stack = makeStack();
  const session = await stack.privateStore.createSession({ agent: "pi", title: "traces" });
  const traceOnly = await stack.privateStore.createPost({
    sessionId: session.id,
    title: "Just a trace",
    surfaces: [{ kind: "trace", assetId: "trace-1" } as unknown as Surface],
  });
  assert.ok(traceOnly);

  const { body } = await preview(stack, session.id);
  assert.equal(body.posts.length, 1);
  assert.equal(body.posts[0].postId, traceOnly.id);
  assert.deepEqual(body.posts[0].surfaceKinds, ["trace"]);
  assert.equal(body.posts[0].publishable, false);
});

test("previewing a session that does not exist is a 404", async () => {
  const stack = makeStack();
  const { status, body } = await preview(stack, "no-such-session");
  assert.equal(status, 404);
  assert.deepEqual(body, { error: "session not found" });
  assert.deepEqual(stack.calls, [], "nothing was sent to the destination");
});

// --- 2. confirmation is mandatory ----------------------------------------

test("publishing a session without a confirmed selection is refused", async () => {
  const stack = makeStack();
  const { session } = await seedSession(stack, [{ title: "One", surfaces: [html("m-one")] }]);

  for (const body of [
    { sessionId: session.id },
    { sessionId: session.id, postIds: [] },
    { sessionId: session.id, postIds: "all" },
    { sessionId: session.id, postIds: {} },
    // A list of nothing usable is still no confirmation.
    { sessionId: session.id, postIds: [7, null] },
  ]) {
    const res = await publishSession(stack.app, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.deepEqual(await res.json(), { error: "confirm which posts to include first" });
  }
  assert.deepEqual(stack.calls, [], "an unconfirmed publish reaches the destination not at all");

  const unknown = await publishSession(stack.app, { postIds: [session.id] });
  assert.equal(unknown.status, 404);
  assert.deepEqual(await unknown.json(), { error: "session not found" });
  assert.deepEqual(stack.calls, []);
});

test("a post from another session cannot be smuggled into a collection", async () => {
  const stack = makeStack();
  const mine = await seedSession(stack, [{ title: "Mine", surfaces: [html("m-mine")] }]);
  const theirs = await seedSession(
    stack,
    [{ title: "Private notes", surfaces: [html("m-secret")] }],
    { agent: "pi", title: "Other work" },
  );

  const res = await publishSession(stack.app, {
    sessionId: mine.session.id,
    postIds: [mine.ids[0], theirs.ids[0]],
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "that post is not in this session" });
  assert.deepEqual(stack.calls, [], "the foreign post never reached the public service");

  // And nothing at all exists on the public side to have leaked it.
  const publications = (await (
    await owner(stack.publicApp, "/api/owner/publications")
  ).json()) as any[];
  assert.deepEqual(publications, []);
});

test("a selection with nothing publishable in it is refused", async () => {
  const stack = makeStack();
  const session = await stack.privateStore.createSession({ agent: "pi", title: "traces" });
  const traceOnly = await stack.privateStore.createPost({
    sessionId: session.id,
    title: "Just a trace",
    surfaces: [{ kind: "trace", assetId: "trace-1" } as unknown as Surface],
  });
  assert.ok(traceOnly);

  const res = await publishSession(stack.app, {
    sessionId: session.id,
    postIds: [traceOnly.id],
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "nothing publishable in that selection" });
  assert.deepEqual(stack.calls, []);
});

// --- 3. narrowing the selection ------------------------------------------

test("confirming a subset publishes exactly that subset, in session order", async () => {
  const stack = makeStack();
  const { session, ids } = await seedSession(stack, [
    { title: "Kickoff", surfaces: [html("m-kickoff")] },
    { title: "Accidental content", surfaces: [html("m-accident")] },
    { title: "Findings", surfaces: [html("m-findings")] },
    { title: "Scratch pad", surfaces: [html("m-scratch")] },
  ]);

  // Confirmed out of order on purpose: the session's order is what publishes.
  const res = await publishSession(stack.app, {
    sessionId: session.id,
    postIds: [ids[2], ids[0]],
  });
  assert.equal(res.status, 201);
  const result = (await res.json()) as any;
  assert.equal(result.revision, 1);
  assert.equal(result.updated, false);

  const snapshot = (await (
    await owner(stack.publicApp, `/api/owner/snapshots/${result.snapshotId}`)
  ).json()) as any;
  assert.deepEqual(
    snapshot.items.map((i: any) => i.postId),
    [ids[0], ids[2]],
  );
  assert.deepEqual(
    snapshot.items.map((i: any) => i.title),
    ["Kickoff", "Findings"],
  );
  const frozen = JSON.stringify(snapshot);
  for (const omitted of ["Accidental content", "m-accident", "Scratch pad", "m-scratch"]) {
    assert.equal(frozen.includes(omitted), false, `${omitted} was published anyway`);
  }

  // …and the page a reader sees mentions the omitted posts nowhere either.
  const page = await stack.publicApp.request(result.url);
  assert.equal(page.status, 200);
  const body = await page.text();
  assert.match(body, /Kickoff/);
  assert.match(body, /Findings/);
  for (const omitted of ["Accidental content", "m-accident", "Scratch pad", "m-scratch"]) {
    assert.equal(body.includes(omitted), false, `${omitted} is visible to the reader`);
  }
});

// --- 4. typed surfaces stay typed ----------------------------------------

const MIXED = [
  { title: "Html", surfaces: [html("m-html")] },
  { title: "Markdown", surfaces: [{ kind: "markdown", markdown: "# m-markdown" }] },
  { title: "Code", surfaces: [{ kind: "code", code: "const mCode = 1;", language: "ts" }] },
  {
    title: "Diff",
    surfaces: [{ kind: "diff", patch: "--- a\n+++ b\n@@ -1 +1 @@\n-m-diff\n+x\n" }],
  },
  { title: "Terminal", surfaces: [{ kind: "terminal", text: "$ m-terminal" }] },
  { title: "Mermaid", surfaces: [{ kind: "mermaid", mermaid: "graph TD; mMermaid-->B;" }] },
  { title: "Json", surfaces: [{ kind: "json", data: { marker: "m-json" } }] },
];

test("every surface kind survives a collection with its own item and kind", async () => {
  const stack = makeStack();
  const { session, asset } = await seedImageSession(stack);
  const ids = await addPosts(stack, session.id, [
    ...MIXED,
    { title: "Image", surfaces: [{ kind: "image", assetId: asset.id, alt: "a shot" }] },
  ]);

  const result = (await (
    await publishSession(stack.app, { sessionId: session.id, postIds: ids })
  ).json()) as any;

  const snapshot = (await (
    await owner(stack.publicApp, `/api/owner/snapshots/${result.snapshotId}`)
  ).json()) as any;
  // One item per post — item boundaries survive, nothing is merged into one
  // flattened surface list.
  assert.equal(snapshot.items.length, ids.length);
  assert.deepEqual(
    snapshot.items.map((i: any) => i.surfaces.length),
    ids.map(() => 1),
  );
  assert.deepEqual(
    snapshot.items.map((i: any) => i.surfaces[0].kind),
    ["html", "markdown", "code", "diff", "terminal", "mermaid", "json", "image"],
  );
  // Typed content is frozen as authored, not re-rendered into markup.
  assert.equal(snapshot.items[0].surfaces[0].html, `<p id="m-html">m-html</p>`);
  assert.equal(snapshot.items[1].surfaces[0].markdown, "# m-markdown");
  assert.equal(snapshot.items[2].surfaces[0].code, "const mCode = 1;");
  assert.equal(snapshot.items[2].surfaces[0].language, "ts");
  assert.match(snapshot.items[3].surfaces[0].patch, /m-diff/);
  assert.equal(snapshot.items[4].surfaces[0].text, "$ m-terminal");
  assert.equal(snapshot.items[5].surfaces[0].mermaid, "graph TD; mMermaid-->B;");
  assert.deepEqual(snapshot.items[6].surfaces[0].data, { marker: "m-json" });
  assert.equal(snapshot.items[7].surfaces[0].assetId, asset.id);

  // The reader's page holds no agent markup at all: every rich surface is an
  // opaque-origin iframe pointing back at this origin.
  const page = await stack.publicApp.request(result.url);
  const body = await page.text();
  for (const marker of ["m-html", "m-markdown", "mCode", "m-diff", "m-terminal", "mMermaid"]) {
    assert.equal(body.includes(marker), false, `${marker} leaked into the trusted page`);
  }
  assert.equal(body.includes("allow-same-origin"), false);
  for (const item of [0, 1, 2, 3, 4, 5]) {
    assert.ok(
      body.includes(`src="/api/v/${result.slug}/s/${item}/0"`),
      `item ${item} is not an iframe`,
    );
  }

  // Each of those documents carries the sandbox CSP that makes serving agent
  // markup from the public origin safe.
  for (const item of [0, 3, 5]) {
    const doc = await stack.publicApp.request(`${DEST_ORIGIN}/api/v/${result.slug}/s/${item}/0`);
    assert.equal(doc.status, 200);
    assert.equal(doc.headers.get("content-security-policy"), "sandbox allow-scripts");
    assert.equal(doc.headers.get("x-content-type-options"), "nosniff");
  }
});

// --- 5. the snapshot is frozen -------------------------------------------

test("later edits never reach a published collection, and its assets stay served", async () => {
  const stack = makeStack();
  const { session, asset } = await seedImageSession(stack);
  const ids = await addPosts(stack, session.id, [
    { title: "Report", surfaces: [html("m-frozen"), { kind: "image", assetId: asset.id }] },
    { title: "Notes", surfaces: [{ kind: "markdown", markdown: "notes" }] },
  ]);

  const result = (await (
    await publishSession(stack.app, { sessionId: session.id, postIds: ids })
  ).json()) as any;

  // The published bytes are served from the public workspace.
  const served = await stack.publicApp.request(`${DEST_ORIGIN}/a/${asset.id}`);
  assert.equal(served.status, 200);
  assert.deepEqual(new Uint8Array(await served.arrayBuffer()), IMAGE_BYTES);

  // Now churn the private post: three more versions, and it stops referencing
  // the image entirely.
  for (const n of [2, 3, 4]) {
    const res = await stack.app.request(
      `/api/posts/${ids[0]}`,
      patch({
        title: `Report v${n}`,
        surfaces: [{ kind: "html", html: `<p id="m-v${n}">v${n}</p>` }],
      }),
    );
    assert.equal(res.status, 200);
  }
  const live = (await (await stack.app.request(`/api/posts/${ids[0]}`)).json()) as any;
  assert.equal(live.version, 4);

  const snapshot = (await (
    await owner(stack.publicApp, `/api/owner/snapshots/${result.snapshotId}`)
  ).json()) as any;
  assert.equal(snapshot.items[0].title, "Report", "the frozen title, not the live one");
  assert.equal(snapshot.items[0].version, 1);
  assert.deepEqual(
    snapshot.items[0].surfaces.map((s: any) => s.kind),
    ["html", "image"],
  );
  assert.equal(snapshot.items[0].surfaces[0].html, `<p id="m-frozen">m-frozen</p>`);
  assert.equal(JSON.stringify(snapshot).includes("m-v4"), false);

  // The asset the snapshot still points at is pinned by the publication, not
  // by the private post that has moved on.
  const stillServed = await stack.publicApp.request(`${DEST_ORIGIN}/a/${asset.id}`);
  assert.equal(stillServed.status, 200);
  assert.deepEqual(new Uint8Array(await stillServed.arrayBuffer()), IMAGE_BYTES);
  const page = await stack.publicApp.request(result.url);
  assert.match(await page.text(), new RegExp(`/a/${asset.id}`));
});

// --- 6. re-publishing a session ------------------------------------------

test("re-publishing a session updates the same collection at the same URL", async () => {
  const stack = makeStack();
  const { session, ids } = await seedSession(stack, [
    { title: "Kickoff", surfaces: [html("m-kickoff")] },
    { title: "Findings", surfaces: [html("m-findings")] },
  ]);

  const first = (await (
    await publishSession(stack.app, { sessionId: session.id, postIds: [ids[0]] })
  ).json()) as any;
  assert.equal(first.updated, false);
  assert.equal(first.revision, 1);

  // The review widens to both posts.
  const second = (await (
    await publishSession(stack.app, { sessionId: session.id, postIds: ids })
  ).json()) as any;
  assert.equal(second.publicationId, first.publicationId, "the same publication is reused");
  assert.equal(second.slug, first.slug, "the shared URL never moves");
  assert.equal(second.url, first.url);
  assert.equal(second.updated, true);
  assert.equal(second.revision, 2);
  assert.notEqual(second.snapshotId, first.snapshotId);

  const detail = (await (
    await owner(stack.publicApp, `/api/owner/publications/${first.publicationId}`)
  ).json()) as any;
  assert.equal(detail.publication.kind, "collection");
  assert.equal(detail.publication.originSessionId, session.id);
  assert.equal(detail.publication.originPostId, null);

  // Revision 1 is still fetchable through the owner API, exactly as published.
  const kept = (await (
    await owner(stack.publicApp, `/api/owner/snapshots/${first.snapshotId}`)
  ).json()) as any;
  assert.equal(kept.revision, 1);
  assert.deepEqual(
    kept.items.map((i: any) => i.postId),
    [ids[0]],
  );
  const page = await stack.publicApp.request(second.url);
  assert.match(await page.text(), /Findings/);
});

test("a session collection and a single-post publication are two different publications", async () => {
  const stack = makeStack();
  const { session, ids } = await seedSession(stack, [
    { title: "Kickoff", surfaces: [html("m-kickoff")] },
  ]);

  const collection = (await (
    await publishSession(stack.app, { sessionId: session.id, postIds: ids })
  ).json()) as any;
  const single = (await (
    await stack.app.request("/api/publish/post", json({ postId: ids[0] }))
  ).json()) as any;

  // Both are looked up by origin, so they must not be mistaken for each other.
  assert.notEqual(single.publicationId, collection.publicationId);
  assert.notEqual(single.slug, collection.slug);
  assert.equal(single.revision, 1, "the collection's revision is not shared");
  assert.equal(single.updated, false);

  const publications = (await (
    await owner(stack.publicApp, "/api/owner/publications")
  ).json()) as any[];
  assert.deepEqual(publications.map((p) => p.kind).sort(), ["collection", "post"]);

  // Publishing one again leaves the other's revision alone.
  const again = (await (
    await publishSession(stack.app, { sessionId: session.id, postIds: ids })
  ).json()) as any;
  assert.equal(again.publicationId, collection.publicationId);
  assert.equal(again.revision, 2);
  const postStatus = (await (await stack.app.request(`/api/publish/post/${ids[0]}`)).json()) as any;
  assert.equal(postStatus.publicationId, single.publicationId);
  assert.equal(postStatus.revision, 1);
});

// --- 7. session publication status ---------------------------------------

test("session publication status reports the URL, revision and link count", async () => {
  const stack = makeStack();
  const { session, ids } = await seedSession(stack, [
    { title: "Kickoff", surfaces: [html("m-kickoff")] },
  ]);

  const before = await stack.app.request(`/api/publish/session/${session.id}`);
  assert.equal(before.status, 200);
  assert.deepEqual(await before.json(), { configured: true, published: false });

  const result = (await (
    await publishSession(stack.app, { sessionId: session.id, postIds: ids })
  ).json()) as any;

  const after = (await (
    await stack.app.request(`/api/publish/session/${session.id}`)
  ).json()) as any;
  assert.equal(after.configured, true);
  assert.equal(after.published, true);
  assert.equal(after.publicationId, result.publicationId);
  assert.equal(after.url, result.url);
  assert.equal(after.revision, 1);
  assert.equal(after.links, 1);
  assert.ok(after.updatedAt);
  assert.equal(JSON.stringify(after).includes(OWNER_TOKEN), false);

  await publishSession(stack.app, { sessionId: session.id, postIds: ids });
  const bumped = (await (
    await stack.app.request(`/api/publish/session/${session.id}`)
  ).json()) as any;
  assert.equal(bumped.revision, 2);
  assert.equal(bumped.url, result.url);
});

// --- 8. failure paths ----------------------------------------------------

test("with no destination configured, publishing a session is 503 and status says so", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sideshow-nodest-collection-"));
  const app = createApp({
    store: new JsonFileStore(join(dir, "data.json")),
    viewerHtml: "<html></html>",
    guideMarkdown: "# guide",
    setupText: "# setup",
  }) as unknown as TestApp;

  const res = await publishSession(app, { sessionId: "anything", postIds: ["a"] });
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: "no publication destination" });

  const status = await app.request("/api/publish/session/anything");
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), { published: false, configured: false });
});

test("a destination failure while publishing a session never echoes the write token", async () => {
  const stack = makeStack();
  const { session, ids } = await seedSession(stack, [
    { title: "Kickoff", surfaces: [html("m-kickoff")] },
  ]);
  stack.setIntercept(() =>
    Response.json({ error: `upstream exploded with ${OWNER_TOKEN}` }, { status: 500 }),
  );

  const res = await publishSession(stack.app, { sessionId: session.id, postIds: ids });
  assert.equal(res.status, 502);
  const body = await res.text();
  assert.equal(body.includes(OWNER_TOKEN), false, "the destination token must never come back");
  assert.deepEqual(JSON.parse(body), { error: "destination returned 500" });

  const status = await stack.app.request(`/api/publish/session/${session.id}`);
  assert.equal(status.status, 502);
  const statusBody = await status.text();
  assert.equal(statusBody.includes(OWNER_TOKEN), false);
  assert.deepEqual(JSON.parse(statusBody), { error: "destination returned 500" });
});

// --- 9. the pure pieces ---------------------------------------------------

const session = (over: Partial<Session> = {}): Session =>
  ({ id: "session-1", agent: "pi", title: "Refactor sweep", ...over }) as unknown as Session;

const postOf = (over: Partial<Post> = {}): Post =>
  ({
    id: "post-1",
    sessionId: "session-1",
    title: "One",
    version: 2,
    updatedAt: "2026-01-01T00:00:00.000Z",
    surfaces: [{ kind: "html", html: "<p>one</p>" }],
    history: [],
    ...over,
  }) as unknown as Post;

test("sessionCollectionTitle prefers the session title, then the agent, then a default", () => {
  assert.equal(sessionCollectionTitle(session()), "Refactor sweep");
  assert.equal(sessionCollectionTitle(session({ title: null })), "pi session");
  assert.equal(sessionCollectionTitle(session({ title: "" })), "pi session");
  assert.equal(sessionCollectionTitle(session({ title: null, agent: "" })), "Session");
});

test("collectionPreview describes every post without carrying its body", () => {
  const result = collectionPreview(session(), [
    postOf(),
    postOf({
      id: "post-2",
      title: "Two",
      version: 5,
      updatedAt: "2026-01-02T00:00:00.000Z",
      surfaces: [
        { kind: "trace", assetId: "t-1" },
        { kind: "markdown", markdown: "two" },
      ] as unknown as Surface[],
    }),
    postOf({
      id: "post-3",
      title: "Three",
      surfaces: [{ kind: "trace", assetId: "t-2" }] as unknown as Surface[],
    }),
  ]);
  assert.deepEqual(result, {
    sessionId: "session-1",
    title: "Refactor sweep",
    posts: [
      {
        postId: "post-1",
        title: "One",
        version: 2,
        surfaceKinds: ["html"],
        updatedAt: "2026-01-01T00:00:00.000Z",
        publishable: true,
      },
      {
        postId: "post-2",
        title: "Two",
        version: 5,
        // The kinds are named, including the ones that will be dropped…
        surfaceKinds: ["trace", "markdown"],
        updatedAt: "2026-01-02T00:00:00.000Z",
        // …and something publishable remains once they are.
        publishable: true,
      },
      {
        postId: "post-3",
        title: "Three",
        version: 2,
        surfaceKinds: ["trace"],
        updatedAt: "2026-01-01T00:00:00.000Z",
        publishable: false,
      },
    ],
  });
  assert.deepEqual(collectionPreview(session(), []).posts, []);
});

test("frozenCollection freezes the confirmed subset in session order", () => {
  const posts = [
    postOf({ id: "a", title: "A" }),
    postOf({ id: "b", title: "B" }),
    postOf({ id: "c", title: "C" }),
  ];
  // Session order wins over the order the ids arrived in.
  assert.deepEqual(
    frozenCollection(posts, ["c", "a"]).map((i) => i.postId),
    ["a", "c"],
  );
  // Unknown ids are ignored rather than fabricating an item.
  assert.deepEqual(
    frozenCollection(posts, ["b", "ghost"]).map((i) => i.postId),
    ["b"],
  );
  assert.deepEqual(frozenCollection(posts, []), []);

  // A post whose only surface is dropped contributes no item at all.
  const traceOnly = postOf({
    id: "t",
    surfaces: [{ kind: "trace", assetId: "t-1" }] as unknown as Surface[],
  });
  assert.deepEqual(frozenCollection([...posts, traceOnly], ["t", "a"]), [
    { postId: "a", title: "A", version: 2, surfaces: [{ kind: "html", html: "<p>one</p>" }] },
  ]);
});
