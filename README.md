# sideshow

[![CI](https://github.com/benvinegar/sideshow/actions/workflows/ci.yml/badge.svg)](https://github.com/benvinegar/sideshow/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**A live visual surface for terminal coding agents.**

Coding agents are stuck in plain text. sideshow gives any agent — Claude Code,
pi, opencode, amp, anything that can run a shell command — a browser canvas to
draw on: diagrams while it explains, UI sketches while it plans, charts while
it profiles. Snippets appear live in your browser, grouped by agent session,
and you can comment on any of them — feedback flows straight back to the agent
in its terminal.

```
agent (terminal) ──publish──►  ┌───────────────────────────┐
                               │  sideshow  · live feed     │
agent ◄──wait for feedback──   │  ┌─────────────────────┐  │
                               │  │  snippet (sandboxed) │  │
                               │  │  💬 your comments    │  │
                               │  └─────────────────────┘  │
                               └───────────────────────────┘
```

## Quick start

```sh
npm install
npx sideshow serve --open     # surface on http://localhost:4242
```

Leave the tab open. Then teach your agent about it (works for any agent that
reads AGENTS.md / CLAUDE.md):

```sh
curl -s http://localhost:4242/setup >> AGENTS.md
```

That's the whole integration for pi, opencode, amp, codex, or anything with a
bash tool — the block tells the agent how to publish snippets and poll for
your comments with plain `curl`. Requires Node ≥ 22.18.

## How agents connect

Three tiers, pick what the agent supports:

1. **Shell (universal)** — the `sideshow` CLI or raw `curl`. Works with every
   coding agent in existence:
   ```sh
   sideshow publish sketch.html --title "Cache layout"   # session handled automatically
   sideshow wait                                         # block until the user comments
   ```
2. **MCP (richer)** — `sideshow mcp` runs a stdio server exposing
   `publish_snippet`, `update_snippet`, `wait_for_feedback`, `reply_to_user`,
   `list_snippets`, `get_design_guide`. For Claude Code:
   ```sh
   claude mcp add --scope user sideshow -- npx -y sideshow mcp
   ```
3. **HTTP** — `POST /api/snippets`, `PUT /api/snippets/:id`,
   `GET /api/comments?wait=60` (long-poll). See `/guide`.

## The model

- **Session** — one agent conversation. Sessions appear in the sidebar;
  rename them by clicking the title, delete them when done.
- **Snippet** — one published HTML fragment, rendered in a sandboxed iframe
  (`sandbox="allow-scripts"`, no same-origin) with a CSP-enforced CDN
  allowlist. Revisions are versioned; flip between versions in the viewer.
- **Comment** — a thread under each snippet. You type in the browser; agents
  receive via long-poll (`sideshow wait` / `wait_for_feedback`) and can reply.
  A snippet's `sendPrompt('...')` buttons post to the same thread.

Agents get a design contract at `/guide` (theme CSS variables, light/dark,
fragment rules) so snippets look native instead of chaotic.

## Architecture

- `server/app.ts` — runtime-agnostic Hono app: REST API, SSE live feed,
  long-poll comments, snippet renderer.
- `server/storage.ts` — `Store` interface + JSON-file implementation
  (sessions, versioned snippets, comments).
- `viewer/` — single-file viewer: session sidebar, live snippet stream,
  comment threads.
- `bin/sideshow.js` — zero-dependency CLI.
- `mcp/server.ts` — stdio MCP server; a thin client over the HTTP API.

## Cloud path

Built local-first, cloud-ready: `createApp()` runs unchanged on Cloudflare
Workers (swap the JSON store for D1/KV behind the `Store` interface; SSE works
on Workers). The CLI and MCP server already target a URL — set `SIDESHOW_URL`
to a deployed origin and `SIDESHOW_TOKEN` for bearer auth (enforced on
mutating routes when the server sets `SIDESHOW_TOKEN`).

## Development

```sh
npm run dev          # server with watch
npm test             # node --test
npm run typecheck    # tsc --noEmit
npm run lint         # oxlint
npm run format       # oxfmt
```

No build step: TypeScript runs directly on Node ≥ 22.18 via native
type-stripping. See [AGENTS.md](AGENTS.md) for architecture rules and
contribution guidance.

## License

[MIT](LICENSE)
