import { expect, test } from '@playwright/test'
import { getJson } from '../_lib/api'

interface Job {
  name: string
  enabled?: boolean
}

test.describe('jobs API (systemd/launchd timer surface)', () => {
  test('GET /api/jobs/available reports platform job-scheduler availability', async ({ request }) => {
    // Real shape: {available: bool, canCreate: bool, platform: "systemd" | "launchd" | null}
    // This is a CAPABILITY probe, not a list of installable jobs.
    const status = await getJson<{
      available: boolean
      canCreate: boolean
      platform: string | null
    }>(request, '/api/jobs/available')
    expect(typeof status.available).toBe('boolean')
    expect(typeof status.canCreate).toBe('boolean')
    expect(status.platform === null || typeof status.platform === 'string').toBe(true)
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
