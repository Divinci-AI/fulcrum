/**
 * Slack channel implementation using @slack/bolt library.
 * Uses Socket Mode for real-time messaging without needing a public URL.
 */

import { App, LogLevel, type SlashCommand, type RespondFn } from '@slack/bolt'
import type { KnownBlock, ChatPostMessageArguments, View } from '@slack/web-api'
import { eq, and, inArray, desc } from 'drizzle-orm'
import { readFileSync } from 'fs'
import { basename } from 'path'
import { db, messagingConnections, tasks } from '../../db'
import { log } from '../../lib/logger'
import { getSettings } from '../../lib/settings'
import { getUserIdForChannelIdentity } from '../channel-identity-service'
import type { AttachmentData } from '../../../shared/types'
import type {
  MessagingChannel,
  ChannelEvents,
  ConnectionStatus,
  IncomingMessage,
} from './types'
import { parseSlackResponse } from './slack-utils'

/** Shape of a Slack file object attached to a message */
interface SlackFile {
  id: string
  name: string
  mimetype: string
  size: number
  url_private_download?: string
}

/** MIME types we support downloading from Slack */
const SUPPORTED_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/plain',
  'text/csv',
  'text/markdown',
])

/** Max file size we'll download (10 MB) */
const MAX_FILE_SIZE = 10 * 1024 * 1024

/** Expected magic bytes for binary file types */
const MAGIC_BYTES: Record<string, (buf: Buffer) => boolean> = {
  'application/pdf': (buf) => buf.length >= 5 && buf.subarray(0, 5).toString('ascii').startsWith('%PDF-'),
  'image/png': (buf) => buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47,
  'image/jpeg': (buf) => buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff,
  'image/gif': (buf) => buf.length >= 4 && buf.subarray(0, 4).toString('ascii') === 'GIF8',
  'image/webp': (buf) => buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP',
}

/** Returns true if the buffer starts with the expected magic bytes for the given MIME type, or if the type has no known signature. */
function validateMagicBytes(mimeType: string, buffer: Buffer): boolean {
  const check = MAGIC_BYTES[mimeType]
  return !check || check(buffer)
}

export class SlackChannel implements MessagingChannel {
  readonly type = 'slack' as const
  readonly connectionId: string

  private app: App | null = null
  private events: ChannelEvents | null = null
  private status: ConnectionStatus = 'disconnected'
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null
  private isShuttingDown = false
  private botToken: string | null = null
  private appToken: string | null = null

  /** How often to verify the connection is alive (ms) */
  private static HEALTH_CHECK_INTERVAL = 5 * 60 * 1000 // 5 minutes

  constructor(connectionId: string) {
    this.connectionId = connectionId
  }

  async initialize(events: ChannelEvents): Promise<void> {
    this.events = events
    this.isShuttingDown = false

    // Load credentials from settings
    const settings = getSettings()
    const slackConfig = settings.channels.slack

    if (!slackConfig.botToken || !slackConfig.appToken) {
      log.messaging.warn('Slack channel missing credentials', {
        connectionId: this.connectionId,
      })
      this.updateStatus('disconnected')
      return
    }

    this.botToken = slackConfig.botToken
    this.appToken = slackConfig.appToken

    await this.connect()
  }

  private async connect(): Promise<void> {
    if (this.isShuttingDown || !this.botToken || !this.appToken) return

    try {
      this.updateStatus('connecting')

      // Create Slack app with Socket Mode
      this.app = new App({
        token: this.botToken,
        appToken: this.appToken,
        socketMode: true,
        logLevel: LogLevel.WARN,
      })

      // Handle slash commands (must register before starting)
      this.app.command(/.*/, async ({ ack, command, respond }) => {
        await ack() // Must acknowledge immediately
        await this.handleSlashCommand(command, respond)
      })

      // Handle DM messages only
      // Note: app.message() handles all message events including DMs
      // We filter to only process direct messages (im channel type)
      this.app.message(async ({ message }) => {
        // Only process DMs, ignore channel/group messages
        if ((message as Record<string, unknown>).channel_type === 'im') {
          await this.handleMessage(message)
        }
      })

      // App Home tab: render a Fulcrum dashboard when a user opens the bot's
      // Home tab (Slack sidebar → Apps → Fulcrum → Home). Requires the
      // manifest to enable app_home.home_tab_enabled and subscribe to the
      // app_home_opened bot_event — both manifest-only changes; no scope
      // additions, no reinstall.
      this.app.event('app_home_opened', async ({ event }) => {
        const ev = event as unknown as { user: string; tab?: string }
        if (ev.tab && ev.tab !== 'home') return  // Ignore 'messages' tab opens
        await this.publishHomeView(ev.user)
      })

      // Start the app
      await this.app.start()

      // Listen for Socket Mode connection state changes
      this.setupSocketModeListeners()

      // Get bot info
      const authTest = await this.app.client.auth.test()

      log.messaging.info('Slack bot connected', {
        connectionId: this.connectionId,
        botId: authTest.bot_id,
        userId: authTest.user_id,
      })
      this.updateStatus('connected')

      // Start periodic health checks
      this.startHealthCheck()

      // Store display name (bot name or workspace)
      const displayName = (authTest.user as string) || 'Slack Bot'
      db.update(messagingConnections)
        .set({
          displayName,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(messagingConnections.id, this.connectionId))
        .run()
      this.events?.onDisplayNameChange?.(displayName)
    } catch (err) {
      log.messaging.error('Slack connect error', {
        connectionId: this.connectionId,
        error: String(err),
      })
      this.updateStatus('disconnected')
      this.scheduleReconnect()
    }
  }

  /**
   * Listen for Socket Mode client state changes so we detect silent disconnects.
   * The SocketModeClient (on the receiver) emits: connected, disconnected, reconnecting, etc.
   */
  private setupSocketModeListeners(): void {
    // Access the SocketModeClient from the Bolt receiver
    const receiver = (this.app as unknown as { receiver: { client: import('eventemitter3').EventEmitter } })?.receiver
    const socketClient = receiver?.client
    if (!socketClient) {
      log.messaging.warn('Could not access Socket Mode client for health monitoring', {
        connectionId: this.connectionId,
      })
      return
    }

    socketClient.on('disconnected', () => {
      if (this.isShuttingDown) return
      log.messaging.warn('Slack Socket Mode disconnected', {
        connectionId: this.connectionId,
      })
      this.updateStatus('disconnected')
    })

    socketClient.on('reconnecting', () => {
      if (this.isShuttingDown) return
      log.messaging.info('Slack Socket Mode reconnecting', {
        connectionId: this.connectionId,
      })
      this.updateStatus('connecting')
    })

    socketClient.on('connected', () => {
      if (this.isShuttingDown) return
      log.messaging.info('Slack Socket Mode reconnected', {
        connectionId: this.connectionId,
      })
      this.updateStatus('connected')
    })

    log.messaging.debug('Socket Mode event listeners attached', {
      connectionId: this.connectionId,
    })
  }

  /**
   * Periodic health check: call auth.test to verify the connection is truly alive.
   * Catches cases where the socket silently dies without emitting disconnect events.
   */
  private startHealthCheck(): void {
    this.stopHealthCheck()
    this.healthCheckTimer = setInterval(async () => {
      if (this.isShuttingDown || !this.app || this.status !== 'connected') return

      try {
        await this.app.client.auth.test()
      } catch (err) {
        log.messaging.warn('Slack health check failed, triggering reconnect', {
          connectionId: this.connectionId,
          error: String(err),
        })
        this.updateStatus('disconnected')

        // Tear down and reconnect
        try {
          await this.app?.stop()
        } catch {
          // ignore stop errors
        }
        this.app = null
        this.scheduleReconnect()
      }
    }, SlackChannel.HEALTH_CHECK_INTERVAL)
  }

  private stopHealthCheck(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer)
      this.healthCheckTimer = null
    }
  }

  private async handleMessage(message: Record<string, unknown>): Promise<void> {
    // Ignore bot messages (including self)
    if (message.bot_id || message.subtype === 'bot_message') return

    const content = (message.text as string | undefined) || ''
    const files = message.files as SlackFile[] | undefined

    // Need either text or files
    if (!content && (!files || files.length === 0)) return

    const userId = message.user as string
    if (!userId) return

    // Get user info for display name
    let senderName: string | undefined
    try {
      if (this.app) {
        const userInfo = await this.app.client.users.info({ user: userId })
        senderName = userInfo.user?.real_name || userInfo.user?.name
      }
    } catch {
      // Ignore errors getting user info
    }

    // Download any attached files
    let attachments: AttachmentData[] | undefined
    if (files && files.length > 0) {
      const downloaded = await this.downloadSlackFiles(files)
      if (downloaded.length > 0) {
        attachments = downloaded
      }
    }

    const incomingMessage: IncomingMessage = {
      channelType: 'slack',
      connectionId: this.connectionId,
      senderId: userId,
      senderName,
      content,
      attachments,
      timestamp: new Date(parseFloat(message.ts as string) * 1000),
      metadata: files?.length ? {
        files: files.map((f) => ({ name: f.name, type: f.mimetype, size: f.size })),
      } : undefined,
    }

    log.messaging.info('Slack message received', {
      connectionId: this.connectionId,
      from: userId,
      contentLength: content.length,
      fileCount: files?.length ?? 0,
      attachmentCount: attachments?.length ?? 0,
    })

    try {
      await this.events?.onMessage(incomingMessage)
    } catch (err) {
      log.messaging.error('Error processing Slack message', {
        connectionId: this.connectionId,
        error: String(err),
      })
    }
  }

  /**
   * Download multiple Slack files, skipping unsupported/oversized ones.
   */
  private async downloadSlackFiles(files: SlackFile[]): Promise<AttachmentData[]> {
    const results: AttachmentData[] = []

    for (const file of files) {
      try {
        const attachment = await this.downloadSlackFile(file)
        if (attachment) {
          results.push(attachment)
        }
      } catch (err) {
        log.messaging.warn('Failed to download Slack file', {
          connectionId: this.connectionId,
          fileName: file.name,
          error: String(err),
        })
      }
    }

    return results
  }

  /**
   * Download a single Slack file and return it as an AttachmentData.
   * Returns null for unsupported/oversized files.
   */
  private async downloadSlackFile(file: SlackFile): Promise<AttachmentData | null> {
    if (!file.url_private_download) {
      log.messaging.warn('Slack file has no download URL', {
        fileName: file.name,
        fileId: file.id,
      })
      return null
    }

    if (file.size > MAX_FILE_SIZE) {
      log.messaging.warn('Slack file too large, skipping', {
        fileName: file.name,
        size: file.size,
        maxSize: MAX_FILE_SIZE,
      })
      return null
    }

    if (!SUPPORTED_MIME_TYPES.has(file.mimetype)) {
      log.messaging.warn('Unsupported Slack file type, skipping', {
        fileName: file.name,
        mimeType: file.mimetype,
      })
      return null
    }

    // Download from Slack with auth.  Slack may redirect to a CDN on a
    // different origin; per the Fetch spec, Authorization headers are stripped
    // on cross-origin redirects.  We try two strategies:
    //   1. Let fetch follow redirects normally (CDN URL has embedded auth)
    //   2. If that fails, follow manually and forward the auth header
    const authHeaders = { Authorization: `Bearer ${this.botToken}` }

    let response = await fetch(file.url_private_download, {
      headers: authHeaders,
    })

    // Strategy 2: if the response isn't the expected type (e.g. HTML error
    // page because the CDN needed auth that got stripped), retry with manual
    // redirect handling and pass the auth header to the CDN too.
    const ct = response.headers.get('content-type')?.split(';')[0]?.trim()
    if (response.ok && ct && ct !== file.mimetype && ct === 'text/html') {
      log.messaging.debug('Slack file download returned HTML, retrying with manual redirect', {
        fileName: file.name,
      })
      response = await fetch(file.url_private_download, {
        headers: authHeaders,
        redirect: 'manual',
      })
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        if (location) {
          response = await fetch(location, { headers: authHeaders })
        }
      }
    }

    if (!response.ok) {
      log.messaging.warn('Failed to download Slack file', {
        fileName: file.name,
        status: response.status,
        statusText: response.statusText,
      })
      return null
    }

    // Verify content type matches what Slack reported.
    // If Slack returns text/html instead of the expected type, it's almost certainly
    // an auth error or redirect page — reject immediately to avoid sending garbage
    // to the AI model.
    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim()
    if (contentType && contentType !== file.mimetype) {
      log.messaging.warn('Slack file content-type mismatch', {
        fileName: file.name,
        expected: file.mimetype,
        actual: contentType,
      })
      if (contentType === 'text/html') {
        log.messaging.warn('Slack file download returned HTML instead of file content (likely auth error)', {
          fileName: file.name,
        })
        return null
      }
    }

    const isText = file.mimetype.startsWith('text/')
    const type: AttachmentData['type'] = file.mimetype.startsWith('image/')
      ? 'image'
      : isText
        ? 'text'
        : 'document'

    if (isText) {
      const text = await response.text()
      return {
        mediaType: file.mimetype,
        data: text,
        filename: file.name,
        type,
      }
    }

    const buffer = Buffer.from(await response.arrayBuffer())

    // Validate binary files have expected magic bytes
    if (!validateMagicBytes(file.mimetype, buffer)) {
      log.messaging.warn('Downloaded file has invalid magic bytes', {
        fileName: file.name,
        mimeType: file.mimetype,
        header: buffer.subarray(0, 16).toString('hex'),
        size: buffer.length,
      })
      return null
    }

    log.messaging.info('Downloaded Slack file', {
      fileName: file.name,
      mimeType: file.mimetype,
      size: buffer.length,
      type,
    })

    return {
      mediaType: file.mimetype,
      data: buffer.toString('base64'),
      filename: file.name,
      type,
    }
  }

  /**
   * Render and publish the App Home tab for a given Slack user. Looks up the
   * Fulcrum user via channel_identity_mappings; when there's no mapping, the
   * view becomes a "link your account" hint instead of a task list.
   *
   * Failures here are non-fatal — log and swallow; the user just sees the
   * last published view (or the default "no Home view" Slack message).
   */
  private async publishHomeView(slackUserId: string): Promise<void> {
    if (!this.app) return

    try {
      const fulcrumUserId = getUserIdForChannelIdentity('slack', slackUserId)

      const baseUrl = getSettings().server.publicDomain
        ? `https://${getSettings().server.publicDomain}`
        : null

      const blocks: KnownBlock[] = [
        {
          type: 'header',
          text: { type: 'plain_text', text: 'Fulcrum', emoji: true },
        },
        {
          type: 'context',
          elements: [
            { type: 'mrkdwn', text: '_The Vibe Engineer\'s Cockpit_' },
          ],
        },
        { type: 'divider' },
      ]

      if (!fulcrumUserId) {
        blocks.push(
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text:
                ':link: *Link your Fulcrum account*\n\n' +
                'Your Slack ID isn\'t mapped to a Fulcrum user yet, so I can\'t show your tasks here. ' +
                'Head to Fulcrum → Settings → *My Channel Identities*, add Slack, and paste your Slack ' +
                `member id \`${slackUserId}\`.`,
            },
          },
          { type: 'divider' }
        )
      } else {
        // Pull up to 10 of the user's open tasks, newest first
        const userTasks = db
          .select({
            id: tasks.id,
            title: tasks.title,
            status: tasks.status,
            updatedAt: tasks.updatedAt,
          })
          .from(tasks)
          .where(
            and(
              eq(tasks.assigneeUserId, fulcrumUserId),
              inArray(tasks.status, ['TO_DO', 'IN_PROGRESS'])
            )
          )
          .orderBy(desc(tasks.updatedAt))
          .limit(10)
          .all()

        if (userTasks.length === 0) {
          blocks.push({
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: ':white_check_mark: *Nothing on your plate.* No open tasks assigned to you.',
            },
          })
        } else {
          blocks.push({
            type: 'section',
            text: { type: 'mrkdwn', text: `*Your open tasks* (${userTasks.length})` },
          })
          for (const t of userTasks) {
            const statusEmoji = t.status === 'IN_PROGRESS' ? ':construction:' : ':inbox_tray:'
            const taskLink = baseUrl ? `<${baseUrl}/tasks?task=${t.id}|${t.title}>` : t.title
            blocks.push({
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `${statusEmoji} ${taskLink}`,
              },
            })
          }
        }
        blocks.push({ type: 'divider' })
      }

      // Always-on footer: quick commands + web link
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text:
            '*Quick commands* (in DM):\n' +
            '• `/reset` — start a fresh conversation\n' +
            '• `/help` — show available commands\n' +
            '• `/info` — session status',
        },
      })
      if (baseUrl) {
        blocks.push({
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `Open the cockpit → <${baseUrl}/tasks|${baseUrl.replace(/^https?:\/\//, '')}>`,
            },
          ],
        })
      }

      const view: View = {
        type: 'home',
        blocks,
      }

      await this.app.client.views.publish({
        user_id: slackUserId,
        view,
      })

      log.messaging.info('Slack App Home view published', {
        connectionId: this.connectionId,
        slackUserId,
        fulcrumUserId,
        blockCount: blocks.length,
      })
    } catch (err) {
      log.messaging.warn('Failed to publish Slack App Home view', {
        connectionId: this.connectionId,
        slackUserId,
        error: String(err),
      })
    }
  }

  /**
   * Handle slash command interactions.
   * Commands are routed to the message handler and acknowledged with an ephemeral response.
   */
  private async handleSlashCommand(
    command: SlashCommand,
    respond: RespondFn
  ): Promise<void> {
    log.messaging.info('Slack slash command received', {
      connectionId: this.connectionId,
      command: command.command,
      userId: command.user_id,
      userName: command.user_name,
    })

    // Convert slash command to an IncomingMessage for the standard command handler
    const incomingMessage: IncomingMessage = {
      channelType: 'slack',
      connectionId: this.connectionId,
      senderId: command.user_id,
      senderName: command.user_name,
      content: command.command, // e.g., "/reset"
      timestamp: new Date(),
      metadata: {
        isSlashCommand: true,
      },
    }

    try {
      await this.events?.onMessage(incomingMessage)

      // Ephemeral acknowledgment to the user
      await respond({ text: '✓ Command received', response_type: 'ephemeral' })
    } catch (err) {
      log.messaging.error('Error processing Slack slash command', {
        connectionId: this.connectionId,
        command: command.command,
        error: String(err),
      })
      await respond({
        text: 'Sorry, something went wrong processing your command.',
        response_type: 'ephemeral',
      })
    }
  }

  /**
   * Stream an AI response into Slack by posting on the first delta,
   * throttling chat.update calls, and doing a final Block Kit update.
   *
   * Returns { streamed: true } on success, or { streamed: false, fullText }
   * to signal the caller should fall back to normal sendMessage.
   */
  async streamResponse(
    recipientId: string,
    stream: AsyncIterable<{ type: string; data: unknown }>,
  ): Promise<{ streamed: boolean; fullText: string; filePath?: string }> {
    if (!this.app || this.status !== 'connected') {
      // Collect full text so caller can fall back
      let fullText = ''
      for await (const event of stream) {
        if (event.type === 'content:delta') {
          fullText += (event.data as { text: string }).text
        } else if (event.type === 'message:complete') {
          fullText = (event.data as { content: string }).content
        }
      }
      return { streamed: false, fullText }
    }

    // Open DM channel once
    let channelId: string
    try {
      const conversation = await this.app.client.conversations.open({ users: recipientId })
      channelId = conversation.channel?.id ?? ''
      if (!channelId) throw new Error('No channel ID returned')
    } catch (err) {
      log.messaging.error('Failed to open Slack DM for streaming', {
        connectionId: this.connectionId, to: recipientId, error: String(err),
      })
      // Drain stream
      let fullText = ''
      for await (const event of stream) {
        if (event.type === 'content:delta') {
          fullText += (event.data as { text: string }).text
        } else if (event.type === 'message:complete') {
          fullText = (event.data as { content: string }).content
        }
      }
      return { streamed: false, fullText }
    }

    let messageTs: string | undefined  // Slack message timestamp (acts as message ID)
    let accumulatedText = ''
    let lastUpdateAt = 0
    let updateFailed = false
    const UPDATE_INTERVAL_MS = 1500
    const MAX_STREAMING_LENGTH = 4000

    for await (const event of stream) {
      if (event.type === 'content:delta') {
        const delta = (event.data as { text: string }).text
        accumulatedText += delta

        // If accumulated text exceeds limit, stop updating and let caller split-send
        if (accumulatedText.length > MAX_STREAMING_LENGTH) {
          continue  // Keep draining to get message:complete
        }

        if (!messageTs && !updateFailed) {
          // Post initial message on first delta
          try {
            const result = await this.app!.client.chat.postMessage({
              channel: channelId,
              text: accumulatedText + ' :writing_hand:',
              mrkdwn: true,
            })
            messageTs = result.ts
            lastUpdateAt = Date.now()
          } catch (err) {
            log.messaging.warn('Failed to post initial streaming message', {
              connectionId: this.connectionId, error: String(err),
            })
            updateFailed = true
          }
        } else if (messageTs && !updateFailed) {
          // Throttled update
          const now = Date.now()
          if (now - lastUpdateAt >= UPDATE_INTERVAL_MS) {
            try {
              await this.app!.client.chat.update({
                channel: channelId,
                ts: messageTs,
                text: accumulatedText + ' :writing_hand:',
                mrkdwn: true,
              })
              lastUpdateAt = now
            } catch (err) {
              log.messaging.warn('Failed to update streaming message', {
                connectionId: this.connectionId, error: String(err),
              })
              updateFailed = true
            }
          }
        }
      } else if (event.type === 'error') {
        const errorMsg = (event.data as { message: string }).message
        log.messaging.error('Assistant error during streaming', { error: errorMsg })
      } else if (event.type === 'message:complete') {
        const text = (event.data as { content: string }).content
        // Don't overwrite good response with API error
        if (!text.startsWith('API Error:') && !text.startsWith('Error:')) {
          accumulatedText = text
        }
      }
    }

    // If response is too long, delete the streaming message and fall back
    if (accumulatedText.length > MAX_STREAMING_LENGTH && messageTs) {
      try {
        await this.app!.client.chat.delete({ channel: channelId, ts: messageTs })
      } catch {
        // Best effort — the message will just stay as a partial preview
      }
      return { streamed: false, fullText: accumulatedText }
    }

    if (!accumulatedText.trim()) {
      // No content — clean up partial message if any
      if (messageTs) {
        try {
          await this.app!.client.chat.update({
            channel: channelId,
            ts: messageTs,
            text: "Sorry, I ran into an issue processing that. Could you try again?",
            mrkdwn: true,
          })
        } catch { /* best effort */ }
      }
      return { streamed: true, fullText: '' }
    }

    // Final update with Block Kit formatting
    const parsed = parseSlackResponse(accumulatedText)
    let filePath: string | undefined

    if (messageTs) {
      try {
        if (parsed) {
          filePath = parsed.filePath
          await this.app!.client.chat.update({
            channel: channelId,
            ts: messageTs,
            text: parsed.body,
            ...(parsed.blocks && { blocks: parsed.blocks as KnownBlock[] }),
          })
        } else {
          // No XML tags — wrap in a section block
          await this.app!.client.chat.update({
            channel: channelId,
            ts: messageTs,
            text: accumulatedText,
            blocks: [{ type: 'section', text: { type: 'mrkdwn', text: accumulatedText } }],
          })
        }
      } catch (err) {
        log.messaging.warn('Failed final streaming update', {
          connectionId: this.connectionId, error: String(err),
        })
        // Message stays as last partial update — acceptable degradation
      }
    } else if (!updateFailed) {
      // Stream completed before we posted anything (very fast response)
      // Fall back to normal send
      return { streamed: false, fullText: accumulatedText, filePath: parsed?.filePath }
    }

    // Upload file if specified
    if (filePath && messageTs) {
      try {
        const fileData = readFileSync(filePath)
        const filename = basename(filePath)
        await this.app!.client.files.uploadV2({
          channel_id: channelId,
          file: fileData,
          filename,
        })
      } catch (err) {
        log.messaging.warn('Failed to upload file after streaming', {
          connectionId: this.connectionId, filePath, error: String(err),
        })
      }
    }

    log.messaging.info('Slack streaming response complete', {
      connectionId: this.connectionId,
      to: recipientId,
      length: accumulatedText.length,
      hadBlocks: !!parsed?.blocks,
    })

    return { streamed: true, fullText: accumulatedText, filePath }
  }

  async shutdown(): Promise<void> {
    this.isShuttingDown = true
    this.stopHealthCheck()

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    if (this.app) {
      await this.app.stop()
      this.app = null
    }

    this.updateStatus('disconnected')
    log.messaging.info('Slack channel shutdown', {
      connectionId: this.connectionId,
    })
  }

  async sendMessage(
    recipientId: string,
    content: string,
    metadata?: Record<string, unknown>
  ): Promise<boolean> {
    if (!this.app || this.status !== 'connected') {
      log.messaging.warn('Cannot send Slack message - not connected', {
        connectionId: this.connectionId,
        status: this.status,
      })
      return false
    }

    try {
      // Open or get existing DM channel with user
      const conversation = await this.app.client.conversations.open({
        users: recipientId,
      })

      const channelId = conversation.channel?.id
      if (!channelId) {
        throw new Error('Failed to open DM channel')
      }

      // Upload file if provided
      if (metadata?.filePath) {
        const filePath = metadata.filePath as string
        try {
          const fileData = readFileSync(filePath)
          const filename = basename(filePath)
          await this.app.client.files.uploadV2({
            channel_id: channelId,
            file: fileData,
            filename,
            initial_comment: content || undefined,
          })
          log.messaging.info('Slack file uploaded', {
            connectionId: this.connectionId,
            to: recipientId,
            filename,
          })
          return true
        } catch (fileErr) {
          log.messaging.error('Failed to upload Slack file', {
            connectionId: this.connectionId,
            filePath,
            error: String(fileErr),
          })
          // Fall through to send text-only message
        }
      }

      // Slack has a ~40000 character limit but best practice is to keep it shorter
      // We'll use 4000 as a practical limit
      if (content.length <= 4000) {
        const messageOptions: ChatPostMessageArguments = {
          channel: channelId,
          text: content, // Fallback for notifications
        }

        // Use blocks if provided, otherwise use mrkdwn text
        if (metadata?.blocks) {
          messageOptions.blocks = metadata.blocks as KnownBlock[]
        } else {
          messageOptions.mrkdwn = true
        }

        await this.app.client.chat.postMessage(messageOptions)
      } else {
        // Split message if too long (blocks not supported for split messages)
        const parts = this.splitMessage(content, 4000)
        for (const part of parts) {
          await this.app.client.chat.postMessage({
            channel: channelId,
            text: part,
            mrkdwn: true,
          })
          // Small delay between messages
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
      }

      log.messaging.info('Slack message sent', {
        connectionId: this.connectionId,
        to: recipientId,
        contentLength: content.length,
        hasBlocks: !!metadata?.blocks,
      })

      return true
    } catch (err) {
      log.messaging.error('Failed to send Slack message', {
        connectionId: this.connectionId,
        to: recipientId,
        error: String(err),
      })
      return false
    }
  }

  private splitMessage(content: string, maxLength: number): string[] {
    const parts: string[] = []
    let remaining = content

    while (remaining.length > 0) {
      if (remaining.length <= maxLength) {
        parts.push(remaining)
        break
      }

      // Try to find a good break point
      let breakPoint = remaining.lastIndexOf('\n\n', maxLength)
      if (breakPoint === -1 || breakPoint < maxLength / 2) {
        breakPoint = remaining.lastIndexOf('\n', maxLength)
      }
      if (breakPoint === -1 || breakPoint < maxLength / 2) {
        breakPoint = remaining.lastIndexOf(' ', maxLength)
      }
      if (breakPoint === -1 || breakPoint < maxLength / 2) {
        breakPoint = maxLength
      }

      parts.push(remaining.slice(0, breakPoint))
      remaining = remaining.slice(breakPoint).trimStart()
    }

    return parts
  }

  getStatus(): ConnectionStatus {
    return this.status
  }

  // Slack uses token-based auth, no QR code needed
  // Auth is handled via setTokens method before initialize

  async logout(): Promise<void> {
    this.stopHealthCheck()

    if (this.app) {
      await this.app.stop()
      this.app = null
    }

    this.botToken = null
    this.appToken = null

    // Clear runtime state in database (credentials are in settings.json)
    db.update(messagingConnections)
      .set({
        displayName: null,
        status: 'disconnected',
        updatedAt: new Date().toISOString(),
      })
      .where(eq(messagingConnections.id, this.connectionId))
      .run()

    this.updateStatus('disconnected')
  }

  private updateStatus(status: ConnectionStatus): void {
    this.status = status

    // Update database
    db.update(messagingConnections)
      .set({
        status,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(messagingConnections.id, this.connectionId))
      .run()

    // Notify listeners
    this.events?.onConnectionChange(status)
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.isShuttingDown) return

    log.messaging.debug('Scheduling Slack reconnect', {
      connectionId: this.connectionId,
      delayMs: 5000,
    })

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, 5000)
  }
}
