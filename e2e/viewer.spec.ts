import { expect, publish, test, update } from "./fixtures.ts";

test("snippet published over HTTP appears live via SSE, no reload", async ({ page, server }) => {
  await page.goto(server.url);
  await expect(page.locator("#onboard")).toBeVisible();

  await publish(server.url, { html: "<h2>It works</h2>", title: "Live test", agent: "e2e" });

  // the card streams in over SSE — the page is never reloaded
  await expect(page.locator(".card-title")).toHaveText("Live test");
  await expect(page.locator("#onboard")).toBeHidden();
  await expect(page.locator(".sess-title")).toContainText("e2e session");
});

test("resize bridge grows the iframe beyond its 120px default", async ({ page, server }) => {
  const tall = `<div style="height: 600px">tall content</div>`;
  await publish(server.url, { html: tall, title: "Tall", agent: "e2e" });

  await page.goto(server.url);
  const iframe = page.locator(".card iframe");
  await expect(iframe).toBeVisible();
  // the sandboxed bridge must report content height via postMessage; this is
  // the WebKit-quirk regression test (see CLAUDE.md)
  await expect
    .poll(async () => (await iframe.boundingBox())?.height ?? 0, { timeout: 15_000 })
    .toBeGreaterThan(300);
});

test("comment typed in the composer round-trips to the API", async ({ page, server }) => {
  const snippet = await publish(server.url, { html: "<p>v1</p>", title: "Doc", agent: "e2e" });

  await page.goto(server.url);
  const input = page.locator(".composer input");
  await input.fill("ship it");
  await input.press("Enter");

  // renders in the thread (via SSE) and is persisted server-side
  await expect(page.locator(".cmt .txt")).toHaveText("ship it");
  await expect(page.locator(".cmt .who")).toHaveText("you");
  await expect
    .poll(async () => {
      const res = await fetch(`${server.url}/api/comments?snippet=${snippet.id}`);
      const data = (await res.json()) as { comments: { text: string }[] };
      return data.comments.map((c) => c.text);
    })
    .toContain("ship it");
});

test("version select appears live after an update", async ({ page, server }) => {
  const snippet = await publish(server.url, { html: "<p>v1</p>", title: "Doc", agent: "e2e" });

  await page.goto(server.url);
  await expect(page.locator(".card .vbadge")).toHaveText("v1");

  await update(server.url, snippet.id, { html: "<p>v2</p>" });

  const select = page.locator("select.vbadge");
  await expect(select).toBeVisible();
  await expect(select).toHaveValue("2");
  await expect(select.locator("option")).toHaveText(["v2", "v1"]);
});
