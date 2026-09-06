/**
 * The HTTP surface — derived, not written.
 *
 * There is no route table in this file. Method, path and which input fields the
 * path carries are declared on each operation in `spec/model.ts` and compile-
 * checked there, so `mountOperations` derives the table at mount time — and the
 * MCP tool list at `/api/mcp` with it. Both hosts mount this: `server.ts` (node,
 * SQLite, the dev persona header) and `worker.ts` (Cloudflare, the OIDC seam).
 * Each supplies a `resolveStub` that authenticates the caller its own way.
 *
 * Adding an operation with `http` to the model is what adds a route — on both
 * hosts, in the OpenAPI document and in the SPA client, in one change.
 */
import type { Context, Hono } from 'hono';
import { mountOperations, problemResponse, type ResolveStub } from '@substrat-run/vertical-host';
import { gardenOperations } from '../spec/model.js';
import { API_DOCUMENT } from './api.js';
import { gardenModule } from './module.js';

export type { ResolveStub };

export interface MountedRoute {
  operation: string;
  method: string;
  path: string;
}

/**
 * Mount every declared operation under `/api`, and the error envelope.
 *
 * The mount decides the STATUS for everything the kernel itself names — a
 * refused permission (403), an input that failed to parse (400), a stale
 * `If-Match` (412), `resolveStub` refusing an anonymous call (401) — and
 * re-throws the rest to `app.onError`, where `problemResponse` renders an RFC
 * 9457 `application/problem+json` body: `code` from the platform taxonomy
 * (`substratError('not_found', …)` → 404), and the vertical's own `Error`s as
 * the caller's 400. `worker.ts` mounts the platform surface after this, whose
 * `onError` is built on the same classifier — same input, same answer.
 *
 * Returns what it mounted, so a test can pin the count: a derived table that
 * silently mounted nothing must fail loudly, not pass a suite of 4xx checks.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mountApi(app: Hono<any, any, any>, resolveStub: ResolveStub): MountedRoute[] {
  app.onError((err, c: Context) => problemResponse(c, err));
  // The document the routes below are derived from, on the SAME prefix: deployed,
  // only `/api/*` reaches the worker — everything else is the SPA's asset store
  // with single-page fallback, so `/openapi.json` would answer index.html.
  app.get('/api/openapi.json', (c) => c.json(API_DOCUMENT));
  return mountOperations(app, gardenOperations, resolveStub, {
    basePath: '/api',
    // A typo between a declaration and the registered handler fails at mount,
    // with a message naming it, rather than as a 404 on first call.
    knownOperations: Object.keys(gardenModule.operations ?? {}),
    mcp: { serverInfo: { name: 'triangle', version: gardenModule.manifest.version } },
  });
}
