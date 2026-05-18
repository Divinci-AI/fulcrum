import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { setupTestEnv, type TestEnv } from '../__tests__/utils/env'
import {
  ensureUserByEmail,
  getUserById,
  listUsers,
  createUserByAdmin,
  DuplicateUserError,
} from './user-service'

describe('user-service', () => {
  let testEnv: TestEnv
  beforeEach(() => {
    testEnv = setupTestEnv()
  })
  afterEach(() => {
    testEnv.cleanup()
  })

  test('ensureUserByEmail creates a row on first sight and returns it', () => {
    const before = listUsers().length
    const user = ensureUserByEmail('mike@divinci.ai')
    expect(user.email).toBe('mike@divinci.ai')
    expect(user.id).toBeTruthy()
    expect(user.createdAt).toBeTruthy()
    expect(listUsers().length).toBe(before + 1)
  })

  test('ensureUserByEmail is idempotent — returns the same row and bumps lastSeenAt', async () => {
    const a = ensureUserByEmail('alice@example.com')
    // Tiny delay so the ISO timestamps actually differ
    await new Promise((r) => setTimeout(r, 10))
    const b = ensureUserByEmail('alice@example.com')
    expect(b.id).toBe(a.id)
    expect(b.email).toBe(a.email)
    // lastSeenAt should advance on each call
    expect(b.lastSeenAt! >= a.lastSeenAt!).toBe(true)
  })

  test('email normalization — case-insensitive lookup', () => {
    const a = ensureUserByEmail('Bob@Example.COM')
    const b = ensureUserByEmail('bob@example.com')
    expect(b.id).toBe(a.id)
    expect(a.email).toBe('bob@example.com')
  })

  test('getUserById returns null for unknown ids', () => {
    expect(getUserById('00000000-0000-0000-0000-000000000000')).toBeNull()
  })

  // D-8 PR 1 — explicit admin-invoked pre-provisioning.
  describe('createUserByAdmin', () => {
    test('creates a row and leaves lastSeenAt null (invited, not yet seen)', () => {
      const row = createUserByAdmin('newbie@example.com')
      expect(row.email).toBe('newbie@example.com')
      expect(row.id).toBeTruthy()
      expect(row.isAdmin).toBe(false)
      expect(row.lastSeenAt).toBeNull()
      expect(row.createdAt).toBeTruthy()
    })

    test('honours isAdmin opt at creation time', () => {
      const row = createUserByAdmin('promoted@example.com', { isAdmin: true })
      expect(row.isAdmin).toBe(true)
    })

    test('honours displayName opt; trims and clears empty/whitespace', () => {
      const a = createUserByAdmin('a@example.com', { displayName: '  Alice  ' })
      expect(a.displayName).toBe('Alice')
      const b = createUserByAdmin('b@example.com', { displayName: '   ' })
      expect(b.displayName).toBeNull()
      const c = createUserByAdmin('c@example.com', { displayName: null })
      expect(c.displayName).toBeNull()
      const d = createUserByAdmin('d@example.com')
      expect(d.displayName).toBeNull()
    })

    test('normalises email to lowercase+trim', () => {
      const row = createUserByAdmin('  Mike@DIVINCI.ai  ')
      expect(row.email).toBe('mike@divinci.ai')
    })

    test('throws DuplicateUserError when the email already exists (case-insensitive)', () => {
      createUserByAdmin('dup@example.com')
      expect(() => createUserByAdmin('DUP@example.com')).toThrow(DuplicateUserError)
    })

    test('throws plain Error on malformed email', () => {
      expect(() => createUserByAdmin('')).toThrow('Invalid email')
      expect(() => createUserByAdmin('   ')).toThrow('Invalid email')
      expect(() => createUserByAdmin('not-an-email')).toThrow('Invalid email')
    })

    test('a subsequent ensureUserByEmail (first sign-in) finds the pre-provisioned row and stamps lastSeenAt', () => {
      const invited = createUserByAdmin('teammate@example.com')
      expect(invited.lastSeenAt).toBeNull()
      const seen = ensureUserByEmail('teammate@example.com')
      expect(seen.id).toBe(invited.id) // same row
      expect(seen.lastSeenAt).toBeTruthy()
    })
  })
})
