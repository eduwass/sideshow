# Public sharing

Public sharing turns private Sideshow work into deliberate, client-facing artifacts while keeping the working workspace private.

## Language

**Publication**:
A client-facing artifact created from one private post or collection. It owns its access settings, presentation options, analytics, and feedback.
_Avoid_: Public post, export

**Collection**:
An ordered publication containing the posts from one private session.
_Avoid_: Public session, concatenated post

**Snapshot**:
The immutable publication revision a viewer opened and commented on. Updating a publication creates a new snapshot without changing historical feedback context.
_Avoid_: Version, copy

**Share link**:
A revocable capability URL for one publication, optionally labelled for a recipient. Separate share links can carry independent access settings and activity.
_Avoid_: Public URL, recipient URL

**Recipient label**:
Private owner-facing context describing who a share link was intended for. It is not proof of viewer identity.
_Avoid_: User, account

**Confirmed open**:
A publication view recorded after the client page renders, rather than from the initial HTTP request.
_Avoid_: Page hit, impression

**External feedback**:
A submission attached to an exact snapshot and surface by a client using a share link. It remains outside the trusted agent feedback stream.
_Avoid_: User comment, public comment

**Text anchor**:
A selected quote and its structural location within a snapshot surface.
_Avoid_: Highlight

**Point anchor**:
A normalized location within a snapshot surface.
_Avoid_: Pin

**Identity header**:
Optional minimal publisher identity shown on a publication: avatar, name, and one link. Publications otherwise have no product branding.
_Avoid_: Branding, profile
