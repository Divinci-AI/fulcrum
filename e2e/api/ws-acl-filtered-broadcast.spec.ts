/**
 * D-4 PR 4: ACL-filter the WS broadcast.
 *
 * A user mentioned on a restricted task they have no grant on should
 * NOT receive the `task:mentioned` event (their in-app toast would
 * dead-end on a 404 click-through). External notifications (Slack /
 * Gmail / etc.) keep firing because they're already "out-of-band" —
 * the mismatch is documented.
 *
 * Covers:
 *  - Mention on tenant-visible task → event reaches the user. (baseline)
 *  - Mention on restricted task w/o grant → event suppressed.
 *  - Mention on restricted task WITH grant → event reaches the user.
 *  - Project mention parity for the suppression case.
 */
import { expect, test } from '@playwright/test'
import { del, uniq, uniqAlnum } from '../_lib/api'
import { WsClient, wsUrl } from '../_lib/ws'
import type { APIRequestContext } from '@playwright/test'

interface User { id: string; email: string }

const cf = (email: string) => ({ 'Cf-Access-Authenticated-User-Email': email })

async function provision(req: APIRequestContext, prefix: string): Promise<User> {
  const email = `${uniqAlnum(prefix)}@example.com`
  const res = await req.get('/api/users/me', { headers: cf(email) })
  const body = (await res.json()) as { user: User }
  return body.user
}

async function openMeSocket(user: User): Promise<WsClient> {
  const ws = new WsClient(wsUrl('/ws/terminal'), {
    headers: { 'Cf-Access-Authenticated-User-Email': user.email },
  })
  await ws.opened
  ws.send({ type: 'subscribe', payload: { topics: ['me'] } })
  await ws.next((m) => m.type === 'subscription:ack', 3000)
  return ws
}

async function restrict(req: APIRequestContext, owner: User, taskId: string): Promise<void> {
  const res = await req.patch(`/api/acls/visibility/task/${taskId}`, {
    headers: cf(owner.email),
    data: { visibility: 'restricted' },
  })
  if (!res.ok()) throw new Error(`restrict failed: ${res.status()}`)
}

async function grantViewer(
  req: APIRequestContext,
  owner: User,
  resourceType: 'task' | 'project',
  resourceId: string,
  principalId: string
): Promise<void> {
  const res = await req.post('/api/acls', {
    headers: cf(owner.email),
    data: {
      resourceType,
      resourceId,
      principalType: 'user',
      principalId,
      role: 'viewer',
    },
  })
  if (!res.ok()) throw new Error(`grant failed: ${res.status()}`)
}

test.describe('D-4 PR 4: ACL-filtered WS broadcast', () => {
  test('mention on tenant-visible task reaches the user (baseline)', async ({ request }) => {
    const owner = await provision(request, 'd4p4_tv_owner')
    const target = await provision(request, 'd4p4_tv_target')
    const ws = await openMeSocket(target)

    const taskRes = await request.post('/api/tasks', {
      headers: cf(owner.email),
      data: {
        title: uniq('e2e-tv-mention'),
        type: 'manual',
        description: `cc @${target.email}`,
      },
    })
    const task = (await taskRes.json()) as { id: string }

    const evt = await ws.next(
      (m) =>
        m.type === 'task:mentioned' &&
        (m.payload as { taskId?: string }).taskId === task.id,
      3000
    )
    expect((evt.payload as { mentionedUserId: string }).mentionedUserId).toBe(target.id)

    ws.close()
    await del(request, `/api/tasks/${task.id}`)
  })

  test('mention on restricted task w/o grant is suppressed', async ({ request }) => {
    const owner = await provision(request, 'd4p4_r_owner')
    const target = await provision(request, 'd4p4_r_target')
    const ws = await openMeSocket(target)

    // Owner creates a task that doesn't mention target yet, restricts it,
    // then PATCHes the description to add the mention.
    const taskRes = await request.post('/api/tasks', {
      headers: cf(owner.email),
      data: { title: uniq('e2e-r-mention'), type: 'manual' },
    })
    const task = (await taskRes.json()) as { id: string }
    await restrict(request, owner, task.id)
    await request.patch(`/api/tasks/${task.id}`, {
      headers: cf(owner.email),
      data: { description: `please look @${target.email}` },
    })

    // Wait long enough that the event WOULD have arrived if dispatched.
    await expect(
      ws.next(
        (m) =>
          m.type === 'task:mentioned' &&
          (m.payload as { taskId?: string }).taskId === task.id,
        1200
      )
    ).rejects.toThrow(/timeout/)

    ws.close()
    await request.delete(`/api/tasks/${task.id}`, { headers: cf(owner.email) })
  })

  test('mention on restricted task WITH grant DOES reach the user', async ({ request }) => {
    const owner = await provision(request, 'd4p4_rg_owner')
    const target = await provision(request, 'd4p4_rg_target')
    const ws = await openMeSocket(target)

    const taskRes = await request.post('/api/tasks', {
      headers: cf(owner.email),
      data: { title: uniq('e2e-rg-mention'), type: 'manual' },
    })
    const task = (await taskRes.json()) as { id: string }
    await restrict(request, owner, task.id)
    await grantViewer(request, owner, 'task', task.id, target.id)

    // PATCH to mention (mention sync re-fires).
    await request.patch(`/api/tasks/${task.id}`, {
      headers: cf(owner.email),
      data: { description: `hey @${target.email}` },
    })

    const evt = await ws.next(
      (m) =>
        m.type === 'task:mentioned' &&
        (m.payload as { taskId?: string }).taskId === task.id,
      3000
    )
    expect((evt.payload as { mentionedUserId: string }).mentionedUserId).toBe(target.id)

    ws.close()
    await request.delete(`/api/tasks/${task.id}`, { headers: cf(owner.email) })
  })

  test('project mention on restricted project is suppressed', async ({ request }) => {
    const owner = await provision(request, 'd4p4_proj_owner')
    const target = await provision(request, 'd4p4_proj_target')
    const ws = await openMeSocket(target)

    const projRes = await request.post('/api/projects', {
      headers: cf(owner.email),
      data: { name: uniq('e2e-r-proj-mention') },
    })
    const project = (await projRes.json()) as { id: string }
    await request.patch(`/api/acls/visibility/project/${project.id}`, {
      headers: cf(owner.email),
      data: { visibility: 'restricted' },
    })
    await request.patch(`/api/projects/${project.id}`, {
      headers: cf(owner.email),
      data: { description: `kickoff @${target.email}` },
    })

    await expect(
      ws.next(
        (m) =>
          m.type === 'project:mentioned' &&
          (m.payload as { projectId?: string }).projectId === project.id,
        1200
      )
    ).rejects.toThrow(/timeout/)

    ws.close()
    await request.delete(`/api/projects/${project.id}`, { headers: cf(owner.email) })
  })
})
