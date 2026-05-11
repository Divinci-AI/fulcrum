import { expect, test } from '@playwright/test'
import { getJson } from '../_lib/api'

interface CaldavAccount {
  id: string
  name: string
  authType: 'basic' | 'google-oauth'
}

test.describe('caldav API', () => {
  test('GET /api/caldav/accounts returns an array', async ({ request }) => {
    const accounts = await getJson<CaldavAccount[]>(request, '/api/caldav/accounts')
    expect(Array.isArray(accounts)).toBe(true)
    // Each entry, if present, should have at minimum an id + name + authType.
    for (const a of accounts) {
      expect(a).toHaveProperty('id')
      expect(a).toHaveProperty('name')
      expect(['basic', 'google-oauth']).toContain(a.authType)
    }
  })

  test('POST /api/caldav/accounts validates required fields', async ({ request }) => {
    // Sending an empty body should produce 400, not a 500 or accidental insert.
    const res = await request.post('/api/caldav/accounts', { data: {} })
    expect(res.status()).toBe(400)
  })
})
