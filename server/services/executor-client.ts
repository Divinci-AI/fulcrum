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
      const message = JSON.parse(String(evt.data)) as { type?: string }
      if (message.type === 'executor:registered') {
        log.server.info('Executor node registered with remote', { nodeId })
      }
      // PR 2: relay:* messages dispatch to the local PTY manager here.
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
