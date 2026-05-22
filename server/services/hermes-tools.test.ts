import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { setupTestEnv, type TestEnv } from '../__tests__/utils/env'
import { db, tasks } from '../db'
import { eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { HERMES_TOOLS, executeToolCall, type OpenAIToolCall } from './hermes-tools'

function makeCall(name: string, args: Record<string, unknown>, id = `call_${nanoid()}`): OpenAIToolCall {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } }
}

function insertTestTask(overrides: Partial<typeof tasks.$inferInsert> = {}): string {
  const id = nanoid()
  const now = new Date().toISOString()
  db.insert(tasks).values({
    id,
    title: overrides.title ?? 'Test task',
    status: overrides.status ?? 'TO_DO',
    priority: overrides.priority ?? 'medium',
    position: 0,
    agent: 'claude',
    visibility: 'tenant',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }).run()
  return id
}

describe('hermes-tools', () => {
  let testEnv: TestEnv

  beforeEach(() => {
    testEnv = setupTestEnv()
  })

  afterEach(() => {
    testEnv.cleanup()
  })

  describe('HERMES_TOOLS schema', () => {
    test('exposes the three starter tools with correct function names', () => {
      const names = HERMES_TOOLS.map((t) => t.function.name).sort()
      expect(names).toEqual(['get_task', 'list_tasks', 'update_task'])
    })

    test('every tool has type: function and a parameters schema', () => {
      for (const tool of HERMES_TOOLS) {
        expect(tool.type).toBe('function')
        expect(tool.function.parameters).toBeDefined()
        expect((tool.function.parameters as { type: string }).type).toBe('object')
      }
    })
  })

  describe('executeToolCall — list_tasks', () => {
    test('returns all tasks when no filters provided', async () => {
      insertTestTask({ title: 'A' })
      insertTestTask({ title: 'B' })
      const result = await executeToolCall(makeCall('list_tasks', {}))
      const parsed = JSON.parse(result.content) as { count: number; tasks: { title: string }[] }
      expect(parsed.count).toBe(2)
      expect(parsed.tasks.map((t) => t.title).sort()).toEqual(['A', 'B'])
    })

    test('filters by status', async () => {
      insertTestTask({ title: 'pending', status: 'TO_DO' })
      insertTestTask({ title: 'done', status: 'DONE' })
      const result = await executeToolCall(makeCall('list_tasks', { status: 'DONE' }))
      const parsed = JSON.parse(result.content) as { tasks: { title: string }[] }
      expect(parsed.tasks).toHaveLength(1)
      expect(parsed.tasks[0].title).toBe('done')
    })

    test('filters by search substring (case-insensitive via LIKE)', async () => {
      insertTestTask({ title: 'Deploy the website' })
      insertTestTask({ title: 'Buy groceries' })
      const result = await executeToolCall(makeCall('list_tasks', { search: 'deploy' }))
      const parsed = JSON.parse(result.content) as { tasks: { title: string }[] }
      // SQLite LIKE is case-insensitive for ASCII by default
      expect(parsed.tasks).toHaveLength(1)
    })

    test('respects limit', async () => {
      for (let i = 0; i < 5; i++) insertTestTask({ title: `T${i}` })
      const result = await executeToolCall(makeCall('list_tasks', { limit: 2 }))
      const parsed = JSON.parse(result.content) as { count: number; tasks: unknown[] }
      expect(parsed.count).toBe(2)
      expect(parsed.tasks).toHaveLength(2)
    })
  })

  describe('executeToolCall — get_task', () => {
    test('returns the task by id', async () => {
      const id = insertTestTask({ title: 'specific' })
      const result = await executeToolCall(makeCall('get_task', { id }))
      const parsed = JSON.parse(result.content) as { title: string }
      expect(parsed.title).toBe('specific')
    })

    test('returns an error result when id is missing', async () => {
      const result = await executeToolCall(makeCall('get_task', {}))
      const parsed = JSON.parse(result.content) as { error: string }
      expect(parsed.error).toContain('Missing required argument: id')
    })

    test('returns an error result when task does not exist', async () => {
      const result = await executeToolCall(makeCall('get_task', { id: 'nonexistent' }))
      const parsed = JSON.parse(result.content) as { error: string }
      expect(parsed.error).toContain('not found')
    })
  })

  describe('executeToolCall — update_task', () => {
    test('updates status and stamps completedAt on terminal transition', async () => {
      const id = insertTestTask({ status: 'TO_DO' })
      const result = await executeToolCall(makeCall('update_task', { id, status: 'DONE' }))
      const parsed = JSON.parse(result.content) as { status: string; completedAt: string }
      expect(parsed.status).toBe('DONE')
      expect(parsed.completedAt).toBeDefined()
      expect(parsed.completedAt).not.toBeNull()
    })

    test('clears completedAt when transitioning out of terminal state', async () => {
      const id = insertTestTask({ status: 'DONE', completedAt: new Date().toISOString() })
      const result = await executeToolCall(makeCall('update_task', { id, status: 'IN_PROGRESS' }))
      const parsed = JSON.parse(result.content) as { status: string; completedAt: string | null }
      expect(parsed.status).toBe('IN_PROGRESS')
      expect(parsed.completedAt).toBeNull()
    })

    test('returns error when no updatable fields are provided', async () => {
      const id = insertTestTask()
      const result = await executeToolCall(makeCall('update_task', { id }))
      const parsed = JSON.parse(result.content) as { error: string }
      expect(parsed.error).toContain('No updatable fields')
    })

    test('ignores invalid status values without crashing', async () => {
      const id = insertTestTask()
      const result = await executeToolCall(makeCall('update_task', { id, status: 'BOGUS' }))
      const parsed = JSON.parse(result.content) as { error?: string; status?: string }
      // status was invalid, so no fields were applied → returns the "no updatable fields" error
      expect(parsed.error).toContain('No updatable fields')
    })
  })

  describe('executeToolCall — error shaping', () => {
    test('unknown tool name returns an error result rather than throwing', async () => {
      const result = await executeToolCall(makeCall('frobnicate', {}))
      const parsed = JSON.parse(result.content) as { error: string }
      expect(parsed.error).toContain('Unknown tool')
    })

    test('malformed JSON arguments return an error result rather than throwing', async () => {
      const call: OpenAIToolCall = {
        id: 'call_1',
        type: 'function',
        function: { name: 'list_tasks', arguments: '{ this is not json' },
      }
      const result = await executeToolCall(call)
      const parsed = JSON.parse(result.content) as { error: string }
      expect(parsed.error).toContain('Invalid JSON arguments')
    })

    test('result envelope always includes tool_call_id, role, and name', async () => {
      const call = makeCall('list_tasks', {})
      const result = await executeToolCall(call)
      expect(result.tool_call_id).toBe(call.id)
      expect(result.role).toBe('tool')
      expect(result.name).toBe('list_tasks')
    })
  })
})

// Suppress unused-import warning for `tasks` schema reference (used in helpers above)
void tasks
void eq
