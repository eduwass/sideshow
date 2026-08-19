// Thin client over the REST API, typed against the server's data model.
import type {
  Comment,
  CommentAnchor,
  CodeSurface,
  DiffSurface,
  HtmlSurface,
  ImageSurface,
  JsonSurface,
  MarkdownSurface,
  MermaidSurface,
  Session,
  Post,
  Surface,
  TerminalSurface,
  TraceSurface,
  TraceStep,
} from "../../server/types.ts";
import type { ViewerPost } from "../../server/apiViews.ts";
import type {
  IdentityHeader,
  Publication,
  PublicationKind,
  ShareLink,
  Snapshot,
} from "../../server/publicationTypes.ts";
import { shareLinkState } from "../../server/publicationTypes.ts";
import { host } from "./host.ts";

export type {
  Comment,
  CommentAnchor,
  CodeSurface,
  DiffSurface,
  HtmlSurface,
  ImageSurface,
  JsonSurface,
  MarkdownSurface,
  MermaidSurface,
  Session,
  Post,
  Surface,
  TerminalSurface,
  TraceSurface,
  TraceStep,
  ViewerPost,
};

export type PublicReadMode = "session" | "full";

// GET /api/sessions decorates each session with its post count. The wire field
// name `surfaceCount` is kept (server-provided).
export interface SessionRow extends Session {
  surfaceCount: number;
}

// GET /api/version — upgradeCommand and notes are set only when an update
// is actually available.
export interface VersionInfo {
  current: string | null;
  latest: string | null;
  updateAvailable: boolean;
  upgradeCommand?: string | null;
  notes?: string | null;
}

declare global {
  interface Window {
    // __SIDESHOW_BASE_PATH__ lives in host.ts (the default host reads it).
    __SIDESHOW_READONLY__?: boolean;
    __SIDESHOW_PUBLIC_READ__?: PublicReadMode;
    __SIDESHOW_SCREENSHOTS__?: boolean;
    __SIDESHOW_PAGE_TITLE__?: string;
  }
}

// The base path comes from the injected host (the default host derives it from
// the hosted-wrapper global / URL prefix, matching the pre-engine viewer).
export function appBasePath(): string {
  return host().basePath;
}

export function appPath(path: string): string {
  return `${appBasePath()}${path}`;
}

export function isReadonly(): boolean {
  // Host-first (cloud embed), falling back to the self-hosted global so the
  // self-hosted public-read page is byte-for-byte unchanged.
  return host().readonly ?? !!window.__SIDESHOW_READONLY__;
}

export function publicReadMode(): PublicReadMode | undefined {
  return window.__SIDESHOW_PUBLIC_READ__;
}

export function initialPageTitle(): string | undefined {
  return window.__SIDESHOW_PAGE_TITLE__;
}

// The engine's layout. "full" shows the sidebar + stream; "stream" shows only
// the current session's stream (no sidebar/session list). An embedder requests
// it through the host; the self-hosted public-read "session" link maps to
// "stream", so that flow is unchanged with no host field set.
export function layoutMode(): "full" | "stream" {
  return host().layout ?? (publicReadMode() === "session" ? "stream" : "full");
}

// `/p/:id` is a post's canonical permalink (`/s/:id` is the legacy alias).
export function postLink(id: string): string {
  return `${location.origin}${appPath(`/p/${encodeURIComponent(id)}`)}`;
}

// The PNG screenshot of a post (the same /p/:id page, captured server-side).
// Only reachable where `canScreenshot()` is true — see that helper.
export function postImageLink(id: string): string {
  return `${location.origin}${appPath(`/p/${encodeURIComponent(id)}.png`)}`;
}

// The post flattened to markdown (GET /api/posts/:id/markdown). Served rather
// than derived here: a hydrated post omits sandboxed surface bodies, so only the
// server can see the whole post (see apiViews.ts).
export function postMarkdownPath(id: string): string {
  return `/api/posts/${encodeURIComponent(id)}/markdown`;
}

// Whether the deployment can render post screenshots (the /p/:id.png route).
// Host-first (cloud embed), falling back to the self-hosted global, mirroring
// isReadonly(). False on a plain Node server, which has no Browser Rendering.
export function canScreenshot(): boolean {
  return host().screenshots ?? !!window.__SIDESHOW_SCREENSHOTS__;
}

export async function api<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(
    appPath(path),
    init ? { headers: { "content-type": "application/json" }, ...init } : undefined,
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || String(res.status));
  }
  return res.json() as Promise<T>;
}

// Same fetch as api(), for the routes that answer 204 with no body at all —
// res.json() would throw on those, so they get their own tiny helper rather
// than a nullable return everywhere else has to ignore.
export async function apiVoid(path: string, init: RequestInit): Promise<void> {
  const res = await fetch(appPath(path), {
    headers: { "content-type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || String(res.status));
  }
}

// Same fetch as api(), for the routes that answer with text rather than JSON.
export async function apiText(path: string): Promise<string> {
  const res = await fetch(appPath(path));
  if (!res.ok) throw new Error(String(res.status));
  return res.text();
}

export const sessionLabel = (s: Session) => s.title || s.agent + " session";

export function relTime(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// --- publishing a post to the public destination ---
//
// Publishing runs entirely server-side (the browser never holds the
// destination's write token), so the viewer only asks three things: whether a
// destination exists at all, whether this post already has a publication, and
// "publish it now".

export type PublishDestination = { configured: boolean; origin: string | null };

export type PublicationStatus = {
  configured: boolean;
  published: boolean;
  publicationId?: string;
  url?: string;
  revision?: number;
  updatedAt?: string;
  links?: number;
};

export type PublishPostResult = {
  publicationId: string;
  snapshotId: string;
  revision: number;
  slug: string;
  url: string;
  // False on a first publish, true when an existing publication gained a revision.
  updated: boolean;
};

export const publishDestinationPath = () => "/api/publish/destination";

export function publicationStatusPath(id: string): string {
  return `/api/publish/post/${encodeURIComponent(id)}`;
}

export const publishPostPath = () => "/api/publish/post";

// Whether this workspace publishes anywhere is a deploy-level fact, so it is
// fetched once per page and shared by every card's share menu — opening a menu
// in a long feed must not be chatty. A failure is not cached, so a transient
// error doesn't leave the menu permanently wrong.
let destinationOnce: Promise<PublishDestination> | null = null;

export function publishDestination(): Promise<PublishDestination> {
  return (destinationOnce ??= api<PublishDestination>(publishDestinationPath()).catch((err) => {
    destinationOnce = null;
    throw err;
  }));
}

export function publicationStatus(id: string): Promise<PublicationStatus> {
  return api<PublicationStatus>(publicationStatusPath(id));
}

export function publishPost(postId: string, version?: number): Promise<PublishPostResult> {
  return api<PublishPostResult>(publishPostPath(), {
    method: "POST",
    body: JSON.stringify(version === undefined ? { postId } : { postId, version }),
  });
}

// api() throws the server's `error` string when there is one and the bare status
// code when there isn't — a status code is not a sentence, so it becomes the
// generic message instead of leaking "503" into a toast.
function serverErrorMessage(err: unknown, fallback: string): string {
  const message = err instanceof Error ? err.message : "";
  return message && !/^\d+$/.test(message) ? message : fallback;
}

export function publishErrorMessage(err: unknown): string {
  return serverErrorMessage(err, "Couldn't publish this post");
}

// Why a publish affordance can be offered and still be inert. Shared by the
// card's share menu and the session header so the two explain it identically.
export const NO_DESTINATION =
  "This workspace has no publication destination configured. See the README.";

// --- publishing a whole session as a collection ---
//
// A collection is published from a REVIEWED list of post ids, never from
// "whatever is in the session right now" — so the viewer first asks the server
// what the session currently holds (the preview) and only sends what the user
// confirmed.

export type CollectionPreviewPost = {
  postId: string;
  title: string;
  version: number;
  surfaceKinds: string[];
  updatedAt: string;
  // False when the post has no surface the destination can render — it is still
  // listed (so the review is of the whole session) but can never be included.
  publishable: boolean;
};

export type CollectionPreview = {
  sessionId: string;
  title: string;
  posts: CollectionPreviewPost[];
};

// The session publish answers with the same shape a post publish does.
export type PublishSessionResult = PublishPostResult;

export function sessionPreviewPath(id: string): string {
  return `/api/publish/session/${encodeURIComponent(id)}/preview`;
}

export function sessionPublicationStatusPath(id: string): string {
  return `/api/publish/session/${encodeURIComponent(id)}`;
}

export const publishSessionPath = () => "/api/publish/session";

export function sessionCollectionPreview(id: string): Promise<CollectionPreview> {
  return api<CollectionPreview>(sessionPreviewPath(id));
}

export function sessionPublicationStatus(id: string): Promise<PublicationStatus> {
  return api<PublicationStatus>(sessionPublicationStatusPath(id));
}

export function publishSession(
  sessionId: string,
  postIds: string[],
  title?: string,
): Promise<PublishSessionResult> {
  return api<PublishSessionResult>(publishSessionPath(), {
    method: "POST",
    body: JSON.stringify(
      title === undefined ? { sessionId, postIds } : { sessionId, postIds, title },
    ),
  });
}

export function publishSessionErrorMessage(err: unknown): string {
  return serverErrorMessage(err, "Couldn't publish this session");
}

// --- the owner's publications dashboard ---
//
// Publications live in the public service, never in this workspace, so the
// private server proxies a fixed set of owner routes to it (see the "owner
// views of the public service" block in server/app.ts). Every one of them
// answers 503 when no destination is configured, which is why the dashboard is
// only offered once publishDestination() reports `configured`.

export type { IdentityHeader, Publication, PublicationKind, ShareLink };

// The owner's view of a share link: the whole record except `passwordHash`,
// which never leaves the public service, plus the one bit the owner does need.
// Derived from ShareLink so it cannot drift from `ownerLinkView` (publicApp.ts).
export interface ShareLinkView extends Omit<ShareLink, "passwordHash"> {
  hasPassword: boolean;
}

// Snapshot metadata only: the frozen surfaces are far too large to list, so the
// detail route sends every field but `items` plus that item count.
export interface SnapshotMeta extends Omit<Snapshot, "items"> {
  itemCount: number;
}

export interface PublicationList {
  origin: string;
  publications: Publication[];
}

export interface PublicationDetail {
  origin: string;
  publication: Publication;
  snapshots: SnapshotMeta[];
  links: ShareLinkView[];
}

export interface CreateShareLinkInput {
  // Omitted for a generated (unguessable) slug — see CUSTOM_SLUG_WARNING.
  slug?: string;
  recipientLabel?: string;
  password?: string;
  expiresAt?: string;
  trackOpens?: boolean;
}

// `null` clears a password or an expiry; omitting the key leaves it alone.
// `revoked: true` is one-way for that recipient.
export interface UpdateShareLinkPatch {
  recipientLabel?: string;
  password?: string | null;
  expiresAt?: string | null;
  trackOpens?: boolean;
  revoked?: boolean;
}

export const publicationsPath = () => "/api/publications";

export function publicationPath(id: string): string {
  return `/api/publications/${encodeURIComponent(id)}`;
}

export function publicationLinksPath(id: string): string {
  return `${publicationPath(id)}/links`;
}

export function shareLinkPath(linkId: string): string {
  return `/api/publications/links/${encodeURIComponent(linkId)}`;
}

export function shareLinkDuplicatePath(linkId: string): string {
  return `${shareLinkPath(linkId)}/duplicate`;
}

export function listPublications(): Promise<PublicationList> {
  return api<PublicationList>(publicationsPath());
}

export function publicationDetail(id: string): Promise<PublicationDetail> {
  return api<PublicationDetail>(publicationPath(id));
}

export function updatePublication(
  id: string,
  patch: { title?: string; identity?: IdentityHeader | null },
): Promise<Publication> {
  return api<Publication>(publicationPath(id), { method: "PATCH", body: JSON.stringify(patch) });
}

export function deletePublication(id: string): Promise<void> {
  return apiVoid(publicationPath(id), { method: "DELETE" });
}

export function createShareLink(id: string, input: CreateShareLinkInput): Promise<ShareLinkView> {
  return api<ShareLinkView>(publicationLinksPath(id), {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateShareLink(
  linkId: string,
  patch: UpdateShareLinkPatch,
): Promise<ShareLinkView> {
  return api<ShareLinkView>(shareLinkPath(linkId), {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export function duplicateShareLink(
  linkId: string,
  input: { recipientLabel?: string; slug?: string } = {},
): Promise<ShareLinkView> {
  return api<ShareLinkView>(shareLinkDuplicatePath(linkId), {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function deleteShareLink(linkId: string): Promise<void> {
  return apiVoid(shareLinkPath(linkId), { method: "DELETE" });
}

export function publicationErrorMessage(err: unknown, fallback = "That didn't work"): string {
  return serverErrorMessage(err, fallback);
}

// --- confirmed opens ---
//
// What the owner is allowed to know about a share link's readers, and nothing
// more: counts, coarse device class, country. The public service never sends
// the visitor hash or an IP, and there is nothing here to join back to a
// person — see ANALYTICS_DISCLAIMER, which the dashboard shows beside every
// one of these numbers rather than burying in a doc.

export interface OpenEventView {
  at: string;
  deviceClass: string | null;
  country: string | null;
  snapshotId: string;
}

// Kept forever, unlike the events: the prune below must never take these.
export interface OpenAggregateView {
  shareLinkId: string;
  firstOpenAt: string | null;
  lastOpenAt: string | null;
  totalOpens: number;
  uniqueVisitors: number;
}

export interface ShareLinkAnalytics {
  trackOpens: boolean;
  /** How long detailed events survive; the aggregate above outlives them. */
  retentionDays: number;
  aggregate: OpenAggregateView;
  events: OpenEventView[];
}

export const ANALYTICS_RECENT_LIMIT = 20;

export function shareLinkAnalyticsPath(linkId: string, limit?: number): string {
  const base = `${shareLinkPath(linkId)}/analytics`;
  return limit === undefined ? base : `${base}?limit=${encodeURIComponent(String(limit))}`;
}

export function shareLinkAnalytics(linkId: string, limit?: number): Promise<ShareLinkAnalytics> {
  return api<ShareLinkAnalytics>(shareLinkAnalyticsPath(linkId, limit));
}

// The one sentence that has to travel with these figures. An open says a
// browser rendered the page behind this link — not who was holding it — and the
// "unique visitors" count is a rotating keyed hash, so the same person reads as
// somebody new once the window turns.
export const ANALYTICS_DISCLAIMER =
  "This is likely-recipient activity, not proof of identity. A link can be forwarded, and visitors are counted with an approximate, rotating, keyed hash rather than anything that identifies a person.";

export function retentionNote(days: number): string {
  return `Recent activity is kept for ${days} days. The totals above are kept indefinitely.`;
}

const DEVICE_LABEL: Record<string, string> = {
  mobile: "Phone",
  tablet: "Tablet",
  desktop: "Computer",
};

export function formatDeviceClass(deviceClass: string | null): string {
  return (deviceClass && DEVICE_LABEL[deviceClass]) || "Unknown device";
}

export function formatCountry(country: string | null): string {
  return country ? country.toUpperCase() : "Unknown country";
}

/** A first/last-open timestamp, or a plain "never" rather than a blank cell. */
export function formatOpenAt(iso: string | null): string {
  if (!iso) return "Never";
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "Unknown";
  return new Date(at).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// A share link's public address. The public service serves a publication at
// `/v/<slug>` on its own origin, which the dashboard learns from the routes
// above rather than guessing (a workspace and its destination are different
// hosts).
export function shareLinkUrl(origin: string, slug: string): string {
  return `${origin.replace(/\/+$/, "")}/v/${encodeURIComponent(slug)}`;
}

export type ShareLinkStatus = "active" | "expired" | "revoked";

// The SAME rule the public service enforces, imported rather than re-derived —
// a dashboard that disagreed with the runtime about whether a link still works
// would be worse than no dashboard at all.
export const shareLinkStatus: (
  link: Pick<ShareLink, "revokedAt" | "expiresAt">,
  now?: number,
) => ShareLinkStatus = shareLinkState;

export function formatExpiry(expiresAt: string | null, now: number = Date.now()): string {
  if (!expiresAt) return "No expiry";
  const at = Date.parse(expiresAt);
  // Fails closed, exactly like shareLinkStatus: an expiry we cannot read is
  // treated as already past, not as "no expiry".
  if (!Number.isFinite(at)) return "Unreadable expiry";
  const when = new Date(at).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return at <= now ? `Expired ${when}` : `Expires ${when}`;
}

// <input type="datetime-local"> speaks local wall-clock with no zone; the wire
// speaks ISO/UTC. These two convert between them and round-trip.
export function expiryInputValue(expiresAt: string | null): string {
  if (!expiresAt) return "";
  const at = new Date(expiresAt);
  if (Number.isNaN(at.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

export function expiryFromInput(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const at = new Date(trimmed);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

// Shown beside the custom-slug field, and deliberately blunt: a custom address
// is a guessable name, not a capability token, so the owner must be told before
// they choose one rather than after someone stumbles onto the publication.
export const CUSTOM_SLUG_WARNING =
  "A custom address is not a secret — anyone who guesses or shares it can open this publication. Leave it blank and sideshow generates an unguessable address instead.";
