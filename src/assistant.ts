import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ScopeStub } from '@substrat-run/kernel';
import { z } from '@substrat-run/contracts';
import type { ModelAttribution, ModelHost, ModelMessage, ModelTool } from '@substrat-run/vertical-host/model';
import { distanceRange, impossiblePulls, surveyOf, typoSearch, whatIf, type Survey } from './analysis.js';
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
  // Workers AI: the platform binds `env.AI` only because package.json declares
  // `substrat.usesModels` — without it a pushed worker has no model at all.
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
      tools: surveyTools(surveyOf(site)),
      maxSteps: 6,
      maxOutputTokens: 1500,
      temperature: 0.2,
    });
    // What the model looked up on the way, for the transcript ("Checked 3 triangles…").
    const used = run.steps.flatMap((step) => step.toolCalls.map((call) => TOOL_WORDS[call.tool] ?? call.tool));
    return c.json({ answer: run.text, model: run.label, used });
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

/** How the transcript says what a tool did. */
const TOOL_WORDS: Record<string, string> = {
  impossible_measurements: 'Checked every taped triangle for pulls that cannot be',
  distance_range: 'Worked out the range a distance can take',
  what_if: 'Re-solved the survey with a change',
  typo_search: 'Tried every one-slip typo against the survey',
};

/**
 * The analyses the model may run — each re-solves or measures the survey for real, so a claim
 * like "the 987 cm pull is impossible" is computed, not guessed. All read-only: a what-if is
 * never saved.
 */
function surveyTools(s: Survey): Record<string, ModelTool<any>> {
  const ref = z.object({
    id: z.string().optional().describe('measurement id from the survey JSON'),
    from: z.string().optional().describe('point name at one end'),
    to: z.string().optional().describe('point name at the other end'),
  });
  return {
    impossible_measurements: {
      description:
        'Every fully taped triangle that cannot close (one side longer than the other two together, or shorter than their difference). Returns each impossible pull with the range it must lie in and why. Needs no redundancy — run it first when the survey disagrees badly.',
      input: z.object({}),
      execute: async () => impossiblePulls(s).slice(0, 12),
    },
    distance_range: {
      description:
        'The range the distance between two points can take, from every third point taped to both; plus what was taped and what the solved map says.',
      input: z.object({ from: z.string(), to: z.string() }),
      execute: async ({ from, to }: { from: string; to: string }) => distanceRange(s, from, to),
    },
    what_if: {
      description:
        'Re-solve with pulls dropped, pulls read as other values, and/or points forced to their mirror side; returns the misfit (rms) before and after, what is placed, and the worst pulls. Nothing is saved. Use it to test a hypothesis before recommending it.',
      input: z.object({
        drop: z.array(ref).optional(),
        change: z.array(ref.extend({ cm: z.number().positive() })).optional(),
        flip: z.array(z.string()).optional().describe('point names to mirror onto their other side'),
      }),
      execute: async (input: Parameters<typeof whatIf>[1]) => whatIf(s, input),
    },
    typo_search: {
      description:
        'Re-solve with each unverified pull read as each one-slip typo (a zero too many or too few, two digits swapped) and rank the readings that make the survey agree best. A real typo stands far ahead of the rest.',
      input: z.object({}),
      execute: async () => typoSearch(s),
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
    'the numbers. You have tools that compute — impossible_measurements, distance_range, what_if,',
    'typo_search. Use them before claiming a pull is wrong, a point is on the wrong side, or a value',
    'is a typo, and quote what they returned. Think like a surveyor: a gross error usually shows as an',
    'impossible triangle; many red residuals around one point usually come from ONE bad pull nearby.',
    'When the data cannot settle it, say exactly what to measure next. You cannot change anything;',
    'suggest what the person should do.',
    'Answer in the language the question is asked in. Plain text, no markdown tables.',
    '',
    'SURVEY (JSON):',
    JSON.stringify(surveyContext(site)),
  ].join('\n');
}
