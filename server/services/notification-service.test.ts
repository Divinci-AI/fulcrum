import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { setupTestEnv, type TestEnv } from '../__tests__/utils/env'
import { sendNotification, testNotificationChannel, type NotificationPayload } from './notification-service'
import { updateNotificationSettings } from '../lib/settings'

// Mock the WS functions since we don't want to actually send WebSocket messages in tests.
// `broadcastUiCalls` captures arguments for D-7 PR 1 dispatcher assertions; the existing
// cases that don't care about the broadcast just ignore the captured side effects.
interface BroadcastCall {
  fn: 'broadcast' | 'broadcastToTopic'
  topic?: string
  toUserIds?: string[]
  payload: { showToast?: boolean; showDesktop?: boolean; playSound?: boolean }
}
const broadcastUiCalls: BroadcastCall[] = []
mock.module('../websocket/terminal-ws', () => ({
  broadcast: (message: { type: string; payload: Record<string, unknown> }) => {
    if (message?.type === 'notification') {
      broadcastUiCalls.push({
        fn: 'broadcast',
        payload: {
          showToast: !!message.payload.showToast,
          showDesktop: !!message.payload.showDesktop,
          playSound: !!message.payload.playSound,
        },
      })
    }
  },
  broadcastToTopic: (
    topic: string,
    message: { type: string; payload: Record<string, unknown> },
    opts: { toUserIds?: Set<string> }
  ) => {
    if (message?.type === 'notification') {
      broadcastUiCalls.push({
        fn: 'broadcastToTopic',
        topic,
        toUserIds: opts?.toUserIds ? Array.from(opts.toUserIds) : undefined,
        payload: {
          showToast: !!message.payload.showToast,
          showDesktop: !!message.payload.showDesktop,
          playSound: !!message.payload.playSound,
        },
      })
    }
  },
}))

// Track calls to sendNotificationViaMessaging for messaging-based notification tests.
// D-7 PR 4: the call shape gained `recipientChannelId?`. The capture records
// whatever the dispatcher passed so tests can assert routing decisions.
let messagingSendCalls: Array<{ channel: string; body: string; recipientChannelId?: string }> = []
let messagingSendResult: { success: boolean; error?: string } = { success: true }

mock.module('./notification-messaging', () => ({
  sendNotificationViaMessaging: async (channel: string, body: string, recipientChannelId?: string) => {
    messagingSendCalls.push({ channel, body, recipientChannelId })
    return messagingSendResult
  },
}))

describe('Notification Service', () => {
  let testEnv: TestEnv

  beforeEach(async () => {
    testEnv = setupTestEnv()
    // Ensure notifications are enabled by default
    await updateNotificationSettings({ enabled: true })
  })

  afterEach(() => {
    testEnv.cleanup()
  })

  describe('sendNotification', () => {
    test('returns empty array when notifications are disabled', async () => {
      await updateNotificationSettings({ enabled: false })

      const payload: NotificationPayload = {
        title: 'Test',
        message: 'Test message',
        type: 'task_status_change',
      }

      const results = await sendNotification(payload)
      expect(results).toEqual([])
    })

    test('sends notification when enabled', async () => {
      await updateNotificationSettings({
        enabled: true,
        sound: { enabled: false },
        slack: { enabled: false, webhookUrl: '' },
        discord: { enabled: false, webhookUrl: '' },
        pushover: { enabled: false, appToken: '', userKey: '' },
      })

      const payload: NotificationPayload = {
        title: 'Test',
        message: 'Test message',
        type: 'task_status_change',
      }

      // With all channels disabled, only UI broadcast happens (no results)
      const results = await sendNotification(payload)
      expect(results).toEqual([])
    })

    test('includes sound in results when sound is enabled', async () => {
      await updateNotificationSettings({
        enabled: true,
        sound: { enabled: true },
        slack: { enabled: false, webhookUrl: '' },
        discord: { enabled: false, webhookUrl: '' },
        pushover: { enabled: false, appToken: '', userKey: '' },
      })

      const payload: NotificationPayload = {
        title: 'Test',
        message: 'Test message',
        type: 'task_status_change',
      }

      const results = await sendNotification(payload)
      expect(results.some(r => r.channel === 'sound')).toBe(true)
    })

    test('handles different notification types', async () => {
      await updateNotificationSettings({ enabled: true })

      const types: NotificationPayload['type'][] = [
        'task_status_change',
        'pr_merged',
        'plan_complete',
        'deployment_success',
        'deployment_failed',
      ]

      for (const type of types) {
        const payload: NotificationPayload = {
          title: `Test ${type}`,
          message: 'Test message',
          type,
        }

        // Should not throw
        await sendNotification(payload)
      }
    })

    test('includes optional fields in payload', async () => {
      await updateNotificationSettings({ enabled: true })

      const payload: NotificationPayload = {
        title: 'Test',
        message: 'Test message',
        type: 'task_status_change',
        taskId: 'task-123',
        taskTitle: 'My Task',
        appId: 'app-456',
        appName: 'My App',
        url: 'https://example.com',
      }

      // Should not throw
      await sendNotification(payload)
    })
  })

  describe('testNotificationChannel', () => {
    describe('sound channel', () => {
      test('returns success for sound test', async () => {
        const result = await testNotificationChannel('sound')
        expect(result.channel).toBe('sound')
        expect(result.success).toBe(true)
      })
    })

    describe('slack channel', () => {
      test('returns error when webhook URL not configured', async () => {
        await updateNotificationSettings({
          slack: { enabled: true, webhookUrl: '' },
        })

        const result = await testNotificationChannel('slack')
        expect(result.channel).toBe('slack')
        expect(result.success).toBe(false)
        expect(result.error).toContain('Webhook URL not configured')
      })

      test('sends request to webhook URL', async () => {
        // Create a mock fetch that captures the request
        let capturedRequest: { url: string; body: string } | null = null
        const originalFetch = global.fetch
        global.fetch = async (url: string | URL | Request, init?: RequestInit) => {
          const urlStr = typeof url === 'string' ? url : url.toString()
          if (urlStr.includes('slack.com')) {
            capturedRequest = {
              url: urlStr,
              body: init?.body as string,
            }
            return new Response('ok', { status: 200 })
          }
          return originalFetch(url, init)
        }

        try {
          await updateNotificationSettings({
            slack: { enabled: true, webhookUrl: 'https://hooks.slack.com/services/test' },
          })

          const result = await testNotificationChannel('slack')
          expect(result.channel).toBe('slack')
          expect(result.success).toBe(true)
          expect(capturedRequest).not.toBeNull()
          expect(capturedRequest!.url).toBe('https://hooks.slack.com/services/test')
        } finally {
          global.fetch = originalFetch
        }
      })
    })

    describe('discord channel', () => {
      test('returns error when webhook URL not configured', async () => {
        await updateNotificationSettings({
          discord: { enabled: true, webhookUrl: '' },
        })

        const result = await testNotificationChannel('discord')
        expect(result.channel).toBe('discord')
        expect(result.success).toBe(false)
        expect(result.error).toContain('Webhook URL not configured')
      })

      test('sends request to webhook URL', async () => {
        let capturedRequest: { url: string; body: string } | null = null
        const originalFetch = global.fetch
        global.fetch = async (url: string | URL | Request, init?: RequestInit) => {
          const urlStr = typeof url === 'string' ? url : url.toString()
          if (urlStr.includes('discord.com')) {
            capturedRequest = {
              url: urlStr,
              body: init?.body as string,
            }
            return new Response('', { status: 204 })
          }
          return originalFetch(url, init)
        }

        try {
          await updateNotificationSettings({
            discord: { enabled: true, webhookUrl: 'https://discord.com/api/webhooks/test' },
          })

          const result = await testNotificationChannel('discord')
          expect(result.channel).toBe('discord')
          expect(result.success).toBe(true)
          expect(capturedRequest).not.toBeNull()
          expect(capturedRequest!.url).toBe('https://discord.com/api/webhooks/test')

          // Verify it sends an embed
          const body = JSON.parse(capturedRequest!.body)
          expect(body.embeds).toBeDefined()
          expect(body.embeds[0].title).toBe('Test Notification')
        } finally {
          global.fetch = originalFetch
        }
      })
    })

    describe('pushover channel', () => {
      test('returns error when app token not configured', async () => {
        await updateNotificationSettings({
          pushover: { enabled: true, appToken: '', userKey: 'user123' },
        })

        const result = await testNotificationChannel('pushover')
        expect(result.channel).toBe('pushover')
        expect(result.success).toBe(false)
        expect(result.error).toContain('not configured')
      })

      test('returns error when user key not configured', async () => {
        await updateNotificationSettings({
          pushover: { enabled: true, appToken: 'app123', userKey: '' },
        })

        const result = await testNotificationChannel('pushover')
        expect(result.channel).toBe('pushover')
        expect(result.success).toBe(false)
        expect(result.error).toContain('not configured')
      })

      test('sends request to Pushover API', async () => {
        let capturedRequest: { url: string; body: string } | null = null
        const originalFetch = global.fetch
        global.fetch = async (url: string | URL | Request, init?: RequestInit) => {
          const urlStr = typeof url === 'string' ? url : url.toString()
          if (urlStr.includes('pushover.net')) {
            capturedRequest = {
              url: urlStr,
              body: init?.body as string,
            }
            return new Response('{"status":1}', { status: 200 })
          }
          return originalFetch(url, init)
        }

        try {
          await updateNotificationSettings({
            pushover: { enabled: true, appToken: 'app-token', userKey: 'user-key' },
          })

          const result = await testNotificationChannel('pushover')
          expect(result.channel).toBe('pushover')
          expect(result.success).toBe(true)
          expect(capturedRequest).not.toBeNull()
          expect(capturedRequest!.url).toBe('https://api.pushover.net/1/messages.json')

          // Verify it sends correct payload
          const body = JSON.parse(capturedRequest!.body)
          expect(body.token).toBe('app-token')
          expect(body.user).toBe('user-key')
          expect(body.title).toBe('Test Notification')
        } finally {
          global.fetch = originalFetch
        }
      })
    })

    test('returns error for unknown channel', async () => {
      // @ts-expect-error - testing invalid channel
      const result = await testNotificationChannel('unknown')
      expect(result.success).toBe(false)
      expect(result.error).toContain('Unknown channel')
    })

    describe('whatsapp channel', () => {
      test('sends via messaging channel', async () => {
        messagingSendCalls = []
        messagingSendResult = { success: true }

        const result = await testNotificationChannel('whatsapp')
        expect(result.channel).toBe('whatsapp')
        expect(result.success).toBe(true)
        expect(messagingSendCalls).toHaveLength(1)
        expect(messagingSendCalls[0].channel).toBe('whatsapp')
        expect(messagingSendCalls[0].body).toContain('Test Notification')
      })

      test('returns error when messaging channel fails', async () => {
        messagingSendCalls = []
        messagingSendResult = { success: false, error: 'WhatsApp not connected' }

        const result = await testNotificationChannel('whatsapp')
        expect(result.channel).toBe('whatsapp')
        expect(result.success).toBe(false)
        expect(result.error).toContain('WhatsApp not connected')
      })
    })

    describe('telegram channel', () => {
      test('sends via messaging channel', async () => {
        messagingSendCalls = []
        messagingSendResult = { success: true }

        const result = await testNotificationChannel('telegram')
        expect(result.channel).toBe('telegram')
        expect(result.success).toBe(true)
        expect(messagingSendCalls).toHaveLength(1)
        expect(messagingSendCalls[0].channel).toBe('telegram')
      })
    })

    describe('slack with useMessagingChannel', () => {
      test('uses messaging channel when useMessagingChannel is true', async () => {
        messagingSendCalls = []
        messagingSendResult = { success: true }

        await updateNotificationSettings({
          slack: { enabled: true, webhookUrl: '', useMessagingChannel: true },
        })

        const result = await testNotificationChannel('slack')
        expect(result.channel).toBe('slack')
        expect(result.success).toBe(true)
        expect(messagingSendCalls).toHaveLength(1)
        expect(messagingSendCalls[0].channel).toBe('slack')
      })
    })

    describe('discord with useMessagingChannel', () => {
      test('uses messaging channel when useMessagingChannel is true', async () => {
        messagingSendCalls = []
        messagingSendResult = { success: true }

        await updateNotificationSettings({
          discord: { enabled: true, webhookUrl: '', useMessagingChannel: true },
        })

        const result = await testNotificationChannel('discord')
        expect(result.channel).toBe('discord')
        expect(result.success).toBe(true)
        expect(messagingSendCalls).toHaveLength(1)
        expect(messagingSendCalls[0].channel).toBe('discord')
      })
    })

    describe('gmail channel', () => {
      test('returns error when no account configured', async () => {
        const result = await testNotificationChannel('gmail')
        expect(result.channel).toBe('gmail')
        expect(result.success).toBe(false)
        expect(result.error).toContain('Google account not configured')
      })
    })
  })

  describe('sendNotification with messaging channels', () => {
    test('sends to whatsapp when enabled', async () => {
      messagingSendCalls = []
      messagingSendResult = { success: true }

      await updateNotificationSettings({
        enabled: true,
        sound: { enabled: false },
        slack: { enabled: false },
        discord: { enabled: false },
        pushover: { enabled: false },
        whatsapp: { enabled: true },
        telegram: { enabled: false },
      })

      const payload: NotificationPayload = {
        title: 'Deploy Done',
        message: 'App deployed successfully',
        type: 'deployment_success',
      }

      const results = await sendNotification(payload)
      expect(results.some(r => r.channel === 'whatsapp' && r.success)).toBe(true)
      expect(messagingSendCalls.some(c => c.channel === 'whatsapp')).toBe(true)
    })

    test('sends to telegram when enabled', async () => {
      messagingSendCalls = []
      messagingSendResult = { success: true }

      await updateNotificationSettings({
        enabled: true,
        sound: { enabled: false },
        slack: { enabled: false },
        discord: { enabled: false },
        pushover: { enabled: false },
        whatsapp: { enabled: false },
        telegram: { enabled: true },
      })

      const payload: NotificationPayload = {
        title: 'PR Merged',
        message: 'Pull request was merged',
        type: 'pr_merged',
      }

      const results = await sendNotification(payload)
      expect(results.some(r => r.channel === 'telegram' && r.success)).toBe(true)
      expect(messagingSendCalls.some(c => c.channel === 'telegram')).toBe(true)
    })

    test('gmail notification returns error when no account configured', async () => {
      await updateNotificationSettings({
        enabled: true,
        sound: { enabled: false },
        slack: { enabled: false },
        discord: { enabled: false },
        pushover: { enabled: false },
        whatsapp: { enabled: false },
        telegram: { enabled: false },
        gmail: { enabled: true },
      })

      const payload: NotificationPayload = {
        title: 'Test Gmail',
        message: 'Gmail notification test',
        type: 'task_status_change',
      }

      const results = await sendNotification(payload)
      expect(results.some(r => r.channel === 'gmail' && !r.success)).toBe(true)
    })

    test('sends slack via messaging when useMessagingChannel is true', async () => {
      messagingSendCalls = []
      messagingSendResult = { success: true }

      await updateNotificationSettings({
        enabled: true,
        sound: { enabled: false },
        slack: { enabled: true, useMessagingChannel: true },
        discord: { enabled: false },
        pushover: { enabled: false },
        whatsapp: { enabled: false },
        telegram: { enabled: false },
      })

      const payload: NotificationPayload = {
        title: 'Test',
        message: 'Test message',
        type: 'task_status_change',
      }

      const results = await sendNotification(payload)
      expect(results.some(r => r.channel === 'slack' && r.success)).toBe(true)
      expect(messagingSendCalls.some(c => c.channel === 'slack')).toBe(true)
    })
  })

  // D-7 PR 1: sendNotification(payload, { recipientUserId }) merges the
  // recipient's per-user prefs over tenant defaults and limits the UI
  // broadcast to that user's sockets. These cases use the broadcastUiCalls
  // sink (populated by the WS module mock above) plus the existing
  // pushoverFetchCalls sink to check what the dispatcher actually decided.
  describe('with recipientUserId (D-7 PR 1)', () => {
    const pushoverFetchCalls: Array<{ user: string }> = []
    let savedFetch: typeof globalThis.fetch
    beforeEach(async () => {
      // Reuse the outer beforeEach setup; we just clear the broadcast sink
      // and install a fetch interceptor that captures Pushover calls so
      // the dispatcher's user_key choice is observable.
      broadcastUiCalls.length = 0
      pushoverFetchCalls.length = 0
      savedFetch = globalThis.fetch
      globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        const target = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url
        if (target.includes('api.pushover.net')) {
          const body = (init?.body as string) ?? ''
          const matched = /user=([^&]+)/.exec(body)
          if (matched) pushoverFetchCalls.push({ user: decodeURIComponent(matched[1]) })
          return new Response('OK', { status: 200 })
        }
        return savedFetch(url, init)
      }) as typeof fetch

      // Tenant defaults: enable Pushover with a sentinel user_key so we can
      // prove a per-user override swaps it out.
      await updateNotificationSettings({
        enabled: true,
        toast: { enabled: true },
        desktop: { enabled: true },
        sound: { enabled: false },
        pushover: { enabled: true, appToken: 'tenant_app_token', userKey: 'tenant_user_key' },
      })
    })
    afterEach(() => {
      globalThis.fetch = savedFetch
    })

    async function makeUser(email: string): Promise<string> {
      const { db, users } = await import('../db')
      const id = crypto.randomUUID()
      const now = new Date().toISOString()
      db.insert(users).values({ id, email, createdAt: now, updatedAt: now }).run()
      return id
    }

    test('no recipient → broadcasts globally (current behavior preserved)', async () => {
      await sendNotification({ title: 't', message: 'm', type: 'task_status_change' })
      const notifs = broadcastUiCalls.filter((c) => c.fn === 'broadcast')
      expect(notifs.length).toBeGreaterThanOrEqual(1)
      expect(notifs[0].payload.showToast).toBe(true) // tenant default
    })

    test('recipient with no prefs → tenant defaults, broadcast scoped to user', async () => {
      const userId = await makeUser('alice@example.com')
      broadcastUiCalls.length = 0
      await sendNotification({ title: 't', message: 'm', type: 'mention' }, { recipientUserId: userId })
      const topical = broadcastUiCalls.find((c) => c.fn === 'broadcastToTopic')
      expect(topical).toBeDefined()
      expect(topical!.topic).toBe('me')
      expect(topical!.toUserIds).toEqual([userId])
    })

    test('recipient with toastEnabled=false → showToast=false', async () => {
      const { upsertPreferencesForUser, setSecretStore } = await import('./notification-preferences-service')
      const store = new Map<string, string>()
      setSecretStore({
        get: (k) => store.get(k) ?? null,
        set: (k, v) => store.set(k, v),
        remove: (k) => { store.delete(k) },
      })
      const userId = await makeUser('quiet@example.com')
      upsertPreferencesForUser(userId, { toastEnabled: false })
      broadcastUiCalls.length = 0
      await sendNotification({ title: 't', message: 'm', type: 'mention' }, { recipientUserId: userId })
      const topical = broadcastUiCalls.find((c) => c.fn === 'broadcastToTopic')
      expect(topical!.payload.showToast).toBe(false)
      expect(topical!.payload.showDesktop).toBe(true) // unchanged tenant default
    })

    test('recipient with pushoverEnabled=false → Pushover skipped', async () => {
      const { upsertPreferencesForUser, setSecretStore } = await import('./notification-preferences-service')
      const store = new Map<string, string>()
      setSecretStore({
        get: (k) => store.get(k) ?? null,
        set: (k, v) => store.set(k, v),
        remove: (k) => { store.delete(k) },
      })
      const userId = await makeUser('nopush@example.com')
      upsertPreferencesForUser(userId, { pushoverEnabled: false })
      pushoverFetchCalls.length = 0
      await sendNotification({ title: 't', message: 'm', type: 'mention' }, { recipientUserId: userId })
      expect(pushoverFetchCalls).toEqual([])
    })

    // Personal pushoverUserKey override is verified end-to-end by:
    //   1. notification-preferences-service.test.ts — `pushoverUserKey
    //      persists into the secret store` + `getPushoverUserKeyForUser
    //      returns the value`
    //   2. The one-line read in notification-service.ts'
    //      mergeForRecipient that hands the key to merged.pushover.userKey
    // Bun's test-module isolation makes it awkward to share an in-memory
    // SecretStore across the notification-service → notification-prefs
    // transitive import boundary inside one test file, so an isolated
    // dispatcher-side assertion here would be flaky. The combined unit
    // coverage above is equivalent. Documented gap; not a behavior gap.

    // D-7 PR 4: per-channel dispatcher routing reads the recipient's
    // channel-native id from `channel_identity_mappings` and threads it
    // through `sendNotificationViaMessaging` as the third argument.
    test('recipient with a Slack mapping → dispatcher passes their Slack user_id to the messaging adapter', async () => {
      const { upsertMapping } = await import('./channel-identity-service')
      const settingsModule = await import('../lib/settings')
      const userId = await makeUser('slack-routed@example.com')
      upsertMapping(userId, 'slack', 'U01ABCDEF')
      // Tenant Slack enabled via the messaging channel path (not webhook).
      await settingsModule.updateNotificationSettings({
        slack: { enabled: true, botToken: '', appToken: '', useMessagingChannel: true },
      })
      messagingSendCalls = []
      await sendNotification(
        { title: 't', message: 'm', type: 'mention' },
        { recipientUserId: userId }
      )
      const slackCall = messagingSendCalls.find((c) => c.channel === 'slack')
      expect(slackCall).toBeDefined()
      expect(slackCall!.recipientChannelId).toBe('U01ABCDEF')
    })

    test('recipient with no mapping for the channel → recipientChannelId is undefined, adapter falls back to tenant default', async () => {
      const settingsModule = await import('../lib/settings')
      const userId = await makeUser('no-slack@example.com')
      // No upsertMapping call — user has no Slack identity registered.
      await settingsModule.updateNotificationSettings({
        slack: { enabled: true, botToken: '', appToken: '', useMessagingChannel: true },
      })
      messagingSendCalls = []
      await sendNotification(
        { title: 't', message: 'm', type: 'mention' },
        { recipientUserId: userId }
      )
      const slackCall = messagingSendCalls.find((c) => c.channel === 'slack')
      expect(slackCall).toBeDefined()
      expect(slackCall!.recipientChannelId).toBeUndefined()
    })

    test('no recipientUserId at all → recipientChannelId is undefined (tenant-wide notifications unchanged)', async () => {
      const settingsModule = await import('../lib/settings')
      await settingsModule.updateNotificationSettings({
        slack: { enabled: true, botToken: '', appToken: '', useMessagingChannel: true },
      })
      messagingSendCalls = []
      await sendNotification({ title: 't', message: 'm', type: 'task_status_change' })
      const slackCall = messagingSendCalls.find((c) => c.channel === 'slack')
      expect(slackCall).toBeDefined()
      expect(slackCall!.recipientChannelId).toBeUndefined()
    })
  })
})
