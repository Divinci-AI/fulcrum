/**
 * Email send event ingest (D-11 PR 2).
 *
 * Receives parsed bounce/complaint/delivery events from the
 * Cloudflare Email Worker (D-11 PR 3) and writes them via the
 * email-event-service.
 *
 * Auth: `X-Webhook-Secret: <shared>` header — NOT Bearer, because
 * `/api/*` runs the `currentUser` middleware which checks every
 * Bearer against `user_api_tokens`. Using a different header keeps
 * webhook auth distinct from operator-user auth.
 *
 * Timing-safe comparison so secret-bytes don't leak via response-
 * time side channels. Misses 401 silently (no body) so probers
 * learn nothing.
 */
import { createMiddleware } from 'hono/factory'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { timingSafeEqual } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { getSettings } from '../lib/settings'
import {
  recordEvent,
  isEmailEventType,
  type EmailEventType,
} from '../services/email-event-service'
import { log } from '../lib/logger'

const app = new Hono()

// X-Webhook-Secret check, timing-safe. Returns the configured
// secret on success so the route can also reject when the operator
// hasn't set one yet (rather than a wide-open endpoint).
const WEBHOOK_HEADER = 'x-webhook-secret'

function constantTimeStringEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

const ingestAuth = createMiddleware(async (c, next) => {
  const expected = getSettings().integrations.cloudflareEmailIngestSecret
  if (!expected) {
    log.api.warn('Webhook hit but ingest secret not configured — rejecting')
    throw new HTTPException(401, {
      res: new Response('', { status: 401 }),
    })
  }
  const presented = c.req.header(WEBHOOK_HEADER)
  if (!presented || !constantTimeStringEqual(presented, expected)) {
    throw new HTTPException(401, {
      res: new Response('', { status: 401 }),
    })
  }
  await next()
})

interface IncomingEvent {
  recipient?: string
  eventType?: string
  occurredAt?: string | null
  providerMessageId?: string | null
  raw?: Record<string, unknown> | null
}

function ingestOne(payload: IncomingEvent): { ok: boolean; id?: string; error?: string } {
  if (!payload.recipient || typeof payload.recipient !== 'string') {
    return { ok: false, error: 'recipient (string) is required' }
  }
  if (!payload.eventType || typeof payload.eventType !== 'string') {
    return { ok: false, error: 'eventType (string) is required' }
  }
  if (!isEmailEventType(payload.eventType)) {
    return { ok: false, error: `Unknown eventType: ${payload.eventType}` }
  }
  try {
    const row = recordEvent({
      recipientEmail: payload.recipient,
      eventType: payload.eventType as EmailEventType,
      occurredAt: payload.occurredAt ?? null,
      providerMessageId: payload.providerMessageId ?? null,
      rawPayload: payload.raw ?? null,
    })
    return { ok: true, id: row.id }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'record failed' }
  }
}

/**
 * POST /api/email-events
 *
 * Body: a single event OR an array of events. The Worker can batch
 * if it ever consolidates multiple bounces in one invocation, but
 * the common case is one bounce per worker call → one event here.
 *
 * Body event shape:
 *   {
 *     "recipient": "newbie@example.com",
 *     "eventType": "bounced" | "complained" | "delivered" | ...,
 *     "occurredAt": "2026-05-18T12:00:00Z",  // optional
 *     "providerMessageId": "...",            // optional
 *     "raw": { ... }                         // optional, stored verbatim
 *   }
 *
 * Returns:
 *   200 { ingested: N, ids: [...], errors: [...] }
 *   401 (no body) on missing/wrong secret
 *   400 on malformed JSON
 */
app.post('/', ingestAuth, async (c) => {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'malformed JSON' }, 400)
  }

  const events: IncomingEvent[] = Array.isArray(body)
    ? body
    : [body as IncomingEvent]

  const ids: string[] = []
  const errors: string[] = []
  for (let i = 0; i < events.length; i++) {
    const result = ingestOne(events[i])
    if (result.ok && result.id) {
      ids.push(result.id)
    } else if (result.error) {
      errors.push(`[${i}] ${result.error}`)
    }
  }

  log.api.info('Ingested email events', {
    ingested: ids.length,
    errors: errors.length,
  })
  return c.json({
    ingested: ids.length,
    ids,
    errors,
  })
})

export default app
