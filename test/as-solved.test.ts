import { describe, expect, it } from 'vitest';
import { asSolved, type MeasurementRow, type PointRow, type SolveReport } from '../src/module.js';

// A read shows the points where the CURRENT solve puts them: the stored x/y are the last solve
// written, and when the solver has improved since, they lag behind the residuals the same read
// reports. This is the overlay that keeps the map and the residuals one picture.

const point = (id: string, x: number | null, y: number | null, status = 'placed'): PointRow =>
  ({ id, site_id: 's', seq: 0, name: id, x, y, status, elevation_m: null, locked: 0, side: null, note: null, created_at: '' }) as unknown as PointRow;
const pull = (a: string, b: string): MeasurementRow =>
  ({ id: `${a}${b}`, site_id: 's', point_a: a, point_b: b, distance_m: 1, note: null, created_at: '', verified_at: null }) as MeasurementRow;

const report = (over: Partial<SolveReport>): SolveReport => ({
  siteId: 's', moved: [], placed: [], unplaced: [], needsSide: [], measurementResidualsCm: {}, constraintResidualsCm: {}, rmsCm: 0, suspects: [], ...over,
});

describe('asSolved', () => {
  it('moves a stale point to where the current solve puts it', () => {
    const out = asSolved([point('A', 0, 0), point('B', 9, -2)], [pull('A', 'B')], report({
      placed: ['A', 'B'],
      moved: [{ pointId: 'B', from: { x: 9, y: -2 }, to: { x: 9, y: 2 }, deltaCm: 400 }],
    }));
    expect(out.find((p) => p.id === 'B')).toMatchObject({ x: 9, y: 2, status: 'placed' });
    expect(out.find((p) => p.id === 'A')).toMatchObject({ x: 0, y: 0, status: 'placed' });
  });

  it('shows a point the current solve cannot place as unplaced, not at its old spot', () => {
    const out = asSolved([point('A', 0, 0), point('C', 3, 3)], [pull('A', 'C')], report({ placed: ['A'] }));
    expect(out.find((p) => p.id === 'C')).toMatchObject({ x: null, y: null, status: 'measured' });
  });
});
