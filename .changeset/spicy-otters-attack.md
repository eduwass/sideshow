---
"sideshow": minor
---

Publication readers can now attach a private note to a spot or to quoted text.

Selecting text inside a published surface or clicking a point opens a composer
in the publication page; the note lands in the owner's external-feedback
tables and nowhere else. The capture itself runs inside the sandboxed,
opaque-origin surface document (bundled `@plannotator/web-highlighter`) and
reports over the existing postMessage bridge, so the trusted page never gains
the ability to read across the sandbox — and a surface document only carries
the capture code when the public runtime asks for it. A text anchor stores its
quote plus the structural range, verified against the quote at capture time and
again when it is restored, so a drifted anchor is reported rather than
mis-highlighted. Names are asked once per browser; owners can read submissions
back at `GET /api/owner/publications/:id/feedback`.
