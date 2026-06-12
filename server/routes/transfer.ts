/**
 * Instance transfer: one-shot export/import of tasks + projects between
 * Fulcrum instances (e.g. local desktop ↔ SaaS). This is the manual
 * stepping stone from the desktop-connectivity assessment — not sync.
 *
 * Scope: projects, tasks, tags (+ task/project tag joins), task links,
 * task dependencies. Machine-local execution state (worktree paths, repo
 * paths, branches, terminals) is intentionally dropped on import — the
 * data plane travels, the execution plane stays local. Assignees and
 * approvers are carried by EMAIL and re-resolved against the importing
 * instance's users table.
 */
import { Hono } from 'hono'
import { eq, inArray } from 'drizzle-orm'
import {
  db,
  projects,
  tasks,
  tags,
  taskTags,
  projectTags,
  taskLinks,
  taskRelationships,
  users,
} from '../db'
import { requireUser, type CurrentUserContext } from '../middleware/current-user'
import { grantCreatorAdmin } from '../services/access-control-service'
import { broadcast } from '../websocket/terminal-ws'

const EXPORT_VERSION = 1

const app = new Hono<CurrentUserContext>()

interface ExportedTask {
  id: string
  title: string
  description: string | null
  status: string
  notes: string | null
  dueDate: string | null
  timeEstimate: number | null
  priority: string | null
  recurrenceRule: string | null
  recurrenceEndDate: string | null
  pinned: boolean
  projectId: string | null
  assigneeEmail: string | null
  assignee: string | null
  approverEmail: string | null
  prUrl: string | null
  visibility: string
  createdAt: string
  updatedAt: string
  completedAt: string | null
  tags: string[]
  links: Array<{ url: string; label: string | null; type: string | null }>
  dependsOn: string[] // exported task ids
}

interface ExportedProject {
  id: string
  name: string
  description: string | null
  notes: string | null
  status: string
  visibility: string
  createdAt: string
  updatedAt: string
  tags: string[]
}

export interface TransferBundle {
  version: number
  exportedAt: string
  projects: ExportedProject[]
  tasks: ExportedTask[]
}

// GET /api/transfer/export?projectId=<optional>
app.get('/export', (c) => {
  requireUser(c)
  const projectId = c.req.query('projectId')

  const allUsers = db.select().from(users).all()
  const emailById = new Map(allUsers.map((u) => [u.id, u.email]))

  const projectRows = projectId
    ? db.select().from(projects).where(eq(projects.id, projectId)).all()
    : db.select().from(projects).all()
  const taskRows = projectId
    ? db.select().from(tasks).where(eq(tasks.projectId, projectId)).all()
    : db.select().from(tasks).all()

  const taskIds = taskRows.map((t) => t.id)
  const tagRows = db.select().from(tags).all()
  const tagById = new Map(tagRows.map((t) => [t.id, t.name]))
  const taskTagRows = taskIds.length
    ? db.select().from(taskTags).where(inArray(taskTags.taskId, taskIds)).all()
    : []
  const projectTagRows = projectRows.length
    ? db.select().from(projectTags).where(inArray(projectTags.projectId, projectRows.map((p) => p.id))).all()
    : []
  const linkRows = taskIds.length
    ? db.select().from(taskLinks).where(inArray(taskLinks.taskId, taskIds)).all()
    : []
  const depRows = taskIds.length
    ? db.select().from(taskRelationships).where(inArray(taskRelationships.taskId, taskIds)).all()
    : []
  const exportedIds = new Set(taskIds)

  const bundle: TransferBundle = {
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    projects: projectRows.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      notes: p.notes,
      status: p.status,
      visibility: (p.visibility as string) ?? 'tenant',
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      tags: projectTagRows
        .filter((pt) => pt.projectId === p.id)
        .map((pt) => tagById.get(pt.tagId))
        .filter((n): n is string => !!n),
    })),
    tasks: taskRows.map((t) => ({
      id: t.id,
      title: t.title,
      description: t.description,
      status: t.status,
      notes: t.notes,
      dueDate: t.dueDate,
      timeEstimate: t.timeEstimate,
      priority: t.priority,
      recurrenceRule: t.recurrenceRule,
      recurrenceEndDate: t.recurrenceEndDate,
      pinned: t.pinned ?? false,
      projectId: t.projectId,
      assigneeEmail: t.assigneeUserId ? (emailById.get(t.assigneeUserId) ?? null) : null,
      assignee: t.assignee,
      approverEmail: t.approverUserId ? (emailById.get(t.approverUserId) ?? null) : null,
      prUrl: t.prUrl,
      visibility: (t.visibility as string) ?? 'tenant',
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      completedAt: t.completedAt,
      tags: taskTagRows
        .filter((tt) => tt.taskId === t.id)
        .map((tt) => tagById.get(tt.tagId))
        .filter((n): n is string => !!n),
      links: linkRows
        .filter((l) => l.taskId === t.id)
        .map((l) => ({ url: l.url, label: l.label, type: l.type })),
      dependsOn: depRows
        .filter((d) => d.taskId === t.id && d.type === 'depends_on' && exportedIds.has(d.relatedTaskId))
        .map((d) => d.relatedTaskId),
    })),
  }

  c.header('Content-Disposition', `attachment; filename="fulcrum-export-${bundle.exportedAt.slice(0, 10)}.json"`)
  return c.json(bundle)
})

function getOrCreateTagId(name: string, now: string): string {
  const normalized = name.trim().toLowerCase()
  const existing = db.select().from(tags).where(eq(tags.name, normalized)).get()
  if (existing) return existing.id
  const id = crypto.randomUUID()
  db.insert(tags).values({ id, name: normalized, color: null, createdAt: now }).run()
  return id
}

// POST /api/transfer/import — body is a TransferBundle. All ids are
// remapped to fresh UUIDs; nothing is overwritten.
app.post('/import', async (c) => {
  const user = requireUser(c)
  const bundle = await c.req.json<TransferBundle>()
  if (bundle.version !== EXPORT_VERSION || !Array.isArray(bundle.tasks) || !Array.isArray(bundle.projects)) {
    return c.json({ error: 'Unrecognized export bundle' }, 400)
  }

  const now = new Date().toISOString()
  const allUsers = db.select().from(users).all()
  const idByEmail = new Map(allUsers.map((u) => [u.email, u.id]))

  // Projects first (tasks reference them).
  const projectIdMap = new Map<string, string>()
  for (const p of bundle.projects) {
    const newId = crypto.randomUUID()
    projectIdMap.set(p.id, newId)
    db.insert(projects)
      .values({
        id: newId,
        name: p.name,
        description: p.description,
        notes: p.notes,
        status: p.status || 'active',
        visibility: p.visibility === 'restricted' ? 'restricted' : 'tenant',
        createdAt: p.createdAt || now,
        updatedAt: now,
      })
      .run()
    grantCreatorAdmin(user.id, 'project', newId)
    for (const tagName of p.tags ?? []) {
      db.insert(projectTags)
        .values({ id: crypto.randomUUID(), projectId: newId, tagId: getOrCreateTagId(tagName, now), createdAt: now })
        .run()
    }
  }

  const taskIdMap = new Map<string, string>()
  let position = 0
  for (const t of bundle.tasks) {
    const newId = crypto.randomUUID()
    taskIdMap.set(t.id, newId)
    db.insert(tasks)
      .values({
        id: newId,
        title: t.title,
        description: t.description,
        status: t.status || 'TO_DO',
        position: position++,
        notes: t.notes,
        dueDate: t.dueDate,
        timeEstimate: t.timeEstimate,
        priority: t.priority ?? 'medium',
        recurrenceRule: t.recurrenceRule,
        recurrenceEndDate: t.recurrenceEndDate,
        pinned: t.pinned ?? false,
        projectId: t.projectId ? (projectIdMap.get(t.projectId) ?? null) : null,
        assigneeUserId: t.assigneeEmail ? (idByEmail.get(t.assigneeEmail) ?? null) : null,
        assignee: t.assignee ?? null,
        approverUserId: t.approverEmail ? (idByEmail.get(t.approverEmail) ?? null) : null,
        prUrl: t.prUrl,
        visibility: t.visibility === 'restricted' ? 'restricted' : 'tenant',
        // Execution-plane fields intentionally dropped: worktreePath,
        // repoPath, branch, terminals are machine-local.
        createdAt: t.createdAt || now,
        updatedAt: now,
        completedAt: t.completedAt,
      })
      .run()
    grantCreatorAdmin(user.id, 'task', newId)
    for (const tagName of t.tags ?? []) {
      db.insert(taskTags)
        .values({ id: crypto.randomUUID(), taskId: newId, tagId: getOrCreateTagId(tagName, now), createdAt: now })
        .run()
    }
    for (const link of t.links ?? []) {
      db.insert(taskLinks)
        .values({ id: crypto.randomUUID(), taskId: newId, url: link.url, label: link.label, type: link.type, createdAt: now })
        .run()
    }
  }

  // Dependencies after all tasks exist (both ends must be remapped).
  for (const t of bundle.tasks) {
    for (const depId of t.dependsOn ?? []) {
      const from = taskIdMap.get(t.id)
      const to = taskIdMap.get(depId)
      if (from && to) {
        db.insert(taskRelationships)
          .values({ id: crypto.randomUUID(), taskId: from, relatedTaskId: to, type: 'depends_on', createdAt: now })
          .run()
      }
    }
  }

  broadcast({ type: 'task:updated', payload: { taskId: '*' } })
  return c.json({
    imported: { projects: projectIdMap.size, tasks: taskIdMap.size },
  })
})

export default app
