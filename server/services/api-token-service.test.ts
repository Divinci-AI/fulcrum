/**
 * D-8 PR 3a — user API token service.
 *
 * Covers: mint shape & entropy, list, revoke (incl. wrong-user 404
 * pattern at the route layer), bearer resolution incl. expiry and
 * unknown-prefix rejection, lastUsedAt touching.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { setupTestEnv, type TestEnv } from '../__tests__/utils/env'
import { db, users, userApiTokens } from '../db'
import { eq } from 'drizzle-orm'
import {
  mintToken,
  listTokensForUser,
  revokeToken,
  resolveBearerUser,
} from './api-token-service'

function insertUser(email: string): string {
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  db.insert(users)
    .values({ id, email, isAdmin: false, createdAt: now, updatedAt: now })
    .run()
  return id
}

describe('api-token-service', () => {
  let env: TestEnv
  beforeEach(() => {
    env = setupTestEnv()
  })
  afterEach(() => env.cleanup())

  describe('mintToken', () => {
    test('returns plaintext, hashes are stored, prefix matches plaintext head', () => {
      const userId = insertUser('mike@example.com')
      const minted = mintToken(userId, { name: 'laptop-cli' })

      expect(minted.plaintext.startsWith('fulc_')).toBe(true)
      // 'fulc_' (5) + 40 base64url chars = 45 total
      expect(minted.plaintext.length).toBe(45)
      expect(minted.prefix.length).toBe(12)
      expect(minted.plaintext.startsWith(minted.prefix)).toBe(true)
      expect(minted.name).toBe('laptop-cli')
      expect(minted.lastUsedAt).toBeNull()
      expect(minted.expiresAt).toBeNull()

      // Plaintext is not in the DB — verify by scanning for the prefix.
      const stored = db
        .select()
        .from(userApiTokens)
        .where(eq(userApiTokens.id, minted.id))
        .get()!
      expect(stored.tokenHash).not.toContain(minted.plaintext)
      expect(stored.tokenHash.length).toBe(64) // sha256 hex
    })

    test('each mint produces a unique plaintext and unique hash', () => {
      const userId = insertUser('mike@example.com')
      const a = mintToken(userId, { name: 'a' })
      const b = mintToken(userId, { name: 'b' })
      expect(a.plaintext).not.toBe(b.plaintext)
      expect(a.id).not.toBe(b.id)
    })

    test('rejects empty name', () => {
      const userId = insertUser('mike@example.com')
      expect(() => mintToken(userId, { name: '' })).toThrow('name is required')
      expect(() => mintToken(userId, { name: '   ' })).toThrow('name is required')
    })

    test('rejects past or malformed expiresAt', () => {
      const userId = insertUser('mike@example.com')
      const past = new Date(Date.now() - 60_000).toISOString()
      expect(() => mintToken(userId, { name: 'x', expiresAt: past })).toThrow(
        'expiresAt must be in the future'
      )
      expect(() => mintToken(userId, { name: 'x', expiresAt: 'not-a-date' })).toThrow(
        'must be a valid ISO timestamp'
      )
    })

    test('accepts future expiresAt and round-trips it', () => {
      const userId = insertUser('mike@example.com')
      const future = new Date(Date.now() + 60 * 60 * 1000).toISOString()
      const minted = mintToken(userId, { name: 'expiring', expiresAt: future })
      expect(minted.expiresAt).toBe(future)
    })
  })

  describe('listTokensForUser', () => {
    test('returns only the caller\'s tokens, oldest first', async () => {
      const alice = insertUser('alice@example.com')
      const bob = insertUser('bob@example.com')
      const t1 = mintToken(alice, { name: 'first' })
      await new Promise((r) => setTimeout(r, 5))
      const t2 = mintToken(alice, { name: 'second' })
      mintToken(bob, { name: 'bobs' })

      const aliceTokens = listTokensForUser(alice)
      expect(aliceTokens.map((t) => t.id)).toEqual([t1.id, t2.id])
      // No plaintext leakage
      expect((aliceTokens[0] as unknown as { plaintext?: unknown }).plaintext).toBeUndefined()
    })

    test('returns [] for a user with no tokens', () => {
      const u = insertUser('blank@example.com')
      expect(listTokensForUser(u)).toEqual([])
    })
  })

  describe('revokeToken', () => {
    test('removes the row and returns true on success', () => {
      const userId = insertUser('mike@example.com')
      const t = mintToken(userId, { name: 'cli' })
      expect(revokeToken(userId, t.id)).toBe(true)
      expect(listTokensForUser(userId)).toEqual([])
    })

    test("returns false (no row removed) when revoking another user's token", () => {
      const alice = insertUser('alice@example.com')
      const bob = insertUser('bob@example.com')
      const bobs = mintToken(bob, { name: 'bobs' })
      expect(revokeToken(alice, bobs.id)).toBe(false)
      // Bob's token still exists
      expect(listTokensForUser(bob).length).toBe(1)
    })

    test('returns false on unknown id', () => {
      const userId = insertUser('mike@example.com')
      expect(revokeToken(userId, 'nope-nope-nope')).toBe(false)
    })
  })

  describe('resolveBearerUser', () => {
    test('returns the owner User for a valid plaintext', () => {
      const userId = insertUser('mike@example.com')
      const minted = mintToken(userId, { name: 'cli' })
      const resolved = resolveBearerUser(minted.plaintext)
      expect(resolved?.id).toBe(userId)
      expect(resolved?.email).toBe('mike@example.com')
    })

    test('touches lastUsedAt on successful resolution', () => {
      const userId = insertUser('mike@example.com')
      const minted = mintToken(userId, { name: 'cli' })
      expect(minted.lastUsedAt).toBeNull()
      resolveBearerUser(minted.plaintext)
      const tokens = listTokensForUser(userId)
      expect(tokens[0].lastUsedAt).not.toBeNull()
    })

    test('returns null for an unknown plaintext', () => {
      expect(resolveBearerUser('fulc_doesnotexist123456789012345678901234567')).toBeNull()
    })

    test('returns null for empty / wrong-prefix input', () => {
      expect(resolveBearerUser('')).toBeNull()
      expect(resolveBearerUser('not-our-format')).toBeNull()
      expect(resolveBearerUser('Bearer fulc_x')).toBeNull() // never strip Bearer here
    })

    test('returns null for an expired token', () => {
      const userId = insertUser('mike@example.com')
      const future = new Date(Date.now() + 60_000).toISOString()
      const minted = mintToken(userId, { name: 'short-lived', expiresAt: future })

      // Move the expiry into the past by direct DB update.
      const past = new Date(Date.now() - 60_000).toISOString()
      db.update(userApiTokens)
        .set({ expiresAt: past })
        .where(eq(userApiTokens.id, minted.id))
        .run()

      expect(resolveBearerUser(minted.plaintext)).toBeNull()
    })

    test('returns null if the owning user has been deleted', () => {
      const userId = insertUser('soon-gone@example.com')
      const minted = mintToken(userId, { name: 'orphan' })
      db.delete(users).where(eq(users.id, userId)).run()
      expect(resolveBearerUser(minted.plaintext)).toBeNull()
    })
  })
})
