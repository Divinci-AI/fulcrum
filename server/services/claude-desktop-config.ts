/**
 * Claude Desktop integration: read/write the `fulcrum` MCP server entry in
 * Claude Desktop's config file so the desktop app gets Fulcrum's full tool
 * surface over stdio (`fulcrum mcp`).
 *
 * The config file is owned by Claude Desktop — we only merge in/remove our
 * own `mcpServers.fulcrum` key and never touch anything else. The absolute
 * path to the fulcrum binary is resolved at connect time because GUI apps
 * on macOS launch with a minimal PATH that usually misses user bin dirs.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { dirname, join } from 'node:path'
import { log } from '../lib/logger'

interface McpServerEntry {
  command: string
  args?: string[]
  env?: Record<string, string>
}

interface ClaudeDesktopConfig {
  mcpServers?: Record<string, McpServerEntry>
  [key: string]: unknown
}

export interface ClaudeDesktopStatus {
  /** Claude Desktop appears installed (its config directory exists). */
  installed: boolean
  configPath: string
  /** A `fulcrum` MCP entry is present. */
  connected: boolean
  /** The command currently configured for the fulcrum entry, if any. */
  command: string | null
}

export function getClaudeDesktopConfigPath(): string {
  switch (platform()) {
    case 'darwin':
      return join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
    case 'win32':
      return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json')
    default:
      return join(homedir(), '.config', 'Claude', 'claude_desktop_config.json')
  }
}

function readConfig(path: string): ClaudeDesktopConfig {
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as ClaudeDesktopConfig
  } catch (err) {
    // A corrupt config is the user's file — refuse to clobber it.
    throw new Error(
      `Claude Desktop config at ${path} is not valid JSON (${err instanceof Error ? err.message : String(err)})`
    )
  }
}

/** Absolute path to the fulcrum CLI, falling back to the bare name. */
export function resolveFulcrumBinary(): string {
  return Bun.which('fulcrum') ?? 'fulcrum'
}

export function getClaudeDesktopStatus(): ClaudeDesktopStatus {
  const configPath = getClaudeDesktopConfigPath()
  const installed = existsSync(dirname(configPath))
  let connected = false
  let command: string | null = null
  if (existsSync(configPath)) {
    try {
      const config = readConfig(configPath)
      const entry = config.mcpServers?.fulcrum
      connected = !!entry
      command = entry?.command ?? null
    } catch {
      // unreadable config — report as not connected; connect will surface
      // the real error.
    }
  }
  return { installed, configPath, connected, command }
}

export function connectClaudeDesktop(): ClaudeDesktopStatus {
  const configPath = getClaudeDesktopConfigPath()
  const config = readConfig(configPath)
  const command = resolveFulcrumBinary()
  config.mcpServers = {
    ...config.mcpServers,
    fulcrum: { command, args: ['mcp'] },
  }
  mkdirSync(dirname(configPath), { recursive: true })
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8')
  log.settings.info('Wrote fulcrum MCP entry into Claude Desktop config', { configPath, command })
  return getClaudeDesktopStatus()
}

export function disconnectClaudeDesktop(): ClaudeDesktopStatus {
  const configPath = getClaudeDesktopConfigPath()
  if (existsSync(configPath)) {
    const config = readConfig(configPath)
    if (config.mcpServers?.fulcrum) {
      delete config.mcpServers.fulcrum
      writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8')
      log.settings.info('Removed fulcrum MCP entry from Claude Desktop config', { configPath })
    }
  }
  return getClaudeDesktopStatus()
}
