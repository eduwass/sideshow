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
export function publishErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : "";
  return message && !/^\d+$/.test(message) ? message : "Couldn't publish this post";
}
