// Production smoke test for the public publication service.
//
// Exercises the whole client-facing path against a REAL deployment — publish,
// share links, access controls, confirmed opens, external feedback, analytics —
// then deletes everything it created. It is safe to run against production
// because it only ever touches the one publication it made, and it fails loudly
// if it cannot clean up.
//
// Usage:
//   SIDESHOW_OWNER_TOKEN=… node scripts/smoke-public-sharing.ts https://show.example.com
//
// Exit code 0 means every check passed.

const origin = (process.argv[2] ?? "").replace(/\/+$/, "");
const token = process.env.SIDESHOW_OWNER_TOKEN ?? "";
if (!origin || !token) {
  console.error("usage: SIDESHOW_OWNER_TOKEN=… node scripts/smoke-public-sharing.ts <origin>");
  process.exit(2);
}

let passed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const owner = (path: string, init: RequestInit = {}) =>
  fetch(`${origin}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });

const ownerJson = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
  const res = await owner(path, init);
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} → ${res.status}`);
  return (await res.json()) as T;
};

// A distinctive string that must never appear in a public response.
const RECIPIENT = `smoke-recipient-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = `smoke-pw-${Math.random().toString(36).slice(2, 10)}`;
const MARKER = `smoke-marker-${Math.random().toString(36).slice(2, 8)}`;

let publicationId = "";

try {
  console.log(`\nsideshow public sharing smoke test → ${origin}\n`);

  // --- the service itself ---
  const robots = await fetch(`${origin}/robots.txt`);
  check("robots.txt disallows everything", (await robots.text()).includes("Disallow: /"));
  check(
    "every response is noindex and unreferrable",
    (robots.headers.get("x-robots-tag") ?? "").includes("noindex") &&
      robots.headers.get("referrer-policy") === "no-referrer",
  );
  check(
    "owner API refuses an anonymous caller",
    (await fetch(`${origin}/api/owner/health`)).status === 401,
  );
  check(
    "owner API refuses a wrong token",
    (await fetch(`${origin}/api/owner/health`, { headers: { authorization: "Bearer nope" } }))
      .status === 401,
  );
  check("owner API accepts the real token", (await owner("/api/owner/health")).ok);

  // --- route isolation ---
  const privateRoutes = [
    "/api/sessions",
    "/api/posts",
    "/api/posts/recent",
    "/api/comments",
    "/api/events",
    "/api/theme",
    "/api/kits",
    "/api/version",
    "/api/publications",
    "/api/publish/destination",
    "/api/feedback",
    "/mcp",
    "/connect",
    "/guide",
  ];
  const isolated = await Promise.all(
    privateRoutes.map(async (path) => (await fetch(`${origin}${path}`)).status === 404),
  );
  check(
    "no private workspace route exists here",
    isolated.every(Boolean),
    privateRoutes.filter((_, i) => !isolated[i]).join(", "),
  );

  // --- publish ---
  const publication = await ownerJson<{ id: string }>("/api/owner/publications", {
    method: "POST",
    body: JSON.stringify({ kind: "post", title: `Smoke test ${MARKER}` }),
  });
  publicationId = publication.id;
  const snapshot = await ownerJson<{ id: string; revision: number }>(
    `/api/owner/publications/${publicationId}/snapshots`,
    {
      method: "POST",
      body: JSON.stringify({
        items: [
          {
            postId: "smoke",
            title: "Smoke surface",
            version: 1,
            surfaces: [
              { kind: "html", html: `<p id="smoke">${MARKER}</p>` },
              { kind: "markdown", markdown: `## ${MARKER}\n\nHello.` },
            ],
          },
        ],
      }),
    },
  );
  check("publishing creates revision 1", snapshot.revision === 1);

  // --- share links ---
  const plain = await ownerJson<{ id: string; slug: string; custom: boolean }>(
    `/api/owner/publications/${publicationId}/links`,
    { method: "POST", body: JSON.stringify({ recipientLabel: RECIPIENT }) },
  );
  check("a generated link is unguessable", plain.slug.length >= 20 && !plain.custom);

  const page = await fetch(`${origin}/v/${plain.slug}`);
  const pageHtml = await page.text();
  check("the publication page renders", page.ok && pageHtml.includes(`Smoke test ${MARKER}`));
  check("the page is unbranded", !/sideshow/i.test(pageHtml));
  check(
    "the page runs under a nonce CSP",
    (page.headers.get("content-security-policy") ?? "").includes("script-src 'nonce-") &&
      !(page.headers.get("content-security-policy") ?? "").includes("unsafe-inline"),
  );
  check("html surfaces are not inlined into the page", !pageHtml.includes(`<p id="smoke">`));

  const surface = await fetch(`${origin}/api/v/${plain.slug}/s/0/0`);
  const surfaceHtml = await surface.text();
  check(
    "a surface document is sandboxed by its own header",
    surface.headers.get("content-security-policy") === "sandbox allow-scripts" &&
      surface.headers.get("x-content-type-options") === "nosniff",
  );
  check("the surface document carries the agent markup", surfaceHtml.includes(MARKER));

  const readJson = await (await fetch(`${origin}/api/v/${plain.slug}`)).text();
  check(
    "the recipient label never reaches a reader",
    !readJson.includes(RECIPIENT) && !pageHtml.includes(RECIPIENT),
  );

  // --- confirmed opens ---
  const openRes = await fetch(`${origin}/api/v/${plain.slug}/open`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ snapshotId: snapshot.id }),
  });
  check("a confirmed open is accepted", openRes.status === 204);
  const analytics = await ownerJson<{
    aggregate: { totalOpens: number; uniqueVisitors: number };
    events: { deviceClass: string | null }[];
    retentionDays: number;
  }>(`/api/owner/links/${plain.id}/analytics`);
  check("the open is aggregated", analytics.aggregate.totalOpens >= 1);
  // ISO timestamps contain dots, so look for an address literal rather than any dot.
  const IP_SHAPED = /\b(?:\d{1,3}\.){3}\d{1,3}\b|\b[0-9a-f]{1,4}(?::[0-9a-f]{0,4}){3,}\b/i;
  check("detailed events retain no IP", !IP_SHAPED.test(JSON.stringify(analytics.events)));
  check("detailed events expire after 90 days", analytics.retentionDays === 90);

  // --- external feedback ---
  const feedbackRes = await fetch(`${origin}/api/v/${plain.slug}/feedback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      snapshotId: snapshot.id,
      name: "Smoke Client",
      note: `${MARKER} please tighten the copy`,
      anchor: { kind: "text", itemIndex: 0, surfaceIndex: 0, quote: MARKER },
    }),
  });
  check("a client can leave feedback", feedbackRes.status === 201);
  const inbox = await ownerJson<{ id: string; note: string; status: string }[]>(
    `/api/owner/feedback?publicationId=${publicationId}`,
  );
  check(
    "the owner sees it, unread",
    inbox.length === 1 && inbox[0].status === "unread" && inbox[0].note.includes(MARKER),
  );
  check(
    "a reader cannot see anyone's feedback",
    !(await (await fetch(`${origin}/api/v/${plain.slug}`)).text()).includes("please tighten"),
  );

  // --- duplication, password, expiry, revocation ---
  const copy = await ownerJson<{ id: string; slug: string }>(
    `/api/owner/links/${plain.id}/duplicate`,
    { method: "POST", body: JSON.stringify({ recipientLabel: "second recipient" }) },
  );
  check("a duplicate is a separate capability", copy.slug !== plain.slug);
  const copyAnalytics = await ownerJson<{ aggregate: { totalOpens: number } }>(
    `/api/owner/links/${copy.id}/analytics`,
  );
  check(
    "the duplicate starts with its own empty analytics",
    copyAnalytics.aggregate.totalOpens === 0,
  );

  await ownerJson(`/api/owner/links/${copy.id}`, {
    method: "PATCH",
    body: JSON.stringify({ password: PASSWORD }),
  });
  const locked = await fetch(`${origin}/api/v/${copy.slug}`);
  check("a password-protected link is gated", locked.status === 401);
  const wrong = await fetch(`${origin}/api/v/${copy.slug}/unlock`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "not-it" }),
  });
  check("the wrong password is refused", wrong.status === 401);
  const unlock = await fetch(`${origin}/api/v/${copy.slug}/unlock`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  });
  const cookie = unlock.headers.get("set-cookie") ?? "";
  check("the right password unlocks", unlock.ok && cookie.startsWith("sspw_"));
  const unlocked = await fetch(`${origin}/api/v/${copy.slug}`, {
    headers: { cookie: cookie.split(";")[0] },
  });
  check("the unlock cookie opens the publication", unlocked.ok);
  check(
    "the original link is unaffected by the copy's password",
    (await fetch(`${origin}/api/v/${plain.slug}`)).ok,
  );

  await ownerJson(`/api/owner/links/${copy.id}`, {
    method: "PATCH",
    body: JSON.stringify({ expiresAt: new Date(Date.now() - 60_000).toISOString() }),
  });
  const expired = await fetch(`${origin}/api/v/${copy.slug}`);
  const unknown = await fetch(`${origin}/api/v/definitely-not-a-real-slug-xyz`);
  check("an expired link fails closed", expired.status === 404);
  check(
    "expired and unknown are indistinguishable",
    expired.status === unknown.status && (await expired.text()) === (await unknown.text()),
  );

  await ownerJson(`/api/owner/links/${plain.id}`, {
    method: "PATCH",
    body: JSON.stringify({ revoked: true }),
  });
  check(
    "a revoked link fails closed",
    (await fetch(`${origin}/api/v/${plain.slug}`)).status === 404,
  );
  check(
    "a revoked link's surfaces are gone too",
    (await fetch(`${origin}/api/v/${plain.slug}/s/0/0`)).status === 404,
  );

  // --- update ---
  const second = await ownerJson<{ revision: number }>(
    `/api/owner/publications/${publicationId}/snapshots`,
    {
      method: "POST",
      body: JSON.stringify({
        items: [
          {
            postId: "smoke",
            title: "Smoke surface",
            version: 2,
            surfaces: [{ kind: "html", html: `<p>${MARKER} second revision</p>` }],
          },
        ],
      }),
    },
  );
  check("re-publishing mints a new revision", second.revision === 2);
  const snapshots = await ownerJson<unknown[]>(
    `/api/owner/publications/${publicationId}/snapshots`,
  );
  check("the historical snapshot is retained", snapshots.length === 2);
} catch (error) {
  failures.push(`threw: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  if (publicationId) {
    const removed = await owner(`/api/owner/publications/${publicationId}`, { method: "DELETE" });
    check("the smoke publication is cleaned up", removed.status === 204);
  }
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.error(`\nfailures:\n${failures.map((f) => `  - ${f}`).join("\n")}`);
  process.exit(1);
}
