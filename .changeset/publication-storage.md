---
"sideshow": minor
---

Add publication storage: a runtime-agnostic model for publications, immutable snapshots, share links, confirmed opens and external feedback, backed by `SqlPublicationStore` on the same SQLite store that runs on Node and the Durable Object. Snapshots pin their assets so a published revision keeps its images after the rolling post history has moved on, detailed open events prune at 90 days while aggregates persist, and external feedback lives in its own tables — it can never enter the trusted comment sequence or advance an agent cursor.
