/**
 * Drizzle column types for secrets encrypted at rest (see lib/field-crypto).
 *
 * Encryption/decryption happens at the ORM driver boundary, so every read
 * and write through Drizzle is covered transparently — call sites keep
 * working with plaintext values and can't forget to encrypt. Raw `sql`
 * fragments that select these columns directly bypass the mapping and see
 * ciphertext; that's intentional (it's what the boot-time migration in
 * encrypt-at-rest.ts relies on).
 */
import { customType } from 'drizzle-orm/sqlite-core'
import { decryptField, encryptField } from '../lib/field-crypto'

/** TEXT column whose value is encrypted at rest. */
export const encryptedText = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'text'
  },
  toDriver(value) {
    return encryptField(value)
  },
  fromDriver(value) {
    return decryptField(value)
  },
})

/** JSON TEXT column whose serialized value is encrypted at rest. */
export const encryptedJson = customType<{ data: unknown; driverData: string }>({
  dataType() {
    return 'text'
  },
  toDriver(value) {
    return encryptField(JSON.stringify(value))
  },
  fromDriver(value) {
    const plain = decryptField(value)
    try {
      return JSON.parse(plain)
    } catch {
      // Undecryptable ciphertext (or a corrupt row) — surface as null
      // rather than throwing inside every SELECT.
      return null
    }
  },
})
