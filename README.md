# Triangle

Garden survey & planning with a 20 m tape — a multi-tenant vertical on
[Substrat](https://substrat.net). Name points, tape the distances, let the solver
place them, draw the walls and the pool on top, plant from a species library, export
DXF. Owners survey; invited viewers see everything and change nothing.

The concept as built is [`spec/concept.md`](spec/concept.md). The model it describes —
eight entities, 23 operations — is [`spec/model.ts`](spec/model.ts), and everything
else is derived from it: the manifest, the host-side input parsing, the route table on
both hosts, the MCP endpoint at `/api/mcp`, `openapi.json` and the SPA client. The
always-on rules an agent must not violate live in [`AGENTS.md`](AGENTS.md).

## Run it

```sh
pnpm install
pnpm dev                  # API on :8871 (tsx watch) + the Vite app on :5174
```

Locally the app shows a persona picker: **markus** (owner), **vera** (viewer) and
**nils** (the neighbour, in another tenant). Deployed, sign-in is an OIDC round-trip
against the issuer chosen when the app was created.

## Gates

```sh
pnpm test                 # the scenario incl. denials, the served route table, model parity
pnpm lint:boundaries      # the layer rules (also: npx @substrat-run/boundary-lint)
pnpm typecheck            # node + worker targets
pnpm lint:generated       # app/src/api.generated.ts + openapi.json match spec/model.ts
```

After changing `spec/model.ts`, run `pnpm emit` and commit the regenerated artifacts.

## Release

`pnpm changeset` to record intent; `pnpm release` runs the gates, versions with
changesets and deploys with `substrat push --promote prod`.
