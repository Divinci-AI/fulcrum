/**
 * D-7 PR 6 — inbound channel-message attribution.
 *
 * Verifies that `storeChannelMessage` and `storeEmail` stamp
 * `channel_messages.user_id` for incoming messages using the resolver
 * in `channel-identity-service`. Outgoing messages stay un-attributed
 * here (their recipient-targeting belongs to the dispatcher path).
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { setupTestEnv, type TestEnv } from '../../__tests__/utils/env'
import { db, users, channelMessages } from '../../db'
import { eq } from 'drizzle-orm'
import { upsertMapping } from '../channel-identity-service'
import { storeChannelMessage } from './message-storage'
import { storeEmail } from './email-storage'

function insertUser(email: string): string {
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  db.insert(users)
    .values({ id, email, isAdmin: false, createdAt: now, updatedAt: now })
    .run()
  return id
}

function getMessageById(id: string) {
  return db.select().from(channelMessages).where(eq(channelMessages.id, id)).get()
}

describe('inbound attribution — storeChannelMessage', () => {
  let env: TestEnv
  beforeEach(() => {
    env = setupTestEnv()
  })
  afterEach(() => env.cleanup())

  test('stamps user_id on incoming Slack message when sender is mapped', () => {
    const alice = insertUser('alice@example.com')
    upsertMapping(alice, 'slack', 'U01ALICE')

    const id = storeChannelMessage({
      channelType: 'slack',
      connectionId: 'conn-1',
      direction: 'incoming',
      senderId: 'U01ALICE',
      content: 'hello from slack',
      messageTimestamp: new Date(),
    })

    const row = getMessageById(id)
    expect(row?.userId).toBe(alice)
  })

  test('leaves user_id null on incoming message when sender is unmapped', () => {
    const id = storeChannelMessage({
      channelType: 'discord',
      connectionId: 'conn-2',
      direction: 'incoming',
      senderId: '999999999999',
      content: 'stranger',
      messageTimestamp: new Date(),
    })

    const row = getMessageById(id)
    expect(row?.userId).toBeNull()
  })

  test('does not stamp user_id on outgoing messages even when sender is mapped', () => {
    const alice = insertUser('alice@example.com')
    upsertMapping(alice, 'slack', 'U01ALICE')

    const id = storeChannelMessage({
      channelType: 'slack',
      connectionId: 'conn-3',
      direction: 'outgoing',
      senderId: 'U01ALICE', // even if sender ID happens to match a mapped user
      recipientId: 'U02BOB',
      content: 'bot reply',
      messageTimestamp: new Date(),
    })

    const row = getMessageById(id)
    expect(row?.userId).toBeNull()
  })

  test('resolves per (channel_type, channel_user_id) — does not cross channels', () => {
    const alice = insertUser('alice@example.com')
    upsertMapping(alice, 'telegram', '12345')

    // Same digits arriving on Discord must NOT resolve to alice.
    const discordId = storeChannelMessage({
      channelType: 'discord',
      connectionId: 'conn-4',
      direction: 'incoming',
      senderId: '12345',
      content: 'discord msg',
      messageTimestamp: new Date(),
    })
    expect(getMessageById(discordId)?.userId).toBeNull()

    const telegramId = storeChannelMessage({
      channelType: 'telegram',
      connectionId: 'conn-4',
      direction: 'incoming',
      senderId: '12345',
      content: 'telegram msg',
      messageTimestamp: new Date(),
    })
    expect(getMessageById(telegramId)?.userId).toBe(alice)
  })
})

describe('inbound attribution — storeEmail', () => {
  let env: TestEnv
  beforeEach(() => {
    env = setupTestEnv()
  })
  afterEach(() => env.cleanup())

  test('stamps user_id on incoming email when sender matches users.email', () => {
    const alice = insertUser('alice@example.com')

    storeEmail({
      connectionId: 'gmail-1',
      messageId: '<msg-1@example.com>',
      direction: 'incoming',
      fromAddress: 'alice@example.com',
      subject: 'hi',
      textContent: 'body',
      emailDate: new Date(),
    })

    const row = db
      .select()
      .from(channelMessages)
      .where(eq(channelMessages.channelType, 'email'))
      .get()
    expect(row?.userId).toBe(alice)
  })

  test('email lookup is case-insensitive', () => {
    const alice = insertUser('alice@example.com')

    storeEmail({
      connectionId: 'gmail-1',
      messageId: '<msg-2@example.com>',
      direction: 'incoming',
      fromAddress: 'Alice@EXAMPLE.com',
      subject: 'hi',
      textContent: 'body',
      emailDate: new Date(),
    })

    const row = db
      .select()
      .from(channelMessages)
      .where(eq(channelMessages.channelType, 'email'))
      .get()
    expect(row?.userId).toBe(alice)
  })

  test('leaves user_id null when sender email matches no user', () => {
    storeEmail({
      connectionId: 'gmail-1',
      messageId: '<msg-3@example.com>',
      direction: 'incoming',
      fromAddress: 'stranger@example.com',
      subject: 'hi',
      textContent: 'body',
      emailDate: new Date(),
    })

    const row = db
      .select()
      .from(channelMessages)
      .where(eq(channelMessages.channelType, 'email'))
      .get()
    expect(row?.userId).toBeNull()
  })

  test('outgoing emails are not attributed via sender (the user is "us")', () => {
    const alice = insertUser('alice@example.com')

    storeEmail({
      connectionId: 'gmail-1',
      messageId: '<msg-4@example.com>',
      direction: 'outgoing',
      fromAddress: 'alice@example.com',
      toAddresses: ['somebody@example.com'],
      subject: 'sent',
      textContent: 'body',
      emailDate: new Date(),
    })

    const row = db
      .select()
      .from(channelMessages)
      .where(eq(channelMessages.channelType, 'email'))
      .get()
    expect(row?.userId).toBeNull()
    // Sanity check: alice exists in the users table for this test setup.
    expect(alice).toBeDefined()
  })
})
