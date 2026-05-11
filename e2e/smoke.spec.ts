import { expect, test } from '@playwright/test'

// Three smoke specs — the things that broke during the first end-to-end deploy
// and that we want to lock down as regression tests forever.

test('/health returns 200 with status:ok', async ({ request }) => {
  const res = await request.get('/health')
  expect(res.status()).toBe(200)
  const body = await res.json()
  expect(body.status).toBe('ok')
  // uptime is a number of ms since process start — should always be present
  expect(typeof body.uptime).toBe('number')
})

test('Settings page renders without erroring', async ({ page }) => {
  await page.goto('/settings')
  // We're not testing exact copy, just that the SPA hydrates and shows the
  // top-level Settings heading. Failure mode this guards against: backend
  // boot errors that leave the page blank.
  await expect(page.getByRole('heading', { name: /settings/i })).toBeVisible({ timeout: 15_000 })
})

test('GET /api/config/google-oauth-status returns expected shape', async ({ request }) => {
  // This endpoint was added on feat/google-oauth-bundled-client and is the
  // signal that drives the managedByHost UI hide. Once Phase 1 merges into
  // the image we deploy, the test will pass against prod too. Until then,
  // it may 404 against prod. That's fine — we want CI to catch the moment
  // the merge lands and the response shape regresses.
  const res = await request.get('/api/config/google-oauth-status')
  // Either endpoint is present (Phase 1 image) and we validate the shape,
  // or it's absent (pre-Phase-1 image) and we just note the skip.
  if (res.status() === 404) {
    test.skip(true, 'google-oauth-status endpoint not present in this build')
  }
  expect(res.status()).toBe(200)
  const body = await res.json()
  expect(body).toHaveProperty('clientId.provider')
  expect(body).toHaveProperty('clientSecret.provider')
  expect(body).toHaveProperty('managedByHost')
  expect(typeof body.managedByHost).toBe('boolean')
})
