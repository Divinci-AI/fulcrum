/**
 * Boot-time upgrade: encrypt plaintext secret columns left over from before
 * field-level encryption existed (see lib/field-crypto and encrypted-column).
 *
 * Runs right after migrations on every boot, via raw SQL so it sees the
 * stored values rather than the Drizzle-decrypted view. Idempotent: rows
 * already carrying the `enc:v1:` prefix are skipped, and the whole pass is
 * a no-op when no key is available.
 */
import type { Database } from 'bun:sqlite'
import { encryptField, hasFieldCryptoKey } from '../lib/field-crypto'
import { log } from '../lib/logger'

const SECRET_COLUMNS: Array<{ table: string; columns: string[] }> = [
  { table: 'google_accounts', columns: ['access_token', 'refresh_token'] },
  { table: 'caldav_accounts', columns: ['password', 'google_client_secret', 'oauth_tokens'] },
  { table: 'messaging_connections', columns: ['auth_state'] },
]

export function encryptExistingDbSecrets(sqlite: Database): void {
  if (!hasFieldCryptoKey()) return

  let total = 0
  for (const { table, columns } of SECRET_COLUMNS) {
    for (const column of columns) {
      try {
        const rows = sqlite
          .query(
            `SELECT id, "${column}" AS value FROM "${table}" WHERE "${column}" IS NOT NULL AND "${column}" NOT LIKE 'enc:v1:%'`
          )
          .all() as Array<{ id: string; value: string }>
        for (const row of rows) {
          sqlite.run(`UPDATE "${table}" SET "${column}" = ? WHERE id = ?`, [
            encryptField(String(row.value)),
            row.id,
          ])
          total++
        }
      } catch (err) {
        log.db.warn('encrypt-at-rest pass failed for column', {
          table,
          column,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }
  if (total > 0) {
    log.db.info('Encrypted plaintext DB secrets at rest', { fields: total })
  }
}
