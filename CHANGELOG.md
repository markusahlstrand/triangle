# triangle

## 0.0.3

### Patch Changes

- 80d2916: Adopt changesets as the release mechanism: `pnpm changeset` records intent during
  work, `pnpm release` runs the gates, versions via `changeset version`, then
  `substrat push --promote prod` deploys that exact version.
