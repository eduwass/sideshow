import {
  collectSnapshotAssetIds,
  type CreateFeedbackInput,
  type CreatePublicationInput,
  type CreateShareLinkInput,
  type CreateSnapshotInput,
  type ExternalAnchor,
  type ExternalFeedback,
  type FeedbackQuery,
  type FeedbackStatus,
  type IdentityHeader,
  newShareToken,
  type OpenAggregate,
  type OpenEvent,
  type Publication,
  type PublicationStore,
  type RecordOpenInput,
  type ShareLink,
  type Snapshot,
  type SnapshotItem,
  type UpdatePublicationInput,
  type UpdateShareLinkInput,
} from "./publicationTypes.ts";
import { newId, type SqlStorage, type SqlStorageValue, stripNul } from "./types.ts";

// Publication storage on SQLite — the same class runs on a Durable Object's
// `ctx.storage.sql` and on Node via server/sqliteStorage.ts, so the private and
// public deployments share one implementation and one contract suite.
//
// Every statement here is plain SQL with no tenant columns: one workspace is one
// database. Schema creation is `IF NOT EXISTS` throughout, which is what makes
// it a safe in-place migration for a deployed Durable Object (which can never be
// reset). Future column additions must follow the `pragma_table_info` probe
// pattern used in SqlStore's constructor.
export class SqlPublicationStore implements PublicationStore {
  private sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.sql = sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS publications (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL,
        originSessionId TEXT, originPostId TEXT, currentSnapshotId TEXT,
        identity TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS snapshots (
        id TEXT PRIMARY KEY, publicationId TEXT NOT NULL, revision INTEGER NOT NULL,
        title TEXT NOT NULL, items TEXT NOT NULL, createdAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS snapshot_assets (
        snapshotId TEXT NOT NULL, assetId TEXT NOT NULL,
        PRIMARY KEY (snapshotId, assetId)
      );
      CREATE TABLE IF NOT EXISTS share_links (
        id TEXT PRIMARY KEY, publicationId TEXT NOT NULL, slug TEXT NOT NULL,
        custom INTEGER NOT NULL DEFAULT 0, recipientLabel TEXT, passwordHash TEXT,
        expiresAt TEXT, revokedAt TEXT, trackOpens INTEGER NOT NULL DEFAULT 1,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS open_events (
        id TEXT PRIMARY KEY, shareLinkId TEXT NOT NULL, snapshotId TEXT NOT NULL,
        visitorHash TEXT NOT NULL, deviceClass TEXT, country TEXT, at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS open_aggregates (
        shareLinkId TEXT PRIMARY KEY, firstOpenAt TEXT, lastOpenAt TEXT,
        totalOpens INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS open_visitors (
        shareLinkId TEXT NOT NULL, visitorHash TEXT NOT NULL, firstAt TEXT NOT NULL,
        PRIMARY KEY (shareLinkId, visitorHash)
      );
      CREATE TABLE IF NOT EXISTS external_feedback (
        id TEXT PRIMARY KEY, publicationId TEXT NOT NULL, shareLinkId TEXT NOT NULL,
        snapshotId TEXT NOT NULL, anchor TEXT NOT NULL, note TEXT NOT NULL,
        name TEXT NOT NULL, email TEXT, status TEXT NOT NULL, createdAt TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS sideshow_share_links_slug_idx
        ON share_links (slug);
      CREATE INDEX IF NOT EXISTS sideshow_share_links_publication_idx
        ON share_links (publicationId, createdAt);
      CREATE INDEX IF NOT EXISTS sideshow_snapshots_publication_idx
        ON snapshots (publicationId, revision);
      CREATE INDEX IF NOT EXISTS sideshow_snapshot_assets_asset_idx
        ON snapshot_assets (assetId);
      CREATE INDEX IF NOT EXISTS sideshow_open_events_link_at_idx
        ON open_events (shareLinkId, at);
      CREATE INDEX IF NOT EXISTS sideshow_open_events_at_idx
        ON open_events (at);
      CREATE INDEX IF NOT EXISTS sideshow_external_feedback_publication_idx
        ON external_feedback (publicationId, createdAt);
      CREATE INDEX IF NOT EXISTS sideshow_external_feedback_link_idx
        ON external_feedback (shareLinkId, createdAt);
    `);
  }

  // --- row mapping ---

  private rowToPublication(r: Record<string, SqlStorageValue>): Publication {
    let identity: IdentityHeader | null = null;
    if (typeof r.identity === "string" && r.identity) {
      try {
        identity = JSON.parse(r.identity) as IdentityHeader;
      } catch {
        identity = null;
      }
    }
    return {
      id: r.id as string,
      kind: r.kind === "collection" ? "collection" : "post",
      title: r.title as string,
      originSessionId: (r.originSessionId as string) ?? null,
      originPostId: (r.originPostId as string) ?? null,
      currentSnapshotId: (r.currentSnapshotId as string) ?? null,
      identity,
      createdAt: r.createdAt as string,
      updatedAt: r.updatedAt as string,
    };
  }

  private rowToSnapshot(r: Record<string, SqlStorageValue>): Snapshot {
    const id = r.id as string;
    const assetIds = this.sql
      .exec("SELECT assetId FROM snapshot_assets WHERE snapshotId = ? ORDER BY assetId ASC", id)
      .toArray()
      .map((a) => a.assetId as string);
    return {
      id,
      publicationId: r.publicationId as string,
      revision: r.revision as number,
      title: r.title as string,
      items: JSON.parse(r.items as string) as SnapshotItem[],
      assetIds,
      createdAt: r.createdAt as string,
    };
  }

  private rowToShareLink(r: Record<string, SqlStorageValue>): ShareLink {
    return {
      id: r.id as string,
      publicationId: r.publicationId as string,
      slug: r.slug as string,
      custom: (r.custom as number) === 1,
      recipientLabel: (r.recipientLabel as string) ?? null,
      passwordHash: (r.passwordHash as string) ?? null,
      expiresAt: (r.expiresAt as string) ?? null,
      revokedAt: (r.revokedAt as string) ?? null,
      trackOpens: (r.trackOpens as number) === 1,
      createdAt: r.createdAt as string,
      updatedAt: r.updatedAt as string,
    };
  }

  private rowToOpenEvent(r: Record<string, SqlStorageValue>): OpenEvent {
    return {
      id: r.id as string,
      shareLinkId: r.shareLinkId as string,
      snapshotId: r.snapshotId as string,
      visitorHash: r.visitorHash as string,
      deviceClass: (r.deviceClass as string) ?? null,
      country: (r.country as string) ?? null,
      at: r.at as string,
    };
  }

  private rowToFeedback(r: Record<string, SqlStorageValue>): ExternalFeedback {
    return {
      id: r.id as string,
      publicationId: r.publicationId as string,
      shareLinkId: r.shareLinkId as string,
      snapshotId: r.snapshotId as string,
      anchor: JSON.parse(r.anchor as string) as ExternalAnchor,
      note: r.note as string,
      name: r.name as string,
      email: (r.email as string) ?? null,
      status: r.status as FeedbackStatus,
      createdAt: r.createdAt as string,
    };
  }

  // --- publications ---

  async createPublication(input: CreatePublicationInput): Promise<Publication> {
    const now = new Date().toISOString();
    const publication: Publication = {
      id: newId(),
      kind: input.kind,
      title: stripNul(input.title)?.trim() || "Untitled",
      originSessionId: stripNul(input.originSessionId ?? null),
      originPostId: stripNul(input.originPostId ?? null),
      currentSnapshotId: null,
      identity: input.identity ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.sql.exec(
      "INSERT INTO publications (id, kind, title, originSessionId, originPostId, currentSnapshotId, identity, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)",
      publication.id,
      publication.kind,
      publication.title,
      publication.originSessionId,
      publication.originPostId,
      publication.identity ? JSON.stringify(publication.identity) : null,
      publication.createdAt,
      publication.updatedAt,
    );
    return publication;
  }

  async getPublication(id: string): Promise<Publication | null> {
    const rows = this.sql.exec("SELECT * FROM publications WHERE id = ?", id).toArray();
    return rows.length > 0 ? this.rowToPublication(rows[0]) : null;
  }

  async listPublications(): Promise<Publication[]> {
    return this.sql
      .exec("SELECT * FROM publications ORDER BY updatedAt DESC")
      .toArray()
      .map((r) => this.rowToPublication(r));
  }

  async updatePublication(id: string, patch: UpdatePublicationInput): Promise<Publication | null> {
    const current = await this.getPublication(id);
    if (!current) return null;
    const title =
      patch.title !== undefined ? stripNul(patch.title).trim() || current.title : current.title;
    const identity = patch.identity !== undefined ? patch.identity : current.identity;
    const updatedAt = new Date().toISOString();
    this.sql.exec(
      "UPDATE publications SET title = ?, identity = ?, updatedAt = ? WHERE id = ?",
      title,
      identity ? JSON.stringify(identity) : null,
      updatedAt,
      id,
    );
    return { ...current, title, identity, updatedAt };
  }

  async removePublication(id: string): Promise<boolean> {
    if (!(await this.getPublication(id))) return false;
    const linkIds = this.sql
      .exec("SELECT id FROM share_links WHERE publicationId = ?", id)
      .toArray()
      .map((r) => r.id as string);
    for (const linkId of linkIds) {
      this.sql.exec("DELETE FROM open_events WHERE shareLinkId = ?", linkId);
      this.sql.exec("DELETE FROM open_visitors WHERE shareLinkId = ?", linkId);
      this.sql.exec("DELETE FROM open_aggregates WHERE shareLinkId = ?", linkId);
    }
    this.sql.exec("DELETE FROM external_feedback WHERE publicationId = ?", id);
    this.sql.exec("DELETE FROM share_links WHERE publicationId = ?", id);
    for (const r of this.sql
      .exec("SELECT id FROM snapshots WHERE publicationId = ?", id)
      .toArray()) {
      this.sql.exec("DELETE FROM snapshot_assets WHERE snapshotId = ?", r.id as string);
    }
    this.sql.exec("DELETE FROM snapshots WHERE publicationId = ?", id);
    this.sql.exec("DELETE FROM publications WHERE id = ?", id);
    return true;
  }

  // --- snapshots ---

  async createSnapshot(input: CreateSnapshotInput): Promise<Snapshot | null> {
    const publication = await this.getPublication(input.publicationId);
    if (!publication) return null;
    const rows = this.sql
      .exec(
        "SELECT MAX(revision) AS maxRevision FROM snapshots WHERE publicationId = ?",
        input.publicationId,
      )
      .toArray();
    const revision = ((rows[0]?.maxRevision as number | null) ?? 0) + 1;
    const now = new Date().toISOString();
    const items = input.items;
    // Explicit pins win, but the surfaces' own references are always included:
    // an immutable snapshot must never lose an asset its markup points at.
    const assetIds = [...new Set([...(input.assetIds ?? []), ...collectSnapshotAssetIds(items)])];
    const snapshot: Snapshot = {
      id: newId(),
      publicationId: input.publicationId,
      revision,
      title: stripNul(input.title)?.trim() || publication.title,
      items,
      assetIds: [...assetIds].sort(),
      createdAt: now,
    };
    this.sql.exec(
      "INSERT INTO snapshots (id, publicationId, revision, title, items, createdAt) VALUES (?, ?, ?, ?, ?, ?)",
      snapshot.id,
      snapshot.publicationId,
      snapshot.revision,
      snapshot.title,
      JSON.stringify(snapshot.items),
      snapshot.createdAt,
    );
    for (const assetId of assetIds) {
      this.sql.exec(
        "INSERT OR IGNORE INTO snapshot_assets (snapshotId, assetId) VALUES (?, ?)",
        snapshot.id,
        assetId,
      );
    }
    this.sql.exec(
      "UPDATE publications SET currentSnapshotId = ?, title = ?, updatedAt = ? WHERE id = ?",
      snapshot.id,
      snapshot.title,
      now,
      input.publicationId,
    );
    return snapshot;
  }

  async getSnapshot(id: string): Promise<Snapshot | null> {
    const rows = this.sql.exec("SELECT * FROM snapshots WHERE id = ?", id).toArray();
    return rows.length > 0 ? this.rowToSnapshot(rows[0]) : null;
  }

  async listSnapshots(publicationId: string): Promise<Snapshot[]> {
    return this.sql
      .exec("SELECT * FROM snapshots WHERE publicationId = ? ORDER BY revision DESC", publicationId)
      .toArray()
      .map((r) => this.rowToSnapshot(r));
  }

  // --- share links ---

  async createShareLink(input: CreateShareLinkInput): Promise<ShareLink | null> {
    if (!(await this.getPublication(input.publicationId))) return null;
    const slug = input.slug ?? newShareToken();
    if (await this.getShareLinkBySlug(slug)) return null;
    const now = new Date().toISOString();
    const link: ShareLink = {
      id: newId(),
      publicationId: input.publicationId,
      slug,
      custom: input.custom === true,
      recipientLabel: stripNul(input.recipientLabel ?? null),
      passwordHash: input.passwordHash ?? null,
      expiresAt: input.expiresAt ?? null,
      revokedAt: null,
      trackOpens: input.trackOpens !== false,
      createdAt: now,
      updatedAt: now,
    };
    this.sql.exec(
      "INSERT INTO share_links (id, publicationId, slug, custom, recipientLabel, passwordHash, expiresAt, revokedAt, trackOpens, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)",
      link.id,
      link.publicationId,
      link.slug,
      link.custom ? 1 : 0,
      link.recipientLabel,
      link.passwordHash,
      link.expiresAt,
      link.trackOpens ? 1 : 0,
      link.createdAt,
      link.updatedAt,
    );
    return link;
  }

  async getShareLink(id: string): Promise<ShareLink | null> {
    const rows = this.sql.exec("SELECT * FROM share_links WHERE id = ?", id).toArray();
    return rows.length > 0 ? this.rowToShareLink(rows[0]) : null;
  }

  async getShareLinkBySlug(slug: string): Promise<ShareLink | null> {
    const rows = this.sql.exec("SELECT * FROM share_links WHERE slug = ?", slug).toArray();
    return rows.length > 0 ? this.rowToShareLink(rows[0]) : null;
  }

  async listShareLinks(publicationId?: string): Promise<ShareLink[]> {
    const rows =
      publicationId === undefined
        ? this.sql.exec("SELECT * FROM share_links ORDER BY createdAt ASC").toArray()
        : this.sql
            .exec(
              "SELECT * FROM share_links WHERE publicationId = ? ORDER BY createdAt ASC",
              publicationId,
            )
            .toArray();
    return rows.map((r) => this.rowToShareLink(r));
  }

  async updateShareLink(id: string, patch: UpdateShareLinkInput): Promise<ShareLink | null> {
    const current = await this.getShareLink(id);
    if (!current) return null;
    const next: ShareLink = {
      ...current,
      recipientLabel:
        patch.recipientLabel !== undefined
          ? stripNul(patch.recipientLabel)
          : current.recipientLabel,
      passwordHash: patch.passwordHash !== undefined ? patch.passwordHash : current.passwordHash,
      expiresAt: patch.expiresAt !== undefined ? patch.expiresAt : current.expiresAt,
      trackOpens: patch.trackOpens !== undefined ? patch.trackOpens : current.trackOpens,
      revokedAt: patch.revokedAt !== undefined ? patch.revokedAt : current.revokedAt,
      updatedAt: new Date().toISOString(),
    };
    this.sql.exec(
      "UPDATE share_links SET recipientLabel = ?, passwordHash = ?, expiresAt = ?, revokedAt = ?, trackOpens = ?, updatedAt = ? WHERE id = ?",
      next.recipientLabel,
      next.passwordHash,
      next.expiresAt,
      next.revokedAt,
      next.trackOpens ? 1 : 0,
      next.updatedAt,
      id,
    );
    return next;
  }

  async removeShareLink(id: string): Promise<boolean> {
    if (!(await this.getShareLink(id))) return false;
    this.sql.exec("DELETE FROM open_events WHERE shareLinkId = ?", id);
    this.sql.exec("DELETE FROM open_visitors WHERE shareLinkId = ?", id);
    this.sql.exec("DELETE FROM open_aggregates WHERE shareLinkId = ?", id);
    this.sql.exec("DELETE FROM external_feedback WHERE shareLinkId = ?", id);
    this.sql.exec("DELETE FROM share_links WHERE id = ?", id);
    return true;
  }

  // --- confirmed opens ---

  async recordOpen(input: RecordOpenInput): Promise<OpenEvent | null> {
    if (!(await this.getShareLink(input.shareLinkId))) return null;
    const at = new Date().toISOString();
    const event: OpenEvent = {
      id: newId(),
      shareLinkId: input.shareLinkId,
      snapshotId: input.snapshotId,
      visitorHash: input.visitorHash,
      deviceClass: stripNul(input.deviceClass ?? null),
      country: stripNul(input.country ?? null),
      at,
    };
    this.sql.exec(
      "INSERT INTO open_events (id, shareLinkId, snapshotId, visitorHash, deviceClass, country, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      event.id,
      event.shareLinkId,
      event.snapshotId,
      event.visitorHash,
      event.deviceClass,
      event.country,
      event.at,
    );
    // Aggregates are the durable record: they must survive the 90-day prune of
    // the detailed events above, so they are maintained here rather than
    // computed from open_events.
    this.sql.exec(
      `INSERT INTO open_aggregates (shareLinkId, firstOpenAt, lastOpenAt, totalOpens)
       VALUES (?, ?, ?, 1)
       ON CONFLICT(shareLinkId) DO UPDATE SET
         lastOpenAt = excluded.lastOpenAt,
         totalOpens = open_aggregates.totalOpens + 1`,
      event.shareLinkId,
      at,
      at,
    );
    this.sql.exec(
      "INSERT OR IGNORE INTO open_visitors (shareLinkId, visitorHash, firstAt) VALUES (?, ?, ?)",
      event.shareLinkId,
      event.visitorHash,
      at,
    );
    return event;
  }

  async listOpenEvents(shareLinkId: string, limit = 100): Promise<OpenEvent[]> {
    return this.sql
      .exec(
        "SELECT * FROM open_events WHERE shareLinkId = ? ORDER BY at DESC, rowid DESC LIMIT ?",
        shareLinkId,
        Math.max(1, Math.trunc(limit)),
      )
      .toArray()
      .map((r) => this.rowToOpenEvent(r));
  }

  async getOpenAggregate(shareLinkId: string): Promise<OpenAggregate> {
    const rows = this.sql
      .exec("SELECT * FROM open_aggregates WHERE shareLinkId = ?", shareLinkId)
      .toArray();
    const uniques = this.sql
      .exec("SELECT COUNT(*) AS n FROM open_visitors WHERE shareLinkId = ?", shareLinkId)
      .toArray();
    const row = rows[0];
    return {
      shareLinkId,
      firstOpenAt: (row?.firstOpenAt as string) ?? null,
      lastOpenAt: (row?.lastOpenAt as string) ?? null,
      totalOpens: (row?.totalOpens as number) ?? 0,
      uniqueVisitors: (uniques[0]?.n as number) ?? 0,
    };
  }

  async pruneOpenEvents(before: string): Promise<number> {
    const rows = this.sql
      .exec("SELECT COUNT(*) AS n FROM open_events WHERE at < ?", before)
      .toArray();
    const n = (rows[0]?.n as number) ?? 0;
    if (n > 0) this.sql.exec("DELETE FROM open_events WHERE at < ?", before);
    return n;
  }

  // --- external feedback ---

  // Deliberately its own table with its own id space: a share-link holder's
  // submission must never land in `comments`, never receive a comment `seq`, and
  // never advance a session's `agentSeq` (docs/adr/0003).
  async createFeedback(input: CreateFeedbackInput): Promise<ExternalFeedback | null> {
    const link = await this.getShareLink(input.shareLinkId);
    if (!link || link.publicationId !== input.publicationId) return null;
    if (!(await this.getSnapshot(input.snapshotId))) return null;
    const feedback: ExternalFeedback = {
      id: newId(),
      publicationId: input.publicationId,
      shareLinkId: input.shareLinkId,
      snapshotId: input.snapshotId,
      anchor: input.anchor,
      note: stripNul(input.note),
      name: stripNul(input.name),
      email: stripNul(input.email ?? null),
      status: "unread",
      createdAt: new Date().toISOString(),
    };
    this.sql.exec(
      "INSERT INTO external_feedback (id, publicationId, shareLinkId, snapshotId, anchor, note, name, email, status, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      feedback.id,
      feedback.publicationId,
      feedback.shareLinkId,
      feedback.snapshotId,
      JSON.stringify(feedback.anchor),
      feedback.note,
      feedback.name,
      feedback.email,
      feedback.status,
      feedback.createdAt,
    );
    return feedback;
  }

  async getFeedback(id: string): Promise<ExternalFeedback | null> {
    const rows = this.sql.exec("SELECT * FROM external_feedback WHERE id = ?", id).toArray();
    return rows.length > 0 ? this.rowToFeedback(rows[0]) : null;
  }

  async listFeedback(query: FeedbackQuery): Promise<ExternalFeedback[]> {
    const clauses: string[] = [];
    const params: SqlStorageValue[] = [];
    if (query.publicationId !== undefined) {
      clauses.push("publicationId = ?");
      params.push(query.publicationId);
    }
    if (query.shareLinkId !== undefined) {
      clauses.push("shareLinkId = ?");
      params.push(query.shareLinkId);
    }
    if (query.snapshotId !== undefined) {
      clauses.push("snapshotId = ?");
      params.push(query.snapshotId);
    }
    if (query.status !== undefined) {
      clauses.push("status = ?");
      params.push(query.status);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.sql
      .exec(`SELECT * FROM external_feedback ${where} ORDER BY createdAt ASC, rowid ASC`, ...params)
      .toArray()
      .map((r) => this.rowToFeedback(r));
  }

  async setFeedbackStatus(id: string, status: FeedbackStatus): Promise<ExternalFeedback | null> {
    const current = await this.getFeedback(id);
    if (!current) return null;
    this.sql.exec("UPDATE external_feedback SET status = ? WHERE id = ?", status, id);
    return { ...current, status };
  }

  // --- assets ---

  async isSnapshotAsset(assetId: string): Promise<boolean> {
    return (
      this.sql
        .exec("SELECT 1 AS hit FROM snapshot_assets WHERE assetId = ? LIMIT 1", assetId)
        .toArray().length > 0
    );
  }
}
