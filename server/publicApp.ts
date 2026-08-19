import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getCookie, setCookie } from "hono/cookie";
import { decodeBase64 } from "./base64.ts";
import { hashPassword, MAX_PASSWORD_BYTES, timingSafeEqual, verifyPassword } from "./passwords.ts";
import { validateSurfaces } from "./postSurfaces.ts";
import { renderPasswordPage, renderPublicationPage } from "./publicationPage.ts";
import {
  type ExternalAnchor,
  type IdentityHeader,
  isValidCustomSlug,
  shareLinkState,
  type ShareLink,
  type Snapshot,
  type SnapshotItem,
  type TextAnchorMeta,
} from "./publicationTypes.ts";
import { OPEN_EVENT_RETENTION_DAYS } from "./publicationTypes.ts";
import { RateLimiter } from "./rateLimit.ts";
import { renderHtmlPage, renderMermaidPage, renderSandboxedPart } from "./surfacePage.ts";
import { DEFAULT_THEME_ID, themeById } from "./themes.ts";
import {
  type AssetKind,
  MAX_ASSET_BYTES,
  isSandboxedSurfaceKind,
  type Store,
  type Surface,
} from "./types.ts";
import { computeVisitorHash, deviceClass } from "./visitorHash.ts";

// The public publication service (docs/adr/0001).
//
// This is a SEPARATE app from createApp, not a filtered one. Route isolation is
// then structural rather than an allowlist someone can get wrong later: the
// private workspace API, MCP, the event bus, the trusted viewer and every owner
// control simply do not exist on this runtime. Whatever is not written below
// answers 404.
//
// What a share-link holder can reach:
//   GET  /api/v/:slug                    the publication's current snapshot
//   POST /api/v/:slug/unlock             password verification
//   POST /api/v/:slug/open               a confirmed open
//   POST /api/v/:slug/feedback           a scoped external submission
//   GET  /api/v/:slug/s/:item/:surface   one sandboxed surface document
//   GET  /a/:id                          an asset a published snapshot pins
//   GET  /robots.txt
//
// Owner writes live under /api/owner/* behind a bearer token the private
// control plane holds server-side. That token is never sent to a browser.

export const MAX_PUBLIC_BODY_BYTES = 64 * 1024;
export const MAX_FEEDBACK_NOTE_LENGTH = 4000;
export const MAX_FEEDBACK_NAME_LENGTH = 120;
export const MAX_FEEDBACK_QUOTE_LENGTH = 2000;
// Owner-only free text on a share link. Bounded like every other stored string.
export const MAX_RECIPIENT_LABEL_LENGTH = 200;

// Password guessing and feedback flooding are the two abusable public writes.
const UNLOCK_LIMIT = 10;
const UNLOCK_WINDOW_MS = 5 * 60 * 1000;
const FEEDBACK_LIMIT = 20;
const FEEDBACK_WINDOW_MS = 10 * 60 * 1000;

export interface PublicAppOptions {
  store: Store;
  // Bearer credential for /api/owner/*, held only by the private control plane.
  ownerToken: string;
  // Server-side secret keying the rotating visitor hash. Never leaves the server.
  visitorSecret: string;
  // Test seam for the clock used by rate limits and link expiry.
  now?: () => number;
}

// What a public reader is allowed to see of one surface. Sandboxed kinds travel
// as a reference — their markup is served from the surface-document route under
// a sandbox CSP header, never inlined into a trusted page. Native kinds
// (image/json) travel as data, which the reader renders as text nodes and
// element attributes.
export type SandboxedPublicSurfaceKind =
  | "html"
  | "markdown"
  | "mermaid"
  | "diff"
  | "terminal"
  | "code";

export type PublicSurfaceView =
  | { kind: SandboxedPublicSurfaceKind; sandboxed: true }
  | { kind: "image"; sandboxed: false; assetId: string; alt?: string; caption?: string }
  | { kind: "json"; sandboxed: false; data: unknown };

export function publicSurfaceView(surface: Surface): PublicSurfaceView | null {
  if (surface.kind === "image") {
    return {
      kind: "image",
      sandboxed: false,
      assetId: surface.assetId,
      ...(surface.alt !== undefined && { alt: surface.alt }),
      ...(surface.caption !== undefined && { caption: surface.caption }),
    };
  }
  if (surface.kind === "json") return { kind: "json", sandboxed: false, data: surface.data };
  // `trace` is an experimental private-side path and is not part of the
  // publication surface taxonomy; it is dropped rather than published.
  if (!isSandboxedSurfaceKind(surface.kind)) return null;
  return { kind: surface.kind as SandboxedPublicSurfaceKind, sandboxed: true };
}

const encoder = new TextEncoder();

// A per-response CSP nonce.
const newNonce = (): string =>
  [...crypto.getRandomValues(new Uint8Array(16))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

// One flat page for every reason a link does not resolve, so a visitor cannot
// tell an unknown slug from a revoked or expired one.
const NOT_FOUND_PAGE =
  `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<meta name="robots" content="noindex, nofollow"><title>Not available</title></head>` +
  `<body style="font:15px/1.6 ui-sans-serif,system-ui,sans-serif;margin:18vh auto;max-width:32rem;padding:0 20px;text-align:center">` +
  `<p>This link is not available.</p></body></html>`;

// Proof that this browser cleared a link's password. Bound to both the link and
// its current password hash, so changing or clearing the password invalidates
// every outstanding unlock without any stored session state.
async function unlockToken(secret: string, link: ShareLink): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`unlock\n${link.id}\n${link.passwordHash ?? ""}`),
  );
  return [...new Uint8Array(signature)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 48);
}

const unlockCookieName = (link: ShareLink) => `sspw_${link.id}`;

const clientIp = (c: Context): string =>
  c.req.header("cf-connecting-ip") ??
  c.req.header("x-forwarded-for")?.split(",")[0].trim() ??
  "unknown";

const clientCountry = (c: Context): string | null => {
  const country = c.req.header("cf-ipcountry");
  return country && /^[A-Z]{2}$/.test(country) ? country : null;
};

export const PUBLICATION_ASSET_AGENT = "publications";

// The owner's view of a share link. The password hash never leaves the service
// — the owner sees only whether one is set.
export function ownerLinkView(link: ShareLink) {
  const { passwordHash, ...rest } = link;
  return { ...rest, hasPassword: !!passwordHash };
}

// `false` means "present but invalid" so a caller can 400 rather than silently
// dropping a value the user asked for.
export function normalizeIdentity(raw: unknown): IdentityHeader | null | false {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object") return false;
  const value = raw as Record<string, unknown>;
  const name = typeof value.name === "string" ? value.name.trim().slice(0, 120) : "";
  if (!name) return false;
  const identity: IdentityHeader = { name };
  if (typeof value.avatarAssetId === "string" && value.avatarAssetId) {
    identity.avatarAssetId = value.avatarAssetId.slice(0, 128);
  }
  if (typeof value.linkUrl === "string" && value.linkUrl) {
    let parsed: URL;
    try {
      parsed = new URL(value.linkUrl);
    } catch {
      return false;
    }
    // Only ever render a link a browser can safely follow — no javascript:,
    // no data:.
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
    identity.linkUrl = parsed.toString();
  }
  if (typeof value.linkLabel === "string" && value.linkLabel) {
    identity.linkLabel = value.linkLabel.trim().slice(0, 80);
  }
  return identity;
}

export function normalizeExpiry(raw: unknown): string | null | false {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string") return false;
  const at = Date.parse(raw);
  if (!Number.isFinite(at)) return false;
  return new Date(at).toISOString();
}

// scrypt is memory-hard per call, so passwords.ts caps its input and throws
// above it. Decide that at the edge instead, so an oversize password is a 400
// rather than an unhandled 500. `false` means "present but too long".
export async function normalizePassword(raw: string): Promise<string | false> {
  if (encoder.encode(raw).length > MAX_PASSWORD_BYTES) return false;
  return hashPassword(raw);
}

const trimmed = (value: unknown, max: number): string =>
  typeof value === "string" ? value.slice(0, max).trim() : "";

export function createPublicApp({ store, ownerToken, visitorSecret, now }: PublicAppOptions) {
  const publications = store.publications;
  if (!publications) {
    throw new Error("the public runtime needs a store that supports publications");
  }
  if (!ownerToken) throw new Error("the public runtime needs an owner token");
  if (!visitorSecret) throw new Error("the public runtime needs a visitor secret");
  const clock = now ?? (() => Date.now());

  const app = new Hono();
  const unlockLimiter = new RateLimiter(UNLOCK_LIMIT, UNLOCK_WINDOW_MS);
  const feedbackLimiter = new RateLimiter(FEEDBACK_LIMIT, FEEDBACK_WINDOW_MS);

  // Publications are never discoverable and never referred from: no indexing, no
  // Referer leaking a capability URL to a third-party origin.
  app.use("*", (c, next) => {
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Robots-Tag", "noindex, nofollow, noarchive");
    return next();
  });

  app.use(
    "*",
    bodyLimit({
      maxSize: MAX_PUBLIC_BODY_BYTES,
      onError: (c) => c.json({ error: "request body too large" }, 413),
    }),
  );

  app.get("/robots.txt", (c) => c.text("User-agent: *\nDisallow: /\n"));

  // --- owner API (bearer token, held only by the private control plane) ---

  app.use("/api/owner/*", async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
    const ok =
      presented.length === ownerToken.length &&
      timingSafeEqual(encoder.encode(presented), encoder.encode(ownerToken));
    if (!ok) return c.json({ error: "unauthorized" }, 401);
    return next();
  });

  app.get("/api/owner/health", (c) => c.json({ ok: true, role: "public" }));

  // Publications live only here (docs/adr/0001), so the private control plane
  // finds an existing one by the post it came from rather than keeping its own
  // copy of the mapping — which would drift, and would survive a private data
  // loss less well than asking the source of truth.
  app.get("/api/owner/publications", async (c) => {
    const originPostId = c.req.query("originPostId");
    const originSessionId = c.req.query("originSessionId");
    let list = await publications.listPublications();
    if (originPostId) list = list.filter((p) => p.originPostId === originPostId);
    if (originSessionId) list = list.filter((p) => p.originSessionId === originSessionId);
    return c.json(list);
  });

  app.post("/api/owner/publications", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const kind = body.kind === "collection" ? "collection" : "post";
    const identity = normalizeIdentity(body.identity);
    if (identity === false) return c.json({ error: "invalid identity header" }, 400);
    const publication = await publications.createPublication({
      kind,
      title: typeof body.title === "string" ? body.title : undefined,
      originSessionId: typeof body.originSessionId === "string" ? body.originSessionId : null,
      originPostId: typeof body.originPostId === "string" ? body.originPostId : null,
      identity,
    });
    return c.json(publication, 201);
  });

  app.get("/api/owner/publications/:id", async (c) => {
    const publication = await publications.getPublication(c.req.param("id"));
    if (!publication) return c.json({ error: "not found" }, 404);
    const snapshots = await publications.listSnapshots(publication.id);
    return c.json({
      publication,
      // Metadata only: a snapshot's frozen surfaces are fetched one at a time.
      snapshots: snapshots.map(({ items: _items, ...meta }) => ({
        ...meta,
        itemCount: _items.length,
      })),
      // Password hashes never leave the service, even to the owner.
      links: (await publications.listShareLinks(publication.id)).map(ownerLinkView),
    });
  });

  app.patch("/api/owner/publications/:id", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const patch: { title?: string; identity?: IdentityHeader | null } = {};
    if (typeof body.title === "string") patch.title = body.title;
    if ("identity" in body) {
      const identity = normalizeIdentity(body.identity);
      if (identity === false) return c.json({ error: "invalid identity header" }, 400);
      patch.identity = identity;
    }
    const updated = await publications.updatePublication(c.req.param("id"), patch);
    if (!updated) return c.json({ error: "not found" }, 404);
    return c.json(updated);
  });

  app.delete("/api/owner/publications/:id", async (c) => {
    const removed = await publications.removePublication(c.req.param("id"));
    if (!removed) return c.json({ error: "not found" }, 404);
    return c.body(null, 204);
  });

  app.get("/api/owner/publications/:id/snapshots", async (c) => {
    if (!(await publications.getPublication(c.req.param("id")))) {
      return c.json({ error: "not found" }, 404);
    }
    return c.json(await publications.listSnapshots(c.req.param("id")));
  });

  // Creating a snapshot is the atomic step that makes a new revision live: it
  // writes the frozen items, pins their assets and flips currentSnapshotId in
  // one call. Assets are uploaded BEFORE this, so a snapshot is never briefly
  // reachable with missing bytes; a failure here leaves the previous revision
  // serving untouched.
  app.post("/api/owner/publications/:id/snapshots", async (c) => {
    const publicationId = c.req.param("id");
    if (!(await publications.getPublication(publicationId))) {
      return c.json({ error: "not found" }, 404);
    }
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const rawItems = Array.isArray(body.items) ? body.items : null;
    if (!rawItems || rawItems.length === 0) return c.json({ error: "items required" }, 400);
    const items: SnapshotItem[] = [];
    for (const raw of rawItems) {
      if (!raw || typeof raw !== "object") return c.json({ error: "invalid item" }, 400);
      const item = raw as Record<string, unknown>;
      // The same strict validator the private workspace uses, so nothing can be
      // stored here that could not have been published there.
      const validated = await validateSurfaces(item.surfaces);
      if (!validated.ok) return c.json({ error: validated.error }, 400);
      items.push({
        postId: typeof item.postId === "string" ? item.postId : "",
        title: typeof item.title === "string" ? item.title : "Untitled",
        version: Number.isInteger(item.version) ? (item.version as number) : 1,
        surfaces: validated.surfaces,
      });
    }
    const assetIds = Array.isArray(body.assetIds)
      ? body.assetIds.filter((id): id is string => typeof id === "string")
      : undefined;
    const snapshot = await publications.createSnapshot({
      publicationId,
      title: typeof body.title === "string" ? body.title : undefined,
      items,
      assetIds,
    });
    if (!snapshot) return c.json({ error: "not found" }, 404);
    return c.json(snapshot, 201);
  });

  app.get("/api/owner/snapshots/:id", async (c) => {
    const snapshot = await publications.getSnapshot(c.req.param("id"));
    if (!snapshot) return c.json({ error: "not found" }, 404);
    return c.json(snapshot);
  });

  app.get("/api/owner/publications/:id/links", async (c) => {
    if (!(await publications.getPublication(c.req.param("id")))) {
      return c.json({ error: "not found" }, 404);
    }
    // Password hashes never leave the service, even to the owner.
    return c.json((await publications.listShareLinks(c.req.param("id"))).map(ownerLinkView));
  });

  app.post("/api/owner/publications/:id/links", async (c) => {
    const publicationId = c.req.param("id");
    if (!(await publications.getPublication(publicationId))) {
      return c.json({ error: "not found" }, 404);
    }
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    let slug: string | undefined;
    if (body.slug !== undefined) {
      if (!isValidCustomSlug(body.slug)) return c.json({ error: "invalid slug" }, 400);
      slug = body.slug;
    }
    const expiresAt = normalizeExpiry(body.expiresAt);
    if (expiresAt === false) return c.json({ error: "invalid expiry" }, 400);
    let passwordHash: string | null = null;
    if (typeof body.password === "string" && body.password) {
      const hashed = await normalizePassword(body.password);
      if (hashed === false) return c.json({ error: "password too long" }, 400);
      passwordHash = hashed;
    }
    const link = await publications.createShareLink({
      publicationId,
      ...(slug !== undefined && { slug, custom: true }),
      recipientLabel:
        typeof body.recipientLabel === "string"
          ? body.recipientLabel.slice(0, MAX_RECIPIENT_LABEL_LENGTH)
          : null,
      passwordHash,
      expiresAt,
      trackOpens: body.trackOpens !== false,
    });
    if (!link) return c.json({ error: "that link address is already taken" }, 409);
    return c.json(ownerLinkView(link), 201);
  });

  // Per-link analytics for the owner dashboard. Aggregates are the durable
  // record; detailed events are a 90-day window (see the prune below), so the
  // two are reported separately rather than derived from each other.
  app.get("/api/owner/links/:id/analytics", async (c) => {
    const link = await publications.getShareLink(c.req.param("id"));
    if (!link) return c.json({ error: "not found" }, 404);
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50) || 50, 1), 200);
    return c.json({
      trackOpens: link.trackOpens,
      retentionDays: OPEN_EVENT_RETENTION_DAYS,
      aggregate: await publications.getOpenAggregate(link.id),
      // Device class and country only — a confirmed open never retains an IP,
      // and the visitor hash is keyed and rotates, so this is likely-recipient
      // activity rather than proof of who opened anything.
      events: (await publications.listOpenEvents(link.id, limit)).map((event) => ({
        at: event.at,
        deviceClass: event.deviceClass,
        country: event.country,
        snapshotId: event.snapshotId,
      })),
    });
  });

  app.get("/api/owner/links/:id", async (c) => {
    const link = await publications.getShareLink(c.req.param("id"));
    if (!link) return c.json({ error: "not found" }, 404);
    return c.json(ownerLinkView(link));
  });

  // Update one link's access controls. `password: null` clears it, a string
  // sets a fresh hash (which also invalidates every outstanding unlock cookie,
  // because those are bound to the hash). `revoked` is the fail-closed kill
  // switch; DELETE below is the permanent removal.
  app.patch("/api/owner/links/:id", async (c) => {
    const id = c.req.param("id");
    const current = await publications.getShareLink(id);
    if (!current) return c.json({ error: "not found" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const patch: Parameters<typeof publications.updateShareLink>[1] = {};
    if ("recipientLabel" in body) {
      patch.recipientLabel =
        typeof body.recipientLabel === "string"
          ? body.recipientLabel.slice(0, MAX_RECIPIENT_LABEL_LENGTH)
          : null;
    }
    if ("password" in body) {
      if (body.password === null || body.password === "") patch.passwordHash = null;
      else if (typeof body.password === "string") {
        const hashed = await normalizePassword(body.password);
        if (hashed === false) return c.json({ error: "password too long" }, 400);
        patch.passwordHash = hashed;
      } else return c.json({ error: "invalid password" }, 400);
    }
    if ("expiresAt" in body) {
      const expiresAt = normalizeExpiry(body.expiresAt);
      if (expiresAt === false) return c.json({ error: "invalid expiry" }, 400);
      patch.expiresAt = expiresAt;
    }
    if ("trackOpens" in body) patch.trackOpens = body.trackOpens !== false;
    if ("revoked" in body) {
      patch.revokedAt = body.revoked ? (current.revokedAt ?? new Date().toISOString()) : null;
    }
    const updated = await publications.updateShareLink(id, patch);
    if (!updated) return c.json({ error: "not found" }, 404);
    return c.json(ownerLinkView(updated));
  });

  // A duplicate carries the same access SETTINGS (so the same password still
  // works and the same expiry applies) but is a wholly separate capability: its
  // own slug, its own analytics, its own feedback, and its own revocation — so
  // cutting one recipient off never touches another.
  app.post("/api/owner/links/:id/duplicate", async (c) => {
    const source = await publications.getShareLink(c.req.param("id"));
    if (!source) return c.json({ error: "not found" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    let slug: string | undefined;
    if (body.slug !== undefined) {
      if (!isValidCustomSlug(body.slug)) return c.json({ error: "invalid slug" }, 400);
      slug = body.slug;
    }
    const copy = await publications.createShareLink({
      publicationId: source.publicationId,
      ...(slug !== undefined && { slug, custom: true }),
      recipientLabel:
        typeof body.recipientLabel === "string"
          ? body.recipientLabel.slice(0, MAX_RECIPIENT_LABEL_LENGTH)
          : null,
      passwordHash: source.passwordHash,
      expiresAt: source.expiresAt,
      trackOpens: source.trackOpens,
    });
    if (!copy) return c.json({ error: "that link address is already taken" }, 409);
    return c.json(ownerLinkView(copy), 201);
  });

  app.delete("/api/owner/links/:id", async (c) => {
    const removed = await publications.removeShareLink(c.req.param("id"));
    if (!removed) return c.json({ error: "not found" }, 404);
    return c.body(null, 204);
  });

  // Asset bytes for a publication. Exempt from the small public body cap above
  // and bounded by the asset cap instead.
  app.post(
    "/api/owner/assets",
    bodyLimit({
      maxSize: MAX_ASSET_BYTES,
      onError: (c) => c.json({ error: `asset exceeds ${MAX_ASSET_BYTES} bytes` }, 413),
    }),
    async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      if (typeof body.data !== "string") return c.json({ error: "data required" }, 400);
      let data: Uint8Array;
      try {
        data = decodeBase64(body.data);
      } catch {
        return c.json({ error: "invalid base64" }, 400);
      }
      if (data.byteLength > MAX_ASSET_BYTES) {
        return c.json({ error: `asset exceeds ${MAX_ASSET_BYTES} bytes` }, 413);
      }
      const kind: AssetKind = body.kind === "image" || body.kind === "file" ? body.kind : "image";
      const asset = await store.putAsset({
        sessionId: await assetSessionId(),
        kind,
        contentType:
          typeof body.contentType === "string" ? body.contentType : "application/octet-stream",
        filename: typeof body.filename === "string" ? body.filename : undefined,
        data,
      });
      if (!asset) return c.json({ error: "could not store that asset" }, 500);
      return c.json({ id: asset.id, byteLength: asset.byteLength }, 201);
    },
  );

  // Assets belong to a publication, not to a session — but the store keys them
  // by session, so the public workspace keeps exactly one reserved session to
  // own them. Snapshot pins, not this session, are what protect them from
  // eviction.
  let reservedSessionId: string | null = null;
  const assetSessionId = async (): Promise<string> => {
    if (reservedSessionId) return reservedSessionId;
    const existing = (await store.listSessions()).find(
      (session) => session.agent === PUBLICATION_ASSET_AGENT,
    );
    reservedSessionId =
      existing?.id ??
      (
        await store.createSession({
          agent: PUBLICATION_ASSET_AGENT,
          title: "Published assets",
        })
      ).id;
    return reservedSessionId;
  };

  // Detailed open events expire after 90 days while aggregates persist. There
  // is no scheduler on this runtime, so the prune rides the only write that can
  // grow the table — throttled so a burst of opens does not re-scan it.
  let prunedAt = 0;
  const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
  const pruneOldEvents = async (): Promise<void> => {
    const now = clock();
    if (now - prunedAt < PRUNE_INTERVAL_MS) return;
    prunedAt = now;
    await publications.pruneOpenEvents(
      new Date(now - OPEN_EVENT_RETENTION_DAYS * 86_400_000).toISOString(),
    );
  };

  // --- share-link resolution ---

  // Every public route funnels through here, so expiry, revocation and the
  // password gate are decided in exactly one place. A missing, revoked or
  // expired link is a flat 404: a share-link holder learns nothing about
  // whether a slug ever existed.
  type Resolved = { link: ShareLink; snapshot: Snapshot; publicationId: string };

  const resolve = async (
    c: Context,
    opts: { requireUnlock?: boolean } = {},
  ): Promise<Resolved | Response> => {
    const slug = c.req.param("slug") ?? "";
    const link = await publications.getShareLinkBySlug(slug);
    if (!link || shareLinkState(link, clock()) !== "active") {
      return c.json({ error: "not found" }, 404);
    }
    if (opts.requireUnlock !== false && link.passwordHash) {
      const presented = getCookie(c, unlockCookieName(link)) ?? "";
      const expected = await unlockToken(visitorSecret, link);
      if (
        presented.length !== expected.length ||
        !timingSafeEqual(encoder.encode(presented), encoder.encode(expected))
      ) {
        return c.json({ error: "password required", passwordRequired: true }, 401);
      }
    }
    const publication = await publications.getPublication(link.publicationId);
    if (!publication?.currentSnapshotId) return c.json({ error: "not found" }, 404);
    const snapshot = await publications.getSnapshot(publication.currentSnapshotId);
    if (!snapshot) return c.json({ error: "not found" }, 404);
    return { link, snapshot, publicationId: publication.id };
  };

  const isResponse = (value: Resolved | Response): value is Response => value instanceof Response;

  // --- public reads ---

  // The publication itself. A locked link renders the password gate rather than
  // an error, so a recipient sees something usable.
  app.get("/v/:slug", async (c) => {
    const nonce = newNonce();
    const resolved = await resolve(c);
    // Nothing agent-authored becomes HTML here (see publicationPage.ts), so the
    // page can run under a strict, nonce-based policy. Sandboxed surfaces are
    // same-origin iframes carrying their own `sandbox` CSP header.
    c.header(
      "Content-Security-Policy",
      `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; ` +
        `img-src 'self' data:; frame-src 'self'; connect-src 'self'; base-uri 'none'; ` +
        `form-action 'none'; frame-ancestors 'none'`,
    );
    c.header("Cache-Control", "private, no-store");
    if (isResponse(resolved)) {
      if (resolved.status === 401) return c.html(renderPasswordPage(c.req.param("slug"), nonce));
      return c.html(NOT_FOUND_PAGE, 404);
    }
    const publication = await publications.getPublication(resolved.publicationId);
    return c.html(
      renderPublicationPage({
        title: resolved.snapshot.title,
        identity: publication?.identity ?? null,
        slug: resolved.link.slug,
        snapshot: resolved.snapshot,
        trackOpens: resolved.link.trackOpens,
        nonce,
      }),
    );
  });

  app.get("/api/v/:slug", async (c) => {
    const resolved = await resolve(c);
    if (isResponse(resolved)) return resolved;
    const { link, snapshot } = resolved;
    const publication = await publications.getPublication(link.publicationId);
    c.header("Cache-Control", "private, no-store");
    return c.json({
      // Deliberately narrow: no publication id, no recipient label, no expiry,
      // no password state, no cross-publication handles.
      title: snapshot.title,
      identity: publication?.identity ?? null,
      link: { slug: link.slug, trackOpens: link.trackOpens },
      snapshot: {
        id: snapshot.id,
        revision: snapshot.revision,
        createdAt: snapshot.createdAt,
        items: snapshot.items.map((item) => ({
          title: item.title,
          surfaces: item.surfaces.map((surface) => publicSurfaceView(surface)),
        })),
      },
    });
  });

  // One surface as its own document, served from this origin under a `sandbox`
  // CSP HEADER — the same rule the private /s/:id route follows. The header (not
  // just an iframe attribute) is what makes a top-level navigation to this URL
  // safe: agent markup can never execute in the public origin, where it could
  // otherwise read a reader's unlock cookie.
  app.get("/api/v/:slug/s/:item/:surface", async (c) => {
    const resolved = await resolve(c);
    if (isResponse(resolved)) return resolved;
    const { snapshot } = resolved;
    const item = snapshot.items[Number(c.req.param("item"))];
    const surface = item?.surfaces[Number(c.req.param("surface"))];
    if (!surface || !isSandboxedSurfaceKind(surface.kind)) {
      return c.text("No renderable surface there", 404);
    }
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Content-Security-Policy", "sandbox allow-scripts");
    // A snapshot is immutable, so its rendered surfaces are too. `private`
    // because a password-protected publication must not sit in a shared cache.
    c.header("Cache-Control", "private, max-age=31536000, immutable");

    const themeId = c.req.query("theme") ?? DEFAULT_THEME_ID;
    const theme = themeById(themeId);
    const modeParam = c.req.query("mode");
    const mode = modeParam === "light" || modeParam === "dark" ? modeParam : undefined;
    const origin = new URL(c.req.url).origin;

    if (surface.kind === "html") {
      return c.html(
        renderHtmlPage({
          title: item.title,
          html: surface.html,
          origin,
          theme,
          mode,
          kits: surface.kits,
        }),
      );
    }
    if (surface.kind === "mermaid") {
      return c.html(renderMermaidPage({ mermaid: surface.mermaid, origin, theme, mode }));
    }
    const { renderCode, renderDiff, renderMarkdown, renderTerminal } =
      await import("./richRender.ts");
    const rendered =
      surface.kind === "markdown"
        ? await renderMarkdown(surface, { theme: themeId, mode })
        : surface.kind === "code"
          ? await renderCode(surface, { theme: themeId, mode })
          : surface.kind === "terminal"
            ? renderTerminal(surface)
            : surface.kind === "diff"
              ? await renderDiff(surface, { theme: themeId, mode }).catch(() => ({
                  body: `<div class="rich-error">Couldn’t render this diff</div>`,
                  css: `.rich-error{color:var(--danger);font:13px/1.5 ui-monospace,monospace;padding:8px 12px;}`,
                }))
              : null;
    if (!rendered) return c.text("No renderable surface there", 404);
    return c.html(
      renderSandboxedPart({ body: rendered.body, css: rendered.css, origin, theme, mode }),
    );
  });

  // Assets a published snapshot pins. Publication-scoped by construction: an
  // asset that no snapshot pins is unreachable here, and asset ids are the
  // SHA-256 of their own bytes, so they cannot be enumerated.
  // An identity header's avatar is referenced by a publication rather than by a
  // snapshot's surfaces, so it needs its own reachability check. There are only
  // ever a handful of publications in a workspace, so a scan is cheaper than
  // another index to keep in step.
  const isIdentityAvatar = async (id: string): Promise<boolean> =>
    (await publications.listPublications()).some((p) => p.identity?.avatarAssetId === id);

  app.get("/a/:id", async (c) => {
    const id = c.req.param("id");
    if (!(await publications.isSnapshotAsset(id)) && !(await isIdentityAvatar(id))) {
      return c.text("Asset not found", 404);
    }
    const asset = await store.getAsset(id);
    if (!asset) return c.text("Asset not found", 404);
    await store.touchAsset(asset.id);
    c.header("Content-Type", asset.contentType);
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Content-Disposition", "inline");
    c.header("Cache-Control", "private, max-age=3600");
    return c.body(asset.data as unknown as ArrayBuffer);
  });

  // --- password verification ---

  app.post("/api/v/:slug/unlock", async (c) => {
    const slug = c.req.param("slug") ?? "";
    const bucket = `${slug}\n${clientIp(c)}`;
    if (!unlockLimiter.take(bucket, clock())) {
      c.header("Retry-After", String(unlockLimiter.retryAfter(bucket, clock())));
      return c.json({ error: "too many attempts" }, 429);
    }
    const resolved = await resolve(c, { requireUnlock: false });
    if (isResponse(resolved)) return resolved;
    const { link } = resolved;
    if (!link.passwordHash) return c.json({ ok: true });
    const body = (await c.req.json().catch(() => ({}))) as { password?: unknown };
    const password = typeof body.password === "string" ? body.password : "";
    if (!(await verifyPassword(password, link.passwordHash))) {
      return c.json({ error: "incorrect password" }, 401);
    }
    setCookie(c, unlockCookieName(link), await unlockToken(visitorSecret, link), {
      httpOnly: true,
      sameSite: "Lax",
      secure: new URL(c.req.url).protocol === "https:",
      maxAge: 60 * 60 * 24 * 30,
      path: "/",
    });
    return c.json({ ok: true });
  });

  // --- confirmed opens ---

  // Called by the reader AFTER the publication has rendered, never from the
  // initial request — that is what makes it a confirmed open rather than a hit.
  app.post("/api/v/:slug/open", async (c) => {
    const resolved = await resolve(c);
    if (isResponse(resolved)) return resolved;
    const { link, snapshot } = resolved;
    if (!link.trackOpens) return c.body(null, 204);
    await pruneOldEvents();
    const userAgent = c.req.header("user-agent") ?? "";
    await publications.recordOpen({
      shareLinkId: link.id,
      snapshotId: snapshot.id,
      visitorHash: await computeVisitorHash({
        secret: visitorSecret,
        shareLinkId: link.id,
        ip: clientIp(c),
        userAgent,
        now: clock(),
      }),
      deviceClass: deviceClass(userAgent),
      country: clientCountry(c),
    });
    return c.body(null, 204);
  });

  // --- external feedback ---

  // A submission from an untrusted share-link holder. It lands in the external
  // feedback tables and nowhere else: it never becomes a Sideshow comment and
  // never advances an agent cursor (docs/adr/0003).
  app.post("/api/v/:slug/feedback", async (c) => {
    const slug = c.req.param("slug") ?? "";
    const bucket = `${slug}\n${clientIp(c)}`;
    if (!feedbackLimiter.take(bucket, clock())) {
      c.header("Retry-After", String(feedbackLimiter.retryAfter(bucket, clock())));
      return c.json({ error: "too many submissions" }, 429);
    }
    const resolved = await resolve(c);
    if (isResponse(resolved)) return resolved;
    const { link, snapshot, publicationId } = resolved;
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    // Honeypot: a real reader never fills this in. Answer 201 so a bot cannot
    // tell a rejection from a success.
    if (typeof body.website === "string" && body.website.trim() !== "") {
      return c.json({ ok: true }, 201);
    }
    const note = trimmed(body.note, MAX_FEEDBACK_NOTE_LENGTH);
    const name = trimmed(body.name, MAX_FEEDBACK_NAME_LENGTH);
    if (!note) return c.json({ error: "a note is required" }, 400);
    if (!name) return c.json({ error: "a name is required" }, 400);
    if (body.snapshotId !== snapshot.id) {
      // The reader submits against the snapshot it rendered; a mismatch means
      // the publication was updated underneath it, so the anchor is stale.
      return c.json({ error: "this publication has been updated — reload it" }, 409);
    }
    const anchor = normalizeAnchor(body.anchor, snapshot);
    if (!anchor) return c.json({ error: "invalid anchor" }, 400);
    const email = trimmed(body.email, MAX_FEEDBACK_NAME_LENGTH);
    const created = await publications.createFeedback({
      publicationId,
      shareLinkId: link.id,
      snapshotId: snapshot.id,
      anchor,
      note,
      name,
      email: email || null,
    });
    if (!created) return c.json({ error: "could not record that" }, 400);
    return c.json({ ok: true }, 201);
  });

  return app;
}

// Validate an anchor against the snapshot it claims to point into, so a stored
// anchor always resolves to a real surface. Returns null for anything else.
export function normalizeAnchor(
  raw: unknown,
  snapshot: Pick<Snapshot, "items">,
): ExternalAnchor | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Record<string, unknown>;
  const itemIndex = Number(a.itemIndex);
  const surfaceIndex = Number(a.surfaceIndex);
  const item = Number.isInteger(itemIndex) ? snapshot.items[itemIndex] : undefined;
  const surface = item && Number.isInteger(surfaceIndex) ? item.surfaces[surfaceIndex] : undefined;
  if (!surface) return null;
  const surfaceId = typeof a.surfaceId === "string" ? a.surfaceId : undefined;
  if (a.kind === "point") {
    const x = Number(a.x);
    const y = Number(a.y);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) return null;
    return { kind: "point", itemIndex, surfaceIndex, ...(surfaceId && { surfaceId }), x, y };
  }
  if (a.kind === "text") {
    const quote = typeof a.quote === "string" ? a.quote.slice(0, MAX_FEEDBACK_QUOTE_LENGTH) : "";
    if (!quote.trim()) return null;
    const meta = (value: unknown): TextAnchorMeta | undefined => {
      if (!value || typeof value !== "object") return undefined;
      const m = value as Record<string, unknown>;
      if (typeof m.parentTagName !== "string") return undefined;
      const parentIndex = Number(m.parentIndex);
      const textOffset = Number(m.textOffset);
      if (!Number.isInteger(parentIndex) || !Number.isInteger(textOffset)) return undefined;
      return { parentTagName: m.parentTagName.slice(0, 32), parentIndex, textOffset };
    };
    return {
      kind: "text",
      itemIndex,
      surfaceIndex,
      ...(surfaceId && { surfaceId }),
      quote,
      ...(typeof a.prefix === "string" && { prefix: a.prefix.slice(0, 200) }),
      ...(typeof a.suffix === "string" && { suffix: a.suffix.slice(0, 200) }),
      ...(meta(a.startMeta) && { startMeta: meta(a.startMeta) }),
      ...(meta(a.endMeta) && { endMeta: meta(a.endMeta) }),
    };
  }
  return null;
}
