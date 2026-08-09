# Triangle — UI design brief (for Claude design)

Design a mobile-first web app called **Triangle** for surveying and planning a
private garden with a 20 m tape measure. The user stands *in the garden*, phone in
one hand, tape in the other. There is one primary user (the garden owner, full
edit) and a future read-only viewer role — design the read-only state too.

## How it works (domain, in brief)

- The user creates named **survey points** ("house SW corner", "pool NW").
- They record **pairwise tape distances in centimeters** ("A → B: 267").
- A solver triangulates points onto a 2D map. A point fixed by only two distances
  has two mirror-image candidate positions — the app must ask "which side?" once,
  visually (show both candidates on the map, tap one). With three or more
  distances the app shows a **residual** (measurement disagreement in cm) as a
  quality signal: green ≤ 2 cm, amber ≤ 5 cm, red above.
- Every point has an **elevation** in meters relative to a chosen datum
  ("terrace floor = 0.00"); can be negative.
- **Features** are drawn through points: retention walls, pool, terrace, stairs,
  house, fence, bed, path. Open runs or closed loops; each segment straight or
  curved. Moving a point moves every feature built on it.
- **Plants** are placed at points, chosen from a species library (common + latin
  name, mature canopy diameter). The map shows a plant as a canopy circle at
  mature size.
- The map can be **exported as DXF**.

## The two primary views (persistent toggle)

1. **Map view** — the hero. Pan/zoom canvas, points with name + elevation labels,
   features styled by type, plants as canopy circles, optional overlay of tape
   measurements as thin construction lines. Tapping anything opens its detail.
   Unplaced points (not enough measurements yet) need a visible home — e.g. a tray
   at the edge — so they're never lost.
2. **List view** — for fast entry in the field. Tabs or sections for Points,
   Measurements, Features, Plants. Optimized for one-handed repeated entry:
   add measurement = pick point A, pick point B (recently used points first),
   numeric keypad for cm, save, immediately ready for the next one.

## Key flows to design

- Onboarding an empty garden: create garden → set datum note → add first point
  (origin) → second point (baseline) → the moment the map first appears.
- Add measurement (the most-used flow — make it fastest).
- Mirror-side choice dialog on the map.
- Point detail: name, elevation, its measurements with residual, lock toggle,
  delete with consequences shown.
- Draw a feature: pick type → tap points in order on the map → per-segment
  straight/curved toggle → close loop or leave open.
- Plant picker: browse/search species library, place at a point.
- Export screen: DXF download.
- Read-only viewer state: same views, all editing affordances gone (not disabled
  — gone), plus a subtle "viewing" indicator.

## Constraints & tone

- **Mobile-first ~375 px**, works up to desktop with the same layout stretched
  (map gets the room; list can sit beside it on wide screens).
- **Outdoor use**: high contrast, readable in sunlight, large touch targets
  (≥44 px), no hover-dependent interactions.
- Numeric entry always brings up a number pad; cm is the implied unit.
- Practical instrument, not decorative: think field tool / surveyor's notebook.
  The map is the identity of the app. Light and dark themes.
- No login screens needed (dev auth for now); no billing, no settings maze.

## Deliverables

Screens for: garden home (list of gardens), Map view, List view (all four
sections), add-measurement flow, mirror choice, point detail, feature editor,
plant library/picker, export, and the viewer (read-only) variant of Map + List.
