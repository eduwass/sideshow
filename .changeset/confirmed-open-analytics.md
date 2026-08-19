---
"sideshow": minor
---

See whether a client-facing publication was actually read: each share link's dashboard row now expands to show first open, last open, total opens, approximate visitors and a short recent-activity list (when, what kind of device, which country). Tracking is on by default and can be turned off per link, and a link with it off says so plainly. An open is only recorded once the publication has really rendered — fetching the page, its API or a surface document never counts one — and no raw IP address is ever stored: visitors are counted with a keyed hash that rotates weekly, so the figures are described in the dashboard for what they are, likely-recipient activity rather than proof of identity. Detailed events are kept for 90 days; the totals are kept indefinitely.
