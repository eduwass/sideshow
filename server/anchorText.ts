// Structural text anchoring — runtime-agnostic, no DOM and no `node:` imports,
// so the same code runs on the Durable Object, in Node tests, and (bundled by
// scripts/buildFeedbackCapture.ts) inside a sandboxed surface document.
//
// A text anchor from @plannotator/web-highlighter is a pair of DomMeta:
// `{parentTagName, parentIndex, textOffset}`, where `parentIndex` is the
// element's index among `root.getElementsByTagName(tagName)` and `textOffset`
// is the character offset inside that element's own text. Restoring an anchor
// therefore means walking the document in the same order and reading the text
// back out.
//
// The quote is the ORACLE, not decoration: a structural position can still
// resolve after the surface changed, and would then highlight the wrong words.
// So re-anchoring always compares the text found at the structural position
// against the stored quote and reports `verified` / `drifted` / `unresolved`
// instead of painting whatever it landed on.

import type { TextAnchorMeta } from "./publicationTypes.ts";

// A document reduced to what anchoring needs: element tags in document order
// and the text between them. Built from a real DOM inside the surface iframe,
// and from plain literals in tests.
export interface TextTreeElement {
  tag: string;
  children: TextTreeNode[];
}

export type TextTreeNode = string | TextTreeElement;

// web-highlighter's sentinel for "the parent IS the root element" (ROOT_IDX),
// and for "this element is not under the root" (UNKNOWN_IDX).
export const ROOT_PARENT_INDEX = -2;
export const UNKNOWN_PARENT_INDEX = -1;

// The root's full text plus, for every descendant element, the offset at which
// its own text begins. `parentIndex` counts per tag name, exactly as
// getElementsByTagName does, and the root itself is not counted.
export interface IndexedTextTree {
  text: string;
  starts: Map<string, number>;
}

const startKey = (tagName: string, index: number) => `${tagName.toUpperCase()}#${index}`;

export function indexTextTree(root: TextTreeElement): IndexedTextTree {
  let text = "";
  const starts = new Map<string, number>();
  const counts = new Map<string, number>();
  const walk = (nodes: TextTreeNode[]): void => {
    for (const node of nodes) {
      if (typeof node === "string") {
        text += node;
        continue;
      }
      const tag = node.tag.toUpperCase();
      const index = counts.get(tag) ?? 0;
      counts.set(tag, index + 1);
      starts.set(startKey(tag, index), text.length);
      walk(node.children);
    }
  };
  walk(root.children);
  return { text, starts };
}

// Absolute offset of one DomMeta in the root's text, or null when the element
// it names no longer exists.
export function absoluteOffset(tree: IndexedTextTree, meta: TextAnchorMeta): number | null {
  if (!Number.isInteger(meta.textOffset) || meta.textOffset < 0) return null;
  if (meta.parentIndex === ROOT_PARENT_INDEX) return meta.textOffset;
  if (meta.parentIndex < 0) return null;
  const start = tree.starts.get(startKey(meta.parentTagName, meta.parentIndex));
  return start === undefined ? null : start + meta.textOffset;
}

/** The text currently sitting at an anchor's structural position, if it resolves. */
export function resolveAnchorText(
  tree: IndexedTextTree,
  startMeta: TextAnchorMeta,
  endMeta: TextAnchorMeta,
): string | null {
  const start = absoluteOffset(tree, startMeta);
  const end = absoluteOffset(tree, endMeta);
  if (start === null || end === null) return null;
  if (end < start || end > tree.text.length) return null;
  return tree.text.slice(start, end);
}

export type AnchorVerificationStatus = "verified" | "drifted" | "unresolved";

export interface AnchorVerification {
  status: AnchorVerificationStatus;
  /** What is actually there now — null when the position no longer exists. */
  found: string | null;
}

/**
 * Quote verification. `verified` means the structural position still holds the
 * exact stored quote and may be highlighted; `drifted` means it resolves but
 * the text changed; `unresolved` means the position is gone (or was never
 * recorded). Only `verified` may paint.
 */
export function verifyTextAnchor(
  anchor: { quote: string; startMeta?: TextAnchorMeta; endMeta?: TextAnchorMeta },
  tree: IndexedTextTree,
): AnchorVerification {
  if (!anchor.startMeta || !anchor.endMeta) return { status: "unresolved", found: null };
  const found = resolveAnchorText(tree, anchor.startMeta, anchor.endMeta);
  if (found === null) return { status: "unresolved", found: null };
  return { status: found === anchor.quote ? "verified" : "drifted", found };
}
