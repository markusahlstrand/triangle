import { useMemo, useRef, useState } from 'react';
import type { MirrorChoice, Point, SitePayload } from './api';

// ============================================================================
// The map — the identity of the app. An SVG canvas in garden meters (y up),
// pan/zoom with pointer + wheel/pinch. Built fabric draws in ink by type;
// tape lines and constraint marks draw thin and violet — scaffolding, never
// built features (design 06/22). Unplaced points live in a tray, mirror
// candidates draw as solid/dashed markers to tap (design 05/07).
// ============================================================================

export interface Overlays {
  tape: boolean;
  elevations: boolean;
  canopies: boolean;
}

const FEATURE_STYLE: Record<string, { stroke: string; width: number; dash?: string; fill?: string }> = {
  house: { stroke: '#17161a', width: 0.12, fill: 'rgb(23 22 26 / 0.06)' },
  'retention-wall': { stroke: '#17161a', width: 0.16 },
  terrace: { stroke: '#8a8578', width: 0.06, fill: 'rgb(138 133 120 / 0.12)' },
  pool: { stroke: '#4a7fa5', width: 0.07, fill: 'rgb(74 127 165 / 0.15)' },
  stairs: { stroke: '#17161a', width: 0.06, dash: '0.25 0.12' },
  fence: { stroke: '#5d5a63', width: 0.05, dash: '0.4 0.2' },
  bed: { stroke: '#6a8f5f', width: 0.05, fill: 'rgb(106 143 95 / 0.12)' },
  path: { stroke: '#a89f8d', width: 0.1, dash: '0.5 0.25' },
};

const VIOLET = 'oklch(0.55 0.14 295)';

/** Catmull-Rom sampling — same shape as the server's DXF sampler. */
function samplePath(
  pts: { x: number; y: number; curved: boolean }[],
  closed: boolean,
): string {
  const n = pts.length;
  if (n < 2) return '';
  const at = (i: number) => pts[((i % n) + n) % n]!;
  const parts: string[] = [`M ${at(0).x} ${-at(0).y}`];
  const segments = closed ? n : n - 1;
  for (let i = 0; i < segments; i++) {
    const p1 = at(i);
    const p2 = at(i + 1);
    if (!p1.curved) {
      parts.push(`L ${p2.x} ${-p2.y}`);
      continue;
    }
    const p0 = closed ? at(i - 1) : at(Math.max(i - 1, 0));
    const p3 = closed ? at(i + 2) : at(Math.min(i + 2, n - 1));
    for (let s = 1; s <= 12; s++) {
      const t = s / 12;
      const t2 = t * t;
      const t3 = t2 * t;
      const cm = (a: number, b: number, c: number, d: number) =>
        0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (3 * b - a - 3 * c + d) * t3);
      parts.push(`L ${cm(p0.x, p1.x, p2.x, p3.x)} ${-cm(p0.y, p1.y, p2.y, p3.y)}`);
    }
  }
  if (closed) parts.push('Z');
  return parts.join(' ');
}

function residualClass(cm: number | undefined): string {
  if (cm === undefined) return 'none';
  if (cm <= 2) return 'good';
  if (cm <= 5) return 'warn';
  return 'bad';
}

const RESIDUAL_COLOR: Record<string, string> = {
  good: 'oklch(0.62 0.14 150)',
  warn: 'oklch(0.75 0.15 75)',
  bad: 'oklch(0.58 0.19 25)',
  none: '#17161a',
};

export function pointResidualCm(site: SitePayload, pointId: string): number | undefined {
  const rs = site.measurements
    .filter((m) => m.point_a === pointId || m.point_b === pointId)
    .map((m) => site.solve.measurementResidualsCm[m.id])
    .filter((r): r is number => r !== undefined);
  return rs.length ? Math.max(...rs) : undefined;
}

export function GardenMap(props: {
  site: SitePayload;
  overlays: Overlays;
  selected: string | null;
  pendingMirror: MirrorChoice | null;
  onSelectPoint: (id: string) => void;
  onPickSide: (choice: MirrorChoice, side: 1 | -1) => void;
  onTrayPoint: (id: string) => void;
}) {
  const { site, overlays } = props;
  const svgRef = useRef<SVGSVGElement>(null);
  const placed = useMemo(() => site.points.filter((p) => p.x !== null && p.y !== null), [site]);
  const byId = useMemo(() => new Map(site.points.map((p) => [p.id, p])), [site]);

  // Fit-to-content once per site; then user pan/zoom (viewBox in meters, y flipped).
  const fit = useMemo(() => {
    const xs = placed.map((p) => p.x!);
    const ys = placed.map((p) => -p.y!);
    for (const c of props.pendingMirror?.candidates ?? []) {
      xs.push(c.x);
      ys.push(-c.y);
    }
    if (xs.length === 0) return { x: -10, y: -10, w: 20, h: 20 };
    const minX = Math.min(...xs) - 3;
    const maxX = Math.max(...xs) + 3;
    const minY = Math.min(...ys) - 3;
    const maxY = Math.max(...ys) + 3;
    return { x: minX, y: minY, w: Math.max(maxX - minX, 8), h: Math.max(maxY - minY, 8) };
  }, [placed, props.pendingMirror]);

  const [view, setView] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const vb = view ?? fit;
  const drag = useRef<{ px: number; py: number; vb: typeof vb } | null>(null);
  const pinch = useRef<Map<number, { x: number; y: number }>>(new Map());

  const clientToUser = (cx: number, cy: number) => {
    const rect = svgRef.current!.getBoundingClientRect();
    const scale = Math.max(vb.w / rect.width, vb.h / rect.height);
    const w = rect.width * scale;
    const h = rect.height * scale;
    const ox = vb.x - (w - vb.w) / 2;
    const oy = vb.y - (h - vb.h) / 2;
    return { x: ox + ((cx - rect.left) / rect.width) * w, y: oy + ((cy - rect.top) / rect.height) * h };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    pinch.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    drag.current = { px: e.clientX, py: e.clientY, vb };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!pinch.current.has(e.pointerId)) return;
    pinch.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch.current.size === 1 && drag.current) {
      const rect = svgRef.current!.getBoundingClientRect();
      const scale = Math.max(vb.w / rect.width, vb.h / rect.height);
      const dx = (e.clientX - drag.current.px) * scale;
      const dy = (e.clientY - drag.current.py) * scale;
      setView({ ...drag.current.vb, x: drag.current.vb.x - dx, y: drag.current.vb.y - dy });
    }
  };
  const onPointerUp = (e: React.PointerEvent) => {
    pinch.current.delete(e.pointerId);
    if (pinch.current.size === 0) drag.current = null;
  };
  const onWheel = (e: React.WheelEvent) => {
    const factor = e.deltaY > 0 ? 1.15 : 1 / 1.15;
    const at = clientToUser(e.clientX, e.clientY);
    setView({
      x: at.x - (at.x - vb.x) * factor,
      y: at.y - (at.y - vb.y) * factor,
      w: vb.w * factor,
      h: vb.h * factor,
    });
  };

  const fontSize = Math.max(vb.w, vb.h) / 42;
  const dot = fontSize * 0.38;
  const unplaced = site.points.filter((p) => p.x === null || p.y === null);

  return (
    <div className="map-wrap">
      <svg
        ref={svgRef}
        viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
      >
        {/* 1 m grid */}
        <Grid vb={vb} />

        {/* Built fabric */}
        {site.features.map((f) => {
          const pts = f.vertices
            .map((v) => byId.get(v.point_id))
            .map((p, i) =>
              p && p.x !== null && p.y !== null
                ? { x: p.x, y: p.y, curved: f.vertices[i]!.curved_to_next === 1 }
                : null,
            )
            .filter((p): p is NonNullable<typeof p> => p !== null);
          if (pts.length < 2) return null;
          const style = FEATURE_STYLE[f.type] ?? FEATURE_STYLE['fence']!;
          return (
            <path
              key={f.id}
              d={samplePath(pts, f.closed === 1)}
              fill={f.closed === 1 ? (style.fill ?? 'none') : 'none'}
              stroke={style.stroke}
              strokeWidth={style.width}
              strokeDasharray={style.dash}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          );
        })}

        {/* Plant canopies */}
        {overlays.canopies &&
          site.plants.map((pl) => {
            const p = byId.get(pl.point_id);
            if (!p || p.x === null || p.y === null) return null;
            const r = (pl.species.mature_canopy_m ?? 1) / 2;
            return (
              <g key={pl.id}>
                <circle
                  cx={p.x}
                  cy={-p.y}
                  r={r}
                  fill="rgb(106 143 95 / 0.15)"
                  stroke="#6a8f5f"
                  strokeWidth={0.04}
                  strokeDasharray="0.3 0.15"
                />
                <text x={p.x + 0.2} y={-p.y + r * 0.8} fontSize={fontSize * 0.8} fill="#6a8f5f" fontFamily="Public Sans">
                  {pl.label ?? pl.species.common_name}
                </text>
              </g>
            );
          })}

        {/* Tape overlay — scaffolding, violet, thin */}
        {overlays.tape &&
          site.measurements.map((m) => {
            const a = byId.get(m.point_a);
            const b = byId.get(m.point_b);
            if (!a || !b || a.x === null || b.x === null) return null;
            return (
              <g key={m.id}>
                <line
                  x1={a.x}
                  y1={-a.y!}
                  x2={b.x}
                  y2={-b.y!}
                  stroke={VIOLET}
                  strokeWidth={0.025}
                  opacity={0.7}
                />
                <text
                  x={(a.x + b.x) / 2}
                  y={-(a.y! + b.y!) / 2 - 0.1}
                  fontSize={fontSize * 0.65}
                  fill={VIOLET}
                  fontFamily="Roboto Mono"
                  textAnchor="middle"
                >
                  {Math.round(m.distance_m * 100)}
                </text>
              </g>
            );
          })}

        {/* Constraint marks — same violet as the tape (design 22) */}
        {site.constraints.map((c) => {
          if (c.kind !== 'right-angle') return null;
          const [at, from, to] = c.points.map((id) => byId.get(id));
          if (!at || !from || !to || at.x === null || from.x === null || to.x === null) return null;
          const s = 0.55;
          const u = norm(from.x! - at.x!, from.y! - at.y!);
          const v = norm(to.x! - at.x!, to.y! - at.y!);
          const p1 = { x: at.x! + u.x * s, y: at.y! + u.y * s };
          const p2 = { x: at.x! + (u.x + v.x) * s, y: at.y! + (u.y + v.y) * s };
          const p3 = { x: at.x! + v.x * s, y: at.y! + v.y * s };
          return (
            <path
              key={c.id}
              d={`M ${p1.x} ${-p1.y} L ${p2.x} ${-p2.y} L ${p3.x} ${-p3.y}`}
              fill="none"
              stroke={VIOLET}
              strokeWidth={0.035}
            />
          );
        })}

        {/* Points */}
        {placed.map((p) => (
          <g
            key={p.id}
            onClick={(e) => {
              e.stopPropagation();
              props.onSelectPoint(p.id);
            }}
            style={{ cursor: 'pointer' }}
          >
            <circle cx={p.x!} cy={-p.y!} r={dot * 2.6} fill="transparent" />
            <rect
              x={p.x! - dot}
              y={-p.y! - dot}
              width={dot * 2}
              height={dot * 2}
              fill={props.selected === p.id ? VIOLET : '#faf8f4'}
              stroke={RESIDUAL_COLOR[residualClass(pointResidualCm(site, p.id))]}
              strokeWidth={dot * 0.45}
              transform={`rotate(45 ${p.x!} ${-p.y!})`}
            />
            <text x={p.x! + dot * 1.8} y={-p.y! - dot * 1.4} fontSize={fontSize * 0.85} fill="#17161a" fontFamily="Public Sans" fontWeight={600}>
              {p.name}
            </text>
            {overlays.elevations && p.elevation_m !== null && (
              <text x={p.x! + dot * 1.8} y={-p.y! - dot * 1.4 + fontSize} fontSize={fontSize * 0.7} fill="#5d5a63" fontFamily="Roboto Mono">
                {p.elevation_m >= 0 ? '+' : ''}
                {p.elevation_m.toFixed(2)}
              </text>
            )}
          </g>
        ))}

        {/* Mirror candidates — solid vs dashed markers to tap (design 07) */}
        {props.pendingMirror &&
          props.pendingMirror.candidates.map((c, i) => {
            const anchors = props.pendingMirror!.anchors.map((id) => byId.get(id)!);
            const a = anchors[0]!;
            const b = anchors[1]!;
            const cr = (b.x! - a.x!) * (c.y - a.y!) - (b.y! - a.y!) * (c.x - a.x!);
            const side: 1 | -1 = cr >= 0 ? 1 : -1;
            return (
              <g
                key={i}
                onClick={(e) => {
                  e.stopPropagation();
                  props.onPickSide(props.pendingMirror!, side);
                }}
                style={{ cursor: 'pointer' }}
              >
                <circle
                  cx={c.x}
                  cy={-c.y}
                  r={dot * 2.4}
                  fill="rgb(255 255 255 / 0.8)"
                  stroke={VIOLET}
                  strokeWidth={dot * 0.5}
                  strokeDasharray={i === 1 ? `${dot} ${dot * 0.7}` : undefined}
                />
                <text x={c.x + dot * 3} y={-c.y + dot} fontSize={fontSize * 0.8} fill={VIOLET} fontFamily="Public Sans" fontWeight={600}>
                  here?
                </text>
              </g>
            );
          })}
      </svg>

      {unplaced.length > 0 && (
        <div className="tray">
          <div className="section-label">Unplaced · {unplaced.length}</div>
          {unplaced.map((p) => (
            <button key={p.id} className="meta" style={{ textAlign: 'left' }} onClick={() => props.onTrayPoint(p.id)}>
              {p.name} · {countDistances(site, p)} dist
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function countDistances(site: SitePayload, p: Point): number {
  return site.measurements.filter((m) => m.point_a === p.id || m.point_b === p.id).length;
}

function norm(x: number, y: number): { x: number; y: number } {
  const l = Math.hypot(x, y) || 1;
  return { x: x / l, y: y / l };
}

function Grid({ vb }: { vb: { x: number; y: number; w: number; h: number } }) {
  if (Math.max(vb.w, vb.h) > 80) return null;
  const lines: React.ReactElement[] = [];
  const x0 = Math.floor(vb.x);
  const y0 = Math.floor(vb.y);
  for (let x = x0; x <= vb.x + vb.w; x++) {
    lines.push(<line key={`v${x}`} x1={x} y1={vb.y} x2={x} y2={vb.y + vb.h} stroke="#e6e0d4" strokeWidth={x % 5 === 0 ? 0.02 : 0.008} />);
  }
  for (let y = y0; y <= vb.y + vb.h; y++) {
    lines.push(<line key={`h${y}`} x1={vb.x} y1={y} x2={vb.x + vb.w} y2={y} stroke="#e6e0d4" strokeWidth={y % 5 === 0 ? 0.02 : 0.008} />);
  }
  return <>{lines}</>;
}
