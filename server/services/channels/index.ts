/**
 * Channel Manager - Orchestrates messaging channels and routes messages to AI assistant.
 * Entry point for the messaging service layer.
 *
 * This module re-exports all channel functionality for backward compatibility.
 * Implementation is split across:
 * - channel-manager.ts: Core lifecycle management
 * - message-handler.ts: Message routing and command handling
 * - api/*.ts: Per-channel API functions
 */

import { log } from '../../lib/logger'
import { db } from '../../db'
import { messagingConnections, messagingSessionMappings } from '../../db/schema'
import { eq, desc } from 'drizzle-orm'
import { activeChannels, DISCORD_CONNECTION_ID, TELEGRAM_CONNECTION_ID, SLACK_CONNECTION_ID } from './channel-manager'
import { storeChannelMessage } from './message-storage'
import {
  getWhatsAppStatus,
  sendWhatsAppMessage,
} from './api/whatsapp'
import {
  getDiscordStatus,
} from './api/discord'
import {
  getTelegramStatus,
} from './api/telegram'
import {
  getSlackStatus,
} from './api/slack'
// Import message-handler to register the handler with channel-manager
import './message-handler'

import { migrateSessionTitles } from './session-mapper'

// Rename existing channel sessions from "Chat with X" to "{Channel} Chat"
migrateSessionTitles()

// Re-export types
export * from './types'

// Re-export session mapper
export * from './session-mapper'

// Re-export channel manager functions
export {
  activeChannels,
  setChannelFactory,
  resetChannelFactory,
  startMessagingChannels,
  stopMessagingChannels,
  listConnections,
  SLACK_CONNECTION_ID,
  DISCORD_CONNECTION_ID,
  TELEGRAM_CONNECTION_ID,
  EMAIL_CONNECTION_ID,
} from './channel-manager'

// Re-export message handler
export { handleIncomingMessage } from './message-handler'

// Re-export WhatsApp API
export {
  getOrCreateWhatsAppConnection,
  enableWhatsApp,
  disableWhatsApp,
  requestWhatsAppAuth,
  disconnectWhatsApp,
  getWhatsAppStatus,
  sendWhatsAppMessage,
} from './api/whatsapp'

// Re-export Discord API
export {
  configureDiscord,
  enableDiscord,
  disableDiscord,
  disconnectDiscord,
  getDiscordStatus,
  getDiscordConfig,
} from './api/discord'

// Re-export Telegram API
export {
  configureTelegram,
  enableTelegram,
  disableTelegram,
  disconnectTelegram,
  getTelegramStatus,
  getTelegramConfig,
} from './api/telegram'

// Re-export Slack API
export {
  configureSlack,
  enableSlack,
  disableSlack,
  disconnectSlack,
  getSlackStatus,
  getSlackConfig,
} from './api/slack'

// Re-export Email API
export {
  configureEmail,
  testEmailCredentials,
  enableEmail,
  disableEmail,
  getEmailStatus,
  getEmailConfig,
  getStoredEmails,
  searchImapEmails,
  fetchAndStoreEmails,
} from './api/email'

// Maps session-based channels to their connection IDs for recipient lookup
const SESSION_CHANNEL_IDS: Record<string, string> = {
  slack: SLACK_CONNECTION_ID,
  discord: DISCORD_CONNECTION_ID,
  telegram: TELEGRAM_CONNECTION_ID,
}

/**
 * Resolve the recipient identifier for a channel by looking up stored state.
 * WhatsApp: user's own phone number from connection displayName (self-chat).
 * Slack/Discord/Telegram: most recent inbound user from session mappings.
 */
export function resolveRecipient(channel: string): string | null {
  if (channel === 'whatsapp') {
    const row = db
      .select({ displayName: messagingConnections.displayName })
      .from(messagingConnections)
      .where(eq(messagingConnections.channelType, 'whatsapp'))
      .get()
    return row?.displayName || null
  }

  const connectionId = SESSION_CHANNEL_IDS[channel]
  if (!connectionId) return null

  const row = db
    .select({ channelUserId: messagingSessionMappings.channelUserId })
    .from(messagingSessionMappings)
    .where(eq(messagingSessionMappings.connectionId, connectionId))
    .orderBy(desc(messagingSessionMappings.lastMessageAt))
    .limit(1)
    .get()
  return row?.channelUserId || null
}

// Connection IDs for active-channel-based messaging
const ACTIVE_CHANNEL_CONFIG: Record<string, {
  connectionId: string
  getStatus: () => { enabled?: boolean; status?: string; displayName?: string | null } | null
}> = {
  discord: { connectionId: DISCORD_CONNECTION_ID, getStatus: getDiscordStatus },
  telegram: { connectionId: TELEGRAM_CONNECTION_ID, getStatus: getTelegramStatus },
  slack: { connectionId: SLACK_CONNECTION_ID, getStatus: getSlackStatus },
}

// Shared send logic for discord, telegram, and slack (all use activeChannels pattern)
async function sendViaActiveChannel(
  channelType: string,
  resolvedTo: string,
  body: string,
  metadata?: Record<string, unknown>,
): Promise<{ success: boolean; error?: string }> {
  const config = ACTIVE_CHANNEL_CONFIG[channelType]
  if (!config) return { success: false, error: `Unknown active channel: ${channelType}` }

  const status = config.getStatus()
  if (!status?.enabled || status.status !== 'connected') {
    return { success: false, error: `${channelType.charAt(0).toUpperCase() + channelType.slice(1)} channel not connected` }
  }

  const channel = Array.from(activeChannels.values()).find((ch) => ch.type === channelType)
  if (!channel) {
    return { success: false, error: `${channelType.charAt(0).toUpperCase() + channelType.slice(1)} channel not active` }
  }

  try {
    const success = await channel.sendMessage(resolvedTo, body, metadata)
    if (!success) {
      return { success: false, error: `Failed to send ${channelType.charAt(0).toUpperCase() + channelType.slice(1)} message` }
    }

    log.messaging.info(`Sent ${channelType} message`, { to: resolvedTo })
    storeChannelMessage({
      channelType,
      connectionId: config.connectionId,
      direction: 'outgoing',
      senderId: status.displayName || 'bot',
      recipientId: resolvedTo,
      content: body,
      metadata,
      messageTimestamp: new Date(),
    })
    return { success: true }
  } catch (err) {
    log.messaging.error(`Failed to send ${channelType} message`, { to: resolvedTo, error: String(err) })
    return { success: false, error: String(err) }
  }
}

// Send via WhatsApp's direct API (not activeChannels pattern)
async function sendViaWhatsApp(
  resolvedTo: string,
  body: string,
): Promise<{ success: boolean; error?: string }> {
  const waStatus = getWhatsAppStatus()
  if (!waStatus?.enabled || waStatus.status !== 'connected') {
    return { success: false, error: 'WhatsApp channel not connected' }
  }

  try {
    await sendWhatsAppMessage(resolvedTo, body)
    log.messaging.info('Sent WhatsApp message', { to: resolvedTo })
    storeChannelMessage({
      channelType: 'whatsapp',
      connectionId: waStatus.id,
      direction: 'outgoing',
      senderId: waStatus.displayName || 'self',
      recipientId: resolvedTo,
      content: body,
      messageTimestamp: new Date(),
    })
    return { success: true }
  } catch (err) {
    log.messaging.error('Failed to send WhatsApp message', { to: resolvedTo, error: String(err) })
    return { success: false, error: String(err) }
  }
}

// Build Slack-specific metadata from options
function buildSlackMetadata(
  options?: { slackBlocks?: Array<Record<string, unknown>>; filePath?: string; slackChannelId?: string },
): Record<string, unknown> | undefined {
  if (!options?.slackBlocks && !options?.filePath && !options?.slackChannelId) return undefined
  return {
    ...(options.slackBlocks && { blocks: options.slackBlocks }),
    ...(options.filePath && { filePath: options.filePath }),
    ...(options.slackChannelId && { slackChannelId: options.slackChannelId }),
  }
}

/**
 * Send a message to a channel.
 * Unified interface for sending messages across all supported channels.
 *
 * Default recipient resolution (D-7 PR 4 extension): when
 * `options.to` is provided, that channel-native id is used directly —
 * Slack `user_id`, Discord snowflake, Telegram chat_id, WhatsApp JID.
 * This is the seam the notification dispatcher uses to route a
 * recipient-addressed payload to the recipient's own DM via the
 * `channel_identity_mappings` table. Without `options.to`, the
 * legacy behavior stands: recipient is auto-resolved from stored
 * channel state (the user who configured the channel).
 */
export async function sendMessageToChannel(
  channel: 'email' | 'whatsapp' | 'discord' | 'telegram' | 'slack',
  body?: string,
  options?: {
    subject?: string
    replyToMessageId?: string
    slackBlocks?: Array<Record<string, unknown>>
    filePath?: string
    /** D-7 PR 4: channel-native recipient id to override the auto-resolver. */
    to?: string
    /**
     * D-15 PR 3: post to a specific Slack channel id (e.g. "C0123ABC") instead of
     * a user DM. The bot's sendMessage routes via chat.postMessage; no DM is opened.
     * `to` is still required as a fallback but is ignored when this is set.
     */
    slackChannelId?: string
  }
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  if (!body) {
    return { success: false, error: 'Message body is required' }
  }

  const explicitTo = options?.to?.trim()
  const resolvedTo = explicitTo || resolveRecipient(channel) || options?.slackChannelId
  if (!resolvedTo) {
    const channelName = channel.charAt(0).toUpperCase() + channel.slice(1)
    return { success: false, error: `No ${channelName} recipient found — no user has messaged via ${channelName} yet` }
  }
  log.messaging.debug('Resolved recipient', { channel, to: resolvedTo, explicit: !!explicitTo })

  switch (channel) {
    case 'email':
      return { success: false, error: 'Email sending disabled. Use Gmail drafts instead.' }

    case 'whatsapp':
      return sendViaWhatsApp(resolvedTo, body)

    case 'discord':
    case 'telegram':
      return sendViaActiveChannel(channel, resolvedTo, body)

    case 'slack': {
      const msgMetadata = buildSlackMetadata(options)
      return sendViaActiveChannel(channel, resolvedTo, body, msgMetadata)
    }

    default:
      return { success: false, error: `Unknown channel: ${channel}` }
  }
}
