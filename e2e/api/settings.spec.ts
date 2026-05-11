import { expect, test } from '@playwright/test'
import { getJson } from '../_lib/api'

test.describe('settings/config API', () => {
  test('GET /api/config returns a flat object of dotted-string keys', async ({ request }) => {
    const config = await getJson<Record<string, unknown>>(request, '/api/config')
    expect(typeof config).toBe('object')
    // `toHaveProperty('server.port')` would treat the dot as nested access;
    // the real keys ARE literally "server.port" strings, so check via in/[].
    expect('server.port' in config).toBe(true)
    expect(typeof config['server.port']).toBe('number')
  })

  test('SECURITY: /api/config redacts every fnox `age` provider field', async ({ request }) => {
    // First e2e run against the deployed acme container caught this — the
    // /api/config listing returned googleClientSecret = "GOCSPX-...DRdy" in
    // plain text. Server now substitutes a "***" marker for any path that
    // FNOX_CONFIG_MAP marks as `provider: 'age'`. The UI can still tell
    // "set vs unset" (presence of the marker vs null) without seeing the
    // raw value. Regression guard: ensure NO Google client secret format
    // ever appears in this response.
    const config = await getJson<Record<string, unknown>>(request, '/api/config')
    const secret = config['integrations.googleClientSecret']
    if (secret !== null && secret !== undefined && secret !== '') {
      expect(String(secret)).not.toMatch(/^GOCSPX-/)
    }
    // Also defend against the GitHub PAT shape leaking via the same surface.
    const pat = config['integrations.githubPat']
    if (pat !== null && pat !== undefined && pat !== '') {
      expect(String(pat)).not.toMatch(/^(ghp_|github_pat_)/)
    }
  })

  test('GET /api/config/fnox-status reports fnox availability', async ({ request }) => {
    const status = await getJson<{ available: boolean; configCount: number }>(
      request,
      '/api/config/fnox-status'
    )
    expect(typeof status.available).toBe('boolean')
    expect(typeof status.configCount).toBe('number')
  })

  test('GET /api/config/google-oauth-status returns the managed-by-host envelope', async ({
    request,
  }) => {
    // This endpoint was added on the Phase 1 branch. Older builds (pre-Phase-1)
    // 404 on it — handled here by skipping. Once a Phase-1-inclusive image is
    // deployed, the assertions run and lock the shape in.
    const res = await request.get('/api/config/google-oauth-status')
    if (res.status() === 404) {
      test.skip(true, 'endpoint not present in this build (pre-Phase-1 image)')
    }
    expect(res.status()).toBe(200)
    const status = (await res.json()) as {
      clientId: { provider: string; configured: boolean }
      clientSecret: { provider: string; configured: boolean }
      managedByHost: boolean
    }
    expect(typeof status.managedByHost).toBe('boolean')
    expect(['env', 'fnox', 'none']).toContain(status.clientId.provider)
    expect(['env', 'fnox', 'none']).toContain(status.clientSecret.provider)
  })

  test('GET /api/config/developer-mode returns enabled + startedAt', async ({ request }) => {
    const dm = await getJson<{ enabled: boolean; startedAt: number }>(
      request,
      '/api/config/developer-mode'
    )
    expect(typeof dm.enabled).toBe('boolean')
    expect(typeof dm.startedAt).toBe('number')
  })
})
