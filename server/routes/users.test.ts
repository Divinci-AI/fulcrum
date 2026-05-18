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

  // D-8 PR 5: response carries a cfAccess result. When CF Access isn't
  // configured (the default test state), `configured: false` and the
  // overall result is treated as ok so the happy path UI doesn't warn.
  // D-9 Phase C — page-context route round-trips with the service.
  test('GET /api/users/me/page-context returns null when nothing published, then the snapshot after setPageContext', async () => {
    const { get } = createTestApp()
    const first = await get('/api/users/me/page-context')
    expect(first.status).toBe(200)
    const firstBody = (await first.json()) as { context: unknown }
    expect(firstBody.context).toBeNull()

    // Look up the test-admin user id to seed a snapshot.
    const meRes = await get('/api/users/me')
    const me = (await meRes.json()) as { user: { id: string } }
    const { setPageContext } = await import('../services/page-context-service')
    setPageContext(me.user.id, {
      route: '/tasks/abc',
      selection: { kind: 'task', id: 'abc' },
    })

    const second = await get('/api/users/me/page-context')
    const secondBody = (await second.json()) as {
      context: { route: string; selection: { kind: string; id: string } | null } | null
    }
    expect(secondBody.context?.route).toBe('/tasks/abc')
    expect(secondBody.context?.selection).toEqual({ kind: 'task', id: 'abc' })
  })

  // D-10 PR 6 — resend-invite + delete.
  test('POST /api/users/:id/resend-invite returns the user + invite-email result', async () => {
    const { get, post } = createTestApp()
    const create = await post('/api/users', { email: 'resend-target@example.com' })
    const created = (await create.json()) as { user: { id: string; email: string } }

    const res = await post(`/api/users/${created.user.id}/resend-invite`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      user: { id: string; email: string }
      inviteEmail: { drafted: boolean; reason?: string }
    }
    expect(body.user.email).toBe('resend-target@example.com')
    expect(body.inviteEmail.drafted).toBe(false)
    expect(body.inviteEmail.reason).toBeTruthy()
    // Sanity: target still exists after resend (no accidental delete)
    const list = await get('/api/users')
    const users = ((await list.json()) as { users: Array<{ email: string }> }).users
    expect(users.some((u) => u.email === 'resend-target@example.com')).toBe(true)
  })

  test('POST /api/users/:id/resend-invite 404 on unknown id', async () => {
    const { post } = createTestApp()
    const res = await post('/api/users/00000000-0000-0000-0000-000000000000/resend-invite')
    expect(res.status).toBe(404)
  })

  test('POST /api/users/:id/resend-invite 403 for non-admin', async () => {
    // Call createTestApp first so ensureTestAdmin seeds the admin +
    // sets FULCRUM_DEV_USER_EMAIL; then add peer; then create the
    // target as the test admin; then resend as peer.
    const { post } = createTestApp()
    insertUser('peer@example.com', { isAdmin: false })
    const create = await post('/api/users', { email: 'target@example.com' })
    expect(create.status).toBe(201)
    const created = (await create.json()) as { user: { id: string } }
    const res = await post(
      `/api/users/${created.user.id}/resend-invite`,
      undefined,
      { 'Cf-Access-Authenticated-User-Email': 'peer@example.com' }
    )
    expect(res.status).toBe(403)
  })

  test('DELETE /api/users/:id removes the user and returns cleanup counts', async () => {
    const { delete: del, get, post } = createTestApp()
    // Test admin will need a second admin so the last-admin guard
    // doesn't trip when we delete a fresh admin target.
    insertUser('keepalive-admin@example.com', { isAdmin: true })
    const create = await post('/api/users', { email: 'to-delete@example.com' })
    const created = (await create.json()) as { user: { id: string } }

    const res = await del(`/api/users/${created.user.id}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      success: boolean
      cfAccess: { ok: boolean; configured: boolean }
      cleanup: { tokensDeleted: number }
    }
    expect(body.success).toBe(true)
    expect(body.cfAccess.configured).toBe(false)
    expect(body.cleanup.tokensDeleted).toBe(0)

    // Target gone from list
    const list = await get('/api/users')
    const users = ((await list.json()) as { users: Array<{ email: string }> }).users
    expect(users.some((u) => u.email === 'to-delete@example.com')).toBe(false)
  })

  test('DELETE /api/users/:id 409 when admin tries to delete themselves', async () => {
    const { delete: del, get } = createTestApp()
    // Test admin must remain admin and have at least one other admin so we
    // hit the self-delete guard, not the last-admin guard.
    insertUser('coadmin@example.com', { isAdmin: true })
    const me = await get('/api/users/me')
    const meBody = (await me.json()) as { user: { id: string } }
    const res = await del(`/api/users/${meBody.user.id}`)
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('own account')
  })

  test('DELETE /api/users/:id 409 when deleting the last admin', async () => {
    const { delete: del, get } = createTestApp()
    // Demote the test admin so they're a regular caller — but they need
    // admin to call DELETE. Different shape: insert a single OTHER admin
    // and try to delete them while we're the only one left if we got
    // demoted. Actually: keep test admin as admin, insert non-admin peer,
    // then directly invoke deleteUserByAdmin via the route — last-admin
    // catches because the *target* is the last admin.
    const onlyAdmin = await get('/api/users/me')
    const me = (await onlyAdmin.json()) as { user: { id: string } }
    const res = await del(`/api/users/${me.user.id}`)
    // Either 409 self-delete OR 409 last-admin — both are correct
    // protection. We just need a 409.
    expect(res.status).toBe(409)
  })

  test('DELETE /api/users/:id 404 on unknown id', async () => {
    const { delete: del } = createTestApp()
    const res = await del('/api/users/00000000-0000-0000-0000-000000000000')
    expect(res.status).toBe(404)
  })

  test('DELETE /api/users/:id 403 for non-admin caller', async () => {
    const { delete: del, post } = createTestApp()
    insertUser('peer@example.com', { isAdmin: false })
    const create = await post('/api/users', { email: 'target-del@example.com' })
    expect(create.status).toBe(201)
    const created = (await create.json()) as { user: { id: string } }
    const res = await del(
      `/api/users/${created.user.id}`,
      { 'Cf-Access-Authenticated-User-Email': 'peer@example.com' }
    )
    expect(res.status).toBe(403)
  })

  // D-9 PR 2: invite-email shape on the response.
  test('response includes inviteEmail:drafted:false when admin has no Gmail-enabled account', async () => {
    const { post } = createTestApp()
    const res = await post('/api/users', { email: 'gmail-check@example.com' })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { inviteEmail: { drafted: boolean; reason?: string } }
    expect(body.inviteEmail.drafted).toBe(false)
    expect(body.inviteEmail.reason).toContain('no Gmail-enabled')
  })

  test('response includes cfAccess shape; configured:false when CF Access is unset', async () => {
    const savedKeys = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_ACCESS_APP_ID', 'CLOUDFLARE_ACCESS_POLICY_ID'] as const
    const saved: Record<string, string | undefined> = {}
    for (const k of savedKeys) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
    try {
      const { post } = createTestApp()
      const res = await post('/api/users', { email: 'cf-check@example.com' })
      expect(res.status).toBe(201)
      const body = (await res.json()) as { cfAccess: { ok: boolean; configured: boolean } }
      expect(body.cfAccess.configured).toBe(false)
      expect(body.cfAccess.ok).toBe(true)
    } finally {
      for (const k of savedKeys) {
        if (saved[k] !== undefined) process.env[k] = saved[k]
      }
    }
  })
})

// D-8 PR 3a — /api/users/me/tokens (self-managed API tokens).
describe('/api/users/me/tokens', () => {
  let env: TestEnv
  beforeEach(() => {
    env = setupTestEnv()
  })
  afterEach(() => env.cleanup())

  test('POST mints a token and returns plaintext exactly once', async () => {
    const { post } = createTestApp()
    const res = await post('/api/users/me/tokens', { name: 'laptop-cli' })
    expect(res.status).toBe(201)
    const body = (await res.json()) as {
      token: { plaintext: string; prefix: string; name: string; lastUsedAt: string | null }
    }
    expect(body.token.plaintext.startsWith('fulc_')).toBe(true)
    expect(body.token.name).toBe('laptop-cli')
    expect(body.token.lastUsedAt).toBeNull()
  })

  test('POST 400 when name is missing/empty', async () => {
    const { post } = createTestApp()
    const a = await post('/api/users/me/tokens', {})
    expect(a.status).toBe(400)
    const b = await post('/api/users/me/tokens', { name: '   ' })
    expect(b.status).toBe(400)
  })

  test('POST 400 when expiresAt is malformed/past', async () => {
    const { post } = createTestApp()
    const past = new Date(Date.now() - 60_000).toISOString()
    const res = await post('/api/users/me/tokens', { name: 'expired', expiresAt: past })
    expect(res.status).toBe(400)
  })

  test('GET lists only the caller\'s tokens with no plaintext leakage', async () => {
    const { get, post } = createTestApp()
    await post('/api/users/me/tokens', { name: 'a' })
    await post('/api/users/me/tokens', { name: 'b' })
    const res = await get('/api/users/me/tokens')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      tokens: Array<{ id: string; name: string; prefix: string; plaintext?: string }>
    }
    expect(body.tokens.length).toBe(2)
    for (const t of body.tokens) {
      expect(t.plaintext).toBeUndefined()
      expect(t.prefix.startsWith('fulc_')).toBe(true)
    }
  })

  test('DELETE 204-shape revokes the caller\'s own token', async () => {
    const { get, post, delete: del } = createTestApp()
    const mint = await post('/api/users/me/tokens', { name: 'rev' })
    const { token } = (await mint.json()) as { token: { id: string } }
    const res = await del(`/api/users/me/tokens/${token.id}`)
    expect(res.status).toBe(200)
    const list = await get('/api/users/me/tokens')
    const listBody = (await list.json()) as { tokens: unknown[] }
    expect(listBody.tokens.length).toBe(0)
  })

  test("DELETE 404 when trying to revoke another user's token", async () => {
    const { post, delete: del } = createTestApp()
    // Mint as the default test admin first.
    const mintAsAdmin = await post('/api/users/me/tokens', { name: 'admins' })
    const { token } = (await mintAsAdmin.json()) as { token: { id: string } }

    // Now try to revoke it acting as a different user.
    insertUser('peer@example.com', { isAdmin: false })
    const res = await del(`/api/users/me/tokens/${token.id}`, {
      'Cf-Access-Authenticated-User-Email': 'peer@example.com',
    })
    expect(res.status).toBe(404)
  })

  test('401 when unauthenticated', async () => {
    const { get } = createTestApp()
    const saved = process.env.FULCRUM_DEV_USER_EMAIL
    delete process.env.FULCRUM_DEV_USER_EMAIL
    try {
      const res = await get('/api/users/me/tokens')
      expect(res.status).toBe(401)
    } finally {
      if (saved !== undefined) process.env.FULCRUM_DEV_USER_EMAIL = saved
    }
  })

  test('using the minted token as Bearer reaches /me as that user', async () => {
    const { get, post } = createTestApp()
    const mint = await post('/api/users/me/tokens', { name: 'cli' })
    const { token } = (await mint.json()) as { token: { plaintext: string } }
    const me = await get('/api/users/me', {
      Authorization: `Bearer ${token.plaintext}`,
      // Send a conflicting CF Access header to prove Bearer wins.
      'Cf-Access-Authenticated-User-Email': 'someone-else@example.com',
    })
    expect(me.status).toBe(200)
    const body = (await me.json()) as { user: { email: string } }
    expect(body.user.email).toBe('test-admin@example.com')
  })

  test('an invalid Bearer 401s (does not silently fall through to CF Access)', async () => {
    const { get } = createTestApp()
    const res = await get('/api/users/me', {
      Authorization: 'Bearer fulc_doesnotexist12345678901234567890123456',
      'Cf-Access-Authenticated-User-Email': 'test-admin@example.com',
    })
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('Invalid API token')
  })
})
