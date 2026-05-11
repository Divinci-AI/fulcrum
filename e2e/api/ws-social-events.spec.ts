/**
 * D-4 PR 2: social events over the WS substrate.
 *
 * Covers:
 *  - `task:mentioned` fires when a user is @mentioned in a task and
 *    reaches a socket subscribed to `me` for that user.
 *  - `task:assigned` fires when assigneeUserId changes via PATCH (and at
 *    creation time when set on POST).
 *  - `project:mentioned` parity check on project mention.
 *  - Event does NOT reach a socket that isn't subscribed to `me`.
 *
 * Builds on D-4 PR 1's subscribe substrate.
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

test.describe('D-4 PR 2: social events', () => {
  test('task:mentioned reaches the mentioned user via `me`', async ({ request }) => {
    const alice = await provision(request, 'd4p2_alice')
    const ws = await openMeSocket(alice)

    const taskRes = await request.post('/api/tasks', {
      headers: cf(alice.email),
      data: {
        title: uniq('e2e-mention-ws'),
        type: 'manual',
        description: `kickoff @${alice.email}`,
      },
    })
    const task = (await taskRes.json()) as { id: string }

    const evt = await ws.next(
      (m) =>
        m.type === 'task:mentioned' &&
        (m.payload as { taskId?: string }).taskId === task.id,
      3000
    )
    expect((evt.payload as { mentionedUserId: string }).mentionedUserId).toBe(alice.id)

    ws.close()
    await del(request, `/api/tasks/${task.id}`)
  })

  test('task:assigned fires on creation when assigneeUserId is set', async ({ request }) => {
    const author = await provision(request, 'd4p2_assign_author')
    const target = await provision(request, 'd4p2_assign_target')
    const ws = await openMeSocket(target)

    const taskRes = await request.post('/api/tasks', {
      headers: cf(author.email),
      data: {
        title: uniq('e2e-assign-create'),
        type: 'manual',
        assigneeUserId: target.id,
      },
    })
    const task = (await taskRes.json()) as { id: string }

    const evt = await ws.next(
      (m) => m.type === 'task:assigned' && (m.payload as { taskId?: string }).taskId === task.id,
      3000
    )
    expect((evt.payload as { assigneeUserId: string }).assigneeUserId).toBe(target.id)

    ws.close()
    await del(request, `/api/tasks/${task.id}`)
  })

  test('task:assigned on PATCH reaches both old and new assignees', async ({ request }) => {
    const author = await provision(request, 'd4p2_reassign_author')
    const a = await provision(request, 'd4p2_reassign_a')
    const b = await provision(request, 'd4p2_reassign_b')
    const wsA = await openMeSocket(a)
    const wsB = await openMeSocket(b)

    const taskRes = await request.post('/api/tasks', {
      headers: cf(author.email),
      data: { title: uniq('e2e-reassign'), type: 'manual', assigneeUserId: a.id },
    })
    const task = (await taskRes.json()) as { id: string }

    // Consume the initial 'assigned-to-a' event so we don't accidentally
    // match it as the reassign one.
    await wsA.next(
      (m) => m.type === 'task:assigned' && (m.payload as { taskId?: string }).taskId === task.id,
      3000
    )

    await request.patch(`/api/tasks/${task.id}`, {
      headers: cf(author.email),
      data: { assigneeUserId: b.id },
    })

    // a is the previous assignee, b is the new one. Both should receive
    // a task:assigned event with the same payload.
    const evtA = await wsA.next(
      (m) =>
        m.type === 'task:assigned' &&
        (m.payload as { taskId?: string }).taskId === task.id &&
        (m.payload as { assigneeUserId?: string | null }).assigneeUserId === b.id,
      3000
    )
    const evtB = await wsB.next(
      (m) =>
        m.type === 'task:assigned' &&
        (m.payload as { taskId?: string }).taskId === task.id,
      3000
    )
    expect((evtA.payload as { previousAssigneeUserId: string }).previousAssigneeUserId).toBe(a.id)
    expect((evtB.payload as { assigneeUserId: string }).assigneeUserId).toBe(b.id)

    wsA.close()
    wsB.close()
    await del(request, `/api/tasks/${task.id}`)
  })

  test('project:mentioned fires for project @mentions too', async ({ request }) => {
    const alice = await provision(request, 'd4p2_proj_mention')
    const ws = await openMeSocket(alice)

    const projectRes = await request.post('/api/projects', {
      headers: cf(alice.email),
      data: { name: uniq('e2e-proj-ws-mention'), description: `cc @${alice.email}` },
    })
    const project = (await projectRes.json()) as { id: string }

    const evt = await ws.next(
      (m) =>
        m.type === 'project:mentioned' &&
        (m.payload as { projectId?: string }).projectId === project.id,
      3000
    )
    expect((evt.payload as { mentionedUserId: string }).mentionedUserId).toBe(alice.id)

    ws.close()
    await del(request, `/api/projects/${project.id}`)
  })

  test('socket without `me` subscription does NOT receive the mention', async ({ request }) => {
    const alice = await provision(request, 'd4p2_neg_alice')
    // Connect alice's socket WITHOUT subscribing to `me`.
    const ws = new WsClient(wsUrl('/ws/terminal'), {
      headers: { 'Cf-Access-Authenticated-User-Email': alice.email },
    })
    await ws.opened
    // Subscribe to an unrelated topic so the socket isn't completely silent.
    ws.send({ type: 'subscribe', payload: { topics: ['project:nonexistent'] } })
    await ws.next((m) => m.type === 'subscription:ack', 3000)

    const taskRes = await request.post('/api/tasks', {
      headers: cf(alice.email),
      data: {
        title: uniq('e2e-mention-no-me'),
        type: 'manual',
        description: `cc @${alice.email}`,
      },
    })
    const task = (await taskRes.json()) as { id: string }

    // Wait long enough that the event WOULD have arrived if the dispatch
    // were buggy. Then assert nothing matched.
    await expect(
      ws.next(
        (m) =>
          m.type === 'task:mentioned' &&
          (m.payload as { taskId?: string }).taskId === task.id,
        1200
      )
    ).rejects.toThrow(/timeout/)

    ws.close()
    await del(request, `/api/tasks/${task.id}`)
  })
})
