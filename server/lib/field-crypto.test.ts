import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setupTestEnv, type TestEnv } from '../__tests__/utils/env'
import {
  _resetFieldCryptoCache,
  decryptField,
  encryptField,
  hasFieldCryptoKey,
  isEncryptedField,
} from './field-crypto'

// A syntactically valid (randomly generated, unused) age identity file.
const FAKE_AGE_TXT = [
  '# created: 2026-06-11T00:00:00Z',
  '# public key: age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
  'AGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ',
].join('\n')

describe('field-crypto', () => {
  let env: TestEnv
  beforeEach(() => {
    env = setupTestEnv()
  })
  afterEach(() => env.cleanup())

  function writeKey(content = FAKE_AGE_TXT): void {
    writeFileSync(join(env.fulcrumDir, 'age.txt'), content)
    _resetFieldCryptoCache()
  }

  describe('without a key', () => {
    test('hasFieldCryptoKey is false and encryptField passes through', () => {
      expect(hasFieldCryptoKey()).toBe(false)
      expect(encryptField('secret-token')).toBe('secret-token')
    })

    test('decryptField passes plaintext through', () => {
      expect(decryptField('plain-value')).toBe('plain-value')
    })

    test('decryptField returns ciphertext as-is when key is gone', () => {
      writeKey()
      const ct = encryptField('secret')
      // Simulate key loss: new env dir without age.txt
      env.cleanup()
      env = setupTestEnv()
      expect(decryptField(ct)).toBe(ct)
    })
  })

  describe('with a key', () => {
    beforeEach(() => writeKey())

    test('roundtrips a value', () => {
      const ct = encryptField('ya29.a0AfH6SMC-token')
      expect(ct.startsWith('enc:v1:')).toBe(true)
      expect(isEncryptedField(ct)).toBe(true)
      expect(decryptField(ct)).toBe('ya29.a0AfH6SMC-token')
    })

    test('does not double-encrypt', () => {
      const ct = encryptField('value')
      expect(encryptField(ct)).toBe(ct)
    })

    test('unique IV per encryption', () => {
      expect(encryptField('same')).not.toBe(encryptField('same'))
    })

    test('handles empty strings and unicode', () => {
      expect(decryptField(encryptField(''))).toBe('')
      expect(decryptField(encryptField('pässwörd 密码 🤖'))).toBe('pässwörd 密码 🤖')
    })

    test('tampered ciphertext fails closed (returns value, not garbage plaintext)', () => {
      const ct = encryptField('secret')
      const tampered = ct.slice(0, -4) + 'AAAA'
      expect(decryptField(tampered)).toBe(tampered)
    })

    test('a different key cannot decrypt', () => {
      const ct = encryptField('secret')
      writeKey(FAKE_AGE_TXT.replace(/Q{10}$/, 'ZZZZZZZZZZ'))
      expect(decryptField(ct)).toBe(ct)
    })
  })

  describe('drizzle integration (googleAccounts roundtrip)', () => {
    test('tokens are ciphertext on disk but plaintext through the ORM', async () => {
      writeKey()
      const { db, googleAccounts, getSqlite } = await import('../db')
      const { eq } = await import('drizzle-orm')

      const now = new Date().toISOString()
      db.insert(googleAccounts)
        .values({
          id: 'crypto-acct-1',
          name: 'Crypto Test',
          accessToken: 'access-plain',
          refreshToken: 'refresh-plain',
          ownerUserId: 'user-1',
          createdAt: now,
          updatedAt: now,
        })
        .run()

      // Through Drizzle: decrypted transparently.
      const row = db.select().from(googleAccounts).where(eq(googleAccounts.id, 'crypto-acct-1')).get()
      expect(row?.accessToken).toBe('access-plain')
      expect(row?.refreshToken).toBe('refresh-plain')

      // Raw on disk: ciphertext.
      const raw = getSqlite()!
        .query("SELECT access_token AS a, refresh_token AS r FROM google_accounts WHERE id = 'crypto-acct-1'")
        .get() as { a: string; r: string }
      expect(raw.a.startsWith('enc:v1:')).toBe(true)
      expect(raw.r.startsWith('enc:v1:')).toBe(true)
    })

    test('boot migration encrypts pre-existing plaintext rows', async () => {
      writeKey()
      const { db, googleAccounts, getSqlite } = await import('../db')
      const { encryptExistingDbSecrets } = await import('../db/encrypt-at-rest')
      const { eq } = await import('drizzle-orm')

      // Touch the lazy db proxy so the sqlite handle exists.
      db.select().from(googleAccounts).all()

      // Simulate a legacy plaintext row via raw SQL (bypasses encryption).
      const sqlite = getSqlite()!
      sqlite.run(
        `INSERT INTO google_accounts (id, name, access_token, refresh_token, owner_user_id, created_at, updated_at)
         VALUES ('legacy-1', 'Legacy', 'legacy-access', 'legacy-refresh', 'user-1', '2026-01-01', '2026-01-01')`
      )

      encryptExistingDbSecrets(sqlite)

      const raw = sqlite
        .query("SELECT access_token AS a FROM google_accounts WHERE id = 'legacy-1'")
        .get() as { a: string }
      expect(raw.a.startsWith('enc:v1:')).toBe(true)

      // And the ORM still reads the original value.
      const row = db.select().from(googleAccounts).where(eq(googleAccounts.id, 'legacy-1')).get()
      expect(row?.accessToken).toBe('legacy-access')
      expect(row?.refreshToken).toBe('legacy-refresh')
    })
  })
})
