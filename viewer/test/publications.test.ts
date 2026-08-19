import { expect, test } from "vitest";
import {
  ANALYTICS_DISCLAIMER,
  CUSTOM_SLUG_WARNING,
  expiryFromInput,
  expiryInputValue,
  formatCountry,
  formatDeviceClass,
  formatExpiry,
  formatOpenAt,
  publicationErrorMessage,
  publicationLinksPath,
  publicationPath,
  publicationsPath,
  type PublicationDetail,
  retentionNote,
  type ShareLinkAnalytics,
  shareLinkAnalyticsPath,
  shareLinkDuplicatePath,
  shareLinkPath,
  shareLinkStatus,
  shareLinkUrl,
  type ShareLinkView,
} from "../src/api.ts";

const link = (over: Partial<ShareLinkView> = {}): ShareLinkView => ({
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

test("the publications routes are built under the API prefix", () => {
  expect(publicationsPath()).toBe("/api/publications");
  expect(publicationPath("pub-1")).toBe("/api/publications/pub-1");
  expect(publicationLinksPath("pub-1")).toBe("/api/publications/pub-1/links");
  expect(shareLinkPath("link-1")).toBe("/api/publications/links/link-1");
  expect(shareLinkDuplicatePath("link-1")).toBe("/api/publications/links/link-1/duplicate");
});

test("ids that aren't URL-safe are escaped in every publications route", () => {
  expect(publicationPath("a b/c?d")).toBe("/api/publications/a%20b%2Fc%3Fd");
  expect(publicationLinksPath("a b/c?d")).toBe("/api/publications/a%20b%2Fc%3Fd/links");
  expect(shareLinkPath("a b/c?d")).toBe("/api/publications/links/a%20b%2Fc%3Fd");
  expect(shareLinkDuplicatePath("a/b")).toBe("/api/publications/links/a%2Fb/duplicate");
});

test("a share link's public URL is the destination origin plus /v/<slug>", () => {
  expect(shareLinkUrl("https://public.example", "abcdef")).toBe("https://public.example/v/abcdef");
  // The origin may arrive with a trailing slash; the URL must not double up.
  expect(shareLinkUrl("https://public.example/", "abcdef")).toBe("https://public.example/v/abcdef");
  expect(shareLinkUrl("https://public.example//", "abcdef")).toBe(
    "https://public.example/v/abcdef",
  );
  expect(shareLinkUrl("https://public.example", "a b")).toBe("https://public.example/v/a%20b");
});

test("link state is revoked first, then expiry, then active", () => {
  const now = Date.parse("2026-08-19T00:00:00.000Z");
  expect(shareLinkStatus(link(), now)).toBe("active");
  expect(shareLinkStatus(link({ expiresAt: "2026-09-01T00:00:00.000Z" }), now)).toBe("active");
  expect(shareLinkStatus(link({ expiresAt: "2026-08-01T00:00:00.000Z" }), now)).toBe("expired");
  // Revoked wins even when the expiry is still in the future.
  expect(
    shareLinkStatus(
      link({ revokedAt: "2026-08-10T00:00:00.000Z", expiresAt: "2026-09-01T00:00:00.000Z" }),
      now,
    ),
  ).toBe("revoked");
  // An expiry exactly at `now` has passed — it fails closed.
  expect(shareLinkStatus(link({ expiresAt: "2026-08-19T00:00:00.000Z" }), now)).toBe("expired");
  // So does one we cannot parse.
  expect(shareLinkStatus(link({ expiresAt: "not a date" }), now)).toBe("expired");
});

test("expiry is described as past or future, and a missing one is not an error", () => {
  const now = Date.parse("2026-08-19T00:00:00.000Z");
  expect(formatExpiry(null, now)).toBe("No expiry");
  expect(formatExpiry("2026-09-01T12:00:00.000Z", now)).toMatch(/^Expires /);
  expect(formatExpiry("2026-08-01T12:00:00.000Z", now)).toMatch(/^Expired /);
  // Fails closed the same way shareLinkStatus does, rather than reading as open.
  expect(formatExpiry("nonsense", now)).toBe("Unreadable expiry");
});

test("an expiry round-trips through the datetime-local input", () => {
  expect(expiryInputValue(null)).toBe("");
  expect(expiryInputValue("nonsense")).toBe("");
  expect(expiryFromInput("")).toBeNull();
  expect(expiryFromInput("   ")).toBeNull();
  expect(expiryFromInput("nonsense")).toBeNull();

  const iso = "2026-09-01T12:34:00.000Z";
  const shown = expiryInputValue(iso);
  // Local wall-clock, no zone — the shape <input type="datetime-local"> wants.
  expect(shown).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  expect(expiryFromInput(shown)).toBe(iso);
});

test("a server error message is preferred, a bare status code is not", () => {
  expect(publicationErrorMessage(new Error("that link address is already taken"))).toBe(
    "that link address is already taken",
  );
  expect(publicationErrorMessage(new Error("503"), "Couldn't load publications")).toBe(
    "Couldn't load publications",
  );
  expect(publicationErrorMessage(new Error(""))).toBe("That didn't work");
  expect(publicationErrorMessage("boom")).toBe("That didn't work");
});

test("the custom-slug copy says plainly that a custom address is not a secret", () => {
  expect(CUSTOM_SLUG_WARNING).toContain("not a secret");
  expect(CUSTOM_SLUG_WARNING).toContain("guess");
  expect(CUSTOM_SLUG_WARNING).toContain("unguessable");
});

test("the detail response type describes what the server actually sends", () => {
  const detail: PublicationDetail = {
    origin: "https://public.example",
    publication: {
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
    links: [link({ recipientLabel: "Acme", hasPassword: true })],
  };
  expect(detail.snapshots[0].itemCount).toBe(3);
  // The password hash never reaches the owner — only the boolean does.
  expect(detail.links[0]).not.toHaveProperty("passwordHash");
  expect(detail.links[0].hasPassword).toBe(true);
});

// --- confirmed opens ---

test("the analytics route is built under the share link, with an optional limit", () => {
  expect(shareLinkAnalyticsPath("link-1")).toBe("/api/publications/links/link-1/analytics");
  expect(shareLinkAnalyticsPath("link-1", 20)).toBe(
    "/api/publications/links/link-1/analytics?limit=20",
  );
  expect(shareLinkAnalyticsPath("a/b", 5)).toBe("/api/publications/links/a%2Fb/analytics?limit=5");
});

test("a device class becomes plain words, and an unknown one is not a blank", () => {
  expect(formatDeviceClass("mobile")).toBe("Phone");
  expect(formatDeviceClass("tablet")).toBe("Tablet");
  expect(formatDeviceClass("desktop")).toBe("Computer");
  expect(formatDeviceClass(null)).toBe("Unknown device");
  // Anything the server did not classify reads as unknown rather than as itself.
  expect(formatDeviceClass("")).toBe("Unknown device");
  expect(formatDeviceClass("watch")).toBe("Unknown device");
});

test("a country is shown as its code, and a missing one says so", () => {
  expect(formatCountry("ES")).toBe("ES");
  expect(formatCountry("es")).toBe("ES");
  expect(formatCountry(null)).toBe("Unknown country");
  expect(formatCountry("")).toBe("Unknown country");
});

test("a first or last open reads as a date, never as an empty cell", () => {
  expect(formatOpenAt(null)).toBe("Never");
  expect(formatOpenAt("nonsense")).toBe("Unknown");
  expect(formatOpenAt("2026-08-18T12:00:00.000Z")).toMatch(/2026/);
});

test("the retention note names the window and says the totals outlive it", () => {
  expect(retentionNote(90)).toContain("90 days");
  expect(retentionNote(90)).toContain("indefinitely");
});

test("the disclaimer says these are likely-recipient activity, not proof of identity", () => {
  expect(ANALYTICS_DISCLAIMER).toContain("likely-recipient activity");
  expect(ANALYTICS_DISCLAIMER).toContain("not proof of identity");
  // The two reasons it is only approximate, both of which the owner needs.
  expect(ANALYTICS_DISCLAIMER).toContain("forwarded");
  expect(ANALYTICS_DISCLAIMER).toContain("rotating");
});

test("the analytics response type carries counts and coarse context, and no visitor hash", () => {
  const analytics: ShareLinkAnalytics = {
    trackOpens: true,
    retentionDays: 90,
    aggregate: {
      shareLinkId: "link-1",
      firstOpenAt: "2026-08-01T00:00:00.000Z",
      lastOpenAt: "2026-08-18T00:00:00.000Z",
      totalOpens: 3,
      uniqueVisitors: 2,
    },
    events: [
      {
        at: "2026-08-18T00:00:00.000Z",
        deviceClass: "mobile",
        country: "ES",
        snapshotId: "snap-2",
      },
    ],
  };
  expect(analytics.aggregate.uniqueVisitors).toBe(2);
  // The rotating hash is the server's business and never reaches the dashboard.
  expect(analytics.events[0]).not.toHaveProperty("visitorHash");
  expect(analytics.events[0]).not.toHaveProperty("ip");
});
