import { Hono } from 'hono'
import { getUserById, listUsers, updateUserProfile } from '../services/user-service'
import { listMentionsForUser } from '../services/mention-service'
import type { CurrentUserContext } from '../middleware/current-user'

const app = new Hono<CurrentUserContext>()

// GET /api/users/me — the request's current user, or null when no identity
// could be derived (no CF Access header and no FULCRUM_DEV_USER_EMAIL).
app.get('/me', (c) => {
  const user = c.var.user
  return c.json({ user })
})

// GET /api/users/me/mentions — every place the current user has been
// `@email`-mentioned (Phase D-3). 401 when there's no current user.
app.get('/me/mentions', (c) => {
  const user = c.var.user
  if (!user) return c.json({ error: 'Authentication required' }, 401)
  return c.json({ mentions: listMentionsForUser(user.id) })
})

// PATCH /api/users/me — update the current user's profile fields
// (displayName, avatarUrl). 401 when there's no current user. Returns the
// updated user. Empty string for a field clears it.
app.patch('/me', async (c) => {
  const user = c.var.user
  if (!user) return c.json({ error: 'Authentication required' }, 401)
  const body = await c.req.json<{ displayName?: string | null; avatarUrl?: string | null }>()
  const updated = updateUserProfile(user.id, body)
  return c.json({ user: updated })
})

// GET /api/users — list every user who has ever signed into this Fulcrum
// instance. Used by mention autocomplete and assignee pickers. Org-scoped
// in our SaaS shape because each tenant gets its own container/DB.
app.get('/', (c) => {
  return c.json({ users: listUsers() })
})

// GET /api/users/:id — single user lookup. 404 if unknown.
app.get('/:id', (c) => {
  const user = getUserById(c.req.param('id'))
  if (!user) {
    return c.json({ error: 'User not found' }, 404)
  }
  return c.json(user)
})

export default app
