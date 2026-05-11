import { expect, test } from '@playwright/test'
import { del, getJson, patchJson, postJson, uniq } from '../_lib/api'

interface Task {
  id: string
  title: string
  status: 'TO_DO' | 'IN_PROGRESS' | 'IN_REVIEW' | 'DONE' | 'CANCELED'
  type: 'worktree' | 'scratch' | 'manual' | null
  priority?: 'high' | 'medium' | 'low' | null
}

test.describe('tasks API', () => {
  let createdId: string | undefined

  test.afterEach(async ({ request }) => {
    if (createdId) {
      await del(request, `/api/tasks/${createdId}`)
      createdId = undefined
    }
  })

  test('GET /api/tasks returns an array', async ({ request }) => {
    const list = await getJson<Task[]>(request, '/api/tasks')
    expect(Array.isArray(list)).toBe(true)
  })

  test('POST /api/tasks creates a manual task and returns it', async ({ request }) => {
    const title = uniq('e2e-task')
    const created = await postJson<Task>(request, '/api/tasks', {
      title,
      type: 'manual',
      priority: 'medium',
    })
    createdId = created.id
    expect(created.title).toBe(title)
    // Server default is IN_PROGRESS for manual tasks. Lock that in, but allow
    // TO_DO too in case a future change defaults manual tasks to backlog.
    expect(['TO_DO', 'IN_PROGRESS']).toContain(created.status)
    expect(created.type).toBe('manual')
  })

  test('PATCH /api/tasks/:id moves task to IN_REVIEW', async ({ request }) => {
    const created = await postJson<Task>(request, '/api/tasks', {
      title: uniq('e2e-task'),
      type: 'manual',
    })
    createdId = created.id
    const updated = await patchJson<Task>(request, `/api/tasks/${created.id}`, {
      status: 'IN_REVIEW',
    })
    expect(updated.status).toBe('IN_REVIEW')
  })

  test('marking a manual task DONE keeps it (no recurrence spawn)', async ({ request }) => {
    const created = await postJson<Task>(request, '/api/tasks', {
      title: uniq('e2e-task'),
      type: 'manual',
    })
    createdId = created.id
    const done = await patchJson<Task>(request, `/api/tasks/${created.id}`, {
      status: 'DONE',
    })
    expect(done.status).toBe('DONE')
    // Recurrence spawn would create a NEW task with the same title — verify it didn't.
    const list = await getJson<Task[]>(request, '/api/tasks')
    const matches = list.filter((t) => t.title === created.title)
    expect(matches.length).toBe(1)
  })
})
