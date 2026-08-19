---
"sideshow": patch
---

Ship the public sharing deployment: a runbook covering both runtimes, upstream sync, rollback, secret rotation and data retention; a verifiable SQLite backup and restore script that folds in a live WAL instead of copying a torn file; a production smoke test that exercises publishing, access controls, analytics and feedback against a real deployment and cleans up after itself; worker-integration coverage for the public service on real workerd; and an adversarial threat-model suite. The client page no longer names the product anywhere, not even in an internal identifier.
