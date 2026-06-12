import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import type { Context } from 'hono'
import type { WSContext } from 'hono/ws'
import { eq } from 'drizzle-orm'
import { setupTestEnv, type TestEnv } from '../__tests__/utils/env'
import { db, users, executorNodes, type User } from '../db'
import type { CurrentUserContext } from '../middleware/current-user'
import {
  makeExecutorWebSocketHandlers,
  listOnlineNodeIds,
  isRelayTerminal,
  listRelayTerminals,
  relayAttach,
  relayCreateTerminal,
  relayForward,
  setExecutorBroadcast,
} from './executor-ws'

// These tests drive the WSEvents handlers directly with fake sockets —
// deliberately no @hono/node-ws server: spinning up real sockets in this
// file poisoned mock.module-based suites that run later in the process
// (bun module mocks are process-global). Bearer resolution on the upgrade
// is covered by middleware/current-user.test.ts; this file asserts the
// registration/ownership/lifecycle semantics layered on top.

function insertUser(email: string): string {
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  db.insert(users).values({ id, email, createdAt: now, updatedAt: now }).run()
  return id
}

interface FakeSocket {
  ws: WSContext
  sent: Array<{ type: string; payload?: Record<string, unknown> }>
  closed: { code?: number; reason?: string } | null
}

function makeFakeSocket(): FakeSocket {
  const fake: FakeSocket = { ws: null as unknown as WSContext, sent: [], closed: null }
  fake.ws = {
    send: (data: string) => {
      fake.sent.push(JSON.parse(data))
    },
    close: (code?: number, reason?: string) => {
      fake.closed = { code, reason }
    },
  } as unknown as WSContext
  return fake
}

function handlersFor(user: User | null) {
  const c = { var: { user } } as unknown as Context<CurrentUserContext>
  return makeExecutorWebSocketHandlers(c)
}

function msgEvent(data: unknown): MessageEvent {
  return { data: JSON.stringify(data) } as MessageEvent
}

const closeEvent = {} as CloseEvent

describe('executor-ws', () => {
  let env: TestEnv
  beforeEach(() => {
    env = setupTestEnv()
  })
  afterEach(() => env.cleanup())

  test('identified node registers, shows online, goes offline on close', () => {
    const userId = insertUser('node-owner@example.com')
    const user = db.select().from(users).where(eq(users.id, userId)).get()!
    const handlers = handlersFor(user)
    const sock = makeFakeSocket()

    handlers.onOpen?.({} as Event, sock.ws)
    expect(sock.closed).toBeNull()

    handlers.onMessage?.(
      msgEvent({
        type: 'executor:register',
        payload: { nodeId: 'node-1', name: 'Test Laptop', platform: 'darwin' },
      }),
      sock.ws
    )

    expect(sock.sent.some((m) => m.type === 'executor:registered')).toBe(true)
    expect(listOnlineNodeIds().has('node-1')).toBe(true)

    const row = db.select().from(executorNodes).where(eq(executorNodes.id, 'node-1')).get()
    expect(row?.ownerUserId).toBe(userId)
    expect(row?.name).toBe('Test Laptop')

    handlers.onClose?.(closeEvent, sock.ws)
    expect(listOnlineNodeIds().has('node-1')).toBe(false)
  })

  test('anonymous socket is closed with 4401', () => {
    const handlers = handlersFor(null)
    const sock = makeFakeSocket()
    handlers.onOpen?.({} as Event, sock.ws)
    expect(sock.closed?.code).toBe(4401)
  })

  test('a node id cannot be hijacked by another user', () => {
    const ownerA = insertUser('owner-a@example.com')
    const ownerB = insertUser('owner-b@example.com')
    const now = new Date().toISOString()
    db.insert(executorNodes)
      .values({ id: 'node-x', ownerUserId: ownerA, name: 'A Machine', createdAt: now })
      .run()

    const userB = db.select().from(users).where(eq(users.id, ownerB)).get()!
    const handlers = handlersFor(userB)
    const sock = makeFakeSocket()
    handlers.onOpen?.({} as Event, sock.ws)
    handlers.onMessage?.(
      msgEvent({ type: 'executor:register', payload: { nodeId: 'node-x', name: 'Evil' } }),
      sock.ws
    )

    expect(sock.closed?.code).toBe(4403)
    expect(listOnlineNodeIds().has('node-x')).toBe(false)
    // The original row is untouched.
    const row = db.select().from(executorNodes).where(eq(executorNodes.id, 'node-x')).get()
    expect(row?.ownerUserId).toBe(ownerA)
    expect(row?.name).toBe('A Machine')
  })

  test('heartbeat refreshes lastSeenAt', async () => {
    const userId = insertUser('hb@example.com')
    const user = db.select().from(users).where(eq(users.id, userId)).get()!
    const handlers = handlersFor(user)
    const sock = makeFakeSocket()
    handlers.onOpen?.({} as Event, sock.ws)
    handlers.onMessage?.(
      msgEvent({ type: 'executor:register', payload: { nodeId: 'node-hb', name: 'HB' } }),
      sock.ws
    )
    const before = db.select().from(executorNodes).where(eq(executorNodes.id, 'node-hb')).get()!
    await new Promise((r) => setTimeout(r, 5))
    handlers.onMessage?.(msgEvent({ type: 'executor:heartbeat' }), sock.ws)
    const after = db.select().from(executorNodes).where(eq(executorNodes.id, 'node-hb')).get()!
    expect(after.lastSeenAt! >= before.lastSeenAt!).toBe(true)
    handlers.onClose?.(closeEvent, sock.ws)
  })

  describe('terminal relay (PR 2)', () => {
    function registerNode(email: string, nodeId: string, terminals: unknown[] = []) {
      const userId = insertUser(email)
      const user = db.select().from(users).where(eq(users.id, userId)).get()!
      const handlers = handlersFor(user)
      const sock = makeFakeSocket()
      handlers.onOpen?.({} as Event, sock.ws)
      handlers.onMessage?.(
        msgEvent({ type: 'executor:register', payload: { nodeId, name: `Node ${nodeId}`, terminals } }),
        sock.ws
      )
      return { handlers, sock, userId }
    }

    test('create → forward to node → created reply completes the flow', () => {
      const broadcasts: Array<{ type: string }> = []
      setExecutorBroadcast((m) => broadcasts.push(m))
      const node = registerNode('relay-owner@example.com', 'node-r1')

      let created: { id: string } | null = null
      let error: string | null = null
      relayCreateTerminal(
        { nodeId: 'node-r1', name: 'Task Shell', cwd: '/work', cols: 80, rows: 24 },
        { onCreated: (info) => { created = info }, onError: (e) => { error = e } }
      )

      // Node received the relay create with a hub-assigned terminal id.
      const sent = node.sock.sent.find((m) => m.type === 'relay:terminal-create')
      expect(sent).toBeDefined()
      const terminalId = (sent!.payload as { terminalId: string }).terminalId
      const reqId = (sent!.payload as { reqId: string }).reqId

      // Node confirms.
      node.handlers.onMessage?.(
        msgEvent({ type: 'relay:terminal-created', payload: { reqId, terminalId, ok: true } }),
        node.sock.ws
      )

      expect(error).toBeNull()
      expect(created!.id).toBe(terminalId)
      expect(isRelayTerminal(terminalId)).toBe(true)
      expect(listRelayTerminals().some((t) => t.id === terminalId)).toBe(true)

      // Input/resize forward to the node socket.
      expect(relayForward(terminalId, { kind: 'input', data: 'ls\n' })).toBe(true)
      expect(node.sock.sent.some((m) => m.type === 'relay:terminal-input')).toBe(true)

      // Output from the owner node reaches browsers via the injected fan-out.
      const outputs: Array<{ terminalId: string }> = []
      setExecutorBroadcast((m) => broadcasts.push(m), (tid) => outputs.push({ terminalId: tid }))
      node.handlers.onMessage?.(
        msgEvent({ type: 'relay:terminal-output', payload: { terminalId, data: 'hello' } }),
        node.sock.ws
      )
      expect(outputs.length).toBe(1)

      // Attach round-trip: hub asks, node replies with the buffer.
      let buffer: string | null = null
      expect(relayAttach(terminalId, { cols: 100, rows: 30 }, (b) => { buffer = b })).toBe(true)
      expect(node.sock.sent.some((m) => m.type === 'relay:terminal-attach')).toBe(true)
      node.handlers.onMessage?.(
        msgEvent({ type: 'relay:terminal-buffer', payload: { terminalId, data: 'replayed' } }),
        node.sock.ws
      )
      expect(buffer).toBe('replayed')

      // Destroy clears the registry.
      expect(relayForward(terminalId, { kind: 'destroy' })).toBe(true)
      expect(isRelayTerminal(terminalId)).toBe(false)

      node.handlers.onClose?.(closeEvent, node.sock.ws)
    })

    test('a different node cannot inject output into another node\'s terminal', () => {
      const nodeA = registerNode('owner-x@example.com', 'node-a', [
        { terminalId: 'term-a', name: 'A', cwd: '/a', cols: 80, rows: 24 },
      ])
      const nodeB = registerNode('owner-y@example.com', 'node-b')

      const outputs: string[] = []
      setExecutorBroadcast(() => {}, (tid) => outputs.push(tid))

      // Node B tries to write into node A's terminal — dropped.
      nodeB.handlers.onMessage?.(
        msgEvent({ type: 'relay:terminal-output', payload: { terminalId: 'term-a', data: 'evil' } }),
        nodeB.sock.ws
      )
      expect(outputs.length).toBe(0)

      // The legitimate owner works.
      nodeA.handlers.onMessage?.(
        msgEvent({ type: 'relay:terminal-output', payload: { terminalId: 'term-a', data: 'ok' } }),
        nodeA.sock.ws
      )
      expect(outputs).toEqual(['term-a'])

      nodeA.handlers.onClose?.(closeEvent, nodeA.sock.ws)
      nodeB.handlers.onClose?.(closeEvent, nodeB.sock.ws)
    })

    test('re-register without a terminal drops it from the registry', () => {
      const broadcasts: Array<{ type: string }> = []
      setExecutorBroadcast((m) => broadcasts.push(m))
      const node = registerNode('resync@example.com', 'node-rs', [
        { terminalId: 'stale-term', name: 'Old', cwd: '/x', cols: 80, rows: 24 },
      ])
      expect(isRelayTerminal('stale-term')).toBe(true)
      node.handlers.onClose?.(closeEvent, node.sock.ws)

      // Node restarts and re-registers with no terminals (dtach state lost).
      const user = db.select().from(users).where(eq(users.email, 'resync@example.com')).get()!
      const handlers = handlersFor(user)
      const sock = makeFakeSocket()
      handlers.onOpen?.({} as Event, sock.ws)
      handlers.onMessage?.(
        msgEvent({ type: 'executor:register', payload: { nodeId: 'node-rs', name: 'Node node-rs', terminals: [] } }),
        sock.ws
      )
      expect(isRelayTerminal('stale-term')).toBe(false)
      expect(broadcasts.some((m) => m.type === 'terminal:destroyed')).toBe(true)
      handlers.onClose?.(closeEvent, sock.ws)
    })

    test('create against an offline node errors immediately', () => {
      let error: string | null = null
      relayCreateTerminal(
        { nodeId: 'no-such-node', name: 'X', cols: 80, rows: 24 },
        { onCreated: () => {}, onError: (e) => { error = e } }
      )
      expect(error).toBe('Execution node is offline')
    })
  })
})
