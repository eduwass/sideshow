import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { hashPassword } from "../server/passwords.ts";
import {
  createPublicApp,
  MAX_FEEDBACK_QUOTE_LENGTH,
  MAX_PUBLIC_BODY_BYTES,
  normalizeAnchor,
  publicSurfaceView,
} from "../server/publicApp.ts";
import type { ShareLink, Snapshot, SnapshotItem } from "../server/publicationTypes.ts";
import { createSqliteStorage } from "../server/sqliteStorage.ts";
import { SqlStore } from "../server/sqlStore.ts";
import { JsonFileStore } from "../server/storage.ts";
import type { Surface } from "../server/types.ts";

const OWNER_TOKEN = "owner-token-value";
const VISITOR_SECRET = "visitor-secret";
const PASSWORD = "s3cret-passphrase";
const RECIPIENT = "Acme Corp — Dana";
const ORIGIN = "http://pub.example";

// scrypt is deliberately expensive; hash the one test password once.
let passwordHashPromise: Promise<string> | undefined;
const testPasswordHash = () => (passwordHashPromise ??= hashPassword(PASSWORD));

// Surface indices inside the seeded snapshot item.
const HTML = 0;
const MARKDOWN = 1;
const CODE = 2;
const TERMINAL = 3;
const DIFF = 4;
const MERMAID = 5;
const IMAGE = 6;
const JSON_ = 7;

const HTML_MARKUP = `<p id="seeded-markup">hello from the publication</p>`;
const ASSET_BYTES = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);

async function seed(opts: { withPassword?: boolean; trackOpens?: boolean } = {}) {
  const store = new SqlStore(createSqliteStorage());
  const publications = store.publications;
  assert.ok(publications, "SqlStore must support publications");

  // A private-side session and comment, so the tests can prove the public
  // runtime never writes into the trusted comment→agent stream.
  const session = await store.createSession({ agent: "pi", title: "private work" });
  const asset = await store.putAsset({
    sessionId: session.id,
    kind: "image",
    contentType: "image/png",
    data: ASSET_BYTES,
  });
  assert.ok(asset);
  const orphanAsset = await store.putAsset({
    sessionId: session.id,
    kind: "image",
    contentType: "image/png",
    data: new Uint8Array([9, 9, 9]),
  });
  assert.ok(orphanAsset);

  const surfaces: Surface[] = [
    { kind: "html", html: HTML_MARKUP },
    { kind: "markdown", markdown: "# Heading\n\nSome **prose**." },
    { kind: "code", code: "const x = 1;\n", language: "ts" },
    { kind: "terminal", text: "$ npm test\nok\n" },
    {
      kind: "diff",
      patch: [
        "diff --git a/a.txt b/a.txt",
        "--- a/a.txt",
        "+++ b/a.txt",
        "@@ -1 +1 @@",
        "-old",
        "+new",
        "",
      ].join("\n"),
    },
    { kind: "mermaid", mermaid: "graph TD; A-->B;" },
    { kind: "image", assetId: asset.id, alt: "a png", caption: "figure 1" },
    { kind: "json", data: { answer: 42 } },
  ];
  const item: SnapshotItem = { postId: "post-1", title: "Frozen post", version: 3, surfaces };

  const publication = await publications.createPublication({
    kind: "post",
    title: "Quarterly report",
    identity: { name: "Edu" },
  });
  const snapshot = await publications.createSnapshot({
    publicationId: publication.id,
    items: [item],
  });
  assert.ok(snapshot);
  const link = await publications.createShareLink({
    publicationId: publication.id,
    slug: "demo-slug",
    custom: true,
    recipientLabel: RECIPIENT,
    expiresAt: "2099-01-01T00:00:00.000Z",
    trackOpens: opts.trackOpens !== false,
    ...(opts.withPassword && { passwordHash: await testPasswordHash() }),
  });
  assert.ok(link);

  const app = createPublicApp({ store, ownerToken: OWNER_TOKEN, visitorSecret: VISITOR_SECRET });
  return {
    store,
    publications,
    app,
    session,
    asset,
    orphanAsset,
    publication,
    snapshot: snapshot as Snapshot,
    link: link as ShareLink,
  };
}

// The public app is a plain Hono instance; `request` is its test entrypoint.
type TestApp = { request: (u: string, i?: RequestInit) => Response | Promise<Response> };

const get = (app: TestApp, path: string, headers?: Record<string, string>) =>
  app.request(`${ORIGIN}${path}`, { headers });

const post = (app: TestApp, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  app.request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });

// --- 1. route isolation -------------------------------------------------

test("no private-runtime route exists on the public app", async () => {
  const { app } = await seed();
  const routes: [string, string][] = [
    ["GET", "/"],
    ["GET", "/connect"],
    ["GET", "/guide"],
    ["GET", "/setup"],
    ["GET", "/agent-howto"],
    ["GET", "/session/x"],
    ["GET", "/mcp"],
    ["POST", "/mcp"],
    ["GET", "/api/sessions"],
    ["POST", "/api/sessions"],
    ["GET", "/api/sessions/x"],
    ["PATCH", "/api/sessions/x"],
    ["DELETE", "/api/sessions/x"],
    ["GET", "/api/posts"],
    ["POST", "/api/posts"],
    ["GET", "/api/posts/recent"],
    ["GET", "/api/posts/x"],
    ["PATCH", "/api/posts/x"],
    ["DELETE", "/api/posts/x"],
    ["GET", "/api/surfaces"],
    ["POST", "/api/surfaces"],
    ["GET", "/api/snippets"],
    ["POST", "/api/snippets"],
    ["GET", "/api/comments"],
    ["POST", "/api/comments"],
    ["GET", "/api/events"],
    ["GET", "/api/theme"],
    ["POST", "/api/theme"],
    ["GET", "/api/kits"],
    ["GET", "/api/version"],
    ["GET", "/api/assets"],
    ["POST", "/api/assets"],
    ["POST", "/api/test-post"],
    ["GET", "/s/x"],
    ["GET", "/p/x"],
    ["POST", "/api/publish/destination"],
  ];
  for (const [method, path] of routes) {
    const res = await app.request(`${ORIGIN}${path}`, {
      method,
      ...(method !== "GET" && {
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    });
    assert.equal(res.status, 404, `${method} ${path}`);
  }
});

// --- 2. owner auth ------------------------------------------------------

test("owner routes demand the exact bearer token and leak nothing on refusal", async () => {
  const { app, publication } = await seed();
  for (const path of ["/api/owner/health", "/api/owner/publications"]) {
    for (const headers of [
      undefined,
      { authorization: "Bearer wrong-token-val" }, // same length, wrong bytes
      { authorization: "Bearer short" }, // different length
      { authorization: OWNER_TOKEN }, // no scheme
    ]) {
      const res = await get(app, path, headers);
      assert.equal(res.status, 401, `${path} ${JSON.stringify(headers)}`);
      assert.deepEqual(await res.json(), { error: "unauthorized" });
    }
    const ok = await get(app, path, { authorization: `Bearer ${OWNER_TOKEN}` });
    assert.equal(ok.status, 200, path);
  }
  const health = await (
    await get(app, "/api/owner/health", {
      authorization: `Bearer ${OWNER_TOKEN}`,
    })
  ).json();
  assert.deepEqual(health, { ok: true, role: "public" });
  const list = (await (
    await get(app, "/api/owner/publications", {
      authorization: `Bearer ${OWNER_TOKEN}`,
    })
  ).json()) as { id: string }[];
  assert.deepEqual(
    list.map((p) => p.id),
    [publication.id],
  );
});

// --- 3. public read -----------------------------------------------------

test("GET /api/v/:slug returns the narrow public payload and nothing more", async () => {
  const { app, snapshot, link, publication, asset } = await seed();
  const res = await get(app, "/api/v/demo-slug");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "private, no-store");
  const body = (await res.json()) as any;

  assert.equal(body.title, "Quarterly report");
  assert.deepEqual(body.identity, { name: "Edu" });
  assert.deepEqual(body.link, { slug: "demo-slug", trackOpens: true });
  assert.equal(body.snapshot.id, snapshot.id);
  assert.equal(body.snapshot.revision, 1);
  assert.equal(body.snapshot.items.length, 1);
  assert.equal(body.snapshot.items[0].title, "Frozen post");
  assert.deepEqual(body.snapshot.items[0].surfaces[HTML], { kind: "html", sandboxed: true });
  assert.deepEqual(body.snapshot.items[0].surfaces[IMAGE], {
    kind: "image",
    sandboxed: false,
    assetId: asset.id,
    alt: "a png",
    caption: "figure 1",
  });
  assert.deepEqual(body.snapshot.items[0].surfaces[JSON_], {
    kind: "json",
    sandboxed: false,
    data: { answer: 42 },
  });

  // Owner-side context must never cross to a share-link holder.
  const wire = JSON.stringify(body);
  for (const secret of [
    RECIPIENT,
    link.passwordHash ?? "no-password",
    publication.id,
    link.id,
    "2099-01-01T00:00:00.000Z",
    "post-1",
  ]) {
    assert.equal(wire.includes(secret), false, `payload leaked ${secret}`);
  }
  // The html surface's markup is a reference only — it is never inlined here.
  assert.equal(wire.includes("seeded-markup"), false);
});

test("a missing, revoked or expired slug is one indistinguishable 404", async () => {
  const { app, publications, link, publication } = await seed();
  const unknown = await get(app, "/api/v/nope");
  assert.equal(unknown.status, 404);
  const unknownBody = await unknown.text();

  await publications.updateShareLink(link.id, { revokedAt: new Date().toISOString() });
  const revoked = await get(app, "/api/v/demo-slug");
  assert.equal(revoked.status, 404);
  assert.equal(await revoked.text(), unknownBody);

  const expiredLink = await publications.createShareLink({
    publicationId: publication.id,
    slug: "expired-slug",
    expiresAt: "2000-01-01T00:00:00.000Z",
  });
  assert.ok(expiredLink);
  const expired = await get(app, "/api/v/expired-slug");
  assert.equal(expired.status, 404);
  assert.equal(await expired.text(), unknownBody);
  assert.equal(unknownBody, JSON.stringify({ error: "not found" }));
});

test("a publication with no snapshot is a 404 too", async () => {
  const store = new SqlStore(createSqliteStorage());
  const publications = store.publications!;
  const publication = await publications.createPublication({ kind: "post", title: "empty" });
  await publications.createShareLink({ publicationId: publication.id, slug: "empty-slug" });
  const app = createPublicApp({ store, ownerToken: OWNER_TOKEN, visitorSecret: VISITOR_SECRET });
  assert.equal((await get(app, "/api/v/empty-slug")).status, 404);
});

// --- 4. password gate ---------------------------------------------------

test("a password-protected link gates reads, unlocks by cookie, and rotates on change", async () => {
  const { app, publications, link } = await seed({ withPassword: true });

  const locked = await get(app, "/api/v/demo-slug");
  assert.equal(locked.status, 401);
  assert.deepEqual(await locked.json(), { error: "password required", passwordRequired: true });

  const wrong = await post(app, "/api/v/demo-slug/unlock", { password: "nope" });
  assert.equal(wrong.status, 401);
  assert.deepEqual(await wrong.json(), { error: "incorrect password" });

  const right = await post(app, "/api/v/demo-slug/unlock", { password: PASSWORD });
  assert.equal(right.status, 200);
  assert.deepEqual(await right.json(), { ok: true });
  const setCookie = right.headers.get("set-cookie") ?? "";
  assert.match(setCookie, new RegExp(`sspw_${link.id}=`));
  assert.match(setCookie, /HttpOnly/i);
  const cookie = setCookie.split(";")[0];

  const unlocked = await get(app, "/api/v/demo-slug", { cookie });
  assert.equal(unlocked.status, 200);

  // The cookie is bound to the current password hash, so changing it revokes
  // every outstanding unlock without any stored session state.
  await publications.updateShareLink(link.id, { passwordHash: await hashPassword("different") });
  const stale = await get(app, "/api/v/demo-slug", { cookie });
  assert.equal(stale.status, 401);
});

test("unlock on a link with no password is a plain ok", async () => {
  const { app } = await seed();
  const res = await post(app, "/api/v/demo-slug/unlock", { password: "anything" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(res.headers.get("set-cookie"), null);
  // A non-JSON body is tolerated rather than throwing.
  const empty = await post(app, "/api/v/demo-slug/unlock");
  assert.equal(empty.status, 200);
});

test("unlock attempts are rate limited per slug and client", async () => {
  const { app } = await seed({ withPassword: true });
  const ip = { "x-forwarded-for": "203.0.113.7, 10.0.0.1" };
  for (let i = 0; i < 10; i++) {
    const res = await post(app, "/api/v/demo-slug/unlock", { password: "nope" }, ip);
    assert.equal(res.status, 401, `attempt ${i + 1}`);
  }
  const limited = await post(app, "/api/v/demo-slug/unlock", { password: "nope" }, ip);
  assert.equal(limited.status, 429);
  assert.deepEqual(await limited.json(), { error: "too many attempts" });
  assert.ok(Number(limited.headers.get("retry-after")) >= 1);

  // A different client still has its own budget.
  const other = await post(
    app,
    "/api/v/demo-slug/unlock",
    { password: "nope" },
    {
      "cf-connecting-ip": "198.51.100.4",
    },
  );
  assert.equal(other.status, 401);
});

// --- 5. confirmed opens -------------------------------------------------

test("a confirmed open records one anonymised event and counts uniques by visitor", async () => {
  const { app, publications, link, snapshot } = await seed();
  const chrome = {
    "user-agent": "Mozilla/5.0 (Macintosh) Chrome/120",
    "cf-connecting-ip": "1.1.1.1",
  };

  const first = await post(app, "/api/v/demo-slug/open", undefined, chrome);
  assert.equal(first.status, 204);
  const events = await publications.listOpenEvents(link.id);
  assert.equal(events.length, 1);
  assert.match(events[0].visitorHash, /^[0-9a-f]{32}$/);
  assert.equal(events[0].deviceClass, "desktop");
  assert.equal(events[0].snapshotId, snapshot.id);
  assert.equal(events[0].country, null);

  // Same IP + UA is the same approximate visitor.
  assert.equal((await post(app, "/api/v/demo-slug/open", undefined, chrome)).status, 204);
  let aggregate = await publications.getOpenAggregate(link.id);
  assert.equal(aggregate.totalOpens, 2);
  assert.equal(aggregate.uniqueVisitors, 1);

  // A different user agent is a different one, and a valid country is kept.
  const iphone = {
    "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
    "cf-connecting-ip": "1.1.1.1",
    "cf-ipcountry": "ES",
  };
  assert.equal((await post(app, "/api/v/demo-slug/open", undefined, iphone)).status, 204);
  aggregate = await publications.getOpenAggregate(link.id);
  assert.equal(aggregate.totalOpens, 3);
  assert.equal(aggregate.uniqueVisitors, 2);
  const latest = await publications.listOpenEvents(link.id);
  assert.equal(latest[0].deviceClass, "mobile");
  assert.equal(latest[0].country, "ES");

  // A bogus country header is dropped rather than stored.
  assert.equal(
    (await post(app, "/api/v/demo-slug/open", undefined, { ...iphone, "cf-ipcountry": "XX1" }))
      .status,
    204,
  );
  assert.equal((await publications.listOpenEvents(link.id))[0].country, null);
});

test("trackOpens:false answers 204 but records nothing, and a revoked link 404s", async () => {
  const { app, publications, link } = await seed({ trackOpens: false });
  assert.equal((await post(app, "/api/v/demo-slug/open")).status, 204);
  assert.deepEqual(await publications.listOpenEvents(link.id), []);
  assert.equal((await publications.getOpenAggregate(link.id)).totalOpens, 0);

  await publications.updateShareLink(link.id, { revokedAt: new Date().toISOString() });
  assert.equal((await post(app, "/api/v/demo-slug/open")).status, 404);
});

// --- 6. external feedback -----------------------------------------------

const pointAnchor = { kind: "point", itemIndex: 0, surfaceIndex: HTML, x: 0.5, y: 0.25 };

test("valid feedback lands in the external tables only", async () => {
  const { app, publications, store, session, snapshot, link, publication } = await seed();
  const body = {
    name: "Dana",
    email: "dana@example.com",
    note: "the second chart is off",
    snapshotId: snapshot.id,
    anchor: pointAnchor,
  };
  const res = await post(app, "/api/v/demo-slug/feedback", body);
  assert.equal(res.status, 201);
  assert.deepEqual(await res.json(), { ok: true });

  const text = await post(app, "/api/v/demo-slug/feedback", {
    ...body,
    anchor: {
      kind: "text",
      itemIndex: 0,
      surfaceIndex: MARKDOWN,
      quote: "Some prose",
      prefix: "Heading ",
      suffix: " end",
      startMeta: { parentTagName: "P", parentIndex: 1, textOffset: 4 },
      endMeta: { parentTagName: "P", parentIndex: 1, textOffset: 14 },
    },
  });
  assert.equal(text.status, 201);

  const stored = await publications.listFeedback({ publicationId: publication.id });
  assert.equal(stored.length, 2);
  for (const feedback of stored) {
    assert.equal(feedback.status, "unread");
    assert.equal(feedback.shareLinkId, link.id);
    assert.equal(feedback.snapshotId, snapshot.id);
    assert.equal(feedback.name, "Dana");
  }
  assert.equal(
    stored.some((f) => f.anchor.kind === "point"),
    true,
  );
  assert.equal(
    stored.some((f) => f.anchor.kind === "text"),
    true,
  );

  // ADR 0003: an untrusted reader never speaks into the comment→agent stream.
  assert.deepEqual(await store.listComments({}), []);
  assert.equal((await store.getSession(session.id))?.agentSeq, 0);
});

test("feedback rejects everything malformed and silently swallows the honeypot", async () => {
  const { app, publications, store, session, snapshot } = await seed();
  const base = { name: "Dana", note: "a note", snapshotId: snapshot.id, anchor: pointAnchor };
  const cases: [string, unknown, number][] = [
    ["honeypot", { ...base, website: "https://spam.example" }, 201],
    ["missing note", { ...base, note: "   " }, 400],
    ["missing name", { ...base, name: "" }, 400],
    ["stale snapshot", { ...base, snapshotId: "snap-gone" }, 409],
    ["no snapshot", { ...base, snapshotId: undefined }, 409],
    ["unknown item", { ...base, anchor: { ...pointAnchor, itemIndex: 9 } }, 400],
    ["unknown surface", { ...base, anchor: { ...pointAnchor, surfaceIndex: 99 } }, 400],
    ["x out of range", { ...base, anchor: { ...pointAnchor, x: 1.5 } }, 400],
    ["y out of range", { ...base, anchor: { ...pointAnchor, y: -0.1 } }, 400],
    ["non-finite point", { ...base, anchor: { ...pointAnchor, x: "abc" } }, 400],
    [
      "blank quote",
      { ...base, anchor: { kind: "text", itemIndex: 0, surfaceIndex: 0, quote: "   " } },
      400,
    ],
    ["missing anchor", { ...base, anchor: undefined }, 400],
  ];
  for (const [name, body, status] of cases) {
    const res = await post(app, "/api/v/demo-slug/feedback", body);
    assert.equal(res.status, status, name);
  }
  assert.deepEqual(await publications.listFeedback({}), []);
  assert.deepEqual(await store.listComments({}), []);
  assert.equal((await store.getSession(session.id))?.agentSeq, 0);
});

test("feedback is rate limited", async () => {
  const { app, snapshot } = await seed();
  const ip = { "cf-connecting-ip": "203.0.113.9" };
  const body = { name: "Dana", note: "a note", snapshotId: snapshot.id, anchor: pointAnchor };
  for (let i = 0; i < 20; i++) {
    assert.equal((await post(app, "/api/v/demo-slug/feedback", body, ip)).status, 201, `#${i + 1}`);
  }
  const limited = await post(app, "/api/v/demo-slug/feedback", body, ip);
  assert.equal(limited.status, 429);
  assert.deepEqual(await limited.json(), { error: "too many submissions" });
  assert.ok(Number(limited.headers.get("retry-after")) >= 1);
});

// --- 7. surface documents -----------------------------------------------

test("every sandboxed surface is served as its own document under a sandbox CSP", async () => {
  const { app } = await seed();
  for (const index of [HTML, MARKDOWN, CODE, TERMINAL, DIFF, MERMAID]) {
    const res = await get(app, `/api/v/demo-slug/s/0/${index}`);
    assert.equal(res.status, 200, `surface ${index}`);
    assert.equal(res.headers.get("content-security-policy"), "sandbox allow-scripts", `${index}`);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff", `${index}`);
    assert.equal(
      res.headers.get("cache-control"),
      "private, max-age=31536000, immutable",
      `${index}`,
    );
    assert.ok((await res.text()).length > 0, `surface ${index} body`);
  }
  // The html surface's own markup lives here and only here.
  const html = await (await get(app, `/api/v/demo-slug/s/0/${HTML}`)).text();
  assert.ok(html.includes(HTML_MARKUP));
  // Themes and modes are honoured without changing the guarantees.
  const themed = await get(app, `/api/v/demo-slug/s/0/${MARKDOWN}?theme=gruvbox&mode=light`);
  assert.equal(themed.status, 200);
  const bogusTheme = await get(app, `/api/v/demo-slug/s/0/${CODE}?theme=nope&mode=sideways`);
  assert.equal(bogusTheme.status, 200);
});

test("native and out-of-range surfaces are not reachable as documents", async () => {
  const { app, publications, link } = await seed();
  for (const path of [
    `/api/v/demo-slug/s/0/${IMAGE}`,
    `/api/v/demo-slug/s/0/${JSON_}`,
    "/api/v/demo-slug/s/0/99",
    "/api/v/demo-slug/s/9/0",
    "/api/v/demo-slug/s/x/y",
  ]) {
    const res = await get(app, path);
    assert.equal(res.status, 404, path);
    assert.equal(await res.text(), "No renderable surface there", path);
  }
  await publications.updateShareLink(link.id, { revokedAt: new Date().toISOString() });
  assert.equal((await get(app, `/api/v/demo-slug/s/0/${HTML}`)).status, 404);
});

test("a locked link does not serve surface documents either", async () => {
  const { app } = await seed({ withPassword: true });
  const res = await get(app, `/api/v/demo-slug/s/0/${HTML}`);
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: "password required", passwordRequired: true });
});

test("a diff that cannot be rendered still answers with a document", async () => {
  const store = new SqlStore(createSqliteStorage());
  const publications = store.publications!;
  const publication = await publications.createPublication({ kind: "post", title: "diffy" });
  await publications.createSnapshot({
    publicationId: publication.id,
    items: [
      {
        postId: "p",
        title: "t",
        version: 1,
        surfaces: [{ kind: "diff" }],
      },
    ],
  });
  await publications.createShareLink({ publicationId: publication.id, slug: "diff-slug" });
  const app = createPublicApp({ store, ownerToken: OWNER_TOKEN, visitorSecret: VISITOR_SECRET });
  const res = await get(app, "/api/v/diff-slug/s/0/0");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-security-policy"), "sandbox allow-scripts");
});

// --- 8. assets ----------------------------------------------------------

test("only assets a snapshot pins are served", async () => {
  const { app, asset, orphanAsset } = await seed();
  const res = await get(app, `/a/${asset.id}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("content-type"), "image/png");
  assert.equal(res.headers.get("content-disposition"), "inline");
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), ASSET_BYTES);

  assert.equal((await get(app, `/a/${orphanAsset.id}`)).status, 404);
  assert.equal((await get(app, "/a/does-not-exist")).status, 404);
});

test("a pinned asset whose bytes are gone is a 404, not a crash", async () => {
  const { app, store, asset } = await seed();
  await store.removeAsset(asset.id);
  assert.equal((await get(app, `/a/${asset.id}`)).status, 404);
});

// --- 9. headers ---------------------------------------------------------

test("every response is unreferrable and unindexable", async () => {
  const { app } = await seed();
  for (const path of ["/api/v/demo-slug", "/api/v/nope", "/robots.txt", "/nothing-here"]) {
    const res = await get(app, path);
    assert.equal(res.headers.get("referrer-policy"), "no-referrer", path);
    assert.match(res.headers.get("x-robots-tag") ?? "", /noindex/, path);
  }
  const robots = await get(app, "/robots.txt");
  assert.equal(robots.status, 200);
  assert.equal(await robots.text(), "User-agent: *\nDisallow: /\n");
});

// --- 10. body limit -----------------------------------------------------

test("an oversized body is rejected before it is parsed", async () => {
  const { app, snapshot } = await seed();
  const res = await app.request(`${ORIGIN}/api/v/demo-slug/feedback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Dana",
      snapshotId: snapshot.id,
      anchor: pointAnchor,
      note: "x".repeat(MAX_PUBLIC_BODY_BYTES + 1),
    }),
  });
  assert.equal(res.status, 413);
  assert.deepEqual(await res.json(), { error: "request body too large" });
});

// --- 11. construction ---------------------------------------------------

test("createPublicApp refuses to start without its secrets or a capable store", async () => {
  const store = new SqlStore(createSqliteStorage());
  assert.throws(
    () => createPublicApp({ store, ownerToken: "", visitorSecret: VISITOR_SECRET }),
    /owner token/,
  );
  assert.throws(
    () => createPublicApp({ store, ownerToken: OWNER_TOKEN, visitorSecret: "" }),
    /visitor secret/,
  );
  const jsonStore = new JsonFileStore(
    join(mkdtempSync(join(tmpdir(), "sideshow-public-")), "data.json"),
  );
  assert.throws(
    () =>
      createPublicApp({
        store: jsonStore,
        ownerToken: OWNER_TOKEN,
        visitorSecret: VISITOR_SECRET,
      }),
    /supports publications/,
  );
});

test("the clock is injectable, so expiry is decided by the caller's time", async () => {
  const store = new SqlStore(createSqliteStorage());
  const publications = store.publications!;
  const publication = await publications.createPublication({ kind: "post", title: "clocked" });
  await publications.createSnapshot({
    publicationId: publication.id,
    items: [{ postId: "p", title: "t", version: 1, surfaces: [{ kind: "json", data: 1 }] }],
  });
  await publications.createShareLink({
    publicationId: publication.id,
    slug: "clock-slug",
    expiresAt: "2030-01-01T00:00:00.000Z",
  });
  const app = createPublicApp({
    store,
    ownerToken: OWNER_TOKEN,
    visitorSecret: VISITOR_SECRET,
    now: () => Date.parse("2031-01-01T00:00:00.000Z"),
  });
  assert.equal((await get(app, "/api/v/clock-slug")).status, 404);
});

// --- 12. publicSurfaceView ----------------------------------------------

test("publicSurfaceView exposes sandboxed kinds by reference and data kinds as data", () => {
  const sandboxed: Surface[] = [
    { kind: "html", html: "<b>secret markup</b>" },
    { kind: "markdown", markdown: "secret prose" },
    { kind: "code", code: "secret()", language: "ts" },
    { kind: "terminal", text: "secret output" },
    { kind: "diff", patch: "secret patch" },
    { kind: "mermaid", mermaid: "graph TD; secret-->x;" },
  ];
  for (const surface of sandboxed) {
    const view = publicSurfaceView(surface);
    assert.deepEqual(view, { kind: surface.kind, sandboxed: true });
    assert.equal(JSON.stringify(view).includes("secret"), false, surface.kind);
  }

  assert.deepEqual(publicSurfaceView({ kind: "image", assetId: "a1" }), {
    kind: "image",
    sandboxed: false,
    assetId: "a1",
  });
  assert.deepEqual(publicSurfaceView({ kind: "image", assetId: "a1", alt: "x", caption: "c" }), {
    kind: "image",
    sandboxed: false,
    assetId: "a1",
    alt: "x",
    caption: "c",
  });
  assert.deepEqual(publicSurfaceView({ kind: "json", data: [1, null] }), {
    kind: "json",
    sandboxed: false,
    data: [1, null],
  });

  // `trace` is private-side and experimental: it is dropped, never published.
  assert.equal(publicSurfaceView({ kind: "trace", steps: [{ label: "ran a tool" }] }), null);
});

// --- 13. normalizeAnchor ------------------------------------------------

const snapshotShape = {
  items: [
    {
      postId: "p",
      title: "t",
      version: 1,
      surfaces: [{ kind: "html", html: "<p>x</p>" }] as Surface[],
    },
  ],
};

test("normalizeAnchor rejects anything that does not point at a real surface", () => {
  for (const raw of [
    null,
    undefined,
    "point",
    42,
    {},
    { kind: "point", itemIndex: 0, surfaceIndex: 0 }, // no coordinates
    { kind: "scribble", itemIndex: 0, surfaceIndex: 0 },
    { kind: "point", itemIndex: 0.5, surfaceIndex: 0, x: 0, y: 0 },
    { kind: "point", itemIndex: 0, surfaceIndex: "one", x: 0, y: 0 },
    { kind: "point", itemIndex: {}, surfaceIndex: 0, x: 0, y: 0 },
    { kind: "point", itemIndex: -1, surfaceIndex: 0, x: 0, y: 0 },
    { kind: "point", itemIndex: 0, surfaceIndex: 1, x: 0, y: 0 },
    { kind: "point", itemIndex: 0, surfaceIndex: 0, x: Number.NaN, y: 0 },
    { kind: "point", itemIndex: 0, surfaceIndex: 0, x: 0, y: Number.POSITIVE_INFINITY },
    { kind: "text", itemIndex: 0, surfaceIndex: 0 },
    { kind: "text", itemIndex: 0, surfaceIndex: 0, quote: 7 },
  ]) {
    assert.equal(normalizeAnchor(raw, snapshotShape), null, JSON.stringify(raw) ?? String(raw));
  }
});

test("normalizeAnchor keeps a valid point anchor and its optional surface id", () => {
  assert.deepEqual(
    normalizeAnchor(
      { kind: "point", itemIndex: 0, surfaceIndex: 0, x: 0, y: 1, surfaceId: "s1" },
      snapshotShape,
    ),
    { kind: "point", itemIndex: 0, surfaceIndex: 0, surfaceId: "s1", x: 0, y: 1 },
  );
  assert.deepEqual(
    normalizeAnchor({ kind: "point", itemIndex: 0, surfaceIndex: 0, x: 1, y: 0 }, snapshotShape),
    { kind: "point", itemIndex: 0, surfaceIndex: 0, x: 1, y: 0 },
  );
});

test("normalizeAnchor truncates text anchor fields and drops malformed meta", () => {
  const anchor = normalizeAnchor(
    {
      kind: "text",
      itemIndex: 0,
      surfaceIndex: 0,
      quote: "q".repeat(MAX_FEEDBACK_QUOTE_LENGTH + 500),
      prefix: "p".repeat(500),
      suffix: "s".repeat(500),
      startMeta: { parentTagName: "P".repeat(100), parentIndex: 2, textOffset: 3 },
      endMeta: { parentTagName: 42, parentIndex: 2, textOffset: 3 },
    },
    snapshotShape,
  );
  assert.ok(anchor && anchor.kind === "text");
  assert.equal(anchor.quote.length, MAX_FEEDBACK_QUOTE_LENGTH);
  assert.equal(anchor.prefix?.length, 200);
  assert.equal(anchor.suffix?.length, 200);
  assert.deepEqual(anchor.startMeta, {
    parentTagName: "P".repeat(32),
    parentIndex: 2,
    textOffset: 3,
  });
  assert.equal(anchor.endMeta, undefined, "a meta without a tag name is dropped");
  assert.equal("surfaceId" in anchor, false);
});

test("normalizeAnchor drops meta that is not an object or has non-integer offsets", () => {
  const base = { kind: "text", itemIndex: 0, surfaceIndex: 0, quote: "hello" };
  for (const meta of [
    null,
    "nope",
    7,
    {},
    { parentTagName: "P" },
    { parentTagName: "P", parentIndex: 1.5, textOffset: 0 },
    { parentTagName: "P", parentIndex: 1, textOffset: "x" },
  ]) {
    const anchor = normalizeAnchor({ ...base, startMeta: meta, endMeta: meta }, snapshotShape);
    assert.ok(anchor && anchor.kind === "text");
    assert.equal(anchor.startMeta, undefined, JSON.stringify(meta) ?? String(meta));
    assert.equal(anchor.endMeta, undefined, JSON.stringify(meta) ?? String(meta));
  }
  const kept = normalizeAnchor(
    { ...base, startMeta: { parentTagName: "P", parentIndex: 0, textOffset: 0 } },
    snapshotShape,
  );
  assert.ok(kept && kept.kind === "text");
  assert.deepEqual(kept.startMeta, { parentTagName: "P", parentIndex: 0, textOffset: 0 });
  assert.equal(kept.prefix, undefined);
  assert.equal(kept.suffix, undefined);
});
