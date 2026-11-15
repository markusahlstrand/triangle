---
"triangle": minor
---

A tape pull can be marked verified: re-measured and confirmed by the owner (migration
`0002-measurement-verified` adds `garden_measurements.verified_at`; new operation
`garden/set-measurement-verified`, `garden:manage`). A verified pull is never a suspect, pulls four
times harder in the adjustment, and wins over an unverified pull of the same pair. The suspect
search also tries flipping each point that sits on a chosen mirror side, and offers "Flip it" when
that explains the misfit. The survey downloads as JSON (⇩ JSON on the map): every point,
measurement with its residual and verification, constraint, feature and the current suspects.
