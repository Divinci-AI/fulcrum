/**
 * D-18 PR 1: node side of executor mode. When `executor.enabled` is on and
 * a remote URL + API token are configured, THIS instance dials out to the
 * remote Fulcrum's /ws/executor, registers itself as an execution node, and
 * heartbeats. Outbound-only — works from behind NAT/laptops, and through
 * Cloudflare in front of the SaaS (the Bearer token authenticates the
 * upgrade; see middleware/current-user).
 *
 * PR 2 will handle relay:* messages on this same socket to run terminals
 * locally on behalf of the remote (see deploy/saas/D18-executor-design.md).
 */
import { hostname, platform } from 'node:os'
import { getSettings, updateSettingByPath } from '../lib/settings'
import { log } from '../lib/logger'
import { getPTYManager } from '../terminal/pty-instance'

const HEARTBEAT_MS = 25_000
const BACKOFF_BASE_MS = 1_000
const BACKOFF_MAX_MS = 60_000

let ws: WebSocket | null = null
let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let backoffMs = BACKOFF_BASE_MS
let stopped = true

function getNodeId(): string {
  const settings = getSettings()
  if (settings.executor?.nodeId) return settings.executor.nodeId
  const id = crypto.randomUUID()
  try {
    updateSettingByPath('executor.nodeId', id)
  } catch (err) {
    // Persist failure means a new id next boot — annoying (duplicate node
    // rows) but not fatal. Log so the operator can fix fnox.
    log.server.warn('Could not persist executor node id', { error: String(err) })
  }
  return id
}

function wsUrlFor(remoteUrl: string): string {
  const base = remoteUrl.replace(/\/$/, '')
  return base.replace(/^http/, 'ws') + '/ws/executor'
}

function clearTimers(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
}

function scheduleReconnect(): void {
  if (stopped || reconnectTimer) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connect()
  }, backoffMs)
  backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS)
}

// ---------------------------------------------------------------------------
// PR 2: terminal relay (node side). The hub assigns relay terminal ids; the
// local PTYManager generates its own, so we keep a bidirectional mapping.
// ---------------------------------------------------------------------------

const relayToLocal = new Map<string, string>()
const localToRelay = new Map<string, string>()

interface RelayInbound {
  type?: string
  payload?: {
    reqId?: string
    terminalId?: string
    name?: string
    cwd?: string
    cols?: number
    rows?: number
    data?: string
  }
}

function sendToHub(message: unknown): void {
  try {
    ws?.send(JSON.stringify(message))
  } catch {
    // socket down; reconnect path handles it
  }
}

/** Called from the PTYManager onData callback in index.ts. Forwards output
 * of relay-backed local terminals to the hub. No-op for local terminals. */
export function relayPtyOutput(localTerminalId: string, data: string): void {
  const relayId = localToRelay.get(localTerminalId)
  if (!relayId) return
  sendToHub({ type: 'relay:terminal-output', payload: { terminalId: relayId, data } })
}

/** Called from the PTYManager onExit callback in index.ts. */
export function relayPtyExit(localTerminalId: string, exitCode: number): void {
  const relayId = localToRelay.get(localTerminalId)
  if (!relayId) return
  sendToHub({ type: 'relay:terminal-exit', payload: { terminalId: relayId, exitCode } })
  localToRelay.delete(localTerminalId)
  relayToLocal.delete(relayId)
}

/** Live relay terminals, reported with executor:register so the hub can
 * rebuild its routing map after either side restarts. */
function describeRelayTerminals(): Array<{ terminalId: string; name: string; cwd: string; cols: number; rows: number }> {
  const out: Array<{ terminalId: string; name: string; cwd: string; cols: number; rows: number }> = []
  try {
    const ptyManager = getPTYManager()
    for (const [relayId, localId] of relayToLocal.entries()) {
      const info = ptyManager.getInfo(localId)
      if (info) {
        out.push({ terminalId: relayId, name: info.name, cwd: info.cwd, cols: info.cols, rows: info.rows })
      }
    }
  } catch {
    // PTY manager not initialized yet — report nothing
  }
  return out
}

async function handleRelayMessage(message: RelayInbound): Promise<void> {
  const p = message.payload ?? {}
  const ptyManager = getPTYManager()

  switch (message.type) {
    case 'relay:terminal-create': {
      if (!p.reqId || !p.terminalId || !p.name) return
      try {
        const info = ptyManager.create({
          name: p.name,
          cols: p.cols ?? 80,
          rows: p.rows ?? 24,
          cwd: p.cwd,
        })
        relayToLocal.set(p.terminalId, info.id)
        localToRelay.set(info.id, p.terminalId)
        sendToHub({ type: 'relay:terminal-created', payload: { reqId: p.reqId, terminalId: p.terminalId, ok: true } })
        log.server.info('Relay terminal created', { relayId: p.terminalId, localId: info.id, cwd: info.cwd })
      } catch (err) {
        sendToHub({
          type: 'relay:terminal-created',
          payload: { reqId: p.reqId, terminalId: p.terminalId, ok: false, error: err instanceof Error ? err.message : String(err) },
        })
      }
      return
    }
    case 'relay:terminal-input': {
      const localId = p.terminalId ? relayToLocal.get(p.terminalId) : undefined
      if (localId && typeof p.data === 'string') ptyManager.write(localId, p.data)
      return
    }
    case 'relay:terminal-resize': {
      const localId = p.terminalId ? relayToLocal.get(p.terminalId) : undefined
      if (localId && typeof p.cols === 'number' && typeof p.rows === 'number') {
        ptyManager.resize(localId, p.cols, p.rows)
      }
      return
    }
    case 'relay:terminal-destroy': {
      const localId = p.terminalId ? relayToLocal.get(p.terminalId) : undefined
      if (localId) {
        ptyManager.destroy(localId)
        localToRelay.delete(localId)
        if (p.terminalId) relayToLocal.delete(p.terminalId)
      }
      return
    }
    case 'relay:terminal-attach': {
      const localId = p.terminalId ? relayToLocal.get(p.terminalId) : undefined
      if (!localId || !p.terminalId) return
      // Same sequence the local attach path uses: connect, size to the
      // client, drain, snapshot.
      await ptyManager.attach(localId)
      if (typeof p.cols === 'number' && typeof p.rows === 'number') {
        ptyManager.resize(localId, p.cols, p.rows)
      }
      await ptyManager.flushPending(localId)
      const buffer = ptyManager.getBuffer(localId) ?? ''
      sendToHub({ type: 'relay:terminal-buffer', payload: { terminalId: p.terminalId, data: buffer } })
      return
    }
  }
}

function connect(): void {
  if (stopped) return
  const { executor } = getSettings()
  if (!executor?.enabled || !executor.remoteUrl || !executor.apiToken) return

  const url = wsUrlFor(executor.remoteUrl)
  const nodeId = getNodeId()
  const nodeName = executor.nodeName?.trim() || hostname()

  log.server.info('Executor client connecting', { url, nodeId })
  // Bun's WebSocket supports custom headers — this is server-to-server,
  // not a browser socket.
  const socket = new WebSocket(url, {
    headers: { Authorization: `Bearer ${executor.apiToken}` },
  } as unknown as string[])
  ws = socket

  socket.onopen = () => {
    backoffMs = BACKOFF_BASE_MS
    socket.send(
      JSON.stringify({
        type: 'executor:register',
        payload: {
          nodeId,
          name: nodeName,
          platform: platform(),
          version: process.env.npm_package_version ?? null,
          terminals: describeRelayTerminals(),
        },
      })
    )
    heartbeatTimer = setInterval(() => {
      try {
        socket.send(JSON.stringify({ type: 'executor:heartbeat' }))
      } catch {
        // close handler will reconnect
      }
    }, HEARTBEAT_MS)
  }

  socket.onmessage = (evt) => {
    try {
      const message = JSON.parse(String(evt.data)) as RelayInbound
      if (message.type === 'executor:registered') {
        log.server.info('Executor node registered with remote', { nodeId })
      } else if (message.type?.startsWith('relay:')) {
        void handleRelayMessage(message).catch((err) => {
          log.server.warn('Relay message handling failed', {
            type: message.type,
            error: err instanceof Error ? err.message : String(err),
          })
        })
      }
    } catch {
      // ignore malformed frames
    }
  }

  socket.onclose = (evt) => {
    clearTimers()
    if (ws === socket) ws = null
    if (evt.code === 4401 || evt.code === 4403) {
      // Auth/ownership rejection — retrying won't help until config changes.
      log.server.error('Executor connection rejected by remote', {
        code: evt.code,
        reason: evt.reason,
      })
      return
    }
    if (!stopped) {
      log.server.info('Executor connection closed, will retry', { inMs: backoffMs })
      scheduleReconnect()
    }
  }

  socket.onerror = () => {
    // onclose fires after onerror; reconnect handled there.
  }
}

export function startExecutorClient(): void {
  const { executor } = getSettings()
  if (!executor?.enabled || !executor.remoteUrl || !executor.apiToken) {
    log.server.debug?.('Executor mode not configured; client not started')
    return
  }
  stopped = false
  connect()
}

export function stopExecutorClient(): void {
  stopped = true
  clearTimers()
  if (ws) {
    try {
      ws.close()
    } catch {
      // already closed
    }
    ws = null
  }
}
