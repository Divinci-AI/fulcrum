/**
 * D-5 PR 2: teams + ACL + visibility CRUD.
 *
 * Coverage:
 *  - Teams CRUD + membership
 *  - ACL grant / list / patch / revoke
 *  - Visibility flip
 *  - Creator-gets-admin grant on POST /api/tasks + POST /api/projects
 *  - Admin gating: non-admin caller gets 403 on grant / visibility flip
 *
 * Read-path filtering (the "switch flip" that makes restricted resources
 * actually invisible to non-grantees) lands in D-5 PR 3.
 */
import { expect, test } from '@playwright/test'
import { del, postJson, uniq, uniqAlnum } from '../_lib/api'
import type { APIRequestContext } from '@playwright/test'

interface User {
  id: string
  email: string
  displayName: string | null
}
interface Team {
  id: string
  name: string
  description: string | null
}
interface Grant {
  id: string
  resourceType: 'task' | 'project'
  resourceId: string
  principalType: 'user' | 'team'
  principalId: string
  role: 'viewer' | 'editor' | 'admin'
}
interface Task {
  id: string
  title: string
}
interface Project {
  id: string
  name: string
}

const cf = (email: string) => ({ 'Cf-Access-Authenticated-User-Email': email })

async function provisionUser(request: APIRequestContext, prefix: string): Promise<User> {
  const email = `${uniqAlnum(prefix)}@example.com`
  const res = await request.get('/api/users/me', { headers: cf(email) })
  const body = (await res.json()) as { user: User }
  return body.user
}

async function listGrants(
  request: APIRequestContext,
  email: string,
  resourceType: string,
  resourceId: string
): Promise<Grant[]> {
  const res = await request.get(
    `/api/acls?resourceType=${resourceType}&resourceId=${resourceId}`,
    { headers: cf(email) }
  )
  const body = (await res.json()) as { acls: Grant[] }
  return body.acls
}

test.describe('teams API (D-5)', () => {
  test('CRUD: create → get → patch → delete', async ({ request }) => {
    const owner = await provisionUser(request, 'd5_team_owner')
    const name = uniq('e2e-team')

    const create = await request.post('/api/teams', {
      headers: cf(owner.email),
      data: { name, description: 'first team' },
    })
    expect(create.status()).toBe(201)
    const team = (await create.json()) as Team
    expect(team.name).toBe(name)

    const get = await request.get(`/api/teams/${team.id}`, { headers: cf(owner.email) })
    const detail = (await get.json()) as { team: Team; members: { user: User; role: string }[] }
    expect(detail.team.id).toBe(team.id)
    // Creator was auto-added as admin.
    expect(detail.members.find((m) => m.user.id === owner.id)?.role).toBe('admin')

    const patch = await request.patch(`/api/teams/${team.id}`, {
      headers: cf(owner.email),
      data: { description: 'renamed' },
    })
    expect(patch.ok()).toBe(true)
    const renamed = (await patch.json()) as Team
    expect(renamed.description).toBe('renamed')

    const ok = await request.delete(`/api/teams/${team.id}`, { headers: cf(owner.email) })
    expect(ok.ok()).toBe(true)
  })

  test('non-admin cannot rename or delete the team', async ({ request }) => {
    const owner = await provisionUser(request, 'd5_team_owner2')
    const stranger = await provisionUser(request, 'd5_stranger')
    const team = await postJson<Team>(
      '/api/teams' as never,
      { headers: cf(owner.email), data: { name: uniq('e2e-team-guarded') } } as never
    ).catch(async () => {
      // postJson can't take headers — fall back to request.post directly.
      const res = await request.post('/api/teams', {
        headers: cf(owner.email),
        data: { name: uniq('e2e-team-guarded') },
      })
      return (await res.json()) as Team
    })

    const patch = await request.patch(`/api/teams/${team.id}`, {
      headers: cf(stranger.email),
      data: { description: 'sneaky' },
    })
    expect(patch.status()).toBe(403)
    const del2 = await request.delete(`/api/teams/${team.id}`, {
      headers: cf(stranger.email),
    })
    expect(del2.status()).toBe(403)

    await request.delete(`/api/teams/${team.id}`, { headers: cf(owner.email) })
  })

  test('add + remove member', async ({ request }) => {
    const owner = await provisionUser(request, 'd5_team_mem_owner')
    const member = await provisionUser(request, 'd5_team_mem_member')

    const teamRes = await request.post('/api/teams', {
      headers: cf(owner.email),
      data: { name: uniq('e2e-team-mem') },
    })
    const team = (await teamRes.json()) as Team

    const add = await request.post(`/api/teams/${team.id}/members`, {
      headers: cf(owner.email),
      data: { userId: member.id, role: 'member' },
    })
    expect(add.status()).toBe(201)

    const get = await request.get(`/api/teams/${team.id}`, { headers: cf(owner.email) })
    const detail = (await get.json()) as { members: { user: User }[] }
    expect(detail.members.some((m) => m.user.id === member.id)).toBe(true)

    const rm = await request.delete(`/api/teams/${team.id}/members/${member.id}`, {
      headers: cf(owner.email),
    })
    expect(rm.ok()).toBe(true)

    await request.delete(`/api/teams/${team.id}`, { headers: cf(owner.email) })
  })
})

test.describe('ACL grants (D-5)', () => {
  test('creator of a task gets an admin grant automatically', async ({ request }) => {
    const owner = await provisionUser(request, 'd5_creator')
    const taskRes = await request.post('/api/tasks', {
      headers: cf(owner.email),
      data: { title: uniq('e2e-task-creator-admin'), type: 'manual' },
    })
    const task = (await taskRes.json()) as Task

    const grants = await listGrants(request, owner.email, 'task', task.id)
    const adminGrant = grants.find(
      (g) => g.principalType === 'user' && g.principalId === owner.id && g.role === 'admin'
    )
    expect(adminGrant).toBeTruthy()

    await del(request, `/api/tasks/${task.id}`)
  })

  test('admin can grant viewer to another user; that user can list grants', async ({
    request,
  }) => {
    const owner = await provisionUser(request, 'd5_grantor')
    const target = await provisionUser(request, 'd5_grantee')

    const taskRes = await request.post('/api/tasks', {
      headers: cf(owner.email),
      data: { title: uniq('e2e-task-grant'), type: 'manual' },
    })
    const task = (await taskRes.json()) as Task

    const grant = await request.post('/api/acls', {
      headers: cf(owner.email),
      data: {
        resourceType: 'task',
        resourceId: task.id,
        principalType: 'user',
        principalId: target.id,
        role: 'viewer',
      },
    })
    expect(grant.status()).toBe(201)

    // Target can read the ACL listing (they have viewer access).
    const grants = await listGrants(request, target.email, 'task', task.id)
    expect(
      grants.some((g) => g.principalId === target.id && g.role === 'viewer')
    ).toBe(true)

    await del(request, `/api/tasks/${task.id}`)
  })

  test('non-admin cannot grant; admin can patch + revoke', async ({ request }) => {
    const owner = await provisionUser(request, 'd5_acl_admin')
    const stranger = await provisionUser(request, 'd5_acl_outsider')
    const taskRes = await request.post('/api/tasks', {
      headers: cf(owner.email),
      data: { title: uniq('e2e-task-acl-guarded'), type: 'manual' },
    })
    const task = (await taskRes.json()) as Task

    // stranger doesn't have admin → can't grant.
    const denied = await request.post('/api/acls', {
      headers: cf(stranger.email),
      data: {
        resourceType: 'task',
        resourceId: task.id,
        principalType: 'user',
        principalId: stranger.id,
        role: 'admin',
      },
    })
    expect(denied.status()).toBe(403)

    // owner grants viewer, then promotes to editor, then revokes.
    const grantRes = await request.post('/api/acls', {
      headers: cf(owner.email),
      data: {
        resourceType: 'task',
        resourceId: task.id,
        principalType: 'user',
        principalId: stranger.id,
        role: 'viewer',
      },
    })
    const g = (await grantRes.json()) as Grant

    const promote = await request.patch(`/api/acls/${g.id}`, {
      headers: cf(owner.email),
      data: { role: 'editor' },
    })
    expect(promote.ok()).toBe(true)
    expect((await promote.json()).role).toBe('editor')

    const revoke = await request.delete(`/api/acls/${g.id}`, { headers: cf(owner.email) })
    expect(revoke.ok()).toBe(true)

    await del(request, `/api/tasks/${task.id}`)
  })

  test('visibility flip requires admin and persists', async ({ request }) => {
    const owner = await provisionUser(request, 'd5_vis_admin')
    const stranger = await provisionUser(request, 'd5_vis_outsider')
    const taskRes = await request.post('/api/tasks', {
      headers: cf(owner.email),
      data: { title: uniq('e2e-task-vis'), type: 'manual' },
    })
    const task = (await taskRes.json()) as Task

    // stranger denied.
    const denied = await request.patch(
      `/api/acls/visibility/task/${task.id}`,
      { headers: cf(stranger.email), data: { visibility: 'restricted' } }
    )
    expect(denied.status()).toBe(403)

    // owner flips it.
    const flip = await request.patch(
      `/api/acls/visibility/task/${task.id}`,
      { headers: cf(owner.email), data: { visibility: 'restricted' } }
    )
    expect(flip.ok()).toBe(true)
    expect((await flip.json()).visibility).toBe('restricted')

    // Verify on the task row directly. Owner must pass their header now
    // that the task is restricted — without it the read-path filter (PR 3)
    // would 404 even on a real existing resource.
    const verifyRes = await request.get(`/api/tasks/${task.id}`, {
      headers: cf(owner.email),
    })
    const t = (await verifyRes.json()) as Task & { visibility: string }
    expect(t.visibility).toBe('restricted')

    await request.delete(`/api/tasks/${task.id}`, { headers: cf(owner.email) })
  })

  test('project creator gets admin too (parity check)', async ({ request }) => {
    const owner = await provisionUser(request, 'd5_proj_creator')
    const res = await request.post('/api/projects', {
      headers: cf(owner.email),
      data: { name: uniq('e2e-proj-creator-admin') },
    })
    const project = (await res.json()) as Project
    const grants = await listGrants(request, owner.email, 'project', project.id)
    expect(
      grants.some(
        (g) => g.principalType === 'user' && g.principalId === owner.id && g.role === 'admin'
      )
    ).toBe(true)

    await del(request, `/api/projects/${project.id}`)
  })
})
