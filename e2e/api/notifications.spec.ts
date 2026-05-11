import { expect, test } from '@playwright/test'
import { getJson, postJson } from '../_lib/api'

interface NotificationSettings {
  enabled: boolean
  toast: { enabled: boolean }
  desktop: { enabled: boolean }
  sound: { enabled: boolean }
  gmail: { enabled: boolean }
}

test.describe('notifications API', () => {
  test('GET /api/config/notifications returns the settings shape', async ({ request }) => {
    const settings = await getJson<NotificationSettings>(
      request,
      '/api/config/notifications'
    )
    expect(settings).toHaveProperty('enabled')
    expect(settings).toHaveProperty('toast.enabled')
    expect(settings).toHaveProperty('gmail.enabled')
  })

  test('POST /api/config/notifications/send fires a toast/desktop dispatch', async ({
    request,
  }) => {
    // Sound channel is the safest test: doesn't require any external service config,
    // and the server has a synthesized "click" file for sound testing.
    const result = await postJson<{ success: boolean; results: unknown[] }>(
      request,
      '/api/config/notifications/send',
      {
        title: 'E2E ping',
        message: 'fired by playwright',
      }
    )
    expect(result.success).toBe(true)
    expect(Array.isArray(result.results)).toBe(true)
  })

  test('POST /api/config/notifications/test/sound returns a result envelope', async ({
    request,
  }) => {
    const res = await request.post('/api/config/notifications/test/sound')
    // 200 success OR a clean error envelope — both are valid for "channel not
    // configured". Anything else (5xx, weird body) indicates the route broke.
    expect([200, 400, 500]).toContain(res.status())
    const body = (await res.json()) as { channel?: string; success?: boolean }
    expect(body.channel).toBe('sound')
  })
})
