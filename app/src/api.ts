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
 * LOCAL dev seam (the worker ignores it unless ALLOW_DEV_HEADER is set); deployed,
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

export interface Me {
  key: string;
  display: string;
  role: string;
}

export type Session =
  | { kind: 'dev'; cast: Cast } // local dev server — the x-principal picker
  | { kind: 'user'; me: Me } // deployed, signed in at the issuer
  | { kind: 'anonymous'; needsSetup: boolean }; // deployed, no session yet

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
      const body = (await res.json()) as Me & { status?: string };
      if (body.status === 'needs-setup') return { kind: 'anonymous', needsSetup: true };
      return { kind: 'user', me: body };
    }
  } catch {
    /* treat as anonymous — the sign-in screen is the safe default */
  }
  return { kind: 'anonymous', needsSetup: false };
}

/** Claim an invite while signed in: binds our issuer identity to the invited principal. */
export async function acceptInvite(token: string): Promise<void> {
  const res = await fetch('/api/accept-invite', {
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
