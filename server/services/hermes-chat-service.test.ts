import { describe, expect, test } from 'bun:test'
import {
  buildChatCompletionsUrl,
  buildHermesBaseline,
  formatUserTurnWithHistory,
  parseOpenAISseStream,
  type StreamEvent,
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

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = []
  for await (const x of gen) out.push(x)
  return out
}

/** Helper: filter to content events and return their text concatenated. */
function contentText(events: StreamEvent[]): string {
  return events
    .filter((e): e is Extract<StreamEvent, { type: 'content' }> => e.type === 'content')
    .map((e) => e.text)
    .join('')
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

describe('hermes-chat-service.buildHermesBaseline', () => {
  test('hasTools=false → identity + data model + no-tool disclaimer', () => {
    const baseline = buildHermesBaseline(false)
    // From getCoreIdentity()
    expect(baseline).toContain("Fulcrum")
    // From getDataModel()
    expect(baseline).toContain('Tasks')
    // The B8 capability note keeping Hermes honest about tool access
    expect(baseline).toContain('Capability Note')
    expect(baseline).toContain('do NOT have tool access')
  })

  test('hasTools=false → no false promises about Claude-path tools', () => {
    const baseline = buildHermesBaseline(false)
    // These are tool names from getCondensedKnowledge() that Hermes can't call
    expect(baseline).not.toContain('create-task')
    expect(baseline).not.toContain('execute-command')
    expect(baseline).not.toContain('Key tools available')
  })

  test('default arg (no param) treats hasTools as false', () => {
    // Backwards compat: existing callers that didn't pass a flag still get the
    // safe no-tools disclaimer rather than claiming tool access.
    expect(buildHermesBaseline()).toContain('do NOT have tool access')
  })

  test('hasTools=true → tells the model to CALL tools, drops the "no access" line', () => {
    const baseline = buildHermesBaseline(true)
    expect(baseline).toContain('Capability Note')
    // The trusted-tier prompt MUST NOT contradict the OpenAI tools param.
    expect(baseline).not.toContain('do NOT have tool access')
    // Should explicitly steer the model toward tool calls.
    expect(baseline).toContain('CALL the appropriate tool')
    expect(baseline).toContain('list_tasks')
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
    const events = await collect(parseOpenAISseStream(stream))
    expect(contentText(events)).toBe('Hello, world!')
  })

  test('handles \\r\\n line endings', async () => {
    const stream = makeStreamFromChunks([
      'data: {"choices":[{"delta":{"content":"A"}}]}\r\n\r\n',
      'data: {"choices":[{"delta":{"content":"B"}}]}\r\n\r\n',
    ])
    expect(contentText(await collect(parseOpenAISseStream(stream)))).toBe('AB')
  })

  test('handles deltas split across chunk boundaries', async () => {
    const stream = makeStreamFromChunks([
      'data: {"choices":[{"delta":{"con',
      'tent":"split"}}]}\n\n',
    ])
    expect(contentText(await collect(parseOpenAISseStream(stream)))).toBe('split')
  })

  test('ignores [DONE] sentinel and empty data lines', async () => {
    const stream = makeStreamFromChunks([
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
      'data:  \n\n',
      'data: [DONE]\n\n',
    ])
    expect(contentText(await collect(parseOpenAISseStream(stream)))).toBe('ok')
  })

  test('falls back to message.content for non-streaming-shaped responses', async () => {
    const stream = makeStreamFromChunks([
      'data: {"choices":[{"message":{"content":"full"}}]}\n\n',
    ])
    expect(contentText(await collect(parseOpenAISseStream(stream)))).toBe('full')
  })

  test('skips malformed JSON without throwing', async () => {
    const stream = makeStreamFromChunks([
      'data: {not valid json\n\n',
      'data: {"choices":[{"delta":{"content":"recovered"}}]}\n\n',
    ])
    expect(contentText(await collect(parseOpenAISseStream(stream)))).toBe('recovered')
  })

  test('drops deltas without a content field (e.g. role-only first chunk)', async () => {
    const stream = makeStreamFromChunks([
      'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
    ])
    expect(contentText(await collect(parseOpenAISseStream(stream)))).toBe('hi')
  })

  // D-16 B2b: tool_call streaming
  test('emits tool_call deltas with index/id/name/argsDelta', async () => {
    const stream = makeStreamFromChunks([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_abc","type":"function","function":{"name":"list_tasks","arguments":""}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"status\\":"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"TO_DO\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n',
    ])
    const events = await collect(parseOpenAISseStream(stream))
    const toolCallEvents = events.filter((e): e is Extract<StreamEvent, { type: 'tool_call' }> => e.type === 'tool_call')
    expect(toolCallEvents).toHaveLength(3)
    expect(toolCallEvents[0].id).toBe('call_abc')
    expect(toolCallEvents[0].name).toBe('list_tasks')
    // Accumulated arguments across deltas
    const accumulatedArgs = toolCallEvents.map((e) => e.argsDelta ?? '').join('')
    expect(accumulatedArgs).toBe('{"status":"TO_DO"}')

    const finishEvents = events.filter((e): e is Extract<StreamEvent, { type: 'finish' }> => e.type === 'finish')
    expect(finishEvents).toHaveLength(1)
    expect(finishEvents[0].reason).toBe('tool_calls')
  })

  test('emits finish_reason=stop on normal completion', async () => {
    const stream = makeStreamFromChunks([
      'data: {"choices":[{"delta":{"content":"done"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ])
    const events = await collect(parseOpenAISseStream(stream))
    const finishEvents = events.filter((e): e is Extract<StreamEvent, { type: 'finish' }> => e.type === 'finish')
    expect(finishEvents).toHaveLength(1)
    expect(finishEvents[0].reason).toBe('stop')
  })

  test('handles parallel tool_calls (two indices in one stream)', async () => {
    const stream = makeStreamFromChunks([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"list_tasks","arguments":"{}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"b","function":{"name":"get_task","arguments":"{\\"id\\":\\"x\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
    ])
    const events = await collect(parseOpenAISseStream(stream))
    const toolCallEvents = events.filter((e): e is Extract<StreamEvent, { type: 'tool_call' }> => e.type === 'tool_call')
    const indices = new Set(toolCallEvents.map((e) => e.index))
    expect(indices.has(0)).toBe(true)
    expect(indices.has(1)).toBe(true)
  })
})
