/**
 * Task Comment service (D-13 PR 3).
 *
 * Threaded discussion on tasks. Flat list by design — no replies-to-
 * comments, no edit history. Mentions in comment bodies flow through
 * the existing mention-service with sourceType='comment'; URL routing
 * to the parent task happens via the `parentTaskId` plumbed into
 * notifyMentions.
 */
import { and, eq } from 'drizzle-orm'
import { db, taskComments, type TaskComment } from '../db'
import { createLogger } from '../lib/logger'

const logger = createLogger('TaskCommentService')

export interface CreateCommentInput {
  taskId: string
  authorUserId: string
  body: string
}

/**
 * Insert a comment. Returns the persisted row so callers can broadcast
 * a `task:comment-added` WS event or queue mention notifications.
 */
export function createTaskComment(input: CreateCommentInput): TaskComment {
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  const row: TaskComment = {
    id,
    taskId: input.taskId,
    authorUserId: input.authorUserId,
    body: input.body,
    createdAt: now,
    updatedAt: now,
  }
  db.insert(taskComments).values(row).run()
  logger.info('Created task comment', { id, taskId: input.taskId, authorUserId: input.authorUserId })
  return row
}

/** List a task's comments, oldest first (chronological discussion order). */
export function listTaskComments(taskId: string): TaskComment[] {
  return db
    .select()
    .from(taskComments)
    .where(eq(taskComments.taskId, taskId))
    .all()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

/** Fetch a single comment by id. */
export function getTaskComment(id: string): TaskComment | null {
  return (
    db.select().from(taskComments).where(eq(taskComments.id, id)).get() ?? null
  )
}

/**
 * Delete a comment. Only the author should be allowed by the route (we
 * don't enforce ownership here — services trust their callers; the
 * routes handle authorization). Returns true if a row was deleted.
 */
export function deleteTaskComment(id: string, authorUserId?: string): boolean {
  const where =
    authorUserId !== undefined
      ? and(eq(taskComments.id, id), eq(taskComments.authorUserId, authorUserId))
      : eq(taskComments.id, id)
  const before = db.select({ id: taskComments.id }).from(taskComments).where(where).get()
  if (!before) return false
  db.delete(taskComments).where(where).run()
  logger.info('Deleted task comment', { id, authorUserId })
  return true
}

/** Count comments on a task — used for badges/UI summaries. */
export function countTaskComments(taskId: string): number {
  return db.select().from(taskComments).where(eq(taskComments.taskId, taskId)).all().length
}
