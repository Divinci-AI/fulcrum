/**
 * Team chat — one flat tenant-wide channel for human-to-human messages.
 * History lives in `team_messages`; live delivery is the `team:message`
 * WS broadcast (tenant-wide, so plain broadcast()). Distinct from
 * `chatSessions` (assistant conversations) and `channelMessages`
 * (external platforms like Slack/WhatsApp).
 */
import { Hono } from 'hono'
import { desc, eq, lt } from 'drizzle-orm'
import { db, teamMessages, users } from '../db'
import { requireUser, type CurrentUserContext } from '../middleware/current-user'
import { broadcast } from '../websocket/terminal-ws'

const MAX_BODY_LENGTH = 4000
const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 200

const app = new Hono<CurrentUserContext>()

interface TeamMessageView {
  id: string
  authorUserId: string
  authorEmail: string | null
  authorName: string | null
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
    body: row.body,
    createdAt: row.createdAt,
  }
}

// GET /api/team-chat?limit=50&before=<ISO timestamp>
// Returns messages in chronological order (oldest first within the page).
app.get('/', (c) => {
  requireUser(c)
  const limit = Math.min(
    Math.max(parseInt(c.req.query('limit') ?? `${DEFAULT_PAGE_SIZE}`, 10) || DEFAULT_PAGE_SIZE, 1),
    MAX_PAGE_SIZE
  )
  const before = c.req.query('before')

  const rows = (
    before
      ? db
          .select()
          .from(teamMessages)
          .where(lt(teamMessages.createdAt, before))
          .orderBy(desc(teamMessages.createdAt))
          .limit(limit)
          .all()
      : db.select().from(teamMessages).orderBy(desc(teamMessages.createdAt)).limit(limit).all()
  ).reverse()

  // One pass over users — the tenant user list is small.
  const userRows = db.select().from(users).all()
  const byId = new Map(userRows.map((u) => [u.id, { email: u.email, displayName: u.displayName }]))

  return c.json({
    messages: rows.map((r) => toView(r, byId.get(r.authorUserId))),
    hasMore: rows.length === limit,
  })
})

// POST /api/team-chat — send a message. Body: { body: string }
app.post('/', async (c) => {
  const user = requireUser(c)
  const payload = await c.req.json<{ body?: string }>()
  const body = typeof payload.body === 'string' ? payload.body.trim() : ''
  if (!body) {
    return c.json({ error: 'body (string) is required' }, 400)
  }
  if (body.length > MAX_BODY_LENGTH) {
    return c.json({ error: `message too long (max ${MAX_BODY_LENGTH} chars)` }, 400)
  }

  const row = {
    id: crypto.randomUUID(),
    authorUserId: user.id,
    body,
    createdAt: new Date().toISOString(),
  }
  db.insert(teamMessages).values(row).run()

  const view = toView(row, { email: user.email, displayName: user.displayName })
  broadcast({ type: 'team:message', payload: view })
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
  broadcast({ type: 'team:message-deleted', payload: { id } })
  return c.json({ success: true })
})

export default app
