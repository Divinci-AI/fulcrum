import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { setupTestEnv, type TestEnv } from '../__tests__/utils/env'
import { db, users } from '../db'
import {
  listMappingsForUser,
  getChannelIdentityForUser,
  getUserIdForChannelIdentity,
  resolveInboundUserId,
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

  // D-7 PR 6 — inbound attribution reverse lookup.
  describe('getUserIdForChannelIdentity (reverse lookup)', () => {
    test('returns the user id for a mapped channel-native id', () => {
      const alice = insertUser('alice@example.com')
      upsertMapping(alice, 'slack', 'U01ABC')
      expect(getUserIdForChannelIdentity('slack', 'U01ABC')).toBe(alice)
    })

    test('returns null when no mapping exists for the (channelType, channelUserId) pair', () => {
      expect(getUserIdForChannelIdentity('slack', 'U_UNKNOWN')).toBeNull()
    })

    test('scoped per channel — the same channelUserId on a different channel does not match', () => {
      const alice = insertUser('alice@example.com')
      upsertMapping(alice, 'slack', '12345')
      // discord uses snowflakes that look like numeric strings too;
      // ensure the channel discriminator is actually checked.
      expect(getUserIdForChannelIdentity('slack', '12345')).toBe(alice)
      expect(getUserIdForChannelIdentity('discord', '12345')).toBeNull()
    })

    test('trims whitespace before matching (mirrors upsert normalisation)', () => {
      const alice = insertUser('alice@example.com')
      upsertMapping(alice, 'slack', 'U01')
      expect(getUserIdForChannelIdentity('slack', '  U01  ')).toBe(alice)
    })

    test('rejects empty/whitespace-only channelUserId', () => {
      expect(getUserIdForChannelIdentity('slack', '')).toBeNull()
      expect(getUserIdForChannelIdentity('slack', '   ')).toBeNull()
    })
  })

  describe('resolveInboundUserId (unified resolver)', () => {
    test('messaging channels delegate to channel_identity_mappings', () => {
      const alice = insertUser('alice@example.com')
      upsertMapping(alice, 'telegram', '9876543')
      expect(resolveInboundUserId('telegram', '9876543')).toBe(alice)
      expect(resolveInboundUserId('telegram', 'unknown')).toBeNull()
    })

    test('email resolves via users.email (case-insensitive)', () => {
      const alice = insertUser('alice@example.com')
      expect(resolveInboundUserId('email', 'alice@example.com')).toBe(alice)
      expect(resolveInboundUserId('email', 'Alice@Example.com')).toBe(alice)
      expect(resolveInboundUserId('email', 'ALICE@EXAMPLE.COM')).toBe(alice)
    })

    test('email returns null when no matching user exists', () => {
      insertUser('alice@example.com')
      expect(resolveInboundUserId('email', 'stranger@example.com')).toBeNull()
    })

    test('email is independent from channel_identity_mappings rows', () => {
      // Even if a user has a slack mapping with an email-like string,
      // we never bridge across types — email goes to users.email only.
      const alice = insertUser('alice@example.com')
      upsertMapping(alice, 'slack', 'alice@example.com')
      // The slack row exists but we're asking via 'email' — must resolve
      // through users.email, not channel_identity_mappings.
      expect(resolveInboundUserId('email', 'alice@example.com')).toBe(alice)
    })
  })
})
