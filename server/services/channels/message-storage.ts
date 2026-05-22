/**
 * Unified message storage for all messaging channels.
 * Stores ALL channel messages (WhatsApp, Discord, Telegram, Slack, Email) in a single table.
 */

import { eq, desc, like, or, and, gt, lt, sql, type SQL } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { db, channelMessages } from '../../db'
import type { ChannelMessageMetadata } from '../../db/schema'
import type { ChannelType } from './types'
import { log } from '../../lib/logger'
import { resolveInboundUserId } from '../channel-identity-service'

/**
 * Parameters for storing a channel message.
 */
export interface StoreChannelMessageParams {
  channelType: ChannelType
  connectionId: string
  direction: 'incoming' | 'outgoing'
  senderId: string
  senderName?: string
  recipientId?: string
  content: string
  metadata?: ChannelMessageMetadata
  messageTimestamp: Date | string
}

/**
 * Store a channel message in the local database.
 *
 * D-7 PR 6: incoming messages are attributed to a Fulcrum user via
 * `resolveInboundUserId` (channel_identity_mappings for the four messaging
 * channels, users.email for email). Outgoing messages aren't attributed
 * here — the recipient-targeting story lives in the dispatcher path
 * (sendNotification's recipientUserId).
 */
export function storeChannelMessage(params: StoreChannelMessageParams): string {
  const now = new Date().toISOString()
  const id = nanoid()

  // Convert timestamp to ISO string if it's a Date
  const messageTimestamp =
    params.messageTimestamp instanceof Date
      ? params.messageTimestamp.toISOString()
      : params.messageTimestamp

  const userId =
    params.direction === 'incoming'
      ? resolveInboundUserId(params.channelType, params.senderId)
      : null

  db.insert(channelMessages)
    .values({
      id,
      channelType: params.channelType,
      connectionId: params.connectionId,
      direction: params.direction,
      senderId: params.senderId,
      senderName: params.senderName,
      recipientId: params.recipientId,
      content: params.content,
      metadata: params.metadata,
      messageTimestamp,
      createdAt: now,
      userId,
    })
    .run()

  log.messaging.debug('Channel message stored', {
    id,
    channelType: params.channelType,
    connectionId: params.connectionId,
    direction: params.direction,
    senderId: params.senderId,
    userId,
  })

  return id
}

/**
 * Options for querying channel messages.
 */
export interface GetChannelMessagesOptions {
  channelType?: ChannelType | 'all'
  connectionId?: string
  direction?: 'incoming' | 'outgoing'
  search?: string
  limit?: number
  offset?: number
}

/**
 * Get channel messages with optional filters.
 */
export function getChannelMessages(
  options: GetChannelMessagesOptions = {}
): typeof channelMessages.$inferSelect[] {
  const conditions: SQL[] = []

  if (options.channelType && options.channelType !== 'all') {
    conditions.push(eq(channelMessages.channelType, options.channelType))
  }

  if (options.connectionId) {
    conditions.push(eq(channelMessages.connectionId, options.connectionId))
  }

  if (options.direction) {
    conditions.push(eq(channelMessages.direction, options.direction))
  }

  if (options.search) {
    const searchTerm = `%${options.search}%`
    conditions.push(
      or(
        like(channelMessages.content, searchTerm),
        like(channelMessages.senderId, searchTerm),
        like(channelMessages.senderName, searchTerm)
      )!
    )
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined

  const results = db
    .select()
    .from(channelMessages)
    .where(whereClause)
    .orderBy(desc(channelMessages.messageTimestamp))
    .limit(options.limit ?? 50)
    .offset(options.offset ?? 0)
    .all()

  return results
}

/**
 * Get a single channel message by ID.
 */
export function getChannelMessageById(
  id: string
): typeof channelMessages.$inferSelect | undefined {
  return db
    .select()
    .from(channelMessages)
    .where(eq(channelMessages.id, id))
    .get()
}

/**
 * A lightweight channel message for injecting into assistant context.
 */
export interface ChannelHistoryMessage {
  direction: 'incoming' | 'outgoing'
  senderName: string | null
  content: string
  messageTimestamp: string
}

/**
 * Get recent channel messages (both incoming and outgoing) for a connection.
 * Used to give the observer context about recent conversation history.
 */
export function getRecentChannelMessages(
  connectionId: string,
  options: { before?: string; limit?: number } = {}
): ChannelHistoryMessage[] {
  const { before, limit = 5 } = options

  const conditions = [
    eq(channelMessages.connectionId, connectionId),
  ]

  if (before) {
    conditions.push(lt(channelMessages.messageTimestamp, before))
  }

  const results = db
    .select({
      direction: channelMessages.direction,
      senderName: channelMessages.senderName,
      content: channelMessages.content,
      messageTimestamp: channelMessages.messageTimestamp,
    })
    .from(channelMessages)
    .where(and(...conditions))
    .orderBy(desc(channelMessages.messageTimestamp))
    .limit(limit)
    .all()

  // Reverse to chronological order (query returns newest first).
  // drizzle's text column infers direction as string; assert the narrow
  // ChannelHistoryMessage union at the boundary.
  return results.reverse() as ChannelHistoryMessage[]
}

/**
 * Get recent outgoing channel messages for a connection.
 * Used to inject notification/ritual messages into the assistant's context
 * so it knows what was sent on the channel since the last conversation.
 */
export function getRecentOutgoingMessages(
  connectionId: string,
  options: { since?: string; limit?: number } = {}
): ChannelHistoryMessage[] {
  const { since, limit = 20 } = options

  const conditions = [
    eq(channelMessages.connectionId, connectionId),
    eq(channelMessages.direction, 'outgoing'),
  ]

  if (since) {
    conditions.push(gt(channelMessages.messageTimestamp, since))
  }

  const results = db
    .select({
      direction: channelMessages.direction,
      senderName: channelMessages.senderName,
      content: channelMessages.content,
      messageTimestamp: channelMessages.messageTimestamp,
    })
    .from(channelMessages)
    .where(and(...conditions))
    .orderBy(desc(channelMessages.messageTimestamp))
    .limit(limit)
    .all()

  // Reverse to chronological order (query returns newest first).
  // drizzle's text column infers direction as string; assert the narrow
  // ChannelHistoryMessage union at the boundary.
  return results.reverse() as ChannelHistoryMessage[]
}

/**
 * Get channel message counts grouped by channel type.
 */
export function getChannelMessageCounts(): Record<string, number> {
  const results = db
    .select({
      channelType: channelMessages.channelType,
      count: sql<number>`count(*)`,
    })
    .from(channelMessages)
    .groupBy(channelMessages.channelType)
    .all()

  const counts: Record<string, number> = {}
  for (const row of results) {
    counts[row.channelType] = row.count
  }
  return counts
}