import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../server/app.ts";
import type { ExternalFeedback } from "../server/publicationTypes.ts";
import { JsonFileStore } from "../server/storage.ts";
import { DEST_ORIGIN, json, makeStack, OWNER_TOKEN, patch, type TestApp } from "./publishStack.ts";

// The owner's side of docs/adr/0003. An untrusted share-link holder writes a
// comment into the public service's external-feedback tables; the owner reads it
// here, over routes that are deliberately NOT the comment→agent stream. The
// three things this has to prove: the context is complete enough to act on, the
// historical surface really is historical, and nothing about any of it reaches
// an agent — no comment, no cursor movement, no token in a browser-visible body.

type Stack = ReturnType<typeof makeStack>;

async function seedPublication(stack: Stack, html = "<p>first cut</p>") {
  const session = await stack.privateStore.createSession({ agent: "pi", title: "work" });
  const created = await stack.app.request(
    "/api/posts",
    json({
      session: session.id,
      title: "Quarterly report",
      surfaces: [
        { kind: "html", html },
        { kind: "markdown", markdown: "# Summary" },
      ],
    }),
  );
  assert.equal(created.status, 201);
  const post = (await created.json()) as { id: string };
  const published = await stack.app.request("/api/publish/post", json({ postId: post.id }));
  assert.equal(published.status, 201);
  const result = (await published.json()) as {
    publicationId: string;
    snapshotId: string;
    slug: string;
    revision: number;
  };
  return { session, post, ...result };
}

/** A submission through the public share link, exactly as a client makes it. */
async function submit(
  stack: Stack,
  slug: string,
  snapshotId: string,
  body: Record<string, unknown>,
) {
  const res = await stack.publicApp.request(`${DEST_ORIGIN}/api/v/${slug}/feedback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Dana", snapshotId, ...body }),
  });
  assert.equal(res.status, 201, await res.text());
}

type InboxRow = {
  feedback: ExternalFeedback;
  publicationTitle: string;
  publicationId: string;
  snapshotRevision: number;
  itemTitle: string;
  surfaceKind: string;
  surfaceUrl: string;
  recipientLabel: string | null;
};

const inbox = async (app: TestApp, query = "") => {
  const res = await app.request(`/api/feedback${query}`);
  assert.equal(res.status, 200);
  return (await res.json()) as { unread: number; feedback: InboxRow[] };
};

test("a client submission arrives in the inbox with its full owner context", async () => {
  const stack = makeStack();
  const pub = await seedPublication(stack);
  await submit(stack, pub.slug, pub.snapshotId, {
    note: "This heading is wrong",
    anchor: { kind: "text", itemIndex: 0, surfaceIndex: 1, quote: "Summary" },
  });

  const { unread, feedback } = await inbox(stack.app);
  assert.equal(unread, 1);
  assert.equal(feedback.length, 1);
  const row = feedback[0]!;
  assert.equal(row.feedback.note, "This heading is wrong");
  assert.equal(row.feedback.name, "Dana");
  assert.equal(row.feedback.status, "unread");
  assert.equal(row.publicationTitle, "Quarterly report");
  assert.equal(row.publicationId, pub.publicationId);
  assert.equal(row.snapshotRevision, 1);
  assert.equal(row.itemTitle, "Quarterly report");
  assert.equal(row.surfaceKind, "markdown");
  // Addressed by snapshot on THIS origin: the browser never holds the
  // destination's token, and the URL survives later revisions.
  assert.equal(new URL(row.surfaceUrl).pathname, `/api/feedback/s/${pub.snapshotId}/0/1`);
  assert.equal(row.recipientLabel, null);
});

test("the inbox filters by status, and the unread count ignores the filter", async () => {
  const stack = makeStack();
  const pub = await seedPublication(stack);
  for (const note of ["first", "second"]) {
    await submit(stack, pub.slug, pub.snapshotId, {
      note,
      anchor: { kind: "point", itemIndex: 0, surfaceIndex: 0, x: 0.5, y: 0.25 },
    });
  }
  const all = await inbox(stack.app);
  assert.equal(all.feedback.length, 2);

  const first = all.feedback[0]!.feedback.id;
  const marked = await stack.app.request(`/api/feedback/${first}`, patch({ status: "resolved" }));
  assert.equal(marked.status, 200);
  assert.equal(((await marked.json()) as ExternalFeedback).status, "resolved");

  const resolved = await inbox(stack.app, "?status=resolved");
  assert.deepEqual(
    resolved.feedback.map((row) => row.feedback.id),
    [first],
  );
  // One left unread; the count is workspace-wide, not filter-wide.
  assert.equal(resolved.unread, 1);

  const unread = await inbox(stack.app, "?status=unread");
  assert.equal(unread.feedback.length, 1);
  assert.notEqual(unread.feedback[0]!.feedback.id, first);
});

test("every status transition is accepted and anything else is refused", async () => {
  const stack = makeStack();
  const pub = await seedPublication(stack);
  await submit(stack, pub.slug, pub.snapshotId, {
    note: "a note",
    anchor: { kind: "point", itemIndex: 0, surfaceIndex: 0, x: 0.1, y: 0.1 },
  });
  const id = (await inbox(stack.app)).feedback[0]!.feedback.id;

  for (const status of ["read", "resolved", "rejected", "unread"]) {
    const res = await stack.app.request(`/api/feedback/${id}`, patch({ status }));
    assert.equal(res.status, 200, status);
    assert.equal(((await res.json()) as ExternalFeedback).status, status);
  }

  const bad = await stack.app.request(`/api/feedback/${id}`, patch({ status: "archived" }));
  assert.equal(bad.status, 400);
  assert.match(((await bad.json()) as { error: string }).error, /invalid status/);

  const missing = await stack.app.request("/api/feedback/nope", patch({ status: "read" }));
  assert.equal(missing.status, 404);
});

test("the historical surface is served under a sandbox CSP and keeps the OLD content", async () => {
  const stack = makeStack();
  const pub = await seedPublication(stack, "<p>original wording</p>");
  await submit(stack, pub.slug, pub.snapshotId, {
    note: "about this bit",
    anchor: { kind: "point", itemIndex: 0, surfaceIndex: 0, x: 0.5, y: 0.5 },
  });
  const url = new URL((await inbox(stack.app)).feedback[0]!.surfaceUrl);

  // The publication moves on to a new revision...
  const updated = await stack.app.request(`/api/posts/${pub.post.id}`, {
    ...json({ surfaces: [{ kind: "html", html: "<p>replaced wording</p>" }] }),
    method: "PUT",
  });
  assert.equal(updated.status, 200);
  const republished = await stack.app.request("/api/publish/post", json({ postId: pub.post.id }));
  assert.equal(republished.status, 201);
  assert.equal(((await republished.json()) as { revision: number }).revision, 2);

  // ...and the submission still opens exactly what it was written against.
  const res = await stack.app.request(url.pathname);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-security-policy"), "sandbox allow-scripts");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  const html = await res.text();
  assert.ok(html.includes("original wording"), html.slice(0, 200));
  assert.equal(html.includes("replaced wording"), false);
  // The private origin proxies it; the destination's token stays server-side.
  assert.equal(html.includes(OWNER_TOKEN), false);

  const nowhere = await stack.app.request(`/api/feedback/s/${pub.snapshotId}/9/9`);
  assert.equal(nowhere.status, 404);
});

test("the prompt route needs a real selection and builds from the stored rows", async () => {
  const stack = makeStack();
  const pub = await seedPublication(stack);
  await submit(stack, pub.slug, pub.snapshotId, {
    note: "tighten the summary",
    anchor: { kind: "text", itemIndex: 0, surfaceIndex: 1, quote: "Summary" },
  });
  const row = (await inbox(stack.app)).feedback[0]!;

  const empty = await stack.app.request("/api/feedback/prompt", json({ ids: [] }));
  assert.equal(empty.status, 400);
  const notAList = await stack.app.request("/api/feedback/prompt", json({}));
  assert.equal(notAList.status, 400);

  const unknown = await stack.app.request("/api/feedback/prompt", json({ ids: ["fb-nope"] }));
  assert.equal(unknown.status, 404);

  const res = await stack.app.request(
    "/api/feedback/prompt",
    json({ ids: [row.feedback.id, "fb-nope"] }),
  );
  assert.equal(res.status, 200);
  const { prompt } = (await res.json()) as { prompt: string };
  assert.match(prompt, /tighten the summary/);
  assert.match(prompt, /Summary/);
  assert.match(prompt, /Quarterly report/);
  assert.match(prompt, /- Revision: 1/);
  assert.ok(prompt.includes(row.surfaceUrl));
  assert.equal(prompt.includes(OWNER_TOKEN), false);
});

test("external feedback never becomes a comment and never moves the agent cursor", async () => {
  const stack = makeStack();
  const pub = await seedPublication(stack);
  const before = await stack.privateStore.getSession(pub.session.id);
  assert.equal(before?.agentSeq, 0);

  await submit(stack, pub.slug, pub.snapshotId, {
    note: "please change the title",
    anchor: { kind: "text", itemIndex: 0, surfaceIndex: 1, quote: "Summary" },
  });
  const row = (await inbox(stack.app)).feedback[0]!;
  await stack.app.request(`/api/feedback/${row.feedback.id}`, patch({ status: "read" }));
  await stack.app.request("/api/feedback/prompt", json({ ids: [row.feedback.id] }));

  // Not one comment anywhere in the private workspace...
  const comments = await stack.privateStore.listComments({ sessionId: pub.session.id });
  assert.equal(comments.length, 0);
  const feed = await stack.app.request(`/api/comments?session=${pub.session.id}`);
  assert.deepEqual(((await feed.json()) as { comments: unknown[] }).comments, []);
  // ...and the cursor an agent reads from has not moved.
  const after = await stack.privateStore.getSession(pub.session.id);
  assert.equal(after?.agentSeq, 0);

  // Nothing an agent polls for mentions it either.
  const agent = await stack.app.request(
    `/api/comments?session=${pub.session.id}&author=user&wait=0`,
  );
  const body = await agent.text();
  assert.equal(body.includes("please change the title"), false);
});

test("no browser-visible response body ever carries the destination token", async () => {
  const stack = makeStack();
  const pub = await seedPublication(stack);
  await submit(stack, pub.slug, pub.snapshotId, {
    note: "a note",
    anchor: { kind: "point", itemIndex: 0, surfaceIndex: 0, x: 0.2, y: 0.8 },
  });
  const listed = await stack.app.request("/api/feedback");
  const listBody = await listed.text();
  assert.equal(listBody.includes(OWNER_TOKEN), false);
  const id = (JSON.parse(listBody) as { feedback: InboxRow[] }).feedback[0]!.feedback.id;

  const patched = await stack.app.request(`/api/feedback/${id}`, patch({ status: "read" }));
  assert.equal((await patched.text()).includes(OWNER_TOKEN), false);
});

test("every inbox route answers 503 when the workspace has no destination", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sideshow-feedback-"));
  const app = createApp({
    store: new JsonFileStore(join(dir, "data.json")),
    viewerHtml: "<html><head></head><body>viewer</body></html>",
    guideMarkdown: "# guide",
    setupText: "# setup",
  }) as unknown as TestApp;

  for (const res of [
    await app.request("/api/feedback"),
    await app.request("/api/feedback/fb-1", patch({ status: "read" })),
    await app.request("/api/feedback/s/snap-1/0/0"),
    await app.request("/api/feedback/prompt", json({ ids: ["fb-1"] })),
  ]) {
    assert.equal(res.status, 503);
  }
});

test("a public-read visitor cannot read the inbox or a historical surface", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sideshow-feedback-public-"));
  const app = createApp({
    store: new JsonFileStore(join(dir, "data.json")),
    viewerHtml: "<html><head></head><body>viewer</body></html>",
    guideMarkdown: "# guide",
    setupText: "# setup",
    authToken: "secret",
    // "full" opens every GET to an unauthenticated reader — except these.
    publicRead: "full",
    destination: { origin: DEST_ORIGIN, token: OWNER_TOKEN },
  }) as unknown as TestApp;

  for (const path of [
    "/api/feedback",
    "/api/feedback?status=unread",
    "/api/feedback/s/snap-1/0/0",
  ]) {
    const res = await app.request(path);
    assert.equal(res.status, 401, path);
  }
  assert.equal((await app.request("/api/feedback/prompt", json({ ids: ["x"] }))).status, 401);
  assert.equal((await app.request("/api/feedback/fb-1", patch({ status: "read" }))).status, 401);

  // The owner still gets through with the token.
  const authed = await app.request("/api/feedback", {
    headers: { authorization: "Bearer secret" },
  });
  assert.notEqual(authed.status, 401);
});
