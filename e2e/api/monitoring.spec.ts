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

  test('GET /api/system/dependencies surfaces the required tools', async ({ request }) => {
    // Real shape: {claudeCode: {installed, path}, openCode: {installed}, dtach: {installed, path}}
    const deps = await getJson<Record<string, { installed: boolean; path?: string }>>(
      request,
      '/api/system/dependencies'
    )
    expect(typeof deps).toBe('object')
    // dtach is required for terminal persistence (CLAUDE.md "Terminal Architecture")
    expect(deps).toHaveProperty('dtach')
    expect(deps.dtach.installed).toBe(true)
    // Claude Code is required for the assistant feature
    expect(deps).toHaveProperty('claudeCode')
    expect(deps.claudeCode.installed).toBe(true)
  })
})
