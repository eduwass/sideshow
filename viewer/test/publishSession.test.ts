import { expect, test } from "vitest";
import {
  type CollectionPreview,
  type CollectionPreviewPost,
  publishSessionErrorMessage,
  publishSessionPath,
  type PublishSessionResult,
  sessionPreviewPath,
  sessionPublicationStatusPath,
} from "../src/api.ts";
import {
  defaultSelectedPostIds,
  selectedPostIds,
  selectionSummary,
} from "../src/publishSelection.ts";

const post = (
  postId: string,
  publishable = true,
  kinds: string[] = ["html"],
): CollectionPreviewPost => ({
  postId,
  title: `Post ${postId}`,
  version: 1,
  surfaceKinds: kinds,
  updatedAt: "2026-08-19T00:00:00.000Z",
  publishable,
});

test("the session publish routes are built under the API prefix", () => {
  expect(publishSessionPath()).toBe("/api/publish/session");
  expect(sessionPreviewPath("sess-1")).toBe("/api/publish/session/sess-1/preview");
  expect(sessionPublicationStatusPath("sess-1")).toBe("/api/publish/session/sess-1");
});

test("a session id that isn't URL-safe is escaped in both session routes", () => {
  expect(sessionPreviewPath("a b/c?d")).toBe("/api/publish/session/a%20b%2Fc%3Fd/preview");
  expect(sessionPublicationStatusPath("a b/c?d")).toBe("/api/publish/session/a%20b%2Fc%3Fd");
});

test("a server error message is preferred, a bare status code is not", () => {
  expect(publishSessionErrorMessage(new Error("nothing publishable in that selection"))).toBe(
    "nothing publishable in that selection",
  );
  expect(publishSessionErrorMessage(new Error("503"))).toBe("Couldn't publish this session");
  expect(publishSessionErrorMessage(new Error(""))).toBe("Couldn't publish this session");
  expect(publishSessionErrorMessage("boom")).toBe("Couldn't publish this session");
  expect(publishSessionErrorMessage(undefined)).toBe("Couldn't publish this session");
});

test("the preview and result types describe what the server actually sends", () => {
  const preview: CollectionPreview = {
    sessionId: "sess-1",
    title: "Refactor the store",
    posts: [post("a"), post("b", false, [])],
  };
  expect(preview.posts.map((p) => p.publishable)).toEqual([true, false]);

  const result: PublishSessionResult = {
    publicationId: "pub-1",
    snapshotId: "snap-1",
    revision: 1,
    slug: "abc",
    url: "https://public.example/v/abc",
    updated: false,
  };
  expect(result.updated).toBe(false);
});

test("every publishable post is selected by default, and only those", () => {
  const posts = [post("a"), post("b", false, []), post("c")];
  expect(defaultSelectedPostIds(posts)).toEqual(["a", "c"]);
  expect(defaultSelectedPostIds([])).toEqual([]);
  expect(defaultSelectedPostIds([post("x", false, [])])).toEqual([]);
});

test("the chosen ids keep session order and can never include an unpublishable post", () => {
  const posts = [post("a"), post("b", false, []), post("c")];
  // Ticked out of order, and with the unpublishable one forced into the set.
  const selected = new Set(["c", "b", "a"]);
  expect(selectedPostIds(posts, selected)).toEqual(["a", "c"]);
  expect(selectedPostIds(posts, new Set(["c"]))).toEqual(["c"]);
  expect(selectedPostIds(posts, new Set())).toEqual([]);
});

test("the count summary reports the selection against every previewed post", () => {
  expect(selectionSummary(4, 6)).toBe("Publishing 4 of 6 posts");
  expect(selectionSummary(0, 3)).toBe("Publishing 0 of 3 posts");
  expect(selectionSummary(1, 1)).toBe("Publishing 1 of 1 post");
});
