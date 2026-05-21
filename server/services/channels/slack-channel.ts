/**
 * Slack channel implementation using @slack/bolt library.
 * Uses Socket Mode for real-time messaging without needing a public URL.
 */

import { App, LogLevel, type SlashCommand, type RespondFn } from '@slack/bolt'
import type { KnownBlock, ChatPostMessageArguments, View } from '@slack/web-api'
import { eq, and, inArray, desc } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { readFileSync } from 'fs'
import { basename } from 'path'
import { db, messagingConnections, slackReactions, tasks } from '../../db'
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
import { sessionExists } from './session-mapper'

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
  private botUserId: string | null = null  // U… id used to strip self-mentions from channel @-mentions

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

      // Handle DM messages AND thread followups in channels we've been @-mentioned in.
      // Direct mentions in channels still flow through the dedicated app_mention event;
      // this branch keeps a conversation alive when the user replies in the same thread
      // *without* re-pinging the bot (which would otherwise drop on the floor pre D-15 PR 5).
      this.app.message(async ({ message }) => {
        const m = message as Record<string, unknown>
        const channelType = m.channel_type as string | undefined
        if (channelType === 'im') {
          await this.handleMessage(m)
          return
        }
        // Non-DM message: only handle if it's a follow-up in a thread the bot is
        // already part of (i.e. we have an active session keyed on that thread).
        const threadTs = m.thread_ts as string | undefined
        const channelId = m.channel as string | undefined
        if (!threadTs || !channelId) return
        // Ignore the bot's own messages (they also arrive as message events)
        if (m.bot_id || m.subtype === 'bot_message') return
        const sessionKey = `${channelId}:${threadTs}`
        if (sessionExists(this.connectionId, sessionKey)) {
          await this.handleMessage(m)
        }
      })

      // Handle @-mentions of the bot in public/private channels.
      // Replies are posted as threaded responses on the same channel,
      // not as DMs, so the conversation stays where the team can see it.
      this.app.event('app_mention', async ({ event }) => {
        await this.handleAppMention(event as unknown as Record<string, unknown>)
      })

      // D-15 PR 6: capture reactions on the bot's messages as a quality signal.
      // We filter to only persist reactions where the reacted-to item author
      // is this bot — everything else is unrelated team chatter.
      this.app.event('reaction_added', async ({ event }) => {
        await this.handleReactionEvent('added', event as unknown as Record<string, unknown>)
      })
      this.app.event('reaction_removed', async ({ event }) => {
        await this.handleReactionEvent('removed', event as unknown as Record<string, unknown>)
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
      this.botUserId = (authTest.user_id as string | undefined) ?? null

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

    // For thread followups in a channel (D-15 PR 5), thread the channel/thread
    // through metadata so the response posts back to the same thread and
    // session-mapper keys to the thread for continuity.
    const channelId = message.channel as string | undefined
    const threadTs = message.thread_ts as string | undefined
    const channelType = message.channel_type as string | undefined
    const isChannelThread = channelType !== 'im' && !!channelId && !!threadTs

    const metadata: Record<string, unknown> = {}
    if (files?.length) {
      metadata.files = files.map((f) => ({ name: f.name, type: f.mimetype, size: f.size }))
    }
    if (isChannelThread) {
      metadata.isChannelMention = true
      metadata.slackChannelId = channelId
      metadata.slackThreadTs = threadTs
    }

    const incomingMessage: IncomingMessage = {
      channelType: 'slack',
      connectionId: this.connectionId,
      senderId: userId,
      senderName,
      content,
      attachments,
      timestamp: new Date(parseFloat(message.ts as string) * 1000),
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    }

    log.messaging.info('Slack message received', {
      connectionId: this.connectionId,
      from: userId,
      contentLength: content.length,
      fileCount: files?.length ?? 0,
      attachmentCount: attachments?.length ?? 0,
      isChannelThread,
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
   * Handle an @-mention of the bot in a channel.
   * The reply is posted as a threaded message on the same channel so the
   * conversation stays in context for the team; per-thread session keying
   * means a single thread is one continuous conversation with the assistant,
   * even across multiple mentions.
   */
  private async handleAppMention(event: Record<string, unknown>): Promise<void> {
    // Slack delivers app_mention for our own messages too if the bot
    // self-references — drop those.
    if (event.bot_id || event.subtype === 'bot_message') return

    const userId = event.user as string | undefined
    if (!userId) return

    const rawText = (event.text as string | undefined) ?? ''
    const channelId = event.channel as string | undefined
    if (!channelId) return

    // Slack guarantees thread_ts is the parent if we're in an existing thread;
    // for a fresh top-level @-mention, use the event's own ts as the thread root
    // so the assistant's reply starts a new thread under the user's message.
    const threadTs = (event.thread_ts as string | undefined) ?? (event.ts as string)

    // Strip the bot's own self-mention from the start of the text so the
    // assistant doesn't see "<@U123> what's up" — just "what's up".
    let content = rawText
    if (this.botUserId) {
      const selfMention = new RegExp(`<@${this.botUserId}>\\s*`, 'g')
      content = content.replace(selfMention, '').trim()
    }

    // Resolve sender display name (best effort)
    let senderName: string | undefined
    try {
      if (this.app) {
        const userInfo = await this.app.client.users.info({ user: userId })
        senderName = userInfo.user?.real_name || userInfo.user?.name
      }
    } catch {
      // Non-fatal
    }

    log.messaging.info('Slack app_mention received', {
      connectionId: this.connectionId,
      from: userId,
      channelId,
      threadTs,
      contentLength: content.length,
    })

    const incomingMessage: IncomingMessage = {
      channelType: 'slack',
      connectionId: this.connectionId,
      senderId: userId,
      senderName,
      content,
      timestamp: new Date(parseFloat(event.ts as string) * 1000),
      metadata: {
        isChannelMention: true,
        slackChannelId: channelId,
        slackThreadTs: threadTs,
      },
    }

    try {
      await this.events?.onMessage(incomingMessage)
    } catch (err) {
      log.messaging.error('Error processing Slack app_mention', {
        connectionId: this.connectionId,
        error: String(err),
      })
    }
  }

  /**
   * Capture a reaction_added / reaction_removed event. Only persisted when
   * the reacted-to item is one of the bot's own messages — quality signal
   * on assistant responses, not a general reaction archive.
   */
  private async handleReactionEvent(
    action: 'added' | 'removed',
    event: Record<string, unknown>
  ): Promise<void> {
    const reactor = event.user as string | undefined
    const reaction = event.reaction as string | undefined
    const itemUser = event.item_user as string | undefined
    const item = event.item as { type?: string; channel?: string; ts?: string } | undefined

    if (!reactor || !reaction || !item || item.type !== 'message' || !item.channel || !item.ts) {
      return
    }

    // Only persist reactions on the bot's own messages
    if (!this.botUserId || itemUser !== this.botUserId) {
      return
    }

    try {
      db.insert(slackReactions).values({
        id: nanoid(),
        connectionId: this.connectionId,
        action,
        reactorSlackUserId: reactor,
        reaction,
        itemTs: item.ts,
        itemChannel: item.channel,
        itemUser: itemUser ?? null,
        createdAt: new Date().toISOString(),
      }).run()

      log.messaging.info('Slack reaction captured', {
        connectionId: this.connectionId,
        action,
        reaction,
        reactor,
        itemTs: item.ts,
      })
    } catch (err) {
      log.messaging.warn('Failed to persist Slack reaction', {
        connectionId: this.connectionId,
        action,
        reaction,
        error: String(err),
      })
    }
  }

  /**
   * Handle slash command interactions.
   * The trigger command (e.g. "/fulcrum") and its text argument are forwarded as
   * the message content; the response is posted back via response_url so the
   * answer lands in the channel where the user typed the command (not as a DM).
   */
  private async handleSlashCommand(
    command: SlashCommand,
    respond: RespondFn
  ): Promise<void> {
    const text = (command.text || '').trim()

    log.messaging.info('Slack slash command received', {
      connectionId: this.connectionId,
      command: command.command,
      hasText: text.length > 0,
      userId: command.user_id,
      userName: command.user_name,
      channelId: command.channel_id,
    })

    // Bare invocation with no argument: show a quick usage tip and return.
    if (!text && command.command === '/fulcrum') {
      await respond({
        text: 'Tip: `/fulcrum <message>` to chat with me, or DM me directly. Try `/fulcrum what can you do?`',
        response_type: 'ephemeral',
      })
      return
    }

    // The slash command itself acts as a meta-command (e.g. /reset registered
    // separately at the workspace level): forward the bare command string so
    // the shared command router can match RESET/HELP/STATUS. Otherwise forward
    // the user's free-text argument as the message content.
    const isMetaCommand = !text && command.command !== '/fulcrum'
    const content = isMetaCommand ? command.command : text

    const incomingMessage: IncomingMessage = {
      channelType: 'slack',
      connectionId: this.connectionId,
      senderId: command.user_id,
      senderName: command.user_name,
      content,
      timestamp: new Date(),
      metadata: {
        isSlashCommand: true,
        slashCommandName: command.command,
        slackChannelId: command.channel_id,
        slackResponseUrl: command.response_url,
      },
    }

    try {
      // Quick ephemeral ack while the assistant works
      await respond({ text: 'Thinking…', response_type: 'ephemeral' })
      await this.events?.onMessage(incomingMessage)
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
   * Post a message to a Slack channel. When `threadTs` is provided, the
   * message lands inside that thread (used to reply to @-mentions); when
   * undefined, the message posts at the channel's top level (used for
   * per-event notification routing).
   */
  private async postToChannelThread(
    channelId: string,
    threadTs: string | undefined,
    content: string,
    blocks?: KnownBlock[],
    filePath?: string
  ): Promise<boolean> {
    if (!this.app) return false

    try {
      // Upload file first if provided (initial_comment carries the text)
      if (filePath) {
        try {
          const fileData = readFileSync(filePath)
          const filename = basename(filePath)
          await this.app.client.files.uploadV2({
            channel_id: channelId,
            file: fileData,
            filename,
            ...(threadTs && { thread_ts: threadTs }),
            initial_comment: content || undefined,
          })
          return true
        } catch (fileErr) {
          log.messaging.error('Failed to upload Slack file to channel', {
            connectionId: this.connectionId,
            channelId,
            threadTs,
            filePath,
            error: String(fileErr),
          })
          // Fall through to text-only
        }
      }

      // Split overly long content the same way the DM path does
      const parts = content.length <= 4000 ? [content] : this.splitMessage(content, 4000)
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]
        const options: ChatPostMessageArguments = {
          channel: channelId,
          text: part,
        }
        if (threadTs) options.thread_ts = threadTs
        if (i === 0 && blocks) {
          options.blocks = blocks
        } else {
          options.mrkdwn = true
        }
        await this.app.client.chat.postMessage(options)
        if (parts.length > 1) {
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
      }

      log.messaging.info('Slack channel message sent', {
        connectionId: this.connectionId,
        channelId,
        threadTs,
        contentLength: content.length,
        hasBlocks: !!blocks,
      })
      return true
    } catch (err) {
      log.messaging.error('Failed to post Slack channel message', {
        connectionId: this.connectionId,
        channelId,
        threadTs,
        error: String(err),
      })
      return false
    }
  }

  /**
   * Post a message back to a Slack channel via the slash command's response_url.
   * Works without the bot being a member of the channel and without
   * chat:write.public scope, but is capped at 5 responses per 30 minutes.
   * Ephemeral posts are visible only to the user who triggered the command.
   */
  private async postViaResponseUrl(
    responseUrl: string,
    content: string,
    blocks?: KnownBlock[],
    ephemeral = false
  ): Promise<boolean> {
    const payload: Record<string, unknown> = {
      response_type: ephemeral ? 'ephemeral' : 'in_channel',
      text: content,
    }
    if (blocks) payload.blocks = blocks

    try {
      const res = await fetch(responseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        log.messaging.warn('Slack response_url POST returned non-ok', {
          connectionId: this.connectionId,
          status: res.status,
          statusText: res.statusText,
        })
      }
      return res.ok
    } catch (err) {
      log.messaging.error('Failed to POST to Slack response_url', {
        connectionId: this.connectionId,
        error: String(err),
      })
      return false
    }
  }

  /**
   * Stream an AI response into Slack by posting on the first delta,
   * throttling chat.update calls, and doing a final Block Kit update.
   *
   * `target` controls where the stream lands:
   *  - `{ type: 'dm', userId }` opens a DM with the user (legacy DM path)
   *  - `{ type: 'channel', channelId, threadTs }` posts directly to a
   *    channel/thread without opening a DM (D-15 PR 7 — used for @-mention
   *    replies and thread followups so streaming works in-channel)
   *
   * Returns { streamed: true } on success, or { streamed: false, fullText }
   * to signal the caller should fall back to normal sendMessage.
   */
  async streamResponse(
    target: { type: 'dm'; userId: string } | { type: 'channel'; channelId: string; threadTs?: string },
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

    // Resolve destination channel
    let channelId: string
    let threadTs: string | undefined
    if (target.type === 'channel') {
      channelId = target.channelId
      threadTs = target.threadTs
    } else {
      try {
        const conversation = await this.app.client.conversations.open({ users: target.userId })
        channelId = conversation.channel?.id ?? ''
        if (!channelId) throw new Error('No channel ID returned')
      } catch (err) {
        log.messaging.error('Failed to open Slack DM for streaming', {
          connectionId: this.connectionId, to: target.userId, error: String(err),
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
              ...(threadTs && { thread_ts: threadTs }),
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
          // Throttled update (chat.update doesn't take thread_ts — the message
          // identity is fixed by channel+ts which was set at post time)
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

    // Upload file if specified (lands in the same thread if streaming was threaded)
    if (filePath && messageTs) {
      try {
        const fileData = readFileSync(filePath)
        const filename = basename(filePath)
        await this.app!.client.files.uploadV2({
          channel_id: channelId,
          file: fileData,
          filename,
          ...(threadTs && { thread_ts: threadTs }),
        })
      } catch (err) {
        log.messaging.warn('Failed to upload file after streaming', {
          connectionId: this.connectionId, filePath, error: String(err),
        })
      }
    }

    log.messaging.info('Slack streaming response complete', {
      connectionId: this.connectionId,
      target: target.type,
      channelId,
      threadTs,
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

    // Slash command path: post back to the channel where the command was
    // invoked via the response_url. No DM is created; the user sees the
    // answer in-channel along with their original `/fulcrum …` line.
    // Meta-commands (/reset, /help, /info) post ephemerally to avoid noise.
    const responseUrl = metadata?.slackResponseUrl as string | undefined
    if (responseUrl) {
      return await this.postViaResponseUrl(
        responseUrl,
        content,
        metadata?.blocks as KnownBlock[] | undefined,
        metadata?.slackEphemeral === true
      )
    }

    // Channel post path: reply to @-mentions (with thread_ts) and per-event
    // notifications (no thread, top-level channel post). The presence of
    // slackChannelId alone is enough to trigger this path; slackThreadTs is
    // optional and only used to land replies inside an existing thread.
    const targetChannelId = metadata?.slackChannelId as string | undefined
    const targetThreadTs = metadata?.slackThreadTs as string | undefined
    if (targetChannelId) {
      return await this.postToChannelThread(
        targetChannelId,
        targetThreadTs,
        content,
        metadata?.blocks as KnownBlock[] | undefined,
        metadata?.filePath as string | undefined
      )
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
