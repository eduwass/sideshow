import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../server/app.ts";
import { MAX_PASSWORD_BYTES } from "../server/passwords.ts";
import { createPublicApp, MAX_RECIPIENT_LABEL_LENGTH } from "../server/publicApp.ts";
import {
  isValidCustomSlug,
  newShareToken,
  type PublicationStore,
  type ShareLink,
  shareLinkState,
  type Snapshot,
} from "../server/publicationTypes.ts";
import { createSqliteStorage } from "../server/sqliteStorage.ts";
import { SqlStore } from "../server/sqlStore.ts";
import { JsonFileStore } from "../server/storage.ts";
import type { SqlStorage } from "../server/types.ts";
import { DEST_ORIGIN, json, makeStack, OWNER_TOKEN, patch, type TestApp } from "./publishStack.ts";

// Share-link management and access controls (GitHub issue #6).
//
// Every assertion here is adversarial by intent: the interesting failures are
// a plaintext password reaching storage or the wire, an expired link that is
// still readable, a recipient label leaking to the recipient, and a duplicated
// link that shares state with its source.

const ORIGIN = "http://pub.example";
const VISITOR_SECRET = "visitor-secret";
const AUTH = { authorization: `Bearer ${OWNER_TOKEN}` };
const PASSWORD_A = "correct-horse-battery";
const PASSWORD_B = "second-passphrase-42";
const PASSWORD_C = "third-passphrase-99";
const RECIPIENT = "Acme Corp — Dana Owner-Only";
const PAST = "2020-01-01T00:00:00.000Z";
const FUTURE = "2099-01-01T00:00:00.000Z";

/**
 * Wraps a Hono app so every response body this test ever sees is retained. The
 * password and recipient-label criteria are "appears in NO response", which is
 * only meaningful if the check covers every call the test made.
 */
function recorder(app: { request: TestApp["request"] }) {
  const bodies: string[] = [];
  const call = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const res = await app.request(`${ORIGIN}${path}`, init);
    bodies.push(await res.clone().text());
    return res;
  };
  const send = (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    call(path, {
      method,
      headers: { "content-type": "application/json", ...headers },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  return {
    bodies,
    /** One request, exactly as given. */
    raw: call,
    get: (path: string, headers?: Record<string, string>) => call(path, { headers }),
    post: (path: string, body?: unknown, headers?: Record<string, string>) =>
      send("POST", path, body, headers),
    ownerGet: (path: string) => call(path, { headers: AUTH }),
    ownerPost: (path: string, body?: unknown) => send("POST", path, body, AUTH),
    ownerPatch: (path: string, body?: unknown) => send("PATCH", path, body, AUTH),
    ownerDelete: (path: string) => send("DELETE", path, undefined, AUTH),
    /** Assert a secret never appeared in anything this app answered. */
    assertNeverLeaked(secret: string, what: string) {
      for (const body of bodies) {
        assert.equal(body.includes(secret), false, `${what} leaked in a response body`);
      }
    },
  };
}

type Recorder = ReturnType<typeof recorder>;

interface PublicFixture {
  storage: SqlStorage;
  publications: PublicationStore;
  publication: { id: string };
  snapshot: Snapshot;
  api: Recorder;
}

// `terminal` renders without shiki, so the surface-document route stays cheap;
// `json` is the native (non-sandboxed) counterpart.
async function seedPublic(): Promise<PublicFixture> {
  const storage = createSqliteStorage();
  const store = new SqlStore(storage);
  const publications = store.publications;
  assert.ok(publications, "SqlStore must support publications");
  const publication = await publications.createPublication({
    kind: "post",
    title: "Quarterly report",
  });
  const snapshot = await publications.createSnapshot({
    publicationId: publication.id,
    items: [
      {
        postId: "post-1",
        title: "Frozen post",
        version: 1,
        surfaces: [
          { kind: "terminal", text: "$ npm test\nok\n" },
          { kind: "json", data: { answer: 42 } },
        ],
      },
    ],
  });
  assert.ok(snapshot);
  const app = createPublicApp({ store, ownerToken: OWNER_TOKEN, visitorSecret: VISITOR_SECRET });
  return { storage, publications, publication, snapshot, api: recorder(app) };
}

const linksPath = (publicationId: string) => `/api/owner/publications/${publicationId}/links`;

/** Create one share link through the owner API and hand back the owner view. */
async function makeLink(
  f: PublicFixture,
  body: Record<string, unknown> = {},
): Promise<ShareLink & { hasPassword: boolean }> {
  const res = await f.api.ownerPost(linksPath(f.publication.id), body);
  assert.equal(res.status, 201, await res.clone().text());
  return (await res.json()) as ShareLink & { hasPassword: boolean };
}

const cookieFrom = (res: Response): string => {
  const raw = res.headers.get("set-cookie");
  assert.ok(raw, "expected an unlock cookie");
  return raw.split(";")[0];
};

const withCookie = (cookie: string) => ({ cookie });

const pointAnchor = { kind: "point", itemIndex: 0, surfaceIndex: 0, x: 0.5, y: 0.5 };

// --- 1. unguessable by default ------------------------------------------

test("a generated share token carries 128 bits of url-safe entropy", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 1000; i++) {
    const token = newShareToken();
    assert.match(token, /^[A-Za-z0-9_-]{22}$/, token);
    seen.add(token);
  }
  assert.equal(seen.size, 1000, "1000 generated slugs must all be distinct");
});

test("a share link created without a slug gets a generated capability token", async () => {
  const f = await seedPublic();
  const generated = await makeLink(f);
  assert.equal(generated.custom, false);
  assert.match(generated.slug, /^[A-Za-z0-9_-]{22}$/);

  const custom = await makeLink(f, { slug: "q3-review" });
  assert.equal(custom.custom, true);
  assert.equal(custom.slug, "q3-review");
});

// --- 2. custom slugs are valid, unique and non-secret --------------------

test("isValidCustomSlug accepts only a conservative lowercase alphabet", () => {
  for (const slug of ["q3-review", "acme", "a1b", "abc", "a".repeat(64), "0-9"]) {
    assert.equal(isValidCustomSlug(slug), true, JSON.stringify(slug));
  }
  const rejected: unknown[] = [
    "Q3-Review", // uppercase
    "ACME",
    "-acme", // leading dash
    "acme-", // trailing dash
    "a", // one character
    "ab", // two characters
    "a".repeat(65), // 65+ characters
    "a".repeat(200),
    "my report", // space
    " acme",
    "acme ",
    "a/b", // slash
    "a.b", // dot
    "acme.report",
    "acme_report", // underscore is not in the custom alphabet
    "",
    7,
    null,
    undefined,
    {},
    ["acme"],
  ];
  for (const slug of rejected) {
    assert.equal(isValidCustomSlug(slug), false, JSON.stringify(slug) ?? String(slug));
  }
});

test("a taken custom slug is a 409 through the owner API and through the private route", async () => {
  const f = await seedPublic();
  await makeLink(f, { slug: "acme" });

  const clash = await f.api.ownerPost(linksPath(f.publication.id), { slug: "acme" });
  assert.equal(clash.status, 409);
  assert.deepEqual(await clash.json(), { error: "that link address is already taken" });

  // Same rule when the owner acts through the private control plane.
  const stack = makeStack();
  const { publicationId } = await publishFixturePost(stack);
  const first = await stack.app.request(
    `/api/publications/${publicationId}/links`,
    json({ slug: "shared-name" }),
  );
  assert.equal(first.status, 200);
  const second = await stack.app.request(
    `/api/publications/${publicationId}/links`,
    json({ slug: "shared-name" }),
  );
  assert.equal(second.status, 502);
  assert.deepEqual(await second.json(), { error: "that link address is already taken" });

  // A duplicate that asks for a taken slug is refused the same way.
  const duplicate = await f.api.ownerPost(`/api/owner/links/${(await makeLink(f)).id}/duplicate`, {
    slug: "acme",
  });
  assert.equal(duplicate.status, 409);
});

// --- 3. passwords are memory-hard and never persist or log in plaintext ---

test("a password is stored only as a scrypt hash and never reaches the wire", async () => {
  const f = await seedPublic();
  const link = await makeLink(f, { recipientLabel: RECIPIENT });
  assert.equal(link.hasPassword, false);

  const patched = await f.api.ownerPatch(`/api/owner/links/${link.id}`, { password: PASSWORD_A });
  assert.equal(patched.status, 200);
  const view = (await patched.json()) as Record<string, unknown>;
  assert.equal(view.hasPassword, true);
  assert.equal("passwordHash" in view, false, "the owner sees only whether a password is set");

  // The raw row: no plaintext anywhere in it, and a memory-hard encoding.
  const rows = f.storage.exec("SELECT * FROM share_links WHERE id = ?", link.id).toArray();
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(
    JSON.stringify(row).includes(PASSWORD_A),
    false,
    "the plaintext password must not be stored",
  );
  assert.equal(typeof row.passwordHash, "string");
  assert.ok(
    (row.passwordHash as string).startsWith("scrypt$16384$8$1$"),
    `expected scrypt N=16384 r=8 p=1, got ${String(row.passwordHash).slice(0, 24)}`,
  );

  // Exercise the owner and public surfaces, then prove neither ever echoed the
  // plaintext or the stored hash.
  const hash = row.passwordHash as string;
  await f.api.ownerGet(`/api/owner/links/${link.id}`);
  await f.api.ownerGet(linksPath(f.publication.id));
  await f.api.ownerGet(`/api/owner/publications/${f.publication.id}`);
  await f.api.ownerGet("/api/owner/publications");
  await f.api.get(`/api/v/${link.slug}`);
  await f.api.get(`/v/${link.slug}`);
  await f.api.get(`/api/v/${link.slug}/s/0/0`);
  await f.api.post(`/api/v/${link.slug}/unlock`, { password: "wrong" });
  const unlocked = await f.api.post(`/api/v/${link.slug}/unlock`, { password: PASSWORD_A });
  assert.equal(unlocked.status, 200);
  await f.api.post(`/api/v/${link.slug}/open`, {}, withCookie(cookieFrom(unlocked)));

  f.api.assertNeverLeaked(PASSWORD_A, "the plaintext password");
  f.api.assertNeverLeaked(hash, "the stored password hash");
  f.api.assertNeverLeaked("passwordHash", "the passwordHash field name");
  f.api.assertNeverLeaked("scrypt$", "encoded hash material");
});

test("a non-string password is refused rather than coerced", async () => {
  const f = await seedPublic();
  const link = await makeLink(f);
  const res = await f.api.ownerPatch(`/api/owner/links/${link.id}`, { password: 7 });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "invalid password" });
  const after = (await (await f.api.ownerGet(`/api/owner/links/${link.id}`)).json()) as {
    hasPassword: boolean;
  };
  assert.equal(after.hasPassword, false);
});

test("a password beyond the scrypt input cap is a 400, not a crash", async () => {
  const f = await seedPublic();
  const tooLong = "p".repeat(MAX_PASSWORD_BYTES + 1);

  const created = await f.api.ownerPost(linksPath(f.publication.id), { password: tooLong });
  assert.equal(created.status, 400);
  assert.deepEqual(await created.json(), { error: "password too long" });

  const link = await makeLink(f);
  const patched = await f.api.ownerPatch(`/api/owner/links/${link.id}`, { password: tooLong });
  assert.equal(patched.status, 400);
  assert.deepEqual(await patched.json(), { error: "password too long" });
  assert.equal(
    (
      (await (await f.api.ownerGet(`/api/owner/links/${link.id}`)).json()) as {
        hasPassword: boolean;
      }
    ).hasPassword,
    false,
    "a refused password must not be half-applied",
  );

  // Exactly at the cap still works.
  const atCap = await f.api.ownerPost(linksPath(f.publication.id), {
    password: "p".repeat(MAX_PASSWORD_BYTES),
  });
  assert.equal(atCap.status, 201);
});

test("a recipient label is bounded the same way on create, patch and duplicate", async () => {
  const f = await seedPublic();
  const huge = "L".repeat(5000);

  const created = await makeLink(f, { recipientLabel: huge });
  assert.equal(created.recipientLabel?.length, MAX_RECIPIENT_LABEL_LENGTH);

  const patched = (await (
    await f.api.ownerPatch(`/api/owner/links/${created.id}`, { recipientLabel: huge })
  ).json()) as ShareLink;
  assert.equal(patched.recipientLabel?.length, MAX_RECIPIENT_LABEL_LENGTH);

  const copy = (await (
    await f.api.ownerPost(`/api/owner/links/${created.id}/duplicate`, { recipientLabel: huge })
  ).json()) as ShareLink;
  assert.equal(copy.recipientLabel?.length, MAX_RECIPIENT_LABEL_LENGTH);
});

// --- 4. changing a password invalidates outstanding unlocks --------------

test("setting, changing and clearing a password rotates every outstanding unlock", async () => {
  const f = await seedPublic();
  const link = await makeLink(f, { password: PASSWORD_A });
  assert.equal(link.hasPassword, true);

  // Locked without a cookie.
  const locked = await f.api.get(`/api/v/${link.slug}`);
  assert.equal(locked.status, 401);
  assert.deepEqual(await locked.json(), { error: "password required", passwordRequired: true });

  const unlockA = await f.api.post(`/api/v/${link.slug}/unlock`, { password: PASSWORD_A });
  assert.equal(unlockA.status, 200);
  const cookieA = cookieFrom(unlockA);
  assert.equal((await f.api.get(`/api/v/${link.slug}`, withCookie(cookieA))).status, 200);

  // Change the password: the cookie is bound to the hash, so it dies with it.
  assert.equal(
    (await f.api.ownerPatch(`/api/owner/links/${link.id}`, { password: PASSWORD_B })).status,
    200,
  );
  assert.equal(
    (await f.api.get(`/api/v/${link.slug}`, withCookie(cookieA))).status,
    401,
    "an outstanding unlock must not survive a password change",
  );
  assert.equal(
    (await f.api.post(`/api/v/${link.slug}/unlock`, { password: PASSWORD_A })).status,
    401,
    "the old password must stop working",
  );
  const unlockB = await f.api.post(`/api/v/${link.slug}/unlock`, { password: PASSWORD_B });
  assert.equal(unlockB.status, 200);
  const cookieB = cookieFrom(unlockB);
  assert.notEqual(cookieB, cookieA);
  assert.equal((await f.api.get(`/api/v/${link.slug}`, withCookie(cookieB))).status, 200);

  // Re-setting the SAME password still rotates (fresh salt, fresh hash).
  assert.equal(
    (await f.api.ownerPatch(`/api/owner/links/${link.id}`, { password: PASSWORD_B })).status,
    200,
  );
  assert.equal((await f.api.get(`/api/v/${link.slug}`, withCookie(cookieB))).status, 401);

  // Clearing it opens the link with no cookie at all.
  const cleared = await f.api.ownerPatch(`/api/owner/links/${link.id}`, { password: null });
  assert.equal(((await cleared.json()) as { hasPassword: boolean }).hasPassword, false);
  assert.equal((await f.api.get(`/api/v/${link.slug}`)).status, 200);
  // And a stale cookie is simply ignored rather than trusted.
  assert.equal((await f.api.get(`/api/v/${link.slug}`, withCookie(cookieA))).status, 200);
});

// --- 5. expired or revoked links fail closed ----------------------------

/** Every public entry point a share-link holder can reach, as (path, init). */
const publicProbes = (slug: string, snapshotId: string): [string, RequestInit][] => [
  [`/api/v/${slug}`, {}],
  [`/v/${slug}`, {}],
  [`/api/v/${slug}/s/0/0`, {}],
  [
    `/api/v/${slug}/open`,
    { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
  ],
  [
    `/api/v/${slug}/feedback`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ note: "hi", name: "Zoe", snapshotId, anchor: pointAnchor }),
    },
  ],
];

test("an expired or revoked link is indistinguishable from an unknown slug", async () => {
  const f = await seedPublic();
  const live = await makeLink(f, { expiresAt: FUTURE });
  const expired = await makeLink(f, { expiresAt: FUTURE });
  const revoked = await makeLink(f, { expiresAt: FUTURE });

  const app = f.api;

  // Baseline: every probe succeeds while the link is live.
  for (const [path, init] of publicProbes(live.slug, f.snapshot.id)) {
    const res = await app.raw(path, init);
    assert.ok(res.status < 400, `${path} should work on a live link (got ${res.status})`);
  }

  assert.equal(
    (await app.ownerPatch(`/api/owner/links/${expired.id}`, { expiresAt: PAST })).status,
    200,
  );
  assert.equal(
    (await app.ownerPatch(`/api/owner/links/${revoked.id}`, { revoked: true })).status,
    200,
  );

  const unknown = await probeResponses(app, "no-such-slug-at-all", f.snapshot.id);
  const expiredOut = await probeResponses(app, expired.slug, f.snapshot.id);
  const revokedOut = await probeResponses(app, revoked.slug, f.snapshot.id);
  for (let i = 0; i < unknown.length; i++) {
    assert.deepEqual(
      expiredOut[i],
      unknown[i],
      `expired link differs from an unknown slug at probe ${i}`,
    );
    assert.deepEqual(
      revokedOut[i],
      unknown[i],
      `revoked link differs from an unknown slug at probe ${i}`,
    );
    assert.ok(unknown[i].status >= 400, `probe ${i} must fail closed`);
  }

  // Un-revoking brings the link back; the expired one stays shut until re-dated.
  assert.equal(
    (await app.ownerPatch(`/api/owner/links/${revoked.id}`, { revoked: false })).status,
    200,
  );
  assert.equal((await app.get(`/api/v/${revoked.slug}`)).status, 200);
  assert.equal((await app.get(`/api/v/${expired.slug}`)).status, 404);
  assert.equal(
    (await app.ownerPatch(`/api/owner/links/${expired.id}`, { expiresAt: null })).status,
    200,
  );
  assert.equal((await app.get(`/api/v/${expired.slug}`)).status, 200);

  // An expiry that is not a date is refused rather than stored.
  for (const expiresAt of ["not-a-date", 7, {}, true]) {
    const res = await app.ownerPatch(`/api/owner/links/${live.id}`, { expiresAt });
    assert.equal(res.status, 400, JSON.stringify(expiresAt));
    assert.deepEqual(await res.json(), { error: "invalid expiry" });
  }
  assert.equal((await app.get(`/api/v/${live.slug}`)).status, 200);
});

// --- 6. recipient labels are owner-only ---------------------------------

test("a recipient label reaches the owner and never the recipient", async () => {
  const f = await seedPublic();
  const link = await makeLink(f, { recipientLabel: RECIPIENT });
  assert.equal(link.recipientLabel, RECIPIENT);

  const ownerBodies: string[] = [];
  for (const path of [
    `/api/owner/links/${link.id}`,
    linksPath(f.publication.id),
    `/api/owner/publications/${f.publication.id}`,
  ]) {
    ownerBodies.push(await (await f.api.ownerGet(path)).text());
  }
  for (const body of ownerBodies) {
    assert.ok(body.includes(RECIPIENT), "the owner surface must show the recipient label");
  }

  // Everything a share-link holder can reach.
  const publicBodies: string[] = [];
  publicBodies.push(await (await f.api.get(`/api/v/${link.slug}`)).text());
  publicBodies.push(await (await f.api.get(`/v/${link.slug}`)).text());
  publicBodies.push(await (await f.api.get(`/api/v/${link.slug}/s/0/0`)).text());
  publicBodies.push(await (await f.api.post(`/api/v/${link.slug}/open`, {})).text());
  const submitted = await f.api.post(`/api/v/${link.slug}/feedback`, {
    note: "looks good",
    name: "Zoe Reader",
    snapshotId: f.snapshot.id,
    anchor: pointAnchor,
  });
  assert.equal(submitted.status, 201);
  publicBodies.push(await submitted.text());
  for (const body of publicBodies) {
    assert.equal(
      body.includes(RECIPIENT),
      false,
      "the recipient label must never be sent to the recipient",
    );
    assert.equal(body.includes("recipientLabel"), false);
  }

  // The label is not viewer identity: the stored submission carries the name the
  // submitter declared for themselves.
  const feedback = await f.publications.listFeedback({ shareLinkId: link.id });
  assert.equal(feedback.length, 1);
  assert.equal(feedback[0].name, "Zoe Reader");
  assert.equal(
    JSON.stringify(feedback[0]).includes(RECIPIENT),
    false,
    "external feedback must not be attributed to the owner's recipient label",
  );

  // A non-string label clears it rather than being coerced into one.
  const cleared = (await (
    await f.api.ownerPatch(`/api/owner/links/${link.id}`, { recipientLabel: 42 })
  ).json()) as { recipientLabel: string | null };
  assert.equal(cleared.recipientLabel, null);
});

// --- 7. duplication creates independent state ---------------------------

test("duplicating a link copies its settings but nothing else", async () => {
  const f = await seedPublic();
  const source = await makeLink(f, {
    password: PASSWORD_A,
    expiresAt: FUTURE,
    recipientLabel: RECIPIENT,
    trackOpens: true,
  });

  // Give the source real history: one confirmed open and one submission.
  const sourceUnlock = await f.api.post(`/api/v/${source.slug}/unlock`, { password: PASSWORD_A });
  const sourceCookie = cookieFrom(sourceUnlock);
  assert.equal(
    (await f.api.post(`/api/v/${source.slug}/open`, {}, withCookie(sourceCookie))).status,
    204,
  );
  assert.equal(
    (
      await f.api.post(
        `/api/v/${source.slug}/feedback`,
        { note: "from the source", name: "Zoe", snapshotId: f.snapshot.id, anchor: pointAnchor },
        withCookie(sourceCookie),
      )
    ).status,
    201,
  );

  const copyRes = await f.api.ownerPost(`/api/owner/links/${source.id}/duplicate`, {
    recipientLabel: "Beta Corp — Sam",
  });
  assert.equal(copyRes.status, 201);
  const copy = (await copyRes.json()) as ShareLink & { hasPassword: boolean };

  // A separate capability with the same access settings.
  assert.notEqual(copy.id, source.id);
  assert.notEqual(copy.slug, source.slug);
  assert.equal(copy.custom, false);
  assert.match(copy.slug, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(copy.hasPassword, true);
  assert.equal(copy.expiresAt, source.expiresAt);
  assert.equal(copy.trackOpens, source.trackOpens);
  assert.equal(copy.revokedAt, null);
  assert.equal(copy.recipientLabel, "Beta Corp — Sam");

  // The same password opens the copy — but the source's unlock cookie does not.
  assert.equal((await f.api.get(`/api/v/${copy.slug}`, withCookie(sourceCookie))).status, 401);
  const copyUnlock = await f.api.post(`/api/v/${copy.slug}/unlock`, { password: PASSWORD_A });
  assert.equal(copyUnlock.status, 200);
  const copyCookie = cookieFrom(copyUnlock);
  assert.equal((await f.api.get(`/api/v/${copy.slug}`, withCookie(copyCookie))).status, 200);

  // Analytics and feedback start empty on the copy and stay the source's.
  assert.equal((await f.publications.getOpenAggregate(copy.id)).totalOpens, 0);
  assert.equal((await f.publications.getOpenAggregate(copy.id)).uniqueVisitors, 0);
  assert.equal((await f.publications.listFeedback({ shareLinkId: copy.id })).length, 0);
  assert.equal((await f.publications.getOpenAggregate(source.id)).totalOpens, 1);
  assert.equal((await f.publications.listFeedback({ shareLinkId: source.id })).length, 1);

  // Feedback through the copy is attributed to the copy's share link.
  assert.equal(
    (
      await f.api.post(
        `/api/v/${copy.slug}/feedback`,
        { note: "from the copy", name: "Sam", snapshotId: f.snapshot.id, anchor: pointAnchor },
        withCookie(copyCookie),
      )
    ).status,
    201,
  );
  const copyFeedback = await f.publications.listFeedback({ shareLinkId: copy.id });
  assert.equal(copyFeedback.length, 1);
  assert.equal(copyFeedback[0].shareLinkId, copy.id);
  assert.equal(copyFeedback[0].note, "from the copy");
  assert.equal((await f.publications.listFeedback({ shareLinkId: source.id })).length, 1);

  // Changing the copy leaves the source untouched.
  const sourceBefore = await (await f.api.ownerGet(`/api/owner/links/${source.id}`)).text();
  await f.api.ownerPatch(`/api/owner/links/${copy.id}`, {
    password: PASSWORD_C,
    expiresAt: PAST,
    recipientLabel: "Renamed",
    revoked: true,
  });
  const sourceAfter = (await (
    await f.api.ownerGet(`/api/owner/links/${source.id}`)
  ).json()) as ShareLink;
  const before = JSON.parse(sourceBefore) as ShareLink;
  assert.deepEqual(sourceAfter, before, "the source must not move when the copy is edited");
  assert.equal((await f.api.get(`/api/v/${source.slug}`, withCookie(sourceCookie))).status, 200);
  assert.equal((await f.api.get(`/api/v/${copy.slug}`, withCookie(copyCookie))).status, 404);

  // Restore the copy, then revoke the SOURCE: the copy stays live.
  await f.api.ownerPatch(`/api/owner/links/${copy.id}`, {
    revoked: false,
    expiresAt: null,
    password: PASSWORD_A,
  });
  const copyCookie2 = cookieFrom(
    await f.api.post(`/api/v/${copy.slug}/unlock`, { password: PASSWORD_A }),
  );
  assert.equal((await f.api.get(`/api/v/${copy.slug}`, withCookie(copyCookie2))).status, 200);

  const copyBefore = await (await f.api.ownerGet(`/api/owner/links/${copy.id}`)).text();
  await f.api.ownerPatch(`/api/owner/links/${source.id}`, { revoked: true });
  assert.equal((await f.api.get(`/api/v/${source.slug}`, withCookie(sourceCookie))).status, 404);
  assert.equal(
    (await f.api.get(`/api/v/${copy.slug}`, withCookie(copyCookie2))).status,
    200,
    "revoking one recipient must never cut off another",
  );
  assert.deepEqual(
    (await (await f.api.ownerGet(`/api/owner/links/${copy.id}`)).json()) as ShareLink,
    JSON.parse(copyBefore) as ShareLink,
  );

  // Deleting the copy leaves the source (and its history) in place.
  assert.equal((await f.api.ownerDelete(`/api/owner/links/${copy.id}`)).status, 204);
  assert.equal((await f.api.ownerGet(`/api/owner/links/${copy.id}`)).status, 404);
  assert.equal((await f.api.ownerDelete(`/api/owner/links/${copy.id}`)).status, 404);
  assert.equal((await f.api.ownerGet(`/api/owner/links/${source.id}`)).status, 200);
  assert.equal((await f.publications.listFeedback({ shareLinkId: source.id })).length, 1);
});

test("owner link routes 404 for an unknown link id", async () => {
  const f = await seedPublic();
  assert.equal((await f.api.ownerGet("/api/owner/links/nope")).status, 404);
  assert.equal((await f.api.ownerPatch("/api/owner/links/nope", { revoked: true })).status, 404);
  assert.equal((await f.api.ownerPost("/api/owner/links/nope/duplicate", {})).status, 404);
  assert.equal((await f.api.ownerDelete("/api/owner/links/nope")).status, 404);
});

test("owner link routes demand the bearer token", async () => {
  const f = await seedPublic();
  const link = await makeLink(f);
  const probes: [string, RequestInit][] = [
    [`/api/owner/links/${link.id}`, {}],
    [`/api/owner/links/${link.id}`, { method: "PATCH", body: "{}" }],
    [`/api/owner/links/${link.id}/duplicate`, { method: "POST", body: "{}" }],
    [`/api/owner/links/${link.id}`, { method: "DELETE" }],
  ];
  for (const [path, init] of probes) {
    const res = await f.api.raw(path, {
      ...init,
      headers: { "content-type": "application/json" },
    });
    assert.equal(res.status, 401, `${init.method ?? "GET"} ${path}`);
  }
});

// --- 8. owner actions through the private service -----------------------

/** Publish one post through the private stack so a publication exists. */
async function publishFixturePost(stack: ReturnType<typeof makeStack>) {
  const session = await stack.privateStore.createSession({ agent: "pi", title: "work" });
  const created = await stack.app.request(
    "/api/posts",
    json({
      session: session.id,
      title: "Quarterly report",
      surfaces: [{ kind: "markdown", markdown: "# Q3\n\nprose" }],
    }),
  );
  assert.equal(created.status, 201);
  const post = (await created.json()) as { id: string };
  const published = await stack.app.request("/api/publish/post", json({ postId: post.id }));
  assert.equal(published.status, 201);
  return (await published.json()) as { publicationId: string; slug: string };
}

test("every owner publication route works end to end through the private service", async () => {
  const stack = makeStack();
  const bodies: string[] = [];
  const call = async (path: string, init?: RequestInit) => {
    const res = await stack.app.request(path, init);
    bodies.push(await res.clone().text());
    return res;
  };
  const { publicationId } = await publishFixturePost(stack);

  const list = await call("/api/publications");
  assert.equal(list.status, 200);
  const listed = (await list.json()) as { origin: string; publications: { id: string }[] };
  assert.equal(listed.origin, DEST_ORIGIN);
  assert.deepEqual(
    listed.publications.map((p) => p.id),
    [publicationId],
  );

  const detail = await call(`/api/publications/${publicationId}`);
  assert.equal(detail.status, 200);
  const read = (await detail.json()) as {
    origin: string;
    publication: { id: string; title: string };
    snapshots: { revision: number; itemCount: number }[];
    links: { id: string; slug: string; hasPassword: boolean }[];
  };
  assert.equal(read.origin, DEST_ORIGIN);
  assert.equal(read.publication.id, publicationId);
  assert.equal(read.snapshots.length, 1);
  assert.equal(read.links.length, 1);

  const retitled = await call(`/api/publications/${publicationId}`, patch({ title: "Renamed" }));
  assert.equal(retitled.status, 200);
  assert.equal(((await retitled.json()) as { title: string }).title, "Renamed");

  const created = await call(
    `/api/publications/${publicationId}/links`,
    json({ recipientLabel: RECIPIENT, expiresAt: FUTURE }),
  );
  assert.equal(created.status, 200);
  const link = (await created.json()) as ShareLink & { hasPassword: boolean };
  assert.equal(link.recipientLabel, RECIPIENT);
  assert.equal(link.hasPassword, false);

  const locked = await call(
    `/api/publications/links/${link.id}`,
    patch({ password: PASSWORD_A, trackOpens: false }),
  );
  assert.equal(locked.status, 200);
  const lockedView = (await locked.json()) as { hasPassword: boolean; trackOpens: boolean };
  assert.equal(lockedView.hasPassword, true);
  assert.equal(lockedView.trackOpens, false);

  const duplicated = await call(`/api/publications/links/${link.id}/duplicate`, json({}));
  assert.equal(duplicated.status, 200);
  const copy = (await duplicated.json()) as ShareLink & { hasPassword: boolean };
  assert.notEqual(copy.id, link.id);
  assert.equal(copy.hasPassword, true);

  // The copy really exists on the public runtime.
  const publicCopy = await stack.publicApp.request(`${DEST_ORIGIN}/api/owner/links/${copy.id}`, {
    headers: AUTH,
  });
  assert.equal(publicCopy.status, 200);

  const removedLink = await call(`/api/publications/links/${copy.id}`, { method: "DELETE" });
  assert.equal(removedLink.status, 204);
  assert.equal(
    (await stack.publicApp.request(`${DEST_ORIGIN}/api/owner/links/${copy.id}`, { headers: AUTH }))
      .status,
    404,
  );

  const removed = await call(`/api/publications/${publicationId}`, { method: "DELETE" });
  assert.equal(removed.status, 204);
  assert.equal(
    ((await (await call("/api/publications")).json()) as { publications: unknown[] }).publications
      .length,
    0,
  );

  // The destination's write token never travels back to the browser.
  for (const body of bodies) {
    assert.equal(body.includes(OWNER_TOKEN), false, "the destination token leaked to the client");
  }
});

test("owner publication routes report 503 with no destination configured", async () => {
  const app = makePrivateApp();
  const probes: [string, RequestInit][] = [
    ["/api/publications", {}],
    ["/api/publications/x", {}],
    ["/api/publications/x", { method: "PATCH", body: "{}" }],
    ["/api/publications/x", { method: "DELETE" }],
    ["/api/publications/x/links", { method: "POST", body: "{}" }],
    ["/api/publications/links/x", { method: "PATCH", body: "{}" }],
    ["/api/publications/links/x/duplicate", { method: "POST", body: "{}" }],
    ["/api/publications/links/x", { method: "DELETE" }],
  ];
  for (const [path, init] of probes) {
    const res = await app.request(path, {
      ...init,
      headers: { "content-type": "application/json" },
    });
    assert.equal(res.status, 503, `${init.method ?? "GET"} ${path}`);
    assert.deepEqual(await res.json(), { error: "no publication destination" });
  }
});

test("a destination 404 maps to 404 and any other failure to a token-free 502", async () => {
  const stack = makeStack();
  const { publicationId } = await publishFixturePost(stack);

  // Unknown ids: the destination's 404 is preserved as a 404.
  for (const [path, init] of [
    ["/api/publications/nope", {}],
    ["/api/publications/nope", { method: "PATCH", body: "{}" }],
    ["/api/publications/nope", { method: "DELETE" }],
    ["/api/publications/nope/links", { method: "POST", body: "{}" }],
    ["/api/publications/links/nope", { method: "PATCH", body: "{}" }],
    ["/api/publications/links/nope/duplicate", { method: "POST", body: "{}" }],
    ["/api/publications/links/nope", { method: "DELETE" }],
  ] as [string, RequestInit][]) {
    const res = await stack.app.request(path, {
      ...init,
      headers: { "content-type": "application/json" },
    });
    assert.equal(res.status, 404, `${init.method ?? "GET"} ${path}`);
    assert.deepEqual(await res.json(), { error: "not found" });
  }

  // A destination that fails otherwise — and echoes our own credential back in
  // its error, as a broken proxy can — becomes a 502 that carries neither.
  stack.setIntercept(() =>
    Response.json({ error: `upstream exploded with Bearer ${OWNER_TOKEN}` }, { status: 500 }),
  );
  for (const [path, init] of [
    ["/api/publications", {}],
    [`/api/publications/${publicationId}`, {}],
    [`/api/publications/${publicationId}/links`, { method: "POST", body: "{}" }],
    ["/api/publications/links/x", { method: "PATCH", body: "{}" }],
    ["/api/publications/links/x/duplicate", { method: "POST", body: "{}" }],
    ["/api/publications/links/x", { method: "DELETE" }],
    [`/api/publications/${publicationId}`, { method: "DELETE" }],
  ] as [string, RequestInit][]) {
    const res = await stack.app.request(path, {
      ...init,
      headers: { "content-type": "application/json" },
    });
    assert.equal(res.status, 502, `${init.method ?? "GET"} ${path}`);
    const body = await res.text();
    assert.equal(body.includes(OWNER_TOKEN), false, "the destination token leaked in a 502");
    assert.deepEqual(JSON.parse(body), { error: "destination returned 500" });
  }
});

// --- 9. route exposure --------------------------------------------------

function makePrivateApp(opts: { authToken?: string; publicRead?: "session" | "full" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sideshow-share-links-"));
  return createApp({
    store: new JsonFileStore(join(dir, "data.json")),
    viewerHtml: "<html><head></head><body>viewer</body></html>",
    guideMarkdown: "# guide",
    setupText: "# setup",
    ...opts,
  }) as unknown as TestApp;
}

test("no publication or publish route is readable on a public-read workspace", async () => {
  const token = "workspace-token";
  const app = makePrivateApp({ authToken: token, publicRead: "session" });
  const routes: [string, string][] = [
    ["GET", "/api/publications"],
    ["GET", "/api/publications/x"],
    ["PATCH", "/api/publications/x"],
    ["DELETE", "/api/publications/x"],
    ["POST", "/api/publications/x/links"],
    ["PATCH", "/api/publications/links/x"],
    ["POST", "/api/publications/links/x/duplicate"],
    ["DELETE", "/api/publications/links/x"],
    ["GET", "/api/publish/destination"],
    ["POST", "/api/publish/post"],
    ["POST", "/api/publish/session"],
    ["GET", "/api/publish/post/x"],
    ["GET", "/api/publish/session/x"],
    ["GET", "/api/publish/session/x/preview"],
  ];
  for (const [method, path] of routes) {
    const anonymous = await app.request(path, {
      method,
      headers: { "content-type": "application/json" },
      ...(method !== "GET" && { body: "{}" }),
    });
    assert.equal(anonymous.status, 401, `${method} ${path} must not be public-readable`);
    assert.deepEqual(await anonymous.json(), {
      error: "unauthorized — send Authorization: Bearer <token>",
    });

    const authenticated = await app.request(path, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      ...(method !== "GET" && { body: "{}" }),
    });
    assert.notEqual(authenticated.status, 401, `${method} ${path} must work with the token`);
  }
});

// --- 10. a malformed stored expiry fails closed -------------------------

test("shareLinkState fails closed on an unparseable expiry, over HTTP too", async () => {
  assert.equal(shareLinkState({ revokedAt: null, expiresAt: "not-a-date" }), "expired");
  assert.equal(shareLinkState({ revokedAt: null, expiresAt: "" }), "active");
  assert.equal(shareLinkState({ revokedAt: null, expiresAt: null }), "active");
  assert.equal(shareLinkState({ revokedAt: PAST, expiresAt: null }), "revoked");
  assert.equal(shareLinkState({ revokedAt: null, expiresAt: FUTURE }), "active");

  const f = await seedPublic();
  const link = await makeLink(f, { expiresAt: FUTURE });
  assert.equal((await f.api.get(`/api/v/${link.slug}`)).status, 200);

  // A row corrupted underneath the API (or written by an older schema) must not
  // read as an open link.
  f.storage.exec("UPDATE share_links SET expiresAt = ? WHERE id = ?", "garbage", link.id);
  for (const [path, init] of publicProbes(link.slug, f.snapshot.id)) {
    const res = await f.api.raw(path, init);
    assert.equal(res.status, 404, `${path} must fail closed on a malformed expiry`);
  }
});

/** Status + body for every public probe against one slug. */
async function probeResponses(api: Recorder, slug: string, snapshotId: string) {
  const out: { status: number; body: string }[] = [];
  for (const [path, init] of publicProbes(slug, snapshotId)) {
    const res = await api.raw(path, init);
    out.push({ status: res.status, body: await res.text() });
  }
  return out;
}
