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
import { db, googleAccounts } from '../db'
import { createDraft } from './google/gmail-service'
import { createLogger } from '../lib/logger'

const logger = createLogger('InviteEmail')

export interface DraftInviteEmailResult {
  drafted: boolean
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
 * Create an invite email draft in the inviter's Gmail account.
 * Idempotent at the call site (createDraft makes a new draft each
 * time), so the route layer should call this exactly once per invite.
 */
export async function draftInviteEmail(
  opts: DraftInviteEmailOptions
): Promise<DraftInviteEmailResult> {
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
      reason: 'inviter has no Gmail-enabled Google account',
    }
  }

  if (!inviterAccount.email) {
    return {
      drafted: false,
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
    return { drafted: true, draftId: draft.draftId }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.warn('Invite email draft failed', {
      inviterUserId: opts.inviterUserId,
      inviteeEmail: opts.inviteeEmail,
      error: message,
    })
    return { drafted: false, reason: message }
  }
}

// Exported for unit tests — pure builder, easy to assert on.
export const _builders = {
  buildSubject,
  buildBody,
}
