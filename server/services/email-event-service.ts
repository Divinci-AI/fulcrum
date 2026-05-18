/**
 * Email send event storage (D-11 PR 1).
 *
 * Records post-send webhook callbacks from transactional email
 * providers (currently Cloudflare Email Sending, beta). Future-
 * providers can map their event vocabulary into the same enum.
 *
 * Why this exists: PR 9 closed the *synchronous* bounce-detection
 * gap (CF tells us in the API response if it knows synchronously).
 * The async gap — bounces that arrive seconds-to-hours after the
 * send call returns — is what this service catches once the
 * webhook receiver (D-11 PR 2) is wired up.
 */
import { and, desc, eq, sql } from 'drizzle-orm'
import {
  db,
  emailSendEvents,
  users,
  type EmailSendEvent,
} from '../db'
import { createLogger } from '../lib/logger'

const logger = createLogger('EmailEvent')

export const EMAIL_EVENT_TYPES = [
  'delivered',
  'bounced',
  'complained',
  'queued',
  'deferred',
  'dropped',
] as const
export type EmailEventType = (typeof EMAIL_EVENT_TYPES)[number]

export function isEmailEventType(value: string): value is EmailEventType {
  return (EMAIL_EVENT_TYPES as readonly string[]).includes(value)
}

export interface RecordEventInput {
  recipientEmail: string
  eventType: EmailEventType
  /** Provider's clock; server falls back to now() when absent. */
  occurredAt?: string | Date | null
  rawPayload?: Record<string, unknown> | null
  providerMessageId?: string | null
}

/**
 * Insert one event, best-effort resolving `userId` from
 * `users.email`. Case-insensitive match (mirrors how invites are
 * matched elsewhere — "Mike@Divinci.AI" and "mike@divinci.ai"
 * resolve to the same user row).
 */
export function recordEvent(input: RecordEventInput): EmailSendEvent {
  const normalized = input.recipientEmail.trim().toLowerCase()
  if (!normalized) {
    throw new Error('recipientEmail must not be empty')
  }
  if (!isEmailEventType(input.eventType)) {
    throw new Error(`Unknown eventType: ${input.eventType}`)
  }

  // Resolve user via case-insensitive match. SQLite's LOWER() does
  // the trick without extra columns; one indexed scan worst-case.
  const userRow = db
    .select({ id: users.id })
    .from(users)
    .where(sql`LOWER(${users.email}) = ${normalized}`)
    .get()

  const occurredAt =
    input.occurredAt instanceof Date
      ? input.occurredAt.toISOString()
      : (input.occurredAt ?? new Date().toISOString())

  const now = new Date().toISOString()
  const row: EmailSendEvent = {
    id: crypto.randomUUID(),
    recipientEmail: normalized,
    eventType: input.eventType,
    occurredAt,
    rawPayload: input.rawPayload ?? null,
    providerMessageId: input.providerMessageId ?? null,
    userId: userRow?.id ?? null,
    createdAt: now,
  }
  db.insert(emailSendEvents).values(row).run()
  logger.info('Recorded email send event', {
    id: row.id,
    recipientEmail: normalized,
    eventType: input.eventType,
    userId: row.userId,
  })
  return row
}

/**
 * Get the most recent events for a given recipient, newest first.
 * Used by the Members UI to surface bounce badges on rows whose
 * last attempt failed.
 */
export function recentEventsFor(
  email: string,
  limit = 10
): EmailSendEvent[] {
  const normalized = email.trim().toLowerCase()
  if (!normalized) return []
  return db
    .select()
    .from(emailSendEvents)
    .where(eq(emailSendEvents.recipientEmail, normalized))
    .orderBy(desc(emailSendEvents.occurredAt))
    .limit(limit)
    .all()
}

/** Convenience: the single most recent event for a recipient, or null. */
export function mostRecentEventFor(email: string): EmailSendEvent | null {
  const all = recentEventsFor(email, 1)
  return all[0] ?? null
}

/**
 * D-11 PR 5: latest event per known recipient, scoped to users
 * that exist in the tenant. Used by the Members UI to show a
 * bounce badge on rows whose last delivery attempt failed.
 *
 * Single SQL pass — for each (recipient_email, max(occurred_at))
 * pair, returns the row. Joined to `users` so we get the row's
 * userId for direct map lookup in the frontend.
 */
export interface UserDeliveryStatus {
  userId: string
  recipientEmail: string
  eventType: string
  occurredAt: string
  reason?: string
}

export function latestEventPerUser(): UserDeliveryStatus[] {
  // For each (recipient_email, max(occurred_at)) pair, fetch the
  // row + the matching user row. Join to users on lowered email
  // so a status only surfaces when the recipient is a known tenant
  // member (we don't expose delivery status for test sends).
  const rows = db.all(sql`
    SELECT u.id AS userId,
           e.recipient_email AS recipientEmail,
           e.event_type AS eventType,
           e.occurred_at AS occurredAt,
           e.raw_payload AS rawPayload
    FROM email_send_events e
    JOIN (
      SELECT recipient_email, MAX(occurred_at) AS max_at
      FROM email_send_events
      GROUP BY recipient_email
    ) latest
      ON latest.recipient_email = e.recipient_email
      AND latest.max_at = e.occurred_at
    JOIN users u
      ON LOWER(u.email) = e.recipient_email
  `) as Array<{
    userId: string
    recipientEmail: string
    eventType: string
    occurredAt: string
    rawPayload: string | Record<string, unknown> | null
  }>

  return rows.map((r) => {
    let reason: string | undefined
    if (r.rawPayload) {
      // raw_payload is JSON in the schema — drizzle returns string
      // here because raw SQL doesn't auto-parse $type JSON columns.
      const parsed =
        typeof r.rawPayload === 'string'
          ? (() => {
              try {
                return JSON.parse(r.rawPayload as string) as { reason?: string }
              } catch {
                return null
              }
            })()
          : (r.rawPayload as { reason?: string })
      reason = parsed?.reason
    }
    return {
      userId: r.userId,
      recipientEmail: r.recipientEmail,
      eventType: r.eventType,
      occurredAt: r.occurredAt,
      reason,
    }
  })
}

/**
 * Aggregate count of bounce/complaint events since `since`. Used by
 * a future monitoring dashboard / alerting cron.
 */
export function bounceCountSince(since: string | Date): number {
  const sinceIso =
    since instanceof Date ? since.toISOString() : since
  const row = db
    .select({ c: sql<number>`count(*)` })
    .from(emailSendEvents)
    .where(
      and(
        sql`${emailSendEvents.eventType} IN ('bounced', 'complained')`,
        sql`${emailSendEvents.occurredAt} >= ${sinceIso}`
      )
    )
    .get()
  return row?.c ?? 0
}
