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
import { search } from './search-service'
import { searchMemories, storeMemory } from './memory-service'
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

/** OpenAI's tool_call shape (subset of what we need).
 *
 * `extra_content` is a Gemini-specific nested extension: thinking-capable
 * models (gemini-2.5/3.5-flash, gemini-3-pro, …) attach an opaque
 * thought_signature at `extra_content.google.thought_signature`, and reject
 * the next turn with HTTP 400 if the follow-up assistant message doesn't
 * echo it back in the same nested shape. Non-Gemini providers simply ignore
 * the field, so it's safe to forward unconditionally.
 */
export interface OpenAIToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string } // arguments is JSON-stringified
  extra_content?: { google?: { thought_signature?: string } }
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
      name: 'create_task',
      description:
        'Create a new Fulcrum task. Use for "add a task for X" requests. Defaults to TO_DO status and manual type (no worktree/scratch dir).',
      parameters: {
        type: 'object',
        required: ['title'],
        properties: {
          title: { type: 'string', description: 'Task title.' },
          description: { type: 'string', description: 'Optional longer description.' },
          status: {
            type: 'string',
            enum: TASK_STATUSES,
            description: 'Initial status. Defaults to TO_DO.',
          },
          priority: {
            type: 'string',
            enum: ['high', 'medium', 'low'],
            description: 'Priority. Defaults to medium.',
          },
          dueDate: {
            type: 'string',
            description: 'Due date in YYYY-MM-DD format.',
          },
          projectId: {
            type: 'string',
            description: 'Optional project to link the task to.',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search',
      description:
        'Unified full-text search across tasks, projects, channel messages, calendar events, memories, and conversations. Returns top results across all entity types. Use for any "find X" or "what do I have about Y?" request.',
      parameters: {
        type: 'object',
        required: ['query'],
        properties: {
          query: {
            type: 'string',
            description: 'Search query. Multi-token queries are ANDed across tokens.',
          },
          entities: {
            type: 'array',
            items: {
              type: 'string',
              enum: ['tasks', 'projects', 'messages', 'events', 'memories', 'conversations'],
            },
            description: 'Restrict search to specific entity types. Omit to search all.',
          },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: 50,
            description: 'Per-entity result cap. Defaults to 10.',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_search',
      description:
        'Search the assistant\'s long-term memory store (persistent across conversations). Use to recall facts the user has previously shared.',
      parameters: {
        type: 'object',
        required: ['query'],
        properties: {
          query: { type: 'string', description: 'FTS5-style search query.' },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional tag filter — only memories with at least one of these tags.',
          },
          limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Max results.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_store',
      description:
        'Save a fact or preference to long-term memory so future conversations can recall it. Tag aggressively — tags are how memories are later retrieved.',
      parameters: {
        type: 'object',
        required: ['content'],
        properties: {
          content: { type: 'string', description: 'The fact/preference to remember.' },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Tags for later retrieval (e.g. ["preference", "calendar"]).',
          },
          source: {
            type: 'string',
            description: 'Optional source identifier (e.g. "slack-dm-2026-05-22").',
          },
        },
      },
    },
  },
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
      case 'create_task':
        return successResult(call, await handleCreateTask(args))
      case 'search':
        return successResult(call, await handleSearch(args))
      case 'memory_search':
        return successResult(call, await handleMemorySearch(args))
      case 'memory_store':
        return successResult(call, await handleMemoryStore(args))
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

async function handleCreateTask(args: Record<string, unknown>): Promise<unknown> {
  const title = args.title as string | undefined
  if (!title || !title.trim()) throw new Error('Missing required argument: title')

  const status = (args.status as TaskStatus | undefined) ?? 'TO_DO'
  if (!(TASK_STATUSES as readonly string[]).includes(status)) {
    throw new Error(`Invalid status: ${status}`)
  }
  const priority =
    typeof args.priority === 'string' && ['high', 'medium', 'low'].includes(args.priority)
      ? (args.priority as 'high' | 'medium' | 'low')
      : 'medium'

  // Compute next position within the chosen status column
  const existing = db.select({ position: tasks.position }).from(tasks).where(eq(tasks.status, status)).all()
  const maxPosition = existing.reduce((m, t) => Math.max(m, t.position), -1)

  const now = new Date().toISOString()
  const id = crypto.randomUUID()
  const newTask = {
    id,
    title: title.trim(),
    description: typeof args.description === 'string' ? args.description : null,
    status,
    position: maxPosition + 1,
    agent: 'claude' as const,
    visibility: 'tenant' as const,
    priority,
    dueDate: typeof args.dueDate === 'string' ? args.dueDate : null,
    projectId: typeof args.projectId === 'string' ? args.projectId : null,
    startedAt: status === 'TO_DO' ? null : now,
    createdAt: now,
    updatedAt: now,
  }
  db.insert(tasks).values(newTask).run()
  const row = db.select().from(tasks).where(eq(tasks.id, id)).get()
  if (!row) throw new Error('Task creation succeeded but row not found — schema mismatch?')
  return row
}

async function handleSearch(args: Record<string, unknown>): Promise<unknown> {
  const query = args.query as string | undefined
  if (!query || !query.trim()) throw new Error('Missing required argument: query')

  type EntityKind = Parameters<typeof search>[0]['entities'] extends (infer U)[] | undefined ? U : never
  const entities = Array.isArray(args.entities) ? (args.entities as EntityKind[]) : undefined
  const limit = typeof args.limit === 'number' ? Math.min(50, Math.max(1, args.limit)) : 10

  const results = await search({ query, entities, limit })
  return { count: results.length, results }
}

async function handleMemorySearch(args: Record<string, unknown>): Promise<unknown> {
  const query = args.query as string | undefined
  if (!query || !query.trim()) throw new Error('Missing required argument: query')

  const tags = Array.isArray(args.tags) ? (args.tags as string[]) : undefined
  const limit = typeof args.limit === 'number' ? Math.min(50, Math.max(1, args.limit)) : 20

  const results = await searchMemories({ query, tags, limit })
  return { count: results.length, memories: results }
}

async function handleMemoryStore(args: Record<string, unknown>): Promise<unknown> {
  const content = args.content as string | undefined
  if (!content || !content.trim()) throw new Error('Missing required argument: content')

  const tags = Array.isArray(args.tags) ? (args.tags as string[]) : undefined
  const source = typeof args.source === 'string' ? args.source : undefined

  const result = await storeMemory({ content: content.trim(), tags, source })
  return result
}

// Suppress unused-import warning — `inArray` is reserved for future tool handlers
// that need IN clauses (e.g. list_tasks with multiple statuses).
void inArray
