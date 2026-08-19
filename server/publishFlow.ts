import { encodeBase64 } from "./base64.ts";
import type { DestinationClient } from "./destination.ts";
import type { Publication, ShareLink, Snapshot, SnapshotItem } from "./publicationTypes.ts";
import { collectAssetIds, type Post, type Store, type Surface } from "./types.ts";

// Publishing one private post to the public service.
//
// Publications live only in the public workspace (docs/adr/0001), so this is
// pure orchestration: the private side owns no publication state and asks the
// destination which publication a post already has. That means re-publishing
// hits the same URL even if the private workspace was rebuilt from scratch.
//
// Ordering is what makes a failure safe. A publication with no snapshot resolves
// to 404 for every link, and a share link is only created after a snapshot
// exists, so at no point is a half-built publication reachable:
//
//   1. upload asset bytes            — a snapshot never points at missing bytes
//   2. find or create the publication — invisible until it has a snapshot
//   3. create the snapshot            — the atomic flip to the new revision
//   4. ensure a share link            — the first URL only appears now
//
// Updating an existing publication is the same sequence; step 3 mints a new
// revision and leaves every earlier snapshot intact for owner feedback views.

export interface PublishResult {
  publicationId: string;
  snapshotId: string;
  revision: number;
  slug: string;
  url: string;
  updated: boolean;
}

// `trace` is an experimental private-side path, deliberately outside the
// publication surface taxonomy — it is dropped rather than published.
export const publishableSurfaces = (surfaces: Surface[]): Surface[] =>
  surfaces.filter((surface) => surface.kind !== "trace");

/** The exact post revision to freeze: the current one, or a historical version. */
export function frozenItem(post: Post, version?: number): SnapshotItem | null {
  if (version === undefined || version === post.version) {
    return {
      postId: post.id,
      title: post.title,
      version: post.version,
      surfaces: publishableSurfaces(post.surfaces),
    };
  }
  const historical = post.history.find((entry) => entry.version === version);
  if (!historical) return null;
  return {
    postId: post.id,
    title: historical.title,
    version: historical.version,
    surfaces: publishableSurfaces(historical.surfaces),
  };
}

/** Copy every asset the frozen surfaces reference into the public workspace. */
export async function uploadItemAssets(
  store: Store,
  client: DestinationClient,
  items: SnapshotItem[],
): Promise<string[]> {
  const ids = new Set<string>();
  for (const item of items) collectAssetIds(item.surfaces, ids);
  const uploaded: string[] = [];
  for (const id of ids) {
    const asset = await store.getAsset(id);
    // A surface can reference an asset that was evicted or never uploaded.
    // Skipping keeps publishing possible; the snapshot simply has no bytes for
    // that one, exactly as the private workspace does.
    if (!asset) continue;
    await client.request<{ id: string }>("/api/owner/assets", {
      method: "POST",
      body: JSON.stringify({
        data: encodeBase64(asset.data),
        contentType: asset.contentType,
        filename: asset.filename ?? undefined,
        kind: asset.kind === "trace" ? "file" : asset.kind,
      }),
    });
    uploaded.push(asset.id);
  }
  return uploaded;
}

export interface PublishInput {
  store: Store;
  client: DestinationClient;
  title: string;
  items: SnapshotItem[];
  kind: "post" | "collection";
  originSessionId: string | null;
  originPostId: string | null;
}

export async function publishItems(input: PublishInput): Promise<PublishResult> {
  const { client } = input;
  const assetIds = await uploadItemAssets(input.store, client, input.items);

  const query = input.originPostId
    ? `?originPostId=${encodeURIComponent(input.originPostId)}`
    : `?originSessionId=${encodeURIComponent(input.originSessionId ?? "")}`;
  const existing = (await client.request<Publication[]>(`/api/owner/publications${query}`)).filter(
    (publication) => publication.kind === input.kind,
  );
  const publication =
    existing[0] ??
    (await client.request<Publication>("/api/owner/publications", {
      method: "POST",
      body: JSON.stringify({
        kind: input.kind,
        title: input.title,
        originSessionId: input.originSessionId,
        originPostId: input.originPostId,
      }),
    }));

  const snapshot = await client.request<Snapshot>(
    `/api/owner/publications/${encodeURIComponent(publication.id)}/snapshots`,
    {
      method: "POST",
      body: JSON.stringify({ title: input.title, items: input.items, assetIds }),
    },
  );

  const links = await client.request<ShareLink[]>(
    `/api/owner/publications/${encodeURIComponent(publication.id)}/links`,
  );
  const link =
    links[0] ??
    (await client.request<ShareLink>(
      `/api/owner/publications/${encodeURIComponent(publication.id)}/links`,
      { method: "POST", body: JSON.stringify({}) },
    ));

  return {
    publicationId: publication.id,
    snapshotId: snapshot.id,
    revision: snapshot.revision,
    slug: link.slug,
    url: `${client.origin}/v/${link.slug}`,
    updated: !!existing[0],
  };
}

export interface PublicationStatus {
  published: boolean;
  publicationId?: string;
  url?: string;
  revision?: number;
  updatedAt?: string;
  links?: number;
}

/** What the private share menu shows for a post: published or not, and where. */
export async function publicationStatusForPost(
  client: DestinationClient,
  postId: string,
): Promise<PublicationStatus> {
  const found = await client.request<Publication[]>(
    `/api/owner/publications?originPostId=${encodeURIComponent(postId)}`,
  );
  const publication = found.find((p) => p.kind === "post");
  if (!publication) return { published: false };
  const detail = await client.request<{
    publication: Publication;
    snapshots: { revision: number }[];
    links: ShareLink[];
  }>(`/api/owner/publications/${encodeURIComponent(publication.id)}`);
  const link = detail.links[0];
  return {
    published: true,
    publicationId: publication.id,
    ...(link && { url: `${client.origin}/v/${link.slug}` }),
    revision: detail.snapshots[0]?.revision,
    updatedAt: publication.updatedAt,
    links: detail.links.length,
  };
}
