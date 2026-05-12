/**
 * Access-control service (Phase D-5).
 *
 * One function answers every "can user X read/edit/delete resource Y?"
 * question in the server: `effectiveRole(userId, resourceType, resourceId)`.
 * Read routes, write routes, and WS subscribe checks all go through it.
 *
 * The decision rules are split out into pure helpers in
 * `access-control-helpers.ts` so they're testable without a database.
 * This file only handles the DB queries and assembly.
 */
import { and, eq } from 'drizzle-orm'
import { db, acls, teamMembers, tasks, projects } from '../db'
import {
  type Role,
  type ResourceType,
  type Visibility,
  combineGrantWithVisibility,
  maxRole,
} from './access-control-helpers'

export {
  type Role,
  type Visibility,
  type ResourceType,
  type PrincipalType,
  TENANT_DEFAULT_ROLE,
  roleSatisfies,
} from './access-control-helpers'

/**
 * Look up the visibility column on a task or project. Returns null when
 * the resource doesn't exist — callers should treat that as "no access."
 */
function getResourceVisibility(
  resourceType: ResourceType,
  resourceId: string
): Visibility | null {
  if (resourceType === 'task') {
    const row = db
      .select({ visibility: tasks.visibility })
      .from(tasks)
      .where(eq(tasks.id, resourceId))
      .get()
    return (row?.visibility as Visibility | undefined) ?? null
  }
  const row = db
    .select({ visibility: projects.visibility })
    .from(projects)
    .where(eq(projects.id, resourceId))
    .get()
  return (row?.visibility as Visibility | undefined) ?? null
}

/**
 * List all team ids the user is currently a member of. Used to widen the
 * ACL lookup beyond direct user grants to include team grants. Cheap by
 * design — a user typically belongs to a handful of teams at most.
 */
function getUserTeamIds(userId: string): string[] {
  return db
    .select({ teamId: teamMembers.teamId })
    .from(teamMembers)
    .where(eq(teamMembers.userId, userId))
    .all()
    .map((r) => r.teamId)
}

/**
 * Pull every ACL grant on the given resource that targets the user — either
 * directly (`principalType='user'`) or via a team they belong to
 * (`principalType='team'`). Returns the raw role strings; the caller folds
 * them with `maxRole`.
 */
function getMatchingGrants(
  userId: string,
  resourceType: ResourceType,
  resourceId: string
): Role[] {
  const teamIds = getUserTeamIds(userId)
  const rows = db
    .select({
      role: acls.role,
      principalType: acls.principalType,
      principalId: acls.principalId,
    })
    .from(acls)
    .where(
      and(eq(acls.resourceType, resourceType), eq(acls.resourceId, resourceId))
    )
    .all()

  const matched: Role[] = []
  for (const r of rows) {
    if (r.principalType === 'user' && r.principalId === userId) {
      matched.push(r.role as Role)
    } else if (r.principalType === 'team' && teamIds.includes(r.principalId)) {
      matched.push(r.role as Role)
    }
  }
  return matched
}

/**
 * Insert an admin grant for the resource creator. Called by POST handlers
 * after a task/project is created so the creator can manage the resource's
 * ACL going forward — without this, the creator only has editor by default
 * (the tenant-visible role) and can't change visibility or grant access.
 *
 * No-op for anonymous creators (no user); the resource ends up admin-less
 * which is a documented footgun but lets anonymous task creation keep
 * working in dev / desktop builds.
 */
export function grantCreatorAdmin(
  userId: string | null | undefined,
  resourceType: ResourceType,
  resourceId: string
): void {
  if (!userId) return
  db.insert(acls)
    .values({
      id: crypto.randomUUID(),
      resourceType,
      resourceId,
      principalType: 'user',
      principalId: userId,
      role: 'admin',
      grantedAt: new Date().toISOString(),
      grantedBy: userId,
    })
    .run()
}

/**
 * Compute the effective role a user has on a specific resource. Returns
 * null when the user has no access (resource doesn't exist, or it's
 * `restricted` and the user has no matching grant).
 *
 * This is the **only** access-decision function the rest of the codebase
 * should call. Don't replicate the logic at call sites — call this and
 * branch on the return value.
 */
export function effectiveRole(
  userId: string,
  resourceType: ResourceType,
  resourceId: string
): Role | null {
  const visibility = getResourceVisibility(resourceType, resourceId)
  if (visibility === null) return null // resource doesn't exist

  const grants = getMatchingGrants(userId, resourceType, resourceId)
  const grantedRole = maxRole(grants)
  return combineGrantWithVisibility(visibility, grantedRole)
}
