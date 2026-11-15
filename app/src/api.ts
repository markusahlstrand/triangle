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
