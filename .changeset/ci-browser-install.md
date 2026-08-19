---
"sideshow": patch
---

Stop the end-to-end CI job from hanging: `playwright install --with-deps` shells out to apt, which intermittently blocks forever on the runner's unattended-upgrades holding the dpkg lock. The job now releases that lock first, installs system dependencies and browsers as separate bounded steps, and fails fast instead of sitting in the step for forty minutes.
