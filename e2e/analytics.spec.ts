import {
  expect,
  owner,
  publicationTest,
  type PublicServer,
  seedPublication,
  test as dashboardTest,
} from "./fixtures.ts";
import type { Page } from "@playwright/test";

// Confirmed opens end to end (issue #8), from both ends of the loop:
//
//   1. the reader's browser — does rendering a publication record exactly one
//      open, does a reload record another, does a link with tracking off record
//      nothing at all; and
//   2. the owner's dashboard — are the resulting figures shown, and shown next
//      to the sentence that says what they are not.
//
// Part 1 drives the real public runtime (`publicationTest`); part 2 drives the
// workspace viewer with the publications proxy stubbed, exactly as
// publications.spec.ts does, because a local sideshow has no destination.

const ITEMS = [
  {
    postId: "post-1",
    title: "Frozen post",
    version: 1,
    surfaces: [{ kind: "markdown", markdown: "## Findings\n\nSome prose worth reading." }],
  },
];

interface Analytics {
  trackOpens: boolean;
  retentionDays: number;
  aggregate: {
    shareLinkId: string;
    firstOpenAt: string | null;
    lastOpenAt: string | null;
    totalOpens: number;
    uniqueVisitors: number;
  };
  events: { at: string; deviceClass: string | null; country: string | null; snapshotId: string }[];
}

const readAnalytics = (server: PublicServer, linkId: string) =>
  owner<Analytics>(server, "GET", `/api/owner/links/${linkId}/analytics`);

const totalOpens = async (server: PublicServer, linkId: string) =>
  (await readAnalytics(server, linkId)).aggregate.totalOpens;

// --- what the reader's browser actually records -------------------------

publicationTest(
  "rendering a publication records one confirmed open, and a reload records a second",
  async ({ page, publicServer }) => {
    const seeded = await seedPublication(publicServer, { items: ITEMS });

    await page.goto(seeded.url);
    await expect(page.locator("h1")).toHaveText("Quarterly report");
    await expect.poll(() => totalOpens(publicServer, seeded.linkId), { timeout: 15_000 }).toBe(1);

    // One render is one open: the beacon must not fire again on its own.
    await page.waitForTimeout(2000);
    const first = await readAnalytics(publicServer, seeded.linkId);
    expect(first.aggregate.totalOpens).toBe(1);
    expect(first.aggregate.uniqueVisitors).toBe(1);
    expect(first.aggregate.firstOpenAt).toBeTruthy();
    expect(first.aggregate.lastOpenAt).toBe(first.aggregate.firstOpenAt);
    expect(first.events).toHaveLength(1);
    expect(first.events[0].snapshotId).toBe(seeded.snapshotId);
    expect(first.events[0].deviceClass).toBeTruthy();
    // Nothing that could identify the reader comes back with it.
    expect(JSON.stringify(first)).not.toContain("visitorHash");

    await page.reload();
    await expect(page.locator("h1")).toHaveText("Quarterly report");
    await expect.poll(() => totalOpens(publicServer, seeded.linkId), { timeout: 15_000 }).toBe(2);

    const second = await readAnalytics(publicServer, seeded.linkId);
    expect(second.events).toHaveLength(2);
    // The same browser inside the same rotation window is still one visitor.
    expect(second.aggregate.uniqueVisitors).toBe(1);
    expect(second.aggregate.firstOpenAt).toBe(first.aggregate.firstOpenAt);
  },
);

publicationTest(
  "a link with tracking off records nothing at all",
  async ({ page, publicServer }) => {
    const seeded = await seedPublication(publicServer, {
      items: ITEMS,
      link: { trackOpens: false },
    });

    await page.goto(seeded.url);
    await expect(page.locator("h1")).toHaveText("Quarterly report");
    // The beacon is deliberately delayed past render; wait well beyond it.
    await page.waitForTimeout(4000);

    const data = await readAnalytics(publicServer, seeded.linkId);
    expect(data.trackOpens).toBe(false);
    expect(data.aggregate.totalOpens).toBe(0);
    expect(data.aggregate.uniqueVisitors).toBe(0);
    expect(data.aggregate.firstOpenAt).toBeNull();
    expect(data.events).toEqual([]);
  },
);

// --- what the owner's dashboard shows -----------------------------------

const ORIGIN = "https://public.example";

const PUBLICATION = {
  id: "pub-1",
  kind: "post",
  title: "Quarterly report",
  originSessionId: null,
  originPostId: "post-1",
  currentSnapshotId: "snap-2",
  identity: null,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-18T00:00:00.000Z",
};

const shareLink = (over: Record<string, unknown>) => ({
  id: "link-tracked",
  publicationId: "pub-1",
  slug: "aaaaaa",
  custom: false,
  recipientLabel: "Acme",
  hasPassword: false,
  expiresAt: null,
  revokedAt: null,
  trackOpens: true,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  ...over,
});

const DETAIL = {
  origin: ORIGIN,
  publication: PUBLICATION,
  snapshots: [
    {
      id: "snap-2",
      publicationId: "pub-1",
      revision: 2,
      title: "Quarterly report",
      assetIds: [],
      createdAt: "2026-08-18T00:00:00.000Z",
      itemCount: 1,
    },
  ],
  links: [shareLink({}), shareLink({ id: "link-off", slug: "bbbbbb", trackOpens: false })],
};

const TRACKED_ANALYTICS = {
  trackOpens: true,
  retentionDays: 90,
  aggregate: {
    shareLinkId: "link-tracked",
    firstOpenAt: "2026-08-01T09:00:00.000Z",
    lastOpenAt: "2026-08-18T17:30:00.000Z",
    totalOpens: 7,
    uniqueVisitors: 3,
  },
  events: [
    { at: "2026-08-18T17:30:00.000Z", deviceClass: "mobile", country: "ES", snapshotId: "snap-2" },
    { at: "2026-08-17T11:00:00.000Z", deviceClass: "desktop", country: null, snapshotId: "snap-2" },
  ],
};

const UNTRACKED_ANALYTICS = {
  trackOpens: false,
  retentionDays: 90,
  aggregate: {
    shareLinkId: "link-off",
    firstOpenAt: null,
    lastOpenAt: null,
    totalOpens: 0,
    uniqueVisitors: 0,
  },
  events: [],
};

/** Stubs the destination probe and the publications proxy; records GET paths. */
async function stubDashboard(page: Page): Promise<string[]> {
  const fetched: string[] = [];
  await page.route("**/api/publish/destination", (route) =>
    route.fulfill({ json: { configured: true, origin: ORIGIN } }),
  );
  await page.route("**/api/publications**", (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === "GET") fetched.push(url.pathname + url.search);
    if (url.pathname === "/api/publications") {
      return route.fulfill({ json: { origin: ORIGIN, publications: [PUBLICATION] } });
    }
    if (url.pathname === "/api/publications/pub-1") return route.fulfill({ json: DETAIL });
    if (url.pathname === "/api/publications/links/link-tracked/analytics") {
      return route.fulfill({ json: TRACKED_ANALYTICS });
    }
    if (url.pathname === "/api/publications/links/link-off/analytics") {
      return route.fulfill({ json: UNTRACKED_ANALYTICS });
    }
    return route.fulfill({ status: 204, body: "" });
  });
  return fetched;
}

async function openPublication(page: Page, serverUrl: string) {
  await page.goto(serverUrl);
  await page.getByRole("link", { name: "publications" }).click();
  await expect(page.getByRole("heading", { name: "Publications" })).toBeVisible();
  await page.locator(".pubs-row").first().click();
  await expect(page.locator("tr.pubs-link")).toHaveCount(2);
}

dashboardTest(
  "a link's opens are fetched only when asked for, and shown with what they are not",
  async ({ page, server }) => {
    const fetched = await stubDashboard(page);
    await openPublication(page, server.url);

    // Lazy: listing links must not pull analytics for every one of them.
    expect(fetched.filter((path) => path.includes("/analytics"))).toEqual([]);

    await page.locator('tr[data-slug="aaaaaa"]').getByRole("button", { name: "Opens" }).click();
    const panel = page.locator(".pubs-opens");
    await expect(panel).toBeVisible();
    await expect.poll(() => fetched.filter((path) => path.includes("/analytics")).length).toBe(1);

    // The four aggregates the owner came for.
    const stats = panel.locator(".pubs-stats");
    await expect(stats).toContainText("First open");
    await expect(stats).toContainText("Last open");
    await expect(stats).toContainText("2026");
    await expect(stats.locator("div").filter({ hasText: "Total opens" })).toContainText("7");
    await expect(stats.locator("div").filter({ hasText: "Approximate visitors" })).toContainText(
      "3",
    );

    // Recent activity, in words rather than raw enum values.
    const events = panel.locator(".pubs-open-list li");
    await expect(events).toHaveCount(2);
    await expect(events.nth(0)).toContainText("Phone");
    await expect(events.nth(0)).toContainText("ES");
    await expect(events.nth(1)).toContainText("Computer");
    await expect(events.nth(1)).toContainText("Unknown country");

    // The wording is the acceptance criterion, not decoration.
    await expect(panel).toContainText("likely-recipient activity");
    await expect(panel).toContainText("not proof of identity");
    await expect(panel).toContainText("forwarded");
    await expect(panel).toContainText("90 days");
    await expect(panel).toContainText("indefinitely");
  },
);

dashboardTest(
  "a link with tracking off says so, and shows the empty state",
  async ({ page, server }) => {
    await stubDashboard(page);
    await openPublication(page, server.url);

    const row = page.locator('tr[data-slug="bbbbbb"]');
    await expect(row).toContainText("Not tracking opens");
    await row.getByRole("button", { name: "Opens" }).click();

    const panel = page.locator(".pubs-opens");
    await expect(panel).toContainText("Tracking is off for this link");
    await expect(panel).toContainText("No opens yet");
    await expect(panel.locator(".pubs-open-list")).toHaveCount(0);
    // Still says what the numbers would and would not mean.
    await expect(panel).toContainText("not proof of identity");
  },
);

dashboardTest(
  "a new share link tracks opens unless the owner turns it off",
  async ({ page, server }) => {
    await stubDashboard(page);
    await openPublication(page, server.url);
    await page.getByRole("button", { name: "New share link…" }).click();

    const form = page.getByRole("form", { name: "New share link" });
    // The default the server would apply is the default the dashboard shows.
    await expect(form.getByLabel("Track opens")).toBeChecked();
    await form.getByLabel("Track opens").uncheck();
    await expect(form.getByLabel("Track opens")).not.toBeChecked();
  },
);
