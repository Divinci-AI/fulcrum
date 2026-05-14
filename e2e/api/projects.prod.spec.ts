/**
 * Single-user project CRUD round-trip — prod-safe.
 * Mirror of tasks.prod.spec.ts at the project surface.
 */
import { expect, test } from '@playwright/test'
import { del, getJson, postJson, uniq } from '../_lib/api'

interface Project {
  id: string
  name: string
  description: string | null
  notes: string | null
}

const createdProjectIds: string[] = []

test.afterAll(async ({ request }) => {
  for (const id of createdProjectIds) {
    await del(request, `/api/projects/${id}`)
  }
})

test('POST + GET round-trip persists description + notes', async ({ request }) => {
  const payload = {
    name: uniq('prod-rt-project'),
    description: 'prod proj desc',
    notes: 'prod proj notes',
  }
  const project = await postJson<Project>(request, '/api/projects', payload)
  createdProjectIds.push(project.id)

  const fetched = await getJson<Project>(request, `/api/projects/${project.id}`)
  expect(fetched.name).toBe(payload.name)
  expect(fetched.description).toBe(payload.description)
  expect(fetched.notes).toBe(payload.notes)
})

test('GET /api/projects includes the just-created project', async ({ request }) => {
  const project = await postJson<Project>(request, '/api/projects', {
    name: uniq('prod-list-project'),
  })
  createdProjectIds.push(project.id)

  const list = await getJson<Project[]>(request, '/api/projects')
  expect(list.some((p) => p.id === project.id)).toBe(true)
})
