/**
 * D-9 PR 2 — invite email drafting.
 *
 * The `createDraft` call is mocked via `mock.module` because it lives
 * in a separate module; the test only needs to assert "we called it
 * with the right account + recipient + content". Pure-function
 * subject/body builders are tested directly.
 */
import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { setupTestEnv, type TestEnv } from '../__tests__/utils/env'
import { db, googleAccounts, users } from '../db'

let mockedDrafts: Array<{
  accountId: string
  opts: { to?: string[]; subject?: string; body?: string }
}> = []

let mockShouldThrow = false
mock.module('./google/gmail-service', () => ({
  createDraft: async (accountId: string, opts: { to?: string[]; subject?: string; body?: string }) => {
    if (mockShouldThrow) throw new Error('mock createDraft error')
    mockedDrafts.push({ accountId, opts })
    return { draftId: `draft-${mockedDrafts.length}`, messageId: `msg-${mockedDrafts.length}` }
  },
}))

const { draftInviteEmail, _builders } = await import('./invite-email-service')

function insertUser(email: string): string {
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  db.insert(users)
    .values({ id, email, isAdmin: true, createdAt: now, updatedAt: now })
    .run()
  return id
}

function insertGoogleAccount(opts: {
  ownerUserId: string
  email: string | null
  gmailEnabled: boolean
}): string {
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  db.insert(googleAccounts)
    .values({
      id,
      name: 'test',
      email: opts.email,
      ownerUserId: opts.ownerUserId,
      gmailEnabled: opts.gmailEnabled,
      calendarEnabled: false,
      needsReauth: false,
      createdAt: now,
      updatedAt: now,
    })
    .run()
  return id
}

describe('invite-email-service', () => {
  let env: TestEnv
  beforeEach(() => {
    env = setupTestEnv()
    mockedDrafts = []
    mockShouldThrow = false
  })
  afterEach(() => env.cleanup())

  describe('draftInviteEmail', () => {
    test('returns drafted:false when the inviter has no Google account', async () => {
      const inviter = insertUser('admin@example.com')
      const result = await draftInviteEmail({
        inviterUserId: inviter,
        inviteeEmail: 'newbie@example.com',
        tenantUrl: 'https://x.example.com',
      })
      expect(result.drafted).toBe(false)
      expect(result.reason).toContain('no Gmail-enabled')
      expect(mockedDrafts.length).toBe(0)
    })

    test('returns drafted:false when the inviter has a Google account with gmail disabled', async () => {
      const inviter = insertUser('admin@example.com')
      insertGoogleAccount({ ownerUserId: inviter, email: 'admin@gmail.com', gmailEnabled: false })
      const result = await draftInviteEmail({
        inviterUserId: inviter,
        inviteeEmail: 'newbie@example.com',
        tenantUrl: 'https://x.example.com',
      })
      expect(result.drafted).toBe(false)
      expect(result.reason).toContain('no Gmail-enabled')
    })

    test('drafts when the inviter has a Gmail-enabled account', async () => {
      const inviter = insertUser('admin@example.com')
      const acct = insertGoogleAccount({
        ownerUserId: inviter,
        email: 'admin@gmail.com',
        gmailEnabled: true,
      })
      const result = await draftInviteEmail({
        inviterUserId: inviter,
        inviteeEmail: 'newbie@example.com',
        tenantUrl: 'https://fulcrum-acme.divinci.ai',
        inviteeDisplayName: 'New Bie',
      })
      expect(result.drafted).toBe(true)
      expect(result.draftId).toBe('draft-1')
      expect(mockedDrafts.length).toBe(1)
      expect(mockedDrafts[0].accountId).toBe(acct)
      expect(mockedDrafts[0].opts.to).toEqual(['newbie@example.com'])
      expect(mockedDrafts[0].opts.subject).toContain('invited')
      const body = mockedDrafts[0].opts.body ?? ''
      expect(body).toContain('https://fulcrum-acme.divinci.ai')
      expect(body).toContain('New Bie')
      expect(body).toContain('admin@gmail.com') // inviter signature
    })

    test('falls back to a generic greeting when no displayName', async () => {
      const inviter = insertUser('admin@example.com')
      insertGoogleAccount({ ownerUserId: inviter, email: 'admin@gmail.com', gmailEnabled: true })
      await draftInviteEmail({
        inviterUserId: inviter,
        inviteeEmail: 'anon@example.com',
        tenantUrl: 'https://x.example.com',
      })
      expect(mockedDrafts[0].opts.body).toMatch(/^Hi,/)
    })

    test('returns drafted:false with the reason when createDraft throws', async () => {
      const inviter = insertUser('admin@example.com')
      insertGoogleAccount({ ownerUserId: inviter, email: 'admin@gmail.com', gmailEnabled: true })
      mockShouldThrow = true
      const result = await draftInviteEmail({
        inviterUserId: inviter,
        inviteeEmail: 'newbie@example.com',
        tenantUrl: 'https://x.example.com',
      })
      expect(result.drafted).toBe(false)
      expect(result.reason).toBe('mock createDraft error')
    })

    test('returns drafted:false when the Google account is missing an email address', async () => {
      const inviter = insertUser('admin@example.com')
      insertGoogleAccount({ ownerUserId: inviter, email: null, gmailEnabled: true })
      const result = await draftInviteEmail({
        inviterUserId: inviter,
        inviteeEmail: 'newbie@example.com',
        tenantUrl: 'https://x.example.com',
      })
      expect(result.drafted).toBe(false)
      expect(result.reason).toContain('missing an email address')
    })
  })

  describe('builders (subject / body)', () => {
    test('subject mentions invitation', () => {
      expect(_builders.buildSubject()).toContain('invited')
    })

    test('body includes tenant URL and inviter signature', () => {
      const body = _builders.buildBody(
        {
          inviterUserId: 'x',
          inviteeEmail: 'e@example.com',
          tenantUrl: 'https://t.example.com',
        },
        'admin@example.com'
      )
      expect(body).toContain('https://t.example.com')
      expect(body).toContain('admin@example.com')
    })
  })
})
