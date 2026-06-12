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
import type { ServerMessage } from '../types'

interface ExecutorConnection {
  nodeId: string
  ownerUserId: string
  name: string
  platform: string | null
  version: string | null
  connectedAt: string
}

interface RelayTerminalDescriptor {
  terminalId: string
  name: string
  cwd: string
  cols: number
  rows: number
}

interface ExecutorClientMessage {
  type:
    | 'executor:register'
    | 'executor:heartbeat'
    | 'relay:terminal-created'
    | 'relay:terminal-output'
    | 'relay:terminal-buffer'
    | 'relay:terminal-exit'
  payload?: {
    nodeId?: string
    name?: string
    platform?: string
    version?: string
    /** PR 2: live relay terminals on the node, sent with register so the
     * hub rebuilds its routing map after either side restarts. */
    terminals?: RelayTerminalDescriptor[]
    // relay fields
    reqId?: string
    terminalId?: string
    ok?: boolean
    error?: string
    data?: string
    exitCode?: number
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
type BroadcastFn = (message: ServerMessage) => void
type BroadcastToTerminalFn = (terminalId: string, message: ServerMessage) => void
let broadcastFn: BroadcastFn | null = null
let broadcastToTerminalFn: BroadcastToTerminalFn | null = null

export function setExecutorBroadcast(
  broadcast: BroadcastFn,
  broadcastToTerminal?: BroadcastToTerminalFn
): void {
  broadcastFn = broadcast
  broadcastToTerminalFn = broadcastToTerminal ?? null
}

function broadcastNodeStatus(nodeId: string, online: boolean): void {
  broadcastFn?.({ type: 'executor:status', payload: { nodeId, online } })
}

// ---------------------------------------------------------------------------
// PR 2: terminal relay (hub side)
//
// Node-backed terminals keep the browser-facing protocol untouched — the
// terminal-ws handler asks `isRelayTerminal()` and forwards through the
// functions below instead of the local PTYManager. Routing state is
// in-memory; nodes resend their live terminal list on (re)register so the
// map survives restarts on either side.
// ---------------------------------------------------------------------------

export interface RelayTerminalInfo {
  id: string
  name: string
  cwd: string
  status: 'running' | 'exited' | 'error'
  cols: number
  rows: number
  createdAt: number
  /** Relay terminals never belong to a tab; present for TerminalInfo shape parity. */
  tabId?: string
  positionInTab?: number
  /** Which execution node this terminal lives on. */
  nodeId: string
}

const RELAY_CREATE_TIMEOUT_MS = 10_000

const relayTerminals = new Map<string, RelayTerminalInfo>()
const pendingCreates = new Map<
  string,
  { onCreated: (info: RelayTerminalInfo) => void; onError: (error: string) => void; timer: ReturnType<typeof setTimeout> }
>()
// attach waiters: terminalId → callbacks expecting the replay buffer
const pendingAttaches = new Map<string, Array<(buffer: string) => void>>()

function socketForNode(nodeId: string): WSContext | null {
  for (const [ws, conn] of connections.entries()) {
    if (conn.nodeId === nodeId) return ws
  }
  return null
}

function sendToNode(nodeId: string, message: unknown): boolean {
  const ws = socketForNode(nodeId)
  if (!ws) return false
  try {
    ws.send(JSON.stringify(message))
    return true
  } catch {
    return false
  }
}

export function isRelayTerminal(terminalId: string): boolean {
  return relayTerminals.has(terminalId)
}

export function listRelayTerminals(): RelayTerminalInfo[] {
  return Array.from(relayTerminals.values())
}

export function relayCreateTerminal(
  options: { nodeId: string; name: string; cwd?: string; cols: number; rows: number; taskId?: string },
  callbacks: { onCreated: (info: RelayTerminalInfo) => void; onError: (error: string) => void }
): void {
  const { nodeId } = options
  if (!socketForNode(nodeId)) {
    callbacks.onError('Execution node is offline')
    return
  }
  const terminalId = crypto.randomUUID()
  const reqId = crypto.randomUUID()
  const timer = setTimeout(() => {
    pendingCreates.delete(reqId)
    callbacks.onError('Execution node did not respond')
  }, RELAY_CREATE_TIMEOUT_MS)
  pendingCreates.set(reqId, {
    timer,
    onError: callbacks.onError,
    onCreated: (info) => {
      relayTerminals.set(info.id, info)
      callbacks.onCreated(info)
    },
  })
  const sent = sendToNode(nodeId, {
    type: 'relay:terminal-create',
    payload: {
      reqId,
      terminalId,
      name: options.name,
      cwd: options.cwd,
      cols: options.cols,
      rows: options.rows,
      taskId: options.taskId,
    },
  })
  if (!sent) {
    clearTimeout(timer)
    pendingCreates.delete(reqId)
    callbacks.onError('Execution node is offline')
    return
  }
  // Stash the metadata the created-reply needs (node echoes reqId + ok).
  const pending = pendingCreates.get(reqId)!
  const baseInfo: RelayTerminalInfo = {
    id: terminalId,
    name: options.name,
    cwd: options.cwd ?? '',
    status: 'running',
    cols: options.cols,
    rows: options.rows,
    createdAt: Date.now(),
    nodeId,
  }
  const originalOnCreated = pending.onCreated
  pending.onCreated = () => originalOnCreated(baseInfo)
}

/** Forward input/resize/destroy for a node-backed terminal. Returns false
 * when the terminal isn't relayed (caller falls through to the local PTY). */
export function relayForward(
  terminalId: string,
  message:
    | { kind: 'input'; data: string }
    | { kind: 'resize'; cols: number; rows: number }
    | { kind: 'destroy' }
): boolean {
  const info = relayTerminals.get(terminalId)
  if (!info) return false
  if (message.kind === 'input') {
    sendToNode(info.nodeId, { type: 'relay:terminal-input', payload: { terminalId, data: message.data } })
  } else if (message.kind === 'resize') {
    info.cols = message.cols
    info.rows = message.rows
    sendToNode(info.nodeId, { type: 'relay:terminal-resize', payload: { terminalId, cols: message.cols, rows: message.rows } })
  } else {
    sendToNode(info.nodeId, { type: 'relay:terminal-destroy', payload: { terminalId } })
    relayTerminals.delete(terminalId)
    broadcastFn?.({ type: 'terminal:destroyed', payload: { terminalId } })
  }
  return true
}

/** Request a buffer replay from the node; resolves via relay:terminal-buffer. */
export function relayAttach(
  terminalId: string,
  opts: { cols?: number; rows?: number },
  onBuffer: (buffer: string) => void
): boolean {
  const info = relayTerminals.get(terminalId)
  if (!info) return false
  const waiters = pendingAttaches.get(terminalId) ?? []
  waiters.push(onBuffer)
  pendingAttaches.set(terminalId, waiters)
  sendToNode(info.nodeId, {
    type: 'relay:terminal-attach',
    payload: { terminalId, cols: opts.cols, rows: opts.rows },
  })
  return true
}

/** Rebuild the routing map for a node from its registration payload. */
function syncNodeTerminals(nodeId: string, descriptors: RelayTerminalDescriptor[]): void {
  const reported = new Set(descriptors.map((d) => d.terminalId))
  // Drop terminals the node no longer has (it restarted, dtach died, etc.)
  for (const [id, info] of relayTerminals.entries()) {
    if (info.nodeId === nodeId && !reported.has(id)) {
      relayTerminals.delete(id)
      broadcastFn?.({ type: 'terminal:destroyed', payload: { terminalId: id } })
    }
  }
  for (const d of descriptors) {
    if (!relayTerminals.has(d.terminalId)) {
      relayTerminals.set(d.terminalId, {
        id: d.terminalId,
        name: d.name,
        cwd: d.cwd,
        status: 'running',
        cols: d.cols,
        rows: d.rows,
        createdAt: Date.now(),
        nodeId,
      })
    }
  }
}

function handleRelayMessage(nodeId: string, message: ExecutorClientMessage): void {
  const p = message.payload ?? {}

  // Terminal-scoped messages must come from the node that owns the
  // terminal — node A can't inject output into node B's terminals.
  const ownsTerminal = (terminalId: string | undefined): terminalId is string => {
    if (!terminalId) return false
    const info = relayTerminals.get(terminalId)
    return !!info && info.nodeId === nodeId
  }

  switch (message.type) {
    case 'relay:terminal-created': {
      if (!p.reqId) return
      const pending = pendingCreates.get(p.reqId)
      if (!pending) return
      pendingCreates.delete(p.reqId)
      clearTimeout(pending.timer)
      if (p.ok) {
        pending.onCreated(undefined as never) // baseInfo captured in closure
      } else {
        pending.onError(p.error ?? 'Execution node failed to create terminal')
      }
      return
    }
    case 'relay:terminal-output': {
      if (!ownsTerminal(p.terminalId) || typeof p.data !== 'string') return
      broadcastToTerminalFn?.(p.terminalId, {
        type: 'terminal:output',
        payload: { terminalId: p.terminalId, data: p.data },
      })
      return
    }
    case 'relay:terminal-buffer': {
      if (!ownsTerminal(p.terminalId)) return
      const waiters = pendingAttaches.get(p.terminalId)
      pendingAttaches.delete(p.terminalId)
      for (const cb of waiters ?? []) cb(p.data ?? '')
      return
    }
    case 'relay:terminal-exit': {
      if (!ownsTerminal(p.terminalId)) return
      const info = relayTerminals.get(p.terminalId)
      if (info) info.status = 'exited'
      broadcastFn?.({
        type: 'terminal:exit',
        payload: { terminalId: p.terminalId, exitCode: p.exitCode ?? 0, status: 'exited' },
      })
      return
    }
  }
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
        // PR 2: rebuild the relay routing map from the node's live list.
        syncNodeTerminals(nodeId, message.payload?.terminals ?? [])
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

      // PR 2: relay traffic — only from sockets that completed registration.
      if (message.type.startsWith('relay:')) {
        const conn = connections.get(ws)
        if (!conn) return
        handleRelayMessage(conn.nodeId, message)
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
