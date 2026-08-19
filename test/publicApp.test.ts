import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { hashPassword } from "../server/passwords.ts";
import { encodeBase64 } from "../server/base64.ts";
import {
  createPublicApp,
  MAX_FEEDBACK_NAME_LENGTH,
  MAX_FEEDBACK_NOTE_LENGTH,
  MAX_FEEDBACK_QUOTE_LENGTH,
  MAX_PUBLIC_BODY_BYTES,
  normalizeAnchor,
  PUBLICATION_ASSET_AGENT,
  publicSurfaceView,
} from "../server/publicApp.ts";
import {
  CUSTOM_THEME_ID,
  CUSTOM_THEME_SETTING,
  CUSTOM_THEME_VERSION,
} from "../server/customTheme.ts";
import {
  OPEN_EVENT_RETENTION_DAYS,
  type ShareLink,
  type Snapshot,
  type SnapshotItem,
} from "../server/publicationTypes.ts";
import { VISITOR_WINDOW_DAYS } from "../server/visitorHash.ts";
import { createSqliteStorage } from "../server/sqliteStorage.ts";
import { SqlStore } from "../server/sqlStore.ts";
import { JsonFileStore } from "../server/storage.ts";
import { hashAssetId, type Surface } from "../server/types.ts";

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

async function seed(
  opts: { withPassword?: boolean; trackOpens?: boolean; now?: () => number } = {},
) {
  const storage = createSqliteStorage();
  const store = new SqlStore(storage);
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

  const app = createPublicApp({
    store,
    ownerToken: OWNER_TOKEN,
    visitorSecret: VISITOR_SECRET,
    ...(opts.now && { now: opts.now }),
  });
  return {
    store,
    // The raw SQL surface, so a test can read what was really persisted rather
    // than what the store chose to hand back.
    storage,
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
    ["PUT", "/api/theme/custom"],
    ["DELETE", "/api/theme/custom"],
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

const DAY_MS = 86_400_000;
const CHROME = {
  "user-agent": "Mozilla/5.0 (Macintosh) Chrome/120",
  "cf-connecting-ip": "1.1.1.1",
};
const IPHONE = {
  "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
  "cf-connecting-ip": "1.1.1.1",
};

const openOnce = async (app: TestApp, headers: Record<string, string>) => {
  const res = await post(app, "/api/v/demo-slug/open", undefined, headers);
  assert.equal(res.status, 204);
};

// A confirmed open is confirmed precisely because the reader had to run the
// page's script to send it. Anything a preview fetcher, a link unfurler or a
// scanner can pull on its own must leave the count at zero.
test("only POST /open records an open — fetching the page or a surface never does", async () => {
  const { app, publications, link } = await seed();

  const probes: [string, RequestInit][] = [
    ["/v/demo-slug", {}],
    ["/api/v/demo-slug", {}],
    [`/api/v/demo-slug/s/0/${HTML}`, {}],
    [`/api/v/demo-slug/s/0/${MARKDOWN}`, {}],
    ["/robots.txt", {}],
  ];
  for (const [path, init] of probes) {
    const res = await app.request(`${ORIGIN}${path}`, { ...init, headers: CHROME });
    assert.equal(res.status, 200, `${path} should have been readable`);
  }

  assert.deepEqual(await publications.listOpenEvents(link.id), []);
  assert.deepEqual(await publications.getOpenAggregate(link.id), {
    shareLinkId: link.id,
    firstOpenAt: null,
    lastOpenAt: null,
    totalOpens: 0,
    uniqueVisitors: 0,
  });

  // The beacon, and only the beacon, moves it.
  await openOnce(app, CHROME);
  assert.equal((await publications.getOpenAggregate(link.id)).totalOpens, 1);
});

test("the aggregate reports first open, last open, total opens and approximate uniques", async () => {
  const { app, publications, link } = await seed();

  await openOnce(app, CHROME);
  const first = await publications.getOpenAggregate(link.id);
  assert.equal(first.totalOpens, 1);
  assert.equal(first.uniqueVisitors, 1);
  assert.ok(first.firstOpenAt, "a first open must be recorded");
  assert.equal(first.lastOpenAt, first.firstOpenAt);

  // The same reader again, then a different one.
  await openOnce(app, CHROME);
  await openOnce(app, IPHONE);

  const after = await publications.getOpenAggregate(link.id);
  assert.equal(after.totalOpens, 3);
  assert.equal(after.uniqueVisitors, 2, "two approximate visitors, three opens");
  // The first open is a fixed point; only the last one moves.
  assert.equal(after.firstOpenAt, first.firstOpenAt);
  const events = await publications.listOpenEvents(link.id);
  assert.equal(events.length, 3);
  assert.equal(after.lastOpenAt, events[0].at, "lastOpenAt is the newest event's instant");
  assert.ok(
    Date.parse(after.lastOpenAt as string) >= Date.parse(after.firstOpenAt as string),
    "the last open cannot precede the first",
  );

  // A link nobody opened reports zeroes rather than nothing.
  const untouched = await publications.createShareLink({ publicationId: link.publicationId });
  assert.ok(untouched);
  assert.deepEqual(await publications.getOpenAggregate(untouched.id), {
    shareLinkId: untouched.id,
    firstOpenAt: null,
    lastOpenAt: null,
    totalOpens: 0,
    uniqueVisitors: 0,
  });
});

test("a stored open keeps device class and country but neither the IP nor the raw user agent", async () => {
  const { app, storage } = await seed();
  const ip = "203.0.113.42";
  const ua = IPHONE["user-agent"];
  await openOnce(app, { "user-agent": ua, "cf-connecting-ip": ip, "cf-ipcountry": "ES" });

  const events = storage.exec("SELECT * FROM open_events").toArray();
  const visitors = storage.exec("SELECT * FROM open_visitors").toArray();
  assert.equal(events.length, 1);
  assert.equal(visitors.length, 1);

  const persisted = JSON.stringify({ events, visitors });
  assert.equal(persisted.includes(ip), false, "a raw IP reached storage");
  assert.equal(persisted.includes("203.0.113"), false, "part of the IP reached storage");
  assert.equal(persisted.includes(ua), false, "the raw user agent reached storage");
  assert.equal(persisted.includes("iPhone"), false, "user-agent detail reached storage");

  // What is kept instead: the coarse bucket, the country header, and a hash.
  assert.equal(events[0].deviceClass, "mobile");
  assert.equal(events[0].country, "ES");
  assert.match(events[0].visitorHash as string, /^[0-9a-f]{32}$/);
});

test("the visitor hash is stable per reader and different for a different IP", async () => {
  const { app, storage } = await seed();
  await openOnce(app, CHROME);
  await openOnce(app, CHROME);
  await openOnce(app, { ...CHROME, "cf-connecting-ip": "198.51.100.7" });

  const hashes = storage
    .exec("SELECT visitorHash FROM open_events ORDER BY rowid")
    .toArray()
    .map((row) => row.visitorHash as string);
  assert.equal(hashes.length, 3);
  assert.equal(hashes[0], hashes[1], "same IP + user agent is the same approximate visitor");
  assert.notEqual(hashes[0], hashes[2], "a different IP must not collide inside one window");
});

test("the visitor hash rotates: the same reader in a later window is a new hash", async () => {
  let now = Date.now();
  const { app, publications, storage, link } = await seed({ now: () => now });

  await openOnce(app, CHROME);
  // One whole rotation window later — the same reader, the same everything.
  now += VISITOR_WINDOW_DAYS * DAY_MS;
  await openOnce(app, CHROME);

  const hashes = storage
    .exec("SELECT visitorHash FROM open_events ORDER BY rowid")
    .toArray()
    .map((row) => row.visitorHash as string);
  assert.notEqual(hashes[0], hashes[1], "the keyed hash must not survive its window");

  // Which is exactly why "uniques" is approximate: one reader, counted twice.
  assert.equal((await publications.getOpenAggregate(link.id)).uniqueVisitors, 2);
});

test("an open prunes events past the retention window, keeps the aggregate, and re-scans hourly at most", async () => {
  let now = Date.now();
  const { app, publications, storage, link, snapshot } = await seed({ now: () => now });

  await openOnce(app, CHROME);
  await openOnce(app, CHROME);
  await openOnce(app, IPHONE);
  const before = await publications.getOpenAggregate(link.id);
  assert.equal(before.totalOpens, 3);
  assert.equal(before.uniqueVisitors, 2);
  assert.equal((await publications.listOpenEvents(link.id)).length, 3);

  // Past the retention window: the next open takes the old detail with it.
  now += (OPEN_EVENT_RETENTION_DAYS + 1) * DAY_MS;
  await openOnce(app, CHROME);

  assert.equal(
    (await publications.listOpenEvents(link.id)).length,
    1,
    "only the open just recorded is still detailed",
  );
  const after = await publications.getOpenAggregate(link.id);
  assert.equal(
    after.firstOpenAt,
    before.firstOpenAt,
    "the aggregate keeps the original first open",
  );
  assert.equal(after.totalOpens, 4, "totals count opens whose detail has expired");
  // The window rotated over those 91 days, so the same reader counts again.
  assert.equal(after.uniqueVisitors, 3);

  // Throttling, observed rather than inspected: an event planted as ancient
  // right after a prune survives the next open, because that one does not scan.
  const plant = (id: string) =>
    storage.exec(
      "INSERT INTO open_events (id, shareLinkId, snapshotId, visitorHash, deviceClass, country, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      id,
      link.id,
      snapshot.id,
      "0".repeat(32),
      "desktop",
      null,
      "1999-01-01T00:00:00.000Z",
    );
  const stillThere = async (id: string) =>
    (await publications.listOpenEvents(link.id, 100)).some((event) => event.id === id);

  plant("ancient-1");
  now += 30 * 60 * 1000;
  await openOnce(app, CHROME);
  assert.equal(await stillThere("ancient-1"), true, "a prune within the hour must not re-scan");

  // Once the hour is up, the very next open does scan.
  now += 61 * 60 * 1000;
  await openOnce(app, CHROME);
  assert.equal(await stillThere("ancient-1"), false);
});

test("the analytics route reports the aggregate and recent events, and leaks nothing", async () => {
  const { app, publications, link, snapshot } = await seed();
  const path = `/api/owner/links/${link.id}/analytics`;

  // An unknown link is a 404, not an empty shape to probe.
  assert.equal((await ownerGet(app, "/api/owner/links/nope/analytics")).status, 404);
  // And it is owner-only, like every other link route.
  assert.equal((await get(app, path)).status, 401);

  const empty = (await (await ownerGet(app, path)).json()) as any;
  assert.equal(empty.trackOpens, true);
  assert.equal(empty.retentionDays, OPEN_EVENT_RETENTION_DAYS);
  assert.deepEqual(empty.aggregate, {
    shareLinkId: link.id,
    firstOpenAt: null,
    lastOpenAt: null,
    totalOpens: 0,
    uniqueVisitors: 0,
  });
  assert.deepEqual(empty.events, []);

  const ip = "203.0.113.42";
  const ua = IPHONE["user-agent"];
  await openOnce(app, { "user-agent": ua, "cf-connecting-ip": ip, "cf-ipcountry": "ES" });

  const res = await ownerGet(app, path);
  const wire = await res.clone().text();
  const body = (await res.json()) as any;
  assert.equal(body.aggregate.totalOpens, 1);
  assert.equal(body.aggregate.uniqueVisitors, 1);
  assert.ok(body.aggregate.firstOpenAt);
  assert.equal(body.aggregate.lastOpenAt, body.aggregate.firstOpenAt);
  assert.equal(body.events.length, 1);
  assert.deepEqual(Object.keys(body.events[0]).sort(), [
    "at",
    "country",
    "deviceClass",
    "snapshotId",
  ]);
  assert.equal(body.events[0].deviceClass, "mobile");
  assert.equal(body.events[0].country, "ES");
  assert.equal(body.events[0].snapshotId, snapshot.id);

  // Nothing that could identify the reader, and nothing owner-only either: the
  // recipient label is the owner's note to themselves, not part of analytics.
  const hash = (await publications.listOpenEvents(link.id))[0].visitorHash;
  assert.equal(wire.includes(hash), false, "the rotating visitor hash reached a caller");
  assert.equal(wire.includes("visitorHash"), false);
  assert.equal(wire.includes(ip), false, "an IP reached a caller");
  assert.equal(wire.includes(ua), false, "the raw user agent reached a caller");
  assert.equal(wire.includes(RECIPIENT), false, "the recipient label reached a caller");
});

test("the analytics limit is clamped, and a nonsense one falls back to the default", async () => {
  const { app, storage, link, snapshot } = await seed();
  // Plant more rows than the ceiling allows, directly: 205 real beacons would
  // only be 205 HMACs of the same assertion.
  for (let i = 0; i < 205; i++) {
    storage.exec(
      "INSERT INTO open_events (id, shareLinkId, snapshotId, visitorHash, deviceClass, country, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      `planted-${i}`,
      link.id,
      snapshot.id,
      String(i).padStart(32, "0"),
      "desktop",
      null,
      new Date(Date.now() - i * 1000).toISOString(),
    );
  }

  const count = async (query: string) => {
    const res = await ownerGet(app, `/api/owner/links/${link.id}/analytics${query}`);
    assert.equal(res.status, 200);
    return ((await res.json()) as { events: unknown[] }).events.length;
  };

  assert.equal(await count(""), 50, "the default window is 50");
  assert.equal(await count("?limit=2"), 2);
  assert.equal(await count("?limit=200"), 200);
  assert.equal(await count("?limit=100000"), 200, "clamped down to the ceiling");
  assert.equal(await count("?limit=-3"), 1, "clamped up to one");
  assert.equal(await count("?limit=abc"), 50, "unreadable falls back to the default");
  assert.equal(await count("?limit=0"), 50);
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

test("only the owner can read feedback back, and no public route can", async () => {
  const { app, snapshot, publication, link } = await seed();
  await post(app, "/api/v/demo-slug/feedback", {
    name: "Dana",
    note: "the second chart is off",
    snapshotId: snapshot.id,
    anchor: pointAnchor,
  });

  // Unauthenticated: the owner API is a closed door.
  assert.equal((await get(app, `/api/owner/publications/${publication.id}/feedback`)).status, 401);
  // And there is no public route that reads a submission back — a client can
  // never see another client's note.
  for (const path of [
    "/api/v/demo-slug/feedback",
    `/api/v/demo-slug/feedback/${publication.id}`,
    "/api/v/demo-slug/comments",
  ]) {
    assert.equal((await get(app, path)).status, 404, path);
  }

  const owned = get(app, `/api/owner/publications/${publication.id}/feedback`, {
    authorization: `Bearer ${OWNER_TOKEN}`,
  });
  const list = (await (await owned).json()) as { note: string; shareLinkId: string }[];
  assert.equal(list.length, 1);
  assert.equal(list[0]?.note, "the second chart is off");
  assert.equal(list[0]?.shareLinkId, link.id);

  // Filters narrow it; a publication that does not exist is a 404.
  const filtered = await get(
    app,
    `/api/owner/publications/${publication.id}/feedback?status=resolved&snapshotId=${snapshot.id}`,
    { authorization: `Bearer ${OWNER_TOKEN}` },
  );
  assert.deepEqual(await filtered.json(), []);
  assert.equal(
    (
      await get(app, "/api/owner/publications/nope/feedback", {
        authorization: `Bearer ${OWNER_TOKEN}`,
      })
    ).status,
    404,
  );
});

test("oversized text is bounded, never stored whole", async () => {
  const { app, publications, snapshot } = await seed();
  const res = await post(app, "/api/v/demo-slug/feedback", {
    name: "D".repeat(500),
    email: "e".repeat(500),
    note: "n".repeat(9000),
    snapshotId: snapshot.id,
    anchor: {
      kind: "text",
      itemIndex: 0,
      surfaceIndex: MARKDOWN,
      quote: "q".repeat(5000),
      prefix: "p".repeat(900),
      suffix: "s".repeat(900),
      startMeta: { parentTagName: "P".repeat(200), parentIndex: 0, textOffset: 0 },
      endMeta: { parentTagName: "P", parentIndex: 0, textOffset: 10 },
    },
  });
  assert.equal(res.status, 201);
  const [stored] = await publications.listFeedback({});
  assert.ok(stored);
  assert.equal(stored.note.length, MAX_FEEDBACK_NOTE_LENGTH);
  assert.equal(stored.name.length, MAX_FEEDBACK_NAME_LENGTH);
  assert.equal(stored.email?.length, MAX_FEEDBACK_NAME_LENGTH);
  assert.equal(stored.anchor.kind, "text");
  if (stored.anchor.kind !== "text") return;
  assert.equal(stored.anchor.quote.length, MAX_FEEDBACK_QUOTE_LENGTH);
  assert.equal(stored.anchor.prefix?.length, 200);
  assert.equal(stored.anchor.suffix?.length, 200);
  assert.equal(stored.anchor.startMeta?.parentTagName.length, 32);
});

test("two identical quotes in one surface stay distinguishable anchors", async () => {
  const { app, publications, snapshot } = await seed();
  const base = {
    name: "Dana",
    note: "this line again",
    snapshotId: snapshot.id,
  };
  const quote = "Some prose";
  for (const parentIndex of [0, 1]) {
    const res = await post(app, "/api/v/demo-slug/feedback", {
      ...base,
      anchor: {
        kind: "text",
        itemIndex: 0,
        surfaceIndex: MARKDOWN,
        quote,
        startMeta: { parentTagName: "P", parentIndex, textOffset: 4 },
        endMeta: { parentTagName: "P", parentIndex, textOffset: 14 },
      },
    });
    assert.equal(res.status, 201);
  }
  const stored = await publications.listFeedback({});
  assert.equal(stored.length, 2);
  const positions = stored.map((f) =>
    f.anchor.kind === "text" ? f.anchor.startMeta?.parentIndex : null,
  );
  // Same words, different structural positions — the second submission is not
  // silently the first one over again.
  assert.deepEqual([...positions].sort(), [0, 1]);
  assert.deepEqual(
    stored.map((f) => (f.anchor.kind === "text" ? f.anchor.quote : null)),
    [quote, quote],
  );
});

test("a text anchor keeps its surface identity and drops unusable structural metadata", () => {
  const snapshot = {
    items: [
      {
        postId: "p",
        title: "t",
        version: 1,
        surfaces: [{ kind: "html", html: "<p>x</p>", id: "surf-1" }],
      },
    ],
  } as unknown as Snapshot;
  const anchor = normalizeAnchor(
    {
      kind: "text",
      itemIndex: 0,
      surfaceIndex: 0,
      surfaceId: "surf-1",
      quote: "x",
      startMeta: { parentTagName: "P", parentIndex: 0, textOffset: 0 },
      // Not a whole number of characters — unusable, so it is not stored.
      endMeta: { parentTagName: "P", parentIndex: 0, textOffset: 1.5 },
    },
    snapshot,
  );
  assert.ok(anchor);
  assert.equal(anchor.kind, "text");
  if (anchor.kind !== "text") return;
  assert.equal(anchor.surfaceId, "surf-1");
  assert.ok(anchor.startMeta);
  assert.equal(anchor.endMeta, undefined);
  // A surface index that is not in the snapshot never becomes an anchor at all.
  assert.equal(
    normalizeAnchor({ kind: "text", itemIndex: 0, surfaceIndex: 3, quote: "x" }, snapshot),
    null,
  );
  assert.equal(
    normalizeAnchor({ kind: "point", itemIndex: 1, surfaceIndex: 0, x: 0, y: 0 }, snapshot),
    null,
  );
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

// Custom-theme sync is a PRIVATE-runtime concern (issue #11): a publication is
// a client-facing artifact and keeps the neutral default palette no matter what
// the owner's machine theme happens to be.
test("a pushed custom theme cannot reach a publication page", async () => {
  const { app, store } = await seed();
  const before = await (await get(app, `/api/v/demo-slug/s/0/${HTML}`)).text();

  // Write the record the private runtime would persist, on the SAME store.
  const accent = { bg: "#010203", text: "#040506", border: "#070809" };
  const palette = {
    bg: "#ff00ff",
    panel: "#ff00ff",
    surface: "#ff00ff",
    text: "#ff00ff",
    muted: "#ff00ff",
    faint: "#ff00ff",
    border: "#ff00ff",
    border2: "#ff00ff",
    hover: "#ff00ff",
    info: accent,
    success: accent,
    warning: accent,
    danger: accent,
  };
  await store.setSetting(
    CUSTOM_THEME_SETTING,
    JSON.stringify({
      revision: 4,
      payload: { version: CUSTOM_THEME_VERSION, label: "Monotheme", dark: { palette } },
    }),
  );

  // Asking for it by id changes nothing either — the public app resolves ids
  // against the bundled registry only, so an unknown id falls back to default.
  for (const path of [
    `/api/v/demo-slug/s/0/${HTML}`,
    `/api/v/demo-slug/s/0/${HTML}?theme=${CUSTOM_THEME_ID}`,
    `/api/v/demo-slug/s/0/${HTML}?theme=${CUSTOM_THEME_ID}&trev=4`,
  ]) {
    const res = await get(app, path);
    assert.equal(res.status, 200, path);
    const body = await res.text();
    assert.equal(body.includes("#ff00ff"), false, path);
    assert.equal(body, before, path);
  }
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

// --- 13. owner publications CRUD ----------------------------------------

const AUTH = { authorization: `Bearer ${OWNER_TOKEN}` };

const ownerGet = (app: TestApp, path: string) => get(app, path, AUTH);

const ownerSend = (app: TestApp, method: string, path: string, body?: unknown) =>
  app.request(`${ORIGIN}${path}`, {
    method,
    headers: { "content-type": "application/json", ...AUTH },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });

const ownerPost = (app: TestApp, path: string, body?: unknown) =>
  ownerSend(app, "POST", path, body);

// A minimal valid frozen item, so link/snapshot tests do not depend on the
// bigger seeded surface set.
const jsonItem = (title = "Frozen post") => ({
  postId: "post-9",
  title,
  version: 1,
  surfaces: [{ kind: "json", data: { ok: true } }],
});

test("owner publications can be created, listed, filtered, read, patched and deleted", async () => {
  const { app, publication: seeded } = await seed();

  // kind defaults to "post" when unspecified.
  const created = await ownerPost(app, "/api/owner/publications", {
    title: "New publication",
    originPostId: "post-42",
    originSessionId: "session-7",
  });
  assert.equal(created.status, 201);
  const publication = (await created.json()) as any;
  assert.equal(publication.kind, "post");
  assert.equal(publication.title, "New publication");
  assert.equal(publication.currentSnapshotId, null);
  assert.equal(publication.identity, null);

  const collection = (await (
    await ownerPost(app, "/api/owner/publications", { kind: "collection" })
  ).json()) as any;
  assert.equal(collection.kind, "collection");

  const all = (await (await ownerGet(app, "/api/owner/publications")).json()) as any[];
  assert.deepEqual(
    new Set(all.map((p) => p.id)),
    new Set([seeded.id, publication.id, collection.id]),
  );

  const byPost = (await (
    await ownerGet(app, "/api/owner/publications?originPostId=post-42")
  ).json()) as any[];
  assert.deepEqual(
    byPost.map((p) => p.id),
    [publication.id],
  );
  const bySession = (await (
    await ownerGet(app, "/api/owner/publications?originSessionId=session-7")
  ).json()) as any[];
  assert.deepEqual(
    bySession.map((p) => p.id),
    [publication.id],
  );
  const byBoth = (await (
    await ownerGet(app, "/api/owner/publications?originPostId=post-42&originSessionId=nope")
  ).json()) as any[];
  assert.deepEqual(byBoth, []);

  // Detail carries snapshot metadata only — never the frozen surfaces.
  await ownerPost(app, `/api/owner/publications/${publication.id}/snapshots`, {
    items: [jsonItem()],
  });
  const detail = (await (
    await ownerGet(app, `/api/owner/publications/${publication.id}`)
  ).json()) as any;
  assert.equal(detail.publication.id, publication.id);
  assert.equal(detail.snapshots.length, 1);
  assert.equal(detail.snapshots[0].itemCount, 1);
  assert.equal("items" in detail.snapshots[0], false, "detail must not carry frozen surfaces");
  assert.deepEqual(detail.links, []);

  const patched = (await (
    await ownerSend(app, "PATCH", `/api/owner/publications/${publication.id}`, {
      title: "Renamed",
    })
  ).json()) as any;
  assert.equal(patched.title, "Renamed");

  const withIdentity = (await (
    await ownerSend(app, "PATCH", `/api/owner/publications/${publication.id}`, {
      identity: {
        name: "  Edu  ",
        avatarAssetId: "avatar-1",
        linkUrl: "https://example.com/edu",
        linkLabel: "  site  ",
      },
    })
  ).json()) as any;
  assert.deepEqual(withIdentity.identity, {
    name: "Edu",
    avatarAssetId: "avatar-1",
    linkUrl: "https://example.com/edu",
    linkLabel: "site",
  });

  const cleared = (await (
    await ownerSend(app, "PATCH", `/api/owner/publications/${publication.id}`, { identity: null })
  ).json()) as any;
  assert.equal(cleared.identity, null);

  const removed = await ownerSend(app, "DELETE", `/api/owner/publications/${publication.id}`);
  assert.equal(removed.status, 204);
  assert.equal((await ownerGet(app, `/api/owner/publications/${publication.id}`)).status, 404);
  assert.equal(
    (await ownerSend(app, "DELETE", `/api/owner/publications/${publication.id}`)).status,
    404,
  );
});

test("an invalid identity header is refused rather than silently dropped", async () => {
  const { app, publication } = await seed();
  for (const identity of [
    {},
    "Edu",
    7,
    { name: "   " },
    { name: "Edu", linkUrl: "javascript:alert(1)" },
    { name: "Edu", linkUrl: "not a url" },
  ]) {
    const created = await ownerPost(app, "/api/owner/publications", { identity });
    assert.equal(created.status, 400, JSON.stringify(identity));
    assert.deepEqual(await created.json(), { error: "invalid identity header" });

    const patched = await ownerSend(app, "PATCH", `/api/owner/publications/${publication.id}`, {
      identity,
    });
    assert.equal(patched.status, 400, JSON.stringify(identity));
  }
});

test("every owner route 404s for an unknown publication id", async () => {
  const { app } = await seed();
  const missing: [string, string, unknown?][] = [
    ["GET", "/api/owner/publications/nope"],
    ["PATCH", "/api/owner/publications/nope", { title: "x" }],
    ["DELETE", "/api/owner/publications/nope"],
    ["GET", "/api/owner/publications/nope/snapshots"],
    ["POST", "/api/owner/publications/nope/snapshots", { items: [jsonItem()] }],
    ["GET", "/api/owner/publications/nope/links"],
    ["POST", "/api/owner/publications/nope/links", {}],
    ["GET", "/api/owner/snapshots/nope"],
  ];
  for (const [method, path, body] of missing) {
    const res = await ownerSend(app, method, path, body);
    assert.equal(res.status, 404, `${method} ${path}`);
    assert.deepEqual(await res.json(), { error: "not found" }, `${method} ${path}`);
  }
});

// --- 14. owner snapshots ------------------------------------------------

test("a snapshot is refused unless every item validates", async () => {
  const { app, publication } = await seed();
  const base = `/api/owner/publications/${publication.id}/snapshots`;

  for (const [body, error] of [
    [{}, "items required"],
    [{ items: [] }, "items required"],
    [{ items: "nope" }, "items required"],
  ] as [unknown, string][]) {
    const res = await ownerPost(app, base, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.deepEqual(await res.json(), { error });
  }

  for (const item of [null, "an item", 7]) {
    const res = await ownerPost(app, base, { items: [item] });
    assert.equal(res.status, 400, JSON.stringify(item));
    assert.deepEqual(await res.json(), { error: "invalid item" });
  }

  // The same strict validator the private workspace uses.
  const bad = await ownerPost(app, base, {
    items: [{ ...jsonItem(), surfaces: [{ kind: "html" }] }],
  });
  assert.equal(bad.status, 400);
  assert.ok(((await bad.json()) as any).error, "the validator's own message is passed through");
});

test("a second snapshot mints revision 2 and leaves revision 1 readable", async () => {
  const { app, publications, publication } = await seed();
  const base = `/api/owner/publications/${publication.id}/snapshots`;

  // The seeded publication already carries revision 1.
  const first = await publications.listSnapshots(publication.id);
  assert.equal(first.length, 1);
  const original = first[0];

  const created = await ownerPost(app, base, {
    title: "Revision two",
    items: [jsonItem("Second cut")],
  });
  assert.equal(created.status, 201);
  const second = (await created.json()) as any;
  assert.equal(second.revision, 2);
  assert.equal(second.title, "Revision two");
  assert.equal(second.items[0].title, "Second cut");

  const after = await publications.getPublication(publication.id);
  assert.equal(after?.currentSnapshotId, second.id, "the new revision is the live one");

  // The frozen original is untouched and still fetchable by id.
  const kept = await ownerGet(app, `/api/owner/snapshots/${original.id}`);
  assert.equal(kept.status, 200);
  const keptBody = (await kept.json()) as any;
  assert.equal(keptBody.revision, 1);
  assert.equal(keptBody.items[0].title, "Frozen post");
  assert.equal(keptBody.items[0].surfaces.length, 8);

  const listed = (await (await ownerGet(app, base)).json()) as any[];
  assert.deepEqual(new Set(listed.map((s) => s.revision)), new Set([1, 2]));
});

test("snapshot item fields fall back rather than trusting the caller", async () => {
  const { app, publication } = await seed();
  const created = await ownerPost(app, `/api/owner/publications/${publication.id}/snapshots`, {
    items: [{ surfaces: [{ kind: "json", data: 1 }], version: 2.5, postId: 7, title: 7 }],
  });
  assert.equal(created.status, 201);
  const snapshot = (await created.json()) as any;
  assert.equal(snapshot.items[0].postId, "");
  assert.equal(snapshot.items[0].title, "Untitled");
  assert.equal(snapshot.items[0].version, 1);
});

// --- 15. owner share links ----------------------------------------------

test("a share link defaults to a generated slug and never exposes a password hash", async () => {
  const { app, publication } = await seed();
  const base = `/api/owner/publications/${publication.id}/links`;

  const created = await ownerPost(app, base, {});
  assert.equal(created.status, 201);
  const generated = (await created.json()) as any;
  assert.equal(generated.custom, false);
  assert.ok(generated.slug.length >= 20, "a generated slug is an unguessable capability token");
  assert.equal(generated.hasPassword, false);
  assert.equal(generated.expiresAt, null);
  assert.equal(generated.trackOpens, true);
  assert.equal("passwordHash" in generated, false);

  const custom = (await (await ownerPost(app, base, { slug: "my-report" })).json()) as any;
  assert.equal(custom.slug, "my-report");
  assert.equal(custom.custom, true);

  const duplicate = await ownerPost(app, base, { slug: "my-report" });
  assert.equal(duplicate.status, 409);
  assert.deepEqual(await duplicate.json(), { error: "that link address is already taken" });

  for (const slug of ["My-Report", "ab", "-abc", "abc-", "a/b", "with space", 7, null]) {
    const res = await ownerPost(app, base, { slug });
    assert.equal(res.status, 400, JSON.stringify(slug));
    assert.deepEqual(await res.json(), { error: "invalid slug" });
  }

  for (const expiresAt of ["not-a-date", 7, {}]) {
    const res = await ownerPost(app, base, { expiresAt });
    assert.equal(res.status, 400, JSON.stringify(expiresAt));
    assert.deepEqual(await res.json(), { error: "invalid expiry" });
  }
  const dated = (await (
    await ownerPost(app, base, { expiresAt: "2099-06-01T12:00:00Z" })
  ).json()) as any;
  assert.equal(dated.expiresAt, "2099-06-01T12:00:00.000Z");
  const undated = (await (await ownerPost(app, base, { expiresAt: "" })).json()) as any;
  assert.equal(undated.expiresAt, null);

  const locked = (await (
    await ownerPost(app, base, {
      password: PASSWORD,
      recipientLabel: RECIPIENT,
      trackOpens: false,
    })
  ).json()) as any;
  assert.equal(locked.hasPassword, true);
  assert.equal(locked.trackOpens, false);
  assert.equal(locked.recipientLabel, RECIPIENT);
  assert.equal("passwordHash" in locked, false);

  // Nothing anywhere in the owner surface carries the stored hash.
  const listed = await ownerGet(app, base);
  const detail = await ownerGet(app, `/api/owner/publications/${publication.id}`);
  for (const res of [listed, detail]) {
    const wire = await res.text();
    assert.equal(wire.includes("passwordHash"), false);
    assert.equal(wire.includes("scrypt"), false, "no encoded hash material leaks either");
  }
  const listedLinks = JSON.parse(await (await ownerGet(app, base)).text()) as any[];
  assert.equal(listedLinks.length, 6);
  assert.equal(
    listedLinks.every((l) => "hasPassword" in l),
    true,
  );
});

// --- 16. owner assets ---------------------------------------------------

const UPLOAD_BYTES = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

test("owner asset uploads are content-addressed and unreachable until pinned", async () => {
  const { app, publication } = await seed();

  const noData = await ownerPost(app, "/api/owner/assets", { contentType: "image/png" });
  assert.equal(noData.status, 400);
  assert.deepEqual(await noData.json(), { error: "data required" });

  const badBase64 = await ownerPost(app, "/api/owner/assets", { data: "not base64!!!" });
  assert.equal(badBase64.status, 400);
  assert.deepEqual(await badBase64.json(), { error: "invalid base64" });

  const created = await ownerPost(app, "/api/owner/assets", {
    data: encodeBase64(UPLOAD_BYTES),
    contentType: "image/png",
    filename: "shot.png",
  });
  assert.equal(created.status, 201);
  const uploaded = (await created.json()) as any;
  assert.equal(uploaded.id, await hashAssetId(UPLOAD_BYTES), "the id is the SHA-256 of the bytes");
  assert.equal(uploaded.byteLength, UPLOAD_BYTES.byteLength);

  // Identical bytes collapse onto the same id.
  const again = (await (
    await ownerPost(app, "/api/owner/assets", { data: encodeBase64(UPLOAD_BYTES), kind: "file" })
  ).json()) as any;
  assert.equal(again.id, uploaded.id);

  // Stored, but not public until a snapshot pins it.
  assert.equal((await get(app, `/a/${uploaded.id}`)).status, 404);
  const pinned = await ownerPost(app, `/api/owner/publications/${publication.id}/snapshots`, {
    items: [
      {
        ...jsonItem(),
        surfaces: [{ kind: "image", assetId: uploaded.id, alt: "shot" }],
      },
    ],
    assetIds: [uploaded.id, 7],
  });
  assert.equal(pinned.status, 201);
  const served = await get(app, `/a/${uploaded.id}`);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get("content-type"), "image/png");
  assert.deepEqual(new Uint8Array(await served.arrayBuffer()), UPLOAD_BYTES);
});

test("however many assets are uploaded, one reserved session owns them all", async () => {
  const { app, store } = await seed();
  const upload = (bytes: Uint8Array) =>
    ownerPost(app, "/api/owner/assets", { data: encodeBase64(bytes) });

  for (const byte of [10, 11, 12]) assert.equal((await upload(new Uint8Array([byte]))).status, 201);

  const reserved = (await store.listSessions()).filter(
    (session) => session.agent === PUBLICATION_ASSET_AGENT,
  );
  assert.equal(reserved.length, 1);
  assert.equal(reserved[0].title, "Published assets");

  // A fresh runtime over the same store adopts the existing session instead of
  // minting a second one.
  const restarted = createPublicApp({
    store,
    ownerToken: OWNER_TOKEN,
    visitorSecret: VISITOR_SECRET,
  });
  assert.equal(
    (
      await ownerPost(restarted, "/api/owner/assets", {
        data: encodeBase64(new Uint8Array([13])),
      })
    ).status,
    201,
  );
  assert.equal(
    (await store.listSessions()).filter((s) => s.agent === PUBLICATION_ASSET_AGENT).length,
    1,
  );
});

// --- 17. the rendered publication page ----------------------------------

test("GET /v/:slug serves the publication under a strict nonce CSP", async () => {
  const { app, snapshot } = await seed();
  const res = await get(app, "/v/demo-slug");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/html/);
  assert.equal(res.headers.get("cache-control"), "private, no-store");

  const csp = res.headers.get("content-security-policy") ?? "";
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'nonce-[0-9a-f]{32}'/);
  assert.match(csp, /style-src 'nonce-[0-9a-f]{32}'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(csp.includes("unsafe-inline"), false);
  assert.equal(csp.includes("unsafe-eval"), false);

  const html = await res.text();
  const nonce = /script-src 'nonce-([0-9a-f]+)'/.exec(csp)?.[1];
  assert.ok(nonce);
  assert.ok(html.includes(`<script nonce="${nonce}">`), "the page uses this response's nonce");
  assert.match(html, /<h1>Quarterly report<\/h1>/);
  assert.match(html, /<div class="who">Edu<\/div>/);
  // The seeded html surface is referenced, never inlined.
  assert.equal(html.includes(HTML_MARKUP), false);
  assert.match(html, /src="\/api\/v\/demo-slug\/s\/0\/0\?fb=1"/);
  assert.ok(html.includes(snapshot.id), "trackOpens wires the snapshot id into the page");

  // Two responses never reuse a nonce.
  const other = await get(app, "/v/demo-slug");
  assert.notEqual(
    other.headers.get("content-security-policy"),
    res.headers.get("content-security-policy"),
  );
});

test("a locked link renders the password gate, not an error", async () => {
  const { app } = await seed({ withPassword: true });
  const res = await get(app, "/v/demo-slug");
  assert.equal(res.status, 200, "the gate is a usable page, not a 401");
  assert.match(res.headers.get("content-type") ?? "", /text\/html/);
  const html = await res.text();
  assert.match(html, /<title>Protected<\/title>/);
  assert.match(html, /type="password"/);
  assert.equal(html.includes("Quarterly report"), false, "nothing behind the gate leaks");
});

test("unknown, revoked and expired slugs render one byte-identical page", async () => {
  const { app, publications, link, publication } = await seed();
  const unknown = await get(app, "/v/never-existed");
  assert.equal(unknown.status, 404);
  const body = await unknown.text();

  const expiredLink = await publications.createShareLink({
    publicationId: publication.id,
    slug: "expired-page",
    expiresAt: "2000-01-01T00:00:00.000Z",
  });
  assert.ok(expiredLink);
  const expired = await get(app, "/v/expired-page");
  assert.equal(expired.status, 404);

  await publications.updateShareLink(link.id, { revokedAt: new Date().toISOString() });
  const revoked = await get(app, "/v/demo-slug");
  assert.equal(revoked.status, 404);

  const revokedBody = await revoked.text();
  const expiredBody = await expired.text();
  assert.equal(revokedBody, body);
  assert.equal(expiredBody, body);
  assert.equal(body.includes("Quarterly report"), false);
  assert.match(body, /This link is not available\./);
});

// --- 18. the neutral viewer (issue #7) ----------------------------------

// The product name must not appear in a served client page AT ALL — not in the
// markup and not in an internal identifier inside the inline script. This used
// to allow a handful of storage keys and the surface bridge's postMessage
// marker through; a production smoke test flagged them, so the storage keys are
// now neutral and the page trusts frame IDENTITY rather than the marker (which
// was always the real control).
function assertNeutralDocument(html: string, label: string) {
  assert.equal(/sideshow/i.test(html), false, `${label}: product name in the page`);
  for (const marker of [
    "/api/sessions",
    "/api/posts",
    "/api/comments",
    "/api/events",
    "/api/publications",
    "/api/owner",
    "/mcp",
    "/setup",
    "/guide",
    "/connect",
    "session",
    "workspace",
    "viewer/dist",
  ]) {
    assert.equal(html.toLowerCase().includes(marker), false, `${label}: leaked ${marker}`);
  }
  assert.equal(/<script[^>]+src=/i.test(html), false, `${label}: an external script`);
  assert.equal(/<link[^>]+href=/i.test(html), false, `${label}: an external stylesheet`);
}

test("the publication, gate and not-found pages are all neutral", async () => {
  const { app } = await seed();
  assertNeutralDocument(await (await get(app, "/v/demo-slug")).text(), "publication");
  assertNeutralDocument(await (await get(app, "/v/never-existed")).text(), "not found");

  const locked = await seed({ withPassword: true });
  assertNeutralDocument(await (await get(locked.app, "/v/demo-slug")).text(), "gate");
});

test("the identity header is off by default and served with its avatar when set", async () => {
  const store = new SqlStore(createSqliteStorage());
  const publications = store.publications!;
  const session = await store.createSession({ agent: "pi" });
  const avatar = await store.putAsset({
    sessionId: session.id,
    kind: "image",
    contentType: "image/png",
    data: new Uint8Array([1, 2, 3, 4]),
  });
  assert.ok(avatar);
  const stranger = await store.putAsset({
    sessionId: session.id,
    kind: "image",
    contentType: "image/png",
    data: new Uint8Array([5, 6, 7, 8]),
  });
  assert.ok(stranger);
  const publication = await publications.createPublication({ kind: "post", title: "Neutral" });
  await publications.createSnapshot({
    publicationId: publication.id,
    items: [{ postId: "p", title: "t", version: 1, surfaces: [{ kind: "json", data: 1 }] }],
  });
  await publications.createShareLink({ publicationId: publication.id, slug: "ident-slug" });
  const app = createPublicApp({ store, ownerToken: OWNER_TOKEN, visitorSecret: VISITOR_SECRET });

  // Off by default: a publication created without an identity renders none.
  const bare = await (await get(app, "/v/ident-slug")).text();
  assert.equal(bare.includes('header class="identity"'), false);
  // And its avatar route is closed until a publication points at the asset.
  assert.equal((await get(app, `/a/${avatar.id}`)).status, 404);

  await publications.updatePublication(publication.id, {
    identity: {
      name: "Edu Wass",
      avatarAssetId: avatar.id,
      linkUrl: "https://example.com/edu",
      linkLabel: "example.com",
    },
  });
  const withIdentity = await (await get(app, "/v/ident-slug")).text();
  assert.match(withIdentity, /<header class="identity"><img src="\/a\/[0-9a-f]+" alt="">/);
  assert.ok(withIdentity.includes(`/a/${avatar.id}`));
  assert.match(withIdentity, /<div class="who">Edu Wass<\/div>/);
  assert.match(
    withIdentity,
    /<a href="https:\/\/example\.com\/edu" rel="noopener noreferrer nofollow" target="_blank">example\.com<\/a>/,
  );
  // Exactly one link, so an identity header can never become a link farm.
  assert.equal(withIdentity.split("<a href=").length - 1, 1);

  // The avatar is now reachable even though no snapshot pins it — but an asset
  // that is neither pinned nor an avatar stays closed.
  const served = await get(app, `/a/${avatar.id}`);
  assert.equal(served.status, 200);
  assert.deepEqual(new Uint8Array(await served.arrayBuffer()), new Uint8Array([1, 2, 3, 4]));
  assert.equal((await get(app, `/a/${stranger.id}`)).status, 404);
});

test("nothing lists publications or share links without the owner token", async () => {
  const { app, publication, link, snapshot } = await seed();
  const paths = [
    "/api/v",
    "/api/v/",
    "/v",
    "/v/",
    "/api",
    "/api/publications",
    "/api/links",
    "/api/snapshots",
    "/api/owner",
    "/api/owner/publications",
    "/api/owner/publications/",
    `/api/owner/publications/${publication.id}`,
    `/api/owner/publications/${publication.id}/links`,
    `/api/owner/links/${link.id}`,
    `/api/owner/snapshots/${snapshot.id}`,
    "/api/v/demo-slug/links",
    "/api/v/demo-slug/publications",
    "/publications",
    "/links",
    "/sitemap.xml",
    "/.well-known/publications",
  ];
  for (const path of paths) {
    const res = await get(app, path);
    assert.ok([401, 404].includes(res.status), `${path} answered ${res.status}`);
    const body = await res.text();
    for (const secret of [publication.id, link.id, link.slug, snapshot.id, RECIPIENT]) {
      assert.equal(body.includes(secret), false, `${path} leaked ${secret}`);
    }
  }
});

test("every public response is noindex, in the header and on the page", async () => {
  const { app, asset } = await seed({ withPassword: false });
  for (const path of [
    "/v/demo-slug",
    "/v/never-existed",
    "/api/v/demo-slug",
    `/api/v/demo-slug/s/0/${HTML}`,
    `/a/${asset.id}`,
    "/robots.txt",
  ]) {
    const res = await get(app, path);
    assert.match(res.headers.get("x-robots-tag") ?? "", /noindex/, path);
  }
  // The HTML pages say it a second time, for a crawler that reads only markup.
  for (const path of ["/v/demo-slug", "/v/never-existed"]) {
    const html = await (await get(app, path)).text();
    assert.match(html, /<meta name="robots" content="noindex/, path);
  }
  const gate = await seed({ withPassword: true });
  assert.match(
    await (await get(gate.app, "/v/demo-slug")).text(),
    /<meta name="robots" content="noindex/,
  );
  assert.equal(await (await get(app, "/robots.txt")).text(), "User-agent: *\nDisallow: /\n");
});

// Every stable surface kind, end to end: the sandboxed ones as their own
// documents, the data ones as escaped nodes in the page.
const RENDERED: [number, RegExp[]][] = [
  [HTML, [/<p id="seeded-markup">hello from the publication<\/p>/]],
  [MARKDOWN, [/<h1>Heading<\/h1>/, /<strong>prose<\/strong>/]],
  [CODE, [/class="shiki/, /<span style="color:/]],
  [TERMINAL, [/class="term-body"/, /\$ npm test/]],
  [DIFF, [/<diffs-container>/, /shadowrootmode="open"/]],
  [MERMAID, [/https:\/\/esm\.sh\/mermaid@11/, /mermaid\.render\(/]],
];

test("every stable surface kind renders its own output in its own sandboxed document", async () => {
  const { app } = await seed();
  for (const [index, markers] of RENDERED) {
    const res = await get(app, `/api/v/demo-slug/s/0/${index}`);
    assert.equal(res.status, 200, `surface ${index}`);
    assert.equal(res.headers.get("content-security-policy"), "sandbox allow-scripts", `${index}`);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff", `${index}`);
    const body = await res.text();
    for (const marker of markers) assert.match(body, marker, `surface ${index}`);
  }

  // image and json have no HTML sink, so they are never served as documents —
  // they are escaped into the page instead.
  for (const index of [IMAGE, JSON_]) {
    assert.equal((await get(app, `/api/v/demo-slug/s/0/${index}`)).status, 404, `${index}`);
  }
  const page = await (await get(app, "/v/demo-slug")).text();
  assert.match(
    page,
    /<figure class="surface"><img src="\/a\/[0-9a-f]+" alt="a png" loading="lazy">/,
  );
  assert.match(page, /<figcaption>figure 1<\/figcaption>/);
  assert.match(page, /<div class="surface"><pre>\{\n  &quot;answer&quot;: 42\n\}<\/pre><\/div>/);
  // One iframe per sandboxed surface and not one more.
  assert.equal(page.split("<iframe").length - 1, RENDERED.length);
});

test("a themed surface renders differently per mode, and an unknown mode falls back", async () => {
  const { app } = await seed();
  for (const [index] of RENDERED) {
    const base = await (await get(app, `/api/v/demo-slug/s/0/${index}`)).text();
    const light = await (await get(app, `/api/v/demo-slug/s/0/${index}?mode=light`)).text();
    const dark = await (await get(app, `/api/v/demo-slug/s/0/${index}?mode=dark`)).text();
    assert.notEqual(light, dark, `surface ${index} ignores mode`);
    // Anything else is not an error: it renders the unpinned document, which
    // follows the reader's own system scheme.
    const bogus = await get(app, `/api/v/demo-slug/s/0/${index}?mode=sideways`);
    assert.equal(bogus.status, 200, `surface ${index}`);
    assert.equal(await bogus.text(), base, `surface ${index} bogus mode`);
  }
});

test("a script inside an html surface exists only in the sandboxed document", async () => {
  const store = new SqlStore(createSqliteStorage());
  const publications = store.publications!;
  const publication = await publications.createPublication({ kind: "post", title: "Scripted" });
  await publications.createSnapshot({
    publicationId: publication.id,
    items: [
      {
        postId: "p",
        title: "t",
        version: 1,
        surfaces: [{ kind: "html", html: `<script>window.__pwned = 1;</script><p>hi</p>` }],
      },
    ],
  });
  await publications.createShareLink({ publicationId: publication.id, slug: "script-slug" });
  const app = createPublicApp({ store, ownerToken: OWNER_TOKEN, visitorSecret: VISITOR_SECRET });

  const page = await (await get(app, "/v/script-slug")).text();
  assert.equal(page.includes("__pwned"), false, "agent script reached the trusted page");
  assert.equal(page.split("<script").length - 1, 1, "only the page's own nonced script");
  assert.match(
    page,
    /<iframe data-surface data-item="0" data-si="0" sandbox="allow-scripts allow-popups"/,
  );
  assert.equal(page.includes("allow-same-origin"), false);

  const document = await get(app, "/api/v/script-slug/s/0/0");
  assert.equal(document.headers.get("content-security-policy"), "sandbox allow-scripts");
  assert.ok((await document.text()).includes("__pwned"), "the script lives in the sandbox");
});
