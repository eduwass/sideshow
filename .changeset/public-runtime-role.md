---
"sideshow": minor
---

Split the runtime into two explicit roles. `SIDESHOW_ROLE=public` starts the public publication service — a separate app that mounts only publication reads, password verification, confirmed-open recording and scoped external feedback, with owner writes behind a server-side bearer token; anything else resolves to the private control plane, so a typo can only ever fail closed. The private service gains a `destination` (URL + token) for the one public service it publishes to; the token stays on the server and no route returns it. Share-link passwords use scrypt, and the private service warns — or, with `SIDESHOW_REQUIRE_LOOPBACK=1`, refuses to start — when it is reachable beyond loopback without a token.
