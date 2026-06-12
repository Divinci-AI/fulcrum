import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { setupTestEnv, type TestEnv } from '../__tests__/utils/env'
import {
  connectClaudeDesktop,
  disconnectClaudeDesktop,
  getClaudeDesktopConfigPath,
  getClaudeDesktopStatus,
} from './claude-desktop-config'

// setupTestEnv points HOME at a temp dir (via mise test isolation), so the
// resolved config path is inside the sandbox.

describe('claude-desktop-config', () => {
  let env: TestEnv
  beforeEach(() => {
    env = setupTestEnv()
  })
  afterEach(() => env.cleanup())

  test('status reports not installed when config dir is absent', () => {
    const status = getClaudeDesktopStatus()
    expect(status.connected).toBe(false)
  })

  test('connect merges entry without clobbering existing servers', () => {
    const path = getClaudeDesktopConfigPath()
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(
      path,
      JSON.stringify({ mcpServers: { other: { command: 'other-tool' } }, theme: 'dark' })
    )

    const status = connectClaudeDesktop()
    expect(status.connected).toBe(true)

    const config = JSON.parse(readFileSync(path, 'utf-8'))
    expect(config.mcpServers.fulcrum.args).toEqual(['mcp'])
    expect(config.mcpServers.other.command).toBe('other-tool')
    expect(config.theme).toBe('dark')
  })

  test('disconnect removes only the fulcrum entry', () => {
    connectClaudeDesktop()
    const path = getClaudeDesktopConfigPath()
    const before = JSON.parse(readFileSync(path, 'utf-8'))
    expect(before.mcpServers.fulcrum).toBeDefined()

    const status = disconnectClaudeDesktop()
    expect(status.connected).toBe(false)
    const after = JSON.parse(readFileSync(path, 'utf-8'))
    expect(after.mcpServers.fulcrum).toBeUndefined()
  })

  test('connect refuses to clobber a corrupt config', () => {
    const path = getClaudeDesktopConfigPath()
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, '{ not json')
    expect(() => connectClaudeDesktop()).toThrow(/not valid JSON/)
    expect(readFileSync(path, 'utf-8')).toBe('{ not json')
  })
})
