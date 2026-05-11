/**
 * Mention service (Phase D-3).
 *
 * Parses free-form text for `@<email>` patterns, syncs the `mentions` table
 * to match (idempotent), and fires a notification on each *new* mention so
 * Mike doesn't get spammed every time a task is re-saved.
 *
 * Recognized format: `@email@domain.tld` preceded by start-of-string or
 * whitespace. This is unambiguous (emails are unique per identity provider
 * in CF Access land) and intentionally strict — `@displayName` lookup is a
 * future enhancement once we have a reason for it.
 */
import { and, eq } from 'drizzle-orm'
import { db, mentions, users, type Mention, type User } from '../db'
import { sendNotification } from './notification-service'
import { getSettings } from '../lib/settings'
import { createLogger } from '../lib/logger'
import { parseMentions } from './mention-parser'

const logger = createLogger('MentionService')

export { parseMentions }

export type MentionSourceType = 'task' | 'project' | 'comment'

interface SyncResult {
  added: User[]   // users newly mentioned in this source
  removed: User[] // users who were mentioned but no longer are
  current: User[] // all users currently mentioned in this source
}

/**
 * Sync the mentions table for one source to match the parsed mention set.
 * Returns which user rows were added vs removed so the caller can decide
 * which side-effects (notifications) to fire. Only users that exist in
 * the users table are mentioned — an unknown email is silently dropped.
 *
 * `text` may be multiple fields concatenated; pass `description + '\n' + notes`
 * for tasks/projects so a mention in either spot counts.
 */
export function syncMentionsForSource(
  sourceType: MentionSourceType,
  sourceId: string,
  text: string | null | undefined
): SyncResult {
  const emails = parseMentions(text)
  const matchedUsers: User[] = emails.length
    ? db.select().from(users).all().filter((u) => emails.includes(u.email))
    : []

  const currentRows = db
    .select()
    .from(mentions)
    .where(and(eq(mentions.sourceType, sourceType), eq(mentions.sourceId, sourceId)))
    .all()
  const currentUserIds = new Set(currentRows.map((r) => r.userId))
  const matchedIds = new Set(matchedUsers.map((u) => u.id))

  const added: User[] = matchedUsers.filter((u) => !currentUserIds.has(u.id))
  const removed: User[] = currentRows
    .filter((r) => !matchedIds.has(r.userId))
    .map((r) => db.select().from(users).where(eq(users.id, r.userId)).get())
    .filter((u): u is User => Boolean(u))

  const now = new Date().toISOString()

  for (const u of added) {
    db.insert(mentions)
      .values({
        id: crypto.randomUUID(),
        sourceType,
        sourceId,
        userId: u.id,
        createdAt: now,
      })
      .run()
  }
  for (const u of removed) {
    db.delete(mentions)
      .where(
        and(
          eq(mentions.sourceType, sourceType),
          eq(mentions.sourceId, sourceId),
          eq(mentions.userId, u.id)
        )
      )
      .run()
  }

  return { added, removed, current: matchedUsers }
}

/**
 * Dispatch notifications for each newly-mentioned user. Fire-and-forget so
 * a flaky notification channel doesn't block the request. Logs but doesn't
 * throw.
 */
export function notifyMentions(opts: {
  added: User[]
  sourceType: MentionSourceType
  sourceId: string
  sourceTitle: string
  authorEmail?: string | null
}): void {
  if (opts.added.length === 0) return
  const publicDomain = getSettings().server.publicDomain
  const baseUrl = publicDomain ? `https://${publicDomain}` : ''
  const path = opts.sourceType === 'task' ? `/tasks/${opts.sourceId}` : `/projects/${opts.sourceId}`
  const url = baseUrl ? `${baseUrl}${path}` : undefined
  const by = opts.authorEmail ? ` by ${opts.authorEmail}` : ''

  for (const u of opts.added) {
    sendNotification({
      title: `You were mentioned${by}`,
      message: `${opts.sourceType === 'task' ? 'Task' : 'Project'}: ${opts.sourceTitle}`,
      type: 'mention',
      taskId: opts.sourceType === 'task' ? opts.sourceId : undefined,
      taskTitle: opts.sourceType === 'task' ? opts.sourceTitle : undefined,
      url,
    }).catch((err: unknown) => {
      logger.warn('Mention notification dispatch failed', {
        userId: u.id,
        sourceType: opts.sourceType,
        sourceId: opts.sourceId,
        error: err instanceof Error ? err.message : String(err),
      })
    })
  }
}

/** List every mention for a given user, newest first. */
export function listMentionsForUser(userId: string): Mention[] {
  return db
    .select()
    .from(mentions)
    .where(eq(mentions.userId, userId))
    .all()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}
