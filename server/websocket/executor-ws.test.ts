import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import type { Context } from 'hono'
import type { WSContext } from 'hono/ws'
import { eq } from 'drizzle-orm'
import { setupTestEnv, type TestEnv } from '../__tests__/utils/env'
import { db, users, executorNodes, type User } from '../db'
import type { CurrentUserContext } from '../middleware/current-user'
import { makeExecutorWebSocketHandlers, listOnlineNodeIds } from './executor-ws'

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
})
