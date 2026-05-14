/**
 * Prod smoke. Runs in BOTH local AND prod projects (see playwright.config.ts).
 * The single source of truth for "the deployment is alive."
 *
 * Things we want this to catch the moment they regress in prod:
 *  - Container is up and the gateway routes
 *  - SPA bundle hydrates (not a redirect loop or a broken JS bundle)
 *  - Migrations applied (any of the D-arc routes responds)
 *  - The service token / current-user wiring still works
 */
import { expect, test } from '@playwright/test'

test('/health returns 200', async ({ request }) => {
  const res = await request.get('/health')
  expect(res.status()).toBe(200)
  const body = await res.json()
  expect(body.status).toBe('ok')
})

test('SPA shell hydrates on /settings', async ({ page }) => {
  await page.goto('/settings')
  // Wait for React to populate the root. We don't assert specific copy
  // because UI text drifts — the meaningful signal is that the bundle
  // loaded and React rendered something.
  await page.waitForFunction(
    () => {
      const root = document.getElementById('root')
      return root !== null && root.children.length > 0 && document.body.innerText.length > 200
    },
    { timeout: 15_000 }
  )
})

test('GET /api/users/me returns the service token identity (or null in local)', async ({
  request,
}) => {
  // Through CF Access, this resolves to whatever email the service token's
  // policy bound. Locally with no header it returns null. Either way the
  // route is reachable and the envelope is well-formed.
  const res = await request.get('/api/users/me')
  expect(res.status()).toBe(200)
  const body = (await res.json()) as { user: { id: string; email: string } | null }
  expect(body).toHaveProperty('user')
})
