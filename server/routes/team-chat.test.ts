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
