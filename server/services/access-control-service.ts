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
import { and, eq, inArray } from 'drizzle-orm'
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
function getUserTeamIds(userId: string | null): string[] {
  if (!userId) return []
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
  userId: string | null,
  resourceType: ResourceType,
  resourceId: string
): Role[] {
  const teamIds = getUserTeamIds(userId)
  // No user + no team grants possible → short-circuit. Tenant-visible
  // resources still grant the default role via combineGrantWithVisibility.
  if (!userId && teamIds.length === 0) return []
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
    if (r.principalType === 'user' && userId && r.principalId === userId) {
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
 * Ensure an assignee has at least viewer access on a resource. Idempotent
 * by virtue of the (resource, principal) UNIQUE index on `acls` — already
 * higher-privilege rows aren't touched.
 *
 * Called from the task POST/PATCH handlers when assigneeUserId is set,
 * so the assignee can see what they were assigned even on a restricted
 * resource. Without this, you could assign Bob to a restricted task he
 * has no grant on; Bob would see "you were assigned" in the toast but
 * `GET /api/tasks/:id` would 404.
 *
 * `grantedBy` is the actor who triggered the assignment (typically the
 * caller of the PATCH/POST). null when anonymous; in that case we skip
 * inserting because we can't attribute the grant.
 */
export function ensureAssigneeViewer(
  assigneeUserId: string | null | undefined,
  resourceType: ResourceType,
  resourceId: string,
  grantedBy: string | null | undefined
): void {
  if (!assigneeUserId || !grantedBy) return
  // If a row already exists for this (resource, user), leave it alone —
  // the existing role (viewer or higher) suffices.
  const existing = db
    .select({ id: acls.id })
    .from(acls)
    .where(
      and(
        eq(acls.resourceType, resourceType),
        eq(acls.resourceId, resourceId),
        eq(acls.principalType, 'user'),
        eq(acls.principalId, assigneeUserId)
      )
    )
    .get()
  if (existing) return

  db.insert(acls)
    .values({
      id: crypto.randomUUID(),
      resourceType,
      resourceId,
      principalType: 'user',
      principalId: assigneeUserId,
      role: 'viewer',
      grantedAt: new Date().toISOString(),
      grantedBy,
    })
    .run()
}

/**
 * Batch form of `effectiveRole` for a list of tasks.
 *
 * WHY THIS EXISTS
 * `effectiveRole` costs SIX synchronous queries per task: visibility,
 * getUserTeamIds, the task's ACL rows, the task's projectId, getUserTeamIds
 * AGAIN, and the project's ACL rows. The task-list route called it once per
 * task. At 4,756 tasks that is ~28,500 queries on a synchronous SQLite handle,
 * measured at 11.0s for GET /api/tasks — and because the handle is
 * synchronous, it stalls every OTHER request too (/api/tags 10.3s,
 * /api/terminal-view-state 9.8s in the same page load, neither of which is
 * remotely expensive on its own).
 *
 * Three of those six queries were pure waste: `visibility` and `projectId` are
 * columns the caller already has in hand, and the user's team ids cannot
 * change within one request.
 *
 * This does 3 queries TOTAL regardless of task count: team ids once, then all
 * task ACL rows and all project ACL rows for the ids in play.
 *
 * ⚠️ THE DECISION LOGIC IS NOT REIMPLEMENTED HERE. It reuses the same
 * `maxRole` + `combineGrantWithVisibility` helpers, in the same order, with the
 * same project-grant cascade. A second copy of an authorization rule is how the
 * two silently diverge — so `access-control-batch.test.ts` asserts, over a
 * fixture that exercises every visibility/grant combination, that this returns
 * EXACTLY what calling `effectiveRole` per task returns. If you change one, that
 * test fails until you change the other.
 */
export function effectiveRolesForTasks(
  userId: string | null,
  rows: Array<{ id: string; projectId: string | null; visibility: string | null }>
): Map<string, Role | null> {
  const out = new Map<string, Role | null>()
  if (rows.length === 0) return out

  const teamIds = getUserTeamIds(userId)
  const canMatch = Boolean(userId) || teamIds.length > 0

  // One pass for task grants, one for project grants. Both are filtered by the
  // ids actually present, so this does not grow with the ACL table.
  const taskIds = rows.map((r) => r.id)
  const projectIds = [...new Set(rows.map((r) => r.projectId).filter((p): p is string => !!p))]

  const grantsFor = (resourceType: ResourceType, ids: string[]): Map<string, Role[]> => {
    const map = new Map<string, Role[]>()
    if (!canMatch || ids.length === 0) return map
    // Chunked to stay clear of SQLite's bound-parameter ceiling; a board can
    // carry more ids than the default limit allows in one IN (...).
    const CHUNK = 500
    for (let i = 0; i < ids.length; i += CHUNK) {
      const slice = ids.slice(i, i + CHUNK)
      const found = db
        .select({
          resourceId: acls.resourceId,
          role: acls.role,
          principalType: acls.principalType,
          principalId: acls.principalId,
        })
        .from(acls)
        .where(and(eq(acls.resourceType, resourceType), inArray(acls.resourceId, slice)))
        .all()
      for (const r of found) {
        const isMine =
          (r.principalType === 'user' && userId && r.principalId === userId) ||
          (r.principalType === 'team' && teamIds.includes(r.principalId))
        if (!isMine) continue
        const list = map.get(r.resourceId) ?? []
        list.push(r.role as Role)
        map.set(r.resourceId, list)
      }
    }
    return map
  }

  const taskGrants = grantsFor('task', taskIds)
  const projectGrants = grantsFor('project', projectIds)

  for (const row of rows) {
    // A row that reached us from the tasks table exists by definition, so the
    // "resource doesn't exist -> null" arm of effectiveRole cannot apply here;
    // a null visibility column still flows through combineGrantWithVisibility
    // exactly as it would there.
    const grants: Role[] = [...(taskGrants.get(row.id) ?? [])]
    if (row.projectId) grants.push(...(projectGrants.get(row.projectId) ?? []))
    out.set(row.id, combineGrantWithVisibility(row.visibility as Visibility, maxRole(grants)))
  }
  return out
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
  userId: string | null,
  resourceType: ResourceType,
  resourceId: string
): Role | null {
  const visibility = getResourceVisibility(resourceType, resourceId)
  if (visibility === null) return null // resource doesn't exist

  const grants = getMatchingGrants(userId, resourceType, resourceId)

  // Project membership cascades to the project's tasks: an explicit grant
  // on the project counts as the same-strength grant on each task inside
  // it. This is what makes "invite someone to only this project" work —
  // without it a restricted task would need its own per-user grant even
  // for project members. Deliberately only EXPLICIT project grants are
  // inherited (not the tenant-default editor role a tenant-visible project
  // implies), so restricting a task inside a tenant-visible project still
  // hides it from non-members.
  if (resourceType === 'task') {
    const row = db
      .select({ projectId: tasks.projectId })
      .from(tasks)
      .where(eq(tasks.id, resourceId))
      .get()
    if (row?.projectId) {
      grants.push(...getMatchingGrants(userId, 'project', row.projectId))
    }
  }

  const grantedRole = maxRole(grants)
  return combineGrantWithVisibility(visibility, grantedRole)
}
