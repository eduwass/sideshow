# Public sharing — deployment runbook

Two runtimes, one codebase (`server/role.ts`):

|               | private control plane                                                      | public publication service                              |
| ------------- | -------------------------------------------------------------------------- | ------------------------------------------------------- |
| what it is    | the working workspace: posts, sessions, agents, MCP, comment→agent channel | frozen publication snapshots behind capability links    |
| where it runs | devbox, systemd user unit, Node                                            | Cloudflare Worker + Durable Object (`show.eduwass.com`) |
| entrypoint    | `bin/sideshow.js serve` → `server/index.ts` → `createApp`                  | `workers/publicService.ts` → `createPublicApp`          |
| data          | `~/services/sideshow/data/sideshow.db` (SQLite, WAL)                       | the `SideshowPublications` DO's own SQLite              |
| audience      | you, on loopback, with a token                                             | link recipients, no account                             |

They talk one way only: the private service holds the public service's owner
token and pushes snapshots to it (`server/destination.ts`). The public service
has no route into a private workspace, because the private workspace is not in
that deployment at all (`docs/adr/0001-isolate-public-sharing.md`).

`SIDESHOW_ROLE` decides which one a process is. Anything other than the exact
string `public` resolves to `private`, so a typo can only fail closed.

---

## 1. Environment variables

### Private control plane (devbox)

Read from `server/index.ts` and `server/role.ts`. Do not invent others.

| variable                     | effect                                                                                                                                              |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SIDESHOW_ROLE`              | unset (or anything but `public`) → private runtime. Leave it unset.                                                                                 |
| `SIDESHOW_HOST`              | address to bind. **Unset means every interface.** Set `127.0.0.1`.                                                                                  |
| `SIDESHOW_TOKEN`             | bearer token required on every request.                                                                                                             |
| `SIDESHOW_REQUIRE_LOOPBACK`  | `1` → the process **refuses to start** unless it binds loopback _and_ has a token (`privateBindingCheck`). This is the deterministic guard; set it. |
| `SIDESHOW_DB`                | SQLite file. Defaults to `SIDESHOW_DATA` with `.json` swapped for `.db`, else `~/.sideshow/sideshow.db`.                                            |
| `SIDESHOW_DATA`              | legacy JSON file; also the one-time migration source on first SQLite boot (`migrateJsonToSqlite`, idempotent, never imports into a non-empty db).   |
| `SIDESHOW_STORE`             | `json` selects the legacy JSON store. Do not set it.                                                                                                |
| `SIDESHOW_DESTINATION_URL`   | origin of the public service — `https://show.eduwass.com`. Must be `https:` unless the hostname is `localhost`, or it is ignored.                   |
| `SIDESHOW_DESTINATION_TOKEN` | the public service's `SIDESHOW_OWNER_TOKEN`.                                                                                                        |
| `PORT`                       | listener port (devbox uses `--port 4250` on the CLI instead).                                                                                       |
| `SIDESHOW_PUBLIC_READ`       | unrelated older feature (tokenless _private_ reads). **Leave unset** — public sharing v1 does not use it.                                           |
| `SIDESHOW_VERSION`           | fakes the version for the update notice; empty string disables the check.                                                                           |

`resolveDestination` returns null unless **both** destination variables are
present and the URL parses, so a half-configured destination never sends
unauthenticated writes at a public origin. With no destination, publish routes
answer `503 {"error":"no publication destination"}` and
`GET /api/publish/destination` reports `{"configured":false}`.

### Public publication service (Cloudflare)

From `workers/publicService.ts` and `wrangler.public.jsonc`. When run on Node
instead, `server/index.ts` requires the same two and exits 1 without them.

| variable                  | effect                                                                                                                                  |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `SIDESHOW_ROLE=public`    | Node only; on the Worker the entrypoint _is_ the public app.                                                                            |
| `SIDESHOW_OWNER_TOKEN`    | bearer for `/api/owner/*`, compared in constant time. The private service's `SIDESHOW_DESTINATION_TOKEN` is this value.                 |
| `SIDESHOW_VISITOR_SECRET` | HMAC key for two things: the approximate-uniques visitor hash (`server/visitorHash.ts`) and the password-unlock cookie (`unlockToken`). |

Both are Wrangler **secrets**, not `vars`. There are no others — the sharing
surface has grown a lot, the secret inventory has not.

### What each runtime exposes

Knowing which side owns which route is what makes a 401 or a 404 diagnosable at
3am.

**Private control plane** — all of it behind `SIDESHOW_TOKEN`. Every
`/api/publications*` and `/api/feedback*` call is proxied server-to-server to
the public service with `SIDESHOW_DESTINATION_TOKEN`, so `503 no publication
destination` means the private side is unconfigured, while `destination returned
401` means the two tokens disagree:

- `GET /api/publish/destination` — is a destination configured, and its origin.
- `POST /api/publish/post`, `POST /api/publish/session`,
  `GET /api/publish/session/:id/preview`, `GET /api/publish/{session,post}/:id`
  — publish, and publication status for a post or a session collection.
- `GET|PATCH|DELETE /api/publications[/:id]`,
  `POST /api/publications/:id/links`,
  `PATCH|DELETE /api/publications/links/:linkId`,
  `POST /api/publications/links/:linkId/duplicate`,
  `GET /api/publications/links/:linkId/analytics` — manage publications, share
  links and their confirmed-open analytics.
- `GET /api/feedback`, `PATCH /api/feedback/:id`,
  `GET /api/feedback/s/:snapshotId/:item/:surface`, `POST /api/feedback/prompt`
  — the feedback inbox: list and triage recipient submissions, reopen the exact
  historical surface one was written against, and copy an agent prompt from it.
- `GET|PUT /api/theme`, and `PUT|DELETE /api/theme/custom` — the latter is the
  versioned payload an external theme engine (monotheme) pushes
  (`server/customTheme.ts`); every accepted push bumps a revision that busts
  every theme-keyed cache. **Private runtime only**; the public app has no such
  route. It is a write channel like any other, protected by `SIDESHOW_TOKEN`
  alone — see rotation (§6).

**Public publication service:**

- Owner API (`/api/owner/*`, `SIDESHOW_OWNER_TOKEN`): `health`; publications
  (`GET|POST|PATCH|DELETE`) and their `snapshots`; share `links`
  (`GET|POST|PATCH|DELETE`, `duplicate`); `GET /api/owner/links/:id/analytics`;
  `GET /api/owner/feedback` and `PATCH /api/owner/feedback/:id`; and
  `GET /api/owner/snapshots/:id/s/:item/:surface`, which renders a **historical**
  snapshot's surface addressed by snapshot rather than by share link — so the
  owner can reopen revision 3's context long after revision 7 went live, without
  any share link exposing an old revision to its holder.
- Visitor routes (no credential, capability URL only): `GET /v/:slug`,
  `GET /api/v/:slug`, `GET /api/v/:slug/s/:item/:surface`, `GET /a/:id`,
  `POST /api/v/:slug/{unlock,open,feedback}`, `GET /robots.txt`.

Every surface-document route — the visitor one and the owner's historical one —
goes through the same renderer and carries `Content-Security-Policy: sandbox
allow-scripts` on the **response**, which is what makes a top-level navigation
to one of those URLs safe.

---

## 2. The public Worker

What is deployed today:

- Worker **`sideshow-public`**, from `wrangler.public.jsonc` — its own Durable
  Object class (`SideshowPublications`) and its own SQLite database, entirely
  separate from the private Worker in `wrangler.jsonc`.
- **`show.eduwass.com`**, attached from the config rather than clicked in the
  dashboard, so the hostname is reproducible from the repo:

  ```jsonc
  "routes": [{ "pattern": "show.eduwass.com", "custom_domain": true }],
  ```

  `custom_domain` makes Cloudflare manage the DNS record and the certificate.
  The zone must be on the same account.

- Secrets `SIDESHOW_OWNER_TOKEN` and `SIDESHOW_VISITOR_SECRET`, both set with
  `wrangler secret put`.

Deploying from scratch, or after changing the config:

```sh
cd ~/Sites/sideshow                       # the fork
npx wrangler login                        # once per machine

openssl rand -hex 32                      # -> SIDESHOW_OWNER_TOKEN
npx wrangler secret put SIDESHOW_OWNER_TOKEN    --config wrangler.public.jsonc
openssl rand -hex 32                      # -> SIDESHOW_VISITOR_SECRET
npx wrangler secret put SIDESHOW_VISITOR_SECRET --config wrangler.public.jsonc

npm run deploy:public                     # wrangler deploy --config wrangler.public.jsonc
```

`npm run deploy` (no `:public`) deploys the _private_ Worker from
`wrangler.jsonc` — a different Worker, a different DO, a different database.
Never point one config at the other's name.

Smoke test:

```sh
curl -sS https://show.eduwass.com/api/owner/health \
  -H "authorization: Bearer $SIDESHOW_OWNER_TOKEN"
# {"ok":true,"role":"public"}
curl -sSi https://show.eduwass.com/api/owner/health | head -1   # -> 401 without the token
curl -sS  https://show.eduwass.com/robots.txt                   # Disallow: /
```

### The 503 "not configured" response

```
sideshow public service is not configured: set its secrets first —
  wrangler secret put SIDESHOW_OWNER_TOKEN --config wrangler.public.jsonc
  wrangler secret put SIDESHOW_VISITOR_SECRET --config wrangler.public.jsonc
```

It means the Worker deployed fine but at least one secret is missing from the
running version, so the fetch handler refuses to construct the Durable Object.
That is deliberate fail-closed behaviour (`workers/publicService.ts`): without
an owner token anyone could write publications, and without a visitor secret
every visitor hash would be unkeyed and the unlock cookie forgeable. No request
reaches the app — it is not a DO outage or a database problem.

**Gotcha, observed during the real deployment: uploading the secret did not lift
the 503 on its own.** `wrangler secret put` created the secret, but the live
version kept answering 503 until a subsequent `wrangler deploy` published a new
version that picked it up. So the fix sequence is:

```sh
npx wrangler secret list --config wrangler.public.jsonc   # names only; values never readable
npx wrangler secret put SIDESHOW_VISITOR_SECRET --config wrangler.public.jsonc
npm run deploy:public                                     # REQUIRED — the secret alone is not enough
curl -sSi https://show.eduwass.com/v/anything | head -1    # confirm the 503 is gone
```

Do not spend ten minutes re-uploading the secret; redeploy and re-check.

---

## 3. The devbox private service

Facts as of the recon on issue #12 — re-check before changing anything.

- Unit: **systemd user** unit `sideshow.service`, `Restart=always`, linger on.
  `~/.config/systemd/user/sideshow.service` is a **symlink into the dotfiles
  repo** (`infra/devbox/files/systemd/user/sideshow.service`, deployed by
  `infra/devbox/roles/sideshow/tasks/main.yml`). Editing the file in
  `~/.config` edits dotfiles. The real change belongs in dotfiles, followed by
  `dotfiles-sync` and `systemctl --user daemon-reload`.
- Command: `node ~/services/sideshow-src/bin/sideshow.js serve --port 4250`,
  `WorkingDirectory=~/services/sideshow`, and originally a single env var
  `SIDESHOW_DATA=~/services/sideshow/data/sideshow.json`.
- Code: a git clone at `~/services/sideshow-src` whose `origin` was
  **modem-dev/sideshow**. The fork deployment repoints it at
  `eduwass/sideshow`.
- Data: `~/services/sideshow/data/` — `sideshow.db` (14 MB) plus a live WAL
  (4.7 MB at recon) and the legacy `sideshow.json` (969 kB, last written
  2026-06-25). SQLite is the live store; the JSON file is only the historical
  migration source and is already imported.
- Binding originally: `*:4250`, **no token**. Reachable over `devbox tunnel`,
  `tailscale serve`, and referenced by `infra/devbox/files/cloudflared/config.yml`.

The hardened unit adds, alongside the existing `SIDESHOW_DATA`:

```ini
Environment=SIDESHOW_HOST=127.0.0.1
Environment=SIDESHOW_REQUIRE_LOOPBACK=1
Environment=SIDESHOW_TOKEN=<32-byte hex>
Environment=SIDESHOW_DESTINATION_URL=https://show.eduwass.com
Environment=SIDESHOW_DESTINATION_TOKEN=<the public SIDESHOW_OWNER_TOKEN>
```

`bin/sideshow.js serve` spawns `server/index.ts` with the full inherited
environment, so unit-level `Environment=` lines reach the server process.

Because the tokens are in the unit file, keep the dotfiles copy at mode `600`,
or better move the secrets to an `EnvironmentFile=%h/services/sideshow/env` that
is `600` and **not** in git — dotfiles is a git repo and secrets do not belong
in it.

Restart and verify:

```sh
systemctl --user daemon-reload
systemctl --user restart sideshow
systemctl --user status sideshow --no-pager
journalctl --user -u sideshow -n 30 --no-pager

# bound to loopback only
ss -ltnp | grep 4250                       # expect 127.0.0.1:4250, not *:4250
curl -sSi http://127.0.0.1:4250/api/sessions | head -1          # 401
curl -sS  http://127.0.0.1:4250/api/sessions -H "authorization: Bearer $SIDESHOW_TOKEN" | head -c 200
curl -sS  http://127.0.0.1:4250/api/publish/destination -H "authorization: Bearer $SIDESHOW_TOKEN"
# {"configured":true,"origin":"https://show.eduwass.com"}
```

If it refuses to start with

```
sideshow refused to start: SIDESHOW_REQUIRE_LOOPBACK is set, so this private
service must bind a loopback address (SIDESHOW_HOST=127.0.0.1) and set SIDESHOW_TOKEN.
```

then one of `SIDESHOW_HOST` / `SIDESHOW_TOKEN` did not reach the process. That
guard is doing its job — do not remove `SIDESHOW_REQUIRE_LOOPBACK` to get the
service back up; fix the environment.

Note that binding loopback changes reachability: `devbox tunnel` forwards from
the devbox side and still works; anything that dialled devbox's LAN/Tailscale
address on `:4250` directly now needs `tailscale serve` (which terminates on
devbox and connects to loopback) instead.

### The auto-updater must not revert the fork

`infra/devbox/files/scripts/sideshow-update.sh` (driven by
`infra/devbox/scripts/software-updates.sh`) runs

```sh
git fetch origin main && git reset --hard origin/main
npm install && npm run build && systemctl --user restart sideshow
```

against `~/services/sideshow-src`. **`git reset --hard` against the old origin
is the mechanism that would silently revert a forked deployment** — including
reverting the hardened server code while the hardened unit file keeps pointing
at it. In the dotfiles repo, do one of:

1. **Repoint** — change the clone's remote to `git@github.com:eduwass/sideshow.git`
   and keep the updater (it then tracks the fork's `main`); or
2. **Gate** — make the script exit non-zero unless
   `git -C ~/services/sideshow-src remote get-url origin` matches the expected
   fork URL, so an unexpected origin stops the update instead of resetting; or
3. **Disable** — remove sideshow from `software-updates.sh`.

Repoint **and** gate is the durable answer: the gate is the deterministic check
that catches a future re-clone from upstream.

Verify:

```sh
git -C ~/services/sideshow-src remote -v          # must be eduwass/sideshow
git -C ~/services/sideshow-src log --oneline -3   # must be the fork's commits
grep -n 'reset --hard\|remote get-url' ~/Sites/dotfiles/infra/devbox/files/scripts/sideshow-update.sh
```

Then run the updater once by hand and re-check `git log` — the deployment must
still be on a fork commit afterwards. That round trip is the only real proof.

---

## 4. Upstream sync (this is a fork)

```
origin    git@github.com:eduwass/sideshow.git    (ours — push here)
upstream  git@github.com:modem-dev/sideshow.git  (READ-ONLY)
```

**Never push to `upstream` and never open a PR against it.** It is a third
party's repository; treat it as a source of commits only.

```sh
cd ~/Sites/sideshow
git remote add upstream git@github.com:modem-dev/sideshow.git   # once, if absent
git fetch upstream
git log --oneline main..upstream/main        # what is new upstream
git switch -c chore/upstream-sync main
git merge upstream/main                      # merge, not rebase: main is published
# resolve conflicts, then the full gate (§9)
git push -u origin chore/upstream-sync       # PR into our main
```

Conflicts land predictably in the files the fork changed: `server/app.ts`,
`server/index.ts`, `wrangler*.jsonc`, `package.json` scripts. Prefer merge over
rebase so the fork's history stays comparable to upstream's.

Deploying an upstream sync is the ordinary path: PR → merge to our `main` →
`npm run deploy:public` (if the public Worker changed) and update
`~/services/sideshow-src` on devbox (`git pull` + `npm install` +
`npm run build` + `systemctl --user restart sideshow`).

---

## 5. Rollback

### Public Worker

There is no database rollback. **A Durable Object's SQLite cannot be reset or
restored** — Cloudflare gives no "reset this DO" operation, and the class is
already live. Schema changes are therefore **in-place and forward-only**
(`SqlStore`/`SqlPublicationStore` migrate with the `pragma_table_info` probe
pattern in their constructors). Rolling back means **redeploying the previous
Worker version**; the data stays where it is, so the previous code must still be
able to read the newer schema. Write migrations that only add.

```sh
npx wrangler versions list --config wrangler.public.jsonc      # version ids
npx wrangler deployments list --config wrangler.public.jsonc   # what is live
npx wrangler rollback <version-id> --config wrangler.public.jsonc -m "why"
# or from source
git checkout <good-sha> && npm run deploy:public
```

Never add a `migrations` entry that deletes a class, or a
`deleted_classes`/`renamed_classes` tag to "start clean" — that destroys every
publication, share link and open record permanently.

If the DO's data is genuinely wrong, the recovery is at the application level:
delete the affected publication through the owner API and re-publish it from the
private workspace, which still holds the source posts.

### Private service (devbox)

Here rollback _is_ code plus data, and the data is a plain file:

```sh
systemctl --user stop sideshow
git -C ~/services/sideshow-src checkout <good-sha>
npm --prefix ~/services/sideshow-src install
npm --prefix ~/services/sideshow-src run build
# only if the data must go back too:
scripts/backup-sideshow.sh --restore \
  ~/backups/sideshow/sideshow-<stamp>.db ~/services/sideshow/data/sideshow.db --force
systemctl --user start sideshow
journalctl --user -u sideshow -n 50 --no-pager
```

Restoring the private database does **not** roll back publications: they live in
the public DO and stay exactly as they were. Re-publishing from an older private
snapshot creates a _new_ revision on the public side; it never rewrites history.

---

## 6. Secret rotation

| secret                                 | where it lives                                                   | rotate with                                            | what breaks                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SIDESHOW_TOKEN` (private)             | devbox unit / EnvironmentFile                                    | new random value, restart the service                  | every agent and browser session using the old token: 401 until `SIDESHOW_TOKEN` is updated in each agent's environment and the viewer is reopened once as `/?key=<token>`. Also breaks any external writer holding it — notably the theme engine pushing `PUT /api/theme/custom`, which then fails silently from the workspace's side (the theme stops following).                                                                   |
| `SIDESHOW_OWNER_TOKEN` (public)        | Wrangler secret **and** the private `SIDESHOW_DESTINATION_TOKEN` | `wrangler secret put` **then `npm run deploy:public`** | **two-sided.** Between the two updates every publish/manage call from the private service gets 401. Publications, links and visitors are unaffected — this token is server-to-server only.                                                                                                                                                                                                                                           |
| `SIDESHOW_DESTINATION_TOKEN` (private) | devbox unit / EnvironmentFile                                    | must equal the public owner token                      | as above; a mismatch shows up as `destination returned 401` on publish.                                                                                                                                                                                                                                                                                                                                                              |
| `SIDESHOW_VISITOR_SECRET` (public)     | Wrangler secret                                                  | `wrangler secret put` **then `npm run deploy:public`** | **user-visible.** (a) approximate uniques re-bucket: `computeVisitorHash` keys on the secret, so returning readers count as new — totals and first/last-open timestamps in `open_aggregates` survive, unique counts step up once; (b) every outstanding unlock cookie is invalidated (`unlockToken` HMACs with the same secret), so anyone holding a password-protected link is asked for the password again. Rotate only for cause. |
| `SIDESHOW_DESTINATION_URL`             | private                                                          | not a secret                                           | changing it points the private service at a different public deployment; existing links keep serving from the old one.                                                                                                                                                                                                                                                                                                               |

Both Wrangler secrets need a **redeploy after the put** for the running version
to see the new value (§2) — the same trap that produced the confusing 503.

Rotation order that avoids a broken window for the owner token: put the new
value on the public Worker and redeploy, then immediately update the private
service and restart it, then confirm with

```sh
curl -sS http://127.0.0.1:4250/api/publications -H "authorization: Bearer $SIDESHOW_TOKEN" | head -c 200
```

A 401 from the destination surfaces through the private API as the destination's
own message; `DestinationClient` never echoes the token itself.

Revoking a _share link_ is not a secret rotation — it is
`DELETE /api/publications/links/:linkId` on the private service (proxied to the
public one), and it takes effect immediately for that link only.

---

## 7. Data retention

Public service (`server/sqlPublicationStore.ts`, `server/publicationTypes.ts`):

- **Detailed open events — 90 days.** `OPEN_EVENT_RETENTION_DAYS = 90` is the
  policy; `SqlPublicationStore.pruneOpenEvents(before)` deletes rows in
  `open_events` (share link, snapshot, visitor hash, coarse device class,
  country, timestamp) older than the cutoff. There is **no scheduler on this
  runtime** — no cron trigger in `wrangler.public.jsonc`, no `scheduled` handler
  — so the prune rides the only write that can grow the table, a confirmed open
  (`server/publicApp.ts`), throttled to once an hour so a burst of opens does
  not re-scan it. Two consequences worth knowing at 3am: the hour is tracked in
  the Durable Object's memory (`prunedAt`), so a DO eviction resets it; and a
  deployment that stops receiving opens stops pruning, so events can outlive 90
  days on an idle service until the next open anywhere triggers a pass. If that
  ever matters, the fix is a `"triggers": { "crons": [...] }` entry plus a
  `scheduled` handler calling `pruneOpenEvents` — not a change to the policy
  constant. `GET /api/owner/links/:id/analytics` reports the window it is
  honouring as `retentionDays`.
- **Aggregates — kept indefinitely.** `open_aggregates` (first open, last open,
  total opens per link) and `open_visitors` (per-link visitor hashes) are the
  durable record and deliberately survive the prune, so long-lived links keep
  meaningful totals after the detail ages out.
- **Visitor identity is already pseudonymous.** No raw IP is ever stored: the
  visitor hash is an HMAC of (share link, IP, user agent) under the visitor
  secret plus a 7-day window (`VISITOR_WINDOW_DAYS`), so linkability expires on
  its own every week. Analytics are "likely-recipient activity", never proof of
  who opened a link.
- **Snapshots are retained, including superseded revisions.** Publishing again
  creates a new revision and flips `currentSnapshotId`; older snapshots stay
  because external feedback references the exact `snapshotId` it was written
  against (`external_feedback.snapshotId`), and the owner reopens that context
  through `GET /api/owner/snapshots/:id/s/:item/:surface`. Deleting old
  snapshots would strand that feedback — do not prune them casually.
- **External feedback** (`external_feedback`: anchor, note, name, optional
  email, status of `unread`/`read`/`resolved`/`rejected`) is kept until its
  publication is deleted.

**Deleting a publication** (`removePublication`) removes, in one call: its
`open_events`, `open_visitors` and `open_aggregates` for every one of its share
links; its `external_feedback`; its `share_links`; its `snapshot_assets` rows
and `snapshots`; and the `publications` row. Every share link for it stops
resolving immediately (`/v/:slug` → 404). Asset _blobs_ are unpinned rather than
force-deleted; they age out through the store's reference-aware LRU
(`selectEvictions`). This is the "delete everything about this share" button and
it is irreversible — there is no DO backup to restore from (§5).

Private service: posts, sessions, comments and assets live in
`~/services/sideshow/data/sideshow.db` and are retained until you delete them.
Assets evict LRU under pressure. Publishing **copies** content to the public
side; deleting a post privately does not retract a publication.

---

## 8. Backups

`scripts/backup-sideshow.sh` backs up the private SQLite workspace. The public
DO has no equivalent — that is precisely why publications are re-publishable
from the private side.

```sh
# hot backup: safe while the service is running
scripts/backup-sideshow.sh ~/services/sideshow/data/sideshow.db ~/backups/sideshow

# rehearse the restore into a scratch path — never straight over live data
scripts/backup-sideshow.sh --restore ~/backups/sideshow/sideshow-<stamp>.db /tmp/restore-check.db
```

A plain `cp` of `sideshow.db` is **not** a backup: the store runs in WAL mode
and an arbitrary amount of committed data lives in `sideshow.db-wal` (4.7 MB at
recon time). The script uses SQLite's `VACUUM INTO`, which reads inside a
transaction and folds the WAL in, then verifies the copy with
`PRAGMA integrity_check` and a per-table row-count comparison against the
source; it writes a `.sha256` sidecar and exits non-zero if anything disagrees.
It opens the source read-only so it cannot checkpoint or truncate the live WAL,
and it prefers the `sqlite3` CLI when present, falling back to Node's built-in
`node:sqlite` (which is what devbox uses — there is no `sqlite3` on PATH there).

Before any migration or restore rehearsal: take a backup, confirm the exit
status is 0, and keep a copy off the box (`scp devbox:~/backups/sideshow/... .`).

---

## 9. Validation gate

Before deploying either runtime:

```sh
npm test              # node unit/API/store + viewer unit
npm run typecheck     # node + workers + viewer programs
npm run lint
npm run format:check
npm run test:worker   # real workerd: private Worker AND public Worker + DO SQLite
npm run security:audit
npm run bench:check
npm run test:e2e      # for viewer/rendering changes
```

`npm run test:worker` runs `test/workerIntegration.integration.ts` and
`test/publicWorkerIntegration.integration.ts`. The second boots
`wrangler.public.jsonc` on real workerd and proves: the 503-without-secrets
path, `SqlPublicationStore`'s schema on a real Durable Object, the owner API's
401 without the token, that no private route exists in that deployment, and that
a seeded publication is readable through `/v/:slug` with the `sandbox` CSP
header on both the visitor and the historical-snapshot surface documents.
