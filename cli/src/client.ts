// @ts-nocheck — pre-existing type errors that surfaced when tsconfig.server.json was added in D-15 OG wrap-up. Remove this directive + fix the errors in a focused follow-up PR.
import { discoverServerUrl } from './utils/server'
import { loadCliConfig } from './utils/cli-config'
import { ApiError } from './utils/errors'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import type {
  Task,
  TaskStatus,
  TaskLink,
  TaskAttachment,
  ProjectAttachment,
  ProjectLink,
  Tag,
  TagWithUsage,
  Repository,
  ProjectWithDetails,
  App,
  Deployment,
  FileTreeEntry,
  FileContent,
  FileStatResponse,
  GitBranchesResponse,
  GitDiffResponse,
  GitStatusResponse,
  WorktreesResponse,
  ConfigResponse,
  NotificationSettings,
  NotificationTestResult,
  ExecuteCommandRequest,
  ExecuteCommandResponse,
  ExecSession,
  SystemdTimer,
  SystemdTimerDetail,
  CreateTimerRequest,
  UpdateTimerRequest,
  JobLogEntry,
  JobScope,
  CopierQuestionsResponse,
  CreateProjectRequest,
  CreateProjectResponse,
} from '@shared/types'

export interface CreateTaskInput {
  title: string
  type?: string | null
  description?: string
  status?: TaskStatus
  repoPath?: string | null
  repoName?: string | null
  baseBranch?: string | null
  branch?: string | null
  prefix?: string | null
  worktreePath?: string | null
  projectId?: string | null
  repositoryId?: string | null
  tags?: string[]
  dueDate?: string | null
  timeEstimate?: number | null
  priority?: string | null
  recurrenceRule?: string | null
  recurrenceEndDate?: string | null
}

export interface TaskTagsResponse {
  tags: string[]
}

export interface TaskDueDateResponse {
  dueDate: string | null
}

export interface TaskDependencyInfo {
  id: string
  task: { id: string; title: string; status: TaskStatus } | null
  createdAt: string
}

export interface TaskDependenciesResponse {
  dependsOn: (TaskDependencyInfo & { dependsOnTaskId: string })[]
  dependents: (TaskDependencyInfo & { taskId: string })[]
  isBlocked: boolean
}

export interface TaskDependency {
  id: string
  taskId: string
  dependsOnTaskId: string
  createdAt: string
}

export interface DiffQueryOptions {
  staged?: boolean
  ignoreWhitespace?: boolean
  includeUntracked?: boolean
}

// Project types
export interface CreateProjectInput {
  name: string
  description?: string
  // Option 1: Link to existing repository
  repositoryId?: string
  // Option 2: Create from local path
  path?: string
  // Option 3: Clone from URL
  url?: string
  targetDir?: string // For cloning
  folderName?: string // For cloning
}

export interface UpdateProjectInput {
  name?: string
  description?: string | null
  notes?: string | null
  status?: 'active' | 'archived'
}

export interface SweepRun {
  id: string
  type: 'hourly' | 'morning_ritual' | 'evening_ritual'
  startedAt: string
  completedAt: string | null
  eventsProcessed: number | null
  tasksUpdated: number | null
  messagesSent: number | null
  summary: string | null
  status: 'running' | 'completed' | 'failed'
}

// Email types
export interface StoredEmail {
  id: string
  connectionId: string
  messageId: string
  threadId: string | null
  inReplyTo: string | null
  references: string[] | null
  direction: 'incoming' | 'outgoing'
  fromAddress: string
  fromName: string | null
  toAddresses: string[] | null
  ccAddresses: string[] | null
  subject: string | null
  textContent: string | null
  htmlContent: string | null
  snippet: string | null
  emailDate: string | null
  folder: string | null
  isRead: boolean | null
  isStarred: boolean | null
  labels: string[] | null
  imapUid: number | null
  createdAt: string
}

// Google types
export interface GoogleAccount {
  id: string
  name: string
  email: string | null
  calendarEnabled: boolean | null
  gmailEnabled: boolean | null
  syncIntervalMinutes: number | null
  lastCalendarSyncAt: string | null
  lastCalendarSyncError: string | null
  lastGmailSyncAt: string | null
  lastGmailSyncError: string | null
  needsReauth: boolean | null
  createdAt: string
  updatedAt: string
}

export interface GmailDraftSummary {
  id: string
  gmailDraftId: string
  to: string[]
  cc: string[]
  subject: string | null
  snippet: string | null
  updatedAt: string
}

// CalDAV types
export interface CaldavAccount {
  id: string
  name: string
  serverUrl: string
  authType: 'basic' | 'google-oauth'
  enabled: boolean | null
  lastSyncedAt: string | null
  lastSyncError: string | null
  createdAt: string
  updatedAt: string
}

export interface CaldavCalendar {
  id: string
  accountId: string | null
  remoteUrl: string
  displayName: string | null
  color: string | null
  ctag: string | null
  syncToken: string | null
  timezone: string | null
  enabled: boolean | null
  lastSyncedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface CaldavCopyRule {
  id: string
  name: string | null
  sourceCalendarId: string
  destCalendarId: string
  enabled: boolean | null
  lastExecutedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface CaldavEvent {
  id: string
  calendarId: string
  remoteUrl: string
  uid: string | null
  etag: string | null
  summary: string | null
  description: string | null
  location: string | null
  dtstart: string | null
  dtend: string | null
  duration: string | null
  allDay: boolean | null
  recurrenceRule: string | null
  status: string | null
  organizer: string | null
  attendees: string[] | null
  rawIcal: string | null
  createdAt: string
  updatedAt: string
}

export interface DeleteProjectOptions {
  deleteDirectory?: boolean
  deleteApp?: boolean
}

// App types
export interface CreateAppInput {
  name: string
  repositoryId: string
  branch?: string
  composeFile?: string
  autoDeployEnabled?: boolean
  environmentVariables?: Record<string, string>
  noCacheBuild?: boolean
  services?: Array<{
    serviceName: string
    containerPort?: number
    exposed: boolean
    domain?: string
    exposureMethod?: 'dns' | 'tunnel'
  }>
}

export interface UpdateAppInput {
  name?: string
  branch?: string
  autoDeployEnabled?: boolean
  autoPortAllocation?: boolean
  environmentVariables?: Record<string, string>
  noCacheBuild?: boolean
  notificationsEnabled?: boolean
  services?: Array<{
    id?: string
    serviceName: string
    containerPort?: number
    exposed: boolean
    domain?: string
    exposureMethod?: 'dns' | 'tunnel'
  }>
}

export interface AppLogOptions {
  service?: string
  tail?: number
}

export interface AppStatus {
  containers: Array<{
    name: string
    service: string
    status: string
    replicas: string
    ports: string[]
  }>
}

// Filesystem types
export interface DirectoryEntry {
  name: string
  type: 'file' | 'directory'
  isGitRepo: boolean
}

export interface ListDirectoryResponse {
  path: string
  parent: string
  entries: DirectoryEntry[]
}

export interface FileTreeResponse {
  root: string
  entries: FileTreeEntry[]
}

export interface WriteFileInput {
  path: string
  root: string
  content: string
}

export interface EditFileInput {
  path: string
  root: string
  old_string: string
  new_string: string
}

export interface PathStatResponse {
  path: string
  exists: boolean
  type: 'file' | 'directory' | 'other' | null
  isDirectory: boolean
  isFile: boolean
}

// Backup types
export interface BackupManifest {
  createdAt: string
  version: string
  files: {
    database: boolean
    settings: boolean
  }
  databaseSize?: number
  settingsSize?: number
  description?: string
}

export interface BackupInfo {
  name: string
  createdAt: string
  path: string
  manifest: BackupManifest
}

export interface BackupCreateResult {
  success: boolean
  name: string
  path: string
  manifest: BackupManifest
}

export interface BackupRestoreResult {
  success: boolean
  restored: {
    database: boolean
    settings: boolean
  }
  preRestoreBackup: string | null
  warning?: string
}

export class FulcrumClient {
  private baseUrl: string
  private token: string | null

  /**
   * URL precedence: explicit override → cli.toml `url` → discoverServerUrl
   * fallback chain. Token: explicit env var (handled in loadCliConfig) →
   * cli.toml `token`. Constructor-time resolution so each invocation
   * picks up `fulcrum login` updates without process restart.
   */
  constructor(urlOverride?: string, portOverride?: string) {
    const cli = loadCliConfig()
    if (urlOverride) {
      this.baseUrl = urlOverride
    } else if (cli.url && !portOverride) {
      this.baseUrl = cli.url
    } else {
      this.baseUrl = discoverServerUrl(urlOverride, portOverride)
    }
    this.token = cli.token ?? null
  }

  private async fetch<T>(path: string, options?: RequestInit): Promise<T> {
    const url = `${this.baseUrl}${path}`

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options?.headers as Record<string, string>),
    }
    if (this.token && !headers['Authorization']) {
      headers['Authorization'] = `Bearer ${this.token}`
    }

    try {
      const res = await fetch(url, {
        ...options,
        headers,
      })

      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new ApiError(res.status, body.error || body.message || `Request failed: ${res.status}`)
      }

      return res.json()
    } catch (err) {
      if (err instanceof ApiError) throw err
      throw new ApiError(0, `Server unreachable: ${this.baseUrl}`)
    }
  }

  // Health
  async health(): Promise<{ status: string }> {
    return this.fetch('/health')
  }

  // Tasks
  async listTasks(): Promise<Task[]> {
    return this.fetch('/api/tasks')
  }

  async getTask(id: string): Promise<Task> {
    return this.fetch(`/api/tasks/${id}`)
  }

  async createTask(data: CreateTaskInput): Promise<Task> {
    return this.fetch('/api/tasks', {
      method: 'POST',
      body: JSON.stringify(data),
    })
  }

  async updateTask(id: string, updates: Partial<Task>): Promise<Task> {
    return this.fetch(`/api/tasks/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    })
  }

  async moveTask(id: string, status: TaskStatus, position?: number): Promise<Task> {
    // If position not provided, get current tasks in target column to calculate
    if (position === undefined) {
      const tasks = await this.listTasks()
      const targetTasks = tasks.filter((t) => t.status === status)
      position = targetTasks.length
    }

    return this.fetch(`/api/tasks/${id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status, position }),
    })
  }

  async deleteTask(
    id: string,
    deleteLinkedWorktree?: boolean
  ): Promise<{ success: true }> {
    const url = deleteLinkedWorktree
      ? `/api/tasks/${id}?deleteLinkedWorktree=true`
      : `/api/tasks/${id}`
    return this.fetch(url, { method: 'DELETE' })
  }

  async bulkDeleteTasks(
    ids: string[],
    deleteLinkedWorktrees?: boolean
  ): Promise<{ success: true; deleted: number }> {
    return this.fetch('/api/tasks/bulk', {
      method: 'DELETE',
      body: JSON.stringify({ ids, deleteLinkedWorktrees }),
    })
  }

  // Repositories
  async listRepositories(options?: { orphans?: boolean; projectId?: string }): Promise<Repository[]> {
    const params = new URLSearchParams()
    if (options?.orphans) params.set('orphans', 'true')
    if (options?.projectId) params.set('projectId', options.projectId)
    const query = params.toString() ? `?${params.toString()}` : ''
    return this.fetch(`/api/repositories${query}`)
  }

  async getRepository(id: string): Promise<Repository> {
    return this.fetch(`/api/repositories/${id}`)
  }

  async addRepository(path: string, displayName?: string, projectId?: string): Promise<Repository> {
    return this.fetch('/api/repositories', {
      method: 'POST',
      body: JSON.stringify({ path, displayName, projectId }),
    })
  }

  async updateRepository(
    id: string,
    updates: {
      displayName?: string
      startupScript?: string | null
      copyFiles?: string | null
      defaultAgent?: 'claude' | 'opencode' | null
      claudeOptions?: Record<string, string> | null
      opencodeOptions?: Record<string, string> | null
      opencodeModel?: string | null
    }
  ): Promise<Repository> {
    return this.fetch(`/api/repositories/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    })
  }

  async deleteRepository(id: string): Promise<{ success: boolean }> {
    return this.fetch(`/api/repositories/${id}`, { method: 'DELETE' })
  }

  async linkRepositoryToProject(
    repositoryId: string,
    projectId: string,
    options?: { isPrimary?: boolean; force?: boolean }
  ): Promise<{ id: string; projectId: string; repositoryId: string; isPrimary: boolean }> {
    return this.fetch(`/api/projects/${projectId}/repositories`, {
      method: 'POST',
      body: JSON.stringify({
        repositoryId,
        isPrimary: options?.isPrimary,
        moveFromProject: options?.force,
      }),
    })
  }

  async unlinkRepositoryFromProject(
    repositoryId: string,
    projectId: string
  ): Promise<{ success: boolean }> {
    return this.fetch(`/api/projects/${projectId}/repositories/${repositoryId}`, {
      method: 'DELETE',
    })
  }

  // Git
  async getBranches(repo: string): Promise<GitBranchesResponse> {
    return this.fetch(`/api/git/branches?repo=${encodeURIComponent(repo)}`)
  }

  async getDiff(path: string, options?: DiffQueryOptions): Promise<GitDiffResponse> {
    const params = new URLSearchParams({ path })
    if (options?.staged) params.set('staged', 'true')
    if (options?.ignoreWhitespace) params.set('ignoreWhitespace', 'true')
    if (options?.includeUntracked) params.set('includeUntracked', 'true')
    return this.fetch(`/api/git/diff?${params}`)
  }

  async getStatus(path: string): Promise<GitStatusResponse> {
    return this.fetch(`/api/git/status?path=${encodeURIComponent(path)}`)
  }

  // Worktrees
  async listWorktrees(): Promise<WorktreesResponse> {
    return this.fetch('/api/worktrees')
  }

  async deleteWorktree(
    worktreePath: string,
    repoPath?: string,
    deleteLinkedTask?: boolean
  ): Promise<{ success: true; path: string; deletedTaskId?: string }> {
    return this.fetch('/api/worktrees', {
      method: 'DELETE',
      body: JSON.stringify({ worktreePath, repoPath, deleteLinkedTask }),
    })
  }

  // Config
  async getAllConfig(): Promise<Record<string, unknown>> {
    return this.fetch('/api/config')
  }

  async getConfig(key: string): Promise<ConfigResponse> {
    return this.fetch(`/api/config/${key}`)
  }

  async setConfig(key: string, value: string | number): Promise<ConfigResponse> {
    return this.fetch(`/api/config/${key}`, {
      method: 'PUT',
      body: JSON.stringify({ value }),
    })
  }

  async resetConfig(key: string): Promise<ConfigResponse> {
    return this.fetch(`/api/config/${key}`, { method: 'DELETE' })
  }

  // Notifications
  async getNotifications(): Promise<NotificationSettings> {
    return this.fetch('/api/config/notifications')
  }

  async updateNotifications(updates: Partial<NotificationSettings>): Promise<NotificationSettings> {
    // Fetch current settings first to get _updatedAt for optimistic locking
    const current = await this.getNotifications()
    return this.fetch('/api/config/notifications', {
      method: 'PUT',
      body: JSON.stringify({ ...updates, _updatedAt: current._updatedAt }),
    })
  }

  async testNotification(
    channel: 'sound' | 'slack' | 'discord' | 'pushover' | 'whatsapp' | 'telegram' | 'gmail'
  ): Promise<NotificationTestResult> {
    return this.fetch(`/api/config/notifications/test/${channel}`, {
      method: 'POST',
    })
  }

  async sendNotification(
    title: string,
    message: string
  ): Promise<{ success: boolean; results: NotificationTestResult[] }> {
    return this.fetch('/api/config/notifications/send', {
      method: 'POST',
      body: JSON.stringify({ title, message }),
    })
  }

  // Server expose (Cloudflare Tunnel for the Fulcrum UI)
  async getServerExpose(): Promise<{
    publicDomain: string | null
    tailscaleHostname: string | null
    detectedTailscaleHostname: string | null
    tunnelAvailable: boolean
    tunnelId: string | null
    tunnelStatus: string | null
  }> {
    return this.fetch('/api/server/expose')
  }

  async createServerExpose(input: { subdomain: string; domain: string }): Promise<{
    success: boolean
    publicDomain: string
    tunnelId: string
    tunnelName: string
    tunnelToken: string | null
    reusedExisting: boolean
    accessSetupUrl: string
  }> {
    return this.fetch('/api/server/expose', {
      method: 'POST',
      body: JSON.stringify(input),
    })
  }

  async deleteServerExpose(removeTunnel?: boolean): Promise<{ success: boolean; tunnelDeleted?: boolean }> {
    const query = removeTunnel ? '?removeTunnel=true' : ''
    return this.fetch(`/api/server/expose${query}`, { method: 'DELETE' })
  }

  // Developer mode
  async getDeveloperMode(): Promise<{ enabled: boolean }> {
    return this.fetch('/api/config/developer-mode')
  }

  async restartFulcrum(): Promise<{ success?: boolean; message?: string; error?: string }> {
    return this.fetch('/api/config/restart', {
      method: 'POST',
    })
  }

  // Command execution
  async executeCommand(
    command: string,
    options?: { sessionId?: string; cwd?: string; timeout?: number; name?: string }
  ): Promise<ExecuteCommandResponse> {
    const body: ExecuteCommandRequest = {
      command,
      ...options,
    }
    return this.fetch('/api/exec', {
      method: 'POST',
      body: JSON.stringify(body),
    })
  }

  async listExecSessions(): Promise<ExecSession[]> {
    return this.fetch('/api/exec/sessions')
  }

  async updateExecSession(sessionId: string, updates: { name?: string }): Promise<ExecSession> {
    return this.fetch(`/api/exec/sessions/${sessionId}`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    })
  }

  async destroyExecSession(sessionId: string): Promise<{ success: boolean }> {
    return this.fetch(`/api/exec/sessions/${sessionId}`, {
      method: 'DELETE',
    })
  }

  // Task links
  async addTaskLink(taskId: string, url: string, label?: string): Promise<TaskLink> {
    return this.fetch(`/api/tasks/${taskId}/links`, {
      method: 'POST',
      body: JSON.stringify({ url, label }),
    })
  }

  async removeTaskLink(taskId: string, linkId: string): Promise<{ success: boolean }> {
    return this.fetch(`/api/tasks/${taskId}/links/${linkId}`, {
      method: 'DELETE',
    })
  }

  async listTaskLinks(taskId: string): Promise<TaskLink[]> {
    return this.fetch(`/api/tasks/${taskId}/links`)
  }

  // Task tags
  async addTaskTag(taskId: string, tag: string): Promise<TaskTagsResponse> {
    return this.fetch(`/api/tasks/${taskId}/tags`, {
      method: 'POST',
      body: JSON.stringify({ tag }),
    })
  }

  async removeTaskTag(taskId: string, tag: string): Promise<TaskTagsResponse> {
    return this.fetch(`/api/tasks/${taskId}/tags/${encodeURIComponent(tag)}`, {
      method: 'DELETE',
    })
  }

  // Tags (global)
  async deleteTag(tagName: string): Promise<{ success: boolean }> {
    const allTags: TagWithUsage[] = await this.fetch('/api/tags')
    const tag = allTags.find((t) => t.name === tagName)
    if (!tag) throw new ApiError(404, 'Tag not found')
    return this.fetch(`/api/tags/${tag.id}`, { method: 'DELETE' })
  }

  // Task due date
  async setTaskDueDate(taskId: string, dueDate: string | null): Promise<TaskDueDateResponse> {
    return this.fetch(`/api/tasks/${taskId}/due-date`, {
      method: 'PATCH',
      body: JSON.stringify({ dueDate }),
    })
  }

  // Task dependencies
  async getTaskDependencies(taskId: string): Promise<TaskDependenciesResponse> {
    return this.fetch(`/api/tasks/${taskId}/dependencies`)
  }

  async addTaskDependency(taskId: string, dependsOnTaskId: string): Promise<TaskDependency> {
    return this.fetch(`/api/tasks/${taskId}/dependencies`, {
      method: 'POST',
      body: JSON.stringify({ dependsOnTaskId }),
    })
  }

  async removeTaskDependency(taskId: string, depId: string): Promise<{ success: boolean }> {
    return this.fetch(`/api/tasks/${taskId}/dependencies/${depId}`, {
      method: 'DELETE',
    })
  }

  // Task attachments
  async listTaskAttachments(taskId: string): Promise<TaskAttachment[]> {
    return this.fetch(`/api/tasks/${taskId}/attachments`)
  }

  async uploadTaskAttachment(taskId: string, filePath: string): Promise<TaskAttachment> {
    // Read file from local filesystem
    const fileContent = readFileSync(filePath)
    const filename = basename(filePath)

    // Create form data with blob
    const formData = new FormData()
    const blob = new Blob([fileContent])
    formData.append('file', blob, filename)

    // Make request without Content-Type header (let browser set it with boundary)
    const url = `${this.baseUrl}/api/tasks/${taskId}/attachments`
    const res = await fetch(url, {
      method: 'POST',
      body: formData,
    })

    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new ApiError(res.status, body.error || body.message || `Request failed: ${res.status}`)
    }

    return res.json()
  }

  async deleteTaskAttachment(taskId: string, attachmentId: string): Promise<{ success: boolean }> {
    return this.fetch(`/api/tasks/${taskId}/attachments/${attachmentId}`, {
      method: 'DELETE',
    })
  }

  async getTaskAttachmentPath(taskId: string, attachmentId: string): Promise<{ path: string; filename: string; mimeType: string }> {
    // Get all attachments and find the one we need
    const attachments = await this.listTaskAttachments(taskId)
    const attachment = attachments.find((a) => a.id === attachmentId)
    if (!attachment) {
      throw new ApiError(404, `Attachment not found: ${attachmentId}`)
    }
    return { path: attachment.storedPath, filename: attachment.filename, mimeType: attachment.mimeType }
  }

  // Task dependency graph
  async getTaskDependencyGraph(): Promise<{
    nodes: Array<{ id: string; title: string; status: TaskStatus; projectId: string | null; tags: string[]; dueDate: string | null }>
    edges: Array<{ id: string; source: string; target: string }>
  }> {
    return this.fetch('/api/task-dependencies/graph')
  }

  // Projects
  async listProjects(): Promise<ProjectWithDetails[]> {
    return this.fetch('/api/projects')
  }

  async getProject(id: string): Promise<ProjectWithDetails> {
    return this.fetch(`/api/projects/${id}`)
  }

  async createProject(data: CreateProjectInput): Promise<ProjectWithDetails> {
    return this.fetch('/api/projects', {
      method: 'POST',
      body: JSON.stringify(data),
    })
  }

  async updateProject(id: string, updates: UpdateProjectInput): Promise<ProjectWithDetails> {
    return this.fetch(`/api/projects/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    })
  }

  async deleteProject(
    id: string,
    options?: DeleteProjectOptions
  ): Promise<{ success: true; deletedDirectory: boolean; deletedApp: boolean }> {
    const params = new URLSearchParams()
    if (options?.deleteDirectory) params.set('deleteDirectory', 'true')
    if (options?.deleteApp) params.set('deleteApp', 'true')
    const query = params.toString() ? `?${params.toString()}` : ''
    return this.fetch(`/api/projects/${id}${query}`, { method: 'DELETE' })
  }

  async scanProjects(
    directory?: string
  ): Promise<{
    directory: string
    repositories: Array<{
      path: string
      name: string
      hasRepository: boolean
      hasProject: boolean
    }>
  }> {
    return this.fetch('/api/projects/scan', {
      method: 'POST',
      body: JSON.stringify({ directory }),
    })
  }

  async bulkCreateProjects(
    repositories: Array<{ path: string; displayName?: string }>
  ): Promise<{ created: ProjectWithDetails[]; skipped: number }> {
    return this.fetch('/api/projects/bulk', {
      method: 'POST',
      body: JSON.stringify({ repositories }),
    })
  }

  // Project tags
  async addProjectTag(projectId: string, tagIdOrName: string): Promise<Tag> {
    // Check if it looks like an ID (nanoid format) or a name
    const isId = tagIdOrName.length === 21 && /^[a-zA-Z0-9_-]+$/.test(tagIdOrName)
    return this.fetch(`/api/projects/${projectId}/tags`, {
      method: 'POST',
      body: JSON.stringify(isId ? { tagId: tagIdOrName } : { name: tagIdOrName }),
    })
  }

  async removeProjectTag(projectId: string, tagId: string): Promise<{ success: boolean }> {
    return this.fetch(`/api/projects/${projectId}/tags/${tagId}`, {
      method: 'DELETE',
    })
  }

  // Project attachments
  async listProjectAttachments(projectId: string): Promise<ProjectAttachment[]> {
    return this.fetch(`/api/projects/${projectId}/attachments`)
  }

  async uploadProjectAttachment(projectId: string, filePath: string): Promise<ProjectAttachment> {
    const fileContent = readFileSync(filePath)
    const filename = basename(filePath)

    const formData = new FormData()
    const blob = new Blob([fileContent])
    formData.append('file', blob, filename)

    const url = `${this.baseUrl}/api/projects/${projectId}/attachments`
    const res = await fetch(url, {
      method: 'POST',
      body: formData,
    })

    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new ApiError(res.status, body.error || body.message || `Request failed: ${res.status}`)
    }

    return res.json()
  }

  async deleteProjectAttachment(projectId: string, attachmentId: string): Promise<{ success: boolean }> {
    return this.fetch(`/api/projects/${projectId}/attachments/${attachmentId}`, {
      method: 'DELETE',
    })
  }

  async getProjectAttachmentPath(projectId: string, attachmentId: string): Promise<{ path: string; filename: string; mimeType: string }> {
    const attachments = await this.listProjectAttachments(projectId)
    const attachment = attachments.find((a) => a.id === attachmentId)
    if (!attachment) {
      throw new ApiError(404, `Attachment not found: ${attachmentId}`)
    }
    return { path: attachment.storedPath, filename: attachment.filename, mimeType: attachment.mimeType }
  }

  // Project links
  async listProjectLinks(projectId: string): Promise<ProjectLink[]> {
    return this.fetch(`/api/projects/${projectId}/links`)
  }

  async addProjectLink(projectId: string, url: string, label?: string): Promise<ProjectLink> {
    return this.fetch(`/api/projects/${projectId}/links`, {
      method: 'POST',
      body: JSON.stringify({ url, label }),
    })
  }

  async removeProjectLink(projectId: string, linkId: string): Promise<{ success: boolean }> {
    return this.fetch(`/api/projects/${projectId}/links/${linkId}`, {
      method: 'DELETE',
    })
  }

  // Apps
  async listApps(): Promise<App[]> {
    return this.fetch('/api/apps')
  }

  async getApp(id: string): Promise<App> {
    return this.fetch(`/api/apps/${id}`)
  }

  async createApp(data: CreateAppInput): Promise<App> {
    return this.fetch('/api/apps', {
      method: 'POST',
      body: JSON.stringify(data),
    })
  }

  async updateApp(id: string, updates: UpdateAppInput): Promise<App> {
    return this.fetch(`/api/apps/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    })
  }

  async deleteApp(
    id: string,
    stopContainers: boolean = true
  ): Promise<{ success: true }> {
    const query = stopContainers ? '' : '?stopContainers=false'
    return this.fetch(`/api/apps/${id}${query}`, { method: 'DELETE' })
  }

  async deployApp(id: string): Promise<{ success: boolean; deployment?: Deployment; error?: string }> {
    return this.fetch(`/api/apps/${id}/deploy`, { method: 'POST' })
  }

  async stopApp(id: string): Promise<{ success: boolean; error?: string }> {
    return this.fetch(`/api/apps/${id}/stop`, { method: 'POST' })
  }

  async getAppLogs(id: string, options?: AppLogOptions): Promise<{ logs: string }> {
    const params = new URLSearchParams()
    if (options?.service) params.set('service', options.service)
    if (options?.tail) params.set('tail', String(options.tail))
    const query = params.toString() ? `?${params.toString()}` : ''
    return this.fetch(`/api/apps/${id}/logs${query}`)
  }

  async getAppStatus(id: string): Promise<AppStatus> {
    return this.fetch(`/api/apps/${id}/status`)
  }

  async listDeployments(appId: string): Promise<Deployment[]> {
    return this.fetch(`/api/apps/${appId}/deployments`)
  }

  async syncAppServices(id: string): Promise<{
    success: boolean
    services: Array<{
      serviceName: string
      containerPort: number | null
      exposed: boolean
      domain: string | null
    }>
  }> {
    return this.fetch(`/api/apps/${id}/sync-services`, { method: 'POST' })
  }

  // Filesystem
  async listDirectory(path?: string): Promise<ListDirectoryResponse> {
    const query = path ? `?path=${encodeURIComponent(path)}` : ''
    return this.fetch(`/api/fs/list${query}`)
  }

  async getFileTree(root: string): Promise<FileTreeResponse> {
    return this.fetch(`/api/fs/tree?root=${encodeURIComponent(root)}`)
  }

  async readFile(
    path: string,
    root: string,
    maxLines?: number
  ): Promise<FileContent> {
    const params = new URLSearchParams({ path, root })
    if (maxLines) params.set('maxLines', String(maxLines))
    return this.fetch(`/api/fs/read?${params.toString()}`)
  }

  async writeFile(input: WriteFileInput): Promise<{ success: true; size: number; mtime: string }> {
    return this.fetch('/api/fs/write', {
      method: 'POST',
      body: JSON.stringify(input),
    })
  }

  async editFile(input: EditFileInput): Promise<{ success: true; size: number; mtime: string }> {
    return this.fetch('/api/fs/edit', {
      method: 'POST',
      body: JSON.stringify(input),
    })
  }

  async getFileStat(path: string, root: string): Promise<FileStatResponse> {
    const params = new URLSearchParams({ path, root })
    return this.fetch(`/api/fs/file-stat?${params.toString()}`)
  }

  async getPathStat(path: string): Promise<PathStatResponse> {
    return this.fetch(`/api/fs/stat?path=${encodeURIComponent(path)}`)
  }

  async isGitRepo(path: string): Promise<{ path: string; isGitRepo: boolean }> {
    return this.fetch(`/api/fs/is-git-repo?path=${encodeURIComponent(path)}`)
  }

  // Backup and restore
  async listBackups(): Promise<{ backups: BackupInfo[]; backupsDir: string }> {
    return this.fetch('/api/backup')
  }

  async createBackup(description?: string): Promise<BackupCreateResult> {
    return this.fetch('/api/backup', {
      method: 'POST',
      body: JSON.stringify({ description }),
    })
  }

  async getBackup(name: string): Promise<{ name: string; path: string; manifest: BackupManifest }> {
    return this.fetch(`/api/backup/${encodeURIComponent(name)}`)
  }

  async restoreBackup(
    name: string,
    options?: { database?: boolean; settings?: boolean }
  ): Promise<BackupRestoreResult> {
    return this.fetch(`/api/backup/${encodeURIComponent(name)}/restore`, {
      method: 'POST',
      body: JSON.stringify(options ?? {}),
    })
  }

  async deleteBackup(name: string): Promise<{ success: boolean; deleted: string }> {
    return this.fetch(`/api/backup/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    })
  }

  // Email
  async listEmails(options?: {
    limit?: number
    offset?: number
    direction?: 'incoming' | 'outgoing'
    threadId?: string
    search?: string
    folder?: string
  }): Promise<{ emails: StoredEmail[]; count: number }> {
    const params = new URLSearchParams()
    if (options?.limit) params.set('limit', String(options.limit))
    if (options?.offset) params.set('offset', String(options.offset))
    if (options?.direction) params.set('direction', options.direction)
    if (options?.threadId) params.set('threadId', options.threadId)
    if (options?.search) params.set('search', options.search)
    if (options?.folder) params.set('folder', options.folder)
    const query = params.toString()
    return this.fetch(`/api/messaging/email/emails${query ? `?${query}` : ''}`)
  }

  async getEmail(id: string): Promise<StoredEmail> {
    return this.fetch(`/api/messaging/email/emails/${id}`)
  }

  async getMessage(id: string): Promise<Record<string, unknown>> {
    return this.fetch(`/api/messaging/messages/${id}`)
  }

  async searchEmails(criteria: {
    subject?: string
    from?: string
    to?: string
    since?: string
    before?: string
    text?: string
    seen?: boolean
    flagged?: boolean
    fetchLimit?: number
  }): Promise<{
    matchingUids: number[]
    matchCount: number
    fetched: number
    emails: StoredEmail[]
  }> {
    return this.fetch('/api/messaging/email/search', {
      method: 'POST',
      body: JSON.stringify(criteria),
    })
  }

  async fetchEmails(uids: number[], limit?: number): Promise<{
    fetched: number
    emails: StoredEmail[]
  }> {
    return this.fetch('/api/messaging/email/fetch', {
      method: 'POST',
      body: JSON.stringify({ uids, limit }),
    })
  }

  // Assistant - Sweep Runs
  async listSweepRuns(options?: { type?: string; limit?: number }): Promise<{ runs: SweepRun[] }> {
    const params = new URLSearchParams()
    if (options?.type) params.set('type', options.type)
    if (options?.limit) params.set('limit', String(options.limit))
    const query = params.toString()
    return this.fetch(`/api/assistant/sweeps${query ? `?${query}` : ''}`)
  }

  async getSweepRun(id: string): Promise<SweepRun> {
    return this.fetch(`/api/assistant/sweeps/${id}`)
  }

  async getLastSweepRun(type: string): Promise<SweepRun | null> {
    return this.fetch(`/api/assistant/sweeps/last/${type}`)
  }

  // Messaging - Send Message
  async sendMessage(data: {
    channel: 'whatsapp' | 'discord' | 'telegram' | 'slack'
    body: string
    subject?: string
    replyToMessageId?: string
    slackBlocks?: Array<Record<string, unknown>>
    filePath?: string
  }): Promise<{ success: boolean; messageId?: string; error?: string }> {
    return this.fetch('/api/messaging/send', {
      method: 'POST',
      body: JSON.stringify(data),
    })
  }

  // CalDAV
  async getCaldavStatus(): Promise<{
    connected: boolean
    syncing: boolean
    lastError: string | null
    calendarCount: number
  }> {
    return this.fetch('/api/caldav/status')
  }

  async listCalendars(accountId?: string): Promise<CaldavCalendar[]> {
    const params = accountId ? `?accountId=${accountId}` : ''
    return this.fetch(`/api/caldav/calendars${params}`)
  }

  // CalDAV Accounts
  async listCaldavAccounts(): Promise<CaldavAccount[]> {
    return this.fetch('/api/caldav/accounts')
  }

  async createCaldavAccount(input: {
    name: string
    serverUrl: string
    username: string
    password: string
    syncIntervalMinutes?: number
  }): Promise<CaldavAccount> {
    return this.fetch('/api/caldav/accounts', {
      method: 'POST',
      body: JSON.stringify(input),
    })
  }

  async deleteCaldavAccount(id: string): Promise<{ success: boolean }> {
    return this.fetch(`/api/caldav/accounts/${id}`, { method: 'DELETE' })
  }

  async syncCaldavAccount(id: string): Promise<{ success: boolean }> {
    return this.fetch(`/api/caldav/accounts/${id}/sync`, { method: 'POST' })
  }

  // CalDAV Copy Rules
  async listCaldavCopyRules(): Promise<CaldavCopyRule[]> {
    return this.fetch('/api/caldav/copy-rules')
  }

  async createCaldavCopyRule(input: {
    name?: string
    sourceCalendarId: string
    destCalendarId: string
  }): Promise<CaldavCopyRule> {
    return this.fetch('/api/caldav/copy-rules', {
      method: 'POST',
      body: JSON.stringify(input),
    })
  }

  async deleteCaldavCopyRule(id: string): Promise<{ success: boolean }> {
    return this.fetch(`/api/caldav/copy-rules/${id}`, { method: 'DELETE' })
  }

  async executeCaldavCopyRule(id: string): Promise<{ created: number; updated: number }> {
    return this.fetch(`/api/caldav/copy-rules/${id}/execute`, { method: 'POST' })
  }

  async syncCalendars(): Promise<{ success: boolean }> {
    return this.fetch('/api/caldav/sync', { method: 'POST' })
  }

  async listCalendarEvents(options?: {
    calendarId?: string
    from?: string
    to?: string
    limit?: number
  }): Promise<CaldavEvent[]> {
    const params = new URLSearchParams()
    if (options?.calendarId) params.set('calendarId', options.calendarId)
    if (options?.from) params.set('from', options.from)
    if (options?.to) params.set('to', options.to)
    if (options?.limit) params.set('limit', String(options.limit))
    const query = params.toString()
    return this.fetch(`/api/caldav/events${query ? `?${query}` : ''}`)
  }

  async getCalendarEvent(id: string): Promise<CaldavEvent> {
    return this.fetch(`/api/caldav/events/${id}`)
  }

  async createCalendarEvent(input: {
    calendarId: string
    summary: string
    dtstart: string
    dtend?: string
    duration?: string
    description?: string
    location?: string
    allDay?: boolean
    recurrenceRule?: string
    status?: string
  }): Promise<CaldavEvent> {
    return this.fetch('/api/caldav/events', {
      method: 'POST',
      body: JSON.stringify(input),
    })
  }

  async updateCalendarEvent(id: string, updates: {
    summary?: string
    dtstart?: string
    dtend?: string
    duration?: string
    description?: string
    location?: string
    allDay?: boolean
    recurrenceRule?: string
    status?: string
  }): Promise<CaldavEvent> {
    return this.fetch(`/api/caldav/events/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    })
  }

  async deleteCalendarEvent(id: string): Promise<{ success: boolean }> {
    return this.fetch(`/api/caldav/events/${id}`, {
      method: 'DELETE',
    })
  }

  // Memory
  async storeMemory(input: { content: string; tags?: string[]; source?: string }): Promise<{
    id: string
    content: string
    tags: string[] | null
    source: string | null
    createdAt: string
    updatedAt: string
  }> {
    return this.fetch('/api/memory', {
      method: 'POST',
      body: JSON.stringify(input),
    })
  }

  async searchMemories(input: {
    query: string
    tags?: string[]
    limit?: number
  }): Promise<Array<{
    id: string
    content: string
    tags: string[] | null
    source: string | null
    createdAt: string
    updatedAt: string
    rank?: number
  }>> {
    const params = new URLSearchParams({ q: input.query })
    if (input.tags?.length) params.set('tags', input.tags.join(','))
    if (input.limit) params.set('limit', String(input.limit))
    return this.fetch(`/api/memory/search?${params.toString()}`)
  }

  async listMemories(input?: {
    tags?: string[]
    limit?: number
    offset?: number
  }): Promise<{
    memories: Array<{
      id: string
      content: string
      tags: string[] | null
      source: string | null
      createdAt: string
      updatedAt: string
    }>
    total: number
  }> {
    const params = new URLSearchParams()
    if (input?.tags?.length) params.set('tags', input.tags.join(','))
    if (input?.limit) params.set('limit', String(input.limit))
    if (input?.offset) params.set('offset', String(input.offset))
    const query = params.toString()
    return this.fetch(`/api/memory${query ? `?${query}` : ''}`)
  }

  async deleteMemory(id: string): Promise<{ success: boolean }> {
    return this.fetch(`/api/memory/${id}`, { method: 'DELETE' })
  }

  // Google Accounts
  async listGoogleAccounts(): Promise<GoogleAccount[]> {
    const result = await this.fetch<{ accounts: GoogleAccount[] }>('/api/google/accounts')
    return result.accounts
  }

  async getGoogleAccount(id: string): Promise<GoogleAccount> {
    return this.fetch(`/api/google/accounts/${id}`)
  }

  async deleteGoogleAccount(id: string): Promise<{ success: boolean }> {
    return this.fetch(`/api/google/accounts/${id}`, { method: 'DELETE' })
  }

  async enableGoogleCalendar(id: string): Promise<{ success: boolean }> {
    return this.fetch(`/api/google/accounts/${id}/enable-calendar`, { method: 'POST' })
  }

  async disableGoogleCalendar(id: string): Promise<{ success: boolean }> {
    return this.fetch(`/api/google/accounts/${id}/disable-calendar`, { method: 'POST' })
  }

  async enableGmail(id: string): Promise<{ success: boolean }> {
    return this.fetch(`/api/google/accounts/${id}/enable-gmail`, { method: 'POST' })
  }

  async disableGmail(id: string): Promise<{ success: boolean }> {
    return this.fetch(`/api/google/accounts/${id}/disable-gmail`, { method: 'POST' })
  }

  async syncGoogleCalendar(id: string): Promise<{ success: boolean }> {
    return this.fetch(`/api/google/accounts/${id}/sync`, { method: 'POST' })
  }

  // Gmail Drafts
  async listGmailDrafts(accountId: string): Promise<GmailDraftSummary[]> {
    const result = await this.fetch<{ drafts: GmailDraftSummary[] }>(`/api/google/accounts/${accountId}/drafts`)
    return result.drafts
  }

  async createGmailDraft(accountId: string, input: {
    to?: string[]
    cc?: string[]
    bcc?: string[]
    subject?: string
    body?: string
    htmlBody?: string
  }): Promise<{ draftId: string; messageId: string | null }> {
    return this.fetch(`/api/google/accounts/${accountId}/drafts`, {
      method: 'POST',
      body: JSON.stringify(input),
    })
  }

  async updateGmailDraft(accountId: string, draftId: string, input: {
    to?: string[]
    cc?: string[]
    bcc?: string[]
    subject?: string
    body?: string
    htmlBody?: string
  }): Promise<{ draftId: string; messageId: string | null }> {
    return this.fetch(`/api/google/accounts/${accountId}/drafts/${draftId}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    })
  }

  async deleteGmailDraft(accountId: string, draftId: string): Promise<{ success: boolean }> {
    return this.fetch(`/api/google/accounts/${accountId}/drafts/${draftId}`, { method: 'DELETE' })
  }

  async sendGmailMessage(
    accountId: string,
    body: string,
    subject?: string
  ): Promise<{ success: boolean; messageId: string }> {
    return this.fetch(`/api/google/accounts/${accountId}/send`, {
      method: 'POST',
      body: JSON.stringify({ body, subject }),
    })
  }

  // Memory File
  async readMemoryFile(): Promise<{ content: string }> {
    return this.fetch('/api/memory-file')
  }

  async writeMemoryFile(content: string): Promise<{ success: boolean }> {
    return this.fetch('/api/memory-file', {
      method: 'PUT',
      body: JSON.stringify({ content }),
    })
  }

  async updateMemoryFileSection(heading: string, content: string): Promise<{ success: boolean }> {
    return this.fetch('/api/memory-file/section', {
      method: 'PATCH',
      body: JSON.stringify({ heading, content }),
    })
  }

  // Jobs
  async listJobs(scope?: 'all' | 'user' | 'system'): Promise<SystemdTimer[]> {
    const params = new URLSearchParams()
    if (scope) params.set('scope', scope)
    const query = params.toString() ? `?${params.toString()}` : ''
    return this.fetch(`/api/jobs${query}`)
  }

  async getJob(name: string, scope?: JobScope): Promise<SystemdTimerDetail> {
    const params = new URLSearchParams()
    if (scope) params.set('scope', scope)
    const query = params.toString() ? `?${params.toString()}` : ''
    return this.fetch(`/api/jobs/${encodeURIComponent(name)}${query}`)
  }

  async getJobLogs(name: string, scope?: JobScope, lines?: number): Promise<{ entries: JobLogEntry[] }> {
    const params = new URLSearchParams()
    if (scope) params.set('scope', scope)
    if (lines) params.set('lines', String(lines))
    const query = params.toString() ? `?${params.toString()}` : ''
    return this.fetch(`/api/jobs/${encodeURIComponent(name)}/logs${query}`)
  }

  async createJob(data: CreateTimerRequest): Promise<{ success: true }> {
    return this.fetch('/api/jobs', {
      method: 'POST',
      body: JSON.stringify(data),
    })
  }

  async updateJob(name: string, updates: UpdateTimerRequest): Promise<{ success: true }> {
    return this.fetch(`/api/jobs/${encodeURIComponent(name)}`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    })
  }

  async deleteJob(name: string): Promise<{ success: true }> {
    return this.fetch(`/api/jobs/${encodeURIComponent(name)}`, { method: 'DELETE' })
  }

  async enableJob(name: string, scope?: JobScope): Promise<{ success: true }> {
    const params = new URLSearchParams()
    if (scope) params.set('scope', scope)
    const query = params.toString() ? `?${params.toString()}` : ''
    return this.fetch(`/api/jobs/${encodeURIComponent(name)}/enable${query}`, { method: 'POST' })
  }

  async disableJob(name: string, scope?: JobScope): Promise<{ success: true }> {
    const params = new URLSearchParams()
    if (scope) params.set('scope', scope)
    const query = params.toString() ? `?${params.toString()}` : ''
    return this.fetch(`/api/jobs/${encodeURIComponent(name)}/disable${query}`, { method: 'POST' })
  }

  async runJobNow(name: string, scope?: JobScope): Promise<{ success: true }> {
    const params = new URLSearchParams()
    if (scope) params.set('scope', scope)
    const query = params.toString() ? `?${params.toString()}` : ''
    return this.fetch(`/api/jobs/${encodeURIComponent(name)}/run${query}`, { method: 'POST' })
  }

  // Copier Templates
  async listTemplates(): Promise<Repository[]> {
    const repos = await this.listRepositories()
    return repos.filter((r) => r.isCopierTemplate)
  }

  async getTemplateQuestions(source: string): Promise<CopierQuestionsResponse> {
    return this.fetch(`/api/copier/questions?source=${encodeURIComponent(source)}`)
  }

  async createFromTemplate(data: CreateProjectRequest): Promise<CreateProjectResponse> {
    return this.fetch('/api/copier/create', {
      method: 'POST',
      body: JSON.stringify(data),
    })
  }

  // Unified Search
  async search(input: {
    query: string
    entities?: string[]
    limit?: number
    taskStatus?: string[]
    projectStatus?: string
    messageChannel?: string
    messageDirection?: string
    eventFrom?: string
    eventTo?: string
    memoryTags?: string[]
    conversationRole?: string
    conversationProvider?: string
    conversationProjectId?: string
    gmailFrom?: string
    gmailTo?: string
    gmailAfter?: string
    gmailBefore?: string
  }): Promise<Array<{
    entityType: string
    id: string
    title: string
    snippet: string
    score: number
    metadata: Record<string, unknown>
  }>> {
    const params = new URLSearchParams({ q: input.query })
    if (input.entities?.length) params.set('entities', input.entities.join(','))
    if (input.limit) params.set('limit', String(input.limit))
    if (input.taskStatus?.length) params.set('taskStatus', input.taskStatus.join(','))
    if (input.projectStatus) params.set('projectStatus', input.projectStatus)
    if (input.messageChannel) params.set('messageChannel', input.messageChannel)
    if (input.messageDirection) params.set('messageDirection', input.messageDirection)
    if (input.eventFrom) params.set('eventFrom', input.eventFrom)
    if (input.eventTo) params.set('eventTo', input.eventTo)
    if (input.memoryTags?.length) params.set('memoryTags', input.memoryTags.join(','))
    if (input.conversationRole) params.set('conversationRole', input.conversationRole)
    if (input.conversationProvider) params.set('conversationProvider', input.conversationProvider)
    if (input.conversationProjectId) params.set('conversationProjectId', input.conversationProjectId)
    if (input.gmailFrom) params.set('gmailFrom', input.gmailFrom)
    if (input.gmailTo) params.set('gmailTo', input.gmailTo)
    if (input.gmailAfter) params.set('gmailAfter', input.gmailAfter)
    if (input.gmailBefore) params.set('gmailBefore', input.gmailBefore)
    return this.fetch(`/api/search?${params.toString()}`)
  }

  // D-8 PR 3b — user management.
  async listUsers(): Promise<{
    users: Array<{
      id: string
      email: string
      displayName: string | null
      isAdmin: boolean
      createdAt: string
      lastSeenAt: string | null
    }>
  }> {
    return this.fetch('/api/users')
  }

  async inviteUser(input: {
    email: string
    isAdmin?: boolean
    displayName?: string | null
  }): Promise<{
    user: { id: string; email: string; isAdmin: boolean; lastSeenAt: string | null }
    invitedBy: string
  }> {
    return this.fetch('/api/users', {
      method: 'POST',
      body: JSON.stringify(input),
    })
  }

  async setUserAdmin(
    userId: string,
    isAdmin: boolean
  ): Promise<{ user: { id: string; email: string; isAdmin: boolean }; grantedBy: string }> {
    return this.fetch(`/api/users/${userId}/admin`, {
      method: 'PATCH',
      body: JSON.stringify({ isAdmin }),
    })
  }

  // Self / /me — useful for `fulcrum login` verification.
  async getCurrentUser(): Promise<{
    user: {
      id: string
      email: string
      isAdmin: boolean
    } | null
  }> {
    return this.fetch('/api/users/me')
  }

  // D-9 Phase C — return the most recent page-context snapshot the
  // user's browser has published. Used by MCP tools so an agent can
  // answer "what is the user looking at?" without polling the page.
  async getPageContext(): Promise<{
    context: {
      route: string
      selection?: { kind: string; id: string } | null
      visibleEntities?: Record<string, string[] | undefined>
      metadata?: Record<string, unknown>
      updatedAt: string
    } | null
  }> {
    return this.fetch('/api/users/me/page-context')
  }
}