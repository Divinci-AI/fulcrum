import { expect, test } from '@playwright/test'
import { del, getJson, patchJson, postJson, uniq } from '../_lib/api'

interface Project {
  id: string
  name: string
  description?: string | null
}

test.describe('projects API', () => {
  let createdId: string | undefined

  test.afterEach(async ({ request }) => {
    if (createdId) {
      await del(request, `/api/projects/${createdId}`)
      createdId = undefined
    }
  })

  test('GET /api/projects returns an array', async ({ request }) => {
    const list = await getJson<Project[]>(request, '/api/projects')
    expect(Array.isArray(list)).toBe(true)
  })

  test('CRUD: create → rename → delete', async ({ request }) => {
    const name = uniq('e2e-proj')
    const created = await postJson<Project>(request, '/api/projects', {
      name,
      description: 'created by e2e test',
    })
    createdId = created.id
    expect(created.name).toBe(name)

    const renamedName = `${name}-renamed`
    const renamed = await patchJson<Project>(request, `/api/projects/${created.id}`, {
      name: renamedName,
    })
    expect(renamed.name).toBe(renamedName)

    // Explicit delete in test body (instead of afterEach) so we verify the API works.
    await del(request, `/api/projects/${created.id}`)
    createdId = undefined
    const res = await request.get(`/api/projects/${created.id}`)
    expect(res.status()).toBe(404)
  })
})
