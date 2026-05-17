import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { setupTestEnv, type TestEnv } from '../../__tests__/utils/env'
import { db, googleAccounts, users } from '../../db'
import { listGoogleAccountsForUser, getGoogleAccountForUser } from './google-calendar-service'

// D-6 PR 1b: per-user filtering for Google accounts AFTER the NOT NULL flip.
// The NULL-owner "visible to all" fallback that existed during the 0078
// transition is gone; the column is now mandatory and a user only sees rows
// they own.

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
  function insertAccount(name: string, ownerUserId: string): string {
    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    db.insert(googleAccounts)
      .values({ id, name, ownerUserId, createdAt: now, updatedAt: now })
      .run()
    return id
  }

  test('returns only the calling user\'s accounts', () => {
    const alice = insertUser('alice@example.com')
    const bob = insertUser('bob@example.com')
    const aliceAcct = insertAccount('alice work', alice)
    const bobAcct = insertAccount('bob work', bob)

    expect(listGoogleAccountsForUser(alice).map((a) => a.id)).toEqual([aliceAcct])
    expect(listGoogleAccountsForUser(bob).map((a) => a.id)).toEqual([bobAcct])
  })

  test('returns empty array when the user owns nothing', () => {
    const alice = insertUser('alice@example.com')
    insertAccount('someone-elses', insertUser('other@example.com'))
    expect(listGoogleAccountsForUser(alice)).toEqual([])
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
  function insertAccount(name: string, ownerUserId: string): string {
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
    // Probing Bob's account ID as Alice yields undefined — the route layer
    // turns this into a 404 so existence isn't leaked.
    expect(getGoogleAccountForUser(bobAcct, alice)).toBeUndefined()
  })

  test('returns undefined for an unknown account ID', () => {
    const alice = insertUser('alice@example.com')
    expect(getGoogleAccountForUser('00000000-0000-0000-0000-000000000000', alice)).toBeUndefined()
  })
})
