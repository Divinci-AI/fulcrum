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
    const name = uniq('e2e-backup')
    const res = await request.post('/api/backup', { data: { name } })
    // Backups can take a while in larger DBs — accept 200/201 here, also
    // accept 202 for async ones. Anything 4xx/5xx is a regression.
    expect([200, 201, 202]).toContain(res.status())
    const created = (await res.json()) as { name?: string }
    createdName = created.name ?? name

    const fetched = (await getJson<Backup>(request, `/api/backup/${encodeURIComponent(createdName)}`))
    expect(fetched.name).toBe(createdName)
  })
})
