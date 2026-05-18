/**
 * Invite email drafting (D-9 PR 2).
 *
 * Creates a templated Gmail draft addressed to the invitee, owned by
 * the admin's Gmail account. The admin opens Gmail, reviews, and
 * clicks send — Fulcrum never auto-sends to third parties (preserves
 * the existing "user-only outbound" policy).
 *
 * No-ops gracefully when the admin doesn't have a Gmail-enabled
 * Google account: returns `{ drafted: false, reason }`.
 */
import { and, eq } from 'drizzle-orm'
import { db, googleAccounts, users } from '../db'
import { createDraft } from './google/gmail-service'
import { sendInviteEmail as sendViaCloudflare } from './cloudflare-email-service'
import { createLogger } from '../lib/logger'

const logger = createLogger('InviteEmail')

export interface DraftInviteEmailResult {
  /** True iff a Gmail draft was created OR a CF Email send succeeded. */
  drafted: boolean
  /** D-10 PR 8: which path actually delivered. `cloudflare` is a true
   * send; `gmail-draft` is a "review and click send" draft; `none` is
   * the no-Gmail-account, no-CF-Email fallback. */
  mode: 'cloudflare' | 'gmail-draft' | 'none'
  /** Draft id (Gmail) OR message id (CF Email), depending on mode. */
  draftId?: string
  reason?: string
}

interface DraftInviteEmailOptions {
  /** Admin/inviter — the draft is owned by their Gmail account. */
  inviterUserId: string
  /** Email address of the person being invited. Used as the To: header. */
  inviteeEmail: string
  /** Tenant URL the invitee should visit, derived from the request Host. */
  tenantUrl: string
  /** Optional display name for the invitee. */
  inviteeDisplayName?: string | null
}

function buildSubject(): string {
  return "You've been invited to Fulcrum"
}

function buildBody(opts: DraftInviteEmailOptions, inviterEmail: string): string {
  const greeting = opts.inviteeDisplayName ? `Hi ${opts.inviteeDisplayName},` : 'Hi,'
  // Plain-text invite body — keep it short so the admin can edit
  // before sending. The URL is the only must-include element.
  return [
    greeting,
    '',
    `I've added you to Fulcrum at ${opts.tenantUrl}.`,
    '',
    "Fulcrum is our workspace for tracking tasks, projects, and the AI agents we run alongside them. Once you sign in with your work email, you'll be able to assign yourself tasks, @-mention me, and pick up the running threads.",
    '',
    `Sign in: ${opts.tenantUrl}`,
    '',
    'Let me know if you have any trouble getting in.',
    '',
    `— ${inviterEmail}`,
  ].join('\n')
}

/**
 * Best-effort delivery of an invite email.
 *
 * D-10 PR 8 routing rules, in order:
 *
 *   1. Try Cloudflare Email Sending (`cloudflareEmailEnabled` + token +
 *      account + from address all configured). If it succeeds we
 *      return `mode: 'cloudflare'` and the message_id; if it returns
 *      a real error (not "skipped"), surface that and don't fall
 *      back — the operator opted into CF Email and needs to see the
 *      failure rather than silently downgrade.
 *   2. Otherwise (CF skipped), drop to the Gmail draft path. Works
 *      when the inviter has a Gmail-enabled Google account. Result
 *      `mode: 'gmail-draft'` with the Gmail draft id.
 *   3. Neither configured → `mode: 'none'`, with a reason string.
 */
export async function draftInviteEmail(
  opts: DraftInviteEmailOptions
): Promise<DraftInviteEmailResult> {
  // --- D-10 PR 8 path: Cloudflare Email Sending ---
  const inviter = db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, opts.inviterUserId))
    .get()
  const cf = await sendViaCloudflare({
    to: opts.inviteeEmail,
    tenantUrl: opts.tenantUrl,
    inviterEmail: inviter?.email ?? 'admin',
    inviteeDisplayName: opts.inviteeDisplayName,
  })
  if (!cf.skipped) {
    if (cf.sent) {
      return { drafted: true, mode: 'cloudflare', draftId: cf.messageId }
    }
    // CF Email is configured but the call failed — surface that.
    // Don't silently fall back to Gmail draft; the operator chose CF
    // explicitly and needs to know it didn't work.
    return { drafted: false, mode: 'cloudflare', reason: cf.reason }
  }

  // --- Pre-existing path: Gmail draft in the inviter's account ---
  const inviterAccount = db
    .select()
    .from(googleAccounts)
    .where(
      and(
        eq(googleAccounts.ownerUserId, opts.inviterUserId),
        eq(googleAccounts.gmailEnabled, true)
      )
    )
    .get()

  if (!inviterAccount) {
    return {
      drafted: false,
      mode: 'none',
      reason: 'inviter has no Gmail-enabled Google account and CF Email is not configured',
    }
  }

  if (!inviterAccount.email) {
    return {
      drafted: false,
      mode: 'none',
      reason: 'inviter Google account is missing an email address',
    }
  }

  try {
    const draft = await createDraft(inviterAccount.id, {
      to: [opts.inviteeEmail],
      subject: buildSubject(),
      body: buildBody(opts, inviterAccount.email),
    })
    logger.info('Drafted invite email', {
      inviterUserId: opts.inviterUserId,
      inviteeEmail: opts.inviteeEmail,
      draftId: draft.draftId,
    })
    return { drafted: true, mode: 'gmail-draft', draftId: draft.draftId }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.warn('Invite email draft failed', {
      inviterUserId: opts.inviterUserId,
      inviteeEmail: opts.inviteeEmail,
      error: message,
    })
    return { drafted: false, mode: 'gmail-draft', reason: message }
  }
}

// Exported for unit tests — pure builder, easy to assert on.
export const _builders = {
  buildSubject,
  buildBody,
}
