import { db, type Task } from '../db'
import { tags, taskTags } from '../db/schema'
import { eq } from 'drizzle-orm'
import { createHmac } from 'node:crypto'
import { log } from '../lib/logger'

/**
 * Outbound task-status webhooks.
 *
 * Configure with FULCRUM_TASK_WEBHOOK_URLS — a comma-separated list of URLs.
 * On every task status transition, each URL receives:
 *
 *   POST <url>
 *   headers: X-Fulcrum-Timestamp: <ms>, X-Fulcrum-Signature: sha256=<hmac hex>
 *   { "event": "task.status_changed",
 *     "oldStatus": "IN_REVIEW", "newStatus": "DONE", "at": "<ISO8601>",
 *     "task": { "id", "title", "status", "projectId", "priority", "tags" } }
 *
 * When FULCRUM_TASK_WEBHOOK_SECRET is set, each request is HMAC-SHA256 signed
 * over `${timestamp}.${body}` so the receiver can verify authenticity + reject
 * replays — this is preferred over putting a token in the URL (which leaks into
 * request logs). Delivery is fire-and-forget with a 10s timeout; no retries —
 * receivers needing reliability should reconcile by polling GET /api/tasks.
 */
export function fireTaskStatusWebhooks(task: Task, oldStatus: string, newStatus: string): void {
  const raw = process.env.FULCRUM_TASK_WEBHOOK_URLS
  if (!raw) return
  const urls = raw
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean)
  if (!urls.length) return

  let tagNames: string[] = []
  try {
    tagNames = db
      .select({ name: tags.name })
      .from(taskTags)
      .innerJoin(tags, eq(taskTags.tagId, tags.id))
      .where(eq(taskTags.taskId, task.id))
      .all()
      .map((t) => t.name)
  } catch {
    // tags are best-effort in the payload
  }

  const payload = JSON.stringify({
    event: 'task.status_changed',
    oldStatus,
    newStatus,
    at: new Date().toISOString(),
    task: {
      id: task.id,
      title: task.title,
      status: newStatus,
      projectId: task.projectId,
      priority: task.priority,
      tags: tagNames,
    },
  })

  const secret = process.env.FULCRUM_TASK_WEBHOOK_SECRET
  const timestamp = String(Date.now())
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (secret) {
    headers['X-Fulcrum-Timestamp'] = timestamp
    headers['X-Fulcrum-Signature'] =
      'sha256=' + createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex')
  }

  for (const url of urls) {
    fetch(url, {
      method: 'POST',
      headers,
      body: payload,
      signal: AbortSignal.timeout(10_000),
    })
      .then((res) => {
        if (!res.ok) {
          log.api.warn('Task webhook returned non-2xx', { url, status: res.status, taskId: task.id })
        }
      })
      .catch((err) => {
        log.api.warn('Task webhook delivery failed', { url, taskId: task.id, error: String(err) })
      })
  }
}
