import { expect, test } from '@playwright/test'

// One browser-driven UI smoke test for the Settings page. The headless API
// specs cover the data plane; this guards the path "user navigates to
// Settings, the React app renders without erroring, and at least one
// recognizable section is visible".

test.describe('Settings UI', () => {
  test('Settings page shows at least one of the expected sections', async ({ page }) => {
    await page.goto('/settings')

    // Wait for React to hydrate (smoke spec validates this more loosely).
    await page.waitForFunction(
      () => {
        const root = document.getElementById('root')
        return root !== null && root.children.length > 0 && document.body.innerText.length > 200
      },
      { timeout: 15_000 }
    )

    // Settings page has several section/tab labels. Accept ANY of these
    // showing up — we want to catch "page is blank or unmounted", not
    // pin specific copy. If all of these disappear, the test fails
    // and we know the page broke.
    const candidates = [
      /general/i,
      /integrations/i,
      /notifications/i,
      /channels/i,
      /appearance/i,
      /assistant/i,
      /google/i,
    ]
    const bodyText = await page.locator('body').innerText({ timeout: 5000 })
    const found = candidates.filter((re) => re.test(bodyText))
    expect(found.length, `expected at least one Settings section label visible; body text:\n${bodyText.slice(0, 600)}`).toBeGreaterThan(0)
  })
})
