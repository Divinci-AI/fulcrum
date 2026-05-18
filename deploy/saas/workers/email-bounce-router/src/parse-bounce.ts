/**
 * Bounce DSN parser (D-11 PR 3).
 *
 * RFC 3464 Delivery Status Notifications encode the bounce
 * outcome in a `message/delivery-status` MIME part with fields:
 *   Final-Recipient: rfc822; user@example.com
 *   Action: failed | delayed | delivered | expanded | relayed
 *   Status: 5.x.x (perm) | 4.x.x (transient) | 2.x.x (success)
 *   Diagnostic-Code: smtp; 550 mailbox unavailable
 *
 * In practice operators see a mix of:
 *   - Real DSNs from CF / destination MTAs (parseable here)
 *   - "Postmaster" replies (free-form text — best-effort regex)
 *   - Replies from real humans saying "you have the wrong address"
 *     (NOT a bounce; we drop these)
 *
 * Pure-function module so it's testable without wrangler.
 */

export type ParsedEventType = 'bounced' | 'complained' | 'delivered' | 'deferred' | 'dropped'

export interface ParsedBounceEvent {
  recipient: string
  eventType: ParsedEventType
  /** SMTP / DSN status code (e.g. "5.1.1") — surfaces enhanced
   * status for downstream classification. */
  statusCode?: string
  /** Human-readable bounce reason from Diagnostic-Code. */
  reason?: string
}

/**
 * Try to parse a raw RFC 5322 email (including its MIME body) as
 * a bounce DSN. Returns null when the message clearly isn't a
 * bounce — caller drops those silently.
 */
export function parseBounce(raw: string): ParsedBounceEvent | null {
  // Cheap pre-check: a real DSN should have `multipart/report` or
  // be from a postmaster/mailer-daemon. If neither, this is
  // probably a real human reply, not a bounce.
  const isReport = /content-type:\s*multipart\/report/i.test(raw)
  const fromPostmaster = /from:\s*(?:[^\n]*?)<?(?:mailer-daemon|postmaster|noreply|no-reply)@/i.test(raw)
  if (!isReport && !fromPostmaster) {
    return null
  }

  // Final-Recipient header is the canonical place to find the
  // original recipient. Format: `rfc822; user@example.com` or
  // `rfc822;user@example.com` (whitespace varies). Some MTAs omit
  // the `rfc822;` prefix entirely. Some wrap the address in
  // angle brackets (`<user@example.com>`); allow that with `<?`.
  const finalRecipientMatch = raw.match(
    /^Final-Recipient:\s*(?:rfc822\s*;\s*)?<?([^\s<>\n,]+)/im
  )
  // Original-Recipient is a fallback that some MTAs include.
  const originalRecipientMatch = raw.match(
    /^Original-Recipient:\s*(?:rfc822\s*;\s*)?<?([^\s<>\n,]+)/im
  )
  const recipient = finalRecipientMatch?.[1] ?? originalRecipientMatch?.[1]
  if (!recipient || !recipient.includes('@')) {
    return null
  }

  // Status code: "5.x.x" = permanent, "4.x.x" = transient,
  // "2.x.x" = success. RFC 3463 enhanced status codes.
  const statusMatch = raw.match(/^Status:\s*(\d\.\d{1,3}\.\d{1,3})/im)
  const statusCode = statusMatch?.[1]

  // Action takes priority over status when present — it's the
  // MTA's explicit classification.
  const actionMatch = raw.match(/^Action:\s*(failed|delayed|delivered|expanded|relayed)/im)
  const action = actionMatch?.[1].toLowerCase()

  // Diagnostic-Code: "smtp; 550 mailbox unavailable" — strip the
  // protocol prefix and trim.
  const diagnosticMatch = raw.match(
    /^Diagnostic-Code:\s*(?:smtp\s*;\s*)?([^\n]+(?:\n\s+[^\n]+)*)/im
  )
  const reason = diagnosticMatch?.[1].replace(/\s+/g, ' ').trim()

  // Classify. Priority: Action header → Status leading digit →
  // fallback to bounced (we wouldn't be here without some signal).
  let eventType: ParsedEventType
  if (action === 'failed') {
    eventType = 'bounced'
  } else if (action === 'delayed') {
    eventType = 'deferred'
  } else if (action === 'delivered') {
    eventType = 'delivered'
  } else if (statusCode?.startsWith('5')) {
    eventType = 'bounced'
  } else if (statusCode?.startsWith('4')) {
    eventType = 'deferred'
  } else if (statusCode?.startsWith('2')) {
    eventType = 'delivered'
  } else {
    eventType = 'bounced'
  }

  return {
    recipient: recipient.toLowerCase(),
    eventType,
    statusCode,
    reason,
  }
}

/**
 * Detect feedback-loop complaint reports (ARF — RFC 5965). These
 * arrive when a recipient marks the message as spam at major
 * providers. The format is `multipart/report; report-type=feedback-report`.
 */
export function parseComplaint(raw: string): ParsedBounceEvent | null {
  // Two-step check to avoid greedy/backtracking subtleties — check
  // for multipart/report AND feedback-report report-type as
  // separate substrings.
  const isReport = /content-type:\s*multipart\/report/i.test(raw)
  const isFeedback = /report-type\s*=\s*feedback-report/i.test(raw)
  if (!isReport || !isFeedback) return null

  // ARF has its own "Original-Rcpt-To" field in the
  // message/feedback-report part. Address may be bracketed.
  const recipientMatch = raw.match(
    /^Original-Rcpt-To:\s*<?([^\s<>\n,]+)/im
  )
  const recipient = recipientMatch?.[1]
  if (!recipient || !recipient.includes('@')) return null

  return {
    recipient: recipient.toLowerCase(),
    eventType: 'complained',
  }
}

/**
 * Try complaint parser first (more specific), fall back to
 * bounce. Returns null when neither matches.
 */
export function parseInboundEmail(raw: string): ParsedBounceEvent | null {
  return parseComplaint(raw) ?? parseBounce(raw)
}
