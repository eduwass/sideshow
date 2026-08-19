---
"sideshow": minor
---

Let an external theme engine drive the private workspace's palette. A new versioned custom-theme contract (`server/customTheme.ts`) carries a semantic palette and full syntax-theme data for light and/or dark; `PUT /api/theme/custom` validates every colour before storing it (a malformed payload is a 400 that changes nothing) and `DELETE /api/theme/custom` restores the default. An accepted push becomes the active theme and re-themes the viewer chrome, the html-surface `--color-*` tokens, and the syntax colours in markdown/code/diff surfaces without a rebuild.

Because a custom theme's content changes while its id stays the same, every accepted push bumps a revision that joins the `/s/:id` render-cache key, the surface iframe URLs (`trev`), the `immutable` response header, and the advertised social-card URL — so no cache can answer with a previous palette. A companion monotheme user target lives in the owner's dotfiles; a Sideshow that is unreachable never aborts a theme switch.

The private chrome no longer shows the sideshow wordmark: the sidebar/header control is now an unbranded home button and the standalone share page has no watermark. Public publications are unaffected — the public runtime has no custom-theme route and keeps its neutral palette.
