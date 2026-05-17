/**
 * Notification preferences service (D-6 PR 4).
 *
 * Per-user overrides on top of the tenant-wide notification settings. Each
 * column is nullable — NULL means "inherit the tenant default". The
 * dispatcher hasn't been updated to consult these yet (follow-up work); for
 * now the surface is read/write only so the foundation is in place.
 *
 * The pushover user key is stored as an age-encrypted fnox secret keyed by
 * a per-user name (`FULCRUM_NOTIF_USER_<userId>_PUSHOVER`). The DB column
 * records the fnox key name only; the secret itself never lives in the row.
 */
import { eq } from 'drizzle-orm'
import { db, notificationPreferences } from '../db'
import type { NotificationPreference } from '../db'
import {
  fnoxGet as defaultFnoxGet,
  fnoxRemove as defaultFnoxRemove,
  fnoxSet as defaultFnoxSet,
} from '../lib/settings/fnox'
import { createLogger } from '../lib/logger'

const logger = createLogger('NotifPrefs:Service')

// Swappable secret store — same pattern as github-account-service. Tests
// inject an in-memory fake; production uses fnox-age.
export interface SecretStore {
  get(key: string): string | null
  set(key: string, value: string): void
  remove(key: string): void
}

const realSecretStore: SecretStore = {
  get: (key) => defaultFnoxGet(key),
  set: (key, value) => defaultFnoxSet(key, value, 'age'),
  remove: (key) => defaultFnoxRemove(key),
}

let secretStore: SecretStore = realSecretStore
export function setSecretStore(store: SecretStore): void {
  secretStore = store
}
export function resetSecretStore(): void {
  secretStore = realSecretStore
}

function pushoverKeyForUser(userId: string): string {
  return `FULCRUM_NOTIF_USER_${userId.replace(/-/g, '_').toUpperCase()}_PUSHOVER`
}

export function getPreferencesForUser(userId: string): NotificationPreference | undefined {
  return db
    .select()
    .from(notificationPreferences)
    .where(eq(notificationPreferences.userId, userId))
    .get()
}

export interface PreferencePatch {
  toastEnabled?: boolean | null
  desktopEnabled?: boolean | null
  soundEnabled?: boolean | null
  pushoverEnabled?: boolean | null
  /** Pass `''` (empty string) to clear the stored pushover key. */
  pushoverUserKey?: string | null
}

// Upsert preferences for `userId`. Only the fields present in `patch` are
// modified; existing fields stay untouched (PATCH semantics). Pushover key
// is stored as an age-encrypted fnox secret; clearing it (passing `''` or
// `null`) removes the fnox key and the DB pointer.
export function upsertPreferencesForUser(
  userId: string,
  patch: PreferencePatch
): NotificationPreference {
  const now = new Date().toISOString()
  const existing = getPreferencesForUser(userId)

  // Handle pushover key separately: persist into fnox, store the fnox key
  // name in the DB column.
  let pushoverUserKeyFnox: string | null | undefined = undefined
  if (patch.pushoverUserKey !== undefined) {
    if (patch.pushoverUserKey === null || patch.pushoverUserKey === '') {
      // Clear: remove the secret and null the column.
      const previousKey = existing?.pushoverUserKeyFnox
      if (previousKey) secretStore.remove(previousKey)
      pushoverUserKeyFnox = null
    } else {
      const fnoxKey = pushoverKeyForUser(userId)
      secretStore.set(fnoxKey, patch.pushoverUserKey)
      pushoverUserKeyFnox = fnoxKey
    }
  }

  const values: Partial<NotificationPreference> = {}
  if (patch.toastEnabled !== undefined) values.toastEnabled = patch.toastEnabled
  if (patch.desktopEnabled !== undefined) values.desktopEnabled = patch.desktopEnabled
  if (patch.soundEnabled !== undefined) values.soundEnabled = patch.soundEnabled
  if (patch.pushoverEnabled !== undefined) values.pushoverEnabled = patch.pushoverEnabled
  if (pushoverUserKeyFnox !== undefined) values.pushoverUserKeyFnox = pushoverUserKeyFnox
  values.updatedAt = now

  if (existing) {
    db.update(notificationPreferences)
      .set(values)
      .where(eq(notificationPreferences.userId, userId))
      .run()
  } else {
    db.insert(notificationPreferences)
      .values({
        userId,
        toastEnabled: values.toastEnabled ?? null,
        desktopEnabled: values.desktopEnabled ?? null,
        soundEnabled: values.soundEnabled ?? null,
        pushoverEnabled: values.pushoverEnabled ?? null,
        pushoverUserKeyFnox: values.pushoverUserKeyFnox ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .run()
  }

  const row = getPreferencesForUser(userId)
  if (!row) {
    // Defensive — the upsert above should always produce a row.
    logger.error('Failed to read back upserted notification preferences', { userId })
    throw new Error('Failed to persist notification preferences')
  }
  return row
}

// Returns the user's pushover user key (decrypted) if set, or null. Used by
// the future dispatcher when routing to a per-user Pushover device.
export function getPushoverUserKeyForUser(userId: string): string | null {
  const row = getPreferencesForUser(userId)
  if (!row || !row.pushoverUserKeyFnox) return null
  return secretStore.get(row.pushoverUserKeyFnox)
}

// View model returned by GET /api/users/me/notifications. Hides the
// internal fnox key name and surfaces a boolean indicating whether a
// custom pushover user key is set; the actual value is never returned
// over the wire.
export interface NotificationPreferencesView {
  toastEnabled: boolean | null
  desktopEnabled: boolean | null
  soundEnabled: boolean | null
  pushoverEnabled: boolean | null
  pushoverUserKeySet: boolean
}

export function toView(row: NotificationPreference | undefined): NotificationPreferencesView {
  return {
    toastEnabled: row?.toastEnabled ?? null,
    desktopEnabled: row?.desktopEnabled ?? null,
    soundEnabled: row?.soundEnabled ?? null,
    pushoverEnabled: row?.pushoverEnabled ?? null,
    pushoverUserKeySet: !!row?.pushoverUserKeyFnox,
  }
}
