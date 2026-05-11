import { expect, test } from '@playwright/test'
import { getJson, uniqAlnum } from '../_lib/api'

interface User {
  id: string
  email: string
  displayName: string | null
  avatarUrl: string | null
  createdAt: string
  updatedAt: string
  lastSeenAt: string | null
}

interface MeResponse {
  user: User | null
}

interface UsersListResponse {
  users: User[]
}

test.describe('users API', () => {
  test('GET /api/users/me returns the current user envelope', async ({ request }) => {
    // Without CF Access header in front, the middleware falls back to
    // FULCRUM_DEV_USER_EMAIL. When that's not set either, .user is null.
    // Either shape is valid for this endpoint; just confirm the envelope.
    const me = await getJson<MeResponse>(request, '/api/users/me')
    expect(me).toHaveProperty('user')
    expect(me.user === null || typeof me.user === 'object').toBe(true)
  })

  test('CF-Access-Authenticated-User-Email header creates + returns the user', async ({
    request,
  }) => {
    const email = `${uniqAlnum('e2e_user')}@example.com`
    const me = await getJson<MeResponse>(
      request,
      '/api/users/me'
    )
    // Send with the header explicitly so the middleware path is exercised.
    const res = await request.get('/api/users/me', {
      headers: { 'Cf-Access-Authenticated-User-Email': email },
    })
    const body = (await res.json()) as MeResponse
    expect(body.user).toBeTruthy()
    expect(body.user!.email).toBe(email.toLowerCase())
    expect(body.user!.id).toBeTruthy()
    expect(body.user!.createdAt).toBeTruthy()

    // Listing must include the newly created user.
    const list = await getJson<UsersListResponse>(request, '/api/users')
    expect(list.users.some((u) => u.id === body.user!.id)).toBe(true)

    // 404 on a clearly-unknown id
    const missing = await request.get('/api/users/00000000-0000-0000-0000-000000000000')
    expect(missing.status()).toBe(404)

    // Suppress the unused-await of the first call above — keeping it
    // proves the endpoint returns 200 even without the header.
    expect(me).toHaveProperty('user')
  })

  test('email case is normalized to lowercase on first sight', async ({ request }) => {
    const local = uniqAlnum('mixed_case')
    const upper = `${local}@EXAMPLE.com`
    const res1 = await request.get('/api/users/me', {
      headers: { 'Cf-Access-Authenticated-User-Email': upper },
    })
    const u1 = ((await res1.json()) as MeResponse).user!
    expect(u1.email).toBe(`${local.toLowerCase()}@example.com`)

    // Lookup with lowercase should return the same row (same id).
    const res2 = await request.get('/api/users/me', {
      headers: { 'Cf-Access-Authenticated-User-Email': upper.toLowerCase() },
    })
    const u2 = ((await res2.json()) as MeResponse).user!
    expect(u2.id).toBe(u1.id)
  })
})
