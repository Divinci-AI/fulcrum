import { db, type Task } from '../db'
import { tasks, taskTags, terminalViewState } from '../db/schema'
import { eq } from 'drizzle-orm'
import { broadcast } from '../websocket/terminal-ws'
import { sendNotification } from './notification-service'
import { killClaudeInTerminalsForWorktree } from '../terminal/pty-instance'
import { log } from '../lib/logger'
import { calculateNextDueDate, getTodayInTimezone } from '../../shared/date-utils'
import type { RecurrenceRule } from '../../shared/types'

/**
 * Create the next recurrence of a completed repeating task.
 * Copies key fields from the completed task and sets a new due date.
 */
function createNextRecurrence(completedTask: Task): void {
  try {
    const rule = completedTask.recurrenceRule as RecurrenceRule
    if (!rule) return

    let nextDueDate = calculateNextDueDate(completedTask.dueDate, rule)

    // If the base date was far in the past, advance until we reach today or later
    const today = getTodayInTimezone(null)
    while (nextDueDate < today) {
      nextDueDate = calculateNextDueDate(nextDueDate, rule)
    }

    // Check if next date is past the end date
    if (completedTask.recurrenceEndDate && nextDueDate > completedTask.recurrenceEndDate) {
      log.api.info('Recurrence end date reached, not creating next task', {
        taskId: completedTask.id,
        nextDueDate,
        endDate: completedTask.recurrenceEndDate,
      })
      return
    }

    const now = new Date().toISOString()
    const newTaskId = crypto.randomUUID()

    // Get max position for TO_DO column
    const existingTasks = db
      .select()
      .from(tasks)
      .where(eq(tasks.status, 'TO_DO'))
      .all()
    const maxPosition = existingTasks.reduce((max, t) => Math.max(max, t.position), -1)

    // Create the new task
    db.insert(tasks)
      .values({
        id: newTaskId,
        title: completedTask.title,
        description: completedTask.description,
        status: 'TO_DO',
        position: maxPosition + 1,
        projectId: completedTask.projectId,
        notes: completedTask.notes,
        dueDate: nextDueDate,
        timeEstimate: completedTask.timeEstimate,
        priority: completedTask.priority,
        recurrenceRule: completedTask.recurrenceRule,
        recurrenceEndDate: completedTask.recurrenceEndDate,
        recurrenceSourceTaskId: completedTask.id,
        agent: completedTask.agent || 'claude',
        createdAt: now,
        updatedAt: now,
      })
      .run()

    // Copy tags from completed task
    const completedTaskTags = db
      .select()
      .from(taskTags)
      .where(eq(taskTags.taskId, completedTask.id))
      .all()

    for (const tt of completedTaskTags) {
      db.insert(taskTags)
        .values({
          id: crypto.randomUUID(),
          taskId: newTaskId,
          tagId: tt.tagId,
          createdAt: now,
        })
        .run()
    }

    broadcast({ type: 'task:updated', payload: { taskId: newTaskId } })

    log.api.info('Created next recurrence', {
      completedTaskId: completedTask.id,
      newTaskId,
      nextDueDate,
      rule,
    })
  } catch (err) {
    log.api.error('Failed to create next recurrence', {
      taskId: completedTask.id,
      error: String(err),
    })
  }
}

/**
 * Centralized function to update task status.
 * This is the ONLY place task status should be updated.
 * Handles all side effects:
 * - Database update (status, position, updatedAt, startedAt)
 * - WebSocket broadcast
 * - Notifications (for IN_REVIEW only)
 * - Kill Claude processes (for DONE, CANCELED)
 * - Worktree creation (for TO_DO -> IN_PROGRESS on code tasks)
 */
export async function updateTaskStatus(
  taskId: string,
  newStatus: string,
  newPosition?: number
): Promise<Task | null> {
  const existing = db.select().from(tasks).where(eq(tasks.id, taskId)).get()
  if (!existing) return null

  const oldStatus = existing.status
  const statusChanged = oldStatus !== newStatus

  // Build update object
  const now = new Date().toISOString()
  const updateData: { status: string; updatedAt: string; position?: number; startedAt?: string; pinned?: boolean; worktreePath?: string; branch?: string; repoPath?: string; repoName?: string; baseBranch?: string; completedAt?: string | null; acceptedAt?: string | null } = {
    status: newStatus,
    updatedAt: now,
  }
  if (newPosition !== undefined) {
    updateData.position = newPosition
  }

  // Auto-unpin when moving to terminal statuses
  if (statusChanged && (newStatus === 'DONE' || newStatus === 'CANCELED') && existing.pinned) {
    updateData.pinned = false
  }

  // D-14 PR 1: maintain completedAt timestamp on status transitions.
  // Set on entry to a terminal state; clear on exit back to active. Skip
  // when the status didn't actually change so re-saves keep the original
  // completion timestamp.
  if (statusChanged) {
    const wasTerminal = oldStatus === 'DONE' || oldStatus === 'CANCELED'
    const isTerminal = newStatus === 'DONE' || newStatus === 'CANCELED'
    if (isTerminal && !wasTerminal) {
      updateData.completedAt = now
    } else if (!isTerminal && wasTerminal) {
      updateData.completedAt = null
      // A reopened task is no longer accepted — the approver signs off
      // again once it comes back through review.
      updateData.acceptedAt = null
    }
    // DONE↔CANCELED (both terminal): leave the existing completedAt alone.
  }

  // Handle TO_DO -> IN_PROGRESS transition: set startedAt.
  //
  // Worktree/scratch directories are NOT auto-created here anymore — tasks
  // are decoupled from terminals by default. The explicit endpoints
  // POST /api/tasks/:id/initialize-worktree and /initialize-scratch are the
  // only paths that materialize a working directory.
  if (statusChanged && oldStatus === 'TO_DO' && newStatus === 'IN_PROGRESS') {
    updateData.startedAt = now
  }

  // Update database
  db.update(tasks)
    .set(updateData)
    .where(eq(tasks.id, taskId))
    .run()

  const updated = db.select().from(tasks).where(eq(tasks.id, taskId)).get()

  // Broadcast update via WebSocket
  broadcast({ type: 'task:updated', payload: { taskId } })

  // Only trigger side effects if status actually changed
  if (statusChanged && updated) {
    // Send notification when task moves to review (suppressed if user is actively viewing)
    if (newStatus === 'IN_REVIEW') {
      const STALE_MS = 5 * 60 * 1000 // 5 minutes

      // Check if user is actively viewing with visible tab
      const viewState = db
        .select()
        .from(terminalViewState)
        .where(eq(terminalViewState.id, 'singleton'))
        .get()

      const viewIsRecent =
        viewState?.viewUpdatedAt &&
        Date.now() - new Date(viewState.viewUpdatedAt).getTime() < STALE_MS
      const tabIsVisible = viewState?.isTabVisible === true
      const isViewingThisTask = viewState?.currentTaskId === taskId
      const isViewingAllTasks =
        viewState?.currentView === 'terminals' && viewState?.activeTabId === 'all-tasks'

      const shouldSuppress = viewIsRecent && tabIsVisible && (isViewingThisTask || isViewingAllTasks)

      if (!shouldSuppress) {
        sendNotification({
          title: 'Task Ready for Review',
          message: `Task "${updated.title}" moved to review`,
          taskId: updated.id,
          taskTitle: updated.title,
          type: 'task_status_change',
        })
      }
    }

    // Kill Claude processes for terminal statuses
    if ((newStatus === 'DONE' || newStatus === 'CANCELED') && updated.worktreePath) {
      try {
        killClaudeInTerminalsForWorktree(updated.worktreePath)
      } catch (err) {
        log.api.error('Failed to kill Claude in worktree', {
          worktreePath: updated.worktreePath,
          error: String(err),
        })
      }
    }

    // Create next recurrence when a repeating task is completed
    if (newStatus === 'DONE' && updated.recurrenceRule) {
      createNextRecurrence(updated)
    }
  }

  return updated ?? null
}
