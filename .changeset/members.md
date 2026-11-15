---
"triangle": minor
---

Members, in the app. The account menu shows the signed-in address beside the avatar, and gives the
garden's owner a Members sheet: who is in the garden and with which role, the open invites (each
withdrawable), and a new invite at either role, optionally tied to an address, as a single-use
link to copy. The owner can remove a member; the owner of record and the caller themself cannot be
removed. Backed by two owner-only worker routes, `GET /api/members` (the directory's bindings joined
to the scope's role holders) and `POST /api/members/:principal/remove` (roles revoked bounded by the
owner's own, then logins unbound), beside vertical-auth's invite routes.
