// Config route tests using standard test environment
// No mock.module() - uses setupTestEnv() for isolation like all other tests
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { createTestApp } from '../__tests__/fixtures/app'
import { setupTestEnv, type TestEnv } from '../__tests__/utils/env'
import { CONFIG_KEYS } from '../../shared/config-keys'
import { VALID_SETTING_PATHS } from '../lib/settings/types'
import { setFnoxValue } from '../lib/settings/fnox'

describe('Config Routes', () => {
  let testEnv: TestEnv

  beforeEach(() => {
    testEnv = setupTestEnv()
  })

  afterEach(() => {
    testEnv.cleanup()
  })

  describe('GET /api/config', () => {
    test('returns all config values', async () => {
      const { get } = createTestApp()
      const res = await get('/api/config')
      const body = await res.json()

      expect(res.status).toBe(200)
      // Keys are literal dot-notation strings, not nested paths
      expect(body['server.port']).toBeDefined()
      expect(body['paths.defaultGitReposDir']).toBeDefined()
      expect(body['editor.app']).toBeDefined()
    })
  })

  describe('GET /api/config/:key', () => {
    test('returns value for valid key', async () => {
      const { get } = createTestApp()
      const res = await get('/api/config/server.port')
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.key).toBe('server.port')
      expect(typeof body.value).toBe('number')
    })

    test('returns worktree_base_path (special read-only key)', async () => {
      const { get } = createTestApp()
      const res = await get('/api/config/worktree_base_path')
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.key).toBe('worktree_base_path')
      expect(typeof body.value).toBe('string')
      expect(body.isDefault).toBe(true)
    })

    test('returns home_dir (special read-only key)', async () => {
      const { get } = createTestApp()
      const res = await get('/api/config/home_dir')
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.key).toBe('home_dir')
      expect(typeof body.value).toBe('string')
      expect(body.isDefault).toBe(true)
    })

    test('returns 404 for unknown key', async () => {
      const { get } = createTestApp()
      const res = await get('/api/config/unknown_key')
      const body = await res.json()

      expect(res.status).toBe(404)
      expect(body.error).toContain('Unknown config key')
    })

    test('supports legacy key mapping', async () => {
      const { get } = createTestApp()
      const res = await get('/api/config/port') // Legacy key for server.port
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.key).toBe('port')
      expect(typeof body.value).toBe('number')
    })

    test('returns isDefault flag', async () => {
      const { get } = createTestApp()
      const res = await get('/api/config/server.port')
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(typeof body.isDefault).toBe('boolean')
    })
  })

  describe('PUT /api/config/:key', () => {
    test('updates port value', async () => {
      const { put, get } = createTestApp()
      const res = await put('/api/config/server.port', { value: 8888 })
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.value).toBe(8888)

      // Verify the value persisted
      const checkRes = await get('/api/config/server.port')
      const checkBody = await checkRes.json()
      expect(checkBody.value).toBe(8888)
    })

    test('validates port range', async () => {
      const { put } = createTestApp()

      // Port too low
      const res1 = await put('/api/config/server.port', { value: 0 })
      expect(res1.status).toBe(400)

      // Port too high
      const res2 = await put('/api/config/server.port', { value: 70000 })
      expect(res2.status).toBe(400)
    })

    test('validates editor app value', async () => {
      const { put } = createTestApp()

      // Valid editor
      const res1 = await put('/api/config/editor.app', { value: 'vscode' })
      expect(res1.status).toBe(200)

      // Invalid editor
      const res2 = await put('/api/config/editor.app', { value: 'invalid_editor' })
      expect(res2.status).toBe(400)
      const body2 = await res2.json()
      expect(body2.error).toContain('must be one of')
    })

    test('validates language value', async () => {
      const { put } = createTestApp()

      // Valid language
      const res1 = await put('/api/config/appearance.language', { value: 'en' })
      expect(res1.status).toBe(200)

      const res2 = await put('/api/config/appearance.language', { value: 'zh' })
      expect(res2.status).toBe(200)

      // Invalid language
      const res3 = await put('/api/config/appearance.language', { value: 'invalid' })
      expect(res3.status).toBe(400)
    })

    test('validates theme value', async () => {
      const { put } = createTestApp()

      // Valid themes
      const res1 = await put('/api/config/appearance.theme', { value: 'light' })
      expect(res1.status).toBe(200)

      const res2 = await put('/api/config/appearance.theme', { value: 'dark' })
      expect(res2.status).toBe(200)

      const res3 = await put('/api/config/appearance.theme', { value: 'system' })
      expect(res3.status).toBe(200)

      // Invalid theme
      const res4 = await put('/api/config/appearance.theme', { value: 'invalid' })
      expect(res4.status).toBe(400)
    })

    test('validates timezone value', async () => {
      const { put, get } = createTestApp()

      // Valid IANA timezones
      const res1 = await put('/api/config/appearance.timezone', { value: 'America/New_York' })
      expect(res1.status).toBe(200)

      const res2 = await put('/api/config/appearance.timezone', { value: 'Europe/London' })
      expect(res2.status).toBe(200)

      const res3 = await put('/api/config/appearance.timezone', { value: 'Asia/Tokyo' })
      expect(res3.status).toBe(200)

      const res4 = await put('/api/config/appearance.timezone', { value: 'UTC' })
      expect(res4.status).toBe(200)

      // Verify persistence
      const checkRes = await get('/api/config/appearance.timezone')
      const checkBody = await checkRes.json()
      expect(checkBody.value).toBe('UTC')

      // null is valid (system timezone)
      const res5 = await put('/api/config/appearance.timezone', { value: null })
      expect(res5.status).toBe(200)

      // Empty string converts to null
      const res6 = await put('/api/config/appearance.timezone', { value: '' })
      expect(res6.status).toBe(200)
      const checkRes2 = await get('/api/config/appearance.timezone')
      const checkBody2 = await checkRes2.json()
      expect(checkBody2.value).toBe(null)

      // Invalid timezone
      const res7 = await put('/api/config/appearance.timezone', { value: 'Invalid/Timezone' })
      expect(res7.status).toBe(400)
      const body7 = await res7.json()
      expect(body7.error).toContain('Invalid timezone')
    })

    // The "empty string → null" coercion previously tested via
    // `integrations.githubPat` (the only nullable-on-empty path that also
    // had a `null` default). After D-6 PR 3 dropped that setting, every
    // remaining NULLABLE_ON_EMPTY path defaults to '' or has a typed
    // default that masks `null` in the GET response (`value ?? default`).
    // The coercion itself is still exercised in production via
    // editor.host / remoteFulcrum.host — there's just no isolated test
    // assertion that survives the default-value layer.

    test('returns 400 for unknown key', async () => {
      const { put } = createTestApp()
      const res = await put('/api/config/unknown_key', { value: 'test' })
      const body = await res.json()

      expect(res.status).toBe(400)
      expect(body.error).toContain('Unknown')
    })

    test('validates default agent', async () => {
      const { put } = createTestApp()

      // Valid agents
      const res1 = await put('/api/config/agent.defaultAgent', { value: 'claude' })
      expect(res1.status).toBe(200)

      const res2 = await put('/api/config/agent.defaultAgent', { value: 'opencode' })
      expect(res2.status).toBe(200)

      // Invalid agent
      const res3 = await put('/api/config/agent.defaultAgent', { value: 'invalid' })
      expect(res3.status).toBe(400)
    })

    test('validates default task type', async () => {
      const { put, get } = createTestApp()

      // Valid task types
      const res1 = await put('/api/config/tasks.defaultTaskType', { value: 'worktree' })
      expect(res1.status).toBe(200)

      const res2 = await put('/api/config/tasks.defaultTaskType', { value: 'manual' })
      expect(res2.status).toBe(200)

      // Verify persistence
      const checkRes = await get('/api/config/tasks.defaultTaskType')
      const checkBody = await checkRes.json()
      expect(checkBody.value).toBe('manual')

      // Invalid task type (old values are no longer valid)
      const res3 = await put('/api/config/tasks.defaultTaskType', { value: 'code' })
      expect(res3.status).toBe(400)
      const body3 = await res3.json()
      expect(body3.error).toContain('must be one of')
    })

    test('normalizes legacy task type values on read', async () => {
      const { get } = createTestApp()

      // Inject legacy "code" value directly into fnox cache (simulates un-migrated data)
      setFnoxValue('tasks.defaultTaskType', 'code')

      const res = await get('/api/config/tasks.defaultTaskType')
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.value).toBe('worktree')
    })

    test('validates start worktree tasks immediately', async () => {
      const { put, get } = createTestApp()

      // Valid boolean value
      const res1 = await put('/api/config/tasks.startWorktreeTasksImmediately', { value: false })
      expect(res1.status).toBe(200)

      // Verify persistence
      const checkRes = await get('/api/config/tasks.startWorktreeTasksImmediately')
      const checkBody = await checkRes.json()
      expect(checkBody.value).toBe(false)

      // Set back to true
      const res2 = await put('/api/config/tasks.startWorktreeTasksImmediately', { value: true })
      expect(res2.status).toBe(200)

      // Invalid non-boolean value
      const res3 = await put('/api/config/tasks.startWorktreeTasksImmediately', { value: 'yes' })
      expect(res3.status).toBe(400)
      const body3 = await res3.json()
      expect(body3.error).toContain('must be a boolean')
    })
  })

  describe('DELETE /api/config/:key', () => {
    test('resets key to default value', async () => {
      const { put, request, get } = createTestApp()

      // Set a non-default value
      await put('/api/config/server.port', { value: 9999 })

      // Reset it
      const res = await request('/api/config/server.port', { method: 'DELETE' })
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.isDefault).toBe(true)

      // Verify it's back to default (7777)
      const checkRes = await get('/api/config/server.port')
      const checkBody = await checkRes.json()
      expect(checkBody.value).toBe(7777)
    })

    test('returns 400 for unknown key', async () => {
      const { request } = createTestApp()
      const res = await request('/api/config/unknown_key', { method: 'DELETE' })
      const body = await res.json()

      expect(res.status).toBe(400)
      expect(body.error).toContain('Unknown config key')
    })
  })

  describe('GET /api/config/notifications', () => {
    test('returns notification settings', async () => {
      const { get } = createTestApp()
      const res = await get('/api/config/notifications')
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body).toHaveProperty('enabled')
      expect(body).toHaveProperty('toast')
      expect(body).toHaveProperty('desktop')
      expect(body).toHaveProperty('sound')
      expect(body).toHaveProperty('slack')
      expect(body).toHaveProperty('discord')
      expect(body).toHaveProperty('pushover')
    })
  })

  describe('PUT /api/config/notifications', () => {
    test('updates notification settings', async () => {
      const { put, get } = createTestApp()
      const res = await put('/api/config/notifications', {
        enabled: false,
      })
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.enabled).toBe(false)

      // Verify persistence
      const checkRes = await get('/api/config/notifications')
      const checkBody = await checkRes.json()
      expect(checkBody.enabled).toBe(false)
    })

    test('updates nested notification channel settings', async () => {
      const { put } = createTestApp()
      const res = await put('/api/config/notifications', {
        slack: {
          enabled: true,
          webhookUrl: 'https://hooks.slack.com/services/test',
        },
      })
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.slack.enabled).toBe(true)
      expect(body.slack.webhookUrl).toBe('https://hooks.slack.com/services/test')
    })

    test('returns _updatedAt timestamp in response', async () => {
      const { get } = createTestApp()
      const res = await get('/api/config/notifications')
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body._updatedAt).toBeDefined()
      expect(typeof body._updatedAt).toBe('number')
    })

    test('returns 409 when client has stale timestamp', async () => {
      const { get, put } = createTestApp()

      // Get current settings with timestamp
      const initialRes = await get('/api/config/notifications')
      const initial = await initialRes.json()
      const staleTimestamp = initial._updatedAt

      // Small delay to ensure timestamp changes (millisecond precision)
      await new Promise((resolve) => setTimeout(resolve, 5))

      // Simulate another client updating (changes the server timestamp)
      await put('/api/config/notifications', { enabled: true })

      // Try to update with the stale timestamp
      const conflictRes = await put('/api/config/notifications', {
        enabled: false,
        _updatedAt: staleTimestamp,
      })
      const conflictBody = await conflictRes.json()

      expect(conflictRes.status).toBe(409)
      expect(conflictBody.error).toBe('Settings changed by another client')
      expect(conflictBody.current).toBeDefined()
      expect(conflictBody.current._updatedAt).toBeDefined()
    })

    test('succeeds when client has current timestamp', async () => {
      const { get, put } = createTestApp()

      // Get current settings with timestamp
      const initialRes = await get('/api/config/notifications')
      const initial = await initialRes.json()
      const currentTimestamp = initial._updatedAt

      // Update with the current timestamp
      const res = await put('/api/config/notifications', {
        enabled: false,
        _updatedAt: currentTimestamp,
      })
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.enabled).toBe(false)
    })

    test('succeeds without timestamp for backward compatibility', async () => {
      const { put } = createTestApp()

      // Update without providing _updatedAt
      const res = await put('/api/config/notifications', {
        enabled: true,
      })
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.enabled).toBe(true)
    })
  })

  describe('POST /api/config/notifications/test/:channel', () => {
    test('returns 400 for invalid channel', async () => {
      const { post } = createTestApp()
      const res = await post('/api/config/notifications/test/invalid')
      const body = await res.json()

      expect(res.status).toBe(400)
      expect(body.error).toContain('Invalid channel')
    })

    test('accepts valid channel names', async () => {
      const { post } = createTestApp()

      // Sound channel (doesn't need external config)
      const res = await post('/api/config/notifications/test/sound')
      // Should succeed or fail based on audio availability, not return 400
      expect(res.status).not.toBe(400)
    })
  })

  describe('POST /api/config/notifications/send', () => {
    test('returns 400 when title is missing', async () => {
      const { post } = createTestApp()
      const res = await post('/api/config/notifications/send', {
        message: 'Test message',
      })
      const body = await res.json()

      expect(res.status).toBe(400)
      expect(body.error).toContain('title and message are required')
    })

    test('returns 400 when message is missing', async () => {
      const { post } = createTestApp()
      const res = await post('/api/config/notifications/send', {
        title: 'Test title',
      })
      const body = await res.json()

      expect(res.status).toBe(400)
      expect(body.error).toContain('title and message are required')
    })

    test('sends notification with valid payload', async () => {
      const { post } = createTestApp()
      const res = await post('/api/config/notifications/send', {
        title: 'Test',
        message: 'Test message',
      })
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.success).toBe(true)
      expect(body.results).toBeDefined()
    })
  })

  describe('GET /api/config/z-ai', () => {
    test('returns z.ai settings', async () => {
      const { get } = createTestApp()
      const res = await get('/api/config/z-ai')
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body).toHaveProperty('enabled')
      expect(body).toHaveProperty('apiKey')
    })
  })

  describe('PUT /api/config/z-ai', () => {
    test('updates z.ai settings', async () => {
      const { put } = createTestApp()
      const res = await put('/api/config/z-ai', {
        enabled: true,
        apiKey: 'test-api-key',
      })
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.enabled).toBe(true)
      expect(body.apiKey).toBe('test-api-key')
    })
  })

  describe('GET /api/config/developer-mode', () => {
    test('returns developer mode status', async () => {
      const { get } = createTestApp()
      const res = await get('/api/config/developer-mode')
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(typeof body.enabled).toBe('boolean')
      expect(typeof body.startedAt).toBe('number')
    })
  })

  describe('POST /api/config/restart', () => {
    test('returns 403 when not in developer mode', async () => {
      // Ensure not in developer mode (isDeveloperMode checks FULCRUM_DEVELOPER)
      const originalDev = process.env.FULCRUM_DEVELOPER
      delete process.env.FULCRUM_DEVELOPER

      try {
        const { post } = createTestApp()
        const res = await post('/api/config/restart')
        const body = await res.json()

        expect(res.status).toBe(403)
        expect(body.error).toContain('developer mode')
      } finally {
        // Restore original value
        if (originalDev !== undefined) {
          process.env.FULCRUM_DEVELOPER = originalDev
        }
      }
    })
  })

  describe('CONFIG_KEYS / VALID_SETTING_PATHS drift prevention', () => {
    // Keys that are only exposed through specialized routes, not the generic config API.
    // These are intentionally excluded from CONFIG_KEYS.
    const EXCLUDED_PATHS = new Set([
      // Cloudflare integration keys (managed via integrations routes)
      'integrations.cloudflareApiToken',
      'integrations.cloudflareAccountId',
      // D-8 PR 5: per-tenant CF Access app+policy IDs. Server-only
      // knobs settable via `fulcrum config set`; not exposed in
      // shared/config-keys.ts because no client code reads them.
      'integrations.cloudflareAccessAppId',
      'integrations.cloudflareAccessPolicyId',
      // D-10 PR 8: CF Email Sending opt-in toggle + from address.
      // Same shape — server-only, settable via UI/CLI.
      'integrations.cloudflareEmailEnabled',
      'integrations.cloudflareEmailFromAddress',
      // D-11 PR 2: shared secret between CF Email Worker and our
      // /api/email-events ingest endpoint. Server-only secret.
      'integrations.cloudflareEmailIngestSecret',
      // Channel settings (managed via messaging/channel routes)
      ...Array.from(VALID_SETTING_PATHS).filter(
        (p) => p.startsWith('channels.')
      ),
    ])

    test('every VALID_SETTING_PATHS entry is either in CONFIG_KEYS or explicitly excluded', () => {
      const configValues = new Set(Object.values(CONFIG_KEYS))
      const missing: string[] = []

      for (const path of VALID_SETTING_PATHS) {
        if (!configValues.has(path as string) && !EXCLUDED_PATHS.has(path)) {
          missing.push(path)
        }
      }

      if (missing.length > 0) {
        throw new Error(
          `VALID_SETTING_PATHS contains paths not in CONFIG_KEYS (shared/config-keys.ts):\n` +
            missing.map((p) => `  - ${p}`).join('\n') +
            `\n\nAdd them to CONFIG_KEYS or to the EXCLUDED_PATHS allowlist in this test.`
        )
      }
    })
  })
})
