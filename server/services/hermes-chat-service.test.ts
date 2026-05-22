import { describe, expect, test } from 'bun:test'
import { parseOpenAISseStream } from './hermes-chat-service'

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
