import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { fetchJSON } from '@/lib/api'
export { CONFIG_KEYS } from '@shared/config-keys'
import { CONFIG_KEYS } from '@shared/config-keys'

// Use relative URLs - works with both Vite dev proxy and production
const API_BASE = ''

interface ConfigResponse {
  key: string
  value: string | number | boolean | string[] | null
  isDefault?: boolean
}

// Default values (client-side fallbacks)
const DEFAULT_PORT = 7777

// Editor app types
export type EditorApp = 'vscode' | 'cursor' | 'windsurf' | 'zed'

export function useConfig(key: string) {
  return useQuery({
    queryKey: ['config', key],
    queryFn: () => fetchJSON<ConfigResponse>(`${API_BASE}/api/config/${key}`),
  })
}

export function usePort() {
  const query = useConfig(CONFIG_KEYS.PORT)

  return {
    ...query,
    data: (query.data?.value as number) ?? DEFAULT_PORT,
    isDefault: query.data?.isDefault ?? true,
  }
}

// Tailscale hostname for this Fulcrum host. Populated by `fulcrum expose`.
export function useTailscaleHostname() {
  const query = useConfig(CONFIG_KEYS.TAILSCALE_HOSTNAME)

  return {
    ...query,
    data: (query.data?.value as string | null) ?? null,
    isDefault: query.data?.isDefault ?? true,
  }
}

// Tailscale IPv4 address for this Fulcrum host. Populated by `fulcrum expose`.
// Preferred over the hostname for browser preview defaults since IPs always
// resolve from any tailnet client.
export function useTailscaleIp() {
  const query = useConfig(CONFIG_KEYS.TAILSCALE_IP)

  return {
    ...query,
    data: (query.data?.value as string | null) ?? null,
    isDefault: query.data?.isDefault ?? true,
  }
}

// Public domain serving this Fulcrum instance through Cloudflare Tunnel.
export function usePublicDomain() {
  const query = useConfig(CONFIG_KEYS.PUBLIC_DOMAIN)

  return {
    ...query,
    data: (query.data?.value as string | null) ?? null,
    isDefault: query.data?.isDefault ?? true,
  }
}

// Read-only: derived from FULCRUM_DIR on server
export function useWorktreeBasePath() {
  const query = useConfig(CONFIG_KEYS.WORKTREE_BASE_PATH)

  return {
    ...query,
    data: (query.data?.value as string) ?? '',
  }
}

// Read-only: derived from FULCRUM_DIR on server
export function useScratchBasePath() {
  const query = useConfig(CONFIG_KEYS.SCRATCH_BASE_PATH)

  return {
    ...query,
    data: (query.data?.value as string) ?? '',
  }
}

// Read-only: system home directory for tilde expansion
export function useHomeDir() {
  const query = useConfig(CONFIG_KEYS.HOME_DIR)

  return {
    ...query,
    data: (query.data?.value as string) ?? '',
  }
}

export function useDefaultGitReposDir() {
  const query = useConfig(CONFIG_KEYS.DEFAULT_GIT_REPOS_DIR)

  return {
    ...query,
    // Default to empty string which will make the browser use home directory
    data: (query.data?.value as string) ?? '',
    isDefault: query.data?.isDefault ?? true,
  }
}

export function useEditorApp() {
  const query = useConfig(CONFIG_KEYS.EDITOR_APP)

  return {
    ...query,
    data: (query.data?.value as EditorApp) ?? 'vscode',
    isDefault: query.data?.isDefault ?? true,
  }
}

export function useEditorHost() {
  const query = useConfig(CONFIG_KEYS.EDITOR_HOST)

  return {
    ...query,
    data: (query.data?.value as string) ?? '',
    isDefault: query.data?.isDefault ?? true,
  }
}

export function useEditorSshPort() {
  const query = useConfig(CONFIG_KEYS.EDITOR_SSH_PORT)

  return {
    ...query,
    data: (query.data?.value as number) ?? 22,
    isDefault: query.data?.isDefault ?? true,
  }
}

export function useGoogleClientId() {
  const query = useConfig(CONFIG_KEYS.GOOGLE_CLIENT_ID)

  return {
    ...query,
    data: (query.data?.value as string) ?? '',
    isDefault: query.data?.isDefault ?? true,
  }
}

export function useGoogleClientSecret() {
  const query = useConfig(CONFIG_KEYS.GOOGLE_CLIENT_SECRET)

  return {
    ...query,
    data: (query.data?.value as string) ?? '',
    isDefault: query.data?.isDefault ?? true,
  }
}

// When a hosted Fulcrum (e.g. Divinci-AI) supplies GOOGLE_CLIENT_ID/SECRET via env,
// users shouldn't see the credential input fields. managedByHost is true only when
// both come from the environment.
interface GoogleOAuthStatus {
  clientId: { provider: 'env' | 'fnox' | 'none'; configured: boolean }
  clientSecret: { provider: 'env' | 'fnox' | 'none'; configured: boolean }
  managedByHost: boolean
}

export function useGoogleOAuthStatus() {
  return useQuery({
    queryKey: ['google-oauth-status'],
    queryFn: () => fetchJSON<GoogleOAuthStatus>(`${API_BASE}/api/config/google-oauth-status`),
  })
}

import type { AgentType } from '@/types'

export function useDefaultAgent() {
  const query = useConfig(CONFIG_KEYS.DEFAULT_AGENT)

  return {
    ...query,
    data: (query.data?.value as AgentType) ?? 'claude',
    isDefault: query.data?.isDefault ?? true,
  }
}

export function useOpencodeModel() {
  const query = useConfig(CONFIG_KEYS.OPENCODE_MODEL)

  return {
    ...query,
    data: (query.data?.value as string | null) ?? null,
    isDefault: query.data?.isDefault ?? true,
  }
}

export function useOpencodeDefaultAgent() {
  const query = useConfig(CONFIG_KEYS.OPENCODE_DEFAULT_AGENT)

  return {
    ...query,
    data: (query.data?.value as string) ?? 'build',
    isDefault: query.data?.isDefault ?? true,
  }
}

export function useOpencodePlanAgent() {
  const query = useConfig(CONFIG_KEYS.OPENCODE_PLAN_AGENT)

  return {
    ...query,
    data: (query.data?.value as string) ?? 'plan',
    isDefault: query.data?.isDefault ?? true,
  }
}

export function useAutoScrollToBottom() {
  const query = useConfig(CONFIG_KEYS.AGENT_AUTO_SCROLL_TO_BOTTOM)

  return {
    ...query,
    // Default to true when value is undefined (preserve existing behavior)
    data: query.data?.value === undefined ? true : Boolean(query.data.value),
    isDefault: query.data?.isDefault ?? true,
  }
}

export function useClaudeCodePath() {
  const query = useConfig(CONFIG_KEYS.CLAUDE_CODE_PATH)

  return {
    ...query,
    data: (query.data?.value as string | null) ?? null,
    isDefault: query.data?.isDefault ?? true,
  }
}

export type Language = 'en' | 'zh' | null

export function useLanguage() {
  const query = useConfig(CONFIG_KEYS.LANGUAGE)

  return {
    ...query,
    data: (query.data?.value as Language) ?? null,
    isDefault: query.data?.isDefault ?? true,
  }
}

export type Theme = 'system' | 'light' | 'dark'

export function useTheme() {
  const query = useConfig(CONFIG_KEYS.THEME)

  return {
    ...query,
    // null means system preference (default)
    data: (query.data?.value as Theme | null) ?? 'system',
    isDefault: query.data?.isDefault ?? true,
  }
}

export function useTimezone() {
  const query = useConfig(CONFIG_KEYS.TIMEZONE)

  return {
    ...query,
    // null means system timezone (default)
    data: (query.data?.value as string | null) ?? null,
    isDefault: query.data?.isDefault ?? true,
  }
}

// Task defaults
export type TaskType = 'worktree' | 'manual' | 'scratch'

const VALID_TASK_TYPES = new Set<string>(['worktree', 'manual', 'scratch'])

export function useDefaultTaskType() {
  const query = useConfig(CONFIG_KEYS.DEFAULT_TASK_TYPE)
  const raw = query.data?.value as string | undefined
  const data = (raw && VALID_TASK_TYPES.has(raw) ? raw : undefined) as TaskType | undefined

  return {
    ...query,
    data: data ?? 'worktree',
    isDefault: query.data?.isDefault ?? true,
  }
}

export function useStartWorktreeTasksImmediately() {
  const query = useConfig(CONFIG_KEYS.START_WORKTREE_TASKS_IMMEDIATELY)

  return {
    ...query,
    // Default to true when value is undefined
    data: query.data?.value === undefined ? true : Boolean(query.data.value),
    isDefault: query.data?.isDefault ?? true,
  }
}

/** @deprecated Use useStartWorktreeTasksImmediately instead */
export const useStartCodeTasksImmediately = useStartWorktreeTasksImmediately

export function useScratchStartupScript() {
  const query = useConfig(CONFIG_KEYS.SCRATCH_STARTUP_SCRIPT)

  return {
    ...query,
    data: (query.data?.value as string | null) ?? null,
    isDefault: query.data?.isDefault ?? true,
  }
}

// Assistant settings
export type AssistantProvider = 'claude' | 'opencode' | 'hermes'
export type AssistantModel = 'opus' | 'sonnet' | 'haiku'
export const ASSISTANT_MODELS: AssistantModel[] = ['opus', 'sonnet', 'haiku']

export function useAssistantProvider() {
  const query = useConfig(CONFIG_KEYS.ASSISTANT_PROVIDER)

  return {
    ...query,
    data: (query.data?.value as AssistantProvider) ?? 'claude',
    isDefault: query.data?.isDefault ?? true,
  }
}

export function useAssistantModel() {
  const query = useConfig(CONFIG_KEYS.ASSISTANT_MODEL)

  return {
    ...query,
    data: query.data ? ((query.data.value as AssistantModel) ?? 'sonnet') : undefined,
    isDefault: query.data?.isDefault ?? true,
  }
}

export function useAssistantObserverModel() {
  const query = useConfig(CONFIG_KEYS.ASSISTANT_OBSERVER_MODEL)

  return {
    ...query,
    data: (query.data?.value as AssistantModel) ?? 'haiku',
    isDefault: query.data?.isDefault ?? true,
  }
}

export function useAssistantObserverProvider() {
  const query = useConfig(CONFIG_KEYS.ASSISTANT_OBSERVER_PROVIDER)

  return {
    ...query,
    data: (query.data?.value as AssistantProvider | null) ?? null,
    isDefault: query.data?.isDefault ?? true,
  }
}

export function useAssistantObserverOpencodeModel() {
  const query = useConfig(CONFIG_KEYS.ASSISTANT_OBSERVER_OPENCODE_MODEL)

  return {
    ...query,
    data: (query.data?.value as string | null) ?? null,
    isDefault: query.data?.isDefault ?? true,
  }
}

export function useAssistantCustomInstructions() {
  const query = useConfig(CONFIG_KEYS.ASSISTANT_CUSTOM_INSTRUCTIONS)

  return {
    ...query,
    data: (query.data?.value as string | null) ?? null,
    isDefault: query.data?.isDefault ?? true,
  }
}

export function useAssistantDocumentsDir() {
  const query = useConfig(CONFIG_KEYS.ASSISTANT_DOCUMENTS_DIR)

  return {
    ...query,
    data: (query.data?.value as string) ?? '~/.fulcrum/documents',
    isDefault: query.data?.isDefault ?? true,
  }
}

// D-16 PR 1: Hermes Agent config hooks
export function useAssistantHermesBaseUrl() {
  const query = useConfig(CONFIG_KEYS.ASSISTANT_HERMES_BASE_URL)
  return {
    ...query,
    data: (query.data?.value as string | null) ?? 'http://localhost:8642',
    isDefault: query.data?.isDefault ?? true,
  }
}

export function useAssistantHermesApiKey() {
  const query = useConfig(CONFIG_KEYS.ASSISTANT_HERMES_API_KEY)
  return {
    ...query,
    data: (query.data?.value as string | null) ?? '',
    isDefault: query.data?.isDefault ?? true,
  }
}

export function useAssistantHermesModel() {
  const query = useConfig(CONFIG_KEYS.ASSISTANT_HERMES_MODEL)
  return {
    ...query,
    data: (query.data?.value as string | null) ?? '',
    isDefault: query.data?.isDefault ?? true,
  }
}

// D-17 PR 1: Divinci RAG pre-flight retrieval hooks
export function useAssistantDivinciEnabled() {
  const query = useConfig(CONFIG_KEYS.ASSISTANT_DIVINCI_ENABLED)
  return {
    ...query,
    data: (query.data?.value as boolean | null) ?? false,
    isDefault: query.data?.isDefault ?? true,
  }
}

export function useAssistantDivinciBaseUrl() {
  const query = useConfig(CONFIG_KEYS.ASSISTANT_DIVINCI_BASE_URL)
  return {
    ...query,
    data: (query.data?.value as string | null) ?? '',
    isDefault: query.data?.isDefault ?? true,
  }
}

export function useAssistantDivinciApiKey() {
  const query = useConfig(CONFIG_KEYS.ASSISTANT_DIVINCI_API_KEY)
  return {
    ...query,
    data: (query.data?.value as string | null) ?? '',
    isDefault: query.data?.isDefault ?? true,
  }
}

export function useAssistantDivinciGroupId() {
  const query = useConfig(CONFIG_KEYS.ASSISTANT_DIVINCI_GROUP_ID)
  return {
    ...query,
    data: (query.data?.value as string | null) ?? '',
    isDefault: query.data?.isDefault ?? true,
  }
}

export function useAssistantDivinciTopK() {
  const query = useConfig(CONFIG_KEYS.ASSISTANT_DIVINCI_TOP_K)
  return {
    ...query,
    data: (query.data?.value as number | null) ?? 8,
    isDefault: query.data?.isDefault ?? true,
  }
}

// D-17 PR 2: per-source collection IDs inside the Divinci Group
export function useAssistantDivinciCollectionFulcrum() {
  const query = useConfig(CONFIG_KEYS.ASSISTANT_DIVINCI_COLLECTION_FULCRUM)
  return {
    ...query,
    data: (query.data?.value as string | null) ?? '',
    isDefault: query.data?.isDefault ?? true,
  }
}

// Ritual settings (under assistant)
export function useAssistantRitualsEnabled() {
  const query = useConfig(CONFIG_KEYS.ASSISTANT_RITUALS_ENABLED)

  return {
    ...query,
    data: Boolean(query.data?.value),
    isDefault: query.data?.isDefault ?? true,
  }
}

export function useAssistantMorningRitualTime() {
  const query = useConfig(CONFIG_KEYS.ASSISTANT_MORNING_RITUAL_TIME)

  return {
    ...query,
    data: (query.data?.value as string) ?? '09:00',
    isDefault: query.data?.isDefault ?? true,
  }
}

export function useAssistantMorningRitualPrompt() {
  const query = useConfig(CONFIG_KEYS.ASSISTANT_MORNING_RITUAL_PROMPT)

  return {
    ...query,
    data: (query.data?.value as string) ?? '',
    isDefault: query.data?.isDefault ?? true,
  }
}

export function useAssistantEveningRitualTime() {
  const query = useConfig(CONFIG_KEYS.ASSISTANT_EVENING_RITUAL_TIME)

  return {
    ...query,
    data: (query.data?.value as string) ?? '18:00',
    isDefault: query.data?.isDefault ?? true,
  }
}

export function useAssistantEveningRitualPrompt() {
  const query = useConfig(CONFIG_KEYS.ASSISTANT_EVENING_RITUAL_PROMPT)

  return {
    ...query,
    data: (query.data?.value as string) ?? '',
    isDefault: query.data?.isDefault ?? true,
  }
}

export function useUpdateConfig() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ key, value }: { key: string; value: string | number | boolean | string[] | null }) =>
      fetchJSON<ConfigResponse>(`${API_BASE}/api/config/${key}`, {
        method: 'PUT',
        body: JSON.stringify({ value }),
      }),
    onSuccess: (_, { key }) => {
      queryClient.invalidateQueries({ queryKey: ['config', key] })
    },
    // D-16 followup: per-mutation error toast. The PUT /api/config/:key route
    // returns 400 "Unknown or read-only config key" for any path not in
    // VALID_SETTING_PATHS — without this, the failure was silent and the
    // operator walked away thinking their save worked.
    onError: (err: Error, { key }) => {
      toast.error(`Failed to save ${key}: ${err.message}`)
    },
  })
}

export function useResetConfig() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (key: string) =>
      fetchJSON<ConfigResponse>(`${API_BASE}/api/config/${key}`, {
        method: 'DELETE',
      }),
    onSuccess: (_, key) => {
      queryClient.invalidateQueries({ queryKey: ['config', key] })
    },
  })
}

// Notification settings types
export interface NotificationSettings {
  enabled: boolean
  toast: { enabled: boolean }
  desktop: { enabled: boolean }
  sound: { enabled: boolean; customSoundFile?: string; silenceTaskMoves?: boolean }
  slack: {
    enabled: boolean
    webhookUrl: string
    useMessagingChannel?: boolean
    // D-15 PR 3: per-event channel routing (messaging-channel mode only)
    eventChannels?: Record<string, string>
    defaultChannel?: string
  }
  discord: { enabled: boolean; webhookUrl: string; useMessagingChannel?: boolean }
  pushover: { enabled: boolean; appToken: string; userKey: string }
  whatsapp: { enabled: boolean }
  telegram: { enabled: boolean }
  gmail: { enabled: boolean; googleAccountId?: string }
  _updatedAt?: number // Timestamp for optimistic locking
}

// Error class for 409 conflicts from stale updates
export class NotificationSettingsConflictError extends Error {
  public readonly current: NotificationSettings

  constructor(message: string, current: NotificationSettings) {
    super(message)
    this.name = 'NotificationSettingsConflictError'
    this.current = current
  }
}

interface NotificationTestResult {
  channel: string
  success: boolean
  error?: string
}

export function useNotificationSettings() {
  return useQuery({
    queryKey: ['config', 'notifications'],
    queryFn: () => fetchJSON<NotificationSettings>(`${API_BASE}/api/config/notifications`),
  })
}

export function useUpdateNotificationSettings() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (settings: Partial<NotificationSettings> & { _updatedAt?: number }) => {
      const res = await fetch(`${API_BASE}/api/config/notifications`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      })

      const body = await res.json()

      if (res.status === 409) {
        // Server rejected the update because another client changed the settings
        throw new NotificationSettingsConflictError(
          body.error || 'Settings changed by another client',
          body.current as NotificationSettings
        )
      }

      if (!res.ok) {
        throw new Error(body.error || 'Failed to update notification settings')
      }

      return body as NotificationSettings
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['config', 'notifications'] })
    },
  })
}

export function useTestNotificationChannel() {
  return useMutation({
    mutationFn: (channel: 'sound' | 'slack' | 'discord' | 'pushover' | 'whatsapp' | 'telegram' | 'gmail') =>
      fetchJSON<NotificationTestResult>(`${API_BASE}/api/config/notifications/test/${channel}`, {
        method: 'POST',
      }),
  })
}

// z.ai settings types
export interface ZAiSettings {
  enabled: boolean
  apiKey: string | null
  haikuModel: string
  sonnetModel: string
  opusModel: string
}

export function useZAiSettings() {
  return useQuery({
    queryKey: ['config', 'z-ai'],
    queryFn: () => fetchJSON<ZAiSettings>(`${API_BASE}/api/config/z-ai`),
  })
}

export function useUpdateZAiSettings() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (settings: Partial<ZAiSettings>) =>
      fetchJSON<ZAiSettings>(`${API_BASE}/api/config/z-ai`, {
        method: 'PUT',
        body: JSON.stringify(settings),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['config', 'z-ai'] })
      // Also invalidate Claude usage since z.ai affects availability
      queryClient.invalidateQueries({ queryKey: ['monitoring', 'claude-usage'] })
    },
  })
}

// Developer mode types and hooks
interface DeveloperModeResponse {
  enabled: boolean
  startedAt: number
}

interface RestartResponse {
  success?: boolean
  message?: string
  error?: string
}

export function useDeveloperMode() {
  return useQuery({
    queryKey: ['config', 'developer-mode'],
    queryFn: () => fetchJSON<DeveloperModeResponse>(`${API_BASE}/api/config/developer-mode`),
    staleTime: Infinity, // Developer mode won't change during runtime
  })
}

export function useRestartFulcrum() {
  return useMutation({
    mutationFn: () =>
      fetchJSON<RestartResponse>(`${API_BASE}/api/config/restart`, {
        method: 'POST',
      }),
  })
}

interface HealthResponse {
  status: string
  version: string | null
  uptime: number
}

export function useFulcrumVersion() {
  const query = useQuery({
    queryKey: ['health'],
    queryFn: () => fetchJSON<HealthResponse>(`${API_BASE}/health`),
    staleTime: Infinity,
  })

  return {
    ...query,
    version: query.data?.version ?? null,
    uptime: query.data?.uptime ?? null,
  }
}

interface VersionCheckResponse {
  currentVersion: string | null
  latestVersion: string | null
  updateAvailable: boolean
  updateCommand: string
  releaseUrl: string
}

const VERSION_CHECK_STALE_TIME = 2 * 60 * 60 * 1000

export function useVersionCheck() {
  return useQuery({
    queryKey: ['version-check'],
    queryFn: () => fetchJSON<VersionCheckResponse>(`${API_BASE}/api/version/check`),
    staleTime: VERSION_CHECK_STALE_TIME,
    refetchOnWindowFocus: false,
  })
}

export function useRefreshVersionCheck() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: () => fetchJSON<VersionCheckResponse>(`${API_BASE}/api/version/check?force=1`),
    onSuccess: (data) => {
      queryClient.setQueryData(['version-check'], data)
    },
  })
}

interface UpdateResponse {
  success: boolean
  message?: string
  error?: string
  fromVersion?: string
  toVersion?: string
}

export function useTriggerUpdate() {
  return useMutation({
    mutationFn: () => fetchJSON<UpdateResponse>(`${API_BASE}/api/version/update`, { method: 'POST' }),
  })
}

// Legacy hook aliases for backward compatibility
/** @deprecated Use useEditorSshPort instead */
export const useSshPort = useEditorSshPort
