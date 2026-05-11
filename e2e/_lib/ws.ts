/**
 * Tiny WebSocket helper for the /ws/terminal protocol. Wraps the standard
 * WebSocket global with promise-based send + a typed message queue so tests
 * can `await ws.next('terminal:created')` instead of writing event handlers.
 */

export interface WsMessage {
  type: string
  payload: Record<string, unknown>
}

export function wsUrl(path = '/ws/terminal'): string {
  const base =
    process.env.PLAYWRIGHT_TEST_BASE_URL ??
    process.env.FULCRUM_E2E_LOCAL_URL ??
    'http://localhost:17777'
  return base.replace(/^http/, 'ws') + path
}

export class WsClient {
  private ws: WebSocket
  private queue: WsMessage[] = []
  private waiters: Array<{ predicate: (m: WsMessage) => boolean; resolve: (m: WsMessage) => void }> =
    []
  readonly opened: Promise<void>

  constructor(url: string) {
    this.ws = new WebSocket(url)
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
