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

  test('GET /api/fs/file-stat requires BOTH root and path query params', async ({ request }) => {
    // Real signature (see server/routes/filesystem.ts): the endpoint takes
    // a `root` directory + a `path` relative to it. Both required. The
    // resolved path must stay inside root (security guard).

    // Missing root → 400 "root parameter is required"
    const onlyPath = await request.get('/api/fs/file-stat?path=hostname')
    expect(onlyPath.status()).toBe(400)
    expect(((await onlyPath.json()) as { error?: string }).error).toMatch(/root parameter/i)

    // Missing path → 400 "path parameter is required"
    const onlyRoot = await request.get('/api/fs/file-stat?root=%2Fetc')
    expect(onlyRoot.status()).toBe(400)
    expect(((await onlyRoot.json()) as { error?: string }).error).toMatch(/path parameter/i)

    // Both present → either 200 or 403 (security guard if root resolves
    // outside the allowed sandbox).
    const both = await request.get('/api/fs/file-stat?root=%2Fetc&path=hostname')
    expect([200, 403, 404]).toContain(both.status())
  })

  test('GET /api/fs/read with no path returns 400', async ({ request }) => {
    const res = await request.get('/api/fs/read')
    expect(res.status()).toBe(400)
  })
})
