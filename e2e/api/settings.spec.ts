import { expect, test } from '@playwright/test'
import { getJson } from '../_lib/api'

test.describe('settings/config API', () => {
  test('GET /api/config returns a flat object of nested keys', async ({ request }) => {
    const config = await getJson<Record<string, unknown>>(request, '/api/config')
    expect(typeof config).toBe('object')
    // Should at least have the well-known server keys
    expect(config).toHaveProperty('server.port')
  })

  test('GET /api/config/fnox-status reports fnox availability', async ({ request }) => {
    const status = await getJson<{ available: boolean; configCount: number }>(
      request,
      '/api/config/fnox-status'
    )
    expect(typeof status.available).toBe('boolean')
    expect(typeof status.configCount).toBe('number')
  })

  test('GET /api/config/google-oauth-status returns the managed-by-host envelope', async ({
    request,
  }) => {
    const status = await getJson<{
      clientId: { provider: string; configured: boolean }
      clientSecret: { provider: string; configured: boolean }
      managedByHost: boolean
    }>(request, '/api/config/google-oauth-status')
    expect(typeof status.managedByHost).toBe('boolean')
    expect(['env', 'fnox', 'none']).toContain(status.clientId.provider)
    expect(['env', 'fnox', 'none']).toContain(status.clientSecret.provider)
  })

  test('GET /api/config/developer-mode returns enabled + startedAt', async ({ request }) => {
    const dm = await getJson<{ enabled: boolean; startedAt: number }>(
      request,
      '/api/config/developer-mode'
    )
    expect(typeof dm.enabled).toBe('boolean')
    expect(typeof dm.startedAt).toBe('number')
  })
})
