/**
 * Channel identity mappings (D-7 PR 3).
 *
 * Per-user channel-native identities (Slack user_id, Discord snowflake,
 * Telegram chat_id, WhatsApp phone JID). The notification dispatcher will
 * eventually consult `getChannelIdentityForUser` to route a recipient-
 * addressed payload to the user's own DM rather than the tenant-wide
 * channel. The per-channel outbound integrations (which API to call with
 * what auth) live in each channel's adapter and are wired in follow-up
 * PRs.
 *
 * UNIQUE (user_id, channel_type) is enforced by migration 0083 — a user
 * can only map one identity per channel; switching workspaces overwrites.
 */
import { and, asc, eq } from 'drizzle-orm'
import { db, channelIdentityMappings } from '../db'
import type { ChannelIdentityMapping } from '../db'

export const CHANNEL_TYPES = ['slack', 'discord', 'telegram', 'whatsapp'] as const
export type ChannelType = (typeof CHANNEL_TYPES)[number]

export function isChannelType(value: string): value is ChannelType {
  return (CHANNEL_TYPES as readonly string[]).includes(value)
}

export function listMappingsForUser(userId: string): ChannelIdentityMapping[] {
  return db
    .select()
    .from(channelIdentityMappings)
    .where(eq(channelIdentityMappings.userId, userId))
    .orderBy(asc(channelIdentityMappings.channelType))
    .all()
}

// Returns the channel-native identity for `userId` on `channelType`, or
// null when the user hasn't mapped one. The dispatcher integration paths
// (one per channel) read this when sending recipient-addressed
// notifications.
export function getChannelIdentityForUser(
  userId: string,
  channelType: ChannelType
): string | null {
  const row = db
    .select({ channelUserId: channelIdentityMappings.channelUserId })
    .from(channelIdentityMappings)
    .where(
      and(
        eq(channelIdentityMappings.userId, userId),
        eq(channelIdentityMappings.channelType, channelType)
      )
    )
    .get()
  return row?.channelUserId ?? null
}

// Upsert. Overwrites the existing row when (user_id, channel_type) already
// has one. Returns the new row.
export function upsertMapping(
  userId: string,
  channelType: ChannelType,
  channelUserId: string
): ChannelIdentityMapping {
  const trimmed = channelUserId.trim()
  if (!trimmed) {
    throw new Error('channelUserId must not be empty')
  }
  const existing = db
    .select()
    .from(channelIdentityMappings)
    .where(
      and(
        eq(channelIdentityMappings.userId, userId),
        eq(channelIdentityMappings.channelType, channelType)
      )
    )
    .get()
  const now = new Date().toISOString()
  if (existing) {
    db.update(channelIdentityMappings)
      .set({ channelUserId: trimmed, updatedAt: now })
      .where(eq(channelIdentityMappings.id, existing.id))
      .run()
    return { ...existing, channelUserId: trimmed, updatedAt: now }
  }
  const row: ChannelIdentityMapping = {
    id: crypto.randomUUID(),
    userId,
    channelType,
    channelUserId: trimmed,
    createdAt: now,
    updatedAt: now,
  }
  db.insert(channelIdentityMappings).values(row).run()
  return row
}

export function deleteMapping(userId: string, channelType: ChannelType): boolean {
  const existing = db
    .select({ id: channelIdentityMappings.id })
    .from(channelIdentityMappings)
    .where(
      and(
        eq(channelIdentityMappings.userId, userId),
        eq(channelIdentityMappings.channelType, channelType)
      )
    )
    .get()
  if (!existing) return false
  db.delete(channelIdentityMappings).where(eq(channelIdentityMappings.id, existing.id)).run()
  return true
}
