/**
 * The garden module's MANIFEST — assembled from `spec/model.ts`, not written twice.
 *
 * `manifestOperations` reads the permission keys and emitted events off the
 * operations; `manifestEntities` reads the parent edges (the link edges the
 * adapter enforces) off the entities; `listsDeclaredBy` reads every kernel-
 * composed paged read so the kernel provisions the index behind it. What is
 * left here is what is genuinely a fact about this DEPLOYMENT rather than the
 * app — its id, its version, where its journal lives, its entitlement — plus
 * the one thing prose has to supply: what each permission key means.
 *
 * Triangle composes NO engines (concept §3): every table is the vertical's own.
 */
import {
  type EnvVarSpec,
  listsDeclaredBy,
  manifestEntities,
  manifestOperations,
  moduleManifest,
  permissionKey,
} from '@substrat-run/contracts';
import { gardenEntities, gardenOperations } from '../spec/model.js';

/** The vertical's permission keys — deliberately just two (concept §4). */
export const GARDEN_PERM = {
  /** Everything that changes a garden: points, tape pulls, constraints, features, plants, species. */
  manage: permissionKey.parse('garden:manage'),
  /** See the map and everything on it, read the audit trail, and export DXF. What a viewer gets. */
  read: permissionKey.parse('garden:read'),
} as const;

/**
 * The instance settings this vertical reads — the standalone-deploy fallback for
 * sign-in only. A hosted install gets its issuer as the delivered `substrat:auth`
 * choice (picked at app creation), which always wins; these apply only when no
 * choice was delivered. Read through `instanceAuthFor` (delivered > binding >
 * default), never off `env` directly. No default for AUTH_PROVIDER: an install
 * with neither a delivered choice nor these set fails closed (503).
 * `src/provision.ts` re-exports this as `envSpec`, which `substrat push` uploads.
 */
export const TRIANGLE_ENV: EnvVarSpec[] = [
  {
    key: 'AUTH_PROVIDER',
    label: 'Auth provider',
    description:
      "OIDC-only: Triangle runs no credential store. When no per-instance `substrat:auth` choice is delivered, 'oidc' verifies bearer tokens against OIDC_ISSUER (standalone deploys).",
    placeholder: 'oidc',
    required: false,
    secret: false,
    group: 'Auth',
  },
  {
    key: 'OIDC_ISSUER',
    label: 'OIDC issuer',
    description: "The issuer URL bearer tokens are verified against when the provider is 'oidc'.",
    placeholder: 'https://auth.example.com',
    required: false,
    secret: false,
    group: 'Auth',
  },
  {
    key: 'OIDC_AUDIENCE',
    label: 'OIDC audience',
    description: 'Expected `aud` claim of verified bearer tokens (optional; issuer-dependent).',
    placeholder: 'https://api.example.com',
    required: false,
    secret: false,
    group: 'Auth',
  },
];

export const gardenManifest = moduleManifest.parse({
  id: 'garden',
  version: '0.0.1',
  kernelContract: '^0.0.1',
  migrations: { journalDir: './migrations', compatibleFrom: '0.0.1' },
  ...manifestOperations(gardenOperations, {
    permissions: {
      'garden:manage':
        'Survey and plan a garden: add/edit points, tape measurements, constraints, features, plants and the species library',
      'garden:read': 'View gardens — the map, points, features, plants, the audit trail — and export DXF',
    },
  }),
  // Every `parents` edge on the model becomes an `entityRelations` entry — the
  // allowlist `ctx.link` checks, and what a future per-garden viewer grant
  // (`garden:read` narrowed to one site) would walk.
  ...manifestEntities(gardenEntities, {}),
  // The kernel-composed paged reads (`paged.over`) and the indexes behind them.
  lists: listsDeclaredBy(gardenOperations, gardenEntities),
  entitlementKey: 'triangle',
  envSpec: TRIANGLE_ENV,
});
