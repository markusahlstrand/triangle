// ============================================================================
// Survey analysis — PURE, over the solver. What the assistant's tools run, so an
// answer about "which pull is wrong" is computed, not guessed:
//
//   - impossible pulls (the triangle inequality over every fully taped triangle);
//   - the range a pull can take, given the pulls around it;
//   - what-if: drop pulls, change a value, force a point onto its mirror side;
//   - typo search: a missing or extra zero, two digits swapped — re-solved one at a time.
//
// Names, not ids, in and out: the person and the model talk about "Pool NW corner".
// No kernel imports, no I/O — the harness hands it a `get-site` payload.
// ============================================================================

import { solveGarden, type SolveConstraint, type SolveMeasurement, type SolvePoint, type SolveResult, type XY } from './geometry.js';
import type { SitePayload } from './module.js';

export interface Survey {
  points: SolvePoint[];
  measurements: SolveMeasurement[];
  constraints: SolveConstraint[];
  name: (pointId: string) => string;
}

export function surveyOf(site: SitePayload): Survey {
  const names = new Map(site.points.map((p) => [p.id, p.name]));
  return {
    points: site.points.map((p) => ({
      id: p.id,
      locked: p.locked === 1,
      side: p.side === 1 ? 1 : p.side === -1 ? -1 : null,
      x: p.x,
      y: p.y,
    })),
    measurements: site.measurements.map((m) => ({
      id: m.id,
      a: m.point_a,
      b: m.point_b,
      d: m.distance_m,
      verified: m.verified_at !== null,
    })),
    constraints: site.constraints.map((c) => ({ id: c.id, kind: c.kind, points: c.points }) as SolveConstraint),
    name: (id) => names.get(id) ?? id,
  };
}

const cm = (m: number) => Math.round(m * 1000) / 10;
const dist = (p: XY, q: XY) => Math.hypot(p.x - q.x, p.y - q.y);

/** A point named by a person or a model: exact, then case-insensitive, then a unique prefix. */
export function pointByName(s: Survey, name: string): string {
  const all = s.points.map((p) => p.id);
  const exact = all.find((id) => s.name(id) === name);
  if (exact) return exact;
  const lower = name.trim().toLowerCase();
  const ci = all.filter((id) => s.name(id).toLowerCase() === lower);
  if (ci.length === 1) return ci[0]!;
  const prefix = all.filter((id) => s.name(id).toLowerCase().startsWith(lower));
  if (prefix.length === 1) return prefix[0]!;
  throw new Error(
    prefix.length > 1
      ? `"${name}" matches several points: ${prefix.map(s.name).join(', ')}`
      : `no point named "${name}"`,
  );
}

/** A pull named by its id, or by its two ends (either order). */
export function measurementByRef(s: Survey, ref: { id?: string; from?: string; to?: string }): SolveMeasurement {
  if (ref.id) {
    const m = s.measurements.find((x) => x.id === ref.id);
    if (!m) throw new Error(`no measurement ${ref.id}`);
    return m;
  }
  if (!ref.from || !ref.to) throw new Error('name a measurement by id, or by from and to');
  const a = pointByName(s, ref.from);
  const b = pointByName(s, ref.to);
  const hits = s.measurements.filter((m) => (m.a === a && m.b === b) || (m.a === b && m.b === a));
  if (hits.length === 0) throw new Error(`no measurement between ${s.name(a)} and ${s.name(b)}`);
  if (hits.length > 1) throw new Error(`${hits.length} measurements between ${s.name(a)} and ${s.name(b)} — name one by id: ${hits.map((h) => h.id).join(', ')}`);
  return hits[0]!;
}

const label = (s: Survey, m: SolveMeasurement) => `${s.name(m.a)} ↔ ${s.name(m.b)}`;

/** What a solve says, as a person reads it. */
export function solveSummary(s: Survey, r: SolveResult, worst = 6) {
  const res = [...r.measurementResiduals.values()];
  const rms = res.length ? Math.sqrt(res.reduce((t, v) => t + v * v, 0) / res.length) : 0;
  return {
    rmsCm: cm(rms),
    placed: r.placed.length,
    of: s.points.length,
    unplaced: s.points.filter((p) => !r.coords.has(p.id)).map((p) => s.name(p.id)),
    worst: [...r.measurementResiduals]
      .sort((a, b) => b[1] - a[1])
      .slice(0, worst)
      .map(([id, v]) => {
        const m = s.measurements.find((x) => x.id === id)!;
        return { measurement: label(s, m), id, tapedCm: cm(m.d), offCm: cm(v), verified: !!m.verified };
      }),
    constraints: [...r.constraintResiduals].map(([id, v]) => ({ id, offCm: cm(v) })),
  };
}

export function solve(s: Survey, over?: Partial<Pick<Survey, 'points' | 'measurements'>>) {
  return solveGarden(over?.points ?? s.points, over?.measurements ?? s.measurements, s.constraints);
}

// ── Impossible pulls ─────────────────────────────────────────────────────────

/**
 * Every fully taped triangle whose sides cannot close: one side longer than the other two
 * together (beyond `toleranceCm` of tape slack). These need no solver and no redundancy — a
 * triangle that cannot exist is wrong whatever else is true. The side that breaks it is named,
 * with the range the other two allow, and whether those two are verified.
 */
export function impossiblePulls(s: Survey, toleranceCm = 2) {
  const byPair = new Map<string, SolveMeasurement[]>();
  const key = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  for (const m of s.measurements) (byPair.get(key(m.a, m.b)) ?? byPair.set(key(m.a, m.b), []).get(key(m.a, m.b))!).push(m);
  const ids = s.points.map((p) => p.id);
  const out: {
    measurement: string;
    id: string;
    tapedCm: number;
    mustBeBetweenCm: [number, number];
    because: string;
    excessCm: number;
  }[] = [];
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++)
      for (let k = j + 1; k < ids.length; k++) {
        const [a, b, c] = [ids[i]!, ids[j]!, ids[k]!];
        const sides = [
          [a, b, c],
          [a, c, b],
          [b, c, a],
        ] as const;
        for (const [p, q, r] of sides) {
          // The side p–q, against the two through r.
          for (const pq of byPair.get(key(p, q)) ?? [])
            for (const pr of byPair.get(key(p, r)) ?? [])
              for (const qr of byPair.get(key(q, r)) ?? []) {
                const lo = Math.abs(pr.d - qr.d);
                const hi = pr.d + qr.d;
                const excess = Math.max(pq.d - hi, lo - pq.d);
                if (excess * 100 <= toleranceCm) continue;
                // A verified pull is never the accused: the triangle's fault is one of its other sides.
                if (pq.verified) continue;
                out.push({
                  measurement: label(s, pq),
                  id: pq.id,
                  tapedCm: cm(pq.d),
                  mustBeBetweenCm: [cm(lo), cm(hi)],
                  because: `${s.name(r)} is ${cm(pr.d)} cm from ${s.name(p)}${pr.verified ? ' (verified)' : ''} and ${cm(qr.d)} cm from ${s.name(q)}${qr.verified ? ' (verified)' : ''}`,
                  excessCm: cm(excess),
                });
              }
        }
      }
  // One impossible triangle cannot say which of its sides is wrong: "too long" here is "too short"
  // there, by the same amount. A wrong pull, though, breaks EVERY taped triangle it is in, so rank
  // by how many triangles a pull breaks, then by how badly. Keep each pull's strongest case.
  const best = new Map<string, (typeof out)[number] & { triangles: number }>();
  for (const o of out) {
    const had = best.get(o.id);
    const triangles = (had?.triangles ?? 0) + 1;
    best.set(o.id, !had || had.excessCm < o.excessCm ? { ...o, triangles } : { ...had, triangles });
  }
  return [...best.values()].sort((x, y) => y.triangles - x.triangles || y.excessCm - x.excessCm);
}

/**
 * The range a distance between two points can take, from every third point taped to both
 * (the triangle inequality), beside what the solved map says and what was taped, if anything.
 */
export function distanceRange(s: Survey, from: string, to: string) {
  const a = pointByName(s, from);
  const b = pointByName(s, to);
  let lo = 0;
  let hi = Infinity;
  const via: string[] = [];
  for (const p of s.points) {
    if (p.id === a || p.id === b) continue;
    const pa = s.measurements.find((m) => (m.a === a && m.b === p.id) || (m.b === a && m.a === p.id));
    const pb = s.measurements.find((m) => (m.a === b && m.b === p.id) || (m.b === b && m.a === p.id));
    if (!pa || !pb) continue;
    lo = Math.max(lo, Math.abs(pa.d - pb.d));
    hi = Math.min(hi, pa.d + pb.d);
    via.push(`${s.name(p.id)} (${cm(pa.d)} / ${cm(pb.d)} cm)`);
  }
  const r = solve(s);
  const ca = r.coords.get(a);
  const cb = r.coords.get(b);
  const taped = s.measurements.filter((m) => (m.a === a && m.b === b) || (m.a === b && m.b === a)).map((m) => cm(m.d));
  return {
    from: s.name(a),
    to: s.name(b),
    tapedCm: taped,
    possibleCm: via.length ? [cm(lo), hi === Infinity ? null : cm(hi)] : null,
    consistent: via.length ? lo <= hi : null,
    via,
    onTheMapCm: ca && cb ? cm(dist(ca, cb)) : null,
  };
}

// ── What if ──────────────────────────────────────────────────────────────────

export interface WhatIf {
  /** Pulls to leave out. */
  drop?: { id?: string; from?: string; to?: string }[];
  /** Pulls to read differently. */
  change?: { id?: string; from?: string; to?: string; cm: number }[];
  /** Points to put on their other mirror side, across the line through their first two anchors. */
  flip?: string[];
}

/**
 * Re-solve with the survey changed as stated, and say what that does: the misfit before and
 * after, what is placed, and the worst pulls either way. Nothing is saved.
 */
export function whatIf(s: Survey, change: WhatIf) {
  const before = solve(s);
  const dropped = new Set((change.drop ?? []).map((ref) => measurementByRef(s, ref).id));
  const newValue = new Map((change.change ?? []).map((c) => [measurementByRef(s, c).id, c.cm / 100]));
  const measurements = s.measurements
    .filter((m) => !dropped.has(m.id))
    .map((m) => (newValue.has(m.id) ? { ...m, d: newValue.get(m.id)! } : m));

  // A flip: mirror the point's solved position across the line through its first two placed
  // anchors and hold it there — a third distance would otherwise just put it back.
  let points = s.points;
  const flipped: string[] = [];
  for (const nm of change.flip ?? []) {
    const id = pointByName(s, nm);
    const here = before.coords.get(id);
    if (!here) throw new Error(`${s.name(id)} is not placed, so it has no side to flip`);
    const order = new Map(s.points.map((p, i) => [p.id, i]));
    const anchors = s.measurements
      .filter((m) => m.a === id || m.b === id)
      .map((m) => (m.a === id ? m.b : m.a))
      .filter((o) => before.coords.has(o))
      .sort((x, y) => order.get(x)! - order.get(y)!);
    const [p, q] = [...new Set(anchors)];
    if (!p || !q) throw new Error(`${s.name(id)} has fewer than two placed neighbours to mirror across`);
    const A = before.coords.get(p)!;
    const B = before.coords.get(q)!;
    const ux = B.x - A.x;
    const uy = B.y - A.y;
    const t = ((here.x - A.x) * ux + (here.y - A.y) * uy) / (ux * ux + uy * uy);
    const foot = { x: A.x + t * ux, y: A.y + t * uy };
    const mirror = { x: 2 * foot.x - here.x, y: 2 * foot.y - here.y };
    points = points.map((pt) => (pt.id === id ? { ...pt, locked: true, x: mirror.x, y: mirror.y } : pt));
    flipped.push(`${s.name(id)} mirrored across ${s.name(p)}–${s.name(q)}`);
  }
  const after = solveGarden(points, measurements, s.constraints);
  return {
    before: solveSummary(s, before),
    after: solveSummary({ ...s, measurements }, after),
    dropped: [...dropped].map((id) => label(s, s.measurements.find((m) => m.id === id)!)),
    changed: [...newValue].map(([id, d]) => {
      const m = s.measurements.find((x) => x.id === id)!;
      return `${label(s, m)}: ${cm(m.d)} → ${cm(d)} cm`;
    }),
    flipped,
  };
}

// ── Typos ────────────────────────────────────────────────────────────────────

/** The numbers one slip of the keypad away: a zero too many or too few, two digits swapped. */
export function slipsOf(valueCm: number): number[] {
  const t = String(Math.round(valueCm));
  const out = new Set<number>();
  for (let i = 0; i < t.length; i++) if (t[i] === '0') out.add(Number(t.slice(0, i) + t.slice(i + 1)));
  for (let i = 1; i <= t.length; i++) out.add(Number(t.slice(0, i) + '0' + t.slice(i)));
  for (let i = 0; i + 1 < t.length; i++) if (t[i] !== t[i + 1]) out.add(Number(t.slice(0, i) + t[i + 1] + t[i] + t.slice(i + 2)));
  return [...out].filter((v) => v > 0 && v !== Math.round(valueCm));
}

/**
 * Re-solve with each unverified pull read as each of its one-slip neighbours, and rank the
 * readings that make the survey agree best. A real typo shows as one reading far ahead of
 * the rest; nothing ahead means it is not a typo.
 */
export function typoSearch(s: Survey, limit = 5) {
  const base = solveSummary(s, solve(s));
  const tried: { reading: string; id: string; rmsCm: number }[] = [];
  for (const m of s.measurements) {
    if (m.verified) continue;
    for (const v of slipsOf(m.d * 100)) {
      const r = solve(s, { measurements: s.measurements.map((x) => (x.id === m.id ? { ...x, d: v / 100 } : x)) });
      if (r.placed.length < base.placed) continue;
      tried.push({ reading: `${label(s, m)}: ${cm(m.d)} → ${v} cm`, id: m.id, rmsCm: solveSummary(s, r).rmsCm });
    }
  }
  tried.sort((a, b) => a.rmsCm - b.rmsCm);
  return { asTypedRmsCm: base.rmsCm, best: tried.slice(0, limit) };
}
