import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import {
  anchorLabel,
  anchorPercent,
  type ExternalFeedback,
  FEEDBACK_HISTORICAL_NOTE,
  FEEDBACK_NO_AUTO_SEND,
  FEEDBACK_STATUSES,
  type FeedbackEntry,
  feedbackAuthor,
  feedbackErrorMessage,
  feedbackPromptFor,
  feedbackSurfaceSrc,
  type FeedbackStatus,
  relTime,
  setFeedbackStatus,
} from "./api.ts";
import { writeClipboard } from "./clipboard.ts";
import { CommentIcon } from "./icons.tsx";
import {
  applyStatus,
  feedbackConfigured,
  feedbackEntries,
  feedbackError,
  feedbackFilter,
  feedbackUnread,
  groupFeedback,
  linkLabel,
  loadFeedback,
  setFeedbackFilter,
  startFeedbackPolling,
  type StatusFilter,
} from "./feedbackInbox.ts";
import { activeTheme, resolvedMode } from "./theme.ts";
import { toast } from "./state.ts";

// The owner's inbox for what clients wrote back on a published artifact.
//
// Two rules shape the whole view. First, a submission is untrusted text from
// somebody outside this workspace: every part of it — the note, the name, the
// quote — is rendered as a text node, never as markup, and the surface it was
// written against is reopened inside a sandboxed iframe pointing at the
// server's frozen copy. Second, nothing here reaches an agent on its own: the
// only export is a block of text the owner puts on their own clipboard
// (docs/adr/0003).

const FILTERS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  ...FEEDBACK_STATUSES.map((value) => ({
    value: value as StatusFilter,
    label: value[0]!.toUpperCase() + value.slice(1),
  })),
];

const receivedAt = (feedback: ExternalFeedback) => {
  const at = Date.parse(feedback.createdAt);
  return Number.isFinite(at) ? new Date(at).toLocaleString() : feedback.createdAt;
};

export function FeedbackInbox() {
  const [selected, setSelected] = createSignal<Set<string>>(new Set());
  const [openId, setOpenId] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);

  onMount(() => {
    onCleanup(startFeedbackPolling());
  });

  const groups = createMemo(() => groupFeedback(feedbackEntries() ?? []));

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Opening an unread submission marks it read — that is what "opening" means
  // here, so it does not need a second click to say so.
  //
  // The status change lands FIRST, then the detail opens. A status change
  // re-renders the row (the list is rendered from the server's objects by
  // identity), and doing that after the detail was on screen would rebuild the
  // iframe holding the frozen surface — a visible reload a moment after the
  // owner opened it.
  const open = async (entry: FeedbackEntry) => {
    const id = entry.feedback.id;
    if (openId() === id) {
      setOpenId(null);
      return;
    }
    if (entry.feedback.status === "unread") await mark(id, "read");
    setOpenId(id);
  };

  const mark = async (id: string, status: FeedbackStatus) => {
    try {
      await setFeedbackStatus(id, status);
      applyStatus(id, status);
      await loadFeedback();
    } catch (err) {
      toast(feedbackErrorMessage(err, "Couldn't update that"));
    }
  };

  const copyPrompt = async () => {
    const ids = [...selected()];
    if (ids.length === 0) return;
    setBusy(true);
    // The text is claimed inside the click gesture (writeClipboard takes the
    // promise) so Safari still allows the write once the fetch resolves.
    const ok = await writeClipboard(feedbackPromptFor(ids).then((res) => res.prompt));
    setBusy(false);
    toast(
      ok
        ? `Prompt copied — ${ids.length} comment${ids.length === 1 ? "" : "s"}`
        : "Couldn't copy that",
    );
  };

  return (
    <section class="settings-page fb-page" aria-label="Feedback">
      <div class="settings-col">
        <header class="settings-top">
          <h1>Feedback</h1>
          <p>
            Comments clients left on published artifacts, newest first.{" "}
            <span class="fb-unread-total">{feedbackUnread()} unread</span>
          </p>
          <p class="fb-boundary">{FEEDBACK_NO_AUTO_SEND}</p>
        </header>

        <Show when={feedbackConfigured() === false}>
          <p class="pubs-empty">
            This workspace has no publication destination configured, so there is nothing to collect
            feedback on yet.
          </p>
        </Show>
        <Show when={feedbackError()}>
          <p class="pubs-error" role="alert">
            {feedbackError()}
          </p>
        </Show>

        <div class="fb-bar">
          <div class="fb-filters" role="group" aria-label="Filter by status">
            <For each={FILTERS}>
              {(filter) => (
                <button
                  type="button"
                  class="fb-filter"
                  classList={{ on: feedbackFilter() === filter.value }}
                  aria-pressed={feedbackFilter() === filter.value}
                  onClick={() => void setFeedbackFilter(filter.value)}
                >
                  {filter.label}
                </button>
              )}
            </For>
          </div>
          <button
            type="button"
            class="publish-btn primary fb-copy"
            disabled={selected().size === 0 || busy()}
            onClick={() => void copyPrompt()}
          >
            Copy prompt for {selected().size} selected
          </button>
        </div>

        <Show when={feedbackEntries()} fallback={<p class="pubs-loading">Loading…</p>}>
          {(rows) => (
            <Show
              when={rows().length > 0}
              fallback={<p class="pubs-empty">No feedback here yet.</p>}
            >
              <For each={groups()}>
                {(publication) => (
                  <section class="fb-pub" aria-label={publication.title}>
                    <h2>
                      {publication.title}
                      <span class="fb-count">
                        {publication.count} comment{publication.count === 1 ? "" : "s"}
                      </span>
                    </h2>
                    <For each={publication.links}>
                      {(link) => (
                        <div class="fb-link">
                          <h3>{linkLabel(link)}</h3>
                          <For each={link.snapshots}>
                            {(snapshot) => (
                              <div class="fb-snap">
                                <h4>Revision {snapshot.revision}</h4>
                                <For each={snapshot.surfaces}>
                                  {(surface) => (
                                    <div class="fb-surface">
                                      <h5>
                                        {surface.itemTitle}
                                        <span class="fb-kind">{surface.surfaceKind}</span>
                                      </h5>
                                      <ul class="fb-items">
                                        <For each={surface.entries}>
                                          {(entry) => (
                                            <FeedbackRow
                                              entry={entry}
                                              open={openId() === entry.feedback.id}
                                              checked={selected().has(entry.feedback.id)}
                                              onToggle={() => toggle(entry.feedback.id)}
                                              onOpen={() => void open(entry)}
                                              onMark={(status) =>
                                                void mark(entry.feedback.id, status)
                                              }
                                            />
                                          )}
                                        </For>
                                      </ul>
                                    </div>
                                  )}
                                </For>
                              </div>
                            )}
                          </For>
                        </div>
                      )}
                    </For>
                  </section>
                )}
              </For>
            </Show>
          )}
        </Show>
      </div>
    </section>
  );
}

function FeedbackRow(props: {
  entry: FeedbackEntry;
  open: boolean;
  checked: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onMark: (status: FeedbackStatus) => void;
}) {
  const feedback = () => props.entry.feedback;
  const point = () => anchorPercent(feedback().anchor);
  const quote = () => {
    const anchor = feedback().anchor;
    return anchor.kind === "text" ? anchor.quote : null;
  };
  return (
    <li
      class="fb-item"
      classList={{ unread: feedback().status === "unread", open: props.open }}
      data-feedback={feedback().id}
      data-status={feedback().status}
    >
      <div class="fb-item-head">
        <label class="fb-select">
          <input
            type="checkbox"
            checked={props.checked}
            onChange={props.onToggle}
            aria-label={`Select feedback from ${feedback().name}`}
          />
        </label>
        <button type="button" class="fb-open" aria-expanded={props.open} onClick={props.onOpen}>
          {/* Everything below is third-party text, so it goes in as text
              nodes — Solid escapes by construction. Never markup. */}
          <span class="fb-note">{feedback().note}</span>
          <span class="fb-meta">
            <span class="fb-who">{feedbackAuthor(feedback())}</span>
            {" · "}
            {relTime(feedback().createdAt)}
            {" · "}
            <span class="fb-anchor">{anchorLabel(feedback().anchor)}</span>
            {" · revision "}
            {props.entry.snapshotRevision}
            {" · "}
            <span class="fb-status">{feedback().status}</span>
          </span>
        </button>
      </div>
      <Show when={props.open}>
        <div class="fb-detail">
          <p class="fb-received">Received {receivedAt(feedback())}</p>
          <Show when={quote()}>
            {(text) => (
              <blockquote class="fb-quote">
                <span>{text()}</span>
              </blockquote>
            )}
          </Show>
          <p class="fb-historical">{FEEDBACK_HISTORICAL_NOTE}</p>
          <div class="fb-frame-wrap">
            <iframe
              class="fb-frame"
              sandbox="allow-scripts"
              loading="lazy"
              title={`Revision ${props.entry.snapshotRevision} of ${props.entry.itemTitle}`}
              src={feedbackSurfaceSrc(props.entry, activeTheme(), resolvedMode())}
            ></iframe>
            <Show when={point()}>
              {(at) => (
                <span
                  class="fb-point"
                  data-x={at().x}
                  data-y={at().y}
                  style={{ left: `${at().x}%`, top: `${at().y}%` }}
                  aria-label={`Comment point at ${at().x}% across, ${at().y}% down`}
                ></span>
              )}
            </Show>
          </div>
          <div class="fb-actions">
            <For each={["read", "resolved", "rejected"] as FeedbackStatus[]}>
              {(status) => (
                <button
                  type="button"
                  class="publish-btn"
                  disabled={feedback().status === status}
                  onClick={() => props.onMark(status)}
                >
                  Mark {status}
                </button>
              )}
            </For>
          </div>
        </div>
      </Show>
    </li>
  );
}

// The nav entry, carrying the unread count. It starts the same poller the view
// does, so the badge is live wherever the owner happens to be — still on the
// inbox's own routes, never the agent stream. The poller is destination-gated
// (see feedbackInbox.ts), and the entry itself only appears once a destination
// answers: without one there is nothing published to comment on.
export function FeedbackLink(props: { onOpen: () => void; href: string; iconOnly?: boolean }) {
  onMount(() => {
    onCleanup(startFeedbackPolling());
  });
  return (
    <Show when={feedbackConfigured()}>
      <a
        class="fb-nav"
        classList={{ "foot-icon": props.iconOnly }}
        href={props.href}
        title={props.iconOnly ? "Feedback" : undefined}
        data-tooltip={props.iconOnly ? "Feedback" : undefined}
        aria-label={props.iconOnly ? "Feedback" : undefined}
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
          e.preventDefault();
          props.onOpen();
        }}
      >
        <Show when={props.iconOnly} fallback={<>feedback</>}>
          <CommentIcon />
        </Show>
        <Show when={feedbackUnread() > 0}>
          <span class="fb-badge" aria-label={`${feedbackUnread()} unread comments`}>
            {feedbackUnread()}
          </span>
        </Show>
      </a>
    </Show>
  );
}
