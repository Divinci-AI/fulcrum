import { Hono } from 'hono'
import {
  getUserById,
  listUsers,
  updateUserProfile,
  setUserAdmin,
  createUserByAdmin,
  DuplicateUserError,
} from '../services/user-service'
import { listMentionsForUser } from '../services/mention-service'
import {
  getPreferencesForUser,
  upsertPreferencesForUser,
  toView,
  type PreferencePatch,
} from '../services/notification-preferences-service'
import {
  listMappingsForUser,
  upsertMapping,
  deleteMapping,
  isChannelType,
} from '../services/channel-identity-service'
import { requireAdminUser, requireUser, type CurrentUserContext } from '../middleware/current-user'

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

// GET /api/users/me/notifications — D-6 PR 4. Per-user notification
// preferences. Every field is nullable; null means "inherit the tenant
// default". The pushover user key is intentionally never returned — only
// `pushoverUserKeySet` indicates whether one is configured.
app.get('/me/notifications', (c) => {
  const user = c.var.user
  if (!user) return c.json({ error: 'Authentication required' }, 401)
  return c.json({ preferences: toView(getPreferencesForUser(user.id)) })
})

// PATCH /api/users/me/notifications — update one or more fields. Omitted
// fields are untouched. Pass `pushoverUserKey: ''` (empty string) or
// `null` to clear the stored pushover key.
app.patch('/me/notifications', async (c) => {
  const user = c.var.user
  if (!user) return c.json({ error: 'Authentication required' }, 401)
  const body = await c.req.json<PreferencePatch>()
  const row = upsertPreferencesForUser(user.id, body)
  return c.json({ preferences: toView(row) })
})

// GET /api/users/me/channel-identities — D-7 PR 3. Per-user channel
// native identities (Slack user_id, Discord snowflake, Telegram chat_id,
// WhatsApp phone JID). Storage + self-service surface; per-channel
// dispatcher routing is wired in follow-up PRs.
app.get('/me/channel-identities', (c) => {
  const user = requireUser(c)
  const mappings = listMappingsForUser(user.id).map((m) => ({
    channelType: m.channelType,
    channelUserId: m.channelUserId,
    updatedAt: m.updatedAt,
  }))
  return c.json({ mappings })
})

// PATCH /api/users/me/channel-identities/:channelType — upsert one
// mapping. Body: { channelUserId: string }.
app.patch('/me/channel-identities/:channelType', async (c) => {
  const user = requireUser(c)
  const channelType = c.req.param('channelType')
  if (!isChannelType(channelType)) {
    return c.json({ error: `Unknown channel type: ${channelType}` }, 400)
  }
  const body = await c.req.json<{ channelUserId?: string }>()
  if (typeof body.channelUserId !== 'string' || body.channelUserId.trim() === '') {
    return c.json({ error: 'channelUserId (non-empty string) is required' }, 400)
  }
  try {
    const row = upsertMapping(user.id, channelType, body.channelUserId)
    return c.json({
      mapping: {
        channelType: row.channelType,
        channelUserId: row.channelUserId,
        updatedAt: row.updatedAt,
      },
    })
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Upsert failed' }, 400)
  }
})

// DELETE /api/users/me/channel-identities/:channelType — clear a mapping.
app.delete('/me/channel-identities/:channelType', (c) => {
  const user = requireUser(c)
  const channelType = c.req.param('channelType')
  if (!isChannelType(channelType)) {
    return c.json({ error: `Unknown channel type: ${channelType}` }, 400)
  }
  const removed = deleteMapping(user.id, channelType)
  if (!removed) return c.json({ error: 'Mapping not found' }, 404)
  return c.json({ success: true })
})

// GET /api/users — list every user who has ever signed into this Fulcrum
// instance. Used by mention autocomplete and assignee pickers. Org-scoped
// in our SaaS shape because each tenant gets its own container/DB.
app.get('/', (c) => {
  return c.json({ users: listUsers() })
})

// POST /api/users — D-8 PR 1. Admin-invoked pre-provisioning. Creates a
// user row before the invitee's first authenticated request so they show
// up in mention/assignee pickers immediately.
//
// Body: { email: string, isAdmin?: boolean, displayName?: string | null }
// Returns: 201 { user, invitedBy } | 400 invalid email | 403 non-admin |
// 409 already exists.
//
// CF Access edge admission is still a separate gate — this only stamps
// the Fulcrum-side identity. A pre-provisioned user can't reach the
// container until their email also clears CF Access. D-8 PR 5 closes
// that gap by chaining a Cloudflare Access policy update.
app.post('/', async (c) => {
  const caller = requireAdminUser(c)
  const body = await c.req.json<{
    email?: string
    isAdmin?: boolean
    displayName?: string | null
  }>()
  if (typeof body.email !== 'string') {
    return c.json({ error: 'email (string) is required' }, 400)
  }
  try {
    const user = createUserByAdmin(body.email, {
      isAdmin: body.isAdmin,
      displayName: body.displayName,
    })
    return c.json({ user, invitedBy: caller.id }, 201)
  } catch (err) {
    if (err instanceof DuplicateUserError) {
      return c.json({ error: err.message }, 409)
    }
    return c.json(
      { error: err instanceof Error ? err.message : 'Invalid request' },
      400
    )
  }
})

// GET /api/users/:id — single user lookup. 404 if unknown.
app.get('/:id', (c) => {
  const user = getUserById(c.req.param('id'))
  if (!user) {
    return c.json({ error: 'User not found' }, 404)
  }
  return c.json(user)
})

// PATCH /api/users/:id/admin — D-7 PR 2. Tenant-admin only. Promote or
// demote another user. Body: { isAdmin: boolean }. A tenant admin can
// demote themselves; the migration backfill ensures the earliest user is
// always seeded as admin, but there is intentionally no "last admin"
// guardrail (operators who lock themselves out can fix it via SQL).
app.patch('/:id/admin', async (c) => {
  const caller = requireAdminUser(c)
  const targetId = c.req.param('id')
  const target = getUserById(targetId)
  if (!target) return c.json({ error: 'User not found' }, 404)
  const body = await c.req.json<{ isAdmin?: boolean }>()
  if (typeof body.isAdmin !== 'boolean') {
    return c.json({ error: 'isAdmin (boolean) is required' }, 400)
  }
  const updated = setUserAdmin(targetId, body.isAdmin)
  return c.json({ user: updated, grantedBy: caller.id })
})

export default app
