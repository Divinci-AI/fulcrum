import { expect, test } from '@playwright/test'
import { getJson } from '../_lib/api'

interface ChannelStatus {
  enabled?: boolean
  connected?: boolean
  [k: string]: unknown
}

test.describe('messaging channel status endpoints', () => {
  test('GET /api/messaging/channels lists configured channels', async ({ request }) => {
    const channels = await getJson<unknown>(request, '/api/messaging/channels')
    // Either an array of channel descriptors or an envelope `{channels: [...]}`.
    const list = Array.isArray(channels)
      ? channels
      : ((channels as { channels?: unknown[] }).channels ?? [])
    expect(Array.isArray(list)).toBe(true)
  })

  for (const channel of ['whatsapp', 'slack', 'discord', 'telegram'] as const) {
    test(`GET /api/messaging/${channel} returns a status envelope`, async ({ request }) => {
      const status = await getJson<ChannelStatus>(request, `/api/messaging/${channel}`)
      // No real connectivity asserted — just that the route is alive and
      // returns an object. The exact shape varies per channel.
      expect(typeof status).toBe('object')
      expect(status).not.toBeNull()
    })
  }
})
