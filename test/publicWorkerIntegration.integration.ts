import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { unstable_dev, type Unstable_DevWorker } from "wrangler";

// The PUBLIC publication service on real workerd (wrangler.public.jsonc +
// workers/publicService.ts). Its sibling file covers the private Worker; this
// one proves the second deployment boots, creates SqlPublicationStore's schema
// on a real Durable Object's SQLite, and serves a share link end to end.

const OWNER_TOKEN = "public-worker-owner-token";
const OWNER_AUTH = { authorization: `Bearer ${OWNER_TOKEN}` };
const VISITOR_SECRET = "public-worker-visitor-secret";
const SLUG = "worker-integration-link";

const HTML_MARKER = '<p id="public-worker-marker">frozen publication surface</p>';

type Publication = { id: string; kind: string; title: string; currentSnapshotId: string | null };
type Snapshot = { id: string; revision: number; publicationId: string };
type ShareLink = { id: string; slug: string; publicationId: string };
type PublicView = {
  title: string;
  link: { slug: string };
  snapshot: { id: string; revision: number; items: Array<{ title: string }> };
};

function ownerJson(body: unknown, method = "POST") {
  return {
    method,
    headers: { ...OWNER_AUTH, "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

async function expectJson<T>(response: Response, status: number): Promise<T> {
  const text = await response.text();
  assert.equal(response.status, status, text);
  return JSON.parse(text) as T;
}

async function startWorker(
  persistTo: string,
  vars: Record<string, string>,
): Promise<Unstable_DevWorker> {
  // The API type requires a positional script, but leaving it undefined makes
  // Wrangler resolve `main` from the checked-in config, just like deploy/dev.
  return unstable_dev(undefined as never, {
    config: "wrangler.public.jsonc",
    local: true,
    persist: true,
    persistTo,
    vars,
    logLevel: "error",
    experimental: {
      disableDevRegistry: true,
      disableExperimentalWarning: true,
      watch: false,
    },
  });
}

test(
  "the public publication Worker boots its own Durable Object and serves a share link",
  { timeout: 60_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "sideshow-public-worker-"));
    const persistTo = join(root, "state");
    let worker: Unstable_DevWorker | undefined;

    let stopping: Promise<void> | undefined;
    const stopWorker = async () => {
      if (!worker) return;
      if (stopping) return stopping;
      const active = worker;
      stopping = active
        .stop()
        .then(() => {
          if (worker === active) worker = undefined;
        })
        .finally(() => {
          stopping = undefined;
        });
      return stopping;
    };
    t.signal.addEventListener("abort", () => void stopWorker().catch(() => {}), { once: true });
    t.after(async () => {
      try {
        await stopWorker();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    // Fail closed: no owner token and no visitor secret means no service at all,
    // rather than publications served with an unkeyed visitor hash.
    worker = await startWorker(persistTo, {
      SIDESHOW_OWNER_TOKEN: "",
      SIDESHOW_VISITOR_SECRET: "",
    });
    const unconfigured = await worker.fetch("/v/anything");
    assert.equal(unconfigured.status, 503);
    const unconfiguredBody = await unconfigured.text();
    assert.match(unconfiguredBody, /wrangler secret put SIDESHOW_OWNER_TOKEN/);
    assert.match(unconfiguredBody, /wrangler secret put SIDESHOW_VISITOR_SECRET/);
    await stopWorker();

    worker = await startWorker(persistTo, {
      SIDESHOW_OWNER_TOKEN: OWNER_TOKEN,
      SIDESHOW_VISITOR_SECRET: VISITOR_SECRET,
    });

    // The owner API is the private control plane's server-to-server channel; a
    // visitor must never reach it.
    assert.equal((await worker.fetch("/api/owner/publications")).status, 401);
    assert.equal(
      (await worker.fetch("/api/owner/publications", { headers: { authorization: "Bearer nope" } }))
        .status,
      401,
    );
    const health = await expectJson<{ ok: boolean; role: string }>(
      await worker.fetch("/api/owner/health", { headers: OWNER_AUTH }),
      200,
    );
    assert.deepEqual(health, { ok: true, role: "public" });

    // None of the private workspace API exists in this deployment.
    assert.equal((await worker.fetch("/api/posts", { headers: OWNER_AUTH })).status, 404);
    assert.equal((await worker.fetch("/api/sessions", { headers: OWNER_AUTH })).status, 404);
    assert.equal((await worker.fetch("/mcp", { headers: OWNER_AUTH })).status, 404);

    // Every write below lands in SqlPublicationStore's tables, so a 201 here is
    // the proof its schema was created on the real DO SQLite backend.
    const publication = await expectJson<Publication>(
      await worker.fetch(
        "/api/owner/publications",
        ownerJson({
          kind: "post",
          title: "Public worker publication",
          originPostId: "post-1",
          identity: { name: "Edu" },
        }),
      ),
      201,
    );
    assert.ok(publication.id);
    assert.equal(publication.currentSnapshotId, null);

    const snapshot = await expectJson<Snapshot>(
      await worker.fetch(
        `/api/owner/publications/${publication.id}/snapshots`,
        ownerJson({
          title: "Frozen revision",
          items: [
            {
              postId: "post-1",
              title: "Frozen post",
              version: 2,
              surfaces: [
                { kind: "html", html: HTML_MARKER },
                { kind: "markdown", markdown: "# Snapshot heading\n\nfrozen prose." },
              ],
            },
          ],
        }),
      ),
      201,
    );
    assert.equal(snapshot.revision, 1);
    assert.equal(snapshot.publicationId, publication.id);

    const link = await expectJson<ShareLink>(
      await worker.fetch(
        `/api/owner/publications/${publication.id}/links`,
        ownerJson({ slug: SLUG, recipientLabel: "Acme — Dana" }),
      ),
      201,
    );
    assert.equal(link.slug, SLUG);

    const detail = await expectJson<{ publication: Publication; snapshots: unknown[] }>(
      await worker.fetch(`/api/owner/publications/${publication.id}`, { headers: OWNER_AUTH }),
      200,
    );
    assert.equal(detail.publication.currentSnapshotId, snapshot.id);
    assert.equal(detail.snapshots.length, 1);

    // The owner-side inbox and analytics run off the same DO tables.
    const feedback = await expectJson<unknown[]>(
      await worker.fetch(`/api/owner/feedback?publicationId=${publication.id}`, {
        headers: OWNER_AUTH,
      }),
      200,
    );
    assert.deepEqual(feedback, []);
    const analytics = await expectJson<{ retentionDays: number; trackOpens: boolean }>(
      await worker.fetch(`/api/owner/links/${link.id}/analytics`, { headers: OWNER_AUTH }),
      200,
    );
    assert.equal(analytics.retentionDays, 90);
    assert.equal(analytics.trackOpens, true);

    // --- the visitor side of the same data, with no credential at all ---

    const page = await worker.fetch(`/v/${SLUG}`);
    assert.equal(page.status, 200);
    const pageHtml = await page.text();
    assert.match(pageHtml, /Frozen post/);
    // Agent markup never reaches this page; it is inert data plus nonced chrome.
    assert.doesNotMatch(pageHtml, /public-worker-marker/);
    assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'none'/);
    assert.equal(page.headers.get("referrer-policy"), "no-referrer");
    assert.match(page.headers.get("x-robots-tag") ?? "", /noindex/);

    const view = await expectJson<PublicView>(await worker.fetch(`/api/v/${SLUG}`), 200);
    assert.equal(view.title, "Frozen revision");
    assert.equal(view.link.slug, SLUG);
    assert.equal(view.snapshot.items.length, 1);
    assert.equal(view.snapshot.items[0].title, "Frozen post");

    // The surface document: served from this origin, so it MUST carry the
    // `sandbox` CSP header itself — an iframe attribute would not survive a
    // top-level navigation to the same URL.
    const surface = await worker.fetch(`/api/v/${SLUG}/s/0/0?theme=github&mode=dark`);
    const surfaceBody = await surface.text();
    assert.equal(surface.status, 200, surfaceBody.slice(0, 400));
    assert.equal(surface.headers.get("content-security-policy"), "sandbox allow-scripts");
    assert.equal(surface.headers.get("x-content-type-options"), "nosniff");
    assert.match(surface.headers.get("cache-control") ?? "", /immutable/);
    assert.match(surfaceBody, /public-worker-marker/);

    // The rich renderers are imported dynamically, which is exactly the kind of
    // thing that works on Node and fails only once deployed to workerd.
    const richSurface = await worker.fetch(`/api/v/${SLUG}/s/0/1?theme=github&mode=dark`);
    const richBody = await richSurface.text();
    assert.equal(richSurface.status, 200, richBody.slice(0, 400));
    assert.equal(richSurface.headers.get("content-security-policy"), "sandbox allow-scripts");
    assert.match(richBody, /<h1>Snapshot heading<\/h1>/);

    // The same surface addressed by SNAPSHOT — the owner's route for reopening
    // the historical context a piece of feedback was written against.
    const historical = await worker.fetch(`/api/owner/snapshots/${snapshot.id}/s/0/0`, {
      headers: OWNER_AUTH,
    });
    const historicalBody = await historical.text();
    assert.equal(historical.status, 200, historicalBody.slice(0, 400));
    assert.equal(historical.headers.get("content-security-policy"), "sandbox allow-scripts");
    assert.match(historicalBody, /public-worker-marker/);
    assert.equal(
      (await worker.fetch(`/api/owner/snapshots/${snapshot.id}/s/0/0`)).status,
      401,
      "the historical surface route must stay behind the owner token",
    );

    assert.equal((await worker.fetch(`/api/v/${SLUG}/s/0/9`)).status, 404);
    assert.equal((await worker.fetch("/api/v/no-such-link")).status, 404);

    // --- restart: the schema and its rows are really on disk in the DO ---

    await stopWorker();
    worker = await startWorker(persistTo, {
      SIDESHOW_OWNER_TOKEN: OWNER_TOKEN,
      SIDESHOW_VISITOR_SECRET: VISITOR_SECRET,
    });

    const afterRestart = await expectJson<PublicView>(await worker.fetch(`/api/v/${SLUG}`), 200);
    assert.equal(afterRestart.snapshot.id, snapshot.id);
    assert.equal(afterRestart.snapshot.revision, 1);

    const listed = await expectJson<Publication[]>(
      await worker.fetch("/api/owner/publications?originPostId=post-1", { headers: OWNER_AUTH }),
      200,
    );
    assert.deepEqual(
      listed.map((p) => p.id),
      [publication.id],
    );

    // Deleting the publication takes its snapshots and links with it, so the
    // share link stops resolving.
    assert.equal(
      (
        await worker.fetch(`/api/owner/publications/${publication.id}`, {
          method: "DELETE",
          headers: OWNER_AUTH,
        })
      ).status,
      204,
    );
    assert.equal((await worker.fetch(`/api/v/${SLUG}`)).status, 404);
  },
);
