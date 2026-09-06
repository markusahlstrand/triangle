// ============================================================================
// The triangulation solver — PURE geometry, no kernel imports, no I/O. The
// garden module feeds it points + tape distances + constraints and writes the
// result back; this file never touches a database.
//
// Model (concept §2):
//   - The FIRST point (creation order) is the origin, fixed at (0,0).
//   - The SECOND point is the baseline: it sits on the +x axis (y = 0), its x
//     given by the measured origin→baseline distance.
//   - Every later point needs distances to ≥2 placed points. Two distances give
//     two mirror candidates — the point stays unplaced until a side is chosen
//     (side = sign of the cross product against its first two anchors) or a
//     third distance auto-resolves it.
//   - LOCKED points keep their stored coordinates; the adjustment moves the
//     others around them.
//   - After placement, a damped Gauss-Newton adjustment refines all free
//     coordinates against every distance and constraint. Constraints are
//     ASSUMPTIONS, so they enter at lower weight than tape measurements —
//     the solver will never bend real numbers far to satisfy one; the
//     constraint's own residual grows instead (concept §2).
// ============================================================================

export interface SolvePoint {
  id: string;
  locked: boolean;
  /** Mirror choice: sign of cross(anchorB−anchorA, P−anchorA); null = not chosen. */
  side: -1 | 1 | null;
  /** Stored coordinates — only trusted when `locked`. */
  x: number | null;
  y: number | null;
}

export interface SolveMeasurement {
  id: string;
  a: string;
  b: string;
  /** meters */
  d: number;
}

export type SolveConstraint =
  | { id: string; kind: 'right-angle'; points: [string, string, string] } // [at, from, to]
  | { id: string; kind: 'parallel'; points: [string, string, string, string] } // seg a1→a2 ∥ b1→b2
  | { id: string; kind: 'equal-length'; points: [string, string, string, string] }
  | { id: string; kind: 'colinear'; points: string[] }; // ≥3 points on one line

export interface XY {
  x: number;
  y: number;
}

export interface MirrorChoice {
  id: string;
  anchors: [string, string];
  candidates: [XY, XY];
}

export interface SolveResult {
  coords: Map<string, XY>;
  placed: string[];
  /** Points the solver could not place, with how many usable distances they have. */
  unplaced: { id: string; distances: number }[];
  /** Points blocked on a mirror choice (exactly two distances, no side chosen). */
  needsSide: MirrorChoice[];
  /** Per measurement: |computed − taped| in meters (only when both ends placed). */
  measurementResiduals: Map<string, number>;
  /** Per constraint: displacement-equivalent residual in meters (only when all points placed). */
  constraintResiduals: Map<string, number>;
  /** Root-mean-square of all measurement residuals, meters. */
  rms: number;
}

const EPS = 1e-9;

/** Constraints are assumptions, not measurements — they pull with half the weight. */
const CONSTRAINT_WEIGHT = 0.5;

function dist(p: XY, q: XY): number {
  return Math.hypot(p.x - q.x, p.y - q.y);
}

/**
 * Intersect circles (centerA, rA) and (centerB, rB). Returns the two solutions
 * (identical when tangent). When the circles do not meet — the tape numbers are
 * inconsistent — returns the nearest-approach point on the center line for
 * both, so the point still lands somewhere sensible and the residual reports
 * the disagreement instead of the point silently vanishing.
 */
export function circleIntersection(a: XY, ra: number, b: XY, rb: number): [XY, XY] {
  const d = dist(a, b);
  if (d < EPS) {
    // Coincident centers: no geometry to work with; drop the point on top.
    return [
      { x: a.x + ra, y: a.y },
      { x: a.x - ra, y: a.y },
    ];
  }
  const ux = (b.x - a.x) / d;
  const uy = (b.y - a.y) / d;
  // Along-axis coordinate of the crossing.
  const along = (ra * ra - rb * rb + d * d) / (2 * d);
  const h2 = ra * ra - along * along;
  if (h2 <= 0) {
    // No intersection (too far apart or one inside the other): nearest approach.
    const p = { x: a.x + ux * along, y: a.y + uy * along };
    return [p, { ...p }];
  }
  const h = Math.sqrt(h2);
  return [
    { x: a.x + ux * along - uy * h, y: a.y + uy * along + ux * h },
    { x: a.x + ux * along + uy * h, y: a.y + uy * along - ux * h },
  ];
}

function cross(o: XY, a: XY, b: XY): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

/** The side (−1 | 1) point p lies on relative to the directed line a→b. */
export function sideOf(a: XY, b: XY, p: XY): -1 | 1 {
  return cross(a, b, p) >= 0 ? 1 : -1;
}

interface DistanceTo {
  anchor: string;
  d: number;
}

/**
 * Solve the whole garden. `points` MUST be in creation order — the first two
 * define the coordinate frame (concept §2).
 */
export function solveGarden(
  points: SolvePoint[],
  measurements: SolveMeasurement[],
  constraints: SolveConstraint[],
): SolveResult {
  const byId = new Map(points.map((p) => [p.id, p]));

  // Average duplicate tape pulls over the same pair (a re-measure refines, not stacks).
  const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const pairDist = new Map<string, number[]>();
  for (const m of measurements) {
    if (!byId.has(m.a) || !byId.has(m.b) || m.a === m.b || !(m.d > 0)) continue;
    const key = pairKey(m.a, m.b);
    (pairDist.get(key) ?? pairDist.set(key, []).get(key)!).push(m.d);
  }
  const distOf = (a: string, b: string): number | null => {
    const ds = pairDist.get(pairKey(a, b));
    return ds ? ds.reduce((s, v) => s + v, 0) / ds.length : null;
  };
  const neighboursOf = (id: string): DistanceTo[] => {
    const seen = new Set<string>();
    const out: DistanceTo[] = [];
    for (const m of measurements) {
      const other = m.a === id ? m.b : m.b === id ? m.a : null;
      if (!other || !byId.has(other) || seen.has(other)) continue;
      seen.add(other);
      const d = distOf(id, other);
      if (d !== null) out.push({ anchor: other, d });
    }
    return out;
  };

  const coords = new Map<string, XY>();
  const needsSide: MirrorChoice[] = [];
  const order = new Map(points.map((p, i) => [p.id, i]));

  // Locked points are placed first, at their stored coordinates, and never move.
  for (const p of points) {
    if (p.locked && p.x !== null && p.y !== null) coords.set(p.id, { x: p.x, y: p.y });
  }

  // The frame: origin at (0,0); baseline on the +x axis at the taped distance.
  const origin = points[0];
  const baseline = points[1];
  if (origin && !coords.has(origin.id)) coords.set(origin.id, { x: 0, y: 0 });
  if (origin && baseline && !coords.has(baseline.id)) {
    const d = distOf(origin.id, baseline.id);
    if (d !== null) coords.set(baseline.id, { x: d, y: 0 });
  }

  // Incremental trilateration until nothing more places.
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const p of points) {
      if (coords.has(p.id)) continue;
      const placedNs = neighboursOf(p.id)
        .filter((n) => coords.has(n.anchor))
        .sort((m, n) => order.get(m.anchor)! - order.get(n.anchor)!);
      if (placedNs.length < 2) continue;

      const [nA, nB] = [placedNs[0]!, placedNs[1]!];
      const A = coords.get(nA.anchor)!;
      const B = coords.get(nB.anchor)!;
      const [c1, c2] = circleIntersection(A, nA.d, B, nB.d);
      const ambiguous = dist(c1, c2) > 0.01; // > 1 cm apart

      let chosen: XY | null = null;
      if (placedNs.length >= 3 && ambiguous) {
        // A third distance settles the mirror on its own.
        const fit = (c: XY) =>
          placedNs.slice(2).reduce((s, n) => s + Math.abs(dist(c, coords.get(n.anchor)!) - n.d), 0);
        chosen = fit(c1) <= fit(c2) ? c1 : c2;
      } else if (!ambiguous) {
        chosen = c1;
      } else if (p.side !== null) {
        chosen = sideOf(A, B, c1) === p.side ? c1 : c2;
      } else {
        needsSide.push({ id: p.id, anchors: [nA.anchor, nB.anchor], candidates: [c1, c2] });
        continue;
      }
      coords.set(p.id, chosen);
      progressed = true;
    }
  }

  // ── Least-squares adjustment ──────────────────────────────────────────────
  // Free variables: every placed point's coordinates, except the origin (fully
  // fixed), the baseline's y (fixed — it defines the axis), and locked points.
  const vars: { id: string; axis: 'x' | 'y' }[] = [];
  for (const p of points) {
    if (!coords.has(p.id) || p.locked) continue;
    if (origin && p.id === origin.id) continue;
    vars.push({ id: p.id, axis: 'x' });
    if (!(baseline && p.id === baseline.id)) vars.push({ id: p.id, axis: 'y' });
  }

  type ResidualFn = () => number;
  const residualFns: { fn: ResidualFn; weight: number }[] = [];
  const measResidual = new Map<string, ResidualFn>();
  const consResidual = new Map<string, ResidualFn>();

  for (const [key, ds] of pairDist) {
    const [a, b] = key.split('|') as [string, string];
    if (!coords.has(a) || !coords.has(b)) continue;
    const d = ds.reduce((s, v) => s + v, 0) / ds.length;
    residualFns.push({ fn: () => dist(coords.get(a)!, coords.get(b)!) - d, weight: 1 });
    // The FIT uses the pair average, but each tape pull REPORTS against its own
    // number — two disagreeing pulls of the same pair must both show it.
    for (const m of measurements) {
      if (pairKey(m.a, m.b) === key) {
        measResidual.set(m.id, () => dist(coords.get(a)!, coords.get(b)!) - m.d);
      }
    }
  }

  const seg = (a: string, b: string): XY => {
    const pa = coords.get(a)!;
    const pb = coords.get(b)!;
    return { x: pb.x - pa.x, y: pb.y - pa.y };
  };
  const len = (v: XY) => Math.hypot(v.x, v.y);

  for (const c of constraints) {
    if (c.points.some((id) => !coords.has(id))) continue;
    const fns: ResidualFn[] = [];
    if (c.kind === 'right-angle') {
      const [at, from, to] = c.points;
      fns.push(() => {
        const u = seg(at, from);
        const v = seg(at, to);
        return (u.x * v.x + u.y * v.y) / Math.max(len(u), len(v), EPS);
      });
    } else if (c.kind === 'parallel') {
      const [a1, a2, b1, b2] = c.points;
      fns.push(() => {
        const u = seg(a1, a2);
        const v = seg(b1, b2);
        return ((u.x * v.y - u.y * v.x) / Math.max(len(u) * len(v), EPS)) * Math.min(len(u), len(v));
      });
    } else if (c.kind === 'equal-length') {
      const [a1, a2, b1, b2] = c.points;
      fns.push(() => len(seg(a1, a2)) - len(seg(b1, b2)));
    } else {
      // colinear: each middle point's perpendicular distance from the end line.
      const ends = [c.points[0]!, c.points[c.points.length - 1]!] as const;
      for (const mid of c.points.slice(1, -1)) {
        fns.push(() => {
          const u = seg(ends[0], ends[1]);
          const w = seg(ends[0], mid);
          return (u.x * w.y - u.y * w.x) / Math.max(len(u), EPS);
        });
      }
    }
    for (const fn of fns) residualFns.push({ fn, weight: CONSTRAINT_WEIGHT });
    const all = fns;
    consResidual.set(c.id, () => Math.max(...all.map((f) => Math.abs(f())), 0));
  }

  if (vars.length > 0 && residualFns.length > 0) gaussNewton(vars, coords, residualFns);

  // ── Report ────────────────────────────────────────────────────────────────
  const measurementResiduals = new Map<string, number>();
  for (const [id, fn] of measResidual) measurementResiduals.set(id, Math.abs(fn()));
  const constraintResiduals = new Map<string, number>();
  for (const [id, fn] of consResidual) constraintResiduals.set(id, fn());

  const placed = points.filter((p) => coords.has(p.id)).map((p) => p.id);
  const pendingSide = new Set(needsSide.map((n) => n.id));
  const unplaced = points
    .filter((p) => !coords.has(p.id) && !pendingSide.has(p.id))
    .map((p) => ({ id: p.id, distances: neighboursOf(p.id).length }));

  const resids = [...measurementResiduals.values()];
  const rms = resids.length ? Math.sqrt(resids.reduce((s, r) => s + r * r, 0) / resids.length) : 0;

  return { coords, placed, unplaced, needsSide, measurementResiduals, constraintResiduals, rms };
}

/**
 * Damped Gauss-Newton over the free coordinates, numeric Jacobian. The system
 * is tiny (a garden survey is tens of points), so a dense normal-equation
 * solve is plenty.
 */
function gaussNewton(
  vars: { id: string; axis: 'x' | 'y' }[],
  coords: Map<string, XY>,
  residualFns: { fn: () => number; weight: number }[],
): void {
  const n = vars.length;
  const get = (i: number) => coords.get(vars[i]!.id)![vars[i]!.axis];
  const set = (i: number, v: number) => {
    coords.get(vars[i]!.id)![vars[i]!.axis] = v;
  };
  const residuals = () => residualFns.map((r) => r.fn() * r.weight);

  let lambda = 1e-3;
  let cost = residuals().reduce((s, r) => s + r * r, 0);

  for (let iter = 0; iter < 30; iter++) {
    const r0 = residuals();
    const m = r0.length;
    // Numeric Jacobian.
    const J: number[][] = Array.from({ length: m }, () => new Array<number>(n).fill(0));
    const h = 1e-7;
    for (let j = 0; j < n; j++) {
      const v0 = get(j);
      set(j, v0 + h);
      const r1 = residuals();
      set(j, v0);
      for (let i = 0; i < m; i++) J[i]![j] = (r1[i]! - r0[i]!) / h;
    }
    // Normal equations with LM damping: (JᵀJ + λI) δ = −Jᵀr
    const A: number[][] = Array.from({ length: n }, () => new Array<number>(n + 1).fill(0));
    for (let a = 0; a < n; a++) {
      for (let b = 0; b < n; b++) {
        let s = 0;
        for (let i = 0; i < m; i++) s += J[i]![a]! * J[i]![b]!;
        A[a]![b] = s + (a === b ? lambda : 0);
      }
      let s = 0;
      for (let i = 0; i < m; i++) s += J[i]![a]! * r0[i]!;
      A[a]![n] = -s;
    }
    const delta = solveLinear(A, n);
    if (!delta) break;

    const before = vars.map((_, i) => get(i));
    for (let i = 0; i < n; i++) set(i, before[i]! + delta[i]!);
    const newCost = residuals().reduce((s, r) => s + r * r, 0);
    if (newCost < cost) {
      cost = newCost;
      lambda = Math.max(lambda / 3, 1e-9);
      const stepMax = Math.max(...delta.map(Math.abs));
      if (stepMax < 1e-10) break;
    } else {
      for (let i = 0; i < n; i++) set(i, before[i]!);
      lambda *= 10;
      if (lambda > 1e6) break;
    }
  }
}

/** Gaussian elimination with partial pivoting on an augmented [A|b] matrix. */
function solveLinear(A: number[][], n: number): number[] | null {
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(A[row]![col]!) > Math.abs(A[pivot]![col]!)) pivot = row;
    }
    if (Math.abs(A[pivot]![col]!) < EPS) return null;
    [A[col], A[pivot]] = [A[pivot]!, A[col]!];
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const f = A[row]![col]! / A[col]![col]!;
      for (let k = col; k <= n; k++) A[row]![k]! -= f * A[col]![k]!;
    }
  }
  return A.map((row, i) => row[n]! / row[i]!);
}
