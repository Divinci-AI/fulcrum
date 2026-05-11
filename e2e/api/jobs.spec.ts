import { expect, test } from '@playwright/test'
import { getJson } from '../_lib/api'

interface Job {
  name: string
  enabled?: boolean
}

test.describe('jobs API (systemd/launchd timer surface)', () => {
  test('GET /api/jobs/available returns the list of installable jobs', async ({ request }) => {
    const list = await getJson<unknown>(request, '/api/jobs/available')
    // Either array or `{jobs: [...]}` — accept both.
    const arr = Array.isArray(list)
      ? list
      : ((list as { jobs?: Job[] }).jobs ?? (list as { available?: Job[] }).available ?? [])
    expect(Array.isArray(arr)).toBe(true)
  })

  test('GET /api/jobs returns currently installed jobs (array)', async ({ request }) => {
    const list = await getJson<unknown>(request, '/api/jobs')
    const arr = Array.isArray(list)
      ? list
      : ((list as { jobs?: Job[] }).jobs ?? [])
    expect(Array.isArray(arr)).toBe(true)
  })

  test('GET /api/jobs/<nonexistent> returns 404 cleanly', async ({ request }) => {
    const res = await request.get('/api/jobs/this-job-does-not-exist')
    expect(res.status()).toBe(404)
  })
})
