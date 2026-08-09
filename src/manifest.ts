import { moduleManifest, permissionKey } from '@substrat-run/contracts';

// ============================================================================
// The garden module's MANIFEST — the reviewable contract the kernel reads at
// registration. Triangle composes NO engines (DESIGN.md §3): the survey, the
// solver, the features, the plants and the DXF export are all vertical domain.
// What the kernel contributes is tenancy (a garden owner is a tenant), the
// owner/viewer permission split, and the audit spine ("why did the pool move
// 12 cm last Tuesday" has an answer).
// ============================================================================

/** The vertical's permission keys — deliberately just two (DESIGN.md §4). */
export const GARDEN_PERM = {
  /** Everything that changes a garden: points, tape pulls, constraints, features, plants, species. */
  manage: permissionKey.parse('garden:manage'),
  /** See the map and everything on it, and export DXF. What a viewer gets. */
  read: permissionKey.parse('garden:read'),
};

export const gardenManifest = moduleManifest.parse({
  id: 'garden',
  version: '0.0.1',
  kernelContract: '^0.0.1',
  permissions: [
    {
      key: 'garden:manage',
      description:
        'Survey and plan a garden: add/edit points, tape measurements, constraints, features, plants and the species library',
    },
    {
      key: 'garden:read',
      description: 'View gardens — the map, points, features, plants — and export DXF',
    },
  ],
  // Fat events for every mutation (rule 6): a consumer — today the audit
  // timeline, someday a vivero-quote emitter — never needs a cross-module read.
  events: {
    emits: [
      { type: 'garden.site-created', schemaVersion: 1 },
      { type: 'garden.point-created', schemaVersion: 1 },
      { type: 'garden.point-updated', schemaVersion: 1 },
      { type: 'garden.point-deleted', schemaVersion: 1 },
      { type: 'garden.measurement-added', schemaVersion: 1 },
      { type: 'garden.measurement-deleted', schemaVersion: 1 },
      { type: 'garden.constraint-added', schemaVersion: 1 },
      { type: 'garden.constraint-deleted', schemaVersion: 1 },
      { type: 'garden.solved', schemaVersion: 1 },
      { type: 'garden.feature-created', schemaVersion: 1 },
      { type: 'garden.feature-updated', schemaVersion: 1 },
      { type: 'garden.feature-deleted', schemaVersion: 1 },
      { type: 'garden.plant-added', schemaVersion: 1 },
      { type: 'garden.plant-removed', schemaVersion: 1 },
      { type: 'garden.dxf-exported', schemaVersion: 1 },
    ],
    consumes: [],
  },
  migrations: { journalDir: './migrations', compatibleFrom: '0.0.1' },
  attachmentTargets: [],
  // Everything in a garden hangs off its site. Declared now so a future
  // per-garden viewer invite (engine-invites) can narrow `garden:read` to one
  // site and the walk point→site / feature→site / plant→site resolves it.
  entityRelations: [
    { entityType: 'point', parentType: 'site' },
    { entityType: 'measurement', parentType: 'site' },
    { entityType: 'constraint', parentType: 'site' },
    { entityType: 'feature', parentType: 'site' },
    { entityType: 'plant', parentType: 'site' },
  ],
  entitlementKey: 'garden',
});
