import * as os from 'os'
import type { AgentType } from '@shared/types'

// Schema version for settings migration
// IMPORTANT: This must match the major version in package.json
// When bumping schema version, also bump major version with: mise run bump major
export const CURRENT_SCHEMA_VERSION = 5

// Editor app types
export type EditorApp = 'vscode' | 'cursor' | 'windsurf' | 'zed' | 'antigravity'

// Task type for defaults
export type TaskType = 'worktree' | 'manual' | 'scratch'

// Assistant provider and model types.
// D-16 PR 1: 'hermes' added alongside claude (Claude Code SDK, optionally
// z.ai-proxied) and opencode (@opencode-ai/sdk). Hermes is reached via Nous
// Research's hermes-agent CLI exposing an OpenAI-compatible local endpoint.
export type AssistantProvider = 'claude' | 'opencode' | 'hermes'
export type AssistantModel = 'opus' | 'sonnet' | 'haiku'

// Ritual configuration (for assistant daily rituals)
export interface RitualConfig {
  time: string // "09:00" (24h format)
  prompt: string
}

// Email IMAP configuration
export interface ImapConfig {
  host: string
  port: number
  secure: boolean
  user: string
  password: string
}

// Email messaging settings
// Email backend type
export type EmailBackend = 'imap' | 'gmail-api'

export interface EmailSettings {
  enabled: boolean
  backend: EmailBackend
  googleAccountId: string | null
  imap: ImapConfig
  pollIntervalSeconds: number
}

// Slack messaging settings
export interface SlackSettings {
  enabled: boolean
  botToken: string
  appToken: string
}

// Discord messaging settings
export interface DiscordSettings {
  enabled: boolean
  botToken: string
}

// Telegram messaging settings
export interface TelegramSettings {
  enabled: boolean
  botToken: string
}

// CalDAV OAuth tokens (for Google Calendar)
export interface CalDavOAuthTokens {
  accessToken: string
  refreshToken: string
  expiration: number // Unix timestamp in seconds
}

// CalDAV calendar integration settings
// Credential fields are kept for backward compatibility / migration detection
// but are no longer the primary storage (moved to caldavAccounts table)
export interface CalDavSettings {
  enabled: boolean
  syncIntervalMinutes: number
  // Legacy fields - read during migration, no longer written to
  serverUrl: string
  username: string
  password: string
  authType: 'basic' | 'google-oauth'
  googleClientId: string
  googleClientSecret: string
  oauthTokens: CalDavOAuthTokens | null
}

// Channels settings (renamed from MessagingSettings)
export interface ChannelsSettings {
  email: EmailSettings
  slack: SlackSettings
  discord: DiscordSettings
  telegram: TelegramSettings
}

// Nested settings interface
export interface Settings {
  _schemaVersion?: number
  server: {
    port: number
    /** Public domain reaching this Fulcrum server through Cloudflare Tunnel (e.g. "citadel.fulcrum.example.com"). Set by `fulcrum expose`. */
    publicDomain: string | null
    /** Tailscale hostname for this machine (e.g. "citadel.tail-abcd.ts.net"). Used by the frontend to rewrite localhost preview URLs to a tailnet-reachable address. */
    tailscaleHostname: string | null
  }
  paths: {
    defaultGitReposDir: string
  }
  editor: {
    app: EditorApp
    host: string
    sshPort: number
  }
  integrations: {
    cloudflareApiToken: string | null
    cloudflareAccountId: string | null
    /**
     * Cloudflare Access App ID — the app fronting this Fulcrum tenant.
     * D-8 PR 5 reads this to PUT into `/apps/{id}/policies/{id}`.
     * Optional: when null, the invite flow skips the CF call and a
     * Fulcrum invite only stamps the local user row.
     */
    cloudflareAccessAppId: string | null
    /**
     * Cloudflare Access **Policy** ID inside the App above. The "Per-user
     * invites" companion policy created per RUNBOOK §9. The invite flow
     * appends `{ email: { email: ... } }` to that policy's include[].
     */
    cloudflareAccessPolicyId: string | null
    /**
     * D-10 PR 8: Cloudflare Email Sending (beta).
     * When `cloudflareEmailEnabled` is true AND the token + account id +
     * from address are all set, invite emails auto-send via
     * `POST /accounts/{id}/email/sending/send` instead of falling
     * through to the Gmail draft path. Existing draft path remains the
     * default until an operator opts in.
     *
     * `cloudflareEmailFromAddress` is the verified sender address (e.g.
     * `invites@divinci.ai`). The sending domain must be on Cloudflare
     * and have SPF/DKIM records configured via the dashboard before
     * sends will succeed.
     */
    cloudflareEmailEnabled: boolean | null
    cloudflareEmailFromAddress: string | null
    /**
     * D-11 PR 2: shared secret the CF Email Worker uses to authenticate
     * inbound bounce/complaint POSTs to `/api/email-events`. Stored
     * age-encrypted because it's a credential — leak = arbitrary event
     * injection into the audit log. Operator generates a random string
     * once (e.g. `openssl rand -hex 32`), pastes it into both Fulcrum
     * (here) and the Worker's wrangler secret.
     */
    cloudflareEmailIngestSecret: string | null
    googleClientId: string | null
    googleClientSecret: string | null
  }
  agent: {
    defaultAgent: AgentType
    opencodeModel: string | null
    opencodeDefaultAgent: string
    opencodePlanAgent: string
    autoScrollToBottom: boolean
    claudeCodePath: string | null
  }
  tasks: {
    defaultTaskType: TaskType
    startWorktreeTasksImmediately: boolean
    scratchStartupScript: string | null
  }
  appearance: {
    language: 'en' | 'zh' | null
    theme: 'system' | 'light' | 'dark' | null
    timezone: string | null // IANA timezone, null = system default
  }
  assistant: {
    provider: AssistantProvider
    model: AssistantModel
    observerModel: AssistantModel
    /** Provider for observe-only message processing (null = use main provider) */
    observerProvider: AssistantProvider | null
    /** OpenCode model for observer processing (null = use main agent.opencodeModel) */
    observerOpencodeModel: string | null
    customInstructions: string | null
    documentsDir: string
    ritualsEnabled: boolean
    morningRitual: RitualConfig
    eveningRitual: RitualConfig
    /**
     * D-16 PR 1: Hermes Agent integration. Operator runs `hermes gateway`
     * locally (or any OpenAI-compatible relay) and points Fulcrum at the
     * endpoint. Used when assistant.provider === 'hermes'.
     *  - baseUrl: e.g. "http://localhost:8642" (without trailing /v1)
     *  - apiKey: bearer matching API_SERVER_KEY in ~/.hermes/.env
     *  - model: e.g. "Hermes-4-70B" or whatever the configured chain resolves to
     */
    hermes: {
      baseUrl: string | null
      apiKey: string | null
      model: string | null
    }
    /**
     * D-17 PR 1: Divinci RAG pre-flight retrieval. When enabled and the
     * assistant provider is 'hermes', `streamHermesMessage` calls Divinci's
     * `POST /api/v1/rag/context` once per user turn and injects the
     * returned chunks as a system-prompt section so the LLM has indexed
     * context from Slack/Fulcrum/Gmail/Calendar/Drive before deciding
     * which (if any) of its 127 MCP tools to call.
     *
     * Always-off default — operator opts in via Settings → Hermes →
     * Divinci once they've created an API key in Divinci's UI and an
     * indexing Group there.
     */
    divinci: {
      enabled: boolean
      baseUrl: string | null
      apiKey: string | null
      groupId: string | null
      /** topK chunks per retrieval; Divinci server caps at 50. */
      topK: number
    }
  }
  channels: ChannelsSettings
  caldav: CalDavSettings
}

// Default settings with new structure
export const DEFAULT_SETTINGS: Settings = {
  _schemaVersion: CURRENT_SCHEMA_VERSION,
  server: {
    port: 7777,
    publicDomain: null,
    tailscaleHostname: null,
  },
  paths: {
    defaultGitReposDir: os.homedir(),
  },
  editor: {
    app: 'vscode',
    host: '',
    sshPort: 22,
  },
  integrations: {
    cloudflareApiToken: null,
    cloudflareAccountId: null,
    cloudflareAccessAppId: null,
    cloudflareAccessPolicyId: null,
    cloudflareEmailEnabled: null,
    cloudflareEmailFromAddress: null,
    cloudflareEmailIngestSecret: null,
    googleClientId: null,
    googleClientSecret: null,
  },
  agent: {
    defaultAgent: 'claude',
    opencodeModel: null,
    opencodeDefaultAgent: 'build',
    opencodePlanAgent: 'plan',
    autoScrollToBottom: false,
    claudeCodePath: null,
  },
  tasks: {
    defaultTaskType: 'worktree',
    startWorktreeTasksImmediately: true,
    scratchStartupScript: null,
  },
  appearance: {
    language: null,
    theme: null,
    timezone: null,
  },
  assistant: {
    provider: 'claude',
    model: 'sonnet',
    observerModel: 'haiku',
    observerProvider: null,
    observerOpencodeModel: null,
    customInstructions: null,
    hermes: {
      baseUrl: 'http://localhost:8642',
      apiKey: null,
      model: null,
    },
    divinci: {
      enabled: false,
      baseUrl: null,
      apiKey: null,
      groupId: null,
      topK: 8,
    },
    documentsDir: '~/.fulcrum/documents',
    ritualsEnabled: false,
    morningRitual: {
      time: '09:00',
      prompt: `Retrieve the most recent evening ritual plan from memory (search for tags: ritual, plan, evening-ritual).

Review the plan alongside any new messages or events that arrived overnight. Adjust priorities if needed based on new information.

Send the morning briefing via these channels (in order): email, Slack, WhatsApp, Telegram.

Then store the morning review as a memory tagged with: ritual, plan, morning-ritual.`,
    },
    eveningRitual: {
      time: '18:00',
      prompt: `Retrieve the most recent morning ritual plan from memory (search for tags: ritual, plan, morning-ritual) for context on what was planned today.

Review what was accomplished today (tasks completed, messages exchanged, calendar events). Identify unfinished items and any new priorities that emerged.

Create a concrete action plan for tomorrow with prioritized items.

Send the evening summary and tomorrow's plan via these channels (in order): email, Slack, WhatsApp, Telegram.

Then store the action plan as a memory tagged with: ritual, plan, evening-ritual.`,
    },
  },
  channels: {
    email: {
      enabled: false,
      backend: 'imap' as const,
      googleAccountId: null,
      imap: {
        host: '',
        port: 993,
        secure: true,
        user: '',
        password: '',
      },
      pollIntervalSeconds: 30,
    },
    slack: {
      enabled: false,
      botToken: '',
      appToken: '',
    },
    discord: {
      enabled: false,
      botToken: '',
    },
    telegram: {
      enabled: false,
      botToken: '',
    },
  },
  caldav: {
    enabled: false,
    serverUrl: 'https://apidata.googleusercontent.com/caldav/v2/',
    username: '',
    password: '',
    syncIntervalMinutes: 15,
    authType: 'google-oauth',
    googleClientId: '',
    googleClientSecret: '',
    oauthTokens: null,
  },
}

// Old default port for migration detection
export const OLD_DEFAULT_PORT = 3333

// Valid setting paths that can be updated via updateSettingByPath
// This ensures we don't silently write to unknown paths
export const VALID_SETTING_PATHS = new Set([
  'server.port',
  'server.publicDomain',
  'server.tailscaleHostname',
  'paths.defaultGitReposDir',
  'editor.app',
  'editor.host',
  'editor.sshPort',
  'integrations.cloudflareApiToken',
  'integrations.cloudflareAccountId',
  'integrations.cloudflareAccessAppId',
  'integrations.cloudflareAccessPolicyId',
  'integrations.cloudflareEmailEnabled',
  'integrations.cloudflareEmailFromAddress',
  'integrations.cloudflareEmailIngestSecret',
  'integrations.googleClientId',
  'integrations.googleClientSecret',
  'agent.defaultAgent',
  'agent.opencodeModel',
  'agent.opencodeDefaultAgent',
  'agent.opencodePlanAgent',
  'agent.autoScrollToBottom',
  'agent.claudeCodePath',
  'tasks.defaultTaskType',
  'tasks.startWorktreeTasksImmediately',
  'tasks.scratchStartupScript',
  'appearance.language',
  'appearance.theme',
  'appearance.timezone',
  'assistant.provider',
  'assistant.model',
  'assistant.observerModel',
  'assistant.observerProvider',
  'assistant.observerOpencodeModel',
  'assistant.customInstructions',
  'assistant.documentsDir',
  'assistant.ritualsEnabled',
  'assistant.morningRitual.time',
  'assistant.morningRitual.prompt',
  'assistant.eveningRitual.time',
  'assistant.eveningRitual.prompt',
  // D-16 PR 1: Hermes provider config. Without these in VALID_SETTING_PATHS,
  // PUT /api/config/assistant.hermes.* silently 400s ("Unknown or read-only
  // config key") and the save UI shows no error — operators see nothing
  // happen when they click Save.
  'assistant.hermes.baseUrl',
  'assistant.hermes.apiKey',
  'assistant.hermes.model',
  // D-17 PR 1: Divinci RAG pre-flight retrieval
  'assistant.divinci.enabled',
  'assistant.divinci.baseUrl',
  'assistant.divinci.apiKey',
  'assistant.divinci.groupId',
  'assistant.divinci.topK',
  'channels.email.enabled',
  'channels.email.backend',
  'channels.email.googleAccountId',
  'channels.email.imap.host',
  'channels.email.imap.port',
  'channels.email.imap.secure',
  'channels.email.imap.user',
  'channels.email.imap.password',
  'channels.email.pollIntervalSeconds',
  'channels.slack.enabled',
  'channels.slack.botToken',
  'channels.slack.appToken',
  'channels.discord.enabled',
  'channels.discord.botToken',
  'channels.telegram.enabled',
  'channels.telegram.botToken',
  'caldav.enabled',
  'caldav.syncIntervalMinutes',
])

// Legacy flat settings interface for backward compatibility
export interface LegacySettings {
  port: number
  defaultGitReposDir: string
  sshPort: number
  language: 'en' | 'zh' | null
  theme: 'system' | 'light' | 'dark' | null
}

// Notification settings types
export interface SoundNotificationConfig {
  enabled: boolean
  customSoundFile?: string // Path to user-uploaded sound file
  /**
   * D-10 PR 7: when true, the sound is suppressed specifically for
   * `task_status_change` events (i.e. drag-between-kanban-columns and
   * other status flips). Default true because the goat-bleat-on-every-
   * column-move was noisy enough to draw a "remove the noises" request
   * from the operator. Set false to bring the chimes back.
   */
  silenceTaskMoves?: boolean
}

export interface ToastNotificationConfig {
  enabled: boolean
}

export interface DesktopNotificationConfig {
  enabled: boolean
}

/**
 * Notification event types — must mirror NotificationPayload['type'].
 * Used as keys in per-event channel routing.
 */
export type NotificationEventType =
  | 'task_status_change'
  | 'pr_merged'
  | 'plan_complete'
  | 'deployment_success'
  | 'deployment_failed'
  | 'mention'

export interface SlackNotificationConfig {
  enabled: boolean
  webhookUrl?: string
  useMessagingChannel?: boolean // Send via messaging channel instead of webhook
  /**
   * Per-event channel routing (messaging-channel mode only). Map an event type
   * to a Slack channel ID (e.g. "C0123ABC") so each notification posts to the
   * right team channel. Falls back to `defaultChannel` when an event has no
   * explicit mapping; when neither is set, the legacy per-user DM path applies.
   */
  eventChannels?: Partial<Record<NotificationEventType, string>>
  /** Default channel for messaging-channel mode when no event-specific channel is mapped. */
  defaultChannel?: string
}

export interface DiscordNotificationConfig {
  enabled: boolean
  webhookUrl?: string
  useMessagingChannel?: boolean // Send via messaging channel instead of webhook
}

export interface PushoverNotificationConfig {
  enabled: boolean
  appToken?: string
  userKey?: string
}

export interface WhatsAppNotificationConfig {
  enabled: boolean
}

export interface TelegramNotificationConfig {
  enabled: boolean
}

export interface GmailNotificationConfig {
  enabled: boolean
  googleAccountId?: string
}

export interface NotificationSettings {
  enabled: boolean
  toast: ToastNotificationConfig
  desktop: DesktopNotificationConfig
  sound: SoundNotificationConfig
  slack: SlackNotificationConfig
  discord: DiscordNotificationConfig
  pushover: PushoverNotificationConfig
  whatsapp: WhatsAppNotificationConfig
  telegram: TelegramNotificationConfig
  gmail: GmailNotificationConfig
  _updatedAt?: number // Timestamp for optimistic locking - prevents stale tabs from overwriting settings
}

// Result type for updateNotificationSettings - either success or conflict
export type NotificationSettingsUpdateResult =
  | NotificationSettings
  | { conflict: true; current: NotificationSettings }

// z.ai settings interface
export interface ZAiSettings {
  enabled: boolean
  apiKey: string | null
  haikuModel: string
  sonnetModel: string
  opusModel: string
}

// Migration map from old flat keys to new nested paths
export const MIGRATION_MAP: Record<string, string> = {
  port: 'server.port',
  defaultGitReposDir: 'paths.defaultGitReposDir',
  // remoteHost and hostname are handled specially in migrateSettings (need URL construction)
  sshPort: 'editor.sshPort',
  language: 'appearance.language',
  theme: 'appearance.theme',
}
