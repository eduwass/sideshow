import { createEffect, createMemo, For, onCleanup, onMount, Show } from "solid-js";
import { relTime } from "./api.ts";
import { cardForPost } from "./Card.tsx";
import { root } from "./host.ts";
import {
  currentPostId,
  focusPost,
  orderedPosts,
  setCurrentPostId,
  setTocOpen,
  stepPost,
  tocOpen,
} from "./state.ts";

// Sessions with more than this many posts get the table of contents.
export const TOC_MIN_POSTS = 4;

// Right-hand table of contents: a rail of tick marks (one per post, the one in
// view emphasised) that expands into the post list on hover, or when opened
// from the keyboard (→ from main). Inside the list: ↑/↓ jump one post, ⌘↑/⌘↓
// (Home/End) jump to the ends, ←/Esc go back to main. The panel is absolutely
// positioned inside the rail, so it overlays the stream without changing the
// document height.
export function PostToc() {
  const ids = createMemo(() => orderedPosts().map((p) => p.id));
  const current = () => currentPostId() ?? ids()[0] ?? null;
  let nav: HTMLElement | undefined;

  // Focus must never scroll an ancestor: the panel is translated off-screen
  // while it slides in, and a plain focus() would scroll #app/body sideways to
  // reveal the item (a visible jolt of the whole page). Keep the item in view
  // by moving the list's own scrollTop instead.
  const focusItem = (id: string | null) => {
    if (!id) return;
    const item = nav?.querySelector<HTMLElement>(`.toc-item[data-id="${id}"]`);
    const list = item?.parentElement;
    if (!item || !list) return;
    item.focus({ preventScroll: true });
    const top = item.offsetTop - list.offsetTop;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (top + item.offsetHeight > list.scrollTop + list.clientHeight)
      list.scrollTop = top + item.offsetHeight - list.clientHeight;
  };
  const jump = (id: string | null) => {
    if (!id) return;
    setCurrentPostId(id);
    cardForPost(id)?.scrollIntoView({ behavior: "instant", block: "start" });
    focusPost(id);
    focusItem(id);
  };
  const close = () => {
    setTocOpen(false);
    (root().querySelector("main") as HTMLElement | null)?.focus({ preventScroll: true });
  };

  // Opening from the keyboard hands focus to the current item.
  createEffect(() => {
    // Re-check on the frame: a `]` pressed again before it runs has closed
    // the panel, and focusing then would reopen it via onFocusIn.
    if (tocOpen()) requestAnimationFrame(() => tocOpen() && focusItem(current()));
  });
  // A pointer landing anywhere outside the rail folds it.
  onMount(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (tocOpen() && e.target instanceof Node && !nav?.contains(e.target)) setTocOpen(false);
    };
    root().addEventListener("pointerdown", onPointerDown as EventListener);
    onCleanup(() => root().removeEventListener("pointerdown", onPointerDown as EventListener));
  });

  const onKeyDown = (e: KeyboardEvent) => {
    const edge = e.metaKey || e.ctrlKey;
    let next: string | null | undefined;
    if (e.key === "ArrowDown") next = stepPost(ids(), current(), edge ? "last" : 1);
    else if (e.key === "ArrowUp") next = stepPost(ids(), current(), edge ? "first" : -1);
    else if (e.key === "Home") next = stepPost(ids(), current(), "first");
    else if (e.key === "End") next = stepPost(ids(), current(), "last");
    else if (e.key === "ArrowLeft" || e.key === "Escape" || e.key === "Enter") {
      // The move already jumped; Enter/Esc/← just fold the panel.
      e.preventDefault();
      close();
      return;
    } else return;
    e.preventDefault();
    jump(next);
  };

  return (
    <nav
      class="toc"
      classList={{ open: tocOpen() }}
      aria-label="Posts in this session"
      ref={(el) => (nav = el)}
      onKeyDown={onKeyDown}
      // Tabbing in, or the window regaining focus on an item, opens the panel;
      // focus leaving the rail (or the window) folds it.
      onFocusIn={() => setTocOpen(true)}
      onFocusOut={(e) => {
        // Focus moving elsewhere in the page folds the panel. A null
        // relatedTarget is the window blurring (or a click on inert content),
        // which must not close it mid-use; clicks outside are handled below.
        if (e.relatedTarget instanceof Node && !nav?.contains(e.relatedTarget)) setTocOpen(false);
      }}
    >
      <div class="toc-ticks" aria-hidden="true">
        <For each={ids()}>{(id) => <i classList={{ on: id === current() }} />}</For>
      </div>
      <div class="toc-list" role="list">
        <For each={orderedPosts()}>
          {(post, i) => {
            const on = () => post.id === current();
            const ago = () => `updated ${relTime(post.updatedAt)}`;
            return (
              <button
                type="button"
                role="listitem"
                class="toc-item"
                classList={{ on: on() }}
                data-id={post.id}
                tabIndex={on() ? 0 : -1}
                aria-current={on() ? "true" : undefined}
                title={`${post.title} · ${ago()}`}
                onClick={() => {
                  setTocOpen(true);
                  jump(post.id);
                }}
              >
                <span class="n">{i() + 1}</span>
                <span class="t">{post.title}</span>
                <Show when={on()}>
                  <span class="ago">{ago()}</span>
                </Show>
              </button>
            );
          }}
        </For>
      </div>
    </nav>
  );
}
