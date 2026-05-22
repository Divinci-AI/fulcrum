// @ts-nocheck — pre-existing type errors that surfaced when tsconfig.server.json was added in D-15 OG wrap-up. Remove this directive + fix the errors in a focused follow-up PR.
/**
 * CalDAV Service
 *
 * Multi-account CalDAV integration with:
 * - Account CRUD and lifecycle management
 * - Calendar discovery and sync per account
 * - Event CRUD with lossless round-tripping via rawIcal
 * - Copy rules for one-way event replication
 * - Data migration from single-account settings.json
 */

import { eq, and, gte, lte, desc, isNull } from 'drizzle-orm'
import { db, caldavAccounts, caldavCalendars, caldavEvents, caldavCopyRules, caldavCopiedEvents, googleAccounts } from '../../db'
import type { CaldavAccount, CaldavCalendar, CaldavEvent, CaldavCopyRule } from '../../db'
import type { CalDavOAuthTokens } from '../../lib/settings/types'
import { getSettings } from '../../lib/settings'
import { createLogger } from '../../lib/logger'
import { generateIcalEvent, updateIcalEvent } from './ical-helpers'
import { accountManager, type AccountStatus } from './caldav-account-manager'
import { googleCalendarManager } from '../google/google-calendar-manager'

const logger = createLogger('CalDAV')

// --- Data Migration ---

/**
 * Migrate single-account credentials from settings.json to caldavAccounts table.
 * Runs once on startup. Idempotent.
 */
function migrateFromSettings(): void {
  const settings = getSettings()
  const caldavSettings = settings.caldav

  // Only migrate if there are credentials in settings and calendars with no accountId
  if (!caldavSettings?.serverUrl) return

  const hasCredentials =
    caldavSettings.authType === 'google-oauth'
      ? !!caldavSettings.oauthTokens
      : !!(caldavSettings.username && caldavSettings.password)

  if (!hasCredentials) return

  // Check if we have orphaned calendars (no accountId)
  const orphanedCalendars = db
    .select()
    .from(caldavCalendars)
    .where(isNull(caldavCalendars.accountId))
    .all()

  if (orphanedCalendars.length === 0) {
    // Check if any accounts exist already - if so, migration was already done
    const existingAccounts = db.select().from(caldavAccounts).all()
    if (existingAccounts.length > 0) return

    // No orphaned calendars and no accounts - nothing to migrate
    return
  }

  logger.info('Migrating CalDAV credentials from settings.json to database', {
    authType: caldavSettings.authType,
    orphanedCalendars: orphanedCalendars.length,
  })

  // Create account from settings
  const now = new Date().toISOString()
  const accountId = crypto.randomUUID()
  const name =
    caldavSettings.authType === 'google-oauth'
      ? 'Google Calendar'
      : new URL(caldavSettings.serverUrl).hostname

  db.insert(caldavAccounts)
    .values({
      id: accountId,
      name,
      serverUrl: caldavSettings.serverUrl,
      authType: caldavSettings.authType,
      username: caldavSettings.username || null,
      password: caldavSettings.password || null,
      googleClientId: caldavSettings.googleClientId || null,
      googleClientSecret: caldavSettings.googleClientSecret || null,
      oauthTokens: caldavSettings.oauthTokens ?? null,
      syncIntervalMinutes: caldavSettings.syncIntervalMinutes ?? 15,
      enabled: caldavSettings.enabled ?? true,
      createdAt: now,
      updatedAt: now,
    })
    .run()

  // Backfill accountId on orphaned calendars
  for (const cal of orphanedCalendars) {
    db.update(caldavCalendars)
      .set({ accountId, updatedAt: now })
      .where(eq(caldavCalendars.id, cal.id))
      .run()
  }

  logger.info('Migration complete', { accountId, migratedCalendars: orphanedCalendars.length })
}

// --- Lifecycle ---

export async function startCaldavSync(): Promise<void> {
  const settings = getSettings()
  if (!settings.caldav?.enabled) {
    logger.info('CalDAV disabled, skipping sync start')
    return
  }

  // Run migration from settings.json if needed
  migrateFromSettings()

  // Start all enabled accounts
  await accountManager.startAll()

  // Initial sync
  await accountManager.syncAll().catch((err) => {
    logger.error('Initial sync failed', { error: err instanceof Error ? err.message : String(err) })
  })

  // Run copy rules after sync
  await executeCopyRules().catch((err) => {
    logger.error('Copy rules execution failed after sync', {
      error: err instanceof Error ? err.message : String(err),
    })
  })
}

export function stopCaldavSync(): void {
  accountManager.stopAll()
  logger.info('CalDAV sync stopped')
}

export function getCaldavStatus(): {
  connected: boolean
  syncing: boolean
  lastError: string | null
  calendarCount: number
  accounts: AccountStatus[]
} {
  const accounts = accountManager.getStatus()
  const calendars = db.select().from(caldavCalendars).all()
  const connected = accounts.some((a) => a.connected)
  const syncing = accounts.some((a) => a.syncing)
  const lastError = accounts.find((a) => a.lastError)?.lastError ?? null

  return {
    connected,
    syncing,
    lastError,
    calendarCount: calendars.length,
    accounts,
  }
}

// --- Account CRUD ---

export function listAccounts(): CaldavAccount[] {
  return db.select().from(caldavAccounts).all()
}

export function getAccount(id: string): CaldavAccount | undefined {
  return db.select().from(caldavAccounts).where(eq(caldavAccounts.id, id)).get()
}

export async function createAccount(input: {
  name: string
  serverUrl: string
  authType: 'basic' | 'google-oauth'
  username?: string
  password?: string
  googleClientId?: string
  googleClientSecret?: string
  oauthTokens?: CalDavOAuthTokens | null
  syncIntervalMinutes?: number
}): Promise<CaldavAccount> {
  const now = new Date().toISOString()
  const id = crypto.randomUUID()

  const account: CaldavAccount = {
    id,
    name: input.name,
    serverUrl: input.serverUrl,
    authType: input.authType,
    username: input.username ?? null,
    password: input.password ?? null,
    googleClientId: input.googleClientId ?? null,
    googleClientSecret: input.googleClientSecret ?? null,
    oauthTokens: input.oauthTokens ?? null,
    syncIntervalMinutes: input.syncIntervalMinutes ?? 15,
    enabled: true,
    lastSyncedAt: null,
    lastSyncError: null,
    createdAt: now,
    updatedAt: now,
  }

  db.insert(caldavAccounts).values(account).run()
  logger.info('Created CalDAV account', { id, name: input.name })

  return account
}

export async function updateAccount(
  id: string,
  updates: {
    name?: string
    serverUrl?: string
    username?: string
    password?: string
    googleClientId?: string
    googleClientSecret?: string
    oauthTokens?: CalDavOAuthTokens | null
    syncIntervalMinutes?: number
  }
): Promise<CaldavAccount> {
  const existing = db.select().from(caldavAccounts).where(eq(caldavAccounts.id, id)).get()
  if (!existing) throw new Error(`Account not found: ${id}`)

  db.update(caldavAccounts)
    .set({ ...updates, updatedAt: new Date().toISOString() })
    .where(eq(caldavAccounts.id, id))
    .run()

  // Restart account if connected (new credentials)
  if (updates.serverUrl || updates.username || updates.password || updates.oauthTokens) {
    await accountManager.startAccount(id).catch(() => {})
  }

  return db.select().from(caldavAccounts).where(eq(caldavAccounts.id, id)).get()!
}

export async function deleteAccount(id: string): Promise<void> {
  accountManager.stopAccount(id)

  // Delete calendars and events for this account
  const calendars = db
    .select()
    .from(caldavCalendars)
    .where(eq(caldavCalendars.accountId, id))
    .all()

  for (const cal of calendars) {
    // Delete copy rules involving this calendar
    db.delete(caldavCopyRules)
      .where(eq(caldavCopyRules.sourceCalendarId, cal.id))
      .run()
    db.delete(caldavCopyRules)
      .where(eq(caldavCopyRules.destCalendarId, cal.id))
      .run()

    // Delete copied events for rules referencing events from this calendar's events
    const events = db.select().from(caldavEvents).where(eq(caldavEvents.calendarId, cal.id)).all()
    for (const event of events) {
      db.delete(caldavCopiedEvents)
        .where(eq(caldavCopiedEvents.sourceEventId, event.id))
        .run()
      db.delete(caldavCopiedEvents)
        .where(eq(caldavCopiedEvents.destEventId, event.id))
        .run()
    }

    db.delete(caldavEvents).where(eq(caldavEvents.calendarId, cal.id)).run()
  }

  db.delete(caldavCalendars).where(eq(caldavCalendars.accountId, id)).run()
  db.delete(caldavAccounts).where(eq(caldavAccounts.id, id)).run()
  logger.info('Deleted CalDAV account', { id })
}

export async function enableAccount(id: string): Promise<void> {
  db.update(caldavAccounts)
    .set({ enabled: true, updatedAt: new Date().toISOString() })
    .where(eq(caldavAccounts.id, id))
    .run()
  await accountManager.startAccount(id)
  await accountManager.syncAccount(id).catch(() => {})
}

export async function disableAccount(id: string): Promise<void> {
  db.update(caldavAccounts)
    .set({ enabled: false, updatedAt: new Date().toISOString() })
    .where(eq(caldavAccounts.id, id))
    .run()
  accountManager.stopAccount(id)
}

export async function testAccountConnection(config: {
  serverUrl: string
  username: string
  password: string
}): Promise<{ success: boolean; calendars?: number; error?: string }> {
  try {
    const { DAVClient } = await import('tsdav')
    const client = new DAVClient({
      serverUrl: config.serverUrl,
      credentials: {
        username: config.username,
        password: config.password,
      },
      authMethod: 'Basic',
      defaultAccountType: 'caldav',
    })
    await client.login()
    const calendars = await client.fetchCalendars()
    return { success: true, calendars: calendars.length }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

export async function syncAccount(id: string): Promise<void> {
  await accountManager.syncAccount(id)
  // Run copy rules after sync
  await executeCopyRules().catch((err) => {
    logger.error('Copy rules failed after account sync', {
      error: err instanceof Error ? err.message : String(err),
    })
  })
}

export async function completeAccountGoogleOAuth(
  accountId: string,
  tokens: { accessToken: string; refreshToken: string; expiresIn: number }
): Promise<void> {
  const oauthTokens: CalDavOAuthTokens = {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiration: Math.floor(Date.now() / 1000) + tokens.expiresIn,
  }

  db.update(caldavAccounts)
    .set({
      oauthTokens,
      authType: 'google-oauth',
      serverUrl: 'https://apidata.googleusercontent.com/caldav/v2/',
      enabled: true,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(caldavAccounts.id, accountId))
    .run()

  await accountManager.startAccount(accountId)
  await accountManager.syncAccount(accountId).catch(() => {})
}

// --- Backward-compatible Configuration ---
// These delegate to the new account-based system

export async function testCaldavConnection(config: {
  serverUrl: string
  username: string
  password: string
}): Promise<{ success: boolean; calendars?: number; error?: string }> {
  return testAccountConnection(config)
}

export async function configureCaldav(config: {
  serverUrl: string
  username: string
  password: string
  syncIntervalMinutes?: number
}): Promise<void> {
  // Create or update the "default" basic account
  const existingAccounts = db.select().from(caldavAccounts).all()
  const basicAccount = existingAccounts.find((a) => a.authType === 'basic')

  if (basicAccount) {
    await updateAccount(basicAccount.id, {
      serverUrl: config.serverUrl,
      username: config.username,
      password: config.password,
      syncIntervalMinutes: config.syncIntervalMinutes,
    })
    await enableAccount(basicAccount.id)
  } else {
    const name = new URL(config.serverUrl).hostname
    const account = await createAccount({
      name,
      serverUrl: config.serverUrl,
      authType: 'basic',
      username: config.username,
      password: config.password,
      syncIntervalMinutes: config.syncIntervalMinutes,
    })
    await accountManager.startAccount(account.id)
    await accountManager.syncAccount(account.id).catch(() => {})
  }

  // Ensure global caldav enabled
  const { updateSettingByPath } = await import('../../lib/settings')
  await updateSettingByPath('caldav.enabled', true)
}

export async function configureGoogleOAuth(config: {
  name?: string
  googleClientId: string
  googleClientSecret: string
  syncIntervalMinutes?: number
  accountId?: string
}): Promise<string> {
  let accountId = config.accountId

  if (accountId) {
    // Update existing account
    await updateAccount(accountId, {
      googleClientId: config.googleClientId,
      googleClientSecret: config.googleClientSecret,
      syncIntervalMinutes: config.syncIntervalMinutes,
    })
  } else {
    // Create new Google account
    const account = await createAccount({
      name: config.name || 'Google Calendar',
      serverUrl: 'https://apidata.googleusercontent.com/caldav/v2/',
      authType: 'google-oauth',
      googleClientId: config.googleClientId,
      googleClientSecret: config.googleClientSecret,
      syncIntervalMinutes: config.syncIntervalMinutes,
    })
    accountId = account.id
  }

  return accountId
}

export async function completeGoogleOAuth(tokens: {
  accessToken: string
  refreshToken: string
  expiresIn: number
  accountId?: string
}): Promise<void> {
  let accountId = tokens.accountId

  if (!accountId) {
    // Find the most recently created Google OAuth account without tokens
    const accounts = db.select().from(caldavAccounts).all()
    const pending = accounts
      .filter((a) => a.authType === 'google-oauth' && !a.oauthTokens)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    accountId = pending[0]?.id
  }

  if (!accountId) {
    throw new Error('No pending Google OAuth account found')
  }

  await completeAccountGoogleOAuth(accountId, tokens)

  // Ensure global caldav enabled
  const { updateSettingByPath } = await import('../../lib/settings')
  await updateSettingByPath('caldav.enabled', true)
}

export async function enableCaldav(): Promise<void> {
  const { updateSettingByPath } = await import('../../lib/settings')
  await updateSettingByPath('caldav.enabled', true)
  await accountManager.startAll()
  await accountManager.syncAll().catch(() => {})
}

export async function disableCaldav(): Promise<void> {
  const { updateSettingByPath } = await import('../../lib/settings')
  await updateSettingByPath('caldav.enabled', false)
  accountManager.stopAll()
}

// --- Calendar Operations ---

export function listCalendars(accountId?: string): CaldavCalendar[] {
  if (accountId) {
    return db
      .select()
      .from(caldavCalendars)
      .where(eq(caldavCalendars.accountId, accountId))
      .all()
  }
  return db.select().from(caldavCalendars).all()
}

export async function syncCalendars(): Promise<void> {
  // Sync CalDAV accounts
  await accountManager.syncAll()

  // Sync Google Calendar accounts
  const { googleCalendarManager } = await import('../google/google-calendar-manager')
  const googleAccountRows = db
    .select()
    .from(googleAccounts)
    .all()
    .filter((a) => a.calendarEnabled)
  for (const account of googleAccountRows) {
    await googleCalendarManager.syncAccount(account.id).catch((err) => {
      logger.error('Google Calendar sync failed during manual sync', {
        accountId: account.id,
        error: err instanceof Error ? err.message : String(err),
      })
    })
  }

  await executeCopyRules().catch((err) => {
    logger.error('Copy rules failed after sync', {
      error: err instanceof Error ? err.message : String(err),
    })
  })
}

// --- Event Operations ---

export function listEvents(options?: {
  calendarId?: string
  from?: string
  to?: string
  limit?: number
}): CaldavEvent[] {
  const conditions = []

  if (options?.calendarId) {
    conditions.push(eq(caldavEvents.calendarId, options.calendarId))
  }
  if (options?.from) {
    conditions.push(gte(caldavEvents.dtstart, options.from))
  }
  if (options?.to) {
    conditions.push(lte(caldavEvents.dtstart, options.to))
  }

  const query = db
    .select()
    .from(caldavEvents)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(caldavEvents.dtstart))

  if (options?.limit) {
    return query.limit(options.limit).all()
  }

  return query.all()
}

export function getEvent(id: string): CaldavEvent | undefined {
  return db.select().from(caldavEvents).where(eq(caldavEvents.id, id)).get()
}

export async function createEvent(input: {
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
}): Promise<CaldavEvent> {
  const calendar = db
    .select()
    .from(caldavCalendars)
    .where(eq(caldavCalendars.id, input.calendarId))
    .get()

  if (!calendar) {
    throw new Error(`Calendar not found: ${input.calendarId}`)
  }

  // Delegate to Google Calendar API for Google-backed calendars
  if (calendar.googleAccountId) {
    await googleCalendarManager.createEvent(calendar.id, {
      summary: input.summary,
      dtstart: input.dtstart,
      dtend: input.dtend,
      description: input.description,
      location: input.location,
      allDay: input.allDay,
    })
    // Return the newly inserted event from DB
    const created = db
      .select()
      .from(caldavEvents)
      .where(eq(caldavEvents.calendarId, input.calendarId))
      .orderBy(desc(caldavEvents.createdAt))
      .limit(1)
      .get()
    if (!created) throw new Error('Failed to retrieve created Google Calendar event')
    return created
  }

  const client = calendar.accountId ? accountManager.getClient(calendar.accountId) : null
  if (!client) {
    throw new Error('CalDAV account not connected for this calendar')
  }

  const uid = `${crypto.randomUUID()}@fulcrum`
  const ical = generateIcalEvent({
    uid,
    summary: input.summary,
    dtstart: input.dtstart,
    dtend: input.dtend,
    duration: input.duration,
    description: input.description,
    location: input.location,
    allDay: input.allDay,
    recurrenceRule: input.recurrenceRule,
    status: input.status,
  })

  const eventUrl = `${calendar.remoteUrl}${uid}.ics`
  await client.createCalendarObject({
    calendar: { url: calendar.remoteUrl },
    filename: `${uid}.ics`,
    iCalString: ical,
  })

  const now = new Date().toISOString()
  const id = crypto.randomUUID()
  const event: CaldavEvent = {
    id,
    calendarId: input.calendarId,
    remoteUrl: eventUrl,
    uid,
    etag: null,
    summary: input.summary,
    description: input.description ?? null,
    location: input.location ?? null,
    dtstart: input.dtstart,
    dtend: input.dtend ?? null,
    duration: input.duration ?? null,
    allDay: input.allDay ?? false,
    recurrenceRule: input.recurrenceRule ?? null,
    status: input.status ?? null,
    organizer: null,
    attendees: null,
    rawIcal: ical,
    createdAt: now,
    updatedAt: now,
  }

  db.insert(caldavEvents).values(event).run()
  logger.info('Created CalDAV event', { id, summary: input.summary })

  return event
}

export async function updateEvent(
  id: string,
  updates: {
    summary?: string
    dtstart?: string
    dtend?: string
    duration?: string
    description?: string
    location?: string
    allDay?: boolean
    recurrenceRule?: string
    status?: string
  }
): Promise<CaldavEvent> {
  const event = db.select().from(caldavEvents).where(eq(caldavEvents.id, id)).get()
  if (!event) {
    throw new Error(`Event not found: ${id}`)
  }

  const calendar = db
    .select()
    .from(caldavCalendars)
    .where(eq(caldavCalendars.id, event.calendarId))
    .get()

  // Delegate to Google Calendar API for Google-backed calendars
  if (calendar?.googleAccountId) {
    await googleCalendarManager.updateEvent(id, updates)
    return db.select().from(caldavEvents).where(eq(caldavEvents.id, id)).get()!
  }

  const client = calendar?.accountId ? accountManager.getClient(calendar.accountId) : null
  if (!client) {
    throw new Error('CalDAV account not connected for this calendar')
  }

  const updatedIcal = event.rawIcal
    ? updateIcalEvent(event.rawIcal, updates)
    : generateIcalEvent({
        uid: event.uid || crypto.randomUUID(),
        summary: updates.summary ?? event.summary ?? 'Untitled',
        dtstart: updates.dtstart ?? event.dtstart ?? new Date().toISOString(),
        dtend: updates.dtend ?? event.dtend ?? undefined,
        duration: updates.duration ?? event.duration ?? undefined,
        description: updates.description ?? event.description ?? undefined,
        location: updates.location ?? event.location ?? undefined,
        allDay: updates.allDay ?? event.allDay ?? false,
        recurrenceRule: updates.recurrenceRule ?? event.recurrenceRule ?? undefined,
        status: updates.status ?? event.status ?? undefined,
      })

  await client.updateCalendarObject({
    calendarObject: {
      url: event.remoteUrl,
      etag: event.etag ?? undefined,
    },
    iCalString: updatedIcal,
  })

  const now = new Date().toISOString()
  db.update(caldavEvents)
    .set({
      summary: updates.summary ?? event.summary,
      description: updates.description ?? event.description,
      location: updates.location ?? event.location,
      dtstart: updates.dtstart ?? event.dtstart,
      dtend: updates.dtend ?? event.dtend,
      duration: updates.duration ?? event.duration,
      allDay: updates.allDay ?? event.allDay,
      recurrenceRule: updates.recurrenceRule ?? event.recurrenceRule,
      status: updates.status ?? event.status,
      rawIcal: updatedIcal,
      updatedAt: now,
    })
    .where(eq(caldavEvents.id, id))
    .run()

  logger.info('Updated CalDAV event', { id, summary: updates.summary ?? event.summary })

  return db.select().from(caldavEvents).where(eq(caldavEvents.id, id)).get()!
}

export async function deleteEvent(id: string): Promise<void> {
  const event = db.select().from(caldavEvents).where(eq(caldavEvents.id, id)).get()
  if (!event) {
    throw new Error(`Event not found: ${id}`)
  }

  const calendar = db
    .select()
    .from(caldavCalendars)
    .where(eq(caldavCalendars.id, event.calendarId))
    .get()

  // Delegate to Google Calendar API for Google-backed calendars
  if (calendar?.googleAccountId) {
    await googleCalendarManager.deleteEvent(id)
    return
  }

  const client = calendar?.accountId ? accountManager.getClient(calendar.accountId) : null
  if (!client) {
    throw new Error('CalDAV account not connected for this calendar')
  }

  await client.deleteCalendarObject({
    calendarObject: {
      url: event.remoteUrl,
      etag: event.etag ?? undefined,
    },
  })

  db.delete(caldavEvents).where(eq(caldavEvents.id, id)).run()
  logger.info('Deleted CalDAV event', { id, summary: event.summary })
}

// --- Copy Rules ---

export function listCopyRules(): CaldavCopyRule[] {
  return db.select().from(caldavCopyRules).all()
}

export function getCopyRule(id: string): CaldavCopyRule | undefined {
  return db.select().from(caldavCopyRules).where(eq(caldavCopyRules.id, id)).get()
}

export function createCopyRule(input: {
  name?: string
  sourceCalendarId: string
  destCalendarId: string
}): CaldavCopyRule {
  const now = new Date().toISOString()
  const id = crypto.randomUUID()

  const rule: CaldavCopyRule = {
    id,
    name: input.name ?? null,
    sourceCalendarId: input.sourceCalendarId,
    destCalendarId: input.destCalendarId,
    enabled: true,
    lastExecutedAt: null,
    createdAt: now,
    updatedAt: now,
  }

  db.insert(caldavCopyRules).values(rule).run()
  logger.info('Created copy rule', { id, source: input.sourceCalendarId, dest: input.destCalendarId })
  return rule
}

export function updateCopyRule(
  id: string,
  updates: { name?: string; enabled?: boolean }
): CaldavCopyRule {
  const existing = db.select().from(caldavCopyRules).where(eq(caldavCopyRules.id, id)).get()
  if (!existing) throw new Error(`Copy rule not found: ${id}`)

  db.update(caldavCopyRules)
    .set({ ...updates, updatedAt: new Date().toISOString() })
    .where(eq(caldavCopyRules.id, id))
    .run()

  return db.select().from(caldavCopyRules).where(eq(caldavCopyRules.id, id)).get()!
}

export function deleteCopyRule(id: string): void {
  db.delete(caldavCopiedEvents).where(eq(caldavCopiedEvents.ruleId, id)).run()
  db.delete(caldavCopyRules).where(eq(caldavCopyRules.id, id)).run()
  logger.info('Deleted copy rule', { id })
}

export async function executeCopyRule(ruleId: string): Promise<{ created: number; updated: number }> {
  const { executeSingleRule } = await import('./copy-engine')
  return executeSingleRule(ruleId)
}

async function executeCopyRules(): Promise<void> {
  const { executeAllRules } = await import('./copy-engine')
  await executeAllRules()
}