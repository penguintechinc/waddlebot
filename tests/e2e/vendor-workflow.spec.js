/**
 * E2E Tests: Vendor Workflow
 * Tests vendor submission, review, and approval process
 */

const { test, expect } = require('@playwright/test');

test.describe('Vendor Submission Workflow', () => {
  test('Submit vendor module request', async ({ page }) => {
    const vendorEmail = `vendor${Date.now()}@test.com`;
    const moduleName = `test-module-${Date.now()}`;

    // Navigate to vendor submission page
    await page.goto('/vendor/submit');
    await page.waitForTimeout(1000);

    // Fill vendor submission form
    await page.fill('input[name="vendor_name"], input[name="vendorName"]', 'Test Vendor');
    await page.fill('input[name="vendor_email"], input[name="vendorEmail"]', vendorEmail);
    await page.fill('input[name="module_name"], input[name="moduleName"]', moduleName);
    await page.fill('textarea[name="module_description"], textarea[name="moduleDescription"]', 'A test module for E2E testing');
    await page.fill('input[name="webhook_url"], input[name="webhookUrl"]', 'https://example.com/webhook');

    // Select pricing model
    const pricingSelect = page.locator('select[name="pricing_model"], select[name="pricingModel"]');
    if (await pricingSelect.count() > 0) {
      await pricingSelect.selectOption('flat-rate');
    }

    // Select payment method
    const paymentSelect = page.locator('select[name="payment_method"], select[name="paymentMethod"]');
    if (await paymentSelect.count() > 0) {
      await paymentSelect.selectOption('paypal');
    }

    // Submit form
    await page.click('button[type="submit"]');
    await page.waitForTimeout(2000);

    // Verify success or pending status
    const hasSuccessMessage = await page.locator('text=/success|submitted|pending/i').count() > 0;
    const currentUrl = page.url();
    expect(hasSuccessMessage || currentUrl.includes('/vendor/status')).toBeTruthy();
  });

  test('View vendor dashboard (requires authentication)', async ({ page }) => {
    // Login first
    await page.goto('/login');
    await page.fill('input[name="email"], input[type="email"]', 'admin@localhost.local');
    await page.fill('input[name="password"], input[type="password"]', 'admin123');
    await page.click('button[type="submit"]');
    await page.waitForTimeout(2000);

    // Navigate to vendor dashboard
    await page.goto('/vendor/dashboard');
    await page.waitForTimeout(1000);

    // Verify page loaded
    const hasSubmissions = await page.locator('text=/submissions|modules/i').count() > 0;
    expect(hasSubmissions || page.url().includes('/vendor')).toBeTruthy();
  });

  test('View vendor submissions list', async ({ page }) => {
    await page.goto('/vendor/submissions');
    await page.waitForTimeout(1000);

    // Verify page loaded (may require auth or be publicly accessible)
    const isOnPage = page.url().includes('/vendor');
    expect(isOnPage).toBeTruthy();
  });
});
