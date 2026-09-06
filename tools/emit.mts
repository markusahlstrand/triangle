#!/usr/bin/env tsx
/**
 * The generated artifacts — re-emitted from `spec/model.ts`, never hand-edited.
 *
 *   pnpm emit                 write app/src/api.generated.ts and openapi.json
 *   pnpm lint:generated       CI: exit 1 if either has drifted from the model
 *
 * Two artifacts, one source. The SPA client (`renderClient`, from
 * `@substrat-run/model-emit`) turns every operation that declares `http` into a
 * typed method and every entity's `fields` into an interface; the OpenAPI
 * document (`src/api.ts`) is the same declarations rendered for a reader. A
 * hand-written client drifts the way a hand-written route table does — the
 * todo demo's could not page or search for two releases after its model
 * declared both — so the `--check` half runs in `pnpm test`'s neighbourhood
 * (`pnpm release`) and fails on drift.
 *
 * Config lives in package.json under `substrat.client`, the same block the
 * platform's own tooling reads. Exit codes follow boundary-lint's: 0 = fine,
 * 1 = drift, 2 = cannot run.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ClientEmitError, renderClient, type ClientConfig } from '@substrat-run/model-emit';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.includes('--check');

function cannot(message: string): never {
  console.error(`emit: ${message}\n`);
  process.exit(2);
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  name: string;
  substrat?: { client?: Partial<ClientConfig> };
};
const config = pkg.substrat?.client;
if (!config) cannot('package.json has no `substrat.client` block');
for (const field of ['model', 'entities', 'operations', 'out', 'name'] as const) {
  if (!config[field]) cannot(`substrat.client is missing \`${field}\``);
}
const client = config as ClientConfig;

const modelPath = join(ROOT, client.model as string);
if (!existsSync(modelPath)) cannot(`substrat.client.model names ${String(client.model)}, which does not exist`);
const model = (await import(pathToFileURL(modelPath).href)) as Record<string, unknown>;
const bag = (name: string): Record<string, unknown> => {
  const value = model[name];
  if (!value || typeof value !== 'object') cannot(`${String(client.model)} exports no \`${name}\``);
  return value as Record<string, unknown>;
};

let clientSource: string;
try {
  clientSource = renderClient(
    pkg.name,
    client,
    client.model as string,
    bag(client.entities as string),
    bag(client.operations as string),
    model,
  );
} catch (err) {
  if (err instanceof ClientEmitError) cannot(err.message);
  throw err;
}

// The OpenAPI document — the same declarations, rendered for a reader.
const { API_DOCUMENT } = (await import(pathToFileURL(join(ROOT, 'src/api.ts')).href)) as {
  API_DOCUMENT: Record<string, unknown>;
};
const openapiSource = `${JSON.stringify(API_DOCUMENT, null, 2)}\n`;

const artifacts: { path: string; content: string; what: string }[] = [
  { path: join(ROOT, client.out), content: clientSource, what: `${client.out} (SPA client)` },
  { path: join(ROOT, 'openapi.json'), content: openapiSource, what: 'openapi.json' },
];

if (!check) {
  for (const a of artifacts) {
    writeFileSync(a.path, a.content);
    console.log(`emit: wrote ${a.what}`);
  }
  process.exit(0);
}

const drifted = artifacts.filter((a) => !existsSync(a.path) || readFileSync(a.path, 'utf8') !== a.content);
if (drifted.length) {
  console.error(
    `emit: drift in ${drifted.map((a) => a.what).join(', ')}.\n` +
      '  The model no longer matches the checked-in artifact. Run `pnpm emit` and commit the diff.',
  );
  process.exit(1);
}
console.log(`emit: ${artifacts.length} artifact(s) clean`);
