import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { setupTestEnv, type TestEnv } from '../__tests__/utils/env'
import {
  getPreferencesForUser,
  upsertPreferencesForUser,
  getPushoverUserKeyForUser,
  toView,
  setSecretStore,
  resetSecretStore,
  type SecretStore,
} from './notification-preferences-service'

function makeInMemorySecretStore(): SecretStore & { store: Map<string, string> } {
  const store = new Map<string, string>()
  return {
    store,
    get: (key) => store.get(key) ?? null,
    set: (key, value) => {
      store.set(key, value)
    },
    remove: (key) => {
      store.delete(key)
    },
  }
}

describe('notification-preferences-service', () => {
  let env: TestEnv
  let secrets: ReturnType<typeof makeInMemorySecretStore>
  beforeEach(() => {
    env = setupTestEnv()
    secrets = makeInMemorySecretStore()
    setSecretStore(secrets)
  })
  afterEach(() => {
    resetSecretStore()
    env.cleanup()
  })

  test('returns undefined when no row exists for the user', () => {
    expect(getPreferencesForUser('no-such-user')).toBeUndefined()
  })

  test('upsert creates a row with only the patched fields populated', () => {
    const userId = crypto.randomUUID()
    const row = upsertPreferencesForUser(userId, { toastEnabled: false })
    expect(row.userId).toBe(userId)
    expect(row.toastEnabled).toBe(false)
    expect(row.desktopEnabled).toBeNull()
    expect(row.soundEnabled).toBeNull()
    expect(row.pushoverEnabled).toBeNull()
    expect(row.pushoverUserKeyFnox).toBeNull()
  })

  test('subsequent upserts merge — untouched fields stay as they were', () => {
    const userId = crypto.randomUUID()
    upsertPreferencesForUser(userId, { toastEnabled: false })
    upsertPreferencesForUser(userId, { soundEnabled: true })
    const row = getPreferencesForUser(userId)
    expect(row?.toastEnabled).toBe(false)
    expect(row?.soundEnabled).toBe(true)
  })

  test('setting a field to null clears it (vs. omitting which keeps it)', () => {
    const userId = crypto.randomUUID()
    upsertPreferencesForUser(userId, { toastEnabled: false, desktopEnabled: false })
    upsertPreferencesForUser(userId, { toastEnabled: null })
    const row = getPreferencesForUser(userId)
    expect(row?.toastEnabled).toBeNull()
    // Desktop stayed false because the second patch didn't mention it.
    expect(row?.desktopEnabled).toBe(false)
  })

  test('pushoverUserKey persists into the secret store under a per-user key', () => {
    const userId = crypto.randomUUID()
    upsertPreferencesForUser(userId, { pushoverUserKey: 'user_key_abc123' })
    const row = getPreferencesForUser(userId)
    expect(row?.pushoverUserKeyFnox).toMatch(/^FULCRUM_NOTIF_USER_/)
    expect(secrets.store.get(row!.pushoverUserKeyFnox!)).toBe('user_key_abc123')
    expect(getPushoverUserKeyForUser(userId)).toBe('user_key_abc123')
  })

  test('clearing pushoverUserKey removes the fnox secret and the DB pointer', () => {
    const userId = crypto.randomUUID()
    upsertPreferencesForUser(userId, { pushoverUserKey: 'user_key_v1' })
    const fnoxKey = getPreferencesForUser(userId)!.pushoverUserKeyFnox!
    upsertPreferencesForUser(userId, { pushoverUserKey: '' })
    expect(getPreferencesForUser(userId)?.pushoverUserKeyFnox).toBeNull()
    expect(secrets.store.get(fnoxKey)).toBeUndefined()
    expect(getPushoverUserKeyForUser(userId)).toBeNull()
  })

  test('toView hides the fnox key name, surfaces only `pushoverUserKeySet` boolean', () => {
    const userId = crypto.randomUUID()
    upsertPreferencesForUser(userId, { pushoverUserKey: 'secret' })
    const view = toView(getPreferencesForUser(userId))
    expect(view.pushoverUserKeySet).toBe(true)
    // The view object has no key name on it.
    expect(Object.keys(view)).not.toContain('pushoverUserKeyFnox')
  })

  test('toView returns all-nulls when no row exists', () => {
    expect(toView(undefined)).toEqual({
      toastEnabled: null,
      desktopEnabled: null,
      soundEnabled: null,
      pushoverEnabled: null,
      pushoverUserKeySet: false,
    })
  })

  test('per-user pushover keys are namespaced — two users do not share the same fnox key', () => {
    const alice = crypto.randomUUID()
    const bob = crypto.randomUUID()
    upsertPreferencesForUser(alice, { pushoverUserKey: 'alice_key' })
    upsertPreferencesForUser(bob, { pushoverUserKey: 'bob_key' })

    const aliceKey = getPreferencesForUser(alice)!.pushoverUserKeyFnox!
    const bobKey = getPreferencesForUser(bob)!.pushoverUserKeyFnox!
    expect(aliceKey).not.toBe(bobKey)
    expect(getPushoverUserKeyForUser(alice)).toBe('alice_key')
    expect(getPushoverUserKeyForUser(bob)).toBe('bob_key')
  })
})
