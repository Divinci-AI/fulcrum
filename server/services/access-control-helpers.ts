/**
 * Pure-function helpers for the D-5 access-control layer. Lives in its
 * own file (with zero DB imports) so unit tests can load it without
 * tripping the test-mode FULCRUM_DIR guard at module-load.
 *
 * Decision model recap (see deploy/saas/D5-sharing-design.md for the full
 * version):
 *
 * - Every shareable resource has a `visibility` ∈ {'tenant', 'restricted'}.
 * - Tenant default role is **editor** — anyone authenticated to the
 *   container gets editor on `tenant`-visible resources, unless their
 *   ACL row raises them higher.
 * - ACL rows on a `tenant`-visible resource ELEVATE the principal's role.
 * - ACL rows on a `restricted` resource are the ONLY source of access.
 * - Creator gets admin via an explicit ACL row at creation time (handled
 *   by the route layer, not here).
 */

export type Role = 'viewer' | 'editor' | 'admin'
export type Visibility = 'tenant' | 'restricted'
export type ResourceType = 'task' | 'project'
export type PrincipalType = 'user' | 'team'

/**
 * Tenant-default role for `visibility='tenant'` resources. Codified as a
 * constant so the choice ("editor — sharing is about restricting") shows
 * up at every reference rather than hiding behind a magic literal.
 */
export const TENANT_DEFAULT_ROLE: Role = 'editor'

const ROLE_RANK: Record<Role, number> = {
  viewer: 1,
  editor: 2,
  admin: 3,
}

/**
 * Pick the strongest of a set of roles. Used to combine multiple ACL grants
 * that target the same user (e.g. a direct user grant + a team grant) into
 * one effective role. Returns null for an empty input so callers can use
 * `?? TENANT_DEFAULT_ROLE` to mean "fall back to the tenant default."
 */
export function maxRole(roles: readonly Role[]): Role | null {
  if (roles.length === 0) return null
  let best: Role = roles[0]
  for (const r of roles) {
    if (ROLE_RANK[r] > ROLE_RANK[best]) best = r
  }
  return best
}

/**
 * Predicate: does `granted` satisfy a requirement for at least `required`?
 * Used at write/admin call sites: `if (!roleSatisfies(effective, 'editor'))
 * return 403`. Returns false when `granted` is null (no access).
 */
export function roleSatisfies(granted: Role | null, required: Role): boolean {
  if (granted === null) return false
  return ROLE_RANK[granted] >= ROLE_RANK[required]
}

/**
 * Combine an optional explicit grant with a resource's visibility into the
 * principal's effective role. This is the central business rule of the
 * model and is the only place that knows what "tenant-visible" means.
 *
 * - visibility='restricted': effective role IS the grant (null = no access)
 * - visibility='tenant':     grant elevates above TENANT_DEFAULT_ROLE
 */
export function combineGrantWithVisibility(
  visibility: Visibility,
  grantedRole: Role | null
): Role | null {
  if (visibility === 'restricted') return grantedRole
  // tenant-visible: fall back to default, or use the grant if it's higher.
  if (grantedRole === null) return TENANT_DEFAULT_ROLE
  return ROLE_RANK[grantedRole] >= ROLE_RANK[TENANT_DEFAULT_ROLE]
    ? grantedRole
    : TENANT_DEFAULT_ROLE
}
