import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ScopeStub } from '@substrat-run/kernel';
import { z } from '@substrat-run/contracts';
import type { ModelAttribution, ModelHost, ModelMessage } from '@substrat-run/vertical-host/model';
import type { SitePayload } from './module.js';

// ============================================================================
// The survey assistant — HARNESS, mounted on both hosts (server.ts, worker.ts).
//
// A person asks about their garden; the platform's model host answers. It reads
// nothing the asker could not read themselves: the garden comes from `garden/get-site`
// invoked AS THE CALLER, so the scope checks `garden:read` exactly as for the map —
// a viewer may ask, Nils in the other tenant reaches nothing. It writes nothing.
//
// The model call lives here and not in an operation: a multi-second network round
// trip must never hold a scope's transaction open (rule 2). The credential is the
// platform's (`createModelHost` over the worker's own bindings) — Triangle ships no
// provider key.
// ============================================================================

/** Preferred first. The first the platform holds a credential for answers. */
export const ASSISTANT_MODELS = [
  'anthropic:claude-sonnet-5',
  // Workers AI, bound as `env.AI` on every pushed vertical: always there when deployed.
  'cloudflare:@cf/meta/llama-3.3-70b-instruct-fp8-fast',
] as const;

/** What the transcript sends: the conversation so far, ending with the question. */
const askBody = z.object({
  siteId: z.string().min(1),
  messages: z
    .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().min(1).max(4000) }))
    .min(1)
    .max(40)
    .refine((m) => m[m.length - 1]!.role === 'user', 'the last message must be the question'),
});

export interface AssistantDeps {
  /** The caller's own scope stub — 401 for nobody, the same resolution every route uses. */
  stub: (c: Context) => Promise<ScopeStub>;
  /** The platform model host for this request; null where none can run (a test, say). */
  models: (c: Context) => ModelHost | null;
  /** The five keys this call is metered under. */
  attribution: (c: Context) => ModelAttribution;
}

/** The first configured model, or null when the platform holds none of them here. */
export function chooseModel(models: ModelHost | null): string | null {
  if (!models) return null;
  return ASSISTANT_MODELS.find((spec) => models.status(spec).configured) ?? null;
}

export function mountAssistant(app: Hono<any, any, any>, deps: AssistantDeps): void {
  /** Which model answers here — what the panel shows before anyone asks. */
  app.get('/api/assistant', async (c) => {
    await deps.stub(c); // signed in, or 401
    const models = deps.models(c);
    const spec = chooseModel(models);
    const status = spec && models ? models.status(spec) : null;
    return c.json({ available: spec !== null, model: status?.label ?? null, hosting: status?.hosting ?? null });
  });

  app.post('/api/assistant', async (c) => {
    const parsed = askBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new HTTPException(400, { message: parsed.error.issues[0]?.message ?? 'bad request' });
    const { siteId, messages } = parsed.data;

    // Read the garden as the asker: the same permission check as the map.
    const scope = await deps.stub(c);
    const site = await scope.invoke<SitePayload>('garden/get-site', { siteId });

    const models = deps.models(c);
    const spec = chooseModel(models);
    if (!models || !spec) {
      throw new HTTPException(503, { message: 'No AI model is available on this install.' });
    }

    const run = await models.run({
      spec,
      attribution: deps.attribution(c),
      system: systemPrompt(site),
      messages: messages as ModelMessage[],
      maxOutputTokens: 1200,
      temperature: 0.2,
    });
    return c.json({ answer: run.text, model: run.label });
  });
}

/**
 * The garden, as the model reads it: compact JSON with names beside ids, distances in cm,
 * each pull with its residual and verification, and the solver's own verdict. A garden is
 * tens of points, so the whole survey fits — no retrieval needed.
 */
export function surveyContext(site: SitePayload) {
  const name = new Map(site.points.map((p) => [p.id, p.name]));
  const n = (id: string) => name.get(id) ?? id;
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  return {
    garden: site.site.name,
    datum: site.site.datum_note,
    units: { distances: 'cm', coordinates: 'm (x east-ish, y north-ish, origin = first point)', elevations: 'm' },
    points: site.points.map((p) => ({
      name: p.name,
      status: p.status,
      x: p.x === null ? null : r3(p.x),
      y: p.y === null ? null : r3(p.y),
      elevation: p.elevation_m,
      locked: p.locked === 1,
    })),
    measurements: site.measurements.map((m) => ({
      id: m.id,
      from: n(m.point_a),
      to: n(m.point_b),
      tapedCm: Math.round(m.distance_m * 1000) / 10,
      residualCm: site.solve.measurementResidualsCm[m.id] ?? null,
      verified: m.verified_at !== null,
    })),
    constraints: site.constraints.map((c) => ({
      kind: c.kind,
      points: c.points.map(n),
      residualCm: site.solve.constraintResidualsCm[c.id] ?? null,
    })),
    features: site.features.map((f) => ({ name: f.name, type: f.type, closed: f.closed === 1, points: f.vertices.map((v) => n(v.point_id)) })),
    plants: site.plants.map((p) => ({ at: n(p.point_id), species: p.species.common_name, label: p.label })),
    solver: {
      rmsCm: site.solve.rmsCm,
      unplaced: site.solve.unplaced.map((u) => ({ point: n(u.id), distances: u.distances })),
      needsSide: site.solve.needsSide.map((s) => n(s.id)),
      suspects: site.solve.suspects.map((s) => ({
        kind: s.kind,
        what:
          s.kind === 'measurement'
            ? (() => {
                const m = site.measurements.find((x) => x.id === s.id);
                return m ? `${n(m.point_a)} ↔ ${n(m.point_b)}` : s.id;
              })()
            : s.kind === 'side'
              ? n(s.id)
              : s.id,
        expectedCm: s.expectedCm,
        offByCm: s.offByCm,
        explains: s.explains,
      })),
    },
  };
}

function systemPrompt(site: SitePayload): string {
  return [
    'You are the survey assistant in Triangle, an app for measuring a garden with a 20 m tape.',
    'Points get positions by trilateration from tape distances; a least-squares adjustment spreads',
    'disagreement, and each measurement has a residual (cm): ≤ 2 good, ≤ 5 amber, above that red.',
    'Constraints (right angles etc.) are assumptions and weigh half as much as tape pulls.',
    'A point with only two distances has two mirror positions; a third distance or a side choice settles it.',
    'The solver lists "suspects": leaving that one observation out makes the rest agree; near-equal',
    '"explains" values mean the survey cannot tell which of them is wrong without one more cross distance.',
    'Verified pulls were re-measured by the owner — trust them over unverified ones.',
    '',
    'Answer questions about this garden from the survey below. Be concrete: name the points and',
    'the numbers. Distances between points can be computed from x/y (meters). When the data cannot',
    'answer, say what to measure next. You cannot change anything; suggest what the person should do.',
    'Answer in the language the question is asked in. Plain text, no markdown tables.',
    '',
    'SURVEY (JSON):',
    JSON.stringify(surveyContext(site)),
  ].join('\n');
}
