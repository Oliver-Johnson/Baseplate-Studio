/* The download dialog, on both tools.
 *
 * Export used to be a panel that sat in the page while you worked. It is now one
 * button and a dialog, and the dialog's whole purpose is to answer three questions
 * before you download anything: what is this, will it fit my printer, and which files
 * am I about to get. Each test below is one of those, plus getting in and out again —
 * because a modal you cannot close is worse than a panel you can ignore.
 */
'use strict';
const fs = require('fs');
const { test, expect } = require('@playwright/test');
const H = require('./helpers.js');
// the library the pages themselves use, so reading a zip back costs no dependency
const JSZip = require('../../vendor/jszip.min.js');

/* Both pages carry the same dialog markup, so the open/close behaviour is worth
   driving identically on each rather than trusting that it was copied correctly. */
for (const tool of [
  // read out of each page's own model — the DOM is what is under test, so it cannot
  // also be the thing that says how many plates there should have been
  { name: 'bins', open: H.openBins, plates: () => goodPlates().length },
  { name: 'baseplates', open: H.openPlates, plates: () => printPlan.plates.length },
]) {
  test.describe(tool.name, () => {
    test.beforeEach(async ({ page }) => {
      page.__errors = await tool.open(page);
      if (tool.name === 'bins') {
        await page.locator('#fillRest').click();      // something to export
        await page.waitForTimeout(400);
      }
    });
    test.afterEach(async ({ page }) => {
      expect(page.__errors, 'the page threw while being driven').toEqual([]);
    });

    test('the dialog opens, and every way out of it works', async ({ page }) => {
      const dlg = page.locator('#exportDlg');
      await expect(dlg).toBeHidden();

      await page.locator('#openExport').click();
      await expect(dlg).toBeVisible();

      await page.locator('#exportClose').click();
      await expect(dlg).toBeHidden();

      await page.locator('#openExport').click();
      await expect(dlg).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(dlg).toBeHidden();
    });

    /* Selecting text in the summary and releasing outside the box used to shut the
       dialog, because a click whose two ends differ reports their common ancestor. */
    test('a drag out of the dialog does not dismiss it', async ({ page }) => {
      await page.locator('#openExport').click();
      const dlg = page.locator('#exportDlg');
      const box = await page.locator('#exDesign').boundingBox();
      await page.mouse.move(box.x + 10, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x - 120, box.y + box.height / 2, { steps: 8 });
      await page.mouse.up();
      await expect(dlg).toBeVisible();

      // a click that begins and ends on the backdrop still closes it
      const d = await dlg.boundingBox();
      await page.mouse.click(Math.max(4, d.x / 2), d.y + 20);
      await expect(dlg).toBeHidden();
    });

    test('there is a download for every plate, and one for all of them', async ({ page }) => {
      await page.locator('#openExport').click();
      const n = await page.evaluate(tool.plates);
      expect(n, 'the fixture should produce at least one plate').toBeGreaterThan(0);

      await expect(page.locator('#exFiles [data-ex="plate"]')).toHaveCount(n);
      await expect(page.locator('#exFiles [data-ex="allplates"]')).toHaveCount(1);
      for (let i = 0; i < n; i++)
        await expect(page.locator('#exFiles .exrow').filter({ hasText: `Plate ${i + 1}` })).toHaveCount(1);
    });

    /* Every download path moved when the panel became a dialog, so at least one of
       them has to be taken end to end rather than merely rendered. A single plate is
       the one worth taking: it is the new affordance, and it exercises the same
       build-transform-zip path the combined export uses. */
    test('a single plate really downloads', async ({ page }) => {
      await page.locator('#openExport').click();
      const [dl] = await Promise.all([
        page.waitForEvent('download'),
        page.locator('#exFiles [data-ex="plate"]').first().click(),
      ]);
      expect(dl.suggestedFilename()).toMatch(/plate-1\.3mf$/);
      expect(fs.statSync(await dl.path()).size).toBeGreaterThan(500);
    });

    test('it says whether the design fits the configured bed', async ({ page }) => {
      await page.locator('#openExport').click();
      const fit = page.locator('#exFit');
      await expect(fit).toHaveClass(/exfit ok/);
      await expect(fit).toContainText(/fits? your 256 × 256 mm bed/);
      await page.locator('#exportClose').click();

      // shrink the bed below a single cell, so nothing at all can fit
      await H.setField(page, 'bedPreset', 'custom');
      await H.setField(page, 'bedW', 30);
      await H.setField(page, 'bedD', 30);
      await page.waitForTimeout(700);
      await page.locator('#openExport').click();
      await expect(fit).toHaveClass(/exfit bad/);
      await expect(fit).toContainText(/too big|not fit/);
    });

    test('it describes the design, not just the files', async ({ page }) => {
      await page.locator('#openExport').click();
      await expect(page.locator('#exDesign')).toContainText('306 × 380 mm drawer');
      await expect(page.locator('#exFiles .exrow').first()).toBeVisible();
    });
  });
}

/* The plate numbering bug, on a layout that actually has the shape that caused it.
 *
 * A bin too big for the bed gets a plate of its own that is never exported, and those
 * sort to the front. Numbering the downloads by raw index therefore skipped the front
 * of the range: with four overflow plates the files came out plate-5 to plate-14 while
 * the page, the print plan and the dialog all said 1 to 10. A fixture with no overflow
 * plates cannot see the difference — the first version of this test had one, and passed
 * against the unfixed code.
 */
test('plate numbering skips the plates that cannot be printed, not the numbers', async ({ page }) => {
  await H.openBins(page);
  await H.setField(page, 'drawerW', 600);
  await H.setField(page, 'drawerD', 500);
  await H.setField(page, 'bedPreset', 'custom');
  await H.setField(page, 'bedW', 120);
  await H.setField(page, 'bedD', 120);
  await H.setField(page, 'u', 5);
  await H.setField(page, 'v', 5);
  await page.locator('#fillRest').click();
  await page.waitForTimeout(1200);

  const plan = await page.evaluate(() => ({
    total: printPlan.plates.length,
    good: goodPlates().length,
    firstGood: goodPlates()[0][1],
  }));
  expect(plan.good, 'fixture: several printable plates').toBe(10);
  expect(plan.firstGood, 'fixture: unprintable plates must sort ahead of them')
    .toBeGreaterThan(0);

  await page.locator('#openExport').click();
  const labels = await page.locator('#exFiles [data-ex="plate"]')
    .evaluateAll((btns) => btns.map((b) => b.closest('.exrow').querySelector('.nm').textContent));
  expect(labels).toEqual(Array.from({ length: 10 }, (_, i) => `Plate ${i + 1}`));

  // the last row must be plate 10, not plate 14
  const [last] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#exFiles [data-ex="plate"]').last().click(),
  ]);
  expect(last.suggestedFilename()).toBe('bin-plate-10.3mf');

  // and the zip has to agree with the buttons, entry for entry
  const [zipDl] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#exFiles [data-ex="allplates"]').click(),
  ]);
  const zip = await JSZip.loadAsync(fs.readFileSync(await zipDl.path()));
  expect(Object.keys(zip.files).sort()).toEqual(
    Array.from({ length: 10 }, (_, i) => `bin-plate-${i + 1}.3mf`).sort());
});

/* "Everything, with a README" has to mean everything. The ZIP kept its own list of
   which connectors need loose parts and that list left out H-clips, so an hclip
   download arrived with a README telling the reader to press a clip into each junction
   and no clip anywhere in the file. */
test('the everything ZIP carries the connector parts for every joint that needs them',
  async ({ page }) => {
    await H.openPlates(page);
    // a shallow drawer: still wider than the bed, so it still splits and still has
    // seams to key, but two pieces and one plate rather than four and four
    await H.setField(page, 'drawerD', 180);
    for (const connector of ['hclip', 'bowtie']) {
      await H.setField(page, 'connector', connector);
      await page.waitForFunction(
        () => /ready/.test(document.getElementById('pieceTail').textContent),
        null, { timeout: 20000 });
      await page.evaluate(() => document.getElementById('openExport').click());
      const [dl] = await Promise.all([
        page.waitForEvent('download'),
        page.locator('#exFiles [data-ex="zip"]').click(),
      ]);
      const zip = await JSZip.loadAsync(fs.readFileSync(await dl.path()));
      const names = Object.keys(zip.files);
      expect(names.filter((n) => /(keys|clips)-x\d+\.stl$/.test(n)),
             `${connector}: the ZIP must contain the parts its README tells you to press in`)
        .toHaveLength(1);
      await page.locator('#exportClose').click();
    }
  });

/* The dialog is rebuilt on open and never again — which was fine until it started
   claiming otherwise. The baseplates page builds asynchronously, so opening it mid-build
   showed a half-built list under the words "the meshes below appear as they finish",
   and they never did: you had to close and reopen. Throttled hard so the build is still
   running when the dialog opens, which is the only way to see it. */
test('the baseplates dialog keeps up with a build running behind it', async ({ page }) => {
  const client = await page.context().newCDPSession(page);
  await H.openPlates(page);
  // after the navigation, not before: the override does not survive the page load
  await client.send('Emulation.setCPUThrottlingRate', { rate: 6 });

  /* A wide drawer with magnet pockets: the pockets are the CSG-subtract path, which is
     by far the slowest thing either tool does, and throttled it takes about eight
     seconds — long enough to open the dialog while the build is genuinely mid-flight.
     The piece table is the synchronisation point: it reads "building n/N" for exactly
     as long as runBuild is working. */
  await page.evaluate(() => {
    const m = document.getElementById('magnets');
    m.checked = true;
    m.dispatchEvent(new Event('change', { bubbles: true }));
    const e = document.getElementById('drawerW');
    e.value = '900';
    e.dispatchEvent(new Event('input', { bubbles: true }));
  });
  /* The status line under the preview is the exact signal: runBuild writes the id of
     the piece it is working on and clears it when the last one lands. The piece table
     is not — it reads "building" from the moment the layout changes, which is before
     the debounce has even fired. */
  await page.waitForFunction(
    () => /building/.test(document.getElementById('status').textContent), null,
    { timeout: 20000 });
  /* Opened with the element's own click, not the locator's. Under a 6x throttle
     Playwright's actionability checks and scroll took seconds, and the build we are
     trying to catch had finished before the pointer landed. */
  /* One synchronous snapshot rather than a series of expects. Two polled assertions
     about a state that is actively moving will race each other, and the second one
     failing because the fix worked is not a useful failure. */
  const midBuild = await page.evaluate(() => {
    document.getElementById('openExport').click();
    return { cls: document.getElementById('exFit').className,
             txt: document.getElementById('exFit').textContent,
             zip: document.querySelector('#exFiles [data-ex="zip"]').disabled,
             open: document.getElementById('exportDlg').open };
  });
  expect(midBuild.open).toBe(true);
  expect(midBuild.cls).toMatch(/wait/);
  expect(midBuild.txt).toContain('Still building');
  expect(midBuild.zip, 'the ZIP cannot be offered before the meshes exist').toBe(true);

  // without closing it: the same dialog has to arrive at the finished state on its own
  await expect(page.locator('#exFit')).toHaveClass(/exfit ok/, { timeout: 45000 });
  await expect(page.locator('#exFiles [data-ex="zip"]')).toBeEnabled();
  await expect(page.locator('#exFiles [data-ex="plate"]').first()).toBeVisible();
  await expect(page.locator('#exFiles .exrow').filter({ hasText: 'Piece A1' }))
    .toContainText(/KB|MB/);
  await client.send('Emulation.setCPUThrottlingRate', { rate: 1 });
});
