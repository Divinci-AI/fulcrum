import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import type { ServerType } from '@hono/node-server'
import { setupTestEnv, type TestEnv } from '../__tests__/utils/env'
import { db, users } from '../db'
import { currentUser, type CurrentUserContext } from './current-user'
import { mcpAuth } from './mcp-auth'

function insertUser(email: string): string {
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  db.insert(users)
    .values({ id, email, createdAt: now, updatedAt: now })
    .run()
  return id
}

function makeApp() {
  const app = new Hono<CurrentUserContext>()
  app.use('*', currentUser)
  app.use('*', mcpAuth)
  app.get('/mcp', (c) => c.json({ ok: true }))
  return app
}

describe('mcpAuth', () => {
  let env: TestEnv
  beforeEach(() => {
    env = setupTestEnv()
  })
  afterEach(() => env.cleanup())

  // app.request() has no underlying socket, so getConnInfo throws and the
  // loopback path can never match — exactly the fail-closed behavior we
  // want when connection info is unavailable.
  test('401 for anonymous request with no connection info', async () => {
    const app = makeApp()
    const res = await app.request('/mcp')
    expect(res.status).toBe(401)
  })

  test('200 when CF Access header resolves a user', async () => {
    insertUser('agent@example.com')
    const app = makeApp()
    const res = await app.request('/mcp', {
      headers: { 'Cf-Access-Authenticated-User-Email': 'agent@example.com' },
    })
    expect(res.status).toBe(200)
  })

  describe('over a real socket', () => {
    let server: ServerType
    let url: string

    beforeEach(async () => {
      server = serve({ fetch: makeApp().fetch, port: 0, hostname: '127.0.0.1' })
      const address = server.address()
      if (typeof address === 'object' && address) {
        url = `http://127.0.0.1:${address.port}/mcp`
      }
    })

    afterEach(() => {
      server.close()
    })

    test('200 for direct loopback connection without credentials', async () => {
      const res = await fetch(url)
      expect(res.status).toBe(200)
    })

    test('401 for loopback connection carrying a proxy-forwarding header', async () => {
      const res = await fetch(url, { headers: { 'X-Forwarded-For': '203.0.113.7' } })
      expect(res.status).toBe(401)
    })

    test('401 for loopback connection forwarded via Cloudflare', async () => {
      const res = await fetch(url, { headers: { 'CF-Connecting-IP': '203.0.113.7' } })
      expect(res.status).toBe(401)
    })

    test('forwarded request still passes with an authenticated identity', async () => {
      insertUser('remote@example.com')
      const res = await fetch(url, {
        headers: {
          'X-Forwarded-For': '203.0.113.7',
          'Cf-Access-Authenticated-User-Email': 'remote@example.com',
        },
      })
      expect(res.status).toBe(200)
    })
  })
})
