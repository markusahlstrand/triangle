---
"triangle": minor
---

Wire real sign-in: Triangle is now a pure OIDC relying party (vertical-auth-detach).
The worker binds the shared `IdentityDO` (sub→principal directory, owner TOFU claim,
invites) as the `AUTH` store, builds the relying-party provider per request from the
platform-delivered `substrat:auth` config, and mounts `/api/auth/*`, `/api/me`,
invites and accept-invite. New `garden/whoami` operation (no new permission keys)
gives the SPA its role hint; the SPA replaces the "no sign-in wired" banner with a
real sign-in screen, signed-in header, and invite acceptance. The `x-principal` dev
seam remains local-only behind `ALLOW_DEV_HEADER`.

Kernel and adapters move 0.55 → 0.62 (the release that carries the auth seam), with
the toolchain (`@types/node`, `typescript`, `vitest`, `concurrently`, `hono`,
`@hono/node-server`, `@cloudflare/workers-types`) brought along.
