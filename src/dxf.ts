// ============================================================================
// A minimal ASCII DXF (R12) writer — PURE, no kernel imports, no I/O. R12 with
// POLYLINE/VERTEX, CIRCLE, POINT and TEXT is the most widely importable flavor
// there is (AutoCAD, LibreCAD, QCAD, SketchUp Pro, Fusion all read it).
//
// Layers (DESIGN.md §7): POINTS, POINT-LABELS, PLANTS, PLANT-LABELS, and one
// FEATURE-<TYPE> per feature type. Point Z carries the elevation, so a
// 3D-capable tool sees the heights. Curved segments arrive here already
// sampled into dense polylines — every CAD tool imports those.
// ============================================================================

export interface DxfPoint {
  name: string;
  x: number;
  y: number;
  /** meters above the datum; 0 when unknown. */
  z: number;
}

export interface DxfPolyline {
  layer: string;
  closed: boolean;
  vertices: { x: number; y: number; z: number }[];
}

export interface DxfPlant {
  label: string;
  x: number;
  y: number;
  z: number;
  /** mature canopy radius in meters — drawn as a circle so spacing mistakes show in CAD. */
  canopyRadius: number;
}

const NUM = (v: number) => (Object.is(v, -0) ? '0' : String(Number(v.toFixed(4))));

function pair(code: number, value: string | number): string {
  return `${code}\n${typeof value === 'number' ? NUM(value) : value}`;
}

export function buildDxf(input: {
  points: DxfPoint[];
  polylines: DxfPolyline[];
  plants: DxfPlant[];
}): string {
  const layers = new Set<string>(['POINTS', 'POINT-LABELS', 'PLANTS', 'PLANT-LABELS']);
  for (const p of input.polylines) layers.add(p.layer);

  const chunks: string[] = [];

  // ── HEADER ────────────────────────────────────────────────────────────────
  chunks.push(pair(0, 'SECTION'), pair(2, 'HEADER'), pair(9, '$ACADVER'), pair(1, 'AC1009'), pair(0, 'ENDSEC'));

  // ── TABLES: the layer table ───────────────────────────────────────────────
  chunks.push(pair(0, 'SECTION'), pair(2, 'TABLES'), pair(0, 'TABLE'), pair(2, 'LAYER'), pair(70, layers.size));
  let color = 1;
  for (const layer of [...layers].sort()) {
    chunks.push(
      pair(0, 'LAYER'),
      pair(2, layer),
      pair(70, 0),
      pair(62, color),
      pair(6, 'CONTINUOUS'),
    );
    color = (color % 7) + 1;
  }
  chunks.push(pair(0, 'ENDTAB'), pair(0, 'ENDSEC'));

  // ── ENTITIES ──────────────────────────────────────────────────────────────
  chunks.push(pair(0, 'SECTION'), pair(2, 'ENTITIES'));

  for (const p of input.points) {
    chunks.push(pair(0, 'POINT'), pair(8, 'POINTS'), pair(10, p.x), pair(20, p.y), pair(30, p.z));
    chunks.push(
      pair(0, 'TEXT'),
      pair(8, 'POINT-LABELS'),
      pair(10, p.x + 0.15),
      pair(20, p.y + 0.15),
      pair(30, p.z),
      pair(40, 0.25), // text height, meters
      pair(1, `${p.name} (${p.z >= 0 ? '+' : ''}${NUM(p.z)})`),
    );
  }

  for (const pl of input.polylines) {
    if (pl.vertices.length < 2) continue;
    chunks.push(
      pair(0, 'POLYLINE'),
      pair(8, pl.layer),
      pair(66, 1),
      pair(70, (pl.closed ? 1 : 0) | 8), // 8 = 3D polyline
    );
    for (const v of pl.vertices) {
      chunks.push(
        pair(0, 'VERTEX'),
        pair(8, pl.layer),
        pair(10, v.x),
        pair(20, v.y),
        pair(30, v.z),
        pair(70, 32), // 3D polyline vertex
      );
    }
    chunks.push(pair(0, 'SEQEND'));
  }

  for (const plant of input.plants) {
    chunks.push(
      pair(0, 'CIRCLE'),
      pair(8, 'PLANTS'),
      pair(10, plant.x),
      pair(20, plant.y),
      pair(30, plant.z),
      pair(40, Math.max(plant.canopyRadius, 0.1)),
    );
    chunks.push(
      pair(0, 'TEXT'),
      pair(8, 'PLANT-LABELS'),
      pair(10, plant.x + 0.15),
      pair(20, plant.y - 0.35),
      pair(30, plant.z),
      pair(40, 0.25),
      pair(1, plant.label),
    );
  }

  chunks.push(pair(0, 'ENDSEC'), pair(0, 'EOF'));
  return chunks.join('\n') + '\n';
}

/**
 * Sample a run of points into a dense polyline, honoring per-segment
 * straight/curved flags. Curved segments follow a Catmull-Rom spline through
 * the surrounding points — smooth through every surveyed point, no free
 * control handles to manage in the field (DESIGN.md §2).
 */
export function sampleRun(
  vertices: { x: number; y: number; z: number; curvedToNext: boolean }[],
  closed: boolean,
  subdivisions = 12,
): { x: number; y: number; z: number }[] {
  const n = vertices.length;
  if (n < 2) return vertices.map(({ x, y, z }) => ({ x, y, z }));
  const at = (i: number) => vertices[((i % n) + n) % n]!;
  const out: { x: number; y: number; z: number }[] = [];
  const segments = closed ? n : n - 1;

  for (let i = 0; i < segments; i++) {
    const p1 = at(i);
    const p2 = at(i + 1);
    out.push({ x: p1.x, y: p1.y, z: p1.z });
    if (!p1.curvedToNext) continue;
    // Catmull-Rom needs the neighbours; clamp at open ends.
    const p0 = closed ? at(i - 1) : at(Math.max(i - 1, 0));
    const p3 = closed ? at(i + 2) : at(Math.min(i + 2, n - 1));
    for (let s = 1; s < subdivisions; s++) {
      const t = s / subdivisions;
      const t2 = t * t;
      const t3 = t2 * t;
      const cm = (a: number, b: number, c: number, d: number) =>
        0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (3 * b - a - 3 * c + d) * t3);
      out.push({
        x: cm(p0.x, p1.x, p2.x, p3.x),
        y: cm(p0.y, p1.y, p2.y, p3.y),
        z: p1.z + (p2.z - p1.z) * t,
      });
    }
  }
  if (!closed) {
    const last = at(n - 1);
    out.push({ x: last.x, y: last.y, z: last.z });
  }
  return out;
}
