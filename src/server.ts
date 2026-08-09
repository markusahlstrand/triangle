import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { PermissionDenied, type ScopeStub } from '@substrat-run/kernel';
import type { PrincipalId } from '@substrat-run/contracts';
import { buildTriangleHost, seedTriangle, type TriangleWorld } from './seed.js';

// ============================================================================
// A deliberately THIN dev API. Each route authenticates (a dev principal picker
// via the `x-principal` header — a real deployment swaps in a session), gets the
// scope, and invokes ONE operation. There is no business logic here: every rule
// lives in an operation. The kernel checks a permission inside EVERY operation,
// so the generic /api/invoke route is exactly as safe as one route per op.
// ============================================================================

const dataDir = join(dirname(fileURLToPath(import.meta.url)), '..', '.data');
mkdirSync(dataDir, { recursive: true });

const host = buildTriangleHost(dataDir);
const world: TriangleWorld = await seedTriangle(host, dataDir);

// The dev cast, keyed by the `x-principal` header value. Every entry is a real
// principal with real tuples — nothing here is a bypass. Nils lives in the
// OTHER tenant: picking him demonstrates the tenant boundary, not a role.
const CAST: Record<string, { name: string; role: string; principal: PrincipalId; tenant: 't1' | 't2' }> = {
  markus: { name: 'Markus', role: 'garden-owner', principal: world.markus, tenant: 't1' },
  vera: { name: 'Vera', role: 'garden-viewer', principal: world.vera, tenant: 't1' },
  nils: { name: 'Nils (Vecino — other tenant)', role: 'garden-owner @ Vecino', principal: world.nils, tenant: 't2' },
};

function entryOf(c: Context) {
  const who = c.req.header('x-principal') ?? 'markus';
  const entry = CAST[who];
  if (!entry) throw new PermissionDenied(`unknown principal: ${who}`);
  return entry;
}

/**
 * Resolve the caller to a stub on their OWN tenant's scope — exactly what the
 * platform router would do. `?tenant=t1` lets the dev UI demonstrate Nils
 * attacking Casa Markus and being turned away by the kernel.
 */
function stub(c: Context): Promise<ScopeStub> {
  const entry = entryOf(c);
  const target = (c.req.query('tenant') ?? entry.tenant) === 't2' ? 't2' : 't1';
  const node = target === 't2' ? { t: world.t2, s: world.s2 } : { t: world.t1, s: world.s1 };
  return host.getScope(entry.principal, node.t, node.s);
}

const app = new Hono();

app.onError((err, c) => {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof PermissionDenied || /permission denied/.test(message)) {
    return c.json({ error: message }, 403);
  }
  if (/not found|unknown scope|unknown operation/.test(message)) return c.json({ error: message }, 404);
  return c.json({ error: message }, 400);
});

app.get('/api/cast', (c) =>
  c.json(
    Object.fromEntries(Object.entries(CAST).map(([k, v]) => [k, { name: v.name, role: v.role }])),
  ),
);

// One generic invoke — the operation registry is the API surface.
app.post('/api/invoke', async (c) => {
  const { op, input } = await c.req.json<{ op: string; input?: unknown }>();
  return c.json((await (await stub(c)).invoke(op, input)) ?? null);
});

// DXF as a real download (the one route that isn't JSON).
app.get('/api/sites/:id/export.dxf', async (c) => {
  const { filename, dxf } = await (
    await stub(c)
  ).invoke<{ filename: string; dxf: string }>('garden/export-dxf', { siteId: c.req.param('id') });
  c.header('Content-Type', 'application/dxf');
  c.header('Content-Disposition', `attachment; filename="${filename}"`);
  return c.body(dxf);
});

const PORT = Number(process.env.PORT ?? 8871);
serve({ fetch: app.fetch, port: PORT });
console.log(`Triangle API on http://localhost:${PORT} — data in ${dataDir}`);
console.log(`Pick a principal with the "x-principal" header: ${Object.keys(CAST).join(', ')}`);
