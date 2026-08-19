import { expect, test } from "vitest";
import {
  avatarPreviewUrl,
  type IdentityForm,
  identityEnabled,
  identityError,
  identityForm,
  identityFromForm,
  identityLinkText,
} from "../src/identity.ts";

const form = (over: Partial<IdentityForm> = {}): IdentityForm => ({
  name: "Ada",
  avatarAssetId: "",
  linkUrl: "",
  linkLabel: "",
  ...over,
});

test("the header is off exactly when the publication has no identity", () => {
  expect(identityEnabled(null)).toBe(false);
  expect(identityEnabled(undefined)).toBe(false);
  expect(identityEnabled({ name: "Ada" })).toBe(true);
});

test("the form starts blank with no identity and filled from an existing one", () => {
  expect(identityForm(null)).toEqual({ name: "", avatarAssetId: "", linkUrl: "", linkLabel: "" });
  expect(
    identityForm({
      name: "Ada",
      avatarAssetId: "asset-1",
      linkUrl: "https://example.com/",
      linkLabel: "Site",
    }),
  ).toEqual({
    name: "Ada",
    avatarAssetId: "asset-1",
    linkUrl: "https://example.com/",
    linkLabel: "Site",
  });
});

test("the avatar preview points at the publication's public asset route", () => {
  expect(avatarPreviewUrl("https://pub.example", "asset-1")).toBe("https://pub.example/a/asset-1");
  expect(avatarPreviewUrl("https://pub.example/", " asset 1 ")).toBe(
    "https://pub.example/a/asset%201",
  );
  expect(avatarPreviewUrl("https://pub.example", "  ")).toBe(null);
  expect(avatarPreviewUrl("", "asset-1")).toBe(null);
});

test("a blank name is rejected the same way the server rejects it", () => {
  expect(identityError(form({ name: "   " }))).toMatch(/name is required/i);
  expect(identityError(form())).toBe(null);
});

test("only http(s) links are accepted", () => {
  expect(identityError(form({ linkUrl: "https://example.com" }))).toBe(null);
  expect(identityError(form({ linkUrl: "http://example.com" }))).toBe(null);
  expect(identityError(form({ linkUrl: "example.com" }))).toMatch(/full URL/i);
  expect(identityError(form({ linkUrl: "javascript:alert(1)" }))).toMatch(/http/i);
  expect(identityError(form({ linkUrl: "mailto:ada@example.com" }))).toMatch(/http/i);
});

test("the patch body trims and omits the optional fields left empty", () => {
  expect(identityFromForm(form({ name: "  Ada  " }))).toEqual({ name: "Ada" });
  expect(
    identityFromForm(
      form({ avatarAssetId: " asset-1 ", linkUrl: " https://example.com ", linkLabel: " Site " }),
    ),
  ).toEqual({
    name: "Ada",
    avatarAssetId: "asset-1",
    linkUrl: "https://example.com",
    linkLabel: "Site",
  });
});

test("the previewed link text falls back to the host, as the public page does", () => {
  expect(identityLinkText(form())).toBe("");
  expect(identityLinkText(form({ linkUrl: "https://example.com/blog" }))).toBe("example.com");
  expect(identityLinkText(form({ linkUrl: "https://example.com", linkLabel: "Site" }))).toBe(
    "Site",
  );
});
