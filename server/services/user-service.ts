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
    isAdmin: false, // D-7 PR 2: never auto-grant on signup. Migration 0082
    // seeded the earliest user as admin; any subsequent admin needs an
    // explicit PATCH /api/users/:id/admin from another admin.
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

/**
 * Update the mutable profile fields of a user. Returns the new row.
 * Pass `null` (or undefined fields) to leave a field unchanged; pass an
 * empty string for displayName to clear it.
 */
export function updateUserProfile(
  id: string,
  patch: { displayName?: string | null; avatarUrl?: string | null }
): User | null {
  const now = new Date().toISOString()
  const updates: Record<string, unknown> = { updatedAt: now }
  if (Object.prototype.hasOwnProperty.call(patch, 'displayName')) {
    const v = patch.displayName
    updates.displayName = typeof v === 'string' && v.trim() !== '' ? v.trim() : null
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'avatarUrl')) {
    const v = patch.avatarUrl
    updates.avatarUrl = typeof v === 'string' && v.trim() !== '' ? v.trim() : null
  }
  db.update(users).set(updates).where(eq(users.id, id)).run()
  return db.select().from(users).where(eq(users.id, id)).get() ?? null
}

/**
 * D-7 PR 2: promote or demote a user's tenant-admin flag. Caller must be a
 * tenant admin (gated at the route layer). Returns the updated row.
 */
export function setUserAdmin(id: string, isAdmin: boolean): User | null {
  const now = new Date().toISOString()
  db.update(users).set({ isAdmin, updatedAt: now }).where(eq(users.id, id)).run()
  return db.select().from(users).where(eq(users.id, id)).get() ?? null
}

// D-8 PR 1: explicit admin-driven user provisioning. Raised when an admin
// invites an email that already corresponds to a row — the route layer maps
// this to HTTP 409 so the client can distinguish "already a member" from a
// generic 400. Other validation failures bubble as plain Errors → 400.
export class DuplicateUserError extends Error {
  constructor(email: string) {
    super(`User with email ${email} already exists`)
    this.name = 'DuplicateUserError'
  }
}

/**
 * D-8 PR 1: admin-invoked pre-provisioning of a user row.
 *
 * Differs from `ensureUserByEmail` (the lazy auto-provision the
 * currentUser middleware uses) in three ways:
 *   1. Throws `DuplicateUserError` if the email already exists — no upsert.
 *   2. Honours an explicit `isAdmin` opt at creation time.
 *   3. Leaves `lastSeenAt` null. The middleware will set it on the user's
 *      first authenticated request, which is also our "have they actually
 *      shown up yet?" signal for the invited-but-never-logged-in UI state.
 *
 * Email validation is intentionally lightweight — just trim/lowercase and
 * require an `@`. Real validation is done by CF Access at the edge before
 * the request reaches this server.
 */
export function createUserByAdmin(
  email: string,
  opts: { isAdmin?: boolean; displayName?: string | null } = {}
): User {
  const normalized = (email ?? '').trim().toLowerCase()
  if (!normalized || !normalized.includes('@')) {
    throw new Error('Invalid email')
  }
  const existing = db
    .select()
    .from(users)
    .where(eq(users.email, normalized))
    .get()
  if (existing) {
    throw new DuplicateUserError(normalized)
  }
  const now = new Date().toISOString()
  const id = crypto.randomUUID()
  const displayName =
    typeof opts.displayName === 'string' && opts.displayName.trim() !== ''
      ? opts.displayName.trim()
      : null
  const row: User = {
    id,
    email: normalized,
    displayName,
    avatarUrl: null,
    isAdmin: opts.isAdmin === true,
    createdAt: now,
    updatedAt: now,
    lastSeenAt: null,
  }
  db.insert(users).values(row).run()
  logger.info('Admin pre-provisioned user', {
    id,
    email: normalized,
    isAdmin: row.isAdmin,
  })
  return row
}
