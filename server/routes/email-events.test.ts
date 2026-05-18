/**
 * D-11 PR 2 — POST /api/email-events ingest endpoint.
 *
 * Auth via `X-Webhook-Secret` header, NOT Bearer (to avoid
 * collision with the user-token middleware). Body is one event or
 * an array. Service-level recording is covered in
 * email-event-service.test.ts; here we test the HTTP wrapper.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createTestApp } from '../__tests__/fixtures/app'
import { setupTestEnv, type TestEnv } from '../__tests__/utils/env'
import { updateSettingByPath } from '../lib/settings'

const SECRET = 'test-webhook-secret-do-not-leak'

function configureSecret(): void {
  updateSettingByPath('integrations.cloudflareEmailIngestSecret', SECRET)
}

describe('POST /api/email-events', () => {
  let env: TestEnv
  beforeEach(() => {
    env = setupTestEnv()
  })
  afterEach(() => env.cleanup())

  test('401 when no secret is configured even with header', async () => {
    // Deliberately do NOT call configureSecret()
    const { post } = createTestApp()
    const res = await post(
      '/api/email-events',
      { recipient: 'x@example.com', eventType: 'bounced' },
      { 'X-Webhook-Secret': SECRET }
    )
    expect(res.status).toBe(401)
  })

  test('401 when header missing', async () => {
    configureSecret()
    const { post } = createTestApp()
    const res = await post('/api/email-events', {
      recipient: 'x@example.com',
      eventType: 'bounced',
    })
    expect(res.status).toBe(401)
  })

  test('401 when header value wrong', async () => {
    configureSecret()
    const { post } = createTestApp()
    const res = await post(
      '/api/email-events',
      { recipient: 'x@example.com', eventType: 'bounced' },
      { 'X-Webhook-Secret': 'WRONG' }
    )
    expect(res.status).toBe(401)
  })

  test('200 with one event, ingested=1 + id', async () => {
    configureSecret()
    const { post } = createTestApp()
    const res = await post(
      '/api/email-events',
      {
        recipient: 'newbie@example.com',
        eventType: 'bounced',
        occurredAt: '2026-05-18T12:00:00Z',
        providerMessageId: 'cf-abc',
        raw: { mta: 'mx1.example.com' },
      },
      { 'X-Webhook-Secret': SECRET }
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ingested: number; ids: string[]; errors: string[] }
    expect(body.ingested).toBe(1)
    expect(body.ids.length).toBe(1)
    expect(body.errors).toEqual([])
  })

  test('200 with array body, ingested=N', async () => {
    configureSecret()
    const { post } = createTestApp()
    const res = await post(
      '/api/email-events',
      [
        { recipient: 'a@example.com', eventType: 'delivered' },
        { recipient: 'b@example.com', eventType: 'bounced' },
        { recipient: 'c@example.com', eventType: 'complained' },
      ],
      { 'X-Webhook-Secret': SECRET }
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ingested: number; ids: string[]; errors: string[] }
    expect(body.ingested).toBe(3)
    expect(body.ids.length).toBe(3)
    expect(body.errors).toEqual([])
  })

  test('200 partial — bad event in array reported in errors but good ones still ingested', async () => {
    configureSecret()
    const { post } = createTestApp()
    const res = await post(
      '/api/email-events',
      [
        { recipient: 'a@example.com', eventType: 'delivered' },
        { recipient: 'b@example.com', eventType: 'totally_not_a_real_type' },
        { recipient: '', eventType: 'bounced' },
        { recipient: 'c@example.com', eventType: 'bounced' },
      ],
      { 'X-Webhook-Secret': SECRET }
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ingested: number; ids: string[]; errors: string[] }
    expect(body.ingested).toBe(2)
    expect(body.errors.length).toBe(2)
    expect(body.errors[0]).toContain('[1]')
    expect(body.errors[0]).toContain('Unknown eventType')
    expect(body.errors[1]).toContain('[2]')
  })

  test('400 on malformed JSON', async () => {
    configureSecret()
    const { app } = createTestApp()
    const res = await app.request('http://localhost/api/email-events', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Secret': SECRET,
      },
      body: '{not json',
    })
    expect(res.status).toBe(400)
  })

  test('timing-safe: a wrong secret of the same length still 401s', async () => {
    configureSecret()
    const { post } = createTestApp()
    const sameLen = 'x'.repeat(SECRET.length)
    const res = await post(
      '/api/email-events',
      { recipient: 'x@example.com', eventType: 'bounced' },
      { 'X-Webhook-Secret': sameLen }
    )
    expect(res.status).toBe(401)
  })
})
