/**
 * Single-user task CRUD round-trip — prod-safe.
 *
 * Constraints in prod:
 *  - Identity is fixed (CF Access service token's policy email). We don't
 *    fabricate users; we test what one authenticated user can do.
 *  - Every resource we create is deleted in afterAll so prod doesn't
 *    accumulate test cruft.
 */
import { expect, test } from '@playwright/test'
import { del, getJson, postJson, uniq } from '../_lib/api'

interface Task {
  id: string
  title: string
  description: string | null
  notes: string | null
  status: string
}

const createdTaskIds: string[] = []

test.afterAll(async ({ request }) => {
  for (const id of createdTaskIds) {
    await del(request, `/api/tasks/${id}`)
  }
})

test('POST + GET round-trip persists every accepted nullable field', async ({ request }) => {
  const payload = {
    title: uniq('prod-rt-task'),
    type: 'manual' as const,
    description: 'prod desc',
    notes: 'prod notes',
    priority: 'medium',
    dueDate: '2026-12-31',
    prefix: 'P-1',
    timeEstimate: 1,
  }
  const task = await postJson<Task>(request, '/api/tasks', payload)
  createdTaskIds.push(task.id)

  const fetched = await getJson<Task & { priority: string }>(
    request,
    `/api/tasks/${task.id}`
  )
  expect(fetched.title).toBe(payload.title)
  expect(fetched.description).toBe(payload.description)
  expect(fetched.notes).toBe(payload.notes)
  expect(fetched.priority).toBe(payload.priority)
})

test('PATCH updates and persists', async ({ request }) => {
  const task = await postJson<Task>(request, '/api/tasks', {
    title: uniq('prod-patch-task'),
    type: 'manual',
  })
  createdTaskIds.push(task.id)

  const res = await request.patch(`/api/tasks/${task.id}`, {
    data: { description: 'patched description' },
  })
  expect(res.ok()).toBe(true)

  const fetched = await getJson<Task>(request, `/api/tasks/${task.id}`)
  expect(fetched.description).toBe('patched description')
})

test('GET /api/tasks includes the just-created task', async ({ request }) => {
  const task = await postJson<Task>(request, '/api/tasks', {
    title: uniq('prod-list-task'),
    type: 'manual',
  })
  createdTaskIds.push(task.id)

  const list = await getJson<Task[]>(request, '/api/tasks')
  expect(list.some((t) => t.id === task.id)).toBe(true)
})
