const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const BASE_URL = 'http://localhost:8060';
const OUTPUT_DIR = path.join(__dirname, '..', 'docs', 'screenshots');

// WaddleBot Hub pages to capture
const pages = [
  { name: 'login', path: '/login' },
  { name: 'dashboard', path: '/dashboard' },
  { name: 'communities', path: '/communities' },
  { name: 'community-dashboard', path: '/communities/1/dashboard' },
  { name: 'servers', path: '/admin/1/servers' },
  { name: 'routes', path: '/admin/1/routes' },
  { name: 'modules', path: '/admin/1/modules' },
  { name: 'users', path: '/admin/1/members' },
  { name: 'settings', path: '/settings' },
];

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function captureScreenshots() {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  console.log('Launching browser...');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });

  // Capture login page first (unauthenticated)
  console.log('Capturing login page...');
  try {
    await page.goto(`${BASE_URL}/login`, { waitUntil: 'networkidle0', timeout: 60000 });
    await sleep(1000);
    await page.screenshot({ path: path.join(OUTPUT_DIR, 'login.png') });
    console.log('  ✓ Saved login.png');
  } catch (error) {
    console.error('  ✗ Error capturing login:', error.message);
  }

  // Perform login through UI
  console.log('\nLogging in...');
  try {
    const inputs = await page.$$('input');
    console.log(`  Found ${inputs.length} input fields`);

    if (inputs.length >= 2) {
      await inputs[0].type('admin@localhost');  // Email/username field
      await inputs[1].type('admin123');          // Password field
    }

    // Click submit button
    await page.click('button[type="submit"]');

    // Wait for navigation to complete
    await page.waitForFunction(
      () => !window.location.pathname.includes('/login'),
      { timeout: 30000 }
    );
    await sleep(2000);
    console.log('  ✓ Login successful');
    console.log(`  Current URL: ${page.url()}`);
  } catch (error) {
    console.error('  ✗ Login failed:', error.message);
    console.log('  Continuing with available pages...');
  }

  // Capture all other pages
  console.log('\nCapturing pages...');
  for (const pageInfo of pages) {
    if (pageInfo.name === 'login') continue;

    try {
      console.log(`  ${pageInfo.name}...`);
      await page.goto(`${BASE_URL}${pageInfo.path}`, {
        waitUntil: 'networkidle0',
        timeout: 60000
      });
      await sleep(2000); // Wait for data to load

      // Check if we got redirected to login
      const currentUrl = page.url();
      if (currentUrl.includes('/login')) {
        console.log(`    ⚠️  Redirected to login, skipping`);
        continue;
      }

      await page.screenshot({
        path: path.join(OUTPUT_DIR, `${pageInfo.name}.png`),
        fullPage: false,
      });
      console.log(`    ✓ Saved ${pageInfo.name}.png`);
    } catch (error) {
      console.error(`    ✗ Error: ${error.message}`);
    }
  }

  await browser.close();
  console.log('\n✓ Screenshots saved to:', OUTPUT_DIR);
}

captureScreenshots().catch(console.error);
