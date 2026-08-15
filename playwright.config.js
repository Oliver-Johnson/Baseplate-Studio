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
  /* Generous on purpose. A case that takes 3 s on an idle machine has been measured
     timing out at 60 s while other work was running on the same box, which reads as a
     broken suite and has already been reported as one. The cost of a high ceiling is
     that a genuine hang takes longer to show itself; the cost of a low one is people
     learning to ignore red, which is worse. */
  timeout: 150_000,
  /* These cases are CPU-bound, not IO-bound: each worker loads a ~245 KB
     self-contained page with three.js and JSZip in it and then runs real CSG or
     mesh building. Playwright's default is half the cores, which on a 20-core
     machine is ten workers all wanting a core each for WebGL and geometry — they
     starve one another and cases that take 3 s alone blow the 60 s timeout. That
     reads as a broken suite and has already been reported as one.

     CI is unaffected either way: a 2-vCPU runner gets one worker and no
     contention, so this is left undefined there and the runner decides. */
  workers: process.env.CI ? undefined : 3,
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
