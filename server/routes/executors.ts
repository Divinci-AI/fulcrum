/**
 * D-18 PR 1: execution node listing. Nodes are strictly per-user — you
 * only ever see (and will only ever route terminals to) your own machines.
 */
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db, executorNodes } from '../db'
import { requireUser, type CurrentUserContext } from '../middleware/current-user'
import { listOnlineNodeIds } from '../websocket/executor-ws'

const app = new Hono<CurrentUserContext>()

app.get('/', (c) => {
  const user = requireUser(c)
  const online = listOnlineNodeIds()
  const rows = db
    .select()
    .from(executorNodes)
    .where(eq(executorNodes.ownerUserId, user.id))
    .all()
  return c.json({
    nodes: rows.map((n) => ({
      id: n.id,
      name: n.name,
      platform: n.platform,
      version: n.version,
      lastSeenAt: n.lastSeenAt,
      online: online.has(n.id),
    })),
  })
})

// DELETE /api/executors/:id — forget a node (e.g. a decommissioned laptop).
app.delete('/:id', (c) => {
  const user = requireUser(c)
  const id = c.req.param('id')
  const node = db.select().from(executorNodes).where(eq(executorNodes.id, id)).get()
  if (!node || node.ownerUserId !== user.id) {
    return c.json({ error: 'Node not found' }, 404)
  }
  db.delete(executorNodes).where(eq(executorNodes.id, id)).run()
  return c.json({ success: true })
})

export default app
