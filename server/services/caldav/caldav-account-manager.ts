// @ts-nocheck — pre-existing type errors that surfaced when tsconfig.server.json was added in D-15 OG wrap-up. Remove this directive + fix the errors in a focused follow-up PR.
/**
 * CalDAV Account Manager
 *
 * Manages multiple DAVClient instances (one per account) with independent
 * sync intervals, connection tracking, and retry logic.
 */

import { DAVClient, getOauthHeaders } from 'tsdav'
import { eq } from 'drizzle-orm'
import { db, caldavAccounts, caldavCalendars } from '../../db'
import type { CaldavAccount } from '../../db'
import type { CalDavOAuthTokens } from '../../lib/settings/types'
import { createLogger } from '../../lib/logger'

const logger = createLogger('CalDAV:AccountManager')

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const MAX_RETRY_DELAY = 5 * 60 * 1000 // 5 minutes

export interface AccountConnection {
  accountId: string
  client: DAVClient | null
  syncInterval: ReturnType<typeof setInterval> | null
  isSyncing: boolean
  lastSyncError: string | null
  retryCount: number
}

export interface AccountStatus {
  id: string
  name: string
  connected: boolean
  syncing: boolean
  lastError: string | null
  calendarCount: number
  enabled: boolean
  lastSyncedAt: string | null
}

class CaldavAccountManager {
  private connections = new Map<string, AccountConnection>()

  getClient(accountId: string): DAVClient | null {
    return this.connections.get(accountId)?.client ?? null
  }

  getConnection(accountId: string): AccountConnection | undefined {
    return this.connections.get(accountId)
  }

  async startAll(): Promise<void> {
    const accounts = db.select().from(caldavAccounts).where(eq(caldavAccounts.enabled, true)).all()
    logger.info('Starting all CalDAV accounts', { count: accounts.length })

    for (const account of accounts) {
      await this.startAccount(account.id).catch((err) => {
        logger.error('Failed to start account', {
          accountId: account.id,
          name: account.name,
          error: err instanceof Error ? err.message : String(err),
        })
      })
    }
  }

  stopAll(): void {
    for (const [accountId] of this.connections) {
      this.stopAccount(accountId)
    }
    this.connections.clear()
    logger.info('All CalDAV accounts stopped')
  }

  async startAccount(accountId: string): Promise<void> {
    const account = db.select().from(caldavAccounts).where(eq(caldavAccounts.id, accountId)).get()
    if (!account) {
      throw new Error(`Account not found: ${accountId}`)
    }
    if (!account.enabled) {
      logger.info('Account is disabled, skipping', { accountId, name: account.name })
      return
    }

    // Stop existing connection if any
    this.stopAccount(accountId)

    const conn: AccountConnection = {
      accountId,
      client: null,
      syncInterval: null,
      isSyncing: false,
      lastSyncError: null,
      retryCount: 0,
    }
    this.connections.set(accountId, conn)

    try {
      conn.client = await this.connect(account)
      this.scheduleSync(accountId, account.syncIntervalMinutes ?? 15)
      logger.info('Started CalDAV account', { accountId, name: account.name })
    } catch (err) {
      conn.lastSyncError = err instanceof Error ? err.message : String(err)
      this.updateAccountError(accountId, conn.lastSyncError)
      logger.error('Failed to connect account', { accountId, error: conn.lastSyncError })
      this.scheduleRetry(accountId)
    }
  }

  stopAccount(accountId: string): void {
    const conn = this.connections.get(accountId)
    if (!conn) return

    if (conn.syncInterval) {
      clearInterval(conn.syncInterval)
      conn.syncInterval = null
    }
    conn.client = null
    conn.isSyncing = false
    this.connections.delete(accountId)
  }

  async syncAccount(accountId: string): Promise<void> {
    const conn = this.connections.get(accountId)
    if (!conn?.client) {
      throw new Error(`Account not connected: ${accountId}`)
    }
    if (conn.isSyncing) return

    conn.isSyncing = true
    try {
      await this.syncAllCalendarsForAccount(accountId, conn.client)
      conn.lastSyncError = null
      conn.retryCount = 0
      this.updateAccountSyncTime(accountId)
    } catch (err) {
      conn.lastSyncError = err instanceof Error ? err.message : String(err)
      this.updateAccountError(accountId, conn.lastSyncError)
      throw err
    } finally {
      conn.isSyncing = false
    }
  }

  async syncAll(): Promise<void> {
    const promises: Promise<void>[] = []
    for (const [accountId, conn] of this.connections) {
      if (conn.client && !conn.isSyncing) {
        promises.push(
          this.syncAccount(accountId).catch((err) => {
            logger.error('Sync failed for account', {
              accountId,
              error: err instanceof Error ? err.message : String(err),
            })
          })
        )
      }
    }
    await Promise.all(promises)
  }

  getStatus(): AccountStatus[] {
    const accounts = db.select().from(caldavAccounts).all()
    return accounts.map((account) => {
      const conn = this.connections.get(account.id)
      const calendarCount = db
        .select()
        .from(caldavCalendars)
        .where(eq(caldavCalendars.accountId, account.id))
        .all().length
      return {
        id: account.id,
        name: account.name,
        connected: conn?.client !== null && conn?.client !== undefined,
        syncing: conn?.isSyncing ?? false,
        lastError: conn?.lastSyncError ?? account.lastSyncError,
        calendarCount,
        enabled: account.enabled ?? true,
        lastSyncedAt: account.lastSyncedAt,
      }
    })
  }

  getAccountStatus(accountId: string): AccountStatus | undefined {
    const account = db.select().from(caldavAccounts).where(eq(caldavAccounts.id, accountId)).get()
    if (!account) return undefined

    const conn = this.connections.get(accountId)
    const calendarCount = db
      .select()
      .from(caldavCalendars)
      .where(eq(caldavCalendars.accountId, accountId))
      .all().length

    return {
      id: account.id,
      name: account.name,
      connected: conn?.client !== null && conn?.client !== undefined,
      syncing: conn?.isSyncing ?? false,
      lastError: conn?.lastSyncError ?? account.lastSyncError,
      calendarCount,
      enabled: account.enabled ?? true,
      lastSyncedAt: account.lastSyncedAt,
    }
  }

  // --- Internal ---

  private async connect(account: CaldavAccount): Promise<DAVClient> {
    if (account.authType === 'google-oauth') {
      return this.connectOAuth(account)
    }
    return this.connectBasic(account)
  }

  private async connectBasic(account: CaldavAccount): Promise<DAVClient> {
    const client = new DAVClient({
      serverUrl: account.serverUrl,
      credentials: {
        username: account.username ?? '',
        password: account.password ?? '',
      },
      authMethod: 'Basic',
      defaultAccountType: 'caldav',
    })
    await client.login()
    logger.info('Connected to CalDAV server (Basic)', { accountId: account.id, serverUrl: account.serverUrl })
    return client
  }

  private async connectOAuth(account: CaldavAccount): Promise<DAVClient> {
    const tokens = account.oauthTokens as CalDavOAuthTokens | null
    if (!tokens || !account.googleClientId || !account.googleClientSecret) {
      throw new Error('Google OAuth not configured. Complete the OAuth flow first.')
    }

    let currentTokens: CalDavOAuthTokens = { ...tokens }
    const accountId = account.id

    const client = new DAVClient({
      serverUrl: account.serverUrl,
      credentials: {
        clientId: account.googleClientId,
        clientSecret: account.googleClientSecret,
        accessToken: currentTokens.accessToken,
        refreshToken: currentTokens.refreshToken,
        expiration: currentTokens.expiration,
        tokenUrl: GOOGLE_TOKEN_URL,
      },
      authMethod: 'Custom',
      authFunction: async (credentials) => {
        const result = await getOauthHeaders(credentials)
        if (result.tokens.access_token && result.tokens.access_token !== currentTokens.accessToken) {
          const newTokens: CalDavOAuthTokens = {
            accessToken: result.tokens.access_token,
            refreshToken: result.tokens.refresh_token ?? currentTokens.refreshToken,
            expiration: result.tokens.expires_in
              ? Math.floor(Date.now() / 1000) + result.tokens.expires_in
              : currentTokens.expiration,
          }
          currentTokens = newTokens
          credentials.accessToken = newTokens.accessToken
          credentials.refreshToken = newTokens.refreshToken
          credentials.expiration = newTokens.expiration

          // Persist tokens to DB
          try {
            db.update(caldavAccounts)
              .set({ oauthTokens: newTokens, updatedAt: new Date().toISOString() })
              .where(eq(caldavAccounts.id, accountId))
              .run()
            logger.info('Persisted refreshed OAuth tokens', { accountId })
          } catch (err) {
            logger.error('Failed to persist refreshed OAuth tokens', {
              accountId,
              error: err instanceof Error ? err.message : String(err),
            })
          }
        }
        return result.headers
      },
      defaultAccountType: 'caldav',
    })
    await client.login()
    logger.info('Connected to CalDAV server (Google OAuth)', { accountId: account.id, serverUrl: account.serverUrl })
    return client
  }

  private scheduleSync(accountId: string, intervalMinutes: number): void {
    const conn = this.connections.get(accountId)
    if (!conn) return

    if (conn.syncInterval) {
      clearInterval(conn.syncInterval)
    }

    conn.syncInterval = setInterval(
      () => {
        this.syncAccount(accountId).catch((err) => {
          logger.error('Periodic sync failed', {
            accountId,
            error: err instanceof Error ? err.message : String(err),
          })
        })
      },
      intervalMinutes * 60 * 1000
    )
  }

  private scheduleRetry(accountId: string): void {
    const conn = this.connections.get(accountId)
    if (!conn) return

    conn.retryCount++
    const delay = Math.min(1000 * Math.pow(2, conn.retryCount), MAX_RETRY_DELAY)
    logger.info('Scheduling account retry', { accountId, retryCount: conn.retryCount, delayMs: delay })

    setTimeout(async () => {
      const account = db.select().from(caldavAccounts).where(eq(caldavAccounts.id, accountId)).get()
      if (!account || !account.enabled) return

      try {
        const client = await this.connect(account)
        conn.client = client
        this.scheduleSync(accountId, account.syncIntervalMinutes ?? 15)
        await this.syncAllCalendarsForAccount(accountId, client)
        conn.retryCount = 0
        conn.lastSyncError = null
        this.updateAccountSyncTime(accountId)
      } catch (err) {
        conn.lastSyncError = err instanceof Error ? err.message : String(err)
        this.updateAccountError(accountId, conn.lastSyncError)
        logger.error('Account retry failed', { accountId, error: conn.lastSyncError })
        this.scheduleRetry(accountId)
      }
    }, delay)
  }

  private updateAccountSyncTime(accountId: string): void {
    const now = new Date().toISOString()
    db.update(caldavAccounts)
      .set({ lastSyncedAt: now, lastSyncError: null, updatedAt: now })
      .where(eq(caldavAccounts.id, accountId))
      .run()
  }

  private updateAccountError(accountId: string, error: string): void {
    db.update(caldavAccounts)
      .set({ lastSyncError: error, updatedAt: new Date().toISOString() })
      .where(eq(caldavAccounts.id, accountId))
      .run()
  }

  /** Sync all calendars for a single account */
  async syncAllCalendarsForAccount(accountId: string, client: DAVClient): Promise<void> {
    const remoteCalendars = await client.fetchCalendars()
    const now = new Date().toISOString()
    const seenUrls = new Set<string>()

    for (const remoteCal of remoteCalendars) {
      const url = remoteCal.url
      seenUrls.add(url)

      const existing = db
        .select()
        .from(caldavCalendars)
        .where(eq(caldavCalendars.remoteUrl, url))
        .get()

      const ctag = remoteCal.ctag ?? remoteCal.syncToken ?? null

      if (existing) {
        db.update(caldavCalendars)
          .set({
            accountId,
            displayName: remoteCal.displayName ?? existing.displayName,
            ctag,
            syncToken: remoteCal.syncToken ?? existing.syncToken,
            updatedAt: now,
            lastSyncedAt: now,
          })
          .where(eq(caldavCalendars.id, existing.id))
          .run()

        if (existing.enabled) {
          await this.syncCalendarEvents(existing.id, remoteCal, client)
        }
      } else {
        const id = crypto.randomUUID()
        db.insert(caldavCalendars)
          .values({
            id,
            accountId,
            remoteUrl: url,
            displayName: remoteCal.displayName ?? 'Unnamed Calendar',
            ctag,
            syncToken: remoteCal.syncToken ?? null,
            color: null,
            timezone: null,
            enabled: true,
            lastSyncedAt: now,
            createdAt: now,
            updatedAt: now,
          })
          .run()

        await this.syncCalendarEvents(id, remoteCal, client)
      }
    }

    // Remove calendars for this account that no longer exist on server
    const localCalendars = db
      .select()
      .from(caldavCalendars)
      .where(eq(caldavCalendars.accountId, accountId))
      .all()

    const { caldavEvents } = await import('../../db')
    for (const local of localCalendars) {
      if (!seenUrls.has(local.remoteUrl)) {
        db.delete(caldavEvents)
          .where(eq(caldavEvents.calendarId, local.id))
          .run()
        db.delete(caldavCalendars)
          .where(eq(caldavCalendars.id, local.id))
          .run()
        logger.info('Removed deleted calendar', { displayName: local.displayName, accountId })
      }
    }

    logger.info('Account sync complete', { accountId, calendars: remoteCalendars.length })
  }

  private async syncCalendarEvents(
    calendarId: string,
    remoteCal: { url: string },
    client: DAVClient
  ): Promise<void> {
    const { caldavEvents } = await import('../../db')
    const { parseIcalEvent } = await import('./ical-helpers')

    const calendarObjects = await client.fetchCalendarObjects({
      calendar: { url: remoteCal.url },
    })

    const now = new Date().toISOString()
    const seenUrls = new Set<string>()

    for (const obj of calendarObjects) {
      if (!obj.data) continue

      const url = obj.url
      seenUrls.add(url)
      const parsed = parseIcalEvent(obj.data)

      const existing = db
        .select()
        .from(caldavEvents)
        .where(eq(caldavEvents.remoteUrl, url))
        .get()

      if (existing) {
        db.update(caldavEvents)
          .set({
            uid: parsed.uid ?? existing.uid,
            etag: obj.etag ?? existing.etag,
            summary: parsed.summary ?? existing.summary,
            description: parsed.description ?? existing.description,
            location: parsed.location ?? existing.location,
            dtstart: parsed.dtstart ?? existing.dtstart,
            dtend: parsed.dtend ?? existing.dtend,
            duration: parsed.duration ?? existing.duration,
            allDay: parsed.allDay,
            recurrenceRule: parsed.recurrenceRule ?? null,
            status: parsed.status ?? existing.status,
            organizer: parsed.organizer ?? existing.organizer,
            attendees: parsed.attendees ?? existing.attendees,
            rawIcal: obj.data,
            updatedAt: now,
          })
          .where(eq(caldavEvents.id, existing.id))
          .run()
      } else {
        db.insert(caldavEvents)
          .values({
            id: crypto.randomUUID(),
            calendarId,
            remoteUrl: url,
            uid: parsed.uid ?? null,
            etag: obj.etag ?? null,
            summary: parsed.summary ?? null,
            description: parsed.description ?? null,
            location: parsed.location ?? null,
            dtstart: parsed.dtstart ?? null,
            dtend: parsed.dtend ?? null,
            duration: parsed.duration ?? null,
            allDay: parsed.allDay,
            recurrenceRule: parsed.recurrenceRule ?? null,
            status: parsed.status ?? null,
            organizer: parsed.organizer ?? null,
            attendees: parsed.attendees ?? null,
            rawIcal: obj.data,
            createdAt: now,
            updatedAt: now,
          })
          .run()
      }
    }

    // Remove events no longer on server
    const localEvents = db
      .select()
      .from(caldavEvents)
      .where(eq(caldavEvents.calendarId, calendarId))
      .all()

    for (const local of localEvents) {
      if (!seenUrls.has(local.remoteUrl)) {
        db.delete(caldavEvents).where(eq(caldavEvents.id, local.id)).run()
      }
    }
  }
}

// Singleton
export const accountManager = new CaldavAccountManager()