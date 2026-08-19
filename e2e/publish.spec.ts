import { expect, publish, test } from "./fixtures.ts";

// A plain local server has no publication destination, so what the share menu
// must do here is offer the affordance and explain why it is inert — the row
// staying discoverable is the point, exactly like the screenshot row.

const NO_DESTINATION = "This workspace has no publication destination configured. See the README.";

test("the publish row is offered but inert without a destination", async ({ page, server }) => {
  // One session, two posts — the second card is what proves the destination
  // answer is shared rather than refetched per menu.
  const first = await publish(server.url, { html: "<p>one</p>", title: "First", agent: "e2e" });
  await publish(server.url, {
    html: "<p>two</p>",
    title: "Second",
    agent: "e2e",
    session: first.sessionId,
  });

  const destinationRequests: string[] = [];
  const publishRequests: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path === "/api/publish/destination") destinationRequests.push(request.method());
    if (path.startsWith("/api/publish/post")) publishRequests.push(request.method());
  });

  await page.goto(server.url);
  const cards = page.locator(".card:not(#whatsNew)");
  await expect(cards).toHaveCount(2);
  const menu = page.locator(".share-menu");

  await cards.first().locator(".act.share").click();
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem")).toHaveText([
    "Copy link",
    "Copy as markdown",
    "Open in new tab",
    "Open as image",
    "Publish to the web…",
  ]);

  const row = menu.getByRole("menuitem", { name: "Publish to the web…" });
  await expect(row).toBeDisabled();
  await expect(row).toHaveAttribute("title", NO_DESTINATION);
  // Nothing to open: an unpublished post gets no publication link.
  await expect(menu.getByRole("menuitem", { name: "Open publication" })).toHaveCount(0);

  // A real click on a disabled row dispatches no activation, so nothing is sent.
  await row.click({ force: true });
  await expect(menu).toBeVisible();
  expect(publishRequests.filter((method) => method === "POST")).toEqual([]);

  // With no destination, the menu never asks about this post's publication.
  expect(publishRequests).toEqual([]);
  expect(destinationRequests).toEqual(["GET"]);

  // Opening a second card's menu reuses the one destination answer.
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await cards.nth(1).locator(".act.share").click();
  await expect(menu.getByRole("menuitem", { name: "Publish to the web…" })).toBeDisabled();
  expect(destinationRequests).toEqual(["GET"]);
  expect(publishRequests).toEqual([]);
});
