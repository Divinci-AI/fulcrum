/**
 * Page-context publisher (D-9 Phase C).
 *
 * Maintains a long-lived WebSocket to `/ws/terminal` and sends a
 * `page-context:update` message every time the user navigates or the
 * selected entity changes. The server (services/page-context-service.ts)
 * caches the latest per Fulcrum user; MCP tools then read it via
 * `/api/users/me/page-context`.
 *
 * The connection is shared with the terminal WS — same endpoint,
 * different message type — so we don't multiply socket count per
 * tab. The terminal-attached client subscribes via `subscribe` and
 * we just dispatch our own publish.
 *
 * Reconnects with backoff on disconnect because the user might leave
 * the tab open for hours; one socket per tab over the session.
 */
import { useEffect, useRef } from 'react'
import { usePageContext } from './use-page-context'

const RECONNECT_INITIAL_MS = 1_000
const RECONNECT_MAX_MS = 30_000

function wsUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}/ws/terminal`
}

export function usePageContextPublisher(): void {
  const context = usePageContext()
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectMsRef = useRef<number>(RECONNECT_INITIAL_MS)
  const pendingPayloadRef = useRef<unknown>(null)

  // Maintain the socket — open on mount, reconnect on close.
  useEffect(() => {
    let cancelled = false
    let reconnectTimer: number | null = null

    const connect = () => {
      if (cancelled) return
      const ws = new WebSocket(wsUrl())
      wsRef.current = ws
      ws.addEventListener('open', () => {
        reconnectMsRef.current = RECONNECT_INITIAL_MS
        // Flush any payload that arrived before the socket opened.
        if (pendingPayloadRef.current !== null) {
          try {
            ws.send(JSON.stringify({ type: 'page-context:update', payload: pendingPayloadRef.current }))
          } catch {
            // Ignore — the close handler will requeue via the
            // context-watching effect.
          }
        }
      })
      ws.addEventListener('close', () => {
        if (cancelled) return
        wsRef.current = null
        const delay = reconnectMsRef.current
        reconnectMsRef.current = Math.min(delay * 2, RECONNECT_MAX_MS)
        reconnectTimer = window.setTimeout(connect, delay)
      })
      ws.addEventListener('error', () => {
        // Don't trigger reconnect from here — the close event always
        // follows error, and double-scheduling delays compounds.
      })
    }

    connect()
    return () => {
      cancelled = true
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer)
      const ws = wsRef.current
      wsRef.current = null
      if (ws && ws.readyState === WebSocket.OPEN) ws.close()
    }
  }, [])

  // Translate the rich `usePageContext` shape into the server's
  // payload schema. The shape is intentionally narrower than the
  // frontend's full context — only what an agent would care about
  // when grounding "what is the user looking at?".
  useEffect(() => {
    const visibleEntities: Record<string, string[]> = {}
    const selection: { kind: string; id: string } | null =
      context.taskId
        ? { kind: 'task', id: context.taskId }
        : context.projectId
          ? { kind: 'project', id: context.projectId }
          : context.repositoryId
            ? { kind: 'repository', id: context.repositoryId }
            : context.appId
              ? { kind: 'app', id: context.appId }
              : context.jobId
                ? { kind: 'job', id: context.jobId }
                : null

    const payload = {
      route: context.path,
      selection,
      visibleEntities,
      metadata: {
        pageType: context.pageType,
        ...(context.filters ? { filters: context.filters } : {}),
        ...(context.activeTab ? { activeTab: context.activeTab } : {}),
        ...(context.searchParams ? { searchParams: context.searchParams } : {}),
      },
    }
    pendingPayloadRef.current = payload

    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: 'page-context:update', payload }))
      } catch {
        // If send fails, the close handler will requeue.
      }
    }
  }, [context])
}
