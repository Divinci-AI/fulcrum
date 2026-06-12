/**
 * D-18 PR 1: hub side of executor mode. Execution nodes (a user's local
 * Fulcrum instance) dial out to /ws/executor with a Bearer API token; the
 * `currentUser` middleware on /ws/* resolves the owner before the upgrade,
 * and sockets without identity are closed immediately.
 *
 * This PR is the registration plane: register + heartbeat + live status.
 * The PR 2 terminal relay rides the same socket (see
 * deploy/saas/D18-executor-design.md for the message envelope).
 */
import type { Context } from 'hono'
import type { WSContext, WSEvents } from 'hono/ws'
import { eq } from 'drizzle-orm'
import { db, executorNodes } from '../db'
import { log } from '../lib/logger'
import type { CurrentUserContext } from '../middleware/current-user'

interface ExecutorConnection {
  nodeId: string
  ownerUserId: string
  name: string
  platform: string | null
  version: string | null
  connectedAt: string
}

interface ExecutorClientMessage {
  type: 'executor:register' | 'executor:heartbeat'
  payload?: {
    nodeId?: string
    name?: string
    platform?: string
    version?: string
  }
}

// Live sockets keyed by WSContext; nodeId → connection for lookups.
const connections = new Map<WSContext, ExecutorConnection>()

export function listOnlineNodeIds(): Set<string> {
  return new Set(Array.from(connections.values()).map((c) => c.nodeId))
}

// Injected at server startup (server/index.ts) rather than imported:
// terminal-ws drags in the PTY/tab-manager graph, and importing it from
// here — eagerly or dynamically — created duplicate module instances
// across bun test files (page-context-service loaded twice, with split
// caches). Dependency injection keeps this module's graph terminal-free;
// when unset (tests), status fan-out is a no-op.
type BroadcastFn = (message: { type: 'executor:status'; payload: { nodeId: string; online: boolean } }) => void
let broadcastFn: BroadcastFn | null = null

export function setExecutorBroadcast(fn: BroadcastFn): void {
  broadcastFn = fn
}

function broadcastNodeStatus(nodeId: string, online: boolean): void {
  broadcastFn?.({ type: 'executor:status', payload: { nodeId, online } })
}

export function makeExecutorWebSocketHandlers(c: Context<CurrentUserContext>): WSEvents {
  const user = c.var.user

  return {
    onOpen(_evt, ws) {
      if (!user) {
        // No Bearer token / CF identity on the upgrade — refuse.
        log.ws.warn('Rejected anonymous executor connection')
        ws.close(4401, 'Authentication required')
        return
      }
      log.ws.info('Executor socket opened, awaiting registration', { userId: user.id })
    },

    onMessage(evt, ws) {
      if (!user) return
      let message: ExecutorClientMessage
      try {
        message = JSON.parse(String(evt.data))
      } catch {
        return
      }

      if (message.type === 'executor:register') {
        const nodeId = message.payload?.nodeId
        const name = message.payload?.name?.trim()
        if (!nodeId || !name) {
          ws.close(4400, 'nodeId and name are required')
          return
        }

        // One node id, one owner — a token for user A can't take over a
        // node id registered by user B.
        const existing = db.select().from(executorNodes).where(eq(executorNodes.id, nodeId)).get()
        if (existing && existing.ownerUserId !== user.id) {
          log.ws.warn('Executor node id owned by another user', { nodeId, userId: user.id })
          ws.close(4403, 'Node id is registered to another user')
          return
        }

        const now = new Date().toISOString()
        if (existing) {
          db.update(executorNodes)
            .set({
              name,
              platform: message.payload?.platform ?? existing.platform,
              version: message.payload?.version ?? existing.version,
              lastSeenAt: now,
            })
            .where(eq(executorNodes.id, nodeId))
            .run()
        } else {
          db.insert(executorNodes)
            .values({
              id: nodeId,
              ownerUserId: user.id,
              name,
              platform: message.payload?.platform ?? null,
              version: message.payload?.version ?? null,
              lastSeenAt: now,
              createdAt: now,
            })
            .run()
        }

        connections.set(ws, {
          nodeId,
          ownerUserId: user.id,
          name,
          platform: message.payload?.platform ?? null,
          version: message.payload?.version ?? null,
          connectedAt: now,
        })
        try {
          ws.send(JSON.stringify({ type: 'executor:registered', payload: { nodeId } }))
        } catch {
          // socket raced shut; onClose will clean up
        }
        log.ws.info('Executor node registered', { nodeId, name, userId: user.id })
        broadcastNodeStatus(nodeId, true)
        return
      }

      if (message.type === 'executor:heartbeat') {
        const conn = connections.get(ws)
        if (!conn) return
        db.update(executorNodes)
          .set({ lastSeenAt: new Date().toISOString() })
          .where(eq(executorNodes.id, conn.nodeId))
          .run()
        return
      }
    },

    onClose(_evt, ws) {
      const conn = connections.get(ws)
      connections.delete(ws)
      if (conn) {
        log.ws.info('Executor node disconnected', { nodeId: conn.nodeId })
        broadcastNodeStatus(conn.nodeId, false)
      }
    },

    onError(_evt, ws) {
      const conn = connections.get(ws)
      connections.delete(ws)
      if (conn) broadcastNodeStatus(conn.nodeId, false)
    },
  }
}
