import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ScopeStub } from '@substrat-run/kernel';
import type { PrincipalId } from '@substrat-run/contracts';
import { API_DOCUMENT } from './api.js';
import { mountApi } from './routes.js';
import { buildTriangleHost, seedTriangle, type TriangleWorld } from './seed.js';

// ============================================================================
// The DEV entrypoint. It owns exactly three things — a SQLite host on disk, the
// dev persona picker, and the port — and then mounts `routes.ts`, the same
// derived route table `worker.ts` mounts. There is no business logic here and
// no route here either: a route exists because an operation in `spec/model.ts`
// declares `http`, and for no other reason.
//
// AUTH, locally: the `x-principal` header names a member of the seeded cast.
// Every entry is a real principal with real permission tuples — nothing here
// is a bypass — but it IS a dev seam: the worker only honours the same header
// behind ALLOW_DEV_HEADER, never set in prod, and resolves callers through the
// OIDC relying-party flow instead.
// ============================================================================

const dataDir = join(dirname(fileURLToPath(import.meta.url)), '..', '.data');
mkdirSync(dataDir, { recursive: true });

const host = buildTriangleHost(dataDir);
const world: TriangleWorld = await seedTriangle(host, dataDir);

// The dev cast, keyed by the `x-principal` header value. Nils lives in the
// OTHER tenant: picking him demonstrates the tenant boundary, not a role.
const CAST: Record<string, { name: string; role: string; principal: PrincipalId; tenant: 't1' | 't2' }> = {
  markus: { name: 'Markus', role: 'garden-owner', principal: world.markus, tenant: 't1' },
  vera: { name: 'Vera', role: 'garden-viewer', principal: world.vera, tenant: 't1' },
  nils: { name: 'Nils (Vecino — other tenant)', role: 'garden-owner @ Vecino', principal: world.nils, tenant: 't2' },
};

/**
 * Resolve the caller to a stub on their OWN tenant's scope — exactly what the
 * platform router would do. `?tenant=t1` lets the dev UI demonstrate Nils
 * attacking Casa Markus and being turned away by the kernel.
 */
function stub(c: Context): Promise<ScopeStub> {
  // No header is nobody — a 401, the same answer the worker gives — never a
  // silent default to the owner.
  const who = c.req.header('x-principal');
  if (!who) throw new HTTPException(401, { message: 'x-principal header required (markus | vera | nils)' });
  const entry = CAST[who];
  if (!entry) throw new HTTPException(401, { message: `unknown principal: ${who}` });
  const target = (c.req.query('tenant') ?? entry.tenant) === 't2' ? 't2' : 't1';
  const node = target === 't2' ? { t: world.t2, s: world.s2 } : { t: world.t1, s: world.s1 };
  return host.getScope(entry.principal, node.t, node.s);
}

const app = new Hono();

// The dev-only persona picker — host-specific, so it stays out of the shared table.
app.get('/api/cast', (c) =>
  c.json(
    Object.fromEntries(Object.entries(CAST).map(([k, v]) => [k, { name: v.name, role: v.role }])),
  ),
);

// The document the operations describe, computed once at boot from the same
// declarations the routes below are derived from. The checked-in `openapi.json`
// exists so a surface change shows up in a PR diff — never to be served.
app.get('/openapi.json', (c) => c.json(API_DOCUMENT));

// Every declared operation, the MCP endpoint at /api/mcp, and the error envelope.
const mounted = mountApi(app, stub);

const PORT = Number(process.env.PORT ?? 8871);
serve({ fetch: app.fetch, port: PORT });
console.log(`Triangle API on http://localhost:${PORT} — ${mounted.length} routes, data in ${dataDir}`);
console.log(`Pick a principal with the "x-principal" header: ${Object.keys(CAST).join(', ')}`);
