import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { Hono } from 'hono'
import { setupTestEnv, type TestEnv } from '../__tests__/utils/env'
import { db, users } from '../db'
import { currentUser, requireAdminUser, requireUser, type CurrentUserContext } from './current-user'
import { mintToken } from '../services/api-token-service'

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

// D-8 PR 3a: Bearer auth path. Precedence is (1) Bearer, (2) CF Access
// header, (3) FULCRUM_DEV_USER_EMAIL. Strict mode: an invalid Bearer 401s
// immediately rather than silently degrading to the CF Access path or
// anonymous — CLI auth bugs surface as auth errors, not permission
// errors at the route layer.
function makeMeApp() {
  const app = new Hono<CurrentUserContext>()
  app.use('*', currentUser)
  app.get('/me', (c) => {
    const u = requireUser(c)
    return c.json({ id: u.id, email: u.email })
  })
  return app
}

describe('Bearer auth (currentUser)', () => {
  let env: TestEnv
  let savedDev: string | undefined
  beforeEach(() => {
    env = setupTestEnv()
    // Isolate from any dev-fallback the parent suite might have set.
    savedDev = process.env.FULCRUM_DEV_USER_EMAIL
    delete process.env.FULCRUM_DEV_USER_EMAIL
  })
  afterEach(() => {
    if (savedDev !== undefined) process.env.FULCRUM_DEV_USER_EMAIL = savedDev
    env.cleanup()
  })

  test('valid Bearer resolves to the token owner regardless of CF Access header', async () => {
    const ownerId = insertUser('owner@example.com')
    const minted = mintToken(ownerId, { name: 'cli' })
    const app = makeMeApp()

    // Bearer beats a conflicting CF Access header — the CLI operator's
    // identity, not the gateway-attached one, wins.
    const res = await app.request('/me', {
      headers: {
        Authorization: `Bearer ${minted.plaintext}`,
        'Cf-Access-Authenticated-User-Email': 'someone-else@example.com',
      },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { id: string; email: string }
    expect(body.id).toBe(ownerId)
    expect(body.email).toBe('owner@example.com')
  })

  test('401 when Bearer is malformed/unknown — does NOT fall back to CF Access', async () => {
    insertUser('cf-user@example.com') // would resolve via CF Access if we fell through
    const app = makeMeApp()
    const res = await app.request('/me', {
      headers: {
        Authorization: 'Bearer not-a-real-token',
        'Cf-Access-Authenticated-User-Email': 'cf-user@example.com',
      },
    })
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('Invalid API token')
  })

  test('no Authorization header → CF Access header path still works', async () => {
    const id = insertUser('cf@example.com')
    const app = makeMeApp()
    const res = await app.request('/me', {
      headers: { 'Cf-Access-Authenticated-User-Email': 'cf@example.com' },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { id: string }
    expect(body.id).toBe(id)
  })
})
