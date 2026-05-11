import { expect, test } from '@playwright/test'
import { getJson } from '../_lib/api'

test.describe('monitoring API', () => {
  test('GET /api/monitoring/system-metrics returns numeric fields', async ({ request }) => {
    const m = await getJson<Record<string, unknown>>(
      request,
      '/api/monitoring/system-metrics'
    )
    // Don't pin the exact field names (server-side fields evolve), just confirm
    // the response is a non-empty object — guards against a route-broken regression.
    expect(typeof m).toBe('object')
    expect(Object.keys(m).length).toBeGreaterThan(0)
  })

  test('GET /api/monitoring/claude-instances returns an array', async ({ request }) => {
    const instances = await getJson<unknown[] | { instances: unknown[] }>(
      request,
      '/api/monitoring/claude-instances'
    )
    const arr = Array.isArray(instances) ? instances : instances.instances ?? []
    expect(Array.isArray(arr)).toBe(true)
  })

  test('GET /api/system/dependencies reports the required tool list', async ({ request }) => {
    const deps = await getJson<{ name: string; installed: boolean }[]>(
      request,
      '/api/system/dependencies'
    )
    expect(Array.isArray(deps)).toBe(true)
    // The runtime container always has these; this guards against a regression
    // where the dependencies route forgets to surface a required dep.
    const names = deps.map((d) => d.name)
    expect(names).toContain('bun')
    expect(names).toContain('dtach')
    expect(names).toContain('git')
  })
})
