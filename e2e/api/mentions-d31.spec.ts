/**
 * D-3.1 mention coverage:
 *  - Projects accept `@<email>` mentions in description/notes.
 *  - `@displayName` resolves to a user when it's unambiguous.
 *  - PATCH /api/users/me sets displayName for the current user.
 *
 * Lives in its own spec file alongside e2e/api/mentions.spec.ts so the
 * original task-mention suite stays focused on task behavior.
 */
import { expect, test } from '@playwright/test'
import { del, patchJson, postJson, uniq, uniqAlnum } from '../_lib/api'

interface User {
  id: string
  email: string
  displayName: string | null
}
interface MeResponse {
  user: User
}
interface Project {
  id: string
  name: string
  description: string | null
  notes: string | null
}
interface Mention {
  id: string
  sourceType: 'task' | 'project' | 'comment'
  sourceId: string
  userId: string
}
interface MentionsListResponse {
  mentions: Mention[]
}
interface Task {
  id: string
  description: string | null
}

async function provisionUser(
  request: import('@playwright/test').APIRequestContext,
  prefix = 'd31_user'
): Promise<User> {
  const email = `${uniqAlnum(prefix)}@example.com`
  const res = await request.get('/api/users/me', {
    headers: { 'Cf-Access-Authenticated-User-Email': email },
  })
  const body = (await res.json()) as MeResponse
  return body.user
}

async function setDisplayName(
  request: import('@playwright/test').APIRequestContext,
  email: string,
  displayName: string | null
): Promise<User> {
  const res = await request.patch('/api/users/me', {
    headers: { 'Cf-Access-Authenticated-User-Email': email },
    data: { displayName },
  })
  if (!res.ok()) {
    throw new Error(`PATCH /api/users/me → ${res.status()}: ${await res.text()}`)
  }
  const body = (await res.json()) as MeResponse
  return body.user
}

async function listMentions(
  request: import('@playwright/test').APIRequestContext,
  email: string
): Promise<Mention[]> {
  const res = await request.get('/api/users/me/mentions', {
    headers: { 'Cf-Access-Authenticated-User-Email': email },
  })
  const body = (await res.json()) as MentionsListResponse
  return body.mentions
}

test.describe('@mentions on projects (D-3.1)', () => {
  let createdProjectIds: string[] = []
  let createdTaskIds: string[] = []
  test.afterEach(async ({ request }) => {
    for (const id of createdTaskIds) await del(request, `/api/tasks/${id}`)
    createdTaskIds = []
    for (const id of createdProjectIds) await del(request, `/api/projects/${id}`)
    createdProjectIds = []
  })

  test('creating a project with @<email> in description records a mention', async ({
    request,
  }) => {
    const user = await provisionUser(request, 'd31_proj_create')
    const project = await postJson<Project>(request, '/api/projects', {
      name: uniq('e2e-proj-mention'),
      description: `kick-off @${user.email}, please review`,
    })
    createdProjectIds.push(project.id)

    const mentions = await listMentions(request, user.email)
    const match = mentions.find((m) => m.sourceType === 'project' && m.sourceId === project.id)
    expect(match).toBeTruthy()
    expect(match!.userId).toBe(user.id)
  })

  test('PATCH on a project replaces the project mention set', async ({ request }) => {
    const alice = await provisionUser(request, 'd31_palice')
    const bob = await provisionUser(request, 'd31_pbob')

    const project = await postJson<Project>(request, '/api/projects', {
      name: uniq('e2e-proj-mention-patch'),
      description: `cc @${alice.email}`,
    })
    createdProjectIds.push(project.id)

    // alice mentioned initially
    expect(
      (await listMentions(request, alice.email)).some((m) => m.sourceId === project.id)
    ).toBe(true)

    await patchJson<Project>(request, `/api/projects/${project.id}`, {
      description: `cc @${bob.email}`,
    })

    // alice now removed, bob added
    expect(
      (await listMentions(request, alice.email)).some((m) => m.sourceId === project.id)
    ).toBe(false)
    expect(
      (await listMentions(request, bob.email)).some((m) => m.sourceId === project.id)
    ).toBe(true)
  })

  test('mentions in project notes count too (not just description)', async ({ request }) => {
    const user = await provisionUser(request, 'd31_pnotes')
    const project = await postJson<Project>(request, '/api/projects', {
      name: uniq('e2e-proj-notes'),
      notes: `please look @${user.email}`,
    })
    createdProjectIds.push(project.id)

    expect(
      (await listMentions(request, user.email)).some((m) => m.sourceId === project.id)
    ).toBe(true)
  })

  test('deleting a project cleans up its mentions', async ({ request }) => {
    const user = await provisionUser(request, 'd31_pdel')
    const project = await postJson<Project>(request, '/api/projects', {
      name: uniq('e2e-proj-del'),
      description: `cc @${user.email}`,
    })
    // Don't push to createdProjectIds — we delete explicitly.

    expect(
      (await listMentions(request, user.email)).some((m) => m.sourceId === project.id)
    ).toBe(true)

    await del(request, `/api/projects/${project.id}`)

    expect(
      (await listMentions(request, user.email)).some((m) => m.sourceId === project.id)
    ).toBe(false)
  })
})

test.describe('@displayName mentions (D-3.1)', () => {
  let createdTaskIds: string[] = []
  test.afterEach(async ({ request }) => {
    for (const id of createdTaskIds) await del(request, `/api/tasks/${id}`)
    createdTaskIds = []
  })

  test('a unique @displayName resolves to that user', async ({ request }) => {
    const user = await provisionUser(request, 'd31_nameok')
    // Generate a guaranteed-unique display name so this test doesn't collide
    // with any user already in the deployed container's DB.
    const handle = uniqAlnum('zorblax')
    await setDisplayName(request, user.email, handle)

    const task = await postJson<Task>(request, '/api/tasks', {
      title: uniq('e2e-mention-displayname'),
      type: 'manual',
      description: `hey @${handle}, ping`,
    })
    createdTaskIds.push(task.id)

    const mentions = await listMentions(request, user.email)
    expect(mentions.some((m) => m.sourceId === task.id)).toBe(true)
  })

  test('an ambiguous @displayName silently no-ops (no mention recorded)', async ({
    request,
  }) => {
    // Two users with the same display name — the parser should refuse to
    // pick one. Neither user should get a mention from `@duplicateName`.
    const shared = uniqAlnum('twinhandle')
    const alice = await provisionUser(request, 'd31_twin_a')
    const bob = await provisionUser(request, 'd31_twin_b')
    await setDisplayName(request, alice.email, shared)
    await setDisplayName(request, bob.email, shared)

    const task = await postJson<Task>(request, '/api/tasks', {
      title: uniq('e2e-mention-ambiguous'),
      type: 'manual',
      description: `hey @${shared}, who are you?`,
    })
    createdTaskIds.push(task.id)

    const aliceMentions = await listMentions(request, alice.email)
    const bobMentions = await listMentions(request, bob.email)
    expect(aliceMentions.some((m) => m.sourceId === task.id)).toBe(false)
    expect(bobMentions.some((m) => m.sourceId === task.id)).toBe(false)
  })

  test('@email and @displayName can both appear in the same body', async ({ request }) => {
    const alice = await provisionUser(request, 'd31_mixed_a')
    const bob = await provisionUser(request, 'd31_mixed_b')
    const bobName = uniqAlnum('bobbyhandle')
    await setDisplayName(request, bob.email, bobName)

    const task = await postJson<Task>(request, '/api/tasks', {
      title: uniq('e2e-mention-mixed'),
      type: 'manual',
      description: `team meeting @${alice.email} and @${bobName} fyi`,
    })
    createdTaskIds.push(task.id)

    expect(
      (await listMentions(request, alice.email)).some((m) => m.sourceId === task.id)
    ).toBe(true)
    expect(
      (await listMentions(request, bob.email)).some((m) => m.sourceId === task.id)
    ).toBe(true)
  })
})

test.describe('PATCH /api/users/me (D-3.1)', () => {
  test('sets a displayName and persists it for subsequent /me reads', async ({ request }) => {
    const user = await provisionUser(request, 'd31_patch')
    const name = uniqAlnum('NewName')
    const updated = await setDisplayName(request, user.email, name)
    expect(updated.displayName).toBe(name)

    // Read back via /me and confirm it stuck.
    const res = await request.get('/api/users/me', {
      headers: { 'Cf-Access-Authenticated-User-Email': user.email },
    })
    const body = (await res.json()) as MeResponse
    expect(body.user.displayName).toBe(name)
  })

  test('trims whitespace and clears with empty string', async ({ request }) => {
    const user = await provisionUser(request, 'd31_clear')
    const name = uniqAlnum('Trimmed')
    const padded = `  ${name}  `

    const set = await setDisplayName(request, user.email, padded)
    expect(set.displayName).toBe(name) // trimmed

    const cleared = await setDisplayName(request, user.email, '')
    expect(cleared.displayName).toBeNull()
  })

  test('401 without any current user', async ({ request }) => {
    // No CF Access header. If the deployment has FULCRUM_DEV_USER_EMAIL set
    // the middleware will still find a user — accept either 200 or 401.
    const res = await request.patch('/api/users/me', { data: { displayName: 'x' } })
    expect([200, 401]).toContain(res.status())
  })
})
