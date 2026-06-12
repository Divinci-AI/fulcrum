/**
 * OG / link-unfurl crawler probe.
 *
 * Verifies that the path-based CF Access Bypass app for unfurl paths
 * (created during D-15 — see PR #82 / #91 + memory "CF Access vs Workers
 * pipeline") keeps working: Slackbot, Discordbot, etc. must reach
 * `/og/*` and `/tasks/*` WITHOUT the CF Access service token. If this
 * spec regresses, every Slack unfurl on every tenant URL is silently
 * broken — there's no in-app signal.
 *
 * Why it matters: the rest of the prod suite uses extraHTTPHeaders to
 * pass the CF Access service token. THAT path proves "the origin
 * works." This spec proves "anonymous crawlers can reach the origin"
 * — the orthogonal axis that broke the D-15 deploy multiple times.
 *
 * Runs in `prod` project by default. In `local` we skip because the
 * docker-compose test target doesn't sit behind CF Access — the
 * scenario isn't representative.
 */
import { expect, test, request as pwRequest } from '@playwright/test'

const SLACKBOT_UA = 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)'

// Skip locally — CF Access only exists in prod, so the test setup
// isn't meaningful there. (beforeEach because Playwright 1.59 stopped
// passing testInfo to file-level test.skip predicates.)
test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name === 'local', 'Prod-only — exercises CF Access path-based bypass')
})

test.describe('OG endpoints reachable for crawlers without CF Access auth', () => {
  test('GET /og/default.png returns a real PNG', async ({ baseURL }) => {
    // Fresh request context with NO CF-Access-Client-* headers — this
    // is what Slackbot looks like to the edge.
    const ctx = await pwRequest.newContext({
      baseURL,
      extraHTTPHeaders: { 'User-Agent': SLACKBOT_UA },
    })
    const res = await ctx.get('/og/default.png')
    expect(res.status(), 'expected 200 from path-based bypass; if 302, CF Access bypass policy is broken').toBe(200)
    expect(res.headers()['content-type']).toBe('image/png')
    const buf = await res.body()
    expect(buf.byteLength).toBeGreaterThan(1000)
    // PNG magic bytes
    expect(buf[0]).toBe(0x89)
    expect(buf[1]).toBe(0x50)
    expect(buf[2]).toBe(0x4e)
    expect(buf[3]).toBe(0x47)
    await ctx.dispose()
  })

  test('GET /og/task/<bogus-uuid>.png returns the fallback PNG (not 404/500)', async ({ baseURL }) => {
    const ctx = await pwRequest.newContext({
      baseURL,
      extraHTTPHeaders: { 'User-Agent': SLACKBOT_UA },
    })
    const res = await ctx.get('/og/task/00000000-0000-0000-0000-000000000000.png')
    expect(res.status()).toBe(200)
    expect(res.headers()['content-type']).toBe('image/png')
    await ctx.dispose()
  })

  test('GET /tasks/* returns SPA HTML with og:* meta tags injected', async ({ baseURL }) => {
    const ctx = await pwRequest.newContext({
      baseURL,
      extraHTTPHeaders: { 'User-Agent': SLACKBOT_UA },
    })
    // Any task path — the meta injector falls back to the default card
    // for unknown UUIDs, which still has og:title / og:image.
    const res = await ctx.get('/tasks/00000000-0000-0000-0000-000000000000')
    expect(res.status()).toBe(200)
    expect(res.headers()['content-type']).toContain('text/html')
    const html = await res.text()
    expect(html).toContain('<meta property="og:type"')
    expect(html).toContain('<meta property="og:image"')
    expect(html).toContain('<meta name="twitter:card"')
    await ctx.dispose()
  })

  test('GET /api/tasks/* STILL requires auth (regression guard against over-broad bypass)', async ({ baseURL }) => {
    const ctx = await pwRequest.newContext({
      baseURL,
      extraHTTPHeaders: { 'User-Agent': SLACKBOT_UA },
      // Don't follow the OAuth redirect — we want to observe it.
      maxRedirects: 0,
    })
    const res = await ctx.get('/api/tasks/00000000-0000-0000-0000-000000000000', {
      maxRedirects: 0,
    })
    // CF Access redirects to its OAuth login. The path-based bypass must
    // NOT cover /api/* — if it does, every tenant's data is suddenly
    // publicly readable.
    expect(res.status(), 'API endpoints must remain gated by CF Access').toBe(302)
    const location = res.headers()['location']
    expect(location).toContain('cloudflareaccess.com')
    await ctx.dispose()
  })
})
