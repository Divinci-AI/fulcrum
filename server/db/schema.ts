import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core'

export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  description: text('description'),
  status: text('status').notNull().default('TO_DO'),
  position: integer('position').notNull(),
  repoPath: text('repo_path'), // Now nullable for manual tasks
  repoName: text('repo_name'), // Now nullable for manual tasks
  baseBranch: text('base_branch'), // Now nullable for manual tasks
  branch: text('branch'),
  prefix: text('prefix'), // Branch name prefix for ticket linkage (e.g., "ENG-123")
  worktreePath: text('worktree_path'),
  viewState: text('view_state'), // JSON: { activeTab, browserUrl, diffOptions }
  prUrl: text('pr_url'), // GitHub PR URL for auto-completion tracking
  prAutoClosedAt: text('pr_auto_closed_at'), // ISO timestamp; once set, PR monitor never auto-closes this task again
  startupScript: text('startup_script'), // Command to run after worktree creation
  agent: text('agent').notNull().default('claude'), // AI agent: 'claude' | 'opencode'
  aiMode: text('ai_mode'), // 'default' | 'plan' | null - AI mode for agent startup
  agentOptions: text('agent_options'), // JSON: { [flag]: value } - CLI options for agent
  opencodeModel: text('opencode_model'), // OpenCode model in format 'provider/model' - null means use default
  pinned: integer('pinned', { mode: 'boolean' }).default(false), // Show task at top of kanban column and calendar list
  // Generalized task management fields
  projectId: text('project_id'), // FK to projects (nullable - null = orphan/inbox)
  repositoryId: text('repository_id'), // FK to repositories for worktree tasks
  // NOTE: tags are now stored in task_tags join table, not here
  startedAt: text('started_at'), // Timestamp when moved out of TO_DO
  dueDate: text('due_date'), // YYYY-MM-DD format
  timeEstimate: integer('time_estimate'), // Hours (min 1, nullable)
  priority: text('priority').default('medium'), // 'high' | 'medium' | 'low'
  recurrenceRule: text('recurrence_rule'), // 'daily'|'weekly'|'biweekly'|'monthly'|'quarterly'|'yearly'|null
  recurrenceEndDate: text('recurrence_end_date'), // YYYY-MM-DD or null = forever
  recurrenceSourceTaskId: text('recurrence_source_task_id'), // FK to parent task (lineage chain)
  type: text('type'), // 'worktree' | 'scratch' | null (null = manual/legacy)
  notes: text('notes'), // Free-form notes/comments
  // Multi-user assignment (Phase D-2). Nullable FK → users.id. Tasks created
  // before this column was added stay unassigned (NULL) until someone touches
  // them. Cleared on user delete via app logic (no FK ON DELETE in SQLite-by-
  // convention here; would need to ALTER TABLE to add a real constraint).
  assigneeUserId: text('assignee_user_id'),
  // D-5: per-resource visibility. 'tenant' = every authenticated tenant member
  // gets the tenant-default role (editor) plus whatever ACL elevates them to.
  // 'restricted' = only principals named on the resource's ACL can access it.
  visibility: text('visibility').notNull().default('tenant'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

// Task relationships - tracks relationships between tasks (dependencies, related, subtasks)
export const taskRelationships = sqliteTable('task_relationships', {
  id: text('id').primaryKey(),
  taskId: text('task_id').notNull(),
  relatedTaskId: text('related_task_id').notNull(),
  type: text('type').notNull().default('depends_on'), // 'depends_on' | 'relates_to' | 'subtask'
  createdAt: text('created_at').notNull(),
})

// Backwards compatibility alias
export const taskDependencies = taskRelationships

// Task links - arbitrary URL links associated with tasks
export const taskLinks = sqliteTable('task_links', {
  id: text('id').primaryKey(),
  taskId: text('task_id').notNull(),
  url: text('url').notNull(),
  label: text('label'), // User-provided or auto-detected label
  type: text('type'), // 'pr' | 'issue' | 'docs' | 'design' | 'other'
  createdAt: text('created_at').notNull(),
})

// Task attachments - file uploads associated with tasks
export const taskAttachments = sqliteTable('task_attachments', {
  id: text('id').primaryKey(),
  taskId: text('task_id').notNull(),
  filename: text('filename').notNull(), // Original filename
  storedPath: text('stored_path').notNull(), // Full filesystem path
  mimeType: text('mime_type').notNull(),
  size: integer('size').notNull(), // Bytes
  createdAt: text('created_at').notNull(),
})

// Project links - arbitrary URL links associated with projects
export const projectLinks = sqliteTable('project_links', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  url: text('url').notNull(),
  label: text('label'), // User-provided or auto-detected label
  type: text('type'), // 'pr' | 'issue' | 'docs' | 'design' | 'other'
  createdAt: text('created_at').notNull(),
})

// Project attachments - file uploads associated with projects
export const projectAttachments = sqliteTable('project_attachments', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  filename: text('filename').notNull(), // Original filename
  storedPath: text('stored_path').notNull(), // Full filesystem path
  mimeType: text('mime_type').notNull(),
  size: integer('size').notNull(), // Bytes
  createdAt: text('created_at').notNull(),
})

// Terminal tabs - first-class entities that can exist without terminals
export const terminalTabs = sqliteTable('terminal_tabs', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  position: integer('position').notNull().default(0), // Tab order in the UI
  directory: text('directory'), // Optional default directory for terminals in this tab
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export const terminals = sqliteTable('terminals', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  cwd: text('cwd').notNull(),
  cols: integer('cols').notNull().default(80),
  rows: integer('rows').notNull().default(24),
  tmuxSession: text('tmux_session').notNull(),
  status: text('status').notNull().default('running'),
  exitCode: integer('exit_code'),
  // Tab association
  tabId: text('tab_id'), // References terminalTabs.id (nullable for orphaned terminals)
  positionInTab: integer('position_in_tab').default(0), // Order within the tab
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

// Terminal view state - singleton table for UI state persistence
export const terminalViewState = sqliteTable('terminal_view_state', {
  id: text('id').primaryKey().default('singleton'),
  activeTabId: text('active_tab_id'),
  focusedTerminals: text('focused_terminals'), // JSON: { [tabId]: terminalId }
  selectedRepositoryIds: text('selected_repository_ids'), // JSON array of repository IDs for "Repos" tab
  // View tracking for notification suppression
  currentView: text('current_view'), // 'task-detail' | 'terminals' | 'other'
  currentTaskId: text('current_task_id'), // Task ID if on task detail view
  isTabVisible: integer('is_tab_visible', { mode: 'boolean' }), // document.visibilityState
  viewUpdatedAt: text('view_updated_at'), // Timestamp to detect stale state
  updatedAt: text('updated_at').notNull(),
})

// Repositories - saved git repositories with startup configuration
export const repositories = sqliteTable('repositories', {
  id: text('id').primaryKey(),
  path: text('path').notNull().unique(),
  displayName: text('display_name').notNull(),
  startupScript: text('startup_script'), // Command to run after worktree creation
  copyFiles: text('copy_files'), // Comma-separated glob patterns (e.g., ".env, config.local.json")
  claudeOptions: text('claude_options'), // JSON: { [flag]: value } - CLI options for Claude Code
  opencodeOptions: text('opencode_options'), // JSON: { [flag]: value } - CLI options for OpenCode
  opencodeModel: text('opencode_model'), // OpenCode model in format 'provider/model' - null means use global default
  defaultAgent: text('default_agent'), // 'claude' | 'opencode' | null - null means use global default
  remoteUrl: text('remote_url'), // GitHub remote URL for filtering issues/PRs
  isCopierTemplate: integer('is_copier_template', { mode: 'boolean' }).default(false), // Mark as Copier template
  lastUsedAt: text('last_used_at'), // Timestamp of last task creation with this repo
  lastBaseBranch: text('last_base_branch'), // Last base branch used for task creation
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

// Apps - deployed applications from repositories
export const apps = sqliteTable('apps', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  repositoryId: text('repository_id').notNull(), // FK to repositories
  branch: text('branch').notNull().default('main'),
  composeFile: text('compose_file').notNull(), // e.g., "compose.yml"
  status: text('status').notNull().default('stopped'), // stopped|building|running|failed
  autoDeployEnabled: integer('auto_deploy_enabled', { mode: 'boolean' }).default(false),
  autoPortAllocation: integer('auto_port_allocation', { mode: 'boolean' }).default(true),
  environmentVariables: text('environment_variables'), // JSON string: {"KEY": "value", ...}
  noCacheBuild: integer('no_cache_build', { mode: 'boolean' }).default(false),
  notificationsEnabled: integer('notifications_enabled', { mode: 'boolean' }).default(true),
  lastDeployedAt: text('last_deployed_at'),
  lastDeployCommit: text('last_deploy_commit'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

// App services - individual services within a compose app
export const appServices = sqliteTable('app_services', {
  id: text('id').primaryKey(),
  appId: text('app_id').notNull(), // FK to apps
  serviceName: text('service_name').notNull(), // e.g., "web", "api"
  containerPort: integer('container_port'), // Port exposed by container
  exposed: integer('exposed', { mode: 'boolean' }).default(false),
  domain: text('domain'), // e.g., "myapp.example.com"
  exposureMethod: text('exposure_method').default('dns'), // 'dns' | 'tunnel'
  status: text('status').default('stopped'), // stopped|running|failed
  containerId: text('container_id'), // Docker container ID
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

// Deployments - deployment history for apps
export const deployments = sqliteTable('deployments', {
  id: text('id').primaryKey(),
  appId: text('app_id').notNull(), // FK to apps
  status: text('status').notNull(), // pending|building|running|failed|rolled_back
  gitCommit: text('git_commit'),
  gitMessage: text('git_message'),
  deployedBy: text('deployed_by'), // manual|auto|rollback
  buildLogs: text('build_logs'),
  errorMessage: text('error_message'),
  startedAt: text('started_at').notNull(),
  completedAt: text('completed_at'),
  createdAt: text('created_at').notNull(),
})

// Cloudflare Tunnels - one tunnel per app for multi-service ingress
export const tunnels = sqliteTable('tunnels', {
  id: text('id').primaryKey(),
  appId: text('app_id').notNull().unique(), // FK to apps - one tunnel per app
  tunnelId: text('tunnel_id').notNull(), // Cloudflare tunnel UUID
  tunnelName: text('tunnel_name').notNull(), // e.g., "fulcrum-app-abc123"
  tunnelToken: text('tunnel_token').notNull(), // Token for cloudflared daemon
  status: text('status').notNull().default('inactive'), // inactive|active|failed
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

// Projects - unified entity wrapping optional repository + optional app + dedicated terminal
export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  notes: text('notes'), // Free-form notes/comments
  repositoryId: text('repository_id'), // DEPRECATED: use projectRepositories join table
  appId: text('app_id').unique(), // FK to apps (nullable, 1:1)
  terminalTabId: text('terminal_tab_id').unique(), // FK to terminalTabs (dedicated)
  status: text('status').notNull().default('active'), // 'active' | 'archived'
  // Agent configuration - inherited by repositories unless overridden
  defaultAgent: text('default_agent'), // 'claude' | 'opencode' | null - null means use global default
  claudeOptions: text('claude_options'), // JSON: { [flag]: value } - CLI options for Claude Code
  opencodeOptions: text('opencode_options'), // JSON: { [flag]: value } - CLI options for OpenCode
  opencodeModel: text('opencode_model'), // OpenCode model in format 'provider/model' - null means use global default
  startupScript: text('startup_script'), // Commands to run before agent invocation
  lastAccessedAt: text('last_accessed_at'),
  // D-5: per-resource visibility (see `tasks.visibility` for the model).
  visibility: text('visibility').notNull().default('tenant'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

// Project Repositories - 1:N join table (each repository belongs to one project)
export const projectRepositories = sqliteTable('project_repositories', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  repositoryId: text('repository_id').notNull().unique(), // Enforce 1:N - each repo belongs to one project
  isPrimary: integer('is_primary', { mode: 'boolean' }).default(false),
  createdAt: text('created_at').notNull(),
})

// Tags - reusable tags shared between tasks and projects
export const tags = sqliteTable('tags', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  color: text('color'), // Optional color for visual distinction (e.g., "blue", "#3b82f6")
  createdAt: text('created_at').notNull(),
})

// Task Tags - M:N join table for tasks and tags
export const taskTags = sqliteTable('task_tags', {
  id: text('id').primaryKey(),
  taskId: text('task_id').notNull(),
  tagId: text('tag_id').notNull(),
  createdAt: text('created_at').notNull(),
})

// Project Tags - M:N join table for projects and tags
export const projectTags = sqliteTable('project_tags', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  tagId: text('tag_id').notNull(),
  createdAt: text('created_at').notNull(),
})

// Chat sessions - AI assistant conversations
export const chatSessions = sqliteTable('chat_sessions', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  provider: text('provider').notNull().default('claude'), // 'claude' | 'opencode'
  model: text('model'), // Model used for this session
  projectId: text('project_id'), // Optional: for organization
  context: text('context'), // JSON: initial page context
  editorContent: text('editor_content'), // Persisted editor/document content
  documentPath: text('document_path'), // Relative path from documents dir (e.g., "my-report.md")
  documentStarred: integer('document_starred', { mode: 'boolean' }).default(false), // Pin document to top
  isFavorite: integer('is_favorite', { mode: 'boolean' }).default(false),
  messageCount: integer('message_count').default(0),
  lastMessageAt: text('last_message_at'),
  claudeSessionId: text('claude_session_id'), // Claude Agent SDK session ID for conversation resume
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

// Chat messages - individual messages within a chat session
export const chatMessages = sqliteTable('chat_messages', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull(), // FK to chatSessions
  role: text('role').notNull(), // 'user' | 'assistant' | 'system'
  content: text('content').notNull(),
  toolCalls: text('tool_calls'), // JSON: tool calls made by assistant
  artifacts: text('artifacts'), // JSON: array of artifact IDs referenced
  model: text('model'), // Model that generated this response
  tokensIn: integer('tokens_in'), // Input tokens
  tokensOut: integer('tokens_out'), // Output tokens
  createdAt: text('created_at').notNull(),
})

// Artifacts - generated content from AI assistant (charts, diagrams, documents)
export const artifacts = sqliteTable('artifacts', {
  id: text('id').primaryKey(),
  sessionId: text('session_id'), // FK to chatSessions (nullable - can be detached)
  messageId: text('message_id'), // FK to chatMessages (nullable)
  type: text('type').notNull(), // 'chart' | 'mermaid' | 'markdown' | 'code'
  title: text('title').notNull(),
  description: text('description'),
  content: text('content'), // Content stored directly in DB
  version: integer('version').default(1),
  previewUrl: text('preview_url'), // External preview URL if applicable
  isFavorite: integer('is_favorite', { mode: 'boolean' }).default(false),
  tags: text('tags'), // JSON array of tags
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

// System metrics for monitoring - stores historical CPU, memory, disk usage
export const systemMetrics = sqliteTable('system_metrics', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  timestamp: integer('timestamp').notNull(), // Unix timestamp in seconds
  cpuPercent: real('cpu_percent').notNull(),
  memoryUsedBytes: integer('memory_used_bytes').notNull(),
  memoryTotalBytes: integer('memory_total_bytes').notNull(),
  memoryCacheBytes: integer('memory_cache_bytes').notNull().default(0), // Cache + Buffers
  diskUsedBytes: integer('disk_used_bytes').notNull(),
  diskTotalBytes: integer('disk_total_bytes').notNull(),
})

// Messaging channel connections - stores channel auth state and configuration
export const messagingConnections = sqliteTable('messaging_connections', {
  id: text('id').primaryKey(),
  channelType: text('channel_type').notNull(), // 'whatsapp' | 'discord' | 'telegram'
  enabled: integer('enabled', { mode: 'boolean' }).default(false),
  authState: text('auth_state', { mode: 'json' }), // JSON: Channel-specific auth credentials
  displayName: text('display_name'), // Connected account name (phone number, username, etc.)
  status: text('status').notNull().default('disconnected'), // 'disconnected' | 'connecting' | 'connected' | 'qr_pending'
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

// Messaging session mappings - maps channel users to AI chat sessions
export const messagingSessionMappings = sqliteTable('messaging_session_mappings', {
  id: text('id').primaryKey(),
  connectionId: text('connection_id').notNull(), // FK to messagingConnections
  channelUserId: text('channel_user_id').notNull(), // Phone number, Discord user ID, etc.
  channelUserName: text('channel_user_name'), // Display name of the user
  sessionId: text('session_id').notNull(), // FK to chatSessions
  createdAt: text('created_at').notNull(),
  lastMessageAt: text('last_message_at').notNull(),
  lastChannelSyncAt: text('last_channel_sync_at'), // Last time channel history was synced to this session
})

// Channel message metadata - covers all channel-specific fields in JSON
export type ChannelMessageMetadata = {
  // Email-specific
  messageId?: string // Email Message-ID header
  threadId?: string // Thread identifier
  inReplyTo?: string // In-Reply-To header
  references?: string[] // References header chain
  subject?: string
  toAddresses?: string[]
  ccAddresses?: string[]
  htmlContent?: string
  snippet?: string
  imapUid?: number
  folder?: string
  isRead?: boolean
  isStarred?: boolean
  labels?: string[]
  // Slack-specific
  blocks?: unknown[]
  // WhatsApp-specific
  isGroup?: boolean
  isSelfChat?: boolean
  // Generic
  [key: string]: unknown
}

// Unified channel messages - stores ALL channel messages (WhatsApp, Discord, Telegram, Slack, Email)
export const channelMessages = sqliteTable('channel_messages', {
  id: text('id').primaryKey(),
  channelType: text('channel_type').notNull(), // 'whatsapp' | 'discord' | 'telegram' | 'slack' | 'email'
  connectionId: text('connection_id').notNull(), // FK to messagingConnections
  direction: text('direction').notNull(), // 'incoming' | 'outgoing'
  senderId: text('sender_id').notNull(), // Phone number, user ID, email address
  senderName: text('sender_name'), // Display name
  recipientId: text('recipient_id'), // For outgoing messages
  content: text('content').notNull(), // Message text / email body
  metadata: text('metadata', { mode: 'json' }).$type<ChannelMessageMetadata>(),
  messageTimestamp: text('message_timestamp').notNull(), // When the message was sent/received
  createdAt: text('created_at').notNull(), // When we stored this message
})

// Sweep runs - track when sweeps happened for reliability and context
export const sweepRuns = sqliteTable('sweep_runs', {
  id: text('id').primaryKey(),
  type: text('type').notNull(), // 'hourly' | 'morning_ritual' | 'evening_ritual'
  startedAt: text('started_at').notNull(),
  completedAt: text('completed_at'),
  eventsProcessed: integer('events_processed').default(0),
  tasksUpdated: integer('tasks_updated').default(0),
  messagesSent: integer('messages_sent').default(0),
  summary: text('summary'), // AI's summary of what it did
  status: text('status').notNull(), // 'running' | 'completed' | 'failed'
})

// Google accounts - unified Google API accounts (Calendar + Gmail)
export const googleAccounts = sqliteTable('google_accounts', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email'), // Google account email
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  tokenExpiry: integer('token_expiry'), // Unix timestamp in milliseconds
  scopes: text('scopes', { mode: 'json' }).$type<string[]>(), // Granted scopes
  calendarEnabled: integer('calendar_enabled', { mode: 'boolean' }).default(false),
  gmailEnabled: integer('gmail_enabled', { mode: 'boolean' }).default(false),
  syncIntervalMinutes: integer('sync_interval_minutes').default(15),
  lastCalendarSyncAt: text('last_calendar_sync_at'),
  lastCalendarSyncError: text('last_calendar_sync_error'),
  lastGmailSyncAt: text('last_gmail_sync_at'),
  lastGmailSyncError: text('last_gmail_sync_error'),
  lastGmailHistoryId: text('last_gmail_history_id'), // Persisted Gmail history ID for incremental polling
  sendAsEmail: text('send_as_email'), // Selected "From:" address for drafts (from Gmail send-as aliases)
  needsReauth: integer('needs_reauth', { mode: 'boolean' }).default(false),
  // D-6 PR 1: owning user for per-user scoping. Nullable for one release so a
  // backfilled NULL row stays visible to every user (legacy behavior). After
  // the transition release, flip to NOT NULL.
  ownerUserId: text('owner_user_id'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

// GitHub accounts (D-6 PR 2): one row per (user, GitHub identity) pair so
// each tenant member's PRs/issues attribute to their own GitHub identity.
// Migration 0079 bootstraps a single row from the legacy tenant
// `integrations.githubPat` setting on first boot, labeled "imported" and
// owned by the tenant's earliest user. The PAT itself lives in fnox under
// the key recorded in `pat_fnox_key`, not in this table.
export const githubAccounts = sqliteTable('github_accounts', {
  id: text('id').primaryKey(),
  ownerUserId: text('owner_user_id').notNull(),
  label: text('label').notNull(), // User-visible name; unique per owner
  patFnoxKey: text('pat_fnox_key').notNull(), // Name of the age-encrypted fnox secret
  githubLogin: text('github_login'), // From octokit.users.getAuthenticated() at validation
  githubAvatarUrl: text('github_avatar_url'),
  lastValidatedAt: text('last_validated_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

// Gmail drafts - cached Gmail draft metadata
export const gmailDrafts = sqliteTable('gmail_drafts', {
  id: text('id').primaryKey(),
  googleAccountId: text('google_account_id').notNull(),
  gmailDraftId: text('gmail_draft_id').notNull(),
  gmailMessageId: text('gmail_message_id'),
  threadId: text('thread_id'),
  to: text('to', { mode: 'json' }).$type<string[]>(),
  cc: text('cc', { mode: 'json' }).$type<string[]>(),
  bcc: text('bcc', { mode: 'json' }).$type<string[]>(),
  subject: text('subject'),
  body: text('body'),
  htmlBody: text('html_body'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

// CalDAV accounts - per-account CalDAV credentials and configuration
export const caldavAccounts = sqliteTable('caldav_accounts', {
  id: text('id').primaryKey(),
  name: text('name').notNull(), // User-visible label
  serverUrl: text('server_url').notNull(),
  authType: text('auth_type').notNull().default('basic'), // 'basic' | 'google-oauth'
  username: text('username'), // Basic auth
  password: text('password'), // Basic auth
  googleClientId: text('google_client_id'), // OAuth
  googleClientSecret: text('google_client_secret'), // OAuth
  oauthTokens: text('oauth_tokens', { mode: 'json' }).$type<import('../lib/settings/types').CalDavOAuthTokens | null>(),
  syncIntervalMinutes: integer('sync_interval_minutes').default(15),
  enabled: integer('enabled', { mode: 'boolean' }).default(true),
  lastSyncedAt: text('last_synced_at'),
  lastSyncError: text('last_sync_error'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

// CalDAV calendars - cached calendar metadata from CalDAV server
export const caldavCalendars = sqliteTable('caldav_calendars', {
  id: text('id').primaryKey(),
  accountId: text('account_id'), // FK to caldavAccounts (nullable for migration)
  googleAccountId: text('google_account_id'), // FK to googleAccounts (nullable - set for Google API calendars)
  remoteUrl: text('remote_url').notNull().unique(),
  displayName: text('display_name'),
  color: text('color'),
  ctag: text('ctag'),
  syncToken: text('sync_token'),
  timezone: text('timezone'),
  enabled: integer('enabled', { mode: 'boolean' }).default(true),
  lastSyncedAt: text('last_synced_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

// CalDAV events - cached event data from CalDAV server
export const caldavEvents = sqliteTable('caldav_events', {
  id: text('id').primaryKey(),
  calendarId: text('calendar_id').notNull(), // FK to caldavCalendars
  remoteUrl: text('remote_url').notNull().unique(),
  uid: text('uid'),
  etag: text('etag'),
  summary: text('summary'),
  description: text('description'),
  location: text('location'),
  dtstart: text('dtstart'),
  dtend: text('dtend'),
  duration: text('duration'),
  allDay: integer('all_day', { mode: 'boolean' }).default(false),
  recurrenceRule: text('recurrence_rule'),
  status: text('status'),
  organizer: text('organizer'),
  attendees: text('attendees', { mode: 'json' }).$type<string[]>(),
  rawIcal: text('raw_ical'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

// CalDAV copy rules - one-way event copying between calendars
export const caldavCopyRules = sqliteTable('caldav_copy_rules', {
  id: text('id').primaryKey(),
  name: text('name'), // Optional label
  sourceCalendarId: text('source_calendar_id').notNull(), // FK to caldavCalendars
  destCalendarId: text('dest_calendar_id').notNull(), // FK to caldavCalendars
  enabled: integer('enabled', { mode: 'boolean' }).default(true),
  lastExecutedAt: text('last_executed_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

// CalDAV copied events - tracks copied events to avoid duplicates
export const caldavCopiedEvents = sqliteTable('caldav_copied_events', {
  id: text('id').primaryKey(),
  ruleId: text('rule_id').notNull(), // FK to caldavCopyRules
  sourceEventId: text('source_event_id').notNull(), // FK to caldavEvents
  destEventId: text('dest_event_id').notNull(), // FK to caldavEvents
  sourceEtag: text('source_etag'), // Detect source changes
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

// Agent memories - persistent knowledge store with FTS5 full-text search
export const memories = sqliteTable('memories', {
  id: text('id').primaryKey(),
  content: text('content').notNull(),
  tags: text('tags'), // JSON array of strings
  source: text('source'), // Origin of memory (e.g., 'channel:whatsapp', 'conversation:assistant')
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

// Observer invocations - tracks observe-only message processing
export const observerInvocations = sqliteTable('observer_invocations', {
  id: text('id').primaryKey(),
  channelMessageId: text('channel_message_id'), // FK to channelMessages (nullable - message may not be stored yet)
  channelType: text('channel_type').notNull(), // 'whatsapp' | 'discord' | 'telegram' | 'slack' | 'email'
  connectionId: text('connection_id').notNull(), // FK to messagingConnections
  senderId: text('sender_id').notNull(),
  senderName: text('sender_name'),
  messagePreview: text('message_preview').notNull(), // Truncated to 200 chars
  provider: text('provider').notNull(), // 'claude' | 'opencode'
  status: text('status').notNull(), // 'processing' | 'completed' | 'failed' | 'timeout' | 'circuit_open'
  actions: text('actions', { mode: 'json' }).$type<ObserverActionRecord[]>(), // JSON array of actions taken
  error: text('error'), // Error message if status is 'failed'
  startedAt: text('started_at').notNull(),
  completedAt: text('completed_at'),
  createdAt: text('created_at').notNull(),
})

// Mentions (Phase D-3). One row per (source, mentioned user) pair. A
// "source" is any entity that has free-form text where someone can write
// `@<email>` — tasks and projects today, comments tomorrow. The pair is
// UNIQUE so re-saving the same text doesn't pile up duplicates; the
// mention-service syncs the table to match the parsed mention set.
export const mentions = sqliteTable('mentions', {
  id: text('id').primaryKey(),
  sourceType: text('source_type').notNull(), // 'task' | 'project' | future: 'comment'
  sourceId: text('source_id').notNull(),
  userId: text('user_id').notNull(),         // FK → users.id
  createdAt: text('created_at').notNull(),
})

// Users — identities that have signed into this Fulcrum instance. Populated
// from the `Cf-Access-Authenticated-User-Email` header set by Cloudflare
// Access at the gateway. The CF Access policy gates *who* can reach the
// container; this table gives those identities a stable id so other rows
// (task assignees, mentions, audit) can reference them.
//
// One row per unique email ever seen. Email is the natural key (CF Access
// guarantees uniqueness within an identity provider). The id is a UUID we
// generate ourselves so callers don't have to round-trip an email.
export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  displayName: text('display_name'), // optional; derive from email when null
  avatarUrl: text('avatar_url'),     // optional; future — CF Access doesn't surface this
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  lastSeenAt: text('last_seen_at'),  // touched by the current-user middleware on each request
})

// Teams (Phase D-5). First-class principal for ACL grants. A tenant's team
// list is small (think: "engineering", "design", "ops") and lives entirely
// inside one container — there's no cross-tenant team concept.
export const teams = sqliteTable('teams', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  description: text('description'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

// Team membership (Phase D-5). Tracks which users belong to which teams and
// at what team-level role. Team-level role is **distinct** from resource
// role: a team admin can manage team membership but isn't automatically an
// admin on resources the team has been granted to.
export const teamMembers = sqliteTable('team_members', {
  id: text('id').primaryKey(),
  teamId: text('team_id').notNull(), // FK → teams.id
  userId: text('user_id').notNull(), // FK → users.id
  role: text('role').notNull().default('member'), // 'admin' | 'member'
  joinedAt: text('joined_at').notNull(),
})

// Access Control List (Phase D-5). One row per (resource, principal) grant.
// `principalType` discriminates user vs. team grants. `role` is the access
// level granted to that principal on that resource. With visibility=tenant
// the row *elevates* the principal above the tenant default; with
// visibility=restricted the row is the *only* source of access.
//
// UNIQUE INDEX on (resource_type, resource_id, principal_type, principal_id)
// is added in the migration — no double-granting the same principal at
// different roles. (Want to change the role? Update the existing row.)
export const acls = sqliteTable('acls', {
  id: text('id').primaryKey(),
  resourceType: text('resource_type').notNull(), // 'task' | 'project'
  resourceId: text('resource_id').notNull(),
  principalType: text('principal_type').notNull(), // 'user' | 'team'
  principalId: text('principal_id').notNull(),
  role: text('role').notNull(), // 'viewer' | 'editor' | 'admin'
  grantedAt: text('granted_at').notNull(),
  grantedBy: text('granted_by').notNull(), // userId of the admin who granted
})

// Observer action record type for JSON storage
export type ObserverActionRecord = {
  type: 'create_task' | 'store_memory'
  title?: string // For create_task
  content?: string // For store_memory
  tags?: string[]
}

// Type inference helpers
export type Repository = typeof repositories.$inferSelect
export type NewRepository = typeof repositories.$inferInsert
export type SystemMetric = typeof systemMetrics.$inferSelect
export type NewSystemMetric = typeof systemMetrics.$inferInsert
export type Task = typeof tasks.$inferSelect
export type NewTask = typeof tasks.$inferInsert
export type TerminalTab = typeof terminalTabs.$inferSelect
export type NewTerminalTab = typeof terminalTabs.$inferInsert
export type Terminal = typeof terminals.$inferSelect
export type NewTerminal = typeof terminals.$inferInsert
export type TerminalViewState = typeof terminalViewState.$inferSelect
export type NewTerminalViewState = typeof terminalViewState.$inferInsert
export type App = typeof apps.$inferSelect
export type NewApp = typeof apps.$inferInsert
export type AppService = typeof appServices.$inferSelect
export type NewAppService = typeof appServices.$inferInsert
export type Deployment = typeof deployments.$inferSelect
export type NewDeployment = typeof deployments.$inferInsert
export type Tunnel = typeof tunnels.$inferSelect
export type NewTunnel = typeof tunnels.$inferInsert
export type Project = typeof projects.$inferSelect
export type NewProject = typeof projects.$inferInsert
export type TaskLink = typeof taskLinks.$inferSelect
export type NewTaskLink = typeof taskLinks.$inferInsert
export type TaskRelationship = typeof taskRelationships.$inferSelect
export type NewTaskRelationship = typeof taskRelationships.$inferInsert
// Backwards compatibility aliases
export type TaskDependency = TaskRelationship
export type NewTaskDependency = NewTaskRelationship
export type ProjectRepository = typeof projectRepositories.$inferSelect
export type NewProjectRepository = typeof projectRepositories.$inferInsert
export type TaskAttachment = typeof taskAttachments.$inferSelect
export type NewTaskAttachment = typeof taskAttachments.$inferInsert
export type ProjectAttachment = typeof projectAttachments.$inferSelect
export type NewProjectAttachment = typeof projectAttachments.$inferInsert
export type Tag = typeof tags.$inferSelect
export type NewTag = typeof tags.$inferInsert
export type TaskTag = typeof taskTags.$inferSelect
export type NewTaskTag = typeof taskTags.$inferInsert
export type ProjectTag = typeof projectTags.$inferSelect
export type NewProjectTag = typeof projectTags.$inferInsert
export type ProjectLink = typeof projectLinks.$inferSelect
export type NewProjectLink = typeof projectLinks.$inferInsert
export type ChatSession = typeof chatSessions.$inferSelect
export type NewChatSession = typeof chatSessions.$inferInsert
export type ChatMessage = typeof chatMessages.$inferSelect
export type NewChatMessage = typeof chatMessages.$inferInsert
export type Artifact = typeof artifacts.$inferSelect
export type NewArtifact = typeof artifacts.$inferInsert
export type MessagingConnection = typeof messagingConnections.$inferSelect
export type NewMessagingConnection = typeof messagingConnections.$inferInsert
export type MessagingSessionMapping = typeof messagingSessionMappings.$inferSelect
export type NewMessagingSessionMapping = typeof messagingSessionMappings.$inferInsert
export type ChannelMessage = typeof channelMessages.$inferSelect
export type NewChannelMessage = typeof channelMessages.$inferInsert
export type SweepRun = typeof sweepRuns.$inferSelect
export type NewSweepRun = typeof sweepRuns.$inferInsert
export type CaldavAccount = typeof caldavAccounts.$inferSelect
export type NewCaldavAccount = typeof caldavAccounts.$inferInsert
export type CaldavCalendar = typeof caldavCalendars.$inferSelect
export type NewCaldavCalendar = typeof caldavCalendars.$inferInsert
export type CaldavEvent = typeof caldavEvents.$inferSelect
export type NewCaldavEvent = typeof caldavEvents.$inferInsert
export type CaldavCopyRule = typeof caldavCopyRules.$inferSelect
export type NewCaldavCopyRule = typeof caldavCopyRules.$inferInsert
export type CaldavCopiedEvent = typeof caldavCopiedEvents.$inferSelect
export type NewCaldavCopiedEvent = typeof caldavCopiedEvents.$inferInsert
export type Memory = typeof memories.$inferSelect
export type NewMemory = typeof memories.$inferInsert
export type ObserverInvocation = typeof observerInvocations.$inferSelect
export type NewObserverInvocation = typeof observerInvocations.$inferInsert
export type GoogleAccount = typeof googleAccounts.$inferSelect
export type NewGoogleAccount = typeof googleAccounts.$inferInsert
export type GithubAccount = typeof githubAccounts.$inferSelect
export type NewGithubAccount = typeof githubAccounts.$inferInsert
export type GmailDraft = typeof gmailDrafts.$inferSelect
export type NewGmailDraft = typeof gmailDrafts.$inferInsert
export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert
export type Mention = typeof mentions.$inferSelect
export type NewMention = typeof mentions.$inferInsert
export type Team = typeof teams.$inferSelect
export type NewTeam = typeof teams.$inferInsert
export type TeamMember = typeof teamMembers.$inferSelect
export type NewTeamMember = typeof teamMembers.$inferInsert
export type Acl = typeof acls.$inferSelect
export type NewAcl = typeof acls.$inferInsert
