/**
 * Team chat — one flat tenant-wide channel for human-to-human messages,
 * plus 1:1 direct messages. History lives in `team_messages` (DMs are
 * rows with `recipientUserId` set); live delivery is the `team:message`
 * WS event — tenant-wide broadcast() for the channel, participant-scoped
 * broadcastToTopic for DMs. Distinct from `chatSessions` (assistant
 * conversations) and `channelMessages` (external platforms like
 * Slack/WhatsApp).
 *
 * `@mentions` in channel messages resolve via the shared mention-service
 * matcher and fire a targeted WS event + notification per mentioned user.
 * DMs skip mention processing — the recipient already gets the message,
 * and a third party can't see the thread anyway.
 */
import { Hono } from 'hono'
import { and, desc, eq, isNull, lt, or, type SQL } from 'drizzle-orm'
import { db, teamMessages, users } from '../db'
import { requireUser, type CurrentUserContext } from '../middleware/current-user'
import { broadcast, broadcastToTopic } from '../websocket/terminal-ws'
import { matchMentionedUsers } from '../services/mention-service'
import { sendNotification } from '../services/notification-service'
import { log } from '../lib/logger'

const MAX_BODY_LENGTH = 4000
const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 200

const app = new Hono<CurrentUserContext>()

interface TeamMessageView {
  id: string
  authorUserId: string
  authorEmail: string | null
  authorName: string | null
  recipientUserId: string | null
  body: string
  createdAt: string
}

function toView(
  row: typeof teamMessages.$inferSelect,
  author: { email: string; displayName: string | null } | undefined
): TeamMessageView {
  return {
    id: row.id,
    authorUserId: row.authorUserId,
    authorEmail: author?.email ?? null,
    authorName: author?.displayName ?? null,
    recipientUserId: row.recipientUserId ?? null,
    body: row.body,
    createdAt: row.createdAt,
  }
}

/** Channel scope (recipient null) or, with `peerId`, the 1:1 thread
 * between the requesting user and that peer — in either direction. */
function threadScope(userId: string, peerId: string | null): SQL {
  if (!peerId) return isNull(teamMessages.recipientUserId)
  return or(
    and(eq(teamMessages.authorUserId, userId), eq(teamMessages.recipientUserId, peerId)),
    and(eq(teamMessages.authorUserId, peerId), eq(teamMessages.recipientUserId, userId))
  )!
}

// GET /api/team-chat?limit=50&before=<ISO timestamp>&with=<userId>
// Returns messages in chronological order (oldest first within the page).
// `with` switches from the team channel to the DM thread with that user.
app.get('/', (c) => {
  const user = requireUser(c)
  const limit = Math.min(
    Math.max(parseInt(c.req.query('limit') ?? `${DEFAULT_PAGE_SIZE}`, 10) || DEFAULT_PAGE_SIZE, 1),
    MAX_PAGE_SIZE
  )
  const before = c.req.query('before')
  const peerId = c.req.query('with') ?? null

  const scope = threadScope(user.id, peerId)
  const rows = db
    .select()
    .from(teamMessages)
    .where(before ? and(scope, lt(teamMessages.createdAt, before)) : scope)
    .orderBy(desc(teamMessages.createdAt))
    .limit(limit)
    .all()
    .reverse()

  // One pass over users — the tenant user list is small.
  const userRows = db.select().from(users).all()
  const byId = new Map(userRows.map((u) => [u.id, { email: u.email, displayName: u.displayName }]))

  return c.json({
    messages: rows.map((r) => toView(r, byId.get(r.authorUserId))),
    hasMore: rows.length === limit,
  })
})

// POST /api/team-chat — send a message.
// Body: { body: string, recipientUserId?: string } — recipientUserId set
// makes it a DM (delivered only to the two participants).
app.post('/', async (c) => {
  const user = requireUser(c)
  const payload = await c.req.json<{ body?: string; recipientUserId?: string }>()
  const body = typeof payload.body === 'string' ? payload.body.trim() : ''
  if (!body) {
    return c.json({ error: 'body (string) is required' }, 400)
  }
  if (body.length > MAX_BODY_LENGTH) {
    return c.json({ error: `message too long (max ${MAX_BODY_LENGTH} chars)` }, 400)
  }

  const recipientUserId =
    typeof payload.recipientUserId === 'string' && payload.recipientUserId
      ? payload.recipientUserId
      : null
  if (recipientUserId) {
    if (recipientUserId === user.id) {
      return c.json({ error: 'Cannot send a direct message to yourself' }, 400)
    }
    const recipient = db.select().from(users).where(eq(users.id, recipientUserId)).get()
    if (!recipient) {
      return c.json({ error: 'Recipient not found' }, 404)
    }
  }

  const row = {
    id: crypto.randomUUID(),
    authorUserId: user.id,
    recipientUserId,
    body,
    createdAt: new Date().toISOString(),
  }
  db.insert(teamMessages).values(row).run()

  const view = toView(row, { email: user.email, displayName: user.displayName })

  if (recipientUserId) {
    // DM: participants only. Delivery rides the `me` subscription, so an
    // anonymous or non-participant socket never sees the payload.
    broadcastToTopic(
      'team-chat',
      { type: 'team:message', payload: view },
      { toUserIds: new Set([user.id, recipientUserId]) }
    )
  } else {
    broadcast({ type: 'team:message', payload: view })

    // Mentions: targeted WS event (instant in-app toast) + notification
    // (per-user channel prefs: desktop/Slack/Pushover/etc.). Fire-and-forget.
    for (const mentioned of matchMentionedUsers(body)) {
      if (mentioned.id === user.id) continue
      broadcastToTopic(
        'team-chat',
        {
          type: 'chat:mentioned',
          payload: { messageId: row.id, mentionedUserId: mentioned.id, authorEmail: user.email },
        },
        { toUserIds: new Set([mentioned.id]) }
      )
      sendNotification(
        {
          title: `You were mentioned by ${user.displayName?.trim() || user.email}`,
          message: `Team chat: ${body.length > 140 ? `${body.slice(0, 140)}…` : body}`,
          type: 'mention',
        },
        { recipientUserId: mentioned.id }
      ).catch((err: unknown) => {
        log.api.warn('Team-chat mention notification failed', {
          userId: mentioned.id,
          error: err instanceof Error ? err.message : String(err),
        })
      })
    }
  }

  return c.json(view, 201)
})

// DELETE /api/team-chat/:id — author or tenant admin only.
app.delete('/:id', (c) => {
  const user = requireUser(c)
  const id = c.req.param('id')
  const existing = db.select().from(teamMessages).where(eq(teamMessages.id, id)).get()
  if (!existing) {
    return c.json({ error: 'Message not found' }, 404)
  }
  if (existing.authorUserId !== user.id && !user.isAdmin) {
    return c.json({ error: 'Only the author or an admin can delete a message' }, 403)
  }
  db.delete(teamMessages).where(eq(teamMessages.id, id)).run()

  const payload = {
    id,
    authorUserId: existing.authorUserId,
    recipientUserId: existing.recipientUserId ?? null,
  }
  if (existing.recipientUserId) {
    broadcastToTopic(
      'team-chat',
      { type: 'team:message-deleted', payload },
      { toUserIds: new Set([existing.authorUserId, existing.recipientUserId]) }
    )
  } else {
    broadcast({ type: 'team:message-deleted', payload })
  }
  return c.json({ success: true })
})

export default app
