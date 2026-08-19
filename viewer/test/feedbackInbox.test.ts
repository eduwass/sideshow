import { expect, test } from "vitest";
import {
  anchorLabel,
  anchorPercent,
  type ExternalFeedback,
  FEEDBACK_NO_AUTO_SEND,
  FEEDBACK_STATUSES,
  type FeedbackEntry,
  feedbackAuthor,
  feedbackPath,
  feedbackPromptPath,
  feedbackStatusPath,
  feedbackSurfaceSrc,
} from "../src/api.ts";
import { groupFeedback, linkLabel } from "../src/feedbackInbox.ts";

const feedback = (over: Partial<ExternalFeedback> = {}): ExternalFeedback => ({
  id: "fb-1",
  publicationId: "pub-1",
  shareLinkId: "link-1",
  snapshotId: "snap-1",
  anchor: { kind: "text", itemIndex: 0, surfaceIndex: 0, quote: "a quote" },
  note: "a note",
  name: "Dana",
  email: null,
  status: "unread",
  createdAt: "2026-08-18T10:00:00.000Z",
  ...over,
});

const entry = (over: Partial<FeedbackEntry> = {}): FeedbackEntry => ({
  feedback: feedback(),
  publicationTitle: "Quarterly report",
  publicationId: "pub-1",
  snapshotRevision: 1,
  itemTitle: "Summary",
  surfaceKind: "markdown",
  surfaceUrl: "/api/feedback/s/snap-1/0/0",
  recipientLabel: null,
  ...over,
});

test("the inbox routes are built under the API prefix, with ids escaped", () => {
  expect(feedbackPath()).toBe("/api/feedback");
  expect(feedbackPath("unread")).toBe("/api/feedback?status=unread");
  expect(feedbackStatusPath("a b/c")).toBe("/api/feedback/a%20b%2Fc");
  expect(feedbackPromptPath()).toBe("/api/feedback/prompt");
  expect(FEEDBACK_STATUSES).toEqual(["unread", "read", "resolved", "rejected"]);
});

test("the trust boundary is stated in the UI, not only in a doc", () => {
  expect(FEEDBACK_NO_AUTO_SEND).toMatch(/sent to an agent automatically/);
  expect(FEEDBACK_NO_AUTO_SEND).toMatch(/clipboard/);
});

test("an anchor reads as a quote or as percentages", () => {
  expect(anchorPercent(feedback().anchor)).toBeNull();
  expect(anchorLabel(feedback().anchor)).toBe("Highlighted text");
  const point = feedback({
    anchor: { kind: "point", itemIndex: 0, surfaceIndex: 0, x: 0.256, y: 0.5 },
  });
  expect(anchorPercent(point.anchor)).toEqual({ x: 26, y: 50 });
  expect(anchorLabel(point.anchor)).toBe("Point at 26% across, 50% down");
});

test("an author reads with an email only when one was given", () => {
  expect(feedbackAuthor(feedback())).toBe("Dana");
  expect(feedbackAuthor(feedback({ email: "dana@x.test" }))).toBe("Dana <dana@x.test>");
});

test("the historical surface src carries the current theme and mode", () => {
  expect(feedbackSurfaceSrc(entry(), "gruvbox", "dark")).toBe(
    "/api/feedback/s/snap-1/0/0?theme=gruvbox&mode=dark",
  );
  expect(feedbackSurfaceSrc(entry({ surfaceUrl: "/x?a=1" }), "one", "light")).toBe(
    "/x?a=1&theme=one&mode=light",
  );
});

test("submissions group by publication, then share link, then snapshot, then surface", () => {
  const groups = groupFeedback([
    entry(),
    // same publication, same link, same snapshot, DIFFERENT surface
    entry({
      feedback: feedback({
        id: "fb-2",
        anchor: { kind: "point", itemIndex: 0, surfaceIndex: 1, x: 0, y: 0 },
      }),
      itemTitle: "Summary",
      surfaceKind: "html",
    }),
    // same publication and link, a later revision
    entry({
      feedback: feedback({ id: "fb-3", snapshotId: "snap-2" }),
      snapshotRevision: 2,
    }),
    // same publication, a different share link
    entry({
      feedback: feedback({ id: "fb-4", shareLinkId: "link-2" }),
      recipientLabel: "Acme",
    }),
    // a different publication
    entry({
      feedback: feedback({ id: "fb-5", publicationId: "pub-2", shareLinkId: "link-3" }),
      publicationId: "pub-2",
      publicationTitle: "Another",
    }),
  ]);

  expect(groups.map((g) => g.title)).toEqual(["Quarterly report", "Another"]);
  const first = groups[0]!;
  expect(first.count).toBe(4);
  expect(first.links).toHaveLength(2);
  expect(first.links[0]!.snapshots).toHaveLength(2);
  expect(first.links[0]!.snapshots[0]!.revision).toBe(1);
  // Two surfaces inside revision 1, one comment each.
  expect(first.links[0]!.snapshots[0]!.surfaces.map((s) => s.surfaceKind)).toEqual([
    "markdown",
    "html",
  ]);
  expect(first.links[0]!.snapshots[1]!.revision).toBe(2);
  expect(first.links[1]!.recipientLabel).toBe("Acme");
  expect(groups[1]!.count).toBe(1);
});

test("two comments on the same surface stay in one surface group", () => {
  const groups = groupFeedback([entry(), entry({ feedback: feedback({ id: "fb-2" }) })]);
  const surfaces = groups[0]!.links[0]!.snapshots[0]!.surfaces;
  expect(surfaces).toHaveLength(1);
  expect(surfaces[0]!.entries.map((e) => e.feedback.id)).toEqual(["fb-1", "fb-2"]);
});

test("a link with no recipient label still names itself", () => {
  expect(linkLabel({ key: "k", recipientLabel: null, snapshots: [] })).toBe("Unlabelled link");
  expect(linkLabel({ key: "k", recipientLabel: "Acme", snapshots: [] })).toBe("Link for Acme");
});

test("an untitled publication is grouped under a readable name", () => {
  expect(groupFeedback([entry({ publicationTitle: "" })])[0]!.title).toBe("Untitled");
  expect(groupFeedback([])).toEqual([]);
});
