// The confirmation view's selection rules, kept pure so they can be reasoned
// about (and tested) without a dialog around them.
import type { CollectionPreviewPost } from "./api.ts";

// Why a post is listed but can't be ticked. Short on purpose — it sits inline
// in the row, next to the title.
export const NOT_PUBLISHABLE = "nothing publishable";

// The collection defaults to every current post of the session; a post with no
// publishable surface is listed for review but starts (and stays) unchecked.
export function defaultSelectedPostIds(posts: readonly CollectionPreviewPost[]): string[] {
  return posts.filter((post) => post.publishable).map((post) => post.postId);
}

// The ids to publish, in the session's own order rather than the order the user
// happened to tick them — the confirmation view shows session order, so that is
// what gets sent. An unpublishable post can never leak in, whatever the set says.
export function selectedPostIds(
  posts: readonly CollectionPreviewPost[],
  selected: ReadonlySet<string>,
): string[] {
  return posts
    .filter((post) => post.publishable && selected.has(post.postId))
    .map((post) => post.postId);
}

export function selectionSummary(selected: number, total: number): string {
  return `Publishing ${selected} of ${total} ${total === 1 ? "post" : "posts"}`;
}
