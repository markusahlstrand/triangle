import { describe, it, expect } from 'vitest';
import {
  circleIntersection,
  sideOf,
  solveGarden,
  type SolveConstraint,
  type SolveMeasurement,
  type SolvePoint,
} from '../src/geometry.js';

// ============================================================================
// The solver, exercised on the spec/concept.md §9 numbers: house-SW is the origin,
// house-SE the 12.40 m baseline, pool-NW fixed by 7.10 m and 9.80 m — two
// mirror candidates until a side is chosen, a third distance auto-resolving,
// and the least-squares adjustment absorbing (and reporting) tape disagreement.
// ============================================================================

const P = (id: string, over: Partial<SolvePoint> = {}): SolvePoint => ({
  id,
  locked: false,
  side: null,
  x: null,
  y: null,
  ...over,
});
const M = (id: string, a: string, b: string, d: number): SolveMeasurement => ({ id, a, b, d });

// The two-circle solution for the design's numbers, derived independently.
const CX = (7.1 ** 2 - 9.8 ** 2 + 12.4 ** 2) / (2 * 12.4); // 4.3601…
const CY = Math.sqrt(7.1 ** 2 - CX ** 2); // 5.6035…

describe('circleIntersection', () => {
  it('finds both crossings, mirrored across the center line', () => {
    const [c1, c2] = circleIntersection({ x: 0, y: 0 }, 5, { x: 8, y: 0 }, 5);
    expect(c1.x).toBeCloseTo(4, 9);
    expect(c2.x).toBeCloseTo(4, 9);
    expect(c1.y).toBeCloseTo(3, 9);
    expect(c2.y).toBeCloseTo(-3, 9);
  });

  it('degrades to nearest approach when the tape numbers cannot meet', () => {
    const [c1, c2] = circleIntersection({ x: 0, y: 0 }, 1, { x: 10, y: 0 }, 1);
    expect(c1).toEqual(c2);
    expect(c1.y).toBeCloseTo(0, 9);
  });
});

describe('solveGarden', () => {
  it('places origin and baseline from the first tape pull', () => {
    const r = solveGarden(
      [P('A'), P('B')],
      [M('m1', 'A', 'B', 12.4)],
      [],
    );
    expect(r.coords.get('A')).toEqual({ x: 0, y: 0 });
    expect(r.coords.get('B')!.x).toBeCloseTo(12.4, 6);
    expect(r.coords.get('B')!.y).toBeCloseTo(0, 6);
  });

  it('holds a two-distance point for a mirror choice, then places it by side', () => {
    const points = [P('A'), P('B'), P('C')];
    const meas = [M('m1', 'A', 'B', 12.4), M('m2', 'A', 'C', 7.1), M('m3', 'B', 'C', 9.8)];

    const pending = solveGarden(points, meas, []);
    expect(pending.coords.has('C')).toBe(false);
    expect(pending.needsSide).toHaveLength(1);
    const choice = pending.needsSide[0]!;
    expect(choice.id).toBe('C');
    expect(choice.candidates[0]!.y).toBeCloseTo(CY, 3);
    expect(choice.candidates[1]!.y).toBeCloseTo(-CY, 3);

    const south = solveGarden([P('A'), P('B'), P('C', { side: -1 })], meas, []);
    const c = south.coords.get('C')!;
    expect(c.x).toBeCloseTo(CX, 3);
    expect(c.y).toBeCloseTo(-CY, 3);
    expect(south.needsSide).toHaveLength(0);
  });

  it('a third distance auto-resolves the mirror and yields a residual', () => {
    // D placed above the baseline; C's true position below it.
    const D = { x: 3.0, y: 6.5 };
    const C = { x: CX, y: -CY };
    const dAD = Math.hypot(D.x, D.y);
    const dCD = Math.hypot(C.x - D.x, C.y - D.y);
    const r = solveGarden(
      [P('A'), P('B'), P('D', { side: 1 }), P('C')],
      [
        M('m1', 'A', 'B', 12.4),
        M('m2', 'A', 'D', dAD),
        M('m3', 'B', 'D', Math.hypot(D.x - 12.4, D.y)),
        M('m4', 'A', 'C', 7.1),
        M('m5', 'B', 'C', 9.8),
        M('m6', 'D', 'C', dCD),
      ],
      [],
    );
    const c = r.coords.get('C')!;
    expect(c.x).toBeCloseTo(CX, 2);
    expect(c.y).toBeCloseTo(-CY, 2); // picked the south side without a choice
    expect(r.needsSide).toHaveLength(0);
    // Perfectly consistent tape → residuals near zero.
    expect(r.measurementResiduals.get('m6')!).toBeLessThan(0.005);
    expect(r.rms).toBeLessThan(0.005);
  });

  it('reports tape disagreement as a residual instead of hiding it', () => {
    // A 12.40 × 8.20 rectangle taped fully — four sides and both diagonals —
    // with one diagonal 6 cm off on purpose. Six pulls against five free
    // coordinates: one redundancy, so the lie has nowhere to hide.
    const diag = Math.hypot(12.4, 8.2);
    const r = solveGarden(
      [P('A'), P('B'), P('C', { side: 1 }), P('D', { side: 1 })],
      [
        M('m1', 'A', 'B', 12.4),
        M('m2', 'B', 'C', 8.2),
        M('m3', 'C', 'D', 12.4),
        M('m4', 'D', 'A', 8.2),
        M('m5', 'A', 'C', diag),
        M('m6', 'B', 'D', diag + 0.06),
      ],
      [],
    );
    expect(r.coords.has('C')).toBe(true);
    expect(r.coords.has('D')).toBe(true);
    const worst = Math.max(...r.measurementResiduals.values());
    expect(worst).toBeGreaterThan(0.005);
    expect(worst).toBeLessThan(0.06); // adjustment spreads the error, never eats it
  });

  it('an unmeasured point stays unplaced and says why', () => {
    const r = solveGarden(
      [P('A'), P('B'), P('E')],
      [M('m1', 'A', 'B', 12.4), M('m2', 'A', 'E', 4)],
      [],
    );
    expect(r.coords.has('E')).toBe(false);
    expect(r.unplaced).toEqual([{ id: 'E', distances: 1 }]);
  });

  it('a right-angle constraint nudges the corner and reports its own residual', () => {
    // A rectangle-ish corner at A between B and D, deliberately 2° off square.
    const angle = (92 * Math.PI) / 180;
    const D = { x: 8.2 * Math.cos(angle), y: 8.2 * Math.sin(angle) };
    const meas = [
      M('m1', 'A', 'B', 12.4),
      M('m2', 'A', 'D', 8.2),
      M('m3', 'B', 'D', Math.hypot(D.x - 12.4, D.y)),
    ];
    const square: SolveConstraint = { id: 'c1', kind: 'right-angle', points: ['A', 'B', 'D'] };

    const free = solveGarden([P('A'), P('B'), P('D', { side: 1 })], meas, []);
    const constrained = solveGarden([P('A'), P('B'), P('D', { side: 1 })], meas, [square]);

    const angleOf = (r: typeof free) => {
      const d = r.coords.get('D')!;
      const b = r.coords.get('B')!;
      return Math.abs(Math.atan2(d.y, d.x) - Math.atan2(b.y, b.x));
    };
    // The constraint pulls the corner toward 90°…
    expect(Math.abs(angleOf(constrained) - Math.PI / 2)).toBeLessThan(
      Math.abs(angleOf(free) - Math.PI / 2),
    );
    // …but the tape still resists (constraints weigh less than measurements),
    // and the leftover disagreement is on the record.
    expect(constrained.constraintResiduals.get('c1')!).toBeGreaterThan(0);
  });

  it('a locked point does not move during adjustment', () => {
    const r = solveGarden(
      [P('A'), P('B'), P('F', { locked: true, x: 5, y: 5 })],
      [M('m1', 'A', 'B', 12.4), M('m2', 'A', 'F', 7.2), M('m3', 'B', 'F', 9.0)],
      [],
    );
    expect(r.coords.get('F')).toEqual({ x: 5, y: 5 });
  });
});

describe('sideOf', () => {
  it('is the sign of the cross product against the anchor pair', () => {
    expect(sideOf({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0.5, y: 1 })).toBe(1);
    expect(sideOf({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0.5, y: -1 })).toBe(-1);
  });
});
