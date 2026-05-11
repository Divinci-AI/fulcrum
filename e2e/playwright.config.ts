import { defineConfig, devices } from '@playwright/test'

const PROD_BASE = process.env.FULCRUM_E2E_PROD_URL ?? 'https://fulcrum-acme.divinci.ai'
const LOCAL_BASE = process.env.FULCRUM_E2E_LOCAL_URL ?? 'http://localhost:17777'

// CF Access Service Token (header pair) for talking to the prod deployment
// without going through SSO. Provisioned via the Cloudflare API and stored as
// CI secrets. When absent, the prod project is skipped (tests are still
// runnable locally).
const CF_ACCESS_CLIENT_ID = process.env.CF_ACCESS_CLIENT_ID ?? ''
const CF_ACCESS_CLIENT_SECRET = process.env.CF_ACCESS_CLIENT_SECRET ?? ''
const HAS_PROD_AUTH = Boolean(CF_ACCESS_CLIENT_ID && CF_ACCESS_CLIENT_SECRET)

export default defineConfig({
  testDir: '.',
  // smoke.spec.ts at top level + api/*.spec.ts feature matrix (headless API).
  // UI specs (browser-driven Playwright) land in ui/*.spec.ts when wired.
  testMatch: ['*.spec.ts', 'api/*.spec.ts', 'ui/*.spec.ts'],
  // Tests are independent — parallelize across files.
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',

  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  projects: [
    {
      // Local target: an ephemeral Fulcrum container brought up by
      // docker-compose.test.yml. No Cloudflare, no SSO. Fast feedback loop.
      name: 'local',
      testMatch: /.*\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: LOCAL_BASE,
      },
    },
    HAS_PROD_AUTH
      ? {
          // Prod probe: hits the real fulcrum-acme.divinci.ai. Authenticates
          // via Cloudflare Access service token (extraHTTPHeaders), bypassing
          // the SSO redirect.
          name: 'prod',
          testMatch: /.*\.spec\.ts/,
          use: {
            ...devices['Desktop Chrome'],
            baseURL: PROD_BASE,
            extraHTTPHeaders: {
              'CF-Access-Client-Id': CF_ACCESS_CLIENT_ID,
              'CF-Access-Client-Secret': CF_ACCESS_CLIENT_SECRET,
            },
          },
        }
      : null,
  ].filter(Boolean) as ReturnType<typeof defineConfig>['projects'],
})
