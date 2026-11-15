import { describe, it, expect } from 'vitest';
import {
  circleIntersection,
  findSuspects,
  sideOf,
  solveGarden,
  type SolveConstraint,
  type SolveMeasurement,
  type SolvePoint,
  type XY,
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

describe('findSuspects', () => {
  // A 10 × 6 m rectangle A B C D with a stake E inside, every side, both diagonals and E to
  // every corner taped: ten pulls for seven unknowns, so any one pull is checked by the rest.
  const corners = { A: { x: 0, y: 0 }, B: { x: 10, y: 0 }, C: { x: 10, y: 6 }, D: { x: 0, y: 6 }, E: { x: 4, y: 2 } };
  type K = keyof typeof corners;
  const d = (c: Record<K, XY>, p: K, q: K) => Math.hypot(c[p].x - c[q].x, c[p].y - c[q].y);
  const pts = [P('A'), P('B'), P('C', { side: 1 }), P('D', { side: 1 }), P('E', { side: 1 })];
  const pairs = [
    ['ab', 'A', 'B'], ['bc', 'B', 'C'], ['cd', 'C', 'D'], ['da', 'D', 'A'], ['ac', 'A', 'C'],
    ['bd', 'B', 'D'], ['ea', 'E', 'A'], ['eb', 'E', 'B'], ['ec', 'E', 'C'], ['ed', 'E', 'D'],
  ] as const;
  const survey = (bad?: { id: string; by: number }, c: Record<K, XY> = corners, only = pairs.map((p) => p[0] as string)) =>
    pairs.filter(([id]) => only.includes(id)).map(([id, a, b]) => M(id, a, b, d(c, a, b) + (bad?.id === id ? bad.by : 0)));

  it('accuses nobody when the tape agrees', () => {
    expect(findSuspects(pts, survey(), [])).toEqual([]);
  });

  it('names the one bad pull and what it should have read', () => {
    const s = findSuspects(pts, survey({ id: 'ac', by: 0.25 }), []);
    expect(s[0]).toMatchObject({ kind: 'measurement', id: 'ac' });
    expect(s[0]!.expected!).toBeCloseTo(d(corners, 'A', 'C'), 2);
    expect(s[0]!.offBy).toBeCloseTo(0.25, 2);
    expect(s[0]!.worstWithout).toBeLessThan(0.005);
    expect(s[0]!.explains - (s[1]?.explains ?? 0)).toBeGreaterThan(0.2);
  });

  it('blames the bad pull, not the right angle it bent', () => {
    const square: SolveConstraint = { id: 'sq', kind: 'right-angle', points: ['A', 'B', 'D'] };
    const s = findSuspects(pts, survey({ id: 'da', by: 0.3 }), [square]);
    expect(s[0]).toMatchObject({ kind: 'measurement', id: 'da' });
  });

  it('blames a right angle the tape contradicts', () => {
    // The tape is consistent, but the corner it describes is not square.
    const skew = { ...corners, D: { x: 0.4, y: 6 }, C: { x: 10.4, y: 6 } };
    const square: SolveConstraint = { id: 'sq', kind: 'right-angle', points: ['A', 'B', 'D'] };
    const s = findSuspects(pts, survey(undefined, skew), [square]);
    expect(s[0]).toMatchObject({ kind: 'constraint', id: 'sq' });
  });

  it('cannot tell which pull of a single loop is wrong — and says so by a tie', () => {
    // Without E: six pulls, five unknowns. One spare pull catches the error but cannot place it.
    const loop = ['ab', 'bc', 'cd', 'da', 'ac', 'bd'];
    const s = findSuspects(pts.slice(0, 4), survey({ id: 'ac', by: 0.25 }, corners, loop), [], undefined, 6);
    expect(s.length).toBeGreaterThan(1);
    expect(s[0]!.explains - s[1]!.explains).toBeLessThan(0.05);
  });

  it('never accuses a verified pull', () => {
    const meas = survey({ id: 'ac', by: 0.25 }).map((m) => (m.id === 'ac' ? { ...m, verified: true } : m));
    const s = findSuspects(pts, meas, []);
    expect(s.map((x) => x.id)).not.toContain('ac');
  });

  it('heals a wrong side that meets an independent cross-check, and accuses nobody', () => {
    // F and C are each fixed by two pulls (to A and B), so each side is a choice: F's was
    // right, C's wrong. E is pulled to A, B, F and C — all true distances — and cannot agree
    // with both F and a mirrored C. A wrong side only shows where it meets points placed
    // independently of it; a point placed only from C would simply follow it into the mirror.
    const truth = { A: { x: 0, y: 0 }, B: { x: 10, y: 0 }, F: { x: 2, y: 6 }, C: { x: 4, y: 3 }, E: { x: 7, y: 4 } };
    type T = keyof typeof truth;
    const t = (p: T, q: T) => Math.hypot(truth[p].x - truth[q].x, truth[p].y - truth[q].y);
    const pairs: [T, T][] = [['A', 'B'], ['A', 'F'], ['B', 'F'], ['A', 'C'], ['B', 'C'], ['A', 'E'], ['B', 'E'], ['F', 'E'], ['C', 'E']];
    const meas = pairs.map(([p, q]) => M(`${p}${q}`, p, q, t(p, q)));
    const order = [P('A'), P('B'), P('F', { side: 1 }), P('C', { side: -1 }), P('E', { side: 1 })];
    // The adjustment itself carries C back across A–B: a wrong side that meets an independent
    // cross-check heals, and nothing — not a pull, not a side — is accused.
    const r = solveGarden(order, meas, []);
    expect(r.coords.get('C')!.y).toBeCloseTo(3, 3);
    expect(findSuspects(order, meas, [])).toEqual([]);
  });

  it('lets a verified pull win over an unverified pull of the same pair', () => {
    const meas = [...survey(), M('ac2', 'A', 'C', d(corners, 'A', 'C') + 0.3)];
    const s = solveGarden(pts, meas.map((m) => (m.id === 'ac' ? { ...m, verified: true } : m)), []);
    // The verified pull fits; the stray re-pull carries the whole disagreement.
    expect(s.measurementResiduals.get('ac')!).toBeLessThan(0.002);
    expect(s.measurementResiduals.get('ac2')!).toBeCloseTo(0.3, 2);
  });
});
