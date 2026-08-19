import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getCookie, setCookie } from "hono/cookie";
import { timingSafeEqual, verifyPassword } from "./passwords.ts";
import {
  type ExternalAnchor,
  shareLinkState,
  type ShareLink,
  type Snapshot,
  type TextAnchorMeta,
} from "./publicationTypes.ts";
import { RateLimiter } from "./rateLimit.ts";
import { renderHtmlPage, renderMermaidPage, renderSandboxedPart } from "./surfacePage.ts";
import { DEFAULT_THEME_ID, themeById } from "./themes.ts";
import { isSandboxedSurfaceKind, type Store, type Surface } from "./types.ts";
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

  app.get("/api/owner/publications", async (c) => c.json(await publications.listPublications()));

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
  app.get("/a/:id", async (c) => {
    const id = c.req.param("id");
    if (!(await publications.isSnapshotAsset(id))) return c.text("Asset not found", 404);
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
