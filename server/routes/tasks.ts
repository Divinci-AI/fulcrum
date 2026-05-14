import { Hono } from 'hono'
import { nanoid } from 'nanoid'
import { db, tasks, repositories, taskLinks, taskRelationships, taskAttachments, tags, taskTags, type Task, type NewTask, type TaskLink } from '../db'
import { eq, asc, and, inArray } from 'drizzle-orm'
import { detectLinkType } from '../lib/link-utils'
import { execSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { getFulcrumDir, getScratchBasePath } from '../lib/settings'
import {
  getPTYManager,
  destroyTerminalAndBroadcast,
  killClaudeInTerminalsForWorktree,
} from '../terminal/pty-instance'
import { broadcast, broadcastToTopic } from '../websocket/terminal-ws'
import { updateTaskStatus } from '../services/task-status'
import { reindexTaskFTS } from '../services/search-service'
import { buildMentionText, syncAndNotify } from '../services/mention-service'
import { grantCreatorAdmin, ensureAssigneeViewer, effectiveRole, roleSatisfies } from '../services/access-control-service'
import { mentions } from '../db'
import { log } from '../lib/logger'
import { createGitWorktree, copyFilesToWorktree } from '../lib/git-utils'

// Helper to delete git worktree
function deleteGitWorktree(repoPath: string, worktreePath: string): void {
  if (!fs.existsSync(worktreePath)) return

  try {
    execSync(`git worktree remove "${worktreePath}" --force`, {
      cwd: repoPath,
      encoding: 'utf-8',
    })
  } catch {
    // If git worktree remove fails, manually remove and prune
    fs.rmSync(worktreePath, { recursive: true, force: true })
    try {
      execSync('git worktree prune', { cwd: repoPath, encoding: 'utf-8' })
    } catch {
      // Ignore prune errors
    }
  }
}

// Helper to destroy terminals associated with a worktree path
function destroyTerminalsForWorktree(worktreePath: string): void {
  try {
    const ptyManager = getPTYManager()
    const terminals = ptyManager.listTerminals()
    for (const terminal of terminals) {
      if (terminal.cwd === worktreePath) {
        destroyTerminalAndBroadcast(terminal.id)
      }
    }
  } catch {
    // PTY manager might not be initialized yet, ignore
  }
}

// MIME types we'll render inline via ?inline=1. Everything else is forced to
// download regardless of the query param, so an uploaded HTML/SVG can't execute
// in the app's origin.
const INLINE_SAFE_MIME_TYPES = new Set([
  'application/pdf',
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'text/plain', 'text/markdown',
])

// Max file size: 50MB
const MAX_FILE_SIZE = 50 * 1024 * 1024

// Get the uploads directory for a task
function getTaskUploadsDir(taskId: string): string {
  return path.join(getFulcrumDir(), 'uploads', 'tasks', taskId)
}

// Sanitize filename for storage
function sanitizeFilename(filename: string): string {
  return filename.replace(/[^a-zA-Z0-9._-]/g, '_')
}

// Delete all attachments for a task (files and DB records)
function deleteTaskAttachments(taskId: string): void {
  // Delete from DB
  db.delete(taskAttachments).where(eq(taskAttachments.taskId, taskId)).run()

  // Delete the upload directory
  const uploadDir = getTaskUploadsDir(taskId)
  if (fs.existsSync(uploadDir)) {
    fs.rmSync(uploadDir, { recursive: true, force: true })
  }
}

const app = new Hono()

// Helper to get links for a task
function getTaskLinks(taskId: string): TaskLink[] {
  return db.select().from(taskLinks).where(eq(taskLinks.taskId, taskId)).all()
}

// Helper to get tags for a task from join table
function getTaskTags(taskId: string): string[] {
  const joins = db
    .select()
    .from(taskTags)
    .where(eq(taskTags.taskId, taskId))
    .all()

  if (joins.length === 0) {
    return []
  }

  const tagIds = joins.map((j) => j.tagId)
  const tagRows = db
    .select()
    .from(tags)
    .where(inArray(tags.id, tagIds))
    .all()
  return tagRows.map((t) => t.name)
}

// Helper to parse JSON fields from database
function toApiResponse(
  task: Task,
  includeLinks = false
): Task & { viewState: unknown; agentOptions: Record<string, string> | null; tags: string[]; links?: TaskLink[] } {
  const response: Task & { viewState: unknown; agentOptions: Record<string, string> | null; tags: string[]; links?: TaskLink[] } = {
    ...task,
    viewState: task.viewState ? JSON.parse(task.viewState) : null,
    agentOptions: task.agentOptions ? JSON.parse(task.agentOptions) : null,
    tags: getTaskTags(task.id),
  }
  if (includeLinks) {
    response.links = getTaskLinks(task.id)
  }
  return response
}

// GET /api/tasks - List all tasks (optionally filter by projectId or orphans)
app.get('/', (c) => {
  const projectId = c.req.query('projectId')
  const orphans = c.req.query('orphans') === 'true'
  const tag = c.req.query('tag')
  const status = c.req.query('status')
  // D-2: filter by assignee. `assigneeId=me` resolves to the current user's
  // id (when one was derived from CF Access header / dev fallback); otherwise
  // resolves to the exact user id provided. `assigneeId=unassigned` returns
  // tasks with no assignee (assignee_user_id IS NULL).
  const rawAssigneeId = c.req.query('assigneeId')
  const currentUserId = (c.var as { user?: { id?: string } | null }).user?.id
  const assigneeFilter =
    rawAssigneeId === 'me' ? currentUserId ?? '__no_current_user__' : rawAssigneeId

  const query = db.select().from(tasks).orderBy(asc(tasks.position))

  let allTasks = query.all()

  // Filter by status (supports comma-separated values e.g. "IN_PROGRESS,TO_DO")
  if (status) {
    const statuses = status.split(',')
    allTasks = allTasks.filter((t) => statuses.includes(t.status))
  }

  // Apply filters in memory (for simplicity with nullable fields)
  if (projectId) {
    allTasks = allTasks.filter((t) => t.projectId === projectId)
  } else if (orphans) {
    allTasks = allTasks.filter((t) => t.projectId === null)
  }

  if (assigneeFilter === 'unassigned') {
    allTasks = allTasks.filter((t) => t.assigneeUserId === null)
  } else if (assigneeFilter) {
    allTasks = allTasks.filter((t) => t.assigneeUserId === assigneeFilter)
  }

  // Filter by tag if specified
  if (tag) {
    allTasks = allTasks.filter((t) => {
      const taskTags = getTaskTags(t.id)
      return taskTags.includes(tag)
    })
  }

  // D-5 PR 3: filter by effectiveRole. Tenant-visible tasks pass through
  // for everyone (incl. anonymous) because the tenant-default role is
  // editor. Restricted tasks only pass for principals with a matching
  // grant. N×1 lookup; acceptable at current scale.
  const userId = (c.var as { user?: { id?: string } | null }).user?.id ?? null
  allTasks = allTasks.filter((t) => effectiveRole(userId, 'task', t.id) !== null)

  return c.json(allTasks.map((t) => toApiResponse(t, true)))
})

// POST /api/tasks - Create task
app.post('/', async (c) => {
  try {
    const body = await c.req.json<
      Omit<NewTask, 'id' | 'createdAt' | 'updatedAt'> & {
        copyFiles?: string
        startupScript?: string
        agent?: string
        agentOptions?: Record<string, string> | null
        opencodeModel?: string | null
        tags?: string[]
        blockedByTaskIds?: string[]
        type?: 'worktree' | 'scratch' | null
        prefix?: string | null
      }
    >()

    // Get max position for the status
    const existingTasks = db
      .select()
      .from(tasks)
      .where(eq(tasks.status, body.status || 'IN_PROGRESS'))
      .all()
    const maxPosition = existingTasks.reduce((max, t) => Math.max(max, t.position), -1)

    const now = new Date().toISOString()

    // Set startedAt based on status (null for TO_DO, now for others)
    const startedAt = body.status === 'TO_DO' ? null : (body.startedAt || now)

    const newTask: NewTask = {
      id: crypto.randomUUID(),
      title: body.title,
      description: body.description || null,
      status: body.status || 'IN_PROGRESS',
      position: maxPosition + 1,
      repoPath: body.repoPath || null,
      repoName: body.repoName || null,
      baseBranch: body.baseBranch || null,
      branch: body.branch || null,
      prefix: body.prefix || null,
      worktreePath: body.worktreePath || null,
      startupScript: body.startupScript || null,
      agent: body.agent || 'claude',
      aiMode: body.aiMode || null,
      agentOptions: body.agentOptions ? JSON.stringify(body.agentOptions) : null,
      opencodeModel: body.opencodeModel || null,
      type: body.type || null,
      // New generalized task fields
      projectId: body.projectId || null,
      repositoryId: body.repositoryId || null,
      startedAt,
      dueDate: body.dueDate || null,
      timeEstimate: body.timeEstimate != null ? (Number.isInteger(body.timeEstimate) && body.timeEstimate >= 1 ? body.timeEstimate : null) : null,
      priority: body.priority && ['high', 'medium', 'low'].includes(body.priority) ? body.priority : 'medium',
      recurrenceRule: body.recurrenceRule || null,
      recurrenceEndDate: body.recurrenceEndDate || null,
      recurrenceSourceTaskId: null,
      pinned: body.pinned ?? false,
      // D-2: optional assignee at creation time.
      assigneeUserId:
        typeof body.assigneeUserId === 'string' && body.assigneeUserId.trim() !== ''
          ? body.assigneeUserId
          : null,
      // D-3: free-form notes accepted at creation so @mentions in `notes` are
      // parsed by the post-insert mention sync. Previously dropped silently.
      notes: body.notes ?? null,
      createdAt: now,
      updatedAt: now,
    }

    // Create git worktree if branch and worktreePath are provided (for immediate IN_PROGRESS tasks)
    if (body.branch && body.worktreePath && body.repoPath && body.baseBranch) {
      const result = createGitWorktree(body.repoPath, body.worktreePath, body.branch, body.baseBranch)
      if (!result.success) {
        return c.json({ error: `Failed to create worktree: ${result.error}` }, 500)
      }

      // Copy files if patterns provided
      if (body.copyFiles) {
        try {
          copyFilesToWorktree(body.repoPath, body.worktreePath, body.copyFiles)
        } catch (err) {
          log.api.error('Failed to copy files', { error: String(err) })
          // Non-fatal: continue with task creation
        }
      }
    }

    // Create scratch directory if type is scratch and worktreePath is provided
    if (body.type === 'scratch' && body.worktreePath) {
      try {
        fs.mkdirSync(body.worktreePath, { recursive: true })
      } catch (err) {
        return c.json({ error: `Failed to create scratch directory: ${err instanceof Error ? err.message : String(err)}` }, 500)
      }
    }

    db.insert(tasks).values(newTask).run()

    // Add tags to task_tags join table if provided
    if (body.tags && body.tags.length > 0) {
      for (const tagName of body.tags) {
        const name = tagName.trim().toLowerCase()
        if (!name) continue

        // Get or create tag
        let tag = db.select().from(tags).where(eq(tags.name, name)).get()
        if (!tag) {
          const tagId = crypto.randomUUID()
          db.insert(tags)
            .values({ id: tagId, name, color: null, createdAt: now })
            .run()
          tag = db.select().from(tags).where(eq(tags.id, tagId)).get()
        }

        if (tag) {
          // Check if already linked (shouldn't happen for new task, but be safe)
          const existing = db
            .select()
            .from(taskTags)
            .where(and(eq(taskTags.taskId, newTask.id), eq(taskTags.tagId, tag.id)))
            .get()
          if (!existing) {
            db.insert(taskTags)
              .values({ id: crypto.randomUUID(), taskId: newTask.id, tagId: tag.id, createdAt: now })
              .run()
          }
        }
      }
    }

    // Create dependencies if blockedByTaskIds provided
    if (body.blockedByTaskIds && body.blockedByTaskIds.length > 0) {
      // Dedupe and filter out self-references and invalid/non-existent tasks
      const uniqueIds = [...new Set(body.blockedByTaskIds)].filter((id) => id !== newTask.id)
      for (const dependsOnTaskId of uniqueIds) {
        // Check if the target task exists
        const targetTask = db.select().from(tasks).where(eq(tasks.id, dependsOnTaskId)).get()
        if (!targetTask) continue

        // Check for circular dependency (shouldn't happen with a new task, but be safe)
        const circularCheck = db
          .select()
          .from(taskRelationships)
          .where(
            and(
              eq(taskRelationships.taskId, dependsOnTaskId),
              eq(taskRelationships.relatedTaskId, newTask.id),
              eq(taskRelationships.type, 'depends_on')
            )
          )
          .get()
        if (circularCheck) continue

        db.insert(taskRelationships)
          .values({
            id: crypto.randomUUID(),
            taskId: newTask.id,
            relatedTaskId: dependsOnTaskId,
            type: 'depends_on',
            createdAt: now,
          })
          .run()
      }
    }

    // Update lastUsedAt and lastBaseBranch for the repository (if it exists in our database)
    if (body.repoPath) {
      db.update(repositories)
        .set({ lastUsedAt: now, lastBaseBranch: body.baseBranch || null, updatedAt: now })
        .where(eq(repositories.path, body.repoPath))
        .run()
    } else if (body.repositoryId && body.baseBranch) {
      db.update(repositories)
        .set({ lastUsedAt: now, lastBaseBranch: body.baseBranch, updatedAt: now })
        .where(eq(repositories.id, body.repositoryId))
        .run()
    }

    const created = db.select().from(tasks).where(eq(tasks.id, newTask.id)).get()
    broadcast({ type: 'task:updated', payload: { taskId: newTask.id } })

    // D-5: creator gets admin on the resource so they can manage its ACL
    // and visibility going forward. No-op when there's no current user
    // (anonymous task creation in dev / desktop).
    const creator = (c.var as { user?: { id?: string } | null }).user
    grantCreatorAdmin(creator?.id, 'task', newTask.id)

    // D-5 PR 4: if the task was created with an assignee, ensure the
    // assignee has at least viewer access — otherwise they'd see the
    // "you were assigned" toast (D-4 PR 3) but 404 on click-through
    // for restricted tasks.
    if (created && created.assigneeUserId) {
      ensureAssigneeViewer(created.assigneeUserId, 'task', created.id, creator?.id)
    }

    // D-4 PR 2: if the task was created with an assignee, fan out
    // task:assigned to the assignee's `me`-subscribed sockets so they
    // see "you were assigned" without waiting for a refetch.
    if (created && created.assigneeUserId) {
      broadcastToTopic(
        `task:${created.id}`,
        {
          type: 'task:assigned',
          payload: {
            taskId: created.id,
            assigneeUserId: created.assigneeUserId,
            previousAssigneeUserId: null,
          },
        },
        { toUserIds: new Set([created.assigneeUserId]) }
      )
    }

    // D-3: parse @mentions from the new task's description + notes and
    // dispatch notifications for any users mentioned at creation time.
    if (created) {
      syncAndNotify({
        sourceType: 'task',
        sourceId: created.id,
        sourceTitle: created.title,
        text: buildMentionText(created),
        authorEmail: (c.var as { user?: { email?: string } | null }).user?.email,
      })
    }

    return c.json(created ? toApiResponse(created, true) : null, 201)
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Failed to create task' }, 400)
  }
})

// DELETE /api/tasks/bulk - Delete multiple tasks (must be before /:id route)
app.delete('/bulk', async (c) => {
  try {
    const body = await c.req.json<{ ids: string[]; deleteLinkedWorktrees?: boolean }>()

    if (!Array.isArray(body.ids) || body.ids.length === 0) {
      return c.json({ error: 'ids must be a non-empty array' }, 400)
    }

    const now = new Date().toISOString()
    let deletedCount = 0

    for (const id of body.ids) {
      const existing = db.select().from(tasks).where(eq(tasks.id, id)).get()
      if (!existing) continue

      // Handle linked worktree/directory based on deleteLinkedWorktrees flag
      if (existing.worktreePath) {
        // Always destroy terminals for the worktree/scratch dir
        destroyTerminalsForWorktree(existing.worktreePath)

        // Only delete the worktree/directory if flag is true
        if (body.deleteLinkedWorktrees) {
          if (existing.repoPath) {
            deleteGitWorktree(existing.repoPath, existing.worktreePath)
          } else if (existing.type === 'scratch') {
            try {
              fs.rmSync(existing.worktreePath, { recursive: true, force: true })
            } catch (err) {
              log.api.error('Failed to delete scratch directory', { path: existing.worktreePath, error: String(err) })
            }
          }
        }
      }

      // Shift down tasks in the same column that were after this task
      const columnTasks = db.select().from(tasks).where(eq(tasks.status, existing.status)).all()

      for (const t of columnTasks) {
        if (t.position > existing.position) {
          db.update(tasks)
            .set({ position: t.position - 1, updatedAt: now })
            .where(eq(tasks.id, t.id))
            .run()
        }
      }

      // Delete associated links
      db.delete(taskLinks).where(eq(taskLinks.taskId, id)).run()

      // Delete associated attachments (files and DB records)
      deleteTaskAttachments(id)

      // D-3: drop mentions pointing at this task
      db.delete(mentions)
        .where(and(eq(mentions.sourceType, 'task'), eq(mentions.sourceId, id)))
        .run()

      db.delete(tasks).where(eq(tasks.id, id)).run()
      broadcast({ type: 'task:updated', payload: { taskId: id } })
      deletedCount++
    }

    return c.json({ success: true, deleted: deletedCount })
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Failed to delete tasks' }, 400)
  }
})

// GET /api/tasks/:id - Get single task
app.get('/:id', (c) => {
  const id = c.req.param('id')
  const task = db.select().from(tasks).where(eq(tasks.id, id)).get()
  if (!task) {
    return c.json({ error: 'Task not found' }, 404)
  }
  // D-5 PR 3: enforce viewer access. Tenant-visible passes for everyone;
  // restricted requires a grant.
  const userId = (c.var as { user?: { id?: string } | null }).user?.id ?? null
  if (!roleSatisfies(effectiveRole(userId, 'task', id), 'viewer')) {
    return c.json({ error: 'Task not found' }, 404)
  }
  return c.json(toApiResponse(task, true))
})

// POST /api/tasks/:id/initialize-worktree - Initialize a manual task as a worktree task
app.post('/:id/initialize-worktree', async (c) => {
  const id = c.req.param('id')

  try {
    const existing = db.select().from(tasks).where(eq(tasks.id, id)).get()
    if (!existing) {
      return c.json({ error: 'Task not found' }, 404)
    }

    // Check if task already has worktree context
    if (existing.worktreePath) {
      return c.json({ error: 'Task already has worktree context' }, 400)
    }

    const body = await c.req.json<{
      agent?: string
      aiMode?: 'default' | 'plan'
      repoPath: string
      repoName: string
      baseBranch: string
      branch: string
      worktreePath: string
      copyFiles?: string
      startupScript?: string
      agentOptions?: Record<string, string> | null
      opencodeModel?: string | null
      prefix?: string | null
    }>()

    if (!body.repoPath || !body.branch || !body.worktreePath || !body.baseBranch) {
      return c.json({ error: 'repoPath, branch, worktreePath, and baseBranch are required' }, 400)
    }

    // Create git worktree
    const result = createGitWorktree(body.repoPath, body.worktreePath, body.branch, body.baseBranch)
    if (!result.success) {
      return c.json({ error: `Failed to create worktree: ${result.error}` }, 500)
    }

    // Copy files if patterns provided
    if (body.copyFiles) {
      try {
        copyFilesToWorktree(body.repoPath, body.worktreePath, body.copyFiles)
      } catch (err) {
        log.api.error('Failed to copy files during worktree initialization', { error: String(err) })
        // Non-fatal: continue with task update
      }
    }

    const now = new Date().toISOString()

    // Update the task with worktree fields and change status to IN_PROGRESS
    db.update(tasks)
      .set({
        agent: body.agent || 'claude',
        aiMode: body.aiMode || null,
        repoPath: body.repoPath,
        repoName: body.repoName,
        baseBranch: body.baseBranch,
        branch: body.branch,
        prefix: body.prefix || null,
        worktreePath: body.worktreePath,
        startupScript: body.startupScript || null,
        agentOptions: body.agentOptions ? JSON.stringify(body.agentOptions) : null,
        opencodeModel: body.opencodeModel || null,
        status: 'IN_PROGRESS',
        startedAt: now,
        updatedAt: now,
      })
      .where(eq(tasks.id, id))
      .run()

    // Update lastUsedAt and lastBaseBranch for the repository
    db.update(repositories)
      .set({ lastUsedAt: now, lastBaseBranch: body.baseBranch || null, updatedAt: now })
      .where(eq(repositories.path, body.repoPath))
      .run()

    const updated = db.select().from(tasks).where(eq(tasks.id, id)).get()
    broadcast({ type: 'task:updated', payload: { taskId: id } })
    return c.json(updated ? toApiResponse(updated, true) : null)
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Failed to initialize worktree task' }, 400)
  }
})

// POST /api/tasks/:id/initialize-scratch - Initialize a manual task as a scratch task
app.post('/:id/initialize-scratch', async (c) => {
  const id = c.req.param('id')

  try {
    const existing = db.select().from(tasks).where(eq(tasks.id, id)).get()
    if (!existing) {
      return c.json({ error: 'Task not found' }, 404)
    }

    if (existing.worktreePath) {
      return c.json({ error: 'Task already has a directory' }, 400)
    }

    const body = await c.req.json<{
      agent?: string
      aiMode?: 'default' | 'plan'
    }>().catch(() => ({} as { agent?: string; aiMode?: 'default' | 'plan' }))

    // Generate scratch directory path
    const scratchBase = getScratchBasePath()
    const slugifiedTitle = existing.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 50)
    const suffix = Math.random().toString(36).slice(2, 6)
    const dirName = slugifiedTitle ? `${slugifiedTitle}-${suffix}` : suffix
    const dirPath = path.join(scratchBase, dirName)

    // Create scratch directory
    try {
      fs.mkdirSync(dirPath, { recursive: true })
    } catch (err) {
      return c.json({ error: `Failed to create scratch directory: ${err instanceof Error ? err.message : String(err)}` }, 500)
    }

    const now = new Date().toISOString()

    db.update(tasks)
      .set({
        type: 'scratch',
        worktreePath: dirPath,
        agent: body.agent || existing.agent || 'claude',
        aiMode: body.aiMode || null,
        status: 'IN_PROGRESS',
        startedAt: now,
        updatedAt: now,
      })
      .where(eq(tasks.id, id))
      .run()

    const updated = db.select().from(tasks).where(eq(tasks.id, id)).get()
    broadcast({ type: 'task:updated', payload: { taskId: id } })
    return c.json(updated ? toApiResponse(updated, true) : null)
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Failed to initialize scratch task' }, 400)
  }
})

// PATCH /api/tasks/:id - Update task
// Build update data from PATCH body using a field→transform map
const TASK_PATCH_FIELDS: Record<string, (v: unknown) => unknown> = {
  title: (v) => v,
  description: (v) => v,
  notes: (v) => v,
  prUrl: (v) => v,
  dueDate: (v) => v,
  priority: (v) => v,
  pinned: (v) => v,
  recurrenceRule: (v) => v,
  recurrenceEndDate: (v) => v,
  projectId: (v) => v,
  repositoryId: (v) => v,
  // D-2: Task assignee. Empty string is normalized to null so callers can
  // unassign via either explicit null or "" without surprise.
  assigneeUserId: (v) => (typeof v === 'string' && v.trim() !== '' ? v : null),
  agent: (v) => v,
  aiMode: (v) => v,
  opencodeModel: (v) => v,
  startupScript: (v) => v,
  type: (v) => v,
  startedAt: (v) => v,
  repoPath: (v) => v,
  repoName: (v) => v,
  baseBranch: (v) => v,
  branch: (v) => v,
  prefix: (v) => v,
  worktreePath: (v) => v,
  timeEstimate: (v) => v != null ? (Number.isInteger(Number(v)) && Number(v) >= 1 ? Number(v) : null) : null,
  viewState: (v) => v ? JSON.stringify(v) : null,
  agentOptions: (v) => v ? JSON.stringify(v) : null,
}

function buildTaskUpdateData(body: Record<string, unknown>, now: string): Record<string, unknown> {
  const updateData: Record<string, unknown> = { updatedAt: now }
  for (const [field, transform] of Object.entries(TASK_PATCH_FIELDS)) {
    if (body[field] !== undefined) {
      updateData[field] = transform(body[field])
    }
  }
  return updateData
}

app.patch('/:id', async (c) => {
  const id = c.req.param('id')

  try {
    const existing = db.select().from(tasks).where(eq(tasks.id, id)).get()
    if (!existing) {
      return c.json({ error: 'Task not found' }, 404)
    }

    // D-5 PR 3: editor required to mutate. Viewer-only can read but not
    // change. Returns 404 (not 403) for "no access at all" to avoid
    // leaking the existence of restricted resources.
    const userId = (c.var as { user?: { id?: string } | null }).user?.id ?? null
    const role = effectiveRole(userId, 'task', id)
    if (!roleSatisfies(role, 'viewer')) return c.json({ error: 'Task not found' }, 404)
    if (!roleSatisfies(role, 'editor')) return c.json({ error: 'editor role required' }, 403)

    const body = await c.req.json<Partial<Task> & { viewState?: unknown }>()
    const now = new Date().toISOString()

    // Handle status change via centralized function
    if (body.status && body.status !== existing.status) {
      await updateTaskStatus(id, body.status)
    }

    // Build whitelisted update data (excludes status, tags, and unknown fields)
    const updates = buildTaskUpdateData(body as Record<string, unknown>, now)

    // Handle tags via join table
    const tagsToUpdate = (body as { tags?: string[] }).tags

    // Only do additional db update if there are fields beyond updatedAt
    if (Object.keys(updates).length > 1) {
      db.update(tasks)
        .set(updates)
        .where(eq(tasks.id, id))
        .run()
      broadcast({ type: 'task:updated', payload: { taskId: id } })
    }

    // Update tags via join table if provided
    if (tagsToUpdate !== undefined) {
      // Clear existing tags
      db.delete(taskTags).where(eq(taskTags.taskId, id)).run()

      // Add new tags
      if (tagsToUpdate && tagsToUpdate.length > 0) {
        for (const tagName of tagsToUpdate) {
          const name = tagName.trim().toLowerCase()
          if (!name) continue

          // Get or create tag
          let tag = db.select().from(tags).where(eq(tags.name, name)).get()
          if (!tag) {
            const tagId = crypto.randomUUID()
            db.insert(tags)
              .values({ id: tagId, name, color: null, createdAt: now })
              .run()
            tag = db.select().from(tags).where(eq(tags.id, tagId)).get()
          }

          if (tag) {
            db.insert(taskTags)
              .values({ id: crypto.randomUUID(), taskId: id, tagId: tag.id, createdAt: now })
              .run()
          }
        }
      }
      broadcast({ type: 'task:updated', payload: { taskId: id } })
    }

    const updated = db.select().from(tasks).where(eq(tasks.id, id)).get()

    // D-3.2: only re-sync mentions when the caller actually touched the
    // mention-bearing text fields. Otherwise a PATCH that only renames
    // the task would re-parse and silently drop mentions of users whose
    // displayName changed since the original mention was recorded.
    const textChanged =
      (body as { description?: unknown }).description !== undefined ||
      (body as { notes?: unknown }).notes !== undefined
    if (updated && textChanged) {
      syncAndNotify({
        sourceType: 'task',
        sourceId: id,
        sourceTitle: updated.title,
        text: buildMentionText(updated),
        authorEmail: (c.var as { user?: { email?: string } | null }).user?.email,
      })
    }

    // D-5 PR 4: when the assignee changes to a new user, ensure that
    // user has at least viewer access. Same rationale as the POST path:
    // toast says "you were assigned" but click-through 404s without a
    // grant. The previous assignee's grant is left alone — they may
    // still want to see the task they were unassigned from.
    if (updated && updated.assigneeUserId && updated.assigneeUserId !== existing.assigneeUserId) {
      const actor = (c.var as { user?: { id?: string } | null }).user?.id ?? null
      ensureAssigneeViewer(updated.assigneeUserId, 'task', id, actor)
    }

    // D-4 PR 2: fan out task:assigned when the assignee actually changed.
    // Targets both the resource topic and `me` for the old + new assignee
    // so both sides get notified ("you were unassigned", "you were
    // assigned"). Skipped when neither id is non-null (no-op assigns).
    if (updated && updated.assigneeUserId !== existing.assigneeUserId) {
      const meUserIds = new Set<string>()
      if (existing.assigneeUserId) meUserIds.add(existing.assigneeUserId)
      if (updated.assigneeUserId) meUserIds.add(updated.assigneeUserId)
      broadcastToTopic(
        `task:${id}`,
        {
          type: 'task:assigned',
          payload: {
            taskId: id,
            assigneeUserId: updated.assigneeUserId,
            previousAssigneeUserId: existing.assigneeUserId,
          },
        },
        { toUserIds: meUserIds }
      )
    }

    return c.json(updated ? toApiResponse(updated, true) : null)
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Failed to update task' }, 400)
  }
})

// DELETE /api/tasks/:id - Delete task (optionally delete linked worktree)
app.delete('/:id', (c) => {
  const id = c.req.param('id')
  const deleteLinkedWorktree = c.req.query('deleteLinkedWorktree') === 'true'

  const existing = db.select().from(tasks).where(eq(tasks.id, id)).get()
  if (!existing) {
    return c.json({ error: 'Task not found' }, 404)
  }

  // D-5 PR 3: editor required to delete. Admin only gates ACL +
  // visibility changes (things that affect other users); delete is part
  // of "I can edit this." Tenant-visible (default) means every tenant
  // member is implicit editor and can therefore delete.
  const userId = (c.var as { user?: { id?: string } | null }).user?.id ?? null
  const role = effectiveRole(userId, 'task', id)
  if (!roleSatisfies(role, 'viewer')) return c.json({ error: 'Task not found' }, 404)
  if (!roleSatisfies(role, 'editor')) return c.json({ error: 'editor role required' }, 403)

  // Handle linked worktree/directory based on deleteLinkedWorktree flag
  if (existing.worktreePath) {
    // Always destroy terminals for the worktree/scratch dir
    destroyTerminalsForWorktree(existing.worktreePath)

    if (deleteLinkedWorktree) {
      if (existing.repoPath) {
        // Git worktree: use git worktree remove
        deleteGitWorktree(existing.repoPath, existing.worktreePath)
      } else if (existing.type === 'scratch') {
        // Standalone directory: simple fs remove
        try {
          fs.rmSync(existing.worktreePath, { recursive: true, force: true })
        } catch (err) {
          log.api.error('Failed to delete scratch directory', { path: existing.worktreePath, error: String(err) })
        }
      }
    }
  }

  // Shift down tasks in the same column that were after this task
  const columnTasks = db.select().from(tasks).where(eq(tasks.status, existing.status)).all()
  const now = new Date().toISOString()

  for (const t of columnTasks) {
    if (t.position > existing.position) {
      db.update(tasks)
        .set({ position: t.position - 1, updatedAt: now })
        .where(eq(tasks.id, t.id))
        .run()
    }
  }

  // Delete associated links
  db.delete(taskLinks).where(eq(taskLinks.taskId, id)).run()

  // Delete associated attachments (files and DB records)
  deleteTaskAttachments(id)

  // D-3: drop mentions pointing at this task
  db.delete(mentions)
    .where(and(eq(mentions.sourceType, 'task'), eq(mentions.sourceId, id)))
    .run()

  db.delete(tasks).where(eq(tasks.id, id)).run()
  broadcast({ type: 'task:updated', payload: { taskId: id } })
  return c.json({ success: true })
})

// PATCH /api/tasks/:id/status - Update task status with position reordering
app.patch('/:id/status', async (c) => {
  const id = c.req.param('id')

  try {
    const existing = db.select().from(tasks).where(eq(tasks.id, id)).get()
    if (!existing) {
      return c.json({ error: 'Task not found' }, 404)
    }

    const body = await c.req.json<{ status: string; position: number }>()
    const now = new Date().toISOString()

    // If status changed or position changed, we need to reorder
    const oldStatus = existing.status
    const newStatus = body.status
    const newPosition = body.position

    if (oldStatus !== newStatus) {
      // Moving to a different column
      // Shift down tasks in old column that were after this task
      const oldColumnTasks = db.select().from(tasks).where(eq(tasks.status, oldStatus)).all()
      for (const t of oldColumnTasks) {
        if (t.position > existing.position) {
          db.update(tasks)
            .set({ position: t.position - 1, updatedAt: now })
            .where(eq(tasks.id, t.id))
            .run()
        }
      }

      // Shift up tasks in new column to make room
      const newColumnTasks = db.select().from(tasks).where(eq(tasks.status, newStatus)).all()
      for (const t of newColumnTasks) {
        if (t.position >= newPosition) {
          db.update(tasks)
            .set({ position: t.position + 1, updatedAt: now })
            .where(eq(tasks.id, t.id))
            .run()
        }
      }
    } else {
      // Same column, just reorder
      const columnTasks = db.select().from(tasks).where(eq(tasks.status, oldStatus)).all()

      if (newPosition > existing.position) {
        // Moving down
        for (const t of columnTasks) {
          if (t.id !== id && t.position > existing.position && t.position <= newPosition) {
            db.update(tasks)
              .set({ position: t.position - 1, updatedAt: now })
              .where(eq(tasks.id, t.id))
              .run()
          }
        }
      } else if (newPosition < existing.position) {
        // Moving up
        for (const t of columnTasks) {
          if (t.id !== id && t.position >= newPosition && t.position < existing.position) {
            db.update(tasks)
              .set({ position: t.position + 1, updatedAt: now })
              .where(eq(tasks.id, t.id))
              .run()
          }
        }
      }
    }

    // Update the task status (handles all side effects: broadcast, notifications, killClaude)
    const updated = await updateTaskStatus(id, newStatus, newPosition)

    return c.json(updated ? toApiResponse(updated, true) : null)
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Failed to update task status' }, 400)
  }
})

// POST /api/tasks/:id/kill-claude - Kill Claude processes in task terminals
app.post('/:id/kill-claude', (c) => {
  const id = c.req.param('id')
  const task = db.select().from(tasks).where(eq(tasks.id, id)).get()

  if (!task) {
    return c.json({ error: 'Task not found' }, 404)
  }

  if (!task.worktreePath) {
    return c.json({ success: true, terminalsAffected: 0 })
  }

  try {
    const count = killClaudeInTerminalsForWorktree(task.worktreePath)
    return c.json({ success: true, terminalsAffected: count })
  } catch {
    return c.json({ success: true, terminalsAffected: 0 })
  }
})

// GET /api/tasks/:id/links - List links for a task
app.get('/:id/links', (c) => {
  const taskId = c.req.param('id')
  const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get()
  if (!task) {
    return c.json({ error: 'Task not found' }, 404)
  }
  const links = getTaskLinks(taskId)
  return c.json(links)
})

// POST /api/tasks/:id/links - Add a link to a task
app.post('/:id/links', async (c) => {
  const taskId = c.req.param('id')

  try {
    const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get()
    if (!task) {
      return c.json({ error: 'Task not found' }, 404)
    }

    const body = await c.req.json<{ url: string; label?: string }>()
    if (!body.url) {
      return c.json({ error: 'URL is required' }, 400)
    }

    const detected = detectLinkType(body.url)
    const now = new Date().toISOString()

    const newLink = {
      id: crypto.randomUUID(),
      taskId,
      url: body.url,
      label: body.label || detected.label,
      type: detected.type,
      createdAt: now,
    }

    db.insert(taskLinks).values(newLink).run()
    broadcast({ type: 'task:updated', payload: { taskId } })

    return c.json(newLink, 201)
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Failed to add link' }, 400)
  }
})

// DELETE /api/tasks/:id/links/:linkId - Remove a link from a task
app.delete('/:id/links/:linkId', (c) => {
  const taskId = c.req.param('id')
  const linkId = c.req.param('linkId')

  const link = db
    .select()
    .from(taskLinks)
    .where(and(eq(taskLinks.id, linkId), eq(taskLinks.taskId, taskId)))
    .get()

  if (!link) {
    return c.json({ error: 'Link not found' }, 404)
  }

  db.delete(taskLinks).where(eq(taskLinks.id, linkId)).run()
  broadcast({ type: 'task:updated', payload: { taskId } })

  return c.json({ success: true })
})

// POST /api/tasks/:id/tags - Add a tag to a task
app.post('/:id/tags', async (c) => {
  const taskId = c.req.param('id')

  try {
    const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get()
    if (!task) {
      return c.json({ error: 'Task not found' }, 404)
    }

    const body = await c.req.json<{ tag?: string; tagId?: string; color?: string }>()

    let tagId = body.tagId
    const tagName = body.tag?.trim()

    // If no tagId provided, find or create tag by name
    if (!tagId && tagName) {
      // Check if tag exists
      const existing = db.select().from(tags).where(eq(tags.name, tagName)).get()
      if (existing) {
        tagId = existing.id
      } else {
        // Create new tag
        const now = new Date().toISOString()
        tagId = nanoid()
        db.insert(tags)
          .values({
            id: tagId,
            name: tagName,
            color: body.color?.trim() || null,
            createdAt: now,
          })
          .run()
      }
    }

    if (!tagId) {
      return c.json({ error: 'tag or tagId is required' }, 400)
    }

    // Verify tag exists
    const tag = db.select().from(tags).where(eq(tags.id, tagId)).get()
    if (!tag) {
      return c.json({ error: 'Tag not found' }, 404)
    }

    // Check if already linked
    const existingLink = db
      .select()
      .from(taskTags)
      .where(and(eq(taskTags.taskId, taskId), eq(taskTags.tagId, tagId)))
      .get()

    if (!existingLink) {
      const now = new Date().toISOString()
      db.insert(taskTags)
        .values({
          id: nanoid(),
          taskId,
          tagId,
          createdAt: now,
        })
        .run()

      db.update(tasks)
        .set({ updatedAt: now })
        .where(eq(tasks.id, taskId))
        .run()
    }

    reindexTaskFTS(taskId)
    const currentTags = getTaskTags(taskId)
    broadcast({ type: 'task:updated', payload: { taskId } })
    return c.json({ tags: currentTags })
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Failed to add tag' }, 400)
  }
})

// DELETE /api/tasks/:id/tags/:tag - Remove a tag from a task (by tag name or ID)
app.delete('/:id/tags/:tag', (c) => {
  const taskId = c.req.param('id')
  const tagParam = decodeURIComponent(c.req.param('tag'))

  const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get()
  if (!task) {
    return c.json({ error: 'Task not found' }, 404)
  }

  // Find tag by ID first, then by name
  let tag = db.select().from(tags).where(eq(tags.id, tagParam)).get()
  if (!tag) {
    tag = db.select().from(tags).where(eq(tags.name, tagParam)).get()
  }

  if (!tag) {
    // Tag doesn't exist, nothing to remove
    const currentTags = getTaskTags(taskId)
    return c.json({ tags: currentTags })
  }

  // Delete the task-tag association
  db.delete(taskTags)
    .where(and(eq(taskTags.taskId, taskId), eq(taskTags.tagId, tag.id)))
    .run()

  const now = new Date().toISOString()
  db.update(tasks)
    .set({ updatedAt: now })
    .where(eq(tasks.id, taskId))
    .run()

  reindexTaskFTS(taskId)
  const currentTags = getTaskTags(taskId)
  broadcast({ type: 'task:updated', payload: { taskId } })
  return c.json({ tags: currentTags })
})

// PATCH /api/tasks/:id/due-date - Set or clear due date
app.patch('/:id/due-date', async (c) => {
  const taskId = c.req.param('id')

  try {
    const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get()
    if (!task) {
      return c.json({ error: 'Task not found' }, 404)
    }

    const body = await c.req.json<{ dueDate: string | null }>()

    const now = new Date().toISOString()
    db.update(tasks)
      .set({ dueDate: body.dueDate, updatedAt: now })
      .where(eq(tasks.id, taskId))
      .run()

    broadcast({ type: 'task:updated', payload: { taskId } })
    return c.json({ dueDate: body.dueDate })
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Failed to set due date' }, 400)
  }
})

// GET /api/tasks/:id/dependencies - Get dependencies for a task
app.get('/:id/dependencies', (c) => {
  const taskId = c.req.param('id')

  const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get()
  if (!task) {
    return c.json({ error: 'Task not found' }, 404)
  }

  // Get tasks that this task depends on (blockers) - only 'depends_on' type
  const dependsOn = db
    .select()
    .from(taskRelationships)
    .where(
      and(
        eq(taskRelationships.taskId, taskId),
        eq(taskRelationships.type, 'depends_on')
      )
    )
    .all()

  // Get tasks that depend on this task (dependents) - only 'depends_on' type
  const dependents = db
    .select()
    .from(taskRelationships)
    .where(
      and(
        eq(taskRelationships.relatedTaskId, taskId),
        eq(taskRelationships.type, 'depends_on')
      )
    )
    .all()

  // Fetch the actual task details for dependencies
  const dependsOnTasks = dependsOn.map((dep) => {
    const t = db.select().from(tasks).where(eq(tasks.id, dep.relatedTaskId)).get()
    return {
      id: dep.id,
      dependsOnTaskId: dep.relatedTaskId,
      task: t ? { id: t.id, title: t.title, status: t.status } : null,
      createdAt: dep.createdAt,
    }
  })

  const dependentTasks = dependents.map((dep) => {
    const t = db.select().from(tasks).where(eq(tasks.id, dep.taskId)).get()
    return {
      id: dep.id,
      taskId: dep.taskId,
      task: t ? { id: t.id, title: t.title, status: t.status } : null,
      createdAt: dep.createdAt,
    }
  })

  // Task is blocked if any of its dependencies are not DONE
  const isBlocked = dependsOnTasks.some(
    (dep) => dep.task && dep.task.status !== 'DONE' && dep.task.status !== 'CANCELED'
  )

  return c.json({
    dependsOn: dependsOnTasks,
    dependents: dependentTasks,
    isBlocked,
  })
})

// POST /api/tasks/:id/dependencies - Add a dependency
app.post('/:id/dependencies', async (c) => {
  const taskId = c.req.param('id')

  try {
    const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get()
    if (!task) {
      return c.json({ error: 'Task not found' }, 404)
    }

    const body = await c.req.json<{ dependsOnTaskId: string }>()
    if (!body.dependsOnTaskId) {
      return c.json({ error: 'dependsOnTaskId is required' }, 400)
    }

    // Can't depend on itself
    if (body.dependsOnTaskId === taskId) {
      return c.json({ error: 'Task cannot depend on itself' }, 400)
    }

    // Check that the target task exists
    const targetTask = db.select().from(tasks).where(eq(tasks.id, body.dependsOnTaskId)).get()
    if (!targetTask) {
      return c.json({ error: 'Target task not found' }, 404)
    }

    // Check for existing dependency
    const existing = db
      .select()
      .from(taskRelationships)
      .where(
        and(
          eq(taskRelationships.taskId, taskId),
          eq(taskRelationships.relatedTaskId, body.dependsOnTaskId),
          eq(taskRelationships.type, 'depends_on')
        )
      )
      .get()

    if (existing) {
      return c.json({ error: 'Dependency already exists' }, 400)
    }

    // Check for circular dependency (target depends on us)
    const circular = db
      .select()
      .from(taskRelationships)
      .where(
        and(
          eq(taskRelationships.taskId, body.dependsOnTaskId),
          eq(taskRelationships.relatedTaskId, taskId),
          eq(taskRelationships.type, 'depends_on')
        )
      )
      .get()

    if (circular) {
      return c.json({ error: 'Circular dependency detected' }, 400)
    }

    const now = new Date().toISOString()
    const newDep = {
      id: crypto.randomUUID(),
      taskId,
      relatedTaskId: body.dependsOnTaskId,
      type: 'depends_on' as const,
      createdAt: now,
    }

    db.insert(taskRelationships).values(newDep).run()

    broadcast({ type: 'task:updated', payload: { taskId } })
    broadcast({ type: 'task:updated', payload: { taskId: body.dependsOnTaskId } })

    // Return with the old field name for API compatibility
    return c.json({
      id: newDep.id,
      taskId: newDep.taskId,
      dependsOnTaskId: newDep.relatedTaskId,
      createdAt: newDep.createdAt,
    }, 201)
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Failed to add dependency' }, 400)
  }
})

// DELETE /api/tasks/:id/dependencies/:depId - Remove a dependency
app.delete('/:id/dependencies/:depId', (c) => {
  const taskId = c.req.param('id')
  const depId = c.req.param('depId')

  const dep = db
    .select()
    .from(taskRelationships)
    .where(and(eq(taskRelationships.id, depId), eq(taskRelationships.taskId, taskId)))
    .get()

  if (!dep) {
    return c.json({ error: 'Dependency not found' }, 404)
  }

  db.delete(taskRelationships).where(eq(taskRelationships.id, depId)).run()

  broadcast({ type: 'task:updated', payload: { taskId } })
  broadcast({ type: 'task:updated', payload: { taskId: dep.relatedTaskId } })

  return c.json({ success: true })
})

// GET /api/tasks/dependencies/graph - Get all dependencies for graph visualization (must be before /:id)
// Note: This is handled separately below since it needs to come before the :id routes

// ==================== ATTACHMENT ROUTES ====================

// GET /api/tasks/:id/attachments - List attachments for a task
app.get('/:id/attachments', (c) => {
  const taskId = c.req.param('id')

  const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get()
  if (!task) {
    return c.json({ error: 'Task not found' }, 404)
  }

  const attachments = db
    .select()
    .from(taskAttachments)
    .where(eq(taskAttachments.taskId, taskId))
    .all()

  return c.json(attachments)
})

// POST /api/tasks/:id/attachments - Upload an attachment
app.post('/:id/attachments', async (c) => {
  const taskId = c.req.param('id')

  try {
    const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get()
    if (!task) {
      return c.json({ error: 'Task not found' }, 404)
    }

    const formData = await c.req.formData()
    const file = formData.get('file') as File | null

    if (!file) {
      return c.json({ error: 'No file provided' }, 400)
    }

    // Validate file size
    if (file.size > MAX_FILE_SIZE) {
      return c.json({ error: `File too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024}MB` }, 400)
    }

    // Create upload directory
    const uploadDir = getTaskUploadsDir(taskId)
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true })
    }

    // Generate unique filename
    const uuid = crypto.randomUUID()
    const sanitizedName = sanitizeFilename(file.name)
    const storedFilename = `${uuid}-${sanitizedName}`
    const storedPath = path.join(uploadDir, storedFilename)

    // Write file to disk
    const arrayBuffer = await file.arrayBuffer()
    fs.writeFileSync(storedPath, Buffer.from(arrayBuffer))

    // Create DB record
    const now = new Date().toISOString()
    const newAttachment = {
      id: crypto.randomUUID(),
      taskId,
      filename: file.name,
      storedPath,
      mimeType: file.type || 'application/octet-stream',
      size: file.size,
      createdAt: now,
    }

    db.insert(taskAttachments).values(newAttachment).run()
    broadcast({ type: 'task:updated', payload: { taskId } })

    return c.json(newAttachment, 201)
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Failed to upload attachment' }, 400)
  }
})

// GET /api/tasks/:id/attachments/:attachmentId - Download an attachment
app.get('/:id/attachments/:attachmentId', (c) => {
  const taskId = c.req.param('id')
  const attachmentId = c.req.param('attachmentId')

  const attachment = db
    .select()
    .from(taskAttachments)
    .where(and(eq(taskAttachments.id, attachmentId), eq(taskAttachments.taskId, taskId)))
    .get()

  if (!attachment) {
    return c.json({ error: 'Attachment not found' }, 404)
  }

  // Check file exists
  if (!fs.existsSync(attachment.storedPath)) {
    return c.json({ error: 'File not found on disk' }, 404)
  }

  // Read file and return
  const fileBuffer = fs.readFileSync(attachment.storedPath)
  const inlineRequested = c.req.query('inline') === '1'
  const disposition = inlineRequested && INLINE_SAFE_MIME_TYPES.has(attachment.mimeType) ? 'inline' : 'attachment'
  return new Response(fileBuffer, {
    headers: {
      'Content-Type': attachment.mimeType,
      'Content-Disposition': `${disposition}; filename="${attachment.filename}"`,
      'Content-Length': String(attachment.size),
      'X-Content-Type-Options': 'nosniff',
    },
  })
})

// DELETE /api/tasks/:id/attachments/:attachmentId - Delete an attachment
app.delete('/:id/attachments/:attachmentId', (c) => {
  const taskId = c.req.param('id')
  const attachmentId = c.req.param('attachmentId')

  const attachment = db
    .select()
    .from(taskAttachments)
    .where(and(eq(taskAttachments.id, attachmentId), eq(taskAttachments.taskId, taskId)))
    .get()

  if (!attachment) {
    return c.json({ error: 'Attachment not found' }, 404)
  }

  // Delete file from disk
  if (fs.existsSync(attachment.storedPath)) {
    fs.unlinkSync(attachment.storedPath)
  }

  // Delete from DB
  db.delete(taskAttachments).where(eq(taskAttachments.id, attachmentId)).run()
  broadcast({ type: 'task:updated', payload: { taskId } })

  return c.json({ success: true })
})

export default app
