---
"triangle": minor
---

Substrat 0.98 → 0.197 (kernel, contracts, adapters, vertical-host; vertical-auth 0.12 → 0.35,
boundary-lint 0.9, model-emit 0.12).

- The module binds its handlers with `operationsFor(gardenOperations)` — the input schemas and
  the `If-Match` map now travel with the handlers by construction. `garden/list-species` is
  `derive: 'list'`: the kernel writes it, same check, same page.
- Both scope hosts are handed `permissions`, so a module outside the declared surface is
  refused at registration.
- The worker's auth seam is vertical-auth's: `instanceAuthFor`, `mountSession` (`/api/me`
  now answers `principal` rather than `key`, plus `firstSignInOpen` while the owner seat
  waits), `mountInviteRoutes` (viewer invites are single-use, expiring `become`
  capabilities, the role grant bounded by what the owner holds) and `mountOwnerClaim`
  (`/?claim=` links from the dashboard). The dashboard's Members section, owner-seat and
  owner-transfer hooks are wired. The worker no longer honours an `x-principal` header at
  all; `ALLOW_DEV_NODE` only addresses an instance for local `wrangler dev`.
- Every request gets the platform's invocation log line and request id; the sweeper records
  the deployed version; provisioning passes `parentScopeId`; a deleted scope drops its
  delivered config.
- Sign-in fallback settings (`AUTH_PROVIDER`, `OIDC_ISSUER`, `OIDC_AUDIENCE`) are declared as
  the manifest's `envSpec`, so they appear in the dashboard's Env tab.
- `model.json` is emitted and checked in beside the client and `openapi.json`.
- `wrangler` is a devDependency (`substrat push` builds with the project's own), and the test
  suite enforces the Durable Object's 50-byte LIKE/GLOB limit.
