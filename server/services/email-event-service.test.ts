/**
 * D-11 PR 1 — email_send_events storage.
 *
 * Round-trip + ordering + bounce-aggregate tests. The webhook
 * receiver (PR 2) is the consumer; this is just the storage.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { setupTestEnv, type TestEnv } from '../__tests__/utils/env'
import { db, users } from '../db'
import {
  EMAIL_EVENT_TYPES,
  isEmailEventType,
  recordEvent,
  recentEventsFor,
  mostRecentEventFor,
  bounceCountSince,
  latestEventPerUser,
} from './email-event-service'

function insertUser(email: string): string {
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  db.insert(users)
    .values({ id, email, isAdmin: false, createdAt: now, updatedAt: now })
    .run()
  return id
}

describe('email-event-service', () => {
  let env: TestEnv
  beforeEach(() => {
    env = setupTestEnv()
  })
  afterEach(() => env.cleanup())

  describe('isEmailEventType', () => {
    test('accepts the six canonical types', () => {
      for (const t of EMAIL_EVENT_TYPES) {
        expect(isEmailEventType(t)).toBe(true)
      }
    })
    test('rejects unknown strings', () => {
      expect(isEmailEventType('processed')).toBe(false)
      expect(isEmailEventType('')).toBe(false)
      expect(isEmailEventType('BOUNCED')).toBe(false) // case-sensitive enum
    })
  })

  describe('recordEvent', () => {
    test('inserts an event and stamps id + createdAt', () => {
      const row = recordEvent({
        recipientEmail: 'someone@example.com',
        eventType: 'delivered',
      })
      expect(row.id).toBeTruthy()
      expect(row.createdAt).toBeTruthy()
      expect(row.recipientEmail).toBe('someone@example.com')
      expect(row.eventType).toBe('delivered')
      expect(row.userId).toBeNull()
    })

    test('resolves userId case-insensitively', () => {
      const userId = insertUser('mike@divinci.ai')
      const row = recordEvent({
        recipientEmail: 'MIKE@Divinci.AI',
        eventType: 'bounced',
      })
      expect(row.userId).toBe(userId)
      expect(row.recipientEmail).toBe('mike@divinci.ai') // normalized on write
    })

    test('userId stays null when no user matches', () => {
      insertUser('mike@divinci.ai')
      const row = recordEvent({
        recipientEmail: 'unknown@example.com',
        eventType: 'bounced',
      })
      expect(row.userId).toBeNull()
    })

    test('uses provider occurredAt when given; falls back to server now()', () => {
      const provided = '2026-05-18T08:00:00.000Z'
      const withProvided = recordEvent({
        recipientEmail: 'a@example.com',
        eventType: 'delivered',
        occurredAt: provided,
      })
      expect(withProvided.occurredAt).toBe(provided)

      const withoutProvided = recordEvent({
        recipientEmail: 'b@example.com',
        eventType: 'delivered',
      })
      expect(new Date(withoutProvided.occurredAt).getTime()).toBeGreaterThan(0)
    })

    test('accepts a Date for occurredAt', () => {
      const d = new Date('2026-05-18T09:00:00.000Z')
      const row = recordEvent({
        recipientEmail: 'a@example.com',
        eventType: 'delivered',
        occurredAt: d,
      })
      expect(row.occurredAt).toBe(d.toISOString())
    })

    test('stores rawPayload verbatim', () => {
      const payload = { event: 'delivery', mta: 'mx1.example.com', nested: { foo: 1 } }
      const row = recordEvent({
        recipientEmail: 'a@example.com',
        eventType: 'delivered',
        rawPayload: payload,
      })
      expect(row.rawPayload).toEqual(payload)
    })

    test('throws on empty email or unknown type', () => {
      expect(() =>
        recordEvent({ recipientEmail: '   ', eventType: 'delivered' })
      ).toThrow('recipientEmail')
      expect(() =>
        recordEvent({
          recipientEmail: 'a@b',
          // @ts-expect-error — deliberately bad
          eventType: 'invalid_type',
        })
      ).toThrow('Unknown eventType')
    })
  })

  describe('recentEventsFor', () => {
    test('returns newest first, capped at limit', async () => {
      recordEvent({ recipientEmail: 'x@example.com', eventType: 'delivered', occurredAt: '2026-05-18T01:00:00Z' })
      recordEvent({ recipientEmail: 'x@example.com', eventType: 'bounced',   occurredAt: '2026-05-18T03:00:00Z' })
      recordEvent({ recipientEmail: 'x@example.com', eventType: 'delivered', occurredAt: '2026-05-18T02:00:00Z' })

      const all = recentEventsFor('x@example.com')
      expect(all.length).toBe(3)
      // Newest first
      expect(all[0].occurredAt).toBe('2026-05-18T03:00:00Z')
      expect(all[2].occurredAt).toBe('2026-05-18T01:00:00Z')

      const limited = recentEventsFor('x@example.com', 1)
      expect(limited.length).toBe(1)
      expect(limited[0].eventType).toBe('bounced')
    })

    test('matches case-insensitively', () => {
      recordEvent({ recipientEmail: 'Mike@Divinci.AI', eventType: 'delivered' })
      expect(recentEventsFor('mike@divinci.ai').length).toBe(1)
      expect(recentEventsFor('MIKE@DIVINCI.AI').length).toBe(1)
    })

    test('returns [] for unseen recipient', () => {
      expect(recentEventsFor('never@seen.com')).toEqual([])
    })
  })

  describe('mostRecentEventFor', () => {
    test('returns null when no events', () => {
      expect(mostRecentEventFor('blank@example.com')).toBeNull()
    })

    test('returns the single newest event', () => {
      recordEvent({ recipientEmail: 'y@example.com', eventType: 'delivered', occurredAt: '2026-05-18T01:00:00Z' })
      recordEvent({ recipientEmail: 'y@example.com', eventType: 'bounced',   occurredAt: '2026-05-18T05:00:00Z' })
      const got = mostRecentEventFor('y@example.com')
      expect(got?.eventType).toBe('bounced')
    })
  })

  // D-11 PR 5 — batch latest-event-per-user.
  describe('latestEventPerUser', () => {
    test('returns most recent event per user, joined to users table', () => {
      const alice = insertUser('alice@example.com')
      const bob = insertUser('bob@example.com')
      // Stranger NOT in users table; their events shouldn't appear.

      recordEvent({ recipientEmail: 'alice@example.com', eventType: 'delivered', occurredAt: '2026-05-18T01:00:00Z' })
      recordEvent({ recipientEmail: 'alice@example.com', eventType: 'bounced',   occurredAt: '2026-05-18T05:00:00Z' })
      recordEvent({ recipientEmail: 'bob@example.com',   eventType: 'delivered', occurredAt: '2026-05-18T04:00:00Z' })
      recordEvent({ recipientEmail: 'stranger@example.com', eventType: 'bounced', occurredAt: '2026-05-18T06:00:00Z' })

const statuses = latestEventPerUser()
      const byUser = new Map(statuses.map((s) => [s.userId, s]))

      expect(statuses.length).toBe(2)
      expect(byUser.get(alice)?.eventType).toBe('bounced')
      expect(byUser.get(alice)?.occurredAt).toBe('2026-05-18T05:00:00Z')
      expect(byUser.get(bob)?.eventType).toBe('delivered')
    })

    test('matches case-insensitively against users.email', () => {
      const mike = insertUser('mike@divinci.ai')
      recordEvent({ recipientEmail: 'Mike@DIVINCI.AI', eventType: 'bounced' })
const statuses = latestEventPerUser()
      expect(statuses[0]?.userId).toBe(mike)
    })

    test('extracts reason from raw_payload when present', () => {
      insertUser('a@example.com')
      recordEvent({
        recipientEmail: 'a@example.com',
        eventType: 'bounced',
        rawPayload: { reason: 'mailbox unavailable', mta: 'mx1.x.com' },
      })
const statuses = latestEventPerUser()
      expect(statuses[0]?.reason).toBe('mailbox unavailable')
    })

    test('returns [] when there are no events', () => {
      insertUser('a@example.com')
expect(latestEventPerUser()).toEqual([])
    })
  })

  describe('bounceCountSince', () => {
    test('counts bounced + complained, excludes delivered/queued', () => {
      recordEvent({ recipientEmail: 'a@example.com', eventType: 'bounced',   occurredAt: '2026-05-18T01:00:00Z' })
      recordEvent({ recipientEmail: 'b@example.com', eventType: 'complained',occurredAt: '2026-05-18T02:00:00Z' })
      recordEvent({ recipientEmail: 'c@example.com', eventType: 'delivered', occurredAt: '2026-05-18T03:00:00Z' })
      recordEvent({ recipientEmail: 'd@example.com', eventType: 'queued',    occurredAt: '2026-05-18T04:00:00Z' })
      expect(bounceCountSince('2026-05-18T00:00:00Z')).toBe(2)
    })

    test('respects the since cutoff', () => {
      recordEvent({ recipientEmail: 'old@example.com', eventType: 'bounced', occurredAt: '2026-05-17T00:00:00Z' })
      recordEvent({ recipientEmail: 'new@example.com', eventType: 'bounced', occurredAt: '2026-05-18T12:00:00Z' })
      expect(bounceCountSince('2026-05-18T00:00:00Z')).toBe(1)
      expect(bounceCountSince('2026-05-17T00:00:00Z')).toBe(2)
      expect(bounceCountSince('2026-05-19T00:00:00Z')).toBe(0)
    })

    test('accepts Date for since', () => {
      recordEvent({ recipientEmail: 'a@example.com', eventType: 'bounced', occurredAt: '2026-05-18T12:00:00Z' })
      expect(bounceCountSince(new Date('2026-05-18T00:00:00Z'))).toBe(1)
    })
  })
})
