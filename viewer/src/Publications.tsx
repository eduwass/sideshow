import { createEffect, createMemo, createSignal, For, onMount, Show } from "solid-js";
import {
  ANALYTICS_DISCLAIMER,
  ANALYTICS_RECENT_LIMIT,
  createShareLink,
  CUSTOM_SLUG_WARNING,
  deletePublication,
  deleteShareLink,
  duplicateShareLink,
  expiryFromInput,
  expiryInputValue,
  formatCountry,
  formatDeviceClass,
  formatExpiry,
  formatOpenAt,
  listPublications,
  type Publication,
  publicationDetail,
  type PublicationDetail,
  publicationErrorMessage,
  relTime,
  retentionNote,
  type ShareLinkAnalytics,
  shareLinkAnalytics,
  type ShareLinkView,
  shareLinkStatus,
  shareLinkUrl,
  updatePublication,
  updateShareLink,
} from "./api.ts";
import { writeClipboard } from "./clipboard.ts";
import {
  avatarPreviewUrl,
  type IdentityForm,
  identityEnabled,
  identityError,
  identityForm,
  identityFromForm,
  identityLinkText,
} from "./identity.ts";
import { toast } from "./state.ts";

// The owner dashboard for everything that has been put on the public web from
// this workspace: what exists, which revision each is on, and — the part that
// actually matters — who can still open it.
//
// Every write here is destructive to somebody's access, so the two irreversible
// ones (revoke, delete) are behind an explicit confirmation step rather than a
// single click, and server errors are shown verbatim: "that link address is
// already taken" is the answer, and paraphrasing it would only hide it.

// The list route answers with bare publications — no revision, no link count —
// so the dashboard fills those in from each publication's detail. That is one
// request per publication; fine for a personal workspace's handful, and the
// upgrade path is counts on the list route itself rather than anything here.
type Enrichment = { revision: number | null; linkCount: number };

export function Publications() {
  const [origin, setOrigin] = createSignal("");
  const [publications, setPublications] = createSignal<Publication[] | null>(null);
  const [extra, setExtra] = createSignal<Record<string, Enrichment>>({});
  const [loadError, setLoadError] = createSignal<string | null>(null);
  const [openId, setOpenId] = createSignal<string | null>(null);

  const load = async () => {
    setLoadError(null);
    try {
      const data = await listPublications();
      setOrigin(data.origin);
      setPublications(data.publications);
      const filled: Record<string, Enrichment> = {};
      await Promise.all(
        data.publications.map(async (p) => {
          try {
            const detail = await publicationDetail(p.id);
            const current = detail.snapshots.find((s) => s.id === p.currentSnapshotId);
            filled[p.id] = {
              revision: current?.revision ?? null,
              linkCount: detail.links.length,
            };
          } catch {
            // A publication whose detail we could not read still belongs in the
            // list; its counts just stay unknown.
          }
        }),
      );
      setExtra(filled);
    } catch (err) {
      setPublications([]);
      setLoadError(publicationErrorMessage(err, "Couldn't load publications"));
    }
  };

  onMount(() => void load());

  return (
    <section class="settings-page pubs-page" aria-label="Publications">
      <div class="settings-col">
        <Show
          when={openId()}
          keyed
          fallback={
            <>
              <header class="settings-top">
                <h1>Publications</h1>
                <p>
                  Everything this workspace has published to the web, and the share links that can
                  still open it.
                </p>
              </header>
              <Show when={loadError()}>
                <p class="pubs-error" role="alert">
                  {loadError()}
                </p>
              </Show>
              <Show when={publications()} fallback={<p class="pubs-loading">Loading…</p>}>
                {(list) => (
                  <Show
                    when={list().length > 0}
                    fallback={
                      <Show when={!loadError()}>
                        <p class="pubs-empty">
                          Nothing published yet. Publish a post or a whole session from its share
                          menu, and it will show up here with its share links.
                        </p>
                      </Show>
                    }
                  >
                    <ul class="pubs-list">
                      <For each={list()}>
                        {(publication) => (
                          <li>
                            <button
                              class="pubs-row"
                              type="button"
                              onClick={() => setOpenId(publication.id)}
                            >
                              <span class="pubs-row-title">{publication.title || "Untitled"}</span>
                              <span class="pubs-row-meta">
                                <span class="pubs-kind">
                                  {publication.kind === "collection" ? "Collection" : "Post"}
                                </span>
                                {" · "}
                                {revisionLabel(extra()[publication.id]?.revision ?? null)}
                                {" · updated "}
                                {relTime(publication.updatedAt)}
                                {" · "}
                                {linkCountLabel(extra()[publication.id]?.linkCount)}
                              </span>
                            </button>
                          </li>
                        )}
                      </For>
                    </ul>
                  </Show>
                )}
              </Show>
            </>
          }
        >
          {(id) => (
            <PublicationDetailView
              id={id}
              fallbackOrigin={origin()}
              onBack={() => {
                setOpenId(null);
                void load();
              }}
            />
          )}
        </Show>
      </div>
    </section>
  );
}

function revisionLabel(revision: number | null): string {
  return revision === null ? "no revision yet" : `revision ${revision}`;
}

function linkCountLabel(count: number | undefined): string {
  if (count === undefined) return "links unknown";
  return count === 1 ? "1 share link" : `${count} share links`;
}

function PublicationDetailView(props: { id: string; fallbackOrigin: string; onBack: () => void }) {
  const [detail, setDetail] = createSignal<PublicationDetail | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [title, setTitle] = createSignal("");
  const [savingTitle, setSavingTitle] = createSignal(false);
  const [creating, setCreating] = createSignal(false);
  const [confirmDelete, setConfirmDelete] = createSignal(false);

  const origin = () => detail()?.origin || props.fallbackOrigin;
  const links = () => detail()?.links ?? [];

  const load = async () => {
    setError(null);
    try {
      const data = await publicationDetail(props.id);
      setDetail(data);
      setTitle(data.publication.title);
    } catch (err) {
      setError(publicationErrorMessage(err, "Couldn't load this publication"));
    }
  };

  onMount(() => void load());

  // One place every write funnels through: run it, refetch, and surface whatever
  // the server said if it refused.
  const run = async (action: () => Promise<unknown>, success: string, fallback: string) => {
    try {
      await action();
      await load();
      toast(success);
      return true;
    } catch (err) {
      toast(publicationErrorMessage(err, fallback));
      return false;
    }
  };

  const saveTitle = async () => {
    const next = title().trim();
    const current = detail()?.publication.title ?? "";
    if (!next || next === current || savingTitle()) return;
    setSavingTitle(true);
    await run(
      () => updatePublication(props.id, { title: next }),
      "Title updated",
      "Couldn't rename this publication",
    );
    setSavingTitle(false);
  };

  return (
    <>
      <header class="settings-top pubs-detail-top">
        <button class="pubs-back" type="button" onClick={props.onBack}>
          ← All publications
        </button>
        <Show when={detail()} fallback={<h1>{error() ? "Publication" : "Loading…"}</h1>}>
          {(data) => (
            <>
              <h1>{data().publication.title || "Untitled"}</h1>
              <p>
                {data().publication.kind === "collection" ? "Collection" : "Post"} · created{" "}
                {relTime(data().publication.createdAt)} · updated{" "}
                {relTime(data().publication.updatedAt)}
              </p>
            </>
          )}
        </Show>
      </header>

      <Show when={error()}>
        <p class="pubs-error" role="alert">
          {error()}
        </p>
      </Show>

      <Show when={detail()}>
        {(data) => (
          <>
            <section class="settings-sec">
              <h2>Title</h2>
              <div class="pubs-field-row">
                <input
                  class="pubs-input"
                  type="text"
                  aria-label="Publication title"
                  value={title()}
                  onInput={(e) => setTitle(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void saveTitle();
                    }
                  }}
                />
                <button
                  class="publish-btn"
                  type="button"
                  disabled={
                    savingTitle() || !title().trim() || title().trim() === data().publication.title
                  }
                  onClick={() => void saveTitle()}
                >
                  Save title
                </button>
              </div>
            </section>

            <IdentityHeaderSection
              publicationId={props.id}
              identity={data().publication.identity}
              origin={origin()}
              run={run}
            />

            <section class="settings-sec">
              <h2>Share links</h2>
              <Show
                when={links().length > 0}
                fallback={
                  <p class="pubs-empty">
                    No share links yet — nobody can open this publication until you make one.
                  </p>
                }
              >
                <div class="pubs-table-wrap">
                  <table class="pubs-table">
                    <thead>
                      <tr>
                        <th>Link</th>
                        <th>Recipient</th>
                        <th>Access</th>
                        <th>State</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      <For each={links()}>
                        {(link) => <ShareLinkRow link={link} origin={origin()} run={run} />}
                      </For>
                    </tbody>
                  </table>
                </div>
              </Show>
              <Show
                when={creating()}
                fallback={
                  <button
                    class="publish-btn primary"
                    type="button"
                    onClick={() => setCreating(true)}
                  >
                    New share link…
                  </button>
                }
              >
                <NewShareLinkForm
                  publicationId={props.id}
                  onDone={() => setCreating(false)}
                  run={run}
                />
              </Show>
            </section>

            <section class="settings-sec">
              <h2>Snapshot history</h2>
              <Show
                when={data().snapshots.length > 0}
                fallback={<p class="pubs-empty">No snapshots yet.</p>}
              >
                <ul class="pubs-snaps">
                  <For each={data().snapshots}>
                    {(snapshot) => (
                      <li
                        classList={{
                          current: snapshot.id === data().publication.currentSnapshotId,
                        }}
                      >
                        <span class="pubs-snap-rev">Revision {snapshot.revision}</span>
                        <span class="pubs-snap-meta">
                          {new Date(snapshot.createdAt).toLocaleString()} ·{" "}
                          {snapshot.itemCount === 1 ? "1 post" : `${snapshot.itemCount} posts`}
                          <Show when={snapshot.id === data().publication.currentSnapshotId}>
                            {" · current"}
                          </Show>
                        </span>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            </section>

            <section class="settings-sec">
              <h2>Danger zone</h2>
              <Show
                when={confirmDelete()}
                fallback={
                  <>
                    <p class="pubs-note">
                      Deleting a publication takes it off the web for everyone, including every
                      share link that points at it.
                    </p>
                    <button
                      class="publish-btn danger"
                      type="button"
                      onClick={() => setConfirmDelete(true)}
                    >
                      Delete this publication…
                    </button>
                  </>
                }
              >
                <p class="pubs-note" role="alert">
                  Delete “{data().publication.title || "Untitled"}” permanently? This cannot be
                  undone.
                </p>
                <div class="pubs-actions">
                  <button class="publish-btn" type="button" onClick={() => setConfirmDelete(false)}>
                    Keep it
                  </button>
                  <button
                    class="publish-btn danger"
                    type="button"
                    onClick={async () => {
                      try {
                        await deletePublication(props.id);
                        toast("Publication deleted");
                        props.onBack();
                      } catch (err) {
                        toast(publicationErrorMessage(err, "Couldn't delete this publication"));
                      }
                    }}
                  >
                    Delete permanently
                  </button>
                </div>
              </Show>
            </section>
          </>
        )}
      </Show>
    </>
  );
}

type Run = (action: () => Promise<unknown>, success: string, fallback: string) => Promise<boolean>;

// The optional publisher identity strip on the public page. It is off by
// default and stays that way until the owner turns it on: the neutral page is
// the product, and this is the one concession to "who published this".
//
// The avatar is an asset id rather than an upload, deliberately — the private
// viewer has no owner asset-upload route to the public service, so this
// references an image the publication already carries, and the preview is how
// the owner finds out whether the id was right.
function IdentityHeaderSection(props: {
  publicationId: string;
  identity: Publication["identity"];
  origin: string;
  run: Run;
}) {
  const [enabled, setEnabled] = createSignal(identityEnabled(props.identity));
  const [form, setForm] = createSignal<IdentityForm>(identityForm(props.identity));
  const [saving, setSaving] = createSignal(false);
  const [showError, setShowError] = createSignal(false);
  const [avatarBroken, setAvatarBroken] = createSignal(false);

  // Re-sync only when the SAVED identity actually changes, so a refetch caused
  // by some other write on this page (a title save) can't wipe an edit in
  // progress here.
  let saved = JSON.stringify(props.identity ?? null);
  createEffect(() => {
    const next = JSON.stringify(props.identity ?? null);
    if (next === saved) return;
    saved = next;
    setEnabled(identityEnabled(props.identity));
    setForm(identityForm(props.identity));
    setShowError(false);
  });

  const field = (key: keyof IdentityForm, value: string) => setForm({ ...form(), [key]: value });

  const error = createMemo(() => identityError(form()));
  const avatarUrl = createMemo(() => avatarPreviewUrl(props.origin, form().avatarAssetId));

  const save = async () => {
    if (saving()) return;
    if (error()) {
      setShowError(true);
      return;
    }
    setSaving(true);
    await props.run(
      () => updatePublication(props.publicationId, { identity: identityFromForm(form()) }),
      "Identity header saved",
      "Couldn't save the identity header",
    );
    setSaving(false);
  };

  const turnOff = async () => {
    setEnabled(false);
    setShowError(false);
    if (!props.identity) return;
    setSaving(true);
    await props.run(
      () => updatePublication(props.publicationId, { identity: null }),
      "Identity header removed",
      "Couldn't remove the identity header",
    );
    setSaving(false);
  };

  return (
    <section class="settings-sec">
      <h2>Identity header</h2>
      <p class="pubs-note">
        Off by default. When it is on, readers see a small avatar, name and link above the
        publication — nothing else about you is published.
      </p>
      <label class="pubs-check">
        <input
          type="checkbox"
          checked={enabled()}
          disabled={saving()}
          onChange={(e) => {
            if (e.currentTarget.checked) setEnabled(true);
            else void turnOff();
          }}
        />
        Show a publisher identity on this publication
      </label>
      <Show when={enabled()}>
        <form
          class="pubs-form"
          aria-label="Identity header"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <label class="pubs-label">
            Name (required)
            <input
              class="pubs-input"
              type="text"
              value={form().name}
              placeholder="e.g. Ada Lovelace"
              onInput={(e) => field("name", e.currentTarget.value)}
            />
          </label>
          <label class="pubs-label">
            Link URL (optional)
            <input
              class="pubs-input"
              type="url"
              value={form().linkUrl}
              placeholder="https://example.com"
              onInput={(e) => field("linkUrl", e.currentTarget.value)}
            />
          </label>
          <label class="pubs-label">
            Link label (optional)
            <input
              class="pubs-input"
              type="text"
              value={form().linkLabel}
              placeholder="Defaults to the link's host"
              onInput={(e) => field("linkLabel", e.currentTarget.value)}
            />
          </label>
          <label class="pubs-label">
            Avatar asset id (optional)
            <input
              class="pubs-input"
              type="text"
              value={form().avatarAssetId}
              placeholder="an asset already in this publication"
              onInput={(e) => {
                setAvatarBroken(false);
                field("avatarAssetId", e.currentTarget.value);
              }}
            />
          </label>
          <p class="pubs-note">
            The image has to be one this publication already carries — publish a post that includes
            it, then paste its asset id here.
          </p>

          <p class="pubs-preview-label">Preview</p>
          <div class="pubs-identity-preview">
            <Show
              when={avatarBroken() ? null : avatarUrl()}
              fallback={<span class="pubs-identity-avatar placeholder" aria-hidden="true" />}
            >
              {(src) => (
                <img
                  class="pubs-identity-avatar"
                  src={src()}
                  alt=""
                  onError={() => setAvatarBroken(true)}
                />
              )}
            </Show>
            <div>
              <div class="pubs-identity-name">{form().name.trim() || "Your name"}</div>
              <Show when={identityLinkText(form())}>
                {(text) => <div class="pubs-identity-link">{text()}</div>}
              </Show>
            </div>
          </div>
          <Show when={avatarUrl() && avatarBroken()}>
            <p class="pubs-note">
              That asset id didn't load from {props.origin || "the publication"} — check the id.
            </p>
          </Show>

          <Show when={showError() && error()}>
            {(message) => (
              <p class="pubs-error" role="alert">
                {message()}
              </p>
            )}
          </Show>
          <div class="pubs-actions">
            <button class="publish-btn primary" type="submit" disabled={saving()}>
              Save identity
            </button>
          </div>
        </form>
      </Show>
    </section>
  );
}

const STATE_LABEL: Record<string, string> = {
  active: "Active",
  expired: "Expired",
  revoked: "Revoked",
};

function ShareLinkRow(props: { link: ShareLinkView; origin: string; run: Run }) {
  const [editing, setEditing] = createSignal(false);
  const [duplicating, setDuplicating] = createSignal(false);
  const [confirmRevoke, setConfirmRevoke] = createSignal(false);
  const [confirmDelete, setConfirmDelete] = createSignal(false);
  // Analytics are one request per link, so they are fetched only once the owner
  // asks for this link's — never for the whole table on load.
  const [showOpens, setShowOpens] = createSignal(false);

  const url = createMemo(() => shareLinkUrl(props.origin, props.link.slug));
  const state = () => shareLinkStatus(props.link);

  return (
    <>
      <tr class="pubs-link" classList={{ dead: state() !== "active" }} data-slug={props.link.slug}>
        <td data-label="Link">
          <span class="pubs-url">{url()}</span>
          <Show when={props.link.custom}>
            <span class="pubs-tag">custom address</span>
          </Show>
        </td>
        <td data-label="Recipient">{props.link.recipientLabel || "—"}</td>
        <td data-label="Access">
          <span class="pubs-access">{props.link.hasPassword ? "Password" : "No password"}</span>
          <span class="pubs-access">{formatExpiry(props.link.expiresAt)}</span>
          <span class="pubs-access">
            {props.link.trackOpens ? "Tracking opens" : "Not tracking opens"}
          </span>
        </td>
        <td data-label="State">
          <span class="pubs-state" classList={{ [state()]: true }}>
            {STATE_LABEL[state()]}
          </span>
        </td>
        <td data-label="Actions">
          <div class="pubs-actions">
            <button
              class="publish-btn"
              type="button"
              onClick={async () => {
                const copied = await writeClipboard(url());
                toast(copied ? "Link copied" : "Couldn't copy that link");
              }}
            >
              Copy
            </button>
            <a class="publish-btn" href={url()} target="_blank" rel="noopener noreferrer">
              Open
            </a>
            <button
              class="publish-btn"
              type="button"
              aria-expanded={showOpens()}
              onClick={() => setShowOpens(!showOpens())}
            >
              Opens
            </button>
            <button class="publish-btn" type="button" onClick={() => setEditing(!editing())}>
              Update
            </button>
            <button
              class="publish-btn"
              type="button"
              onClick={() => setDuplicating(!duplicating())}
            >
              Duplicate
            </button>
            <Show when={state() !== "revoked"}>
              <button class="publish-btn" type="button" onClick={() => setConfirmRevoke(true)}>
                Revoke
              </button>
            </Show>
            <button class="publish-btn danger" type="button" onClick={() => setConfirmDelete(true)}>
              Delete link
            </button>
          </div>
        </td>
      </tr>

      <Show when={showOpens()}>
        <tr class="pubs-subrow">
          <td colSpan={5}>
            <ShareLinkOpens link={props.link} />
          </td>
        </tr>
      </Show>

      <Show when={confirmRevoke()}>
        <tr class="pubs-subrow">
          <td colSpan={5}>
            <p class="pubs-note" role="alert">
              Revoke this link? Whoever holds it loses access immediately, and revoking cannot be
              undone for that recipient — you would have to send them a new link.
            </p>
            <div class="pubs-actions">
              <button class="publish-btn" type="button" onClick={() => setConfirmRevoke(false)}>
                Cancel
              </button>
              <button
                class="publish-btn danger"
                type="button"
                onClick={async () => {
                  setConfirmRevoke(false);
                  await props.run(
                    () => updateShareLink(props.link.id, { revoked: true }),
                    "Link revoked",
                    "Couldn't revoke that link",
                  );
                }}
              >
                Revoke this link
              </button>
            </div>
          </td>
        </tr>
      </Show>

      <Show when={confirmDelete()}>
        <tr class="pubs-subrow">
          <td colSpan={5}>
            <p class="pubs-note" role="alert">
              Delete this link entirely? Its analytics and feedback go with it. Revoking instead
              keeps the record and just closes the door.
            </p>
            <div class="pubs-actions">
              <button class="publish-btn" type="button" onClick={() => setConfirmDelete(false)}>
                Cancel
              </button>
              <button
                class="publish-btn danger"
                type="button"
                onClick={async () => {
                  setConfirmDelete(false);
                  await props.run(
                    () => deleteShareLink(props.link.id),
                    "Link deleted",
                    "Couldn't delete that link",
                  );
                }}
              >
                Delete permanently
              </button>
            </div>
          </td>
        </tr>
      </Show>

      <Show when={editing()}>
        <tr class="pubs-subrow">
          <td colSpan={5}>
            <UpdateShareLinkForm
              link={props.link}
              run={props.run}
              onDone={() => setEditing(false)}
            />
          </td>
        </tr>
      </Show>

      <Show when={duplicating()}>
        <tr class="pubs-subrow">
          <td colSpan={5}>
            <DuplicateShareLinkForm
              link={props.link}
              run={props.run}
              onDone={() => setDuplicating(false)}
            />
          </td>
        </tr>
      </Show>
    </>
  );
}

// What this link's readers actually did, and — just as important — the limits of
// what that means. The disclaimer and the retention note sit next to the numbers
// rather than in a doc somewhere: an owner reading "2 visitors" has to be able
// to see, in the same glance, that those are rotating hashes and not people.
//
// One request per link, made here on expand, so a dashboard with twenty links
// still loads with one call per publication.
function ShareLinkOpens(props: { link: ShareLinkView }) {
  const [data, setData] = createSignal<ShareLinkAnalytics | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  const load = async () => {
    try {
      setData(await shareLinkAnalytics(props.link.id, ANALYTICS_RECENT_LIMIT));
    } catch (err) {
      setError(publicationErrorMessage(err, "Couldn't load opens for this link"));
    }
  };

  onMount(() => void load());

  return (
    <div class="pubs-opens" aria-label="Confirmed opens">
      <Show when={!props.link.trackOpens}>
        <p class="pubs-note" role="note">
          Tracking is off for this link, so nothing new is being recorded. Anything below is from
          before it was switched off.
        </p>
      </Show>
      <Show when={error()}>
        {(message) => (
          <p class="pubs-error" role="alert">
            {message()}
          </p>
        )}
      </Show>
      <Show
        when={data()}
        fallback={
          <Show when={!error()}>
            <p class="pubs-loading">Loading opens…</p>
          </Show>
        }
      >
        {(analytics) => (
          <>
            <dl class="pubs-stats">
              <div>
                <dt>First open</dt>
                <dd>{formatOpenAt(analytics().aggregate.firstOpenAt)}</dd>
              </div>
              <div>
                <dt>Last open</dt>
                <dd>{formatOpenAt(analytics().aggregate.lastOpenAt)}</dd>
              </div>
              <div>
                <dt>Total opens</dt>
                <dd>{analytics().aggregate.totalOpens}</dd>
              </div>
              <div>
                <dt>Approximate visitors</dt>
                <dd>{analytics().aggregate.uniqueVisitors}</dd>
              </div>
            </dl>
            <Show
              when={analytics().events.length > 0}
              fallback={
                <p class="pubs-empty">
                  {analytics().aggregate.totalOpens > 0
                    ? "No opens recent enough to list — the totals above still count the older ones."
                    : "No opens yet. Nothing is recorded until someone actually renders the page behind this link."}
                </p>
              }
            >
              <p class="pubs-preview-label">Recent activity</p>
              <ul class="pubs-open-list">
                <For each={analytics().events}>
                  {(event) => (
                    <li>
                      <span class="pubs-open-at">{relTime(event.at)}</span>
                      <span class="pubs-open-meta">
                        {formatDeviceClass(event.deviceClass)} · {formatCountry(event.country)}
                      </span>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
            <p class="pubs-note">{ANALYTICS_DISCLAIMER}</p>
            <p class="pubs-note">{retentionNote(analytics().retentionDays)}</p>
          </>
        )}
      </Show>
    </div>
  );
}

// Password and expiry are three-state here — leave alone, set, or clear — so the
// form tracks "did the user touch this" separately from the value itself; an
// untouched field must not silently clear a password the owner still wants.
function UpdateShareLinkForm(props: { link: ShareLinkView; run: Run; onDone: () => void }) {
  const [label, setLabel] = createSignal(props.link.recipientLabel ?? "");
  const [password, setPassword] = createSignal("");
  const [clearPassword, setClearPassword] = createSignal(false);
  const [expiry, setExpiry] = createSignal(expiryInputValue(props.link.expiresAt));
  const [tracking, setTracking] = createSignal(props.link.trackOpens);
  const [saving, setSaving] = createSignal(false);

  const submit = async () => {
    if (saving()) return;
    setSaving(true);
    const patch: Parameters<typeof updateShareLink>[1] = {
      recipientLabel: label().trim(),
      trackOpens: tracking(),
      expiresAt: expiryFromInput(expiry()),
    };
    if (clearPassword()) patch.password = null;
    else if (password()) patch.password = password();
    const ok = await props.run(
      () => updateShareLink(props.link.id, patch),
      "Link updated",
      "Couldn't update that link",
    );
    setSaving(false);
    if (ok) props.onDone();
  };

  return (
    <form
      class="pubs-form"
      aria-label="Update share link"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label class="pubs-label">
        Recipient label
        <input
          class="pubs-input"
          type="text"
          value={label()}
          placeholder="e.g. Acme design team"
          onInput={(e) => setLabel(e.currentTarget.value)}
        />
      </label>
      <label class="pubs-label">
        {props.link.hasPassword ? "Replace password" : "Set a password"}
        <input
          class="pubs-input"
          type="password"
          autocomplete="new-password"
          value={password()}
          disabled={clearPassword()}
          placeholder={props.link.hasPassword ? "Leave blank to keep the current one" : "Optional"}
          onInput={(e) => setPassword(e.currentTarget.value)}
        />
      </label>
      <Show when={props.link.hasPassword}>
        <label class="pubs-check">
          <input
            type="checkbox"
            checked={clearPassword()}
            onChange={(e) => setClearPassword(e.currentTarget.checked)}
          />
          Remove the password
        </label>
      </Show>
      <label class="pubs-label">
        Expires
        <input
          class="pubs-input"
          type="datetime-local"
          value={expiry()}
          onInput={(e) => setExpiry(e.currentTarget.value)}
        />
      </label>
      <p class="pubs-note">Clear the expiry field to let this link stay open indefinitely.</p>
      <label class="pubs-check">
        <input
          type="checkbox"
          checked={tracking()}
          onChange={(e) => setTracking(e.currentTarget.checked)}
        />
        Track opens
      </label>
      <div class="pubs-actions">
        <button class="publish-btn" type="button" onClick={props.onDone}>
          Cancel
        </button>
        <button class="publish-btn primary" type="submit" disabled={saving()}>
          Save changes
        </button>
      </div>
    </form>
  );
}

// Duplicating mints a brand-new link with its own password, expiry, analytics
// and revocation state — so the only thing worth asking for here is who the
// copy is for.
function DuplicateShareLinkForm(props: { link: ShareLinkView; run: Run; onDone: () => void }) {
  const [label, setLabel] = createSignal("");
  const [saving, setSaving] = createSignal(false);

  return (
    <form
      class="pubs-form"
      aria-label="Duplicate share link"
      onSubmit={async (e) => {
        e.preventDefault();
        if (saving()) return;
        setSaving(true);
        const trimmed = label().trim();
        const ok = await props.run(
          () => duplicateShareLink(props.link.id, trimmed ? { recipientLabel: trimmed } : {}),
          "Link duplicated",
          "Couldn't duplicate that link",
        );
        setSaving(false);
        if (ok) props.onDone();
      }}
    >
      <label class="pubs-label">
        Recipient label for the copy (optional)
        <input
          class="pubs-input"
          type="text"
          value={label()}
          placeholder="e.g. Second reviewer"
          onInput={(e) => setLabel(e.currentTarget.value)}
        />
      </label>
      <p class="pubs-note">
        The copy gets its own address, password, expiry, analytics and revocation state — revoking
        one never touches the other.
      </p>
      <div class="pubs-actions">
        <button class="publish-btn" type="button" onClick={props.onDone}>
          Cancel
        </button>
        <button class="publish-btn primary" type="submit" disabled={saving()}>
          Duplicate link
        </button>
      </div>
    </form>
  );
}

function NewShareLinkForm(props: { publicationId: string; run: Run; onDone: () => void }) {
  const [label, setLabel] = createSignal("");
  const [slug, setSlug] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [expiry, setExpiry] = createSignal("");
  // On by default, matching the public service's own default for a link created
  // without the field — the dashboard must not quietly opt a new link out.
  const [tracking, setTracking] = createSignal(true);
  const [saving, setSaving] = createSignal(false);

  return (
    <form
      class="pubs-form"
      aria-label="New share link"
      onSubmit={async (e) => {
        e.preventDefault();
        if (saving()) return;
        setSaving(true);
        const input: Parameters<typeof createShareLink>[1] = { trackOpens: tracking() };
        if (label().trim()) input.recipientLabel = label().trim();
        if (slug().trim()) input.slug = slug().trim();
        if (password()) input.password = password();
        const expiresAt = expiryFromInput(expiry());
        if (expiresAt) input.expiresAt = expiresAt;
        const ok = await props.run(
          () => createShareLink(props.publicationId, input),
          "Share link created",
          "Couldn't create that link",
        );
        setSaving(false);
        if (ok) props.onDone();
      }}
    >
      <label class="pubs-label">
        Recipient label (optional)
        <input
          class="pubs-input"
          type="text"
          value={label()}
          placeholder="e.g. Acme design team"
          onInput={(e) => setLabel(e.currentTarget.value)}
        />
      </label>
      <label class="pubs-label">
        Custom address (optional)
        <input
          class="pubs-input"
          type="text"
          value={slug()}
          placeholder="leave blank for an unguessable address"
          onInput={(e) => setSlug(e.currentTarget.value)}
        />
      </label>
      <p class="pubs-warn" role="note">
        {CUSTOM_SLUG_WARNING}
      </p>
      <label class="pubs-label">
        Password (optional)
        <input
          class="pubs-input"
          type="password"
          autocomplete="new-password"
          value={password()}
          onInput={(e) => setPassword(e.currentTarget.value)}
        />
      </label>
      <label class="pubs-label">
        Expires (optional)
        <input
          class="pubs-input"
          type="datetime-local"
          value={expiry()}
          onInput={(e) => setExpiry(e.currentTarget.value)}
        />
      </label>
      <label class="pubs-check">
        <input
          type="checkbox"
          checked={tracking()}
          onChange={(e) => setTracking(e.currentTarget.checked)}
        />
        Track opens
      </label>
      <div class="pubs-actions">
        <button class="publish-btn" type="button" onClick={props.onDone}>
          Cancel
        </button>
        <button class="publish-btn primary" type="submit" disabled={saving()}>
          Create link
        </button>
      </div>
    </form>
  );
}
