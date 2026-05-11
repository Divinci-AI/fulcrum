/**
 * POST round-trip coverage (D-3.2 follow-up).
 *
 * The "POST silently drops field X" bug class has bitten us twice
 * (`tasks.notes` in D-3, `projects.notes` in D-3.1). These tests
 * post every nullable body field for tasks + projects and then GET
 * the row to assert each one round-trips. Future schema additions
 * that get plumbed through the body type without being threaded
 * into the insert will fail loudly here.
 */
import { expect, test } from '@playwright/test'
import { del, getJson, postJson, uniq } from '../_lib/api'

interface Task {
  id: string
  title: string
  description: string | null
  notes: string | null
  priority: string | null
  dueDate: string | null
  prefix: string | null
  timeEstimate: number | null
  pinned: boolean | null
  type: string | null
}
interface Project {
  id: string
  name: string
  description: string | null
  notes: string | null
}

test.describe('POST /api/tasks round-trip', () => {
  const created: string[] = []
  test.afterAll(async ({ request }) => {
    for (const id of created) await del(request, `/api/tasks/${id}`)
  })

  test('every accepted nullable field on POST is queryable on GET', async ({ request }) => {
    const payload = {
      title: uniq('rt-task'),
      type: 'manual' as const,
      description: 'desc-rt',
      notes: 'notes-rt',
      priority: 'high',
      dueDate: '2026-06-01',
      prefix: 'RT-1',
      timeEstimate: 2,
      pinned: true,
    }
    const task = await postJson<Task>(request, '/api/tasks', payload)
    created.push(task.id)

    const fetched = await getJson<Task>(request, `/api/tasks/${task.id}`)
    expect(fetched.title).toBe(payload.title)
    expect(fetched.description).toBe(payload.description)
    expect(fetched.notes).toBe(payload.notes)
    expect(fetched.priority).toBe(payload.priority)
    expect(fetched.dueDate).toBe(payload.dueDate)
    expect(fetched.prefix).toBe(payload.prefix)
    expect(fetched.timeEstimate).toBe(payload.timeEstimate)
    expect(fetched.pinned).toBe(true)
  })
})

test.describe('POST /api/projects round-trip', () => {
  const created: string[] = []
  test.afterAll(async ({ request }) => {
    for (const id of created) await del(request, `/api/projects/${id}`)
  })

  test('description and notes both persist through POST → GET', async ({ request }) => {
    const payload = {
      name: uniq('rt-project'),
      description: 'project-desc-rt',
      notes: 'project-notes-rt',
    }
    const project = await postJson<Project>(request, '/api/projects', payload)
    created.push(project.id)

    const fetched = await getJson<Project>(request, `/api/projects/${project.id}`)
    expect(fetched.name).toBe(payload.name)
    expect(fetched.description).toBe(payload.description)
    expect(fetched.notes).toBe(payload.notes)
  })
})
