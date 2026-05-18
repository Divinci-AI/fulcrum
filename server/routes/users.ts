import { Hono } from 'hono'
import {
  getUserById,
  listUsers,
  updateUserProfile,
  setUserAdmin,
  createUserByAdmin,
  deleteUserByAdmin,
  DuplicateUserError,
  CannotDeleteSelfError,
  CannotDeleteLastAdminError,
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
import {
  listTokensForUser,
  mintToken,
  revokeToken,
} from '../services/api-token-service'
import { addEmailToPolicy, removeEmailFromPolicy } from '../services/cloudflare-access'
import { draftInviteEmail } from '../services/invite-email-service'
import { getPageContext } from '../services/page-context-service'
import { latestEventPerUser } from '../services/email-event-service'
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

// GET /api/users/me/page-context — D-9 Phase C. Returns the most
// recent page-context snapshot the user's browser has published over
// WebSocket. Null when the user has no active browser session in this
// process lifetime. Used by MCP tools to answer "what is the user
// looking at right now?" without round-tripping the browser.
app.get('/me/page-context', (c) => {
  const user = requireUser(c)
  return c.json({ context: getPageContext(user.id) })
})

// GET /api/users/me/tokens — D-8 PR 3a. List the calling user's API
// tokens. Returns view rows only — the plaintext is never persisted, so
// even the server can't return it.
app.get('/me/tokens', (c) => {
  const user = requireUser(c)
  return c.json({ tokens: listTokensForUser(user.id) })
})

// POST /api/users/me/tokens — mint a new token. The response includes a
// one-time `plaintext` field; the caller MUST store it immediately,
// because it cannot be recovered later. Body: { name, expiresAt? }.
app.post('/me/tokens', async (c) => {
  const user = requireUser(c)
  const body = await c.req.json<{ name?: string; expiresAt?: string | null }>()
  if (typeof body.name !== 'string' || body.name.trim() === '') {
    return c.json({ error: 'name (non-empty string) is required' }, 400)
  }
  try {
    const minted = mintToken(user.id, {
      name: body.name,
      expiresAt: body.expiresAt ?? null,
    })
    return c.json({ token: minted }, 201)
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : 'Mint failed' },
      400
    )
  }
})

// DELETE /api/users/me/tokens/:id — revoke a token. Only the owner can
// revoke; trying to revoke someone else's token 404s rather than 403
// to avoid leaking token-id existence.
app.delete('/me/tokens/:id', (c) => {
  const user = requireUser(c)
  const removed = revokeToken(user.id, c.req.param('id'))
  if (!removed) return c.json({ error: 'Token not found' }, 404)
  return c.json({ success: true })
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

// GET /api/users/email-delivery-status — D-11 PR 5. Returns the most
// recent email_send_event per user as a batch. Members UI uses this
// to show bounce/complaint badges. Admin-only because non-admins
// don't need the delivery audit trail.
app.get('/email-delivery-status', (c) => {
  requireAdminUser(c)
  return c.json({ statuses: latestEventPerUser() })
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
  let user
  try {
    user = createUserByAdmin(body.email, {
      isAdmin: body.isAdmin,
      displayName: body.displayName,
    })
  } catch (err) {
    if (err instanceof DuplicateUserError) {
      return c.json({ error: err.message }, 409)
    }
    return c.json(
      { error: err instanceof Error ? err.message : 'Invalid request' },
      400
    )
  }

  // D-8 PR 5: chain CF Access policy update. Soft-fails — the local row
  // exists regardless; the result is surfaced so the admin UI can flag
  // "manual CF step required" if the API call didn't land. When CF
  // Access isn't configured (skipped), we return ok: true to keep the
  // happy-path UX simple — the operator hasn't asked for CF chaining.
  const cf = await addEmailToPolicy(user.email)
  const cfAccess = cf.skipped
    ? { ok: true, configured: false }
    : { ok: cf.ok, configured: true, reason: cf.reason }

  // D-9 PR 2: optionally draft an invite email in the admin's Gmail.
  // Stays inside the "user-only outbound" policy — we never send to
  // a third party, just create a draft for the admin to review +
  // send manually. No-op when the admin has no Gmail-enabled Google
  // account; soft-fail (logged) on any draft API error.
  //
  // The tenant URL is derived from the request origin so the link in
  // the draft points at this exact tenant.
  const requestUrl = new URL(c.req.url)
  const tenantUrl = `${requestUrl.protocol}//${requestUrl.host}`
  const draft = await draftInviteEmail({
    inviterUserId: caller.id,
    inviteeEmail: user.email,
    tenantUrl,
    inviteeDisplayName: user.displayName,
  })

  return c.json(
    { user, invitedBy: caller.id, cfAccess, inviteEmail: draft },
    201
  )
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

// POST /api/users/:id/resend-invite — D-10 PR 6. Admin-only.
// Re-runs the Gmail invite draft for an existing user row (useful when
// the initial POST /api/users hit a soft-fail like "Google account
// needs re-authorization", or when an admin wants to remind an invitee
// who hasn't shown up yet). Creates a brand-new draft each call —
// Gmail's Drafts API doesn't deduplicate; the admin reviews + sends
// the most recent one.
//
// Returns: { user, inviteEmail: { drafted, draftId?, reason? } }
app.post('/:id/resend-invite', async (c) => {
  const caller = requireAdminUser(c)
  const target = getUserById(c.req.param('id'))
  if (!target) return c.json({ error: 'User not found' }, 404)

  const requestUrl = new URL(c.req.url)
  const tenantUrl = `${requestUrl.protocol}//${requestUrl.host}`
  const inviteEmail = await draftInviteEmail({
    inviterUserId: caller.id,
    inviteeEmail: target.email,
    tenantUrl,
    inviteeDisplayName: target.displayName,
  })
  return c.json({ user: target, inviteEmail })
})

// DELETE /api/users/:id — D-10 PR 6. Admin-only.
// Hard-deletes the user + their owned rows (tokens, channel
// identities, notification prefs, mentions). Channel_messages.user_id
// is null'd in place to preserve the audit trail without dangling
// references. Refuses to delete the caller themselves (409) or the
// last admin (409) — protections against locking the tenant out.
//
// CF Access cleanup: if the per-user policy is configured, removes
// the email from the policy's include list. Soft-failed: a CF error
// doesn't block the local delete.
//
// Returns: { success, cfAccess: { ok, configured, reason? }, cleanup }
app.delete('/:id', async (c) => {
  const caller = requireAdminUser(c)
  const target = getUserById(c.req.param('id'))
  if (!target) return c.json({ error: 'User not found' }, 404)

  // Try the CF Access cleanup first (best-effort). We do it before the
  // local delete so the email is still in our records if CF is slow.
  const cf = await removeEmailFromPolicy(target.email)
  const cfAccess = cf.skipped
    ? { ok: true, configured: false }
    : { ok: cf.ok, configured: true, reason: cf.reason }

  try {
    const cleanup = deleteUserByAdmin(caller.id, target.id)
    return c.json({ success: true, cfAccess, cleanup })
  } catch (err) {
    if (err instanceof CannotDeleteSelfError) {
      return c.json({ error: err.message }, 409)
    }
    if (err instanceof CannotDeleteLastAdminError) {
      return c.json({ error: err.message }, 409)
    }
    return c.json(
      { error: err instanceof Error ? err.message : 'Delete failed' },
      400
    )
  }
})

export default app
