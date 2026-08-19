// State for the external-feedback inbox: what has arrived, what is unread, and
// the polling that keeps both fresh.
//
// This deliberately does NOT ride /api/events, the comment long-poll, or the
// agent cursor. Those are the trusted comment→agent stream; an untrusted
// share-link holder's submission must never travel on it (docs/adr/0003), and
// wiring the inbox into that stream is exactly how the boundary would erode.
// So: plain polling of the inbox's own routes, on a modest interval and on
// window focus, and only when a publication destination exists at all — with no
// destination every one of those routes answers 503, so polling would be pure
// noise.
import { createSignal } from "solid-js";
import {
  type FeedbackEntry,
  feedbackErrorMessage,
  type FeedbackStatus,
  listFeedback,
  publishDestination,
} from "./api.ts";

export const FEEDBACK_POLL_MS = 30_000;

export type StatusFilter = FeedbackStatus | "all";

const [entriesState, setEntries] = createSignal<FeedbackEntry[] | null>(null);
export const feedbackEntries = entriesState;

const [unreadState, setUnread] = createSignal(0);
export const feedbackUnread = unreadState;

const [filterState, setFilterInternal] = createSignal<StatusFilter>("all");
export const feedbackFilter = filterState;

const [errorState, setError] = createSignal("");
export const feedbackError = errorState;

/** Whether this workspace publishes anywhere; null until the probe answers. */
const [configuredState, setConfigured] = createSignal<boolean | null>(null);
export const feedbackConfigured = configuredState;

// A poll that found nothing new must change nothing. The list is rendered from
// these objects by identity, so re-setting an equal payload would tear down and
// rebuild every row — including an open submission and the iframe holding its
// frozen surface, which would reload out from under the owner reading it every
// thirty seconds. Comparing the serialized payload is cheap at inbox sizes; the
// upgrade path, if an inbox ever gets big, is a per-row merge keyed by id.
export function sameFeedback(a: FeedbackEntry[] | null, b: FeedbackEntry[]): boolean {
  return a !== null && JSON.stringify(a) === JSON.stringify(b);
}

export async function loadFeedback(): Promise<void> {
  try {
    const inbox = await listFeedback(
      filterState() === "all" ? undefined : (filterState() as FeedbackStatus),
    );
    if (!sameFeedback(entriesState(), inbox.feedback)) setEntries(inbox.feedback);
    setUnread(inbox.unread);
    setError("");
  } catch (err) {
    setError(feedbackErrorMessage(err));
  }
}

export async function setFeedbackFilter(filter: StatusFilter): Promise<void> {
  setFilterInternal(filter);
  setEntries(null);
  await loadFeedback();
}

/** Fold one already-known status change in without a round trip. */
export function applyStatus(id: string, status: FeedbackStatus): void {
  setEntries((rows) =>
    rows
      ? rows.map((row) =>
          row.feedback.id === id ? { ...row, feedback: { ...row.feedback, status } } : row,
        )
      : rows,
  );
}

// One poller for the whole page however many components want the count:
// the nav badge and the inbox view both start it, and it stops when the last
// one lets go.
let holders = 0;
let timer: ReturnType<typeof setInterval> | undefined;
let onFocus: (() => void) | undefined;

async function pollIfConfigured(): Promise<void> {
  if (configuredState() === false) return;
  await loadFeedback();
}

export function startFeedbackPolling(): () => void {
  holders += 1;
  if (holders === 1) {
    void publishDestination()
      .then((destination) => {
        setConfigured(destination.configured);
        // No destination means no inbox to poll — every route 503s.
        if (!destination.configured) return;
        void loadFeedback();
        timer = setInterval(() => void pollIfConfigured(), FEEDBACK_POLL_MS);
        onFocus = () => void pollIfConfigured();
        window.addEventListener("focus", onFocus);
      })
      .catch(() => {
        // An unknown destination is treated as none: polling stays off rather
        // than hammering a route that may not exist.
        setConfigured(false);
      });
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders -= 1;
    if (holders > 0) return;
    if (timer) clearInterval(timer);
    timer = undefined;
    if (onFocus) window.removeEventListener("focus", onFocus);
    onFocus = undefined;
  };
}

// --- grouping ------------------------------------------------------------
//
// Publication → share link → snapshot → surface, which is the order an owner
// actually asks the question in: which artifact, who was looking at it, which
// revision they saw, and which block on the page.

export interface SurfaceGroup {
  key: string;
  itemTitle: string;
  surfaceKind: string;
  entries: FeedbackEntry[];
}

export interface SnapshotGroup {
  key: string;
  revision: number;
  surfaces: SurfaceGroup[];
}

export interface LinkGroup {
  key: string;
  recipientLabel: string | null;
  snapshots: SnapshotGroup[];
}

export interface PublicationGroup {
  key: string;
  title: string;
  count: number;
  links: LinkGroup[];
}

function push<T>(map: Map<string, T>, key: string, make: () => T): T {
  const existing = map.get(key);
  if (existing) return existing;
  const created = make();
  map.set(key, created);
  return created;
}

export function groupFeedback(entries: FeedbackEntry[]): PublicationGroup[] {
  const publications = new Map<string, PublicationGroup>();
  const links = new Map<string, LinkGroup>();
  const snapshots = new Map<string, SnapshotGroup>();
  const surfaces = new Map<string, SurfaceGroup>();
  for (const entry of entries) {
    const { feedback } = entry;
    const publication = push(publications, entry.publicationId, () => ({
      key: entry.publicationId,
      title: entry.publicationTitle || "Untitled",
      count: 0,
      links: [],
    }));
    publication.count += 1;
    const linkKey = `${entry.publicationId}\n${feedback.shareLinkId}`;
    const link = push(links, linkKey, () => {
      const group: LinkGroup = {
        key: linkKey,
        recipientLabel: entry.recipientLabel,
        snapshots: [],
      };
      publication.links.push(group);
      return group;
    });
    const snapshotKey = `${linkKey}\n${feedback.snapshotId}`;
    const snapshot = push(snapshots, snapshotKey, () => {
      const group: SnapshotGroup = {
        key: snapshotKey,
        revision: entry.snapshotRevision,
        surfaces: [],
      };
      link.snapshots.push(group);
      return group;
    });
    const surfaceKey = `${snapshotKey}\n${feedback.anchor.itemIndex}\n${feedback.anchor.surfaceIndex}`;
    const surface = push(surfaces, surfaceKey, () => {
      const group: SurfaceGroup = {
        key: surfaceKey,
        itemTitle: entry.itemTitle,
        surfaceKind: entry.surfaceKind,
        entries: [],
      };
      snapshot.surfaces.push(group);
      return group;
    });
    surface.entries.push(entry);
  }
  return [...publications.values()];
}

export const linkLabel = (group: LinkGroup): string =>
  group.recipientLabel ? `Link for ${group.recipientLabel}` : "Unlabelled link";
