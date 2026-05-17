/**
 * Tiny WebSocket helper for the /ws/terminal protocol. Wraps the standard
 * WebSocket global with promise-based send + a typed message queue so tests
 * can `await ws.next('terminal:created')` instead of writing event handlers.
 */
import { WebSocket as WsWithHeaders } from 'ws'

export interface WsMessage {
  type: string
  payload: Record<string, unknown>
}

/**
 * Build a `ws://` (or `wss://`) URL for the given path.
 *
 * `opts.baseUrl` is the explicit, unambiguous path — pass it from prod
 * specs so they target the live deployment rather than localhost.
 * Example:
 *   const PROD_BASE = process.env.FULCRUM_E2E_PROD_URL ?? 'https://fulcrum-acme.divinci.ai'
 *   wsUrl('/ws/terminal', { baseUrl: PROD_BASE })
 *
 * Without `baseUrl`, the fallback chain is:
 *   1. `PLAYWRIGHT_TEST_BASE_URL` — Playwright does NOT auto-export this
 *      from `use.baseURL`, but a `globalSetup` could populate it. Kept
 *      as the first env-var fallback because that's the spec-recommended
 *      shape if you ever want a single env to control everything.
 *   2. `FULCRUM_E2E_PROD_URL` — set on the prod CI / shell path. New in
 *      this fix; previously falling straight to the local URL meant any
 *      prod spec that called `wsUrl()` without an explicit baseUrl
 *      silently hit `localhost:17777` and failed with ECONNREFUSED.
 *   3. `FULCRUM_E2E_LOCAL_URL` — local docker-compose target.
 *   4. `http://localhost:17777` — last-resort default.
 *
 * The explicit `baseUrl` parameter is the only path that's bulletproof
 * across project configs. Prefer it in any new prod-ws spec.
 */
export function wsUrl(path = '/ws/terminal', opts: { baseUrl?: string } = {}): string {
  const base =
    opts.baseUrl ??
    process.env.PLAYWRIGHT_TEST_BASE_URL ??
    process.env.FULCRUM_E2E_PROD_URL ??
    process.env.FULCRUM_E2E_LOCAL_URL ??
    'http://localhost:17777'
  return base.replace(/^http/, 'ws') + path
}

export interface WsClientOptions {
  /** Optional headers to set on the WS handshake. Requires the Node `ws`
   * package since the standard WebSocket API doesn't expose headers.
   * Use for `Cf-Access-Authenticated-User-Email` and similar identity
   * headers the server reads on upgrade. */
  headers?: Record<string, string>
}

export class WsClient {
  private ws: WebSocket | import('ws').WebSocket
  private queue: WsMessage[] = []
  private waiters: Array<{ predicate: (m: WsMessage) => boolean; resolve: (m: WsMessage) => void }> =
    []
  readonly opened: Promise<void>

  constructor(url: string, options: WsClientOptions = {}) {
    if (options.headers && Object.keys(options.headers).length > 0) {
      // Headers require the `ws` package — the standard WebSocket API
      // doesn't expose handshake headers. Use ws-with-headers only when the
      // caller asked for them so the common path stays on the built-in.
      this.ws = new WsWithHeaders(url, { headers: options.headers })
    } else {
      this.ws = new WebSocket(url)
    }
    this.opened = new Promise<void>((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve(), { once: true })
      this.ws.addEventListener('error', (e) => reject(e), { once: true })
    })
    this.ws.addEventListener('message', (ev) => {
      // Normalise the payload across runtimes: browsers give a string for text
      // frames; Node's built-in WebSocket may hand back a Buffer or
      // ArrayBuffer (and `String(Buffer)` is the unhelpful "[object Object]"
      // path). Convert defensively before parsing.
      let raw: string
      const data = (ev as MessageEvent).data as unknown
      if (typeof data === 'string') {
        raw = data
      } else if (data instanceof ArrayBuffer) {
        raw = new TextDecoder('utf-8').decode(data)
      } else if (
        data &&
        typeof data === 'object' &&
        'byteLength' in (data as ArrayBufferView)
      ) {
        raw = new TextDecoder('utf-8').decode(data as ArrayBufferView)
      } else if (
        data &&
        typeof (data as { toString?: () => string }).toString === 'function'
      ) {
        raw = (data as { toString: () => string }).toString()
      } else {
        return
      }
      let msg: WsMessage
      try {
        msg = JSON.parse(raw) as WsMessage
      } catch {
        return
      }
      const idx = this.waiters.findIndex((w) => w.predicate(msg))
      if (idx !== -1) {
        const [w] = this.waiters.splice(idx, 1)
        w.resolve(msg)
      } else {
        this.queue.push(msg)
      }
    })
  }

  send(msg: WsMessage): void {
    this.ws.send(JSON.stringify(msg))
  }

  /**
   * Wait for the next message matching `predicate`. Times out after `timeoutMs`
   * to avoid hanging tests.
   */
  next(predicate: (m: WsMessage) => boolean, timeoutMs = 5000): Promise<WsMessage> {
    const idx = this.queue.findIndex(predicate)
    if (idx !== -1) {
      const [m] = this.queue.splice(idx, 1)
      return Promise.resolve(m)
    }
    return new Promise<WsMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        const wIdx = this.waiters.findIndex((w) => w.resolve === wrappedResolve)
        if (wIdx !== -1) this.waiters.splice(wIdx, 1)
        reject(new Error(`WsClient.next: timeout after ${timeoutMs}ms`))
      }, timeoutMs)
      const wrappedResolve = (m: WsMessage) => {
        clearTimeout(timer)
        resolve(m)
      }
      this.waiters.push({ predicate, resolve: wrappedResolve })
    })
  }

  /** Wait for any message of the given type (string match on `.type`). */
  nextOfType(type: string, timeoutMs = 5000): Promise<WsMessage> {
    return this.next((m) => m.type === type, timeoutMs)
  }

  close(): void {
    this.ws.close()
  }
}
