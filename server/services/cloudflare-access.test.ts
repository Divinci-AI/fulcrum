/**
 * D-8 PR 5 — Cloudflare Access policy management.
 *
 * Uses the `setCloudflareFetchImpl` DI seam (defined in the service)
 * instead of `mock.module` so cross-file test ordering doesn't bite —
 * same pattern as github-account-service + notification-preferences.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { setupTestEnv, type TestEnv } from '../__tests__/utils/env'
import {
  addEmailToPolicy,
  removeEmailFromPolicy,
  setCloudflareFetchImpl,
  resetCloudflareFetchImpl,
} from './cloudflare-access'
import { updateSettingByPath } from '../lib/settings'

interface MockRequest {
  url: string
  method: string
  body: unknown
}

function setupCfConfig(): void {
  // Use plain settings paths — cloudflareAccessAppId/PolicyId are plain
  // provider in fnox.ts, but the api token + account id are encrypted.
  // The setting functions handle both transparently.
  updateSettingByPath('integrations.cloudflareApiToken', 'cf_test_token')
  updateSettingByPath('integrations.cloudflareAccountId', 'acct_test')
  updateSettingByPath('integrations.cloudflareAccessAppId', 'app_test')
  updateSettingByPath('integrations.cloudflareAccessPolicyId', 'policy_test')
}

function makeMockFetch(
  responses: Array<{ status?: number; body: unknown; capture?: (req: MockRequest) => void }>
): { fetch: typeof fetch; calls: MockRequest[] } {
  const calls: MockRequest[] = []
  let i = 0
  const fn: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input as Request).url
    const req: MockRequest = {
      url,
      method: (init?.method as string | undefined) ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : null,
    }
    calls.push(req)
    const r = responses[Math.min(i, responses.length - 1)]
    r.capture?.(req)
    i++
    return new Response(JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  return { fetch: fn, calls }
}

describe('cloudflare-access', () => {
  let env: TestEnv
  // Env vars override settings, so we need to clear any operator-shell
  // values for the duration of these tests — otherwise getSettings()
  // returns the real production CF token regardless of our test setup
  // calls.
  const ENV_KEYS = [
    'CLOUDFLARE_API_TOKEN',
    'CLOUDFLARE_ACCOUNT_ID',
    'CLOUDFLARE_ACCESS_APP_ID',
    'CLOUDFLARE_ACCESS_POLICY_ID',
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
    resetCloudflareFetchImpl()
    for (const k of ENV_KEYS) {
      if (saved[k] !== undefined) process.env[k] = saved[k]
    }
    env.cleanup()
  })

  describe('addEmailToPolicy', () => {
    test('skipped: true when CF Access is not configured', async () => {
      // No setSetting calls — empty config.
      const result = await addEmailToPolicy('alice@example.com')
      expect(result.ok).toBe(false)
      expect(result.skipped).toBe(true)
      expect(result.reason).toContain('not configured')
    })

    test('GETs the policy, appends the email entry, PUTs the merged policy', async () => {
      setupCfConfig()
      const policy = {
        id: 'policy_test',
        name: 'Per-user invites',
        decision: 'allow',
        include: [
          { email: { email: 'existing@example.com' } },
          { group: { id: 'g_divincians' } },
        ],
      }
      const { fetch: mock, calls } = makeMockFetch([
        { body: { success: true, result: policy } },
        { body: { success: true, result: policy } },
      ])
      setCloudflareFetchImpl(mock)

      const result = await addEmailToPolicy('newbie@example.com')
      expect(result.ok).toBe(true)
      expect(result.skipped).toBe(false)
      expect(calls.length).toBe(2)
      expect(calls[0].method).toBe('GET')
      expect(calls[1].method).toBe('PUT')
      const putBody = calls[1].body as typeof policy
      expect(putBody.include.length).toBe(3)
      // Existing entries preserved (including non-email shapes)
      expect(putBody.include[0]).toEqual({ email: { email: 'existing@example.com' } })
      expect(putBody.include[1]).toEqual({ group: { id: 'g_divincians' } })
      expect(putBody.include[2]).toEqual({ email: { email: 'newbie@example.com' } })
    })

    test('idempotent: a second add returns ok:true without a PUT', async () => {
      setupCfConfig()
      const policy = {
        id: 'policy_test',
        name: 'p',
        decision: 'allow',
        include: [{ email: { email: 'already@example.com' } }],
      }
      const { fetch: mock, calls } = makeMockFetch([
        { body: { success: true, result: policy } },
      ])
      setCloudflareFetchImpl(mock)

      const result = await addEmailToPolicy('already@example.com')
      expect(result.ok).toBe(true)
      expect(calls.length).toBe(1) // GET only — no PUT
    })

    test('email match is case-insensitive', async () => {
      setupCfConfig()
      const policy = {
        id: 'policy_test',
        name: 'p',
        decision: 'allow',
        include: [{ email: { email: 'mike@divinci.ai' } }],
      }
      const { fetch: mock, calls } = makeMockFetch([
        { body: { success: true, result: policy } },
      ])
      setCloudflareFetchImpl(mock)

      const result = await addEmailToPolicy('Mike@DIVINCI.AI')
      expect(result.ok).toBe(true)
      expect(calls.length).toBe(1) // recognized as already-present
    })

    test('returns ok:false reason on CF API error response', async () => {
      setupCfConfig()
      const { fetch: mock } = makeMockFetch([
        {
          body: {
            success: false,
            errors: [{ code: 9109, message: 'Invalid token' }],
            result: null,
          },
        },
      ])
      setCloudflareFetchImpl(mock)

      const result = await addEmailToPolicy('user@example.com')
      expect(result.ok).toBe(false)
      expect(result.skipped).toBe(false)
      expect(result.reason).toContain('9109')
    })

    test('returns ok:false reason on HTTP-level error', async () => {
      setupCfConfig()
      const { fetch: mock } = makeMockFetch([{ status: 500, body: 'oops' }])
      setCloudflareFetchImpl(mock)

      const result = await addEmailToPolicy('user@example.com')
      expect(result.ok).toBe(false)
      expect(result.reason).toContain('500')
    })

    test('rejects empty email without consulting CF', async () => {
      setupCfConfig()
      const { fetch: mock, calls } = makeMockFetch([])
      setCloudflareFetchImpl(mock)
      const result = await addEmailToPolicy('   ')
      expect(result.ok).toBe(false)
      expect(result.skipped).toBe(false)
      expect(calls.length).toBe(0)
    })
  })

  describe('removeEmailFromPolicy', () => {
    test('removes the matching entry and PUTs the filtered policy', async () => {
      setupCfConfig()
      const policy = {
        id: 'policy_test',
        name: 'p',
        decision: 'allow',
        include: [
          { email: { email: 'a@example.com' } },
          { email: { email: 'b@example.com' } },
          { group: { id: 'g_x' } },
        ],
      }
      const { fetch: mock, calls } = makeMockFetch([
        { body: { success: true, result: policy } },
        { body: { success: true, result: policy } },
      ])
      setCloudflareFetchImpl(mock)

      const result = await removeEmailFromPolicy('a@example.com')
      expect(result.ok).toBe(true)
      const putBody = calls[1].body as typeof policy
      expect(putBody.include.length).toBe(2)
      expect(putBody.include.some((i) => 'email' in i && (i.email as { email: string }).email === 'a@example.com')).toBe(false)
      // Non-email shapes preserved
      expect(putBody.include.some((i) => 'group' in i)).toBe(true)
    })

    test('no-op when the email is not in the policy', async () => {
      setupCfConfig()
      const policy = {
        id: 'policy_test',
        name: 'p',
        decision: 'allow',
        include: [{ email: { email: 'present@example.com' } }],
      }
      const { fetch: mock, calls } = makeMockFetch([
        { body: { success: true, result: policy } },
      ])
      setCloudflareFetchImpl(mock)

      const result = await removeEmailFromPolicy('absent@example.com')
      expect(result.ok).toBe(true)
      expect(calls.length).toBe(1) // GET only
    })

    test('skipped:true when CF Access not configured', async () => {
      const result = await removeEmailFromPolicy('alice@example.com')
      expect(result.ok).toBe(false)
      expect(result.skipped).toBe(true)
    })
  })
})
