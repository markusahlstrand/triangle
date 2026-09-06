/**
 * Triangle's model — what exists, declared once.
 *
 * The concept is approved (`spec/concept.md`); this is its entity and operation
 * surface, and everything downstream is derived from it: the manifest
 * (`src/manifest.ts`), the host-side input parsing, the route table
 * (`src/routes.ts`, via `mountOperations`), the MCP tool list, the OpenAPI
 * document and the SPA client (`tools/emit.mts`). Nothing here is restated by
 * hand anywhere else — a route, a tool or a client method exists because an
 * operation below declares `http`, and for no other reason.
 *
 * This vertical composes **no engine** (concept §3): the survey, the solver, the
 * features, the plants and the DXF export are all domain code. What the kernel
 * contributes is tenancy, the owner/viewer split and the audit spine.
 */
import { defineEntities, defineOperations, emitModel, historyEntry, z } from '@substrat-run/contracts';

export const FEATURE_TYPES = [
  'retention-wall',
  'pool',
  'terrace',
  'stairs',
  'house',
  'fence',
  'bed',
  'path',
] as const;

export const CONSTRAINT_KINDS = ['right-angle', 'parallel', 'equal-length', 'colinear'] as const;

export const SPECIES_CATEGORIES = ['tree', 'shrub', 'hedge', 'perennial', 'climber'] as const;

export const POINT_STATUSES = ['named', 'measured', 'placed'] as const;

// ---------------------------------------------------------------------------
// Entities — the `garden_*` tables (concept §7). Field names ARE the SQL
// columns; `test/model.test.ts` holds them to the migration journal.
// ---------------------------------------------------------------------------

export const gardenEntities = defineEntities({
  /** A garden. One tenant may hold several — they are rows, not tenants. */
  site: {
    table: 'garden_sites',
    fields: z.object({
      id: z.string(),
      name: z.string(),
      datum_note: z.string().nullable(),
      created_at: z.string(),
    }),
  },

  /**
   * A survey point. `x`/`y` are SOLVER OUTPUT — the solver is the only writer
   * (concept §2). `seq` is creation order: the lowest is the origin, the second
   * the baseline. `side` records the mirror choice; `status` mirrors the
   * lifecycle named → measured → placed.
   */
  point: {
    table: 'garden_points',
    fields: z.object({
      id: z.string(),
      site_id: z.string(),
      seq: z.number(),
      name: z.string(),
      elevation_m: z.number().nullable(),
      x: z.number().nullable(),
      y: z.number().nullable(),
      status: z.enum(POINT_STATUSES),
      side: z.number().nullable(),
      locked: z.number(),
      note: z.string().nullable(),
      created_at: z.string(),
    }),
    parents: ['site'],
  },

  /** A tape pull between two points. Entered in cm, stored in meters. */
  measurement: {
    table: 'garden_measurements',
    fields: z.object({
      id: z.string(),
      site_id: z.string(),
      point_a: z.string(),
      point_b: z.string(),
      distance_m: z.number(),
      note: z.string().nullable(),
      created_at: z.string(),
    }),
    parents: ['site'],
  },

  /**
   * A solver assumption. `points_json` is the ordered id list whose meaning
   * depends on `kind`: [at, from, to] for right-angle, [a1, a2, b1, b2] for
   * parallel / equal-length, [p1..pn] for colinear.
   */
  constraint: {
    table: 'garden_constraints',
    fields: z.object({
      id: z.string(),
      site_id: z.string(),
      kind: z.enum(CONSTRAINT_KINDS),
      points_json: z.string(),
      created_at: z.string(),
    }),
    parents: ['site'],
  },

  /** Built fabric drawn through points. Never stores coordinates. */
  feature: {
    table: 'garden_features',
    fields: z.object({
      id: z.string(),
      site_id: z.string(),
      type: z.enum(FEATURE_TYPES),
      name: z.string(),
      closed: z.number(),
      props_json: z.string(),
      created_at: z.string(),
    }),
    parents: ['site'],
  },

  /**
   * The ordered point-run that gives a feature its shape. Keyed by
   * (feature, seq) — a composite key, so it is a full model member but not
   * something a grant, an event or a link can point at.
   */
  featureVertex: {
    table: 'garden_feature_vertices',
    fields: z.object({
      feature_id: z.string(),
      seq: z.number(),
      point_id: z.string(),
      curved_to_next: z.number(),
    }),
    primaryKey: ['feature_id', 'seq'],
  },

  /** The per-tenant species library — the names on DXF labels and the growth numbers. */
  species: {
    table: 'garden_species',
    fields: z.object({
      id: z.string(),
      common_name: z.string(),
      latin_name: z.string().nullable(),
      category: z.enum(SPECIES_CATEGORIES),
      mature_canopy_m: z.number().nullable(),
      mature_height_m: z.number().nullable(),
      years_to_mature: z.number().nullable(),
      created_at: z.string(),
    }),
  },

  /** A plant at a point. `label` falls back to the species' common name. */
  plant: {
    table: 'garden_plants',
    fields: z.object({
      id: z.string(),
      site_id: z.string(),
      point_id: z.string(),
      species_id: z.string(),
      label: z.string().nullable(),
      planted_on: z.string().nullable(),
      note: z.string().nullable(),
      created_at: z.string(),
    }),
    parents: ['site'],
  },
});

/**
 * Two keys, deliberately (concept §4): the owner surveys and plans, the viewer
 * sees everything and changes nothing. Both are held tenant-wide by role; nobody
 * sees another tenant's garden, and that is the kernel's tenancy, not a key.
 */
export const GARDEN_PERMISSIONS = ['garden:manage', 'garden:read'] as const;

// ---------------------------------------------------------------------------
// Shapes the operations answer with that are NOT a stored row. Named here so the
// emitted client can name them too (`substrat.client.schemas` in package.json).
// ---------------------------------------------------------------------------

const xy = z.object({ x: z.number(), y: z.number() });

/** A point with exactly two distances fits in two places; the caller picks one. */
export const mirrorChoice = z.object({
  id: z.string(),
  anchors: z.tuple([z.string(), z.string()]),
  candidates: z.tuple([xy, xy]),
});

/** What a re-solve reports back — nothing moves silently (concept §2). All distances in cm. */
export const solveReport = z.object({
  siteId: z.string(),
  moved: z.array(z.object({ pointId: z.string(), from: xy.nullable(), to: xy, deltaCm: z.number() })),
  placed: z.array(z.string()),
  unplaced: z.array(z.object({ id: z.string(), distances: z.number() })),
  needsSide: z.array(mirrorChoice),
  measurementResidualsCm: z.record(z.string(), z.number()),
  constraintResidualsCm: z.record(z.string(), z.number()),
  rmsCm: z.number(),
});

/** The whole garden in one read — what the map and every list tab render from. */
export const sitePayload = z.object({
  site: gardenEntities.site.fields,
  points: z.array(gardenEntities.point.fields),
  measurements: z.array(gardenEntities.measurement.fields),
  constraints: z.array(gardenEntities.constraint.fields.extend({ points: z.array(z.string()) })),
  features: z.array(
    gardenEntities.feature.fields.extend({
      vertices: z.array(z.object({ point_id: z.string(), seq: z.number(), curved_to_next: z.number() })),
      props: z.record(z.string(), z.unknown()),
    }),
  ),
  plants: z.array(gardenEntities.plant.fields.extend({ species: gardenEntities.species.fields })),
  solve: solveReport,
});

/** A garden in the home list — the row plus what the card shows. */
export const siteSummary = gardenEntities.site.fields.extend({
  points: z.number(),
  measurements: z.number(),
  features: z.number(),
  plants: z.number(),
});

const vertexInput = z.object({
  pointId: z.string().min(1),
  curvedToNext: z.boolean().optional(),
});

/** Point-count per constraint kind: a right angle has a corner and two neighbours, and so on. */
export const CONSTRAINT_ARITY: Record<(typeof CONSTRAINT_KINDS)[number], { min: number; max: number }> = {
  'right-angle': { min: 3, max: 3 },
  parallel: { min: 4, max: 4 },
  'equal-length': { min: 4, max: 4 },
  colinear: { min: 3, max: Number.POSITIVE_INFINITY },
};

const constraintInput = z
  .object({
    siteId: z.string().min(1),
    kind: z.enum(CONSTRAINT_KINDS),
    pointIds: z.array(z.string().min(1)).min(3),
  })
  .superRefine((value, ctx) => {
    const arity = CONSTRAINT_ARITY[value.kind];
    if (value.pointIds.length < arity.min || value.pointIds.length > arity.max) {
      ctx.addIssue({
        code: 'custom',
        path: ['pointIds'],
        message:
          arity.min === arity.max
            ? `a ${value.kind} constraint takes exactly ${arity.min} points`
            : `a ${value.kind} constraint takes at least ${arity.min} points`,
      });
    }
    if (new Set(value.pointIds).size !== value.pointIds.length) {
      ctx.addIssue({ code: 'custom', path: ['pointIds'], message: 'a constraint cannot use the same point twice' });
    }
  });

// ---------------------------------------------------------------------------
// Operations. `http` is the ONLY statement that an operation faces the network:
// it puts the operation in the route table, the MCP tool list, the OpenAPI
// document and the SPA client. Paths are relative to `/api`.
//
// Event payloads are deliberately not declared here: the handlers emit FAT
// payloads (point names, both ends of a tape pull, what moved) that are richer
// than the row the operation answers with, and `payload` can only name output
// fields. The type, the subject entity and the PII class are declared, which is
// what the manifest and the review need.
// ---------------------------------------------------------------------------

export const gardenOperations = defineOperations(gardenEntities, GARDEN_PERMISSIONS)({
  // ── Sites ────────────────────────────────────────────────────────────────
  'garden/create-site': {
    summary: 'Create a garden',
    permission: 'garden:manage',
    input: z.object({ name: z.string().min(1), datumNote: z.string().optional() }),
    output: gardenEntities.site.fields,
    http: { method: 'POST', path: '/sites' },
    emits: { entity: 'site', entityIdFrom: 'id', type: 'garden.site-created', schemaVersion: 1, piiClass: 'none' },
  },

  'garden/list-sites': {
    summary: 'The gardens in this tenant, with their counts',
    permission: 'garden:read',
    output: siteSummary,
    paged: { over: { entity: 'site', sortable: ['created_at', 'name'] } },
    http: { method: 'GET', path: '/sites' },
  },

  'garden/get-site': {
    summary: 'A garden in full: points, tape pulls, constraints, features, plants and the current solve',
    permission: 'garden:read',
    input: z.object({ siteId: z.string().min(1) }),
    output: sitePayload,
    http: { method: 'GET', path: '/sites/{siteId}' },
  },

  // ── Points ───────────────────────────────────────────────────────────────
  'garden/create-point': {
    summary: 'Name a survey point (the first becomes the origin, the second the baseline)',
    permission: 'garden:manage',
    input: z.object({
      siteId: z.string().min(1),
      name: z.string().min(1),
      elevationM: z.number().finite().optional(),
      note: z.string().optional(),
    }),
    output: gardenEntities.point.fields,
    http: { method: 'POST', path: '/sites/{siteId}/points' },
    emits: { entity: 'point', entityIdFrom: 'id', type: 'garden.point-created', schemaVersion: 1, piiClass: 'none' },
  },

  'garden/update-point': {
    summary: 'Rename a point, set its elevation or note, or lock its position',
    permission: 'garden:manage',
    input: z.object({
      pointId: z.string().min(1),
      name: z.string().min(1).optional(),
      elevationM: z.number().finite().nullable().optional(),
      locked: z.boolean().optional(),
      note: z.string().nullable().optional(),
    }),
    output: z.object({ pointId: z.string(), point: gardenEntities.point.fields, solve: solveReport }),
    http: { method: 'PATCH', path: '/points/{pointId}' },
    // A field bag over the point's own columns is read-modify-write: two people
    // editing one point must not silently overwrite each other (#129).
    concurrency: { over: 'point', idFrom: 'pointId' },
    emits: { entity: 'point', entityIdFrom: 'pointId', type: 'garden.point-updated', schemaVersion: 1, piiClass: 'none' },
  },

  'garden/delete-point': {
    summary: 'Delete a point and every tape pull and constraint that used it',
    permission: 'garden:manage',
    input: z.object({ pointId: z.string().min(1) }),
    output: z.object({ deleted: z.string(), solve: solveReport }),
    http: { method: 'DELETE', path: '/points/{pointId}' },
    emits: { entity: 'point', entityIdFrom: 'deleted', type: 'garden.point-deleted', schemaVersion: 1, piiClass: 'none' },
  },

  'garden/choose-side': {
    summary: 'Pick which of the two mirror positions a two-distance point is on',
    permission: 'garden:manage',
    input: z.object({ pointId: z.string().min(1), side: z.union([z.literal(1), z.literal(-1)]) }),
    output: z.object({ pointId: z.string(), point: gardenEntities.point.fields, solve: solveReport }),
    http: { method: 'POST', path: '/points/{pointId}/side' },
    emits: { entity: 'point', entityIdFrom: 'pointId', type: 'garden.point-updated', schemaVersion: 1, piiClass: 'none' },
  },

  // ── Measurements ─────────────────────────────────────────────────────────
  'garden/add-measurement': {
    summary: 'Record a tape pull between two points, in centimeters',
    permission: 'garden:manage',
    input: z.object({
      siteId: z.string().min(1),
      pointA: z.string().min(1),
      pointB: z.string().min(1),
      distanceCm: z.number().positive().finite(),
      note: z.string().optional(),
    }),
    output: z.object({
      measurementId: z.string(),
      measurement: gardenEntities.measurement.fields,
      solve: solveReport,
    }),
    http: { method: 'POST', path: '/sites/{siteId}/measurements' },
    emits: {
      entity: 'measurement',
      entityIdFrom: 'measurementId',
      type: 'garden.measurement-added',
      schemaVersion: 1,
      piiClass: 'none',
    },
  },

  'garden/delete-measurement': {
    summary: 'Delete a tape pull; the survey re-solves from what survives',
    permission: 'garden:manage',
    input: z.object({ measurementId: z.string().min(1) }),
    output: z.object({ deleted: z.string(), solve: solveReport }),
    http: { method: 'DELETE', path: '/measurements/{measurementId}' },
    emits: {
      entity: 'measurement',
      entityIdFrom: 'deleted',
      type: 'garden.measurement-deleted',
      schemaVersion: 1,
      piiClass: 'none',
    },
  },

  // ── Constraints ──────────────────────────────────────────────────────────
  'garden/preview-constraint': {
    summary: 'Dry-run a constraint: what would it move, and by how much',
    permission: 'garden:read',
    input: constraintInput,
    output: solveReport,
    // A POST because the input is a structured body, not because it writes: it
    // touches nothing. Static `/preview` is registered ahead of its siblings.
    http: { method: 'POST', path: '/sites/{siteId}/constraints/preview' },
  },

  'garden/add-constraint': {
    summary: 'Apply a constraint (right angle, parallel, equal length, colinear)',
    permission: 'garden:manage',
    input: constraintInput,
    output: z.object({
      constraintId: z.string(),
      constraint: gardenEntities.constraint.fields,
      solve: solveReport,
    }),
    http: { method: 'POST', path: '/sites/{siteId}/constraints' },
    emits: {
      entity: 'constraint',
      entityIdFrom: 'constraintId',
      type: 'garden.constraint-added',
      schemaVersion: 1,
      piiClass: 'none',
    },
  },

  'garden/delete-constraint': {
    summary: 'Remove a constraint; the survey re-solves without it',
    permission: 'garden:manage',
    input: z.object({ constraintId: z.string().min(1) }),
    output: z.object({ deleted: z.string(), solve: solveReport }),
    http: { method: 'DELETE', path: '/constraints/{constraintId}' },
    emits: {
      entity: 'constraint',
      entityIdFrom: 'deleted',
      type: 'garden.constraint-deleted',
      schemaVersion: 1,
      piiClass: 'none',
    },
  },

  // ── Solve ────────────────────────────────────────────────────────────────
  'garden/solve': {
    summary: 'Re-solve the whole survey and persist the coordinates',
    permission: 'garden:manage',
    input: z.object({ siteId: z.string().min(1) }),
    output: solveReport,
    http: { method: 'POST', path: '/sites/{siteId}/solve' },
    emits: { entity: 'site', entityIdFrom: 'siteId', type: 'garden.solved', schemaVersion: 1, piiClass: 'none' },
  },

  // ── Features ─────────────────────────────────────────────────────────────
  'garden/create-feature': {
    summary: 'Draw a feature through an ordered run of points',
    permission: 'garden:manage',
    input: z.object({
      siteId: z.string().min(1),
      type: z.enum(FEATURE_TYPES),
      name: z.string().min(1),
      closed: z.boolean().optional(),
      vertices: z.array(vertexInput).min(2),
      props: z.record(z.string(), z.unknown()).optional(),
    }),
    output: gardenEntities.feature.fields,
    http: { method: 'POST', path: '/sites/{siteId}/features' },
    emits: { entity: 'feature', entityIdFrom: 'id', type: 'garden.feature-created', schemaVersion: 1, piiClass: 'none' },
  },

  'garden/update-feature': {
    summary: 'Rename a feature, open or close it, retrace its run or change its properties',
    permission: 'garden:manage',
    input: z.object({
      featureId: z.string().min(1),
      name: z.string().min(1).optional(),
      closed: z.boolean().optional(),
      vertices: z.array(vertexInput).min(2).optional(),
      props: z.record(z.string(), z.unknown()).optional(),
    }),
    output: gardenEntities.feature.fields,
    http: { method: 'PATCH', path: '/features/{featureId}' },
    concurrency: { over: 'feature', idFrom: 'featureId' },
    emits: { entity: 'feature', entityIdFrom: 'id', type: 'garden.feature-updated', schemaVersion: 1, piiClass: 'none' },
  },

  'garden/delete-feature': {
    summary: 'Delete a feature (its points stay)',
    permission: 'garden:manage',
    input: z.object({ featureId: z.string().min(1) }),
    output: z.object({ deleted: z.string() }),
    http: { method: 'DELETE', path: '/features/{featureId}' },
    emits: { entity: 'feature', entityIdFrom: 'deleted', type: 'garden.feature-deleted', schemaVersion: 1, piiClass: 'none' },
  },

  // ── Species & plants ─────────────────────────────────────────────────────
  'garden/list-species': {
    summary: 'The species library, alphabetical',
    permission: 'garden:read',
    output: gardenEntities.species.fields,
    paged: { over: { entity: 'species', sortable: ['common_name', 'created_at'] } },
    http: { method: 'GET', path: '/species' },
  },

  'garden/upsert-species': {
    summary: 'Add a species to the library, or update one by id',
    permission: 'garden:manage',
    input: z.object({
      id: z.string().min(1).optional(),
      commonName: z.string().min(1),
      latinName: z.string().optional(),
      category: z.enum(SPECIES_CATEGORIES),
      matureCanopyM: z.number().positive().finite().optional(),
      matureHeightM: z.number().positive().finite().optional(),
      yearsToMature: z.number().positive().finite().optional(),
    }),
    output: gardenEntities.species.fields,
    http: { method: 'PUT', path: '/species' },
    emits: { entity: 'species', entityIdFrom: 'id', type: 'garden.species-upserted', schemaVersion: 1, piiClass: 'none' },
  },

  'garden/add-plant': {
    summary: 'Plant a species at a point',
    permission: 'garden:manage',
    input: z.object({
      siteId: z.string().min(1),
      pointId: z.string().min(1),
      speciesId: z.string().min(1),
      label: z.string().optional(),
      plantedOn: z.string().optional(),
      note: z.string().optional(),
    }),
    output: gardenEntities.plant.fields,
    http: { method: 'POST', path: '/sites/{siteId}/plants' },
    emits: { entity: 'plant', entityIdFrom: 'id', type: 'garden.plant-added', schemaVersion: 1, piiClass: 'none' },
  },

  'garden/remove-plant': {
    summary: 'Remove a plant',
    permission: 'garden:manage',
    input: z.object({ plantId: z.string().min(1) }),
    output: z.object({ deleted: z.string() }),
    http: { method: 'DELETE', path: '/plants/{plantId}' },
    emits: { entity: 'plant', entityIdFrom: 'deleted', type: 'garden.plant-removed', schemaVersion: 1, piiClass: 'none' },
  },

  // ── Export ───────────────────────────────────────────────────────────────
  'garden/export-dxf': {
    summary: 'The garden as ASCII DXF (R12): points with Z = elevation, one layer per feature type, mature canopies',
    permission: 'garden:read',
    input: z.object({ siteId: z.string().min(1) }),
    output: z.object({ siteId: z.string(), filename: z.string(), dxf: z.string() }),
    http: { method: 'GET', path: '/sites/{siteId}/dxf' },
    emits: { entity: 'site', entityIdFrom: 'siteId', type: 'garden.dxf-exported', schemaVersion: 1, piiClass: 'none' },
  },

  // ── Audit ────────────────────────────────────────────────────────────────
  'garden/timeline': {
    summary: "An entity's event history off the audit spine — why did the pool move 12 cm last Tuesday",
    permission: 'garden:read',
    input: z.object({ entityType: z.string().min(1), entityId: z.string().min(1) }),
    output: historyEntry,
    // Walks `_substrat_outbox`, a kernel table — the handler owns the read
    // (`readHistory`) and the cursor is the event id.
    paged: { sortKey: 'id' },
    http: { method: 'GET', path: '/entities/{entityType}/{entityId}/timeline' },
  },

  // ── Session ──────────────────────────────────────────────────────────────
  'garden/whoami': {
    summary: "The caller's role hint for the app shell, derived from the same two grants every operation checks",
    permission: 'garden:read',
    output: z.object({ role: z.enum(['garden-owner', 'garden-viewer']) }),
    http: { method: 'GET', path: '/whoami' },
    // A shell hint, not something an agent reaches for.
    mcp: false,
  },
});

export const gardenModel = emitModel(gardenEntities);
