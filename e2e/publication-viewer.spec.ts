import {
  expect,
  expectIframesNoHorizontalOverflow,
  expectNoHorizontalOverflow,
  owner,
  publicationTest as test,
  seedPublication,
  TINY_PNG_B64,
  uploadPublicAsset,
  type PublicServer,
} from "./fixtures.ts";
import type { Page } from "@playwright/test";

// The client-facing publication viewer (issue #7). It is server-rendered by the
// PUBLIC runtime — a separate server from the workspace one every other spec
// uses — so these tests drive `publicServer` and seed it through its owner API.

const HTML_SURFACE = `<div id="agent-html"><h3>Revenue</h3>${"<p>a paragraph of body copy that takes up room</p>".repeat(
  8,
)}</div>`;

const MARKDOWN_SURFACE = [
  "## Findings",
  "",
  ...Array.from({ length: 12 }, (_, i) => `- point ${i + 1}`),
].join("\n");

// Every surface carries enough content to be taller than the 220px default an
// iframe starts at, so the resize bridge has something to report on all six.
const DIFF_SURFACE = [
  "diff --git a/a.txt b/a.txt",
  "--- a/a.txt",
  "+++ b/a.txt",
  "@@ -1,20 +1,20 @@",
  ...Array.from({ length: 20 }, (_, i) => `-line ${i + 1} before\n+line ${i + 1} after`),
  "",
].join("\n");

const MERMAID_SURFACE = `graph TD; ${Array.from(
  { length: 12 },
  (_, i) => `N${i}[step number ${i}]-->N${i + 1}[step number ${i + 1}]`,
).join("; ")};`;

async function seedEveryKind(publicServer: PublicServer, link?: Record<string, unknown>) {
  const asset = await uploadPublicAsset(publicServer, {
    data: TINY_PNG_B64,
    contentType: "image/png",
    filename: "shot.png",
  });
  return seedPublication(publicServer, {
    title: "Quarterly report",
    items: [
      {
        postId: "post-1",
        title: "Frozen post",
        version: 1,
        surfaces: [
          { kind: "html", html: HTML_SURFACE },
          { kind: "markdown", markdown: MARKDOWN_SURFACE },
          { kind: "code", code: "const answer = 42;\n".repeat(10), language: "ts" },
          { kind: "terminal", text: "$ npm test\n".repeat(10) },
          { kind: "diff", patch: DIFF_SURFACE },
          { kind: "mermaid", mermaid: MERMAID_SURFACE },
          { kind: "image", assetId: asset.id, alt: "a png", caption: "figure 1" },
          { kind: "json", data: { answer: 42 } },
        ],
      },
    ],
    assetIds: [asset.id],
    ...(link && { link }),
  });
}

// Sandboxed surfaces are `loading="lazy"`, so a frame below the fold never
// loads (and never reports its height) until it is scrolled to.
async function loadEveryFrame(page: Page) {
  const frames = page.locator("iframe[data-surface]");
  const count = await frames.count();
  for (let i = 0; i < count; i++) {
    await frames.nth(i).scrollIntoViewIfNeeded();
  }
  // WebKit starts a lazy frame at about:blank; wait until every one of them has
  // navigated to its own surface document before measuring anything.
  await expect
    .poll(() => page.frames().filter((frame) => frame.url().includes("/s/")).length, {
      timeout: 15_000,
    })
    .toBe(count);
  await page.evaluate(() => window.scrollTo(0, 0));
}

// --- the page itself ----------------------------------------------------

test("a publication renders its title, its data surfaces and one sandboxed frame per surface", async ({
  page,
  publicServer,
}) => {
  const seeded = await seedEveryKind(publicServer);
  await page.goto(seeded.url);

  await expect(page.locator("h1")).toHaveText("Quarterly report");

  // Six sandboxed kinds; image and json have no HTML sink and are rendered as
  // escaped nodes in the page instead.
  const frames = page.locator("iframe[data-surface]");
  await expect(frames).toHaveCount(6);
  await expect(page.locator("figure.surface img")).toHaveAttribute("alt", "a png");
  await expect(page.locator("figure.surface figcaption")).toHaveText("figure 1");
  await expect(page.locator(".surface pre")).toContainText(`"answer": 42`);

  // Isolation: an opaque origin, never same-origin with the page.
  for (let i = 0; i < 6; i++) {
    await expect(frames.nth(i)).toHaveAttribute("sandbox", "allow-scripts allow-popups");
  }

  // Each frame's own content really rendered, and the resize bridge grew it
  // past the 220px default.
  await loadEveryFrame(page);
  for (let i = 0; i < 6; i++) {
    const frame = frames.nth(i);
    await frame.scrollIntoViewIfNeeded();
    await expect
      .poll(async () => (await frame.boundingBox())?.height ?? 0, { timeout: 15_000 })
      .toBeGreaterThan(220);
  }
  await expect(
    page.frameLocator("iframe[data-surface]").nth(0).locator("#agent-html h3"),
  ).toHaveText("Revenue");
  await expect(page.frameLocator("iframe[data-surface]").nth(1).locator("h2")).toHaveText(
    "Findings",
  );

  // No product branding anywhere a reader can see it.
  await expect(page.locator("body")).not.toContainText(/sideshow/i);
});

// --- light / dark -------------------------------------------------------

test("the scheme toggle flips the page, re-renders each surface and survives a reload", async ({
  page,
  publicServer,
}) => {
  const seeded = await seedEveryKind(publicServer);
  await page.goto(seeded.url);
  await loadEveryFrame(page);

  const root = page.locator("html");
  const frames = page.locator("iframe[data-surface]");

  // Nothing stored yet: the reader's system scheme decides, so no override.
  await expect(root).not.toHaveAttribute("data-scheme", /.*/);
  expect(await frames.first().getAttribute("src")).not.toContain("mode=");

  const toggle = page.locator("#scheme-toggle");
  await expect(toggle).toHaveAttribute("aria-label", "Switch between light and dark");
  await toggle.click();

  // A sandboxed surface bakes its colours into the document it was served as,
  // so switching must RELOAD each frame with an explicit mode.
  await expect(root).toHaveAttribute("data-scheme", "dark");
  for (let i = 0; i < (await frames.count()); i++) {
    await expect(frames.nth(i)).toHaveAttribute("src", /[?&]mode=dark/);
  }
  expect(await page.evaluate(() => localStorage.getItem("sideshow.scheme"))).toBe("dark");

  // The choice is the reader's, and it is theirs on the next visit too.
  await page.reload();
  await expect(root).toHaveAttribute("data-scheme", "dark");
  await expect(frames.first()).toHaveAttribute("src", /[?&]mode=dark/);

  // And back again.
  await toggle.click();
  await expect(root).toHaveAttribute("data-scheme", "light");
  await expect(frames.first()).toHaveAttribute("src", /[?&]mode=light/);
  await page.reload();
  await expect(root).toHaveAttribute("data-scheme", "light");
});

// --- responsive ---------------------------------------------------------

for (const [label, viewport] of [
  ["desktop", { width: 1280, height: 800 }],
  ["iPhone 14 Pro", { width: 393, height: 852 }],
] as const) {
  test(`the publication page has no horizontal overflow at ${label} width`, async ({
    page,
    publicServer,
  }) => {
    const seeded = await seedEveryKind(publicServer);
    await page.setViewportSize(viewport);
    await page.goto(seeded.url);
    await loadEveryFrame(page);

    await expect(page.locator("h1")).toBeVisible();
    await expectNoHorizontalOverflow(page, "body");
    await expectNoHorizontalOverflow(page, ".wrap");
    await expectNoHorizontalOverflow(page, ".surface");
    await expectIframesNoHorizontalOverflow(page, page.locator(".wrap"));
  });
}

// --- access controls ----------------------------------------------------

test("a password-protected link gates, refuses a wrong password and stays unlocked", async ({
  page,
  publicServer,
}) => {
  const seeded = await seedEveryKind(publicServer, { password: "s3cret-passphrase" });
  await page.goto(seeded.url);

  const gate = page.locator(".gate");
  await expect(gate.locator("h1")).toHaveText("This link is protected");
  await expect(page.locator("body")).not.toContainText("Quarterly report");

  await page.fill("#p", "not-the-password");
  await page.locator(".gate button").click();
  await expect(page.locator("#e")).toHaveText("That password did not work.");
  // Still the gate — nothing behind it leaked.
  await expect(gate).toBeVisible();
  await expect(page.locator("iframe[data-surface]")).toHaveCount(0);

  await page.fill("#p", "s3cret-passphrase");
  await page.locator(".gate button").click();
  await expect(page.locator("h1")).toHaveText("Quarterly report");
  await expect(page.locator("iframe[data-surface]")).toHaveCount(6);

  // The unlock is a cookie bound to the link, so it survives a reload.
  await page.reload();
  await expect(page.locator("h1")).toHaveText("Quarterly report");
});

test("a revoked link shows the not-available page and nothing else", async ({
  page,
  publicServer,
}) => {
  const seeded = await seedEveryKind(publicServer);
  await page.goto(seeded.url);
  await expect(page.locator("h1")).toHaveText("Quarterly report");

  await owner(publicServer, "PATCH", `/api/owner/links/${seeded.linkId}`, { revoked: true });

  await page.goto(seeded.url);
  await expect(page.locator("body")).toContainText("This link is not available.");
  await expect(page.locator("body")).not.toContainText("Quarterly report");
  await expect(page.locator("iframe")).toHaveCount(0);
});

// --- confirmed opens ----------------------------------------------------

async function watchOpens(page: Page): Promise<string[]> {
  const seen: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname.endsWith("/open")) {
      seen.push(request.url());
    }
  });
  return seen;
}

test("the confirmed-open beacon fires once the page has really rendered", async ({
  page,
  publicServer,
}) => {
  const seeded = await seedEveryKind(publicServer);
  const opens = await watchOpens(page);
  await page.goto(seeded.url);
  await expect(page.locator("h1")).toHaveText("Quarterly report");

  await expect.poll(() => opens.length, { timeout: 15_000 }).toBeGreaterThan(0);
  expect(opens[0]).toContain(`/api/v/${seeded.slug}/open`);
});

test("a link with tracking off never sends the beacon", async ({ page, publicServer }) => {
  const seeded = await seedEveryKind(publicServer, { trackOpens: false });
  const opens = await watchOpens(page);
  await page.goto(seeded.url);
  await expect(page.locator("h1")).toHaveText("Quarterly report");

  // The beacon is deliberately delayed past render; wait well beyond it.
  await page.waitForTimeout(4000);
  expect(opens).toEqual([]);
});
