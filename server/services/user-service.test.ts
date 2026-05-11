import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { setupTestEnv, type TestEnv } from '../__tests__/utils/env'
import { ensureUserByEmail, getUserById, listUsers } from './user-service'

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
})
