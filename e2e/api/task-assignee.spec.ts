import { expect, test } from '@playwright/test'
import { del, getJson, patchJson, postJson, uniq, uniqAlnum } from '../_lib/api'

interface User {
  id: string
  email: string
}
interface MeResponse {
  user: User
}
interface Task {
  id: string
  title: string
  status: string
  assigneeUserId: string | null
}

/**
 * Provision a user via the CF Access header path (D-1) and return its id.
 * Each call creates a fresh test user so concurrent runs don't collide on
 * the assignee_user_id filter.
 */
async function provisionUser(
  request: import('@playwright/test').APIRequestContext,
  prefix = 'd2_user'
): Promise<string> {
  const email = `${uniqAlnum(prefix)}@example.com`
  const res = await request.get('/api/users/me', {
    headers: { 'Cf-Access-Authenticated-User-Email': email },
  })
  const body = (await res.json()) as MeResponse
  expect(body.user).toBeTruthy()
  return body.user.id
}

test.describe('task assignee (D-2)', () => {
  let createdTaskIds: string[] = []

  test.afterEach(async ({ request }) => {
    for (const id of createdTaskIds) {
      await del(request, `/api/tasks/${id}`)
    }
    createdTaskIds = []
  })

  test('newly created task starts with assigneeUserId: null', async ({ request }) => {
    const task = await postJson<Task>(request, '/api/tasks', {
      title: uniq('e2e-unassigned'),
      type: 'manual',
    })
    createdTaskIds.push(task.id)
    expect(task.assigneeUserId).toBeNull()
  })

  test('POST accepts assigneeUserId at creation', async ({ request }) => {
    const assigneeId = await provisionUser(request)
    const task = await postJson<Task>(request, '/api/tasks', {
      title: uniq('e2e-assigned-on-create'),
      type: 'manual',
      assigneeUserId: assigneeId,
    })
    createdTaskIds.push(task.id)
    expect(task.assigneeUserId).toBe(assigneeId)
  })

  test('PATCH assigns + unassigns', async ({ request }) => {
    const assigneeId = await provisionUser(request)
    const task = await postJson<Task>(request, '/api/tasks', {
      title: uniq('e2e-assign-patch'),
      type: 'manual',
    })
    createdTaskIds.push(task.id)
    expect(task.assigneeUserId).toBeNull()

    const assigned = await patchJson<Task>(request, `/api/tasks/${task.id}`, {
      assigneeUserId: assigneeId,
    })
    expect(assigned.assigneeUserId).toBe(assigneeId)

    // Unassign by setting null
    const cleared = await patchJson<Task>(request, `/api/tasks/${task.id}`, {
      assigneeUserId: null,
    })
    expect(cleared.assigneeUserId).toBeNull()
  })

  test('PATCH unassigns when given empty string too (UX equivalence)', async ({ request }) => {
    const assigneeId = await provisionUser(request)
    const task = await postJson<Task>(request, '/api/tasks', {
      title: uniq('e2e-empty-string-unassign'),
      type: 'manual',
      assigneeUserId: assigneeId,
    })
    createdTaskIds.push(task.id)
    expect(task.assigneeUserId).toBe(assigneeId)

    const cleared = await patchJson<Task>(request, `/api/tasks/${task.id}`, {
      assigneeUserId: '',
    })
    expect(cleared.assigneeUserId).toBeNull()
  })

  test('GET /api/tasks?assigneeId=<id> filters to that assignee only', async ({ request }) => {
    const aliceId = await provisionUser(request, 'd2_alice')
    const bobId = await provisionUser(request, 'd2_bob')

    const t1 = await postJson<Task>(request, '/api/tasks', {
      title: uniq('e2e-alice-task'),
      type: 'manual',
      assigneeUserId: aliceId,
    })
    const t2 = await postJson<Task>(request, '/api/tasks', {
      title: uniq('e2e-bob-task'),
      type: 'manual',
      assigneeUserId: bobId,
    })
    const t3 = await postJson<Task>(request, '/api/tasks', {
      title: uniq('e2e-unassigned-task'),
      type: 'manual',
    })
    createdTaskIds.push(t1.id, t2.id, t3.id)

    const aliceList = await getJson<Task[]>(request, `/api/tasks?assigneeId=${aliceId}`)
    expect(aliceList.some((t) => t.id === t1.id)).toBe(true)
    expect(aliceList.some((t) => t.id === t2.id)).toBe(false)
    expect(aliceList.every((t) => t.assigneeUserId === aliceId)).toBe(true)

    const unassignedList = await getJson<Task[]>(request, '/api/tasks?assigneeId=unassigned')
    expect(unassignedList.some((t) => t.id === t3.id)).toBe(true)
    expect(unassignedList.every((t) => t.assigneeUserId === null)).toBe(true)
  })
})
