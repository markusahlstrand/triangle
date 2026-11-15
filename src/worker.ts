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
 * via /internal/configure; `instanceAuthFor` builds the full RP (browser login
 * at the issuer, cookie sessions signed with the tenant's DO-minted secret,
 * bearer fallback for API clients) from that delivery. The tenant's `AUTH`
 * IdentityDO maps a verified subject → PrincipalId (claiming the owner seat on
 * first login) and holds invites.
 *
 * There is ONE way in, in every environment: a verified login. The worker no
 * longer honours an `x-principal` header at all — a header naming the caller is
 * an impersonation bypass one variable away from being live. `ALLOW_DEV_NODE`
 * (local `wrangler dev` only, never set in prod) supplies an ADDRESS — which
 * instance an un-routed request belongs to — and authenticates nobody.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import {
  principalId,
  scopeId,
  tenantId,
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
import type { ScopeStub } from '@substrat-run/kernel';
import {
  invocationLog,
  kickFlags,
  mountPlatformSurface,
  readRoutedNode,
  RouterAssertionError,
} from '@substrat-run/vertical-host';
import {
  AuthConfigError,
  IdentityDO,
  instanceAuthFor,
  mintOwnerClaimLink,
  type AuthProvider,
} from '@substrat-run/vertical-auth';
import { mountOwnerClaim } from '@substrat-run/vertical-auth/owner-claim-routes';
import { mountSession } from '@substrat-run/vertical-auth/session-route';
import { membersHook, mountInviteRoutes } from '@substrat-run/vertical-auth/invite-routes';
import { mountApi } from './routes.js';
import { mountAssistant } from './assistant.js';
import { createModelHost } from '@substrat-run/vertical-host/model';
import { createAnthropic } from '@ai-sdk/anthropic';
import { gardenManifest } from './manifest.js';
import { envSpec, MODULES, OWNER_ROLE_KEY, permissions, ROLES } from './provision.js';

/** The scope-DO class = the app binary: kernel + engines + this vertical, bundled. */
export const ScopeDO = defineScopeDO(MODULES, {}, { permissions });
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
  // #1232: the pass reports the version whose code actually ran (the deploy-injected binding).
  versionId: (env) => env.SUBSTRAT_VERSION_ID ?? null,
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
// where there is no router to assert one; gated on ALLOW_DEV_NODE (never set in
// prod). An ADDRESS, not an identity: it grants nobody anything.
const DEV_NODE: Node = {
  tenantId: tenantId.parse('01JZ00000000000000000DEV01'),
  scopeId: scopeId.parse('01JZ00000000000000000DEV02'),
};

interface Env {
  /** Injected at deploy (#1242); absent locally — the sweep record then reads NULL. */
  SUBSTRAT_VERSION_ID?: string;
  /** One DO per scope — business data (sandbox-clean). */
  SCOPE: DurableObjectNamespace;
  /** The per-TENANT identity directory: sub→principal, owner seat, invites, delivered config. */
  AUTH: DurableObjectNamespace<IdentityDO>;
  /** The roster-keeping sweep singleton — the deployment's own timer (#461). */
  SWEEPER: DurableObjectNamespace;
  /**
   * The standalone-deploy sign-in fallback (declared in TRIANGLE_ENV, src/manifest.ts).
   * Typed here only so `wrangler dev --var` works: read ONLY through `instanceAuthFor`,
   * where a delivered per-scope value wins over these deployment-wide bindings.
   */
  AUTH_PROVIDER?: string;
  OIDC_ISSUER?: string;
  OIDC_AUDIENCE?: string;
  /** Local `wrangler dev` only: when 'true', fall back to DEV_NODE if no router
   *  asserted a node. Addresses an instance; authenticates nobody. NEVER set in prod. */
  ALLOW_DEV_NODE?: string;
  /** Shared secret the router presents (how this worker knows the asserted node is real). */
  ROUTER_SECRET?: string;
  /** Shared secret the platform presents on /internal/* calls. */
  PLATFORM_SECRET?: string;
  /**
   * PLATFORM-held model credentials (#1054) — deployment-wide, never a per-install token.
   * Read only by the model host, which reads each provider row's own variables.
   */
  ANTHROPIC_API_KEY?: string;
  /** Workers AI, bound by the platform on every pushed vertical: a capability, not a secret. */
  AI?: unknown;
}

/** The routed (tenant, scope) — from the router assertion, or the dev node. */
function nodeFor(req: Request, env: Env): Node {
  let routed;
  try {
    routed = readRoutedNode(req.headers, {
      expectedSecret: env.ROUTER_SECRET,
      // #966: an unsigned assertion is refused unless this is an un-routed dev instance.
      allowUnsigned: env.ALLOW_DEV_NODE === 'true',
    });
  } catch (e) {
    if (e instanceof RouterAssertionError) throw new HTTPException(400, { message: e.message });
    throw e;
  }
  if (routed) return { tenantId: routed.tenantId, scopeId: routed.scopeId };
  if (env.ALLOW_DEV_NODE === 'true') return DEV_NODE;
  throw new HTTPException(503, { message: 'no scope was asserted for this request (missing router assertion)' });
}

function hostFor(env: Env): CloudflareScopeHost {
  // `permissions` is the declared surface: a module it leaves out is refused at registration.
  const host = new CloudflareScopeHost({ scope: env.SCOPE, permissions });
  for (const m of MODULES) host.registerModule(m);
  return host;
}

/** The tenant's identity DO stub — the sub→principal directory. */
function identityDo(env: Env, node: Node) {
  return env.AUTH.get(env.AUTH.idFromName(node.tenantId));
}

/**
 * Everything this instance was configured with, in ONE DO hop: the delivered
 * `substrat:auth` choice, the declared settings (TRIANGLE_ENV, resolved delivered >
 * binding > manifest default) and the tenant's session secret. A bare `env.X` read
 * would only ever see the deployment-wide default shared by every install.
 */
function authWiringFor(env: Env, node: Node) {
  return instanceAuthFor({
    directory: identityDo(env, node),
    scopeId: node.scopeId,
    envSpec,
    env: env as unknown as Record<string, unknown>,
  });
}

/** The provider an already-read configuration selects; a refusal becomes its HTTP status. */
function providerOf(instance: Awaited<ReturnType<typeof authWiringFor>>): AuthProvider {
  try {
    return instance.provider();
  } catch (err) {
    if (err instanceof AuthConfigError) throw new HTTPException(err.status, { message: err.message });
    throw err;
  }
}

/**
 * The `AuthProvider` for this request, chosen by CONFIG. Per-SCOPE first (a
 * delivered `substrat:auth` builds the full relying-party flow), then the
 * deployment fallback (`AUTH_PROVIDER=oidc` + `OIDC_ISSUER` verifies bearer
 * tokens), then fail closed — there is no builtin credential store.
 */
async function authProviderFor(env: Env, req: Request): Promise<AuthProvider> {
  return providerOf(await authWiringFor(env, nodeFor(req, env)));
}

/**
 * THE AUTH SEAM: the configured provider verifies the request → a subject, and the
 * tenant's identity DO maps that subject → a principal in this scope (claiming the
 * owner seat on first login). Null principal ⇒ nobody (fail closed).
 */
async function callerFor(env: Env, req: Request) {
  const node = nodeFor(req, env);
  const instance = await authWiringFor(env, node);
  const subject = await providerOf(instance).resolve(req.headers);
  if (!subject) return { identity: instance.identity, subject: null, principal: null };
  const principal = await identityDo(env, node).resolvePrincipal(node.scopeId, subject.sub);
  return { identity: instance.identity, subject, principal: principal ? principalId.parse(principal) : null };
}

/** Resolve caller + routed node → who they are and a scope stub. 401 if nobody. */
async function caller(c: Context<{ Bindings: Env }>): Promise<{ principal: PrincipalId; scope: ScopeStub }> {
  const node = nodeFor(c.req.raw, c.env);
  const { principal } = await callerFor(c.env, c.req.raw);
  if (!principal) throw new HTTPException(401, { message: 'unauthorized' });
  const scope = await hostFor(c.env).getScope(principal, node.tenantId, node.scopeId, {
    // An invoke that enqueued platform intents flags its response so the router kicks
    // an immediate platform drain instead of waiting for the sweep. Costs nothing until then.
    ...kickFlags((name, value) => c.header(name, value)),
  });
  return { principal, scope };
}

/** The caller's scope stub. 401 if nobody. */
async function stub(c: Context<{ Bindings: Env }>): Promise<ScopeStub> {
  return (await caller(c)).scope;
}

/**
 * Gate an owner-only action (invites): the caller's role comes from the scope's
 * own grants via `garden/whoami` — the scope-local permission model, not a
 * second source of truth. Throws 401 (no session) / 403 (not the owner).
 */
async function requireOwner(c: Context<{ Bindings: Env }>): Promise<{ principal: PrincipalId }> {
  const { principal, scope } = await caller(c);
  const who = await scope.invoke<{ role: string }>('garden/whoami', undefined);
  if (who.role !== OWNER_ROLE_KEY) throw new HTTPException(403, { message: 'only the garden owner can manage members' });
  return { principal };
}

const app = new Hono<{ Bindings: Env }>();

// FIRST, before any route: Hono composes handlers in registration order and stops at
// the one that answers, so a route registered above this line would never be logged.
// The line it writes attributes this vertical's invocations to the tenant they served,
// written from a VERIFIED router assertion — never from the bare header.
app.use(
  '*',
  invocationLog<Env>({
    routerSecret: (env) => env.ROUTER_SECRET,
    allowUnsigned: (env) => env.ALLOW_DEV_NODE === 'true',
  }),
);

// ── The vertical's API — the SAME derived table `server.ts` mounts (src/routes.ts) ──
// Every operation `spec/model.ts` declares `http` for, /api/openapi.json, the
// MCP endpoint at /api/mcp, and the problem+json error envelope. Mounted BEFORE the platform
// surface below: Hono keeps only the last-registered `onError`, so the platform's
// envelope wins for the whole app — harmless, because both are built on the same
// `classifyError` (a denial is 403 on both).
// The survey assistant (src/assistant.ts) — before the derived table, beside it on /api.
mountAssistant(app, {
  stub,
  models: (c) =>
    createModelHost({
      env: c.env as unknown as Record<string, string | undefined>,
      factories: { anthropic: createAnthropic },
      ...(c.env.AI ? { aiBinding: c.env.AI } : {}),
      sent: 'The question, the conversation so far, and this garden survey: point names, coordinates and tape distances',
      // One usage line per call, in the invocation log — tokens as the provider reported them.
      record: (line) => console.log(JSON.stringify({ event: 'model-usage', ...line })),
    }),
  attribution: (c) => {
    const node = nodeFor(c.req.raw, c.env);
    return {
      tenant: node.tenantId,
      scope: node.scopeId,
      vertical: gardenManifest.id,
      version: c.env.SUBSTRAT_VERSION_ID ?? gardenManifest.version,
      operation: 'garden/assistant',
    };
  },
});

mountApi(app, stub);

// The relying-party flow — `/login` → issuer → `/callback` → session cookie →
// `/logout`. Credentials/sessions live entirely at the OIDC issuer; the
// provider's handle 404s every other credential path (sign-up, password, reset).
app.on(['GET', 'POST'], '/api/auth/*', async (c) => (await authProviderFor(c.env, c.req.raw)).handle(c.req.raw));

/**
 * Who am I — vertical-auth's session route: `{ principal, display, email?, role }`, or
 * `{ status: 'needs-setup', firstSignInOpen }` while the owner seat is unclaimed, so the
 * SPA can say "sign in to claim this garden" instead of a bare 401. The role hint comes
 * from the scope itself (`garden/whoami`).
 */
mountSession(app, {
  caller: async (c) => ({ node: nodeFor(c.req.raw, c.env), ...(await callerFor(c.env, c.req.raw)) }),
  directory: identityDo,
  async extra(c, { node, principal }) {
    const scope = await hostFor(c.env).getScope(principalId.parse(principal), node.tenantId, node.scopeId);
    const who = await scope.invoke<{ role: string }>('garden/whoami', undefined);
    return { role: who.role };
  },
});

// The dev principal picker exists only on the local dev server (src/server.ts) —
// deployed, the cast is empty and the SPA keys its signed-in state off /api/me.
app.get('/api/cast', (c) => c.json({}));

/**
 * Invites — the join path for the viewer (concept §3's invite-a-viewer, on the
 * identity directory). The four routes — list, create, revoke, accept — are
 * `@substrat-run/vertical-auth`'s: creating one pre-mints a principal, grants it the
 * chosen role BOUNDED by what the owner holds, and mints the accept link as a
 * single-use, expiring `become` capability in the scope (on the spine). The invitee
 * signs in at the issuer, opens the link, and the claim binds their `sub` to the
 * pre-minted principal. An invite naming an address is accepted only from a session
 * whose issuer verified that address.
 */
mountInviteRoutes(app, {
  nodeFor,
  requireAdmin: requireOwner,
  roles: ROLES.map((r) => r.key),
  directory: identityDo,
  assignScopeRoleBounded: (env, node, by, assignee, roleKey) =>
    hostFor(env).assignScopeRoleBounded(node.tenantId, node.scopeId, by, assignee, roleKey),
  revokeScopeRole: (env, scope, principal, roleKey) => hostFor(env).revokeScopeRole(scope, principal, roleKey),
  revokeScopeRolesBounded: (env, node, by, principal) =>
    hostFor(env).revokeScopeRolesBounded(node.tenantId, node.scopeId, by, principal),
  mintBecomeCapabilityBounded: (env, node, by, input) =>
    hostFor(env).mintBecomeCapabilityBounded(node.tenantId, node.scopeId, by, input),
  revokeBecomeCapability: (env, node, capabilityId, by) =>
    hostFor(env).revokeBecomeCapability(node.tenantId, node.scopeId, capabilityId, by),
  exchangeCapability: (env, node, secret) =>
    hostFor(env).exchangeCapability(node.tenantId, node.scopeId, secret, { mode: 'become' }),
  becomeLinkStates: (env, node, ids) => hostFor(env).becomeLinkStates(node.tenantId, node.scopeId, ids),
  authProvider: authProviderFor,
});

/**
 * Members — who is in this garden and with which role (owner-only). The identity half
 * (bound logins, the address an invite named) is the directory's; the role half is the
 * scope's own grants. Open invites are listed by `GET /api/invites` beside this.
 */
app.get('/api/members', async (c) => {
  const node = nodeFor(c.req.raw, c.env);
  const { principal: me } = await requireOwner(c);
  const directory = identityDo(c.env, node);
  const [bindings, holders, owner] = await Promise.all([
    directory.listMemberBindings(node.scopeId),
    hostFor(c.env).listScopeRoleHolders(node.tenantId, node.scopeId),
    directory.getOwnerOfRecord(node.scopeId),
  ]);
  const roles = new Map<string, string[]>();
  for (const h of holders) roles.set(h.principal, [...(roles.get(h.principal) ?? []), h.roleKey]);
  const members = bindings
    .filter((b) => b.logins > 0)
    .map((b) => ({
      principal: b.principal,
      email: b.email,
      roles: roles.get(b.principal) ?? [],
      you: b.principal === me,
      ownerOfRecord: b.principal === owner,
    }));
  return c.json({ members });
});

/**
 * Remove a member (owner-only): their roles go first, bounded by what the owner holds,
 * then their logins are unbound. The owner of record and the caller themself are
 * refused — a garden must never be left without its owner.
 */
app.post('/api/members/:principal/remove', async (c) => {
  const node = nodeFor(c.req.raw, c.env);
  const { principal: me } = await requireOwner(c);
  const target = principalId.safeParse(c.req.param('principal'));
  if (!target.success) throw new HTTPException(400, { message: 'not a principal id' });
  const directory = identityDo(c.env, node);
  if (target.data === me) throw new HTTPException(409, { message: 'you cannot remove yourself' });
  if (target.data === (await directory.getOwnerOfRecord(node.scopeId))) {
    throw new HTTPException(409, { message: "the garden's owner cannot be removed" });
  }
  const taken = await hostFor(c.env).revokeScopeRolesBounded(node.tenantId, node.scopeId, me, target.data);
  if (!taken.coverage.covered) throw new HTTPException(403, { message: 'you do not hold every role this member holds' });
  await directory.unbindPrincipal(node.scopeId, target.data);
  return c.body(null, 204);
});

/**
 * Claim the owner seat by link (`POST /api/claim-owner`): when the first-sign-in
 * window has closed with the seat still empty, the dashboard mints a claim link
 * (`/?claim=…`); the installer signs in at the issuer and presents it here.
 */
mountOwnerClaim(app, {
  nodeFor,
  authProvider: authProviderFor,
  directory: identityDo,
  host: hostFor,
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
// the dashboard's Env and Identity tabs — how `substrat:auth` reaches this instance.
mountPlatformSurface<Env>(app, {
  platformSecret: (env) => env.PLATFORM_SECRET,
  hostFor,
  roles: ROLES,
  ownerRoleKey: OWNER_ROLE_KEY,
  onProvision: async (env, b) => {
    // `parentScopeId` binds a sibling scope's owner seat to the login the parent binds
    // to that owner, instead of opening a first-sign-in window.
    await identityDo(env, { tenantId: b.tenantId, scopeId: b.scopeId }).setPendingOwner(b.scopeId, b.owner, b.parentScopeId);
    await sweeper(env).noteScope(b.tenantId, b.scopeId);
  },
  resolveOwner: async (env, ref) => {
    const owner = await identityDo(env, ref).getOwnerOfRecord(ref.scopeId);
    return owner ? principalId.parse(owner) : null;
  },
  // The dashboard's Members section: the same roles and directory as the invite routes
  // above, so a viewer invited from the dashboard accepts at this app's own route.
  members: membersHook({ roles: ROLES.map((r) => r.key), directory: identityDo }),
  onConfigure: (env, b) =>
    identityDo(env, { tenantId: b.tenantId, scopeId: b.scopeId }).setScopeConfig(b.scopeId, b.entries),
  onReadPreviewConfig: (env, b) =>
    identityDo(env, { tenantId: b.tenantId, scopeId: b.scopeId }).getScopeConfig(b.scopeId),
  // The owner seat as the platform may see it, and the claim link it may mint for one
  // that sits empty after the first-sign-in window.
  ownerSeat: (env, ref) => identityDo(env, ref).ownerSeat(ref.scopeId),
  mintOwnerClaim: (env, ref, input) =>
    mintOwnerClaimLink({ directory: identityDo(env, ref), host: hostFor(env) }, ref, input.origin, input.actor),
  // The owner hand-over: moves the record the reconcile re-sources its owner from.
  transferOwner: (env, ref, input) =>
    identityDo(env, ref).transferOwner(ref.scopeId, input.from, input.to, input.toHoldsRole),
  completeOwnerTransfer: (env, ref, input) => identityDo(env, ref).completeOwnerTransfer(ref.scopeId, input.from, input.to),
  abandonOwnerTransfer: (env, ref, input) =>
    identityDo(env, ref).abandonOwnerTransfer(ref.scopeId, input.from, input.to, input.toHoldsRole),
  // A reaped scope's alarm must never wake it again, and its delivered config goes with it.
  onDeleteScope: async (env, s, tenantId) => {
    await sweeper(env).forgetScope(s);
    if (tenantId) await identityDo(env, { tenantId, scopeId: s }).deleteScopeConfig(s);
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
  }),
);

export default app;
