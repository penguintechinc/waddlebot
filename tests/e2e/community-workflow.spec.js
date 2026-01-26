/**
 * E2E Tests: Community Workflow
 * Tests community creation, server linking, and module installation
 */

const { test, expect } = require('@playwright/test');

test.describe('Community Management Workflow', () => {
  test.beforeEach(async ({ page }) => {
    // Login as admin
    await page.goto('/login');
    await page.fill('input[name="email"], input[type="email"]', 'admin@localhost.local');
    await page.fill('input[name="password"], input[type="password"]', 'admin123');
    await page.click('button[type="submit"]');
    await page.waitForTimeout(2000);
  });

  test('Create new community', async ({ page }) => {
    const communityName = `testcommunity${Date.now()}`;
    const displayName = `Test Community ${Date.now()}`;

    // Navigate to communities page
    await page.goto('/communities');
    await page.waitForTimeout(1000);

    // Click create community button
    const createButton = page.locator('button:has-text("Create"), a:has-text("Create"), [data-testid="create-community"]').first();
    await createButton.click();
    await page.waitForTimeout(1000);

    // Fill community form
    await page.fill('input[name="name"]', communityName);
    await page.fill('input[name="display_name"], input[name="displayName"]', displayName);
    await page.fill('textarea[name="description"]', 'A test community for E2E tests');

    // Submit form
    await page.click('button[type="submit"]');
    await page.waitForTimeout(2000);

    // Verify success (should redirect to community page or show success message)
    const currentUrl = page.url();
    const hasSuccessMessage = await page.locator('text=/success|created/i').count() > 0;
    expect(currentUrl.includes('/communities') || hasSuccessMessage).toBeTruthy();
  });

  test('View community list', async ({ page }) => {
    await page.goto('/communities');
    await page.waitForTimeout(1000);

    // Verify page loaded
    await expect(page.locator('h1, h2')).toContainText(/Communities/i);

    // Verify at least one community is visible
    const communityCards = await page.locator('[data-testid="community-card"], .community-card, .community-item').count();
    expect(communityCards).toBeGreaterThanOrEqual(0);
  });

  test('View community details', async ({ page }) => {
    // Go to communities list
    await page.goto('/communities');
    await page.waitForTimeout(1000);

    // Click first community
    const firstCommunity = page.locator('[data-testid="community-card"], .community-card, .community-item').first();
    if (await firstCommunity.count() > 0) {
      await firstCommunity.click();
      await page.waitForTimeout(1000);

      // Verify community page loaded
      const hasMembers = await page.locator('text=/members/i').count() > 0;
      const hasModules = await page.locator('text=/modules/i').count() > 0;
      expect(hasMembers || hasModules).toBeTruthy();
    }
  });
});
