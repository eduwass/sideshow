---
name: sideshow
description: Draw live HTML previews to the user's sideshow surface — diagrams, UI sketches, data visualizations, interactive explainers — and receive their comments back. Use when the user asks you to illustrate, visualize, sketch, or draw something, mentions sideshow, or when a visual would explain your work better than text.
---

# sideshow

The user keeps a sideshow surface open in their browser. You publish HTML
snippets to it; they appear instantly. The user can comment on any snippet
and you can pick up those comments from the terminal — it is a two-way
surface, not a fire-and-forget renderer.

## Before your first publish

Fetch the design contract once per session (fragment rules, theme CSS
variables, CDN allowlist, sizing):

```sh
sideshow guide        # or: curl -s $SIDESHOW_URL/guide
```

If `SIDESHOW_URL` is unset, the surface is at `http://localhost:4242`. If it
is not running, start it: `sideshow serve` (or `npx sideshow serve`).

## Publishing

Prefer MCP tools if the sideshow MCP server is connected
(`publish_snippet`, `update_snippet`, `wait_for_feedback`, `reply_to_user`).
Otherwise use the CLI — session grouping is automatic:

```sh
sideshow publish sketch.html --title "Cache layout" --agent your-name
echo '<p>...</p>' | sideshow publish - --title "Quick note"
```

Rules of thumb:

- One concept per snippet, with a clear title. A series of small snippets
  beats one giant page.
- **Iterate with `sideshow update <id>`** (same card, new version) instead of
  publishing near-duplicates. Versions are kept; the user can flip between them.
- Use the theme CSS variables from the guide so snippets work in dark mode.

## The feedback loop

After publishing something that needs a reaction:

```sh
sideshow wait --timeout 120   # blocks until the user comments, prints JSON
```

Treat returned comments as user instructions. Acknowledge briefly with
`sideshow comment "..." --snippet <id>` when useful; do substantial changes
as snippet updates.

## Remote surfaces

A deployed sideshow needs `SIDESHOW_URL` and `SIDESHOW_TOKEN` set in your
environment; the CLI and MCP server send the token automatically. For raw
curl, add `-H "Authorization: Bearer $SIDESHOW_TOKEN"`.
