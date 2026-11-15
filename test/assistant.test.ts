/**
 * The survey assistant, served: it answers only what the asker may read, and it hands the
 * model the garden. Driven with `app.request` over the real seeded scope and a stand-in
 * model host — no network, no provider — so this proves the route's boundaries, not a model.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import type { ModelHost, ModelRequest } from '@substrat-run/vertical-host/model';
import { mountApi } from '../src/routes.js';
import { ASSISTANT_MODELS, mountAssistant } from '../src/assistant.js';
import { buildTriangleHost, seedTriangle, type TriangleWorld } from '../src/seed.js';

let dir: string;
let host: SqliteScopeHost;
let w: TriangleWorld;
let app: Hono;
let asked: ModelRequest[] = [];
let configured = true;

/** Answers with what it was given, so a test can see what reached the model. */
const fakeModels: ModelHost = {
  status: (spec) =>
    ({
      spec,
      label: `fake/${spec}`,
      provider: 'fake',
      modelId: spec,
      configured: configured && spec === ASSISTANT_MODELS[0],
      missing: [],
      hosting: { vendor: 'fake', location: 'test', sent: 'everything' },
    }) as unknown as ReturnType<ModelHost['status']>,
  run: async (request) => {
    asked.push(request);
    return { text: 'Measure from the pillar to the pool corner.', label: `fake/${request.spec}` } as Awaited<
      ReturnType<ModelHost['run']>
    >;
  },
};

const ask = (who: string | undefined, body: unknown) =>
  app.request('/api/assistant', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...(who ? { 'x-principal': who } : {}) },
  });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'triangle-assistant-'));
  host = buildTriangleHost(dir);
  w = await seedTriangle(host, dir);
  app = new Hono();
  const cast = { markus: [w.markus, w.t1, w.s1], vera: [w.vera, w.t1, w.s1], nils: [w.nils, w.t2, w.s2] } as const;
  const stub = async (c: { req: { header: (n: string) => string | undefined } }) => {
    const header = c.req.header('x-principal');
    if (!header) throw new HTTPException(401, { message: 'x-principal header required' });
    const who = cast[header as keyof typeof cast];
    if (!who) throw new HTTPException(401, { message: `unknown principal: ${header}` });
    return host.getScope(who[0], who[1], who[2]);
  };
  mountAssistant(app, {
    stub: stub as never,
    models: () => fakeModels,
    attribution: () => ({ tenant: w.t1, scope: w.s1, vertical: 'garden', version: 'test', operation: 'garden/assistant' }),
  });
  mountApi(app, stub as never);
});

afterAll(async () => {
  await host.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the survey assistant', () => {
  const question = () => ({ siteId: w.siteId, messages: [{ role: 'user', content: 'Which pull is wrong?' }] });

  it('is nobody’s without a caller', async () => {
    expect((await ask(undefined, question())).status).toBe(401);
  });

  it('answers a viewer, with the garden in front of the model', async () => {
    asked = [];
    const res = await ask('vera', question());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ answer: 'Measure from the pillar to the pool corner.', model: `fake/${ASSISTANT_MODELS[0]}` });
    expect(asked).toHaveLength(1);
    expect(asked[0]!.spec).toBe(ASSISTANT_MODELS[0]);
    expect(asked[0]!.system).toContain('Casa Markus');
    expect(asked[0]!.system).toContain('house SW corner');
    expect(asked[0]!.messages).toEqual([{ role: 'user', content: 'Which pull is wrong?' }]);
  });

  it('gives the other tenant nothing — not even the question reaches a model', async () => {
    asked = [];
    const res = await ask('nils', question());
    expect(res.status).toBe(404);
    expect(asked).toHaveLength(0);
  });

  it('refuses a conversation that does not end with a question', async () => {
    const res = await ask('markus', { siteId: w.siteId, messages: [{ role: 'assistant', content: 'hi' }] });
    expect(res.status).toBe(400);
  });

  it('says so when no model is available, rather than failing quietly', async () => {
    configured = false;
    try {
      const res = await ask('markus', question());
      expect(res.status).toBe(503);
      const status = await (await app.request('/api/assistant', { headers: { 'x-principal': 'markus' } })).json();
      expect(status).toMatchObject({ available: false, model: null });
    } finally {
      configured = true;
    }
  });
});
