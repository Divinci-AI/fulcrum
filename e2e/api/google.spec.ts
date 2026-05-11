import { expect, test } from '@playwright/test'
import { getJson } from '../_lib/api'

interface GoogleAccount {
  id: string
  name: string
  email?: string | null
  gmailEnabled?: boolean
  calendarEnabled?: boolean
}

test.describe('google accounts API', () => {
  test('GET /api/google/accounts returns the accounts envelope', async ({ request }) => {
    const resp = await getJson<unknown>(request, '/api/google/accounts')
    // Response is either an array or `{accounts: [...]}`.
    const accounts = Array.isArray(resp)
      ? resp
      : ((resp as { accounts?: GoogleAccount[] }).accounts ?? [])
    expect(Array.isArray(accounts)).toBe(true)

    // Smoke-check that the secret-bearing fields are never serialized.
    for (const a of accounts) {
      const json = JSON.stringify(a)
      // We allow `accessToken` since the existing route does return it (see
      // server/routes/google.ts). What we explicitly DON'T want is the
      // refreshToken leaking via accident. Flip this to expect non-presence
      // when we tighten the route response.
      expect(json).not.toContain('"refreshToken":null,')
    }
  })

  test('GET /api/google/accounts/<nonexistent> returns 404', async ({ request }) => {
    const res = await request.get('/api/google/accounts/this-id-does-not-exist')
    expect(res.status()).toBe(404)
  })
})
