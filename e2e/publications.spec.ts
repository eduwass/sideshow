import { expect, test } from "./fixtures.ts";
import type { Page } from "@playwright/test";

// The publications dashboard talks to the public service through the private
// server's owner proxy, and a plain local sideshow has no destination at all —
// so every /api/publications* answer here is stubbed. What is being tested is
// the dashboard's own behaviour: what it shows, what it sends, and what it
// refuses to send until it is confirmed.

const ORIGIN = "https://public.example";

const PUBLICATIONS = [
  {
    id: "pub-1",
    kind: "collection",
    title: "Sprint review",
    originSessionId: "sess-1",
    originPostId: null,
    currentSnapshotId: "snap-2",
    identity: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:00.000Z",
  },
  {
    id: "pub-2",
    kind: "post",
    title: "One diagram",
    originSessionId: null,
    originPostId: "post-9",
    currentSnapshotId: "snap-9",
    identity: null,
    createdAt: "2026-08-02T00:00:00.000Z",
    updatedAt: "2026-08-17T00:00:00.000Z",
  },
];

const link = (over: Record<string, unknown>) => ({
  id: "link-1",
  publicationId: "pub-1",
  slug: "abcdef",
  custom: false,
  recipientLabel: null,
  hasPassword: false,
  expiresAt: null,
  revokedAt: null,
  trackOpens: false,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  ...over,
});

const LINKS = [
  link({ id: "link-active", slug: "aaaaaa", recipientLabel: "Acme", hasPassword: true }),
  link({ id: "link-expired", slug: "bbbbbb", expiresAt: "2020-01-01T00:00:00.000Z" }),
  link({ id: "link-revoked", slug: "cccccc", revokedAt: "2026-08-10T00:00:00.000Z" }),
];

const DETAIL = {
  origin: ORIGIN,
  publication: PUBLICATIONS[0],
  snapshots: [
    {
      id: "snap-2",
      publicationId: "pub-1",
      revision: 2,
      title: "Sprint review",
      assetIds: [],
      createdAt: "2026-08-18T00:00:00.000Z",
      itemCount: 3,
    },
  ],
  links: LINKS,
};

const DETAIL_2 = {
  origin: ORIGIN,
  publication: PUBLICATIONS[1],
  snapshots: [
    {
      id: "snap-9",
      publicationId: "pub-2",
      revision: 1,
      title: "One diagram",
      assetIds: [],
      createdAt: "2026-08-17T00:00:00.000Z",
      itemCount: 1,
    },
  ],
  links: [link({ id: "link-solo", publicationId: "pub-2", slug: "dddddd" })],
};

type Sent = { method: string; path: string; body: unknown };

// Stubs the destination probe and every publications route, and records the
// writes so a test can assert that a confirmation step really did gate one.
async function stubPublications(page: Page): Promise<Sent[]> {
  const sent: Sent[] = [];
  await page.route("**/api/publish/destination", (route) =>
    route.fulfill({ json: { configured: true, origin: ORIGIN } }),
  );
  await page.route("**/api/publications**", (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (method !== "GET") {
      sent.push({ method, path, body: request.postDataJSON() });
    }
    if (method === "GET" && path === "/api/publications") {
      return route.fulfill({ json: { origin: ORIGIN, publications: PUBLICATIONS } });
    }
    if (method === "GET" && path === "/api/publications/pub-1") {
      return route.fulfill({ json: DETAIL });
    }
    if (method === "GET" && path === "/api/publications/pub-2") {
      return route.fulfill({ json: DETAIL_2 });
    }
    if (method === "POST" && path.endsWith("/duplicate")) {
      return route.fulfill({ status: 201, json: link({ id: "link-copy", slug: "eeeeee" }) });
    }
    if (method === "POST" && path === "/api/publications/pub-1/links") {
      // The one server refusal the dashboard must show verbatim.
      return route.fulfill({ status: 409, json: { error: "that link address is already taken" } });
    }
    if (method === "PATCH") {
      return route.fulfill({
        json: link({ id: "link-active", revokedAt: "2026-08-19T00:00:00Z" }),
      });
    }
    return route.fulfill({ status: 204, body: "" });
  });
  return sent;
}

// The dashboard is reached from the sidebar footer, which is also what proves
// the entry exists and is enabled once a destination is configured.
async function openDashboard(page: Page, serverUrl: string) {
  await page.goto(serverUrl);
  await page.getByRole("link", { name: "publications" }).click();
  await expect(page.getByRole("heading", { name: "Publications" })).toBeVisible();
}

test("the dashboard lists every publication with its kind, revision and link count", async ({
  page,
  server,
}) => {
  await stubPublications(page);
  await openDashboard(page, server.url);

  const rows = page.locator(".pubs-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText("Sprint review");
  await expect(rows.first()).toContainText("Collection");
  await expect(rows.first()).toContainText("revision 2");
  await expect(rows.first()).toContainText("3 share links");
  await expect(rows.nth(1)).toContainText("One diagram");
  await expect(rows.nth(1)).toContainText("Post");
  await expect(rows.nth(1)).toContainText("1 share link");
});

test("the entry is disabled, with a reason, when no destination is configured", async ({
  page,
  server,
}) => {
  await page.route("**/api/publish/destination", (route) =>
    route.fulfill({ json: { configured: false, origin: null } }),
  );
  await page.goto(server.url);
  const entry = page.getByRole("button", { name: "publications" });
  await expect(entry).toBeDisabled();
  await expect(entry).toHaveAttribute(
    "title",
    "This workspace has no publication destination configured. See the README.",
  );
  await expect(page.getByRole("link", { name: "publications" })).toHaveCount(0);
});

test("an empty workspace says so instead of showing an empty table", async ({ page, server }) => {
  await page.route("**/api/publish/destination", (route) =>
    route.fulfill({ json: { configured: true, origin: ORIGIN } }),
  );
  await page.route("**/api/publications**", (route) =>
    route.fulfill({ json: { origin: ORIGIN, publications: [] } }),
  );
  await openDashboard(page, server.url);
  await expect(page.locator(".pubs-empty")).toContainText("Nothing published yet");
});

test("opening a publication shows each link's state, and expired and revoked read as unusable", async ({
  page,
  server,
}) => {
  await stubPublications(page);
  await openDashboard(page, server.url);
  await page.locator(".pubs-row").first().click();

  await expect(page.getByRole("heading", { name: "Sprint review" })).toBeVisible();
  // Snapshot history.
  await expect(page.locator(".pubs-snaps li")).toHaveCount(1);
  await expect(page.locator(".pubs-snaps li")).toContainText("Revision 2");
  await expect(page.locator(".pubs-snaps li")).toContainText("3 posts");

  const rows = page.locator("tr.pubs-link");
  await expect(rows).toHaveCount(3);

  const active = page.locator('tr[data-slug="aaaaaa"]');
  await expect(active).toContainText(`${ORIGIN}/v/aaaaaa`);
  await expect(active).toContainText("Acme");
  await expect(active).toContainText("Password");
  await expect(active).toContainText("No expiry");
  await expect(active).toContainText("Not tracking opens");
  await expect(active.locator(".pubs-state")).toHaveText("Active");
  await expect(active).not.toHaveClass(/dead/);

  const expired = page.locator('tr[data-slug="bbbbbb"]');
  await expect(expired.locator(".pubs-state")).toHaveText("Expired");
  await expect(expired).toHaveClass(/dead/);

  const revoked = page.locator('tr[data-slug="cccccc"]');
  await expect(revoked.locator(".pubs-state")).toHaveText("Revoked");
  await expect(revoked).toHaveClass(/dead/);
  // Nothing left to revoke on an already-revoked link.
  await expect(revoked.getByRole("button", { name: "Revoke" })).toHaveCount(0);

  // Open is a real anchor, so middle-click and copy-link work too.
  const open = active.getByRole("link", { name: "Open" });
  await expect(open).toHaveAttribute("href", `${ORIGIN}/v/aaaaaa`);
  await expect(open).toHaveAttribute("target", "_blank");
  await expect(open).toHaveAttribute("rel", "noopener noreferrer");
});

test("copy puts the link's full URL on the clipboard", async ({
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
  await stubPublications(page);
  await openDashboard(page, server.url);
  await page.locator(".pubs-row").first().click();

  await page.locator('tr[data-slug="aaaaaa"]').getByRole("button", { name: "Copy" }).click();
  await expect(page.locator("#toast")).toHaveText("Link copied");
  if (browserName === "chromium") {
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toBe(`${ORIGIN}/v/aaaaaa`);
  }
});

test("the custom-slug field says plainly that a custom address is not a secret", async ({
  page,
  server,
}) => {
  const sent = await stubPublications(page);
  await openDashboard(page, server.url);
  await page.locator(".pubs-row").first().click();
  await page.getByRole("button", { name: "New share link…" }).click();

  const form = page.getByRole("form", { name: "New share link" });
  await expect(form.getByLabel("Custom address (optional)")).toBeVisible();
  const warning = form.locator(".pubs-warn");
  await expect(warning).toBeVisible();
  await expect(warning).toContainText("not a secret");
  await expect(warning).toContainText("anyone who guesses");
  await expect(warning).toContainText("unguessable");

  // A refused custom slug is reported in the server's own words.
  await form.getByLabel("Custom address (optional)").fill("taken-name");
  await form.getByRole("button", { name: "Create link" }).click();
  await expect(page.locator("#toast")).toHaveText("that link address is already taken");
  expect(sent).toContainEqual({
    method: "POST",
    path: "/api/publications/pub-1/links",
    // Tracking is on unless the owner unchecks it, matching the server default.
    body: { trackOpens: true, slug: "taken-name" },
  });
});

test("duplicate POSTs to the duplicate route with the label given", async ({ page, server }) => {
  const sent = await stubPublications(page);
  await openDashboard(page, server.url);
  await page.locator(".pubs-row").first().click();

  await page.locator('tr[data-slug="aaaaaa"]').getByRole("button", { name: "Duplicate" }).click();
  const form = page.getByRole("form", { name: "Duplicate share link" });
  await form.getByLabel("Recipient label for the copy (optional)").fill("Second reviewer");
  await form.getByRole("button", { name: "Duplicate link" }).click();

  await expect(page.locator("#toast")).toHaveText("Link duplicated");
  expect(sent).toContainEqual({
    method: "POST",
    path: "/api/publications/links/link-active/duplicate",
    body: { recipientLabel: "Second reviewer" },
  });
});

test("revoke sends nothing until the confirmation is accepted", async ({ page, server }) => {
  const sent = await stubPublications(page);
  await openDashboard(page, server.url);
  await page.locator(".pubs-row").first().click();

  const row = page.locator('tr[data-slug="aaaaaa"]');
  await row.getByRole("button", { name: "Revoke" }).click();
  const confirmation = page.locator(".pubs-subrow").filter({ hasText: "Revoke this link?" });
  await expect(confirmation).toBeVisible();

  // Dismissing the confirmation is genuinely inert.
  await confirmation.getByRole("button", { name: "Cancel" }).click();
  await expect(confirmation).toHaveCount(0);
  expect(sent).toEqual([]);

  await row.getByRole("button", { name: "Revoke" }).click();
  await page.locator(".pubs-subrow").getByRole("button", { name: "Revoke this link" }).click();

  await expect(page.locator("#toast")).toHaveText("Link revoked");
  expect(sent).toEqual([
    {
      method: "PATCH",
      path: "/api/publications/links/link-active",
      body: { revoked: true },
    },
  ]);
});

test("updating a link sends the label, expiry, tracking and password it was given", async ({
  page,
  server,
}) => {
  const sent = await stubPublications(page);
  await openDashboard(page, server.url);
  await page.locator(".pubs-row").first().click();

  await page.locator('tr[data-slug="aaaaaa"]').getByRole("button", { name: "Update" }).click();
  const form = page.getByRole("form", { name: "Update share link" });
  await form.getByLabel("Recipient label").fill("Acme design team");
  await form.getByLabel("Remove the password").check();
  await form.getByLabel("Track opens").check();
  await form.getByRole("button", { name: "Save changes" }).click();

  await expect(page.locator("#toast")).toHaveText("Link updated");
  expect(sent).toEqual([
    {
      method: "PATCH",
      path: "/api/publications/links/link-active",
      body: {
        recipientLabel: "Acme design team",
        trackOpens: true,
        expiresAt: null,
        password: null,
      },
    },
  ]);
});

test("the share-link table stays readable at phone width", async ({ page, server }) => {
  await stubPublications(page);
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto(server.url);
  // The sidebar (and its footer links) live behind the drawer at phone width.
  await page.getByRole("button", { name: "Show sessions" }).click();
  await page.getByRole("link", { name: "publications" }).click();
  await page.locator(".pubs-row").first().click();

  const wrap = page.locator(".pubs-table-wrap");
  await expect(wrap).toBeVisible();
  const overflow = await wrap.evaluate((el) => Math.ceil(el.scrollWidth - el.clientWidth));
  expect(overflow).toBeLessThanOrEqual(1);
});
