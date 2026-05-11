/**
 * D-3.2 safeguard: PATCH calls that do NOT touch description / notes
 * must NOT re-parse mentions and therefore must NOT drop a mention
 * whose displayName-matched user has since changed their name.
 *
 * The pathology this prevents: alice gets mentioned via `@alice`,
 * alice changes her displayName to `alice2`, someone PATCHes the
 * task to change its title only — and the old code re-parsed the
 * text, found no user matching `@alice`, and silently dropped the
 * mention.
 */
import { expect, test } from '@playwright/test'
import { del, patchJson, postJson, uniq, uniqAlnum } from '../_lib/api'

interface User { id: string; email: string; displayName: string | null }
interface MeResponse { user: User }
interface Mention { sourceType: string; sourceId: string; userId: string }
interface MentionsListResponse { mentions: Mention[] }
interface Task { id: string; title: string; description: string | null }

async function provision(
  request: import('@playwright/test').APIRequestContext,
  prefix: string,
  displayName: string
): Promise<User> {
  const email = `${uniqAlnum(prefix)}@example.com`
  await request.get('/api/users/me', {
    headers: { 'Cf-Access-Authenticated-User-Email': email },
  })
  const res = await request.patch('/api/users/me', {
    headers: { 'Cf-Access-Authenticated-User-Email': email },
    data: { displayName },
  })
  const body = (await res.json()) as MeResponse
  return body.user
}

async function setDisplayName(
  request: import('@playwright/test').APIRequestContext,
  email: string,
  displayName: string
): Promise<void> {
  await request.patch('/api/users/me', {
    headers: { 'Cf-Access-Authenticated-User-Email': email },
    data: { displayName },
  })
}

async function hasMention(
  request: import('@playwright/test').APIRequestContext,
  email: string,
  sourceId: string
): Promise<boolean> {
  const res = await request.get('/api/users/me/mentions', {
    headers: { 'Cf-Access-Authenticated-User-Email': email },
  })
  const body = (await res.json()) as MentionsListResponse
  return body.mentions.some((m) => m.sourceId === sourceId)
}

test.describe('D-3.2: rename does not retroactively drop @displayName mentions', () => {
  const createdTasks: string[] = []
  test.afterEach(async ({ request }) => {
    for (const id of createdTasks) await del(request, `/api/tasks/${id}`)
    createdTasks.length = 0
  })

  test('PATCH that only changes title preserves the existing mention even after the user renamed', async ({
    request,
  }) => {
    const originalName = uniqAlnum('aliceish')
    const alice = await provision(request, 'd32_rename', originalName)

    // Mention via display name. Recorded in mentions table keyed by alice.id.
    const task = await postJson<Task>(request, '/api/tasks', {
      title: uniq('e2e-rename-task'),
      type: 'manual',
      description: `please review @${originalName}`,
    })
    createdTasks.push(task.id)

    expect(await hasMention(request, alice.email, task.id)).toBe(true)

    // Alice renames herself.
    const newName = uniqAlnum('alice2')
    await setDisplayName(request, alice.email, newName)

    // Someone PATCHes the task — but ONLY the title, not description/notes.
    await patchJson<Task>(request, `/api/tasks/${task.id}`, {
      title: uniq('e2e-rename-task-renamed'),
    })

    // The mention should still be there. Old buggy behavior: re-parse on
    // every PATCH found no match for `@${originalName}` and removed the row.
    expect(await hasMention(request, alice.email, task.id)).toBe(true)
  })

  test('PATCH that DOES touch description still re-syncs (no regression)', async ({
    request,
  }) => {
    const handle = uniqAlnum('charlieish')
    const charlie = await provision(request, 'd32_resync', handle)

    const task = await postJson<Task>(request, '/api/tasks', {
      title: uniq('e2e-resync-task'),
      type: 'manual',
      description: `cc @${handle}`,
    })
    createdTasks.push(task.id)

    expect(await hasMention(request, charlie.email, task.id)).toBe(true)

    // PATCH clears the mention by replacing the description.
    await patchJson<Task>(request, `/api/tasks/${task.id}`, {
      description: 'no mentions in this revision',
    })

    expect(await hasMention(request, charlie.email, task.id)).toBe(false)
  })
})
