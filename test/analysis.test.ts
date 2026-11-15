import { describe, expect, it } from 'vitest';
import { distanceRange, impossiblePulls, slipsOf, typoSearch, whatIf, type Survey } from '../src/analysis.js';
import type { SolveMeasurement, SolvePoint } from '../src/geometry.js';

// ============================================================================
// A terrace with a 34 × 34 cm pillar in it, surveyed from a baseline — the shape of a real
// survey that went wrong: every pillar pull is checked against the others, and errors are
// planted one at a time to prove each analysis names the right one.
// ============================================================================

const truth: Record<string, { x: number; y: number }> = {
  A: { x: 0, y: 0 }, //               baseline origin
  B: { x: 10, y: 0 }, //              baseline end
  C: { x: 9, y: -3 }, //              pool corner
  K: { x: 8, y: 4 }, //               kitchen door
  PNE: { x: 6.34, y: 0.34 }, //       the pillar's four corners
  PSE: { x: 6.34, y: 0 },
  PSW: { x: 6, y: 0 },
  PNW: { x: 6, y: 0.34 },
};
const t = (p: string, q: string) => Math.hypot(truth[p]!.x - truth[q]!.x, truth[p]!.y - truth[q]!.y);
const pairs: [string, string][] = [
  ['A', 'B'], ['A', 'C'], ['B', 'C'], ['A', 'K'], ['B', 'K'], ['C', 'K'],
  ['PNE', 'B'], ['PNE', 'K'], ['PNE', 'C'], ['PNE', 'PSE'], ['PSE', 'PSW'], ['PSW', 'PNW'], ['PNW', 'PNE'],
  ['PSE', 'B'], ['PSE', 'C'], ['PSW', 'A'], ['PSW', 'C'], ['PNW', 'K'], ['PNW', 'A'], ['PNW', 'C'],
];
const ORDER = ['A', 'B', 'C', 'K', 'PNE', 'PSE', 'PSW', 'PNW'];

function survey(edit: Record<string, number> = {}, verified: string[] = [], order = ORDER, locked: string[] = []): Survey {
  const points: SolvePoint[] = order.map((id) =>
    locked.includes(id)
      ? { id, locked: true, side: null, x: truth[id]!.x, y: truth[id]!.y }
      : { id, locked: false, side: id === 'C' ? -1 : 1, x: null, y: null },
  );
  const measurements: SolveMeasurement[] = pairs.map(([a, b]) => {
    const id = `${a}-${b}`;
    return { id, a, b, d: edit[id] ?? Math.round(t(a, b) * 100) / 100, verified: verified.includes(id) };
  });
  return { points, measurements, constraints: [], name: (id) => id };
}

describe('impossiblePulls', () => {
  it('finds nothing in a survey that closes', () => {
    expect(impossiblePulls(survey())).toEqual([]);
  });

  it('names a pull to the wrong point as impossible, with the range it must lie in', () => {
    // The pool corner taped to the pillar's SW corner at 9.87 m — the distance to A, not the pillar.
    const bad = impossiblePulls(survey({ 'PSW-C': 9.87 }));
    expect(bad[0]).toMatchObject({ id: 'PSW-C', tapedCm: 987 });
    expect(bad[0]!.triangles).toBeGreaterThan(1); // it breaks every triangle it is in
    const [lo, hi] = bad[0]!.mustBeBetweenCm;
    expect(t('PSW', 'C') * 100).toBeGreaterThanOrEqual(lo - 1);
    expect(t('PSW', 'C') * 100).toBeLessThanOrEqual(hi + 1);
    expect(hi).toBeLessThan(500); // nowhere near the 987 typed
  });
});

describe('distanceRange', () => {
  it('bounds a distance from every point taped to both ends', () => {
    const r = distanceRange(survey(), 'PSW', 'C');
    expect(r.consistent).toBe(true);
    expect(r.possibleCm![0]!).toBeLessThanOrEqual(t('PSW', 'C') * 100 + 1);
    expect(r.possibleCm![1]!).toBeGreaterThanOrEqual(t('PSW', 'C') * 100 - 1);
    expect(r.onTheMapCm!).toBeCloseTo(t('PSW', 'C') * 100, -1);
  });

  it('accepts names however a person writes them', () => {
    expect(distanceRange(survey(), 'psw', 'c').from).toBe('PSW');
    expect(() => distanceRange(survey(), 'P', 'C')).toThrow(/several points/);
  });
});

describe('whatIf', () => {
  it('shows dropping the bad pull is what makes the survey agree', () => {
    const s = survey({ 'PSW-C': 9.87 });
    const r = whatIf(s, { drop: [{ from: 'PSW', to: 'C' }] });
    expect(r.before.rmsCm).toBeGreaterThan(20);
    expect(r.after.rmsCm).toBeLessThan(2);
    expect(r.after.placed).toBe(r.before.placed);
    expect(r.dropped).toEqual(['PSW ↔ C']);
  });

  it('reads a pull as another value', () => {
    const r = whatIf(survey({ 'PSE-B': 2.7 }), { change: [{ from: 'PSE', to: 'B', cm: Math.round(t('PSE', 'B') * 100) }] });
    expect(r.after.rmsCm).toBeLessThan(r.before.rmsCm);
    expect(r.changed[0]).toMatch(/PSE ↔ B: 270 →/);
  });

  it('forces a point onto its mirror side — and a well-placed point gets worse for it', () => {
    // A survey is only ever known up to a mirror image: points placed FROM C simply follow it
    // across. What exposes a wrong side is a point fixed independently of C — here K, a locked
    // stake — whose pull to C cannot agree with the mirrored C.
    const r = whatIf(survey({}, [], ORDER, ['K']), { flip: ['C'] });
    expect(r.flipped[0]).toMatch(/^C mirrored across/);
    expect(r.after.rmsCm).toBeGreaterThan(r.before.rmsCm + 10);
  });
});

describe('typo slips', () => {
  it('knows the slips one keypad press away', () => {
    expect(slipsOf(340)).toEqual(expect.arrayContaining([34, 3400, 3040, 304, 430]));
  });

  it('finds an extra zero as the one reading far ahead of the rest', () => {
    const real = Math.round(t('PNE', 'K') * 100); // 456 cm
    const typed = Number(String(real).slice(0, 1) + '0' + String(real).slice(1)); // 4056
    const r = typoSearch(survey({ 'PNE-K': typed / 100 }));
    expect(r.best[0]!.id).toBe('PNE-K');
    expect(r.best[0]!.reading).toContain(`→ ${real} cm`);
    expect(r.best[0]!.rmsCm).toBeLessThan(2);
  });
});

describe('impossiblePulls and verified pulls', () => {
  it('never accuses a verified pull — the fault is another side of the triangle', () => {
    // PSE–B read as 2.70 m: the triangle PSE, PNE, B cannot close. PNE–PSE is verified, so the
    // accusation must land on PSE–B, not on the 34 cm pillar edge.
    const bad = impossiblePulls(survey({ 'PSE-B': 2.7 }, ['PNE-PSE', 'PNE-B']));
    expect(bad.map((b) => b.id)).not.toContain('PNE-PSE');
    expect(bad[0]!.id).toBe('PSE-B');
  });
});
