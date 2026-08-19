// Feedback capture — the script that runs INSIDE a sandboxed surface document.
//
// Why it lives here and not in the trusted page: the text a client wants to
// quote is inside an opaque-origin iframe, and the publication page cannot read
// a selection across that boundary. Rather than weaken the sandbox (which is
// what keeps agent-authored markup away from the workspace API), the capture
// runs in the frame and reports through the EXISTING postMessage bridge — the
// same `{__pub: true, type}` convention the parent uses for this channel. The
// marker is deliberately neutral rather than the surface bridge's own
// `__sideshow`: the parent side of it is written into the client-facing page,
// which must not name the product anywhere, not even in an identifier.
// It never touches the network: `connect-src` stays absent for rich surfaces,
// and everything captured here goes to the parent, which does the submitting.
//
// This module is bundled with esbuild into server/feedbackCaptureBundle.ts (see
// scripts/buildFeedbackCapture.ts) and injected ONLY when the surface document
// is served in feedback mode (`?fb=1`, which only the public runtime sets).
//
// Messages out (frame -> parent):
//   feedback-ready      capture is live in this frame
//   feedback-select     a text anchor: quote, prefix/suffix, start/end meta
//   feedback-point      a point anchor: normalized [0,1] surface coordinates
//   feedback-restored   the result of a restore request, per anchor
// Messages in (parent -> frame), accepted only from `parent`:
//   feedback-arm        arm/disarm point mode
//   feedback-clear      drop the pending highlight and selection
//   feedback-restore    re-anchor stored anchors, verifying each quote

import Highlighter from "@plannotator/web-highlighter";
import {
  absoluteOffset,
  indexTextTree,
  type IndexedTextTree,
  type TextTreeElement,
  type TextTreeNode,
  verifyTextAnchor,
} from "../server/anchorText.ts";
import type { TextAnchorMeta } from "../server/publicationTypes.ts";

// Mirrors MAX_FEEDBACK_QUOTE_LENGTH / the prefix+suffix caps in publicApp.ts, so
// the client never composes an anchor the server would truncate underneath it.
const MAX_QUOTE = 2000;
const MAX_CONTEXT = 200;

interface HighlightSourceLike {
  id: string;
  text: string;
  startMeta: TextAnchorMeta;
  endMeta: TextAnchorMeta;
}

const send = (message: Record<string, unknown>): void => {
  parent.postMessage({ __pub: true, ...message }, "*");
};

// The DOM reduced to the tag/text tree anchorText.ts indexes. Only elements and
// text nodes count — exactly the nodes web-highlighter walks when it computes a
// DomMeta, so the offsets here and its offsets are the same numbers.
function domTree(el: Element): TextTreeElement {
  const children: TextTreeNode[] = [];
  const nodes = el.childNodes;
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    if (node.nodeType === 3) children.push((node as Text).data);
    else if (node.nodeType === 1) children.push(domTree(node as Element));
  }
  return { tag: el.tagName, children };
}

const snapshot = (): IndexedTextTree => indexTextTree(domTree(document.body));

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

const STYLE = `
.sideshow-fb-mark{background:rgba(255,206,0,.42);border-radius:2px;box-shadow:0 0 0 1px rgba(180,130,0,.35)}
.sideshow-fb-point{cursor:crosshair!important}
`;

function injectStyle(): void {
  const style = document.createElement("style");
  style.textContent = STYLE;
  document.head.appendChild(style);
}

const highlighter = new Highlighter({
  $root: document.body,
  exceptSelectors: ["script", "style"],
  style: { className: "sideshow-fb-mark" },
}) as unknown as {
  fromRange: (range: Range) => HighlightSourceLike;
  fromStore: (
    start: TextAnchorMeta,
    end: TextAnchorMeta,
    text: string,
    id: string,
  ) => HighlightSourceLike;
  remove: (id: string) => void;
  removeAll: () => void;
};

// Exactly one pending highlight at a time. It is removed again on cancel AND
// after a successful submit, which keeps the DOM byte-identical to the one the
// next selection's DomMeta is computed against — a painted highlight inserts
// wrapper elements and would shift every later anchor's parentIndex.
let pendingId: string | null = null;

function clearPending(): void {
  if (pendingId) {
    try {
      highlighter.remove(pendingId);
    } catch {
      /* already gone */
    }
    pendingId = null;
  }
  const selection = window.getSelection();
  if (selection) selection.removeAllRanges();
}

function captureSelection(): void {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
  const range = selection.getRangeAt(0);
  const quote = String(selection).slice(0, MAX_QUOTE);
  if (!quote.trim()) return;

  // Snapshot BEFORE painting: fromRange wraps the selection in new elements, so
  // the tree the metas were computed against is the one that exists right now.
  const tree = snapshot();
  clearPending();

  let source: HighlightSourceLike | null = null;
  try {
    source = highlighter.fromRange(range);
  } catch {
    source = null;
  }

  const anchor: Record<string, unknown> = { kind: "text", quote };
  if (source) {
    pendingId = source.id;
    // The library's own range text, not the raw selection string: a triple
    // click can pull trailing whitespace into `String(selection)` that the
    // structural range does not cover, and the stored quote has to be exactly
    // what re-anchoring will read back or every restore reports drift.
    // Self-check at capture time: if the library's own metas do not read the
    // quote back out of the pristine tree, send the anchor WITHOUT them rather
    // than hand the owner a structural position that would mis-highlight.
    const verification = verifyTextAnchor(
      {
        quote: source.text.slice(0, MAX_QUOTE),
        startMeta: source.startMeta,
        endMeta: source.endMeta,
      },
      tree,
    );
    if (verification.status === "verified") {
      anchor.quote = source.text.slice(0, MAX_QUOTE);
      anchor.startMeta = source.startMeta;
      anchor.endMeta = source.endMeta;
      const start = absoluteOffset(tree, source.startMeta) ?? 0;
      const end = absoluteOffset(tree, source.endMeta) ?? start;
      anchor.prefix = tree.text.slice(Math.max(0, start - MAX_CONTEXT), start);
      anchor.suffix = tree.text.slice(end, end + MAX_CONTEXT);
    }
    anchor.verified = verification.status === "verified";
  } else {
    anchor.verified = false;
  }
  send({ type: "feedback-select", anchor });
}

// --- point anchors ------------------------------------------------------

let armed = false;

function arm(next: boolean): void {
  armed = next;
  document.documentElement.classList.toggle("sideshow-fb-point", next);
}

function onClick(event: MouseEvent): void {
  if (!armed) return;
  // Capture phase: an html surface's own click handlers must not run while the
  // reader is placing a marker.
  event.preventDefault();
  event.stopPropagation();
  arm(false);
  const width = Math.max(document.documentElement.clientWidth || window.innerWidth || 1, 1);
  const height = Math.max(
    document.body ? document.body.scrollHeight : 0,
    document.documentElement.clientHeight || 0,
    1,
  );
  send({
    type: "feedback-point",
    anchor: {
      kind: "point",
      x: clamp01((event.clientX + window.scrollX) / width),
      y: clamp01((event.clientY + window.scrollY) / height),
    },
  });
}

// --- restore (owner side) ----------------------------------------------

interface RestorableAnchor {
  quote?: unknown;
  startMeta?: TextAnchorMeta;
  endMeta?: TextAnchorMeta;
}

function restore(raw: unknown): void {
  const anchors: RestorableAnchor[] = Array.isArray(raw) ? raw : [];
  highlighter.removeAll();
  pendingId = null;
  // Verify every anchor against the SAME pristine tree before painting any of
  // them; each painted highlight rewrites the DOM the next one would resolve in.
  const tree = snapshot();
  const results = anchors.map((anchor) =>
    verifyTextAnchor(
      {
        quote: typeof anchor.quote === "string" ? anchor.quote : "",
        startMeta: anchor.startMeta,
        endMeta: anchor.endMeta,
      },
      tree,
    ),
  );
  for (let i = 0; i < anchors.length; i++) {
    const anchor = anchors[i]!;
    if (results[i]!.status !== "verified" || !anchor.startMeta || !anchor.endMeta) continue;
    try {
      highlighter.fromStore(
        anchor.startMeta,
        anchor.endMeta,
        String(anchor.quote),
        `restored-${i}`,
      );
    } catch {
      results[i] = { status: "unresolved", found: null };
    }
  }
  send({ type: "feedback-restored", results });
}

// --- wiring -------------------------------------------------------------

injectStyle();
document.addEventListener("mouseup", captureSelection);
document.addEventListener("touchend", captureSelection);
document.addEventListener("keyup", captureSelection);
document.addEventListener("click", onClick, true);

window.addEventListener("message", (event: MessageEvent) => {
  // Only this frame's embedder may drive capture.
  if (event.source !== parent) return;
  const data = event.data as { __pub?: unknown; type?: unknown; mode?: unknown } | null;
  if (!data || data.__pub !== true) return;
  if (data.type === "feedback-arm") arm(data.mode === "point");
  else if (data.type === "feedback-clear") clearPending();
  else if (data.type === "feedback-restore") {
    restore((data as { anchors?: unknown }).anchors);
  }
});

send({ type: "feedback-ready" });
