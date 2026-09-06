/**
 * The scenario bypasses HTTP entirely, so this file is what stands between
 * "gates green" and a server that does not actually serve.
 *
 * Driven with `app.request` — no port, no process. The route table under test
 * is DERIVED from `spec/model.ts`, so this is also the proof that the derivation
 * produces a surface that works, not merely one that mounts: the persona header
 * resolves a caller, a denial arrives as a 403 problem document (not a generic
 * error), a bad body is a 400 naming the field, and the other tenant's owner
 * sees only their own garden.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { mountApi, type MountedRoute } from '../src/routes.js';
import { buildTriangleHost, seedTriangle, type TriangleWorld } from '../src/seed.js';
import { gardenOperations } from '../spec/model.js';

let dir: string;
let host: SqliteScopeHost;
let w: TriangleWorld;
let app: Hono;
let mounted: MountedRoute[];

const req = (path: string, who?: string, init?: RequestInit) =>
  app.request(path, {
    ...init,
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...(who ? { 'x-principal': who } : {}),
      ...((init?.headers as Record<string, string>) ?? {}),
    },
  });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'triangle-server-'));
  host = buildTriangleHost(dir);
  w = await seedTriangle(host, dir);

  app = new Hono();
  const cast = { markus: [w.markus, w.t1, w.s1], vera: [w.vera, w.t1, w.s1], nils: [w.nils, w.t2, w.s2] } as const;
  mounted = mountApi(app, async (c) => {
    const header = c.req.header('x-principal');
    if (!header) throw new HTTPException(401, { message: 'x-principal header required' });
    const who = cast[header as keyof typeof cast];
    if (!who) throw new HTTPException(401, { message: `unknown principal: ${header}` });
    return host.getScope(who[0], who[1], who[2]);
  });
});

afterAll(async () => {
  await host.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the derived route table, served', () => {
  it('mounts one route per operation the model declares an http shape for', () => {
    const declared = Object.values(gardenOperations).filter((op) => 'http' in op).length;
    // Pinned on purpose: adding an operation to the model should make somebody
    // look here, and a derived table that silently mounted nothing must not pass
    // the 4xx checks below by accident.
    expect(declared).toBe(23);
    expect(mounted).toHaveLength(declared);
    expect(mounted.map((m) => `${m.method} ${m.path}`)).toContain('GET /api/sites/:siteId');
  });

  it('no two operations claim one route', () => {
    const routes = mounted.map((m) => `${m.method} ${m.path}`);
    expect(new Set(routes).size).toBe(routes.length);
    // The dry-run and the apply share a prefix and differ in depth — both reachable.
    expect(routes).toContain('POST /api/sites/:siteId/constraints/preview');
    expect(routes).toContain('POST /api/sites/:siteId/constraints');
  });

  it('serves a paged read for the owner: entries in the body, the walk in headers', async () => {
    const res = await req('/api/sites', 'markus');
    expect(res.status).toBe(200);
    const sites = (await res.json()) as { name: string; points: number }[];
    expect(sites.map((s) => s.name)).toEqual(['Casa Markus']);
    expect(sites[0]!.points).toBeGreaterThan(0);
    expect(res.headers.get('Link')).toBeNull(); // one page, no next
  });

  it('path parameters and query coercion reach the operation', async () => {
    const res = await req(`/api/sites/${w.siteId}`, 'markus');
    expect(res.status).toBe(200);
    const site = (await res.json()) as { site: { name: string }; solve: { rmsCm: number } };
    expect(site.site.name).toBe('Casa Markus');
    expect(site.solve.rmsCm).toBeLessThan(2);
  });

  it('a write goes through the body, and the solver answers', async () => {
    const res = await req(`/api/sites/${w.siteId}/points`, 'markus', {
      method: 'POST',
      body: JSON.stringify({ name: 'gate post', elevationM: 0.1 }),
    });
    expect(res.status).toBe(200);
    const point = (await res.json()) as { id: string; site_id: string; status: string };
    expect(point.site_id).toBe(w.siteId);
    expect(point.status).toBe('named');
    // Housekeeping.
    const del = await req(`/api/points/${point.id}`, 'markus', { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect(((await del.json()) as { deleted: string }).deleted).toBe(point.id);
  });

  it('no header is 401, an unknown principal is 401', async () => {
    expect((await req('/api/sites')).status).toBe(401);
    expect((await req('/api/sites', 'mallory')).status).toBe(401);
  });

  it('the viewer is refused with a 403 PROBLEM document, not a generic error', async () => {
    const res = await req(`/api/sites/${w.siteId}/points`, 'vera', {
      method: 'POST',
      body: JSON.stringify({ name: 'sneaky point' }),
    });
    expect(res.status).toBe(403);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    const body = (await res.json()) as { code?: string; detail?: string };
    expect(body.code).toBe('permission_denied');
    // …while the control beside it is open: the viewer reads and exports.
    expect((await req(`/api/sites/${w.siteId}`, 'vera')).status).toBe(200);
    const dxf = await req(`/api/sites/${w.siteId}/dxf`, 'vera');
    expect(dxf.status).toBe(200);
    expect(((await dxf.json()) as { filename: string }).filename).toBe('casa-markus.dxf');
  });

  it('a malformed body is a 400 naming the field — parsed by the host, not the handler', async () => {
    const res = await req(`/api/sites/${w.siteId}/measurements`, 'markus', {
      method: 'POST',
      body: JSON.stringify({ pointA: w.points.houseSW, pointB: w.points.houseSE, distanceCm: -5 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string; detail?: string };
    expect(body.code).toBe('validation_failed');
    expect(JSON.stringify(body)).toContain('distanceCm');
  });

  it('a genuinely missing thing is 404', async () => {
    expect((await req('/api/sites/nope', 'markus')).status).toBe(404);
  });

  it("a point a wall stands on refuses deletion with a 409, and says why", async () => {
    const res = await req(`/api/points/${w.points.poolNW}`, 'markus', { method: 'DELETE' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { detail: string }).detail).toMatch(/point in use by feature/);
  });

  it("the neighbour's owner sees only the neighbour's garden", async () => {
    const res = await req('/api/sites', 'nils');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { name: string }[]).map((s) => s.name)).toEqual(['Vecino back plot']);
    // …and asking for Casa Markus by id gets nothing: it is another tenant's database.
    expect((await req(`/api/sites/${w.siteId}`, 'nils')).status).toBe(404);
  });

  it('the role hint answers per caller', async () => {
    expect(await (await req('/api/whoami', 'markus')).json()).toEqual({ role: 'garden-owner' });
    expect(await (await req('/api/whoami', 'vera')).json()).toEqual({ role: 'garden-viewer' });
  });

  it('the audit trail is served, paged, with the fat payload', async () => {
    const res = await req(`/api/entities/site/${w.siteId}/timeline?limit=5`, 'vera');
    expect(res.status).toBe(200);
    const entries = (await res.json()) as { type: string }[];
    expect(entries.length).toBeLessThanOrEqual(5);
    expect(res.headers.get('Link')).toMatch(/rel="next"/);
  });

  it('the MCP rendering lists the same operations, minus the ones curated out', async () => {
    const res = await req('/api/mcp', 'markus', {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      headers: { accept: 'application/json, text/event-stream' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { tools: { name: string }[] } };
    const names = body.result.tools.map((t) => t.name);
    expect(names).toContain('garden_export-dxf');
    expect(names).not.toContain('garden_whoami'); // `mcp: false`
    expect(names).toHaveLength(22);
  });
});
