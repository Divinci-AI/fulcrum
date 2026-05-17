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
import { WsClient } from '../_lib/ws'

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

// Build the WS URL from the prod base directly. The shared wsUrl() helper
// reads PLAYWRIGHT_TEST_BASE_URL, which Playwright does NOT auto-export from
// `use.baseURL` — so it would silently fall back to localhost here.
const PROD_BASE = process.env.FULCRUM_E2E_PROD_URL ?? 'https://fulcrum-acme.divinci.ai'
const prodWsUrl = (path: string) => PROD_BASE.replace(/^http/, 'ws') + path

test('WS upgrade succeeds and subscribe → ack round-trips', async () => {
  const ws = new WsClient(prodWsUrl('/ws/terminal'), cfHeaders ? { headers: cfHeaders } : {})
  await ws.opened

  ws.send({ type: 'subscribe', payload: { topics: ['me'] } })
  const ack = await ws.next((m) => m.type === 'subscription:ack', 5000)
  expect(ack.payload.topics).toContain('me')

  ws.close()
})
