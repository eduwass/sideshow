import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { buildFeedbackCaptureModule, BUNDLE_PATH } from "../scripts/buildFeedbackCapture.ts";
import { createApp } from "../server/app.ts";
import { FEEDBACK_CAPTURE_JS } from "../server/feedbackCaptureBundle.ts";
import { createPublicApp } from "../server/publicApp.ts";
import { createSqliteStorage } from "../server/sqliteStorage.ts";
import { SqlStore } from "../server/sqlStore.ts";
import { renderHtmlPage, renderMermaidPage, renderSandboxedPart } from "../server/surfacePage.ts";

// Feedback capture (issue #9): the script that runs inside a sandboxed surface
// document, and the flag that decides whether it is there at all.

const ORIGIN = "http://pub.example";

// --- the generated bundle -----------------------------------------------

test("the committed capture bundle is exactly what its sources build", async () => {
  const rebuilt = await buildFeedbackCaptureModule();
  const committed = await readFile(BUNDLE_PATH, "utf8");
  assert.equal(
    committed,
    rebuilt,
    "server/feedbackCaptureBundle.ts is stale — run `npm run build:feedback-capture`",
  );
});

test("the bundle is self-contained, inert as markup, and carries the highlighter", () => {
  // No import/require left over: it has to run as a plain inline <script> in a
  // document whose CSP allows nothing but inline script.
  assert.equal(/\bimport\s*\(/.test(FEEDBACK_CAPTURE_JS), false, "dynamic import survived");
  assert.equal(/\bfrom\s*"/.test(FEEDBACK_CAPTURE_JS), false, "an ESM import survived");
  // It never reaches the network — the rich-surface CSP has no connect-src, and
  // everything captured goes to the parent instead.
  assert.equal(FEEDBACK_CAPTURE_JS.includes("XMLHttpRequest"), false);
  assert.equal(/\bfetch\s*\(/.test(FEEDBACK_CAPTURE_JS), false);
  // Nothing in it may close the <script> element it is injected into.
  assert.equal(/<\/script/i.test(FEEDBACK_CAPTURE_JS), false);
  // The library the anchors come from, and the message types it speaks.
  assert.match(FEEDBACK_CAPTURE_JS, /parentTagName/);
  for (const type of ["feedback-select", "feedback-point", "feedback-arm", "feedback-restore"]) {
    assert.ok(FEEDBACK_CAPTURE_JS.includes(type), `${type} missing from the bundle`);
  }
});

// --- the flag -----------------------------------------------------------

const renderers = [
  [
    "html",
    (feedback?: boolean) =>
      renderHtmlPage({ title: "t", html: "<p>x</p>", origin: ORIGIN, feedback }),
  ],
  [
    "rich",
    (feedback?: boolean) =>
      renderSandboxedPart({ body: "<p>x</p>", css: "", origin: ORIGIN, feedback }),
  ],
  [
    "mermaid",
    (feedback?: boolean) =>
      renderMermaidPage({ mermaid: "graph TD; A-->B;", origin: ORIGIN, feedback }),
  ],
] as const;

for (const [kind, render] of renderers) {
  test(`a ${kind} surface document carries capture code only when asked for it`, () => {
    const plain = render();
    assert.equal(plain.includes(FEEDBACK_CAPTURE_JS), false, "capture code without the flag");
    assert.equal(plain.includes("feedback-select"), false);

    const withCapture = render(true);
    assert.ok(withCapture.includes(FEEDBACK_CAPTURE_JS), "capture code missing under the flag");

    // The flag adds exactly one script block and changes nothing else, so a
    // document served without it is byte-identical to what it always was.
    assert.equal(withCapture.replace(`\n<script>${FEEDBACK_CAPTURE_JS}</script>`, ""), plain);
    assert.equal(render(false), plain, "an explicit false is the same as omitting it");
  });
}

test("capture never widens a surface document's CSP", () => {
  const rich = renderSandboxedPart({ body: "x", css: "", origin: ORIGIN, feedback: true });
  const policy = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(rich)?.[1];
  assert.ok(policy);
  assert.equal(policy.includes("connect-src"), false, "capture must not add connect-src");
  assert.match(policy, /script-src 'unsafe-inline'(;|$)/);
});

// --- who may set it -----------------------------------------------------

async function seedPrivatePost() {
  const store = new SqlStore(createSqliteStorage());
  const app = createApp({
    store,
    viewerHtml: "<html>v</html>",
    guideMarkdown: "#",
    setupText: "#",
    agentHowtoText: "#",
  });
  const created = (await (
    await app.request("/api/posts", {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ title: "t", surfaces: [{ kind: "html", html: "<p>private</p>" }] }),
    })
  ).json()) as { id: string };
  return { app, id: created.id };
}

test("the private workspace never serves capture code, however it is asked", async () => {
  const { app, id } = await seedPrivatePost();
  const plain = await (await app.request(`/s/${id}?part=0`)).text();
  assert.equal(plain.includes("feedback-select"), false);
  // Even with the query flag the public runtime uses: the private route does
  // not read it, so its documents are unchanged.
  for (const query of ["?part=0&fb=1", "?part=0&fb=true", "?surface=0&fb=1"]) {
    const forced = await (await app.request(`/s/${id}${query}`)).text();
    assert.equal(forced.includes("feedback-select"), false, `capture leaked via ${query}`);
    assert.equal(forced, plain, `${query} changed the private document`);
  }
  // And the viewer page the same route serves without a surface index.
  const viewer = await (await app.request(`/s/${id}?fb=1`)).text();
  assert.equal(viewer.includes("feedback-select"), false);
});

test("the public runtime serves capture code only for a surface asked for with fb=1", async () => {
  const store = new SqlStore(createSqliteStorage());
  const publications = store.publications;
  assert.ok(publications);
  const publication = await publications.createPublication({ kind: "post", title: "p" });
  const snapshot = await publications.createSnapshot({
    publicationId: publication.id,
    items: [
      {
        postId: "post-1",
        title: "Frozen post",
        version: 1,
        surfaces: [
          { kind: "html", html: "<p>hello</p>" },
          { kind: "markdown", markdown: "# hi\n\nprose" },
          { kind: "mermaid", mermaid: "graph TD; A-->B;" },
        ],
      },
    ],
  });
  assert.ok(snapshot);
  const link = await publications.createShareLink({
    publicationId: publication.id,
    slug: "fb-slug",
    custom: true,
  });
  assert.ok(link);
  const app = createPublicApp({ store, ownerToken: "owner", visitorSecret: "visitor" });

  for (const surface of [0, 1, 2]) {
    const off = await (await app.request(`${ORIGIN}/api/v/fb-slug/s/0/${surface}`)).text();
    assert.equal(off.includes("feedback-select"), false, `surface ${surface} leaked capture code`);
    const on = await (await app.request(`${ORIGIN}/api/v/fb-slug/s/0/${surface}?fb=1`)).text();
    assert.ok(on.includes(FEEDBACK_CAPTURE_JS), `surface ${surface} is missing capture code`);
    // Only the exact flag turns it on.
    const bogus = await (await app.request(`${ORIGIN}/api/v/fb-slug/s/0/${surface}?fb=yes`)).text();
    assert.equal(bogus.includes("feedback-select"), false);
    // ...and it is still sandboxed by the response itself.
    const res = await app.request(`${ORIGIN}/api/v/fb-slug/s/0/${surface}?fb=1`);
    assert.equal(res.headers.get("content-security-policy"), "sandbox allow-scripts");
  }
});
