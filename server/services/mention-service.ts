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
import { parseMentions, parseDisplayNameMentions } from './mention-parser'
import { broadcastToTopic } from '../websocket/terminal-ws'
import { effectiveRole } from './access-control-service'

const logger = createLogger('MentionService')

export { parseMentions, parseDisplayNameMentions }

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
  const names = parseDisplayNameMentions(text)
  const allUsers = emails.length || names.length ? db.select().from(users).all() : []

  // Email lookup is exact (case-insensitive — emails were lowercased on
  // upsert). Display-name lookup is case-insensitive too, but ONLY counts
  // when the name resolves to a single user — ambiguous names (e.g. two
  // "Bob"s) silently no-op rather than mention both.
  const matchedSet = new Map<string, User>()
  for (const u of allUsers) {
    if (emails.includes(u.email)) matchedSet.set(u.id, u)
  }
  for (const name of names) {
    const candidates = allUsers.filter(
      (u) => (u.displayName ?? '').toLowerCase() === name.toLowerCase()
    )
    if (candidates.length === 1) {
      matchedSet.set(candidates[0].id, candidates[0])
    }
  }
  const matchedUsers: User[] = Array.from(matchedSet.values())

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

  // D-4 PR 2: fan out a typed WS event per mention so subscribed clients
  // light up the UI without waiting for the user to navigate. Each event
  // targets the resource topic (task:<id> / project:<id>) AND the `me`
  // topic (delivered iff the recipient socket has `me` subscribed and
  // userId matches). Notifications below (Slack/Discord/Gmail/etc.) keep
  // running in parallel — overlap is acceptable.
  //
  // D-4 PR 4: skip the WS broadcast for users who can't actually see the
  // source (restricted resource, no grant). Same user is still notified
  // via the external channels below — those are out-of-band by design
  // ("Slack told me I was mentioned somewhere I can't access"). But the
  // in-app toast would dead-end on a 404 click-through, so we suppress.
  const skipResourceType = opts.sourceType === 'comment' ? null : opts.sourceType
  for (const u of opts.added) {
    if (skipResourceType !== null) {
      const role = effectiveRole(u.id, skipResourceType, opts.sourceId)
      if (role === null) continue
    }
    if (opts.sourceType === 'task') {
      broadcastToTopic(
        `task:${opts.sourceId}`,
        {
          type: 'task:mentioned',
          payload: {
            taskId: opts.sourceId,
            mentionedUserId: u.id,
            authorEmail: opts.authorEmail ?? null,
          },
        },
        { toUserIds: new Set([u.id]) }
      )
    } else if (opts.sourceType === 'project') {
      broadcastToTopic(
        `project:${opts.sourceId}`,
        {
          type: 'project:mentioned',
          payload: {
            projectId: opts.sourceId,
            mentionedUserId: u.id,
            authorEmail: opts.authorEmail ?? null,
          },
        },
        { toUserIds: new Set([u.id]) }
      )
    }
  }

  for (const u of opts.added) {
    // D-7 PR 1: pass the recipient so the dispatcher merges this user's
    // notification preferences (toast/desktop/sound/pushover toggles +
    // per-user Pushover key) over the tenant defaults, and limits the UI
    // broadcast to the recipient's own sockets.
    sendNotification(
      {
        title: `You were mentioned${by}`,
        message: `${opts.sourceType === 'task' ? 'Task' : 'Project'}: ${opts.sourceTitle}`,
        type: 'mention',
        taskId: opts.sourceType === 'task' ? opts.sourceId : undefined,
        taskTitle: opts.sourceType === 'task' ? opts.sourceTitle : undefined,
        url,
      },
      { recipientUserId: u.id }
    ).catch((err: unknown) => {
      logger.warn('Mention notification dispatch failed', {
        userId: u.id,
        sourceType: opts.sourceType,
        sourceId: opts.sourceId,
        error: err instanceof Error ? err.message : String(err),
      })
    })
  }
}

/**
 * Build the `text` blob fed to `syncMentionsForSource` from a source row.
 * Concatenates `description` + `notes` (each may be null). Centralized so
 * every caller is consistent and any future change (e.g. adding a third
 * field, or stripping markdown) lands in exactly one place.
 */
export function buildMentionText(source: {
  description?: string | null
  notes?: string | null
}): string {
  return `${source.description ?? ''}\n${source.notes ?? ''}`
}

/**
 * One-shot helper: sync the mention table for a source and dispatch
 * notifications for any newly mentioned users. Wraps the
 * sync-then-notify pair that every route used to repeat by hand.
 */
export function syncAndNotify(opts: {
  sourceType: MentionSourceType
  sourceId: string
  sourceTitle: string
  text: string | null | undefined
  authorEmail?: string | null
}): SyncResult {
  const result = syncMentionsForSource(opts.sourceType, opts.sourceId, opts.text)
  notifyMentions({
    added: result.added,
    sourceType: opts.sourceType,
    sourceId: opts.sourceId,
    sourceTitle: opts.sourceTitle,
    authorEmail: opts.authorEmail,
  })
  return result
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
