/**
 * CLI auth + base URL config (D-8 PR 3b).
 *
 * Persists `fulcrum login` output so subsequent `fulcrum <cmd>` calls
 * find their server + bearer token without re-asking. Stored at
 * `~/.fulcrum/cli.toml` (single profile for now — multi-profile is a
 * straightforward extension when there are multiple tenants).
 *
 * Env vars override file values: `FULCRUM_URL` and `FULCRUM_TOKEN`.
 * That keeps CI / one-off scripts free of write side-effects on the
 * operator's home dir.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

const CONFIG_FILENAME = 'cli.toml'

export interface CliConfig {
  url?: string | null
  token?: string | null
}

export function getCliConfigPath(): string {
  // Mirror server.getFulcrumDir() — env override beats $HOME so test
  // isolation already covers this path. We intentionally use ~/.fulcrum
  // instead of XDG so the CLI's config sits alongside the server's data
  // dir for a single mental model.
  const root =
    process.env.FULCRUM_DIR ??
    join(homedir(), '.fulcrum')
  return join(root, CONFIG_FILENAME)
}

/**
 * Minimal TOML reader. We only ever write `url = "..."` and
 * `token = "..."` lines, so the full TOML grammar is overkill —
 * key + double-quoted string is enough. Bringing in a TOML
 * dependency for two lines isn't worth the install footprint.
 */
function parseSimpleToml(text: string): CliConfig {
  const config: CliConfig = {}
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const match = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*"((?:[^"\\]|\\.)*)"\s*$/)
    if (!match) continue
    const [, key, rawValue] = match
    // Un-escape backslash + double-quote — only escapes we ever produce
    const value = rawValue.replace(/\\(["\\])/g, '$1')
    if (key === 'url') config.url = value
    else if (key === 'token') config.token = value
  }
  return config
}

function serializeSimpleToml(config: CliConfig): string {
  const lines: string[] = []
  if (config.url) lines.push(`url = "${escapeTomlString(config.url)}"`)
  if (config.token) lines.push(`token = "${escapeTomlString(config.token)}"`)
  return lines.join('\n') + '\n'
}

function escapeTomlString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/**
 * Load the saved config (or empty config if missing). Env vars override
 * file values — preferred chain is env → file → undefined.
 */
export function loadCliConfig(): CliConfig {
  let fromFile: CliConfig = {}
  const path = getCliConfigPath()
  if (existsSync(path)) {
    try {
      fromFile = parseSimpleToml(readFileSync(path, 'utf8'))
    } catch {
      // Treat a corrupt config as empty rather than crashing the CLI.
      fromFile = {}
    }
  }
  return {
    url: process.env.FULCRUM_URL ?? fromFile.url ?? null,
    token: process.env.FULCRUM_TOKEN ?? fromFile.token ?? null,
  }
}

/**
 * Save the config. Writes to `~/.fulcrum/cli.toml` with 0600 perms
 * because it contains a bearer token. mkdir -p first.
 */
export function saveCliConfig(config: CliConfig): string {
  const path = getCliConfigPath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, serializeSimpleToml(config), { encoding: 'utf8' })
  // Lock perms — bearer tokens shouldn't be world-readable.
  try {
    chmodSync(path, 0o600)
  } catch {
    // Best effort; some platforms (e.g. Windows) don't support chmod.
  }
  return path
}
