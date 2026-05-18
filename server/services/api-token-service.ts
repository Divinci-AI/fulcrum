/**
 * User API token service (D-8 PR 3a).
 *
 * Mints, lists, looks up, and revokes per-user bearer tokens for the
 * Fulcrum CLI and any future API integration that needs to act-as a
 * specific Fulcrum user. The plaintext is shown to the user ONCE on
 * mint; we persist only the SHA-256 digest.
 *
 * Token format: `fulc_<40 base64url chars>` ≈ 240 bits of entropy.
 * That's well past collision risk and well past brute-force concerns
 * for the lifetime of any single token.
 *
 * The Bearer middleware (extended `currentUser` middleware) uses
 * `resolveBearerUser` for the auth path. Strict mode: an invalid
 * bearer 401s rather than silently downgrading to anonymous, so CLI
 * auth bugs surface immediately instead of looking like permission
 * issues at the route layer.
 */
import { createHash, randomBytes } from 'node:crypto'
import { and, asc, eq } from 'drizzle-orm'
import { db, userApiTokens, type UserApiToken, type User, users } from '../db'
import { createLogger } from '../lib/logger'

const logger = createLogger('ApiTokenService')

const TOKEN_PREFIX = 'fulc_'
const TOKEN_RANDOM_BYTES = 30 // → 40 base64url chars
const PREFIX_VISIBLE_LEN = 12 // characters of plaintext shown in the UI (`fulc_AbCdEfGh`)

function generatePlaintext(): string {
  // 30 bytes → 40 chars after base64url encoding (no padding). Drop any
  // remaining `=` defensively in case Node's API ever pads short outputs.
  const random = randomBytes(TOKEN_RANDOM_BYTES).toString('base64url').replace(/=+$/, '')
  return `${TOKEN_PREFIX}${random}`
}

function hashToken(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex')
}

/**
 * The shape returned by `mintToken`. `plaintext` is present once — at
 * mint time — and never afterwards. The view shape (no plaintext) is
 * returned by every other function.
 */
export interface MintedToken extends UserApiTokenView {
  plaintext: string
}

export interface UserApiTokenView {
  id: string
  userId: string
  name: string
  prefix: string
  createdAt: string
  lastUsedAt: string | null
  expiresAt: string | null
}

function toView(row: UserApiToken): UserApiTokenView {
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    prefix: row.prefix,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt ?? null,
    expiresAt: row.expiresAt ?? null,
  }
}

/**
 * Mint a new API token for `userId`. Returns the plaintext exactly
 * once — store it client-side immediately or it's lost.
 *
 * `opts.expiresAt` is optional. If supplied it must be a future ISO
 * timestamp; expired tokens fail authentication in `resolveBearerUser`.
 */
export function mintToken(
  userId: string,
  opts: { name: string; expiresAt?: string | null }
): MintedToken {
  const name = opts.name.trim()
  if (!name) throw new Error('name is required')
  if (opts.expiresAt) {
    const ts = Date.parse(opts.expiresAt)
    if (Number.isNaN(ts)) throw new Error('expiresAt must be a valid ISO timestamp')
    if (ts <= Date.now()) throw new Error('expiresAt must be in the future')
  }

  const plaintext = generatePlaintext()
  const tokenHash = hashToken(plaintext)
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  const prefix = plaintext.slice(0, PREFIX_VISIBLE_LEN)

  const row: UserApiToken = {
    id,
    userId,
    name,
    tokenHash,
    prefix,
    createdAt: now,
    lastUsedAt: null,
    expiresAt: opts.expiresAt ?? null,
  }
  db.insert(userApiTokens).values(row).run()
  logger.info('Minted API token', { id, userId, name, prefix })
  return { ...toView(row), plaintext }
}

/** List all tokens for a user. Plaintext is never returned. */
export function listTokensForUser(userId: string): UserApiTokenView[] {
  return db
    .select()
    .from(userApiTokens)
    .where(eq(userApiTokens.userId, userId))
    .orderBy(asc(userApiTokens.createdAt))
    .all()
    .map(toView)
}

/** Revoke a token by id, but only if it belongs to `userId`. Returns
 * true if a row was removed. */
export function revokeToken(userId: string, tokenId: string): boolean {
  const existing = db
    .select({ id: userApiTokens.id })
    .from(userApiTokens)
    .where(and(eq(userApiTokens.userId, userId), eq(userApiTokens.id, tokenId)))
    .get()
  if (!existing) return false
  db.delete(userApiTokens).where(eq(userApiTokens.id, existing.id)).run()
  logger.info('Revoked API token', { id: tokenId, userId })
  return true
}

/**
 * Bearer-auth lookup. Hashes the incoming plaintext, finds the matching
 * row, checks expiry, returns the owning user (or null on any miss).
 *
 * Side-effect: touches `lastUsedAt` on the row when the lookup hits.
 * Fire-and-forget — failure to update timing metadata never blocks the
 * request from authenticating.
 */
export function resolveBearerUser(plaintext: string): User | null {
  if (!plaintext || !plaintext.startsWith(TOKEN_PREFIX)) return null
  const tokenHash = hashToken(plaintext)
  const row = db
    .select()
    .from(userApiTokens)
    .where(eq(userApiTokens.tokenHash, tokenHash))
    .get()
  if (!row) return null
  if (row.expiresAt && Date.parse(row.expiresAt) <= Date.now()) return null

  const owner = db.select().from(users).where(eq(users.id, row.userId)).get()
  if (!owner) return null

  // Touch lastUsedAt. Best-effort.
  try {
    db.update(userApiTokens)
      .set({ lastUsedAt: new Date().toISOString() })
      .where(eq(userApiTokens.id, row.id))
      .run()
  } catch {
    // Swallow — auth still succeeds.
  }
  return owner
}
