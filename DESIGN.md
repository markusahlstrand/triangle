Status: v0.3 · Last updated: 2026-08-09 · v0.1 approved 2026-08-09; v0.2 folds in the review answers (pairwise distances confirmed, straight/curved segments, owner+viewer cast confirmed, mobile-first UI); v0.3 adds **constraints** from the approved UI design handover (`design/handover/`)

# Triangle — a garden survey & planning app

## 1. What we're building & who uses it

An app for mapping and planning a real garden with nothing but a 20 m tape measure.
You walk the garden, name physical points (a corner of the house, the end of a
retention wall, the edge of the pool), and record distances between them. The app
triangulates those distances into a 2D map, lets you draw the garden's features on
top of the points — retention walls, pool, terrace, stairs, the house — place plants
from a species library, and export the whole thing as DXF for use in CAD tools.

Today the only user is Markus, the garden owner. The design keeps two doors open
without building them yet: **inviting read-only viewers** to a garden, and — much
later — **selling licenses or producing quotes for viveros** (price per tree etc.).

## 2. The thing that moves through the system

The core object is the **survey point**. Its life:

1. **Named** — created with a name ("house SW corner"), no position yet.
2. **Measured** — one or more tape distances recorded to other points.
3. **Placed** — the solver has coordinates for it. The first point is the origin;
   the second defines the baseline direction. From then on, a point needs distances
   to **at least two placed points**. Two distances give two mirror-image candidate
   positions — you pick which side of the line it's on; a third distance resolves it
   automatically and lets the solver report a **residual** (how well your tape
   measurements agree, in cm).
4. **Locked** (optional) — you're happy with its position; later measurements adjust
   other points around it, not it.

Deleting a measurement can demote a point back to *measured/unplaced*; the solver
always recomputes from the surviving measurements. Nothing is ever silently moved:
every re-solve is an explicit action with a visible before/after.

Every point carries an **elevation** in meters relative to a datum point you choose
(e.g. "terrace floor = 0.00"), entered by hand (hose level, laser, or estimate).

Distances are entered the way the tape reads them — **in centimeters** ("A → B:
267") — and stored in meters.

Besides distances, the solver accepts **constraints** — assumptions stated as
equations: a **right angle** at a point between two neighbours, two segments
**parallel**, two segments of **equal length**, or points **colinear** along one
wall face. On a rectangular terrace a right angle replaces the awkward diagonal
tape pull. Constraints are assumptions, not measurements, so they carry their own
residual: if the tape later disagrees with an assumed right angle, the *constraint*
goes amber — the app never quietly bends real measurements to fit an assumption.
Applying a constraint previews how far it will move each affected point before it
is accepted.

**Features** are drawn over placed points: a retention wall is an ordered run of
points; the pool, terrace and house are closed loops of points; stairs are a run
with a step count. Each segment between two consecutive points is either
**straight** or **curved** (a smooth curve fitted through the surrounding points —
so a rounded pool edge needs fewer surveyed points). Features never store their
own coordinates — move a point and every feature built on it follows.

**Plants** are placed at a point (one point = one planting spot), with a species
chosen from the library. The library schema carries growth parameters (canopy
diameter and height by age) so the future "watch the trees grow" view needs no
schema change — only a UI.

## 3. What already exists vs. what's yours

Honest split: **most of this app is yours.** The hard parts — the triangulation
solver, the interactive map, DXF export, the species library — are domain code no
engine provides. What Substrat contributes is the foundation that makes the
*multi-user future* free instead of a rewrite.

**From the kernel (free, day one):**
- **Tenancy** — each garden owner is a tenant with their own isolated database.
  Today that's just you; the day you sell a license, customer #2 is another tenant
  and cannot see your garden by construction — there is no API for crossing over.
- **Permissions** — the owner/viewer split is a grant shape, not custom code.
- **Audit trail** — every measurement, every re-solve, every moved point is an
  event with who/when stamped by the kernel. For a survey tool this is genuinely
  useful: "why did the pool move 12 cm last Tuesday" has an answer.
- **Migrations** — schema changes are journaled and applied per garden.

**Engines composed now:** none. (`workorder`, `protocol`, `booking` don't fit a
garden map, and pretending otherwise would be forcing it.)

**Engines reserved for later, by design:**
- `engine-invites` — the "invite a viewer" flow, when you want it. Invitations
  confer nothing until accepted and identifiers are stored hashed, so the app can
  never be used to check who's on the platform.
- `engine-invoicing` — vivero quotes, if that day comes: the app would emit a
  billable event per tree/line and invoicing accumulates it. Two honest caveats
  recorded now: it produces *invoices*, not quotes (a quote flow would be partly
  yours), and it has **no VAT/IVA concept** — that gap is yours to fill before any
  real Spanish invoice goes out.

**Yours (Tier 3 — the app itself):**
- The triangulation solver (baseline fix, two-circle intersection with mirror
  choice, least-squares adjustment when over-measured, residual reporting).
- The 2D map canvas: pan/zoom, points with names + elevations, features drawn by
  type (straight and curved segments), tape measurements optionally shown as
  construction lines.
- The app surface is **mobile-first** — you'll have the phone in one hand and the
  tape in the other. Two primary views, toggled: **List view** (fast entry:
  points, measurements with a numeric keypad in cm, features) and **Map view**
  (the canvas). Big touch targets, high contrast for sunlight. Desktop gets the
  same app with more room, not a separate one.
- Feature types and their properties (wall, pool, terrace, stairs, house, fence,
  bed, path).
- The species library and its starter content; import of more species from JSON.
- DXF export (see §5).
- All screens.

**Not in scope for Substrat at all:** 3D rendering and the growth-over-time view
are pure frontend, deferred (§10).

## 4. Who is denied what

Two roles, and the two questions that matter:

- **Who can see the money?** Nobody — there is no money in v1 (§5). When quotes
  arrive, price data will be owner-only by default; viewers see the garden, never
  prices.
- **Who can see other people's gardens?** Nobody, ever. A garden lives in its
  owner's tenant. A viewer sees exactly the gardens they were invited to. Another
  tenant's owner sees *nothing* of yours — this is enforced by the database layout,
  not by a filter someone could forget.

| Role | Can | Cannot |
|---|---|---|
| **garden-owner** | Everything in their own garden: points, measurements, solve, features, plants, exports, (later) invites | See or touch any other tenant's garden |
| **garden-viewer** *(future, designed now)* | View the map, points, features, plants of gardens they were invited to; export DXF | Add/edit/delete anything; see prices (when prices exist); see other gardens; invite anyone |

The scenario test (§8) proves the denials, not just the happy path.

## 5. Money & sign-off

**None in v1.** No invoice, no quote, no receipt, nothing gated on a signature.
The vivero-quote future is recorded in §3 so the door stays open; it is explicitly
out of scope now (§10).

## 6. The cast, roles, and tenancy

- **Markus** — `garden-owner` of tenant *Casa Markus*.
- **A second tenant always exists in the seed** — *Vecino* (a neighbour's garden,
  its own owner). It's there to be attacked: the scenario test logs in as the
  neighbour and proves they get nothing of yours. Isolation is demonstrated, not
  claimed.
- **A viewer principal** exists in the seed with the `garden-viewer` role on Casa
  Markus, so the read-only story is tested from day one even though real invites
  come later.

One tenant = one garden owner (a household). A tenant can hold several gardens
(or several versions/sketches of one garden) — they're rows, not tenants.

## 7. The data we'll store

All tables belong to the vertical (prefix `garden_`), in plain terms:

- **`garden_site`** — a garden: id, **name** ("Casa Markus"), datum note ("terrace
  floor = 0.00"), created.
- **`garden_point`** — id, site, **name** ("house SW corner"), elevation (m,
  nullable until measured), solved x/y (m, nullable until placed), status
  (named / measured / placed), locked flag, note.
- **`garden_measurement`** — id, site, point A, point B, **distance (m)**, note
  ("tape along wall top"), created. Append-only in spirit: corrections are new
  measurements; deletions are explicit and audited.
- **`garden_constraint`** — id, site, kind (right-angle / parallel / equal-length /
  colinear), the points/segments it binds (as ordered point references), created.
  Like measurements: corrections are deletions plus new constraints, audited.
- **`garden_feature`** — id, site, type (retention-wall / pool / terrace / stairs /
  house / fence / bed / path), **name** ("lower retention wall"), properties
  (per-type: wall height, step count, …).
- **`garden_feature_vertex`** — feature, sequence number, point, and the segment
  style to the next point (**straight | curved**, default straight). The ordered
  point-run that gives a feature its shape.
- **`garden_species`** — the library: id, **common name** ("Olivo"), latin name,
  category (tree / shrub / hedge / …), mature canopy diameter (m), mature height
  (m), growth curve parameters (for the future growth view). Ships with a starter
  set; more importable from JSON.
- **`garden_plant`** — id, site, point, species, **label** ("olivo grande"),
  planted date, note.

Every name promised on an output artifact has a source here: DXF point labels come
from `garden_point.name`, feature layer names from `garden_feature.type` +
`garden_feature.name`, plant labels from `garden_plant.label` falling back to
`garden_species` common name.

**DXF export** (not a table — the artifact): 2D top view, one layer per feature
type plus layers for points, point labels (name + elevation as text), and plants
(circle at mature canopy diameter, so spacing mistakes are visible in CAD).
Curved segments export as densely fitted polylines, the form every CAD tool
imports. Point
Z = elevation, so a 3D-capable CAD tool sees the heights. **SKP is not planned**:
it's a closed format with no practical writer outside SketchUp's own SDK — the
honest path is DXF, which SketchUp Pro imports directly.

Migrations are append-only forever after first ship, so this section is the cheap
moment to object to the shape.

## 8. The scenario the test will replay

Happy path, as Markus:
1. Create the *Casa Markus* garden, datum "terrace floor = 0.00".
2. Add points: `house-SW` (origin), `house-SE` (baseline, 12.40 m from origin),
   `pool-NW` with distances to both (7.10 m, 9.80 m) → solver offers two mirror
   positions, Markus picks the south side → point is **placed**.
3. Add a third distance to `pool-NW` → solver reports a residual under 5 cm.
   Add a right-angle constraint at `house-SW` → solver reports the constraint's
   own residual and the adjustment it caused.
4. Set elevations: house corners 0.00, `pool-NW` at −1.20.
5. Draw the house (closed loop) and a retention wall (open run); plant an *Olivo*
   at a new placed point.
6. Export DXF; the test asserts the layers, the labeled points with elevations,
   and the olive's canopy circle exist in the file.

The denials, same test:
7. The **viewer** principal lists the garden and reads the map — allowed; tries to
   add a point and a measurement — **denied**, with the audit trail showing the
   denial.
8. The **neighbour** (tenant *Vecino*) lists gardens — sees only their own; tries
   to read Casa Markus by id — **gets nothing**, as if it doesn't exist.

## 9. Open decisions — each with a recommended default

1. **Auth.** Default: local dev `x-principal` header (a dev seam, not a login).
   Must be replaced (e.g. Better Auth, the `demos/callout` pattern) before any
   real viewer is invited or anything goes on the internet. Building doesn't wait
   for it.
2. **Deploy or stay local.** Default: **local-first.** It's your garden and your
   machine; deploying to Cloudflare is a later, separate step.
3. **Mirror choice UX.** Default: with exactly two distances the app asks "which
   side?" once and remembers; a third measurement resolves it automatically.
4. **Units & precision.** Default: meters with cm precision (two decimals) —
   matches a 20 m tape.
5. **DXF flavor.** Default: ASCII DXF, 2D entities with Z on points, layers as in
   §7 — the most widely importable form. Fancier (splines, blocks) only if a
   target CAD tool demands it.

## 10. Out of scope / deferred

- **3D view** — deferred; the data (x, y, elevation) already supports it.
- **Growth over time** — deferred; the species schema already carries the curve.
- **Viewer invites** — designed (role exists, engine chosen) but not wired.
- **Quotes / licenses / any money** — recorded as a future in §3, nothing built.
- **SKP export** — honest no (closed format); DXF is the interchange path.
- **GPS / RTK / photo import** — tape measure only, by design.

---

## Review questions — answered 2026-08-09

1. **The measurement model:** confirmed — pairwise tape distances only
   ("A → B: 267 cm"), no angles or offsets.
2. **Features as point-runs:** confirmed, with segments either **straight or
   curved** (smooth curve through points) so rounded edges need fewer points.
3. **The cast:** owner + viewer is the whole cast for now; no editor role.
