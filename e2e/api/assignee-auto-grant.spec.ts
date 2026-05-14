/**
 * D-5 PR 4: assignee auto-grant.
 *
 * Assigning a user to a restricted task implicitly grants them viewer
 * access so the "you were assigned" UX (D-4 PR 3 toast) doesn't
 * dead-end on a 404 click-through. Idempotent — existing grants
 * (including stronger ones) are left alone.
 *
 * Covers:
 *  - POST /api/tasks with assigneeUserId on a restricted-from-birth flow
 *    grants the assignee viewer.
 *  - PATCH /api/tasks/:id setting assigneeUserId on an already-restricted
 *    task grants the new assignee viewer.
 *  - Existing higher-role grants are not downgraded.
 *  - Unassign (assigneeUserId → null) does not revoke prior grant.
 */
import { expect, test } from '@playwright/test'
import { uniq, uniqAlnum } from '../_lib/api'
import type { APIRequestContext } from '@playwright/test'

interface User { id: string; email: string }
interface Task { id: string }
interface Grant {
  id: string
  resourceType: string
  resourceId: string
  principalType: string
  principalId: string
  role: 'viewer' | 'editor' | 'admin'
}

const cf = (email: string) => ({ 'Cf-Access-Authenticated-User-Email': email })

async function provision(req: APIRequestContext, prefix: string): Promise<User> {
  const email = `${uniqAlnum(prefix)}@example.com`
  const res = await req.get('/api/users/me', { headers: cf(email) })
  const body = (await res.json()) as { user: User }
  return body.user
}

async function createTask(req: APIRequestContext, owner: User): Promise<Task> {
  const res = await req.post('/api/tasks', {
    headers: cf(owner.email),
    data: { title: uniq('e2e-autogrant'), type: 'manual' },
  })
  return (await res.json()) as Task
}

async function restrict(req: APIRequestContext, owner: User, taskId: string): Promise<void> {
  const res = await req.patch(`/api/acls/visibility/task/${taskId}`, {
    headers: cf(owner.email),
    data: { visibility: 'restricted' },
  })
  if (!res.ok()) throw new Error(`restrict failed: ${res.status()}`)
}

async function listGrants(
  req: APIRequestContext,
  email: string,
  taskId: string
): Promise<Grant[]> {
  const res = await req.get(`/api/acls?resourceType=task&resourceId=${taskId}`, {
    headers: cf(email),
  })
  if (!res.ok()) return []
  const body = (await res.json()) as { acls: Grant[] }
  return body.acls
}

test.describe('D-5 PR 4: assignee auto-grant', () => {
  test('POST with assigneeUserId on restricted-after flow grants viewer', async ({ request }) => {
    const owner = await provision(request, 'd5p4_post_owner')
    const assignee = await provision(request, 'd5p4_post_assignee')

    // Create task already assigning; this fires assigneeUserId immediately.
    const createRes = await request.post('/api/tasks', {
      headers: cf(owner.email),
      data: {
        title: uniq('e2e-autogrant-post'),
        type: 'manual',
        assigneeUserId: assignee.id,
      },
    })
    const task = (await createRes.json()) as Task

    // Restrict it so default tenant access no longer covers assignee.
    await restrict(request, owner, task.id)

    // Assignee should still be able to GET the task (PR 4 created a
    // viewer grant at POST time).
    const get = await request.get(`/api/tasks/${task.id}`, {
      headers: cf(assignee.email),
    })
    expect(get.ok()).toBe(true)

    const grants = await listGrants(request, owner.email, task.id)
    const grant = grants.find(
      (g) => g.principalType === 'user' && g.principalId === assignee.id
    )
    expect(grant?.role).toBe('viewer')

    await request.delete(`/api/tasks/${task.id}`, { headers: cf(owner.email) })
  })

  test('PATCH that sets assigneeUserId on a restricted task grants viewer', async ({ request }) => {
    const owner = await provision(request, 'd5p4_patch_owner')
    const newAssignee = await provision(request, 'd5p4_patch_target')
    const task = await createTask(request, owner)
    await restrict(request, owner, task.id)

    // Before assignment, the target can NOT see the task.
    const beforeRes = await request.get(`/api/tasks/${task.id}`, {
      headers: cf(newAssignee.email),
    })
    expect(beforeRes.status()).toBe(404)

    // Assign.
    await request.patch(`/api/tasks/${task.id}`, {
      headers: cf(owner.email),
      data: { assigneeUserId: newAssignee.id },
    })

    // After: can see it (implicit viewer grant).
    const afterRes = await request.get(`/api/tasks/${task.id}`, {
      headers: cf(newAssignee.email),
    })
    expect(afterRes.ok()).toBe(true)

    await request.delete(`/api/tasks/${task.id}`, { headers: cf(owner.email) })
  })

  test('existing admin grant is NOT downgraded by re-assignment', async ({ request }) => {
    const owner = await provision(request, 'd5p4_idem_owner')
    const target = await provision(request, 'd5p4_idem_target')
    const task = await createTask(request, owner)
    await restrict(request, owner, task.id)

    // Manually grant target admin first.
    await request.post('/api/acls', {
      headers: cf(owner.email),
      data: {
        resourceType: 'task',
        resourceId: task.id,
        principalType: 'user',
        principalId: target.id,
        role: 'admin',
      },
    })

    // Now assign target. Auto-grant should NOT replace admin with viewer.
    await request.patch(`/api/tasks/${task.id}`, {
      headers: cf(owner.email),
      data: { assigneeUserId: target.id },
    })

    const grants = await listGrants(request, owner.email, task.id)
    const grant = grants.find(
      (g) => g.principalType === 'user' && g.principalId === target.id
    )
    expect(grant?.role).toBe('admin')

    await request.delete(`/api/tasks/${task.id}`, { headers: cf(owner.email) })
  })

  test('unassign preserves the auto-granted viewer (no auto-revoke)', async ({ request }) => {
    const owner = await provision(request, 'd5p4_unassign_owner')
    const target = await provision(request, 'd5p4_unassign_target')
    const task = await createTask(request, owner)
    await restrict(request, owner, task.id)

    // Assign → auto-grant fires
    await request.patch(`/api/tasks/${task.id}`, {
      headers: cf(owner.email),
      data: { assigneeUserId: target.id },
    })
    // Unassign
    await request.patch(`/api/tasks/${task.id}`, {
      headers: cf(owner.email),
      data: { assigneeUserId: null },
    })

    // Target still has viewer access (auto-grant is sticky; revoke is
    // explicit via DELETE /api/acls/:grantId).
    const afterRes = await request.get(`/api/tasks/${task.id}`, {
      headers: cf(target.email),
    })
    expect(afterRes.ok()).toBe(true)

    await request.delete(`/api/tasks/${task.id}`, { headers: cf(owner.email) })
  })
})
