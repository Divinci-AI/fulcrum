import { expect, test } from '@playwright/test'
import { getJson } from '../_lib/api'

test.describe('filesystem API (sandboxed read surface)', () => {
  test.skip(
    process.env.PLAYWRIGHT_TEST_BASE_URL?.includes('divinci.ai') ?? false,
    'filesystem listing requires a writable host path; skip on prod where paths differ'
  )

  test('GET /api/fs/list?path=/tmp returns directory contents', async ({ request }) => {
    const res = await request.get('/api/fs/list?path=%2Ftmp')
    // Either listing succeeds (200) or the endpoint refuses out-of-sandbox
    // access (403). Anything else is a regression.
    expect([200, 403]).toContain(res.status())
    if (res.status() === 200) {
      const body = (await res.json()) as { entries?: unknown[] } | unknown[]
      const arr = Array.isArray(body) ? body : body.entries ?? []
      expect(Array.isArray(arr)).toBe(true)
    }
  })

  test('GET /api/fs/file-stat for /etc/hostname returns metadata', async ({ request }) => {
    const res = await request.get('/api/fs/file-stat?path=%2Fetc%2Fhostname')
    expect([200, 403, 404]).toContain(res.status())
    if (res.status() === 200) {
      const body = await res.json()
      expect(body).toHaveProperty('size')
    }
  })

  test('GET /api/fs/read with no path returns 400', async ({ request }) => {
    const res = await request.get('/api/fs/read')
    expect(res.status()).toBe(400)
  })
})
