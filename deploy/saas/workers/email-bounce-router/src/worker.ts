/**
 * Fulcrum email bounce router (D-11 PR 3).
 *
 * Cloudflare Email Worker handler. Receives inbound email (catch-
 * all from the bounce-handling Routing rule), parses RFC 3464
 * DSNs and ARF complaints, POSTs structured events to Fulcrum's
 * /api/email-events ingest endpoint.
 *
 * Deploy: `wrangler deploy` from this directory.
 * Bindings:
 *   FULCRUM_INGEST_URL    — origin URL incl. /api/email-events
 *   FULCRUM_INGEST_SECRET — shared secret; must match
 *                           integrations.cloudflareEmailIngestSecret
 *                           on the Fulcrum tenant
 */
import { parseInboundEmail } from './parse-bounce'

interface Env {
  FULCRUM_INGEST_URL: string
  FULCRUM_INGEST_SECRET: string
}

/**
 * CF Email Worker `message` type. Defined locally so we don't pull
 * in the entire `@cloudflare/workers-types` dep tree for the small
 * surface we touch.
 */
interface ForwardableEmailMessage {
  readonly from: string
  readonly to: string
  readonly raw: ReadableStream<Uint8Array>
  readonly rawSize: number
  readonly headers: Headers
  setReject(reason: string): void
  forward(rcptTo: string, headers?: Headers): Promise<void>
}

async function streamToString(stream: ReadableStream<Uint8Array>): Promise<string> {
  // Cap reads at 1 MiB. Real DSNs are usually < 16 KiB; anything
  // larger is either malformed or includes a giant original-message
  // attachment we don't need to parse.
  const MAX_BYTES = 1_048_576
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      total += value.length
      if (total > MAX_BYTES) {
        // Stop reading; what we have so far is enough for headers.
        chunks.push(value)
        break
      }
      chunks.push(value)
    }
  }
  // Concat and decode as UTF-8 (DSNs are 7-bit ASCII in practice,
  // UTF-8 decoding is safe).
  const flat = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    flat.set(chunk, offset)
    offset += chunk.length
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(flat)
}

export default {
  async email(
    message: ForwardableEmailMessage,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<void> {
    // 1. Read the raw email.
    let raw: string
    try {
      raw = await streamToString(message.raw)
    } catch (err) {
      console.error('Failed to read message.raw', err)
      return
    }

    // 2. Parse — drop non-bounces silently.
    const event = parseInboundEmail(raw)
    if (!event) {
      console.log('Inbound email is not a bounce/complaint; ignoring', {
        from: message.from,
        to: message.to,
      })
      return
    }

    // 3. POST to Fulcrum's ingest endpoint.
    try {
      const res = await fetch(env.FULCRUM_INGEST_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Secret': env.FULCRUM_INGEST_SECRET,
        },
        body: JSON.stringify({
          recipient: event.recipient,
          eventType: event.eventType,
          providerMessageId: message.headers.get('Message-ID') ?? undefined,
          raw: {
            statusCode: event.statusCode,
            reason: event.reason,
            from: message.from,
            to: message.to,
          },
        }),
      })
      if (!res.ok) {
        console.error('Fulcrum ingest returned non-OK', {
          status: res.status,
          recipient: event.recipient,
        })
      } else {
        console.log('Ingested bounce event', {
          recipient: event.recipient,
          eventType: event.eventType,
        })
      }
    } catch (err) {
      console.error('Failed to POST to Fulcrum', err)
    }
  },
}
