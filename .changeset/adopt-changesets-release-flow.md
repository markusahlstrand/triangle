---
"triangle": patch
---

Adopt changesets as the release mechanism: `pnpm changeset` records intent during
work, `pnpm release` runs the gates, versions via `changeset version`, then
`substrat push --promote prod` deploys that exact version.
