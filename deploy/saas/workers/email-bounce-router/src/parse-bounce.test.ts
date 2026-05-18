/**
 * D-11 PR 3 — parse-bounce tests.
 *
 * Pure-function module; testable without wrangler. Covers the
 * documented DSN/ARF formats + the common real-world variants
 * (whitespace differences, no rfc822 prefix, etc.).
 */
import { describe, test, expect } from 'bun:test'
import { parseBounce, parseComplaint, parseInboundEmail } from './parse-bounce'

const DSN_PERMANENT_BOUNCE = `From: <Mailer-Daemon@mx1.example.com>
To: bounces@invites.divinci.ai
Subject: Mail delivery failed
Content-Type: multipart/report; report-type=delivery-status; boundary="bdry"

--bdry
Content-Type: text/plain

This message could not be delivered.

--bdry
Content-Type: message/delivery-status

Reporting-MTA: dns; mx1.example.com
Final-Recipient: rfc822; missing@example.com
Action: failed
Status: 5.1.1
Diagnostic-Code: smtp; 550 5.1.1 The email account that you tried to reach does not exist.

--bdry--
`

const DSN_TRANSIENT = `From: <Mailer-Daemon@mx1.example.com>
To: bounces@invites.divinci.ai
Content-Type: multipart/report; report-type=delivery-status; boundary="bdry"

--bdry
Content-Type: message/delivery-status

Final-Recipient: rfc822; busy@example.com
Action: delayed
Status: 4.7.0
Diagnostic-Code: smtp; 451 Greylisted, try again later
--bdry--
`

const DSN_NO_RFC822_PREFIX = `From: postmaster@example.com
To: bounces@invites.divinci.ai
Content-Type: multipart/report

Final-Recipient: alt@example.com
Action: failed
Status: 5.2.1
`

const ARF_COMPLAINT = `From: <fbl@aol.com>
To: bounces@invites.divinci.ai
Content-Type: multipart/report; report-type=feedback-report; boundary="abr"

--abr
Content-Type: message/feedback-report

Feedback-Type: abuse
User-Agent: AOL Mail FBL
Original-Mail-From: <noreply@invites.divinci.ai>
Original-Rcpt-To: <complainer@aol.com>
Reported-Domain: invites.divinci.ai
--abr--
`

const HUMAN_REPLY = `From: Friend <friend@example.com>
To: bounces@invites.divinci.ai
Subject: Re: invitation

Hey, you sent that to the wrong address.
`

describe('parseBounce', () => {
  test('permanent bounce (5.x.x, Action: failed) → bounced', () => {
    const got = parseBounce(DSN_PERMANENT_BOUNCE)
    expect(got).not.toBeNull()
    expect(got?.recipient).toBe('missing@example.com')
    expect(got?.eventType).toBe('bounced')
    expect(got?.statusCode).toBe('5.1.1')
    expect(got?.reason).toContain('does not exist')
  })

  test('transient (4.x.x, Action: delayed) → deferred', () => {
    const got = parseBounce(DSN_TRANSIENT)
    expect(got?.eventType).toBe('deferred')
    expect(got?.statusCode).toBe('4.7.0')
    expect(got?.recipient).toBe('busy@example.com')
  })

  test('Final-Recipient without rfc822; prefix still parses', () => {
    const got = parseBounce(DSN_NO_RFC822_PREFIX)
    expect(got?.recipient).toBe('alt@example.com')
    expect(got?.statusCode).toBe('5.2.1')
    expect(got?.eventType).toBe('bounced')
  })

  test('returns null for a human reply that lacks both multipart/report and a daemon From', () => {
    expect(parseBounce(HUMAN_REPLY)).toBeNull()
  })

  test('recipient is lowercased', () => {
    const upper = DSN_PERMANENT_BOUNCE.replace('missing@example.com', 'MIXED.Case@Example.COM')
    expect(parseBounce(upper)?.recipient).toBe('mixed.case@example.com')
  })

  test('falls back to Status digit when Action is missing', () => {
    const noAction = `From: mailer-daemon@x.com
Content-Type: multipart/report

Final-Recipient: rfc822; x@y.com
Status: 5.0.0
`
    expect(parseBounce(noAction)?.eventType).toBe('bounced')

    const transientNoAction = noAction.replace('5.0.0', '4.4.1')
    expect(parseBounce(transientNoAction)?.eventType).toBe('deferred')
  })

  test('accepts postmaster sender even without multipart/report', () => {
    const plainBounce = `From: postmaster@google.com
To: bounces@invites.divinci.ai
Subject: Delivery failure

Final-Recipient: rfc822; nobody@bigco.com
Status: 5.1.1
Diagnostic-Code: 550 not found
`
    const got = parseBounce(plainBounce)
    expect(got?.recipient).toBe('nobody@bigco.com')
    expect(got?.eventType).toBe('bounced')
  })

  test('returns null when there is no recipient header at all', () => {
    const noRecipient = `From: mailer-daemon@x.com
Content-Type: multipart/report

Status: 5.0.0
Action: failed
`
    expect(parseBounce(noRecipient)).toBeNull()
  })
})

describe('parseComplaint', () => {
  test('ARF feedback report → complained', () => {
    const got = parseComplaint(ARF_COMPLAINT)
    expect(got).not.toBeNull()
    expect(got?.recipient).toBe('complainer@aol.com')
    expect(got?.eventType).toBe('complained')
  })

  test('returns null for a regular DSN', () => {
    expect(parseComplaint(DSN_PERMANENT_BOUNCE)).toBeNull()
  })

  test('returns null for a human reply', () => {
    expect(parseComplaint(HUMAN_REPLY)).toBeNull()
  })
})

describe('parseInboundEmail', () => {
  test('routes ARF to complaint parser first', () => {
    expect(parseInboundEmail(ARF_COMPLAINT)?.eventType).toBe('complained')
  })

  test('falls back to bounce parser', () => {
    expect(parseInboundEmail(DSN_PERMANENT_BOUNCE)?.eventType).toBe('bounced')
  })

  test('returns null for human reply', () => {
    expect(parseInboundEmail(HUMAN_REPLY)).toBeNull()
  })
})
