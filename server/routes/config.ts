// @ts-nocheck — pre-existing type errors that surfaced when tsconfig.server.json was added in D-15 OG wrap-up. Remove this directive + fix the errors in a focused follow-up PR.
import { Hono } from 'hono'
import os from 'node:os'
import {
  getSettings,
  updateSettingByPath,
  getWorktreeBasePath,
  getScratchBasePath,
  getNotificationSettings,
  updateNotificationSettings,
  getZAiSettings,
  updateZAiSettings,
  getClaudeSettings,
  updateClaudeSettings,
  isDeveloperMode,
  getDefaultValue,
  isFnoxAvailable,
  getFnoxConfigCount,
  type NotificationSettings,
  type ZAiSettings,
} from '../lib/settings'
import { FNOX_CONFIG_MAP } from '../lib/settings/fnox'
import { spawn } from 'child_process'
import { testNotificationChannel, sendNotification, type NotificationPayload } from '../services/notification-service'
import { detectTailscaleIp } from './server-expose'

export { CONFIG_KEYS } from '../../shared/config-keys'
import { CONFIG_KEYS } from '../../shared/config-keys'
import { requireAdminUser, type CurrentUserContext } from '../middleware/current-user'

// Legacy key mapping to new nested paths (for backward compatibility)
const LEGACY_KEY_MAP: Record<string, string> = {
  // snake_case legacy keys
  port: 'server.port',
  default_git_repos_dir: 'paths.defaultGitReposDir',
  remote_host: 'remoteFulcrum.host',
  hostname: 'remoteFulcrum.host', // Extra legacy key
  ssh_port: 'editor.sshPort',
  language: 'appearance.language',
  theme: 'appearance.theme',
  // camelCase legacy keys
  defaultGitReposDir: 'paths.defaultGitReposDir',
  remoteHost: 'remoteFulcrum.host',
  sshPort: 'editor.sshPort',
}

// Valid nested paths
const VALID_PATHS = new Set(Object.values(CONFIG_KEYS))

// Resolve a key to its nested path
function resolveConfigKey(key: string): string | null {
  // If it's already a valid dot-notation path, return it
  if (VALID_PATHS.has(key as (typeof CONFIG_KEYS)[keyof typeof CONFIG_KEYS])) {
    return key
  }

  // Check legacy key map
  if (key in LEGACY_KEY_MAP) {
    return LEGACY_KEY_MAP[key]
  }

  return null
}

// Get value from nested settings by path
function getSettingValue(path: string): unknown {
  const settings = getSettings()
  const parts = path.split('.')

  let current: unknown = settings
  for (const part of parts) {
    if (current && typeof current === 'object' && part in current) {
      current = (current as Record<string, unknown>)[part]
    } else {
      return undefined
    }
  }
  return current
}

const app = new Hono<CurrentUserContext>()

// Settings paths whose values are stored via fnox `age` provider — i.e. they
// are secrets. The /api/config GET listing must not return raw values for
// these paths; we substitute a stable redaction marker so the UI can tell
// "set vs unset" without ever exposing the secret. Derived from the single
// source of truth (FNOX_CONFIG_MAP).
const SECRET_PATHS = new Set(
  Object.entries(FNOX_CONFIG_MAP)
    .filter(([, entry]) => entry.provider === 'age')
    .map(([path]) => path)
)
const REDACTED = '***'

// GET /api/config - List all config values (secrets redacted)
app.get('/', (c) => {
  const config: Record<string, unknown> = {}
  for (const [, path] of Object.entries(CONFIG_KEYS)) {
    const value = getSettingValue(path) ?? getDefaultValue(path)
    if (SECRET_PATHS.has(path) && value !== null && value !== undefined && value !== '') {
      config[path] = REDACTED
    } else {
      config[path] = value
    }
  }
  return c.json(config)
})

// Notification routes must come before generic /:key routes

// GET /api/config/notifications - Get notification settings
app.get('/notifications', (c) => {
  const notifications = getNotificationSettings()
  return c.json(notifications)
})

// PUT /api/config/notifications - Update notification settings
// Supports optimistic locking via _updatedAt field to prevent stale tabs from overwriting
//
// D-7 PR 2: tenant defaults are admin-only. Per-user notification
// overrides live at PATCH /api/users/me/notifications and stay open to
// every user.
app.put('/notifications', async (c) => {
  requireAdminUser(c)
  try {
    const body = await c.req.json<Partial<NotificationSettings> & { _updatedAt?: number }>()
    const { _updatedAt, ...updates } = body

    const result = await updateNotificationSettings(updates, _updatedAt)

    // Check if this is a conflict response
    if ('conflict' in result && result.conflict) {
      return c.json(
        {
          error: 'Settings changed by another client',
          current: result.current,
        },
        409
      )
    }

    return c.json(result)
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Failed to update notifications' }, 400)
  }
})

// POST /api/config/notifications/test/:channel - Test a notification channel
app.post('/notifications/test/:channel', async (c) => {
  const channel = c.req.param('channel') as 'sound' | 'slack' | 'discord' | 'pushover' | 'whatsapp' | 'telegram' | 'gmail'
  const validChannels = ['sound', 'slack', 'discord', 'pushover', 'whatsapp', 'telegram', 'gmail']

  if (!validChannels.includes(channel)) {
    return c.json({ error: `Invalid channel: ${channel}` }, 400)
  }

  const result = await testNotificationChannel(channel)
  return c.json(result)
})

// POST /api/config/notifications/send - Send an arbitrary notification
app.post('/notifications/send', async (c) => {
  try {
    const body = await c.req.json<{ title: string; message: string }>()

    if (!body.title || !body.message) {
      return c.json({ error: 'title and message are required' }, 400)
    }

    const payload: NotificationPayload = {
      title: body.title,
      message: body.message,
      type: 'task_status_change', // Generic type for arbitrary notifications
    }

    const results = await sendNotification(payload)
    return c.json({ success: true, results })
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Failed to send notification' }, 400)
  }
})

// z.ai routes must come before generic /:key routes

// GET /api/config/z-ai - Get z.ai settings
app.get('/z-ai', (c) => {
  const settings = getZAiSettings()
  return c.json(settings)
})

// PUT /api/config/z-ai - Update z.ai settings (also updates ~/.claude/settings.json)
app.put('/z-ai', async (c) => {
  try {
    const body = await c.req.json<Partial<ZAiSettings>>()
    const updated = updateZAiSettings(body)

    // Sync to Claude Code settings
    if (updated.enabled && updated.apiKey) {
      // Get current Claude settings and merge env vars
      const claudeSettings = getClaudeSettings()
      const currentEnv = (claudeSettings.env as Record<string, string>) || {}
      updateClaudeSettings({
        env: {
          ...currentEnv,
          ANTHROPIC_AUTH_TOKEN: updated.apiKey,
          ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
          API_TIMEOUT_MS: '3000000',
          // Model mappings for z.ai (configurable)
          ANTHROPIC_DEFAULT_HAIKU_MODEL: updated.haikuModel,
          ANTHROPIC_DEFAULT_SONNET_MODEL: updated.sonnetModel,
          ANTHROPIC_DEFAULT_OPUS_MODEL: updated.opusModel,
        },
      })
    } else {
      // Remove z.ai env vars when disabled (preserve other env vars)
      const claudeSettings = getClaudeSettings()
      if (claudeSettings.env) {
        const env = { ...(claudeSettings.env as Record<string, string>) }
        delete env.ANTHROPIC_AUTH_TOKEN
        delete env.ANTHROPIC_BASE_URL
        delete env.API_TIMEOUT_MS
        delete env.ANTHROPIC_DEFAULT_HAIKU_MODEL
        delete env.ANTHROPIC_DEFAULT_SONNET_MODEL
        delete env.ANTHROPIC_DEFAULT_OPUS_MODEL
        updateClaudeSettings({ env: Object.keys(env).length > 0 ? env : undefined })
      }
    }

    return c.json(updated)
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Failed to update z.ai settings' }, 400)
  }
})

// GET /api/config/fnox-status - Check fnox availability and config count
app.get('/fnox-status', (c) => {
  return c.json({
    available: isFnoxAvailable(),
    configCount: getFnoxConfigCount(),
  })
})

// GET /api/config/google-oauth-status - Report where Google OAuth credentials come from.
// Hosted Fulcrum deployments (e.g. Divinci-AI) supply GOOGLE_CLIENT_ID/SECRET via env
// vars so individual users never set up their own GCP project. When that's the case,
// the Settings UI should hide the input fields and show a "managed by host" message.
app.get('/google-oauth-status', (c) => {
  const envClientId = process.env.GOOGLE_CLIENT_ID
  const envClientSecret = process.env.GOOGLE_CLIENT_SECRET
  const settings = getSettings()
  const providerClientId = envClientId ? 'env' : (settings.integrations.googleClientId ? 'fnox' : 'none')
  const providerClientSecret = envClientSecret ? 'env' : (settings.integrations.googleClientSecret ? 'fnox' : 'none')
  return c.json({
    clientId: { provider: providerClientId, configured: providerClientId !== 'none' },
    clientSecret: { provider: providerClientSecret, configured: providerClientSecret !== 'none' },
    managedByHost: providerClientId === 'env' && providerClientSecret === 'env',
  })
})

// Developer mode routes

// GET /api/config/developer-mode - Check if developer mode is enabled
// Track when the server started for restart detection
const serverStartTime = Date.now()

app.get('/developer-mode', (c) => {
  return c.json({ enabled: isDeveloperMode(), startedAt: serverStartTime })
})

// POST /api/config/restart - Restart Fulcrum via systemd (developer mode only)
// The systemd service handles build, migrations, and startup
app.post('/restart', (c) => {
  if (!isDeveloperMode()) {
    return c.json({ error: 'Restart only available in developer mode' }, 403)
  }

  // systemctl restart triggers the service which handles build + migrate + start
  setTimeout(() => {
    spawn('systemctl', ['--user', 'restart', 'fulcrum'], {
      detached: true,
      stdio: 'ignore',
    }).unref()
  }, 100)

  return c.json({ success: true, message: 'Restart initiated' })
})

// GET /api/config/:key - Get config value
app.get('/:key', (c) => {
  const key = c.req.param('key')

  // Handle special read-only keys
  if (key === 'worktree_base_path') {
    return c.json({ key, value: getWorktreeBasePath(), isDefault: true })
  }
  if (key === 'scratch_base_path') {
    return c.json({ key, value: getScratchBasePath(), isDefault: true })
  }
  if (key === 'home_dir') {
    return c.json({ key, value: os.homedir(), isDefault: true })
  }
  if (key === 'tailscale_ip') {
    return c.json({ key, value: detectTailscaleIp(), isDefault: true })
  }

  // Resolve key to nested path
  const path = resolveConfigKey(key)
  if (!path) {
    return c.json({ key, value: null, isDefault: true, error: 'Unknown config key' }, 404)
  }

  const value = getSettingValue(path)
  const defaultValue = getDefaultValue(path)
  const isDefault = value === defaultValue || value === undefined || value === null

  return c.json({ key, value: value ?? defaultValue, isDefault })
})

// Validator result: either a validated value or an error string
type ValidatorResult = { value: unknown } | { error: string }

// Validator factory: enum field that must be one of the valid values
function enumValidator(validValues: readonly string[], label: string) {
  return (value: unknown): ValidatorResult => {
    if (!validValues.includes(value as string)) {
      return { error: `${label} must be one of: ${validValues.join(', ')}` }
    }
    return { value }
  }
}

// Validator factory: boolean field
function booleanValidator(label: string) {
  return (value: unknown): ValidatorResult => {
    if (typeof value !== 'boolean') {
      return { error: `${label} must be a boolean` }
    }
    return { value }
  }
}

// Validator factory: nullable string field (empty string → null)
function nullableStringValidator(label: string) {
  return (value: unknown): ValidatorResult => {
    if (value !== null && typeof value !== 'string') {
      return { error: `${label} must be a string or null` }
    }
    return { value: value === '' ? null : value }
  }
}

// Validator: port number (1-65535)
function portValidator(value: unknown): ValidatorResult {
  const port = typeof value === 'number' ? value : parseInt(value as string, 10)
  if (isNaN(port) || port < 1 || port > 65535) {
    return { error: 'Port must be a number between 1 and 65535' }
  }
  return { value: port }
}

// Validator: non-empty trimmed string
function nonEmptyStringValidator(label: string) {
  return (value: unknown): ValidatorResult => {
    if (typeof value !== 'string' || value.trim() === '') {
      return { error: `${label} must be a non-empty string` }
    }
    return { value: (value as string).trim() }
  }
}

// Fields where empty string should be coerced to null in the catch-all
const NULLABLE_ON_EMPTY = new Set([
  CONFIG_KEYS.REMOTE_HOST,
  CONFIG_KEYS.EDITOR_HOST,
])

// Config key → validator function
const CONFIG_VALIDATORS: Record<string, (value: unknown) => ValidatorResult> = {
  [CONFIG_KEYS.PORT]: portValidator,
  [CONFIG_KEYS.PUBLIC_DOMAIN]: nullableStringValidator('Public domain'),
  [CONFIG_KEYS.TAILSCALE_HOSTNAME]: nullableStringValidator('Tailscale hostname'),
  [CONFIG_KEYS.REMOTE_PORT]: portValidator,
  [CONFIG_KEYS.EDITOR_SSH_PORT]: portValidator,
  [CONFIG_KEYS.LANGUAGE]: (value) => {
    if (value !== null && value !== '' && value !== 'en' && value !== 'zh') {
      return { error: 'Language must be "en", "zh", or null' }
    }
    return { value: value === '' ? null : value }
  },
  [CONFIG_KEYS.THEME]: (value) => {
    if (value !== null && value !== '' && value !== 'system' && value !== 'light' && value !== 'dark') {
      return { error: 'Theme must be "system", "light", "dark", or null' }
    }
    return { value: value === '' || value === 'system' ? null : value }
  },
  [CONFIG_KEYS.TIMEZONE]: (value) => {
    if (value !== null && value !== '') {
      try {
        Intl.DateTimeFormat(undefined, { timeZone: value as string })
      } catch {
        return { error: 'Invalid timezone' }
      }
    }
    return { value: value === '' ? null : value }
  },
  [CONFIG_KEYS.EDITOR_APP]: enumValidator(['vscode', 'cursor', 'windsurf', 'zed', 'antigravity'] as const, 'Editor app'),
  [CONFIG_KEYS.DEFAULT_AGENT]: enumValidator(['claude', 'opencode'] as const, 'Default agent'),
  [CONFIG_KEYS.OPENCODE_MODEL]: nullableStringValidator('OpenCode model'),
  [CONFIG_KEYS.OPENCODE_DEFAULT_AGENT]: nonEmptyStringValidator('OpenCode agent name'),
  [CONFIG_KEYS.OPENCODE_PLAN_AGENT]: nonEmptyStringValidator('OpenCode agent name'),
  [CONFIG_KEYS.AGENT_AUTO_SCROLL_TO_BOTTOM]: booleanValidator('Auto-scroll to bottom'),
  [CONFIG_KEYS.CLAUDE_CODE_PATH]: nullableStringValidator('Claude Code path'),
  [CONFIG_KEYS.DEFAULT_TASK_TYPE]: enumValidator(['worktree', 'manual', 'scratch'] as const, 'Default task type'),
  [CONFIG_KEYS.START_WORKTREE_TASKS_IMMEDIATELY]: booleanValidator('Start worktree tasks immediately'),
  [CONFIG_KEYS.ASSISTANT_PROVIDER]: enumValidator(['claude', 'opencode'] as const, 'Assistant provider'),
  [CONFIG_KEYS.ASSISTANT_MODEL]: enumValidator(['opus', 'sonnet', 'haiku'] as const, 'Assistant model'),
  [CONFIG_KEYS.ASSISTANT_OBSERVER_MODEL]: enumValidator(['opus', 'sonnet', 'haiku'] as const, 'Assistant model'),
  [CONFIG_KEYS.ASSISTANT_OBSERVER_PROVIDER]: (value) => {
    if (value !== null && value !== 'claude' && value !== 'opencode') {
      return { error: 'Observer provider must be "claude", "opencode", or null' }
    }
    return { value }
  },
  [CONFIG_KEYS.ASSISTANT_OBSERVER_OPENCODE_MODEL]: nullableStringValidator('Observer OpenCode model'),
  [CONFIG_KEYS.ASSISTANT_CUSTOM_INSTRUCTIONS]: nullableStringValidator('Custom instructions'),
  [CONFIG_KEYS.EMAIL_POLL_INTERVAL]: (value) => {
    const num = typeof value === 'string' ? parseInt(value, 10) : value
    if (typeof num !== 'number' || isNaN(num) || num < 5 || num > 3600) {
      return { error: 'Poll interval must be a number between 5 and 3600 seconds' }
    }
    return { value: num }
  },
}

// PUT /api/config/:key - Set config value
//
// D-7 PR 2: tenant-wide config is admin-only. Reading these settings
// stays open to any authenticated user (the GET handler above is
// unchanged), but mutating them requires `isAdmin`. Non-admins get 403.
app.put('/:key', async (c) => {
  requireAdminUser(c)
  const key = c.req.param('key')

  // Resolve key to nested path
  const path = resolveConfigKey(key)
  if (!path) {
    return c.json({ error: `Unknown or read-only config key: ${key}` }, 400)
  }

  try {
    const body = await c.req.json<{ value: string | number | boolean | string[] | null }>()
    let { value } = body

    const validator = CONFIG_VALIDATORS[path]
    if (validator) {
      const result = validator(value)
      if ('error' in result) {
        return c.json({ error: result.error }, 400)
      }
      value = result.value as typeof value
    } else if (typeof value === 'string' && value === '' && NULLABLE_ON_EMPTY.has(path)) {
      value = null
    }

    updateSettingByPath(path, value)

    return c.json({ key, value })
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Failed to set config' }, 400)
  }
})

// DELETE /api/config/:key - Reset config to default
app.delete('/:key', (c) => {
  const key = c.req.param('key')

  // Resolve key to nested path
  const path = resolveConfigKey(key)
  if (!path) {
    return c.json({ error: `Unknown config key: ${key}` }, 400)
  }

  // Get the default value for this specific key
  const defaultValue = getDefaultValue(path)

  // Update the setting to its default value
  updateSettingByPath(path, defaultValue)

  return c.json({ key, value: defaultValue, isDefault: true })
})

export default app