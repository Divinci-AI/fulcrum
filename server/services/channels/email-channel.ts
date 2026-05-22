/**
 * Email channel implementation using imapflow (IMAP) for receiving.
 * Sending is disabled — use Gmail drafts for human-in-the-loop email.
 *
 * All incoming emails are observe-only (create tasks/memories, never auto-respond).
 */

import { ImapFlow } from 'imapflow'
import { log } from '../../lib/logger'
import { getSettings } from '../../lib/settings'
import type {
  MessagingChannel,
  ChannelEvents,
  ConnectionStatus,
  IncomingMessage,
  EmailAuthState,
} from './types'

// Import from new modules
import { parseEmailHeaders, parseEmailContent } from './email-parser'
import { storeEmail, getStoredEmails as getStoredEmailsFromDb, getStoredEmailByMessageId, type StoredEmail } from './email-storage'
import { isAutomatedEmail } from './email-types'

export class EmailChannel implements MessagingChannel {
  readonly type = 'email' as const
  readonly connectionId: string

  private imapClient: ImapFlow | null = null
  private events: ChannelEvents | null = null
  private status: ConnectionStatus = 'disconnected'
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private isShuttingDown = false
  private credentials: EmailAuthState | null = null
  private lastSeenUid: number = 0
  private consecutiveFailures = 0

  constructor(connectionId: string, credentials?: EmailAuthState) {
    this.connectionId = connectionId
    this.credentials = credentials ?? null
  }

  /** Create an ImapFlow client with an error event listener to prevent unhandled crashes */
  private createImapClient(): ImapFlow {
    if (!this.credentials) throw new Error('No credentials available')
    const client = new ImapFlow({
      host: this.credentials.imap.host,
      port: this.credentials.imap.port,
      secure: this.credentials.imap.secure,
      auth: {
        user: this.credentials.imap.user,
        pass: this.credentials.imap.password,
      },
      logger: false,
      socketTimeout: 90_000,
      greetingTimeout: 15_000,
    })
    client.on('error', (err: Error) => {
      log.messaging.error('IMAP client error', {
        connectionId: this.connectionId,
        error: String(err),
      })
    })
    return client
  }

  async initialize(events: ChannelEvents): Promise<void> {
    this.events = events
    this.isShuttingDown = false

    if (!this.credentials) {
      // Load credentials from settings
      const settings = getSettings()
      const emailConfig = settings.channels.email

      if (!emailConfig.imap.host || !emailConfig.imap.user || !emailConfig.imap.password) {
        this.updateStatus('credentials_required')
        return
      }

      this.credentials = {
        imap: emailConfig.imap,
        pollIntervalSeconds: emailConfig.pollIntervalSeconds,
      }
    }

    await this.connect()
  }

  private async connect(): Promise<void> {
    if (this.isShuttingDown || !this.credentials) return

    try {
      this.updateStatus('connecting')

      // Setup IMAP client
      this.imapClient = this.createImapClient()

      // Connect to IMAP
      await this.imapClient.connect()

      log.messaging.info('IMAP connection established', {
        connectionId: this.connectionId,
        host: this.credentials.imap.host,
      })

      // Get the last UID from INBOX to avoid processing old emails
      await this.imapClient.mailboxOpen('INBOX')
      const status = await this.imapClient.status('INBOX', { uidNext: true })
      this.lastSeenUid = (status.uidNext ?? 1) - 1
      await this.imapClient.logout()

      this.updateStatus('connected')
      this.consecutiveFailures = 0

      // Start IMAP polling
      this.startPolling()
    } catch (err) {
      log.messaging.error('Email connect error', {
        connectionId: this.connectionId,
        error: String(err),
      })
      this.updateStatus('disconnected')
    }
  }

  private startPolling(): void {
    if (this.pollTimer || !this.credentials) return

    const intervalMs = (this.credentials.pollIntervalSeconds || 30) * 1000

    log.messaging.info('Starting IMAP polling', {
      connectionId: this.connectionId,
      intervalMs,
    })

    // Initial poll
    this.pollForNewEmails()

    // Schedule regular polling
    this.pollTimer = setInterval(() => {
      this.pollForNewEmails()
    }, intervalMs)
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.isShuttingDown) return

    const delayMs = Math.min(5000 * Math.pow(2, this.consecutiveFailures), 300_000)

    log.messaging.info('Scheduling IMAP reconnect', {
      connectionId: this.connectionId,
      delayMs,
      consecutiveFailures: this.consecutiveFailures,
    })

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delayMs)
  }

  private async pollForNewEmails(): Promise<void> {
    if (this.isShuttingDown || !this.credentials) return

    let client: ImapFlow | null = null

    try {
      // Create new IMAP connection for polling
      client = this.createImapClient()

      await client.connect()
      const lock = await client.getMailboxLock('INBOX')

      try {
        // Search for unseen emails with UID greater than last seen
        const searchQuery = this.lastSeenUid > 0
          ? { uid: `${this.lastSeenUid + 1}:*`, seen: false }
          : { seen: false }

        for await (const message of client.fetch(searchQuery, {
          uid: true,
          envelope: true,
          source: true,
        })) {
          // Skip if we've already processed this UID
          if (message.uid <= this.lastSeenUid) continue

          this.lastSeenUid = Math.max(this.lastSeenUid, message.uid)

          // ImapFlow types message.source as Buffer | undefined when the
          // BODYSTRUCTURE fetch didn't include the message body. We
          // explicitly asked for source: true above, so this is
          // defensive — skip if missing.
          if (!message.source) continue

          // Parse full headers from source
          const headers = parseEmailHeaders(message.source, message.envelope ?? {})

          if (!headers.from) continue

          // Skip emails from ourselves (to avoid loops)
          const fromAddress = this.credentials!.imap.user.toLowerCase()
          if (headers.from.toLowerCase() === fromAddress) {
            continue
          }

          // Skip automated emails entirely (newsletters, notifications, etc.)
          const automatedCheck = isAutomatedEmail(headers)
          if (automatedCheck.isAutomated) {
            log.messaging.info('Email skipped - automated sender', {
              connectionId: this.connectionId,
              from: headers.from,
              subject: headers.subject,
              reason: automatedCheck.reason,
            })
            continue
          }

          // Parse email content
          const content = await parseEmailContent(message.source, this.connectionId)
          if (!content) continue

          // Compute thread ID from email chain
          const threadId = headers.references[0] || headers.inReplyTo || headers.messageId || undefined

          // Store ALL non-automated emails locally — skip observer if duplicate
          if (headers.messageId) {
            const isNew = storeEmail({
              connectionId: this.connectionId,
              messageId: headers.messageId,
              threadId,
              inReplyTo: headers.inReplyTo ?? undefined,
              references: headers.references.length > 0 ? headers.references : undefined,
              direction: 'incoming',
              fromAddress: headers.from || 'unknown',
              fromName: headers.fromName ?? undefined,
              toAddresses: headers.to.length > 0 ? headers.to : undefined,
              ccAddresses: headers.cc.length > 0 ? headers.cc : undefined,
              subject: headers.subject ?? undefined,
              textContent: content,
              emailDate: headers.date ?? undefined,
              imapUid: message.uid,
            })

            if (!isNew) continue // Already processed — skip observer
          }

          const incomingMessage: IncomingMessage = {
            channelType: 'email',
            connectionId: this.connectionId,
            senderId: headers.from,
            senderName: headers.fromName || undefined,
            content,
            timestamp: headers.date || new Date(),
            metadata: {
              messageId: headers.messageId,
              inReplyTo: headers.inReplyTo,
              references: headers.references,
              subject: headers.subject,
              threadId,
              observeOnly: true,
            },
          }

          log.messaging.info('Email received', {
            connectionId: this.connectionId,
            from: headers.from,
            subject: headers.subject,
            contentLength: content.length,
            threadId,
          })

          // Route through message handler (observe-only messages won't get AI responses)
          try {
            await this.events?.onMessage(incomingMessage)
          } catch (err) {
            log.messaging.error('Error processing email message', {
              connectionId: this.connectionId,
              error: String(err),
            })
          }

          // Note: We don't mark messages as read here because imapflow's
          // messageFlagsAdd hangs when called inside the fetch loop.
          // Messages will be skipped on subsequent polls via UID tracking.
        }
      } finally {
        lock.release()
      }

      await client.logout()
      this.consecutiveFailures = 0
    } catch (err) {
      this.consecutiveFailures++

      log.messaging.error('IMAP poll error', {
        connectionId: this.connectionId,
        error: String(err),
        consecutiveFailures: this.consecutiveFailures,
      })

      if (String(err).includes('AUTHENTICATIONFAILED') || String(err).includes('LOGIN')) {
        this.updateStatus('credentials_required')
      } else if (this.consecutiveFailures >= 3) {
        log.messaging.warn('IMAP polling failed repeatedly, scheduling reconnect', {
          connectionId: this.connectionId,
          consecutiveFailures: this.consecutiveFailures,
        })
        this.updateStatus('disconnected')
        if (this.pollTimer) {
          clearInterval(this.pollTimer)
          this.pollTimer = null
        }
        this.scheduleReconnect()
      }

      // Ensure client is cleaned up on error — use close() instead of logout()
      // to destroy the socket immediately rather than sending a command over a dead connection
      if (client) {
        try {
          client.close()
        } catch {
          // Ignore cleanup errors
        }
      }
    }
  }

  async shutdown(): Promise<void> {
    this.isShuttingDown = true

    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    if (this.imapClient) {
      try {
        await this.imapClient.logout()
      } catch {
        // Ignore logout errors
      }
      this.imapClient = null
    }

    this.updateStatus('disconnected')
    log.messaging.info('Email channel shutdown', {
      connectionId: this.connectionId,
    })
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async sendMessage(recipientId: string, content: string, metadata?: Record<string, unknown>): Promise<boolean> {
    log.messaging.warn('Email sending disabled — use Gmail drafts instead', {
      connectionId: this.connectionId,
    })
    return false
  }

  getStatus(): ConnectionStatus {
    return this.status
  }

  private updateStatus(status: ConnectionStatus): void {
    this.status = status

    // Notify listeners (no database update - email config is in settings.json)
    this.events?.onConnectionChange(status)
  }

  /**
   * Search emails via IMAP.
   * Returns matching email UIDs that can then be fetched.
   */
  async searchImapEmails(criteria: {
    subject?: string
    from?: string
    to?: string
    since?: Date
    before?: Date
    text?: string
    seen?: boolean
    flagged?: boolean
  }): Promise<number[]> {
    if (!this.credentials) {
      throw new Error('Not connected - no credentials available')
    }

    const client = this.createImapClient()

    try {
      await client.connect()
      const lock = await client.getMailboxLock('INBOX')

      try {
        // Build IMAP search query
        const searchQuery: Record<string, unknown> = {}

        if (criteria.subject) searchQuery.subject = criteria.subject
        if (criteria.from) searchQuery.from = criteria.from
        if (criteria.to) searchQuery.to = criteria.to
        if (criteria.since) searchQuery.since = criteria.since
        if (criteria.before) searchQuery.before = criteria.before
        if (criteria.text) searchQuery.body = criteria.text
        if (criteria.seen !== undefined) {
          searchQuery.seen = criteria.seen
        }
        if (criteria.flagged !== undefined) {
          searchQuery.flagged = criteria.flagged
        }

        const uids = await client.search(searchQuery, { uid: true })
        return uids as number[]
      } finally {
        lock.release()
      }
    } finally {
      await client.logout()
    }
  }

  /**
   * Fetch emails by UID from IMAP and store them locally.
   * Returns the stored email records.
   */
  async fetchAndStoreEmails(uids: number[], options?: { limit?: number }): Promise<StoredEmail[]> {
    if (!this.credentials || uids.length === 0) {
      return []
    }

    const limit = options?.limit ?? 50
    const uidsToFetch = uids.slice(0, limit)

    const client = this.createImapClient()

    const storedEmails: StoredEmail[] = []

    try {
      await client.connect()
      const lock = await client.getMailboxLock('INBOX')

      try {
        for await (const message of client.fetch(uidsToFetch, {
          uid: true,
          source: true,
          envelope: true,
        })) {
          // ImapFlow types message.source as Buffer | undefined; we
          // asked for source: true above, so this is defensive.
          if (!message.source) continue
          const headers = parseEmailHeaders(message.source, message.envelope ?? {})

          if (!headers.messageId) continue

          // Parse content
          const content = await parseEmailContent(message.source, this.connectionId)

          // Store the email
          storeEmail({
            connectionId: this.connectionId,
            messageId: headers.messageId,
            threadId: headers.references[0] || headers.inReplyTo || headers.messageId,
            inReplyTo: headers.inReplyTo ?? undefined,
            references: headers.references.length > 0 ? headers.references : undefined,
            direction: 'incoming',
            fromAddress: headers.from || 'unknown',
            fromName: headers.fromName ?? undefined,
            toAddresses: headers.to.length > 0 ? headers.to : undefined,
            ccAddresses: headers.cc.length > 0 ? headers.cc : undefined,
            subject: headers.subject ?? undefined,
            textContent: content ?? undefined,
            emailDate: headers.date ?? undefined,
            imapUid: message.uid,
          })

          // Retrieve the stored email
          const stored = getStoredEmailByMessageId(this.connectionId, headers.messageId)

          if (stored) {
            storedEmails.push(stored)
          }
        }
      } finally {
        lock.release()
      }
    } finally {
      await client.logout()
    }

    return storedEmails
  }

  /**
   * Get locally stored emails with optional filters.
   */
  getStoredEmails(options?: {
    limit?: number
    offset?: number
    direction?: 'incoming' | 'outgoing'
    threadId?: string
    search?: string
    folder?: string
  }): StoredEmail[] {
    return getStoredEmailsFromDb({
      connectionId: this.connectionId,
      ...options,
    })
  }
}

/**
 * Test email credentials without saving them.
 * Tests IMAP connection only (sending is disabled).
 */
export async function testEmailCredentials(credentials: EmailAuthState): Promise<{
  success: boolean
  imapOk: boolean
  error?: string
}> {
  // Test IMAP
  try {
    const client = new ImapFlow({
      host: credentials.imap.host,
      port: credentials.imap.port,
      secure: credentials.imap.secure,
      auth: {
        user: credentials.imap.user,
        pass: credentials.imap.password,
      },
      logger: false,
    })
    client.on('error', () => {}) // Prevent unhandled error event crash

    await client.connect()
    await client.logout()
  } catch (err) {
    return {
      success: false,
      imapOk: false,
      error: `IMAP error: ${String(err)}`,
    }
  }

  return {
    success: true,
    imapOk: true,
  }
}