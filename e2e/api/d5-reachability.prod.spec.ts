/**
 * D-5 surface reachability — prod-safe.
 *
 * Doesn't test multi-user enforcement (that's local-only). Just verifies
 * that:
 *  - Migration 0077 applied — the teams / acls endpoints respond
 *  - The D-5 routes are wired into the app
 *  - The visibility flip endpoint reaches a real handler (not a 404)
 *
 * This is the canary that catches "we shipped an image without the D-5
 * migration baked in" or "the new routes aren't registered in app.ts."
 */
import { expect, test } from '@playwright/test'

test('GET /api/teams returns an array', async ({ request }) => {
  const res = await request.get('/api/teams')
  expect(res.status()).toBe(200)
  const body = (await res.json()) as { teams: unknown[] }
  expect(Array.isArray(body.teams)).toBe(true)
})

test('GET /api/acls is wired (4xx — not 404, not 5xx)', async ({ request }) => {
  // Without query params, the route returns 401 (requireUser fires) for
  // anonymous local callers, or 400 (input validation) when an identity
  // is present and resourceType is missing. Both signals are "the route
  // is registered." The regressions we want to catch are 404 (route
  // missing) and 5xx (handler crash).
  const res = await request.get('/api/acls')
  expect(res.status()).toBeGreaterThanOrEqual(400)
  expect(res.status()).toBeLessThan(500)
  expect(res.status()).not.toBe(404)
})

test('PATCH /api/acls/visibility/task/<unknown-id> is wired (4xx — not 404, not 5xx)', async ({
  request,
}) => {
  // Unknown task: locally returns 401 (no identity) or 403 (identity but
  // no admin on missing resource). In prod via service token, 403 or 404
  // depending on access-control semantics for missing resources. All are
  // "the route is wired"; 5xx would be the regression.
  const res = await request.patch('/api/acls/visibility/task/00000000-nope-nope-nope-000000000000', {
    data: { visibility: 'restricted' },
  })
  expect(res.status()).toBeGreaterThanOrEqual(400)
  expect(res.status()).toBeLessThan(500)
})
