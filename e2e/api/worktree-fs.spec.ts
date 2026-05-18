/**
 * Phase B-4 — worktree filesystem round-trip tests.
 *
 * These tests exercise the FS routes (`/api/fs/write` + `/api/fs/read` +
 * `/api/fs/file-stat`) against the local docker-compose target. They
 * are gated behind `FULCRUM_E2E_LOCAL_FS=1` because:
 *
 *   1. They write to the test container's filesystem; running them
 *      against prod would write into `/tmp` on the GCE host, which is
 *      noise + a potential security boundary surprise.
 *   2. The local docker-compose container has a known, controlled tmp
 *      directory that gets cleaned with the container teardown.
 *
 * To run: `FULCRUM_E2E_LOCAL_FS=1 bunx playwright test --project=local`
 * They are silently skipped in the default local run so they don't
 * slow down the everyday feedback loop.
 *
 * What they validate:
 *   - Write → file-stat round-trip (path correctness, content size)
 *   - Read returns the same content
 *   - Path traversal rejected (403 on `../`-escape)
 */
import { expect, test } from '@playwright/test'

const FS_ENABLED = process.env.FULCRUM_E2E_LOCAL_FS === '1'

test.beforeEach(() => {
  test.skip(!FS_ENABLED, 'Set FULCRUM_E2E_LOCAL_FS=1 to enable worktree FS tests')
})

const TEST_ROOT = '/tmp'
const TEST_FILE = `fulcrum-e2e-${Date.now()}.txt`
const TEST_CONTENT = 'hello from playwright phase b-4 ☘️'

test('write → file-stat round-trip', async ({ request }) => {
  const writeRes = await request.post('/api/fs/write', {
    data: {
      path: TEST_FILE,
      root: TEST_ROOT,
      content: TEST_CONTENT,
      create: true,
    },
  })
  expect(writeRes.status()).toBe(200)

  const statRes = await request.get(
    `/api/fs/file-stat?path=${encodeURIComponent(TEST_FILE)}&root=${encodeURIComponent(TEST_ROOT)}`
  )
  expect(statRes.status()).toBe(200)
  const stat = (await statRes.json()) as { size?: number; isFile?: boolean }
  expect(stat.isFile).toBe(true)
  // Size should match byte length of the UTF-8 content. The emoji is
  // multi-byte; using TextEncoder gives the right reference.
  expect(stat.size).toBe(new TextEncoder().encode(TEST_CONTENT).length)
})

test('read returns the written content verbatim', async ({ request }) => {
  // Idempotent setup — re-write in case the previous test ran in a
  // different process. Playwright tests are isolated per file.
  await request.post('/api/fs/write', {
    data: {
      path: TEST_FILE,
      root: TEST_ROOT,
      content: TEST_CONTENT,
      create: true,
    },
  })

  const readRes = await request.get(
    `/api/fs/read?path=${encodeURIComponent(TEST_FILE)}&root=${encodeURIComponent(TEST_ROOT)}`
  )
  expect(readRes.status()).toBe(200)
  const body = (await readRes.json()) as { content?: string }
  expect(body.content).toBe(TEST_CONTENT)
})

test('path traversal is rejected (403, not 200)', async ({ request }) => {
  // Trying to escape the root with `../` segments must be refused.
  // Important because the FS routes are admin-power: a successful
  // escape would let any authenticated user read or write arbitrary
  // files in the container.
  const res = await request.get(
    `/api/fs/file-stat?path=../../etc/passwd&root=${encodeURIComponent(TEST_ROOT)}`
  )
  expect(res.status()).toBe(403)
})
