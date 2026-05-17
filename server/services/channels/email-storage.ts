/**
 * Email storage utilities for local database operations.
 * Uses the unified channelMessages table with email-specific metadata.
 */

import { eq, desc, like, or, and, sql } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { db, channelMessages } from '../../db'
import type { ChannelMessageMetadata, ChannelMessage } from '../../db/schema'
import { log } from '../../lib/logger'
import { resolveInboundUserId } from '../channel-identity-service'

/**
 * Parameters for storing an email.
 */
export interface StoreEmailParams {
  connectionId: string
  messageId: string
  threadId?: string
  inReplyTo?: string
  references?: string[]
  direction: 'incoming' | 'outgoing'
  fromAddress: string
  fromName?: string
  toAddresses?: string[]
  ccAddresses?: string[]
  subject?: string
  textContent?: string
  htmlContent?: string
  emailDate?: Date
  imapUid?: number
  folder?: string
}

/**
 * Email data returned from storage (backward-compatible shape).
 */
export interface StoredEmail {
  id: string
  connectionId: string
  messageId: string
  threadId?: string | null
  inReplyTo?: string | null
  references?: string[] | null
  direction: string
  fromAddress: string
  fromName?: string | null
  toAddresses?: string[] | null
  ccAddresses?: string[] | null
  subject?: string | null
  textContent?: string | null
  htmlContent?: string | null
  snippet?: string | null
  emailDate?: string | null
  folder?: string | null
  isRead?: boolean | null
  isStarred?: boolean | null
  labels?: string[] | null
  imapUid?: number | null
  createdAt: string
}

/**
 * Convert a ChannelMessage to StoredEmail format for backward compatibility.
 */
function toStoredEmail(msg: ChannelMessage): StoredEmail {
  const metadata = (msg.metadata || {}) as ChannelMessageMetadata
  return {
    id: msg.id,
    connectionId: msg.connectionId,
    messageId: metadata.messageId || msg.id,
    threadId: metadata.threadId,
    inReplyTo: metadata.inReplyTo,
    references: metadata.references,
    direction: msg.direction,
    fromAddress: msg.senderId,
    fromName: msg.senderName,
    toAddresses: metadata.toAddresses,
    ccAddresses: metadata.ccAddresses,
    subject: metadata.subject,
    textContent: msg.content,
    htmlContent: metadata.htmlContent,
    snippet: metadata.snippet,
    emailDate: msg.messageTimestamp,
    folder: metadata.folder,
    isRead: metadata.isRead,
    isStarred: metadata.isStarred,
    labels: metadata.labels,
    imapUid: metadata.imapUid,
    createdAt: msg.createdAt,
  }
}

/**
 * Store an email in the local database.
 * Returns true if the email was newly stored, false if it already existed (duplicate).
 */
export function storeEmail(params: StoreEmailParams): boolean {
  const now = new Date().toISOString()

  // Check if email already exists (by messageId in metadata)
  const existing = db
    .select()
    .from(channelMessages)
    .where(
      and(
        eq(channelMessages.channelType, 'email'),
        sql`json_extract(${channelMessages.metadata}, '$.messageId') = ${params.messageId}`
      )
    )
    .get()

  if (existing) {
    log.messaging.debug('Email already stored', {
      connectionId: params.connectionId,
      messageId: params.messageId,
    })
    return false
  }

  // Generate snippet from text content
  const snippet = params.textContent
    ? params.textContent.slice(0, 200).replace(/\s+/g, ' ').trim()
    : undefined

  // Build metadata object with email-specific fields
  const metadata: ChannelMessageMetadata = {
    messageId: params.messageId,
    threadId: params.threadId,
    inReplyTo: params.inReplyTo,
    references: params.references,
    subject: params.subject,
    toAddresses: params.toAddresses,
    ccAddresses: params.ccAddresses,
    htmlContent: params.htmlContent,
    snippet,
    imapUid: params.imapUid,
    folder: params.folder ?? (params.direction === 'outgoing' ? 'sent' : 'inbox'),
    isRead: params.direction === 'outgoing', // Outgoing are automatically "read"
    isStarred: false,
  }

  // Get recipient for outgoing emails
  const recipientId = params.toAddresses?.[0] ?? undefined

  // D-7 PR 6: attribute incoming emails to the Fulcrum user whose
  // users.email matches the sender. Outgoing emails are from "us" so the
  // attribution there belongs to the dispatcher's recipient-targeting,
  // not the sender column.
  const userId =
    params.direction === 'incoming'
      ? resolveInboundUserId('email', params.fromAddress)
      : null

  db.insert(channelMessages)
    .values({
      id: nanoid(),
      channelType: 'email',
      connectionId: params.connectionId,
      direction: params.direction,
      senderId: params.fromAddress,
      senderName: params.fromName,
      recipientId,
      content: params.textContent || '',
      metadata,
      messageTimestamp: params.emailDate?.toISOString() ?? now,
      createdAt: now,
      userId,
    })
    .run()

  log.messaging.debug('Email stored', {
    connectionId: params.connectionId,
    messageId: params.messageId,
    direction: params.direction,
  })

  return true
}

/**
 * Options for querying stored emails.
 */
export interface GetStoredEmailsOptions {
  connectionId: string
  limit?: number
  offset?: number
  direction?: 'incoming' | 'outgoing'
  threadId?: string
  search?: string
  folder?: string
}

/**
 * Get locally stored emails with optional filters.
 */
export function getStoredEmails(options: GetStoredEmailsOptions): StoredEmail[] {
  const conditions = [
    eq(channelMessages.channelType, 'email'),
    eq(channelMessages.connectionId, options.connectionId),
  ]

  if (options.direction) {
    conditions.push(eq(channelMessages.direction, options.direction))
  }

  if (options.threadId) {
    conditions.push(
      sql`json_extract(${channelMessages.metadata}, '$.threadId') = ${options.threadId}`
    )
  }

  if (options.folder) {
    conditions.push(
      sql`json_extract(${channelMessages.metadata}, '$.folder') = ${options.folder}`
    )
  }

  if (options.search) {
    const searchTerm = `%${options.search}%`
    conditions.push(
      or(
        sql`json_extract(${channelMessages.metadata}, '$.subject') LIKE ${searchTerm}`,
        like(channelMessages.content, searchTerm),
        like(channelMessages.senderId, searchTerm)
      )!
    )
  }

  const results = db
    .select()
    .from(channelMessages)
    .where(and(...conditions))
    .orderBy(desc(channelMessages.messageTimestamp))
    .limit(options.limit ?? 50)
    .offset(options.offset ?? 0)
    .all()

  return results.map(toStoredEmail)
}

/**
 * Get a single email by ID.
 */
export function getStoredEmailById(id: string): StoredEmail | undefined {
  const result = db
    .select()
    .from(channelMessages)
    .where(
      and(
        eq(channelMessages.channelType, 'email'),
        eq(channelMessages.id, id)
      )
    )
    .get()

  return result ? toStoredEmail(result) : undefined
}

/**
 * Get a single email by its message ID (Email Message-ID header).
 */
export function getStoredEmailByMessageId(
  connectionId: string,
  messageId: string
): StoredEmail | undefined {
  const result = db
    .select()
    .from(channelMessages)
    .where(
      and(
        eq(channelMessages.channelType, 'email'),
        eq(channelMessages.connectionId, connectionId),
        sql`json_extract(${channelMessages.metadata}, '$.messageId') = ${messageId}`
      )
    )
    .get()

  return result ? toStoredEmail(result) : undefined
}
