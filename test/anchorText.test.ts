import assert from "node:assert/strict";
import { test } from "node:test";
import {
  absoluteOffset,
  indexTextTree,
  resolveAnchorText,
  ROOT_PARENT_INDEX,
  type TextTreeElement,
  UNKNOWN_PARENT_INDEX,
  verifyTextAnchor,
} from "../server/anchorText.ts";

// The tree a surface document reduces to: element tags in document order and
// the text between them. Inside the sandboxed frame it is built from the real
// DOM; here it is written out by hand.
const el = (tag: string, ...children: (string | TextTreeElement)[]): TextTreeElement => ({
  tag,
  children,
});

const meta = (parentTagName: string, parentIndex: number, textOffset: number) => ({
  parentTagName,
  parentIndex,
  textOffset,
});

// <body><h1>Revenue</h1><p>Growth was strong.</p><p>Growth was strong.</p></body>
const DOC = el(
  "BODY",
  el("H1", "Revenue"),
  el("P", "Growth was strong."),
  el("P", "Growth was strong."),
);

test("indexing counts each tag separately and never counts the root itself", () => {
  const tree = indexTextTree(DOC);
  assert.equal(tree.text, "RevenueGrowth was strong.Growth was strong.");
  assert.equal(tree.starts.get("H1#0"), 0);
  assert.equal(tree.starts.get("P#0"), 7);
  assert.equal(tree.starts.get("P#1"), 25);
  assert.equal(tree.starts.has("BODY#0"), false);
});

test("nested elements keep document order, and tag names are matched case-insensitively", () => {
  const tree = indexTextTree(el("body", el("div", "a", el("em", "b"), "c"), el("div", "d")));
  assert.equal(tree.text, "abcd");
  assert.equal(tree.starts.get("DIV#0"), 0);
  assert.equal(tree.starts.get("EM#0"), 1);
  assert.equal(tree.starts.get("DIV#1"), 3);
  assert.equal(absoluteOffset(tree, meta("div", 1, 1)), 4);
});

test("a quote that has not moved verifies; a changed one is reported as drifted", () => {
  const tree = indexTextTree(DOC);
  const anchor = {
    quote: "was strong",
    startMeta: meta("P", 0, 7),
    endMeta: meta("P", 0, 17),
  };
  assert.deepEqual(verifyTextAnchor(anchor, tree), { status: "verified", found: "was strong" });

  // The surface was republished with different words at the same position.
  const edited = indexTextTree(
    el("BODY", el("H1", "Revenue"), el("P", "Growth was weak now."), el("P", "Growth was strong.")),
  );
  const drifted = verifyTextAnchor(anchor, edited);
  assert.equal(drifted.status, "drifted");
  // The mismatch is EXPOSED rather than highlighted: the caller sees what is
  // there now instead of a marker painted over the wrong words.
  assert.equal(drifted.found, "was weak n");
});

test("two identical quotes in one surface are distinguishable by structural position", () => {
  const tree = indexTextTree(DOC);
  const first = {
    quote: "Growth was strong.",
    startMeta: meta("P", 0, 0),
    endMeta: meta("P", 0, 18),
  };
  const second = {
    quote: "Growth was strong.",
    startMeta: meta("P", 1, 0),
    endMeta: meta("P", 1, 18),
  };
  assert.equal(verifyTextAnchor(first, tree).status, "verified");
  assert.equal(verifyTextAnchor(second, tree).status, "verified");
  // Same text, different anchors — the second is not silently the first.
  assert.notDeepEqual(first.startMeta, second.startMeta);
  assert.equal(absoluteOffset(tree, first.startMeta), 7);
  assert.equal(absoluteOffset(tree, second.startMeta), 25);
});

test("an anchor whose element is gone is unresolved, never guessed at", () => {
  const tree = indexTextTree(DOC);
  const gone = { quote: "anything", startMeta: meta("P", 9, 0), endMeta: meta("P", 9, 4) };
  assert.deepEqual(verifyTextAnchor(gone, tree), { status: "unresolved", found: null });
  // web-highlighter's "not under the root" sentinel resolves to nothing too.
  assert.equal(absoluteOffset(tree, meta("P", UNKNOWN_PARENT_INDEX, 0)), null);
  // ...while its "the parent IS the root" sentinel is a plain root-relative offset.
  assert.equal(absoluteOffset(tree, meta("BODY", ROOT_PARENT_INDEX, 7)), 7);
});

test("an anchor with no structural metadata is unresolved, not verified by its quote alone", () => {
  const tree = indexTextTree(DOC);
  assert.deepEqual(verifyTextAnchor({ quote: "Revenue" }, tree), {
    status: "unresolved",
    found: null,
  });
  assert.deepEqual(verifyTextAnchor({ quote: "Revenue", startMeta: meta("H1", 0, 0) }, tree), {
    status: "unresolved",
    found: null,
  });
});

test("nonsense offsets resolve to nothing rather than throwing or wrapping around", () => {
  const tree = indexTextTree(DOC);
  assert.equal(
    resolveAnchorText(tree, meta("P", 0, 10), meta("P", 0, 2)),
    null,
    "end before start",
  );
  assert.equal(resolveAnchorText(tree, meta("H1", 0, 0), meta("P", 1, 999)), null, "past the end");
  assert.equal(absoluteOffset(tree, meta("P", 0, -1)), null, "negative offset");
  assert.equal(absoluteOffset(tree, meta("P", 0, 1.5)), null, "fractional offset");
});

test("a text anchor can span elements", () => {
  const tree = indexTextTree(DOC);
  assert.equal(
    resolveAnchorText(tree, meta("H1", 0, 3), meta("P", 0, 6)),
    "enueGrowth",
    "from inside the heading into the first paragraph",
  );
});
