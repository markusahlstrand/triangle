import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type PrincipalId,
  type ScopeId,
  type TenantId,
} from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { ENTITLEMENT_KEYS, MODULES, OWNER_ROLE_KEY, ROLES } from './provision.js';

// The provisioning surface (modules, roles, grant shapes) lives in
// provision.ts — node-free so the worker bundles it and `substrat push` reads
// it. Re-exported here for callers that treat seed.ts as the world's front door.
export { ENTITY_GRANTS, MODULES, permissions, ROLES } from './provision.js';

// ============================================================================
// The seeded world (concept §6). TWO tenants on purpose: Casa Markus is the
// garden under test; Vecino — the neighbour's garden, its own owner — exists
// to be attacked, which is how isolation gets proven rather than claimed.
// ============================================================================

export interface TriangleWorld {
  t1: TenantId; // Casa Markus
  s1: ScopeId;
  t2: TenantId; // Vecino — the neighbour
  s2: ScopeId;
  markus: PrincipalId; // garden-owner @ t1
  vera: PrincipalId; // garden-viewer @ t1
  nils: PrincipalId; // garden-owner @ t2 — the cross-tenant attacker
  siteId: string; // Casa Markus's garden
  vecinoSiteId: string; // the neighbour's own garden
  points: Record<string, string>; // named seed points (houseSW, houseSE, …)
  olivoSpeciesId: string;
}

export function buildTriangleHost(dir: string): SqliteScopeHost {
  const host = new SqliteScopeHost({ dir });
  for (const m of MODULES) host.registerModule(m);
  return host;
}

/**
 * Provision ONE tenant of this vertical: tenant, entitlement, an active scope,
 * the role table, and the owner holding garden-owner. This is what an
 * instantiate button would call — no demo cast, no fixtures.
 */
async function provisionGarden(
  host: SqliteScopeHost,
  input: { tenantId: TenantId; scopeId: ScopeId; owner: PrincipalId; slug: string; name: string },
): Promise<void> {
  const staff = platformActorId.parse(ulid());
  await host.admin.createTenant(staff, { id: input.tenantId, slug: input.slug, name: input.name });
  for (const key of ENTITLEMENT_KEYS) {
    await host.admin.grantEntitlement(staff, input.tenantId, key);
  }
  await host.provisionScope(staff, {
    tenantId: input.tenantId,
    scopeId: input.scopeId,
    jurisdiction: 'eu',
  });
  await host.admin.activateScope(staff, input.tenantId, input.scopeId);
  for (const role of ROLES) await host.admin.defineRole(staff, input.tenantId, role);
  await host.admin.assignRole(staff, {
    principalId: input.owner,
    roleKey: OWNER_ROLE_KEY,
    node: { tenantId: input.tenantId, scopeId: null },
  });
}

/** The starter species library (concept §7) — Mediterranean garden basics. */
const STARTER_SPECIES = [
  { commonName: 'Olivo', latinName: 'Olea europaea', category: 'tree', matureCanopyM: 6, matureHeightM: 8, yearsToMature: 25 },
  { commonName: 'Limonero', latinName: 'Citrus limon', category: 'tree', matureCanopyM: 4, matureHeightM: 5, yearsToMature: 10 },
  { commonName: 'Naranjo', latinName: 'Citrus sinensis', category: 'tree', matureCanopyM: 5, matureHeightM: 6, yearsToMature: 12 },
  { commonName: 'Jacaranda', latinName: 'Jacaranda mimosifolia', category: 'tree', matureCanopyM: 9, matureHeightM: 12, yearsToMature: 20 },
  { commonName: 'Ciprés', latinName: 'Cupressus sempervirens', category: 'tree', matureCanopyM: 1.5, matureHeightM: 18, yearsToMature: 30 },
  { commonName: 'Lavanda', latinName: 'Lavandula angustifolia', category: 'shrub', matureCanopyM: 0.8, matureHeightM: 0.7, yearsToMature: 3 },
  { commonName: 'Romero', latinName: 'Salvia rosmarinus', category: 'shrub', matureCanopyM: 1.2, matureHeightM: 1.2, yearsToMature: 4 },
  { commonName: 'Buganvilla', latinName: 'Bougainvillea glabra', category: 'climber', matureCanopyM: 3, matureHeightM: 6, yearsToMature: 8 },
] as const;

/**
 * Idempotent seed. Everything that mutates the control plane runs only on a
 * FRESH data dir (guarded by cast.json); on restart the tenants, roles, grants
 * and entities are already in the SQLite files, so we just rebuild the handle
 * object. Safe to call on every server start and on every test.
 */
export async function seedTriangle(host: SqliteScopeHost, dir: string): Promise<TriangleWorld> {
  const castPath = join(dir, 'cast.json');
  if (existsSync(castPath)) {
    const raw = JSON.parse(readFileSync(castPath, 'utf8')) as TriangleWorld;
    return {
      ...raw,
      t1: tenantId.parse(raw.t1),
      s1: scopeId.parse(raw.s1),
      t2: tenantId.parse(raw.t2),
      s2: scopeId.parse(raw.s2),
      markus: principalId.parse(raw.markus),
      vera: principalId.parse(raw.vera),
      nils: principalId.parse(raw.nils),
    };
  }

  const staff = platformActorId.parse(ulid());
  const world: TriangleWorld = {
    t1: tenantId.parse(ulid()),
    s1: scopeId.parse(ulid()),
    t2: tenantId.parse(ulid()),
    s2: scopeId.parse(ulid()),
    markus: principalId.parse(ulid()),
    vera: principalId.parse(ulid()),
    nils: principalId.parse(ulid()),
    siteId: '',
    vecinoSiteId: '',
    points: {},
    olivoSpeciesId: '',
  };

  await provisionGarden(host, {
    tenantId: world.t1,
    scopeId: world.s1,
    owner: world.markus,
    slug: 'casa-markus',
    name: 'Casa Markus',
  });
  await provisionGarden(host, {
    tenantId: world.t2,
    scopeId: world.s2,
    owner: world.nils,
    slug: 'vecino',
    name: 'Vecino',
  });

  // Vera views everything in Casa Markus — the tenant-wide viewer role.
  // (A future per-garden invite would use the entity-narrowed shape instead.)
  await host.admin.assignRole(staff, {
    principalId: world.vera,
    roleKey: 'garden-viewer',
    node: { tenantId: world.t1, scopeId: world.s1 },
  });

  // Seed entities go through the operations (NEVER raw SQL): the seed exercises
  // the same permission checks, solver and event spine the app does.
  const markus = await host.getScope(world.markus, world.t1, world.s1);

  const site = await markus.invoke<{ id: string }>('garden/create-site', {
    name: 'Casa Markus',
    datumNote: 'terrace floor = 0.00',
  });
  world.siteId = site.id;

  for (const s of STARTER_SPECIES) {
    const row = await markus.invoke<{ id: string; common_name: string }>('garden/upsert-species', s);
    if (row.common_name === 'Olivo') world.olivoSpeciesId = row.id;
  }

  // The house: a 12.40 × 8.20 m rectangle. house-SW is the origin, house-SE the
  // baseline; the diagonals make the survey redundant enough to show residuals.
  const P = async (name: string, elevationM?: number) =>
    (
      await markus.invoke<{ id: string }>('garden/create-point', {
        siteId: site.id,
        name,
        ...(elevationM !== undefined ? { elevationM } : {}),
      })
    ).id;
  const M = (a: string, b: string, distanceCm: number) =>
    markus.invoke('garden/add-measurement', { siteId: site.id, pointA: a, pointB: b, distanceCm });

  const houseSW = await P('house SW corner', 0);
  const houseSE = await P('house SE corner', 0);
  const houseNE = await P('house NE corner', 0.05);
  const houseNW = await P('house NW corner', 0.05);

  await M(houseSW, houseSE, 1240);
  await M(houseSE, houseNE, 820);
  await M(houseSW, houseNE, 1487); // diagonal
  await markus.invoke('garden/choose-side', { pointId: houseNE, side: 1 });
  await M(houseNW, houseSW, 820);
  await M(houseNW, houseSE, 1487); // diagonal
  await markus.invoke('garden/choose-side', { pointId: houseNW, side: 1 });
  await markus.invoke('garden/add-constraint', {
    siteId: site.id,
    kind: 'right-angle',
    pointIds: [houseSW, houseSE, houseNW],
  });

  // The pool, south of the house, 1.2 m below the terrace datum.
  const poolNW = await P('pool NW', -1.2);
  const poolNE = await P('pool NE', -1.2);
  await M(houseSW, poolNW, 710);
  await M(houseSE, poolNW, 980);
  await markus.invoke('garden/choose-side', { pointId: poolNW, side: -1 });
  await M(houseSE, poolNE, 750);
  await M(houseSW, poolNE, 1050);
  await markus.invoke('garden/choose-side', { pointId: poolNE, side: -1 });

  // A planting spot for the olive, west of the house.
  const olivo = await P('olivo spot', -0.4);
  await M(houseSW, olivo, 520);
  await M(houseNW, olivo, 780);
  await markus.invoke('garden/choose-side', { pointId: olivo, side: 1 });

  world.points = { houseSW, houseSE, houseNE, houseNW, poolNW, poolNE, olivo };

  await markus.invoke('garden/create-feature', {
    siteId: site.id,
    type: 'house',
    name: 'the house',
    closed: true,
    vertices: [
      { pointId: houseSW },
      { pointId: houseSE },
      { pointId: houseNE },
      { pointId: houseNW },
    ],
  });
  await markus.invoke('garden/create-feature', {
    siteId: site.id,
    type: 'retention-wall',
    name: 'pool retention wall',
    closed: false,
    vertices: [{ pointId: poolNW, curvedToNext: true }, { pointId: poolNE }],
    props: { heightM: 1.2 },
  });
  await markus.invoke('garden/add-plant', {
    siteId: site.id,
    pointId: olivo,
    speciesId: world.olivoSpeciesId,
    label: 'olivo grande',
  });

  // The neighbour's own garden — content the attacker legitimately owns.
  const nils = await host.getScope(world.nils, world.t2, world.s2);
  const vecinoSite = await nils.invoke<{ id: string }>('garden/create-site', {
    name: 'Vecino back plot',
  });
  world.vecinoSiteId = vecinoSite.id;
  const vA = (
    await nils.invoke<{ id: string }>('garden/create-point', {
      siteId: vecinoSite.id,
      name: 'shed corner',
    })
  ).id;
  const vB = (
    await nils.invoke<{ id: string }>('garden/create-point', {
      siteId: vecinoSite.id,
      name: 'gate post',
    })
  ).id;
  await nils.invoke('garden/add-measurement', {
    siteId: vecinoSite.id,
    pointA: vA,
    pointB: vB,
    distanceCm: 630,
  });

  writeFileSync(castPath, JSON.stringify(world, null, 2));
  return world;
}
