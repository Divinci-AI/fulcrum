import {
  getNotificationSettings,
  type NotificationSettings,
  type SlackNotificationConfig,
  type DiscordNotificationConfig,
  type PushoverNotificationConfig,
  type GmailNotificationConfig,
} from '../lib/settings'
import { broadcast, broadcastToTopic } from '../websocket/terminal-ws'
import { log } from '../lib/logger'
import { sendNotificationViaMessaging } from './notification-messaging'
import { eq } from 'drizzle-orm'
import { db, googleAccounts } from '../db'
import {
  getPreferencesForUser,
  getPushoverUserKeyForUser,
} from './notification-preferences-service'
import {
  getChannelIdentityForUser,
  type ChannelType,
} from './channel-identity-service'

export interface NotificationPayload {
  title: string
  message: string
  taskId?: string
  taskTitle?: string
  appId?: string
  appName?: string
  type: 'task_status_change' | 'pr_merged' | 'plan_complete' | 'deployment_success' | 'deployment_failed' | 'mention'
  url?: string
}

export interface NotificationResult {
  channel: string
  success: boolean
  error?: string
}

// Play notification sound via frontend (web audio)
// The server just signals to play; the frontend handles actual playback
async function sendSoundNotification(): Promise<NotificationResult> {
  // Sound is played by the frontend via WebSocket notification
  // This function exists for the test endpoint
  return { channel: 'sound', success: true }
}

// Send Slack notification via webhook
async function sendSlackNotification(
  config: SlackNotificationConfig,
  payload: NotificationPayload
): Promise<NotificationResult> {
  if (!config.webhookUrl) {
    return { channel: 'slack', success: false, error: 'Webhook URL not configured' }
  }

  try {
    const blocks = [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*${payload.title}*\n${payload.message}` },
      },
    ]

    if (payload.url) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `<${payload.url}|View Task>` },
      })
    }

    const response = await fetch(config.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: payload.title, blocks }),
    })

    if (response.ok) {
      return { channel: 'slack', success: true }
    } else {
      return { channel: 'slack', success: false, error: `HTTP ${response.status}` }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { channel: 'slack', success: false, error: message }
  }
}

// Send Discord notification via webhook
async function sendDiscordNotification(
  config: DiscordNotificationConfig,
  payload: NotificationPayload
): Promise<NotificationResult> {
  if (!config.webhookUrl) {
    return { channel: 'discord', success: false, error: 'Webhook URL not configured' }
  }

  try {
    const embed = {
      title: payload.title,
      description: payload.message,
      color: 0x5865f2, // Discord blurple
      url: payload.url,
    }

    const response = await fetch(config.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] }),
    })

    if (response.ok || response.status === 204) {
      return { channel: 'discord', success: true }
    } else {
      return { channel: 'discord', success: false, error: `HTTP ${response.status}` }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { channel: 'discord', success: false, error: message }
  }
}

// Send Pushover notification via API
async function sendPushoverNotification(
  config: PushoverNotificationConfig,
  payload: NotificationPayload
): Promise<NotificationResult> {
  if (!config.appToken || !config.userKey) {
    return { channel: 'pushover', success: false, error: 'App token or user key not configured' }
  }

  try {
    const body: Record<string, string> = {
      token: config.appToken,
      user: config.userKey,
      title: payload.title,
      message: payload.message,
    }

    if (payload.url) {
      body.url = payload.url
      body.url_title = 'View Task'
    }

    const response = await fetch('https://api.pushover.net/1/messages.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    if (response.ok) {
      return { channel: 'pushover', success: true }
    } else {
      const text = await response.text()
      return { channel: 'pushover', success: false, error: `HTTP ${response.status}: ${text}` }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { channel: 'pushover', success: false, error: message }
  }
}

// Send notification via a messaging channel (WhatsApp, Telegram, Slack, Discord).
//
// D-7 PR 4: when `recipientUserId` is provided, look up the recipient's
// channel-native id from `channel_identity_mappings` and thread it through
// to the unified `sendMessageToChannel`. When the user has no mapping for
// this channel, the channel adapter falls back to its tenant-default
// auto-resolved recipient — same behavior as before per-user routing.
//
// D-15 PR 3 (Slack only): when `slackConfig.eventChannels[payload.type]` (or
// `slackConfig.defaultChannel`) is set, the notification posts to that Slack
// channel instead of being DM'd to a user. Event-channel routing takes
// precedence over per-user DM — the typical use is "post all deploy events
// to #deploys" overriding "DM each subscribed user".
async function sendViaMessagingChannel(
  channel: 'whatsapp' | 'discord' | 'telegram' | 'slack',
  payload: NotificationPayload,
  recipientUserId?: string,
  slackConfig?: SlackNotificationConfig
): Promise<NotificationResult> {
  const text = `*${payload.title}*\n${payload.message}${payload.url ? `\n${payload.url}` : ''}`

  const slackChannelId =
    channel === 'slack' && slackConfig
      ? slackConfig.eventChannels?.[payload.type] ?? slackConfig.defaultChannel ?? undefined
      : undefined

  // When routing to a channel, skip per-user DM resolution entirely.
  const recipientChannelId = slackChannelId
    ? undefined
    : recipientUserId
      ? getChannelIdentityForUser(recipientUserId, channel as ChannelType) ?? undefined
      : undefined

  try {
    const result = await sendNotificationViaMessaging(channel, text, recipientChannelId, slackChannelId)
    if (result.success) {
      return { channel, success: true }
    }
    return { channel, success: false, error: result.error }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { channel, success: false, error: message }
  }
}

// Auto-resolve Gmail account: if no accountId configured, use the only Gmail-enabled account
function autoResolveGmailAccountId(): string | null {
  const accounts = db
    .select({ id: googleAccounts.id })
    .from(googleAccounts)
    .where(eq(googleAccounts.gmailEnabled, true))
    .all()
  if (accounts.length === 1) return accounts[0].id
  return null
}

// Send Gmail notification via Gmail API
async function sendGmailNotification(
  config: GmailNotificationConfig,
  payload: NotificationPayload
): Promise<NotificationResult> {
  const accountId = config.googleAccountId || autoResolveGmailAccountId()
  if (!accountId) {
    return { channel: 'gmail', success: false, error: 'Google account not configured' }
  }

  try {
    const { sendEmail } = await import('./google/gmail-service')
    const subject = `Fulcrum: ${payload.title}`
    const body = `${payload.title}\n\n${payload.message}${payload.url ? `\n\n${payload.url}` : ''}`
    await sendEmail(accountId, { subject, body })
    return { channel: 'gmail', success: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { channel: 'gmail', success: false, error: message }
  }
}

// Broadcast notification to UI via WebSocket
function broadcastUINotification(
  payload: NotificationPayload,
  options: {
    showToast: boolean
    showDesktop: boolean
    playSound: boolean
    isCustomSound: boolean
  }
): void {
  const notificationType =
    payload.type === 'pr_merged' || payload.type === 'plan_complete' || payload.type === 'deployment_success'
      ? 'success'
      : payload.type === 'deployment_failed'
        ? 'error'
        : 'info'

  broadcast({
    type: 'notification',
    payload: {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      title: payload.title,
      message: payload.message,
      notificationType,
      taskId: payload.taskId,
      showToast: options.showToast, // Whether to show in-app toast
      showDesktop: options.showDesktop, // Whether to show browser/desktop notification
      playSound: options.playSound, // Tell desktop app to play local sound
      isCustomSound: options.isCustomSound, // Whether user has custom sound file (affects notification icon)
    },
  })
}

// Build list of enabled channel dispatchers from current settings.
//
// D-7 PR 4: when `recipientUserId` is provided, the messaging-channel
// path threads it down to `sendViaMessagingChannel` so per-channel routing
// can look up the user's channel-native id and DM them directly. Channels
// that go via webhook (sendSlackNotification/sendDiscordNotification when
// useMessagingChannel is false) are tenant-wide by nature and untouched.
function getChannelDispatchers(
  settings: NotificationSettings,
  payload: NotificationPayload,
  recipientUserId?: string
): Array<{ channel: string; send: () => Promise<NotificationResult> }> {
  const dispatchers: Array<{ channel: string; send: () => Promise<NotificationResult> }> = []

  if (settings.sound?.enabled) {
    dispatchers.push({ channel: 'sound', send: () => sendSoundNotification() })
  }

  if (settings.slack?.enabled) {
    dispatchers.push({
      channel: 'slack',
      send: () => settings.slack!.useMessagingChannel
        ? sendViaMessagingChannel('slack', payload, recipientUserId, settings.slack!)
        : sendSlackNotification(settings.slack!, payload),
    })
  }

  if (settings.discord?.enabled) {
    dispatchers.push({
      channel: 'discord',
      send: () => settings.discord!.useMessagingChannel
        ? sendViaMessagingChannel('discord', payload, recipientUserId)
        : sendDiscordNotification(settings.discord!, payload),
    })
  }

  if (settings.pushover?.enabled) {
    dispatchers.push({ channel: 'pushover', send: () => sendPushoverNotification(settings.pushover!, payload) })
  }

  if (settings.whatsapp?.enabled) {
    dispatchers.push({ channel: 'whatsapp', send: () => sendViaMessagingChannel('whatsapp', payload, recipientUserId) })
  }

  if (settings.telegram?.enabled) {
    dispatchers.push({ channel: 'telegram', send: () => sendViaMessagingChannel('telegram', payload, recipientUserId) })
  }

  if (settings.gmail?.enabled) {
    dispatchers.push({ channel: 'gmail', send: () => sendGmailNotification(settings.gmail!, payload) })
  }

  return dispatchers
}

// D-7 PR 1: merge tenant defaults with a user's per-user preferences. Each
// boolean toggle in the prefs row is tri-state: NULL = inherit tenant
// default; true/false = override. For Pushover, if the user has stored a
// personal user key it replaces the tenant userKey (the appToken stays
// tenant-wide since it's per-app, not per-recipient).
function mergeForRecipient(
  settings: NotificationSettings,
  userId: string
): NotificationSettings {
  const prefs = getPreferencesForUser(userId)
  if (!prefs) return settings

  const merged: NotificationSettings = {
    ...settings,
    toast: {
      ...settings.toast,
      enabled: prefs.toastEnabled ?? settings.toast?.enabled ?? true,
    },
    desktop: {
      ...settings.desktop,
      enabled: prefs.desktopEnabled ?? settings.desktop?.enabled ?? true,
    },
    sound: {
      ...settings.sound,
      enabled: prefs.soundEnabled ?? settings.sound?.enabled ?? false,
    },
    pushover: {
      ...settings.pushover,
      enabled: prefs.pushoverEnabled ?? settings.pushover?.enabled ?? false,
    },
  }

  if (prefs.pushoverUserKeyFnox) {
    const userKey = getPushoverUserKeyForUser(userId)
    if (userKey) {
      merged.pushover = { ...merged.pushover, userKey }
    }
  }

  return merged
}

// Send notification to all enabled channels.
//
// D-7 PR 1: when `options.recipientUserId` is set, the dispatcher merges
// the tenant-wide settings with that user's per-user preferences (stored
// by D-6 PR 4) and routes the UI broadcast to the recipient's WS
// connections only — other users no longer see toasts/desktop pings for
// notifications addressed to someone else. When the parameter is absent
// the behavior is unchanged from before.
export async function sendNotification(
  payload: NotificationPayload,
  options?: { recipientUserId?: string }
): Promise<NotificationResult[]> {
  const tenantSettings = getNotificationSettings()

  if (!tenantSettings.enabled) {
    return []
  }

  const recipientUserId = options?.recipientUserId
  const settings = recipientUserId
    ? mergeForRecipient(tenantSettings, recipientUserId)
    : tenantSettings

  // Broadcast to UI. With a recipient, scope to that user's WS connections
  // via `broadcastToTopic('me', …, { toUserIds })` so other tenants in the
  // same instance don't see toasts/desktop pings meant for someone else.
  // Without a recipient, behave as before (broadcast to all clients).
  const notificationType: 'success' | 'info' | 'warning' | 'error' =
    payload.type === 'pr_merged' || payload.type === 'plan_complete' || payload.type === 'deployment_success'
      ? 'success'
      : payload.type === 'deployment_failed'
      ? 'error'
      : 'info'

  // D-10 PR 7: silenceTaskMoves overrides the global sound flag for
  // task_status_change events (the kanban-drag-between-columns case).
  // Default true — the goat bleat on every move was noisy enough to
  // draw a "remove the noises" request. Toggle off in Settings →
  // Notifications to bring the chimes back.
  const silenceTaskMoves = settings.sound?.silenceTaskMoves ?? true
  const playSound =
    (settings.sound?.enabled ?? false) &&
    !(silenceTaskMoves && payload.type === 'task_status_change')

  const uiPayload = {
    type: 'notification' as const,
    payload: {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      title: payload.title,
      message: payload.message,
      notificationType,
      taskId: payload.taskId,
      showToast: settings.toast?.enabled ?? true,
      showDesktop: settings.desktop?.enabled ?? true,
      playSound,
      isCustomSound: !!settings.sound?.customSoundFile,
    },
  }
  if (recipientUserId) {
    broadcastToTopic('me', uiPayload, { toUserIds: new Set([recipientUserId]) })
  } else {
    broadcast(uiPayload)
  }

  const results: NotificationResult[] = []
  const dispatchers = getChannelDispatchers(settings, payload, recipientUserId)

  await Promise.allSettled(
    dispatchers.map((d) =>
      d.send()
        .then((r) => results.push(r))
        .catch((e) => results.push({ channel: d.channel, success: false, error: e.message }))
    )
  )

  for (const result of results) {
    if (!result.success) {
      log.notification.warn('Notification failed', { channel: result.channel, error: result.error })
    }
  }

  return results
}

// Test a specific notification channel
export async function testNotificationChannel(
  channel: 'sound' | 'slack' | 'discord' | 'pushover' | 'whatsapp' | 'telegram' | 'gmail',
  settings?: NotificationSettings
): Promise<NotificationResult> {
  const config = settings ?? getNotificationSettings()
  const testPayload: NotificationPayload = {
    title: 'Test Notification',
    message: 'This is a test notification from Fulcrum.',
    type: 'task_status_change',
  }

  switch (channel) {
    case 'sound':
      // Broadcast to UI to play sound (frontend handles actual playback)
      broadcastUINotification(testPayload, {
        showToast: false, // Don't show toast for sound test
        showDesktop: false, // Don't show desktop notification for sound test
        playSound: true,
        isCustomSound: !!config.sound?.customSoundFile,
      })
      return { channel: 'sound', success: true }
    case 'slack':
      if (config.slack?.useMessagingChannel) {
        return sendViaMessagingChannel('slack', testPayload)
      }
      return sendSlackNotification(config.slack, testPayload)
    case 'discord':
      if (config.discord?.useMessagingChannel) {
        return sendViaMessagingChannel('discord', testPayload)
      }
      return sendDiscordNotification(config.discord, testPayload)
    case 'pushover':
      return sendPushoverNotification(config.pushover, testPayload)
    case 'whatsapp':
      return sendViaMessagingChannel('whatsapp', testPayload)
    case 'telegram':
      return sendViaMessagingChannel('telegram', testPayload)
    case 'gmail':
      return sendGmailNotification(config.gmail, testPayload)
    default:
      return { channel, success: false, error: 'Unknown channel' }
  }
}