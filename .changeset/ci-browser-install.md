---
"sideshow": patch
---

Stop the end-to-end CI job from hanging: `playwright install --with-deps` shells out to apt, which intermittently blocks forever on the runner's unattended-upgrades holding the dpkg lock. The job now releases that lock first, retries the apt half, caches the browser binaries, and bounds both steps so a stuck mirror fails inside the job's budget instead of sitting in one step for forty minutes.
