/**
 * D-10 PR 8 — Cloudflare Email Sending.
 *
 * DI seam tests (setCloudflareEmailFetchImpl). The CF API is beta,
 * so this is what catches breakage when their request/response
 * shape drifts.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { setupTestEnv, type TestEnv } from '../__tests__/utils/env'
import {
  sendInviteEmail,
  setCloudflareEmailFetchImpl,
  resetCloudflareEmailFetchImpl,
  _builders,
} from './cloudflare-email-service'
import { updateSettingByPath } from '../lib/settings'

function setupConfig(): void {
  updateSettingByPath('integrations.cloudflareApiToken', 'cf_test_token')
  updateSettingByPath('integrations.cloudflareAccountId', 'acct_test')
  updateSettingByPath('integrations.cloudflareEmailEnabled', true)
  updateSettingByPath('integrations.cloudflareEmailFromAddress', 'invites@divinci.ai')
}

interface MockReq {
  url: string
  method: string
  body: Record<string, unknown>
}

function makeMockFetch(
  responses: Array<{ status?: number; body: unknown }>
): { fetch: typeof fetch; calls: MockReq[] } {
  const calls: MockReq[] = []
  let i = 0
  const fn: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input as Request).url
    calls.push({
      url,
      method: (init?.method as string | undefined) ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : {},
    })
    const r = responses[Math.min(i, responses.length - 1)]
    i++
    return new Response(JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  return { fetch: fn, calls }
}

describe('cloudflare-email-service', () => {
  let env: TestEnv
  // Env vars override settings, so clear them so our test config sticks.
  const ENV_KEYS = [
    'CLOUDFLARE_API_TOKEN',
    'CLOUDFLARE_ACCOUNT_ID',
    'CLOUDFLARE_EMAIL_FROM',
  ] as const
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    env = setupTestEnv()
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
  })
  afterEach(() => {
    resetCloudflareEmailFetchImpl()
    for (const k of ENV_KEYS) {
      if (saved[k] !== undefined) process.env[k] = saved[k]
    }
    env.cleanup()
  })

  describe('sendInviteEmail', () => {
    test('skipped:true when CF Email is not configured', async () => {
      const result = await sendInviteEmail({
        to: 'someone@example.com',
        tenantUrl: 'https://x.example.com',
        inviterEmail: 'admin@example.com',
      })
      expect(result.sent).toBe(false)
      expect(result.skipped).toBe(true)
      expect(result.reason).toContain('not configured')
    })

    test('skipped when toggle is off even with token + account + from set', async () => {
      updateSettingByPath('integrations.cloudflareApiToken', 'cf_test_token')
      updateSettingByPath('integrations.cloudflareAccountId', 'acct_test')
      updateSettingByPath('integrations.cloudflareEmailFromAddress', 'invites@divinci.ai')
      // Toggle deliberately not enabled
      const result = await sendInviteEmail({
        to: 'someone@example.com',
        tenantUrl: 'https://x.example.com',
        inviterEmail: 'admin@example.com',
      })
      expect(result.skipped).toBe(true)
    })

    test('POSTs the expected body shape; recipient in delivered → sent:true delivery:delivered', async () => {
      setupConfig()
      const { fetch: mock, calls } = makeMockFetch([
        { body: { success: true, errors: [], result: { delivered: ['newbie@example.com'], permanent_bounces: [], queued: [] } } },
      ])
      setCloudflareEmailFetchImpl(mock)

      const result = await sendInviteEmail({
        to: 'newbie@example.com',
        tenantUrl: 'https://fulcrum-acme.divinci.ai',
        inviterEmail: 'mike@divinci.ai',
        inviteeDisplayName: 'Newbie',
      })

      expect(result.sent).toBe(true)
      expect(result.delivery).toBe('delivered')
      expect(calls.length).toBe(1)
      expect(calls[0].url).toContain('/accounts/acct_test/email/sending/send')
      expect(calls[0].method).toBe('POST')
      expect(calls[0].body.to).toBe('newbie@example.com')
      expect(calls[0].body.from).toBe('invites@divinci.ai')
      expect(String(calls[0].body.subject)).toContain('invited')
      expect(String(calls[0].body.text)).toContain('Newbie')
      expect(String(calls[0].body.text)).toContain('https://fulcrum-acme.divinci.ai')
      expect(String(calls[0].body.html)).toContain('mike@divinci.ai')
    })

    test('recipient in queued → sent:true delivery:queued', async () => {
      setupConfig()
      const { fetch: mock } = makeMockFetch([
        { body: { success: true, result: { delivered: [], permanent_bounces: [], queued: ['slow@example.com'] } } },
      ])
      setCloudflareEmailFetchImpl(mock)
      const result = await sendInviteEmail({
        to: 'slow@example.com',
        tenantUrl: 'https://x.example.com',
        inviterEmail: 'a@example.com',
      })
      expect(result.sent).toBe(true)
      expect(result.delivery).toBe('queued')
    })

    test('recipient in permanent_bounces → sent:false delivery:bounced with reason', async () => {
      setupConfig()
      const { fetch: mock } = makeMockFetch([
        { body: { success: true, result: { delivered: [], permanent_bounces: ['nope@example.com'], queued: [] } } },
      ])
      setCloudflareEmailFetchImpl(mock)
      const result = await sendInviteEmail({
        to: 'nope@example.com',
        tenantUrl: 'https://x.example.com',
        inviterEmail: 'a@example.com',
      })
      expect(result.sent).toBe(false)
      expect(result.skipped).toBe(false)
      expect(result.delivery).toBe('bounced')
      expect(result.reason).toContain('bounce')
    })

    test('success:true but recipient not in any bucket → sent:true delivery:queued (optimistic)', async () => {
      setupConfig()
      const { fetch: mock } = makeMockFetch([
        { body: { success: true, result: { delivered: [], permanent_bounces: [], queued: [] } } },
      ])
      setCloudflareEmailFetchImpl(mock)
      const result = await sendInviteEmail({
        to: 'orphan@example.com',
        tenantUrl: 'https://x.example.com',
        inviterEmail: 'a@example.com',
      })
      expect(result.sent).toBe(true)
      expect(result.delivery).toBe('queued')
    })

    test('outcome matching is case-insensitive on the recipient address', async () => {
      setupConfig()
      const { fetch: mock } = makeMockFetch([
        { body: { success: true, result: { delivered: ['Mike@DIVINCI.AI'], permanent_bounces: [], queued: [] } } },
      ])
      setCloudflareEmailFetchImpl(mock)
      const result = await sendInviteEmail({
        to: 'mike@divinci.ai',
        tenantUrl: 'https://x.example.com',
        inviterEmail: 'a@example.com',
      })
      expect(result.sent).toBe(true)
      expect(result.delivery).toBe('delivered')
    })

    test('returns sent:false reason on CF API error (success:false)', async () => {
      setupConfig()
      const { fetch: mock } = makeMockFetch([
        { body: { success: false, errors: [{ code: 1234, message: 'No mail domain' }] } },
      ])
      setCloudflareEmailFetchImpl(mock)

      const result = await sendInviteEmail({
        to: 'newbie@example.com',
        tenantUrl: 'https://x.example.com',
        inviterEmail: 'mike@example.com',
      })
      expect(result.sent).toBe(false)
      expect(result.skipped).toBe(false)
      expect(result.reason).toContain('1234')
    })

    test('returns sent:false reason on HTTP-level error', async () => {
      setupConfig()
      const { fetch: mock } = makeMockFetch([{ status: 503, body: 'service unavailable' }])
      setCloudflareEmailFetchImpl(mock)

      const result = await sendInviteEmail({
        to: 'newbie@example.com',
        tenantUrl: 'https://x.example.com',
        inviterEmail: 'mike@example.com',
      })
      expect(result.sent).toBe(false)
      expect(result.skipped).toBe(false)
      expect(result.reason).toContain('503')
    })

    test('rejects invalid recipient without consulting CF', async () => {
      setupConfig()
      const { fetch: mock, calls } = makeMockFetch([])
      setCloudflareEmailFetchImpl(mock)
      const result = await sendInviteEmail({
        to: 'not-an-email',
        tenantUrl: 'https://x.example.com',
        inviterEmail: 'admin@example.com',
      })
      expect(result.sent).toBe(false)
      expect(result.skipped).toBe(false)
      expect(calls.length).toBe(0)
    })
  })

  describe('builders', () => {
    test('subject mentions invited', () => {
      expect(_builders.buildSubject()).toContain('invited')
    })

    test('text body includes tenant URL + inviter signature', () => {
      const body = _builders.buildText({
        to: 'x@example.com',
        tenantUrl: 'https://t.example.com',
        inviterEmail: 'a@example.com',
      })
      expect(body).toContain('https://t.example.com')
      expect(body).toContain('a@example.com')
    })

    test('html body has a clickable sign-in link', () => {
      const html = _builders.buildHtml({
        to: 'x@example.com',
        tenantUrl: 'https://t.example.com',
        inviterEmail: 'a@example.com',
      })
      expect(html).toContain('href="https://t.example.com"')
    })
  })
})
