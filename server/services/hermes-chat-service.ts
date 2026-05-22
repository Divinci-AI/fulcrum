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
import type { AttachmentData } from '../../shared/types'

/** OpenAI-compatible chat message shape, including vision content blocks. */
type ChatMessage =
  | { role: 'system' | 'assistant'; content: string }
  | { role: 'user'; content: string | Array<ContentBlock> }

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
  userBlocks.push({ type: 'text', text: userMessage || '(no text)' })

  const messages: ChatMessage[] = []
  if (options.systemPromptAdditions) {
    messages.push({ role: 'system', content: options.systemPromptAdditions })
  }
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

  // Persist the user turn (unless ephemeral). Mirrors the Claude/OpenCode paths.
  if (!options.ephemeral) {
    db.insert(chatMessages).values({
      id: crypto.randomUUID(),
      sessionId,
      role: 'user',
      content: userMessage,
      createdAt: new Date().toISOString(),
    }).run()
  }

  const url = buildChatCompletionsUrl(cfg.baseUrl)
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({ model, messages, stream: true }),
    })
  } catch (err) {
    log.chat.error('Hermes fetch failed', { url, error: String(err) })
    yield { type: 'error', data: { message: `Hermes request failed: ${err instanceof Error ? err.message : String(err)}` } }
    return
  }

  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => '')
    log.chat.error('Hermes responded non-ok', { status: response.status, detail: detail.slice(0, 500) })
    yield {
      type: 'error',
      data: { message: `Hermes returned ${response.status}: ${detail.slice(0, 200) || response.statusText}` },
    }
    return
  }

  let assembled = ''
  try {
    for await (const delta of parseOpenAISseStream(response.body)) {
      if (delta) {
        assembled += delta
        yield { type: 'content:delta', data: { text: delta } }
      }
    }
  } catch (err) {
    log.chat.error('Hermes stream parse failed', { error: String(err) })
    yield { type: 'error', data: { message: `Hermes stream parse failed: ${err instanceof Error ? err.message : String(err)}` } }
    return
  }

  yield { type: 'message:complete', data: { content: assembled } }

  if (!options.ephemeral && assembled.trim()) {
    db.insert(chatMessages).values({
      id: crypto.randomUUID(),
      sessionId,
      role: 'assistant',
      content: assembled,
      createdAt: new Date().toISOString(),
    }).run()
  }

  log.chat.info('Hermes chat complete', {
    sessionId,
    model,
    length: assembled.length,
    messageCount: messages.length,
  })

  yield { type: 'done', data: { content: assembled } }
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
 * Parse an OpenAI-style SSE stream and yield content deltas.
 * Each SSE chunk is `data: {…JSON…}\n\n`; the terminating message is
 * `data: [DONE]\n\n`. We only surface the assistant content tokens.
 *
 * Exported for direct unit testing — the wrapper above ties the parser to
 * the fetched Response body.
 */
export async function* parseOpenAISseStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    // OpenAI uses `\n\n` between SSE events; some servers use `\r\n\r\n`.
    let sep: number
    while ((sep = findEventBoundary(buffer)) >= 0) {
      const eventText = buffer.slice(0, sep)
      buffer = buffer.slice(sep).replace(/^(\r?\n){2}/, '')
      const delta = extractContentFromEvent(eventText)
      if (delta) yield delta
    }
  }
  // Flush any trailing partial event (best-effort)
  if (buffer.trim()) {
    const delta = extractContentFromEvent(buffer)
    if (delta) yield delta
  }
}

function findEventBoundary(buf: string): number {
  const a = buf.indexOf('\n\n')
  const b = buf.indexOf('\r\n\r\n')
  if (a === -1) return b
  if (b === -1) return a
  return Math.min(a, b)
}

function extractContentFromEvent(eventText: string): string | null {
  // Each event is a sequence of `field: value` lines; we only care about `data:`
  for (const line of eventText.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    try {
      const obj = JSON.parse(payload) as {
        choices?: Array<{ delta?: { content?: string }; message?: { content?: string } }>
      }
      // Streaming chunk: choices[0].delta.content. Non-streaming fallback: message.content.
      const c = obj.choices?.[0]
      const text = c?.delta?.content ?? c?.message?.content
      if (typeof text === 'string') return text
    } catch {
      // Ignore lines that aren't valid JSON (e.g. comments, keepalives)
    }
  }
  return null
}
