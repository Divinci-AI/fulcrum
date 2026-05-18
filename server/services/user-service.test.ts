import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { setupTestEnv, type TestEnv } from '../__tests__/utils/env'
import {
  ensureUserByEmail,
  getUserById,
  listUsers,
  createUserByAdmin,
  deleteUserByAdmin,
  DuplicateUserError,
  CannotDeleteSelfError,
  CannotDeleteLastAdminError,
} from './user-service'
import { db, users, userApiTokens, channelIdentityMappings, mentions, channelMessages } from '../db'
import { eq } from 'drizzle-orm'

describe('user-service', () => {
  let testEnv: TestEnv
  beforeEach(() => {
    testEnv = setupTestEnv()
  })
  afterEach(() => {
    testEnv.cleanup()
  })

  test('ensureUserByEmail creates a row on first sight and returns it', () => {
    const before = listUsers().length
    const user = ensureUserByEmail('mike@divinci.ai')
    expect(user.email).toBe('mike@divinci.ai')
    expect(user.id).toBeTruthy()
    expect(user.createdAt).toBeTruthy()
    expect(listUsers().length).toBe(before + 1)
  })

  test('ensureUserByEmail is idempotent — returns the same row and bumps lastSeenAt', async () => {
    const a = ensureUserByEmail('alice@example.com')
    // Tiny delay so the ISO timestamps actually differ
    await new Promise((r) => setTimeout(r, 10))
    const b = ensureUserByEmail('alice@example.com')
    expect(b.id).toBe(a.id)
    expect(b.email).toBe(a.email)
    // lastSeenAt should advance on each call
    expect(b.lastSeenAt! >= a.lastSeenAt!).toBe(true)
  })

  test('email normalization — case-insensitive lookup', () => {
    const a = ensureUserByEmail('Bob@Example.COM')
    const b = ensureUserByEmail('bob@example.com')
    expect(b.id).toBe(a.id)
    expect(a.email).toBe('bob@example.com')
  })

  test('getUserById returns null for unknown ids', () => {
    expect(getUserById('00000000-0000-0000-0000-000000000000')).toBeNull()
  })

  // D-8 PR 1 — explicit admin-invoked pre-provisioning.
  describe('createUserByAdmin', () => {
    test('creates a row and leaves lastSeenAt null (invited, not yet seen)', () => {
      const row = createUserByAdmin('newbie@example.com')
      expect(row.email).toBe('newbie@example.com')
      expect(row.id).toBeTruthy()
      expect(row.isAdmin).toBe(false)
      expect(row.lastSeenAt).toBeNull()
      expect(row.createdAt).toBeTruthy()
    })

    test('honours isAdmin opt at creation time', () => {
      const row = createUserByAdmin('promoted@example.com', { isAdmin: true })
      expect(row.isAdmin).toBe(true)
    })

    test('honours displayName opt; trims and clears empty/whitespace', () => {
      const a = createUserByAdmin('a@example.com', { displayName: '  Alice  ' })
      expect(a.displayName).toBe('Alice')
      const b = createUserByAdmin('b@example.com', { displayName: '   ' })
      expect(b.displayName).toBeNull()
      const c = createUserByAdmin('c@example.com', { displayName: null })
      expect(c.displayName).toBeNull()
      const d = createUserByAdmin('d@example.com')
      expect(d.displayName).toBeNull()
    })

    test('normalises email to lowercase+trim', () => {
      const row = createUserByAdmin('  Mike@DIVINCI.ai  ')
      expect(row.email).toBe('mike@divinci.ai')
    })

    test('throws DuplicateUserError when the email already exists (case-insensitive)', () => {
      createUserByAdmin('dup@example.com')
      expect(() => createUserByAdmin('DUP@example.com')).toThrow(DuplicateUserError)
    })

    test('throws plain Error on malformed email', () => {
      expect(() => createUserByAdmin('')).toThrow('Invalid email')
      expect(() => createUserByAdmin('   ')).toThrow('Invalid email')
      expect(() => createUserByAdmin('not-an-email')).toThrow('Invalid email')
    })

    test('a subsequent ensureUserByEmail (first sign-in) finds the pre-provisioned row and stamps lastSeenAt', () => {
      const invited = createUserByAdmin('teammate@example.com')
      expect(invited.lastSeenAt).toBeNull()
      const seen = ensureUserByEmail('teammate@example.com')
      expect(seen.id).toBe(invited.id) // same row
      expect(seen.lastSeenAt).toBeTruthy()
    })
  })

  // D-10 PR 6 — admin-driven member removal.
  describe('deleteUserByAdmin', () => {
    function makeAdmin(email: string): string {
      const id = crypto.randomUUID()
      const now = new Date().toISOString()
      db.insert(users).values({ id, email, isAdmin: true, createdAt: now, updatedAt: now }).run()
      return id
    }
    function makeMember(email: string): string {
      const id = crypto.randomUUID()
      const now = new Date().toISOString()
      db.insert(users).values({ id, email, isAdmin: false, createdAt: now, updatedAt: now }).run()
      return id
    }

    test('hard-deletes the target and their owned rows', () => {
      const adminA = makeAdmin('a@example.com')
      const adminB = makeAdmin('b@example.com') // keeps last-admin guard happy
      const targetId = makeMember('victim@example.com')

      // Seed some owned rows
      const now = new Date().toISOString()
      db.insert(userApiTokens).values({
        id: crypto.randomUUID(),
        userId: targetId,
        name: 'cli',
        tokenHash: 'hashhashhashhashhashhashhashhashhashhashhashhashhashhashhashhash',
        prefix: 'fulc_xxxxxx',
        createdAt: now,
      }).run()
      db.insert(channelIdentityMappings).values({
        id: crypto.randomUUID(),
        userId: targetId,
        channelType: 'slack',
        channelUserId: 'U01',
        createdAt: now,
        updatedAt: now,
      }).run()
      db.insert(mentions).values({
        id: crypto.randomUUID(),
        sourceType: 'task',
        sourceId: 't1',
        userId: targetId,
        createdAt: now,
      }).run()
      db.insert(channelMessages).values({
        id: crypto.randomUUID(),
        channelType: 'slack',
        connectionId: 'c1',
        direction: 'incoming',
        senderId: 'U01',
        content: 'hi',
        messageTimestamp: now,
        createdAt: now,
        userId: targetId,
      }).run()

      const cleanup = deleteUserByAdmin(adminA, targetId)
      expect(cleanup.tokensDeleted).toBe(1)
      expect(cleanup.channelIdentitiesDeleted).toBe(1)
      expect(cleanup.mentionsDeleted).toBe(1)
      expect(cleanup.channelMessagesNulledOut).toBe(1)
      expect(getUserById(targetId)).toBeNull()
      // adminB still exists; not nuked accidentally
      expect(getUserById(adminB)).not.toBeNull()
    })

    test('preserves the channel_messages audit trail with NULL user_id', () => {
      const adminA = makeAdmin('a@example.com')
      makeAdmin('b@example.com')
      const targetId = makeMember('audit@example.com')

      const now = new Date().toISOString()
      const msgId = crypto.randomUUID()
      db.insert(channelMessages).values({
        id: msgId,
        channelType: 'slack',
        connectionId: 'c1',
        direction: 'incoming',
        senderId: 'U01',
        content: 'audit me',
        messageTimestamp: now,
        createdAt: now,
        userId: targetId,
      }).run()

      deleteUserByAdmin(adminA, targetId)
      // Row still exists; user_id is NULL.
      const msg = db.select().from(channelMessages).where(eq(channelMessages.id, msgId)).get()
      expect(msg).not.toBeUndefined()
      expect(msg?.userId).toBeNull()
      expect(msg?.content).toBe('audit me')
    })

    test('throws CannotDeleteSelfError when admin tries to delete themselves', () => {
      const me = makeAdmin('me@example.com')
      makeAdmin('other@example.com')
      expect(() => deleteUserByAdmin(me, me)).toThrow(CannotDeleteSelfError)
    })

    test('throws CannotDeleteLastAdminError when deleting the only admin', () => {
      const onlyAdmin = makeAdmin('lonely@example.com')
      const otherAdmin = makeAdmin('helper@example.com')
      // Demote helper → onlyAdmin is now alone
      db.update(users).set({ isAdmin: false }).where(eq(users.id, otherAdmin)).run()
      expect(() => deleteUserByAdmin(otherAdmin, onlyAdmin)).toThrow(
        CannotDeleteLastAdminError
      )
    })

    test('throws Error("User not found") on unknown target', () => {
      const me = makeAdmin('me@example.com')
      makeAdmin('other@example.com')
      expect(() =>
        deleteUserByAdmin(me, '00000000-0000-0000-0000-000000000000')
      ).toThrow('User not found')
    })
  })
})
