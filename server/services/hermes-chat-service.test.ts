import { describe, expect, test } from 'bun:test'
import {
  buildChatCompletionsUrl,
  formatUserTurnWithHistory,
  parseOpenAISseStream,
} from './hermes-chat-service'

function makeStreamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  let i = 0
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(enc.encode(chunks[i++]))
      } else {
        controller.close()
      }
    },
  })
}

async function collect(gen: AsyncGenerator<string>): Promise<string[]> {
  const out: string[] = []
  for await (const x of gen) out.push(x)
  return out
}

describe('hermes-chat-service.buildChatCompletionsUrl', () => {
  test('host-only baseUrl gets /v1/chat/completions appended (Hermes convention)', () => {
    expect(buildChatCompletionsUrl('http://localhost:8642')).toBe(
      'http://localhost:8642/v1/chat/completions',
    )
    expect(buildChatCompletionsUrl('http://localhost:8642/')).toBe(
      'http://localhost:8642/v1/chat/completions',
    )
  })

  test('baseUrl with explicit path gets only /chat/completions appended (Gemini, OpenRouter, OpenAI)', () => {
    expect(buildChatCompletionsUrl('https://generativelanguage.googleapis.com/v1beta/openai')).toBe(
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    )
    expect(buildChatCompletionsUrl('https://api.openai.com/v1')).toBe(
      'https://api.openai.com/v1/chat/completions',
    )
    expect(buildChatCompletionsUrl('https://openrouter.ai/api/v1/')).toBe(
      'https://openrouter.ai/api/v1/chat/completions',
    )
  })

  test('malformed baseUrl falls back to bare-host convention without throwing', () => {
    // The fetch() in streamHermesMessage will surface the real error; the helper just doesn't crash
    expect(() => buildChatCompletionsUrl('not a url')).not.toThrow()
  })
})

describe('hermes-chat-service.formatUserTurnWithHistory', () => {
  test('returns the message unchanged when history is missing or empty', () => {
    expect(formatUserTurnWithHistory('hi', undefined)).toBe('hi')
    expect(formatUserTurnWithHistory('hi', [])).toBe('hi')
  })

  test('prepends a [Recent messages…] block when history rows are provided', () => {
    const ts = new Date('2026-05-22T14:35:00Z').toISOString()
    const out = formatUserTurnWithHistory('what was that?', [
      // The actual shape used downstream — only the fields the formatter reads
      { content: 'Task X completed', messageTimestamp: ts } as unknown as Parameters<typeof formatUserTurnWithHistory>[1] extends (infer U)[] | undefined ? U : never,
    ])
    expect(out).toContain('[Recent messages sent on this channel')
    expect(out).toContain('Task X completed')
    expect(out.endsWith('what was that?')).toBe(true)
  })

  test('truncates entries longer than 500 chars with an ellipsis', () => {
    const long = 'x'.repeat(800)
    const out = formatUserTurnWithHistory('?', [
      { content: long, messageTimestamp: new Date().toISOString() } as unknown as Parameters<typeof formatUserTurnWithHistory>[1] extends (infer U)[] | undefined ? U : never,
    ])
    expect(out).toContain('xxx...')
    expect(out).not.toContain('x'.repeat(800))
  })
})

describe('hermes-chat-service.parseOpenAISseStream', () => {
  test('extracts content deltas from a well-formed OpenAI SSE stream', async () => {
    const stream = makeStreamFromChunks([
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":", world"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"!"}}]}\n\n',
      'data: [DONE]\n\n',
    ])
    expect(await collect(parseOpenAISseStream(stream))).toEqual(['Hello', ', world', '!'])
  })

  test('handles \\r\\n line endings', async () => {
    const stream = makeStreamFromChunks([
      'data: {"choices":[{"delta":{"content":"A"}}]}\r\n\r\n',
      'data: {"choices":[{"delta":{"content":"B"}}]}\r\n\r\n',
    ])
    expect(await collect(parseOpenAISseStream(stream))).toEqual(['A', 'B'])
  })

  test('handles deltas split across chunk boundaries', async () => {
    // The `data: ...` line gets cut in half between two TCP reads
    const stream = makeStreamFromChunks([
      'data: {"choices":[{"delta":{"con',
      'tent":"split"}}]}\n\n',
    ])
    expect(await collect(parseOpenAISseStream(stream))).toEqual(['split'])
  })

  test('ignores [DONE] sentinel and empty data lines', async () => {
    const stream = makeStreamFromChunks([
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
      'data:  \n\n',
      'data: [DONE]\n\n',
    ])
    expect(await collect(parseOpenAISseStream(stream))).toEqual(['ok'])
  })

  test('falls back to message.content for non-streaming-shaped responses', async () => {
    const stream = makeStreamFromChunks([
      'data: {"choices":[{"message":{"content":"full"}}]}\n\n',
    ])
    expect(await collect(parseOpenAISseStream(stream))).toEqual(['full'])
  })

  test('skips malformed JSON without throwing', async () => {
    const stream = makeStreamFromChunks([
      'data: {not valid json\n\n',
      'data: {"choices":[{"delta":{"content":"recovered"}}]}\n\n',
    ])
    expect(await collect(parseOpenAISseStream(stream))).toEqual(['recovered'])
  })

  test('drops deltas without a content field (e.g. role-only first chunk)', async () => {
    const stream = makeStreamFromChunks([
      'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
    ])
    expect(await collect(parseOpenAISseStream(stream))).toEqual(['hi'])
  })
})
