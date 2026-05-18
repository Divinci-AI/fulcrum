/**
 * D-10 PR 4 — Phase C round-trip verification.
 *
 * Opens a WebSocket, publishes a `page-context:update`, then GETs
 * `/api/users/me/page-context` to confirm the snapshot landed. Catches
 * future regressions in the publisher/cache wiring (which today is
 * only exercised manually by opening the browser).
 *
 * Runs against the **local** project only — the prod CF Access service
 * token collapses to a single identity, so we can't isolate a per-user
 * cache entry from there. The local docker-compose target lets us
 * fabricate a distinct identity via the `Cf-Access-Authenticated-User-Email`
 * header and verify the round-trip in isolation.
 */
import { expect, test } from '@playwright/test'
import { WsClient, wsUrl } from '../_lib/ws'

const USER_EMAIL = `page-ctx-${Date.now()}@example.com`

test('WS publish → HTTP read round-trip', async ({ request }) => {
  // 1. Provoke the user row by hitting /api/users/me — the currentUser
  //    middleware lazy-creates on first sight via the CF Access header
  //    fallback.
  const me = await request.get('/api/users/me', {
    headers: { 'Cf-Access-Authenticated-User-Email': USER_EMAIL },
  })
  expect(me.status()).toBe(200)
  const meBody = (await me.json()) as { user: { id: string } | null }
  expect(meBody.user).not.toBeNull()

  // 2. Open a WS as that same identity. The publisher hook in the
  //    browser sends `page-context:update` on every nav; we synthesize
  //    one here.
  const ws = new WsClient(wsUrl('/ws/terminal'), {
    headers: { 'Cf-Access-Authenticated-User-Email': USER_EMAIL },
  })
  await ws.opened

  ws.send({
    type: 'page-context:update',
    payload: {
      route: '/tasks/round-trip-test',
      selection: { kind: 'task', id: 'round-trip-test' },
      visibleEntities: { tasks: ['round-trip-test', 'another'] },
      metadata: { pageType: 'task' },
    },
  })

  // 3. Race-safe read: the WS handler stamps the cache synchronously,
  //    but the WS write itself is fire-and-forget from this side. A
  //    short poll loop avoids a flaky strict-await.
  let body: { context: { route?: string; selection?: { id: string } | null } | null } = { context: null }
  for (let i = 0; i < 20; i++) {
    const res = await request.get('/api/users/me/page-context', {
      headers: { 'Cf-Access-Authenticated-User-Email': USER_EMAIL },
    })
    expect(res.status()).toBe(200)
    body = (await res.json()) as typeof body
    if (body.context?.route === '/tasks/round-trip-test') break
    await new Promise((r) => setTimeout(r, 100))
  }

  expect(body.context).not.toBeNull()
  expect(body.context?.route).toBe('/tasks/round-trip-test')
  expect(body.context?.selection?.id).toBe('round-trip-test')

  ws.close()
})

test('second update overwrites the first', async ({ request }) => {
  const ws = new WsClient(wsUrl('/ws/terminal'), {
    headers: { 'Cf-Access-Authenticated-User-Email': USER_EMAIL },
  })
  await ws.opened

  ws.send({
    type: 'page-context:update',
    payload: { route: '/projects/x', metadata: {} },
  })
  ws.send({
    type: 'page-context:update',
    payload: { route: '/apps/y', metadata: {} },
  })

  let route: string | undefined
  for (let i = 0; i < 20; i++) {
    const res = await request.get('/api/users/me/page-context', {
      headers: { 'Cf-Access-Authenticated-User-Email': USER_EMAIL },
    })
    const body = (await res.json()) as { context: { route?: string } | null }
    route = body.context?.route
    if (route === '/apps/y') break
    await new Promise((r) => setTimeout(r, 100))
  }
  expect(route).toBe('/apps/y')

  ws.close()
})

test('per-user scoping — anonymous read sees nothing for this identity', async ({ request }) => {
  // Publish as USER_EMAIL.
  const ws = new WsClient(wsUrl('/ws/terminal'), {
    headers: { 'Cf-Access-Authenticated-User-Email': USER_EMAIL },
  })
  await ws.opened
  ws.send({
    type: 'page-context:update',
    payload: { route: '/me-only', metadata: {} },
  })
  // Give the server a beat to process.
  await new Promise((r) => setTimeout(r, 200))

  // A request without a CF Access header is either anonymous (no
  // user) or resolves to a different identity via the dev fallback.
  // Either way it must NOT return our published snapshot.
  const res = await request.get('/api/users/me/page-context')
  // Anonymous → 401 OR (with dev fallback) a non-USER_EMAIL identity →
  // different context (likely null).
  if (res.status() === 200) {
    const body = (await res.json()) as { context: { route?: string } | null }
    expect(body.context?.route).not.toBe('/me-only')
  } else {
    expect(res.status()).toBe(401)
  }

  ws.close()
})
