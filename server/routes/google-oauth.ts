/**
 * Google OAuth Routes
 *
 * Handles OAuth2 authorization flow for Google accounts.
 * Supports both new account creation and re-authorization of existing accounts.
 */

import { Hono } from 'hono'
import { asc, eq } from 'drizzle-orm'
import { db, googleAccounts, users } from '../db'
import { googleCalendarManager } from '../services/google/google-calendar-manager'
import { getSettings } from '../lib/settings'
import {
  createOAuth2Client,
  generateAuthUrl,
  exchangeCodeForTokens,
  getAccountEmail,
} from '../services/google-oauth'
import { createLogger } from '../lib/logger'
import type { CurrentUserContext } from '../middleware/current-user'

const logger = createLogger('GoogleOAuth:Routes')

const app = new Hono<CurrentUserContext>()

/**
 * GET /api/google/oauth/authorize
 *
 * Generate Google OAuth authorization URL.
 * Query params:
 *   - accountName: Display name for new account (required for new accounts)
 *   - accountId: Existing account ID (for re-authorization)
 *   - origin: Browser's window.location.origin (used to build redirect URI)
 */
app.get('/authorize', (c) => {
  const accountName = c.req.query('accountName')
  const accountId = c.req.query('accountId')
  const clientOrigin = c.req.query('origin')

  logger.info('OAuth authorize request', {
    accountName,
    accountId,
    clientOrigin,
    hostHeader: c.req.header('host'),
    originHeader: c.req.header('origin'),
    refererHeader: c.req.header('referer'),
  })

  try {
    const client = createOAuth2Client()

    // Prefer explicit origin from the browser (immune to proxy rewrites)
    let baseUrl: string
    if (clientOrigin) {
      baseUrl = clientOrigin
    } else {
      const settings = getSettings()
      const host = c.req.header('host') ?? `localhost:${settings.server.port}`
      baseUrl = `http://${host}`
    }
    const redirectUri = `${baseUrl}/api/google/oauth/callback`

    // Encode state as JSON with account info + redirect URI for callback matching
    const state = JSON.stringify({
      accountId: accountId || null,
      accountName: accountName || 'Google Account',
      redirectUri,
    })

    logger.info('OAuth authorize: generating auth URL', {
      baseUrl,
      redirectUri,
      stateJson: state,
      clientId: client._clientId,
    })

    const authUrl = generateAuthUrl(client, redirectUri, state)

    // Parse the generated URL to verify redirect_uri
    try {
      const parsed = new URL(authUrl)
      logger.info('OAuth authorize: generated auth URL', {
        authUrl,
        redirect_uri_in_url: parsed.searchParams.get('redirect_uri'),
        client_id_in_url: parsed.searchParams.get('client_id'),
        scope_in_url: parsed.searchParams.get('scope'),
      })
    } catch {
      logger.info('OAuth authorize: generated auth URL (unparseable)', { authUrl })
    }

    return c.json({ authUrl })
  } catch (err) {
    logger.error('OAuth authorize failed', {
      error: err instanceof Error ? err.message : String(err),
    })
    return c.json(
      { error: err instanceof Error ? err.message : 'Failed to generate auth URL' },
      400
    )
  }
})

/**
 * GET /api/google/oauth/callback
 *
 * OAuth2 callback handler. Exchanges code for tokens, creates/updates account.
 * Returns auto-close HTML page.
 */
app.get('/callback', async (c) => {
  const code = c.req.query('code')
  const error = c.req.query('error')
  const stateParam = c.req.query('state')
  const fullUrl = c.req.url

  logger.info('OAuth callback received', {
    hasCode: !!code,
    codePrefix: code?.slice(0, 20) + '...',
    error,
    stateParam,
    fullUrl,
    hostHeader: c.req.header('host'),
    originHeader: c.req.header('origin'),
    refererHeader: c.req.header('referer'),
  })

  if (error) {
    logger.warn('OAuth callback: Google returned error', { error })
    return c.html(
      `<html><body><h2>Authorization Failed</h2><p>${error}</p><script>setTimeout(()=>window.close(),3000)</script></body></html>`
    )
  }

  if (!code) {
    logger.warn('OAuth callback: missing authorization code')
    return c.html(
      '<html><body><h2>Missing authorization code</h2><script>setTimeout(()=>window.close(),3000)</script></body></html>',
      400
    )
  }

  let state: { accountId: string | null; accountName: string; redirectUri?: string } = {
    accountId: null,
    accountName: 'Google Account',
  }
  try {
    if (stateParam) {
      state = JSON.parse(stateParam)
    }
  } catch {
    logger.warn('OAuth callback: failed to parse state param', { stateParam })
  }

  logger.info('OAuth callback: parsed state', {
    accountId: state.accountId,
    accountName: state.accountName,
    redirectUri: state.redirectUri,
  })

  try {
    // Use the redirect URI from state (set during authorize) to guarantee it matches
    const redirectUri = state.redirectUri
    if (!redirectUri) {
      throw new Error('Missing redirect URI in state — cannot match token exchange')
    }

    const client = createOAuth2Client()

    logger.info('OAuth callback: exchanging code for tokens', {
      redirectUri,
      clientId: client._clientId,
      codePrefix: code.slice(0, 20) + '...',
    })

    const tokens = await exchangeCodeForTokens(client, code, redirectUri)

    // Set credentials to fetch account email
    client.setCredentials({
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      expiry_date: tokens.expiry,
    })
    const email = await getAccountEmail(client)

    const now = new Date().toISOString()

    if (state.accountId) {
      // Re-authorization of existing account
      db.update(googleAccounts)
        .set({
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          tokenExpiry: tokens.expiry,
          scopes: tokens.scopes,
          email: email ?? undefined,
          needsReauth: false,
          lastCalendarSyncError: null,
          lastGmailSyncError: null,
          updatedAt: now,
        })
        .where(eq(googleAccounts.id, state.accountId))
        .run()

      logger.info('Re-authorized Google account', {
        accountId: state.accountId,
        email,
      })

      // Restart sync if calendar was enabled before re-auth
      const account = db.select().from(googleAccounts).where(eq(googleAccounts.id, state.accountId)).get()
      if (account?.calendarEnabled) {
        googleCalendarManager.startAccount(state.accountId).catch((err) => {
          logger.error('Failed to restart calendar sync after re-auth', {
            accountId: state.accountId,
            error: err instanceof Error ? err.message : String(err),
          })
        })
      }
    } else {
      // New account. D-6 PR 1: record the owning user so subsequent route
      // calls can scope visibility. `c.var.user` is set by the global
      // currentUser middleware from the CF Access header on this callback
      // (Google's redirect returns to the same hostname, so CF Access
      // gates it and rewrites the header). If somehow absent — e.g. local
      // dev without FULCRUM_DEV_USER_EMAIL — fall back to the tenant's
      // first user so the account isn't created orphaned, matching the
      // migration backfill behavior.
      const callerUserId =
        c.var.user?.id ??
        db.select({ id: users.id }).from(users).orderBy(asc(users.createdAt)).limit(1).get()?.id ??
        null

      const accountId = crypto.randomUUID()
      db.insert(googleAccounts)
        .values({
          id: accountId,
          name: state.accountName,
          email,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          tokenExpiry: tokens.expiry,
          scopes: tokens.scopes,
          calendarEnabled: false,
          gmailEnabled: false,
          syncIntervalMinutes: 15,
          ownerUserId: callerUserId,
          createdAt: now,
          updatedAt: now,
        })
        .run()

      logger.info('Created Google account', {
        accountId,
        name: state.accountName,
        email,
        ownerUserId: callerUserId,
      })
    }

    return c.html(
      '<html><body><h2>Authorization Successful</h2><p>You can close this window.</p><script>setTimeout(()=>window.close(),2000)</script></body></html>'
    )
  } catch (err) {
    logger.error('OAuth callback failed', {
      error: err instanceof Error ? err.message : String(err),
    })
    return c.html(
      `<html><body><h2>Authorization Failed</h2><p>${err instanceof Error ? err.message : String(err)}</p><script>setTimeout(()=>window.close(),5000)</script></body></html>`,
      500
    )
  }
})

export default app
