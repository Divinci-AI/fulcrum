import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { setupTestEnv, type TestEnv } from '../../__tests__/utils/env'
import { db, googleAccounts, users } from '../../db'
import { listGoogleAccountsForUser, getGoogleAccountForUser } from './google-calendar-service'

// D-6 PR 1: per-user filtering for Google accounts. Covers the new
// `listGoogleAccountsForUser` + `getGoogleAccountForUser` helpers and the
// one-release NULL-owner transition compatibility.

describe('listGoogleAccountsForUser', () => {
  let env: TestEnv
  beforeEach(() => {
    env = setupTestEnv()
  })
  afterEach(() => env.cleanup())

  function insertUser(email: string): string {
    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    db.insert(users).values({ id, email, createdAt: now, updatedAt: now }).run()
    return id
  }
  function insertAccount(name: string, ownerUserId: string | null): string {
    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    db.insert(googleAccounts)
      .values({ id, name, ownerUserId, createdAt: now, updatedAt: now })
      .run()
    return id
  }

  test('returns only the calling user\'s accounts plus NULL-owner legacy rows', () => {
    const alice = insertUser('alice@example.com')
    const bob = insertUser('bob@example.com')
    const aliceAcct = insertAccount('alice work', alice)
    const bobAcct = insertAccount('bob work', bob)
    const legacyAcct = insertAccount('legacy shared', null)

    const aliceSees = listGoogleAccountsForUser(alice).map((a) => a.id).sort()
    const bobSees = listGoogleAccountsForUser(bob).map((a) => a.id).sort()

    expect(aliceSees).toEqual([aliceAcct, legacyAcct].sort())
    expect(bobSees).toEqual([bobAcct, legacyAcct].sort())
    expect(aliceSees).not.toContain(bobAcct)
    expect(bobSees).not.toContain(aliceAcct)
  })

  test('returns only NULL-owner rows for a user with no owned accounts', () => {
    const newUser = insertUser('new@example.com')
    const legacyAcct = insertAccount('legacy', null)
    insertAccount('someone-elses', insertUser('other@example.com'))

    const seen = listGoogleAccountsForUser(newUser).map((a) => a.id)
    expect(seen).toEqual([legacyAcct])
  })

  test('returns empty array when no accounts exist', () => {
    const u = insertUser('lone@example.com')
    expect(listGoogleAccountsForUser(u)).toEqual([])
  })
})

describe('getGoogleAccountForUser', () => {
  let env: TestEnv
  beforeEach(() => {
    env = setupTestEnv()
  })
  afterEach(() => env.cleanup())

  function insertUser(email: string): string {
    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    db.insert(users).values({ id, email, createdAt: now, updatedAt: now }).run()
    return id
  }
  function insertAccount(name: string, ownerUserId: string | null): string {
    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    db.insert(googleAccounts)
      .values({ id, name, ownerUserId, createdAt: now, updatedAt: now })
      .run()
    return id
  }

  test('returns the account when the caller owns it', () => {
    const alice = insertUser('alice@example.com')
    const acct = insertAccount('alice work', alice)
    expect(getGoogleAccountForUser(acct, alice)?.id).toBe(acct)
  })

  test('returns undefined when the caller does NOT own the account', () => {
    const alice = insertUser('alice@example.com')
    const bob = insertUser('bob@example.com')
    const bobAcct = insertAccount('bob work', bob)
    // The privacy guarantee: probing Bob's account ID as Alice yields
    // undefined (route layer turns this into a 404 — same response as
    // "doesn't exist", so existence isn't leaked).
    expect(getGoogleAccountForUser(bobAcct, alice)).toBeUndefined()
  })

  test('returns the account when ownerUserId is NULL (legacy transition)', () => {
    const alice = insertUser('alice@example.com')
    const bob = insertUser('bob@example.com')
    const legacyAcct = insertAccount('legacy shared', null)
    expect(getGoogleAccountForUser(legacyAcct, alice)?.id).toBe(legacyAcct)
    expect(getGoogleAccountForUser(legacyAcct, bob)?.id).toBe(legacyAcct)
  })

  test('returns undefined for an unknown account ID', () => {
    const alice = insertUser('alice@example.com')
    expect(getGoogleAccountForUser('00000000-0000-0000-0000-000000000000', alice)).toBeUndefined()
  })
})
