/**
 * User service — manages the users table populated from the
 * `Cf-Access-Authenticated-User-Email` header at the gateway.
 *
 * The table is a record of identities that have ever signed into this
 * Fulcrum instance. Email is the natural key (CF Access guarantees
 * uniqueness within an identity provider). We assign a UUID `id` so other
 * tables can reference users without coupling to email.
 */
import { eq } from 'drizzle-orm'
import { db, users, type User } from '../db'
import { createLogger } from '../lib/logger'

const logger = createLogger('UserService')

/**
 * Upsert a user by email. Returns the canonical row (creating if absent,
 * touching `updatedAt` + `lastSeenAt` if present). Cheap by design — called
 * from the request middleware on every authenticated request.
 */
export function ensureUserByEmail(email: string, opts: { displayName?: string | null } = {}): User {
  const normalized = email.trim().toLowerCase()
  const now = new Date().toISOString()

  const existing = db
    .select()
    .from(users)
    .where(eq(users.email, normalized))
    .get()

  if (existing) {
    db.update(users)
      .set({ lastSeenAt: now, updatedAt: now })
      .where(eq(users.id, existing.id))
      .run()
    // Re-fetch to get the updated row — keeps the return type honest without
    // building it client-side and risking drift.
    return db.select().from(users).where(eq(users.id, existing.id)).get()!
  }

  const id = crypto.randomUUID()
  const row: User = {
    id,
    email: normalized,
    displayName: opts.displayName ?? null,
    avatarUrl: null,
    createdAt: now,
    updatedAt: now,
    lastSeenAt: now,
  }
  db.insert(users).values(row).run()
  logger.info('Created user from first sign-in', { id, email: normalized })
  return row
}

export function getUserById(id: string): User | null {
  return db.select().from(users).where(eq(users.id, id)).get() ?? null
}

export function listUsers(): User[] {
  return db.select().from(users).all()
}
