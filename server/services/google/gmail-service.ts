/**
 * Gmail Service
 *
 * Wraps the Gmail API for sending, receiving, and draft management.
 * Used both by the Gmail backend for EmailChannel and by the MCP tools.
 */

import { google, type gmail_v1 } from 'googleapis'
import { eq } from 'drizzle-orm'
import { db, googleAccounts, gmailDrafts } from '../../db'
import { getAuthenticatedClient } from '../google-oauth'
import { createLogger } from '../../lib/logger'
import { stripHtml } from '../channels/email-parser'

const logger = createLogger('Google:Gmail')

// ==========================================
// Message helpers
// ==========================================

/**
 * Build an RFC 2822 compliant email message.
 */
function buildRawMessage(opts: {
  to?: string[]
  cc?: string[]
  bcc?: string[]
  subject?: string
  body?: string
  htmlBody?: string
  from?: string
  inReplyTo?: string
  references?: string[]
}): string {
  const lines: string[] = []

  if (opts.from) lines.push(`From: ${opts.from}`)
  if (opts.to?.length) lines.push(`To: ${opts.to.join(', ')}`)
  if (opts.cc?.length) lines.push(`Cc: ${opts.cc.join(', ')}`)
  if (opts.bcc?.length) lines.push(`Bcc: ${opts.bcc.join(', ')}`)
  if (opts.subject) lines.push(`Subject: ${opts.subject}`)
  if (opts.inReplyTo) lines.push(`In-Reply-To: ${opts.inReplyTo}`)
  if (opts.references?.length) lines.push(`References: ${opts.references.join(' ')}`)

  if (opts.htmlBody) {
    const boundary = `boundary_${crypto.randomUUID().replace(/-/g, '')}`
    lines.push('MIME-Version: 1.0')
    lines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`)
    lines.push('')
    lines.push(`--${boundary}`)
    lines.push('Content-Type: text/plain; charset=UTF-8')
    lines.push('')
    lines.push(opts.body ?? '')
    lines.push(`--${boundary}`)
    lines.push('Content-Type: text/html; charset=UTF-8')
    lines.push('')
    lines.push(opts.htmlBody)
    lines.push(`--${boundary}--`)
  } else {
    lines.push('MIME-Version: 1.0')
    lines.push('Content-Type: text/plain; charset=UTF-8')
    lines.push('')
    lines.push(opts.body ?? '')
  }

  return lines.join('\r\n')
}

/**
 * Base64url encode a string for Gmail API.
 */
function base64urlEncode(str: string): string {
  return Buffer.from(str)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/**
 * Recursively search MIME parts for a specific content type.
 */
function findMimePart(
  parts: gmail_v1.Schema$MessagePart[] | undefined,
  mimeType: string
): gmail_v1.Schema$MessagePart | undefined {
  if (!parts) return undefined
  for (const part of parts) {
    if (part.mimeType === mimeType && part.body?.data) return part
    const nested = findMimePart(part.parts, mimeType)
    if (nested) return nested
  }
  return undefined
}

/**
 * Parse a Gmail message into a simplified format.
 */
function parseGmailMessage(msg: gmail_v1.Schema$Message): {
  id: string
  threadId: string | null
  from: string | null
  to: string[]
  cc: string[]
  subject: string | null
  snippet: string | null
  body: string | null
  date: string | null
  messageId: string | null
  inReplyTo: string | null
  labels: string[]
} {
  const headers = msg.payload?.headers ?? []
  const getHeader = (name: string) =>
    headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? null

  // Extract body: try text/plain, fall back to text/html, then snippet
  let body: string | null = null
  if (msg.payload?.body?.data) {
    body = Buffer.from(msg.payload.body.data, 'base64url').toString('utf-8')
    if (msg.payload.mimeType === 'text/html') {
      body = stripHtml(body)
    }
  } else if (msg.payload?.parts) {
    const textPart = findMimePart(msg.payload.parts, 'text/plain')
    if (textPart?.body?.data) {
      body = Buffer.from(textPart.body.data, 'base64url').toString('utf-8')
    } else {
      const htmlPart = findMimePart(msg.payload.parts, 'text/html')
      if (htmlPart?.body?.data) {
        body = stripHtml(Buffer.from(htmlPart.body.data, 'base64url').toString('utf-8'))
      }
    }
  }
  // Last resort: use snippet
  if (!body && msg.snippet) {
    body = msg.snippet
  }

  return {
    id: msg.id ?? '',
    threadId: msg.threadId ?? null,
    from: getHeader('From'),
    to: (getHeader('To') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    cc: (getHeader('Cc') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    subject: getHeader('Subject'),
    snippet: msg.snippet ?? null,
    body,
    date: getHeader('Date'),
    messageId: getHeader('Message-ID') ?? getHeader('Message-Id'),
    inReplyTo: getHeader('In-Reply-To'),
    labels: msg.labelIds ?? [],
  }
}

// ==========================================
// Internal helpers
// ==========================================

async function getGmailClient(accountId: string): Promise<gmail_v1.Gmail> {
  const auth = await getAuthenticatedClient(accountId)
  return google.gmail({ version: 'v1', auth })
}

// ==========================================
// Send-as aliases
// ==========================================

/**
 * List verified send-as aliases for a Gmail account.
 * Uses gmail.users.settings.sendAs.list (covered by gmail.modify scope).
 */
export async function listSendAsAliases(
  accountId: string
): Promise<Array<{ email: string; displayName: string | null; isDefault: boolean; isPrimary: boolean }>> {
  const gmail = await getGmailClient(accountId)

  const res = await gmail.users.settings.sendAs.list({ userId: 'me' })
  const aliases = res.data.sendAs ?? []

  logger.info('Gmail sendAs aliases', {
    accountId,
    count: aliases.length,
    aliases: aliases.map((a) => ({
      email: a.sendAsEmail,
      isPrimary: a.isPrimary,
      isDefault: a.isDefault,
      verificationStatus: a.verificationStatus,
    })),
  })

  return aliases
    .filter((a) => a.verificationStatus === 'accepted' || a.isPrimary)
    .map((a) => ({
      email: a.sendAsEmail ?? '',
      displayName: a.displayName ?? null,
      isDefault: a.isDefault ?? false,
      isPrimary: a.isPrimary ?? false,
    }))
}

// ==========================================
// Receiving
// ==========================================

/**
 * List messages from Gmail.
 */
export async function listMessages(
  accountId: string,
  opts?: {
    query?: string
    maxResults?: number
    labelIds?: string[]
  }
): Promise<ReturnType<typeof parseGmailMessage>[]> {
  const gmail = await getGmailClient(accountId)

  const res = await gmail.users.messages.list({
    userId: 'me',
    q: opts?.query,
    maxResults: opts?.maxResults ?? 20,
    labelIds: opts?.labelIds,
  })

  const messages = res.data.messages ?? []
  const parsed: ReturnType<typeof parseGmailMessage>[] = []

  for (const msg of messages) {
    if (!msg.id) continue
    const full = await gmail.users.messages.get({
      userId: 'me',
      id: msg.id,
      format: 'full',
    })
    parsed.push(parseGmailMessage(full.data))
  }

  return parsed
}

/**
 * Get a single message by ID.
 */
export async function getMessage(
  accountId: string,
  messageId: string
): Promise<ReturnType<typeof parseGmailMessage>> {
  const gmail = await getGmailClient(accountId)
  const res = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'full',
  })
  return parseGmailMessage(res.data)
}

/**
 * Poll for new messages using Gmail history API.
 * Falls back to listing INBOX if no historyId is provided.
 */
export async function pollNewMessages(
  accountId: string,
  opts?: { historyId?: string; maxResults?: number }
): Promise<{
  messages: ReturnType<typeof parseGmailMessage>[]
  latestHistoryId: string | null
}> {
  const gmail = await getGmailClient(accountId)

  if (opts?.historyId) {
    try {
      const res = await gmail.users.history.list({
        userId: 'me',
        startHistoryId: opts.historyId,
        historyTypes: ['messageAdded'],
        labelId: 'INBOX',
      })

      const messages: ReturnType<typeof parseGmailMessage>[] = []
      const history = res.data.history ?? []

      for (const h of history) {
        for (const added of h.messagesAdded ?? []) {
          if (added.message?.id) {
            const full = await gmail.users.messages.get({
              userId: 'me',
              id: added.message.id,
              format: 'full',
            })
            messages.push(parseGmailMessage(full.data))
          }
        }
      }

      return {
        messages,
        latestHistoryId: res.data.historyId ?? opts.historyId,
      }
    } catch {
      // historyId expired, fall back to listing
      logger.warn('Gmail history expired, falling back to list', { accountId })
    }
  }

  // Fallback: list recent INBOX messages
  const messages = await listMessages(accountId, {
    query: 'in:inbox is:unread',
    maxResults: opts?.maxResults ?? 10,
  })

  // Get current historyId from profile
  const profile = await gmail.users.getProfile({ userId: 'me' })

  return {
    messages,
    latestHistoryId: profile.data.historyId ?? null,
  }
}

// ==========================================
// Drafts
// ==========================================

/**
 * List Gmail drafts for an account.
 */
export async function listDrafts(
  accountId: string
): Promise<Array<{
  id: string
  gmailDraftId: string
  to: string[]
  cc: string[]
  subject: string | null
  snippet: string | null
  updatedAt: string
}>> {
  const gmail = await getGmailClient(accountId)

  const res = await gmail.users.drafts.list({
    userId: 'me',
    maxResults: 50,
  })

  const drafts = res.data.drafts ?? []
  const results: Array<{
    id: string
    gmailDraftId: string
    to: string[]
    cc: string[]
    subject: string | null
    snippet: string | null
    updatedAt: string
  }> = []

  for (const draft of drafts) {
    if (!draft.id) continue

    // Two SDK quirks force the casts here:
    //   1. Params$Resource$Users$Drafts$Get is missing `metadataHeaders`
    //      (the Gmail REST API accepts it, types are stale upstream).
    //   2. drafts.get has callback overloads that return void, and TS
    //      resolves the union to `void` when params don't strictly match
    //      a single overload — so we narrow the awaited result here.
    // Drop both casts when @types/googleapis catches up.
    const full = (await gmail.users.drafts.get({
      userId: 'me',
      id: draft.id,
      format: 'metadata',
      metadataHeaders: ['To', 'Cc', 'Subject'],
    } as unknown as Parameters<typeof gmail.users.drafts.get>[0])) as unknown as { data: gmail_v1.Schema$Draft }

    const headers = full.data.message?.payload?.headers ?? []
    const getHeader = (name: string) =>
      headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? null

    results.push({
      id: draft.id,
      gmailDraftId: draft.id,
      to: (getHeader('To') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
      cc: (getHeader('Cc') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
      subject: getHeader('Subject'),
      snippet: full.data.message?.snippet ?? null,
      updatedAt: new Date().toISOString(),
    })
  }

  return results
}

/**
 * Create a Gmail draft.
 */
export async function createDraft(
  accountId: string,
  opts: {
    to?: string[]
    cc?: string[]
    bcc?: string[]
    subject?: string
    body?: string
    htmlBody?: string
  }
): Promise<{ draftId: string; messageId: string | null }> {
  const gmail = await getGmailClient(accountId)

  const account = db.select().from(googleAccounts).where(eq(googleAccounts.id, accountId)).get()
  const from = account?.email ?? undefined

  const raw = base64urlEncode(
    buildRawMessage({ ...opts, from })
  )

  const res = await gmail.users.drafts.create({
    userId: 'me',
    requestBody: {
      message: { raw },
    },
  })

  const draftId = res.data.id ?? ''
  const messageId = res.data.message?.id ?? null

  // Cache in local DB
  const now = new Date().toISOString()
  db.insert(gmailDrafts)
    .values({
      id: crypto.randomUUID(),
      googleAccountId: accountId,
      gmailDraftId: draftId,
      gmailMessageId: messageId,
      threadId: res.data.message?.threadId ?? null,
      to: opts.to ?? null,
      cc: opts.cc ?? null,
      bcc: opts.bcc ?? null,
      subject: opts.subject ?? null,
      body: opts.body ?? null,
      htmlBody: opts.htmlBody ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .run()

  logger.info('Created Gmail draft', { accountId, draftId })

  return { draftId, messageId }
}

/**
 * Update a Gmail draft.
 */
export async function updateDraft(
  accountId: string,
  draftId: string,
  opts: {
    to?: string[]
    cc?: string[]
    bcc?: string[]
    subject?: string
    body?: string
    htmlBody?: string
  }
): Promise<{ draftId: string; messageId: string | null }> {
  const gmail = await getGmailClient(accountId)

  const account = db.select().from(googleAccounts).where(eq(googleAccounts.id, accountId)).get()
  const from = account?.email ?? undefined

  const raw = base64urlEncode(
    buildRawMessage({ ...opts, from })
  )

  const res = await gmail.users.drafts.update({
    userId: 'me',
    id: draftId,
    requestBody: {
      message: { raw },
    },
  })

  const newDraftId = res.data.id ?? draftId
  const messageId = res.data.message?.id ?? null

  // Update local cache
  const now = new Date().toISOString()
  db.update(gmailDrafts)
    .set({
      gmailDraftId: newDraftId,
      gmailMessageId: messageId,
      to: opts.to ?? undefined,
      cc: opts.cc ?? undefined,
      bcc: opts.bcc ?? undefined,
      subject: opts.subject ?? undefined,
      body: opts.body ?? undefined,
      htmlBody: opts.htmlBody ?? undefined,
      updatedAt: now,
    })
    .where(eq(gmailDrafts.gmailDraftId, draftId))
    .run()

  logger.info('Updated Gmail draft', { accountId, draftId: newDraftId })

  return { draftId: newDraftId, messageId }
}

/**
 * Send an email to the account's own email address.
 * Used by the Gmail messaging channel and Gmail notification channel.
 */
export async function sendEmail(
  accountId: string,
  opts: { subject?: string; body?: string; htmlBody?: string }
): Promise<{ messageId: string }> {
  const gmail = await getGmailClient(accountId)
  const account = db.select().from(googleAccounts).where(eq(googleAccounts.id, accountId)).get()
  if (!account?.email) throw new Error('Google account has no email address')

  const raw = base64urlEncode(
    buildRawMessage({ to: [account.email], from: account.email, ...opts })
  )

  const res = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw },
  })

  logger.info('Sent Gmail message', { accountId, messageId: res.data.id })

  return { messageId: res.data.id ?? '' }
}

/**
 * Delete a Gmail draft.
 */
export async function deleteDraft(accountId: string, draftId: string): Promise<void> {
  const gmail = await getGmailClient(accountId)

  await gmail.users.drafts.delete({
    userId: 'me',
    id: draftId,
  })

  // Remove from local cache
  db.delete(gmailDrafts).where(eq(gmailDrafts.gmailDraftId, draftId)).run()

  logger.info('Deleted Gmail draft', { accountId, draftId })
}