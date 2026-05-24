import { describe, test, expect, beforeEach, mock } from 'bun:test'
import {
  buildContextUrl,
  formatRetrievedContextSection,
  getDivinciContext,
  _resetDivinciCacheForTesting,
  type DivinciContextResult,
} from './divinci-rag-client'

const goodConfig = {
  baseUrl: 'https://api.divinci.ai',
  apiKey: 'test-key',
  groupId: 'group-abc',
}

function makeResult(overrides: Partial<DivinciContextResult> = {}): DivinciContextResult {
  return {
    chunks: [
      {
        content: 'In Progress · Sprint planning notes for D-17 stack',
        score: 0.91,
        source: 'Fulcrum task: D-17 Plan · https://fulcrum-acme.divinci.ai/tasks/abc',
        fileId: 'file-1',
        vectorId: 'v-1',
      },
    ],
    query: 'planning',
    groupId: goodConfig.groupId,
    groupName: 'fulcrum-acme',
    vectors: ['fulcrum-tasks'],
    total: 1,
    retrievalMs: 87,
    ...overrides,
  }
}

beforeEach(() => {
  _resetDivinciCacheForTesting()
})

describe('divinci-rag-client.buildContextUrl', () => {
  test('appends /api/v1/rag/context to a clean base', () => {
    expect(buildContextUrl('https://api.divinci.ai')).toBe('https://api.divinci.ai/api/v1/rag/context')
  })

  test('strips trailing slashes', () => {
    expect(buildContextUrl('https://api.divinci.ai///')).toBe('https://api.divinci.ai/api/v1/rag/context')
  })

  test('preserves nested path prefixes (e.g. behind a Worker)', () => {
    expect(buildContextUrl('https://acme.divinci.ai/divinci-proxy')).toBe(
      'https://acme.divinci.ai/divinci-proxy/api/v1/rag/context',
    )
  })
})

describe('divinci-rag-client.getDivinciContext', () => {
  test('returns null for empty query without calling fetch', async () => {
    const fetchSpy = mock(() => Promise.resolve(new Response('{}')))
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    const result = await getDivinciContext(goodConfig, '   ')
    expect(result).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test('returns null when config is incomplete', async () => {
    const fetchSpy = mock(() => Promise.resolve(new Response('{}')))
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    expect(await getDivinciContext({ ...goodConfig, apiKey: '' }, 'hi')).toBeNull()
    expect(await getDivinciContext({ ...goodConfig, baseUrl: '' }, 'hi')).toBeNull()
    expect(await getDivinciContext({ ...goodConfig, groupId: '' }, 'hi')).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test('parses 200-ok body and returns the result', async () => {
    const expected = makeResult()
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify(expected), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    ) as unknown as typeof fetch
    const result = await getDivinciContext(goodConfig, 'planning')
    expect(result).toEqual(expected)
  })

  test('caches identical (groupId, query) for 60s — second call does not refetch', async () => {
    let calls = 0
    globalThis.fetch = mock(() => {
      calls += 1
      return Promise.resolve(new Response(JSON.stringify(makeResult()), { status: 200 }))
    }) as unknown as typeof fetch
    await getDivinciContext(goodConfig, 'planning')
    await getDivinciContext(goodConfig, 'planning')
    expect(calls).toBe(1)
  })

  test('noCache option bypasses the cache', async () => {
    let calls = 0
    globalThis.fetch = mock(() => {
      calls += 1
      return Promise.resolve(new Response(JSON.stringify(makeResult()), { status: 200 }))
    }) as unknown as typeof fetch
    await getDivinciContext(goodConfig, 'planning')
    await getDivinciContext(goodConfig, 'planning', { noCache: true })
    expect(calls).toBe(2)
  })

  test('returns null on non-2xx (fail-soft)', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response('{"error":"rate limited"}', { status: 429 })),
    ) as unknown as typeof fetch
    const result = await getDivinciContext(goodConfig, 'planning')
    expect(result).toBeNull()
  })

  test('returns null on non-JSON body (fail-soft)', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response('<html>oops</html>', { status: 200 })),
    ) as unknown as typeof fetch
    const result = await getDivinciContext(goodConfig, 'planning')
    expect(result).toBeNull()
  })

  test('returns null on fetch throw (network) and never throws', async () => {
    globalThis.fetch = mock(() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch
    const result = await getDivinciContext(goodConfig, 'planning')
    expect(result).toBeNull()
  })
})

describe('divinci-rag-client.formatRetrievedContextSection', () => {
  test('returns empty string when no chunks', () => {
    const result = makeResult({ chunks: [] })
    expect(formatRetrievedContextSection(result)).toBe('')
  })

  test('renders header, freshness disclaimer, and per-chunk source attribution', () => {
    const result = makeResult()
    const out = formatRetrievedContextSection(result, { retrievedAt: new Date('2026-05-23T08:00:00Z') })
    expect(out).toContain('## Retrieved Context')
    expect(out).toContain('2026-05-23T08:00:00.000Z')
    expect(out).toContain('For live state, call the matching MCP tool')
    expect(out).toContain('[Fulcrum task: D-17 Plan · https://fulcrum-acme.divinci.ai/tasks/abc]')
    expect(out).toContain('Sprint planning notes for D-17 stack')
  })

  test('truncates output at maxChars budget', () => {
    const longContent = 'x'.repeat(20_000)
    const result = makeResult({
      chunks: [
        { content: longContent, score: 1, source: 'a', fileId: null, vectorId: null },
        { content: longContent, score: 1, source: 'b', fileId: null, vectorId: null },
      ],
    })
    const out = formatRetrievedContextSection(result, { maxChars: 1000 })
    expect(out.length).toBeLessThanOrEqual(1100) // header overhead allowed
  })

  test('drops a chunk entirely if there is not enough room for header + snippet', () => {
    const result = makeResult({
      chunks: [
        { content: 'first', score: null, source: 'A', fileId: null, vectorId: null },
        { content: 'second', score: null, source: 'B', fileId: null, vectorId: null },
      ],
    })
    // Tiny budget — second chunk should not appear at all
    const out = formatRetrievedContextSection(result, { maxChars: 200 })
    expect(out).toContain('[A]')
    expect(out).not.toContain('[B]')
  })

  test('unknown source falls back to [unknown source]', () => {
    const result = makeResult({
      chunks: [{ content: 'hi', score: null, source: null, fileId: null, vectorId: null }],
    })
    const out = formatRetrievedContextSection(result)
    expect(out).toContain('[unknown source]')
  })
})
