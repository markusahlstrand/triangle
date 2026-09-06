---
"triangle": minor
---

Move to Substrat 0.98 and make the model the source of every surface.

- **Packages** — `kernel`, `contracts`, `adapter-sqlite`, `adapter-cloudflare`,
  `vertical-host` 0.63 → 0.98.1; `vertical-auth` 0.7 → 0.12.1; `boundary-lint`
  0.0.7 → 0.4.1; `@substrat-run/model-emit` added (dev) to render the client.
  Toolchain: vitest 5, changesets 3.0.2, hono 4.13.7, workers-types 2026-09-06.
- **`spec/model.ts`** — the eight `garden_*` entities and all 23 operations declared
  once with `defineEntities` / `defineOperations`: permission, input, output, `http`,
  `paged`, `concurrency`, `emits`. `src/manifest.ts` is assembled from it; the host
  now parses every invocation (`operationInputs`) and guards the two field-bag
  updates with `If-Match` (`operationConcurrency`).
- **Routes are derived** — `src/routes.ts` mounts the model with `mountOperations`
  on both hosts. The hand-written `/api/invoke` and the DXF file route are gone; the
  DXF download is built in the browser from the `export-dxf` JSON. Every operation
  with `http` is also an MCP tool at `/api/mcp` (`whoami` opts out) and an entry in
  the OpenAPI document served at `/openapi.json` and checked in as `openapi.json`.
- **Paged reads** — `list-sites`, `list-species` (kernel-composed) and `timeline`
  (via `readHistory`, with the fat payload) return a `Page` in process and a bare
  array + `Link` header on the wire. In-process callers read `.entries`.
- **Errors** — RFC 9457 problem documents via `problemResponse`: denials 403,
  parse failures 400 naming the field, missing things 404, a point in use 409.
- **Generated client** — `pnpm emit` renders `app/src/api.generated.ts` and
  `openapi.json`; `pnpm lint:generated` fails on drift and is part of `pnpm release`.
  The SPA calls typed methods instead of `invoke('garden/…')`.
- **Rule R6** — module code takes time from `ctx.now()`; the `new Date()` the new
  boundary-lint flagged is gone.
- **Docs** — `DESIGN.md` became `spec/concept.md` (v0.4, the concept as built);
  AGENTS.md and `.substrat/playbook.md` refreshed from the 0.98 scaffold; the
  session-start hook and `.claude/settings.json` added so every session announces the
  installed kernel and its docs slice.
- **Tests** — `test/server.test.ts` drives the derived route table over HTTP as
  owner, viewer and neighbour; `test/model.test.ts` holds the model's fields to the
  migration journal's columns.

Behavior changes for API callers: responses of `update-point`, `choose-side`,
`add-measurement` and `add-constraint` gain a top-level id field; `export-dxf`
answers JSON (`siteId`, `filename`, `dxf`) at `GET /api/sites/{siteId}/dxf`;
`upsert-species` requires `category`; `SolveReport` carries `siteId`.
