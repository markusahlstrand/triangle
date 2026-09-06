/**
 * This vertical as a deployable Cloudflare Worker — SANDBOX-CLEAN and
 * control-plane-less: the shape `substrat push` deploys into the platform's
 * dispatch namespace. Its only durable stores are its OWN DO classes — `SCOPE`
 * (kernel + engines + this vertical, bundled), `AUTH` (the per-tenant identity
 * directory) and `SWEEPER` (the deployment's own timer, #461); no CONTROL_PLANE
 * binding, no service bindings, no ASSETS binding — the platform refuses those.
 *
 * `substrat push` derives the deploy config from `substrat.runtimeNeeds` in
 * package.json (entry = this file, stores = the DO classes exported here) —
 * you never author wrangler config.
 *
 * ── THE AUTH SEAM (vertical-auth-detach.md) ─────────────────────────────────
 * This vertical is a pure OIDC RELYING PARTY: it runs no credential store and
 * hosts no sign-up. The issuer is chosen at app creation (the dashboard's
 * Identity section) and delivered per scope as the `substrat:auth` config entry
 * via /internal/configure; `authProviderFor` builds the full RP (browser login
 * at the issuer, cookie sessions signed with the tenant's DO-minted secret,
 * bearer fallback for API clients) from that delivery. The tenant's `AUTH`
 * IdentityDO maps a verified subject → PrincipalId (claiming the owner seat on
 * first login) and holds invites. The `x-principal` dev header remains ONLY
 * behind ALLOW_DEV_HEADER for local `wrangler dev` — never set in prod.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import {
  principalId,
  scopeId,
  tenantId,
  z,
  type PrincipalId,
  type ScopeId,
  type TenantId,
} from '@substrat-run/contracts';
import {
  CloudflareScopeHost,
  defineScopeDO,
  defineScopeSweeperDO,
  SCOPE_SWEEPER_NAME,
  type ScopeSweeperDo,
} from '@substrat-run/adapter-cloudflare';
import { readRoutedNode, RouterAssertionError, ulid, type ScopeStub } from '@substrat-run/kernel';
import { mountPlatformSurface } from '@substrat-run/vertical-host';
import { mountApi } from './routes.js';
import {
  IdentityDO,
  oidcAuthProvider,
  oidcRpAuthProvider,
  type AuthProvider,
} from '@substrat-run/vertical-auth';
import { MODULES, OWNER_ROLE_KEY, ROLES } from './provision.js';

/** The scope-DO class = the app binary: kernel + engines + this vertical, bundled. */
export const ScopeDO = defineScopeDO(MODULES, {});
/** The per-tenant identity DO (shared @substrat-run/vertical-auth) — bound as AUTH. */
export { IdentityDO };

/**
 * The deployment's own timer (#461): a roster-keeping singleton whose alarm runs
 * each provisioned scope's due recurring work — executor retries and any
 * `manifest.schedules` your modules declare — with no control plane anywhere.
 * `/internal/provision` and `/internal/reconcile` add scopes to the roster;
 * `/internal/delete-scope` removes them. Costs nothing while the roster is empty.
 */
export const SweeperDO = defineScopeSweeperDO<Env>({
  intervalMs: 120_000,
  host: hostFor,
});

/** The sweeper singleton's stub — one roster and one alarm per deployment. */
function sweeper(env: Env): DurableObjectStub & ScopeSweeperDo {
  return env.SWEEPER.get(
    env.SWEEPER.idFromName(SCOPE_SWEEPER_NAME),
  ) as DurableObjectStub & ScopeSweeperDo;
}

interface Node {
  tenantId: TenantId;
  scopeId: ScopeId;
}

// A fixed dev node (valid ULIDs) — ONLY the fallback for local `wrangler dev`,
// where there is no router to assert one; gated on ALLOW_DEV_HEADER (never set
// in prod).
const DEV_NODE: Node = {
  tenantId: tenantId.parse('01JZ00000000000000000DEV01'),
  scopeId: scopeId.parse('01JZ00000000000000000DEV02'),
};

interface Env {
  /** One DO per scope — business data (sandbox-clean). */
  SCOPE: DurableObjectNamespace;
  /** The per-TENANT identity directory: sub→principal, owner seat, invites, delivered config. */
  AUTH: DurableObjectNamespace<IdentityDO>;
  /** The roster-keeping sweep singleton — the deployment's own timer (#461). */
  SWEEPER: DurableObjectNamespace;
  /**
   * Standalone-deploy fallback ONLY: verify presented bearer tokens against this
   * issuer when no `substrat:auth` was delivered (hosted installs always get the
   * delivered config, which wins). A delivered per-scope value of the same key
   * also wins — see `authProviderFor`.
   */
  OIDC_ISSUER?: string;
  OIDC_AUDIENCE?: string;
  /** Local dev only: when 'true', trust the `x-principal` header. NEVER set in prod. */
  ALLOW_DEV_HEADER?: string;
  /** Shared secret the router presents (how this worker knows the asserted node is real). */
  ROUTER_SECRET?: string;
  /** Shared secret the platform presents on /internal/* calls. */
  PLATFORM_SECRET?: string;
}

/** The routed (tenant, scope) — from the router assertion, or the dev node. */
function nodeFor(req: Request, env: Env): Node {
  let routed;
  try {
    routed = readRoutedNode(req.headers, { expectedSecret: env.ROUTER_SECRET });
  } catch (e) {
    if (e instanceof RouterAssertionError) throw new HTTPException(400, { message: e.message });
    throw e;
  }
  if (routed) return { tenantId: routed.tenantId, scopeId: routed.scopeId };
  if (env.ALLOW_DEV_HEADER === 'true') return DEV_NODE;
  throw new HTTPException(503, { message: 'no scope was asserted for this request (missing router assertion)' });
}

function hostFor(env: Env): CloudflareScopeHost {
  const host = new CloudflareScopeHost({ scope: env.SCOPE });
  for (const m of MODULES) host.registerModule(m);
  return host;
}

/** The tenant's identity DO stub — the sub→principal directory. */
function identityDo(env: Env, node: Node) {
  return env.AUTH.get(env.AUTH.idFromName(node.tenantId));
}

/** SHA-256 hex (Web Crypto). Invite tokens are stored + compared only as hashes. */
async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The scope's DELIVERED auth choice (vertical-auth-detach.md §2.2/§2.3) — the
 * `substrat:auth` entry the dashboard configured at app creation, stored in the
 * tenant's identity DO. Parsed leniently: an absent or malformed entry means
 * "no choice delivered" and the standalone fallback below applies, so a bad
 * delivery can never lock an instance out. OIDC-only: this vertical runs no
 * credential store, so a delivered `builtin` fails the parse → treated as
 * "no choice" → fail closed, never a local account store.
 */
const authChoice = z.object({
  mode: z.literal('oidc'),
  issuer: z.string().url().optional(),
  clientId: z.string().min(1).optional(),
  clientSecret: z.string().optional(),
  audience: z.string().optional(),
  cookieDomain: z.string().min(1).optional(),
});
const AUTH_CONFIG_KEY = 'substrat:auth';

/** The scope's auth wiring, in one DO hop: delivered config + the tenant's session secret. */
async function authWiringFor(env: Env, node: Node) {
  const wiring = await identityDo(env, node).authWiring(node.scopeId);
  const raw = wiring.config[AUTH_CONFIG_KEY];
  let choice: z.infer<typeof authChoice> | null = null;
  if (raw) {
    try {
      const parsed = authChoice.safeParse(JSON.parse(raw));
      choice = parsed.success ? parsed.data : null;
    } catch {
      choice = null;
    }
  }
  return { choice, sessionSecret: wiring.sessionSecret, config: wiring.config };
}

/**
 * The `AuthProvider` for this request, chosen by CONFIG. Per-SCOPE first
 * (hosted): a delivered `substrat:auth` builds the full relying-party provider —
 * one script, many issuers. No delivery: a per-scope/env `OIDC_ISSUER` verifies
 * presented bearer tokens (standalone deploys). Anything else is unconfigured —
 * fail closed rather than serving anyone.
 */
async function authProviderFor(env: Env, req: Request): Promise<AuthProvider> {
  const node = nodeFor(req, env);
  const { choice, sessionSecret, config } = await authWiringFor(env, node);
  if (choice?.mode === 'oidc') {
    if (!choice.issuer || !choice.clientId) {
      throw new HTTPException(503, { message: "this instance's OIDC configuration is incomplete — set issuer and clientId" });
    }
    return oidcRpAuthProvider({
      issuer: choice.issuer,
      clientId: choice.clientId,
      clientSecret: choice.clientSecret ?? '',
      sessionSecret,
      ...(choice.audience ? { audience: choice.audience } : {}),
      ...(choice.cookieDomain ? { cookieDomain: choice.cookieDomain } : {}),
    });
  }
  const issuer = config['OIDC_ISSUER'] ?? env.OIDC_ISSUER;
  if (issuer) {
    const audience = config['OIDC_AUDIENCE'] ?? env.OIDC_AUDIENCE;
    return oidcAuthProvider({ issuer, ...(audience ? { audience } : {}) });
  }
  throw new HTTPException(503, {
    message: "this instance has no identity provider configured — deliver substrat:auth with mode 'oidc'",
  });
}

/**
 * THE AUTH SEAM: resolve the caller to a PrincipalId, or null for nobody
 * (fail closed). Dev header (local only), else the configured provider verifies
 * the request → a subject, and the tenant's identity DO maps that subject → a
 * principal in this scope — claiming the owner seat on first login (TOFU).
 */
async function principalFor(env: Env, req: Request): Promise<PrincipalId | null> {
  if (env.ALLOW_DEV_HEADER === 'true') {
    const parsed = principalId.safeParse(req.headers.get('x-principal') ?? '');
    if (parsed.success) return parsed.data;
  }
  const subject = await (await authProviderFor(env, req)).resolve(req.headers);
  if (!subject) return null;
  const node = nodeFor(req, env);
  const principal = await identityDo(env, node).resolvePrincipal(node.scopeId, subject.sub);
  return principal ? principalId.parse(principal) : null;
}

/** Resolve caller + routed node → a scope stub. 401 if nobody. */
async function stub(c: Context<{ Bindings: Env }>): Promise<ScopeStub> {
  const node = nodeFor(c.req.raw, c.env);
  const principal = await principalFor(c.env, c.req.raw);
  if (!principal) throw new HTTPException(401, { message: 'unauthorized' });
  return hostFor(c.env).getScope(principal, node.tenantId, node.scopeId);
}

/**
 * Gate an owner-only action (invites): the caller's role comes from the scope's
 * own grants via `garden/whoami` — the scope-local permission model, not a
 * second source of truth. Throws 401 (no session) / 403 (not the owner).
 */
async function requireOwner(c: Context<{ Bindings: Env }>): Promise<ScopeStub> {
  const scope = await stub(c);
  const who = await scope.invoke<{ role: string }>('garden/whoami', undefined);
  if (who.role !== OWNER_ROLE_KEY) throw new HTTPException(403, { message: 'only the garden owner can manage invites' });
  return scope;
}

const app = new Hono<{ Bindings: Env }>();

// ── The vertical's API — the SAME derived table `server.ts` mounts (src/routes.ts) ──
// Every operation `spec/model.ts` declares `http` for, /api/openapi.json, the
// MCP endpoint at /api/mcp, and the problem+json error envelope. Mounted BEFORE the platform
// surface below: Hono keeps only the last-registered `onError`, so the platform's
// envelope wins for the whole app — harmless, because both are built on the same
// `classifyError` (a denial is 403 on both).
mountApi(app, stub);

// The relying-party flow — `/login` → issuer → `/callback` → session cookie →
// `/logout`. Credentials/sessions live entirely at the OIDC issuer; the
// provider's handle 404s every other credential path (sign-up, password, reset).
app.on(['GET', 'POST'], '/api/auth/*', async (c) => (await authProviderFor(c.env, c.req.raw)).handle(c.req.raw));

/**
 * Who am I, in the shape the SPA centres on. No session: if the owner seat is
 * unclaimed this instance is awaiting first sign-in — tell the SPA so it can
 * say "sign in to claim this garden" instead of a bare 401.
 */
app.get('/api/me', async (c) => {
  const node = nodeFor(c.req.raw, c.env);
  const principal = await principalFor(c.env, c.req.raw);
  if (!principal) {
    const needsSetup = await identityDo(c.env, node).needsSetup(node.scopeId);
    return needsSetup ? c.json({ status: 'needs-setup' }) : c.json({ error: 'unauthorized' }, 401);
  }
  const scope = await hostFor(c.env).getScope(principal, node.tenantId, node.scopeId);
  const who = await scope.invoke<{ role: string }>('garden/whoami', undefined);
  // A display name when the provider carries one (the dev-header path carries none).
  const subject = await authProviderFor(c.env, c.req.raw)
    .then((p) => p.resolve(c.req.raw.headers))
    .catch(() => null);
  return c.json({ key: principal, display: subject?.name ?? subject?.email ?? 'You', role: who.role });
});

// The dev principal picker exists only on the local dev server (src/server.ts) —
// deployed, the cast is empty and the SPA keys its signed-in state off /api/me.
app.get('/api/cast', (c) => c.json({}));

/**
 * Invites — the join path for the viewer (concept §3's invite-a-viewer, on the
 * identity directory): creating one pre-mints a principal, grants it the chosen
 * role at scope level, and records the invite keyed by the token's hash; the
 * plaintext token rides only in the returned accept link. The invitee
 * authenticates at the issuer, opens the link, and the claim binds their `sub`
 * to the pre-minted principal.
 */
const inviteBody = z.object({
  email: z.string().email().optional(),
  roleKey: z.string().min(1),
});

app.get('/api/invites', async (c) => {
  const node = nodeFor(c.req.raw, c.env);
  await requireOwner(c);
  return c.json({ roles: ROLES.map((r) => r.key), invites: await identityDo(c.env, node).listInvites(node.scopeId) });
});

app.post('/api/invites', async (c) => {
  const node = nodeFor(c.req.raw, c.env);
  await requireOwner(c);
  const { email, roleKey } = inviteBody.parse(await c.req.json());
  if (!ROLES.some((r) => r.key === roleKey)) throw new HTTPException(400, { message: `unknown role '${roleKey}'` });
  const principal = principalId.parse(ulid());
  // A long, URL-safe token; only its hash is stored. Two UUIDs = 256 bits of entropy.
  const token = (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, '');
  await hostFor(c.env).assignScopeRole(node.scopeId, principal, roleKey);
  await identityDo(c.env, node).createInvite(node.scopeId, principal, roleKey, email ?? null, await sha256Hex(token));
  return c.json(
    { principal, roleKey, email: email ?? null, acceptUrl: `${new URL(c.req.raw.url).origin}/?invite=${token}` },
    201,
  );
});

app.post('/api/invites/:principal/revoke', async (c) => {
  const node = nodeFor(c.req.raw, c.env);
  await requireOwner(c);
  await identityDo(c.env, node).revokeInvite(node.scopeId, c.req.param('principal'));
  return c.body(null, 204);
});

/**
 * Accept an invite: the invitee signs in at the issuer first, then claims while
 * authenticated. Binds their subject → the invite's pre-minted principal;
 * `/api/me` then resolves them as that member.
 */
app.post('/api/accept-invite', async (c) => {
  const node = nodeFor(c.req.raw, c.env);
  const subject = await (await authProviderFor(c.env, c.req.raw)).resolve(c.req.raw.headers);
  if (!subject) throw new HTTPException(401, { message: 'sign in before accepting an invite' });
  const { token } = z.object({ token: z.string().min(1) }).parse(await c.req.json());
  const principal = await identityDo(c.env, node).claimInvite(node.scopeId, subject.sub, await sha256Hex(token));
  if (!principal) throw new HTTPException(400, { message: 'this invite is invalid or already used' });
  return c.json({ ok: true, principal });
});

// ── /internal/* — the platform-gated management contract ────────────────────
// The control plane provisions, heals, inspects and restores installs through
// these routes. The whole contract — provision, reconcile, introspection, the
// read-only SQL console, platform-request drain, snapshot/delete/export/restore,
// bookmarks/rewind, and per-instance configure — plus the guaranteed { error }
// envelope is authored ONCE in @substrat-run/vertical-host (issue #510); mount
// it and it cannot drift.
//
// The hooks: a newly provisioned scope joins the sweep roster (#461) AND records
// its owner seat in the identity directory (the TOFU claim + the durable
// owner-of-record a reconcile heals from); `onConfigure` is the delivery half of
// the dashboard's Env tab — how `substrat:auth` reaches this instance.
mountPlatformSurface<Env>(app, {
  platformSecret: (env) => env.PLATFORM_SECRET,
  hostFor,
  roles: ROLES,
  ownerRoleKey: OWNER_ROLE_KEY,
  onProvision: async (env, b) => {
    await identityDo(env, { tenantId: b.tenantId, scopeId: b.scopeId }).setPendingOwner(b.scopeId, b.owner);
    await sweeper(env).noteScope(b.tenantId, b.scopeId);
  },
  resolveOwner: async (env, ref) => {
    const owner = await identityDo(env, ref).getOwnerOfRecord(ref.scopeId);
    return owner ? principalId.parse(owner) : null;
  },
  onConfigure: (env, b) =>
    identityDo(env, { tenantId: b.tenantId, scopeId: b.scopeId }).setScopeConfig(b.scopeId, b.entries),
  onDeleteScope: async (env, s) => {
    await sweeper(env).forgetScope(s);
  },
});

// Unmatched /api/* fails as JSON. Everything else never reaches the worker in
// production: the SPA under app/dist rides the platform's NATIVE asset store
// (#340) — declared in package.json `substrat.runtimeNeeds.assets`, uploaded by
// `substrat push`, served from the edge with SPA fallback; `runWorkerFirst`
// keeps only /api/* and /internal/* in front of this worker. The JSON pointer
// below is the local-dev fallback where no assets are mounted.
app.all('/api/*', (c) => c.json({ error: `unknown route: ${new URL(c.req.raw.url).pathname}` }, 404));
app.all('*', (c) =>
  c.json({
    service: 'triangle',
    api: 'derived from spec/model.ts — see /api/openapi.json; MCP at /api/mcp',
    docs: 'https://substrat.net',
  }),
);

export default app;
