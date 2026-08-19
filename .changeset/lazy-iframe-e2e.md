---
"sideshow": patch
---

Fix a false negative in the end-to-end suite: surface iframes are lazily loaded, so on a tall card at a phone viewport the ones below the fold never navigated and the horizontal-overflow check measured them as permanently missing. The check now brings each surface into view first — what a reader does — so it covers every surface instead of only the ones that happened to be on screen.
