// @ts-nocheck — pre-existing type errors that surfaced when tsconfig.server.json was added in D-15 OG wrap-up. Remove this directive + fix the errors in a focused follow-up PR.
/**
 * Session Mapper - Maps messaging channel users to AI chat sessions.
 * Each phone number/user ID gets a persistent conversation with the AI.
 */

import { nanoid } from 'nanoid'
import { eq, and, like, or } from 'drizzle-orm'
import { db, messagingSessionMappings, messagingConnections, chatSessions } from '../../db'
import type { MessagingSessionMapping, ChatSession } from '../../db/schema'
import { log } from '../../lib/logger'

export interface SessionMapperResult {
  mapping: MessagingSessionMapping
  session: ChatSession
  isNew: boolean
}

/**
 * Get or create a chat session for a channel user.
 * Each user gets one persistent session per connection.
 *
 * For email, pass sessionKey as the threadId to create per-thread sessions.
 * For other channels, sessionKey defaults to channelUserId (per-user sessions).
 */
export function getOrCreateSession(
  connectionId: string,
  channelUserId: string,
  channelUserName?: string,
  sessionKey?: string,
  channelType?: string
): SessionMapperResult {
  // Use sessionKey if provided (e.g., threadId for email), otherwise use channelUserId
  const lookupKey = sessionKey ?? channelUserId
  const now = new Date().toISOString()

  // Check for existing mapping (using lookupKey which may be threadId for email)
  const existingMapping = db
    .select()
    .from(messagingSessionMappings)
    .where(
      and(
        eq(messagingSessionMappings.connectionId, connectionId),
        eq(messagingSessionMappings.channelUserId, lookupKey)
      )
    )
    .get()

  if (existingMapping) {
    // Update last message timestamp
    db.update(messagingSessionMappings)
      .set({ lastMessageAt: now })
      .where(eq(messagingSessionMappings.id, existingMapping.id))
      .run()

    // Get the associated session
    const session = db
      .select()
      .from(chatSessions)
      .where(eq(chatSessions.id, existingMapping.sessionId))
      .get()

    if (session) {
      log.messaging.debug('Found existing session mapping', {
        connectionId,
        channelUserId,
        sessionId: session.id,
      })
      return { mapping: existingMapping, session, isNew: false }
    }

    // Session was deleted - need to create a new one
    log.messaging.warn('Session mapping exists but session was deleted', {
      mappingId: existingMapping.id,
      sessionId: existingMapping.sessionId,
    })
  }

  // Create new chat session
  const sessionId = nanoid()
  const sessionTitle = channelType
    ? `${channelType.charAt(0).toUpperCase() + channelType.slice(1)} Chat`
    : channelUserName
      ? `Chat with ${channelUserName}`
      : `Chat ${channelUserId}`

  const newSession = {
    id: sessionId,
    title: sessionTitle,
    provider: 'claude' as const,
    model: 'sonnet',
    isFavorite: false,
    messageCount: 0,
    createdAt: now,
    updatedAt: now,
  }

  db.insert(chatSessions).values(newSession).run()

  // Create or update the mapping
  // Store lookupKey as channelUserId (may be threadId for email)
  const mappingId = existingMapping?.id ?? nanoid()
  const newMapping = {
    id: mappingId,
    connectionId,
    channelUserId: lookupKey,
    channelUserName: channelUserName ?? null,
    sessionId,
    createdAt: existingMapping?.createdAt ?? now,
    lastMessageAt: now,
  }

  if (existingMapping) {
    db.update(messagingSessionMappings)
      .set({
        sessionId,
        channelUserName: channelUserName ?? null,
        lastMessageAt: now,
      })
      .where(eq(messagingSessionMappings.id, existingMapping.id))
      .run()
  } else {
    db.insert(messagingSessionMappings).values(newMapping).run()
  }

  const session = db
    .select()
    .from(chatSessions)
    .where(eq(chatSessions.id, sessionId))
    .get()!

  const mapping = db
    .select()
    .from(messagingSessionMappings)
    .where(eq(messagingSessionMappings.id, mappingId))
    .get()!

  log.messaging.info('Created new session for channel user', {
    connectionId,
    channelUserId,
    sessionKey: lookupKey,
    sessionId,
  })

  return { mapping, session, isNew: true }
}

/**
 * Reset a user's session - creates a fresh conversation.
 */
export function resetSession(
  connectionId: string,
  channelUserId: string,
  channelUserName?: string,
  sessionKey?: string,
  channelType?: string
): SessionMapperResult {
  const now = new Date().toISOString()
  const lookupKey = sessionKey ?? channelUserId

  // Find existing mapping
  const existingMapping = db
    .select()
    .from(messagingSessionMappings)
    .where(
      and(
        eq(messagingSessionMappings.connectionId, connectionId),
        eq(messagingSessionMappings.channelUserId, lookupKey)
      )
    )
    .get()

  // Create new chat session
  const sessionId = nanoid()
  const sessionTitle = channelType
    ? `${channelType.charAt(0).toUpperCase() + channelType.slice(1)} Chat`
    : channelUserName
      ? `Chat with ${channelUserName}`
      : `Chat ${channelUserId}`

  const newSession = {
    id: sessionId,
    title: sessionTitle,
    provider: 'claude' as const,
    model: 'sonnet',
    isFavorite: false,
    messageCount: 0,
    createdAt: now,
    updatedAt: now,
  }

  db.insert(chatSessions).values(newSession).run()

  // Update or create mapping (using lookupKey as channelUserId)
  const mappingId = existingMapping?.id ?? nanoid()

  if (existingMapping) {
    db.update(messagingSessionMappings)
      .set({
        sessionId,
        channelUserName: channelUserName ?? null,
        lastMessageAt: now,
      })
      .where(eq(messagingSessionMappings.id, existingMapping.id))
      .run()
  } else {
    db.insert(messagingSessionMappings)
      .values({
        id: mappingId,
        connectionId,
        channelUserId: lookupKey,
        channelUserName: channelUserName ?? null,
        sessionId,
        createdAt: now,
        lastMessageAt: now,
      })
      .run()
  }

  const session = db
    .select()
    .from(chatSessions)
    .where(eq(chatSessions.id, sessionId))
    .get()!

  const mapping = db
    .select()
    .from(messagingSessionMappings)
    .where(eq(messagingSessionMappings.id, mappingId))
    .get()!

  log.messaging.info('Reset session for channel user', {
    connectionId,
    channelUserId,
    newSessionId: sessionId,
  })

  return { mapping, session, isNew: true }
}

/**
 * D-15 PR 5: returns true when a session mapping already exists for the
 * given lookup key. Used by Slack thread continuity to decide whether a
 * non-mention message in a channel-thread should be routed to the assistant
 * (because the bot was previously @-mentioned in that thread) or ignored
 * (the thread is just a regular team conversation the bot has no business in).
 */
export function sessionExists(connectionId: string, sessionKey: string): boolean {
  const row = db
    .select({ id: messagingSessionMappings.id })
    .from(messagingSessionMappings)
    .where(
      and(
        eq(messagingSessionMappings.connectionId, connectionId),
        eq(messagingSessionMappings.channelUserId, sessionKey)
      )
    )
    .get()
  return !!row
}

/**
 * List all session mappings for a connection.
 */
export function listSessionMappings(connectionId: string): MessagingSessionMapping[] {
  return db
    .select()
    .from(messagingSessionMappings)
    .where(eq(messagingSessionMappings.connectionId, connectionId))
    .all()
}

/**
 * Delete a session mapping (does not delete the chat session).
 */
export function deleteSessionMapping(mappingId: string): boolean {
  const result = db
    .delete(messagingSessionMappings)
    .where(eq(messagingSessionMappings.id, mappingId))
    .run()
  return result.changes > 0
}

/**
 * Map from hardcoded connection IDs to channel types.
 * Most channels use fixed IDs (e.g., "slack-channel") rather than DB-stored connections.
 */
const CONNECTION_ID_TO_CHANNEL: Record<string, string> = {
  'slack-channel': 'slack',
  'discord-channel': 'discord',
  'telegram-channel': 'telegram',
  'email-channel': 'email',
}

/**
 * Migrate existing channel session titles from "Chat with X" / "Chat X" to "{Channel} Chat".
 * Handles both DB-stored connections (WhatsApp) and hardcoded connection IDs (Slack, Discord, etc.).
 * Skips non-channel sessions (e.g., assistant-ritual, assistant-sweep).
 */
export function migrateSessionTitles(): void {
  const rows = db
    .select({
      sessionId: messagingSessionMappings.sessionId,
      connectionId: messagingSessionMappings.connectionId,
      sessionTitle: chatSessions.title,
    })
    .from(messagingSessionMappings)
    .innerJoin(chatSessions, eq(messagingSessionMappings.sessionId, chatSessions.id))
    .where(
      or(
        like(chatSessions.title, 'Chat with %'),
        like(chatSessions.title, 'Chat %'),
      )
    )
    .all()

  if (rows.length === 0) return

  // Build a map of DB connection IDs to channel types
  const dbConnections = db.select({ id: messagingConnections.id, channelType: messagingConnections.channelType })
    .from(messagingConnections)
    .all()
  const dbConnectionMap = new Map(dbConnections.map(c => [c.id, c.channelType]))

  let updated = 0
  for (const row of rows) {
    // Resolve channel type: check hardcoded IDs first, then DB connections
    const channelType = CONNECTION_ID_TO_CHANNEL[row.connectionId] ?? dbConnectionMap.get(row.connectionId)
    if (!channelType) continue // Skip non-channel sessions (e.g., assistant-ritual)

    const newTitle = `${channelType.charAt(0).toUpperCase() + channelType.slice(1)} Chat`
    if (row.sessionTitle !== newTitle) {
      db.update(chatSessions)
        .set({ title: newTitle })
        .where(eq(chatSessions.id, row.sessionId))
        .run()
      updated++
    }
  }

  if (updated > 0) {
    log.messaging.info('Migrated channel session titles', { updated, total: rows.length })
  }
}