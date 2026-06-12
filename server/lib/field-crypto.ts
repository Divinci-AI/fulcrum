/**
 * Field-level encryption for secrets stored in SQLite (OAuth tokens, CalDAV
 * passwords, WhatsApp session keys). Complements fnox: fnox/age encrypts
 * settings in config/fnox.toml; this encrypts DB columns using the SAME key
 * material (~/.fulcrum/age.txt), so backup/restore semantics don't change —
 * whoever holds age.txt can read both.
 *
 * Implementation notes:
 *   - AES-256-GCM via node:crypto. Deliberately NOT the age wire format:
 *     no new dependencies (typage would add a supply-chain surface and an
 *     async API our sync DB layer can't use), and nothing ever needs to
 *     decrypt these fields with the age CLI.
 *   - The 32-byte key is HKDF-SHA256-derived from the AGE-SECRET-KEY-1…
 *     string with a fixed app-specific info label.
 *   - Wire format: `enc:v1:<base64 iv>:<base64 ciphertext||tag>`. Values
 *     without the prefix are legacy plaintext and pass through on read;
 *     `encryptExistingDbSecrets()` (db/encrypt-at-rest.ts) upgrades them
 *     at boot.
 *   - When age.txt is missing (fnox not set up, test envs), encryption
 *     degrades to passthrough so the app keeps working — already-encrypted
 *     values then surface as ciphertext and are logged loudly, since
 *     deleting the key genuinely loses the secrets.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getFulcrumDir } from './settings/paths'

const PREFIX = 'enc:v1:'
const HKDF_INFO = 'fulcrum-db-field-encryption-v1'
const IV_LENGTH = 12
const TAG_LENGTH = 16

// undefined = not loaded yet; null = no key available (passthrough mode)
let cachedKey: Buffer | null | undefined
let warnedNoKey = false
let warnedUndecryptable = false

/** Test hook: clear the cached key so a test can swap FULCRUM_DIR/age.txt. */
export function _resetFieldCryptoCache(): void {
  cachedKey = undefined
  warnedNoKey = false
  warnedUndecryptable = false
}

function loadKey(): Buffer | null {
  if (cachedKey !== undefined) return cachedKey
  try {
    const keyPath = join(getFulcrumDir(), 'age.txt')
    if (!existsSync(keyPath)) {
      cachedKey = null
      return null
    }
    const match = readFileSync(keyPath, 'utf-8').match(/AGE-SECRET-KEY-1[0-9A-Z]+/)
    if (!match) {
      cachedKey = null
      return null
    }
    cachedKey = Buffer.from(
      hkdfSync('sha256', Buffer.from(match[0], 'utf-8'), Buffer.alloc(0), HKDF_INFO, 32)
    )
  } catch {
    // getFulcrumDir can throw in test mode without FULCRUM_DIR — treat as
    // "no key" rather than taking the caller down.
    cachedKey = null
  }
  return cachedKey
}

export function isEncryptedField(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(PREFIX)
}

/** Whether a key is available (age.txt present and parseable). */
export function hasFieldCryptoKey(): boolean {
  return loadKey() !== null
}

/**
 * Encrypt a field value. Passthrough (returns the plaintext) when no key is
 * available. Already-encrypted values are returned unchanged so double
 * encryption can't happen.
 */
export function encryptField(plain: string): string {
  if (isEncryptedField(plain)) return plain
  const key = loadKey()
  if (!key) {
    if (!warnedNoKey) {
      warnedNoKey = true
      // Lazy import to avoid a logger↔settings import cycle at module load.
      void import('./logger').then(({ log }) =>
        log.settings.warn('No age.txt key — DB secret fields are stored unencrypted')
      )
    }
    return plain
  }
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf-8'), cipher.final(), cipher.getAuthTag()])
  return PREFIX + iv.toString('base64') + ':' + ciphertext.toString('base64')
}

/**
 * Decrypt a field value. Non-prefixed values are legacy plaintext and pass
 * through. If the value IS encrypted but can't be decrypted (key deleted or
 * rotated, corrupt row), the ciphertext is returned as-is — downstream auth
 * will fail visibly, which beats crashing every SELECT on the table — and
 * an error is logged once.
 */
export function decryptField(value: string): string {
  if (!isEncryptedField(value)) return value

  const fail = (reason: string): string => {
    if (!warnedUndecryptable) {
      warnedUndecryptable = true
      void import('./logger').then(({ log }) =>
        log.settings.error(
          'Encrypted DB field could not be decrypted — is ~/.fulcrum/age.txt missing or replaced?',
          { reason }
        )
      )
    }
    return value
  }

  const key = loadKey()
  if (!key) return fail('no key available')

  try {
    const [ivB64, dataB64] = value.slice(PREFIX.length).split(':')
    if (!ivB64 || !dataB64) return fail('malformed value')
    const iv = Buffer.from(ivB64, 'base64')
    const data = Buffer.from(dataB64, 'base64')
    if (iv.length !== IV_LENGTH || data.length < TAG_LENGTH) return fail('malformed value')
    const ciphertext = data.subarray(0, data.length - TAG_LENGTH)
    const tag = data.subarray(data.length - TAG_LENGTH)
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf-8')
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err))
  }
}
