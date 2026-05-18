/**
 * D-8 PR 1 — POST /api/users (admin-invoked pre-provisioning).
 *
 * The service-level behaviour is covered in user-service.test.ts. This
 * file exercises the HTTP wrapper: status codes, admin gating, error
 * mapping (DuplicateUserError → 409, plain Error → 400).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createTestApp } from '../__tests__/fixtures/app'
import { setupTestEnv, type TestEnv } from '../__tests__/utils/env'
import { db, users } from '../db'

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

describe('POST /api/users', () => {
  let env: TestEnv
  beforeEach(() => {
    env = setupTestEnv()
  })
  afterEach(() => env.cleanup())

  test('201 when admin invites a new user', async () => {
    const { post } = createTestApp()
    const res = await post('/api/users', {
      email: 'newbie@example.com',
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as {
      user: { email: string; isAdmin: boolean; lastSeenAt: string | null }
      invitedBy: string
    }
    expect(body.user.email).toBe('newbie@example.com')
    expect(body.user.isAdmin).toBe(false)
    expect(body.user.lastSeenAt).toBeNull()
    expect(body.invitedBy).toBeTruthy()
  })

  test('201 with isAdmin=true creates an admin', async () => {
    const { post } = createTestApp()
    const res = await post('/api/users', {
      email: 'second-admin@example.com',
      isAdmin: true,
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { user: { isAdmin: boolean } }
    expect(body.user.isAdmin).toBe(true)
  })

  test('400 when email is missing or non-string', async () => {
    const { post } = createTestApp()
    const a = await post('/api/users', {})
    expect(a.status).toBe(400)
    const b = await post('/api/users', { email: 12345 })
    expect(b.status).toBe(400)
  })

  test('400 when email is malformed', async () => {
    const { post } = createTestApp()
    const a = await post('/api/users', { email: 'not-an-email' })
    expect(a.status).toBe(400)
    const aBody = (await a.json()) as { error: string }
    expect(aBody.error).toBe('Invalid email')
    const b = await post('/api/users', { email: '   ' })
    expect(b.status).toBe(400)
  })

  test('409 when the email is already registered (case-insensitive)', async () => {
    const { post } = createTestApp()
    const first = await post('/api/users', { email: 'dup@example.com' })
    expect(first.status).toBe(201)
    const second = await post('/api/users', { email: 'DUP@example.com' })
    expect(second.status).toBe(409)
    const body = (await second.json()) as { error: string }
    expect(body.error).toContain('already exists')
  })

  test('403 when caller is not a tenant admin', async () => {
    insertUser('regular@example.com', { isAdmin: false })
    const { post } = createTestApp()
    const res = await post(
      '/api/users',
      { email: 'invited-by-regular@example.com' },
      { 'Cf-Access-Authenticated-User-Email': 'regular@example.com' }
    )
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('Tenant admin required')
  })

  test('401 when no caller identity is present', async () => {
    // createTestApp seeds the test admin and sets FULCRUM_DEV_USER_EMAIL —
    // do that first, then clear the env var so the actual request arrives
    // anonymous (no CF Access header, no env fallback) and requireUser
    // inside requireAdminUser throws 401.
    const { post } = createTestApp()
    const saved = process.env.FULCRUM_DEV_USER_EMAIL
    delete process.env.FULCRUM_DEV_USER_EMAIL
    try {
      const res = await post('/api/users', { email: 'nobody@example.com' })
      expect(res.status).toBe(401)
    } finally {
      if (saved !== undefined) process.env.FULCRUM_DEV_USER_EMAIL = saved
    }
  })

  test('created user immediately shows in GET /api/users', async () => {
    const { get, post } = createTestApp()
    await post('/api/users', { email: 'visible@example.com' })
    const res = await get('/api/users')
    const body = (await res.json()) as { users: Array<{ email: string }> }
    expect(body.users.some((u) => u.email === 'visible@example.com')).toBe(true)
  })
})
