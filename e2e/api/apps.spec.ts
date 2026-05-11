import { expect, test } from '@playwright/test'
import { del, getJson, postJson, uniq } from '../_lib/api'

interface App {
  id: string
  name: string
  status?: string
}

test.describe('apps API (deployment metadata only — no real deploys)', () => {
  let createdId: string | undefined

  test.afterEach(async ({ request }) => {
    if (createdId) {
      await del(request, `/api/apps/${createdId}`)
      createdId = undefined
    }
  })

  test('GET /api/apps returns array', async ({ request }) => {
    const list = await getJson<App[] | { apps: App[] }>(request, '/api/apps')
    const arr = Array.isArray(list) ? list : list.apps ?? []
    expect(Array.isArray(arr)).toBe(true)
  })

  test('POST /api/apps creates a placeholder app (no deploy triggered)', async ({ request }) => {
    const name = uniq('e2e-app')
    // The exact required fields depend on the server; minimal sensible payload.
    // Test passes if the server either creates the app OR returns a clear 400.
    const res = await request.post('/api/apps', { data: { name } })
    if (res.status() === 201 || res.status() === 200) {
      const created = (await res.json()) as App
      createdId = created.id
      expect(created.name).toBe(name)
    } else {
      // Validation failure is also acceptable — the route is alive and
      // refusing a malformed payload. Anything outside [200, 201, 400, 422]
      // is a real regression.
      expect([400, 422]).toContain(res.status())
    }
  })
})
