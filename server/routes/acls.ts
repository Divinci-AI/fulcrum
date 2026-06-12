/**
 * ACL API (Phase D-5 PR 2).
 *
 * Generic CRUD for ACL grants on tasks + projects. The resource is
 * identified by query (?resourceType=task&resourceId=abc) for GET and
 * by body for POST. PATCH / DELETE operate on a specific grant id.
 *
 * Authorization: only callers with admin role on the target resource
 * can grant, modify, or revoke ACL rows. Visibility flip lives in the
 * same admin-gated bucket.
 */
import { Hono } from 'hono'
import { and, eq } from 'drizzle-orm'
import { db, acls, tasks, projects, users, teams, type Acl } from '../db'
import {
  effectiveRole,
  roleSatisfies,
  type ResourceType,
  type Role,
  type PrincipalType,
  type Visibility,
} from '../services/access-control-service'
import type { CurrentUserContext } from '../middleware/current-user'
import { requireUser } from '../middleware/current-user'
import { broadcast } from '../websocket/terminal-ws'

const app = new Hono<CurrentUserContext>()

const VALID_RESOURCE_TYPES: ResourceType[] = ['task', 'project']
const VALID_PRINCIPAL_TYPES: PrincipalType[] = ['user', 'team']
const VALID_ROLES: Role[] = ['viewer', 'editor', 'admin']

function parseResourceType(s: unknown): ResourceType | null {
  return typeof s === 'string' && (VALID_RESOURCE_TYPES as string[]).includes(s)
    ? (s as ResourceType)
    : null
}
function parsePrincipalType(s: unknown): PrincipalType | null {
  return typeof s === 'string' && (VALID_PRINCIPAL_TYPES as string[]).includes(s)
    ? (s as PrincipalType)
    : null
}
function parseRole(s: unknown): Role | null {
  return typeof s === 'string' && (VALID_ROLES as string[]).includes(s)
    ? (s as Role)
    : null
}

/** Does the principal exist in this tenant? Avoids granting access to
 *  ghost ids that nothing else would match. */
function principalExists(type: PrincipalType, id: string): boolean {
  if (type === 'user') {
    return Boolean(db.select().from(users).where(eq(users.id, id)).get())
  }
  return Boolean(db.select().from(teams).where(eq(teams.id, id)).get())
}


// Live-update fan-out: ACL/visibility changes affect what other connected
// clients can see (member panels, restricted lists) — nudge them to refetch.
function broadcastResourceUpdated(resourceType: string, resourceId: string): void {
  if (resourceType === 'task') {
    broadcast({ type: 'task:updated', payload: { taskId: resourceId } })
  } else {
    broadcast({ type: 'project:updated', payload: { projectId: resourceId } })
  }
}

// GET /api/acls?resourceType=task&resourceId=abc — list grants on a
// resource. Caller must have at least viewer access on the resource.
app.get('/', (c) => {
  const user = requireUser(c)
  const resourceType = parseResourceType(c.req.query('resourceType'))
  const resourceId = c.req.query('resourceId')
  if (!resourceType || !resourceId) {
    return c.json({ error: 'resourceType + resourceId required' }, 400)
  }
  const role = effectiveRole(user.id, resourceType, resourceId)
  if (!roleSatisfies(role, 'viewer')) {
    return c.json({ error: 'access denied' }, 403)
  }
  const rows = db
    .select()
    .from(acls)
    .where(and(eq(acls.resourceType, resourceType), eq(acls.resourceId, resourceId)))
    .all()
  return c.json({ acls: rows })
})

// POST /api/acls — create a new grant. Caller must be admin on the
// resource. Refuses to grant to a ghost user/team id.
app.post('/', async (c) => {
  const user = requireUser(c)
  const body = await c.req.json<{
    resourceType?: string
    resourceId?: string
    principalType?: string
    principalId?: string
    role?: string
  }>()
  const resourceType = parseResourceType(body.resourceType)
  const principalType = parsePrincipalType(body.principalType)
  const role = parseRole(body.role)
  if (!resourceType || !body.resourceId || !principalType || !body.principalId || !role) {
    return c.json(
      { error: 'resourceType, resourceId, principalType, principalId, role are all required' },
      400
    )
  }
  if (!principalExists(principalType, body.principalId)) {
    return c.json({ error: 'principal not found' }, 404)
  }

  const callerRole = effectiveRole(user.id, resourceType, body.resourceId)
  if (!roleSatisfies(callerRole, 'admin')) {
    return c.json({ error: 'admin role required to grant ACL' }, 403)
  }

  const dupe = db
    .select()
    .from(acls)
    .where(
      and(
        eq(acls.resourceType, resourceType),
        eq(acls.resourceId, body.resourceId),
        eq(acls.principalType, principalType),
        eq(acls.principalId, body.principalId)
      )
    )
    .get()
  if (dupe) {
    return c.json(
      { error: 'grant already exists; PATCH the existing row to change role' },
      409
    )
  }

  const grant: Acl = {
    id: crypto.randomUUID(),
    resourceType,
    resourceId: body.resourceId,
    principalType,
    principalId: body.principalId,
    role,
    grantedAt: new Date().toISOString(),
    grantedBy: user.id,
  }
  db.insert(acls).values(grant).run()
  broadcastResourceUpdated(resourceType, body.resourceId)
  return c.json(grant, 201)
})

// PATCH /api/acls/:grantId — change the role on an existing grant.
app.patch('/:grantId', async (c) => {
  const user = requireUser(c)
  const grant = db.select().from(acls).where(eq(acls.id, c.req.param('grantId'))).get()
  if (!grant) return c.json({ error: 'grant not found' }, 404)

  const callerRole = effectiveRole(
    user.id,
    grant.resourceType as ResourceType,
    grant.resourceId
  )
  if (!roleSatisfies(callerRole, 'admin')) {
    return c.json({ error: 'admin role required to modify ACL' }, 403)
  }

  const body = await c.req.json<{ role?: string }>()
  const role = parseRole(body.role)
  if (!role) return c.json({ error: 'role must be viewer | editor | admin' }, 400)

  db.update(acls).set({ role }).where(eq(acls.id, grant.id)).run()
  broadcastResourceUpdated(grant.resourceType, grant.resourceId)
  const updated = db.select().from(acls).where(eq(acls.id, grant.id)).get()
  return c.json(updated)
})

// DELETE /api/acls/:grantId — revoke a grant.
app.delete('/:grantId', (c) => {
  const user = requireUser(c)
  const grant = db.select().from(acls).where(eq(acls.id, c.req.param('grantId'))).get()
  if (!grant) return c.json({ error: 'grant not found' }, 404)

  const callerRole = effectiveRole(
    user.id,
    grant.resourceType as ResourceType,
    grant.resourceId
  )
  if (!roleSatisfies(callerRole, 'admin')) {
    return c.json({ error: 'admin role required to revoke ACL' }, 403)
  }

  db.delete(acls).where(eq(acls.id, grant.id)).run()
  broadcastResourceUpdated(grant.resourceType, grant.resourceId)
  return c.json({ ok: true })
})

// PATCH /api/acls/visibility/:resourceType/:resourceId — flip
// visibility between 'tenant' and 'restricted'. Caller must be admin.
// Lives under the ACL umbrella since visibility + ACL together form one
// access concept.
app.patch('/visibility/:resourceType/:resourceId', async (c) => {
  const user = requireUser(c)
  const resourceType = parseResourceType(c.req.param('resourceType'))
  const resourceId = c.req.param('resourceId')
  if (!resourceType) return c.json({ error: 'invalid resourceType' }, 400)

  const callerRole = effectiveRole(user.id, resourceType, resourceId)
  if (!roleSatisfies(callerRole, 'admin')) {
    return c.json({ error: 'admin role required to change visibility' }, 403)
  }

  const body = await c.req.json<{ visibility?: string }>()
  const v: Visibility | null =
    body.visibility === 'tenant' || body.visibility === 'restricted'
      ? body.visibility
      : null
  if (!v) return c.json({ error: "visibility must be 'tenant' or 'restricted'" }, 400)

  if (resourceType === 'task') {
    db.update(tasks).set({ visibility: v }).where(eq(tasks.id, resourceId)).run()
  } else {
    db.update(projects).set({ visibility: v }).where(eq(projects.id, resourceId)).run()
  }
  broadcastResourceUpdated(resourceType, resourceId)
  return c.json({ resourceType, resourceId, visibility: v })
})

export default app
