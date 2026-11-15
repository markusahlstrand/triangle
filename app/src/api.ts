// The auth seam — the only part of this client a person writes.
//
// Everything else lives in `api.generated.ts`: the types are the entities'
// `fields` and the named schemas, the methods are the `http` declarations in
// `spec/model.ts`, and `pnpm emit` re-emits both. A hand-written client drifts
// the moment an operation is renamed; a generated one fails `pnpm
// lint:generated` instead.
//
// What is left here is genuinely NOT in the model: which identity a request
// carries (the dev persona header locally, the session cookie deployed), the
// session/invite handshake, and turning the DXF text into a download.
import { ApiError, createClient } from './api.generated';
import type { SitePayload } from './api.generated';

export { ApiError };
export type {
  Measurement,
  MirrorChoice,
  Paged,
  Point,
  Site,
  SitePayload,
  SiteSummary,
  SolveReport,
  Species,
  TriangleClient,
} from './api.generated';

/** The hydrated shapes `getSite` answers with — the row plus what the map needs. */
export type Constraint = SitePayload['constraints'][number];
export type Feature = SitePayload['features'][number];
export type FeatureVertex = Feature['vertices'][number];
export type Plant = SitePayload['plants'][number];

export interface CastEntry {
  name: string;
  role: string;
}

export type Cast = Record<string, CastEntry>;

let currentPrincipal = localStorage.getItem('triangle-principal') ?? 'markus';

export function principal(): string {
  return currentPrincipal;
}

export function setPrincipal(p: string): void {
  currentPrincipal = p;
  localStorage.setItem('triangle-principal', p);
}

/**
 * The typed client over the derived route table. The persona header is the
 * LOCAL dev seam of the node dev server (the worker ignores it entirely); deployed,
 * the session cookie set by the relying-party flow is what identifies a request.
 * `errorMessage` is left at its default: the problem+json envelope carries
 * `detail`, which the default already reads.
 */
export const api = createClient({
  headers: () => ({ 'x-principal': currentPrincipal }),
  fetch: (input, init) => fetch(input, { credentials: 'same-origin', ...init }),
});

/**
 * The dev cast — only the LOCAL dev server has one (the x-principal picker is a
 * dev seam). Deployed, this returns empty and the picker hides.
 */
export async function fetchCast(): Promise<Cast> {
  try {
    const res = await fetch('/api/cast');
    if (!res.ok) return {};
    const body = (await res.json()) as Cast & { error?: string };
    return body.error ? {} : body;
  } catch {
    return {};
  }
}

// ── Session (deployed: OIDC relying-party flow; local dev: the cast) ─────────

/** `GET /api/me` signed in — vertical-auth's session answer plus the role hint. */
export interface Me {
  principal: string;
  display: string;
  email?: string;
  role: string;
}

export type Session =
  | { kind: 'dev'; cast: Cast } // local dev server — the x-principal picker
  | { kind: 'user'; me: Me } // deployed, signed in at the issuer
  // deployed, no session yet. `firstSignInOpen` false: the owner seat waits for a claim
  // link from the dashboard, so a plain sign-in would bind nobody.
  | { kind: 'anonymous'; needsSetup: boolean; firstSignInOpen: boolean };

/** Where the worker's relying-party flow lives — redirects to the OIDC issuer. */
export const LOGIN_URL = '/api/auth/login';
export const LOGOUT_URL = '/api/auth/logout';

/**
 * Resolve who we are: a non-empty cast means the local dev server (picker mode);
 * otherwise /api/me decides — signed in, anonymous, or "sign in to claim this
 * garden" while the owner seat is unclaimed (needs-setup).
 */
export async function fetchSession(): Promise<Session> {
  const cast = await fetchCast();
  if (Object.keys(cast).length > 0) return { kind: 'dev', cast };
  try {
    const res = await fetch('/api/me');
    if (res.ok) {
      const body = (await res.json()) as Me & { status?: string; firstSignInOpen?: boolean };
      if (body.status === 'needs-setup') {
        return { kind: 'anonymous', needsSetup: true, firstSignInOpen: body.firstSignInOpen ?? true };
      }
      return { kind: 'user', me: body };
    }
  } catch {
    /* treat as anonymous — the sign-in screen is the safe default */
  }
  return { kind: 'anonymous', needsSetup: false, firstSignInOpen: false };
}

/**
 * The two links a person can arrive with, each redeemed once signed in:
 * an invite (`?invite=` → binds our issuer identity to the invited principal) and an
 * owner claim (`?claim=`, minted by the dashboard when the first-sign-in window closed
 * with the owner seat still empty → binds us to the owner).
 */
export const LINKS = {
  invite: { param: 'invite', storageKey: 'triangle-invite', path: '/api/accept-invite' },
  claim: { param: 'claim', storageKey: 'triangle-claim', path: '/api/claim-owner' },
} as const;

/** Redeem a stashed link while signed in. */
export async function redeemLink(path: string, token: string): Promise<void> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
    throw new ApiError(res.status, body.detail ?? body.error ?? res.statusText, body);
  }
}

/**
 * The DXF is one declared operation like any other — it answers the text and a
 * filename as JSON — so the download is built here, from the same client.
 */
export async function downloadDxf(siteId: string): Promise<void> {
  const { filename, dxf } = await api.exportDxf({ siteId });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([dxf], { type: 'application/dxf' }));
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ── Members (deployed, owner-only) ───────────────────────────────────────────

export interface Member {
  principal: string;
  email: string | null;
  roles: string[];
  you: boolean;
  ownerOfRecord: boolean;
}

export interface Invite {
  principal: string;
  roleKey: string;
  email: string | null;
  createdAt?: string;
  link: { state: 'open' | 'used' | 'revoked' | 'expired'; reason: string | null } | null;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
    throw new ApiError(res.status, body.detail ?? body.error ?? res.statusText, body);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export const members = {
  list: () => call<{ members: Member[] }>('/api/members').then((r) => r.members),
  remove: (principal: string) => call<void>(`/api/members/${principal}/remove`, { method: 'POST' }),
  invites: () => call<{ roles: string[]; invites: Invite[] }>('/api/invites'),
  invite: (roleKey: string, email?: string) =>
    call<{ principal: string; roleKey: string; email: string | null; acceptUrl: string }>('/api/invites', {
      method: 'POST',
      body: JSON.stringify(email ? { roleKey, email } : { roleKey }),
    }),
  revokeInvite: (principal: string) => call<void>(`/api/invites/${principal}/revoke`, { method: 'POST' }),
};

// ── JSON export: the whole survey, as numbers a person (or another tool) can read ──

/**
 * Every measurement, point and assumption of a garden as one JSON file, built from the same
 * `get-site` read the map draws from — names beside ids, distances in cm, each pull with what
 * the adjusted survey makes of it, and the solver's current suspects.
 */
export function surveyJson(site: SitePayload) {
  const name = new Map(site.points.map((p) => [p.id, p.name]));
  const r = (n: number) => Math.round(n * 1000) / 1000;
  return {
    garden: site.site.name,
    datum: site.site.datum_note,
    units: { distance: 'cm', coordinates: 'm', elevation: 'm' },
    points: site.points.map((p) => ({
      id: p.id,
      name: p.name,
      status: p.status,
      x: p.x === null ? null : r(p.x),
      y: p.y === null ? null : r(p.y),
      elevation: p.elevation_m,
      locked: p.locked === 1,
      side: p.side,
    })),
    measurements: site.measurements.map((m) => ({
      id: m.id,
      from: name.get(m.point_a) ?? m.point_a,
      to: name.get(m.point_b) ?? m.point_b,
      fromId: m.point_a,
      toId: m.point_b,
      distanceCm: Math.round(m.distance_m * 1000) / 10,
      residualCm: site.solve.measurementResidualsCm[m.id] ?? null,
      verifiedAt: m.verified_at,
      note: m.note,
      measuredAt: m.created_at,
    })),
    constraints: site.constraints.map((c) => ({
      id: c.id,
      kind: c.kind,
      points: c.points.map((id) => name.get(id) ?? id),
      residualCm: site.solve.constraintResidualsCm[c.id] ?? null,
    })),
    features: site.features.map((f) => ({
      name: f.name,
      type: f.type,
      closed: f.closed === 1,
      points: f.vertices.map((v) => name.get(v.point_id) ?? v.point_id),
    })),
    solve: { rmsCm: site.solve.rmsCm, suspects: site.solve.suspects },
  };
}

export function downloadSurveyJson(site: SitePayload): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(
    new Blob([JSON.stringify(surveyJson(site), null, 2)], { type: 'application/json' }),
  );
  a.download = `${site.site.name.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'garden'}-survey.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}
