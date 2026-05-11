/**
 * Teams API (Phase D-5 PR 2).
 *
 * Teams are first-class principals for ACL grants. Each tenant has its
 * own (small) team list — there's no cross-tenant team concept because
 * each tenant runs in its own container.
 *
 * Routes mounted at /api/teams.
 */
import { Hono } from 'hono'
import { and, eq } from 'drizzle-orm'
import { db, teams, teamMembers, users, type Team, type TeamMember, type User } from '../db'
import type { CurrentUserContext } from '../middleware/current-user'
import { requireUser } from '../middleware/current-user'

const app = new Hono<CurrentUserContext>()

// GET /api/teams — list every team in the tenant.
app.get('/', (c) => {
  return c.json({ teams: db.select().from(teams).all() })
})

// POST /api/teams — create a team. Caller becomes its first admin
// member automatically so they can manage future members.
app.post('/', async (c) => {
  const user = requireUser(c)
  const body = await c.req.json<{ name?: string; description?: string | null }>()
  const name = (body.name ?? '').trim()
  if (!name) return c.json({ error: 'name is required' }, 400)

  const existing = db.select().from(teams).where(eq(teams.name, name)).get()
  if (existing) return c.json({ error: 'team name already in use' }, 409)

  const now = new Date().toISOString()
  const team: Team = {
    id: crypto.randomUUID(),
    name,
    description: body.description ?? null,
    createdAt: now,
    updatedAt: now,
  }
  db.insert(teams).values(team).run()

  // Creator → team admin.
  db.insert(teamMembers)
    .values({
      id: crypto.randomUUID(),
      teamId: team.id,
      userId: user.id,
      role: 'admin',
      joinedAt: now,
    })
    .run()

  return c.json(team, 201)
})

// GET /api/teams/:id — single team + its members joined with user rows.
app.get('/:id', (c) => {
  const id = c.req.param('id')
  const team = db.select().from(teams).where(eq(teams.id, id)).get()
  if (!team) return c.json({ error: 'team not found' }, 404)
  const memberRows = db
    .select({
      id: teamMembers.id,
      role: teamMembers.role,
      joinedAt: teamMembers.joinedAt,
      user: users,
    })
    .from(teamMembers)
    .innerJoin(users, eq(users.id, teamMembers.userId))
    .where(eq(teamMembers.teamId, id))
    .all()
  return c.json({ team, members: memberRows })
})

// PATCH /api/teams/:id — rename / change description. Caller must be a
// team admin.
app.patch('/:id', async (c) => {
  const user = requireUser(c)
  const id = c.req.param('id')
  const team = db.select().from(teams).where(eq(teams.id, id)).get()
  if (!team) return c.json({ error: 'team not found' }, 404)

  const me = db
    .select()
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, id), eq(teamMembers.userId, user.id)))
    .get()
  if (!me || me.role !== 'admin') {
    return c.json({ error: 'team admin required' }, 403)
  }

  const body = await c.req.json<{ name?: string; description?: string | null }>()
  const updates: Partial<Team> = { updatedAt: new Date().toISOString() }
  if (typeof body.name === 'string') {
    const trimmed = body.name.trim()
    if (!trimmed) return c.json({ error: 'name cannot be empty' }, 400)
    updates.name = trimmed
  }
  if ('description' in body) {
    updates.description = body.description ?? null
  }
  db.update(teams).set(updates).where(eq(teams.id, id)).run()
  const updated = db.select().from(teams).where(eq(teams.id, id)).get()
  return c.json(updated)
})

// DELETE /api/teams/:id — drop the team + its memberships. Caller must
// be a team admin. ACL grants that targeted this team become orphaned
// and effectively no-op (no team membership lookup will match).
app.delete('/:id', (c) => {
  const user = requireUser(c)
  const id = c.req.param('id')
  const team = db.select().from(teams).where(eq(teams.id, id)).get()
  if (!team) return c.json({ error: 'team not found' }, 404)

  const me = db
    .select()
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, id), eq(teamMembers.userId, user.id)))
    .get()
  if (!me || me.role !== 'admin') {
    return c.json({ error: 'team admin required' }, 403)
  }

  db.delete(teamMembers).where(eq(teamMembers.teamId, id)).run()
  db.delete(teams).where(eq(teams.id, id)).run()
  return c.json({ ok: true })
})

// POST /api/teams/:id/members — add a user (by id) to the team.
app.post('/:id/members', async (c) => {
  const user = requireUser(c)
  const id = c.req.param('id')
  const team = db.select().from(teams).where(eq(teams.id, id)).get()
  if (!team) return c.json({ error: 'team not found' }, 404)

  const me = db
    .select()
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, id), eq(teamMembers.userId, user.id)))
    .get()
  if (!me || me.role !== 'admin') {
    return c.json({ error: 'team admin required' }, 403)
  }

  const body = await c.req.json<{ userId?: string; role?: TeamMember['role'] }>()
  if (!body.userId) return c.json({ error: 'userId is required' }, 400)

  const targetUser: User | undefined = db
    .select()
    .from(users)
    .where(eq(users.id, body.userId))
    .get()
  if (!targetUser) return c.json({ error: 'user not found' }, 404)

  const dupe = db
    .select()
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, id), eq(teamMembers.userId, body.userId)))
    .get()
  if (dupe) return c.json({ error: 'user is already a member' }, 409)

  const role = body.role === 'admin' ? 'admin' : 'member'
  const member: TeamMember = {
    id: crypto.randomUUID(),
    teamId: id,
    userId: body.userId,
    role,
    joinedAt: new Date().toISOString(),
  }
  db.insert(teamMembers).values(member).run()
  return c.json(member, 201)
})

// DELETE /api/teams/:id/members/:userId — remove a user from the team.
app.delete('/:id/members/:userId', (c) => {
  const user = requireUser(c)
  const id = c.req.param('id')
  const userId = c.req.param('userId')

  const me = db
    .select()
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, id), eq(teamMembers.userId, user.id)))
    .get()
  if (!me || me.role !== 'admin') {
    return c.json({ error: 'team admin required' }, 403)
  }

  db.delete(teamMembers)
    .where(and(eq(teamMembers.teamId, id), eq(teamMembers.userId, userId)))
    .run()
  return c.json({ ok: true })
})

export default app
