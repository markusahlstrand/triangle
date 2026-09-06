/**
 * The garden operations — the business logic, and nothing else.
 *
 * Everything structural is derived from `spec/model.ts`: the manifest, the
 * host-side input parsing (`operationInputs`), the concurrency guards, the
 * route table, the MCP tools, the API document and the SPA client. What is
 * left here is what only a person could decide — what a tape pull means, when
 * a point may be deleted, and that the SOLVER is the only writer of
 * coordinates (concept §2): every mutation that changes the survey re-solves,
 * persists, and returns what moved, so nothing moves silently.
 *
 * `satisfies { … OperationHandler<HandlerInput, HandlerOutput> }` is the join: a
 * handler whose input or return disagrees with its declaration, one declared and
 * not implemented, or one implemented and not declared, is a compile error naming
 * the exact operation.
 *
 * Data access is `ctx.sql` only. Time is `ctx.now()`. No `fetch`, no `node:*`.
 */
import {
  mapPage,
  operationConcurrencyOf,
  operationInputsOf,
  substratError,
  type EntityRow,
  type HandlerInput,
  type HandlerOutput,
  type z,
} from '@substrat-run/contracts';
import {
  assertAllowed,
  readHistory,
  ulid,
  type ModuleRegistration,
  type OperationContext,
  type OperationHandler,
} from '@substrat-run/kernel';
import {
  gardenEntities,
  gardenOperations,
  type sitePayload,
  type solveReport,
} from '../spec/model.js';
import { gardenManifest, GARDEN_PERM } from './manifest.js';
import { gardenMigrations } from './migrations.js';
import { solveGarden, type SolveConstraint, type SolvePoint } from './geometry.js';
import { buildDxf, sampleRun, type DxfPolyline } from './dxf.js';

export { FEATURE_TYPES } from '../spec/model.js';

export type SiteRow = EntityRow<typeof gardenEntities, 'site'>;
export type PointRow = EntityRow<typeof gardenEntities, 'point'>;
export type MeasurementRow = EntityRow<typeof gardenEntities, 'measurement'>;
export type ConstraintRow = EntityRow<typeof gardenEntities, 'constraint'>;
export type FeatureRow = EntityRow<typeof gardenEntities, 'feature'>;
export type SpeciesRow = EntityRow<typeof gardenEntities, 'species'>;
export type PlantRow = EntityRow<typeof gardenEntities, 'plant'>;

/** What a re-solve reports back to the caller — nothing moves silently. */
export type SolveReport = z.infer<typeof solveReport>;
/** The whole garden in one read. */
export type SitePayload = z.infer<typeof sitePayload>;

const cm = (m: number) => Math.round(m * 1000) / 10;

const siteRef = (id: string) => ({ entityType: 'site', entityId: id });

function siteOr404(ctx: OperationContext, siteId: string): SiteRow {
  const site = ctx.sql.query<SiteRow>('SELECT * FROM garden_sites WHERE id = ?', [siteId])[0];
  if (!site) throw substratError('not_found', `site not found: ${siteId}`);
  return site;
}

function pointOr404(ctx: OperationContext, pointId: string): PointRow {
  const p = ctx.sql.query<PointRow>('SELECT * FROM garden_points WHERE id = ?', [pointId])[0];
  if (!p) throw substratError('not_found', `point not found: ${pointId}`);
  return p;
}

function speciesOr404(ctx: OperationContext, speciesId: string): SpeciesRow {
  const s = ctx.sql.query<SpeciesRow>('SELECT * FROM garden_species WHERE id = ?', [speciesId])[0];
  if (!s) throw substratError('not_found', `species not found: ${speciesId}`);
  return s;
}

function featureOr404(ctx: OperationContext, featureId: string): FeatureRow {
  const f = ctx.sql.query<FeatureRow>('SELECT * FROM garden_features WHERE id = ?', [featureId])[0];
  if (!f) throw substratError('not_found', `feature not found: ${featureId}`);
  return f;
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

function residualsCm(residuals: Map<string, number>): Record<string, number> {
  return Object.fromEntries([...residuals].map(([id, r]) => [id, cm(r)]));
}

/**
 * Re-solve a site and (when `persist`) write the coordinates back — the ONLY
 * writer of garden_points.x/y/status. Returns what moved, in cm, so every
 * caller can show a before/after (concept §2: nothing moves silently).
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
        entity: siteRef(siteId),
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
    siteId,
    moved,
    placed: result.placed,
    unplaced: result.unplaced,
    needsSide: result.needsSide,
    measurementResidualsCm: residualsCm(result.measurementResiduals),
    constraintResidualsCm: residualsCm(result.constraintResiduals),
    rmsCm: cm(result.rms),
  };
}

function count(ctx: OperationContext, table: string, siteId: string): number {
  // table names come from the closed list at the call site, never from input
  return Number(
    ctx.sql.query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE site_id = ?`, [siteId])[0]!
      .n,
  );
}

function assertPointsOfSite(ctx: OperationContext, siteId: string, pointIds: readonly string[]): PointRow[] {
  return pointIds.map((id) => {
    const p = pointOr404(ctx, id);
    if (p.site_id !== siteId) throw new Error('all points must belong to the site');
    return p;
  });
}

function writeVertices(
  ctx: OperationContext,
  featureId: string,
  siteId: string,
  vertices: readonly { pointId: string; curvedToNext?: boolean | undefined }[],
): void {
  ctx.sql.exec('DELETE FROM garden_feature_vertices WHERE feature_id = ?', [featureId]);
  assertPointsOfSite(
    ctx,
    siteId,
    vertices.map((v) => v.pointId),
  );
  vertices.forEach((v, i) => {
    ctx.sql.exec(
      `INSERT INTO garden_feature_vertices (feature_id, seq, point_id, curved_to_next)
       VALUES (?, ?, ?, ?)`,
      [featureId, i, v.pointId, v.curvedToNext ? 1 : 0],
    );
  });
}

const operations = {
  // ── Sites ──────────────────────────────────────────────────────────────────

  'garden/create-site': async (ctx, input) => {
    assertAllowed(await ctx.check(GARDEN_PERM.manage));
    const id = ulid();
    ctx.sql.exec('INSERT INTO garden_sites (id, name, datum_note, created_at) VALUES (?, ?, ?, ?)', [
      id,
      input.name,
      input.datumNote ?? null,
      ctx.now(),
    ]);
    ctx.emit({
      type: 'garden.site-created',
      schemaVersion: 1,
      entity: siteRef(id),
      piiClass: 'none',
      payload: { siteId: id, name: input.name },
    });
    return siteOr404(ctx, id);
  },

  'garden/list-sites': async (ctx, input) => {
    assertAllowed(await ctx.check(GARDEN_PERM.read));
    // The kernel composes the walk (declared `paged.over`); the counts are ours.
    return mapPage(ctx.page<SiteRow>('site', input), (s) => ({
      ...s,
      points: count(ctx, 'garden_points', s.id),
      measurements: count(ctx, 'garden_measurements', s.id),
      features: count(ctx, 'garden_features', s.id),
      plants: count(ctx, 'garden_plants', s.id),
    }));
  },

  'garden/get-site': async (ctx, input) => {
    assertAllowed(await ctx.check(GARDEN_PERM.read));
    const site = siteOr404(ctx, input.siteId);
    const { points, measurements, constraints } = loadSurvey(ctx, site.id);
    const features = ctx.sql
      .query<FeatureRow>('SELECT * FROM garden_features WHERE site_id = ? ORDER BY created_at', [site.id])
      .map((f) => ({
        ...f,
        vertices: ctx.sql.query<{ point_id: string; seq: number; curved_to_next: number }>(
          'SELECT point_id, seq, curved_to_next FROM garden_feature_vertices WHERE feature_id = ? ORDER BY seq',
          [f.id],
        ),
        props: JSON.parse(f.props_json) as Record<string, unknown>,
      }));
    const plants = ctx.sql
      .query<PlantRow>('SELECT * FROM garden_plants WHERE site_id = ? ORDER BY created_at', [site.id])
      .map((p) => ({ ...p, species: speciesOr404(ctx, p.species_id) }));
    // Read-only solve: residuals + pending mirror choices for the UI, no writes.
    const solve = runSolve(ctx, site.id, false);
    return {
      site,
      points,
      measurements,
      constraints: constraints.map((c) => ({ ...c, points: JSON.parse(c.points_json) as string[] })),
      features,
      plants,
      solve,
    };
  },

  // ── Points ─────────────────────────────────────────────────────────────────

  'garden/create-point': async (ctx, input) => {
    assertAllowed(await ctx.check(GARDEN_PERM.manage));
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
      [id, input.siteId, seq, input.name, input.elevationM ?? null, input.note ?? null, ctx.now()],
    );
    ctx.link({ entityType: 'point', entityId: id }, siteRef(input.siteId));
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
  },

  'garden/update-point': async (ctx, input) => {
    assertAllowed(await ctx.check(GARDEN_PERM.manage));
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
    return { pointId: point.id, point: pointOr404(ctx, point.id), solve };
  },

  'garden/delete-point': async (ctx, input) => {
    assertAllowed(await ctx.check(GARDEN_PERM.manage));
    const point = pointOr404(ctx, input.pointId);
    const inFeatures = ctx.sql.query<{ name: string }>(
      `SELECT f.name FROM garden_feature_vertices v JOIN garden_features f ON f.id = v.feature_id
       WHERE v.point_id = ?`,
      [point.id],
    );
    if (inFeatures.length > 0) {
      throw substratError(
        'conflict',
        `point in use by feature: ${inFeatures.map((f) => f.name).join(', ')} — remove it from the feature first`,
      );
    }
    const plants = ctx.sql.query<{ id: string }>('SELECT id FROM garden_plants WHERE point_id = ?', [
      point.id,
    ]);
    if (plants.length > 0) throw substratError('conflict', 'point in use by plant — remove the plant first');

    ctx.sql.exec('DELETE FROM garden_measurements WHERE point_a = ? OR point_b = ?', [point.id, point.id]);
    // Constraints referencing the point go with it (they are assumptions about it).
    for (const c of ctx.sql.query<ConstraintRow>(
      'SELECT * FROM garden_constraints WHERE site_id = ?',
      [point.site_id],
    )) {
      if ((JSON.parse(c.points_json) as string[]).includes(point.id)) {
        ctx.sql.exec('DELETE FROM garden_constraints WHERE id = ?', [c.id]);
      }
    }
    ctx.sql.exec('DELETE FROM garden_points WHERE id = ?', [point.id]);
    ctx.emit({
      type: 'garden.point-deleted',
      schemaVersion: 1,
      entity: { entityType: 'point', entityId: point.id },
      piiClass: 'none',
      payload: { siteId: point.site_id, pointId: point.id, name: point.name },
    });
    const solve = runSolve(ctx, point.site_id, true);
    return { deleted: point.id, solve };
  },

  'garden/choose-side': async (ctx, input) => {
    assertAllowed(await ctx.check(GARDEN_PERM.manage));
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
    return { pointId: point.id, point: pointOr404(ctx, point.id), solve };
  },

  // ── Measurements ───────────────────────────────────────────────────────────

  'garden/add-measurement': async (ctx, input) => {
    assertAllowed(await ctx.check(GARDEN_PERM.manage));
    siteOr404(ctx, input.siteId);
    if (input.pointA === input.pointB) throw new Error('a distance needs two different points');
    const [a, b] = assertPointsOfSite(ctx, input.siteId, [input.pointA, input.pointB]) as [PointRow, PointRow];
    const id = ulid();
    ctx.sql.exec(
      `INSERT INTO garden_measurements (id, site_id, point_a, point_b, distance_m, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, input.siteId, a.id, b.id, input.distanceCm / 100, input.note ?? null, ctx.now()],
    );
    ctx.link({ entityType: 'measurement', entityId: id }, siteRef(input.siteId));
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
    return { measurementId: id, measurement, solve };
  },

  'garden/delete-measurement': async (ctx, input) => {
    assertAllowed(await ctx.check(GARDEN_PERM.manage));
    const m = ctx.sql.query<MeasurementRow>('SELECT * FROM garden_measurements WHERE id = ?', [
      input.measurementId,
    ])[0];
    if (!m) throw substratError('not_found', `measurement not found: ${input.measurementId}`);
    ctx.sql.exec('DELETE FROM garden_measurements WHERE id = ?', [m.id]);
    ctx.emit({
      type: 'garden.measurement-deleted',
      schemaVersion: 1,
      entity: { entityType: 'measurement', entityId: m.id },
      piiClass: 'none',
      payload: { siteId: m.site_id, measurementId: m.id, distanceCm: cm(m.distance_m) },
    });
    const solve = runSolve(ctx, m.site_id, true);
    return { deleted: m.id, solve };
  },

  // ── Constraints ────────────────────────────────────────────────────────────

  /** Dry-run: what WOULD this constraint move? (screen 21 — the honesty preview). */
  'garden/preview-constraint': async (ctx, input) => {
    assertAllowed(await ctx.check(GARDEN_PERM.read));
    siteOr404(ctx, input.siteId);
    assertPointsOfSite(ctx, input.siteId, input.pointIds);
    const { points, measurements, constraints } = loadSurvey(ctx, input.siteId);
    const { solvePoints, solveMeasurements, solveConstraints } = toSolverInput(
      points,
      measurements,
      constraints,
    );
    solveConstraints.push({ id: 'preview', kind: input.kind, points: input.pointIds } as SolveConstraint);
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
      siteId: input.siteId,
      moved,
      placed: result.placed,
      unplaced: result.unplaced,
      needsSide: result.needsSide,
      measurementResidualsCm: residualsCm(result.measurementResiduals),
      constraintResidualsCm: residualsCm(result.constraintResiduals),
      rmsCm: cm(result.rms),
    };
  },

  'garden/add-constraint': async (ctx, input) => {
    assertAllowed(await ctx.check(GARDEN_PERM.manage));
    siteOr404(ctx, input.siteId);
    assertPointsOfSite(ctx, input.siteId, input.pointIds);
    const id = ulid();
    ctx.sql.exec(
      `INSERT INTO garden_constraints (id, site_id, kind, points_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [id, input.siteId, input.kind, JSON.stringify(input.pointIds), ctx.now()],
    );
    ctx.link({ entityType: 'constraint', entityId: id }, siteRef(input.siteId));
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
    return { constraintId: id, constraint, solve };
  },

  'garden/delete-constraint': async (ctx, input) => {
    assertAllowed(await ctx.check(GARDEN_PERM.manage));
    const c = ctx.sql.query<ConstraintRow>('SELECT * FROM garden_constraints WHERE id = ?', [
      input.constraintId,
    ])[0];
    if (!c) throw substratError('not_found', `constraint not found: ${input.constraintId}`);
    ctx.sql.exec('DELETE FROM garden_constraints WHERE id = ?', [c.id]);
    ctx.emit({
      type: 'garden.constraint-deleted',
      schemaVersion: 1,
      entity: { entityType: 'constraint', entityId: c.id },
      piiClass: 'none',
      payload: { siteId: c.site_id, constraintId: c.id, kind: c.kind },
    });
    const solve = runSolve(ctx, c.site_id, true);
    return { deleted: c.id, solve };
  },

  // ── Solve (explicit full re-solve) ─────────────────────────────────────────

  'garden/solve': async (ctx, input) => {
    assertAllowed(await ctx.check(GARDEN_PERM.manage));
    siteOr404(ctx, input.siteId);
    return runSolve(ctx, input.siteId, true);
  },

  // ── Features ───────────────────────────────────────────────────────────────

  'garden/create-feature': async (ctx, input) => {
    assertAllowed(await ctx.check(GARDEN_PERM.manage));
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
        ctx.now(),
      ],
    );
    writeVertices(ctx, id, input.siteId, input.vertices);
    ctx.link({ entityType: 'feature', entityId: id }, siteRef(input.siteId));
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
    return featureOr404(ctx, id);
  },

  'garden/update-feature': async (ctx, input) => {
    assertAllowed(await ctx.check(GARDEN_PERM.manage));
    const f = featureOr404(ctx, input.featureId);
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
    return featureOr404(ctx, f.id);
  },

  'garden/delete-feature': async (ctx, input) => {
    assertAllowed(await ctx.check(GARDEN_PERM.manage));
    const f = featureOr404(ctx, input.featureId);
    ctx.sql.exec('DELETE FROM garden_feature_vertices WHERE feature_id = ?', [f.id]);
    ctx.sql.exec('DELETE FROM garden_features WHERE id = ?', [f.id]);
    ctx.emit({
      type: 'garden.feature-deleted',
      schemaVersion: 1,
      entity: { entityType: 'feature', entityId: f.id },
      piiClass: 'none',
      payload: { siteId: f.site_id, featureId: f.id, name: f.name },
    });
    return { deleted: f.id };
  },

  // ── Species & plants ───────────────────────────────────────────────────────

  'garden/list-species': async (ctx, input) => {
    assertAllowed(await ctx.check(GARDEN_PERM.read));
    return ctx.page<SpeciesRow>('species', input);
  },

  'garden/upsert-species': async (ctx, input) => {
    assertAllowed(await ctx.check(GARDEN_PERM.manage));
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
        input.category,
        input.matureCanopyM ?? null,
        input.matureHeightM ?? null,
        input.yearsToMature ?? null,
        ctx.now(),
      ],
    );
    const row = speciesOr404(ctx, id);
    ctx.emit({
      type: 'garden.species-upserted',
      schemaVersion: 1,
      entity: { entityType: 'species', entityId: id },
      piiClass: 'none',
      payload: { speciesId: id, commonName: row.common_name, category: row.category },
    });
    return row;
  },

  'garden/add-plant': async (ctx, input) => {
    assertAllowed(await ctx.check(GARDEN_PERM.manage));
    siteOr404(ctx, input.siteId);
    const [point] = assertPointsOfSite(ctx, input.siteId, [input.pointId]) as [PointRow];
    const species = speciesOr404(ctx, input.speciesId);
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
        ctx.now(),
      ],
    );
    ctx.link({ entityType: 'plant', entityId: id }, siteRef(input.siteId));
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
  },

  'garden/remove-plant': async (ctx, input) => {
    assertAllowed(await ctx.check(GARDEN_PERM.manage));
    const p = ctx.sql.query<PlantRow>('SELECT * FROM garden_plants WHERE id = ?', [input.plantId])[0];
    if (!p) throw substratError('not_found', `plant not found: ${input.plantId}`);
    ctx.sql.exec('DELETE FROM garden_plants WHERE id = ?', [p.id]);
    ctx.emit({
      type: 'garden.plant-removed',
      schemaVersion: 1,
      entity: { entityType: 'plant', entityId: p.id },
      piiClass: 'none',
      payload: { siteId: p.site_id, plantId: p.id },
    });
    return { deleted: p.id };
  },

  // ── DXF export ─────────────────────────────────────────────────────────────

  'garden/export-dxf': async (ctx, input) => {
    // Viewers can export (concept §4) — read, not manage.
    assertAllowed(await ctx.check(GARDEN_PERM.read));
    const site = siteOr404(ctx, input.siteId);
    const { points } = loadSurvey(ctx, site.id);
    const placed = points.filter((p) => p.x !== null && p.y !== null);
    const byId = new Map(placed.map((p) => [p.id, p]));

    const polylines: DxfPolyline[] = [];
    const features = ctx.sql.query<FeatureRow>('SELECT * FROM garden_features WHERE site_id = ?', [
      site.id,
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
      .query<PlantRow>('SELECT * FROM garden_plants WHERE site_id = ?', [site.id])
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
      entity: siteRef(site.id),
      piiClass: 'none',
      payload: { siteId: site.id, points: placed.length, features: polylines.length, plants: plants.length },
    });

    const slug = site.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return { siteId: site.id, filename: `${slug || 'garden'}.dxf`, dxf };
  },

  // ── Timeline ───────────────────────────────────────────────────────────────

  /**
   * An entity's event history, read off the spine through the kernel's own
   * `readHistory` (reading `_substrat_*` for a projection is allowed; writing it
   * is not). The audit answer to "why did the pool move 12 cm last Tuesday".
   */
  'garden/timeline': async (ctx, input) => {
    assertAllowed(await ctx.check(GARDEN_PERM.read));
    return readHistory(
      ctx,
      { entityType: input.entityType, entityId: input.entityId },
      {
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        ...(input.order === undefined ? {} : { order: input.order }),
      },
    );
  },

  // ── Who am I ───────────────────────────────────────────────────────────────

  /**
   * The caller's role hint for the SPA shell: `read` is the gate, `manage` is the
   * probe. No new permission keys — the answer is derived from the same two grants
   * every other operation checks, so this cannot say anything the kernel wouldn't.
   */
  'garden/whoami': async (ctx) => {
    assertAllowed(await ctx.check(GARDEN_PERM.read));
    const manage = await ctx.check(GARDEN_PERM.manage);
    return { role: manage.allowed ? ('garden-owner' as const) : ('garden-viewer' as const) };
  },
} satisfies {
  // Derived by the platform, not restated here — `HandlerOutput` is what knows
  // that a `paged` declaration means the handler returns a Page of the entry.
  [K in keyof typeof gardenOperations]: OperationHandler<
    HandlerInput<(typeof gardenOperations)[K]>,
    HandlerOutput<(typeof gardenOperations)[K]>
  >;
};

export const gardenModule: ModuleRegistration = {
  manifest: gardenManifest,
  migrations: gardenMigrations,
  // The host parses every invocation against the same declaration the routes,
  // the document and the client come from — HTTP, test, seed, MCP alike — so
  // "parse, don't trust" holds on every path in, not in the handlers that remembered.
  operationInputs: operationInputsOf(gardenOperations),
  // The `If-Match` precondition for the two field-bag updates, compared inside
  // the operation's transaction by the host.
  operationConcurrency: operationConcurrencyOf(gardenOperations),
  operations: operations as ModuleRegistration['operations'],
};
