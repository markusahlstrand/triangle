---
"triangle": patch
---

Move the Substrat packages 0.62 → 0.63 (`kernel`, `contracts`, `adapter-sqlite`,
`adapter-cloudflare`, `vertical-host`) and take `@changesets/cli` to 3.x. No app
behavior changes: the scenario (including the denials), `boundary-lint`, and both
typecheck passes stay green on the new versions.
