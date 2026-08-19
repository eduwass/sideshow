import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type ExternalAnchor,
  type PublicationStore,
  shareLinkState,
  type SnapshotItem,
} from "../server/publicationTypes.ts";
import { htmlSurface, type Store, type Surface } from "../server/types.ts";

const bytes = (...values: number[]) => new Uint8Array(values);
const NUL = String.fromCharCode(0);

const point = (itemIndex = 0, surfaceIndex = 0): ExternalAnchor => ({
  kind: "point",
  itemIndex,
  surfaceIndex,
  x: 0.5,
  y: 0.5,
});

const item = (surfaces: Surface[], postId = "post-1"): SnapshotItem => ({
  postId,
  title: "Frozen",
  version: 1,
  surfaces,
});

// Reusable contract suite for the optional publication side of a Store.
// makeStore must return a fresh, empty store on each call; a store without
// `publications` cannot host publications at all, so its tests skip rather
// than fail.
export function runPublicationStoreContract(name: string, makeStore: () => Store | Promise<Store>) {
  const contract = (title: string, fn: (pubs: PublicationStore, store: Store) => Promise<void>) =>
    test(`${name}: ${title}`, async (t) => {
      const store = await makeStore();
      if (!store.publications) return t.skip("store has no publication support");
      await fn(store.publications, store);
    });

  // --- publications ---

  contract("creates publications with defaults and round-trips CRUD", async (pubs) => {
    const blank = await pubs.createPublication({ kind: "post", title: "   " });
    assert.equal(blank.kind, "post");
    assert.equal(blank.title, "Untitled");
    assert.equal(blank.identity, null);
    assert.equal(blank.currentSnapshotId, null);
    assert.equal(blank.originSessionId, null);
    assert.equal(blank.originPostId, null);
    assert.equal(blank.updatedAt, blank.createdAt);

    const full = await pubs.createPublication({
      kind: "collection",
      title: "  Q3 review  ",
      originSessionId: "session-1",
      originPostId: "post-1",
      identity: { name: "Edu", linkUrl: "https://example.com" },
    });
    assert.equal(full.kind, "collection");
    assert.equal(full.title, "Q3 review");
    assert.deepEqual(full.identity, { name: "Edu", linkUrl: "https://example.com" });

    assert.deepEqual(await pubs.getPublication(full.id), full);
    assert.equal(await pubs.getPublication("missing"), null);
    assert.deepEqual(
      (await pubs.listPublications()).map((p) => p.id).sort(),
      [blank.id, full.id].sort(),
    );

    const renamed = await pubs.updatePublication(full.id, { title: "  Q4 review  " });
    assert.equal(renamed?.title, "Q4 review");
    // An identity left out of the patch survives; an explicit null clears it.
    assert.deepEqual(renamed?.identity, full.identity);
    assert.deepEqual(await pubs.getPublication(full.id), renamed);
    const cleared = await pubs.updatePublication(full.id, { identity: null });
    assert.equal(cleared?.identity, null);
    assert.equal(cleared?.title, "Q4 review");
    // A blank title keeps the current one rather than resetting to "Untitled".
    assert.equal((await pubs.updatePublication(full.id, { title: "  " }))?.title, "Q4 review");
    assert.equal(await pubs.updatePublication("missing", { title: "x" }), null);

    assert.equal(await pubs.removePublication(full.id), true);
    assert.equal(await pubs.getPublication(full.id), null);
    assert.equal(await pubs.removePublication(full.id), false);
    assert.equal(await pubs.removePublication("missing"), false);
  });

  // --- snapshots ---

  contract("snapshots take monotonic revisions and become the current one", async (pubs) => {
    const publication = await pubs.createPublication({ kind: "post", title: "Design" });
    const first = await pubs.createSnapshot({
      publicationId: publication.id,
      items: [item([htmlSurface("<p>one</p>")])],
    });
    assert.ok(first);
    assert.equal(first.revision, 1);
    // No explicit title: the snapshot inherits the publication's.
    assert.equal(first.title, "Design");
    let current = await pubs.getPublication(publication.id);
    assert.equal(current?.currentSnapshotId, first.id);
    assert.equal(current?.title, "Design");

    const second = await pubs.createSnapshot({
      publicationId: publication.id,
      title: "  Design v2  ",
      items: [item([htmlSurface("<p>two</p>")])],
    });
    assert.ok(second);
    assert.equal(second.revision, 2);
    assert.equal(second.title, "Design v2");
    current = await pubs.getPublication(publication.id);
    assert.equal(current?.currentSnapshotId, second.id);
    // A titled snapshot renames the publication it belongs to.
    assert.equal(current?.title, "Design v2");

    // Immutability: the earlier revision reads back byte-identical.
    assert.deepEqual(await pubs.getSnapshot(first.id), first);
    assert.deepEqual(await pubs.getSnapshot(second.id), second);
    assert.equal(await pubs.getSnapshot("missing"), null);

    // Newest revision first.
    assert.deepEqual(
      (await pubs.listSnapshots(publication.id)).map((s) => s.revision),
      [2, 1],
    );
    assert.deepEqual(await pubs.listSnapshots("missing"), []);
    assert.equal(await pubs.createSnapshot({ publicationId: "missing", items: [] }), null);
  });

  contract("snapshots pin the asset ids their surfaces reference", async (pubs) => {
    const publication = await pubs.createPublication({ kind: "collection", title: "Pinned" });
    const snapshot = await pubs.createSnapshot({
      publicationId: publication.id,
      items: [
        item([
          { kind: "image", assetId: "asset-image" },
          { kind: "trace", assetId: "asset-trace", steps: [{ label: "step" }] },
          htmlSurface("<p>no asset</p>"),
        ]),
        item([{ kind: "image", assetId: "asset-image" }], "post-2"),
      ],
      // Explicit pins are merged with what the surfaces themselves reference.
      assetIds: ["asset-explicit", "asset-image"],
    });
    assert.ok(snapshot);
    assert.deepEqual(snapshot.assetIds, ["asset-explicit", "asset-image", "asset-trace"]);
    assert.deepEqual((await pubs.getSnapshot(snapshot.id))?.assetIds, snapshot.assetIds);

    for (const id of snapshot.assetIds) assert.equal(await pubs.isSnapshotAsset(id), true);
    assert.equal(await pubs.isSnapshotAsset("asset-unknown"), false);
  });

  contract(
    "a snapshot keeps its asset referenced after post history rolls",
    async (pubs, store) => {
      const session = await store.createSession({ agent: "pi" });
      const pinned = await store.putAsset({
        sessionId: session.id,
        kind: "image",
        contentType: "image/png",
        data: bytes(1, 2, 3),
      });
      const loose = await store.putAsset({
        sessionId: session.id,
        kind: "image",
        contentType: "image/png",
        data: bytes(4, 5, 6),
      });
      assert.ok(pinned);
      assert.ok(loose);
      const post = await store.createPost({
        sessionId: session.id,
        title: "Mockup",
        surfaces: [
          { kind: "image", assetId: pinned.id },
          { kind: "image", assetId: loose.id },
        ],
      });
      assert.ok(post);

      const publication = await pubs.createPublication({
        kind: "post",
        title: "Mockup",
        originSessionId: session.id,
        originPostId: post.id,
      });
      const snapshot = await pubs.createSnapshot({
        publicationId: publication.id,
        items: [item([{ kind: "image", assetId: pinned.id }], post.id)],
      });
      assert.ok(snapshot);
      assert.deepEqual(snapshot.assetIds, [pinned.id]);

      // Push both images out of the rolling history (HISTORY_LIMIT is 20).
      for (let i = 0; i < 25; i++) {
        assert.ok(await store.updatePost(post.id, { surfaces: [htmlSurface(`<p>${i}</p>`)] }));
      }
      await store.removePost(post.id);

      // The pinned asset survives because the immutable snapshot still points at
      // it; the unpinned one is now collectable.
      assert.equal(await store.isAssetReferenced(pinned.id), true);
      assert.equal(await store.isAssetReferenced(loose.id), false);
    },
  );

  // --- share links ---

  contract("generates unguessable slugs and rejects duplicates", async (pubs) => {
    const publication = await pubs.createPublication({ kind: "post", title: "Share" });

    const slugs = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const link = await pubs.createShareLink({ publicationId: publication.id });
      assert.ok(link);
      assert.equal(link.custom, false);
      // 128 bits of entropy, url-safe base64, unpadded.
      assert.ok(link.slug.length >= 20, `slug too short: ${link.slug}`);
      assert.match(link.slug, /^[A-Za-z0-9_-]+$/);
      slugs.add(link.slug);
    }
    assert.equal(slugs.size, 50, "generated slugs must all be distinct");

    const custom = await pubs.createShareLink({
      publicationId: publication.id,
      slug: "q3-review",
      custom: true,
      recipientLabel: "  Acme  ",
    });
    assert.ok(custom);
    assert.equal(custom.slug, "q3-review");
    assert.equal(custom.custom, true);
    assert.equal(custom.recipientLabel, "  Acme  ");
    assert.equal(custom.passwordHash, null);
    assert.equal(custom.expiresAt, null);
    assert.equal(custom.revokedAt, null);
    // Opens are tracked unless the owner explicitly opts out.
    assert.equal(custom.trackOpens, true);
    assert.equal(
      (await pubs.createShareLink({ publicationId: publication.id, trackOpens: false }))
        ?.trackOpens,
      false,
    );

    assert.equal(
      await pubs.createShareLink({ publicationId: publication.id, slug: "q3-review" }),
      null,
      "a duplicate slug must be rejected",
    );
    assert.equal(await pubs.createShareLink({ publicationId: "missing" }), null);

    assert.deepEqual(await pubs.getShareLink(custom.id), custom);
    assert.deepEqual(await pubs.getShareLinkBySlug("q3-review"), custom);
    assert.equal(await pubs.getShareLink("missing"), null);
    assert.equal(await pubs.getShareLinkBySlug("missing"), null);

    const other = await pubs.createPublication({ kind: "post", title: "Other" });
    const otherLink = await pubs.createShareLink({ publicationId: other.id });
    assert.ok(otherLink);
    assert.deepEqual(
      (await pubs.listShareLinks(other.id)).map((l) => l.id),
      [otherLink.id],
    );
    assert.equal((await pubs.listShareLinks(publication.id)).length, 52);
    assert.equal((await pubs.listShareLinks()).length, 53);
  });

  contract("updates and removes share links, cascading their analytics", async (pubs) => {
    const publication = await pubs.createPublication({ kind: "post", title: "Share" });
    const link = await pubs.createShareLink({ publicationId: publication.id });
    assert.ok(link);

    const updated = await pubs.updateShareLink(link.id, {
      recipientLabel: "Acme Corp",
      passwordHash: "scrypt$abc",
      expiresAt: "2999-01-01T00:00:00.000Z",
      trackOpens: false,
    });
    assert.ok(updated);
    assert.equal(updated.recipientLabel, "Acme Corp");
    assert.equal(updated.passwordHash, "scrypt$abc");
    assert.equal(updated.expiresAt, "2999-01-01T00:00:00.000Z");
    assert.equal(updated.trackOpens, false);
    assert.equal(updated.revokedAt, null);
    assert.equal(updated.slug, link.slug);
    assert.deepEqual(await pubs.getShareLink(link.id), updated);

    const revoked = await pubs.updateShareLink(link.id, { revokedAt: "2026-01-01T00:00:00.000Z" });
    assert.equal(revoked?.revokedAt, "2026-01-01T00:00:00.000Z");
    // Untouched fields survive a partial patch.
    assert.equal(revoked?.passwordHash, "scrypt$abc");
    assert.equal(await pubs.updateShareLink("missing", { trackOpens: true }), null);

    const snapshot = await pubs.createSnapshot({
      publicationId: publication.id,
      items: [item([htmlSurface("<p>hi</p>")])],
    });
    assert.ok(snapshot);
    assert.ok(
      await pubs.recordOpen({
        shareLinkId: link.id,
        snapshotId: snapshot.id,
        visitorHash: "v1",
      }),
    );
    assert.ok(
      await pubs.createFeedback({
        publicationId: publication.id,
        shareLinkId: link.id,
        snapshotId: snapshot.id,
        anchor: point(),
        note: "typo",
        name: "Ada",
      }),
    );

    assert.equal(await pubs.removeShareLink(link.id), true);
    assert.equal(await pubs.getShareLink(link.id), null);
    assert.equal(await pubs.removeShareLink(link.id), false);
    assert.deepEqual(await pubs.listOpenEvents(link.id), []);
    assert.deepEqual(await pubs.getOpenAggregate(link.id), {
      shareLinkId: link.id,
      firstOpenAt: null,
      lastOpenAt: null,
      totalOpens: 0,
      uniqueVisitors: 0,
    });
    assert.deepEqual(await pubs.listFeedback({ shareLinkId: link.id }), []);
  });

  contract("shareLinkState reports active, revoked and expired", async () => {
    const now = Date.parse("2026-06-01T00:00:00.000Z");
    assert.equal(shareLinkState({ revokedAt: null, expiresAt: null }, now), "active");
    assert.equal(
      shareLinkState({ revokedAt: null, expiresAt: "2026-06-02T00:00:00.000Z" }, now),
      "active",
    );
    assert.equal(
      shareLinkState({ revokedAt: "2026-05-01T00:00:00.000Z", expiresAt: null }, now),
      "revoked",
    );
    // Revocation wins over an otherwise-valid expiry.
    assert.equal(
      shareLinkState(
        { revokedAt: "2026-05-01T00:00:00.000Z", expiresAt: "2999-01-01T00:00:00.000Z" },
        now,
      ),
      "revoked",
    );
    assert.equal(
      shareLinkState({ revokedAt: null, expiresAt: "2026-05-31T23:59:59.000Z" }, now),
      "expired",
    );
    // Fails closed rather than treating an unparseable expiry as no expiry.
    assert.equal(shareLinkState({ revokedAt: null, expiresAt: "not-a-date" }, now), "expired");
  });

  // --- confirmed opens ---

  contract("records opens into events, aggregates and unique visitors", async (pubs) => {
    const publication = await pubs.createPublication({ kind: "post", title: "Opens" });
    const link = await pubs.createShareLink({ publicationId: publication.id });
    assert.ok(link);
    const snapshot = await pubs.createSnapshot({
      publicationId: publication.id,
      items: [item([htmlSurface("<p>hi</p>")])],
    });
    assert.ok(snapshot);

    // A link with no opens reports zeroes, not a missing row.
    assert.deepEqual(await pubs.getOpenAggregate(link.id), {
      shareLinkId: link.id,
      firstOpenAt: null,
      lastOpenAt: null,
      totalOpens: 0,
      uniqueVisitors: 0,
    });
    assert.equal(
      await pubs.recordOpen({ shareLinkId: "missing", snapshotId: snapshot.id, visitorHash: "v1" }),
      null,
    );

    const open = (visitorHash: string, country: string | null) =>
      pubs.recordOpen({
        shareLinkId: link.id,
        snapshotId: snapshot.id,
        visitorHash,
        deviceClass: "desktop",
        country,
      });
    const first = await open("v1", "ES");
    const second = await open("v1", "ES");
    const third = await open("v2", null);
    assert.ok(first && second && third);
    assert.equal(first.deviceClass, "desktop");
    assert.equal(first.country, "ES");
    assert.equal(third.country, null);

    assert.deepEqual(await pubs.getOpenAggregate(link.id), {
      shareLinkId: link.id,
      firstOpenAt: first.at,
      lastOpenAt: third.at,
      totalOpens: 3,
      uniqueVisitors: 2,
    });

    // Newest first, with insertion order breaking equal-millisecond ties.
    const events = await pubs.listOpenEvents(link.id);
    assert.deepEqual(
      events.map((e) => e.id),
      [third.id, second.id, first.id],
    );
    assert.deepEqual(await pubs.listOpenEvents(link.id, 2), events.slice(0, 2));
    assert.deepEqual(await pubs.listOpenEvents("missing"), []);
  });

  contract("prunes detailed open events while aggregates persist", async (pubs) => {
    const publication = await pubs.createPublication({ kind: "post", title: "Retention" });
    const link = await pubs.createShareLink({ publicationId: publication.id });
    assert.ok(link);
    const snapshot = await pubs.createSnapshot({
      publicationId: publication.id,
      items: [item([htmlSurface("<p>hi</p>")])],
    });
    assert.ok(snapshot);
    for (const visitorHash of ["v1", "v1", "v2"]) {
      assert.ok(
        await pubs.recordOpen({ shareLinkId: link.id, snapshotId: snapshot.id, visitorHash }),
      );
    }
    const before = await pubs.getOpenAggregate(link.id);
    assert.equal(before.totalOpens, 3);

    // A cutoff before every event deletes nothing.
    assert.equal(await pubs.pruneOpenEvents("2000-01-01T00:00:00.000Z"), 0);
    assert.equal((await pubs.listOpenEvents(link.id)).length, 3);

    assert.equal(await pubs.pruneOpenEvents("2999-01-01T00:00:00.000Z"), 3);
    assert.deepEqual(await pubs.listOpenEvents(link.id), []);
    // The durable record is unchanged: aggregates outlive the events.
    assert.deepEqual(await pubs.getOpenAggregate(link.id), before);
  });

  // --- external feedback ---

  // docs/adr/0003: a share-link holder must never be able to speak into the
  // trusted comment→agent stream.
  contract("external feedback never touches comments or agentSeq", async (pubs, store) => {
    const session = await store.createSession({ agent: "pi" });
    const post = await store.createPost({
      sessionId: session.id,
      surfaces: [htmlSurface("<p>hi</p>")],
    });
    assert.ok(post);
    const comment = await store.createComment({
      sessionId: session.id,
      postId: post.id,
      author: "user",
      text: "real comment",
    });
    assert.ok(comment);
    await store.markAgentSeen(session.id, comment.seq);

    const publication = await pubs.createPublication({
      kind: "post",
      title: "Shared",
      originSessionId: session.id,
      originPostId: post.id,
    });
    const link = await pubs.createShareLink({ publicationId: publication.id });
    assert.ok(link);
    const snapshot = await pubs.createSnapshot({
      publicationId: publication.id,
      items: [item(post.surfaces, post.id)],
    });
    assert.ok(snapshot);

    const commentsBefore = await store.listComments({});
    const agentSeqBefore = (await store.getSession(session.id))?.agentSeq;
    assert.equal(agentSeqBefore, comment.seq);

    const feedback = await pubs.createFeedback({
      publicationId: publication.id,
      shareLinkId: link.id,
      snapshotId: snapshot.id,
      anchor: point(),
      note: "the chart axis is off",
      name: "Ada",
      email: "ada@example.com",
    });
    assert.ok(feedback);
    assert.equal(feedback.status, "unread");
    assert.equal(feedback.email, "ada@example.com");
    assert.deepEqual(await pubs.getFeedback(feedback.id), feedback);
    assert.equal(await pubs.getFeedback("missing"), null);

    // The trusted stream is untouched: no comment row, no seq consumed, no
    // cursor movement.
    assert.deepEqual(await store.listComments({}), commentsBefore);
    assert.equal((await store.getSession(session.id))?.agentSeq, agentSeqBefore);
    const next = await store.createComment({
      sessionId: session.id,
      author: "user",
      text: "still sequential",
    });
    assert.equal(next?.seq, comment.seq + 1);

    // A link belonging to another publication cannot post feedback here.
    const other = await pubs.createPublication({ kind: "post", title: "Other" });
    const otherLink = await pubs.createShareLink({ publicationId: other.id });
    assert.ok(otherLink);
    assert.equal(
      await pubs.createFeedback({
        publicationId: publication.id,
        shareLinkId: otherLink.id,
        snapshotId: snapshot.id,
        anchor: point(),
        note: "nope",
        name: "Mallory",
      }),
      null,
    );
    assert.equal(
      await pubs.createFeedback({
        publicationId: publication.id,
        shareLinkId: "missing",
        snapshotId: snapshot.id,
        anchor: point(),
        note: "nope",
        name: "Mallory",
      }),
      null,
    );
    assert.equal(
      await pubs.createFeedback({
        publicationId: publication.id,
        shareLinkId: link.id,
        snapshotId: "missing",
        anchor: point(),
        note: "nope",
        name: "Mallory",
      }),
      null,
    );
  });

  contract("filters feedback and transitions its status", async (pubs) => {
    const one = await pubs.createPublication({ kind: "post", title: "One" });
    const two = await pubs.createPublication({ kind: "post", title: "Two" });
    const linkOne = await pubs.createShareLink({ publicationId: one.id });
    const linkOneAlt = await pubs.createShareLink({ publicationId: one.id });
    const linkTwo = await pubs.createShareLink({ publicationId: two.id });
    assert.ok(linkOne && linkOneAlt && linkTwo);
    const snapOne = await pubs.createSnapshot({
      publicationId: one.id,
      items: [item([htmlSurface("<p>1</p>")])],
    });
    const snapOneV2 = await pubs.createSnapshot({
      publicationId: one.id,
      items: [item([htmlSurface("<p>1b</p>")])],
    });
    const snapTwo = await pubs.createSnapshot({
      publicationId: two.id,
      items: [item([htmlSurface("<p>2</p>")])],
    });
    assert.ok(snapOne && snapOneV2 && snapTwo);

    const add = async (
      publicationId: string,
      shareLinkId: string,
      snapshotId: string,
      note: string,
    ) => {
      const created = await pubs.createFeedback({
        publicationId,
        shareLinkId,
        snapshotId,
        anchor: point(),
        note,
        name: "Ada",
      });
      assert.ok(created);
      return created;
    };
    const a = await add(one.id, linkOne.id, snapOne.id, "a");
    const b = await add(one.id, linkOneAlt.id, snapOneV2.id, "b");
    const c = await add(two.id, linkTwo.id, snapTwo.id, "c");

    const ids = (list: { id: string }[]) => list.map((f) => f.id);
    // Oldest first, with insertion order breaking equal-millisecond ties.
    assert.deepEqual(ids(await pubs.listFeedback({})), [a.id, b.id, c.id]);
    assert.deepEqual(ids(await pubs.listFeedback({ publicationId: one.id })), [a.id, b.id]);
    assert.deepEqual(ids(await pubs.listFeedback({ shareLinkId: linkOneAlt.id })), [b.id]);
    assert.deepEqual(ids(await pubs.listFeedback({ snapshotId: snapOne.id })), [a.id]);
    assert.deepEqual(ids(await pubs.listFeedback({ status: "unread" })), [a.id, b.id, c.id]);
    assert.deepEqual(
      ids(await pubs.listFeedback({ publicationId: one.id, snapshotId: snapTwo.id })),
      [],
    );

    for (const status of ["read", "resolved", "rejected"] as const) {
      const moved = await pubs.setFeedbackStatus(a.id, status);
      assert.equal(moved?.status, status);
      assert.equal((await pubs.getFeedback(a.id))?.status, status);
    }
    assert.deepEqual(ids(await pubs.listFeedback({ status: "rejected" })), [a.id]);
    assert.deepEqual(ids(await pubs.listFeedback({ publicationId: one.id, status: "unread" })), [
      b.id,
    ]);
    assert.equal(await pubs.setFeedbackStatus("missing", "read"), null);
  });

  // --- NUL parity ---

  // SQLite truncates TEXT at an embedded NUL while a JSON file preserves it, so
  // publication text is stripped the same way the private store strips it.
  contract("strips embedded NUL from stored publication text", async (pubs) => {
    const publication = await pubs.createPublication({
      kind: "post",
      title: `keep${NUL}drop`,
    });
    assert.equal(publication.title, "keepdrop");
    assert.equal((await pubs.getPublication(publication.id))?.title, "keepdrop");
    assert.equal(
      (await pubs.updatePublication(publication.id, { title: `re${NUL}named` }))?.title,
      "renamed",
    );

    const link = await pubs.createShareLink({
      publicationId: publication.id,
      recipientLabel: `Ac${NUL}me`,
    });
    assert.ok(link);
    assert.equal(link.recipientLabel, "Acme");
    assert.equal((await pubs.getShareLink(link.id))?.recipientLabel, "Acme");
    assert.equal(
      (await pubs.updateShareLink(link.id, { recipientLabel: `Bo${NUL}lt` }))?.recipientLabel,
      "Bolt",
    );

    const snapshot = await pubs.createSnapshot({
      publicationId: publication.id,
      title: `Snap${NUL}shot`,
      items: [item([htmlSurface("<p>hi</p>")])],
    });
    assert.ok(snapshot);
    assert.equal(snapshot.title, "Snapshot");
    assert.equal((await pubs.getSnapshot(snapshot.id))?.title, "Snapshot");

    const feedback = await pubs.createFeedback({
      publicationId: publication.id,
      shareLinkId: link.id,
      snapshotId: snapshot.id,
      anchor: point(),
      note: `no${NUL}te`,
      name: `Ad${NUL}a`,
      email: `a${NUL}@example.com`,
    });
    assert.ok(feedback);
    assert.equal(feedback.note, "note");
    assert.equal(feedback.name, "Ada");
    assert.equal(feedback.email, "a@example.com");
    const stored = await pubs.getFeedback(feedback.id);
    assert.equal(stored?.note, "note");
    assert.equal(stored?.name, "Ada");
  });
}
