import { useState, useEffect, useRef } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { FilesystemBrowser } from '@/components/ui/filesystem-browser'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { HugeiconsIcon } from '@hugeicons/react'
import { Folder01Icon, RotateLeft01Icon, Tick02Icon, TestTube01Icon, Loading03Icon, Upload04Icon, Delete02Icon, ArrowDown01Icon, Alert02Icon, ArrowUp02Icon, RefreshIcon, Settings05Icon, AiInnovation01Icon, MessageMultiple01Icon, Calendar03Icon } from '@hugeicons/core-free-icons'
import { toast } from 'sonner'
import {
  usePort,
  useDefaultGitReposDir,
  useEditorApp,
  useEditorHost,
  useEditorSshPort,
  useGoogleClientId,
  useGoogleClientSecret,
  useDefaultAgent,
  useOpencodeModel,
  useOpencodeDefaultAgent,
  useOpencodePlanAgent,
  useAutoScrollToBottom,
  useClaudeCodePath,
  useTriggerUpdate,
  useUpdateConfig,
  useResetConfig,
  useNotificationSettings,
  useUpdateNotificationSettings,
  useTestNotificationChannel,
  useZAiSettings,
  useUpdateZAiSettings,
  useDeveloperMode,
  useRestartFulcrum,
  useFulcrumVersion,
  useVersionCheck,
  useRefreshVersionCheck,

  useDefaultTaskType,
  useStartWorktreeTasksImmediately,
  useScratchStartupScript,
  useTimezone,
  useAssistantProvider,
  useAssistantModel,
  useAssistantObserverModel,
  useAssistantObserverProvider,
  useAssistantObserverOpencodeModel,
  useAssistantDocumentsDir,
  useAssistantHermesBaseUrl,
  useAssistantHermesApiKey,
  useAssistantHermesModel,
  useAssistantRitualsEnabled,
  useAssistantMorningRitualTime,
  useAssistantMorningRitualPrompt,
  useAssistantEveningRitualTime,
  useAssistantEveningRitualPrompt,
  NotificationSettingsConflictError,
  CONFIG_KEYS,
  ASSISTANT_MODELS,
  type EditorApp,
  type TaskType,
  type AssistantProvider,
  type AssistantModel,
} from '@/hooks/use-config'
import { useQueryClient } from '@tanstack/react-query'
import { AGENT_DISPLAY_NAMES, type AgentType } from '@/types'
import { ModelPicker } from '@/components/opencode/model-picker'
import { WhatsAppSetup } from '@/components/messaging/whatsapp-setup'
import { DiscordSetup } from '@/components/messaging/discord-setup'
import { TelegramSetup } from '@/components/messaging/telegram-setup'
import { SlackSetup } from '@/components/messaging/slack-setup'
import { EmailSettings } from '@/components/messaging/email-settings'
import { CaldavAccounts } from '@/components/caldav/caldav-accounts'
import { GoogleAccountManager } from '@/components/google/google-account-manager'
import { GitHubAccountManager } from '@/components/github/github-account-manager'
import { MyNotificationPreferences } from '@/components/notifications/my-notification-preferences'
import { MyChannelIdentities } from '@/components/notifications/my-channel-identities'
import { MyUsersAdmin } from '@/components/users/my-users-admin'
import { MyApiTokens } from '@/components/users/my-api-tokens'
import { useCurrentUser } from '@/hooks/use-current-user'
import { useGoogleAccounts } from '@/hooks/use-google'
import { GoogleCalendarSettings } from '@/components/google/google-calendar-settings'
import { CaldavCopyRules } from '@/components/caldav/caldav-copy-rules'
import {
  useDeploymentSettings,
  useUpdateDeploymentSettings,
} from '@/hooks/use-apps'
import { useLanguageSync } from '@/hooks/use-language-sync'
import { useThemeSync } from '@/hooks/use-theme-sync'
import { useOpencodeModels } from '@/hooks/use-opencode-models'

type SettingsTab = 'general' | 'ai' | 'messaging' | 'calendar'

const VALID_TABS: SettingsTab[] = ['general', 'ai', 'messaging', 'calendar']

export const Route = createFileRoute('/settings/')({
  component: SettingsPage,
  validateSearch: (search: Record<string, unknown>): { tab?: SettingsTab } => ({
    tab: VALID_TABS.includes(search.tab as SettingsTab) ? (search.tab as SettingsTab) : undefined,
  }),
})

function SettingsSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="film-grain relative rounded-lg border border-border p-4 pt-6" style={{ background: 'var(--gradient-card)' }}>
      <span className="absolute -top-2.5 left-3 rounded bg-card px-2 text-xs font-medium text-muted-foreground">
        {title}
      </span>
      {children}
    </div>
  )
}

function SettingsPage() {
  const { t } = useTranslation('settings')
  const { t: tc } = useTranslation('common')
  const { tab: urlTab } = Route.useSearch()
  const navigate = Route.useNavigate()

  const activeTab = urlTab || 'general'

  const handleTabChange = (newTab: string) => {
    const validTab = newTab as SettingsTab
    navigate({
      search: (prev) => ({ ...prev, tab: validTab === 'general' ? undefined : validTab }),
      replace: true,
    })
  }
  const { data: port, isLoading: portLoading } = usePort()
  const { data: defaultGitReposDir, isLoading: reposDirLoading } = useDefaultGitReposDir()
  const { data: editorApp, isLoading: editorAppLoading } = useEditorApp()
  const { data: editorHost, isLoading: editorHostLoading } = useEditorHost()
  const { data: editorSshPort, isLoading: editorSshPortLoading } = useEditorSshPort()
  const { data: googleClientId } = useGoogleClientId()
  const { data: googleClientSecret } = useGoogleClientSecret()
  const { data: defaultAgent, isLoading: defaultAgentLoading } = useDefaultAgent()
  const { data: globalOpencodeModel, isLoading: opcodeModelLoading } = useOpencodeModel()
  const { data: globalOpencodeDefaultAgent, isLoading: opcodeDefaultAgentLoading } = useOpencodeDefaultAgent()
  const { data: globalOpencodePlanAgent, isLoading: opencodePlanAgentLoading } = useOpencodePlanAgent()
  const { data: autoScrollToBottom, isLoading: autoScrollLoading } = useAutoScrollToBottom()
  const { data: claudeCodePath } = useClaudeCodePath()
  const { data: notificationSettings, isLoading: notificationsLoading } = useNotificationSettings()
  // D-7 PR 2: gate tenant-default sections (Integrations, tenant
  // Notifications) for non-admins. Per-user prefs and read-only views stay
  // visible to everyone.
  const { data: currentUser } = useCurrentUser()
  const isAdmin = currentUser?.isAdmin ?? false
  const { data: zAiSettings, isLoading: zAiLoading } = useZAiSettings()
  const { data: deploymentSettings, isLoading: deploymentLoading } = useDeploymentSettings()
  const updateDeploymentSettings = useUpdateDeploymentSettings()
  const { data: developerMode } = useDeveloperMode()
  const restartFulcrum = useRestartFulcrum()
  const { savedLanguage, changeLanguage } = useLanguageSync()
  const { theme, changeTheme } = useThemeSync()
  const { data: defaultTaskType, isLoading: taskTypeLoading } = useDefaultTaskType()
  const { data: startWorktreeTasksImmediately, isLoading: startImmediatelyLoading } = useStartWorktreeTasksImmediately()
  const { data: scratchStartupScript, isLoading: scratchStartupScriptLoading } = useScratchStartupScript()
  const { data: timezone, isLoading: timezoneLoading } = useTimezone()
  const { data: assistantProvider, isLoading: assistantProviderLoading } = useAssistantProvider()
  const { data: assistantModel, isLoading: assistantModelLoading } = useAssistantModel()
  const { data: assistantObserverModel, isLoading: assistantObserverModelLoading } = useAssistantObserverModel()
  const { data: assistantObserverProvider } = useAssistantObserverProvider()
  const { data: assistantObserverOpencodeModel } = useAssistantObserverOpencodeModel()
  const { data: assistantDocumentsDir, isLoading: assistantDocumentsDirLoading } = useAssistantDocumentsDir()
  const { data: hermesBaseUrl } = useAssistantHermesBaseUrl()
  const { data: hermesApiKey } = useAssistantHermesApiKey()
  const { data: hermesModel } = useAssistantHermesModel()
  const { data: ritualsEnabled, isLoading: ritualsEnabledLoading } = useAssistantRitualsEnabled()
  const { data: morningRitualTime, isLoading: morningTimeLoading } = useAssistantMorningRitualTime()
  const { data: morningRitualPrompt, isLoading: morningPromptLoading } = useAssistantMorningRitualPrompt()
  const { data: eveningRitualTime, isLoading: eveningTimeLoading } = useAssistantEveningRitualTime()
  const { data: eveningRitualPrompt, isLoading: eveningPromptLoading } = useAssistantEveningRitualPrompt()
  const { installed: opencodeInstalled } = useOpencodeModels()
  const { version } = useFulcrumVersion()
  const { data: versionCheck, isLoading: versionCheckLoading } = useVersionCheck()
  const refreshVersionCheck = useRefreshVersionCheck()
  const triggerUpdate = useTriggerUpdate()
  const updateConfig = useUpdateConfig()
  const resetConfig = useResetConfig()
  const updateNotifications = useUpdateNotificationSettings()
  const updateZAi = useUpdateZAiSettings()
  const testChannel = useTestNotificationChannel()
  const googleAccountsQuery = useGoogleAccounts()
  const gmailEnabledAccounts = (googleAccountsQuery.data ?? []).filter((a) => a.gmailEnabled)
  const queryClient = useQueryClient()

  const [localPort, setLocalPort] = useState('')
  const [localReposDir, setLocalReposDir] = useState('')
  const [localEditorApp, setLocalEditorApp] = useState<EditorApp>('vscode')
  const [localEditorHost, setLocalEditorHost] = useState('')
  const [localEditorSshPort, setLocalEditorSshPort] = useState('')
  const [localGoogleClientId, setLocalGoogleClientId] = useState('')
  const [localGoogleClientSecret, setLocalGoogleClientSecret] = useState('')
  const [localDefaultAgent, setLocalDefaultAgent] = useState<AgentType>('claude')
  const [localOpencodeModel, setLocalOpencodeModel] = useState<string | null>(null)
  const [localOpencodeDefaultAgent, setLocalOpencodeDefaultAgent] = useState<string>('build')
  const [localOpencodePlanAgent, setLocalOpencodePlanAgent] = useState<string>('plan')
  const [localAutoScrollToBottom, setLocalAutoScrollToBottom] = useState(true)
  const [localClaudeCodePath, setLocalClaudeCodePath] = useState<string>('')
  const [reposDirBrowserOpen, setReposDirBrowserOpen] = useState(false)
  const [saved, setSaved] = useState(false)

  // Notification settings local state
  const [notificationsEnabled, setNotificationsEnabled] = useState(true)
  const [toastEnabled, setToastEnabled] = useState(true)
  const [desktopEnabled, setDesktopEnabled] = useState(true)
  const [soundEnabled, setSoundEnabled] = useState(false)
  // D-10 PR 7: per-event control for the kanban-drag-between-columns
  // noise. Default true (silent) — the user explicitly asked for the
  // noises gone. Toggle off to bring the goat bleat back on every move.
  const [silenceTaskMoves, setSilenceTaskMoves] = useState(true)
  const [slackEnabled, setSlackEnabled] = useState(false)
  const [slackWebhook, setSlackWebhook] = useState('')
  const [discordEnabled, setDiscordEnabled] = useState(false)
  const [discordWebhook, setDiscordWebhook] = useState('')
  const [pushoverEnabled, setPushoverEnabled] = useState(false)
  const [pushoverAppToken, setPushoverAppToken] = useState('')
  const [pushoverUserKey, setPushoverUserKey] = useState('')
  const [whatsappNotifEnabled, setWhatsappNotifEnabled] = useState(false)
  const [telegramNotifEnabled, setTelegramNotifEnabled] = useState(false)
  const [gmailNotifEnabled, setGmailNotifEnabled] = useState(false)
  const [gmailNotifAccountId, setGmailNotifAccountId] = useState('')
  const [slackUseMessaging, setSlackUseMessaging] = useState(false)
  const [discordUseMessaging, setDiscordUseMessaging] = useState(false)
  // D-15 PR 3: per-event Slack channel routing. Each event type can target a
  // specific Slack channel; defaultChannel covers anything not explicitly mapped.
  const [slackEventChannels, setSlackEventChannels] = useState<Record<string, string>>({})
  const [slackDefaultChannel, setSlackDefaultChannel] = useState('')

  // z.ai settings local state
  const [zAiEnabled, setZAiEnabled] = useState(false)
  const [zAiApiKey, setZAiApiKey] = useState('')
  const [zAiHaikuModel, setZAiHaikuModel] = useState('glm-4.5-air')
  const [zAiSonnetModel, setZAiSonnetModel] = useState('glm-4.7')
  const [zAiOpusModel, setZAiOpusModel] = useState('glm-4.7')

  // Deployment settings local state
  const [localCloudflareToken, setLocalCloudflareToken] = useState('')
  const [localCloudflareAccountId, setLocalCloudflareAccountId] = useState('')
  // D-9 PR 1: CF Access (per-user invite policy) IDs — non-secret.
  const [localCloudflareAccessAppId, setLocalCloudflareAccessAppId] = useState('')
  const [localCloudflareAccessPolicyId, setLocalCloudflareAccessPolicyId] = useState('')
  // D-10 PR 8: Cloudflare Email Sending opt-in + from address.
  const [localCloudflareEmailEnabled, setLocalCloudflareEmailEnabled] = useState(false)
  const [localCloudflareEmailFromAddress, setLocalCloudflareEmailFromAddress] = useState('')
  // D-11 PR 4: shared secret between the CF Email Worker (parses
  // bounces) and our /api/email-events ingest endpoint.
  const [localCloudflareEmailIngestSecret, setLocalCloudflareEmailIngestSecret] = useState('')

  // Task defaults local state
  const [localDefaultTaskType, setLocalDefaultTaskType] = useState<TaskType>('worktree')
  const [localStartWorktreeTasksImmediately, setLocalStartWorktreeTasksImmediately] = useState(true)
  const [localScratchStartupScript, setLocalScratchStartupScript] = useState<string>('')

  // Timezone local state
  const [localTimezone, setLocalTimezone] = useState<string | null>(null)

  // Assistant settings local state
  const [localAssistantProvider, setLocalAssistantProvider] = useState<AssistantProvider>('claude')
  const [localAssistantModel, setLocalAssistantModel] = useState<AssistantModel>('sonnet')
  const [localAssistantObserverModel, setLocalAssistantObserverModel] = useState<AssistantModel>('haiku')
  const [localAssistantObserverProvider, setLocalAssistantObserverProvider] = useState<AssistantProvider | null>(null)
  const [localAssistantObserverOpencodeModel, setLocalAssistantObserverOpencodeModel] = useState<string | null>(null)
  const [localAssistantDocumentsDir, setLocalAssistantDocumentsDir] = useState<string>('~/.fulcrum/documents')
  const [localHermesBaseUrl, setLocalHermesBaseUrl] = useState<string>('http://localhost:8642')
  const [localHermesApiKey, setLocalHermesApiKey] = useState<string>('')
  const [localHermesModel, setLocalHermesModel] = useState<string>('')

  // Ritual settings local state (under assistant)
  const [localRitualsEnabled, setLocalRitualsEnabled] = useState(false)
  const [localMorningRitualTime, setLocalMorningRitualTime] = useState('09:00')
  const [localMorningRitualPrompt, setLocalMorningRitualPrompt] = useState('')
  const [localEveningRitualTime, setLocalEveningRitualTime] = useState('18:00')
  const [localEveningRitualPrompt, setLocalEveningRitualPrompt] = useState('')

  // Developer mode restart state
  const [isRestarting, setIsRestarting] = useState(false)

  // Custom sound upload state
  const [hasCustomSound, setHasCustomSound] = useState(false)
  const [isUploadingSound, setIsUploadingSound] = useState(false)
  const soundInputRef = useRef<HTMLInputElement>(null)

  // Sync local form state with fetched server values
  useEffect(() => {
    if (port !== undefined) setLocalPort(String(port))
    if (defaultGitReposDir !== undefined) setLocalReposDir(defaultGitReposDir)
    if (editorApp !== undefined) setLocalEditorApp(editorApp)
    if (editorHost !== undefined) setLocalEditorHost(editorHost)
    if (editorSshPort !== undefined) setLocalEditorSshPort(String(editorSshPort))
    if (googleClientId !== undefined) setLocalGoogleClientId(googleClientId)
    if (googleClientSecret !== undefined) setLocalGoogleClientSecret(googleClientSecret)
    if (defaultAgent !== undefined) setLocalDefaultAgent(defaultAgent)
    if (globalOpencodeModel !== undefined) setLocalOpencodeModel(globalOpencodeModel)
    if (globalOpencodeDefaultAgent !== undefined) setLocalOpencodeDefaultAgent(globalOpencodeDefaultAgent)
    if (globalOpencodePlanAgent !== undefined) setLocalOpencodePlanAgent(globalOpencodePlanAgent)
    if (autoScrollToBottom !== undefined) setLocalAutoScrollToBottom(autoScrollToBottom)
    if (claudeCodePath !== undefined) setLocalClaudeCodePath(claudeCodePath ?? '')
  }, [port, defaultGitReposDir, editorApp, editorHost, editorSshPort, googleClientId, googleClientSecret, defaultAgent, globalOpencodeModel, globalOpencodeDefaultAgent, globalOpencodePlanAgent, autoScrollToBottom, claudeCodePath])

  // Sync notification settings
  useEffect(() => {
    if (notificationSettings) {
      setNotificationsEnabled(notificationSettings.enabled)
      setToastEnabled(notificationSettings.toast?.enabled ?? true)
      setDesktopEnabled(notificationSettings.desktop?.enabled ?? true)
      setSoundEnabled(notificationSettings.sound?.enabled ?? false)
      setHasCustomSound(!!notificationSettings.sound?.customSoundFile)
      setSilenceTaskMoves(notificationSettings.sound?.silenceTaskMoves ?? true)
      setSlackEnabled(notificationSettings.slack?.enabled ?? false)
      setSlackWebhook(notificationSettings.slack?.webhookUrl ?? '')
      setDiscordEnabled(notificationSettings.discord?.enabled ?? false)
      setDiscordWebhook(notificationSettings.discord?.webhookUrl ?? '')
      setPushoverEnabled(notificationSettings.pushover?.enabled ?? false)
      setPushoverAppToken(notificationSettings.pushover?.appToken ?? '')
      setPushoverUserKey(notificationSettings.pushover?.userKey ?? '')
      setWhatsappNotifEnabled(notificationSettings.whatsapp?.enabled ?? false)
      setTelegramNotifEnabled(notificationSettings.telegram?.enabled ?? false)
      setGmailNotifEnabled(notificationSettings.gmail?.enabled ?? false)
      setGmailNotifAccountId(notificationSettings.gmail?.googleAccountId ?? '')
      setSlackUseMessaging(notificationSettings.slack?.useMessagingChannel ?? false)
      setDiscordUseMessaging(notificationSettings.discord?.useMessagingChannel ?? false)
      setSlackEventChannels(notificationSettings.slack?.eventChannels ?? {})
      setSlackDefaultChannel(notificationSettings.slack?.defaultChannel ?? '')
    }
  }, [notificationSettings])

  // Sync z.ai settings
  useEffect(() => {
    if (zAiSettings) {
      setZAiEnabled(zAiSettings.enabled)
      setZAiApiKey(zAiSettings.apiKey ?? '')
      setZAiHaikuModel(zAiSettings.haikuModel)
      setZAiSonnetModel(zAiSettings.sonnetModel)
      setZAiOpusModel(zAiSettings.opusModel)
    }
  }, [zAiSettings])

  // Sync deployment settings
  // We sync masked values for display (just like GitHub fields)
  // The save logic filters out masked values to prevent overwriting real values
  useEffect(() => {
    if (deploymentSettings?.cloudflareApiToken !== undefined) {
      setLocalCloudflareToken(deploymentSettings.cloudflareApiToken ?? '')
    }
    if (deploymentSettings?.cloudflareAccountId !== undefined) {
      setLocalCloudflareAccountId(deploymentSettings.cloudflareAccountId ?? '')
    }
    if (deploymentSettings?.cloudflareAccessAppId !== undefined) {
      setLocalCloudflareAccessAppId(deploymentSettings.cloudflareAccessAppId ?? '')
    }
    if (deploymentSettings?.cloudflareAccessPolicyId !== undefined) {
      setLocalCloudflareAccessPolicyId(deploymentSettings.cloudflareAccessPolicyId ?? '')
    }
    if (deploymentSettings?.cloudflareEmailEnabled !== undefined) {
      setLocalCloudflareEmailEnabled(deploymentSettings.cloudflareEmailEnabled ?? false)
    }
    if (deploymentSettings?.cloudflareEmailFromAddress !== undefined) {
      setLocalCloudflareEmailFromAddress(deploymentSettings.cloudflareEmailFromAddress ?? '')
    }
    if (deploymentSettings?.cloudflareEmailIngestSecret !== undefined) {
      setLocalCloudflareEmailIngestSecret(deploymentSettings.cloudflareEmailIngestSecret ?? '')
    }
  }, [deploymentSettings])

  // Sync task defaults
  useEffect(() => {
    if (defaultTaskType !== undefined) setLocalDefaultTaskType(defaultTaskType)
    if (startWorktreeTasksImmediately !== undefined) setLocalStartWorktreeTasksImmediately(startWorktreeTasksImmediately)
    if (scratchStartupScript !== undefined) setLocalScratchStartupScript(scratchStartupScript ?? '')
  }, [defaultTaskType, startWorktreeTasksImmediately, scratchStartupScript])

  // Sync timezone
  useEffect(() => {
    if (timezone !== undefined) setLocalTimezone(timezone)
  }, [timezone])

  // Sync assistant settings
  useEffect(() => {
    if (assistantProvider !== undefined) setLocalAssistantProvider(assistantProvider)
    if (assistantModel !== undefined) setLocalAssistantModel(assistantModel)
    if (assistantObserverModel !== undefined) setLocalAssistantObserverModel(assistantObserverModel)
    if (assistantObserverProvider !== undefined) setLocalAssistantObserverProvider(assistantObserverProvider)
    if (assistantObserverOpencodeModel !== undefined) setLocalAssistantObserverOpencodeModel(assistantObserverOpencodeModel)
    if (assistantDocumentsDir !== undefined) setLocalAssistantDocumentsDir(assistantDocumentsDir)
    if (hermesBaseUrl !== undefined) setLocalHermesBaseUrl(hermesBaseUrl || 'http://localhost:8642')
    if (hermesApiKey !== undefined) setLocalHermesApiKey(hermesApiKey || '')
    if (hermesModel !== undefined) setLocalHermesModel(hermesModel || '')
  }, [assistantProvider, assistantModel, assistantObserverModel, assistantObserverProvider, assistantObserverOpencodeModel, assistantDocumentsDir, hermesBaseUrl, hermesApiKey, hermesModel])

  // Sync ritual settings
  useEffect(() => {
    if (ritualsEnabled !== undefined) setLocalRitualsEnabled(ritualsEnabled)
    if (morningRitualTime !== undefined) setLocalMorningRitualTime(morningRitualTime)
    if (morningRitualPrompt !== undefined) setLocalMorningRitualPrompt(morningRitualPrompt)
    if (eveningRitualTime !== undefined) setLocalEveningRitualTime(eveningRitualTime)
    if (eveningRitualPrompt !== undefined) setLocalEveningRitualPrompt(eveningRitualPrompt)
  }, [
    ritualsEnabled,
    morningRitualTime,
    morningRitualPrompt,
    eveningRitualTime,
    eveningRitualPrompt,
  ])

  const isLoading =
    portLoading || reposDirLoading || editorAppLoading || editorHostLoading || editorSshPortLoading || defaultAgentLoading || opcodeModelLoading || opcodeDefaultAgentLoading || opencodePlanAgentLoading || autoScrollLoading || notificationsLoading || zAiLoading || deploymentLoading || taskTypeLoading || startImmediatelyLoading || scratchStartupScriptLoading || timezoneLoading || assistantProviderLoading || assistantModelLoading || assistantObserverModelLoading || assistantDocumentsDirLoading ||
    ritualsEnabledLoading || morningTimeLoading || morningPromptLoading || eveningTimeLoading || eveningPromptLoading

  const hasZAiChanges = zAiSettings && (
    zAiEnabled !== zAiSettings.enabled ||
    zAiApiKey !== (zAiSettings.apiKey ?? '') ||
    zAiHaikuModel !== zAiSettings.haikuModel ||
    zAiSonnetModel !== zAiSettings.sonnetModel ||
    zAiOpusModel !== zAiSettings.opusModel
  )

  const hasTaskDefaultsChanges =
    localDefaultTaskType !== defaultTaskType ||
    localStartWorktreeTasksImmediately !== startWorktreeTasksImmediately ||
    localScratchStartupScript !== (scratchStartupScript ?? '')

  const hasTimezoneChanges = localTimezone !== timezone

  const hasAssistantChanges =
    localAssistantProvider !== assistantProvider ||
    localAssistantModel !== assistantModel ||
    localAssistantObserverModel !== assistantObserverModel ||
    localAssistantObserverProvider !== assistantObserverProvider ||
    localAssistantObserverOpencodeModel !== assistantObserverOpencodeModel ||
    localAssistantDocumentsDir !== assistantDocumentsDir ||
    localHermesBaseUrl !== hermesBaseUrl ||
    localHermesApiKey !== hermesApiKey ||
    localHermesModel !== hermesModel

  const hasRitualsChanges =
    localRitualsEnabled !== ritualsEnabled ||
    localMorningRitualTime !== morningRitualTime ||
    localMorningRitualPrompt !== morningRitualPrompt ||
    localEveningRitualTime !== eveningRitualTime ||
    localEveningRitualPrompt !== eveningRitualPrompt

  // Check if deployment settings have changed
  // We compare local state against server values
  // Masked values (all dots) are treated as "unchanged from server"
  const hasDeploymentChanges = (() => {
    const serverToken = deploymentSettings?.cloudflareApiToken ?? ''
    const serverAccountId = deploymentSettings?.cloudflareAccountId ?? ''
    const serverAccessAppId = deploymentSettings?.cloudflareAccessAppId ?? ''
    const serverAccessPolicyId = deploymentSettings?.cloudflareAccessPolicyId ?? ''
    const serverCfEmailEnabled = deploymentSettings?.cloudflareEmailEnabled ?? false
    const serverCfEmailFromAddress = deploymentSettings?.cloudflareEmailFromAddress ?? ''
    const serverCfEmailIngestSecret = deploymentSettings?.cloudflareEmailIngestSecret ?? ''
    // Token: changed if different from server AND not a mask (user entered real value)
    const tokenChanged = localCloudflareToken !== serverToken && !localCloudflareToken.match(/^•+$/)
    // Account ID: changed if different from server AND not a mask
    const accountIdChanged = localCloudflareAccountId !== serverAccountId && !localCloudflareAccountId.match(/^•+$/)
    // CF Access IDs aren't masked — plain text round-trip
    const accessAppIdChanged = localCloudflareAccessAppId !== serverAccessAppId
    const accessPolicyIdChanged = localCloudflareAccessPolicyId !== serverAccessPolicyId
    // CF Email — boolean + plain text
    const cfEmailEnabledChanged = localCloudflareEmailEnabled !== serverCfEmailEnabled
    const cfEmailFromChanged = localCloudflareEmailFromAddress !== serverCfEmailFromAddress
    // CF Email ingest secret — masked, same handling as token
    const cfEmailIngestSecretChanged = localCloudflareEmailIngestSecret !== serverCfEmailIngestSecret && !localCloudflareEmailIngestSecret.match(/^•+$/)
    return tokenChanged || accountIdChanged || accessAppIdChanged || accessPolicyIdChanged || cfEmailEnabledChanged || cfEmailFromChanged || cfEmailIngestSecretChanged
  })()

  const hasNotificationChanges = notificationSettings && (
    notificationsEnabled !== notificationSettings.enabled ||
    toastEnabled !== (notificationSettings.toast?.enabled ?? true) ||
    desktopEnabled !== (notificationSettings.desktop?.enabled ?? true) ||
    soundEnabled !== (notificationSettings.sound?.enabled ?? false) ||
    silenceTaskMoves !== (notificationSettings.sound?.silenceTaskMoves ?? true) ||
    slackEnabled !== (notificationSettings.slack?.enabled ?? false) ||
    slackWebhook !== (notificationSettings.slack?.webhookUrl ?? '') ||
    slackUseMessaging !== (notificationSettings.slack?.useMessagingChannel ?? false) ||
    JSON.stringify(slackEventChannels) !== JSON.stringify(notificationSettings.slack?.eventChannels ?? {}) ||
    slackDefaultChannel !== (notificationSettings.slack?.defaultChannel ?? '') ||
    discordEnabled !== (notificationSettings.discord?.enabled ?? false) ||
    discordWebhook !== (notificationSettings.discord?.webhookUrl ?? '') ||
    discordUseMessaging !== (notificationSettings.discord?.useMessagingChannel ?? false) ||
    pushoverEnabled !== (notificationSettings.pushover?.enabled ?? false) ||
    pushoverAppToken !== (notificationSettings.pushover?.appToken ?? '') ||
    pushoverUserKey !== (notificationSettings.pushover?.userKey ?? '') ||
    whatsappNotifEnabled !== (notificationSettings.whatsapp?.enabled ?? false) ||
    telegramNotifEnabled !== (notificationSettings.telegram?.enabled ?? false) ||
    gmailNotifEnabled !== (notificationSettings.gmail?.enabled ?? false) ||
    gmailNotifAccountId !== (notificationSettings.gmail?.googleAccountId ?? '')
  )

  const hasEditorChanges =
    localEditorApp !== editorApp ||
    localEditorHost !== editorHost ||
    localEditorSshPort !== String(editorSshPort)

  const hasAgentChanges = localDefaultAgent !== defaultAgent ||
    localOpencodeModel !== (globalOpencodeModel ?? null) ||
    localOpencodeDefaultAgent !== globalOpencodeDefaultAgent ||
    localOpencodePlanAgent !== globalOpencodePlanAgent ||
    localAutoScrollToBottom !== autoScrollToBottom ||
    localClaudeCodePath !== (claudeCodePath ?? '')

  const hasChanges =
    localPort !== String(port) ||
    localReposDir !== defaultGitReposDir ||
    localGoogleClientId !== googleClientId ||
    localGoogleClientSecret !== googleClientSecret ||
    hasAgentChanges ||
    hasEditorChanges ||
    hasNotificationChanges ||
    hasZAiChanges ||
    hasDeploymentChanges ||
    hasTaskDefaultsChanges ||
    hasTimezoneChanges ||
    hasAssistantChanges ||
    hasRitualsChanges

  const saveGoogleCredentials = async () => {
    const promises: Promise<unknown>[] = []
    if (localGoogleClientId !== googleClientId) {
      promises.push(
        updateConfig.mutateAsync({ key: CONFIG_KEYS.GOOGLE_CLIENT_ID, value: localGoogleClientId || null })
      )
    }
    if (localGoogleClientSecret !== googleClientSecret) {
      promises.push(
        updateConfig.mutateAsync({ key: CONFIG_KEYS.GOOGLE_CLIENT_SECRET, value: localGoogleClientSecret || null })
      )
    }
    if (promises.length > 0) await Promise.all(promises)
  }

  const handleSaveAll = async () => {
    const promises: Promise<unknown>[] = []

    if (localPort !== String(port)) {
      const portNum = parseInt(localPort, 10)
      if (!isNaN(portNum) && portNum >= 1 && portNum <= 65535) {
        promises.push(
          new Promise((resolve) => {
            updateConfig.mutate({ key: CONFIG_KEYS.PORT, value: portNum }, { onSettled: resolve })
          })
        )
      }
    }

    if (localReposDir !== defaultGitReposDir) {
      promises.push(
        new Promise((resolve) => {
          updateConfig.mutate(
            { key: CONFIG_KEYS.DEFAULT_GIT_REPOS_DIR, value: localReposDir },
            { onSettled: resolve }
          )
        })
      )
    }

    // Save editor settings
    if (localEditorApp !== editorApp) {
      promises.push(
        new Promise((resolve) => {
          updateConfig.mutate(
            { key: CONFIG_KEYS.EDITOR_APP, value: localEditorApp },
            { onSettled: resolve }
          )
        })
      )
    }

    if (localEditorHost !== editorHost) {
      promises.push(
        new Promise((resolve) => {
          updateConfig.mutate(
            { key: CONFIG_KEYS.EDITOR_HOST, value: localEditorHost },
            { onSettled: resolve }
          )
        })
      )
    }

    if (localEditorSshPort !== String(editorSshPort)) {
      const portNum = parseInt(localEditorSshPort, 10)
      if (!isNaN(portNum) && portNum >= 1 && portNum <= 65535) {
        promises.push(
          new Promise((resolve) => {
            updateConfig.mutate(
              { key: CONFIG_KEYS.EDITOR_SSH_PORT, value: portNum },
              { onSettled: resolve }
            )
          })
        )
      }
    }

    if (localGoogleClientId !== googleClientId) {
      promises.push(
        new Promise((resolve) => {
          updateConfig.mutate(
            { key: CONFIG_KEYS.GOOGLE_CLIENT_ID, value: localGoogleClientId || null },
            { onSettled: resolve }
          )
        })
      )
    }

    if (localGoogleClientSecret !== googleClientSecret) {
      promises.push(
        new Promise((resolve) => {
          updateConfig.mutate(
            { key: CONFIG_KEYS.GOOGLE_CLIENT_SECRET, value: localGoogleClientSecret || null },
            { onSettled: resolve }
          )
        })
      )
    }

    // Save agent settings
    if (localDefaultAgent !== defaultAgent) {
      promises.push(
        new Promise((resolve) => {
          updateConfig.mutate(
            { key: CONFIG_KEYS.DEFAULT_AGENT, value: localDefaultAgent },
            { onSettled: resolve }
          )
        })
      )
    }

    if (localOpencodeModel !== (globalOpencodeModel ?? null)) {
      promises.push(
        new Promise((resolve) => {
          updateConfig.mutate(
            { key: CONFIG_KEYS.OPENCODE_MODEL, value: localOpencodeModel },
            { onSettled: resolve }
          )
        })
      )
    }

    if (localOpencodeDefaultAgent !== globalOpencodeDefaultAgent) {
      promises.push(
        new Promise((resolve) => {
          updateConfig.mutate(
            { key: CONFIG_KEYS.OPENCODE_DEFAULT_AGENT, value: localOpencodeDefaultAgent },
            { onSettled: resolve }
          )
        })
      )
    }

    if (localOpencodePlanAgent !== globalOpencodePlanAgent) {
      promises.push(
        new Promise((resolve) => {
          updateConfig.mutate(
            { key: CONFIG_KEYS.OPENCODE_PLAN_AGENT, value: localOpencodePlanAgent },
            { onSettled: resolve }
          )
        })
      )
    }

    if (localAutoScrollToBottom !== autoScrollToBottom) {
      promises.push(
        new Promise((resolve) => {
          updateConfig.mutate(
            { key: CONFIG_KEYS.AGENT_AUTO_SCROLL_TO_BOTTOM, value: localAutoScrollToBottom },
            { onSettled: resolve }
          )
        })
      )
    }

    if (localClaudeCodePath !== (claudeCodePath ?? '')) {
      promises.push(
        new Promise((resolve) => {
          updateConfig.mutate(
            { key: CONFIG_KEYS.CLAUDE_CODE_PATH, value: localClaudeCodePath || null },
            { onSettled: resolve }
          )
        })
      )
    }

    // Save notification settings with optimistic locking
    if (hasNotificationChanges) {
      promises.push(
        new Promise((resolve) => {
          updateNotifications.mutate(
            {
              enabled: notificationsEnabled,
              toast: { enabled: toastEnabled },
              desktop: { enabled: desktopEnabled },
              sound: { enabled: soundEnabled, silenceTaskMoves },
              slack: {
                enabled: slackEnabled,
                webhookUrl: slackWebhook,
                useMessagingChannel: slackUseMessaging,
                eventChannels: slackEventChannels,
                defaultChannel: slackDefaultChannel || undefined,
              },
              discord: { enabled: discordEnabled, webhookUrl: discordWebhook, useMessagingChannel: discordUseMessaging },
              pushover: { enabled: pushoverEnabled, appToken: pushoverAppToken, userKey: pushoverUserKey },
              whatsapp: { enabled: whatsappNotifEnabled },
              telegram: { enabled: telegramNotifEnabled },
              gmail: { enabled: gmailNotifEnabled, googleAccountId: gmailNotifAccountId || undefined },
              _updatedAt: notificationSettings?._updatedAt, // Include timestamp for conflict detection
            },
            {
              onSettled: resolve,
              onError: (error) => {
                if (error instanceof NotificationSettingsConflictError) {
                  // Another tab/device changed the settings - refresh to get current state
                  toast.warning(t('notifications.conflictWarning') || 'Settings changed elsewhere - refreshing')
                  queryClient.invalidateQueries({ queryKey: ['config', 'notifications'] })
                }
              },
            }
          )
        })
      )
    }

    // Save z.ai settings
    if (hasZAiChanges) {
      promises.push(
        new Promise((resolve) => {
          updateZAi.mutate(
            {
              enabled: zAiEnabled,
              apiKey: zAiApiKey || null,
              haikuModel: zAiHaikuModel,
              sonnetModel: zAiSonnetModel,
              opusModel: zAiOpusModel,
            },
            { onSettled: resolve }
          )
        })
      )
    }

    // Save task defaults
    if (hasTaskDefaultsChanges) {
      if (localDefaultTaskType !== defaultTaskType) {
        promises.push(
          new Promise((resolve) => {
            updateConfig.mutate(
              { key: CONFIG_KEYS.DEFAULT_TASK_TYPE, value: localDefaultTaskType },
              { onSettled: resolve }
            )
          })
        )
      }
      if (localStartWorktreeTasksImmediately !== startWorktreeTasksImmediately) {
        promises.push(
          new Promise((resolve) => {
            updateConfig.mutate(
              { key: CONFIG_KEYS.START_WORKTREE_TASKS_IMMEDIATELY, value: localStartWorktreeTasksImmediately },
              { onSettled: resolve }
            )
          })
        )
      }
      if (localScratchStartupScript !== (scratchStartupScript ?? '')) {
        promises.push(
          new Promise((resolve) => {
            updateConfig.mutate(
              { key: CONFIG_KEYS.SCRATCH_STARTUP_SCRIPT, value: localScratchStartupScript.trim() || null },
              { onSettled: resolve }
            )
          })
        )
      }
    }

    // Save timezone
    if (hasTimezoneChanges) {
      promises.push(
        new Promise((resolve) => {
          updateConfig.mutate(
            { key: CONFIG_KEYS.TIMEZONE, value: localTimezone },
            { onSettled: resolve }
          )
        })
      )
    }

    // Save assistant settings
    if (hasAssistantChanges) {
      if (localAssistantProvider !== assistantProvider) {
        promises.push(
          new Promise((resolve) => {
            updateConfig.mutate(
              { key: CONFIG_KEYS.ASSISTANT_PROVIDER, value: localAssistantProvider },
              { onSettled: resolve }
            )
          })
        )
      }
      if (localAssistantModel !== assistantModel) {
        promises.push(
          new Promise((resolve) => {
            updateConfig.mutate(
              { key: CONFIG_KEYS.ASSISTANT_MODEL, value: localAssistantModel },
              { onSettled: resolve }
            )
          })
        )
      }
      if (localAssistantObserverModel !== assistantObserverModel) {
        promises.push(
          new Promise((resolve) => {
            updateConfig.mutate(
              { key: CONFIG_KEYS.ASSISTANT_OBSERVER_MODEL, value: localAssistantObserverModel },
              { onSettled: resolve }
            )
          })
        )
      }
      if (localAssistantObserverProvider !== assistantObserverProvider) {
        promises.push(
          new Promise((resolve) => {
            updateConfig.mutate(
              { key: CONFIG_KEYS.ASSISTANT_OBSERVER_PROVIDER, value: localAssistantObserverProvider },
              { onSettled: resolve }
            )
          })
        )
      }
      if (localAssistantObserverOpencodeModel !== assistantObserverOpencodeModel) {
        promises.push(
          new Promise((resolve) => {
            updateConfig.mutate(
              { key: CONFIG_KEYS.ASSISTANT_OBSERVER_OPENCODE_MODEL, value: localAssistantObserverOpencodeModel },
              { onSettled: resolve }
            )
          })
        )
      }
      if (localAssistantDocumentsDir !== assistantDocumentsDir) {
        promises.push(
          new Promise((resolve) => {
            updateConfig.mutate(
              { key: CONFIG_KEYS.ASSISTANT_DOCUMENTS_DIR, value: localAssistantDocumentsDir },
              { onSettled: resolve }
            )
          })
        )
      }
      if (localHermesBaseUrl !== hermesBaseUrl) {
        promises.push(
          new Promise((resolve) => {
            updateConfig.mutate(
              { key: CONFIG_KEYS.ASSISTANT_HERMES_BASE_URL, value: localHermesBaseUrl || null },
              { onSettled: resolve }
            )
          })
        )
      }
      if (localHermesApiKey !== hermesApiKey) {
        promises.push(
          new Promise((resolve) => {
            updateConfig.mutate(
              { key: CONFIG_KEYS.ASSISTANT_HERMES_API_KEY, value: localHermesApiKey || null },
              { onSettled: resolve }
            )
          })
        )
      }
      if (localHermesModel !== hermesModel) {
        promises.push(
          new Promise((resolve) => {
            updateConfig.mutate(
              { key: CONFIG_KEYS.ASSISTANT_HERMES_MODEL, value: localHermesModel || null },
              { onSettled: resolve }
            )
          })
        )
      }
    }

    // Save ritual settings (under assistant)
    if (hasRitualsChanges) {
      if (localRitualsEnabled !== ritualsEnabled) {
        promises.push(
          new Promise((resolve) => {
            updateConfig.mutate(
              { key: CONFIG_KEYS.ASSISTANT_RITUALS_ENABLED, value: localRitualsEnabled },
              { onSettled: resolve }
            )
          })
        )
      }
      if (localMorningRitualTime !== morningRitualTime) {
        promises.push(
          new Promise((resolve) => {
            updateConfig.mutate(
              { key: CONFIG_KEYS.ASSISTANT_MORNING_RITUAL_TIME, value: localMorningRitualTime },
              { onSettled: resolve }
            )
          })
        )
      }
      if (localMorningRitualPrompt !== morningRitualPrompt) {
        promises.push(
          new Promise((resolve) => {
            updateConfig.mutate(
              { key: CONFIG_KEYS.ASSISTANT_MORNING_RITUAL_PROMPT, value: localMorningRitualPrompt },
              { onSettled: resolve }
            )
          })
        )
      }
      if (localEveningRitualTime !== eveningRitualTime) {
        promises.push(
          new Promise((resolve) => {
            updateConfig.mutate(
              { key: CONFIG_KEYS.ASSISTANT_EVENING_RITUAL_TIME, value: localEveningRitualTime },
              { onSettled: resolve }
            )
          })
        )
      }
      if (localEveningRitualPrompt !== eveningRitualPrompt) {
        promises.push(
          new Promise((resolve) => {
            updateConfig.mutate(
              { key: CONFIG_KEYS.ASSISTANT_EVENING_RITUAL_PROMPT, value: localEveningRitualPrompt },
              { onSettled: resolve }
            )
          })
        )
      }
    }

    // Save deployment settings (cloudflare token/account ID + CF Access IDs)
    // Only send values that were actually changed by the user (not masked placeholders)
    if (hasDeploymentChanges) {
      const serverToken = deploymentSettings?.cloudflareApiToken ?? ''
      const serverAccountId = deploymentSettings?.cloudflareAccountId ?? ''
      const serverAccessAppId = deploymentSettings?.cloudflareAccessAppId ?? ''
      const serverAccessPolicyId = deploymentSettings?.cloudflareAccessPolicyId ?? ''
      const serverCfEmailEnabled = deploymentSettings?.cloudflareEmailEnabled ?? false
      const serverCfEmailFromAddress = deploymentSettings?.cloudflareEmailFromAddress ?? ''
      const serverCfEmailIngestSecret = deploymentSettings?.cloudflareEmailIngestSecret ?? ''
      const updates: {
        cloudflareApiToken?: string | null
        cloudflareAccountId?: string | null
        cloudflareAccessAppId?: string | null
        cloudflareAccessPolicyId?: string | null
        cloudflareEmailEnabled?: boolean | null
        cloudflareEmailFromAddress?: string | null
        cloudflareEmailIngestSecret?: string | null
      } = {}

      // Only send token if it changed and is not a mask (user entered real value)
      if (localCloudflareToken !== serverToken && !localCloudflareToken.match(/^•+$/)) {
        updates.cloudflareApiToken = localCloudflareToken || null
      }

      // Only send account ID if it changed and is not a mask
      if (localCloudflareAccountId !== serverAccountId && !localCloudflareAccountId.match(/^•+$/)) {
        updates.cloudflareAccountId = localCloudflareAccountId || null
      }

      // CF Access IDs are plain text — no mask handling.
      if (localCloudflareAccessAppId !== serverAccessAppId) {
        updates.cloudflareAccessAppId = localCloudflareAccessAppId || null
      }
      if (localCloudflareAccessPolicyId !== serverAccessPolicyId) {
        updates.cloudflareAccessPolicyId = localCloudflareAccessPolicyId || null
      }
      // CF Email — boolean + plain text.
      if (localCloudflareEmailEnabled !== serverCfEmailEnabled) {
        updates.cloudflareEmailEnabled = localCloudflareEmailEnabled
      }
      if (localCloudflareEmailFromAddress !== serverCfEmailFromAddress) {
        updates.cloudflareEmailFromAddress = localCloudflareEmailFromAddress || null
      }
      // CF Email ingest secret — masked round-trip like the token
      if (localCloudflareEmailIngestSecret !== serverCfEmailIngestSecret && !localCloudflareEmailIngestSecret.match(/^•+$/)) {
        updates.cloudflareEmailIngestSecret = localCloudflareEmailIngestSecret || null
      }

      if (Object.keys(updates).length > 0) {
        promises.push(
          new Promise((resolve) => {
            updateDeploymentSettings.mutate(updates, { onSettled: resolve })
          })
        )
      }
    }

    await Promise.all(promises)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const handleResetPort = () => {
    resetConfig.mutate(CONFIG_KEYS.PORT, {
      onSuccess: (data) => {
        if (data.value !== null) setLocalPort(String(data.value))
      },
    })
  }

  const handleResetReposDir = () => {
    resetConfig.mutate(CONFIG_KEYS.DEFAULT_GIT_REPOS_DIR, {
      onSuccess: (data) => {
        if (data.value) setLocalReposDir(String(data.value))
      },
    })
  }

  const handleResetEditorApp = () => {
    resetConfig.mutate(CONFIG_KEYS.EDITOR_APP, {
      onSuccess: (data) => {
        if (data.value !== null && data.value !== undefined)
          setLocalEditorApp(data.value as EditorApp)
      },
    })
  }

  const handleResetEditorHost = () => {
    resetConfig.mutate(CONFIG_KEYS.EDITOR_HOST, {
      onSuccess: (data) => {
        setLocalEditorHost(data.value !== null && data.value !== undefined ? String(data.value) : '')
      },
    })
  }

  const handleResetEditorSshPort = () => {
    resetConfig.mutate(CONFIG_KEYS.EDITOR_SSH_PORT, {
      onSuccess: (data) => {
        if (data.value !== null && data.value !== undefined)
          setLocalEditorSshPort(String(data.value))
      },
    })
  }

  const handleResetDefaultAgent = () => {
    resetConfig.mutate(CONFIG_KEYS.DEFAULT_AGENT, {
      onSuccess: (data) => {
        setLocalDefaultAgent((data.value as AgentType) ?? 'claude')
      },
    })
  }

  const handleResetOpencodeModel = () => {
    resetConfig.mutate(CONFIG_KEYS.OPENCODE_MODEL, {
      onSuccess: (data) => {
        setLocalOpencodeModel(data.value !== null && data.value !== undefined ? String(data.value) : null)
      },
    })
  }

  const handleResetOpencodeDefaultAgent = () => {
    resetConfig.mutate(CONFIG_KEYS.OPENCODE_DEFAULT_AGENT, {
      onSuccess: (data) => {
        setLocalOpencodeDefaultAgent((data.value as string) ?? 'build')
      },
    })
  }

  const handleResetOpencodePlanAgent = () => {
    resetConfig.mutate(CONFIG_KEYS.OPENCODE_PLAN_AGENT, {
      onSuccess: (data) => {
        setLocalOpencodePlanAgent((data.value as string) ?? 'plan')
      },
    })
  }

  const handleTestChannel = async (channel: 'sound' | 'slack' | 'discord' | 'pushover' | 'whatsapp' | 'telegram' | 'gmail') => {
    testChannel.mutate(channel, {
      onSuccess: (result) => {
        if (result.success) {
          toast.success(t('notifications.testSuccess', { channel }))
        } else {
          toast.error(t('notifications.testFailed', { channel, error: result.error }))
        }
      },
      onError: (error) => {
        toast.error(t('notifications.testFailed', { channel, error: error.message }))
      },
    })
  }

  const handleSoundUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    setIsUploadingSound(true)
    try {
      const formData = new FormData()
      formData.append('file', file)

      const res = await fetch('/api/uploads/sound', {
        method: 'POST',
        body: formData,
      })

      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Upload failed')
      }

      setHasCustomSound(true)
      toast.success(t('notifications.soundUploaded'))
    } catch (err) {
      toast.error(t('notifications.soundUploadFailed', { error: err instanceof Error ? err.message : 'Unknown error' }))
    } finally {
      setIsUploadingSound(false)
      // Reset input so same file can be uploaded again
      if (soundInputRef.current) {
        soundInputRef.current.value = ''
      }
    }
  }

  const handleDeleteCustomSound = async () => {
    try {
      const res = await fetch('/api/uploads/sound', { method: 'DELETE' })
      if (!res.ok) throw new Error('Delete failed')
      setHasCustomSound(false)
      toast.success(t('notifications.soundDeleted'))
    } catch {
      toast.error(t('notifications.soundDeleteFailed'))
    }
  }

  const handleUpdate = () => {
    triggerUpdate.mutate(undefined, {
      onSuccess: () => {
        toast.info(t('version.updateStarted'))
      },
      onError: () => {
        toast.error(t('version.updateFailed'))
      },
    })
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-hidden">
        <Tabs value={activeTab} onValueChange={handleTabChange} className="flex h-full flex-col">
          <div className="film-grain relative flex shrink-0 items-center border-b border-border px-4" style={{ background: 'var(--gradient-header)' }}>
            <TabsList className="justify-start gap-1 bg-transparent rounded-none h-10">
              <TabsTrigger value="general" className="gap-1.5 data-[state=active]:bg-muted">
                <HugeiconsIcon icon={Settings05Icon} size={14} strokeWidth={2} />
                <span className="max-sm:hidden">{t('tabs.general')}</span>
              </TabsTrigger>
              <TabsTrigger value="ai" className="gap-1.5 data-[state=active]:bg-muted">
                <HugeiconsIcon icon={AiInnovation01Icon} size={14} strokeWidth={2} />
                <span className="max-sm:hidden">{t('tabs.ai')}</span>
              </TabsTrigger>
              <TabsTrigger value="messaging" className="gap-1.5 data-[state=active]:bg-muted">
                <HugeiconsIcon icon={MessageMultiple01Icon} size={14} strokeWidth={2} />
                <span className="max-sm:hidden">{t('tabs.messaging')}</span>
              </TabsTrigger>
              <TabsTrigger value="calendar" className="gap-1.5 data-[state=active]:bg-muted">
                <HugeiconsIcon icon={Calendar03Icon} size={14} strokeWidth={2} />
                <span className="max-sm:hidden">{t('tabs.calendar')}</span>
              </TabsTrigger>
            </TabsList>
            <div className="ml-auto flex items-center gap-2">
              {version && <span className="text-xs font-mono text-muted-foreground">v{version}</span>}
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 text-muted-foreground hover:text-foreground"
                onClick={() => refreshVersionCheck.mutate()}
                disabled={versionCheckLoading || refreshVersionCheck.isPending}
                title={t('version.refresh')}
                aria-label={t('version.refresh')}
              >
                <HugeiconsIcon
                  icon={RefreshIcon}
                  size={14}
                  strokeWidth={2}
                  className={refreshVersionCheck.isPending ? "animate-spin" : ""}
                />
              </Button>
              {versionCheckLoading && (
                <div className="flex h-6 items-center gap-1.5 rounded-full bg-muted/50 px-2.5 text-xs text-muted-foreground">
                  <HugeiconsIcon icon={Loading03Icon} size={12} strokeWidth={2} className="animate-spin" />
                  <span>{t('version.checkingForUpdates')}</span>
                </div>
              )}
              {versionCheck?.updateAvailable && versionCheck.latestVersion && (
                <div className="flex items-center gap-2">
                  <span className="flex h-6 items-center gap-1.5 rounded-full bg-primary/10 px-2.5 text-xs font-medium text-primary border border-primary/20">
                    <HugeiconsIcon icon={ArrowUp02Icon} size={12} strokeWidth={2.5} />
                    {t('version.updateAvailable', { version: versionCheck.latestVersion })}
                  </span>
                  <Button
                    size="sm"
                    className="h-6 gap-1.5 px-2.5 text-xs"
                    disabled={triggerUpdate.isPending || triggerUpdate.isSuccess}
                    onClick={handleUpdate}
                  >
                    {triggerUpdate.isPending ? (
                      <>
                        <HugeiconsIcon icon={Loading03Icon} size={12} strokeWidth={2} className="animate-spin" />
                        {t('version.updating')}
                      </>
                    ) : (
                      <>
                        <HugeiconsIcon icon={ArrowUp02Icon} size={12} strokeWidth={2} />
                        {t('version.update')}
                      </>
                    )}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 gap-1.5 px-2.5 text-xs"
                    onClick={() => {
                      if (versionCheck.releaseUrl) {
                        window.open(versionCheck.releaseUrl, '_blank')
                      }
                    }}
                  >
                    {t('version.viewRelease')}
                  </Button>
                </div>
              )}
              {!versionCheckLoading && versionCheck && !versionCheck.updateAvailable && (
                <span className="flex h-6 items-center gap-1.5 rounded-full bg-green-500/10 px-2.5 text-xs font-medium text-green-600 dark:text-green-400 border border-green-500/20">
                  <HugeiconsIcon icon={Tick02Icon} size={12} strokeWidth={2.5} />
                  {t('version.upToDate')}
                </span>
              )}
            </div>
          </div>

          <TabsContent value="general" className="flex-1 overflow-auto p-6">
            <div className="mx-auto max-w-5xl space-y-4">

              {/* Appearance */}
              <SettingsSection title={t('sections.appearance')}>
                <div className="space-y-4">
                  {/* Language */}
                  <div className="space-y-1">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                      <label className="text-sm text-muted-foreground sm:w-32 sm:shrink-0">
                        {t('fields.language.label')}
                      </label>
                      <Select
                        value={savedLanguage ?? 'auto'}
                        onValueChange={(v) => changeLanguage(v === 'auto' ? null : (v as 'en' | 'zh'))}
                      >
                        <SelectTrigger className="w-40">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="auto">{t('fields.language.options.auto')}</SelectItem>
                          <SelectItem value="en">{t('fields.language.options.en')}</SelectItem>
                          <SelectItem value="zh">{t('fields.language.options.zh')}</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <p className="text-xs text-muted-foreground sm:ml-32 sm:pl-2">
                      {t('fields.language.description')}
                    </p>
                  </div>

                  {/* Theme */}
                  <div className="space-y-1">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                      <label className="text-sm text-muted-foreground sm:w-32 sm:shrink-0">
                        {t('fields.theme.label')}
                      </label>
                      <Select
                        value={theme ?? 'system'}
                        onValueChange={(v) => changeTheme(v as 'system' | 'light' | 'dark')}
                      >
                        <SelectTrigger className="w-40">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="system">{t('fields.theme.options.system')}</SelectItem>
                          <SelectItem value="light">{t('fields.theme.options.light')}</SelectItem>
                          <SelectItem value="dark">{t('fields.theme.options.dark')}</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <p className="text-xs text-muted-foreground sm:ml-32 sm:pl-2">
                      {t('fields.theme.description')}
                    </p>
                  </div>

                  {/* Timezone */}
                  <div className="space-y-1">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                      <label className="text-sm text-muted-foreground sm:w-32 sm:shrink-0">
                        {t('fields.timezone.label')}
                      </label>
                      <Select
                        value={localTimezone ?? 'auto'}
                        onValueChange={(v) => setLocalTimezone(v === 'auto' ? null : v)}
                      >
                        <SelectTrigger className="w-56">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="auto">{t('fields.timezone.options.auto')}</SelectItem>
                          <SelectItem value="America/New_York">America/New_York (EST/EDT)</SelectItem>
                          <SelectItem value="America/Chicago">America/Chicago (CST/CDT)</SelectItem>
                          <SelectItem value="America/Denver">America/Denver (MST/MDT)</SelectItem>
                          <SelectItem value="America/Los_Angeles">America/Los_Angeles (PST/PDT)</SelectItem>
                          <SelectItem value="America/Anchorage">America/Anchorage (AKST/AKDT)</SelectItem>
                          <SelectItem value="Pacific/Honolulu">Pacific/Honolulu (HST)</SelectItem>
                          <SelectItem value="Europe/London">Europe/London (GMT/BST)</SelectItem>
                          <SelectItem value="Europe/Paris">Europe/Paris (CET/CEST)</SelectItem>
                          <SelectItem value="Europe/Berlin">Europe/Berlin (CET/CEST)</SelectItem>
                          <SelectItem value="Asia/Tokyo">Asia/Tokyo (JST)</SelectItem>
                          <SelectItem value="Asia/Shanghai">Asia/Shanghai (CST)</SelectItem>
                          <SelectItem value="Asia/Singapore">Asia/Singapore (SGT)</SelectItem>
                          <SelectItem value="Australia/Sydney">Australia/Sydney (AEST/AEDT)</SelectItem>
                          <SelectItem value="Pacific/Auckland">Pacific/Auckland (NZST/NZDT)</SelectItem>
                          <SelectItem value="UTC">UTC</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <p className="text-xs text-muted-foreground sm:ml-32 sm:pl-2">
                      {t('fields.timezone.description')}
                    </p>
                  </div>

                </div>
              </SettingsSection>

              {/* Editor + Integrations side by side */}
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {/* Editor */}
                <SettingsSection title={t('sections.editor')}>
                  <div className="space-y-4">
                    {/* Editor App */}
                    <div className="space-y-1">
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                        <label className="text-sm text-muted-foreground sm:w-20 sm:shrink-0">
                          {t('fields.editor.app.label')}
                        </label>
                        <div className="flex items-center gap-2">
                          <Select
                            value={localEditorApp}
                            onValueChange={(v) => setLocalEditorApp(v as EditorApp)}
                          >
                            <SelectTrigger className="w-32">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="vscode">VS Code</SelectItem>
                              <SelectItem value="cursor">Cursor</SelectItem>
                              <SelectItem value="windsurf">Windsurf</SelectItem>
                              <SelectItem value="zed">Zed</SelectItem>
                              <SelectItem value="antigravity">Antigravity</SelectItem>
                            </SelectContent>
                          </Select>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-muted-foreground hover:text-foreground"
                            onClick={handleResetEditorApp}
                            disabled={isLoading || resetConfig.isPending}
                            title={tc('buttons.reset')}
                          >
                            <HugeiconsIcon icon={RotateLeft01Icon} size={14} strokeWidth={2} />
                          </Button>
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground sm:ml-20 sm:pl-2">
                        {t('fields.editor.app.description')}
                      </p>
                    </div>

                    {/* Editor Host */}
                    <div className="space-y-1">
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                        <label className="text-sm text-muted-foreground sm:w-20 sm:shrink-0">
                          {t('fields.editor.host.label')}
                        </label>
                        <div className="flex flex-1 items-center gap-2">
                          <Input
                            value={localEditorHost}
                            onChange={(e) => setLocalEditorHost(e.target.value)}
                            placeholder={t('fields.editor.host.placeholder')}
                            disabled={isLoading}
                            className="flex-1 font-mono text-sm"
                          />
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-muted-foreground hover:text-foreground"
                            onClick={handleResetEditorHost}
                            disabled={isLoading || resetConfig.isPending}
                            title={tc('buttons.reset')}
                          >
                            <HugeiconsIcon icon={RotateLeft01Icon} size={14} strokeWidth={2} />
                          </Button>
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground sm:ml-20 sm:pl-2">
                        {t('fields.editor.host.description')}
                      </p>
                    </div>

                    {/* SSH Port */}
                    <div className="space-y-1">
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                        <label className="text-sm text-muted-foreground sm:w-20 sm:shrink-0">
                          {t('fields.editor.sshPort.label')}
                        </label>
                        <div className="flex items-center gap-2">
                          <Input
                            type="number"
                            min={1}
                            max={65535}
                            value={localEditorSshPort}
                            onChange={(e) => setLocalEditorSshPort(e.target.value)}
                            placeholder="22"
                            disabled={isLoading}
                            className="w-20 font-mono text-sm"
                          />
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-muted-foreground hover:text-foreground"
                            onClick={handleResetEditorSshPort}
                            disabled={isLoading || resetConfig.isPending}
                            title={tc('buttons.reset')}
                          >
                            <HugeiconsIcon icon={RotateLeft01Icon} size={14} strokeWidth={2} />
                          </Button>
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground sm:ml-20 sm:pl-2">
                        {t('fields.editor.sshPort.description')}
                      </p>
                    </div>
                  </div>
                </SettingsSection>

                {/* Members — D-8 PR 2. Admin-only. Lists every user in
                    this tenant and lets an admin invite / promote /
                    demote. Pre-provisioned rows still need CF Access edge
                    admission until D-8 PR 5 closes that gap. */}
                {isAdmin && (
                  <SettingsSection title="Members">
                    <MyUsersAdmin />
                  </SettingsSection>
                )}

                {/* API tokens — D-8 PR 3a. Self-managed bearer tokens for
                    the CLI; not admin-gated. Plaintext shown once on
                    mint. */}
                <SettingsSection title="API tokens">
                  <MyApiTokens />
                </SettingsSection>

                {/* Integrations — D-7 PR 2: GitHubAccountManager is
                    per-user (visible to everyone). Cloudflare + Google
                    OAuth client are tenant defaults — admin-only. */}
                <SettingsSection title={t('sections.integrations')}>
                  <div className="space-y-4">
                    {/* GitHub Accounts (D-6 PR 2 — per-user) */}
                    <GitHubAccountManager />

                    {!isAdmin && (
                      <p className="text-xs text-muted-foreground border-t pt-3">
                        Tenant-wide integrations (Cloudflare, Google OAuth
                        client) are managed by your tenant admin.
                      </p>
                    )}

                    {isAdmin && <>

                    {/* Cloudflare API Token */}
                    <div className="space-y-1">
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                        <label className="text-sm text-muted-foreground sm:w-20 sm:shrink-0">
                          {t('fields.cloudflare.label')}
                        </label>
                        <div className="flex flex-1 items-center gap-2">
                          <div className="relative flex-1">
                            <Input
                              type="password"
                              value={localCloudflareToken}
                              onChange={(e) => setLocalCloudflareToken(e.target.value)}
                              placeholder={t('fields.cloudflare.placeholder')}
                              disabled={isLoading}
                              className="flex-1 pr-8 font-mono text-sm"
                            />
                            {!!deploymentSettings?.cloudflareApiToken && (
                              <div className="absolute right-2 top-1/2 -translate-y-1/2 text-green-500">
                                <HugeiconsIcon icon={Tick02Icon} size={14} strokeWidth={2} />
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground sm:ml-20 sm:pl-2">
                        {t('fields.cloudflare.description')}
                      </p>
                    </div>

                    {/* Cloudflare Account ID */}
                    <div className="space-y-1">
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                        <label className="text-sm text-muted-foreground sm:w-20 sm:shrink-0">
                          Account ID
                        </label>
                        <div className="flex flex-1 items-center gap-2">
                          <div className="relative flex-1">
                            <Input
                              type="password"
                              value={localCloudflareAccountId}
                              onChange={(e) => setLocalCloudflareAccountId(e.target.value)}
                              placeholder="CF Account ID"
                              disabled={isLoading}
                              className="flex-1 pr-8 font-mono text-sm"
                            />
                            {!!deploymentSettings?.cloudflareAccountId && (
                              <div className="absolute right-2 top-1/2 -translate-y-1/2 text-green-500">
                                <HugeiconsIcon icon={Tick02Icon} size={14} strokeWidth={2} />
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground sm:ml-20 sm:pl-2">
                        Required for Cloudflare Tunnel. Find in your dashboard URL: dash.cloudflare.com/{'<account_id>'}/...
                      </p>
                    </div>

                    {/* CF Access App ID — D-9 PR 1 */}
                    <div className="space-y-1">
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                        <label className="text-sm text-muted-foreground sm:w-20 sm:shrink-0">
                          Access App
                        </label>
                        <div className="flex flex-1 items-center gap-2">
                          <div className="relative flex-1">
                            <Input
                              type="text"
                              value={localCloudflareAccessAppId}
                              onChange={(e) => setLocalCloudflareAccessAppId(e.target.value)}
                              placeholder="8c9dfd22-595d-4bd1-869b-7dca77d56cf2"
                              disabled={isLoading}
                              className="flex-1 pr-8 font-mono text-sm"
                            />
                            {!!deploymentSettings?.cloudflareAccessAppId && (
                              <div className="absolute right-2 top-1/2 -translate-y-1/2 text-green-500">
                                <HugeiconsIcon icon={Tick02Icon} size={14} strokeWidth={2} />
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground sm:ml-20 sm:pl-2">
                        Cloudflare Access App ID fronting this tenant. The invite flow updates this app's policy include list.
                      </p>
                    </div>

                    {/* CF Access Policy ID — D-9 PR 1 */}
                    <div className="space-y-1">
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                        <label className="text-sm text-muted-foreground sm:w-20 sm:shrink-0">
                          Access Policy
                        </label>
                        <div className="flex flex-1 items-center gap-2">
                          <div className="relative flex-1">
                            <Input
                              type="text"
                              value={localCloudflareAccessPolicyId}
                              onChange={(e) => setLocalCloudflareAccessPolicyId(e.target.value)}
                              placeholder="UUID of the per-user invites policy"
                              disabled={isLoading}
                              className="flex-1 pr-8 font-mono text-sm"
                            />
                            {!!deploymentSettings?.cloudflareAccessPolicyId && (
                              <div className="absolute right-2 top-1/2 -translate-y-1/2 text-green-500">
                                <HugeiconsIcon icon={Tick02Icon} size={14} strokeWidth={2} />
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground sm:ml-20 sm:pl-2">
                        The companion policy created per RUNBOOK §9. When both IDs are set, admin invites also add the email to this policy's include list.
                      </p>
                    </div>

                    {/* D-10 PR 8 — Cloudflare Email Sending (beta) */}
                    <div className="space-y-1 border-t pt-3">
                      <div className="flex items-center gap-2">
                        <Switch
                          checked={localCloudflareEmailEnabled}
                          onCheckedChange={setLocalCloudflareEmailEnabled}
                          disabled={isLoading}
                        />
                        <label className="text-sm text-muted-foreground">
                          Auto-send invite emails via Cloudflare (beta)
                        </label>
                      </div>
                      <p className="text-xs text-muted-foreground sm:pl-12">
                        When on, admin invites send the email immediately via Cloudflare Email Sending instead of creating a Gmail draft. Requires a verified sender domain on Cloudflare + the API token's <code>Email Sending: Edit</code> permission.
                      </p>
                    </div>

                    <div className="space-y-1">
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                        <label className="text-sm text-muted-foreground sm:w-20 sm:shrink-0">
                          From
                        </label>
                        <div className="flex flex-1 items-center gap-2">
                          <div className="relative flex-1">
                            <Input
                              type="email"
                              value={localCloudflareEmailFromAddress}
                              onChange={(e) => setLocalCloudflareEmailFromAddress(e.target.value)}
                              placeholder="invites@divinci.ai"
                              disabled={isLoading || !localCloudflareEmailEnabled}
                              className="flex-1 pr-8 font-mono text-sm"
                            />
                            {!!deploymentSettings?.cloudflareEmailFromAddress && (
                              <div className="absolute right-2 top-1/2 -translate-y-1/2 text-green-500">
                                <HugeiconsIcon icon={Tick02Icon} size={14} strokeWidth={2} />
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground sm:ml-20 sm:pl-2">
                        Verified sender address — must be on a domain whose DNS is on Cloudflare with SPF/DKIM/DMARC published (set up via the dashboard).
                      </p>
                    </div>

                    {/* D-11 PR 4 — bounce-receiver shared secret. The
                        Worker (deploy/saas/workers/email-bounce-router)
                        sends this same value as `X-Webhook-Secret` when
                        POSTing parsed bounce events back to our
                        /api/email-events endpoint. */}
                    <div className="space-y-1">
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                        <label className="text-sm text-muted-foreground sm:w-20 sm:shrink-0">
                          Bounce secret
                        </label>
                        <div className="flex flex-1 items-center gap-2">
                          <div className="relative flex-1">
                            <Input
                              type="password"
                              value={localCloudflareEmailIngestSecret}
                              onChange={(e) => setLocalCloudflareEmailIngestSecret(e.target.value)}
                              placeholder="Paste output of: openssl rand -hex 32"
                              disabled={isLoading}
                              className="flex-1 pr-8 font-mono text-sm"
                            />
                            {!!deploymentSettings?.cloudflareEmailIngestSecret && (
                              <div className="absolute right-2 top-1/2 -translate-y-1/2 text-green-500">
                                <HugeiconsIcon icon={Tick02Icon} size={14} strokeWidth={2} />
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground sm:ml-20 sm:pl-2">
                        Shared with the CF Email Worker. Same value goes in <code>wrangler secret put FULCRUM_INGEST_SECRET</code>. Worker uses it to POST parsed bounces back to <code>/api/email-events</code>. See <code>deploy/saas/workers/email-bounce-router/README.md</code> for the full setup.
                      </p>
                    </div>

                    {/* Google */}
                    <GoogleAccountManager
                      clientId={localGoogleClientId}
                      onClientIdChange={setLocalGoogleClientId}
                      clientIdSaved={!!googleClientId}
                      clientSecret={localGoogleClientSecret}
                      onClientSecretChange={setLocalGoogleClientSecret}
                      clientSecretSaved={!!googleClientSecret}
                      isLoading={isLoading}
                      onSaveCredentials={saveGoogleCredentials}
                    />
                    </>}
                  </div>
                </SettingsSection>
              </div>

              {/* Task Defaults */}
              <SettingsSection title={t('sections.tasks')}>
                <div className="space-y-4">
                  {/* Default task type */}
                  <div className="space-y-1">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                      <label className="text-sm text-muted-foreground sm:w-32 sm:shrink-0">
                        {t('fields.tasks.defaultType.label')}
                      </label>
                      <Select
                        value={localDefaultTaskType}
                        onValueChange={(v) => setLocalDefaultTaskType(v as TaskType)}
                      >
                        <SelectTrigger className="w-40">
                          <SelectValue>
                            {(value: string) => t(`fields.tasks.defaultType.options.${value}`) || value}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="worktree">{t('fields.tasks.defaultType.options.worktree')}</SelectItem>
                          <SelectItem value="manual">{t('fields.tasks.defaultType.options.manual')}</SelectItem>
                          <SelectItem value="scratch">{t('fields.tasks.defaultType.options.scratch')}</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <p className="text-xs text-muted-foreground sm:ml-32 sm:pl-2">
                      {t('fields.tasks.defaultType.description')}
                    </p>
                  </div>

                  {/* Start worktree tasks immediately */}
                  <div className="space-y-1">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                      <label className="text-sm text-muted-foreground sm:w-32 sm:shrink-0">
                        {t('fields.tasks.startImmediately.label')}
                      </label>
                      <Switch
                        checked={localStartWorktreeTasksImmediately}
                        onCheckedChange={setLocalStartWorktreeTasksImmediately}
                        disabled={isLoading}
                      />
                    </div>
                    <p className="text-xs text-muted-foreground sm:ml-32 sm:pl-2">
                      {t('fields.tasks.startImmediately.description')}
                    </p>
                  </div>

                  {/* Scratch startup script */}
                  <div className="space-y-1">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
                      <label className="text-sm text-muted-foreground sm:w-32 sm:shrink-0 sm:pt-2">
                        {t('fields.tasks.scratchStartupScript.label')}
                      </label>
                      <Textarea
                        value={localScratchStartupScript}
                        onChange={(e) => setLocalScratchStartupScript(e.target.value)}
                        placeholder="export ENV_VAR=value"
                        className="font-mono text-xs min-h-[60px]"
                        rows={2}
                        disabled={isLoading}
                      />
                    </div>
                    <p className="text-xs text-muted-foreground sm:ml-32 sm:pl-2">
                      {t('fields.tasks.scratchStartupScript.description')}
                    </p>
                  </div>
                </div>
              </SettingsSection>

              {/* Server */}
              <SettingsSection title={t('sections.server')}>
                <div className="space-y-1">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                    <label className="text-sm text-muted-foreground sm:w-32 sm:shrink-0">{t('fields.port.label')}</label>
                    <div className="flex items-center gap-2">
                      <Input
                        type="number"
                        min={1}
                        max={65535}
                        value={localPort}
                        onChange={(e) => setLocalPort(e.target.value)}
                        placeholder="7777"
                        disabled={isLoading}
                        className="w-24 font-mono text-sm"
                      />
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-muted-foreground hover:text-foreground"
                        onClick={handleResetPort}
                        disabled={isLoading || resetConfig.isPending}
                        title={tc('buttons.reset')}
                      >
                        <HugeiconsIcon icon={RotateLeft01Icon} size={14} strokeWidth={2} />
                      </Button>
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground sm:ml-32 sm:pl-2">
                    {t('fields.port.description')}
                  </p>
                </div>
              </SettingsSection>

              {/* Paths */}
              <SettingsSection title={t('sections.paths')}>
                <div className="space-y-1">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                    <label className="text-sm text-muted-foreground sm:w-32 sm:shrink-0">
                      {t('fields.gitReposDir.label')}
                    </label>
                    <div className="flex flex-1 items-center gap-2">
                      <Input
                        value={localReposDir}
                        onChange={(e) => setLocalReposDir(e.target.value)}
                        placeholder="~/projects"
                        disabled={isLoading}
                        className="flex-1 font-mono text-sm"
                      />
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-muted-foreground hover:text-foreground"
                        onClick={() => setReposDirBrowserOpen(true)}
                        disabled={isLoading}
                        title={tc('buttons.browse')}
                      >
                        <HugeiconsIcon icon={Folder01Icon} size={14} strokeWidth={2} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-muted-foreground hover:text-foreground"
                        onClick={handleResetReposDir}
                        disabled={isLoading || resetConfig.isPending}
                        title={tc('buttons.reset')}
                      >
                        <HugeiconsIcon icon={RotateLeft01Icon} size={14} strokeWidth={2} />
                      </Button>
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground sm:ml-32 sm:pl-2">
                    {t('fields.gitReposDir.description')}
                  </p>
                </div>
              </SettingsSection>

              {/* Developer (only visible in developer mode) */}
              {developerMode?.enabled && (
                <SettingsSection title={t('sections.developer')}>
                  <div className="space-y-1">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <div className="flex-1">
                        <p className="text-sm text-muted-foreground">
                          {t('developer.restartDescription')}
                        </p>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          // Save current server start time to detect actual restart
                          const originalStartTime = developerMode?.startedAt
                          setIsRestarting(true)
                          restartFulcrum.mutate(undefined, {
                            onSuccess: () => {
                              // Poll until server restarts (new startedAt) or timeout
                              const pollForServer = async () => {
                                const maxAttempts = 120 // 60 seconds max (build can take a while)
                                for (let i = 0; i < maxAttempts; i++) {
                                  await new Promise((r) => setTimeout(r, 500))
                                  try {
                                    const res = await fetch('/api/config/developer-mode')
                                    if (res.ok) {
                                      const data = await res.json()
                                      // Only reload if server actually restarted (new start time)
                                      if (data.startedAt !== originalStartTime) {
                                        window.location.reload()
                                        return
                                      }
                                      // Same start time means build failed, old instance still running
                                    }
                                  } catch {
                                    // Server not ready yet, keep polling
                                  }
                                }
                                // Timeout - build likely failed, show error
                                setIsRestarting(false)
                                toast.error(t('developer.restartFailed'), {
                                  description: t('developer.checkLogs'),
                                })
                              }
                              pollForServer()
                            },
                            onError: (error) => {
                              setIsRestarting(false)
                              toast.error(t('developer.restartFailed'), {
                                description: error.message,
                              })
                            },
                          })
                        }}
                        disabled={restartFulcrum.isPending || isRestarting}
                        className="shrink-0 gap-2"
                      >
                        {(restartFulcrum.isPending || isRestarting) && (
                          <HugeiconsIcon
                            icon={Loading03Icon}
                            size={14}
                            strokeWidth={2}
                            className="animate-spin"
                          />
                        )}
                        {isRestarting ? t('developer.restarting') : t('developer.restartButton')}
                      </Button>
                    </div>
                  </div>
                </SettingsSection>
              )}
            </div>
          </TabsContent>

          <TabsContent value="ai" className="flex-1 overflow-auto p-6">
            <div className="mx-auto max-w-5xl space-y-4">
              {/* Agent */}
              <SettingsSection title={t('sections.agent')}>
                <div className="space-y-4">
                  <div className="space-y-1">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                      <label className="text-sm text-muted-foreground sm:w-32 sm:shrink-0">
                        {t('fields.agent.default.label')}
                      </label>
                      <div className="flex items-center gap-2">
                        <Select
                          value={localDefaultAgent}
                          onValueChange={(v) => setLocalDefaultAgent(v as AgentType)}
                        >
                          <SelectTrigger className="w-40">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {(Object.keys(AGENT_DISPLAY_NAMES) as AgentType[]).map((agent) => (
                              <SelectItem key={agent} value={agent}>
                                {AGENT_DISPLAY_NAMES[agent]}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-muted-foreground hover:text-foreground"
                          onClick={handleResetDefaultAgent}
                          disabled={isLoading || resetConfig.isPending}
                          title={tc('buttons.reset')}
                        >
                          <HugeiconsIcon icon={RotateLeft01Icon} size={14} strokeWidth={2} />
                        </Button>
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground sm:ml-32 sm:pl-2">
                      {t('fields.agent.default.description')}
                    </p>
                  </div>

                  <div className="space-y-1">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                      <label className="text-sm text-muted-foreground sm:w-32 sm:shrink-0">
                        {t('fields.agent.opencodeModel.label')}
                      </label>
                      <div className="flex flex-1 items-center gap-2">
                        <ModelPicker
                          value={localOpencodeModel}
                          onChange={setLocalOpencodeModel}
                          placeholder={t('fields.agent.opencodeModel.placeholder')}
                          className="w-64"
                        />
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-muted-foreground hover:text-foreground"
                          onClick={handleResetOpencodeModel}
                          disabled={isLoading || resetConfig.isPending}
                          title={tc('buttons.reset')}
                        >
                          <HugeiconsIcon icon={RotateLeft01Icon} size={14} strokeWidth={2} />
                        </Button>
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground sm:ml-32 sm:pl-2">
                      {t('fields.agent.opencodeModel.description')}
                    </p>
                  </div>
                </div>

                {/* OpenCode Agent Names - Advanced (collapsed by default) */}
                <Collapsible className="mt-4 space-y-1">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
                    <CollapsibleTrigger className="group flex cursor-pointer items-center gap-1.5 text-left text-sm text-muted-foreground transition-colors hover:text-foreground sm:w-32 sm:shrink-0">
                      <HugeiconsIcon
                        icon={ArrowDown01Icon}
                        size={12}
                        strokeWidth={2}
                        className="shrink-0 transition-transform duration-200 group-data-[state=open]:rotate-180"
                      />
                      <span>{t('fields.agent.advancedAgentNames.label')}</span>
                    </CollapsibleTrigger>
                    <p className="text-xs text-muted-foreground sm:pt-0.5">
                      {t('fields.agent.advancedAgentNames.description')}
                    </p>
                  </div>

                  <CollapsibleContent className="space-y-4 pt-2 sm:ml-32 sm:pl-2">
                    <div className="flex items-start gap-2 rounded-md border border-amber-500/20 bg-amber-500/10 p-3">
                      <HugeiconsIcon
                        icon={Alert02Icon}
                        size={16}
                        strokeWidth={2}
                        className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400"
                      />
                      <p className="text-xs text-amber-600 dark:text-amber-400">
                        {t('fields.agent.advancedAgentNames.warning')}
                      </p>
                    </div>

                    <div className="space-y-2">
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                        <label className="text-sm text-muted-foreground sm:w-32 sm:shrink-0">
                          {t('fields.agent.opencodeDefaultAgent.label')}
                        </label>
                        <div className="flex flex-1 items-center gap-2">
                          <Input
                            value={localOpencodeDefaultAgent ?? 'build'}
                            onChange={(e) => setLocalOpencodeDefaultAgent(e.target.value)}
                            placeholder="build"
                            disabled={isLoading}
                            className="font-mono text-sm"
                          />
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-muted-foreground hover:text-foreground"
                            onClick={handleResetOpencodeDefaultAgent}
                            disabled={isLoading || resetConfig.isPending}
                            title={tc('buttons.reset')}
                          >
                            <HugeiconsIcon icon={RotateLeft01Icon} size={14} strokeWidth={2} />
                          </Button>
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground sm:ml-32 sm:pl-2">
                        {t('fields.agent.opencodeDefaultAgent.description')}
                      </p>
                    </div>

                    <div className="space-y-2">
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                        <label className="text-sm text-muted-foreground sm:w-32 sm:shrink-0">
                          {t('fields.agent.opencodePlanAgent.label')}
                        </label>
                        <div className="flex flex-1 items-center gap-2">
                          <Input
                            value={localOpencodePlanAgent ?? 'plan'}
                            onChange={(e) => setLocalOpencodePlanAgent(e.target.value)}
                            placeholder="plan"
                            disabled={isLoading}
                            className="font-mono text-sm"
                          />
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-muted-foreground hover:text-foreground"
                            onClick={handleResetOpencodePlanAgent}
                            disabled={isLoading || resetConfig.isPending}
                            title={tc('buttons.reset')}
                          >
                            <HugeiconsIcon icon={RotateLeft01Icon} size={14} strokeWidth={2} />
                          </Button>
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground sm:ml-32 sm:pl-2">
                        {t('fields.agent.opencodePlanAgent.description')}
                      </p>
                    </div>
                  </CollapsibleContent>
                </Collapsible>

                {/* Auto-scroll to bottom */}
                <div className="mt-4 space-y-1 border-t border-border pt-4">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                    <label className="text-sm text-muted-foreground sm:w-32 sm:shrink-0">
                      {t('fields.agent.autoScrollToBottom.label')}
                    </label>
                    <Switch
                      checked={localAutoScrollToBottom}
                      onCheckedChange={setLocalAutoScrollToBottom}
                      disabled={isLoading}
                    />
                  </div>
                  <p className="text-xs text-muted-foreground sm:ml-32 sm:pl-2">
                    {t('fields.agent.autoScrollToBottom.description')}
                  </p>
                </div>

                {/* Claude Code Path */}
                <div className="mt-4 space-y-1 border-t border-border pt-4">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                    <label className="text-sm text-muted-foreground sm:w-32 sm:shrink-0">
                      {t('fields.agent.claudeCodePath.label')}
                    </label>
                    <Input
                      value={localClaudeCodePath}
                      onChange={(e) => setLocalClaudeCodePath(e.target.value)}
                      placeholder={t('fields.agent.claudeCodePath.placeholder')}
                      className="flex-1"
                      disabled={isLoading}
                    />
                  </div>
                  <p className="text-xs text-muted-foreground sm:ml-32 sm:pl-2">
                    {t('fields.agent.claudeCodePath.description')}
                  </p>
                </div>
              </SettingsSection>

              {/* AI Assistant */}
              <SettingsSection title={t('sections.assistant')}>
                <div className="space-y-4">
                  {/* Provider & model settings — 2-column on md+ */}
                  <div className="grid gap-4 md:grid-cols-2 md:gap-x-8">
                    {/* Left column: Main provider */}
                    <div className="space-y-4">
                      {/* Default provider */}
                      <div className="space-y-1">
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                          <label className="text-sm text-muted-foreground sm:w-32 sm:shrink-0">
                            {t('fields.assistant.provider.label')}
                          </label>
                          <Select
                            value={localAssistantProvider}
                            onValueChange={(v) => setLocalAssistantProvider(v as AssistantProvider)}
                          >
                            <SelectTrigger className="w-48">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="claude">Claude</SelectItem>
                              {opencodeInstalled && (
                                <SelectItem value="opencode">OpenCode</SelectItem>
                              )}
                              <SelectItem value="hermes">Hermes</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        <p className="text-xs text-muted-foreground sm:ml-32 sm:pl-2">
                          {t('fields.assistant.provider.description')}
                        </p>
                      </div>

                      {/* Claude model (shown when provider is Claude) */}
                      {localAssistantProvider === 'claude' && (
                        <div className="space-y-1">
                          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                            <label className="text-sm text-muted-foreground sm:w-32 sm:shrink-0">
                              {t('fields.assistant.model.label')}
                            </label>
                            <Select
                              value={localAssistantModel}
                              onValueChange={(v) => setLocalAssistantModel(v as AssistantModel)}
                            >
                              <SelectTrigger className="w-48">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {ASSISTANT_MODELS.map((model) => (
                                  <SelectItem key={model} value={model}>
                                    {t(`fields.assistant.model.options.${model}`)}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          <p className="text-xs text-muted-foreground sm:ml-32 sm:pl-2">
                            {t('fields.assistant.model.description')}
                          </p>
                        </div>
                      )}

                      {/* OpenCode model (shown when provider is OpenCode) */}
                      {localAssistantProvider === 'opencode' && (
                        <div className="space-y-1">
                          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                            <label className="text-sm text-muted-foreground sm:w-32 sm:shrink-0">
                              {t('fields.assistant.opencodeModel.label')}
                            </label>
                            <ModelPicker
                              value={globalOpencodeModel}
                              onChange={(v) => {
                                updateConfig.mutate({ key: CONFIG_KEYS.OPENCODE_MODEL, value: v })
                              }}
                              placeholder={t('fields.assistant.opencodeModel.placeholder')}
                              className="w-64"
                            />
                          </div>
                          <p className="text-xs text-muted-foreground sm:ml-32 sm:pl-2">
                            {t('fields.assistant.opencodeModel.description')}
                          </p>
                        </div>
                      )}

                      {/* Hermes config (shown when provider is Hermes) */}
                      {localAssistantProvider === 'hermes' && (
                        <div className="space-y-3 rounded-md border border-border bg-muted/30 p-3">
                          <p className="text-xs text-muted-foreground">
                            Run <code className="rounded bg-muted px-1">hermes gateway</code> on the same host as Fulcrum. Set <code className="rounded bg-muted px-1">API_SERVER_ENABLED=true</code> and <code className="rounded bg-muted px-1">API_SERVER_KEY</code> in <code className="rounded bg-muted px-1">~/.hermes/.env</code>, then paste them here.
                          </p>
                          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                            <label className="text-sm text-muted-foreground sm:w-32 sm:shrink-0">
                              Base URL
                            </label>
                            <Input
                              type="text"
                              value={localHermesBaseUrl}
                              onChange={(e) => setLocalHermesBaseUrl(e.target.value)}
                              placeholder="http://localhost:8642"
                              className="flex-1 font-mono text-xs"
                            />
                          </div>
                          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                            <label className="text-sm text-muted-foreground sm:w-32 sm:shrink-0">
                              API Key
                            </label>
                            <Input
                              type="password"
                              value={localHermesApiKey}
                              onChange={(e) => setLocalHermesApiKey(e.target.value)}
                              placeholder="API_SERVER_KEY from ~/.hermes/.env"
                              className="flex-1 font-mono text-xs"
                            />
                          </div>
                          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                            <label className="text-sm text-muted-foreground sm:w-32 sm:shrink-0">
                              Model
                            </label>
                            <Input
                              type="text"
                              value={localHermesModel}
                              onChange={(e) => setLocalHermesModel(e.target.value)}
                              placeholder="Hermes-4-70B"
                              className="flex-1 font-mono text-xs"
                            />
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Right column: Observer */}
                    <div className="space-y-4">
                      {/* Observer provider */}
                      <div className="space-y-1">
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                          <label className="text-sm text-muted-foreground sm:w-32 sm:shrink-0">
                            {t('fields.assistant.observerProvider.label')}
                          </label>
                          <Select
                            value={localAssistantObserverProvider ?? 'same-as-main'}
                            onValueChange={(v) => setLocalAssistantObserverProvider(v === 'same-as-main' ? null : v as AssistantProvider)}
                          >
                            <SelectTrigger className="w-48">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="same-as-main">
                                {t('fields.assistant.observerProvider.options.default')}
                              </SelectItem>
                              <SelectItem value="claude">Claude</SelectItem>
                              {opencodeInstalled && (
                                <SelectItem value="opencode">OpenCode</SelectItem>
                              )}
                              <SelectItem value="hermes">Hermes</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        <p className="text-xs text-muted-foreground sm:ml-32 sm:pl-2">
                          {t('fields.assistant.observerProvider.description')}
                        </p>
                      </div>

                      {/* Observer model (shown when observer provider is Claude or default+Claude) */}
                      {(localAssistantObserverProvider === 'claude' || (localAssistantObserverProvider === null && localAssistantProvider === 'claude')) && (
                        <div className="space-y-1">
                          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                            <label className="text-sm text-muted-foreground sm:w-32 sm:shrink-0">
                              {t('fields.assistant.observerModel.label')}
                            </label>
                            <Select
                              value={localAssistantObserverModel}
                              onValueChange={(v) => setLocalAssistantObserverModel(v as AssistantModel)}
                            >
                              <SelectTrigger className="w-48">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {ASSISTANT_MODELS.map((model) => (
                                  <SelectItem key={model} value={model}>
                                    {t(`fields.assistant.observerModel.options.${model}`)}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          <p className="text-xs text-muted-foreground sm:ml-32 sm:pl-2">
                            {t('fields.assistant.observerModel.description')}
                          </p>
                        </div>
                      )}

                      {/* Observer OpenCode model (shown when observer provider is OpenCode) */}
                      {(localAssistantObserverProvider === 'opencode' || (localAssistantObserverProvider === null && localAssistantProvider === 'opencode')) && opencodeInstalled && (
                        <div className="space-y-1">
                          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                            <label className="text-sm text-muted-foreground sm:w-32 sm:shrink-0">
                              {t('fields.assistant.observerOpencodeModel.label')}
                            </label>
                            <ModelPicker
                              value={localAssistantObserverOpencodeModel}
                              onChange={(v) => setLocalAssistantObserverOpencodeModel(v)}
                              placeholder={t('fields.assistant.observerOpencodeModel.placeholder')}
                              className="w-64"
                            />
                          </div>
                          <p className="text-xs text-muted-foreground sm:ml-32 sm:pl-2">
                            {t('fields.assistant.observerOpencodeModel.description')}
                          </p>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Memory file link (replaces custom instructions) */}
                  <div className="space-y-1">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                      <label className="text-sm text-muted-foreground sm:w-32 sm:shrink-0">
                        {t('fields.assistant.customInstructions.label')}
                      </label>
                      <Link to="/assistant" search={{ tab: 'memory' }}>
                        <Button variant="outline" size="sm">
                          {t('fields.assistant.customInstructions.openMemoryFile')}
                        </Button>
                      </Link>
                    </div>
                    <p className="text-xs text-muted-foreground sm:ml-32 sm:pl-2">
                      {t('fields.assistant.customInstructions.memoryDescription')}
                    </p>
                  </div>

                  {/* Documents directory */}
                  <div className="space-y-1">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                      <label className="text-sm text-muted-foreground sm:w-32 sm:shrink-0">
                        {t('fields.assistant.documentsDir.label')}
                      </label>
                      <Input
                        value={localAssistantDocumentsDir}
                        onChange={(e) => setLocalAssistantDocumentsDir(e.target.value)}
                        placeholder="~/.fulcrum/documents"
                        disabled={isLoading}
                        className="w-64 font-mono text-sm"
                      />
                    </div>
                    <p className="text-xs text-muted-foreground sm:ml-32 sm:pl-2">
                      {t('fields.assistant.documentsDir.description')}
                    </p>
                  </div>

                  {/* Daily Rituals */}
                  <div className="border-t border-border pt-4 space-y-1">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                      <label className="text-sm text-muted-foreground sm:w-32 sm:shrink-0">
                        {t('concierge.rituals')}
                      </label>
                      <Switch
                        checked={localRitualsEnabled}
                        onCheckedChange={setLocalRitualsEnabled}
                        disabled={isLoading}
                      />
                    </div>
                    <p className="text-xs text-muted-foreground sm:ml-32 sm:pl-2">
                      {t('concierge.ritualsDescription')}
                    </p>
                  </div>

                  {localRitualsEnabled && (
                    <>
                      {/* Morning Ritual */}
                      <div className="space-y-3">
                        <div className="space-y-1">
                          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                            <label className="text-sm text-muted-foreground sm:w-32 sm:shrink-0">
                              {t('concierge.morningRitual')}
                            </label>
                            <Input
                              type="time"
                              value={localMorningRitualTime}
                              onChange={(e) => setLocalMorningRitualTime(e.target.value)}
                              disabled={isLoading}
                              className="w-32"
                            />
                          </div>
                          <p className="text-xs text-muted-foreground sm:ml-32 sm:pl-2">
                            {t('concierge.morningRitualDescription')}
                          </p>
                        </div>
                        <div className="sm:ml-32 sm:pl-2">
                          <Textarea
                            value={localMorningRitualPrompt}
                            onChange={(e) => setLocalMorningRitualPrompt(e.target.value)}
                            placeholder={t('concierge.morningRitualPromptPlaceholder')}
                            disabled={isLoading}
                            className="min-h-[80px] text-sm"
                          />
                        </div>
                      </div>

                      {/* Evening Ritual */}
                      <div className="space-y-3">
                        <div className="space-y-1">
                          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                            <label className="text-sm text-muted-foreground sm:w-32 sm:shrink-0">
                              {t('concierge.eveningRitual')}
                            </label>
                            <Input
                              type="time"
                              value={localEveningRitualTime}
                              onChange={(e) => setLocalEveningRitualTime(e.target.value)}
                              disabled={isLoading}
                              className="w-32"
                            />
                          </div>
                          <p className="text-xs text-muted-foreground sm:ml-32 sm:pl-2">
                            {t('concierge.eveningRitualDescription')}
                          </p>
                        </div>
                        <div className="sm:ml-32 sm:pl-2">
                          <Textarea
                            value={localEveningRitualPrompt}
                            onChange={(e) => setLocalEveningRitualPrompt(e.target.value)}
                            placeholder={t('concierge.eveningRitualPromptPlaceholder')}
                            disabled={isLoading}
                            className="min-h-[80px] text-sm"
                          />
                        </div>
                      </div>
                    </>
                  )}
                </div>
              </SettingsSection>

              {/* z.ai */}
              <SettingsSection title={t('sections.zai')}>
                <div className="space-y-4">
                  {/* Enable toggle */}
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                    <label className="text-sm text-muted-foreground sm:w-20 sm:shrink-0">
                      {t('fields.zai.enable')}
                    </label>
                    <Switch
                      checked={zAiEnabled}
                      onCheckedChange={setZAiEnabled}
                      disabled={isLoading}
                    />
                  </div>

                  {/* Settings (shown when enabled) */}
                  {zAiEnabled && (
                    <>
                      {/* API Key */}
                      <div className="space-y-1">
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                          <label className="text-sm text-muted-foreground sm:w-20 sm:shrink-0">
                            {t('fields.zai.apiKey')}
                          </label>
                          <div className="relative flex-1">
                            <Input
                              type="password"
                              value={zAiApiKey}
                              onChange={(e) => setZAiApiKey(e.target.value)}
                              placeholder="zai_..."
                              disabled={isLoading}
                              className="flex-1 pr-8 font-mono text-sm"
                            />
                            {!!zAiSettings?.apiKey && (
                              <div className="absolute right-2 top-1/2 -translate-y-1/2 text-green-500">
                                <HugeiconsIcon icon={Tick02Icon} size={14} strokeWidth={2} />
                              </div>
                            )}
                          </div>
                        </div>
                        <p className="text-xs text-muted-foreground sm:ml-20 sm:pl-2">
                          {t('fields.zai.description')}
                        </p>
                      </div>

                      {/* Model Mappings */}
                      <div className="space-y-3 border-t border-border pt-4">
                        <p className="text-xs font-medium text-muted-foreground">{t('fields.zai.modelMappings')}</p>

                        {/* Haiku Model */}
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                          <label className="text-sm text-muted-foreground sm:w-20 sm:shrink-0">
                            {t('fields.zai.haiku')}
                          </label>
                          <Input
                            value={zAiHaikuModel}
                            onChange={(e) => setZAiHaikuModel(e.target.value)}
                            placeholder="glm-4.5-air"
                            disabled={isLoading}
                            className="flex-1 font-mono text-sm"
                          />
                        </div>

                        {/* Sonnet Model */}
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                          <label className="text-sm text-muted-foreground sm:w-20 sm:shrink-0">
                            {t('fields.zai.sonnet')}
                          </label>
                          <Input
                            value={zAiSonnetModel}
                            onChange={(e) => setZAiSonnetModel(e.target.value)}
                            placeholder="glm-4.7"
                            disabled={isLoading}
                            className="flex-1 font-mono text-sm"
                          />
                        </div>

                        {/* Opus Model */}
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                          <label className="text-sm text-muted-foreground sm:w-20 sm:shrink-0">
                            {t('fields.zai.opus')}
                          </label>
                          <Input
                            value={zAiOpusModel}
                            onChange={(e) => setZAiOpusModel(e.target.value)}
                            placeholder="glm-4.7"
                            disabled={isLoading}
                            className="flex-1 font-mono text-sm"
                          />
                        </div>
                      </div>
                    </>
                  )}
                </div>
              </SettingsSection>
            </div>
          </TabsContent>

          <TabsContent value="messaging" className="flex-1 overflow-auto p-6">
            <div className="mx-auto max-w-5xl space-y-4">
              {/* D-6 PR 4: per-user overrides on top of the tenant-wide
                  notification defaults below. The dispatcher integration
                  is a follow-up (D-7); storage + self-service ship now. */}
              <SettingsSection title={t('sections.myNotifs', 'My notification preferences')}>
                <MyNotificationPreferences />
              </SettingsSection>

              {/* D-7 PR 3: per-user channel identity mappings. Storage
                  surface; dispatcher routing into each channel is wired
                  in follow-ups. */}
              <SettingsSection title={t('sections.myChannelIdentities', 'My channel identities')}>
                <MyChannelIdentities />
              </SettingsSection>

              {/* Notifications — tenant defaults, D-7 PR 2 admin-only.
                  Non-admins see only the "My notification preferences"
                  section above. */}
              {isAdmin && (
              <SettingsSection title={t('sections.notifications')}>
                <div className="space-y-4">
                  {/* Master toggle */}
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                    <label className="text-sm text-muted-foreground sm:w-40 sm:shrink-0">
                      {t('notifications.enable')}
                    </label>
                    <Switch
                      checked={notificationsEnabled}
                      onCheckedChange={setNotificationsEnabled}
                      disabled={isLoading}
                    />
                  </div>

                  {/* Toast (in-app) */}
                  <div className="space-y-2 pl-4">
                    <div className="flex items-center gap-2">
                      <Switch
                        checked={toastEnabled}
                        onCheckedChange={setToastEnabled}
                        disabled={isLoading || !notificationsEnabled}
                      />
                      <label className="text-sm text-muted-foreground">{t('notifications.toast')}</label>
                    </div>
                    <p className="ml-10 text-xs text-muted-foreground">
                      {t('notifications.toastDescription')}
                    </p>
                  </div>

                  {/* Desktop (browser/native) */}
                  <div className="space-y-2 pl-4">
                    <div className="flex items-center gap-2">
                      <Switch
                        checked={desktopEnabled}
                        onCheckedChange={setDesktopEnabled}
                        disabled={isLoading || !notificationsEnabled}
                      />
                      <label className="text-sm text-muted-foreground">{t('notifications.desktop')}</label>
                    </div>
                    <p className="ml-10 text-xs text-muted-foreground">
                      {t('notifications.desktopDescription')}
                    </p>
                  </div>

                  {/* Sound */}
                  <div className="space-y-2 pl-4">
                    <div className="flex items-center gap-2">
                      <Switch
                        checked={soundEnabled}
                        onCheckedChange={setSoundEnabled}
                        disabled={isLoading || !notificationsEnabled}
                      />
                      <label className="text-sm text-muted-foreground">{t('notifications.sound')}</label>
                      <div className="ml-auto flex items-center gap-1">
                        {/* Upload custom sound */}
                        <input
                          ref={soundInputRef}
                          type="file"
                          accept="audio/mpeg,audio/mp3,audio/wav,audio/ogg"
                          className="hidden"
                          onChange={handleSoundUpload}
                        />
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-muted-foreground hover:text-foreground"
                          onClick={() => soundInputRef.current?.click()}
                          disabled={isLoading || !notificationsEnabled || !soundEnabled || isUploadingSound}
                          title={t('notifications.uploadSound')}
                        >
                          {isUploadingSound ? (
                            <HugeiconsIcon icon={Loading03Icon} size={14} strokeWidth={2} className="animate-spin" />
                          ) : (
                            <HugeiconsIcon icon={Upload04Icon} size={14} strokeWidth={2} />
                          )}
                        </Button>
                        {/* Delete custom sound (only shown if custom sound exists) */}
                        {hasCustomSound && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-muted-foreground hover:text-destructive"
                            onClick={handleDeleteCustomSound}
                            disabled={isLoading || !notificationsEnabled || !soundEnabled}
                            title={t('notifications.deleteSound')}
                          >
                            <HugeiconsIcon icon={Delete02Icon} size={14} strokeWidth={2} />
                          </Button>
                        )}
                        {/* Test sound */}
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-muted-foreground hover:text-foreground"
                          onClick={() => handleTestChannel('sound')}
                          disabled={isLoading || !notificationsEnabled || !soundEnabled || testChannel.isPending}
                          title={t('notifications.testSound')}
                        >
                          {testChannel.isPending ? (
                            <HugeiconsIcon icon={Loading03Icon} size={14} strokeWidth={2} className="animate-spin" />
                          ) : (
                            <HugeiconsIcon icon={TestTube01Icon} size={14} strokeWidth={2} />
                          )}
                        </Button>
                      </div>
                    </div>
                    {hasCustomSound && (
                      <p className="ml-10 text-xs text-muted-foreground">
                        {t('notifications.customSoundActive')}
                      </p>
                    )}
                    {/* D-10 PR 7 — per-event sound suppression for the
                        kanban-drag-between-columns case. Default true
                        (silent). Toggle off if you want the chimes back
                        on every column move. Indented + label-only
                        because it's a sub-control of "Sound". */}
                    <div className="flex items-center gap-2 ml-10">
                      <Switch
                        checked={silenceTaskMoves}
                        onCheckedChange={setSilenceTaskMoves}
                        disabled={isLoading || !notificationsEnabled || !soundEnabled}
                      />
                      <label className="text-xs text-muted-foreground select-none">
                        Silence sound for task column moves
                      </label>
                    </div>
                  </div>

                  {/* Slack */}
                  <div className="space-y-2 pl-4">
                    <div className="flex items-center gap-2">
                      <Switch
                        checked={slackEnabled}
                        onCheckedChange={setSlackEnabled}
                        disabled={isLoading || !notificationsEnabled}
                      />
                      <label className="text-sm text-muted-foreground">{t('notifications.slack')}</label>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="ml-auto h-8 w-8 text-muted-foreground hover:text-foreground"
                        onClick={() => handleTestChannel('slack')}
                        disabled={isLoading || !notificationsEnabled || !slackEnabled || (!slackWebhook && !slackUseMessaging) || testChannel.isPending}
                        title={t('notifications.slack')}
                      >
                        {testChannel.isPending ? (
                          <HugeiconsIcon icon={Loading03Icon} size={14} strokeWidth={2} className="animate-spin" />
                        ) : (
                          <HugeiconsIcon icon={TestTube01Icon} size={14} strokeWidth={2} />
                        )}
                      </Button>
                    </div>
                    {slackEnabled && (
                      <div className="ml-6 space-y-2">
                        <div className="flex items-center gap-2">
                          <Switch
                            checked={slackUseMessaging}
                            onCheckedChange={setSlackUseMessaging}
                            disabled={isLoading || !notificationsEnabled || !slackEnabled}
                          />
                          <label className="text-xs text-muted-foreground">
                            {t('notifications.useMessagingChannel') || 'Use messaging channel'}
                          </label>
                        </div>
                        {!slackUseMessaging && (
                          <div className="relative">
                            <Input
                              type="password"
                              value={slackWebhook}
                              onChange={(e) => setSlackWebhook(e.target.value)}
                              placeholder="https://hooks.slack.com/services/..."
                              disabled={isLoading || !notificationsEnabled}
                              className="flex-1 pr-8 font-mono text-sm"
                            />
                            {!!notificationSettings?.slack?.webhookUrl && (
                              <div className="absolute right-2 top-1/2 -translate-y-1/2 text-green-500">
                                <HugeiconsIcon icon={Tick02Icon} size={14} strokeWidth={2} />
                              </div>
                            )}
                          </div>
                        )}
                        {slackUseMessaging && (
                          <p className="text-xs text-muted-foreground">
                            {t('notifications.messagingChannelNote') || 'Sends via connected Slack messaging channel'}
                          </p>
                        )}
                        {slackUseMessaging && (
                          <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3">
                            <div className="text-xs font-medium text-foreground">
                              Per-event channel routing
                            </div>
                            <p className="text-xs text-muted-foreground">
                              Route specific events to specific Slack channels (channel id, e.g. <code className="rounded bg-muted px-1">C0123ABC</code>). Falls back to the default below; if both are blank, the bot DMs the recipient.
                            </p>
                            {([
                              ['task_status_change', 'Task status changes'],
                              ['pr_merged', 'PR merged'],
                              ['plan_complete', 'Plan complete'],
                              ['deployment_success', 'Deploy success'],
                              ['deployment_failed', 'Deploy failed'],
                              ['mention', 'Mentions'],
                            ] as const).map(([eventKey, label]) => (
                              <div key={eventKey} className="flex items-center gap-2">
                                <label className="w-36 text-xs text-muted-foreground">{label}</label>
                                <Input
                                  type="text"
                                  value={slackEventChannels[eventKey] ?? ''}
                                  onChange={(e) => {
                                    const next = { ...slackEventChannels }
                                    const v = e.target.value.trim()
                                    if (v) next[eventKey] = v
                                    else delete next[eventKey]
                                    setSlackEventChannels(next)
                                  }}
                                  placeholder="C0123ABC"
                                  disabled={isLoading || !notificationsEnabled}
                                  className="flex-1 font-mono text-xs"
                                />
                              </div>
                            ))}
                            <div className="flex items-center gap-2 border-t border-border pt-2">
                              <label className="w-36 text-xs text-muted-foreground">Default channel</label>
                              <Input
                                type="text"
                                value={slackDefaultChannel}
                                onChange={(e) => setSlackDefaultChannel(e.target.value.trim())}
                                placeholder="C0123ABC (fallback)"
                                disabled={isLoading || !notificationsEnabled}
                                className="flex-1 font-mono text-xs"
                              />
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Discord */}
                  <div className="space-y-2 pl-4">
                    <div className="flex items-center gap-2">
                      <Switch
                        checked={discordEnabled}
                        onCheckedChange={setDiscordEnabled}
                        disabled={isLoading || !notificationsEnabled}
                      />
                      <label className="text-sm text-muted-foreground">{t('notifications.discord')}</label>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="ml-auto h-8 w-8 text-muted-foreground hover:text-foreground"
                        onClick={() => handleTestChannel('discord')}
                        disabled={isLoading || !notificationsEnabled || !discordEnabled || (!discordWebhook && !discordUseMessaging) || testChannel.isPending}
                        title={t('notifications.discord')}
                      >
                        {testChannel.isPending ? (
                          <HugeiconsIcon icon={Loading03Icon} size={14} strokeWidth={2} className="animate-spin" />
                        ) : (
                          <HugeiconsIcon icon={TestTube01Icon} size={14} strokeWidth={2} />
                        )}
                      </Button>
                    </div>
                    {discordEnabled && (
                      <div className="ml-6 space-y-2">
                        <div className="flex items-center gap-2">
                          <Switch
                            checked={discordUseMessaging}
                            onCheckedChange={setDiscordUseMessaging}
                            disabled={isLoading || !notificationsEnabled || !discordEnabled}
                          />
                          <label className="text-xs text-muted-foreground">
                            {t('notifications.useMessagingChannel') || 'Use messaging channel'}
                          </label>
                        </div>
                        {!discordUseMessaging && (
                          <div className="relative">
                            <Input
                              type="password"
                              value={discordWebhook}
                              onChange={(e) => setDiscordWebhook(e.target.value)}
                              placeholder="https://discord.com/api/webhooks/..."
                              disabled={isLoading || !notificationsEnabled}
                              className="flex-1 pr-8 font-mono text-sm"
                            />
                            {!!notificationSettings?.discord?.webhookUrl && (
                              <div className="absolute right-2 top-1/2 -translate-y-1/2 text-green-500">
                                <HugeiconsIcon icon={Tick02Icon} size={14} strokeWidth={2} />
                              </div>
                            )}
                          </div>
                        )}
                        {discordUseMessaging && (
                          <p className="text-xs text-muted-foreground">
                            {t('notifications.messagingChannelNote') || 'Sends via connected Discord messaging channel'}
                          </p>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Pushover */}
                  <div className="space-y-2 pl-4">
                    <div className="flex items-center gap-2">
                      <Switch
                        checked={pushoverEnabled}
                        onCheckedChange={setPushoverEnabled}
                        disabled={isLoading || !notificationsEnabled}
                      />
                      <label className="text-sm text-muted-foreground">{t('notifications.pushover')}</label>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="ml-auto h-8 w-8 text-muted-foreground hover:text-foreground"
                        onClick={() => handleTestChannel('pushover')}
                        disabled={isLoading || !notificationsEnabled || !pushoverEnabled || !pushoverAppToken || !pushoverUserKey || testChannel.isPending}
                        title={t('notifications.pushover')}
                      >
                        {testChannel.isPending ? (
                          <HugeiconsIcon icon={Loading03Icon} size={14} strokeWidth={2} className="animate-spin" />
                        ) : (
                          <HugeiconsIcon icon={TestTube01Icon} size={14} strokeWidth={2} />
                        )}
                      </Button>
                    </div>
                    {pushoverEnabled && (
                      <div className="ml-6 space-y-2">
                        <div className="relative">
                          <Input
                            type="password"
                            value={pushoverAppToken}
                            onChange={(e) => setPushoverAppToken(e.target.value)}
                            placeholder={t('notifications.appToken')}
                            disabled={isLoading || !notificationsEnabled}
                            className="flex-1 pr-8 font-mono text-sm"
                          />
                          {!!notificationSettings?.pushover?.appToken && (
                            <div className="absolute right-2 top-1/2 -translate-y-1/2 text-green-500">
                              <HugeiconsIcon icon={Tick02Icon} size={14} strokeWidth={2} />
                            </div>
                          )}
                        </div>
                        <div className="relative">
                          <Input
                            type="password"
                            value={pushoverUserKey}
                            onChange={(e) => setPushoverUserKey(e.target.value)}
                            placeholder={t('notifications.userKey')}
                            disabled={isLoading || !notificationsEnabled}
                            className="flex-1 pr-8 font-mono text-sm"
                          />
                          {!!notificationSettings?.pushover?.userKey && (
                            <div className="absolute right-2 top-1/2 -translate-y-1/2 text-green-500">
                              <HugeiconsIcon icon={Tick02Icon} size={14} strokeWidth={2} />
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* WhatsApp */}
                  <div className="space-y-2 pl-4">
                    <div className="flex items-center gap-2">
                      <Switch
                        checked={whatsappNotifEnabled}
                        onCheckedChange={setWhatsappNotifEnabled}
                        disabled={isLoading || !notificationsEnabled}
                      />
                      <label className="text-sm text-muted-foreground">{t('notifications.whatsapp') || 'WhatsApp'}</label>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="ml-auto h-8 w-8 text-muted-foreground hover:text-foreground"
                        onClick={() => handleTestChannel('whatsapp')}
                        disabled={isLoading || !notificationsEnabled || !whatsappNotifEnabled || testChannel.isPending}
                        title={t('notifications.whatsapp') || 'WhatsApp'}
                      >
                        {testChannel.isPending ? (
                          <HugeiconsIcon icon={Loading03Icon} size={14} strokeWidth={2} className="animate-spin" />
                        ) : (
                          <HugeiconsIcon icon={TestTube01Icon} size={14} strokeWidth={2} />
                        )}
                      </Button>
                    </div>
                    {whatsappNotifEnabled && (
                      <p className="ml-10 text-xs text-muted-foreground">
                        {t('notifications.messagingChannelRequired') || 'Requires connected WhatsApp messaging channel'}
                      </p>
                    )}
                  </div>

                  {/* Telegram */}
                  <div className="space-y-2 pl-4">
                    <div className="flex items-center gap-2">
                      <Switch
                        checked={telegramNotifEnabled}
                        onCheckedChange={setTelegramNotifEnabled}
                        disabled={isLoading || !notificationsEnabled}
                      />
                      <label className="text-sm text-muted-foreground">{t('notifications.telegram') || 'Telegram'}</label>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="ml-auto h-8 w-8 text-muted-foreground hover:text-foreground"
                        onClick={() => handleTestChannel('telegram')}
                        disabled={isLoading || !notificationsEnabled || !telegramNotifEnabled || testChannel.isPending}
                        title={t('notifications.telegram') || 'Telegram'}
                      >
                        {testChannel.isPending ? (
                          <HugeiconsIcon icon={Loading03Icon} size={14} strokeWidth={2} className="animate-spin" />
                        ) : (
                          <HugeiconsIcon icon={TestTube01Icon} size={14} strokeWidth={2} />
                        )}
                      </Button>
                    </div>
                    {telegramNotifEnabled && (
                      <p className="ml-10 text-xs text-muted-foreground">
                        {t('notifications.messagingChannelRequired') || 'Requires connected Telegram messaging channel'}
                      </p>
                    )}
                  </div>

                  {/* Gmail */}
                  <div className="space-y-2 pl-4">
                    <div className="flex items-center gap-2">
                      <Switch
                        checked={gmailNotifEnabled}
                        onCheckedChange={setGmailNotifEnabled}
                        disabled={isLoading || !notificationsEnabled}
                      />
                      <label className="text-sm text-muted-foreground">{t('notifications.gmail')}</label>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="ml-auto h-8 w-8 text-muted-foreground hover:text-foreground"
                        onClick={() => handleTestChannel('gmail')}
                        disabled={isLoading || !notificationsEnabled || !gmailNotifEnabled || testChannel.isPending}
                        title={t('notifications.gmail')}
                      >
                        {testChannel.isPending ? (
                          <HugeiconsIcon icon={Loading03Icon} size={14} strokeWidth={2} className="animate-spin" />
                        ) : (
                          <HugeiconsIcon icon={TestTube01Icon} size={14} strokeWidth={2} />
                        )}
                      </Button>
                    </div>
                    {gmailNotifEnabled && (
                      <div className="ml-10 space-y-2">
                        <p className="text-xs text-muted-foreground">
                          {t('notifications.gmailDescription')}
                        </p>
                        {gmailEnabledAccounts.length > 1 && (
                          <Select value={gmailNotifAccountId || 'auto'} onValueChange={(v) => setGmailNotifAccountId(!v || v === 'auto' ? '' : v)}>
                            <SelectTrigger className="h-8 w-60">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="auto">{t('notifications.gmailAutoResolve')}</SelectItem>
                              {gmailEnabledAccounts.map((a) => (
                                <SelectItem key={a.id} value={a.id}>{a.email || a.name}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        )}
                        {gmailEnabledAccounts.length === 0 && (
                          <p className="text-xs text-destructive">
                            {t('notifications.gmailNoAccounts')}
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </SettingsSection>
              )}

              {/* Messaging Channels */}
              <SettingsSection title="Channels">
                <div className="space-y-8">
                  <div className="rounded-lg border border-border p-4">
                    <EmailSettings isLoading={isLoading} />
                  </div>
                  <WhatsAppSetup isLoading={isLoading} />
                  <DiscordSetup isLoading={isLoading} />
                  <TelegramSetup isLoading={isLoading} />
                  <SlackSetup isLoading={isLoading} />
                </div>
              </SettingsSection>
            </div>
          </TabsContent>

          <TabsContent value="calendar" className="flex-1 overflow-auto p-6">
            <div className="mx-auto max-w-5xl space-y-4">
              {/* Google Calendar */}
              <SettingsSection title={t('sections.googleCalendar', 'Google Calendar')}>
                <GoogleCalendarSettings />
              </SettingsSection>
              {/* CalDAV Calendar */}
              <SettingsSection title={t('sections.caldav')}>
                <CaldavAccounts isLoading={isLoading} />
                <CaldavCopyRules isLoading={isLoading} />
              </SettingsSection>
            </div>
          </TabsContent>
        </Tabs>
      </div>

      {/* Sticky Save Button Footer */}
      <div className="shrink-0 border-t border-border bg-background px-6 py-3">
        <div className="mx-auto flex max-w-5xl items-center justify-start">
          <div className="flex items-center gap-2">
            {saved && (
              <span className="flex items-center gap-1 text-xs text-accent">
                <HugeiconsIcon icon={Tick02Icon} size={12} strokeWidth={2} />
                {tc('status.saved')}
              </span>
            )}
            <Button
              size="sm"
              onClick={handleSaveAll}
              disabled={!hasChanges || isLoading || updateConfig.isPending || updateNotifications.isPending || updateZAi.isPending || updateDeploymentSettings.isPending}
            >
              {tc('buttons.save')}
            </Button>
          </div>
        </div>
      </div>

      <FilesystemBrowser
        open={reposDirBrowserOpen}
        onOpenChange={setReposDirBrowserOpen}
        onSelect={(path) => setLocalReposDir(path)}
        initialPath={localReposDir || undefined}
      />
    </div>
  )
}
