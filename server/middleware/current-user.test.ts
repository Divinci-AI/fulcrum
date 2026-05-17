import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { Hono } from 'hono'
import { setupTestEnv, type TestEnv } from '../__tests__/utils/env'
import { db, users } from '../db'
import { currentUser, requireAdminUser, type CurrentUserContext } from './current-user'

// D-7 PR 2: requireAdminUser composes on top of requireUser. We exercise
// the full middleware stack against an in-process Hono app so the
// HTTPException → Response conversion is observable.

function insertUser(email: string, opts: { isAdmin?: boolean } = {}): string {
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  db.insert(users)
    .values({
      id,
      email,
      isAdmin: opts.isAdmin ?? false,
      createdAt: now,
      updatedAt: now,
    })
    .run()
  return id
}

function makeApp() {
  const app = new Hono<CurrentUserContext>()
  app.use('*', currentUser)
  app.get('/admin-only', (c) => {
    const user = requireAdminUser(c)
    return c.json({ id: user.id, isAdmin: user.isAdmin })
  })
  return app
}

describe('requireAdminUser', () => {
  let env: TestEnv
  beforeEach(() => {
    env = setupTestEnv()
  })
  afterEach(() => env.cleanup())

  test('401 when no identity is present', async () => {
    const app = makeApp()
    const res = await app.request('/admin-only')
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('Authentication required')
  })

  test('403 when authenticated but not an admin', async () => {
    insertUser('non-admin@example.com', { isAdmin: false })
    const app = makeApp()
    const res = await app.request('/admin-only', {
      headers: { 'Cf-Access-Authenticated-User-Email': 'non-admin@example.com' },
    })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('Tenant admin required')
  })

  test('200 when authenticated and isAdmin=true', async () => {
    insertUser('boss@example.com', { isAdmin: true })
    const app = makeApp()
    const res = await app.request('/admin-only', {
      headers: { 'Cf-Access-Authenticated-User-Email': 'boss@example.com' },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { id: string; isAdmin: boolean }
    expect(body.isAdmin).toBe(true)
  })

  test('mixed users: admin passes, peer is rejected with 403', async () => {
    insertUser('admin@example.com', { isAdmin: true })
    insertUser('peer@example.com', { isAdmin: false })
    const app = makeApp()

    const adminRes = await app.request('/admin-only', {
      headers: { 'Cf-Access-Authenticated-User-Email': 'admin@example.com' },
    })
    expect(adminRes.status).toBe(200)

    const peerRes = await app.request('/admin-only', {
      headers: { 'Cf-Access-Authenticated-User-Email': 'peer@example.com' },
    })
    expect(peerRes.status).toBe(403)
  })
})
