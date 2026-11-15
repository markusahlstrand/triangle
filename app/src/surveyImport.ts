import { api, type SitePayload } from './api';

// ============================================================================
// Editing the survey as JSON: the same shape `⇩ JSON` downloads, read back and turned into
// the operations it stands for — never written behind the model's back. Every change is one
// declared operation (create-point, update-point, add/delete-measurement, set-measurement-
// verified), so it is permission-checked, on the History, and re-solved like a tap would be.
//
// What it changes, keyed by `id` (a row without an id is new):
//   points        — new name → created; name or elevation changed → updated.
//                   A point missing from the file is KEPT (deleting points is the map's job).
//   measurements  — missing from the file → deleted; new → added (ends by id or by name);
//                   distanceCm or its ends changed → replaced (delete + add, verification kept);
//                   verifiedAt set or cleared → verified / unverified.
// Constraints, features, plants and the solver's output are read-only here.
// ============================================================================

interface FilePoint {
  id?: string;
  name?: string;
  elevation?: number | null;
}
interface FileMeasurement {
  id?: string;
  from?: string;
  to?: string;
  fromId?: string;
  toId?: string;
  distanceCm?: number;
  verifiedAt?: string | null;
  note?: string | null;
}

export interface ImportStep {
  /** What it does, in words — the preview line. */
  label: string;
  kind: 'add' | 'change' | 'delete' | 'verify';
  run: (ids: Map<string, string>) => Promise<void>;
}

export interface ImportPlan {
  steps: ImportStep[];
  /** What the file says that this import does not act on. */
  notes: string[];
}

const near = (a: number, b: number) => Math.abs(a - b) < 0.05;

/** Read a JSON text (the export's shape) against the garden as it stands, into the steps it means. */
export function planImport(site: SitePayload, text: string): ImportPlan {
  let file: { points?: FilePoint[]; measurements?: FileMeasurement[] };
  try {
    file = JSON.parse(text);
  } catch (e) {
    throw new Error(`Not valid JSON: ${(e as Error).message}`);
  }
  if (!file || typeof file !== 'object' || !Array.isArray(file.measurements) || !Array.isArray(file.points)) {
    throw new Error('Expected the survey export: an object with "points" and "measurements" arrays.');
  }

  const siteId = site.site.id;
  const steps: ImportStep[] = [];
  const notes: string[] = [];
  const pointById = new Map(site.points.map((p) => [p.id, p]));
  const nameOf = (id: string) => pointById.get(id)?.name ?? id;

  // ── Points ──
  // Names a new measurement may use: every existing point, then every point the file adds.
  const knownNames = new Map(site.points.map((p) => [p.name.toLowerCase(), p.id]));
  for (const fp of file.points) {
    const name = fp.name?.trim();
    const existing = fp.id ? pointById.get(fp.id) : undefined;
    if (existing) {
      const patch: { name?: string; elevationM?: number | null } = {};
      if (name && name !== existing.name) patch.name = name;
      if (fp.elevation !== undefined && (fp.elevation ?? null) !== existing.elevation_m) patch.elevationM = fp.elevation ?? null;
      if (Object.keys(patch).length === 0) continue;
      const what = [
        patch.name ? `rename “${existing.name}” → “${patch.name}”` : null,
        patch.elevationM !== undefined ? `elevation ${existing.elevation_m ?? '—'} → ${patch.elevationM ?? '—'} m` : null,
      ]
        .filter(Boolean)
        .join(', ');
      steps.push({
        kind: 'change',
        label: `Point ${existing.name}: ${what}`,
        run: async () => void (await api.updatePoint({ pointId: existing.id, ...patch })),
      });
      if (patch.name) knownNames.set(patch.name.toLowerCase(), existing.id);
    } else {
      if (fp.id) notes.push(`Point id ${fp.id} is not in this garden — treated as a new point.`);
      if (!name) {
        notes.push('A point without a name was skipped.');
        continue;
      }
      if (knownNames.has(name.toLowerCase())) {
        notes.push(`A point named “${name}” already exists — not created twice.`);
        continue;
      }
      const key = `new:${name.toLowerCase()}`;
      knownNames.set(name.toLowerCase(), key);
      steps.push({
        kind: 'add',
        label: `New point ${name}${typeof fp.elevation === 'number' ? ` (elevation ${fp.elevation} m)` : ''}`,
        run: async (ids) => {
          const p = await api.createPoint({
            siteId,
            name,
            ...(typeof fp.elevation === 'number' ? { elevationM: fp.elevation } : {}),
          });
          ids.set(key, p.id);
        },
      });
    }
  }
  const missingPoints = site.points.filter((p) => !file.points!.some((fp) => fp.id === p.id));
  if (missingPoints.length) notes.push(`${missingPoints.length} point(s) not in the file are kept: ${missingPoints.map((p) => p.name).join(', ')}.`);

  /** A measurement end: an existing id, else a name (existing or added above). */
  const endOf = (id: string | undefined, name: string | undefined): string | null => {
    if (id && pointById.has(id)) return id;
    if (name && knownNames.has(name.trim().toLowerCase())) return knownNames.get(name.trim().toLowerCase())!;
    return null;
  };
  const resolve = (ref: string, ids: Map<string, string>) => (ref.startsWith('new:') ? ids.get(ref)! : ref);

  // ── Measurements ──
  const byId = new Map(site.measurements.map((m) => [m.id, m]));
  const seen = new Set<string>();
  for (const fm of file.measurements) {
    const a = endOf(fm.fromId, fm.from);
    const b = endOf(fm.toId, fm.to);
    const cm = fm.distanceCm;
    const old = fm.id ? byId.get(fm.id) : undefined;
    if (old) seen.add(old.id);
    if (!a || !b || a === b || typeof cm !== 'number' || !(cm > 0)) {
      notes.push(`Skipped a measurement (${fm.from ?? fm.fromId ?? '?'} → ${fm.to ?? fm.toId ?? '?'}, ${cm ?? '?'} cm): it needs two different known points and a positive distanceCm.`);
      continue;
    }
    const nameA = a.startsWith('new:') ? fm.from! : nameOf(a);
    const nameB = b.startsWith('new:') ? fm.to! : nameOf(b);
    const verified = typeof fm.verifiedAt === 'string' && fm.verifiedAt.length > 0;
    const addPull = async (ids: Map<string, string>) => {
      const r = await api.addMeasurement({
        siteId,
        pointA: resolve(a, ids),
        pointB: resolve(b, ids),
        distanceCm: cm,
        ...(fm.note ? { note: fm.note } : {}),
      });
      if (verified) await api.setMeasurementVerified({ measurementId: r.measurementId, verified: true });
    };

    if (!old) {
      steps.push({ kind: 'add', label: `New measurement ${nameA} ↔ ${nameB}: ${cm} cm${verified ? ' ✓' : ''}`, run: addPull });
      continue;
    }
    const sameEnds = (old.point_a === a && old.point_b === b) || (old.point_a === b && old.point_b === a);
    const oldCm = Math.round(old.distance_m * 1000) / 10;
    if (!sameEnds || !near(oldCm, cm)) {
      // A pull has no edit operation: the change is the old one deleted and the new one added,
      // as one step, so the preview reads as the change it is.
      steps.push({
        kind: 'change',
        label: sameEnds
          ? `Change ${nameA} ↔ ${nameB}: ${oldCm} → ${cm} cm${verified ? ' ✓' : ''}`
          : `Change ${nameOf(old.point_a)} ↔ ${nameOf(old.point_b)} ${oldCm} cm → ${nameA} ↔ ${nameB} ${cm} cm${verified ? ' ✓' : ''}`,
        run: async (ids) => {
          await api.deleteMeasurement({ measurementId: old.id });
          await addPull(ids);
        },
      });
      continue;
    }
    if (verified !== (old.verified_at !== null)) {
      steps.push({
        kind: 'verify',
        label: `${verified ? 'Verify' : 'Unverify'} ${nameOf(old.point_a)} ↔ ${nameOf(old.point_b)} ${oldCm} cm`,
        run: async () => void (await api.setMeasurementVerified({ measurementId: old.id, verified })),
      });
    }
  }
  for (const m of site.measurements) {
    if (seen.has(m.id)) continue;
    steps.push({
      kind: 'delete',
      label: `Delete ${nameOf(m.point_a)} ↔ ${nameOf(m.point_b)} ${Math.round(m.distance_m * 1000) / 10} cm`,
      run: async () => void (await api.deleteMeasurement({ measurementId: m.id })),
    });
  }

  // Deletions first, so a pair replaced by a new pull never briefly has both.
  const order: Record<ImportStep['kind'], number> = { delete: 0, add: 1, change: 2, verify: 3 };
  const pointSteps = steps.filter((s) => s.label.startsWith('New point') || s.label.startsWith('Point '));
  const rest = steps.filter((s) => !pointSteps.includes(s));
  return {
    steps: [...pointSteps, ...rest.sort((x, y) => order[x.kind] - order[y.kind])],
    notes,
  };
}
