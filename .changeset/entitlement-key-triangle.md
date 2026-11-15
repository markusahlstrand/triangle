---
"triangle": patch
---

The module's entitlement key is `triangle`, the vertical's own slug. It was `garden`, which a
vertical may not declare, so a fresh install was granted `triangle` and every operation, including
the role lookup behind `/api/me`, was refused as "not entitled". `ENTITLEMENT_KEYS` now reads the
key from the manifest so the two cannot drift.
