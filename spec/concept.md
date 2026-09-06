# Triangle — a garden survey & planning app

Status: v0.4 · Last updated: 2026-09-06 · Supersedes `DESIGN.md` v0.3 (v0.1 approved
2026-08-09; v0.2 folded in the review answers; v0.3 added constraints from the UI
handover in `design/handover/`; v0.4 is the concept **as built** on Substrat 0.98 —
the real tables, the declared operation surface, the auth that shipped).

This document is the human half of the app. The machine half is
[`spec/model.ts`](model.ts): every entity and operation the concept names is declared
there once, and the manifest, the host-side input parsing, the route table, the MCP
tool list, the OpenAPI document and the SPA client are all derived from it. When the
two disagree, the code is wrong or this page is stale — never "both are right".

## 1. What we're building & who uses it

An app for mapping and planning a real garden with nothing but a 20 m tape measure.
You walk the garden, name physical points (a corner of the house, the end of a
retention wall, the edge of the pool), and record distances between them. The app
triangulates those distances into a 2D map, lets you draw the garden's features on
top of the points — retention walls, pool, terrace, stairs, the house — place plants
from a species library, and export the whole thing as DXF for CAD tools.

Two kinds of people use it, in the same app: the **garden owner** who surveys and
plans, and a **viewer** the owner invites, who sees everything and changes nothing.
Today the owner is Markus and the viewer is Vera. A much later door — selling
licenses or producing quotes for viveros — stays open and unbuilt (§3, §12).

## 2. The thing that moves through the system

The core object is the **survey point**. Its life:

1. **Named** — created with a name ("house SW corner"), no position yet.
2. **Measured** — one or more tape distances recorded to other points.
3. **Placed** — the solver has coordinates for it. The first point is the origin; the
   second defines the baseline on +x. From then on, a point needs distances to **at
   least two placed points**. Two distances give two mirror-image candidates — you
   pick which side of the line it is on; a third distance resolves it automatically
   and lets the solver report a **residual** (how well your tape pulls agree, in cm:
   green ≤ 2, amber ≤ 5, red above).
4. **Locked** (optional) — you are happy with its position; later measurements adjust
   other points around it, not it.

Deleting a measurement can demote a point back to *measured*; the solver always
recomputes from the surviving measurements. **The solver is the only writer of a
point's coordinates**: every mutation that changes the survey re-solves, persists, and
answers with what moved and by how much. Nothing moves silently.

Every point carries an **elevation** in meters relative to a datum you choose
("terrace floor = 0.00"), entered by hand. Distances are entered the way the tape
reads them — **in centimeters** — and stored in meters.

Besides distances, the solver accepts **constraints** — assumptions stated as
equations: a **right angle** at a point between two neighbours, two segments
**parallel**, two segments of **equal length**, or points **colinear** along one wall
face. Constraints are assumptions, not measurements, so they enter the adjustment at
**half the weight** of a tape pull and carry their own residual: if the tape later
disagrees with an assumed right angle, the *constraint* goes amber — the app never
quietly bends real numbers to fit an assumption. A constraint is **previewed** before
it is applied: the dry run reports what it would move.

**Features** are drawn over placed points: a retention wall is an ordered run of
points; the pool, terrace and house are closed loops; stairs are a run with a step
count. Each segment between two consecutive points is **straight** or **curved** (a
smooth curve fitted through the surrounding points). Features never store their own
coordinates — move a point and every feature built on it follows.

**Plants** sit at a point (one point = one planting spot), with a species from the
library. The library carries mature canopy and height so the map can draw the mature
canopy today, and a future "watch the trees grow" view needs no schema change.

## 3. What already exists vs. what's yours

Honest split: **most of this app is ours.** The solver, the interactive map, DXF export
and the species library are domain code no engine provides. What Substrat contributes
is the foundation that makes the multi-user shape free instead of a rewrite.

**From the kernel (free, day one):**
- **Tenancy** — each garden owner is a tenant with an isolated database. Another
  tenant's owner cannot see this garden by construction; there is no API for crossing
  over.
- **Permissions** — the owner/viewer split is two permission keys and two roles, not
  custom code. Every operation checks one first.
- **Audit trail** — every measurement, every re-solve, every moved point is an event
  with who/when stamped by the kernel. "Why did the pool move 12 cm last Tuesday" has
  an answer, and the app reads it back through the kernel's own history reader.
- **Migrations** — schema changes are journaled and applied per garden.
- **Host-side parsing** — every invocation is parsed against the declared input
  schema before a handler runs, on every path in (HTTP, test, seed, MCP).
- **Derived surfaces** — the route table, the MCP endpoint, the OpenAPI document and
  the SPA client all come from the declarations in `spec/model.ts`.

**From the platform's shared packages:**
- **Identity** (`@substrat-run/vertical-auth`) — the per-tenant identity directory
  (`IdentityDO`): subject → principal, the owner's first-sign-in claim, viewer
  invites. Triangle is a pure OIDC relying party; the issuer is chosen when the app is
  created in the dashboard.
- **The management contract** (`@substrat-run/vertical-host`) — `/internal/*`
  provisioning, snapshots, restore, config delivery; mounted in one call.

**Engines composed now: none.** `workorder`, `protocol` and `booking` don't fit a
garden map, and pretending otherwise would be forcing it. Reserved by design:
`engine-invoicing` for vivero quotes, if that day comes — recorded with two caveats:
it produces invoices, not quotes, and it has **no VAT/IVA concept**, a gap that would
be ours to fill before any real Spanish invoice goes out.

**Ours (the app):** the triangulation solver (`src/geometry.ts`, pure), the map
canvas, feature types, the species library and its starter content, DXF export
(`src/dxf.ts`, pure), and every screen.

## 4. Who can do what

Two roles, two permission keys, and the two questions that matter:

- **Who can see the money?** Nobody — there is no money (§5).
- **Who can see other people's gardens?** Nobody, ever. A garden lives in its
  owner's tenant. This is enforced by the database layout, not by a filter someone
  could forget.

| Role | Holds | Can | Cannot |
|---|---|---|---|
| **garden-owner** | `garden:manage`, `garden:read` | Everything in their own tenant's gardens: points, tape pulls, constraints, solve, features, plants, species, exports, the audit trail, inviting viewers | See or touch any other tenant's garden |
| **garden-viewer** | `garden:read` | View the map, points, features, plants and the audit trail of the gardens in the tenant; preview a constraint; export DXF | Add / edit / delete anything; invite anyone; see other tenants' gardens |

Both roles are held **tenant-wide**. An entity-narrowed shape (`garden:read` on one
site) is declared in `src/provision.ts` for a future per-garden invite, but nothing
grants it yet.

The tests prove the denials, not just the happy path (§10).

## 5. Money & sign-off

**None.** No invoice, no quote, no receipt, nothing gated on a signature.

## 6. The cast, roles, tenancy and sign-in

**Two tenants, always** — the second exists to be attacked, which is how isolation is
proven rather than claimed. Seeded by `src/seed.ts`, through the operations (never
raw SQL), so the seed exercises the same permission checks and solver the app does.

| who | tenant | role | what they are |
|---|---|---|---|
| Markus | Casa Markus | garden-owner | surveys and plans |
| Vera | Casa Markus | garden-viewer | sees everything, changes nothing |
| Nils | Vecino | garden-owner (of Vecino) | the neighbour — the cross-tenant attacker who must reach nothing of Casa Markus |

One tenant = one household; a tenant may hold several gardens (rows, not tenants).

**Sign-in, locally:** the dev server (`pnpm dev`) resolves the caller from an
`x-principal` header naming a member of the cast, and the app shows a persona picker.
Every entry is a real principal with real permission tuples — nothing is a bypass —
but it is a dev seam: the worker only honours the header behind `ALLOW_DEV_HEADER`,
never set in production.

**Sign-in, deployed:** an ordinary OpenID Connect round-trip against the issuer chosen
when the app was created (an Auth Server app in the team, or an external provider).
The worker builds the relying party per request from the delivered `substrat:auth`
config; the tenant's identity directory maps the verified subject to a principal. The
**first sign-in claims the owner seat** the install recorded. Viewers join through an
invite the owner mints (`POST /api/invites`): the accept link binds the invitee's
issuer identity to a pre-minted principal holding `garden-viewer`.

## 7. The data we store

All tables are the vertical's own (prefix `garden_`), declared as entities in
`spec/model.ts` and created by the append-only journal in `src/migrations.ts`.
`test/model.test.ts` holds the two to each other, column for column.

| entity | table | columns | notes |
|---|---|---|---|
| **site** | `garden_sites` | id, name, datum_note, created_at | a garden |
| **point** | `garden_points` | id, site_id, seq, name, elevation_m, x, y, status, side, locked, note, created_at | `x`/`y` are solver output; `status` ∈ named · measured · placed; `side` ∈ −1 · 1 · null |
| **measurement** | `garden_measurements` | id, site_id, point_a, point_b, distance_m, note, created_at | a tape pull, in meters |
| **constraint** | `garden_constraints` | id, site_id, kind, points_json, created_at | `kind` ∈ right-angle · parallel · equal-length · colinear |
| **feature** | `garden_features` | id, site_id, type, name, closed, props_json, created_at | `type` ∈ retention-wall · pool · terrace · stairs · house · fence · bed · path |
| **featureVertex** | `garden_feature_vertices` | feature_id, seq, point_id, curved_to_next | keyed by (feature_id, seq) — the ordered point-run |
| **species** | `garden_species` | id, common_name, latin_name, category, mature_canopy_m, mature_height_m, years_to_mature, created_at | `category` ∈ tree · shrub · hedge · perennial · climber |
| **plant** | `garden_plants` | id, site_id, point_id, species_id, label, planted_on, note, created_at | `label` falls back to the species' common name |

Ids are ULIDs; timestamps are ISO-8601 text from `ctx.now()`; lengths and coordinates
are meters. Every point, measurement, constraint, feature and plant is **linked to its
site** — the declared parent edges — which is what a future per-garden grant would
walk. Every name promised on an output artifact has a source here: DXF point labels
come from `point.name`, feature layers from `feature.type`, plant labels from
`plant.label` falling back to `species.common_name`.

**DXF export** (an artifact, not a table): ASCII DXF R12, 2D top view. Layers
`POINTS`, `POINT-LABELS` (name + elevation), one `FEATURE-<TYPE>` per feature type,
`PLANTS` (a circle at mature canopy diameter) and `PLANT-LABELS`. Point Z = elevation.
Curved segments export as densely sampled polylines. **SKP is a deliberate no** —
closed format, no writer outside SketchUp's SDK; DXF is the interchange path.

## 8. The API surface — derived, never written

Every operation below is declared once in `spec/model.ts`. `mountOperations` derives
the route table at mount time on **both** hosts (`src/routes.ts`), the same
declarations answer as MCP tools at `/api/mcp`, `src/api.ts` renders the OpenAPI
document (served at `/api/openapi.json`, checked in as `openapi.json`), and `pnpm emit`
renders the SPA client (`app/src/api.generated.ts`). `pnpm lint:generated` fails on
drift. Paths are under `/api`.

| operation | route | needs | answers |
|---|---|---|---|
| `garden/create-site` | `POST /sites` | manage | the site |
| `garden/list-sites` | `GET /sites` | read | page of sites with counts (walk via `Link`) |
| `garden/get-site` | `GET /sites/{siteId}` | read | the whole garden + a read-only solve |
| `garden/create-point` | `POST /sites/{siteId}/points` | manage | the point |
| `garden/update-point` | `PATCH /points/{pointId}` | manage | point + solve report; honours `If-Match` (412 when stale) |
| `garden/delete-point` | `DELETE /points/{pointId}` | manage | deleted id + solve report; **409** if a feature or plant uses it |
| `garden/choose-side` | `POST /points/{pointId}/side` | manage | point + solve report |
| `garden/add-measurement` | `POST /sites/{siteId}/measurements` | manage | measurement + solve report |
| `garden/delete-measurement` | `DELETE /measurements/{measurementId}` | manage | deleted id + solve report |
| `garden/preview-constraint` | `POST /sites/{siteId}/constraints/preview` | read | a solve report — writes nothing |
| `garden/add-constraint` | `POST /sites/{siteId}/constraints` | manage | constraint + solve report |
| `garden/delete-constraint` | `DELETE /constraints/{constraintId}` | manage | deleted id + solve report |
| `garden/solve` | `POST /sites/{siteId}/solve` | manage | the solve report |
| `garden/create-feature` | `POST /sites/{siteId}/features` | manage | the feature |
| `garden/update-feature` | `PATCH /features/{featureId}` | manage | the feature; honours `If-Match` |
| `garden/delete-feature` | `DELETE /features/{featureId}` | manage | deleted id |
| `garden/list-species` | `GET /species` | read | page of species |
| `garden/upsert-species` | `PUT /species` | manage | the species |
| `garden/add-plant` | `POST /sites/{siteId}/plants` | manage | the plant |
| `garden/remove-plant` | `DELETE /plants/{plantId}` | manage | deleted id |
| `garden/export-dxf` | `GET /sites/{siteId}/dxf` | read | `{ filename, dxf }` — the app turns it into a download |
| `garden/timeline` | `GET /entities/{entityType}/{entityId}/timeline` | read | page of history entries with the fat payload |
| `garden/whoami` | `GET /whoami` | read | `{ role }` — the shell's hint; not an MCP tool |

Conventions the platform supplies and the app relies on: a refused permission is a
**403** `application/problem+json` document with `code: permission_denied`; an input
that fails to parse is a **400** with `code: validation_failed` naming the field; a
missing thing is **404**; the vertical's own refusals ("a distance needs two different
points") are **400**. Paged reads answer the bare array and carry the walk in `Link`
(and `X-Total-Count` where declared). Every unsafe method honours `Idempotency-Key`.

Host-specific routes that are genuinely not part of the model: `GET /api/cast` (the
dev persona picker, dev server only), `/api/auth/*`, `GET /api/me`, the invite
routes and `POST /api/accept-invite` (worker only), and `/internal/*` (the platform's
management contract, worker only).

## 9. The screens

Mobile-first — the phone in one hand and the tape in the other. Big touch targets,
high contrast for sunlight; desktop gets the same app with more room.

- **Gardens** — the tenant's gardens as cards with counts; owners create one.
- **Map** — an SVG canvas in garden meters: placed points with names and elevations,
  features drawn by type, tape lines and constraint marks as thin scaffolding, mature
  canopies as circles, unplaced points in a tray, mirror candidates as solid/dashed
  markers to tap. Overlay toggles; DXF download; a "+ Measurement" button for owners.
- **List** — tabs for points, measurements (with residuals), features, plants and
  constraints (with their own residuals).
- **Sheets** — new point (with origin/baseline guidance), new measurement (the hot
  path: pick two points, a numeric keypad in cm, "save & next"), point detail
  (measurements, elevation, lock, delete), which-side, constraint (kind → points →
  **preview** → apply), feature editor (list-based tracing, straight/curved per
  segment), plant placement (species library → point).

A viewer gets the same views with every editing affordance **gone**, not disabled,
plus a VIEWING badge. Deployed, a signed-out visitor sees the sign-in screen; an
unclaimed install says "the first sign-in claims this garden".

## 10. The scenario the tests replay

`test/scenario.test.ts` drives the operations in-process against the seeded world;
`test/server.test.ts` drives the derived route table over HTTP with `app.request`;
`test/geometry.test.ts` pins the solver; `test/model.test.ts` holds the model to the
journal.

**The happy path.** The seeded survey (a 12.40 × 8.20 m house with both diagonals, a
right-angle constraint, a pool 1.2 m below the datum, an olive spot) solves to the
real rectangle with an RMS under 2 cm. A new point with two distances waits for its
mirror choice and lands on the chosen side. A lying tape pull (8 cm long) surfaces as
a residual spread by adjustment, and deleting it restores the survey. A constraint
previews its shove without touching the stored map. The DXF carries every promised
layer, the labelled points with elevations, the plant label and the olive's canopy
circle. The audit trail answers "why did the pool move" with the fat payload.

**The denials that prove it.**
- Vera reads the map, previews and exports — and every write is a shut door, each a
  403 problem document over HTTP and a `permission denied` in process.
- Nils, under his own tenant, cannot even mint a stub on Casa Markus's scope; with the
  right pair he holds no tuples there and every operation is denied. His own list
  never shows Casa Markus.
- A point a wall stands on refuses deletion (409); a zero-length tape pull is refused;
  a negative distance is a 400 naming the field.
- A control beside each: the same doors open for Markus, so the shut ones are not
  passing because every door is shut.

## 11. Decisions taken

- **Units** — meters with cm precision; the tape reads cm, the store holds meters.
- **Mirror choice** — with exactly two distances the app asks "which side?" once and
  remembers; a third measurement resolves it automatically.
- **Constraints** — half the weight of measurements; always previewed before applied.
- **DXF flavour** — ASCII R12, 2D entities with Z on points; no splines or blocks.
- **Concurrency** — the two field-bag updates (point, feature) declare `concurrency`;
  a client that sends the `ETag` it read gets a 412 instead of a lost update.
- **Auth** — OIDC relying party only, issuer chosen at app creation; the local dev
  seam is the persona header, never deployed.
- **Routes** — derived from the model; no hand-written route table, no generic
  invoke. The DXF download is built in the browser from the JSON answer rather than
  served as a file route, so the surface stays entirely declared.
- **Deploy** — the SPA ships as native platform assets from `app/dist`; `/api/*` and
  `/internal/*` stay on the worker.

## 12. Out of scope / deferred

- **3D view** — the data (x, y, elevation) already supports it.
- **Growth over time** — the species schema already carries the numbers.
- **Per-garden viewer grants** — the entity-narrowed shape is declared; invites grant
  the tenant-wide viewer role today.
- **Quotes / licenses / any money** — recorded as a future in §3, nothing built.
- **SKP export** — honest no (closed format); DXF is the interchange path.
- **GPS / RTK / photo import** — tape measure only, by design.
- **Search** — a garden has tens of points; the list tabs are the search.

---

## Review history

- **v0.1 (2026-08-09)** approved: pairwise tape distances only (no angles or offsets);
  features as point-runs with straight or curved segments; owner + viewer is the whole
  cast, no editor role.
- **v0.2** folded those answers in; mobile-first UI.
- **v0.3** added constraints from the UI handover.
- **v0.4 (2026-09-06)** the concept as built: the entity/operation model in
  `spec/model.ts`, derived routes/MCP/OpenAPI/client, OIDC relying-party auth with
  the identity directory, viewer invites, the audit read through `readHistory`.
