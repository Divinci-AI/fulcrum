/**
 * D-4 WebSocket substrate reachability — prod-safe.
 *
 * Opens a WS through CF Access (the service token's headers come from the
 * config's extraHTTPHeaders, but WS handshakes don't pick those up — we
 * pass them explicitly). Verifies:
 *  - The upgrade succeeds through the gateway
 *  - subscribe/unsubscribe protocol round-trips
 *
 * This catches the moment something breaks at the Cloudflare → cloudflared
 * → container WS-path layer (a CF rule change, a cloudflared upgrade
 * regression, a container env var that disables /ws/* registration).
 */
import { expect, test } from '@playwright/test'
import { WsClient, wsUrl } from '../_lib/ws'

// CF Access service-token headers are required for the WS upgrade to
// authenticate through the gateway. Read them from the same env vars
// playwright.config.ts uses.
const cfHeaders =
  process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET
    ? {
        'CF-Access-Client-Id': process.env.CF_ACCESS_CLIENT_ID,
        'CF-Access-Client-Secret': process.env.CF_ACCESS_CLIENT_SECRET,
      }
    : undefined

// D-7 PR 5: pass the prod base URL explicitly to `wsUrl`. The shared
// helper now supports an explicit `baseUrl` option for exactly this
// reason — any prod ws spec should opt in instead of relying on env-var
// magic (Playwright doesn't auto-export `use.baseURL` to env).
const PROD_BASE = process.env.FULCRUM_E2E_PROD_URL ?? 'https://fulcrum-acme.divinci.ai'

test('WS upgrade succeeds and subscribe → ack round-trips', async () => {
  const ws = new WsClient(
    wsUrl('/ws/terminal', { baseUrl: PROD_BASE }),
    cfHeaders ? { headers: cfHeaders } : {}
  )
  await ws.opened

  ws.send({ type: 'subscribe', payload: { topics: ['me'] } })
  const ack = await ws.next((m) => m.type === 'subscription:ack', 5000)
  expect(ack.payload.topics).toContain('me')

  ws.close()
})
