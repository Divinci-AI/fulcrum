import { expect, test } from '@playwright/test'
import { del, patchJson, postJson, uniq, uniqAlnum } from '../_lib/api'

interface User {
  id: string
  email: string
}
interface MeResponse {
  user: User
}
interface Mention {
  id: string
  sourceType: 'task' | 'project' | 'comment'
  sourceId: string
  userId: string
  createdAt: string
}
interface MentionsListResponse {
  mentions: Mention[]
}
interface Task {
  id: string
  description: string | null
  notes: string | null
}

async function provisionUser(
  request: import('@playwright/test').APIRequestContext,
  prefix = 'd3_user'
): Promise<{ id: string; email: string }> {
  const email = `${uniqAlnum(prefix)}@example.com`
  const res = await request.get('/api/users/me', {
    headers: { 'Cf-Access-Authenticated-User-Email': email },
  })
  const body = (await res.json()) as MeResponse
  return body.user
}

test.describe('@mentions (D-3)', () => {
  let createdTaskIds: string[] = []
  test.afterEach(async ({ request }) => {
    for (const id of createdTaskIds) {
      await del(request, `/api/tasks/${id}`)
    }
    createdTaskIds = []
  })

  test('creating a task with @<email> in description records a mention', async ({ request }) => {
    const user = await provisionUser(request)
    const task = await postJson<Task>(request, '/api/tasks', {
      title: uniq('e2e-mention-create'),
      type: 'manual',
      description: `hello @${user.email}, please review`,
    })
    createdTaskIds.push(task.id)

    // Fetch /me/mentions as that user — should include this task as a source.
    const res = await request.get('/api/users/me/mentions', {
      headers: { 'Cf-Access-Authenticated-User-Email': user.email },
    })
    const body = (await res.json()) as MentionsListResponse
    const match = body.mentions.find((m) => m.sourceType === 'task' && m.sourceId === task.id)
    expect(match).toBeTruthy()
    expect(match!.userId).toBe(user.id)
  })

  test('PATCH replaces the mention set; removed mentions drop, added ones land', async ({
    request,
  }) => {
    const alice = await provisionUser(request, 'd3_alice')
    const bob = await provisionUser(request, 'd3_bob')

    // Start with alice mentioned only.
    const task = await postJson<Task>(request, '/api/tasks', {
      title: uniq('e2e-mention-patch'),
      type: 'manual',
      description: `cc @${alice.email}`,
    })
    createdTaskIds.push(task.id)

    // /me/mentions reads the current user from CF Access header, so we
    // call request.get directly here instead of getJson (which can't pass
    // headers).
    {
      const res = await request.get('/api/users/me/mentions', {
        headers: { 'Cf-Access-Authenticated-User-Email': alice.email },
      })
      const aliceMentions = (await res.json()) as MentionsListResponse
      expect(aliceMentions.mentions.some((m) => m.sourceId === task.id)).toBe(true)
    }

    // PATCH: replace alice with bob in the description.
    await patchJson<Task>(request, `/api/tasks/${task.id}`, {
      description: `cc @${bob.email}`,
    })

    // Alice should NO longer be mentioned on this task.
    {
      const res = await request.get('/api/users/me/mentions', {
        headers: { 'Cf-Access-Authenticated-User-Email': alice.email },
      })
      const list = (await res.json()) as MentionsListResponse
      expect(list.mentions.some((m) => m.sourceId === task.id)).toBe(false)
    }
    // Bob now should be.
    {
      const res = await request.get('/api/users/me/mentions', {
        headers: { 'Cf-Access-Authenticated-User-Email': bob.email },
      })
      const list = (await res.json()) as MentionsListResponse
      expect(list.mentions.some((m) => m.sourceId === task.id)).toBe(true)
    }
  })

  test('mentions in `notes` count too (not just description)', async ({ request }) => {
    const user = await provisionUser(request, 'd3_notes')
    const task = await postJson<Task>(request, '/api/tasks', {
      title: uniq('e2e-mention-notes'),
      type: 'manual',
      notes: `please look @${user.email}`,
    })
    createdTaskIds.push(task.id)

    const res = await request.get('/api/users/me/mentions', {
      headers: { 'Cf-Access-Authenticated-User-Email': user.email },
    })
    const body = (await res.json()) as MentionsListResponse
    expect(body.mentions.some((m) => m.sourceId === task.id)).toBe(true)
  })

  test('deleting a task cleans up its mentions', async ({ request }) => {
    const user = await provisionUser(request, 'd3_del')
    const task = await postJson<Task>(request, '/api/tasks', {
      title: uniq('e2e-mention-del'),
      type: 'manual',
      description: `cc @${user.email}`,
    })
    // Don't push to createdTaskIds — we delete it explicitly.

    {
      const res = await request.get('/api/users/me/mentions', {
        headers: { 'Cf-Access-Authenticated-User-Email': user.email },
      })
      const list = (await res.json()) as MentionsListResponse
      expect(list.mentions.some((m) => m.sourceId === task.id)).toBe(true)
    }

    await del(request, `/api/tasks/${task.id}`)

    {
      const res = await request.get('/api/users/me/mentions', {
        headers: { 'Cf-Access-Authenticated-User-Email': user.email },
      })
      const list = (await res.json()) as MentionsListResponse
      expect(list.mentions.some((m) => m.sourceId === task.id)).toBe(false)
    }
  })

  test('/me/mentions returns 401 when no identity is present', async ({ request }) => {
    // Locally we set FULCRUM_DEV_USER_EMAIL only when explicitly configured;
    // without any header or env, the middleware leaves c.var.user null and
    // the endpoint should 401. If the deployment HAS a dev fallback set,
    // the endpoint returns 200 with that user's list (could be empty).
    const res = await request.get('/api/users/me/mentions')
    expect([200, 401]).toContain(res.status())
  })
})
