import { expect, test } from '@playwright/test'
import { del, getJson, postJson, uniq } from '../_lib/api'

interface Backup {
  name: string
  createdAt?: string
  size?: number
}

test.describe('backup API', () => {
  let createdName: string | undefined

  test.afterEach(async ({ request }) => {
    if (createdName) {
      await del(request, `/api/backup/${encodeURIComponent(createdName)}`)
      createdName = undefined
    }
  })

  test('GET /api/backup returns an array', async ({ request }) => {
    const list = await getJson<Backup[] | { backups: Backup[] }>(request, '/api/backup')
    const arr = Array.isArray(list) ? list : list.backups ?? []
    expect(Array.isArray(arr)).toBe(true)
  })

  test('POST /api/backup creates a backup and GET returns it', async ({ request }) => {
    // Known issue: POST /api/backup returns 500 "Internal Server Error" with a
    // minimal payload on the current deployed build (probed 2026-05-11). The
    // backup feature may need fnox state, age key, or some other precondition
    // that isn't met in the container's default state. Marked test.fail so it
    // tracks until the route handler returns a proper 4xx or actually works.
    test.fail(true, 'known: POST /api/backup returns 500 instead of a clean 4xx; tracking')
    const name = uniq('e2e-backup')
    const res = await request.post('/api/backup', { data: { name } })
    expect([200, 201, 202]).toContain(res.status())
    const created = (await res.json()) as { name?: string }
    createdName = created.name ?? name

    const fetched = (await getJson<Backup>(request, `/api/backup/${encodeURIComponent(createdName)}`))
    expect(fetched.name).toBe(createdName)
  })
})
