# Building on Substrat — agent instructions

This project is a **Substrat vertical**: a multi-tenant business app built on the
Substrat kernel and its engines. This file is the always-on constitution — the rules
that hold no matter what you touch. It is read by every AI tool (Claude Code, Cursor,
opencode); do not duplicate it into tool-specific config.

The full build flow — interview, coverage map, a reviewed design document you approve
before any code, then reshape, run, and the checkpoints — is a **playbook**, not always-on
context. Invoke it when you start or extend a vertical:

- **Claude Code**: `/substrat`
- **Cursor / opencode**: the `new-vertical` command, or read [`.substrat/playbook.md`](.substrat/playbook.md)

Read the playbook before scaffolding. This file is what a session already mid-build
must never violate.

## The mental model

Three layers. You only own the third.

1. **Kernel — free, always.** Tenancy (one scope = one isolated database; there is no
   cross-tenant API), permissions (roles, grants, and a proof path for every decision),
   events + audit (every mutation emits a kernel-stamped event you cannot mislabel),
   migrations (journaled per module, applied lazily per scope).
2. **Engines — compose or feed.** Headless, own invariants that cannot be violated
   (state machines that can't skip states, append-only entries). You either **compose**
   an engine (import it; its in-scope functions run in *your* transaction) or **feed** it
   (emit a fat event; it consumes — no import). Engines never import each other. Read an
   engine's real surface from `node_modules/@substrat-run/engine-*/dist/index.d.ts` —
   never guess at it.
3. **Your vertical — everything a user touches.** Vocabulary, price list, extra fields,
   roles, screens. If your core noun isn't something an engine already owns, this is most
   of the app — a normal, supported outcome.

## Project layout

The linter and tests expect this shape. `manifest`/`migrations`/`module` are **module
code** (the rules below bind them); `seed`/`server` are **harness** (exempt).

```
spec/concept.md        the concept as built — the human half           ← doc
spec/model.ts          defineEntities + defineOperations (http, paged…)  ← module code
src/manifest.ts        moduleManifest, assembled from the model          ← module code
src/migrations.ts      the SqlMigration[] (append-only)                  ← module code
src/module.ts          handlers `satisfies` the model; registration      ← module code
src/provision.ts       MODULES, ROLES, grant shapes — node-free           ← module code
src/geometry.ts        the solver (pure)                                  ← module code
src/dxf.ts             the DXF writer (pure)                              ← module code
src/routes.ts          mountOperations over the model — BOTH hosts        ← harness
src/api.ts             the OpenAPI document, from the model               ← harness
src/seed.ts            host, tenants, demo cast, seed world               ← harness
src/server.ts          the dev entrypoint (node + persona header)         ← harness
src/worker.ts          the deployable Cloudflare worker + the auth seam   ← harness
tools/emit.mts         renders app/src/api.generated.ts + openapi.json    ← harness
app/                   the React SPA (npm); api.generated.ts is emitted
test/scenario.test.ts  the scenario — including the denials
test/server.test.ts    the derived route table, served (401/403/400/404)
test/model.test.ts     the model's fields == the journal's columns
```

**A route is not written; it is declared.** An operation in `spec/model.ts` that
carries `http` is mounted by `mountOperations` in `src/routes.ts` — on both hosts —
and becomes an MCP tool at `/api/mcp`, an entry in `openapi.json` and a method on the
SPA client, all in that one change. Never add a Hono route for an operation to an
entrypoint or to `routes.ts`: it would exist on one host and 404 on the other, and
the scenario tests would never notice. What an entrypoint may still own is only what
is genuinely its own — building a host, resolving a caller, and its auth-shaped
routes (`/api/cast` in dev; `/api/auth/*`, `/api/me`, invites in the worker). After
changing the model run `pnpm emit`; `pnpm lint:generated` fails on drift.

`provision.ts` is deliberately node-free: both hosts register from it (the dev
server's SQLite host and the worker's `ScopeDO`), and `substrat push` reads the
permission registry from it (package.json `substrat.permissions`). Roles or
modules defined anywhere else will run locally and silently not deploy.
`worker.ts` **mounts** the platform's `/internal/*` management contract via
`mountPlatformSurface` from `@substrat-run/vertical-host` (one call — the routes
and the error envelope are authored there, not here, so they can't drift or ship
half-done). What `worker.ts` still owns is **the auth seam**: Triangle is a pure OIDC
relying party (`@substrat-run/vertical-auth`), and the `x-principal` dev header is
honoured only behind `ALLOW_DEV_HEADER`, which is never set in prod — deploying with
it set is a cross-tenant hole with a UI.

**A UI ships as declared assets.** If `app/` exists, `substrat.runtimeNeeds.assets` must
point at its build output and `runtimeNeeds.build` must produce it — otherwise the deployed
vertical serves the API and 404s on `/`, with every local gate green. Declare it in the same
change that creates `app/`, not at deploy time. (`substrat push` refuses an undeclared UI,
but by then you are already deploying.)

Among the hooks it passes, **`onConfigure` is the one you must not drop.** It is
how per-instance settings reach the running app: the dashboard's Settings → Env
and Identity tabs POST to `/internal/configure`, and a vertical that supplies no
hook answers **501** to that call for its whole life — the setting is saved, the
dashboard reports `delivered: false`, and the app never sees it. That includes the
`substrat:auth` issuer choice, i.e. the difference between a working login and
401-on-everything. Triangle stores deliveries in the tenant's `IdentityDO` and reads
them back per request in `authWiringFor`. Read settings that way and never off `env`
directly: an `envSpec` default rides as a worker binding shared by every install of
one serving script, so `env.FOO` is the same string for every tenant.

## The rules (non-negotiable)

**Module code** = everything reachable from a `ModuleRegistration` (operations,
consumers). Rules 1–5 are enforced mechanically by `boundary-lint`.

1. **Data access is `ctx.sql` only.** Never import `better-sqlite3`, an adapter,
   `node:*`, or `cloudflare:workers` in module code. That last one is not a style rule:
   it exports an ambient `env`, so a single import hands module code every binding and
   secret your worker declares — including its own `SCOPE` Durable Object namespace,
   which reaches *another scope's* data. `ctx.sql` is closed over one scope and cannot.
   Capabilities arrive on `ctx`; `DurableObject` is imported in harness code
   (`worker.ts`, `*-do.ts`), never here.
2. **No `fetch` / network in module code.** It would hold the scope's transaction open on
   a third party. The sanctioned path is a **connector**: emit a fat event, register a
   handler that runs outside the transaction. An integration is never impossible because
   of this rule — it has an answer.
3. **Never write `_substrat_*` tables.** Reads are fine (timelines are projections);
   writes forge the audit spine. Do the read with `readTimeline` / `readHistory` from
   `@substrat-run/kernel` rather than a `SELECT` of your own: both take an `EntityRef`,
   page like a list read, and decode the envelope for you. `readHistory` also returns the
   payload, the authorization chain (which checks the operation passed, and under which
   grant), the impersonation stamp and the PII class. On the first three, a `null` is a
   *fact* rather than data you failed to fetch — the payload was erased, the row predates
   authorization recording, nobody was impersonating — so render it as that. Neither
   helper checks a permission; you do, before you call it.
4. **Another module's tables are private.** Never `SELECT` from `workorder_*` etc. — use
   the engine's exported in-scope functions. This is the rule with no runtime equivalent:
   the shortcut *works* and silently welds you to an engine's private schema forever. Need
   extra data on an engine entity? Add **your own side table keyed by the engine's id** —
   never a column upstream.
5. **Time comes from `ctx.now()`.** Module code has no other clock — `new Date()` and
   `Date.now()` are banned exactly like `node:*`. It is the same instant for the whole
   operation, so your rows and the events announcing them agree about when. Store it as
   ISO text, never an epoch integer. Because the host injects the clock, a scenario can
   test elapsed time (`manualClock` from `@substrat-run/kernel`) instead of sleeping or
   shrinking the window to zero — the workaround that proves nothing.
6. **Every operation checks a permission first.** `assertAllowed(await ctx.check(PERM))`
   is the first line.
7. **Every mutation emits a fat event** — a consumer must never need a cross-module read.
8. **Never fork an engine.** Extend by composition. If you must fork, the engine drew its
   line wrong — that's design feedback, not a coding problem.
9. **IDs are `ulid()`. Money is strings** via `@substrat-run/contracts` helpers
   (`moneyOf`, `mulMoney`, `addDecimal`, `compareDecimal`) — never floats.
10. **Web-standard APIs always** — `globalThis.crypto`, `TextEncoder`, `URL`. Never
    hand-roll a hash to dodge an import ban.
11. **Parse, don't trust** — and the **host** is what parses. A module passes
    `operationInputs: operationInputsOf(ops)` beside its `operations`, and every invocation
    is parsed against the declared schema before the guards and the handler, on every path
    in (HTTP, test, seed, schedule). Handlers do not hand-parse; a declared input nobody
    parses stops being possible rather than merely discouraged. Import `z` from
    `@substrat-run/contracts`, **never from `zod`**. Zod schemas don't compose across
    copies or majors; composing a contracts schema into one built from a separate `zod`
    fails at *runtime* (`expected a Zod schema`) with an error pointing nowhere near the
    cause.

## Swallowing an engine error requires `ctx.atomic`

An engine call composed inside your transaction has no boundary of its own. A `catch` that
handles the failure and carries on therefore leaves you holding the engine's partial
writes — the rows its invariants were protecting — and then commits them. Give the call a
boundary instead:

```ts
try {
  await ctx.atomic(() => completeWorkOrder(ctx, { orderId, billable }));
} catch {
  // the engine's rows, events, links and grants are all gone; your own writes
  // survive, and the operation still commits once
}
```

A succeeded `ctx.atomic` is still provisional: if the operation later throws, its writes go
too. Sub-transactions nest but must not interleave — starting two concurrently throws.

The line is whether the failure still reaches the caller. A catch that **swallows** an
engine error — one that does not rethrow — is what needs the boundary, and outside
`ctx.atomic` `boundary-lint` rejects it with **no** escape hatch. A catch that always
rethrows (`catch (e) { log(e); throw e }`) needs nothing, and neither does `try`/`finally`
with no `catch`: the operation still fails and the whole transaction rolls back, which is
already the outcome the rule protects. `ctx.atomic` is what you reach for when you intend
to *continue* past the failure.

"Always rethrows" is read literally — the catch's last statement is the `throw`. A `throw`
buried in an `if` block is not that, because the catch runs on past it.

## Declare every link edge

`entityRelations` in the manifest must declare every edge you traverse — both your own
(`bike → customer`) and the ones an engine makes on your behalf (`workorder → bike`). The
adapter **rejects** a `ctx.link` for an undeclared edge, so a missing one fails loudly.
This is also what lets a portal permission-walk reach the owner.

## Sharing is `ctx.grant` / `ctx.revoke`, not a table

When a person shares their own record with another person — and takes them off it again —
the operation narrows a permission it already holds onto that one entity:

```ts
await ctx.grant(principal, PERM.listContribute, listRef(listId));   // share
await ctx.revoke(principal, PERM.listContribute, listRef(listId));  // un-share
```

Entity-required (module code can never write a scope- or tenant-wide grant), delegating
(the caller's own decision on that entity is re-checked, so an operation can never hand out
more than it holds), and transactional with the operation. Every later `ctx.check` reads
the grant, so nothing else has to remember who may touch what.

Neither alternative is this, so you can tell a real absence from this one: a `ctx.link`
edge is **not revocable at all** — it is permanent — and org membership is revocable but
coarse-grained — a whole org, not one record. Never mint an org per domain row, or a
membership table consulted by hand in every handler, to get a revoke. The two-line
reference is the [todo demo](https://github.com/substrat-run/substrat/tree/main/demos/todo)
(`src/module.ts`, `todo/share-list` and `todo/revoke-share`).

## The gates — run them, believe them

```sh
pnpm test                       # the scenario + the served route table + model parity
pnpm lint:boundaries            # the layer rules (1–5) — also: npx @substrat-run/boundary-lint
pnpm typecheck                  # node + worker targets
pnpm lint:generated             # the emitted client + openapi.json match the model
```

`boundary-lint` exits non-zero if it *couldn't do its job* (no module code found, no
engines resolvable) — a pass that checked nothing is worse than no linter. Never wave that
through; fix the setup until it can see your code.

A green scenario test does **not** mean the app works: the test calls operations directly
and never exercises `server.ts`, its routes, or the principal picker. Before calling a
vertical done, boot the server and drive the real flow over HTTP as two personas — one who
should succeed and one who should be denied — and confirm the denial arrives as a denial
(not a generic error).

## When it breaks — symptom → fix

Six failures that have each cost someone a day. What makes them expensive is that none of
them names its own cause: the symptom points somewhere other than the fix, so an agent
debugging from first principles walks away from the answer.

| Symptom | Fix |
|---|---|
| `expected a Zod schema` at runtime, pointing nowhere useful | Two copies of Zod. Never add `zod` to `package.json` — import `z` from `@substrat-run/contracts`, so the schema you build and the one the host validates with are the same class. |
| Killing the dev server kills unrelated ones too | `pkill -f 'tsx src/server.ts'` matches every Substrat project running on the machine, not just yours. Kill by port instead: `kill $(lsof -ti :<port>)`. |
| Green locally, red in CI, with nothing in the diff that explains it | A warm build output hides it. Delete `dist`, reinstall from the lockfile (`--frozen-lockfile`), and re-run the gates before believing a local green. |
| Green test suite, broken app | The scenario calls operations directly and never reaches `server.ts`, its routes, or the principal picker. Boot the server and drive the flow over HTTP as two personas — one who should succeed and one who should be denied. |
| Permission denied after you widened a role | Roles are projected into a scope when that scope is provisioned, from `ROLES` in `src/provision.ts`. An existing scope keeps the projection it was born with — re-provision it (or re-seed onto a fresh data directory), then present the permission diff below. |
| `pnpm install` dies compiling `better-sqlite3` | Take `better-sqlite3` out of `pnpm.onlyBuiltDependencies`. Since 13.x it ships prebuilt binaries and no install script, but it still ships a `binding.gyp` — so an allowlist entry makes pnpm run a `node-gyp rebuild` that nothing here needs. |

## Two human checkpoints — you may never self-approve

Present these and stop:

1. **Migration diff** — every new `SqlMigration`, verbatim. Migrations are append-only
   forever once shipped, so this is the last cheap moment to change your mind.
2. **Permission diff** — a table: key → description → which roles hold it → why. Walk the
   reviewer through it in their own vocabulary until they can answer *who can now see the
   money, and who can see other tenants' data?* A permission diff nobody understands is
   theater — it reproduces the exact failure Substrat exists to prevent.

---

## This vertical: Triangle — garden survey & planning

The approved concept is [`spec/concept.md`](spec/concept.md) (v0.4, the concept as
built); the model it describes is [`spec/model.ts`](spec/model.ts); the UI design
handover the app skin follows is `design/handover/Triangle.dc.html`. Read the concept
and the model before changing behavior — and change the model first: everything
else is derived from it.

**The domain.** A garden is surveyed with a 20 m tape: named **points** with
**elevations** (meters vs a chosen datum), fixed by pairwise **measurements**
(entered in **cm**, stored in meters). The **solver** (`src/geometry.ts`, pure —
no kernel imports) triangulates: first point = origin, second = baseline on +x;
a point with exactly two distances has two mirror candidates and waits for a
**side choice** (`garden/choose-side`); a third distance auto-resolves and yields
**residuals** (cm; green ≤ 2, amber ≤ 5, red above). **Constraints** (right-angle,
parallel, equal-length, colinear) are assumptions with their own residuals — they
enter the adjustment at HALF the weight of tape measurements, so the app never
quietly bends real numbers to fit one; preview before apply (`garden/preview-constraint`).
**Features** (retention-wall, pool, terrace, stairs, house, fence, bed, path) are
ordered point-runs, per-segment straight/curved; they never store coordinates.
**Plants** sit at points with species from `garden_species` (mature canopy drawn on
the map and in DXF). **DXF export** (`src/dxf.ts`, pure) is ASCII R12; point Z =
elevation; curves sampled to polylines. SKP is a deliberate no.

**The solver is the only writer of `garden_points.x/y/status`** — mutations re-solve
via `runSolve` and return what moved; nothing moves silently.

**The model is the source (concept §8).** `spec/model.ts` declares eight entities and
23 operations. From it: `src/manifest.ts` (permissions, events, entity relations,
paged lists), `operationInputs` (the host parses every invocation), `operationConcurrency`
(`If-Match` on `update-point` / `update-feature`), the route table on both hosts,
the MCP endpoint at `/api/mcp` (`whoami` opts out), `/api/openapi.json` and
`app/src/api.generated.ts` (`pnpm emit`). Paged reads (`list-sites`, `list-species`,
`timeline`) return a `Page` in process and a bare array + `Link` header on the wire.
Errors are RFC 9457 problem documents: `permission_denied` → 403, `validation_failed`
→ 400, `not_found` → 404, a point in use → 409 (`substratError('conflict', …)`).
The DXF download is built in the browser from the `export-dxf` JSON — there is no
file route, so the surface stays fully declared. `test/model.test.ts` holds the
model's fields to the migration journal's columns; change both together.

**Cast & tenancy (concept §4/§6).** Roles: `garden-owner` (garden:manage +
garden:read), `garden-viewer` (garden:read — sees everything, changes nothing,
may preview constraints and export DXF). Seed world (`src/seed.ts`): tenant **Casa
Markus** (markus = owner, vera = viewer) and tenant **Vecino** (nils = its owner, the
cross-tenant attacker the scenario proves gets nothing). No engines composed;
`engine-invoicing` is reserved for future vivero quotes (no VAT concept — a known gap
recorded in the concept). Viewer invites ride the identity directory (below), not
`engine-invites`.

**Auth (vertical-auth-detach).** Deployed, Triangle is a pure OIDC **relying
party** — the standard is always a separate issuer (an Auth Server app in the
team, or external OIDC), never per-app credentials. `src/worker.ts` binds the
shared `IdentityDO` (`@substrat-run/vertical-auth`, from the registry) as the
`AUTH` store: it holds the `sub → principal` directory, the owner TOFU claim
(first sign-in claims the seat `onProvision` recorded), invites, and the
platform-delivered `substrat:auth` config (`onConfigure`) that `authProviderFor`
builds the RP from per request. The issuer is chosen at APP CREATION in the
dashboard's Identity section — an install created without it stays unwired.
`garden/whoami` (no new permission keys) gives the SPA its role hint; `/api/me`
drives the sign-in screen; viewer invites are `POST /api/invites` (owner-only)
→ accept link → the claim binds the invitee's issuer identity.

**Run it.** `pnpm dev` starts the API (:8871, tsx watch) + the Vite app (:5174,
proxies /api). `pnpm test` = solver unit tests + the scenario incl. denials + the
served route table + model parity. `pnpm lint:boundaries` and `pnpm lint:generated`
must stay green. LOCAL dev auth is still the `x-principal` header (markus | vera |
nils) — worker-side it only exists behind `ALLOW_DEV_HEADER`, never set in prod.
Dev data lives in `.data/` (regenerated from seed — safe to wipe). The app under
`app/` uses **npm**, the root uses **pnpm**.

**Deploy.** `substrat push` (slug `triangle`). The SPA ships as NATIVE platform
assets — `substrat.runtimeNeeds.assets` points at `app/dist`, the `build` command
produces it, `runWorkerFirst` keeps `/api/*` + `/internal/*` on the worker and
everything else on the edge with SPA fallback. Never inline assets into the
worker. Deployed, `/api/cast` is empty → the app hides the principal picker and
keys its state off `/api/me`: signed-out → the sign-in screen (→ `/api/auth/login`
→ issuer → callback → cookie session); `needs-setup` → "first sign-in claims this
garden". The auth choice is create-time only — re-create the app in the dashboard
picking the Auth Server; a re-pointed issuer would orphan `sub → principal`
bindings.

**Release.** Versioning is owned by changesets. Record intent while working
(`pnpm changeset`); release with `pnpm release` — it runs the gates, `changeset version`
bumps `package.json` + writes `CHANGELOG.md`, then `substrat push --promote prod`
deploys that exact version. Never hand-edit the version and never release via a bare
`substrat push` (its auto-bump drifts the registry away from `package.json`).
