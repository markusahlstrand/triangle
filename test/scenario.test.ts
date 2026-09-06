import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { ScopeStub } from '@substrat-run/kernel';
import type { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { buildTriangleHost, seedTriangle, type TriangleWorld } from '../src/seed.js';
import type { SitePayload, SolveReport } from '../src/module.js';

// ============================================================================
// The Triangle scenario (spec/concept.md §9), replayed headlessly against a temp
// dir: the seeded survey solves to the real rectangle, a new point walks the
// mirror-choice flow, a lying tape pull surfaces as a residual, the DXF
// export carries every promised label — then every door that should be shut
// is proven shut, each denial pinned to its message and paired with a control
// that a neighbouring door is open.
// ============================================================================

describe('triangle scenario', () => {
  let dir: string;
  let host: SqliteScopeHost;
  let w: TriangleWorld;
  let markus: ScopeStub;
  let vera: ScopeStub;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-triangle-'));
    host = buildTriangleHost(dir);
    w = await seedTriangle(host, dir);
    markus = await host.getScope(w.markus, w.t1, w.s1);
    vera = await host.getScope(w.vera, w.t1, w.s1);
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('1. provisions and applies the garden journal', () => {
    const db = new Database(join(dir, `${w.t1}__${w.s1}.sqlite`), { readonly: true });
    const rows = db
      .prepare('SELECT DISTINCT module_id FROM _substrat_migrations ORDER BY module_id')
      .all() as { module_id: string }[];
    db.close();
    expect(rows.map((r) => r.module_id)).toEqual(['garden']);
  });

  it('2. the seeded survey solves to the real house rectangle', async () => {
    const site = await markus.invoke<SitePayload>('garden/get-site', { siteId: w.siteId });
    const byId = new Map(site.points.map((p) => [p.id, p]));

    const sw = byId.get(w.points.houseSW!)!;
    const se = byId.get(w.points.houseSE!)!;
    const ne = byId.get(w.points.houseNE!)!;
    const nw = byId.get(w.points.houseNW!)!;

    // The frame: origin at (0,0), baseline on the +x axis.
    expect(sw.x).toBeCloseTo(0, 6);
    expect(sw.y).toBeCloseTo(0, 6);
    expect(se.y).toBeCloseTo(0, 6);
    expect(se.x).toBeCloseTo(12.4, 1);
    // The far corners land on the rectangle (within survey tolerance, cm).
    expect(ne.x).toBeCloseTo(12.4, 1);
    expect(ne.y).toBeCloseTo(8.2, 1);
    expect(nw.x).toBeCloseTo(0, 1);
    expect(nw.y).toBeCloseTo(8.2, 1);
    // The pool is south of the baseline — the chosen mirror side held.
    expect(byId.get(w.points.poolNW!)!.y).toBeLessThan(0);
    expect(byId.get(w.points.poolNE!)!.y).toBeLessThan(0);
    // Everything seeded is placed; the survey agrees with itself to under 2 cm.
    expect(site.points.every((p) => p.status === 'placed')).toBe(true);
    expect(site.solve.rmsCm).toBeLessThan(2);
    // The seeded right-angle assumption carries its own residual, on the record.
    expect(Object.keys(site.solve.constraintResidualsCm)).toHaveLength(1);
  });

  it('3. a two-distance point waits for its mirror choice, then lands on the chosen side', async () => {
    const created = await markus.invoke<{ id: string }>('garden/create-point', {
      siteId: w.siteId,
      name: 'terrace SE',
      elevationM: 0,
    });
    await markus.invoke('garden/add-measurement', {
      siteId: w.siteId,
      pointA: w.points.houseSE!,
      pointB: created.id,
      distanceCm: 430,
    });
    const second = await markus.invoke<{ solve: SolveReport }>('garden/add-measurement', {
      siteId: w.siteId,
      pointA: w.points.houseNE!,
      pointB: created.id,
      distanceCm: 940,
    });

    // Two distances → held for a mirror choice, with both candidates offered.
    const pending = second.solve.needsSide.find((n) => n.id === created.id);
    expect(pending).toBeDefined();
    expect(pending!.candidates).toHaveLength(2);
    let site = await markus.invoke<SitePayload>('garden/get-site', { siteId: w.siteId });
    expect(site.points.find((p) => p.id === created.id)!.status).toBe('measured');

    // Choose the south side; the point places there.
    const chosen = await markus.invoke<{ point: { status: string }; solve: SolveReport }>(
      'garden/choose-side',
      { pointId: created.id, side: -1 },
    );
    expect(chosen.point.status).toBe('placed');
    site = await markus.invoke<SitePayload>('garden/get-site', { siteId: w.siteId });
    const placed = site.points.find((p) => p.id === created.id)!;
    expect(placed.y).toBeLessThan(0);

    // Housekeeping: remove the point again (no feature uses it).
    await markus.invoke('garden/delete-point', { pointId: created.id });
  });

  it('4. a lying tape pull surfaces as a residual and never silently bends the map', async () => {
    // The true SW→NE diagonal is ~14.87 m; report it 8 cm long.
    const lying = await markus.invoke<{ measurement: { id: string }; solve: SolveReport }>(
      'garden/add-measurement',
      {
        siteId: w.siteId,
        pointA: w.points.houseSW!,
        pointB: w.points.houseNE!,
        distanceCm: 1495,
      },
    );
    const residuals = lying.solve.measurementResidualsCm;
    const worst = Math.max(...Object.values(residuals));
    expect(worst).toBeGreaterThan(0.5); // the disagreement is on the record…
    expect(worst).toBeLessThan(8); // …spread by adjustment, not eaten

    // Deleting the bad pull restores the survey.
    const restored = await markus.invoke<{ solve: SolveReport }>('garden/delete-measurement', {
      measurementId: lying.measurement.id,
    });
    expect(restored.solve.rmsCm).toBeLessThan(2);
  });

  it('5. a constraint previews its shove before it applies', async () => {
    const preview = await markus.invoke<SolveReport>('garden/preview-constraint', {
      siteId: w.siteId,
      kind: 'right-angle',
      pointIds: [w.points.houseSE!, w.points.houseSW!, w.points.houseNE!],
    });
    // A dry run: reports what would move, but the stored map is untouched.
    const site = await markus.invoke<SitePayload>('garden/get-site', { siteId: w.siteId });
    expect(site.constraints).toHaveLength(1); // still only the seeded one
    expect(preview.constraintResidualsCm).toBeDefined();
  });

  it('6. the DXF carries every promised name, layer and canopy circle', async () => {
    const { filename, dxf } = await markus.invoke<{ filename: string; dxf: string }>(
      'garden/export-dxf',
      { siteId: w.siteId },
    );
    expect(filename).toBe('casa-markus.dxf');
    // Layers per concept §7.
    for (const layer of ['POINTS', 'POINT-LABELS', 'FEATURE-HOUSE', 'FEATURE-RETENTION-WALL', 'PLANTS', 'PLANT-LABELS']) {
      expect(dxf).toContain(layer);
    }
    // Point labels carry name + elevation from garden_points…
    expect(dxf).toContain('house SW corner (+0)');
    expect(dxf).toContain('pool NW (-1.2)');
    // …the plant label comes from garden_plants.label…
    expect(dxf).toContain('olivo grande');
    // …and the olive's canopy circle has the species' mature radius (6 m / 2).
    expect(dxf).toMatch(/CIRCLE[\s\S]{0,200}40\n3\b/);
    // The curved wall segment was sampled into extra vertices: more VERTEX
    // records than the two surveyed wall points + four house corners.
    const vertexCount = (dxf.match(/^VERTEX$/gm) ?? []).length;
    expect(vertexCount).toBeGreaterThan(10);
  });

  it('7. the viewer sees everything and changes nothing', async () => {
    // The SPA's role hint tells each of them apart — derived from the same two
    // grants every operation checks, so it can't disagree with the kernel.
    await expect(markus.invoke('garden/whoami')).resolves.toEqual({ role: 'garden-owner' });
    await expect(vera.invoke('garden/whoami')).resolves.toEqual({ role: 'garden-viewer' });
    // Vera reads the map…
    const site = await vera.invoke<SitePayload>('garden/get-site', { siteId: w.siteId });
    expect(site.site.name).toBe('Casa Markus');
    expect(site.plants[0]!.species.common_name).toBe('Olivo');
    // …and may export (concept §4: viewers export DXF)…
    await expect(
      vera.invoke('garden/export-dxf', { siteId: w.siteId }),
    ).resolves.toHaveProperty('dxf');
    // …but every write is a shut door, each with its pinned message.
    await expect(
      vera.invoke('garden/create-point', { siteId: w.siteId, name: 'sneaky point' }),
    ).rejects.toThrow(/permission denied/);
    await expect(
      vera.invoke('garden/add-measurement', {
        siteId: w.siteId,
        pointA: w.points.houseSW!,
        pointB: w.points.houseSE!,
        distanceCm: 100,
      }),
    ).rejects.toThrow(/permission denied/);
    await expect(
      vera.invoke('garden/remove-plant', { plantId: site.plants[0]!.id }),
    ).rejects.toThrow(/permission denied/);
    await expect(vera.invoke('garden/solve', { siteId: w.siteId })).rejects.toThrow(
      /permission denied/,
    );
  });

  it('8. the neighbour gets nothing: wrong pair fails, right pair holds no tuples', async () => {
    // Claiming Casa Markus's scope under his OWN tenant fails the pair check…
    await expect(host.getScope(w.nils, w.t2, w.s1)).rejects.toThrow(/unknown scope/);
    // …the control: his own (t2, s2) pair resolves, and his own garden lists.
    const home = await host.getScope(w.nils, w.t2, w.s2);
    // A paged read: in-process callers get the `Page` envelope the wire projects into headers.
    const own = (await home.invoke<{ entries: { name: string }[] }>('garden/list-sites')).entries;
    expect(own.map((s) => s.name)).toEqual(['Vecino back plot']);

    // With the correct (t1, s1) pair he can mint a stub but holds no tuples
    // there — every operation is denied by the owning scope's evaluation.
    const intruder = await host.getScope(w.nils, w.t1, w.s1);
    await expect(intruder.invoke('garden/whoami')).rejects.toThrow(/permission denied/);
    await expect(intruder.invoke('garden/list-sites')).rejects.toThrow(/permission denied/);
    await expect(intruder.invoke('garden/get-site', { siteId: w.siteId })).rejects.toThrow(
      /permission denied/,
    );
    await expect(intruder.invoke('garden/export-dxf', { siteId: w.siteId })).rejects.toThrow(
      /permission denied/,
    );
    // And Markus's garden never leaks into the neighbour's own list.
    expect(own.some((s) => s.name === 'Casa Markus')).toBe(false);
  });

  it('9. structure holds: no deleting a point a wall stands on, no zero-length tape', async () => {
    await expect(
      markus.invoke('garden/delete-point', { pointId: w.points.poolNW! }),
    ).rejects.toThrow(/point in use by feature/);
    await expect(
      markus.invoke('garden/add-measurement', {
        siteId: w.siteId,
        pointA: w.points.houseSW!,
        pointB: w.points.houseSW!,
        distanceCm: 100,
      }),
    ).rejects.toThrow(/two different points/);
    // The control: the same point deletes fine once the wall lets go of it —
    // proven indirectly in test 3 where an unused point deleted cleanly.
  });

  it('10. the audit spine answers "why did the pool move"', async () => {
    const siteTimeline = await markus.invoke<{ entries: { type: string; payload: unknown }[] }>(
      'garden/timeline',
      { entityType: 'site', entityId: w.siteId, limit: 100 },
    );
    const types = siteTimeline.entries.map((e) => e.type);
    expect(types).toContain('garden.site-created');
    expect(types).toContain('garden.solved'); // every survey change that moved a point
    // The history carries the fat payload — what moved, and by how much.
    const solved = siteTimeline.entries.find((e) => e.type === 'garden.solved')!;
    expect(solved.payload).toHaveProperty('moved');

    const pointTimeline = await markus.invoke<{ entries: { type: string }[] }>('garden/timeline', {
      entityType: 'point',
      entityId: w.points.poolNW!,
    });
    expect(pointTimeline.entries.map((e) => e.type)).toContain('garden.point-created');

    // The viewer can read the audit trail too — read, not manage.
    await expect(
      vera.invoke('garden/timeline', { entityType: 'site', entityId: w.siteId }),
    ).resolves.toBeTruthy();
  });
});
