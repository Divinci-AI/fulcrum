/**
 * Divinci RAG client (D-17 PR 1).
 *
 * Thin HTTP wrapper around Divinci's `POST /api/v1/rag/context` endpoint.
 * Hermes invokes this once per turn (pre-flight retrieval) to fetch
 * semantic chunks across the operator's connected sources — Slack,
 * Fulcrum, Gmail, Calendar, Drive — bundled into a single Divinci Group.
 *
 * Design choices:
 *  - Fail-soft: a 1500ms timeout or non-2xx response logs a warn and
 *    returns an empty chunk array, so Hermes still functions with
 *    tools-only when Divinci is down. Never throws.
 *  - 60-second in-memory cache keyed by `(groupId, query)` so the same
 *    Slack back-and-forth doesn't hammer Divinci's rate limiter.
 *  - Token-budgets the returned chunk content at the caller's discretion
 *    (returned as-is here; injection-side trims).
 *
 * See:
 *  - Divinci handler: /Users/mikeumus/Documents/server/workspace/servers/public-api/src/api/v1/routes/rag-context.ts
 *  - D-17 architecture notes in the PR description.
 */
import { log } from '../lib/logger'

/** One retrieved chunk from Divinci. Mirrors the rag-context.ts shape. */
export interface DivinciChunk {
  content: string
  score: number | null
  source: string | null
  fileId: string | null
  vectorId: string | null
}

export interface DivinciContextResult {
  chunks: DivinciChunk[]
  query: string
  groupId?: string
  groupName?: string
  vectors?: string[]
  total: number
  retrievalMs: number
}

export interface GetContextOptions {
  /** Maximum chunks to retrieve. Server caps at 50. */
  topK?: number
  /** Hard timeout for the HTTP call (ms). Default 1500. */
  timeoutMs?: number
  /** Bypass the in-memory cache for this call (e.g. for tests). */
  noCache?: boolean
}

interface CachedEntry {
  expiresAt: number
  result: DivinciContextResult
}

const CACHE_TTL_MS = 60_000
const cache = new Map<string, CachedEntry>()

/**
 * Test-only: reset the module-level cache between cases.
 */
export function _resetDivinciCacheForTesting(): void {
  cache.clear()
}

/**
 * Build the cache key. Groups isolate per-tenant; query is the user input.
 */
function cacheKey(groupId: string, query: string): string {
  return `${groupId}::${query}`
}

/**
 * Fetch retrieved-context chunks from a Divinci Group.
 *
 * Returns `null` when Divinci is misconfigured or unreachable — callers
 * should treat that as "no augmentation available, proceed tools-only."
 */
export async function getDivinciContext(
  config: { baseUrl: string; apiKey: string; groupId: string },
  query: string,
  options: GetContextOptions = {},
): Promise<DivinciContextResult | null> {
  if (!query.trim()) return null
  if (!config.baseUrl || !config.apiKey || !config.groupId) return null

  const key = cacheKey(config.groupId, query)
  if (!options.noCache) {
    const cached = cache.get(key)
    if (cached && cached.expiresAt > Date.now()) return cached.result
  }

  const url = buildContextUrl(config.baseUrl)
  const timeoutMs = options.timeoutMs ?? 1500
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        query,
        groupId: config.groupId,
        ...(options.topK && { topK: options.topK }),
      }),
      signal: controller.signal,
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      log.chat.warn('Divinci context retrieval non-ok', {
        status: response.status,
        groupId: config.groupId,
        queryPreview: query.slice(0, 80),
        detail: detail.slice(0, 200),
      })
      return null
    }
    const text = await response.text()
    let parsed: DivinciContextResult
    try {
      parsed = JSON.parse(text) as DivinciContextResult
    } catch {
      log.chat.warn('Divinci context retrieval returned non-JSON', {
        status: response.status,
        bodyPreview: text.slice(0, 200),
      })
      return null
    }
    cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, result: parsed })
    return parsed
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError'
    log.chat.warn(aborted ? 'Divinci context timed out' : 'Divinci context error', {
      timeoutMs,
      groupId: config.groupId,
      queryPreview: query.slice(0, 80),
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Resolve `/api/v1/rag/context` against a Divinci base URL. Handles both
 * trailing-slash variants. Exported for unit testing.
 */
export function buildContextUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  return `${trimmed}/api/v1/rag/context`
}

/**
 * Render the retrieved chunks as a system-prompt section. Caps the total
 * output at ~`maxChars` so we don't blow the context budget. Per-chunk
 * truncation preserves the source attribution.
 */
export function formatRetrievedContextSection(
  result: DivinciContextResult,
  options: { maxChars?: number; retrievedAt?: Date } = {},
): string {
  if (!result.chunks.length) return ''
  const maxChars = options.maxChars ?? 8000 // ~2000 tokens
  const retrievedAt = options.retrievedAt ?? new Date()

  const lines: string[] = []
  lines.push('## Retrieved Context')
  lines.push('')
  lines.push(
    `Indexed snapshots from Slack, Fulcrum, Gmail, Calendar, and Drive (via Divinci, retrieved ${retrievedAt.toISOString()}). For live state, call the matching MCP tool.`,
  )
  lines.push('')

  let used = lines.join('\n').length
  for (const chunk of result.chunks) {
    const header = chunk.source ? `[${chunk.source}]` : '[unknown source]'
    let body = chunk.content.trim()
    const block = `${header}\n${body}\n`
    if (used + block.length > maxChars) {
      // Truncate this chunk's body to fit; if there's not even room for
      // the header + a snippet, drop the rest.
      const remaining = maxChars - used - header.length - 6
      if (remaining < 80) break
      body = `${body.slice(0, remaining).trimEnd()}…`
      lines.push(header, body, '')
      break
    }
    lines.push(header, body, '')
    used += block.length
  }
  return lines.join('\n').trimEnd()
}
