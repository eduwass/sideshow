---
"sideshow": minor
---

Publish a post to the public destination from the card's share menu. Publishing freezes the selected post version and copies its assets into the public workspace, then serves it at a stable `/v/:slug` URL; re-publishing mints a new snapshot at the same URL while every earlier snapshot stays intact for owner feedback views. The private side keeps no publication state — it asks the destination which publication a post already has — and the destination's write token never reaches the browser.
