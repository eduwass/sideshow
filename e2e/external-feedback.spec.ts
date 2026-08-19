import {
  expect,
  expectIframesNoHorizontalOverflow,
  expectNoHorizontalOverflow,
  listFeedback,
  publicationTest as test,
  seedPublication,
  type PublicServer,
  type SeededPublication,
} from "./fixtures.ts";
import type { Page } from "@playwright/test";

// Point and highlighted-text feedback (issue #9), end to end on the real thing:
// the quote is captured INSIDE the opaque-origin surface iframe (the trusted
// page cannot read a selection across that boundary and must not be able to),
// travels over the postMessage bridge, and is submitted by the page.
//
// Runs on every project the suite defines — chromium and webkit — and at both a
// desktop and a phone width, because the composer is a different layout on each.

const PARAGRAPH = "Growth was strong this quarter.";
const SECOND = "Margins narrowed slightly.";

// Two paragraphs with the SAME words appear twice, so the duplicate-quote case
// is exercised by the real capture path rather than only in a unit test.
const HTML_SURFACE =
  `<div id="report">` +
  `<h3>Revenue</h3>` +
  `<p id="p1">${PARAGRAPH}</p>` +
  `<p id="p2">${SECOND}</p>` +
  `<p id="p3">${PARAGRAPH}</p>` +
  `${"<p>filler copy that gives the surface some height</p>".repeat(6)}` +
  `</div>`;

async function seed(publicServer: PublicServer): Promise<SeededPublication> {
  return seedPublication(publicServer, {
    title: "Quarterly report",
    items: [
      {
        postId: "post-1",
        title: "Frozen post",
        version: 1,
        surfaces: [
          { kind: "html", html: HTML_SURFACE, id: "surface-html" },
          { kind: "markdown", markdown: `## Findings\n\n${PARAGRAPH}\n` },
        ],
      },
    ],
  });
}

const VIEWPORTS = [
  ["desktop", { width: 1280, height: 800 }],
  ["iPhone 14 Pro", { width: 393, height: 852 }],
] as const;

/** The surface frames are lazy: nothing loads until it has been scrolled to. */
async function loadFrames(page: Page) {
  const frames = page.locator("iframe[data-surface]");
  const count = await frames.count();
  for (let i = 0; i < count; i++) await frames.nth(i).scrollIntoViewIfNeeded();
  await expect
    .poll(() => page.frames().filter((frame) => frame.url().includes("/s/")).length, {
      timeout: 15_000,
    })
    .toBe(count);
}

/** Select a whole paragraph inside the first surface iframe. */
async function selectParagraph(page: Page, id: string) {
  const target = page.frameLocator("iframe[data-surface]").first().locator(`#${id}`);
  await expect(target).toBeVisible();
  await target.click({ clickCount: 3 });
}

async function fillAndSend(page: Page, note: string, name?: string) {
  const panel = page.locator("#fb-panel");
  await expect(panel).toBeVisible();
  if (name !== undefined) await page.locator("#fb-name").fill(name);
  await page.locator("#fb-note").fill(note);
  await page.locator("#fb-send").click();
}

// --- text anchors -------------------------------------------------------

for (const [label, viewport] of VIEWPORTS) {
  test(`a client can quote text in a surface and send a private note (${label})`, async ({
    page,
    publicServer,
  }) => {
    const seeded = await seed(publicServer);
    await page.setViewportSize(viewport);
    await page.goto(seeded.url);
    await loadFrames(page);

    await selectParagraph(page, "p1");

    // The composer opened with the quote — as TEXT, in the trusted page.
    const panel = page.locator("#fb-panel");
    await expect(panel).toBeVisible();
    await expect(page.locator("#fb-quote")).toContainText(PARAGRAPH);
    // The name is asked because this browser has not answered it yet.
    await expect(page.locator("#fb-name-row")).toBeVisible();

    await fillAndSend(page, "this number looks stale", "Dana");
    await expect(page.locator("#fb-done")).toContainText("Thanks");
    await expect(panel).toBeHidden();

    const stored = await listFeedback(publicServer, seeded.publicationId);
    expect(stored).toHaveLength(1);
    const feedback = stored[0]!;
    expect(feedback.note).toBe("this number looks stale");
    expect(feedback.name).toBe("Dana");
    expect(feedback.snapshotId).toBe(seeded.snapshotId);
    const anchor = feedback.anchor as {
      kind: string;
      quote: string;
      itemIndex: number;
      surfaceIndex: number;
      surfaceId?: string;
      startMeta?: { parentTagName: string; parentIndex: number; textOffset: number };
      endMeta?: { parentTagName: string; textOffset: number };
    };
    expect(anchor.kind).toBe("text");
    expect(anchor.quote).toContain(PARAGRAPH);
    expect(anchor.itemIndex).toBe(0);
    expect(anchor.surfaceIndex).toBe(0);
    expect(anchor.surfaceId).toBe("surface-html");
    // The structural range survived the frame's own quote check, so the owner
    // can re-anchor it rather than searching for the words again.
    expect(anchor.startMeta?.parentTagName).toBe("P");
    expect(anchor.endMeta?.parentTagName).toBe("P");
    // Context either side of the quote comes from the same verified pass.
    expect(anchor.prefix).toContain("Revenue");
  });
}

// --- quote verification -------------------------------------------------

/** Ask the surface frame to re-anchor stored anchors and report each result. */
async function restoreInFrame(page: Page, anchors: unknown[]) {
  return page.evaluate(async (list) => {
    const frame = document.querySelector("iframe[data-surface]") as HTMLIFrameElement;
    return await new Promise<{ status: string; found: string | null }[]>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no reply from the frame")), 10_000);
      function onMessage(event: MessageEvent) {
        const data = event.data as { __pub?: unknown; type?: unknown; results?: unknown };
        if (!data || data.__pub !== true || data.type !== "feedback-restored") return;
        clearTimeout(timer);
        window.removeEventListener("message", onMessage);
        resolve(data.results as { status: string; found: string | null }[]);
      }
      window.addEventListener("message", onMessage);
      frame.contentWindow!.postMessage(
        { __pub: true, type: "feedback-restore", anchors: list },
        "*",
      );
    });
  }, anchors);
}

test("a stored anchor re-anchors, and a quote that no longer matches is reported not painted", async ({
  page,
  publicServer,
}) => {
  const seeded = await seed(publicServer);
  await page.goto(seeded.url);
  await loadFrames(page);
  await selectParagraph(page, "p1");
  await fillAndSend(page, "check this", "Dana");
  await expect(page.locator("#fb-done")).toContainText("Thanks");

  const stored = (await listFeedback(publicServer, seeded.publicationId))[0]!;
  const anchor = stored.anchor as Record<string, unknown>;
  const results = await restoreInFrame(page, [
    anchor,
    { ...anchor, quote: "words that were never in this surface" },
  ]);

  expect(results[0]!.status).toBe("verified");
  expect(results[0]!.found).toContain(PARAGRAPH);
  // The structural position still resolves, but the text there is not the
  // stored quote — so it is reported as drifted rather than mis-highlighted.
  expect(results[1]!.status).toBe("drifted");
  expect(results[1]!.found).toContain(PARAGRAPH);

  // Only the verified one was painted.
  const marks = page.frameLocator("iframe[data-surface]").first().locator(".sideshow-fb-mark");
  await expect(marks.first()).toBeVisible();
  await expect(marks.first()).toContainText("Growth");
});

// --- bridge boundary ----------------------------------------------------

test("the page ignores capture messages that did not come from one of its frames", async ({
  page,
  publicServer,
}) => {
  const seeded = await seed(publicServer);
  await page.goto(seeded.url);
  await loadFrames(page);

  // Same shape, wrong sender: the page matches e.source against its own frames.
  await page.evaluate(() => {
    window.postMessage(
      { __pub: true, type: "feedback-select", anchor: { kind: "text", quote: "spoofed" } },
      "*",
    );
    window.postMessage(
      { __pub: true, type: "feedback-point", anchor: { kind: "point", x: 0.5, y: 0.5 } },
      "*",
    );
  });
  await page.waitForTimeout(500);
  await expect(page.locator("#fb-panel")).toBeHidden();
  await expect(page.locator("body")).not.toContainText("spoofed");
  expect(await listFeedback(publicServer, seeded.publicationId)).toHaveLength(0);
});

test("the same quote in two places produces two distinguishable anchors", async ({
  page,
  publicServer,
}) => {
  const seeded = await seed(publicServer);
  await page.goto(seeded.url);
  await loadFrames(page);

  await selectParagraph(page, "p1");
  await fillAndSend(page, "first occurrence", "Dana");
  await expect(page.locator("#fb-panel")).toBeHidden();

  await selectParagraph(page, "p3");
  await fillAndSend(page, "third occurrence");
  await expect(page.locator("#fb-panel")).toBeHidden();

  const stored = await listFeedback(publicServer, seeded.publicationId);
  expect(stored).toHaveLength(2);
  const metas = stored.map(
    (f) => (f.anchor as { startMeta?: { parentIndex: number } }).startMeta?.parentIndex,
  );
  for (const f of stored) {
    expect((f.anchor as { quote: string }).quote).toContain(PARAGRAPH);
  }
  // Identical words, different structural positions.
  expect(new Set(metas).size).toBe(2);
});

// --- point anchors ------------------------------------------------------

test("a point anchor records normalized coordinates inside the surface", async ({
  page,
  publicServer,
}) => {
  const seeded = await seed(publicServer);
  await page.goto(seeded.url);
  await loadFrames(page);

  const add = page.locator("#fb-add");
  await add.click();
  await expect(add).toHaveAttribute("aria-pressed", "true");

  const frame = page.locator("iframe[data-surface]").first();
  await frame.scrollIntoViewIfNeeded();
  const box = (await frame.boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.4);

  await expect(page.locator("#fb-panel")).toBeVisible();
  await expect(page.locator("#fb-quote")).toContainText("A spot on");
  await fillAndSend(page, "what is this bit?", "Dana");
  await expect(page.locator("#fb-done")).toContainText("Thanks");

  const stored = await listFeedback(publicServer, seeded.publicationId);
  expect(stored).toHaveLength(1);
  const anchor = stored[0]!.anchor as { kind: string; x: number; y: number; surfaceIndex: number };
  expect(anchor.kind).toBe("point");
  expect(anchor.surfaceIndex).toBe(0);
  expect(anchor.x).toBeGreaterThan(0);
  expect(anchor.x).toBeLessThanOrEqual(1);
  expect(anchor.y).toBeGreaterThan(0);
  expect(anchor.y).toBeLessThanOrEqual(1);
  // Roughly where it was clicked, not an arbitrary number in range.
  expect(Math.abs(anchor.x - 0.5)).toBeLessThan(0.15);
});

// --- identity -----------------------------------------------------------

test("the name is asked once per browser and never again", async ({ page, publicServer }) => {
  const seeded = await seed(publicServer);
  await page.goto(seeded.url);
  await loadFrames(page);

  await selectParagraph(page, "p1");
  await expect(page.locator("#fb-name-row")).toBeVisible();
  await fillAndSend(page, "first note", "Dana");
  await expect(page.locator("#fb-panel")).toBeHidden();

  // Same browser, a whole page load later: no second ask.
  await page.reload();
  await loadFrames(page);
  await selectParagraph(page, "p2");
  await expect(page.locator("#fb-panel")).toBeVisible();
  await expect(page.locator("#fb-name-row")).toBeHidden();
  await fillAndSend(page, "second note");
  await expect(page.locator("#fb-done")).toContainText("Thanks");

  const stored = await listFeedback(publicServer, seeded.publicationId);
  expect(stored.map((f) => f.name).sort()).toEqual(["Dana", "Dana"]);
  expect(stored.map((f) => f.note).sort()).toEqual(["first note", "second note"]);
});

// --- privacy ------------------------------------------------------------

test("a client sees no other client's feedback anywhere on the page", async ({
  page,
  publicServer,
  browser,
}) => {
  const seeded = await seed(publicServer);
  await page.goto(seeded.url);
  await loadFrames(page);
  await selectParagraph(page, "p1");
  await fillAndSend(page, "a secret from the first reader", "Dana");
  await expect(page.locator("#fb-done")).toContainText("Thanks");

  // A different browser entirely — its own storage, its own cookies.
  const other = await browser.newContext();
  const second = await other.newPage();
  await second.goto(seeded.url);
  await expect(second.locator("h1")).toHaveText("Quarterly report");
  await loadFrames(second);

  await expect(second.locator("body")).not.toContainText("a secret from the first reader");
  await expect(second.locator("body")).not.toContainText("Dana");
  for (const frame of second.frames()) {
    if (frame === second.mainFrame()) continue;
    expect(await frame.content()).not.toContain("a secret from the first reader");
  }
  // Nor does the publication's own JSON carry any of it.
  const payload = await second.evaluate(
    async (slug) => JSON.stringify(await (await fetch(`/api/v/${slug}`)).json()),
    seeded.slug,
  );
  expect(payload).not.toContain("secret from the first reader");
  expect(payload.toLowerCase()).not.toContain("feedback");
  await other.close();
});

// --- responsive ---------------------------------------------------------

for (const [label, viewport] of VIEWPORTS) {
  test(`the composer is usable and the page never scrolls sideways at ${label} width`, async ({
    page,
    publicServer,
  }) => {
    const seeded = await seed(publicServer);
    await page.setViewportSize(viewport);
    await page.goto(seeded.url);
    await loadFrames(page);

    await selectParagraph(page, "p1");
    const panel = page.locator("#fb-panel");
    await expect(panel).toBeVisible();
    // Every control is reachable, not clipped off the side of a phone.
    const panelBox = (await panel.boundingBox())!;
    expect(panelBox.x).toBeGreaterThanOrEqual(0);
    expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(viewport.width + 1);
    for (const id of ["#fb-note", "#fb-send", "#fb-cancel", "#fb-name"]) {
      await expect(page.locator(id)).toBeVisible();
    }
    // The honeypot is clipped to a pixel and out of the tab order — invisible
    // to a person, still there for a bot that fills every field.
    await expect(page.locator("#fb-website")).toHaveAttribute("tabindex", "-1");
    const hp = (await page.locator("#fb-website").boundingBox())!;
    expect(hp.width).toBeLessThanOrEqual(2);
    expect(hp.height).toBeLessThanOrEqual(2);

    await page.locator("#fb-note").fill("a note typed on a small screen");
    await expectNoHorizontalOverflow(page, "body");
    await expectNoHorizontalOverflow(page, ".wrap");
    await expectNoHorizontalOverflow(page, "#fb-panel");
    await expectIframesNoHorizontalOverflow(page, page.locator(".wrap"));

    await page.locator("#fb-cancel").click();
    await expect(panel).toBeHidden();
  });
}
