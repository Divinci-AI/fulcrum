import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { createTestApp } from '../__tests__/fixtures/app'
import { setupTestEnv, type TestEnv } from '../__tests__/utils/env'
import { db, users } from '../db'

describe('Team Chat Routes', () => {
  let env: TestEnv
  beforeEach(() => {
    env = setupTestEnv()
  })
  afterEach(() => env.cleanup())

  test('empty history', async () => {
    const { get } = createTestApp()
    const res = await get('/api/team-chat')
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.messages).toEqual([])
    expect(body.hasMore).toBe(false)
  })

  test('send + list roundtrip with author info', async () => {
    const { post, get } = createTestApp()
    const sendRes = await post('/api/team-chat', { body: 'hello team' })
    const sent = await sendRes.json()
    expect(sendRes.status).toBe(201)
    expect(sent.body).toBe('hello team')
    expect(sent.authorEmail).toBe('test-admin@example.com')

    const listRes = await get('/api/team-chat')
    const list = await listRes.json()
    expect(list.messages.length).toBe(1)
    expect(list.messages[0].id).toBe(sent.id)
  })

  test('rejects empty and oversized messages', async () => {
    const { post } = createTestApp()
    expect((await post('/api/team-chat', { body: '   ' })).status).toBe(400)
    expect((await post('/api/team-chat', { body: 'x'.repeat(4001) })).status).toBe(400)
  })

  test('author can delete own message; others cannot (non-admin)', async () => {
    const { post, request } = createTestApp()
    const sent = await (await post('/api/team-chat', { body: 'to delete' })).json()

    // Another non-admin user tries to delete → 403
    const now = new Date().toISOString()
    db.insert(users)
      .values({ id: crypto.randomUUID(), email: 'peer@example.com', createdAt: now, updatedAt: now })
      .run()
    const forbidden = await request(`/api/team-chat/${sent.id}`, {
      method: 'DELETE',
      headers: { 'Cf-Access-Authenticated-User-Email': 'peer@example.com' },
    })
    expect(forbidden.status).toBe(403)

    // The author (default identity) deletes successfully
    const ok = await request(`/api/team-chat/${sent.id}`, { method: 'DELETE' })
    expect(ok.status).toBe(200)
  })

  test('DM thread: scoped listing, excluded from channel, both directions', async () => {
    const { post, get, request } = createTestApp()
    const now = new Date().toISOString()
    const peerId = crypto.randomUUID()
    db.insert(users)
      .values({ id: peerId, email: 'peer@example.com', createdAt: now, updatedAt: now })
      .run()

    // Channel message + DM from default identity to peer
    await post('/api/team-chat', { body: 'channel message' })
    const dmRes = await post('/api/team-chat', { body: 'psst, just for you', recipientUserId: peerId })
    expect(dmRes.status).toBe(201)
    const dm = await dmRes.json()
    expect(dm.recipientUserId).toBe(peerId)

    // Peer replies
    const replyRes = await request('/api/team-chat', {
      method: 'POST',
      headers: {
        'Cf-Access-Authenticated-User-Email': 'peer@example.com',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ body: 'right back at you', recipientUserId: dm.authorUserId }),
    })
    expect(replyRes.status).toBe(201)

    // Channel listing shows only the channel message
    const channel = await (await get('/api/team-chat')).json()
    expect(channel.messages.map((m: { body: string }) => m.body)).toEqual(['channel message'])

    // DM thread shows both directions in order
    const thread = await (await get(`/api/team-chat?with=${peerId}`)).json()
    expect(thread.messages.map((m: { body: string }) => m.body)).toEqual([
      'psst, just for you',
      'right back at you',
    ])
  })

  test('DM validation: no self-DM, recipient must exist', async () => {
    const { post, get } = createTestApp()
    // Resolve own user id via a channel message's author
    const sent = await (await post('/api/team-chat', { body: 'x' })).json()
    expect(
      (await post('/api/team-chat', { body: 'me me me', recipientUserId: sent.authorUserId })).status
    ).toBe(400)
    expect(
      (await post('/api/team-chat', { body: 'ghost', recipientUserId: 'no-such-user' })).status
    ).toBe(404)
    // Channel unaffected
    const channel = await (await get('/api/team-chat')).json()
    expect(channel.messages.length).toBe(1)
  })

  test('pagination with before cursor', async () => {
    const { post, get } = createTestApp()
    for (let i = 0; i < 5; i++) {
      await post('/api/team-chat', { body: `msg ${i}` })
      // createdAt has millisecond resolution; space the messages out
      await new Promise((r) => setTimeout(r, 2))
    }
    const page1 = await (await get('/api/team-chat?limit=3')).json()
    expect(page1.messages.length).toBe(3)
    expect(page1.hasMore).toBe(true)
    const oldest = page1.messages[0]
    const page2 = await (
      await get(`/api/team-chat?limit=3&before=${encodeURIComponent(oldest.createdAt)}`)
    ).json()
    expect(page2.messages.length).toBe(2)
    expect(page2.messages.every((m: { createdAt: string }) => m.createdAt < oldest.createdAt)).toBe(true)
  })
})
