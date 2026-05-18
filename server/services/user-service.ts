/**
 * User service — manages the users table populated from the
 * `Cf-Access-Authenticated-User-Email` header at the gateway.
 *
 * The table is a record of identities that have ever signed into this
 * Fulcrum instance. Email is the natural key (CF Access guarantees
 * uniqueness within an identity provider). We assign a UUID `id` so other
 * tables can reference users without coupling to email.
 */
import { and, eq, ne, sql } from 'drizzle-orm'
import {
  db,
  users,
  type User,
  userApiTokens,
  channelIdentityMappings,
  notificationPreferences,
  mentions,
  channelMessages,
} from '../db'
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

// D-10 PR 6: admin-driven member removal. Distinguished error types so the
// route layer maps the right HTTP status: self-delete and last-admin-delete
// both → 409 (state conflict), unknown-id → 404.
export class CannotDeleteSelfError extends Error {
  constructor() {
    super('You cannot remove your own account')
    this.name = 'CannotDeleteSelfError'
  }
}

export class CannotDeleteLastAdminError extends Error {
  constructor() {
    super(
      'Refusing to remove the last admin — promote another user first to avoid locking the tenant out'
    )
    this.name = 'CannotDeleteLastAdminError'
  }
}

export interface DeleteUserCleanup {
  tokensDeleted: number
  channelIdentitiesDeleted: number
  notificationPreferencesDeleted: number
  mentionsDeleted: number
  channelMessagesNulledOut: number
}

/**
 * Hard-delete a user + their owned rows + null any references that
 * outlive them (channel messages are kept for the audit trail but
 * stripped of the user attribution).
 *
 * Refuses to delete:
 *   - the caller themselves (`CannotDeleteSelfError`)
 *   - the last admin in the tenant (`CannotDeleteLastAdminError`)
 *
 * Owned rows that get hard-deleted alongside the user:
 *   - user_api_tokens          — revokes their CLI auth immediately
 *   - channel_identity_mappings — their per-user channel routes
 *   - notification_preferences  — their override row
 *   - mentions                  — both directions (their @-mentions of others
 *                                 and others' @-mentions of them)
 *
 * Audit-trail rows preserved (NULL'd in place):
 *   - channel_messages.user_id  — historical inbound attribution we want
 *                                 to keep readable, just disconnected
 *
 * Google + GitHub accounts are intentionally NOT deleted — the operator
 * may want to re-attach them to a future user. Cleanup is a separate
 * action.
 */
export function deleteUserByAdmin(
  callerUserId: string,
  targetId: string
): DeleteUserCleanup {
  if (callerUserId === targetId) {
    throw new CannotDeleteSelfError()
  }
  const target = db.select().from(users).where(eq(users.id, targetId)).get()
  if (!target) {
    throw new Error('User not found')
  }
  if (target.isAdmin) {
    const otherAdminCount = db
      .select({ count: sql<number>`count(*)` })
      .from(users)
      .where(and(eq(users.isAdmin, true), ne(users.id, targetId)))
      .get()
    if (!otherAdminCount || otherAdminCount.count === 0) {
      throw new CannotDeleteLastAdminError()
    }
  }

  const cleanup: DeleteUserCleanup = {
    tokensDeleted: 0,
    channelIdentitiesDeleted: 0,
    notificationPreferencesDeleted: 0,
    mentionsDeleted: 0,
    channelMessagesNulledOut: 0,
  }

  // Count-then-delete for the cleanup report. Bun's drizzle binding
  // doesn't surface `changes` on `.run()` portably, so we count first.
  cleanup.tokensDeleted =
    db.select({ c: sql<number>`count(*)` }).from(userApiTokens).where(eq(userApiTokens.userId, targetId)).get()?.c ?? 0
  cleanup.channelIdentitiesDeleted =
    db.select({ c: sql<number>`count(*)` }).from(channelIdentityMappings).where(eq(channelIdentityMappings.userId, targetId)).get()?.c ?? 0
  cleanup.notificationPreferencesDeleted =
    db.select({ c: sql<number>`count(*)` }).from(notificationPreferences).where(eq(notificationPreferences.userId, targetId)).get()?.c ?? 0
  cleanup.mentionsDeleted =
    db.select({ c: sql<number>`count(*)` }).from(mentions).where(eq(mentions.userId, targetId)).get()?.c ?? 0
  cleanup.channelMessagesNulledOut =
    db.select({ c: sql<number>`count(*)` }).from(channelMessages).where(eq(channelMessages.userId, targetId)).get()?.c ?? 0

  db.delete(userApiTokens).where(eq(userApiTokens.userId, targetId)).run()
  db.delete(channelIdentityMappings).where(eq(channelIdentityMappings.userId, targetId)).run()
  db.delete(notificationPreferences).where(eq(notificationPreferences.userId, targetId)).run()
  db.delete(mentions).where(eq(mentions.userId, targetId)).run()
  db.update(channelMessages).set({ userId: null }).where(eq(channelMessages.userId, targetId)).run()
  db.delete(users).where(eq(users.id, targetId)).run()

  logger.info('Admin deleted user', {
    callerUserId,
    targetId,
    targetEmail: target.email,
    cleanup,
  })

  return cleanup
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
