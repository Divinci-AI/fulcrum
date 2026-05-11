/**
 * CalDAV API Routes
 *
 * Provides REST endpoints for CalDAV calendar integration:
 * multi-account management, calendar listing, event CRUD, and copy rules.
 */

import { Hono } from 'hono'
import { fetchOauthTokens } from 'tsdav'
import {
  getCaldavStatus,
  testCaldavConnection,
  configureCaldav,
  configureGoogleOAuth,
  completeGoogleOAuth,
  enableCaldav,
  disableCaldav,
  listCalendars,
  syncCalendars,
  listEvents,
  getEvent,
  createEvent,
  updateEvent,
  deleteEvent,
  // Account CRUD
  listAccounts,
  getAccount,
  createAccount,
  updateAccount,
  deleteAccount,
  enableAccount,
  disableAccount,
  testAccountConnection,
  syncAccount,
  completeAccountGoogleOAuth,
  // Copy rules
  listCopyRules,
  createCopyRule,
  updateCopyRule,
  deleteCopyRule,
  executeCopyRule,
} from '../services/caldav'
import { getSettings } from '../lib/settings'
import { createLogger } from '../lib/logger'
import { getUserTimezone, toUserTimezone, fromUserTimezone } from '../services/caldav/timezone'
import { db, caldavCalendars, type CaldavEvent } from '../db'
import { isNotNull } from 'drizzle-orm'
import { googleCalendarManager } from '../services/google/google-calendar-manager'

// Google OAuth constants
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GOOGLE_CALDAV_SCOPE = 'https://www.googleapis.com/auth/calendar'

const logger = createLogger('CalDAV:Routes')
const caldavRoutes = new Hono()

/** Convert event dates from UTC (DB) to user's configured timezone. */
function localizeEvent(event: CaldavEvent, tz: string): CaldavEvent & { timezone: string } {
  return {
    ...event,
    dtstart: event.dtstart ? toUserTimezone(event.dtstart, tz) : null,
    dtend: event.dtend ? toUserTimezone(event.dtend, tz) : null,
    timezone: tz,
  }
}

// ==========================================
// Account endpoints
// ==========================================

// GET /api/caldav/accounts
caldavRoutes.get('/accounts', (c) => {
  const accounts = listAccounts()
  // Don't expose sensitive fields
  return c.json(
    accounts.map((a) => ({
      ...a,
      password: a.password ? '***' : null,
      googleClientSecret: a.googleClientSecret ? '***' : null,
      oauthTokens: a.oauthTokens ? { hasTokens: true } : null,
    }))
  )
})

// POST /api/caldav/accounts - Create basic auth account
caldavRoutes.post('/accounts', async (c) => {
  const body = await c.req.json<{
    name: string
    serverUrl: string
    username: string
    password: string
    syncIntervalMinutes?: number
  }>()

  if (!body.name || !body.serverUrl || !body.username || !body.password) {
    return c.json({ error: 'name, serverUrl, username, and password are required' }, 400)
  }

  try {
    const account = await createAccount({
      name: body.name,
      serverUrl: body.serverUrl,
      authType: 'basic',
      username: body.username,
      password: body.password,
      syncIntervalMinutes: body.syncIntervalMinutes,
    })
    return c.json(account, 201)
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Failed to create account' }, 500)
  }
})

// POST /api/caldav/accounts/google - Create Google OAuth account
caldavRoutes.post('/accounts/google', async (c) => {
  const body = await c.req.json<{
    name?: string
    googleClientId: string
    googleClientSecret: string
    syncIntervalMinutes?: number
  }>()

  if (!body.googleClientId || !body.googleClientSecret) {
    return c.json({ error: 'googleClientId and googleClientSecret are required' }, 400)
  }

  try {
    const accountId = await configureGoogleOAuth({
      name: body.name,
      googleClientId: body.googleClientId,
      googleClientSecret: body.googleClientSecret,
      syncIntervalMinutes: body.syncIntervalMinutes,
    })
    const account = getAccount(accountId)
    return c.json(account, 201)
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Failed to create account' }, 500)
  }
})

// PATCH /api/caldav/accounts/:id
caldavRoutes.patch('/accounts/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json<{
    name?: string
    serverUrl?: string
    username?: string
    password?: string
    googleClientId?: string
    googleClientSecret?: string
    syncIntervalMinutes?: number
  }>()

  try {
    const account = await updateAccount(id, body)
    return c.json(account)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to update account'
    return c.json({ error: msg }, msg.includes('not found') ? 404 : 500)
  }
})

// DELETE /api/caldav/accounts/:id
caldavRoutes.delete('/accounts/:id', async (c) => {
  const id = c.req.param('id')
  try {
    await deleteAccount(id)
    return c.json({ success: true })
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Failed to delete account' }, 500)
  }
})

// POST /api/caldav/accounts/:id/test
caldavRoutes.post('/accounts/:id/test', async (c) => {
  const id = c.req.param('id')
  const account = getAccount(id)
  if (!account) return c.json({ error: 'Account not found' }, 404)

  if (account.authType !== 'basic' || !account.username || !account.password) {
    return c.json({ error: 'Test connection only supported for basic auth accounts' }, 400)
  }

  const result = await testAccountConnection({
    serverUrl: account.serverUrl,
    username: account.username,
    password: account.password,
  })
  return c.json(result)
})

// POST /api/caldav/accounts/:id/sync
caldavRoutes.post('/accounts/:id/sync', async (c) => {
  const id = c.req.param('id')
  try {
    await syncAccount(id)
    return c.json({ success: true })
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Sync failed' }, 500)
  }
})

// POST /api/caldav/accounts/:id/enable
caldavRoutes.post('/accounts/:id/enable', async (c) => {
  const id = c.req.param('id')
  try {
    await enableAccount(id)
    return c.json({ success: true })
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Failed to enable account' }, 500)
  }
})

// POST /api/caldav/accounts/:id/disable
caldavRoutes.post('/accounts/:id/disable', async (c) => {
  const id = c.req.param('id')
  try {
    await disableAccount(id)
    return c.json({ success: true })
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Failed to disable account' }, 500)
  }
})

// GET /api/caldav/accounts/:id/oauth/authorize
caldavRoutes.get('/accounts/:id/oauth/authorize', (c) => {
  const id = c.req.param('id')
  const account = getAccount(id)
  if (!account) return c.json({ error: 'Account not found' }, 404)

  if (!account.googleClientId) {
    return c.json({ error: 'Google Client ID not configured for this account' }, 400)
  }

  const settings = getSettings()
  const host = c.req.header('host') ?? `localhost:${settings.server.port}`
  const redirectUri = `http://${host}/api/caldav/oauth/callback`

  const params = new URLSearchParams({
    client_id: account.googleClientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GOOGLE_CALDAV_SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    state: id, // Encode accountId in state param
  })

  const authUrl = `${GOOGLE_AUTH_URL}?${params.toString()}`
  return c.json({ authUrl })
})

// ==========================================
// Copy rule endpoints
// ==========================================

// GET /api/caldav/copy-rules
caldavRoutes.get('/copy-rules', (c) => {
  const rules = listCopyRules()
  return c.json(rules)
})

// POST /api/caldav/copy-rules
caldavRoutes.post('/copy-rules', async (c) => {
  const body = await c.req.json<{
    name?: string
    sourceCalendarId: string
    destCalendarId: string
  }>()

  if (!body.sourceCalendarId || !body.destCalendarId) {
    return c.json({ error: 'sourceCalendarId and destCalendarId are required' }, 400)
  }

  if (body.sourceCalendarId === body.destCalendarId) {
    return c.json({ error: 'Source and destination calendars must be different' }, 400)
  }

  try {
    const rule = createCopyRule(body)
    return c.json(rule, 201)
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Failed to create copy rule' }, 500)
  }
})

// PATCH /api/caldav/copy-rules/:id
caldavRoutes.patch('/copy-rules/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json<{ name?: string; enabled?: boolean }>()

  try {
    const rule = updateCopyRule(id, body)
    return c.json(rule)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to update copy rule'
    return c.json({ error: msg }, msg.includes('not found') ? 404 : 500)
  }
})

// DELETE /api/caldav/copy-rules/:id
caldavRoutes.delete('/copy-rules/:id', async (c) => {
  const id = c.req.param('id')
  try {
    deleteCopyRule(id)
    return c.json({ success: true })
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Failed to delete copy rule' }, 500)
  }
})

// POST /api/caldav/copy-rules/:id/execute
caldavRoutes.post('/copy-rules/:id/execute', async (c) => {
  const id = c.req.param('id')
  try {
    const result = await executeCopyRule(id)
    return c.json(result)
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Failed to execute copy rule' }, 500)
  }
})

// ==========================================
// Backward-compatible endpoints
// ==========================================

// GET /api/caldav/status
caldavRoutes.get('/status', (c) => {
  const status = getCaldavStatus()
  return c.json(status)
})

// POST /api/caldav/test
caldavRoutes.post('/test', async (c) => {
  const { serverUrl, username, password } = await c.req.json<{
    serverUrl: string
    username: string
    password: string
  }>()

  if (!serverUrl || !username || !password) {
    return c.json({ error: 'serverUrl, username, and password are required' }, 400)
  }

  const result = await testCaldavConnection({ serverUrl, username, password })
  return c.json(result)
})

// POST /api/caldav/configure
caldavRoutes.post('/configure', async (c) => {
  const body = await c.req.json<{
    serverUrl: string
    username: string
    password: string
    syncIntervalMinutes?: number
  }>()

  if (!body.serverUrl || !body.username || !body.password) {
    return c.json({ error: 'serverUrl, username, and password are required' }, 400)
  }

  try {
    await configureCaldav(body)
    return c.json({ success: true })
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : 'Configuration failed' },
      500
    )
  }
})

// POST /api/caldav/enable
caldavRoutes.post('/enable', async (c) => {
  try {
    await enableCaldav()
    return c.json({ success: true })
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : 'Failed to enable CalDAV' },
      500
    )
  }
})

// POST /api/caldav/disable
caldavRoutes.post('/disable', async (c) => {
  try {
    await disableCaldav()
    return c.json({ success: true })
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : 'Failed to disable CalDAV' },
      500
    )
  }
})

// POST /api/caldav/configure-google — Save Google Client ID + Secret
caldavRoutes.post('/configure-google', async (c) => {
  const { googleClientId, googleClientSecret, syncIntervalMinutes } = await c.req.json<{
    googleClientId: string
    googleClientSecret: string
    syncIntervalMinutes?: number
  }>()

  if (!googleClientId || !googleClientSecret) {
    return c.json({ error: 'googleClientId and googleClientSecret are required' }, 400)
  }

  try {
    const accountId = await configureGoogleOAuth({ googleClientId, googleClientSecret, syncIntervalMinutes })
    return c.json({ success: true, accountId })
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : 'Configuration failed' },
      500
    )
  }
})

// GET /api/caldav/oauth/authorize — Build Google authorization URL
caldavRoutes.get('/oauth/authorize', (c) => {
  const settings = getSettings()
  const { googleClientId } = settings.caldav

  // Check if we have an account with Google credentials
  const accounts = listAccounts()
  const googleAccount = accounts.find(
    (a) => a.authType === 'google-oauth' && a.googleClientId
  )

  const clientId = googleAccount?.googleClientId ?? googleClientId
  const accountId = googleAccount?.id

  if (!clientId) {
    return c.json({ error: 'Google Client ID not configured. Call /configure-google first.' }, 400)
  }

  const host = c.req.header('host') ?? `localhost:${settings.server.port}`
  const redirectUri = `http://${host}/api/caldav/oauth/callback`

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GOOGLE_CALDAV_SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    ...(accountId ? { state: accountId } : {}),
  })

  const authUrl = `${GOOGLE_AUTH_URL}?${params.toString()}`
  return c.json({ authUrl })
})

// GET /api/caldav/oauth/callback — Receive auth code from Google redirect
caldavRoutes.get('/oauth/callback', async (c) => {
  const code = c.req.query('code')
  const error = c.req.query('error')
  const accountId = c.req.query('state') // Account ID encoded in state param

  if (error) {
    return c.html(`<html><body><h2>Authorization Failed</h2><p>${error}</p><script>setTimeout(()=>window.close(),3000)</script></body></html>`)
  }

  if (!code) {
    return c.html('<html><body><h2>Missing authorization code</h2><script>setTimeout(()=>window.close(),3000)</script></body></html>', 400)
  }

  // Determine which account's credentials to use
  let googleClientId: string | undefined
  let googleClientSecret: string | undefined

  if (accountId) {
    const account = getAccount(accountId)
    if (account) {
      googleClientId = account.googleClientId ?? undefined
      googleClientSecret = account.googleClientSecret ?? undefined
    }
  }

  if (!googleClientId || !googleClientSecret) {
    // Fallback chain: legacy caldav.* config first (back-compat), then the
    // primary integrations.* values. The latter respects the GOOGLE_CLIENT_ID
    // / GOOGLE_CLIENT_SECRET env vars, so hosted Fulcrum deployments
    // automatically reuse the operator-provided OAuth client for CalDAV.
    const settings = getSettings()
    googleClientId = googleClientId ?? (settings.caldav.googleClientId || undefined) ?? (settings.integrations.googleClientId || undefined)
    googleClientSecret = googleClientSecret ?? (settings.caldav.googleClientSecret || undefined) ?? (settings.integrations.googleClientSecret || undefined)
  }

  if (!googleClientId || !googleClientSecret) {
    return c.html('<html><body><h2>Google OAuth not configured</h2><script>setTimeout(()=>window.close(),3000)</script></body></html>', 400)
  }

  const settings = getSettings()
  const host = c.req.header('host') ?? `localhost:${settings.server.port}`
  const redirectUri = `http://${host}/api/caldav/oauth/callback`

  try {
    const tokens = await fetchOauthTokens({
      clientId: googleClientId,
      clientSecret: googleClientSecret,
      authorizationCode: code,
      redirectUrl: redirectUri,
      tokenUrl: GOOGLE_TOKEN_URL,
    })

    if (!tokens.access_token || !tokens.refresh_token) {
      return c.html('<html><body><h2>Failed to obtain tokens</h2><p>Missing access or refresh token. Try again with prompt=consent.</p><script>setTimeout(()=>window.close(),5000)</script></body></html>', 500)
    }

    if (accountId) {
      await completeAccountGoogleOAuth(accountId, {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresIn: tokens.expires_in ?? 3600,
      })
    } else {
      await completeGoogleOAuth({
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresIn: tokens.expires_in ?? 3600,
      })
    }

    return c.html(`<html>
<body style="font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0a0a0a;color:#fff">
<div style="text-align:center">
<h2 style="color:#22c55e">Connected to Google Calendar!</h2>
<p style="color:#a1a1aa">You can close this tab.</p>
<script>setTimeout(()=>window.close(),2000)</script>
</div>
</body>
</html>`)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Token exchange failed'
    return c.html(`<html><body style="font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0a0a0a;color:#fff"><div style="text-align:center"><h2 style="color:#ef4444">Connection Failed</h2><p style="color:#a1a1aa">${message}</p><script>setTimeout(()=>window.close(),5000)</script></div></body></html>`, 500)
  }
})

// POST /api/caldav/sync
caldavRoutes.post('/sync', async (c) => {
  try {
    await syncCalendars()
    return c.json({ success: true })
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : 'Sync failed' },
      500
    )
  }
})

// GET /api/caldav/calendars
caldavRoutes.get('/calendars', (c) => {
  const accountId = c.req.query('accountId')
  const calendars = listCalendars(accountId ?? undefined)
  return c.json(calendars)
})

// GET /api/caldav/events
caldavRoutes.get('/events', async (c) => {
  const calendarId = c.req.query('calendarId')
  const from = c.req.query('from')
  const to = c.req.query('to')
  const source = c.req.query('source')
  const limitStr = c.req.query('limit')
  const limit = limitStr ? parseInt(limitStr, 10) : undefined
  const tz = getUserTimezone()

  // Convert user-local from/to to UTC for DB query
  const utcFrom = from ? fromUserTimezone(from, tz) : undefined
  const utcTo = to ? fromUserTimezone(to, tz) : undefined

  if (source === 'live' && from && to) {
    // Get non-Google events from local DB
    const allDbEvents = listEvents({ calendarId: calendarId ?? undefined, from: utcFrom, to: utcTo, limit })

    // Find Google-backed calendar IDs to exclude from DB results
    const googleCalendars = db
      .select()
      .from(caldavCalendars)
      .where(isNotNull(caldavCalendars.googleAccountId))
      .all()
    const googleCalendarIds = new Set(googleCalendars.map((c) => c.id))
    const nonGoogleEvents = allDbEvents.filter((e) => !googleCalendarIds.has(e.calendarId))

    // Fetch Google events live, grouped by account
    const accountIds = [...new Set(googleCalendars.map((c) => c.googleAccountId!).filter(Boolean))]
    const liveEvents: CaldavEvent[] = []

    for (const accountId of accountIds) {
      try {
        const events = await googleCalendarManager.fetchEventsLive(accountId, utcFrom!, utcTo!)
        liveEvents.push(...(events as CaldavEvent[]))
      } catch (err) {
        // Fall back to DB events for this account on error
        logger.error('Live Google Calendar fetch failed, falling back to DB', {
          accountId,
          error: err instanceof Error ? err.message : String(err),
        })
        const fallbackEvents = allDbEvents.filter(
          (e) => googleCalendarIds.has(e.calendarId) &&
            googleCalendars.find((c) => c.id === e.calendarId)?.googleAccountId === accountId
        )
        liveEvents.push(...fallbackEvents)
      }
    }

    const merged = [...nonGoogleEvents, ...liveEvents]
    return c.json(merged.map((e) => localizeEvent(e, tz)))
  }

  const events = listEvents({ calendarId: calendarId ?? undefined, from: utcFrom, to: utcTo, limit })
  return c.json(events.map(e => localizeEvent(e, tz)))
})

// GET /api/caldav/events/:id
caldavRoutes.get('/events/:id', (c) => {
  const event = getEvent(c.req.param('id'))
  if (!event) {
    return c.json({ error: 'Event not found' }, 404)
  }
  return c.json(localizeEvent(event, getUserTimezone()))
})

// POST /api/caldav/events
caldavRoutes.post('/events', async (c) => {
  const body = await c.req.json<{
    calendarId: string
    summary: string
    dtstart: string
    dtend?: string
    duration?: string
    description?: string
    location?: string
    allDay?: boolean
    recurrenceRule?: string
    status?: string
  }>()

  if (!body.calendarId || !body.summary || !body.dtstart) {
    return c.json({ error: 'calendarId, summary, and dtstart are required' }, 400)
  }

  // Convert user-local dates to UTC for storage
  const tz = getUserTimezone()
  const utcBody = {
    ...body,
    dtstart: fromUserTimezone(body.dtstart, tz),
    dtend: body.dtend ? fromUserTimezone(body.dtend, tz) : undefined,
  }

  try {
    const event = await createEvent(utcBody)
    return c.json(localizeEvent(event, tz), 201)
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : 'Failed to create event' },
      500
    )
  }
})

// PATCH /api/caldav/events/:id
caldavRoutes.patch('/events/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json<{
    summary?: string
    dtstart?: string
    dtend?: string
    duration?: string
    description?: string
    location?: string
    allDay?: boolean
    recurrenceRule?: string
    status?: string
  }>()

  // Convert user-local dates to UTC for storage
  const tz = getUserTimezone()
  const utcBody = {
    ...body,
    dtstart: body.dtstart ? fromUserTimezone(body.dtstart, tz) : undefined,
    dtend: body.dtend ? fromUserTimezone(body.dtend, tz) : undefined,
  }

  try {
    const event = await updateEvent(id, utcBody)
    return c.json(localizeEvent(event, tz))
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to update event'
    if (message.includes('not found')) {
      return c.json({ error: message }, 404)
    }
    return c.json({ error: message }, 500)
  }
})

// DELETE /api/caldav/events/:id
caldavRoutes.delete('/events/:id', async (c) => {
  const id = c.req.param('id')

  try {
    await deleteEvent(id)
    return c.json({ success: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to delete event'
    if (message.includes('not found')) {
      return c.json({ error: message }, 404)
    }
    return c.json({ error: message }, 500)
  }
})

export default caldavRoutes
