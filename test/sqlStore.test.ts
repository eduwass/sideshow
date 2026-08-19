import assert from "node:assert/strict";
import { test } from "node:test";
import { createSqliteStorage } from "../server/sqliteStorage.ts";
import { SqlStore } from "../server/sqlStore.ts";
import { htmlSurface, type SqlStorage } from "../server/types.ts";
import { runPublicationStoreContract } from "./publicationStoreContract.ts";
import { runStoreContract } from "./storeContract.ts";

// Runs the shared store contract against SqlStore on node:sqlite (:memory:) —
// the same adapter the local server uses on disk, so the contract exercises the
// real Node SQLite path rather than a bespoke shim.
runStoreContract("SqlStore", () => new SqlStore(createSqliteStorage()));
runPublicationStoreContract("SqlStore", () => new SqlStore(createSqliteStorage()));

const hotPathIndexes = {
  sideshow_assets_session_idx: ["sessionId"],
  sideshow_comments_id_idx: ["id"],
  sideshow_comments_post_seq_idx: ["postId", "seq"],
  sideshow_comments_session_seq_idx: ["sessionId", "seq"],
  sideshow_posts_session_created_at_idx: ["sessionId", "createdAt"],
  sideshow_posts_updated_at_idx: ["updatedAt"],
} as const;

// The publication tables live in the same database behind SqlPublicationStore,
// so their indexes share the `sideshow_` prefix and show up in the same scan.
const publicationIndexes = {
  sideshow_external_feedback_link_idx: ["shareLinkId", "createdAt"],
  sideshow_external_feedback_publication_idx: ["publicationId", "createdAt"],
  sideshow_open_events_at_idx: ["at"],
  sideshow_open_events_link_at_idx: ["shareLinkId", "at"],
  sideshow_share_links_publication_idx: ["publicationId", "createdAt"],
  sideshow_share_links_slug_idx: ["slug"],
  sideshow_snapshot_assets_asset_idx: ["assetId"],
  sideshow_snapshots_publication_idx: ["publicationId", "revision"],
} as const;

const sideshowIndexNames = (storage: SqlStorage) =>
  storage
    .exec(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'sideshow_%' ORDER BY name",
    )
    .toArray()
    .map((row) => row.name);

const indexColumns = (storage: SqlStorage, name: string) =>
  storage
    .exec(`SELECT name FROM pragma_index_info('${name}') ORDER BY seqno`)
    .toArray()
    .map((row) => row.name);

test("SqlStore adds hot-path indexes to existing workspaces idempotently", () => {
  const storage = createSqliteStorage();
  new SqlStore(storage);

  // Model a database created by an older release, before these indexes existed.
  for (const name of Object.keys(hotPathIndexes)) storage.exec(`DROP INDEX ${name}`);

  new SqlStore(storage);
  new SqlStore(storage);

  assert.deepEqual(
    sideshowIndexNames(storage),
    [...Object.keys(hotPathIndexes), ...Object.keys(publicationIndexes)].sort(),
  );
  for (const [name, columns] of Object.entries(hotPathIndexes)) {
    assert.deepEqual(indexColumns(storage, name), columns, `${name} column order`);
  }
});

test("SqlStore migrates the publication schema in place idempotently", async () => {
  const storage = createSqliteStorage();

  // Model a database created by an older release, before publications existed.
  const legacy = new SqlStore(storage);
  const session = await legacy.createSession({ agent: "pi" });
  const post = await legacy.createPost({
    sessionId: session.id,
    title: "Mockup",
    surfaces: [htmlSurface("<p>hi</p>")],
  });
  assert.ok(post);
  for (const name of Object.keys(publicationIndexes)) storage.exec(`DROP INDEX ${name}`);
  for (const table of [
    "external_feedback",
    "open_visitors",
    "open_aggregates",
    "open_events",
    "share_links",
    "snapshot_assets",
    "snapshots",
    "publications",
  ]) {
    storage.exec(`DROP TABLE ${table}`);
  }

  // Re-opening the same storage rebuilds the publication schema, and doing it
  // repeatedly is a no-op — a deployed Durable Object can never be reset.
  const store = new SqlStore(storage);
  const publication = await store.publications.createPublication({ kind: "post", title: "Shared" });
  const snapshot = await store.publications.createSnapshot({
    publicationId: publication.id,
    items: [{ postId: post.id, title: post.title, version: post.version, surfaces: post.surfaces }],
    assetIds: ["asset-1"],
  });
  assert.ok(snapshot);
  new SqlStore(storage);
  new SqlStore(storage);

  assert.deepEqual(
    sideshowIndexNames(storage),
    [...Object.keys(hotPathIndexes), ...Object.keys(publicationIndexes)].sort(),
  );
  for (const [name, columns] of Object.entries(publicationIndexes)) {
    assert.deepEqual(indexColumns(storage, name), columns, `${name} column order`);
  }

  // Nothing was dropped or rewritten by the repeated migrations.
  const reopened = new SqlStore(storage);
  assert.deepEqual(await reopened.publications.getPublication(publication.id), {
    ...publication,
    currentSnapshotId: snapshot.id,
    updatedAt: snapshot.createdAt,
  });
  assert.deepEqual(await reopened.publications.getSnapshot(snapshot.id), snapshot);
  assert.equal(await reopened.publications.isSnapshotAsset("asset-1"), true);
  assert.deepEqual(await reopened.getPost(post.id), post);
  assert.deepEqual(await reopened.listSessions(), [await reopened.getSession(session.id)]);
});

test("SqlStore hot queries use their covering or ordering indexes", () => {
  const storage = createSqliteStorage();
  new SqlStore(storage);

  const assertUsesIndex = (query: string, index: string, ...bindings: (string | number)[]) => {
    const plan = storage
      .exec(`EXPLAIN QUERY PLAN ${query}`, ...bindings)
      .toArray()
      .map((row) => row.detail)
      .join("\n");
    assert.match(plan, new RegExp(`\\b${index}\\b`), `${query}\n${plan}`);
  };

  assertUsesIndex(
    "SELECT * FROM posts WHERE sessionId = ? ORDER BY createdAt ASC",
    "sideshow_posts_session_created_at_idx",
    "session",
  );
  assertUsesIndex(
    "SELECT sessionId, COUNT(*) AS count FROM posts GROUP BY sessionId",
    "sideshow_posts_session_created_at_idx",
  );
  assertUsesIndex(
    "SELECT * FROM posts ORDER BY updatedAt DESC, rowid DESC LIMIT ?",
    "sideshow_posts_updated_at_idx",
    20,
  );
  assertUsesIndex(
    "SELECT * FROM comments WHERE sessionId = ? AND seq > ? ORDER BY seq ASC",
    "sideshow_comments_session_seq_idx",
    "session",
    10,
  );
  assertUsesIndex(
    "SELECT * FROM comments WHERE postId = ? AND seq > ? ORDER BY seq ASC",
    "sideshow_comments_post_seq_idx",
    "post",
    10,
  );
  assertUsesIndex("SELECT * FROM comments WHERE id = ?", "sideshow_comments_id_idx", "comment");
  assertUsesIndex(
    "SELECT * FROM assets WHERE sessionId = ?",
    "sideshow_assets_session_idx",
    "session",
  );
});

test("SqlStore counts posts with one aggregate query and never selects body columns", async () => {
  const storage = createSqliteStorage();
  const queries: string[] = [];
  const tracked: SqlStorage = {
    exec(query, ...bindings) {
      queries.push(query.replace(/\s+/g, " ").trim());
      return storage.exec(query, ...bindings);
    },
  };
  const store = new SqlStore(tracked);
  const session = await store.createSession({ agent: "pi" });
  await store.createPost({ sessionId: session.id, surfaces: [htmlSurface("<p>large</p>")] });

  queries.length = 0;
  const counts = await store.countPostsBySession();

  assert.equal(counts.get(session.id), 1);
  assert.deepEqual(queries, ["SELECT sessionId, COUNT(*) AS count FROM posts GROUP BY sessionId"]);
});
