import { z } from '@substrat-run/contracts';
import {
  assertAllowed,
  ulid,
  type ModuleRegistration,
  type OperationContext,
  type OperationHandler,
} from '@substrat-run/kernel';
import { gardenManifest, GARDEN_PERM } from './manifest.js';
import { gardenMigrations } from './migrations.js';
import {
  solveGarden,
  type MirrorChoice,
  type SolveConstraint,
  type SolvePoint,
  type XY,
} from './geometry.js';
import { buildDxf, sampleRun, type DxfPolyline } from './dxf.js';

// ============================================================================
// The garden operations. Triangle composes no engines — every table here is
// the vertical's own (DESIGN.md §3) — so the load-bearing patterns are:
//   - every operation's FIRST line is the permission check (owner writes,
//     viewer reads — DESIGN.md §4),
//   - every mutation emits a fat event (the audit answer to "why did the pool
//     move 12 cm last Tuesday"),
//   - the SOLVER is the only writer of coordinates: mutations that change the
//     survey re-solve and persist, and return what moved so nothing ever moves
//     silently (DESIGN.md §2).
// Data access is `ctx.sql` only. No `fetch`, no `node:*`.
// ============================================================================

export const FEATURE_TYPES = [
  'retention-wall',
  'pool',
  'terrace',
  'stairs',
  'house',
  'fence',
  'bed',
  'path',
] as const;

export interface SiteRow {
  id: string;
  name: string;
  datum_note: string | null;
  created_at: string;
}

export interface PointRow {
  id: string;
  site_id: string;
  seq: number;
  name: string;
  elevation_m: number | null;
  x: number | null;
  y: number | null;
  status: string;
  side: number | null;
  locked: number;
  note: string | null;
  created_at: string;
}

export interface MeasurementRow {
  id: string;
  site_id: string;
  point_a: string;
  point_b: string;
  distance_m: number;
  note: string | null;
  created_at: string;
}

export interface ConstraintRow {
  id: string;
  site_id: string;
  kind: string;
  points_json: string;
  created_at: string;
}

export interface FeatureRow {
  id: string;
  site_id: string;
  type: string;
  name: string;
  closed: number;
  props_json: string;
  created_at: string;
}

export interface SpeciesRow {
  id: string;
  common_name: string;
  latin_name: string | null;
  category: string;
  mature_canopy_m: number | null;
  mature_height_m: number | null;
  years_to_mature: number | null;
  created_at: string;
}

export interface PlantRow {
  id: string;
  site_id: string;
  point_id: string;
  species_id: string;
  label: string | null;
  planted_on: string | null;
  note: string | null;
  created_at: string;
}

/** What a re-solve reports back to the caller — nothing moves silently. */
export interface SolveReport {
  moved: { pointId: string; from: XY | null; to: XY; deltaCm: number }[];
  placed: string[];
  unplaced: { id: string; distances: number }[];
  needsSide: MirrorChoice[];
  measurementResidualsCm: Record<string, number>;
  constraintResidualsCm: Record<string, number>;
  rmsCm: number;
}

const now = () => new Date().toISOString();
const cm = (m: number) => Math.round(m * 1000) / 10;

function siteOr404(ctx: OperationContext, siteId: string): SiteRow {
  const site = ctx.sql.query<SiteRow>('SELECT * FROM garden_sites WHERE id = ?', [siteId])[0];
  if (!site) throw new Error(`site not found: ${siteId}`);
  return site;
}

function pointOr404(ctx: OperationContext, pointId: string): PointRow {
  const p = ctx.sql.query<PointRow>('SELECT * FROM garden_points WHERE id = ?', [pointId])[0];
  if (!p) throw new Error(`point not found: ${pointId}`);
  return p;
}

function loadSurvey(ctx: OperationContext, siteId: string) {
  const points = ctx.sql.query<PointRow>(
    'SELECT * FROM garden_points WHERE site_id = ? ORDER BY seq',
    [siteId],
  );
  const measurements = ctx.sql.query<MeasurementRow>(
    'SELECT * FROM garden_measurements WHERE site_id = ? ORDER BY created_at',
    [siteId],
  );
  const constraints = ctx.sql.query<ConstraintRow>(
    'SELECT * FROM garden_constraints WHERE site_id = ? ORDER BY created_at',
    [siteId],
  );
  return { points, measurements, constraints };
}

function toSolverInput(points: PointRow[], measurements: MeasurementRow[], constraints: ConstraintRow[]) {
  const solvePoints: SolvePoint[] = points.map((p) => ({
    id: p.id,
    locked: p.locked === 1,
    side: p.side === 1 ? 1 : p.side === -1 ? -1 : null,
    x: p.x,
    y: p.y,
  }));
  const solveMeasurements = measurements.map((m) => ({
    id: m.id,
    a: m.point_a,
    b: m.point_b,
    d: m.distance_m,
  }));
  const solveConstraints = constraints.map(
    (c) => ({ id: c.id, kind: c.kind, points: JSON.parse(c.points_json) }) as SolveConstraint,
  );
  return { solvePoints, solveMeasurements, solveConstraints };
}

/**
 * Re-solve a site and (when `persist`) write the coordinates back — the ONLY
 * writer of garden_points.x/y/status. Returns what moved, in cm, so every
 * caller can show a before/after (DESIGN.md §2: nothing moves silently).
 */
function runSolve(ctx: OperationContext, siteId: string, persist: boolean): SolveReport {
  const { points, measurements, constraints } = loadSurvey(ctx, siteId);
  const { solvePoints, solveMeasurements, solveConstraints } = toSolverInput(
    points,
    measurements,
    constraints,
  );
  const result = solveGarden(solvePoints, solveMeasurements, solveConstraints);

  const moved: SolveReport['moved'] = [];
  for (const p of points) {
    const c = result.coords.get(p.id);
    if (!c) continue;
    const from = p.x !== null && p.y !== null ? { x: p.x, y: p.y } : null;
    const delta = from ? Math.hypot(c.x - from.x, c.y - from.y) : Math.hypot(c.x, c.y) + 0.000001;
    if (!from || delta > 0.0005) {
      moved.push({ pointId: p.id, from, to: { x: c.x, y: c.y }, deltaCm: from ? cm(delta) : 0 });
    }
  }

  if (persist) {
    const measuredIds = new Set<string>();
    for (const m of measurements) {
      measuredIds.add(m.point_a);
      measuredIds.add(m.point_b);
    }
    for (const p of points) {
      const c = result.coords.get(p.id);
      const status = c ? 'placed' : measuredIds.has(p.id) ? 'measured' : 'named';
      ctx.sql.exec('UPDATE garden_points SET x = ?, y = ?, status = ? WHERE id = ?', [
        c ? c.x : null,
        c ? c.y : null,
        status,
        p.id,
      ]);
    }
    if (moved.length > 0) {
      ctx.emit({
        type: 'garden.solved',
        schemaVersion: 1,
        entity: { entityType: 'site', entityId: siteId },
        piiClass: 'none',
        payload: {
          siteId,
          moved,
          rmsCm: cm(result.rms),
          placed: result.placed.length,
          unplaced: result.unplaced.length,
        },
      });
    }
  }

  return {
    moved,
    placed: result.placed,
    unplaced: result.unplaced,
    needsSide: result.needsSide,
    measurementResidualsCm: Object.fromEntries(
      [...result.measurementResiduals].map(([id, r]) => [id, cm(r)]),
    ),
    constraintResidualsCm: Object.fromEntries(
      [...result.constraintResiduals].map(([id, r]) => [id, cm(r)]),
    ),
    rmsCm: cm(result.rms),
  };
}

// ── Sites ────────────────────────────────────────────────────────────────────

const createSiteInput = z.object({
  name: z.string().min(1),
  datumNote: z.string().optional(),
});

const createSiteOp: OperationHandler<z.infer<typeof createSiteInput>, SiteRow> = async (
  ctx,
  rawInput,
) => {
  assertAllowed(await ctx.check(GARDEN_PERM.manage));
  const input = createSiteInput.parse(rawInput);
  const id = ulid();
  ctx.sql.exec('INSERT INTO garden_sites (id, name, datum_note, created_at) VALUES (?, ?, ?, ?)', [
    id,
    input.name,
    input.datumNote ?? null,
    now(),
  ]);
  ctx.emit({
    type: 'garden.site-created',
    schemaVersion: 1,
    entity: { entityType: 'site', entityId: id },
    piiClass: 'none',
    payload: { siteId: id, name: input.name },
  });
  return ctx.sql.query<SiteRow>('SELECT * FROM garden_sites WHERE id = ?', [id])[0]!;
};

const listSitesOp: OperationHandler<
  undefined,
  (SiteRow & { points: number; measurements: number; features: number; plants: number })[]
> = async (ctx) => {
  assertAllowed(await ctx.check(GARDEN_PERM.read));
  return ctx.sql
    .query<SiteRow>('SELECT * FROM garden_sites ORDER BY created_at')
    .map((s) => ({
      ...s,
      points: count(ctx, 'garden_points', s.id),
      measurements: count(ctx, 'garden_measurements', s.id),
      features: count(ctx, 'garden_features', s.id),
      plants: count(ctx, 'garden_plants', s.id),
    }));
};

function count(ctx: OperationContext, table: string, siteId: string): number {
  // table names come from the closed list above, never from input
  return Number(
    ctx.sql.query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE site_id = ?`, [siteId])[0]!
      .n,
  );
}

export interface SitePayload {
  site: SiteRow;
  points: PointRow[];
  measurements: MeasurementRow[];
  constraints: (ConstraintRow & { points: string[] })[];
  features: (FeatureRow & {
    vertices: { point_id: string; seq: number; curved_to_next: number }[];
    props: Record<string, unknown>;
  })[];
  plants: (PlantRow & { species: SpeciesRow })[];
  solve: SolveReport;
}

const siteIdInput = z.object({ siteId: z.string().min(1) });

const getSiteOp: OperationHandler<z.infer<typeof siteIdInput>, SitePayload> = async (
  ctx,
  rawInput,
) => {
  assertAllowed(await ctx.check(GARDEN_PERM.read));
  const { siteId } = siteIdInput.parse(rawInput);
  const site = siteOr404(ctx, siteId);
  const { points, measurements, constraints } = loadSurvey(ctx, siteId);
  const features = ctx.sql
    .query<FeatureRow>('SELECT * FROM garden_features WHERE site_id = ? ORDER BY created_at', [siteId])
    .map((f) => ({
      ...f,
      vertices: ctx.sql.query<{ point_id: string; seq: number; curved_to_next: number }>(
        'SELECT point_id, seq, curved_to_next FROM garden_feature_vertices WHERE feature_id = ? ORDER BY seq',
        [f.id],
      ),
      props: JSON.parse(f.props_json) as Record<string, unknown>,
    }));
  const plants = ctx.sql
    .query<PlantRow>('SELECT * FROM garden_plants WHERE site_id = ? ORDER BY created_at', [siteId])
    .map((p) => ({
      ...p,
      species: ctx.sql.query<SpeciesRow>('SELECT * FROM garden_species WHERE id = ?', [
        p.species_id,
      ])[0]!,
    }));
  // Read-only solve: residuals + pending mirror choices for the UI, no writes.
  const solve = runSolve(ctx, siteId, false);
  return {
    site,
    points,
    measurements,
    constraints: constraints.map((c) => ({ ...c, points: JSON.parse(c.points_json) as string[] })),
    features,
    plants,
    solve,
  };
};

// ── Points ───────────────────────────────────────────────────────────────────

const createPointInput = z.object({
  siteId: z.string().min(1),
  name: z.string().min(1),
  elevationM: z.number().finite().optional(),
  note: z.string().optional(),
});

const createPointOp: OperationHandler<z.infer<typeof createPointInput>, PointRow> = async (
  ctx,
  rawInput,
) => {
  assertAllowed(await ctx.check(GARDEN_PERM.manage));
  const input = createPointInput.parse(rawInput);
  siteOr404(ctx, input.siteId);
  const id = ulid();
  const seq =
    Number(
      ctx.sql.query<{ m: number | null }>(
        'SELECT MAX(seq) AS m FROM garden_points WHERE site_id = ?',
        [input.siteId],
      )[0]!.m ?? 0,
    ) + 1;
  ctx.sql.exec(
    `INSERT INTO garden_points (id, site_id, seq, name, elevation_m, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, input.siteId, seq, input.name, input.elevationM ?? null, input.note ?? null, now()],
  );
  ctx.link({ entityType: 'point', entityId: id }, { entityType: 'site', entityId: input.siteId });
  ctx.emit({
    type: 'garden.point-created',
    schemaVersion: 1,
    entity: { entityType: 'point', entityId: id },
    piiClass: 'none',
    payload: { siteId: input.siteId, pointId: id, name: input.name, seq },
  });
  // The first point becomes the origin the moment it exists.
  runSolve(ctx, input.siteId, true);
  return pointOr404(ctx, id);
};

const updatePointInput = z.object({
  pointId: z.string().min(1),
  name: z.string().min(1).optional(),
  elevationM: z.number().finite().nullable().optional(),
  locked: z.boolean().optional(),
  note: z.string().nullable().optional(),
});

const updatePointOp: OperationHandler<
  z.infer<typeof updatePointInput>,
  { point: PointRow; solve: SolveReport }
> = async (ctx, rawInput) => {
  assertAllowed(await ctx.check(GARDEN_PERM.manage));
  const input = updatePointInput.parse(rawInput);
  const point = pointOr404(ctx, input.pointId);
  ctx.sql.exec(
    `UPDATE garden_points SET
       name = COALESCE(?, name),
       elevation_m = CASE WHEN ? THEN ? ELSE elevation_m END,
       locked = COALESCE(?, locked),
       note = CASE WHEN ? THEN ? ELSE note END
     WHERE id = ?`,
    [
      input.name ?? null,
      input.elevationM !== undefined ? 1 : 0,
      input.elevationM ?? null,
      input.locked === undefined ? null : input.locked ? 1 : 0,
      input.note !== undefined ? 1 : 0,
      input.note ?? null,
      point.id,
    ],
  );
  ctx.emit({
    type: 'garden.point-updated',
    schemaVersion: 1,
    entity: { entityType: 'point', entityId: point.id },
    piiClass: 'none',
    payload: { siteId: point.site_id, pointId: point.id, changes: input },
  });
  const solve = runSolve(ctx, point.site_id, true);
  return { point: pointOr404(ctx, point.id), solve };
};

const pointIdInput = z.object({ pointId: z.string().min(1) });

const deletePointOp: OperationHandler<
  z.infer<typeof pointIdInput>,
  { deleted: string; solve: SolveReport }
> = async (ctx, rawInput) => {
  assertAllowed(await ctx.check(GARDEN_PERM.manage));
  const { pointId } = pointIdInput.parse(rawInput);
  const point = pointOr404(ctx, pointId);
  const inFeatures = ctx.sql.query<{ name: string }>(
    `SELECT f.name FROM garden_feature_vertices v JOIN garden_features f ON f.id = v.feature_id
     WHERE v.point_id = ?`,
    [pointId],
  );
  if (inFeatures.length > 0) {
    throw new Error(
      `point in use by feature: ${inFeatures.map((f) => f.name).join(', ')} — remove it from the feature first`,
    );
  }
  const plants = ctx.sql.query<{ id: string }>('SELECT id FROM garden_plants WHERE point_id = ?', [
    pointId,
  ]);
  if (plants.length > 0) throw new Error('point in use by plant — remove the plant first');

  ctx.sql.exec('DELETE FROM garden_measurements WHERE point_a = ? OR point_b = ?', [
    pointId,
    pointId,
  ]);
  // Constraints referencing the point go with it (they are assumptions about it).
  for (const c of ctx.sql.query<ConstraintRow>(
    'SELECT * FROM garden_constraints WHERE site_id = ?',
    [point.site_id],
  )) {
    if ((JSON.parse(c.points_json) as string[]).includes(pointId)) {
      ctx.sql.exec('DELETE FROM garden_constraints WHERE id = ?', [c.id]);
    }
  }
  ctx.sql.exec('DELETE FROM garden_points WHERE id = ?', [pointId]);
  ctx.emit({
    type: 'garden.point-deleted',
    schemaVersion: 1,
    entity: { entityType: 'point', entityId: pointId },
    piiClass: 'none',
    payload: { siteId: point.site_id, pointId, name: point.name },
  });
  const solve = runSolve(ctx, point.site_id, true);
  return { deleted: pointId, solve };
};

const chooseSideInput = z.object({
  pointId: z.string().min(1),
  side: z.union([z.literal(1), z.literal(-1)]),
});

const chooseSideOp: OperationHandler<
  z.infer<typeof chooseSideInput>,
  { point: PointRow; solve: SolveReport }
> = async (ctx, rawInput) => {
  assertAllowed(await ctx.check(GARDEN_PERM.manage));
  const input = chooseSideInput.parse(rawInput);
  const point = pointOr404(ctx, input.pointId);
  ctx.sql.exec('UPDATE garden_points SET side = ? WHERE id = ?', [input.side, point.id]);
  ctx.emit({
    type: 'garden.point-updated',
    schemaVersion: 1,
    entity: { entityType: 'point', entityId: point.id },
    piiClass: 'none',
    payload: { siteId: point.site_id, pointId: point.id, changes: { side: input.side } },
  });
  const solve = runSolve(ctx, point.site_id, true);
  return { point: pointOr404(ctx, point.id), solve };
};

// ── Measurements ─────────────────────────────────────────────────────────────

const addMeasurementInput = z.object({
  siteId: z.string().min(1),
  pointA: z.string().min(1),
  pointB: z.string().min(1),
  /** The tape reads centimeters (DESIGN.md §2); stored in meters. */
  distanceCm: z.number().positive().finite(),
  note: z.string().optional(),
});

const addMeasurementOp: OperationHandler<
  z.infer<typeof addMeasurementInput>,
  { measurement: MeasurementRow; solve: SolveReport }
> = async (ctx, rawInput) => {
  assertAllowed(await ctx.check(GARDEN_PERM.manage));
  const input = addMeasurementInput.parse(rawInput);
  siteOr404(ctx, input.siteId);
  if (input.pointA === input.pointB) throw new Error('a distance needs two different points');
  const a = pointOr404(ctx, input.pointA);
  const b = pointOr404(ctx, input.pointB);
  if (a.site_id !== input.siteId || b.site_id !== input.siteId) {
    throw new Error('both points must belong to the site');
  }
  const id = ulid();
  ctx.sql.exec(
    `INSERT INTO garden_measurements (id, site_id, point_a, point_b, distance_m, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, input.siteId, a.id, b.id, input.distanceCm / 100, input.note ?? null, now()],
  );
  ctx.link({ entityType: 'measurement', entityId: id }, { entityType: 'site', entityId: input.siteId });
  ctx.emit({
    type: 'garden.measurement-added',
    schemaVersion: 1,
    entity: { entityType: 'measurement', entityId: id },
    piiClass: 'none',
    payload: {
      siteId: input.siteId,
      measurementId: id,
      pointA: { id: a.id, name: a.name },
      pointB: { id: b.id, name: b.name },
      distanceCm: input.distanceCm,
    },
  });
  const solve = runSolve(ctx, input.siteId, true);
  const measurement = ctx.sql.query<MeasurementRow>(
    'SELECT * FROM garden_measurements WHERE id = ?',
    [id],
  )[0]!;
  return { measurement, solve };
};

const measurementIdInput = z.object({ measurementId: z.string().min(1) });

const deleteMeasurementOp: OperationHandler<
  z.infer<typeof measurementIdInput>,
  { deleted: string; solve: SolveReport }
> = async (ctx, rawInput) => {
  assertAllowed(await ctx.check(GARDEN_PERM.manage));
  const { measurementId } = measurementIdInput.parse(rawInput);
  const m = ctx.sql.query<MeasurementRow>('SELECT * FROM garden_measurements WHERE id = ?', [
    measurementId,
  ])[0];
  if (!m) throw new Error(`measurement not found: ${measurementId}`);
  ctx.sql.exec('DELETE FROM garden_measurements WHERE id = ?', [measurementId]);
  ctx.emit({
    type: 'garden.measurement-deleted',
    schemaVersion: 1,
    entity: { entityType: 'measurement', entityId: measurementId },
    piiClass: 'none',
    payload: { siteId: m.site_id, measurementId, distanceCm: cm(m.distance_m) },
  });
  const solve = runSolve(ctx, m.site_id, true);
  return { deleted: measurementId, solve };
};

// ── Constraints ──────────────────────────────────────────────────────────────

const constraintShape = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('right-angle'), pointIds: z.array(z.string().min(1)).length(3) }),
  z.object({ kind: z.literal('parallel'), pointIds: z.array(z.string().min(1)).length(4) }),
  z.object({ kind: z.literal('equal-length'), pointIds: z.array(z.string().min(1)).length(4) }),
  z.object({ kind: z.literal('colinear'), pointIds: z.array(z.string().min(1)).min(3) }),
]);

const addConstraintInput = z.object({ siteId: z.string().min(1) }).and(constraintShape);

function validateConstraintPoints(ctx: OperationContext, siteId: string, pointIds: string[]): void {
  for (const id of pointIds) {
    const p = pointOr404(ctx, id);
    if (p.site_id !== siteId) throw new Error('all constraint points must belong to the site');
  }
  if (new Set(pointIds).size !== pointIds.length) {
    throw new Error('a constraint cannot use the same point twice');
  }
}

/** Dry-run: what WOULD this constraint move? (screen 21 — the honesty preview). */
const previewConstraintOp: OperationHandler<z.infer<typeof addConstraintInput>, SolveReport> =
  async (ctx, rawInput) => {
    assertAllowed(await ctx.check(GARDEN_PERM.read));
    const input = addConstraintInput.parse(rawInput);
    siteOr404(ctx, input.siteId);
    validateConstraintPoints(ctx, input.siteId, input.pointIds);
    const { points, measurements, constraints } = loadSurvey(ctx, input.siteId);
    const { solvePoints, solveMeasurements, solveConstraints } = toSolverInput(
      points,
      measurements,
      constraints,
    );
    solveConstraints.push({
      id: 'preview',
      kind: input.kind,
      points: input.pointIds,
    } as SolveConstraint);
    const result = solveGarden(solvePoints, solveMeasurements, solveConstraints);
    const moved: SolveReport['moved'] = [];
    for (const p of points) {
      const c = result.coords.get(p.id);
      if (!c || p.x === null || p.y === null) continue;
      const delta = Math.hypot(c.x - p.x, c.y - p.y);
      if (delta > 0.0005) {
        moved.push({ pointId: p.id, from: { x: p.x, y: p.y }, to: c, deltaCm: cm(delta) });
      }
    }
    return {
      moved,
      placed: result.placed,
      unplaced: result.unplaced,
      needsSide: result.needsSide,
      measurementResidualsCm: Object.fromEntries(
        [...result.measurementResiduals].map(([id, r]) => [id, cm(r)]),
      ),
      constraintResidualsCm: {
        ...Object.fromEntries([...result.constraintResiduals].map(([id, r]) => [id, cm(r)])),
      },
      rmsCm: cm(result.rms),
    };
  };

const addConstraintOp: OperationHandler<
  z.infer<typeof addConstraintInput>,
  { constraint: ConstraintRow; solve: SolveReport }
> = async (ctx, rawInput) => {
  assertAllowed(await ctx.check(GARDEN_PERM.manage));
  const input = addConstraintInput.parse(rawInput);
  siteOr404(ctx, input.siteId);
  validateConstraintPoints(ctx, input.siteId, input.pointIds);
  const id = ulid();
  ctx.sql.exec(
    `INSERT INTO garden_constraints (id, site_id, kind, points_json, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [id, input.siteId, input.kind, JSON.stringify(input.pointIds), now()],
  );
  ctx.link({ entityType: 'constraint', entityId: id }, { entityType: 'site', entityId: input.siteId });
  ctx.emit({
    type: 'garden.constraint-added',
    schemaVersion: 1,
    entity: { entityType: 'constraint', entityId: id },
    piiClass: 'none',
    payload: { siteId: input.siteId, constraintId: id, kind: input.kind, pointIds: input.pointIds },
  });
  const solve = runSolve(ctx, input.siteId, true);
  const constraint = ctx.sql.query<ConstraintRow>('SELECT * FROM garden_constraints WHERE id = ?', [
    id,
  ])[0]!;
  return { constraint, solve };
};

const constraintIdInput = z.object({ constraintId: z.string().min(1) });

const deleteConstraintOp: OperationHandler<
  z.infer<typeof constraintIdInput>,
  { deleted: string; solve: SolveReport }
> = async (ctx, rawInput) => {
  assertAllowed(await ctx.check(GARDEN_PERM.manage));
  const { constraintId } = constraintIdInput.parse(rawInput);
  const c = ctx.sql.query<ConstraintRow>('SELECT * FROM garden_constraints WHERE id = ?', [
    constraintId,
  ])[0];
  if (!c) throw new Error(`constraint not found: ${constraintId}`);
  ctx.sql.exec('DELETE FROM garden_constraints WHERE id = ?', [constraintId]);
  ctx.emit({
    type: 'garden.constraint-deleted',
    schemaVersion: 1,
    entity: { entityType: 'constraint', entityId: constraintId },
    piiClass: 'none',
    payload: { siteId: c.site_id, constraintId, kind: c.kind },
  });
  const solve = runSolve(ctx, c.site_id, true);
  return { deleted: constraintId, solve };
};

// ── Solve (explicit full re-solve) ───────────────────────────────────────────

const solveOp: OperationHandler<z.infer<typeof siteIdInput>, SolveReport> = async (
  ctx,
  rawInput,
) => {
  assertAllowed(await ctx.check(GARDEN_PERM.manage));
  const { siteId } = siteIdInput.parse(rawInput);
  siteOr404(ctx, siteId);
  return runSolve(ctx, siteId, true);
};

// ── Features ─────────────────────────────────────────────────────────────────

const vertexShape = z.object({
  pointId: z.string().min(1),
  curvedToNext: z.boolean().optional(),
});

const createFeatureInput = z.object({
  siteId: z.string().min(1),
  type: z.enum(FEATURE_TYPES),
  name: z.string().min(1),
  closed: z.boolean().optional(),
  vertices: z.array(vertexShape).min(2),
  props: z.record(z.string(), z.unknown()).optional(),
});

function writeVertices(
  ctx: OperationContext,
  featureId: string,
  siteId: string,
  vertices: z.infer<typeof vertexShape>[],
): void {
  ctx.sql.exec('DELETE FROM garden_feature_vertices WHERE feature_id = ?', [featureId]);
  vertices.forEach((v, i) => {
    const p = pointOr404(ctx, v.pointId);
    if (p.site_id !== siteId) throw new Error('all feature points must belong to the site');
    ctx.sql.exec(
      `INSERT INTO garden_feature_vertices (feature_id, seq, point_id, curved_to_next)
       VALUES (?, ?, ?, ?)`,
      [featureId, i, v.pointId, v.curvedToNext ? 1 : 0],
    );
  });
}

const createFeatureOp: OperationHandler<z.infer<typeof createFeatureInput>, FeatureRow> = async (
  ctx,
  rawInput,
) => {
  assertAllowed(await ctx.check(GARDEN_PERM.manage));
  const input = createFeatureInput.parse(rawInput);
  siteOr404(ctx, input.siteId);
  const id = ulid();
  ctx.sql.exec(
    `INSERT INTO garden_features (id, site_id, type, name, closed, props_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.siteId,
      input.type,
      input.name,
      input.closed ? 1 : 0,
      JSON.stringify(input.props ?? {}),
      now(),
    ],
  );
  writeVertices(ctx, id, input.siteId, input.vertices);
  ctx.link({ entityType: 'feature', entityId: id }, { entityType: 'site', entityId: input.siteId });
  ctx.emit({
    type: 'garden.feature-created',
    schemaVersion: 1,
    entity: { entityType: 'feature', entityId: id },
    piiClass: 'none',
    payload: {
      siteId: input.siteId,
      featureId: id,
      type: input.type,
      name: input.name,
      vertices: input.vertices,
    },
  });
  return ctx.sql.query<FeatureRow>('SELECT * FROM garden_features WHERE id = ?', [id])[0]!;
};

const updateFeatureInput = z.object({
  featureId: z.string().min(1),
  name: z.string().min(1).optional(),
  closed: z.boolean().optional(),
  vertices: z.array(vertexShape).min(2).optional(),
  props: z.record(z.string(), z.unknown()).optional(),
});

const updateFeatureOp: OperationHandler<z.infer<typeof updateFeatureInput>, FeatureRow> = async (
  ctx,
  rawInput,
) => {
  assertAllowed(await ctx.check(GARDEN_PERM.manage));
  const input = updateFeatureInput.parse(rawInput);
  const f = ctx.sql.query<FeatureRow>('SELECT * FROM garden_features WHERE id = ?', [
    input.featureId,
  ])[0];
  if (!f) throw new Error(`feature not found: ${input.featureId}`);
  ctx.sql.exec(
    `UPDATE garden_features SET
       name = COALESCE(?, name),
       closed = COALESCE(?, closed),
       props_json = COALESCE(?, props_json)
     WHERE id = ?`,
    [
      input.name ?? null,
      input.closed === undefined ? null : input.closed ? 1 : 0,
      input.props ? JSON.stringify(input.props) : null,
      f.id,
    ],
  );
  if (input.vertices) writeVertices(ctx, f.id, f.site_id, input.vertices);
  ctx.emit({
    type: 'garden.feature-updated',
    schemaVersion: 1,
    entity: { entityType: 'feature', entityId: f.id },
    piiClass: 'none',
    payload: { siteId: f.site_id, featureId: f.id, changes: input },
  });
  return ctx.sql.query<FeatureRow>('SELECT * FROM garden_features WHERE id = ?', [f.id])[0]!;
};

const featureIdInput = z.object({ featureId: z.string().min(1) });

const deleteFeatureOp: OperationHandler<z.infer<typeof featureIdInput>, { deleted: string }> =
  async (ctx, rawInput) => {
    assertAllowed(await ctx.check(GARDEN_PERM.manage));
    const { featureId } = featureIdInput.parse(rawInput);
    const f = ctx.sql.query<FeatureRow>('SELECT * FROM garden_features WHERE id = ?', [featureId])[0];
    if (!f) throw new Error(`feature not found: ${featureId}`);
    ctx.sql.exec('DELETE FROM garden_feature_vertices WHERE feature_id = ?', [featureId]);
    ctx.sql.exec('DELETE FROM garden_features WHERE id = ?', [featureId]);
    ctx.emit({
      type: 'garden.feature-deleted',
      schemaVersion: 1,
      entity: { entityType: 'feature', entityId: featureId },
      piiClass: 'none',
      payload: { siteId: f.site_id, featureId, name: f.name },
    });
    return { deleted: featureId };
  };

// ── Species & plants ─────────────────────────────────────────────────────────

const upsertSpeciesInput = z.object({
  id: z.string().min(1).optional(),
  commonName: z.string().min(1),
  latinName: z.string().optional(),
  category: z.enum(['tree', 'shrub', 'hedge', 'perennial', 'climber']).optional(),
  matureCanopyM: z.number().positive().finite().optional(),
  matureHeightM: z.number().positive().finite().optional(),
  yearsToMature: z.number().positive().finite().optional(),
});

const upsertSpeciesOp: OperationHandler<z.infer<typeof upsertSpeciesInput>, SpeciesRow> = async (
  ctx,
  rawInput,
) => {
  assertAllowed(await ctx.check(GARDEN_PERM.manage));
  const input = upsertSpeciesInput.parse(rawInput);
  const id = input.id ?? ulid();
  ctx.sql.exec(
    `INSERT INTO garden_species
       (id, common_name, latin_name, category, mature_canopy_m, mature_height_m, years_to_mature, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       common_name = excluded.common_name,
       latin_name = excluded.latin_name,
       category = excluded.category,
       mature_canopy_m = excluded.mature_canopy_m,
       mature_height_m = excluded.mature_height_m,
       years_to_mature = excluded.years_to_mature`,
    [
      id,
      input.commonName,
      input.latinName ?? null,
      input.category ?? 'tree',
      input.matureCanopyM ?? null,
      input.matureHeightM ?? null,
      input.yearsToMature ?? null,
      now(),
    ],
  );
  return ctx.sql.query<SpeciesRow>('SELECT * FROM garden_species WHERE id = ?', [id])[0]!;
};

const listSpeciesOp: OperationHandler<undefined, SpeciesRow[]> = async (ctx) => {
  assertAllowed(await ctx.check(GARDEN_PERM.read));
  return ctx.sql.query<SpeciesRow>('SELECT * FROM garden_species ORDER BY common_name');
};

const addPlantInput = z.object({
  siteId: z.string().min(1),
  pointId: z.string().min(1),
  speciesId: z.string().min(1),
  label: z.string().optional(),
  plantedOn: z.string().optional(),
  note: z.string().optional(),
});

const addPlantOp: OperationHandler<z.infer<typeof addPlantInput>, PlantRow> = async (
  ctx,
  rawInput,
) => {
  assertAllowed(await ctx.check(GARDEN_PERM.manage));
  const input = addPlantInput.parse(rawInput);
  siteOr404(ctx, input.siteId);
  const point = pointOr404(ctx, input.pointId);
  if (point.site_id !== input.siteId) throw new Error('the planting point must belong to the site');
  const species = ctx.sql.query<SpeciesRow>('SELECT * FROM garden_species WHERE id = ?', [
    input.speciesId,
  ])[0];
  if (!species) throw new Error(`species not found: ${input.speciesId}`);
  const id = ulid();
  ctx.sql.exec(
    `INSERT INTO garden_plants (id, site_id, point_id, species_id, label, planted_on, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.siteId,
      input.pointId,
      input.speciesId,
      input.label ?? null,
      input.plantedOn ?? null,
      input.note ?? null,
      now(),
    ],
  );
  ctx.link({ entityType: 'plant', entityId: id }, { entityType: 'site', entityId: input.siteId });
  ctx.emit({
    type: 'garden.plant-added',
    schemaVersion: 1,
    entity: { entityType: 'plant', entityId: id },
    piiClass: 'none',
    payload: {
      siteId: input.siteId,
      plantId: id,
      species: species.common_name,
      at: { pointId: point.id, pointName: point.name },
    },
  });
  return ctx.sql.query<PlantRow>('SELECT * FROM garden_plants WHERE id = ?', [id])[0]!;
};

const plantIdInput = z.object({ plantId: z.string().min(1) });

const removePlantOp: OperationHandler<z.infer<typeof plantIdInput>, { deleted: string }> = async (
  ctx,
  rawInput,
) => {
  assertAllowed(await ctx.check(GARDEN_PERM.manage));
  const { plantId } = plantIdInput.parse(rawInput);
  const p = ctx.sql.query<PlantRow>('SELECT * FROM garden_plants WHERE id = ?', [plantId])[0];
  if (!p) throw new Error(`plant not found: ${plantId}`);
  ctx.sql.exec('DELETE FROM garden_plants WHERE id = ?', [plantId]);
  ctx.emit({
    type: 'garden.plant-removed',
    schemaVersion: 1,
    entity: { entityType: 'plant', entityId: plantId },
    piiClass: 'none',
    payload: { siteId: p.site_id, plantId },
  });
  return { deleted: plantId };
};

// ── DXF export ───────────────────────────────────────────────────────────────

const exportDxfOp: OperationHandler<
  z.infer<typeof siteIdInput>,
  { filename: string; dxf: string }
> = async (ctx, rawInput) => {
  // Viewers can export (DESIGN.md §4) — read, not manage.
  assertAllowed(await ctx.check(GARDEN_PERM.read));
  const { siteId } = siteIdInput.parse(rawInput);
  const site = siteOr404(ctx, siteId);
  const { points } = loadSurvey(ctx, siteId);
  const placed = points.filter((p) => p.x !== null && p.y !== null);
  const byId = new Map(placed.map((p) => [p.id, p]));

  const polylines: DxfPolyline[] = [];
  const features = ctx.sql.query<FeatureRow>('SELECT * FROM garden_features WHERE site_id = ?', [
    siteId,
  ]);
  for (const f of features) {
    const vertices = ctx.sql
      .query<{ point_id: string; curved_to_next: number }>(
        'SELECT point_id, curved_to_next FROM garden_feature_vertices WHERE feature_id = ? ORDER BY seq',
        [f.id],
      )
      .map((v) => {
        const p = byId.get(v.point_id);
        return p
          ? { x: p.x!, y: p.y!, z: p.elevation_m ?? 0, curvedToNext: v.curved_to_next === 1 }
          : null;
      })
      .filter((v): v is NonNullable<typeof v> => v !== null);
    if (vertices.length < 2) continue;
    polylines.push({
      layer: `FEATURE-${f.type.toUpperCase()}`,
      closed: f.closed === 1,
      vertices: sampleRun(vertices, f.closed === 1),
    });
  }

  const plants = ctx.sql
    .query<PlantRow>('SELECT * FROM garden_plants WHERE site_id = ?', [siteId])
    .map((plant) => {
      const point = byId.get(plant.point_id);
      if (!point) return null;
      const species = ctx.sql.query<SpeciesRow>('SELECT * FROM garden_species WHERE id = ?', [
        plant.species_id,
      ])[0];
      return {
        label: plant.label ?? species?.common_name ?? 'plant',
        x: point.x!,
        y: point.y!,
        z: point.elevation_m ?? 0,
        canopyRadius: (species?.mature_canopy_m ?? 1) / 2,
      };
    })
    .filter((p): p is NonNullable<typeof p> => p !== null);

  const dxf = buildDxf({
    points: placed.map((p) => ({ name: p.name, x: p.x!, y: p.y!, z: p.elevation_m ?? 0 })),
    polylines,
    plants,
  });

  ctx.emit({
    type: 'garden.dxf-exported',
    schemaVersion: 1,
    entity: { entityType: 'site', entityId: siteId },
    piiClass: 'none',
    payload: { siteId, points: placed.length, features: polylines.length, plants: plants.length },
  });

  const slug = site.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return { filename: `${slug || 'garden'}.dxf`, dxf };
};

// ── Timeline ─────────────────────────────────────────────────────────────────

const timelineInput = z.object({
  entityType: z.string().min(1),
  entityId: z.string().min(1),
});

/**
 * An entity's event timeline, read straight off the spine (reading
 * `_substrat_*` for a projection is allowed; writing it is not). This is the
 * audit answer to "why did the pool move 12 cm last Tuesday".
 */
const timelineOp: OperationHandler<
  z.infer<typeof timelineInput>,
  { type: string; occurred_at: string; actor: string; payload: string }[]
> = async (ctx, rawInput) => {
  assertAllowed(await ctx.check(GARDEN_PERM.read));
  const entity = timelineInput.parse(rawInput);
  return ctx.sql.query(
    `SELECT type, occurred_at, actor, payload FROM _substrat_outbox
     WHERE entity_type = ? AND entity_id = ? ORDER BY rowid`,
    [entity.entityType, entity.entityId],
  );
};

// ── Who am I ─────────────────────────────────────────────────────────────────

/**
 * The caller's role hint for the SPA shell: `read` is the gate, `manage` is the
 * probe. No new permission keys — the answer is derived from the same two grants
 * every other operation checks, so this cannot say anything the kernel wouldn't.
 */
const whoamiOp: OperationHandler<void, { role: 'garden-owner' | 'garden-viewer' }> = async (
  ctx,
) => {
  assertAllowed(await ctx.check(GARDEN_PERM.read));
  const manage = await ctx.check(GARDEN_PERM.manage);
  return { role: manage.allowed ? 'garden-owner' : 'garden-viewer' };
};

export const gardenModule: ModuleRegistration = {
  manifest: gardenManifest,
  migrations: gardenMigrations,
  operations: {
    'garden/create-site': createSiteOp as never,
    'garden/list-sites': listSitesOp as never,
    'garden/get-site': getSiteOp as never,
    'garden/create-point': createPointOp as never,
    'garden/update-point': updatePointOp as never,
    'garden/delete-point': deletePointOp as never,
    'garden/choose-side': chooseSideOp as never,
    'garden/add-measurement': addMeasurementOp as never,
    'garden/delete-measurement': deleteMeasurementOp as never,
    'garden/preview-constraint': previewConstraintOp as never,
    'garden/add-constraint': addConstraintOp as never,
    'garden/delete-constraint': deleteConstraintOp as never,
    'garden/solve': solveOp as never,
    'garden/create-feature': createFeatureOp as never,
    'garden/update-feature': updateFeatureOp as never,
    'garden/delete-feature': deleteFeatureOp as never,
    'garden/list-species': listSpeciesOp as never,
    'garden/upsert-species': upsertSpeciesOp as never,
    'garden/add-plant': addPlantOp as never,
    'garden/remove-plant': removePlantOp as never,
    'garden/export-dxf': exportDxfOp as never,
    'garden/timeline': timelineOp as never,
    'garden/whoami': whoamiOp as never,
  },
};
