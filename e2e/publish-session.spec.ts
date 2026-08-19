import { expect, publish, test } from "./fixtures.ts";
import type { Page } from "@playwright/test";

// Publishing a session puts a whole conversation on the public web, so the
// header action never publishes directly — it opens a mandatory confirmation
// view. Two things are covered here: the affordance stays discoverable on a
// plain local server (which has no destination), and the confirmation view
// itself, against a stubbed destination.

const NO_DESTINATION = "This workspace has no publication destination configured. See the README.";

const DESTINATION = "https://public.example";

test("the session publish action is offered but inert without a destination", async ({
  page,
  server,
}) => {
  await publish(server.url, { html: "<p>one</p>", title: "First", agent: "e2e" });

  const publishRequests: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/publish/session")) publishRequests.push(request.method());
  });

  await page.goto(server.url);
  await expect(page.locator(".card:not(#whatsNew)")).toHaveCount(1);

  const action = page.locator(".session-head button.publish-session");
  await expect(action).toBeVisible();
  await expect(action).toHaveText("Publish session…");
  await expect(action).toBeDisabled();
  await expect(action).toHaveAttribute("title", NO_DESTINATION);

  // A real click on a disabled button dispatches no activation: no dialog, and
  // nothing sent — not even the preview read.
  await action.click({ force: true });
  await expect(page.getByRole("dialog", { name: "Publish this session" })).toHaveCount(0);
  expect(publishRequests).toEqual([]);
});

// The stub stands in for a configured destination. It is one handler rather than
// three routes so the ordering between `/api/publish/session/:id` and
// `/api/publish/session` can't be ambiguous.
async function stubDestination(
  page: Page,
  sessionId: string,
  posts: { postId: string; title: string; surfaceKinds: string[]; publishable: boolean }[],
  posted: { body: unknown }[],
) {
  await page.route(
    (url) => url.pathname.startsWith("/api/publish/"),
    async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const json = (body: unknown, status = 200) =>
        route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

      if (path === "/api/publish/destination") {
        return json({ configured: true, origin: DESTINATION });
      }
      if (path.endsWith("/preview")) {
        return json({
          sessionId,
          title: "A reviewed session",
          posts: posts.map((post) => ({
            ...post,
            version: 1,
            updatedAt: "2026-08-19T00:00:00.000Z",
          })),
        });
      }
      if (path === "/api/publish/session" && request.method() === "POST") {
        posted.push({ body: request.postDataJSON() });
        return json(
          {
            publicationId: "pub-1",
            snapshotId: "snap-1",
            revision: 1,
            slug: "abc",
            url: `${DESTINATION}/v/abc`,
            updated: false,
          },
          201,
        );
      }
      // Both status routes (session and post): configured, nothing published yet.
      return json({ configured: true, published: false });
    },
  );
}

test("the confirmation view lists every session post, checked by default", async ({
  page,
  server,
}) => {
  const first = await publish(server.url, { html: "<p>one</p>", title: "First", agent: "e2e" });
  const second = await publish(server.url, {
    html: "<p>two</p>",
    title: "Second",
    agent: "e2e",
    session: first.sessionId,
  });

  const posted: { body: unknown }[] = [];
  await stubDestination(
    page,
    first.sessionId,
    [
      { postId: first.id, title: "First", surfaceKinds: ["html"], publishable: true },
      { postId: second.id, title: "Second", surfaceKinds: ["markdown"], publishable: true },
      { postId: "empty-1", title: "Empty", surfaceKinds: [], publishable: false },
    ],
    posted,
  );

  await page.goto(server.url);
  await expect(page.locator(".card:not(#whatsNew)")).toHaveCount(2);

  const action = page.locator(".session-head button.publish-session");
  await expect(action).toBeEnabled();
  await action.click();

  const dialog = page.getByRole("dialog", { name: "Publish this session" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("aria-modal", "true");

  const rows = dialog.locator(".publish-row");
  await expect(rows).toHaveCount(3);
  await expect(rows.locator(".publish-row-title")).toHaveText(["First", "Second", "Empty"]);

  // Every publishable post is ticked without the user doing anything.
  const boxes = dialog.locator("input[type=checkbox]");
  await expect(boxes.nth(0)).toBeChecked();
  await expect(boxes.nth(1)).toBeChecked();
  // The post with nothing publishable is listed for review, but can't be sent.
  await expect(boxes.nth(2)).not.toBeChecked();
  await expect(boxes.nth(2)).toBeDisabled();
  await expect(rows.nth(2)).toContainText("nothing publishable");

  await expect(dialog.locator(".publish-count")).toHaveText("Publishing 2 of 3 posts");

  // Unchecking one narrows the collection.
  await boxes.nth(1).uncheck();
  await expect(dialog.locator(".publish-count")).toHaveText("Publishing 1 of 3 posts");

  // And unchecking the rest leaves nothing to publish.
  await boxes.nth(0).uncheck();
  await expect(dialog.locator(".publish-count")).toHaveText("Publishing 0 of 3 posts");
  await expect(dialog.getByRole("button", { name: "Publish session" })).toBeDisabled();

  // Cancel is the accidental-open path: it closes and writes nothing.
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(posted).toEqual([]);

  // Escape is the same inert exit.
  await action.click();
  await expect(page.getByRole("dialog", { name: "Publish this session" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Publish this session" })).toHaveCount(0);
  expect(posted).toEqual([]);
});

test("confirming publishes exactly the checked posts", async ({ page, server }) => {
  const first = await publish(server.url, { html: "<p>one</p>", title: "First", agent: "e2e" });
  const second = await publish(server.url, {
    html: "<p>two</p>",
    title: "Second",
    agent: "e2e",
    session: first.sessionId,
  });

  const posted: { body: unknown }[] = [];
  await stubDestination(
    page,
    first.sessionId,
    [
      { postId: first.id, title: "First", surfaceKinds: ["html"], publishable: true },
      { postId: second.id, title: "Second", surfaceKinds: ["markdown"], publishable: true },
    ],
    posted,
  );

  await page.goto(server.url);
  await expect(page.locator(".card:not(#whatsNew)")).toHaveCount(2);
  await page.locator(".session-head button.publish-session").click();

  const dialog = page.getByRole("dialog", { name: "Publish this session" });
  await expect(dialog).toBeVisible();
  await dialog.locator("input[type=checkbox]").nth(1).uncheck();
  await expect(dialog.locator(".publish-count")).toHaveText("Publishing 1 of 2 posts");

  await dialog.getByRole("button", { name: "Publish session" }).click();

  await expect(page.locator("#toast")).toContainText("Session published", { timeout: 5_000 });
  await expect(dialog).toHaveCount(0);
  expect(posted).toEqual([{ body: { sessionId: first.sessionId, postIds: [first.id] } }]);
});
