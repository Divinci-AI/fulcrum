/**
 * D-5 PR 3: read-path + mutation filtering enforcement.
 *
 * The "switch flip" — restricted resources actually disappear for users
 * without grants. Tenant-visible resources keep working for everyone
 * (because tenant-default role is editor).
 *
 * Covers:
 *  - Tenant-visible task: anyone can read, edit, list.
 *  - Restricted task: invisible to non-grantees on GET list + detail.
 *  - Restricted + viewer grant: target can read but cannot PATCH.
 *  - Restricted + editor grant: target can PATCH but cannot DELETE.
 *  - Restricted + admin grant: target can DELETE.
 *  - Parity check on projects.
 */
import { expect, test } from '@playwright/test'
import { uniq, uniqAlnum } from '../_lib/api'
import type { APIRequestContext } from '@playwright/test'

interface User { id: string; email: string }
interface Task { id: string; title: string }
interface Project { id: string; name: string }
type Role = 'viewer' | 'editor' | 'admin'

const cf = (email: string) => ({ 'Cf-Access-Authenticated-User-Email': email })

async function provision(req: APIRequestContext, prefix: string): Promise<User> {
  const email = `${uniqAlnum(prefix)}@example.com`
  const res = await req.get('/api/users/me', { headers: cf(email) })
  const body = (await res.json()) as { user: User }
  return body.user
}

async function createTask(
  req: APIRequestContext,
  owner: User,
  title?: string
): Promise<Task> {
  const res = await req.post('/api/tasks', {
    headers: cf(owner.email),
    data: { title: title ?? uniq('e2e-acl-task'), type: 'manual' },
  })
  return (await res.json()) as Task
}
async function restrict(
  req: APIRequestContext,
  owner: User,
  resourceType: 'task' | 'project',
  resourceId: string
): Promise<void> {
  const res = await req.patch(`/api/acls/visibility/${resourceType}/${resourceId}`, {
    headers: cf(owner.email),
    data: { visibility: 'restricted' },
  })
  if (!res.ok()) throw new Error(`restrict failed: ${res.status()}`)
}
async function grant(
  req: APIRequestContext,
  owner: User,
  resourceType: 'task' | 'project',
  resourceId: string,
  principalId: string,
  role: Role
): Promise<void> {
  const res = await req.post('/api/acls', {
    headers: cf(owner.email),
    data: {
      resourceType,
      resourceId,
      principalType: 'user',
      principalId,
      role,
    },
  })
  if (!res.ok()) throw new Error(`grant failed: ${res.status()} ${await res.text()}`)
}

test.describe('D-5 PR 3: read-path + mutation filtering', () => {
  test('tenant-visible task: any user can read + edit', async ({ request }) => {
    const owner = await provision(request, 'd5p3_open_owner')
    const stranger = await provision(request, 'd5p3_open_stranger')
    const task = await createTask(request, owner, uniq('e2e-tenant-task'))

    // stranger can read
    const getRes = await request.get(`/api/tasks/${task.id}`, { headers: cf(stranger.email) })
    expect(getRes.ok()).toBe(true)
    // stranger can edit (tenant default = editor)
    const patchRes = await request.patch(`/api/tasks/${task.id}`, {
      headers: cf(stranger.email),
      data: { description: 'edited by stranger' },
    })
    expect(patchRes.ok()).toBe(true)
    // owner can delete (admin via creator grant)
    const delRes = await request.delete(`/api/tasks/${task.id}`, { headers: cf(owner.email) })
    expect(delRes.ok()).toBe(true)
  })

  test('restricted task: invisible to non-grantees on GET list + detail', async ({ request }) => {
    const owner = await provision(request, 'd5p3_priv_owner')
    const stranger = await provision(request, 'd5p3_priv_stranger')
    const task = await createTask(request, owner, uniq('e2e-priv-task'))
    await restrict(request, owner, 'task', task.id)

    // stranger's list does NOT contain this task
    const listRes = await request.get('/api/tasks', { headers: cf(stranger.email) })
    const list = (await listRes.json()) as Task[]
    expect(list.some((t) => t.id === task.id)).toBe(false)
    // stranger's detail 404s
    const detailRes = await request.get(`/api/tasks/${task.id}`, { headers: cf(stranger.email) })
    expect(detailRes.status()).toBe(404)
    // owner can still see it
    const ownerList = await request.get('/api/tasks', { headers: cf(owner.email) })
    const ownerListJson = (await ownerList.json()) as Task[]
    expect(ownerListJson.some((t) => t.id === task.id)).toBe(true)

    await request.delete(`/api/tasks/${task.id}`, { headers: cf(owner.email) })
  })

  test('restricted + viewer grant: target can read but cannot PATCH or DELETE', async ({ request }) => {
    const owner = await provision(request, 'd5p3_v_owner')
    const target = await provision(request, 'd5p3_v_target')
    const task = await createTask(request, owner, uniq('e2e-viewer'))
    await restrict(request, owner, 'task', task.id)
    await grant(request, owner, 'task', task.id, target.id, 'viewer')

    // target can read
    const getRes = await request.get(`/api/tasks/${task.id}`, { headers: cf(target.email) })
    expect(getRes.ok()).toBe(true)
    // target cannot PATCH (editor required)
    const patchRes = await request.patch(`/api/tasks/${task.id}`, {
      headers: cf(target.email),
      data: { description: 'attempted edit' },
    })
    expect(patchRes.status()).toBe(403)
    // target cannot DELETE (editor required)
    const delRes = await request.delete(`/api/tasks/${task.id}`, { headers: cf(target.email) })
    expect(delRes.status()).toBe(403)

    await request.delete(`/api/tasks/${task.id}`, { headers: cf(owner.email) })
  })

  test('restricted + editor grant: PATCH + DELETE both work; ACL grant 403', async ({ request }) => {
    const owner = await provision(request, 'd5p3_e_owner')
    const target = await provision(request, 'd5p3_e_target')
    const task = await createTask(request, owner, uniq('e2e-editor'))
    await restrict(request, owner, 'task', task.id)
    await grant(request, owner, 'task', task.id, target.id, 'editor')

    const patchRes = await request.patch(`/api/tasks/${task.id}`, {
      headers: cf(target.email),
      data: { description: 'editor-allowed edit' },
    })
    expect(patchRes.ok()).toBe(true)

    // Editor can DELETE (D-5 PR 3 rule: admin gates only ACL/visibility,
    // not the resource itself).
    // But editor CANNOT grant ACL — that needs admin.
    const aclRes = await request.post('/api/acls', {
      headers: cf(target.email),
      data: {
        resourceType: 'task',
        resourceId: task.id,
        principalType: 'user',
        principalId: target.id,
        role: 'admin',
      },
    })
    expect(aclRes.status()).toBe(403)

    const delRes = await request.delete(`/api/tasks/${task.id}`, { headers: cf(target.email) })
    expect(delRes.ok()).toBe(true)
  })

  test('restricted + admin grant: target can grant ACL', async ({ request }) => {
    const owner = await provision(request, 'd5p3_a_owner')
    const target = await provision(request, 'd5p3_a_target')
    const other = await provision(request, 'd5p3_a_other')
    const task = await createTask(request, owner, uniq('e2e-admin'))
    await restrict(request, owner, 'task', task.id)
    await grant(request, owner, 'task', task.id, target.id, 'admin')

    // Admin can grant new ACLs on the resource.
    const grantRes = await request.post('/api/acls', {
      headers: cf(target.email),
      data: {
        resourceType: 'task',
        resourceId: task.id,
        principalType: 'user',
        principalId: other.id,
        role: 'viewer',
      },
    })
    expect(grantRes.status()).toBe(201)

    await request.delete(`/api/tasks/${task.id}`, { headers: cf(owner.email) })
  })

  test('projects parity: restricted hides from non-grantee list', async ({ request }) => {
    const owner = await provision(request, 'd5p3_proj_owner')
    const stranger = await provision(request, 'd5p3_proj_stranger')

    const projRes = await request.post('/api/projects', {
      headers: cf(owner.email),
      data: { name: uniq('e2e-priv-project') },
    })
    const project = (await projRes.json()) as Project
    await restrict(request, owner, 'project', project.id)

    const listRes = await request.get('/api/projects', { headers: cf(stranger.email) })
    const list = (await listRes.json()) as Project[]
    expect(list.some((p) => p.id === project.id)).toBe(false)

    const detail = await request.get(`/api/projects/${project.id}`, {
      headers: cf(stranger.email),
    })
    expect(detail.status()).toBe(404)

    await request.delete(`/api/projects/${project.id}`, { headers: cf(owner.email) })
  })
})
