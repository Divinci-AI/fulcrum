// @ts-nocheck — pre-existing type errors that surfaced when tsconfig.server.json was added in D-15 OG wrap-up. Remove this directive + fix the errors in a focused follow-up PR.
/**
 * Central Google OAuth2 Service
 *
 * Shared OAuth2 client management for Google Calendar and Gmail APIs.
 * All scopes are requested upfront so a single Google account covers
 * both Calendar and Gmail integration.
 */

import { google } from 'googleapis'
import type { OAuth2Client } from 'google-auth-library'
import { eq } from 'drizzle-orm'
import { db, googleAccounts } from '../db'
import { getSettings } from '../lib/settings'
import { createLogger } from '../lib/logger'

const logger = createLogger('GoogleOAuth')

/** All Google scopes requested upfront */
export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/userinfo.email',
]

/**
 * Create an OAuth2 client with the given credentials.
 * Reads client ID/secret from integrations settings if not provided.
 */
export function createOAuth2Client(
  clientId?: string,
  clientSecret?: string
): OAuth2Client {
  const settings = getSettings()
  const id = clientId || settings.integrations.googleClientId
  const secret = clientSecret || settings.integrations.googleClientSecret

  if (!id || !secret) {
    throw new Error(
      'Google OAuth not configured. Set integrations.googleClientId and integrations.googleClientSecret in settings.'
    )
  }

  logger.info('createOAuth2Client', {
    clientId: id,
    hasSecret: !!secret,
  })

  return new google.auth.OAuth2(id, secret)
}

/**
 * Generate the OAuth consent URL with all scopes.
 */
export function generateAuthUrl(
  client: OAuth2Client,
  redirectUri: string,
  state?: string
): string {
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: GOOGLE_SCOPES,
    redirect_uri: redirectUri,
    state: state || undefined,
  })
}

/**
 * Exchange an authorization code for tokens.
 */
export async function exchangeCodeForTokens(
  client: OAuth2Client,
  code: string,
  redirectUri: string
): Promise<{
  accessToken: string
  refreshToken: string
  expiry: number
  scopes: string[]
}> {
  logger.info('exchangeCodeForTokens: starting token exchange', {
    redirectUri,
    clientId: client._clientId,
    codePrefix: code.slice(0, 20) + '...',
  })

  let tokens
  try {
    const result = await client.getToken({ code, redirect_uri: redirectUri })
    tokens = result.tokens
    logger.info('exchangeCodeForTokens: token exchange succeeded', {
      hasAccessToken: !!tokens.access_token,
      hasRefreshToken: !!tokens.refresh_token,
      expiryDate: tokens.expiry_date,
      scope: tokens.scope,
    })
  } catch (err) {
    logger.error('exchangeCodeForTokens: token exchange FAILED', {
      error: err instanceof Error ? err.message : String(err),
      redirectUri,
      clientId: client._clientId,
      // Log the full error response if available
      response: (err as Record<string, unknown>)?.response?.data,
    })
    throw err
  }

  if (!tokens.access_token) {
    throw new Error('No access token received from Google')
  }
  if (!tokens.refresh_token) {
    throw new Error(
      'No refresh token received. Revoke app access at https://myaccount.google.com/permissions and try again.'
    )
  }

  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiry: tokens.expiry_date ?? Date.now() + 3600 * 1000,
    scopes: tokens.scope?.split(' ') ?? GOOGLE_SCOPES,
  }
}

/**
 * Get the Google account email using the userinfo API.
 */
export async function getAccountEmail(client: OAuth2Client): Promise<string | null> {
  try {
    const oauth2 = google.oauth2({ version: 'v2', auth: client })
    const { data } = await oauth2.userinfo.get()
    return data.email ?? null
  } catch (err) {
    logger.error('Failed to get Google account email', {
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

/**
 * Get an authenticated OAuth2Client for a Google account.
 * Auto-refreshes expired tokens and persists new tokens to DB.
 */
export async function getAuthenticatedClient(accountId: string): Promise<OAuth2Client> {
  const account = db
    .select()
    .from(googleAccounts)
    .where(eq(googleAccounts.id, accountId))
    .get()

  if (!account) {
    throw new Error(`Google account not found: ${accountId}`)
  }

  if (!account.accessToken || !account.refreshToken) {
    throw new Error(`Google account ${accountId} has no tokens. Complete OAuth flow first.`)
  }

  if (account.needsReauth) {
    throw new Error(
      `Google account "${account.name}" needs re-authorization. Reconnect the account in Settings.`
    )
  }

  const client = createOAuth2Client()
  client.setCredentials({
    access_token: account.accessToken,
    refresh_token: account.refreshToken,
    expiry_date: account.tokenExpiry ?? undefined,
  })

  // Auto-refresh if token is expired or about to expire (within 5 min)
  const now = Date.now()
  const expiry = account.tokenExpiry ?? 0
  if (expiry < now + 5 * 60 * 1000) {
    try {
      const { credentials } = await client.refreshAccessToken()
      client.setCredentials(credentials)

      // Persist refreshed tokens
      const updatedAt = new Date().toISOString()
      db.update(googleAccounts)
        .set({
          accessToken: credentials.access_token ?? account.accessToken,
          refreshToken: credentials.refresh_token ?? account.refreshToken,
          tokenExpiry: credentials.expiry_date ?? account.tokenExpiry,
          updatedAt,
        })
        .where(eq(googleAccounts.id, accountId))
        .run()

      logger.info('Refreshed Google OAuth tokens', { accountId })
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      logger.error('Failed to refresh Google OAuth tokens', {
        accountId,
        error: errorMsg,
      })

      // Detect permanent token revocation/expiry
      if (errorMsg.includes('invalid_grant')) {
        db.update(googleAccounts)
          .set({
            needsReauth: true,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(googleAccounts.id, accountId))
          .run()
        logger.warn('Marked Google account as needing re-authorization', { accountId })
      }

      throw new Error(`Failed to refresh Google tokens: ${errorMsg}`)
    }
  }

  return client
}