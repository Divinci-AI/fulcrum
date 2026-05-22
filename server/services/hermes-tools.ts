/**
 * Tool calling for the Hermes provider (D-16 B2a).
 *
 * Hermes hits an OpenAI-compatible chat-completions endpoint. The OpenAI
 * spec supports `tools: [...]` for function calling — the model returns
 * `tool_calls` and the server executes them, appending `role: 'tool'`
 * results, until the model emits a final assistant message with no more
 * tool_calls. This module ships:
 *
 *   - OpenAI function schemas for a starter set of high-impact Fulcrum tools
 *     (list_tasks / get_task / update_task — enough to demo the Slack DM
 *     "what's on my plate / mark this done" flow)
 *   - In-process handlers that talk directly to Drizzle (no HTTP indirection)
 *   - `executeToolCall()` dispatcher with structured error shaping so model
 *     errors come back as tool messages it can react to, not server crashes
 *
 * Out of scope for B2a (separate PRs):
 *   - Streaming tool_calls (B2b)
 *   - Observer-tier scoping (B2b)
 *   - Full tool parity with the MCP server (~100+ tools, B2c)
 */
import { and, desc, eq, inArray, like, type SQL } from 'drizzle-orm'
import { db, tasks } from '../db'
import { log } from '../lib/logger'
import type { TaskStatus } from '../../shared/types'

/** OpenAI's tool definition shape. */
export interface OpenAITool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown> // JSON Schema
  }
}

/** OpenAI's tool_call shape (subset of what we need). */
export interface OpenAIToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string } // arguments is JSON-stringified
}

/** Tool result fed back to the model. */
export interface ToolResult {
  tool_call_id: string
  role: 'tool'
  name: string
  content: string // JSON-stringified result, or human-readable error
}

const TASK_STATUSES = ['TO_DO', 'IN_PROGRESS', 'IN_REVIEW', 'DONE', 'CANCELED'] as const

/**
 * The starter set of tools exposed to Hermes. Order matters only for prompt
 * compression — keep the most common ones first so they show up early in
 * the model's context window.
 */
export const HERMES_TOOLS: OpenAITool[] = [
  {
    type: 'function',
    function: {
      name: 'list_tasks',
      description:
        'List Fulcrum tasks with optional filters. Use this when the user asks about their tasks, what is pending, what is in progress, etc.',
      parameters: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: TASK_STATUSES,
            description: 'Filter to a single task status. Omit for all statuses.',
          },
          search: {
            type: 'string',
            description: 'Case-insensitive substring match on task title.',
          },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: 50,
            description: 'Maximum number of tasks to return. Defaults to 20.',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_task',
      description:
        'Fetch full details for a single task by id. Use after list_tasks to drill into a specific entry.',
      parameters: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', description: 'The task id (e.g. "8cb2c6d0-…").' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_task',
      description:
        'Update fields on an existing task. Most common use: changing status (e.g. to DONE or CANCELED). Pass only the fields you want to change.',
      parameters: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', description: 'The task id.' },
          status: {
            type: 'string',
            enum: TASK_STATUSES,
            description: 'New status. Setting DONE or CANCELED also stamps completedAt.',
          },
          title: { type: 'string', description: 'New title.' },
          priority: {
            type: 'string',
            enum: ['high', 'medium', 'low'],
            description: 'New priority.',
          },
        },
      },
    },
  },
]

/**
 * Execute a single tool call and return the result message to feed back into
 * the model. Never throws — failures are encoded as result content so the
 * model can react to them.
 */
export async function executeToolCall(call: OpenAIToolCall): Promise<ToolResult> {
  const { name } = call.function
  let args: Record<string, unknown>
  try {
    args = JSON.parse(call.function.arguments || '{}')
  } catch (err) {
    return errorResult(call, `Invalid JSON arguments: ${err instanceof Error ? err.message : String(err)}`)
  }

  try {
    switch (name) {
      case 'list_tasks':
        return successResult(call, await handleListTasks(args))
      case 'get_task':
        return successResult(call, await handleGetTask(args))
      case 'update_task':
        return successResult(call, await handleUpdateTask(args))
      default:
        return errorResult(call, `Unknown tool: ${name}`)
    }
  } catch (err) {
    log.chat.error('Hermes tool execution failed', { tool: name, error: String(err) })
    return errorResult(call, err instanceof Error ? err.message : String(err))
  }
}

function successResult(call: OpenAIToolCall, payload: unknown): ToolResult {
  return {
    tool_call_id: call.id,
    role: 'tool',
    name: call.function.name,
    content: JSON.stringify(payload),
  }
}

function errorResult(call: OpenAIToolCall, message: string): ToolResult {
  return {
    tool_call_id: call.id,
    role: 'tool',
    name: call.function.name,
    content: JSON.stringify({ error: message }),
  }
}

// ---------------------------------------------------------------------------
// Tool handlers — direct Drizzle, no HTTP indirection
// ---------------------------------------------------------------------------

async function handleListTasks(args: Record<string, unknown>): Promise<unknown> {
  const status = args.status as TaskStatus | undefined
  const search = args.search as string | undefined
  const limit = typeof args.limit === 'number' ? Math.min(50, Math.max(1, args.limit)) : 20

  const conditions: SQL<unknown>[] = []
  if (status) conditions.push(eq(tasks.status, status))
  if (search && search.trim()) conditions.push(like(tasks.title, `%${search.trim()}%`))

  const rows = db
    .select({
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
      priority: tasks.priority,
      dueDate: tasks.dueDate,
      assigneeUserId: tasks.assigneeUserId,
      projectId: tasks.projectId,
      updatedAt: tasks.updatedAt,
    })
    .from(tasks)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(tasks.updatedAt))
    .limit(limit)
    .all()

  return { count: rows.length, tasks: rows }
}

async function handleGetTask(args: Record<string, unknown>): Promise<unknown> {
  const id = args.id as string | undefined
  if (!id) throw new Error('Missing required argument: id')
  const row = db.select().from(tasks).where(eq(tasks.id, id)).get()
  if (!row) throw new Error(`Task not found: ${id}`)
  return row
}

async function handleUpdateTask(args: Record<string, unknown>): Promise<unknown> {
  const id = args.id as string | undefined
  if (!id) throw new Error('Missing required argument: id')

  const updates: Record<string, unknown> = {}
  if (typeof args.status === 'string' && (TASK_STATUSES as readonly string[]).includes(args.status)) {
    updates.status = args.status
  }
  if (typeof args.title === 'string' && args.title.trim()) updates.title = args.title.trim()
  if (typeof args.priority === 'string' && ['high', 'medium', 'low'].includes(args.priority)) {
    updates.priority = args.priority
  }

  if (Object.keys(updates).length === 0) {
    throw new Error('No updatable fields provided. Pass at least one of: status, title, priority.')
  }

  const now = new Date().toISOString()
  updates.updatedAt = now
  // D-14 PR 1 parity: stamp completedAt when transitioning to a terminal status
  if (updates.status === 'DONE' || updates.status === 'CANCELED') {
    updates.completedAt = now
  } else if (updates.status && updates.status !== 'DONE' && updates.status !== 'CANCELED') {
    updates.completedAt = null
  }

  db.update(tasks).set(updates).where(eq(tasks.id, id)).run()
  const updated = db.select().from(tasks).where(eq(tasks.id, id)).get()
  if (!updated) throw new Error(`Task not found after update: ${id}`)
  return updated
}

// Suppress unused-import warning — `inArray` is reserved for future tool handlers
// that need IN clauses (e.g. list_tasks with multiple statuses in B2c).
void inArray
