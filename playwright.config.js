// @ts-check
const { defineConfig, devices } = require('@playwright/test');

/* The pages are static and compute everything locally, so they load straight off
   disk over file:// — no server to start and nothing to go wrong in CI because a
   port was busy. */
module.exports = defineConfig({
  testDir: './test/ui',
  /* Both tools compute real geometry before the page settles — the baseplates page
     runs CSG for every piece — so a case that drives one is doing seconds of work, not
     milliseconds. Measured locally with ten workers competing for the cores, the
     slowest case is around 20 s; CI sets no worker count and a 2-vCPU runner gives it
     one worker and no contention. 30 s left no headroom on a busy laptop, and per-test
     slow() marks would be an uneven fix for something every case here shares. */
  timeout: 60_000,
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
