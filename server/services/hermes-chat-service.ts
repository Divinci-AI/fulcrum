/**
 * Hermes Agent (Nous Research) chat-streaming via its OpenAI-compatible API
 * server. The operator runs `hermes gateway` locally — see
 * https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server —
 * which exposes `http://127.0.0.1:8642/v1` with bearer-token auth. Fulcrum
 * points at that endpoint via `settings.assistant.hermes.{baseUrl,apiKey,model}`.
 *
 * Stateless contract: each call ships the full session message history.
 * Compared to the opencode-chat-service (which holds OpenCode-side session
 * IDs in memory), Hermes mirrors the standard OpenAI chat-completion shape
 * and doesn't need a session-ID handshake.
 */
import { db, chatMessages } from '../db'
import { eq, sql } from 'drizzle-orm'
import { log } from '../lib/logger'
import { getSettings } from '../lib/settings'
import { getInstanceContext } from '../lib/settings/paths'
import { addMessage } from './assistant-service'
import { getObserverKnowledge } from './assistant-knowledge'
import { readMemoryFile } from './memory-file-service'
import {
  HERMES_TOOLS,
  executeToolCall,
  type OpenAIToolCall,
} from './hermes-tools'
import {
  executeMcpTool,
  getMcpToolsAsOpenAI,
  isMcpToolKnown,
} from './hermes-mcp-bridge'
import type { ChannelHistoryMessage } from './channels/message-storage'
import type { AttachmentData } from '../../shared/types'

/** OpenAI-compatible chat message shape, including vision content blocks and tool turns. */
type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: OpenAIToolCall[] }
  | { role: 'user'; content: string | Array<ContentBlock> }
  | { role: 'tool'; tool_call_id: string; name: string; content: string }

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

/** Streamed event surfaced to callers. Mirrors streamMessage / streamOpencodeMessage. */
export interface HermesStreamEvent {
  type: 'content:delta' | 'message:complete' | 'error' | 'done'
  data: unknown
}

export interface StreamHermesOptions {
  /** Override the configured default model for this call. */
  modelId?: string
  /** Extra context prepended to the system prompt (channel/ritual/observer mode). */
  systemPromptAdditions?: string
  /** Attached files (images/text/documents). Inlined into the user message. */
  attachments?: AttachmentData[]
  /** Skip persisting messages — used for observer / one-shot calls. */
  ephemeral?: boolean
  /**
   * Recent outgoing channel messages (notifications, rituals, MCP sends) the
   * assistant hasn't seen yet. Inlined into the user-turn prefix so Hermes can
   * answer follow-ups like "what was that notification about?" — same shape as
   * the Claude path's channelHistory option.
   */
  channelHistory?: ChannelHistoryMessage[]
  /**
   * D-16 B2b: security tier scopes the available tool set. 'observer' = no
   * tools (Hermes just observes channel chatter, no mutations). 'trusted' =
   * full HERMES_TOOLS (default). Mirrors the Claude path's securityTier
   * concept where observer mode runs through `/mcp/observer` with a
   * restricted scope.
   */
  securityTier?: 'observer' | 'trusted'
}

/**
 * Stream a chat response via Hermes Agent.
 *
 * Yields:
 *  - `content:delta` for each token batch
 *  - `message:complete` once with the full assembled text
 *  - `done` to mark stream end
 *  - `error` on auth / config / transport failure (terminates the stream)
 */
export async function* streamHermesMessage(
  sessionId: string,
  userMessage: string,
  options: StreamHermesOptions = {},
): AsyncGenerator<HermesStreamEvent> {
  const settings = getSettings()
  const cfg = settings.assistant.hermes

  if (!cfg.baseUrl) {
    yield {
      type: 'error',
      data: { message: 'Hermes baseUrl is not configured (Settings → Assistant → Hermes)' },
    }
    return
  }
  if (!cfg.apiKey) {
    yield {
      type: 'error',
      data: { message: 'Hermes API key is not configured (Settings → Assistant → Hermes)' },
    }
    return
  }

  const model = options.modelId ?? cfg.model
  if (!model) {
    yield {
      type: 'error',
      data: { message: 'Hermes model is not configured (Settings → Assistant → Hermes)' },
    }
    return
  }

  // Build the message history from the DB. For ephemeral / observer calls
  // we still want any previously-stored context to surface; consumers that
  // truly want a single-shot call should use a fresh sessionId.
  const history = getSessionHistoryForHermes(sessionId)

  // Compose the user turn, folding any text-style attachments into the prompt
  // and surfacing images as OpenAI vision content blocks.
  const userBlocks: ContentBlock[] = []
  if (options.attachments && options.attachments.length > 0) {
    for (const a of options.attachments) {
      if (a.type === 'image') {
        userBlocks.push({
          type: 'image_url',
          image_url: { url: `data:${a.mediaType};base64,${a.data}` },
        })
      } else if (a.type === 'text') {
        userBlocks.push({
          type: 'text',
          text: `--- ${a.filename ?? 'attachment.txt'} ---\n${a.data}`,
        })
      } else {
        // document (PDF, etc.) — describe rather than embed; Hermes vision support varies
        userBlocks.push({
          type: 'text',
          text: `[Attached document: ${a.filename ?? 'document'} (${a.mediaType})]`,
        })
      }
    }
  }
  // D-16 B3: thread channelHistory in front of the user turn so Hermes has
  // context for follow-ups about recent notifications / rituals / MCP sends.
  const userText = formatUserTurnWithHistory(userMessage, options.channelHistory)
  userBlocks.push({ type: 'text', text: userText || '(no text)' })

  // D-16 B8: prepend a Hermes-appropriate baseline system prompt so the
  // assistant knows what Fulcrum is and what it can/can't do. Uses the
  // observer-knowledge bundle (CoreIdentity + DataModel, no tool descriptions)
  // so the model doesn't pretend it can call tools it doesn't have access to.
  const messages: ChatMessage[] = []
  const baseline = buildHermesBaseline()
  const fullSystem = options.systemPromptAdditions
    ? `${baseline}\n\n${options.systemPromptAdditions}`
    : baseline
  messages.push({ role: 'system', content: fullSystem })
  for (const m of history) {
    messages.push({ role: m.role as 'user' | 'assistant', content: m.content })
  }
  // If the only block is plain text and nothing else (no attachments), send
  // a bare string — many OpenAI-compatible servers prefer that shape.
  const onlyTextBlock =
    userBlocks.length === 1 && userBlocks[0].type === 'text' ? userBlocks[0] : null
  messages.push({
    role: 'user',
    content: onlyTextBlock ? onlyTextBlock.text : userBlocks,
  })

  // Persist the user turn (unless ephemeral). Goes through assistant-service.addMessage
  // so chatSessions.messageCount / lastMessageAt / updatedAt stay current — matters for
  // session-list sorting and the WS broadcast.
  if (!options.ephemeral) {
    addMessage(sessionId, { sessionId, role: 'user', content: userMessage })
  }

  const url = buildChatCompletionsUrl(cfg.baseUrl)

  // D-16 B2b: streaming tool-call loop. Each iteration sends a streaming
  // request, accumulates content + tool_call deltas from the SSE stream,
  // and decides at finish_reason whether to execute tools (and loop) or
  // emit the buffered content as the final answer.
  //
  // Why we buffer content rather than yield it during the stream: interstitial
  // iterations may emit preamble text ("Sure, let me check…") before the
  // tool_calls arrive. Yielding those would pollute the Slack bubble — which
  // accumulates content via chat.update — with the model's pre-tool reasoning.
  // Instead we hold content until we know finish_reason !== 'tool_calls', then
  // emit it as content:delta chunks for streaming consumers.
  const MAX_TOOL_ITERATIONS = 5
  // Observer tier gets no tools — pure-chat observation with no mutation surface.
  // Trusted tier: MCP-derived tools (~127 from cli/src/mcp/tools/*) union with the
  // hand-rolled HERMES_TOOLS, MCP winning on name collisions (MCP schemas are
  // richer). Dispatch order in executeAnyTool mirrors this precedence.
  const toolsForCall =
    options.securityTier === 'observer'
      ? []
      : (() => {
          const mcp = getMcpToolsAsOpenAI()
          const mcpNames = new Set(mcp.map((t) => t.function.name))
          const handRolled = HERMES_TOOLS.filter((t) => !mcpNames.has(t.function.name))
          return [...mcp, ...handRolled]
        })()
  let finalContent = ''
  let lastError: string | null = null

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    let response: Response
    try {
      const requestBody: Record<string, unknown> = { model, messages, stream: true }
      if (toolsForCall.length > 0) requestBody.tools = toolsForCall
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify(requestBody),
      })
    } catch (err) {
      log.chat.error('Hermes fetch failed', { url, iter, error: String(err) })
      lastError = `Hermes request failed: ${err instanceof Error ? err.message : String(err)}`
      break
    }

    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => '')
      log.chat.error('Hermes responded non-ok', { status: response.status, iter, detail: detail.slice(0, 500) })
      lastError = `Hermes returned ${response.status}: ${detail.slice(0, 200) || response.statusText}`
      break
    }

    // Accumulate streamed events for this iteration. tool_calls stream
    // field-by-field across chunks, identified by `index`.
    let contentBuffer = ''
    const toolCallSlots = new Map<number, OpenAIToolCall>()
    let finishReason: string | null = null

    try {
      for await (const ev of parseOpenAISseStream(response.body)) {
        if (ev.type === 'content') {
          contentBuffer += ev.text
        } else if (ev.type === 'tool_call') {
          const slot =
            toolCallSlots.get(ev.index) ??
            ({ id: '', type: 'function' as const, function: { name: '', arguments: '' } } as OpenAIToolCall)
          if (ev.id) slot.id = ev.id
          if (ev.name) slot.function.name = ev.name
          if (ev.argsDelta) slot.function.arguments += ev.argsDelta
          toolCallSlots.set(ev.index, slot)
        } else if (ev.type === 'finish') {
          finishReason = ev.reason
        }
      }
    } catch (err) {
      log.chat.error('Hermes stream parse failed', { iter, error: String(err) })
      lastError = `Hermes stream parse failed: ${err instanceof Error ? err.message : String(err)}`
      break
    }

    // If the model decided to call tools, execute and loop. Note: we check
    // BOTH finishReason === 'tool_calls' AND toolCallSlots.size — some
    // providers don't always set finish_reason cleanly when streaming.
    if (toolCallSlots.size > 0 && (finishReason === 'tool_calls' || finishReason === null)) {
      const toolCalls = [...toolCallSlots.values()]
      messages.push({
        role: 'assistant',
        content: contentBuffer || null,
        tool_calls: toolCalls,
      })
      for (const call of toolCalls) {
        // D-16 B2d: MCP-registered tools win over hand-rolled ones. Try the
        // MCP bridge first; only fall back to executeToolCall when the name
        // isn't in the MCP registry.
        let resultContent: string
        let resultName = call.function.name
        if (isMcpToolKnown(call.function.name)) {
          let args: Record<string, unknown>
          try {
            args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>
          } catch (err) {
            args = {}
            log.chat.warn('Hermes MCP tool args not JSON; passing empty object', {
              tool: call.function.name,
              error: String(err),
            })
          }
          resultContent = await executeMcpTool(call.function.name, args)
        } else {
          const result = await executeToolCall(call)
          resultContent = result.content
          resultName = result.name
        }
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          name: resultName,
          content: resultContent,
        })
        log.chat.info('Hermes tool executed', {
          tool: call.function.name,
          source: isMcpToolKnown(call.function.name) ? 'mcp' : 'hand-rolled',
          callId: call.id,
          iter,
        })
      }
      continue
    }

    // No tool_calls (or finish_reason='stop'): this is the final answer.
    finalContent = contentBuffer
    break
  }

  if (lastError) {
    yield { type: 'error', data: { message: lastError } }
    return
  }

  // Chunk the final content into content:delta events for downstream
  // streaming consumers (Slack chat.update path). Each chunk is ~80 chars
  // which gives a "watch it appear" feel without spamming Slack's rate limit.
  for (const chunk of chunkText(finalContent, 80)) {
    yield { type: 'content:delta', data: { text: chunk } }
  }

  yield { type: 'message:complete', data: { content: finalContent } }

  if (!options.ephemeral && finalContent.trim()) {
    addMessage(sessionId, { sessionId, role: 'assistant', content: finalContent })
  }

  log.chat.info('Hermes chat complete', {
    sessionId,
    model,
    length: finalContent.length,
    messageCount: messages.length,
  })

  yield { type: 'done', data: { content: finalContent } }
}

/**
 * Split a string into chunks of up to `size` characters, prefer breaking at
 * whitespace where possible. Used to emit content:delta events from the
 * final-iteration content buffer (the streaming loop holds content during
 * tool iterations to avoid polluting Slack bubbles with model preamble).
 */
function chunkText(text: string, size: number): string[] {
  if (!text) return []
  const out: string[] = []
  let i = 0
  while (i < text.length) {
    let end = Math.min(i + size, text.length)
    if (end < text.length) {
      // Walk back to the nearest whitespace within the chunk
      const ws = text.lastIndexOf(' ', end)
      if (ws > i + size / 2) end = ws + 1
    }
    out.push(text.slice(i, end))
    i = end
  }
  return out
}

/**
 * Build the baseline system prompt that's always present in a Hermes chat.
 *
 * Composed of:
 *   - Instance context (documents dir, hostname, etc.)
 *   - Observer-tier knowledge: CoreIdentity ("you are Fulcrum's assistant") +
 *     DataModel ("tasks, projects, repositories, …"). NO tool descriptions —
 *     Hermes doesn't have MCP / Claude Code tool surface today (B2 follow-up).
 *   - The master memory file content (MEMORY.md) injected verbatim, matching
 *     the Claude path's behavior so persistent user prefs / project context
 *     flow into Hermes too.
 *   - A short "you don't have tool access today" disclaimer so the model
 *     describes what's possible rather than hallucinating tool calls.
 *
 * Exported for unit testing.
 */
export function buildHermesBaseline(): string {
  const settings = getSettings()
  const instanceContext = getInstanceContext(settings.assistant.documentsDir)
  const knowledge = getObserverKnowledge()
  const memoryFileContent = readMemoryFile()

  const memorySection = memoryFileContent.trim()
    ? `\n\n## Master Memory File

This is your persistent memory (MEMORY.md), injected into every conversation.

${memoryFileContent}`
    : ''

  const toolDisclaimer = `\n\n## Capability Note

You're running on the Hermes provider, which routes to an OpenAI-compatible chat endpoint. You can read context (recent channel activity, the memory file, the user's message) and answer in natural language — but you do NOT have tool access today. If the user asks you to create a task, send a notification, or modify state, describe what they should do (which UI panel, which command) rather than claiming you can act. Tool support is planned for a follow-up release.`

  return `${instanceContext}\n\n${knowledge}${memorySection}${toolDisclaimer}`
}

/**
 * Compose the user-turn text with a recent-channel-activity prefix, matching
 * the format the Claude path uses in `assistant-service.ts`. Empty when no
 * history rows are provided.
 *
 * Exported for unit testing.
 */
export function formatUserTurnWithHistory(
  userMessage: string,
  channelHistory: ChannelHistoryMessage[] | undefined,
): string {
  if (!channelHistory || channelHistory.length === 0) return userMessage
  const lines = channelHistory.map((msg) => {
    const time = new Date(msg.messageTimestamp).toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
    const truncated = msg.content.length > 500 ? msg.content.slice(0, 500) + '...' : msg.content
    return `[${time}] ${truncated}`
  })
  return `[Recent messages sent on this channel since our last conversation:\n${lines.join('\n')}]\n\n${userMessage}`
}

/**
 * Resolve the chat-completions URL from an operator-supplied baseUrl.
 *
 * Two conventions seen in the wild:
 *   - "host-only" baseUrl (e.g. `http://localhost:8642`, no path). The service
 *     hosts the API under `/v1/chat/completions` — append `/v1/chat/completions`.
 *   - "path-included" baseUrl (e.g.
 *     `https://generativelanguage.googleapis.com/v1beta/openai`, or
 *     `https://api.openai.com/v1`). The version segment is already part of the
 *     URL — append only `/chat/completions`.
 *
 * The discriminator is whether the parsed URL has a non-trivial pathname.
 * Exported for unit testing.
 */
export function buildChatCompletionsUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '')
  let pathname = '/'
  try {
    pathname = new URL(base).pathname
  } catch {
    // Malformed URL — fall back to bare-host convention; fetch() will surface the real error
  }
  const hasPath = pathname && pathname !== '/'
  return hasPath ? `${base}/chat/completions` : `${base}/v1/chat/completions`
}

/**
 * Pull the prior user/assistant messages for this session, oldest first.
 * System prompts and tool messages are skipped — only the conversation core.
 */
function getSessionHistoryForHermes(sessionId: string): Array<{ role: string; content: string }> {
  const rows = db
    .select({ role: chatMessages.role, content: chatMessages.content })
    .from(chatMessages)
    .where(eq(chatMessages.sessionId, sessionId))
    .orderBy(chatMessages.createdAt, sql`rowid`)
    .all()
  return rows.filter((r) => r.role === 'user' || r.role === 'assistant')
}

/**
 * Rich SSE-stream event. D-16 B2b — replaces the content-only generator
 * with a typed union so callers can react to tool_calls and finish_reason
 * separately. The B2a non-streaming tool loop is gone; streamHermesMessage
 * now consumes this directly.
 */
export type StreamEvent =
  | { type: 'content'; text: string }
  | {
      type: 'tool_call'
      index: number
      id?: string
      name?: string
      argsDelta?: string
    }
  | { type: 'finish'; reason: string | null }

/**
 * Parse an OpenAI-style SSE stream and yield typed events for content
 * deltas, tool_call deltas (which OpenAI streams field-by-field across
 * chunks, identified by `index`), and finish markers.
 *
 * Exported for direct unit testing.
 */
export async function* parseOpenAISseStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<StreamEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let sep: number
    while ((sep = findEventBoundary(buffer)) >= 0) {
      const eventText = buffer.slice(0, sep)
      buffer = buffer.slice(sep).replace(/^(\r?\n){2}/, '')
      yield* extractEventsFromSse(eventText)
    }
  }
  if (buffer.trim()) {
    yield* extractEventsFromSse(buffer)
  }
}

function findEventBoundary(buf: string): number {
  const a = buf.indexOf('\n\n')
  const b = buf.indexOf('\r\n\r\n')
  if (a === -1) return b
  if (b === -1) return a
  return Math.min(a, b)
}

/**
 * Yields a sequence of StreamEvents for a single SSE block. A single block
 * can contain content, multiple tool_call slices (one per index), and/or
 * a finish_reason.
 */
function* extractEventsFromSse(eventText: string): Generator<StreamEvent> {
  for (const line of eventText.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    let obj: SseDataPayload
    try {
      obj = JSON.parse(payload) as SseDataPayload
    } catch {
      continue
    }
    const choice = obj.choices?.[0]
    if (!choice) continue

    // Content (streaming delta or non-streaming message.content fallback)
    const contentText = choice.delta?.content ?? choice.message?.content
    if (typeof contentText === 'string' && contentText.length > 0) {
      yield { type: 'content', text: contentText }
    }

    // Tool call deltas — streaming spec: choices[0].delta.tool_calls[].{id?, function.{name?, arguments?}}
    const toolCallDeltas = choice.delta?.tool_calls ?? choice.message?.tool_calls
    if (Array.isArray(toolCallDeltas)) {
      for (const tc of toolCallDeltas) {
        const out: Extract<StreamEvent, { type: 'tool_call' }> = {
          type: 'tool_call',
          index: typeof tc.index === 'number' ? tc.index : 0,
        }
        if (tc.id) out.id = tc.id
        if (tc.function?.name) out.name = tc.function.name
        if (typeof tc.function?.arguments === 'string') out.argsDelta = tc.function.arguments
        yield out
      }
    }

    // Finish marker
    if (choice.finish_reason) {
      yield { type: 'finish', reason: choice.finish_reason }
    }
  }
}

interface SseDataPayload {
  choices?: Array<{
    delta?: {
      content?: string
      tool_calls?: Array<{
        index?: number
        id?: string
        type?: string
        function?: { name?: string; arguments?: string }
      }>
    }
    message?: {
      content?: string
      tool_calls?: Array<{
        index?: number
        id?: string
        type?: string
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason?: string | null
  }>
}
