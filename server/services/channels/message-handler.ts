/**
 * Message Handler - Routes incoming messages from channels to the AI assistant.
 * Handles special commands (/reset, /help, /status) and response splitting.
 */

import { log } from '../../lib/logger'
import { activeChannels, setMessageHandler } from './channel-manager'
import { getOrCreateSession, resetSession } from './session-mapper'
import { getMessagingSystemPrompt, getObserveOnlySystemPrompt, type MessagingContext } from './system-prompts'
import * as assistantService from '../assistant-service'
import { getRecentOutgoingMessages, getRecentChannelMessages } from './message-storage'
import { streamOpencodeObserverMessage } from '../opencode-channel-service'
import { getSettings } from '../../lib/settings/core'
import {
  createInvocation,
  completeInvocation,
  failInvocation,
  timeoutInvocation,
  skipInvocation,
} from '../observer-tracking'
import type { ObserverActionRecord } from '../../db/schema'
import { db, tasks } from '../../db'
import { desc } from 'drizzle-orm'
import type { IncomingMessage } from './types'
import { parseSlackResponse } from './slack-utils'
import type { SlackChannel } from './slack-channel'

// Internal deps - exposed for test replacement (avoids unreliable mock.module)
export const _deps = {
  streamMessage: (...args: Parameters<typeof assistantService.streamMessage>) =>
    assistantService.streamMessage(...args),
  streamOpencodeObserverMessage: (...args: Parameters<typeof streamOpencodeObserverMessage>) =>
    streamOpencodeObserverMessage(...args),
}

// Circuit breaker for observer processing — prevents log flooding and wasted
// Claude Code spawns when the session is corrupted. Opens after consecutive
// failures, closes after a successful probe.
const OBSERVER_CIRCUIT_BREAKER = {
  failureCount: 0,
  failureThreshold: 3,
  state: 'closed' as 'closed' | 'open',
  nextProbeAt: 0,
  cooldownMs: 60_000, // starts at 1 min, doubles up to 10 min
  maxCooldownMs: 600_000,
}

// Exported for testing
export function getCircuitBreaker() {
  return OBSERVER_CIRCUIT_BREAKER
}

export function resetCircuitBreaker() {
  OBSERVER_CIRCUIT_BREAKER.failureCount = 0
  OBSERVER_CIRCUIT_BREAKER.state = 'closed'
  OBSERVER_CIRCUIT_BREAKER.nextProbeAt = 0
  OBSERVER_CIRCUIT_BREAKER.cooldownMs = 60_000
}

function recordObserverFailure() {
  OBSERVER_CIRCUIT_BREAKER.failureCount++
  if (OBSERVER_CIRCUIT_BREAKER.failureCount >= OBSERVER_CIRCUIT_BREAKER.failureThreshold) {
    if (OBSERVER_CIRCUIT_BREAKER.state !== 'open') {
      log.messaging.warn('Observer circuit breaker OPEN — pausing observe-only processing', {
        failures: OBSERVER_CIRCUIT_BREAKER.failureCount,
        cooldownMs: OBSERVER_CIRCUIT_BREAKER.cooldownMs,
      })
    }
    OBSERVER_CIRCUIT_BREAKER.state = 'open'
    OBSERVER_CIRCUIT_BREAKER.nextProbeAt = Date.now() + OBSERVER_CIRCUIT_BREAKER.cooldownMs
    // Exponential backoff, capped at max
    OBSERVER_CIRCUIT_BREAKER.cooldownMs = Math.min(
      OBSERVER_CIRCUIT_BREAKER.cooldownMs * 2,
      OBSERVER_CIRCUIT_BREAKER.maxCooldownMs,
    )
  }
}

function recordObserverSuccess() {
  if (OBSERVER_CIRCUIT_BREAKER.state === 'open') {
    log.messaging.info('Observer circuit breaker CLOSED — resuming normal processing', {
      previousFailures: OBSERVER_CIRCUIT_BREAKER.failureCount,
    })
  }
  OBSERVER_CIRCUIT_BREAKER.failureCount = 0
  OBSERVER_CIRCUIT_BREAKER.state = 'closed'
  OBSERVER_CIRCUIT_BREAKER.nextProbeAt = 0
  OBSERVER_CIRCUIT_BREAKER.cooldownMs = 60_000
}

function isObserverCircuitOpen(): boolean {
  if (OBSERVER_CIRCUIT_BREAKER.state !== 'open') return false
  // Allow a probe if cooldown has elapsed
  if (Date.now() >= OBSERVER_CIRCUIT_BREAKER.nextProbeAt) return false
  return true
}

// Special commands that don't go to the AI
const COMMANDS = {
  RESET: ['/reset', '/new', '/clear'],
  HELP: ['/help', '/?'],
  STATUS: ['/status', '/info'], // /info for Slack (where /status is reserved)
}

/**
 * Handle incoming message from any channel.
 * Routes to AI assistant and sends response back.
 */
export async function handleIncomingMessage(msg: IncomingMessage): Promise<void> {
  const content = msg.content.trim()
  const isObserveOnly = msg.metadata?.observeOnly === true

  // For observe-only messages (e.g., WhatsApp messages not in self-chat),
  // skip commands and just let the assistant observe for important information
  if (isObserveOnly) {
    log.messaging.info('Processing observe-only message', {
      connectionId: msg.connectionId,
      channelType: msg.channelType,
      senderId: msg.senderId,
    })
    await processObserveOnlyMessage(msg)
    return
  }

  // Check for special commands
  if (COMMANDS.RESET.some((cmd) => content.toLowerCase() === cmd)) {
    // For email, reset doesn't make sense - each thread is its own session
    if (msg.channelType === 'email') {
      await sendResponse(msg, 'To start a new conversation, simply send a new email (not a reply). Each email thread has its own conversation history.')
      return
    }
    await handleResetCommand(msg)
    return
  }

  if (COMMANDS.HELP.some((cmd) => content.toLowerCase() === cmd)) {
    await handleHelpCommand(msg)
    return
  }

  if (COMMANDS.STATUS.some((cmd) => content.toLowerCase() === cmd)) {
    await handleStatusCommand(msg)
    return
  }

  // Route to AI assistant
  // For email, use threadId as session key (each email thread = separate conversation)
  // For other channels, use senderId (each user = separate conversation)
  const emailThreadId = msg.channelType === 'email' ? (msg.metadata?.threadId as string) : undefined
  const { session } = getOrCreateSession(
    msg.connectionId,
    msg.senderId,
    msg.senderName,
    emailThreadId,
    msg.channelType
  )

  log.messaging.info('Routing message to assistant', {
    connectionId: msg.connectionId,
    senderId: msg.senderId,
    sessionId: session.id,
    channelType: msg.channelType,
  })

  try {
    // Build context for intelligent message handling
    // The assistant decides whether to respond, create events, or ignore
    const context: MessagingContext = {
      channel: msg.channelType,
      sender: msg.senderId,
      senderName: msg.senderName,
      content,
      hasAttachments: (msg.attachments?.length ?? 0) > 0,
      attachmentNames: msg.attachments?.map((a) => a.filename),
      metadata: {
        subject: msg.metadata?.subject as string | undefined,
        threadId: msg.metadata?.threadId as string | undefined,
        messageId: msg.metadata?.messageId as string | undefined,
      },
    }
    const systemPrompt = getMessagingSystemPrompt(msg.channelType, context)

    // Fetch recent outgoing messages (notifications, rituals, MCP sends) that
    // the SDK session hasn't seen yet, so the AI has context for user replies.
    const lastSyncAt = assistantService.getLastChannelSyncAt(session.id)
    const channelHistory = getRecentOutgoingMessages(msg.connectionId, { since: lastSyncAt })

    const isSlack = msg.channelType === 'slack'
    const stream = _deps.streamMessage(session.id, content || '(file attached)', {
      systemPromptAdditions: systemPrompt,
      ...(msg.attachments?.length && { attachments: msg.attachments }),
      ...(channelHistory.length > 0 && { channelHistory }),
    })

    // For Slack DMs: try streaming the response incrementally via chat.postMessage + chat.update.
    // Slash-command responses are posted via response_url (which can't be updated reliably),
    // so we skip streaming for those and use the collect-then-send path.
    const isSlashCommand = msg.metadata?.isSlashCommand === true
    if (isSlack && !isSlashCommand) {
      const slackChannel = activeChannels.get(msg.connectionId) as SlackChannel | undefined
      if (slackChannel && typeof slackChannel.streamResponse === 'function') {
        const result = await slackChannel.streamResponse(msg.senderId, stream)

        // Mark channel history as synced
        if (channelHistory.length > 0) {
          assistantService.updateLastChannelSyncAt(session.id)
        }

        if (result.streamed) {
          // Streaming handled everything (including Block Kit final update)
          return
        }

        // Streaming fell back — send the full text via normal sendMessage
        const responseText = result.fullText
        if (responseText.trim()) {
          const parsed = parseSlackResponse(responseText)
          if (parsed) {
            const meta: Record<string, unknown> = {}
            if (parsed.blocks) meta.blocks = parsed.blocks
            if (parsed.filePath) meta.filePath = parsed.filePath
            await sendResponse(
              msg,
              parsed.body,
              Object.keys(meta).length > 0 ? meta : undefined
            )
          } else {
            await sendResponse(msg, responseText, {
              blocks: [{ type: 'section', text: { type: 'mrkdwn', text: responseText } }],
            })
          }
        }
        return
      }
      // If we can't get the SlackChannel instance, fall through to non-streaming path
    }

    // Non-Slack channels (or Slack fallback): collect full response then send
    let responseText = ''
    let hasError = false

    for await (const event of stream) {
      if (event.type === 'error') {
        const errorMsg = (event.data as { message: string }).message
        log.messaging.error('Assistant error handling message', { error: errorMsg })
        hasError = true
      } else if (event.type === 'message:complete') {
        const text = (event.data as { content: string }).content
        // Don't overwrite a good response with an API error message from a subsequent turn
        if (!text.startsWith('API Error:') && !text.startsWith('Error:')) {
          responseText = text
        } else {
          log.messaging.warn('Suppressed API error from assistant response', {
            errorPreview: text.slice(0, 200),
          })
          hasError = true
        }
      }
    }

    // If we got only errors and no valid response, send a friendly error message
    if (hasError && !responseText.trim()) {
      responseText = "Sorry, I ran into an issue processing that. Could you try again or rephrase your message?"
    }

    // Mark channel history as synced so we don't re-inject on next message
    if (channelHistory.length > 0) {
      assistantService.updateLastChannelSyncAt(session.id)
    }

    // Send the response
    if (isSlack && responseText.trim()) {
      // Slack fallback (no streaming available) — still apply Block Kit formatting
      const parsed = parseSlackResponse(responseText)
      if (parsed) {
        const meta: Record<string, unknown> = {}
        if (parsed.blocks) meta.blocks = parsed.blocks
        if (parsed.filePath) meta.filePath = parsed.filePath
        await sendResponse(
          msg,
          parsed.body,
          Object.keys(meta).length > 0 ? meta : undefined
        )
      } else {
        await sendResponse(msg, responseText, {
          blocks: [{ type: 'section', text: { type: 'mrkdwn', text: responseText } }],
        })
      }
    } else if (responseText.trim()) {
      await sendResponse(msg, responseText)
    }
  } catch (err) {
    log.messaging.error('Error processing message through assistant', {
      connectionId: msg.connectionId,
      sessionId: session.id,
      error: String(err),
    })
  }
}

/**
 * Handle /reset command - start fresh conversation.
 */
async function handleResetCommand(msg: IncomingMessage): Promise<void> {
  resetSession(msg.connectionId, msg.senderId, msg.senderName, undefined, msg.channelType)

  // Use Block Kit for Slack
  if (msg.channelType === 'slack') {
    const blocks = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '✓ *Conversation reset!* I\'ve started a fresh session. How can I help you?',
        },
      },
    ]
    await sendResponse(msg, 'Conversation reset!', { blocks, slackEphemeral: true })
    return
  }

  await sendResponse(
    msg,
    "Conversation reset! I've started a fresh session. How can I help you?"
  )
}

/**
 * Handle /help command.
 */
async function handleHelpCommand(msg: IncomingMessage): Promise<void> {
  const isEmail = msg.channelType === 'email'

  // Use Block Kit for Slack
  if (msg.channelType === 'slack') {
    const blocks = [
      {
        type: 'header',
        text: { type: 'plain_text', text: 'AI Assistant Help', emoji: true },
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: '*Available Commands:*' },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text:
            '• `/reset` - Start a fresh conversation\n' +
            '• `/help` - Show this help message\n' +
            '• `/info` - Show your session status',
        },
      },
      { type: 'divider' },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: 'Just message me to chat! I\'m powered by Claude.',
          },
        ],
      },
    ]
    await sendResponse(msg, 'AI Assistant Help', { blocks, slackEphemeral: true })
    return
  }

  const helpText = isEmail
    ? `*Fulcrum AI Assistant*

I'm Claude, ready to help you with questions and tasks.

*Available commands:*
/help - Show this help message
/status - Show session info

*Email threading:*
Each email thread has its own conversation history. To start a fresh conversation, send a new email (not a reply).

Just send any message and I'll do my best to help!`
    : `*Fulcrum AI Assistant*

I'm Claude, ready to help you with questions and tasks.

*Available commands:*
/reset - Start a fresh conversation
/help - Show this help message
/status - Show session info

Just send any message and I'll do my best to help!`

  await sendResponse(msg, helpText)
}

/**
 * Handle /status command.
 */
async function handleStatusCommand(msg: IncomingMessage): Promise<void> {
  const emailThreadId = msg.channelType === 'email' ? (msg.metadata?.threadId as string) : undefined
  const { session, mapping } = getOrCreateSession(
    msg.connectionId,
    msg.senderId,
    msg.senderName,
    emailThreadId,
    msg.channelType
  )

  // Use Block Kit for Slack
  if (msg.channelType === 'slack') {
    const blocks = [
      {
        type: 'header',
        text: { type: 'plain_text', text: 'Session Status', emoji: true },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Session ID:*\n\`${session.id.slice(0, 8)}...\`` },
          { type: 'mrkdwn', text: `*Messages:*\n${session.messageCount ?? 0}` },
          { type: 'mrkdwn', text: `*Started:*\n${new Date(mapping.createdAt).toLocaleString()}` },
          { type: 'mrkdwn', text: `*Last Active:*\n${new Date(mapping.lastMessageAt).toLocaleString()}` },
        ],
      },
      { type: 'divider' },
      {
        type: 'context',
        elements: [
          { type: 'mrkdwn', text: 'Use `/reset` to start a fresh conversation.' },
        ],
      },
    ]
    await sendResponse(msg, 'Session Status', { blocks, slackEphemeral: true })
    return
  }

  const statusText = `*Session Status*

Session ID: ${session.id.slice(0, 8)}...
Messages: ${session.messageCount ?? 0}
Started: ${new Date(mapping.createdAt).toLocaleString()}
Last active: ${new Date(mapping.lastMessageAt).toLocaleString()}`

  await sendResponse(msg, statusText)
}

// Re-export for backward compatibility (tests import from here)
export { parseSlackResponse }

/**
 * Send a response back through the appropriate channel.
 */
async function sendResponse(
  originalMsg: IncomingMessage,
  content: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  // Email sending is disabled — use Gmail drafts instead
  if (originalMsg.channelType === 'email') {
    log.messaging.info('Skipping email response — sending disabled, use Gmail drafts', {
      connectionId: originalMsg.connectionId,
      senderId: originalMsg.senderId,
    })
    return
  }

  const channel = activeChannels.get(originalMsg.connectionId)
  if (!channel) {
    log.messaging.warn('No active channel to send response', {
      connectionId: originalMsg.connectionId,
    })
    return
  }

  // WhatsApp has a message size limit, split if needed
  const maxLength = 4000
  const parts = splitMessage(content, maxLength)

  // Merge provided metadata with original message metadata
  const combinedMetadata = { ...originalMsg.metadata, ...metadata }

  for (const part of parts) {
    // Pass metadata for email threading and Slack blocks
    await channel.sendMessage(originalMsg.senderId, part, combinedMetadata)
    // Small delay between parts to maintain order
    if (parts.length > 1) {
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
}

/**
 * Split a message into parts that fit within a size limit.
 */
function splitMessage(content: string, maxLength: number): string[] {
  if (content.length <= maxLength) return [content]

  const parts: string[] = []
  let remaining = content

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      parts.push(remaining)
      break
    }

    // Try to split at a paragraph break
    let splitIdx = remaining.lastIndexOf('\n\n', maxLength)

    // Fall back to newline
    if (splitIdx === -1 || splitIdx < maxLength / 2) {
      splitIdx = remaining.lastIndexOf('\n', maxLength)
    }

    // Fall back to space
    if (splitIdx === -1 || splitIdx < maxLength / 2) {
      splitIdx = remaining.lastIndexOf(' ', maxLength)
    }

    // Fall back to hard cut
    if (splitIdx === -1 || splitIdx < maxLength / 2) {
      splitIdx = maxLength
    }

    parts.push(remaining.slice(0, splitIdx).trim())
    remaining = remaining.slice(splitIdx).trim()
  }

  return parts
}

/**
 * Process an observe-only message (no response).
 * Used for messages the assistant can observe but shouldn't respond to,
 * e.g., WhatsApp messages not in the user's self-chat.
 * Important information is stored as memories with appropriate tags.
 */
async function processObserveOnlyMessage(msg: IncomingMessage): Promise<void> {
  const settings = getSettings()
  const observerProvider = (settings.assistant.observerProvider ?? settings.assistant.provider) as 'claude' | 'opencode'

  // Circuit breaker: skip processing if too many recent failures
  if (isObserverCircuitOpen()) {
    skipInvocation({
      channelType: msg.channelType,
      connectionId: msg.connectionId,
      senderId: msg.senderId,
      senderName: msg.senderName,
      messageContent: msg.content,
      provider: observerProvider,
    })
    return
  }

  // If content is empty but subject exists, use subject as content (HTML-only emails may fail extraction)
  if (!msg.content.trim()) {
    const subject = msg.metadata?.subject as string | undefined
    if (subject) {
      log.messaging.info('Using subject as content for empty-body email', {
        connectionId: msg.connectionId,
        channelType: msg.channelType,
        senderId: msg.senderId,
        subject,
      })
      msg = { ...msg, content: `[Email subject: ${subject}]` }
    } else {
      log.messaging.info('Skipping observe-only message with empty content', {
        connectionId: msg.connectionId,
        channelType: msg.channelType,
        senderId: msg.senderId,
      })
      return
    }
  }

  // Fetch recent open tasks for duplicate prevention context
  let recentTasks: Array<{ id: string; title: string; status: string }> = []
  try {
    const allTasks = db.select({ id: tasks.id, title: tasks.title, status: tasks.status, createdAt: tasks.createdAt })
      .from(tasks)
      .orderBy(desc(tasks.createdAt))
      .all()
    recentTasks = allTasks
      .filter(t => t.status === 'TO_DO' || t.status === 'IN_PROGRESS')
      .slice(0, 10)
      .map(t => ({ id: t.id, title: t.title, status: t.status }))
  } catch { /* non-fatal */ }

  // Fetch recent channel messages for context (skip email — too noisy/threaded)
  const channelHistory = msg.channelType !== 'email'
    ? getRecentChannelMessages(msg.connectionId, {
        before: (msg.timestamp ?? new Date()).toISOString(),
        limit: 5,
      })
    : []

  // Use a shared session for observe-only messages (they don't need individual tracking)
  const observeSessionKey = `observe-${msg.connectionId}`
  const { session } = getOrCreateSession(
    msg.connectionId,
    observeSessionKey,
    'Observer',
    undefined,
    msg.channelType
  )

  const invocationId = createInvocation({
    channelType: msg.channelType,
    connectionId: msg.connectionId,
    senderId: msg.senderId,
    senderName: msg.senderName,
    messageContent: msg.content,
    provider: observerProvider,
  })

  if (observerProvider === 'opencode') {
    // Route to OpenCode text-only observer (no direct tool access)
    try {
      let hadError = false
      let errorMsg = ''
      const stream = _deps.streamOpencodeObserverMessage(session.id, msg.content, {
        channelType: msg.channelType,
        senderId: msg.senderId,
        senderName: msg.senderName,
        channelHistory,
        recentTasks,
      })

      for await (const event of stream) {
        if (event.type === 'error') {
          hadError = true
          errorMsg = (event.data as { message: string }).message
          log.messaging.error('Error in OpenCode observe-only processing', { error: errorMsg })
        } else if (event.type === 'timeout') {
          timeoutInvocation(invocationId)
          recordObserverFailure()
          return
        } else if (event.type === 'done') {
          const actions = ((event.data as { actions?: unknown[] })?.actions ?? []) as ObserverActionRecord[]
          completeInvocation(invocationId, actions)
        }
      }
      if (hadError) {
        failInvocation(invocationId, errorMsg)
        recordObserverFailure()
      } else {
        recordObserverSuccess()
      }
    } catch (err) {
      log.messaging.error('Error processing observe-only message via OpenCode', {
        connectionId: msg.connectionId,
        error: String(err),
      })
      failInvocation(invocationId, String(err))
      recordObserverFailure()
    }
    return
  }

  // Claude observer: uses restricted MCP endpoint (memory tools only)
  const context: MessagingContext = {
    channel: msg.channelType,
    sender: msg.senderId,
    senderName: msg.senderName,
    content: msg.content,
    metadata: {
      subject: msg.metadata?.subject as string | undefined,
      isGroup: msg.metadata?.isGroup as boolean | undefined,
    },
  }
  const systemPrompt = getObserveOnlySystemPrompt(msg.channelType, context, recentTasks)

  try {
    let hadError = false
    let lastErrorMsg = ''
    const observerModelId = settings.assistant.observerModel

    // Stream with observer security tier: no built-in tools, MCP restricted to memory only.
    // Ephemeral: each observation is independent — no session resume, no message persistence.
    const stream = _deps.streamMessage(session.id, msg.content, {
      systemPromptAdditions: systemPrompt,
      modelId: observerModelId,
      securityTier: 'observer',
      ephemeral: true,
      ...(channelHistory.length > 0 && { channelHistory }),
    })

    // Consume stream
    for await (const event of stream) {
      if (event.type === 'error') {
        hadError = true
        lastErrorMsg = (event.data as { message: string }).message
        log.messaging.error('Error in observe-only message processing', { error: lastErrorMsg })
      }
    }
    if (hadError) {
      failInvocation(invocationId, lastErrorMsg)
      recordObserverFailure()
    } else {
      completeInvocation(invocationId, []) // Claude provider: actions unknown (tool calls handled via MCP)
      recordObserverSuccess()
    }
  } catch (err) {
    log.messaging.error('Error processing observe-only message', {
      connectionId: msg.connectionId,
      error: String(err),
    })
    failInvocation(invocationId, String(err))
    recordObserverFailure()
  }
}

// Register message handler with channel manager
setMessageHandler(handleIncomingMessage)
