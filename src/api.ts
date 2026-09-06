/**
 * Triangle's OpenAPI document — derived, not authored.
 *
 * `apiCatalogFrom` reads the summaries and the input/output schemas off the
 * declared operations, so the document and the handlers cannot disagree: they
 * are the same objects. Served live at `/openapi.json` by both hosts, and
 * written to the checked-in `openapi.json` by `pnpm emit` so a surface change
 * shows up in a pull request diff (`pnpm lint:generated` fails on drift).
 */
import { apiCatalogFrom, buildOpenApiDocument } from '@substrat-run/contracts';
import { gardenOperations } from '../spec/model.js';
import { gardenManifest } from './manifest.js';

export const API = apiCatalogFrom(gardenOperations, {
  'garden/create-site': { tag: 'Gardens' },
  'garden/list-sites': { tag: 'Gardens' },
  'garden/get-site': { tag: 'Gardens' },
  'garden/create-point': { tag: 'Survey', description: 'The first point is the origin, the second the baseline on +x.' },
  'garden/update-point': { tag: 'Survey', description: 'Send `If-Match` with the `ETag` a read returned to refuse a stale edit.' },
  'garden/delete-point': { tag: 'Survey' },
  'garden/choose-side': { tag: 'Survey', description: 'A point with exactly two distances has two mirror candidates.' },
  'garden/add-measurement': { tag: 'Survey', description: 'Entered in centimeters as the tape reads; stored in meters.' },
  'garden/delete-measurement': { tag: 'Survey' },
  'garden/preview-constraint': { tag: 'Constraints', description: 'Read-only: reports what the constraint would move before it is applied.' },
  'garden/add-constraint': { tag: 'Constraints', description: 'Assumptions enter the adjustment at half the weight of tape measurements.' },
  'garden/delete-constraint': { tag: 'Constraints' },
  'garden/solve': { tag: 'Survey', description: 'The solver is the only writer of point coordinates.' },
  'garden/create-feature': { tag: 'Features', description: 'Features are ordered point-runs; they never store coordinates.' },
  'garden/update-feature': { tag: 'Features' },
  'garden/delete-feature': { tag: 'Features' },
  'garden/list-species': { tag: 'Plants' },
  'garden/upsert-species': { tag: 'Plants' },
  'garden/add-plant': { tag: 'Plants' },
  'garden/remove-plant': { tag: 'Plants' },
  'garden/export-dxf': { tag: 'Export', description: 'Viewers may export. SKP is a deliberate no; DXF is the interchange path.' },
  'garden/timeline': { tag: 'Audit' },
  'garden/whoami': { tag: 'Session' },
});

export const API_DOCUMENT = buildOpenApiDocument(
  {
    title: 'Triangle',
    version: gardenManifest.version,
    description: 'Garden survey & planning with a 20 m tape — on Substrat.',
  },
  API,
);
