import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { setupTestEnv, type TestEnv } from '../__tests__/utils/env'
import {
  _resetMcpBridgeForTesting,
  executeMcpTool,
  getMcpToolsAsOpenAI,
  isMcpToolKnown,
} from './hermes-mcp-bridge'

describe('hermes-mcp-bridge', () => {
  let testEnv: TestEnv

  beforeEach(() => {
    testEnv = setupTestEnv()
    _resetMcpBridgeForTesting()
  })

  afterEach(() => {
    testEnv.cleanup()
  })

  test('enumerates ~127 MCP tools (every category file registers some)', () => {
    const tools = getMcpToolsAsOpenAI()
    // 23 category files registering 1-8 tools each; the exact total varies as
    // new tools land. Verify we have substantially more than the hand-rolled 7
    // — any number above 50 means the introspection actually worked.
    expect(tools.length).toBeGreaterThan(50)
  })

  test('every tool has type=function, name, description, and parameters', () => {
    const tools = getMcpToolsAsOpenAI()
    for (const tool of tools) {
      expect(tool.type).toBe('function')
      expect(typeof tool.function.name).toBe('string')
      expect(tool.function.name.length).toBeGreaterThan(0)
      expect(typeof tool.function.description).toBe('string')
      expect(tool.function.parameters).toBeDefined()
      // Always wrapped as an object schema (OpenAI requires this)
      expect((tool.function.parameters as { type?: string }).type).toBe('object')
    }
  })

  test('tool names are unique', () => {
    const tools = getMcpToolsAsOpenAI()
    const names = tools.map((t) => t.function.name)
    expect(new Set(names).size).toBe(names.length)
  })

  test('isMcpToolKnown returns true for canonical Fulcrum tools', () => {
    expect(isMcpToolKnown('list_tasks')).toBe(true)
    expect(isMcpToolKnown('create_task')).toBe(true)
    expect(isMcpToolKnown('search')).toBe(true)
    expect(isMcpToolKnown('memory_store')).toBe(true)
  })

  test('isMcpToolKnown returns false for unknown names', () => {
    expect(isMcpToolKnown('not_a_real_tool')).toBe(false)
    expect(isMcpToolKnown('')).toBe(false)
  })

  test('executeMcpTool returns an error envelope for unknown tools (does not throw)', async () => {
    const result = await executeMcpTool('definitely_not_a_tool', {})
    const parsed = JSON.parse(result) as { error?: string }
    expect(parsed.error).toContain('Unknown MCP tool')
  })

  test('JSON schemas don\'t include the $schema URL (OpenAI rejects it)', () => {
    const tools = getMcpToolsAsOpenAI()
    for (const tool of tools) {
      expect((tool.function.parameters as { $schema?: unknown }).$schema).toBeUndefined()
    }
  })
})
