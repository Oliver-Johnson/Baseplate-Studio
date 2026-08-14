// @ts-check
const { defineConfig, devices } = require('@playwright/test');

/* The pages are static and compute everything locally, so they load straight off
   disk over file:// — no server to start and nothing to go wrong in CI because a
   port was busy. */
module.exports = defineConfig({
  testDir: './test/ui',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    // a real viewport: the drawer map sizes itself from its container, and has
    // been broken before by measuring the wrong element
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
