import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import {
  type CollectionPreview,
  type PublicationStatus,
  publishSession,
  publishSessionErrorMessage,
  sessionCollectionPreview,
} from "./api.ts";
import { writeClipboard } from "./clipboard.ts";
import { root } from "./host.ts";
import {
  defaultSelectedPostIds,
  NOT_PUBLISHABLE,
  selectedPostIds,
  selectionSummary,
} from "./publishSelection.ts";
import { toast } from "./state.ts";

// Publishing a session is the one write in the viewer that puts a whole
// conversation on the public web, so it is never a single click: this dialog is
// the mandatory confirmation view. It lists every post the session currently
// holds, in session order, and publishes exactly the ticked ids — so an
// accidental open costs nothing and a stale extra post can be dropped before it
// ships.
//
// Cancel (the button, Escape, a click on the backdrop, the ✕) must be genuinely
// inert: it closes and issues no write at all. The only request this dialog
// makes before the user confirms is the preview GET.
//
// It follows the fullscreen surface dialog's modal pattern (backdrop + focus
// trap + Escape) rather than inventing a second one.

export function PublishSessionDialog(props: {
  sessionId: string;
  // The session's publication as the opener already knew it — decides whether
  // this is a first publish or an update, and supplies the existing URL.
  publication: PublicationStatus | null;
  onClose: () => void;
  // Called with the fresh status after a successful publish, so the opener's
  // label can flip to "Update publication" without refetching.
  onPublished?: (status: PublicationStatus) => void;
}) {
  let dialog: HTMLDivElement | undefined;
  const [preview, setPreview] = createSignal<CollectionPreview | null>(null);
  const [loadError, setLoadError] = createSignal<string | null>(null);
  const [selected, setSelected] = createSignal<ReadonlySet<string>>(new Set());
  const [publishing, setPublishing] = createSignal(false);

  const posts = () => preview()?.posts ?? [];
  const chosen = () => selectedPostIds(posts(), selected());
  const isUpdate = () => !!props.publication?.published;
  const primaryLabel = () =>
    publishing() ? "Publishing…" : isUpdate() ? "Update publication" : "Publish session";

  onMount(() => {
    sessionCollectionPreview(props.sessionId)
      .then((data) => {
        setPreview(data);
        setSelected(new Set(defaultSelectedPostIds(data.posts)));
      })
      .catch((err) => setLoadError(publishSessionErrorMessage(err)));
  });

  const toggle = (postId: string, on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(postId);
      else next.delete(postId);
      return next;
    });
  };

  // The inert exit. Nothing is sent; a publish already in flight is not
  // cancellable, so the dialog simply refuses to close under it.
  const cancel = () => {
    if (publishing()) return;
    props.onClose();
  };

  const confirm = async () => {
    const postIds = chosen();
    if (publishing() || postIds.length === 0) return;
    setPublishing(true);
    try {
      const result = await publishSession(props.sessionId, postIds);
      props.onPublished?.({
        configured: true,
        published: true,
        publicationId: result.publicationId,
        url: result.url,
        revision: result.revision,
      });
      const copied = await writeClipboard(result.url);
      props.onClose();
      toast(
        result.updated
          ? copied
            ? "Publication updated — link copied"
            : "Publication updated"
          : copied
            ? "Session published — link copied"
            : "Session published",
      );
    } catch (err) {
      props.onClose();
      toast(publishSessionErrorMessage(err));
    } finally {
      setPublishing(false);
    }
  };

  const focusable = () =>
    Array.from(
      dialog?.querySelectorAll<HTMLElement>(
        'button, input, [href], select, textarea, [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    ).filter((el) => !el.hasAttribute("disabled") && el.tabIndex >= 0);

  // Escape cancels and Tab is trapped, bound at the root for the same reason the
  // share menu does it: focus can sit outside the dialog for a beat while the
  // preview loads.
  createEffect(() => {
    queueMicrotask(() => focusable()[0]?.focus());
    const onKey = (event: Event) => {
      const e = event as KeyboardEvent;
      if (e.key === "Escape") {
        e.preventDefault();
        cancel();
        return;
      }
      if (e.key !== "Tab") return;
      const all = focusable();
      if (all.length === 0) return;
      const first = all[0];
      const last = all[all.length - 1];
      const active = root().activeElement;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      } else if (!active || !dialog?.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    };
    root().addEventListener("keydown", onKey);
    onCleanup(() => root().removeEventListener("keydown", onKey));
  });

  return (
    <div class="publish-backdrop" onClick={cancel}>
      <div
        ref={(el) => (dialog = el)}
        class="publish-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Publish this session"
        onClick={(e) => e.stopPropagation()}
      >
        <div class="publish-head">
          <h2>{isUpdate() ? "Update publication" : "Publish this session"}</h2>
          <button class="x" type="button" aria-label="Cancel publishing" onClick={cancel}>
            ✕
          </button>
        </div>

        <div class="publish-body">
          <p class="publish-intro">
            Review what goes public. Everything ticked below is published as one collection.
          </p>
          <Show when={props.publication?.url}>
            {(url) => (
              <p class="publish-existing">
                Already published at{" "}
                <a href={url()} target="_blank" rel="noopener noreferrer">
                  {url()}
                </a>
              </p>
            )}
          </Show>

          <Show when={loadError()}>
            <p class="publish-error" role="alert">
              {loadError()}
            </p>
          </Show>
          <Show when={!loadError() && !preview()}>
            <p class="publish-loading">Loading this session&rsquo;s posts…</p>
          </Show>

          <Show when={preview()}>
            <ul class="publish-list">
              <For each={posts()}>
                {(post) => (
                  <li class="publish-row" classList={{ off: !post.publishable }}>
                    <label>
                      <input
                        type="checkbox"
                        checked={selected().has(post.postId)}
                        disabled={!post.publishable}
                        onChange={(e) => toggle(post.postId, e.currentTarget.checked)}
                      />
                      <span class="publish-row-text">
                        <span class="publish-row-title">{post.title}</span>
                        <span class="publish-row-meta">
                          {post.surfaceKinds.join(", ") || "no surfaces"}
                          <Show when={!post.publishable}>
                            <span class="publish-row-why"> · {NOT_PUBLISHABLE}</span>
                          </Show>
                        </span>
                      </span>
                    </label>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </div>

        <div class="publish-foot">
          <span class="publish-count">{selectionSummary(chosen().length, posts().length)}</span>
          <span class="publish-foot-sp"></span>
          <button class="publish-btn" type="button" disabled={publishing()} onClick={cancel}>
            Cancel
          </button>
          <button
            class="publish-btn primary"
            type="button"
            disabled={publishing() || chosen().length === 0}
            onClick={confirm}
          >
            {primaryLabel()}
          </button>
        </div>
      </div>
    </div>
  );
}
