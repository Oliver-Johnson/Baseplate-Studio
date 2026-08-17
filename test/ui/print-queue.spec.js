/* Printing a drawer a few bins at a time.
 *
 * A drawer is filled over several evenings, so half of it is already sitting there
 * while the rest is still to print. Arranging plates around parts you already own
 * wastes the plate. Marking a bin printed leaves it in the layout — it is in the
 * drawer, it is just not in the queue — and takes it out of everything you would
 * print from.
 *
 * These drive the page rather than calling types(), because the claim is about what
 * the plates and the export offer, not about what one function returns.
 */
'use strict';
const { test, expect } = require('@playwright/test');
const H = require('./helpers.js');

const settle = (page) => page.waitForTimeout(700);

async function placeTwo(page) {
  await H.dragCells(page, [0, 0], [0, 0]);
  await H.dragCells(page, [2, 0], [2, 0]);
  await settle(page);
}
const planText = (page) => page.locator('#plateSummary').textContent();

test('a bin marked printed leaves the plates but stays in the drawer', async ({ page }) => {
  await H.openBins(page);
  await placeTwo(page);
  expect(await planText(page)).toMatch(/2 bins packed/);

  await H.clickCell(page, 0, 0);            // select the first
  await settle(page);
  await expect(page.locator('#doneRow')).toBeVisible();
  await page.check('#done');
  await settle(page);

  // out of the queue...
  expect(await planText(page)).toMatch(/1 bin packed/);
  expect(await page.locator('#totals').textContent()).toMatch(/1 bin still to print/);
  // ...but still in the drawer
  expect((await H.bins(page)).length).toBe(2);
  expect(await page.locator('#coverage').textContent()).toMatch(/2 bins/);
});

test('the toggle is hidden with nothing selected, so it cannot describe the next bin', async ({ page }) => {
  await H.openBins(page);
  await placeTwo(page);
  await page.keyboard.press('Escape').catch(() => {});
  await page.evaluate(() => { B().forEach((b) => { b.sel = false; }); selected = -1; readControls(); });
  await settle(page);
  await expect(page.locator('#doneRow')).toBeHidden();
});

/* Neither half of this is enough on its own, which is worth stating because the first
   version of this test checked the wrong one and passed against everything.
   `done` is kept out of the settings object, AND new bins are built from an explicit
   field list rather than a spread of `state`. Break either and nothing happens; break
   both — route the flag through `t` and spread `state` into new bins, which is an
   ordinary tidy-up — and every bin drawn after a mark is born printed. This fails on
   that pair. It also needs the deselect below: with a bin selected the flag reaches
   only that bin, so the bug hides until you click away. */
test('marking one bin printed does not infect the bins drawn next', async ({ page }) => {
  await H.openBins(page);
  await H.dragCells(page, [0, 0], [0, 0]);
  await settle(page);
  await H.clickCell(page, 0, 0);
  await settle(page);
  await page.check('#done');
  await settle(page);

  /* Deselect BEFORE drawing the next one. That is the whole path: with a bin selected
     the flag only reaches that bin, so a version routed through `state` looks correct
     until you click away — readControls then writes the still-ticked box into the
     template for every bin drawn afterwards. Without this line the test passes against
     the bug it exists to catch. */
  await page.evaluate(() => { B().forEach((b) => { b.sel = false; }); selected = -1; readControls(); });
  await settle(page);

  await H.dragCells(page, [3, 3], [3, 3]);
  await settle(page);
  const marks = await page.evaluate(() => B().map((b) => !!b.done));
  expect(marks.filter(Boolean).length, 'only the one that was marked').toBe(1);
  expect(await planText(page)).toMatch(/1 bin packed/);
});

test('mark every bin printed, and clear it again', async ({ page }) => {
  await H.openBins(page);
  await placeTwo(page);
  await page.click('#markAllDone');
  await settle(page);
  expect(await page.evaluate(() => B().every((b) => b.done))).toBe(true);

  await page.click('#markNoneDone');
  await settle(page);
  expect(await page.evaluate(() => B().some((b) => b.done))).toBe(false);
  expect(await planText(page)).toMatch(/2 bins packed/);
});

/* The mark has to travel, or sharing a half-built drawer hands the recipient a plate
   of everything including what you already printed. */
test('the printed mark survives a reload', async ({ page }) => {
  await H.openBins(page);
  await placeTwo(page);
  await H.clickCell(page, 0, 0);
  await settle(page);
  await page.check('#done');
  await settle(page);

  await page.reload();
  await page.waitForFunction(() => typeof THREE !== 'undefined');
  await settle(page);
  expect(await page.evaluate(() => B().filter((b) => b.done).length)).toBe(1);
  expect(await planText(page)).toMatch(/1 bin packed/);
});
