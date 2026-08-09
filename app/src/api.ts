// Typed wrappers over the dev API. One generic invoke — the operation registry
// is the API surface; the kernel checks a permission inside every operation.

export interface CastEntry {
  name: string;
  role: string;
}

export type Cast = Record<string, CastEntry>;

export interface SiteSummary {
  id: string;
  name: string;
  datum_note: string | null;
  points: number;
  measurements: number;
  features: number;
  plants: number;
}

export interface Point {
  id: string;
  seq: number;
  name: string;
  elevation_m: number | null;
  x: number | null;
  y: number | null;
  status: 'named' | 'measured' | 'placed';
  side: number | null;
  locked: number;
  note: string | null;
}

export interface Measurement {
  id: string;
  point_a: string;
  point_b: string;
  distance_m: number;
  note: string | null;
  created_at: string;
}

export interface Constraint {
  id: string;
  kind: 'right-angle' | 'parallel' | 'equal-length' | 'colinear';
  points: string[];
}

export interface FeatureVertex {
  point_id: string;
  seq: number;
  curved_to_next: number;
}

export interface Feature {
  id: string;
  type: string;
  name: string;
  closed: number;
  vertices: FeatureVertex[];
  props: Record<string, unknown>;
}

export interface Species {
  id: string;
  common_name: string;
  latin_name: string | null;
  category: string;
  mature_canopy_m: number | null;
  mature_height_m: number | null;
  years_to_mature: number | null;
}

export interface Plant {
  id: string;
  point_id: string;
  species_id: string;
  label: string | null;
  planted_on: string | null;
  species: Species;
}

export interface MirrorChoice {
  id: string;
  anchors: [string, string];
  candidates: [{ x: number; y: number }, { x: number; y: number }];
}

export interface SolveReport {
  moved: { pointId: string; from: { x: number; y: number } | null; to: { x: number; y: number }; deltaCm: number }[];
  placed: string[];
  unplaced: { id: string; distances: number }[];
  needsSide: MirrorChoice[];
  measurementResidualsCm: Record<string, number>;
  constraintResidualsCm: Record<string, number>;
  rmsCm: number;
}

export interface SitePayload {
  site: { id: string; name: string; datum_note: string | null };
  points: Point[];
  measurements: Measurement[];
  constraints: Constraint[];
  features: Feature[];
  plants: Plant[];
  solve: SolveReport;
}

let currentPrincipal = localStorage.getItem('triangle-principal') ?? 'markus';

export function principal(): string {
  return currentPrincipal;
}

export function setPrincipal(p: string): void {
  currentPrincipal = p;
  localStorage.setItem('triangle-principal', p);
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
  get denied(): boolean {
    return this.status === 403;
  }
}

export async function invoke<O>(op: string, input?: unknown): Promise<O> {
  const res = await fetch('/api/invoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-principal': currentPrincipal },
    body: JSON.stringify({ op, input }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({ error: res.statusText }))) as { error?: string };
    throw new ApiError(body.error ?? res.statusText, res.status);
  }
  return (await res.json()) as O;
}

export async function fetchCast(): Promise<Cast> {
  const res = await fetch('/api/cast');
  return (await res.json()) as Cast;
}

export function dxfUrl(siteId: string): string {
  return `/api/sites/${siteId}/export.dxf`;
}

export async function downloadDxf(siteId: string): Promise<void> {
  const res = await fetch(dxfUrl(siteId), { headers: { 'x-principal': currentPrincipal } });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({ error: res.statusText }))) as { error?: string };
    throw new ApiError(body.error ?? res.statusText, res.status);
  }
  const blob = await res.blob();
  const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1];
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name ?? 'garden.dxf';
  a.click();
  URL.revokeObjectURL(a.href);
}
