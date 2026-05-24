// Single source of truth for config keys used by both frontend and backend.
// Both frontend/hooks/use-config.ts and server/routes/config.ts import from here.
export const CONFIG_KEYS = {
  PORT: 'server.port',
  PUBLIC_DOMAIN: 'server.publicDomain',
  TAILSCALE_HOSTNAME: 'server.tailscaleHostname',
  TAILSCALE_IP: 'tailscale_ip', // Read-only, detected at request time via `tailscale ip -4`
  WORKTREE_BASE_PATH: 'worktree_base_path', // Read-only, derived from FULCRUM_DIR
  SCRATCH_BASE_PATH: 'scratch_base_path', // Read-only, derived from FULCRUM_DIR
  HOME_DIR: 'home_dir', // Read-only, system home directory
  DEFAULT_GIT_REPOS_DIR: 'paths.defaultGitReposDir',
  REMOTE_HOST: 'remoteFulcrum.host',
  REMOTE_PORT: 'remoteFulcrum.port',
  EDITOR_APP: 'editor.app',
  EDITOR_HOST: 'editor.host',
  EDITOR_SSH_PORT: 'editor.sshPort',
  GOOGLE_CLIENT_ID: 'integrations.googleClientId',
  GOOGLE_CLIENT_SECRET: 'integrations.googleClientSecret',
  DEFAULT_AGENT: 'agent.defaultAgent',
  OPENCODE_MODEL: 'agent.opencodeModel',
  OPENCODE_DEFAULT_AGENT: 'agent.opencodeDefaultAgent',
  OPENCODE_PLAN_AGENT: 'agent.opencodePlanAgent',
  AGENT_AUTO_SCROLL_TO_BOTTOM: 'agent.autoScrollToBottom',
  CLAUDE_CODE_PATH: 'agent.claudeCodePath',
  LANGUAGE: 'appearance.language',
  THEME: 'appearance.theme',
  TIMEZONE: 'appearance.timezone',
  DEFAULT_TASK_TYPE: 'tasks.defaultTaskType',
  START_WORKTREE_TASKS_IMMEDIATELY: 'tasks.startWorktreeTasksImmediately',
  SCRATCH_STARTUP_SCRIPT: 'tasks.scratchStartupScript',
  ASSISTANT_PROVIDER: 'assistant.provider',
  ASSISTANT_MODEL: 'assistant.model',
  ASSISTANT_OBSERVER_MODEL: 'assistant.observerModel',
  ASSISTANT_OBSERVER_PROVIDER: 'assistant.observerProvider',
  ASSISTANT_OBSERVER_OPENCODE_MODEL: 'assistant.observerOpencodeModel',
  ASSISTANT_CUSTOM_INSTRUCTIONS: 'assistant.customInstructions',
  ASSISTANT_DOCUMENTS_DIR: 'assistant.documentsDir',
  ASSISTANT_RITUALS_ENABLED: 'assistant.ritualsEnabled',
  ASSISTANT_MORNING_RITUAL_TIME: 'assistant.morningRitual.time',
  ASSISTANT_MORNING_RITUAL_PROMPT: 'assistant.morningRitual.prompt',
  ASSISTANT_EVENING_RITUAL_TIME: 'assistant.eveningRitual.time',
  ASSISTANT_EVENING_RITUAL_PROMPT: 'assistant.eveningRitual.prompt',
  ASSISTANT_HERMES_BASE_URL: 'assistant.hermes.baseUrl',
  ASSISTANT_HERMES_API_KEY: 'assistant.hermes.apiKey',
  ASSISTANT_HERMES_MODEL: 'assistant.hermes.model',
  // D-17 PR 1: Divinci RAG pre-flight retrieval for Hermes. Used only when
  // assistant.provider === 'hermes' AND assistant.divinci.enabled. See
  // server/services/divinci-rag-client.ts.
  ASSISTANT_DIVINCI_ENABLED: 'assistant.divinci.enabled',
  ASSISTANT_DIVINCI_BASE_URL: 'assistant.divinci.baseUrl',
  ASSISTANT_DIVINCI_API_KEY: 'assistant.divinci.apiKey',
  ASSISTANT_DIVINCI_GROUP_ID: 'assistant.divinci.groupId',
  ASSISTANT_DIVINCI_TOP_K: 'assistant.divinci.topK',
  // D-17 PR 2: per-source target/collection IDs inside the Group. One added
  // per sync PR. PR 2 = Fulcrum tasks+projects; PRs 3-6 add slack/gmail/cal/drive.
  ASSISTANT_DIVINCI_COLLECTION_FULCRUM: 'assistant.divinci.collections.fulcrum',
  ASSISTANT_DIVINCI_COLLECTION_SLACK: 'assistant.divinci.collections.slack',
  ASSISTANT_DIVINCI_COLLECTION_GMAIL: 'assistant.divinci.collections.gmail',
  ASSISTANT_DIVINCI_COLLECTION_CALENDAR: 'assistant.divinci.collections.calendar',
  ASSISTANT_DIVINCI_COLLECTION_DRIVE: 'assistant.divinci.collections.drive',
  EMAIL_POLL_INTERVAL: 'channels.email.pollIntervalSeconds',
  CALDAV_ENABLED: 'caldav.enabled',
  CALDAV_SERVER_URL: 'caldav.serverUrl',
  CALDAV_USERNAME: 'caldav.username',
  CALDAV_PASSWORD: 'caldav.password',
  CALDAV_SYNC_INTERVAL: 'caldav.syncIntervalMinutes',
  CALDAV_AUTH_TYPE: 'caldav.authType',
  CALDAV_GOOGLE_CLIENT_ID: 'caldav.googleClientId',
  CALDAV_GOOGLE_CLIENT_SECRET: 'caldav.googleClientSecret',
  CALDAV_OAUTH_TOKENS: 'caldav.oauthTokens',
} as const

export type ConfigKey = (typeof CONFIG_KEYS)[keyof typeof CONFIG_KEYS]
