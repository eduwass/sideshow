// Public-sharing data model — no runtime imports, safe for any platform.
//
// A *publication* is a client-facing artifact created from one private post or
// one private session (a *collection*). It owns its access settings,
// presentation options, analytics, and feedback. A *snapshot* is the immutable
// revision a viewer actually opened; updating a publication mints a new
// snapshot and never rewrites an old one, so historical external feedback keeps
// the exact content it was written against (docs/adr/0002).
//
// External feedback lives in its own tables and never touches `comments` or a
// session's `agentSeq`: an untrusted share-link holder must not be able to speak
// into the trusted comment→agent stream (docs/adr/0003).

import type { Surface } from "./types.ts";

export type PublicationKind = "post" | "collection";

// One frozen post inside a snapshot. `postId`/`version` are the origin post's
// identity, kept for owner-facing context only — the public runtime never
// resolves them against a private workspace.
export interface SnapshotItem {
  postId: string;
  title: string;
  version: number;
  surfaces: Surface[];
}

// Optional minimal publisher identity shown on a publication: avatar, name and
// one link. Off by default; publications otherwise carry no branding.
export interface IdentityHeader {
  name: string;
  avatarAssetId?: string;
  linkUrl?: string;
  linkLabel?: string;
}

export interface Publication {
  id: string;
  kind: PublicationKind;
  title: string;
  // Origin identifiers on the private side. Owner metadata only.
  originSessionId: string | null;
  originPostId: string | null;
  currentSnapshotId: string | null;
  identity: IdentityHeader | null;
  createdAt: string;
  updatedAt: string;
}

export interface Snapshot {
  id: string;
  publicationId: string;
  // 1-based, monotonic per publication.
  revision: number;
  title: string;
  items: SnapshotItem[];
  // Assets this snapshot pins. Snapshots are immutable, so their assets must
  // outlive the rolling post history that may have referenced them originally.
  assetIds: string[];
  createdAt: string;
}

export interface ShareLink {
  id: string;
  publicationId: string;
  // The capability token in the URL. Generated slugs are unguessable; a custom
  // slug is explicitly NOT a secret.
  slug: string;
  custom: boolean;
  // Owner-only context describing who the link was meant for. Never treated as
  // viewer identity and never sent to a public reader.
  recipientLabel: string | null;
  // Opaque encoded hash string (see server/passwords.ts). Plaintext is never
  // stored or logged.
  passwordHash: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  trackOpens: boolean;
  createdAt: string;
  updatedAt: string;
}

// A confirmed open: recorded after the publication actually rendered, never
// from the initial HTTP request. `visitorHash` is a rotating keyed hash — no raw
// IP is ever stored.
export interface OpenEvent {
  id: string;
  shareLinkId: string;
  snapshotId: string;
  visitorHash: string;
  deviceClass: string | null;
  country: string | null;
  at: string;
}

// Survives detailed-event pruning: aggregates are kept forever, events are not.
export interface OpenAggregate {
  shareLinkId: string;
  firstOpenAt: string | null;
  lastOpenAt: string | null;
  totalOpens: number;
  uniqueVisitors: number;
}

// Where a text anchor sits structurally inside a rendered surface document.
// Mirrors @plannotator/web-highlighter's DomMeta so an anchor can be restored
// without a fuzzy search; `quote` is the verification oracle.
export interface TextAnchorMeta {
  parentTagName: string;
  parentIndex: number;
  textOffset: number;
}

export type ExternalAnchor =
  | {
      kind: "point";
      // Index into the snapshot's `items`, then into that item's surfaces.
      itemIndex: number;
      surfaceIndex: number;
      surfaceId?: string;
      // Normalized surface coordinates in [0, 1].
      x: number;
      y: number;
    }
  | {
      kind: "text";
      itemIndex: number;
      surfaceIndex: number;
      surfaceId?: string;
      quote: string;
      prefix?: string;
      suffix?: string;
      startMeta?: TextAnchorMeta;
      endMeta?: TextAnchorMeta;
    };

export type FeedbackStatus = "unread" | "read" | "resolved" | "rejected";

export interface ExternalFeedback {
  id: string;
  publicationId: string;
  shareLinkId: string;
  // The exact snapshot the client was looking at.
  snapshotId: string;
  anchor: ExternalAnchor;
  note: string;
  // Self-declared, asked once per browser. Not an identity claim.
  name: string;
  email: string | null;
  status: FeedbackStatus;
  createdAt: string;
}

export interface CreatePublicationInput {
  kind: PublicationKind;
  title?: string;
  originSessionId?: string | null;
  originPostId?: string | null;
  identity?: IdentityHeader | null;
}

export interface UpdatePublicationInput {
  title?: string;
  identity?: IdentityHeader | null;
}

export interface CreateSnapshotInput {
  publicationId: string;
  title?: string;
  items: SnapshotItem[];
  assetIds?: string[];
}

export interface CreateShareLinkInput {
  publicationId: string;
  slug?: string;
  custom?: boolean;
  recipientLabel?: string | null;
  passwordHash?: string | null;
  expiresAt?: string | null;
  trackOpens?: boolean;
}

export interface UpdateShareLinkInput {
  recipientLabel?: string | null;
  passwordHash?: string | null;
  expiresAt?: string | null;
  trackOpens?: boolean;
  revokedAt?: string | null;
}

export interface RecordOpenInput {
  shareLinkId: string;
  snapshotId: string;
  visitorHash: string;
  deviceClass?: string | null;
  country?: string | null;
}

export interface CreateFeedbackInput {
  publicationId: string;
  shareLinkId: string;
  snapshotId: string;
  anchor: ExternalAnchor;
  note: string;
  name: string;
  email?: string | null;
}

export interface FeedbackQuery {
  publicationId?: string;
  shareLinkId?: string;
  snapshotId?: string;
  status?: FeedbackStatus;
}

// Publication-side storage. Optional on `Store`: only the SQLite-backed store
// implements it (the same class runs on node:sqlite and on the Durable Object),
// so a store without it simply cannot host publications and the app says so.
export interface PublicationStore {
  createPublication(input: CreatePublicationInput): Promise<Publication>;
  getPublication(id: string): Promise<Publication | null>;
  listPublications(): Promise<Publication[]>;
  updatePublication(id: string, patch: UpdatePublicationInput): Promise<Publication | null>;
  removePublication(id: string): Promise<boolean>;

  createSnapshot(input: CreateSnapshotInput): Promise<Snapshot | null>;
  getSnapshot(id: string): Promise<Snapshot | null>;
  listSnapshots(publicationId: string): Promise<Snapshot[]>;

  createShareLink(input: CreateShareLinkInput): Promise<ShareLink | null>;
  getShareLink(id: string): Promise<ShareLink | null>;
  getShareLinkBySlug(slug: string): Promise<ShareLink | null>;
  listShareLinks(publicationId?: string): Promise<ShareLink[]>;
  updateShareLink(id: string, patch: UpdateShareLinkInput): Promise<ShareLink | null>;
  removeShareLink(id: string): Promise<boolean>;

  recordOpen(input: RecordOpenInput): Promise<OpenEvent | null>;
  listOpenEvents(shareLinkId: string, limit?: number): Promise<OpenEvent[]>;
  getOpenAggregate(shareLinkId: string): Promise<OpenAggregate>;
  /** Delete detailed events older than `before` (ISO). Aggregates are kept. */
  pruneOpenEvents(before: string): Promise<number>;

  createFeedback(input: CreateFeedbackInput): Promise<ExternalFeedback | null>;
  getFeedback(id: string): Promise<ExternalFeedback | null>;
  listFeedback(query: FeedbackQuery): Promise<ExternalFeedback[]>;
  setFeedbackStatus(id: string, status: FeedbackStatus): Promise<ExternalFeedback | null>;

  /** Whether any snapshot pins this asset id (keeps it out of eviction). */
  isSnapshotAsset(assetId: string): Promise<boolean>;

  /**
   * Ids of the publications whose snapshots pin this asset. The public asset
   * route needs to know WHOSE an asset is, so it can apply the same revocation
   * and expiry gate every other public route applies; `isSnapshotAsset` alone
   * only says the bytes are pinned by someone.
   */
  snapshotAssetPublications(assetId: string): Promise<string[]>;
}

// Detailed open events are pruned at 90 days; aggregates persist.
export const OPEN_EVENT_RETENTION_DAYS = 90;

// Capability tokens are the whole security of a generated share URL, so they get
// 128 bits of entropy (22 url-safe base64 chars) rather than the 64-bit `newId`
// used for workspace-internal ids.
export const SHARE_TOKEN_BYTES = 16;

export const newShareToken = (): string =>
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(SHARE_TOKEN_BYTES))))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

// Custom slugs are user-chosen and land in a URL path segment; keep them to a
// conservative, unambiguous alphabet so they can't collide with routes or need
// escaping.
export const CUSTOM_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;

export function isValidCustomSlug(slug: unknown): slug is string {
  return typeof slug === "string" && CUSTOM_SLUG_PATTERN.test(slug);
}

// A share link is usable only when it is neither revoked nor past its expiry.
// Everything else (password) is a separate gate. Fails closed on a malformed
// expiry.
export function shareLinkState(
  link: Pick<ShareLink, "revokedAt" | "expiresAt">,
  now: number = Date.now(),
): "active" | "revoked" | "expired" {
  if (link.revokedAt) return "revoked";
  if (link.expiresAt) {
    const at = Date.parse(link.expiresAt);
    if (!Number.isFinite(at) || at <= now) return "expired";
  }
  return "active";
}

// Collect the asset ids a snapshot's frozen surfaces reference, so the snapshot
// can pin them independently of the rolling post history.
export function collectSnapshotAssetIds(items: SnapshotItem[]): string[] {
  const out = new Set<string>();
  for (const item of items) {
    for (const surface of item.surfaces) {
      if (surface.kind === "image") out.add(surface.assetId);
      else if (surface.kind === "trace" && surface.assetId) out.add(surface.assetId);
    }
  }
  return [...out];
}
