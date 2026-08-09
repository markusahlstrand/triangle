import {
  definePermissions,
  type PermissionKey,
  type RoleDefinition,
} from '@substrat-run/contracts';
import { gardenModule } from './module.js';
import { GARDEN_PERM } from './manifest.js';

// ============================================================================
// The vertical's PROVISIONING surface — everything a deployment needs to know
// about modules, roles and grant shapes, with NO node imports. Split from
// seed.ts (which pulls in node:fs + the SQLite adapter) so the Cloudflare
// worker (src/worker.ts) can bundle it, and so `substrat push` can read the
// permission registry from it (package.json `substrat.permissions`).
// ============================================================================

/** Triangle composes NO engines (DESIGN.md §3) — one module, the garden. */
export const MODULES = [gardenModule];

/** Entitlements are default-deny: one SKU key per module this vertical runs. */
export const ENTITLEMENT_KEYS = ['garden'];

/**
 * The whole cast is two roles (DESIGN.md §4/§6): the owner surveys and plans;
 * the viewer looks and exports. Nobody sees another tenant's garden — that is
 * the kernel's tenancy, not a role.
 */
export const ROLES: RoleDefinition[] = [
  { key: 'garden-owner', permissions: [GARDEN_PERM.manage, GARDEN_PERM.read], source: 'vertical' },
  { key: 'garden-viewer', permissions: [GARDEN_PERM.read], source: 'vertical' },
];

/** Which role the installing owner holds — what /internal/provision assigns. */
export const OWNER_ROLE_KEY = 'garden-owner';

/**
 * Entity-narrowed grant SHAPE, reserved for the invite-a-viewer future
 * (DESIGN.md §3): a viewer invited to ONE garden would hold `garden:read`
 * narrowed to that site instead of the tenant-wide viewer role. Declared now
 * so the reviewable surface already names it; today's seed uses the role.
 */
export const ENTITY_GRANTS: { entityType: string; permissions: PermissionKey[] }[] = [
  { entityType: 'site', permissions: [GARDEN_PERM.read] },
];

/**
 * The single typed source for this vertical's permission surface — what the
 * permission checkpoint and `substrat push` read (via package.json
 * `substrat.permissions`).
 */
export const permissions = definePermissions({
  modules: MODULES,
  roles: ROLES,
  entityGrants: ENTITY_GRANTS,
});
