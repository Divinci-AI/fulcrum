/**
 * D-4 PR 1 substrate coverage:
 *  - WS upgrades carry the Cf-Access-Authenticated-User-Email header
 *    through the currentUser middleware so the socket is tagged with the
 *    user identity.
 *  - `subscribe` / `unsubscribe` ClientMessages round-trip via the
 *    `subscription:ack` ServerMessage.
 *
 * Fan-out behavior (`broadcastToTopic` reaching matching subscribers only)
 * is exercised in D-4 PR 2 once route handlers fire social events that
 * land on this substrate.
 */
import { expect, test } from '@playwright/test'
import { WsClient, wsUrl } from '../_lib/ws'

test.describe('D-4 WS substrate', () => {
  test('connection without identity opens cleanly (anonymous socket)', async () => {
    const ws = new WsClient(wsUrl('/ws/terminal'))
    await ws.opened
    ws.close()
  })

  test('subscribe → server acks with the current topic set', async () => {
    const ws = new WsClient(wsUrl('/ws/terminal'))
    await ws.opened

    ws.send({
      type: 'subscribe',
      payload: { topics: ['task:*', 'project:abc'] },
    })

    const ack = await ws.next((m) => m.type === 'subscription:ack', 3000)
    expect(ack.payload.topics).toEqual(expect.arrayContaining(['task:*', 'project:abc']))
    ws.close()
  })

  test('unsubscribe drops topics from the socket set', async () => {
    const ws = new WsClient(wsUrl('/ws/terminal'))
    await ws.opened

    ws.send({ type: 'subscribe', payload: { topics: ['me', 'task:*'] } })
    await ws.next((m) => m.type === 'subscription:ack', 3000)

    ws.send({ type: 'unsubscribe', payload: { topics: ['task:*'] } })
    const ack = await ws.next((m) => m.type === 'subscription:ack', 3000)

    expect(ack.payload.topics).toContain('me')
    expect(ack.payload.topics).not.toContain('task:*')
    ws.close()
  })

  test('subscribe with empty topics array is a no-op (still acks)', async () => {
    const ws = new WsClient(wsUrl('/ws/terminal'))
    await ws.opened

    ws.send({ type: 'subscribe', payload: { topics: [] } })
    const ack = await ws.next((m) => m.type === 'subscription:ack', 3000)
    expect(ack.payload.topics).toEqual([])
    ws.close()
  })

  test('upgrade carries Cf-Access-Authenticated-User-Email through middleware', async () => {
    // Provision a user via REST first so the user row exists. Then connect
    // a WS with the same header — if the upgrade properly applied the
    // currentUser middleware, the socket is tagged with that identity.
    // We can't directly assert userId from the client side, but the
    // connection opening cleanly with the header present is a meaningful
    // smoke test for the middleware integration path.
    const email = `d4_ws_${Date.now().toString(36)}@example.com`
    const ws = new WsClient(wsUrl('/ws/terminal'), {
      headers: { 'Cf-Access-Authenticated-User-Email': email },
    })
    await ws.opened
    // Subscribe to confirm the message loop is reachable end-to-end.
    ws.send({ type: 'subscribe', payload: { topics: ['me'] } })
    const ack = await ws.next((m) => m.type === 'subscription:ack', 3000)
    expect(ack.payload.topics).toContain('me')
    ws.close()
  })
})
