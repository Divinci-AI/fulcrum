/**
 * Cloudflare Email Sending — beta (D-10 PR 8).
 *
 * Auto-sends transactional invite emails via Cloudflare's email send
 * API. Opt-in: when `cloudflareEmailEnabled` is true AND the token +
 * account id + from address are all set, `sendInviteEmail` short-
 * circuits the Gmail draft path. Otherwise this module returns
 * `{ sent: false, skipped: true }` and the caller falls back.
 *
 * Threat model — this path is for **transactional system mail only**
 * (templated bodies, admin-triggered, recipient is the email the
 * admin explicitly typed in the invite form). The existing
 * "user-only outbound" policy in memory applies to AI-driven
 * conversational messaging, not transactional. Don't wire this
 * service into anything the assistant produces.
 *
 * Endpoint (beta):
 *   POST /accounts/{account_id}/email/sending/send
 *   { to, from, subject, html, text }
 *
 * Auth: Bearer CLOUDFLARE_API_TOKEN. The token needs an
 * "Email Sending: Edit" permission — operators rotating the token
 * should add this scope (see RUNBOOK §8).
 *
 * Sending domain prerequisites (one-time per domain, in CF dashboard):
 *   1. Domain on Cloudflare DNS (already true for divinci.ai)
 *   2. SPF/DKIM/DMARC records published (CF wizard adds them)
 *   3. From address verified
 */
import { getSettings } from '../lib/settings'
import { createLogger } from '../lib/logger'

const logger = createLogger('CloudflareEmail')
const CF_API_BASE = 'https://api.cloudflare.com/client/v4'

export interface SendInviteEmailResult {
  sent: boolean
  /** True iff the call was a no-op because CF Email isn't
   * configured (or explicitly disabled). Distinct from `sent:false`
   * which means CF API was called and failed. */
  skipped: boolean
  /** CF-returned message id on success. */
  messageId?: string
  reason?: string
}

interface SendInviteEmailOptions {
  to: string
  /** The tenant URL the invitee should visit (used in the body). */
  tenantUrl: string
  /** The admin's email — used in the body's signature. */
  inviterEmail: string
  /** Optional display name for the greeting. */
  inviteeDisplayName?: string | null
}

interface CfEmailSendResponse {
  success: boolean
  errors?: Array<{ code: number; message: string }>
  result?: { id?: string; message_id?: string }
}

// Exposed so tests can inject a mock fetch without `mock.module`
// cross-file ordering risk (the established DI seam pattern).
type FetchImpl = typeof fetch
let _fetchImpl: FetchImpl = fetch
export function setCloudflareEmailFetchImpl(impl: FetchImpl): void {
  _fetchImpl = impl
}
export function resetCloudflareEmailFetchImpl(): void {
  _fetchImpl = fetch
}

function buildSubject(): string {
  return "You've been invited to Fulcrum"
}

function buildText(opts: SendInviteEmailOptions): string {
  const greeting = opts.inviteeDisplayName ? `Hi ${opts.inviteeDisplayName},` : 'Hi,'
  return [
    greeting,
    '',
    `You've been added to Fulcrum at ${opts.tenantUrl}.`,
    '',
    "Fulcrum is our workspace for tracking tasks, projects, and the AI agents we run alongside them. Sign in with your work email and you'll be able to assign yourself tasks, get @-mentioned, and pick up running threads.",
    '',
    `Sign in: ${opts.tenantUrl}`,
    '',
    'Let me know if you have any trouble getting in.',
    '',
    `— ${opts.inviterEmail}`,
  ].join('\n')
}

function buildHtml(opts: SendInviteEmailOptions): string {
  // Intentionally simple — no inline styles beyond a single link.
  // Email clients render plaintext-ish HTML reliably; fancier
  // templates can come later if the operator asks.
  const greeting = opts.inviteeDisplayName ? `Hi ${opts.inviteeDisplayName},` : 'Hi,'
  return `
<p>${greeting}</p>
<p>You've been added to Fulcrum at <a href="${opts.tenantUrl}">${opts.tenantUrl}</a>.</p>
<p>Fulcrum is our workspace for tracking tasks, projects, and the AI agents we run alongside them. Sign in with your work email and you'll be able to assign yourself tasks, get @-mentioned, and pick up running threads.</p>
<p><a href="${opts.tenantUrl}">Sign in &rarr;</a></p>
<p>Let me know if you have any trouble getting in.</p>
<p>&mdash; ${opts.inviterEmail}</p>
  `.trim()
}

/**
 * Send an invite email via Cloudflare Email Sending. No-op (skipped)
 * when not configured; soft-fail with `{ sent:false, reason }` on
 * API error. The route layer falls back to the Gmail draft path on
 * skipped OR failed.
 */
export async function sendInviteEmail(
  opts: SendInviteEmailOptions
): Promise<SendInviteEmailResult> {
  const settings = getSettings()
  const enabled = settings.integrations.cloudflareEmailEnabled === true
  const token = settings.integrations.cloudflareApiToken
  const accountId = settings.integrations.cloudflareAccountId
  const fromAddress = settings.integrations.cloudflareEmailFromAddress

  if (!enabled || !token || !accountId || !fromAddress) {
    return {
      sent: false,
      skipped: true,
      reason: 'CF Email not configured (enabled toggle off or token / account / from address missing)',
    }
  }

  const trimmedTo = opts.to.trim()
  if (!trimmedTo || !trimmedTo.includes('@')) {
    return { sent: false, skipped: false, reason: 'invalid recipient email' }
  }

  const body = {
    to: trimmedTo,
    from: fromAddress,
    subject: buildSubject(),
    text: buildText(opts),
    html: buildHtml(opts),
  }

  try {
    const res = await _fetchImpl(
      `${CF_API_BASE}/accounts/${accountId}/email/sending/send`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      }
    )
    if (!res.ok) {
      const txt = await res.text().catch(() => '')
      return {
        sent: false,
        skipped: false,
        reason: `Cloudflare Email API ${res.status}: ${txt}`,
      }
    }
    const parsed = (await res.json()) as CfEmailSendResponse
    if (!parsed.success) {
      const summary = (parsed.errors ?? [])
        .map((e) => `${e.code} ${e.message}`)
        .join('; ')
      return {
        sent: false,
        skipped: false,
        reason: `Cloudflare Email API error: ${summary || 'unknown'}`,
      }
    }
    const messageId = parsed.result?.id ?? parsed.result?.message_id
    logger.info('Sent invite email via Cloudflare', {
      to: trimmedTo,
      messageId,
    })
    return { sent: true, skipped: false, messageId }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.warn('CF Email send failed', { to: trimmedTo, error: message })
    return { sent: false, skipped: false, reason: message }
  }
}

// Test-only exports for the body/subject builders.
export const _builders = { buildSubject, buildText, buildHtml }
