import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { setupTestEnv, type TestEnv } from '../__tests__/utils/env'
import { db, users } from '../db'
import {
  listMappingsForUser,
  getChannelIdentityForUser,
  upsertMapping,
  deleteMapping,
  isChannelType,
  CHANNEL_TYPES,
} from './channel-identity-service'

function insertUser(email: string): string {
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  db.insert(users)
    .values({ id, email, isAdmin: false, createdAt: now, updatedAt: now })
    .run()
  return id
}

describe('channel-identity-service', () => {
  let env: TestEnv
  beforeEach(() => {
    env = setupTestEnv()
  })
  afterEach(() => env.cleanup())

  test('isChannelType validates the supported set', () => {
    expect(isChannelType('slack')).toBe(true)
    expect(isChannelType('discord')).toBe(true)
    expect(isChannelType('telegram')).toBe(true)
    expect(isChannelType('whatsapp')).toBe(true)
    expect(isChannelType('email')).toBe(false)
    expect(isChannelType('')).toBe(false)
    expect(CHANNEL_TYPES.length).toBe(4)
  })

  test('upsert creates a new mapping when none exists', () => {
    const userId = insertUser('alice@example.com')
    const row = upsertMapping(userId, 'slack', 'U01ABC')
    expect(row.channelUserId).toBe('U01ABC')
    expect(row.userId).toBe(userId)
    expect(row.channelType).toBe('slack')
    expect(getChannelIdentityForUser(userId, 'slack')).toBe('U01ABC')
  })

  test('upsert overwrites an existing mapping for the same (user, channel)', () => {
    const userId = insertUser('alice@example.com')
    upsertMapping(userId, 'slack', 'U_OLD')
    upsertMapping(userId, 'slack', 'U_NEW')
    const rows = listMappingsForUser(userId).filter((m) => m.channelType === 'slack')
    expect(rows.length).toBe(1)
    expect(rows[0].channelUserId).toBe('U_NEW')
  })

  test('different channels for the same user are independent rows', () => {
    const userId = insertUser('alice@example.com')
    upsertMapping(userId, 'slack', 'U01')
    upsertMapping(userId, 'discord', '12345')
    upsertMapping(userId, 'telegram', '67890')
    const rows = listMappingsForUser(userId)
    expect(rows.length).toBe(3)
    expect(rows.map((r) => r.channelType).sort()).toEqual(['discord', 'slack', 'telegram'])
  })

  test('different users on the same channel are independent', () => {
    const alice = insertUser('alice@example.com')
    const bob = insertUser('bob@example.com')
    upsertMapping(alice, 'slack', 'U_ALICE')
    upsertMapping(bob, 'slack', 'U_BOB')
    expect(getChannelIdentityForUser(alice, 'slack')).toBe('U_ALICE')
    expect(getChannelIdentityForUser(bob, 'slack')).toBe('U_BOB')
  })

  test('upsert rejects empty channelUserId', () => {
    const userId = insertUser('alice@example.com')
    expect(() => upsertMapping(userId, 'slack', '')).toThrow('channelUserId must not be empty')
    expect(() => upsertMapping(userId, 'slack', '   ')).toThrow('channelUserId must not be empty')
  })

  test('upsert trims surrounding whitespace before storing', () => {
    const userId = insertUser('alice@example.com')
    const row = upsertMapping(userId, 'slack', '  U01ABC  ')
    expect(row.channelUserId).toBe('U01ABC')
  })

  test('getChannelIdentityForUser returns null when nothing is mapped', () => {
    const userId = insertUser('alice@example.com')
    expect(getChannelIdentityForUser(userId, 'slack')).toBeNull()
  })

  test('delete removes the mapping; returns false when nothing was removed', () => {
    const userId = insertUser('alice@example.com')
    upsertMapping(userId, 'slack', 'U01')
    expect(deleteMapping(userId, 'slack')).toBe(true)
    expect(getChannelIdentityForUser(userId, 'slack')).toBeNull()
    // Second delete is a no-op returning false.
    expect(deleteMapping(userId, 'slack')).toBe(false)
  })

  test('delete is scoped to (user, channel) — does not affect other channels', () => {
    const userId = insertUser('alice@example.com')
    upsertMapping(userId, 'slack', 'U01')
    upsertMapping(userId, 'discord', '12345')
    deleteMapping(userId, 'slack')
    expect(getChannelIdentityForUser(userId, 'discord')).toBe('12345')
  })
})
