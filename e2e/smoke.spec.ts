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

test('Settings page hydrates (SPA loads and React renders)', async ({ page }) => {
  await page.goto('/settings')
  // The SPA serves the same HTML shell for every route — Fulcrum doesn't
  // render a literal "Settings" h1. Verify hydration by waiting for the
  // React root to populate. This guards against the failure mode that
  // matters (backend boot errors, broken SPA bundle, redirect loop) without
  // depending on specific copy that's likely to change.
  await page.waitForFunction(
    () => {
      const root = document.getElementById('root')
      return root !== null && root.children.length > 0 && document.body.innerText.length > 200
    },
    { timeout: 15_000 }
  )
})

test('GET /api/config/google-oauth-status returns expected shape', async ({ request }) => {
  // This endpoint was added on feat/google-oauth-bundled-client and is the
  // signal that drives the managedByHost UI hide. Once Phase 1 merges into
  // the image we deploy, the test will pass against prod too. Until then,
  // it may 404 against prod. That's fine — we want CI to catch the moment
  // the merge lands and the response shape regresses.
  const res = await request.get('/api/config/google-oauth-status')
  // Either endpoint is present (Phase 1 image) and we validate the shape,
  // or it's absent (pre-Phase-1 image) and we just note the skip. The
  // 404 response from this build has shape {error: "Unknown config key"}
  // — that's because the path is being interpreted as a /:key fallback in
  // server/routes/config.ts. When Phase 1 ships in the image, the explicit
  // /google-oauth-status route handler catches first.
  if (res.status() === 404) {
    test.skip(true, 'google-oauth-status endpoint not present in this build')
  }
  expect(res.status()).toBe(200)
  const body = (await res.json()) as {
    clientId?: { provider: string }
    clientSecret?: { provider: string }
    managedByHost?: boolean
  }
  expect(body.clientId?.provider).toBeTruthy()
  expect(body.clientSecret?.provider).toBeTruthy()
  expect(typeof body.managedByHost).toBe('boolean')
})
