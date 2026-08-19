import { expect, test } from "vitest";
import {
  publicationStatusPath,
  publishDestinationPath,
  publishErrorMessage,
  publishPostPath,
  type PublicationStatus,
  type PublishDestination,
  type PublishPostResult,
} from "../src/api.ts";

test("the publish routes are built under the API prefix", () => {
  expect(publishDestinationPath()).toBe("/api/publish/destination");
  expect(publishPostPath()).toBe("/api/publish/post");
  expect(publicationStatusPath("post-1")).toBe("/api/publish/post/post-1");
});

test("a publication status path escapes an id that isn't URL-safe", () => {
  expect(publicationStatusPath("a b/c?d")).toBe("/api/publish/post/a%20b%2Fc%3Fd");
});

test("a server error message is preferred, a bare status code is not", () => {
  expect(publishErrorMessage(new Error("this post has nothing publishable"))).toBe(
    "this post has nothing publishable",
  );
  // api() throws the status code when the body carried no `error` string —
  // "503" is not something to show a user.
  expect(publishErrorMessage(new Error("503"))).toBe("Couldn't publish this post");
  expect(publishErrorMessage(new Error(""))).toBe("Couldn't publish this post");
  expect(publishErrorMessage("boom")).toBe("Couldn't publish this post");
  expect(publishErrorMessage(undefined)).toBe("Couldn't publish this post");
});

test("the response types describe what the server actually sends", () => {
  const unconfigured: PublishDestination = { configured: false, origin: null };
  expect(unconfigured.configured).toBe(false);

  // An unconfigured workspace answers the status route with only these two keys.
  const unpublished: PublicationStatus = { configured: false, published: false };
  expect(unpublished.url).toBeUndefined();

  const published: PublicationStatus = {
    configured: true,
    published: true,
    publicationId: "pub-1",
    url: "https://public.example/v/abc",
    revision: 2,
    updatedAt: "2026-08-19T00:00:00.000Z",
    links: 1,
  };
  expect(published.url).toBe("https://public.example/v/abc");

  const result: PublishPostResult = {
    publicationId: "pub-1",
    snapshotId: "snap-1",
    revision: 1,
    slug: "abc",
    url: "https://public.example/v/abc",
    updated: false,
  };
  expect(result.updated).toBe(false);
});
