import { expect, test } from "./fixtures.ts";
import type { Page, Request } from "@playwright/test";

// The feedback inbox in a real browser. A plain local sideshow has no
// publication destination, so every /api/feedback* answer here is stubbed —
// what is being tested is the view's own behaviour: what it groups, what it
// sends, what it puts on the clipboard, and — the load-bearing one — what it
// never touches. The inbox must not ride /api/events or /api/comments: those
// are the trusted comment→agent stream, and an outside client's words must
// never travel on it (docs/adr/0003).

const ORIGIN = "https://public.example";

const row = (over: Record<string, unknown> = {}, feedbackOver: Record<string, unknown> = {}) => ({
  feedback: {
    id: "fb-1",
    publicationId: "pub-1",
    shareLinkId: "link-1",
    snapshotId: "snap-1",
    anchor: { kind: "text", itemIndex: 0, surfaceIndex: 1, quote: "the summary paragraph" },
    note: "This heading is wrong",
    name: "Dana",
    email: null,
    status: "unread",
    createdAt: "2026-08-18T10:00:00.000Z",
    ...feedbackOver,
  },
  publicationTitle: "Quarterly report",
  publicationId: "pub-1",
  snapshotRevision: 1,
  itemTitle: "Summary",
  surfaceKind: "markdown",
  surfaceUrl: "/api/feedback/s/snap-1/0/1",
  recipientLabel: null,
  ...over,
});

const FEEDBACK = [
  row(),
  // same publication + link + revision, a different surface
  row(
    { itemTitle: "Summary", surfaceKind: "html", surfaceUrl: "/api/feedback/s/snap-1/0/0" },
    {
      id: "fb-2",
      note: "Move this box up",
      name: "Rio",
      anchor: { kind: "point", itemIndex: 0, surfaceIndex: 0, x: 0.25, y: 0.75 },
    },
  ),
  // same publication, a different (labelled) share link and a later revision
  row(
    {
      snapshotRevision: 2,
      recipientLabel: "Acme",
      surfaceUrl: "/api/feedback/s/snap-2/0/0",
      itemTitle: "Appendix",
    },
    {
      id: "fb-3",
      shareLinkId: "link-2",
      snapshotId: "snap-2",
      note: "Add the numbers",
      status: "read",
    },
  ),
  // a different publication
  row(
    { publicationId: "pub-2", publicationTitle: "One diagram" },
    { id: "fb-4", publicationId: "pub-2", shareLinkId: "link-3", note: "Wrong arrow" },
  ),
];

const PROMPT =
  "A client left one comment on a published surface.\n\nComment:\n```\nThis heading is wrong\n```";

type Sent = { method: string; path: string; body: unknown };

async function stubFeedback(page: Page, opts: { configured?: boolean } = {}) {
  const sent: Sent[] = [];
  const seen: string[] = [];
  page.on("request", (request: Request) => seen.push(new URL(request.url()).pathname));
  await page.route("**/api/publish/destination", (route) =>
    route.fulfill({
      json: {
        configured: opts.configured !== false,
        origin: opts.configured === false ? null : ORIGIN,
      },
    }),
  );
  await page.route("**/api/feedback**", (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    if (method !== "GET") sent.push({ method, path: url.pathname, body: request.postDataJSON() });
    if (url.pathname === "/api/feedback/prompt") {
      return route.fulfill({ json: { prompt: PROMPT } });
    }
    if (url.pathname.startsWith("/api/feedback/s/")) {
      // The frozen surface, as the server serves it: its own document under a
      // sandbox CSP header, never inlined into the trusted page.
      return route.fulfill({
        contentType: "text/html",
        headers: { "content-security-policy": "sandbox allow-scripts" },
        body: `<html><body><p>frozen ${url.pathname}</p></body></html>`,
      });
    }
    if (method === "PATCH") {
      const id = url.pathname.slice("/api/feedback/".length);
      return route.fulfill({
        json: { ...row().feedback, id, ...(request.postDataJSON() as object) },
      });
    }
    const status = url.searchParams.get("status");
    const rows = status ? FEEDBACK.filter((r) => r.feedback.status === status) : FEEDBACK;
    return route.fulfill({ json: { unread: 3, feedback: rows } });
  });
  return { sent, seen };
}

const openInbox = async (page: Page, serverUrl: string) => {
  await page.goto(serverUrl);
  await page.getByRole("link", { name: /feedback/ }).click();
  await expect(page.getByRole("heading", { name: "Feedback", level: 1 })).toBeVisible();
};

test("the nav entry carries an unread badge", async ({ page, server }) => {
  await stubFeedback(page);
  await page.goto(server.url);
  const badge = page.locator(".fb-badge");
  await expect(badge).toHaveText("3");
  await expect(badge).toHaveAttribute("aria-label", "3 unread comments");
});

test("with no destination there is no entry and nothing is polled", async ({ page, server }) => {
  const { seen } = await stubFeedback(page, { configured: false });
  await page.goto(server.url);
  await expect(page.getByRole("link", { name: "publications" })).toHaveCount(0);
  await expect(page.locator(".fb-nav")).toHaveCount(0);
  // The inbox routes all answer 503 without a destination, so polling them
  // would be pure noise.
  expect(seen.filter((path) => path.startsWith("/api/feedback"))).toEqual([]);
});

test("submissions are grouped by publication, share link, revision and surface", async ({
  page,
  server,
}) => {
  await stubFeedback(page);
  await openInbox(page, server.url);

  const publications = page.locator(".fb-pub");
  await expect(publications).toHaveCount(2);
  await expect(publications.first().locator("h2")).toContainText("Quarterly report");
  await expect(publications.first().locator("h2")).toContainText("3 comments");

  const links = publications.first().locator(".fb-link");
  await expect(links).toHaveCount(2);
  await expect(links.first().locator("h3")).toHaveText("Unlabelled link");
  await expect(links.nth(1).locator("h3")).toHaveText("Link for Acme");

  // The first link's snapshot has two surfaces; the second link is on revision 2.
  await expect(links.first().locator(".fb-snap h4")).toHaveText(["Revision 1"]);
  await expect(links.first().locator(".fb-surface")).toHaveCount(2);
  await expect(links.nth(1).locator(".fb-snap h4")).toHaveText(["Revision 2"]);

  // The note, the author and the anchor all read as plain text.
  const first = page.locator('[data-feedback="fb-1"]');
  await expect(first.locator(".fb-note")).toHaveText("This heading is wrong");
  await expect(first.locator(".fb-who")).toHaveText("Dana");
  await expect(first.locator(".fb-anchor")).toHaveText("Highlighted text");
  await expect(first).toHaveAttribute("data-status", "unread");
  await expect(page.locator('[data-feedback="fb-2"] .fb-anchor')).toHaveText(
    "Point at 25% across, 75% down",
  );
});

test("the view says plainly that nothing is sent to an agent by itself", async ({
  page,
  server,
}) => {
  await stubFeedback(page);
  await openInbox(page, server.url);

  const boundary = page.locator(".fb-boundary");
  await expect(boundary).toContainText("sent to an agent automatically");
  await expect(boundary).toContainText("clipboard");
});

test("opening an unread submission marks it read and restores the frozen surface", async ({
  page,
  server,
}) => {
  const { sent } = await stubFeedback(page);
  await openInbox(page, server.url);

  await page.locator('[data-feedback="fb-1"] .fb-open').click();

  expect(sent).toContainEqual({
    method: "PATCH",
    path: "/api/feedback/fb-1",
    body: { status: "read" },
  });

  const detail = page.locator('[data-feedback="fb-1"] .fb-detail');
  // The stored quote, beside the surface it was taken from.
  await expect(detail.locator(".fb-quote")).toHaveText("the summary paragraph");
  await expect(detail.locator(".fb-historical")).toContainText("frozen revision");

  const frame = detail.locator("iframe.fb-frame");
  await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
  await expect(frame).toHaveAttribute("src", /\/api\/feedback\/s\/snap-1\/0\/1\?theme=/);
  // It really is the historical document, rendered in its own frame rather
  // than inlined into this page.
  await expect(frame.contentFrame().locator("p")).toHaveText("frozen /api/feedback/s/snap-1/0/1");
});

test("a point anchor puts a marker at the recorded coordinates", async ({ page, server }) => {
  await stubFeedback(page);
  await openInbox(page, server.url);

  await page.locator('[data-feedback="fb-2"] .fb-open').click();
  const marker = page.locator('[data-feedback="fb-2"] .fb-point');
  await expect(marker).toBeVisible();
  await expect(marker).toHaveAttribute("data-x", "25");
  await expect(marker).toHaveAttribute("data-y", "75");

  // How far the marker's centre sits from a quarter across and three quarters
  // down the frame it is drawn over. Measured through expect.poll rather than
  // once: WebKit can report a not-yet-laid-out box for a sandboxed iframe at
  // the moment it appears (see the WebKit-quirk note in AGENTS.md), so this
  // waits for a real box instead of trusting the first reading.
  const wrap = page.locator('[data-feedback="fb-2"] .fb-frame-wrap');
  const drift = async () => {
    const box = await wrap.boundingBox();
    const spot = await marker.boundingBox();
    // Not laid out yet: returning null (rather than a number) keeps the poll
    // waiting instead of comparing a box that does not exist.
    if (!box || !spot || box.width === 0 || box.height === 0) return null;
    return Math.max(
      Math.abs(spot.x + spot.width / 2 - (box.x + box.width * 0.25)),
      Math.abs(spot.y + spot.height / 2 - (box.y + box.height * 0.75)),
    );
  };
  await expect.poll(drift).toBeLessThan(2);
});

test("selected submissions are copied as a prompt, and only to the clipboard", async ({
  page,
  server,
  context,
  browserName,
}) => {
  // only chromium lets tests grant clipboard access; the other engines still
  // exercise the button + toast path
  if (browserName === "chromium") {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  }
  const { sent } = await stubFeedback(page);
  await openInbox(page, server.url);

  const copy = page.getByRole("button", { name: /Copy prompt/ });
  await expect(copy).toBeDisabled();

  await page.locator('[data-feedback="fb-1"] input[type="checkbox"]').check();
  await page.locator('[data-feedback="fb-3"] input[type="checkbox"]').check();
  await expect(copy).toHaveText("Copy prompt for 2 selected");
  await copy.click();

  await expect(page.locator("#toast")).toHaveText("Prompt copied — 2 comments");
  expect(sent).toContainEqual({
    method: "POST",
    path: "/api/feedback/prompt",
    body: { ids: ["fb-1", "fb-3"] },
  });
  if (browserName === "chromium") {
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(PROMPT);
  }
  // The only write the copy made was the prompt request itself: no comment was
  // posted anywhere.
  expect(sent.filter((s) => s.path.startsWith("/api/comments"))).toEqual([]);
});

test("status transitions are sent, and the list can be filtered by status", async ({
  page,
  server,
}) => {
  const { sent } = await stubFeedback(page);
  await openInbox(page, server.url);

  await page.locator('[data-feedback="fb-1"] .fb-open').click();
  await page
    .locator('[data-feedback="fb-1"]')
    .getByRole("button", { name: "Mark resolved" })
    .click();
  expect(sent).toContainEqual({
    method: "PATCH",
    path: "/api/feedback/fb-1",
    body: { status: "resolved" },
  });

  await page.getByRole("button", { name: "Read", exact: true }).click();
  // The stub answers a status filter with only the rows in that status.
  await expect(page.locator(".fb-item")).toHaveCount(1);
  await expect(page.locator(".fb-item")).toHaveAttribute("data-feedback", "fb-3");
});

test("the inbox polls its own routes and never the agent stream", async ({ page, server }) => {
  const { seen } = await stubFeedback(page);
  await openInbox(page, server.url);
  await expect(page.locator(".fb-item").first()).toBeVisible();

  const mark = seen.length;
  const inboxReads = () => seen.slice(mark).filter((path) => path === "/api/feedback").length;

  // Returning to the window refreshes the inbox — over its own route.
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(inboxReads).toBeGreaterThan(0);

  await page.locator('[data-feedback="fb-1"] .fb-open').click();
  await expect(page.locator('[data-feedback="fb-1"] iframe.fb-frame')).toBeVisible();

  // Nothing the inbox did touched the trusted comment→agent channel.
  expect(seen.slice(mark).filter((path) => path.startsWith("/api/events"))).toEqual([]);
  expect(seen.slice(mark).filter((path) => path.startsWith("/api/comments"))).toEqual([]);
});
