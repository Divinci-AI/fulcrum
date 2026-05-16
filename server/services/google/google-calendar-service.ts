/**
 * Google Calendar Service
 *
 * CRUD for Google accounts and lifecycle management.
 */

import { eq, isNull, or } from 'drizzle-orm'
import { db, googleAccounts, caldavCalendars, caldavEvents } from '../../db'
import type { GoogleAccount } from '../../db'
import { googleCalendarManager } from './google-calendar-manager'
import { createLogger } from '../../lib/logger'
import { updateSettingByPath } from '../../lib/settings'
import { startEmailChannel, stopEmailChannel } from '../channels/channel-manager'

const logger = createLogger('Google:CalendarService')

// Returns every Google account. Used by background workers that have no
// user context (calendar sync, gmail polling). Route handlers should use
// `listGoogleAccountsForUser` instead so requests are scoped to the calling
// user.
export function listGoogleAccounts(): GoogleAccount[] {
  return db.select().from(googleAccounts).all()
}

// D-6 PR 1: returns Google accounts visible to `userId`. Includes accounts
// the user owns plus legacy accounts whose `ownerUserId` is still NULL
// (one-release transition; rows are backfilled to the tenant's first user
// by migration 0078, but accounts connected before the upgrade may be
// re-visible to multiple users until they're re-linked). In the next
// release this fallback drops and the column flips to NOT NULL.
export function listGoogleAccountsForUser(userId: string): GoogleAccount[] {
  return db
    .select()
    .from(googleAccounts)
    .where(or(eq(googleAccounts.ownerUserId, userId), isNull(googleAccounts.ownerUserId)))
    .all()
}

export function getGoogleAccount(id: string): GoogleAccount | undefined {
  return db.select().from(googleAccounts).where(eq(googleAccounts.id, id)).get()
}

// D-6 PR 1: like `getGoogleAccount` but returns the account only when it's
// visible to `userId`. Visibility = the user owns it, OR `ownerUserId` is
// still NULL (legacy transition). Routes use this to gate ID-addressed
// operations (PATCH/DELETE/enable/disable/sync) so guessing an account ID
// can't reach another user's connection.
export function getGoogleAccountForUser(id: string, userId: string): GoogleAccount | undefined {
  const account = getGoogleAccount(id)
  if (!account) return undefined
  if (account.ownerUserId !== null && account.ownerUserId !== userId) return undefined
  return account
}

export function updateGoogleAccount(
  id: string,
  updates: { name?: string; syncIntervalMinutes?: number; sendAsEmail?: string | null }
): GoogleAccount | undefined {
  const now = new Date().toISOString()
  db.update(googleAccounts)
    .set({ ...updates, updatedAt: now })
    .where(eq(googleAccounts.id, id))
    .run()
  return getGoogleAccount(id)
}

export async function deleteGoogleAccount(id: string): Promise<void> {
  // Stop sync
  googleCalendarManager.stopAccount(id)

  // Delete calendars and events for this account
  const calendars = db
    .select()
    .from(caldavCalendars)
    .where(eq(caldavCalendars.googleAccountId, id))
    .all()

  for (const cal of calendars) {
    db.delete(caldavEvents).where(eq(caldavEvents.calendarId, cal.id)).run()
  }

  db.delete(caldavCalendars).where(eq(caldavCalendars.googleAccountId, id)).run()

  // Delete account
  db.delete(googleAccounts).where(eq(googleAccounts.id, id)).run()

  logger.info('Deleted Google account', { accountId: id })
}

export async function enableGoogleCalendar(id: string): Promise<void> {
  const now = new Date().toISOString()
  db.update(googleAccounts)
    .set({ calendarEnabled: true, updatedAt: now })
    .where(eq(googleAccounts.id, id))
    .run()

  await googleCalendarManager.startAccount(id)
  logger.info('Enabled Google Calendar for account', { accountId: id })
}

export async function disableGoogleCalendar(id: string): Promise<void> {
  const now = new Date().toISOString()
  db.update(googleAccounts)
    .set({ calendarEnabled: false, updatedAt: now })
    .where(eq(googleAccounts.id, id))
    .run()

  googleCalendarManager.stopAccount(id)
  logger.info('Disabled Google Calendar for account', { accountId: id })
}

export async function enableGmail(id: string): Promise<void> {
  const now = new Date().toISOString()
  db.update(googleAccounts)
    .set({ gmailEnabled: true, updatedAt: now })
    .where(eq(googleAccounts.id, id))
    .run()

  // Update email channel settings so the channel starts with Gmail backend
  updateSettingByPath('channels.email.enabled', true)
  updateSettingByPath('channels.email.backend', 'gmail-api')
  updateSettingByPath('channels.email.googleAccountId', id)

  // Restart the email channel with the new configuration
  await stopEmailChannel()
  await startEmailChannel()

  logger.info('Enabled Gmail for account', { accountId: id })
}

export async function disableGmail(id: string): Promise<void> {
  const now = new Date().toISOString()
  db.update(googleAccounts)
    .set({ gmailEnabled: false, updatedAt: now })
    .where(eq(googleAccounts.id, id))
    .run()

  // Stop the email channel and update settings
  await stopEmailChannel()
  updateSettingByPath('channels.email.enabled', false)
  updateSettingByPath('channels.email.googleAccountId', null)

  logger.info('Disabled Gmail for account', { accountId: id })
}

export async function syncGoogleCalendar(id: string): Promise<void> {
  await googleCalendarManager.syncAccount(id)
}

/**
 * Start Google Calendar sync for all enabled accounts.
 * Called on server startup.
 */
export async function startGoogleCalendarSync(): Promise<void> {
  await googleCalendarManager.startAll()
}

/**
 * Stop all Google Calendar sync.
 * Called on server shutdown.
 */
export function stopGoogleCalendarSync(): void {
  googleCalendarManager.stopAll()
}
