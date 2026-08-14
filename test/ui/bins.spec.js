/* Browser-level checks for the bins page.
 *
 * The geometry has had audits from the start; the interface had none, and every
 * bug found in it was found by hand. Each test below is a bug that actually
 * shipped, so the suite is a record of them rather than a wish list.
 */
'use strict';
const { test, expect } = require('@playwright/test');
const H = require('./helpers.js');

test.beforeEach(async ({ page }) => {
  const errors = await H.openBins(page);
  page.__errors = errors;
});

test.afterEach(async ({ page }) => {
  expect(page.__errors, 'the page threw while being driven').toEqual([]);
});

test('drag places a bin of the dragged size', async ({ page }) => {
  await H.dragCells(page, [0, 0], [2, 1]);
  const b = await H.bins(page);
  expect(b).toHaveLength(1);
  expect([b[0].u, b[0].v]).toEqual([3, 2]);
  expect(b[0].carved).toBe(false);
});

test('alt-click carves a cell out and puts it back', async ({ page }) => {
  await H.dragCells(page, [0, 0], [2, 2]);
  await H.clickCell(page, 2, 2, ['Alt']);
  let b = await H.bins(page);
  expect(b[0].cells).toHaveLength(8);
  expect(b[0].carved).toBe(true);
  expect(b[0].cells).not.toContain('2,2');

  await H.clickCell(page, 2, 2, ['Alt']);
  b = await H.bins(page);
  expect(b[0].cells).toHaveLength(9);
  expect(b[0].carved).toBe(false);
});

/* A carved bin is a normal bin. It was reported as an error and painted red the
   moment you carved, which made the feature look broken as you used it. */
test('a carved bin keeps its stacking lip and is not an error', async ({ page }) => {
  await H.dragCells(page, [0, 0], [2, 2]);
  await H.clickCell(page, 2, 2, ['Alt']);

  const meta = await page.evaluate(() => {
    const m = geomFor(B()[0]).meta;
    return { hasLip: m.hasLip, totalH: m.totalH, pitch: m.H, carved: m.carved };
  });
  expect(meta.carved).toBe(true);
  expect(meta.hasLip).toBe(true);
  // same overall height as the rectangle of the same unit count: 3 x 7 + 3.95 lip
  expect(meta.pitch).toBeCloseTo(21, 3);
  expect(meta.totalH).toBeCloseTo(24.95, 3);

  expect(await page.locator('#fillmap .clash').count()).toBe(0);
  expect(await page.locator('#warnings .w.err').count()).toBe(0);
  await expect(page.locator('#warnings')).toContainText('keeps its stacking lip');
});

test('the carve button drives the same thing, and lets you out again', async ({ page }) => {
  await H.dragCells(page, [0, 0], [2, 2]);
  const btn = page.locator('#carveMode');
  await expect(btn).toBeVisible();
  await expect(btn).toHaveText(/Carve this bin/);

  await btn.click();
  await expect(btn).toHaveText(/Done carving/);
  await expect(page.locator('#fillmap')).toHaveClass(/carving/);

  await H.clickCell(page, 2, 2);                       // plain click now carves
  expect((await H.bins(page))[0].cells).toHaveLength(8);

  // clicking outside the bin must not be swallowed, or the mode traps you
  await H.clickCell(page, 6, 6);
  await expect(page.locator('#fillmap')).not.toHaveClass(/carving/);

  await btn.click();
  await page.keyboard.press('Escape');
  await expect(page.locator('#fillmap')).not.toHaveClass(/carving/);
});

/* Resizing left the old mask in place. Cells outside the new box drew nothing on
   the map yet still blocked other bins and still built in the preview. */
test('resizing a carved bin reconciles its mask', async ({ page }) => {
  await H.dragCells(page, [0, 0], [2, 2]);
  await H.clickCell(page, 2, 2, ['Alt']);

  await H.setField(page, 'u', 4);
  await H.setField(page, 'v', 4);
  let b = await H.bins(page);
  expect(b[0].outsideBox, 'mask must never reach outside the bounding box').toBe(0);
  expect(b[0].cells).toHaveLength(15);          // 4x4 with the one hole carried over
  expect(b[0].cells).not.toContain('2,2');

  // shrinking past the hole drops it: a rectangle is the only honest result
  await H.setField(page, 'u', 2);
  await H.setField(page, 'v', 2);
  b = await H.bins(page);
  expect(b[0].outsideBox).toBe(0);
  expect(b[0].carved).toBe(false);
  expect(b[0].cells).toHaveLength(4);

  // and the cells it gave up must really be free again
  await H.dragCells(page, [3, 3], [3, 3]);
  expect(await H.bins(page)).toHaveLength(2);
});

/* Selecting bins of different sizes bulk-assigned the primary's footprint onto
   all of them, silently resizing every bin in the selection. */
test('multi-select edits settings without resizing anything', async ({ page }) => {
  await H.dragCells(page, [0, 0], [2, 1]);        // 3x2
  await H.dragCells(page, [0, 3], [0, 4]);        // 1x2
  await H.clickCell(page, 0, 0, ['Control']);     // both selected

  const b = await H.bins(page);
  expect(b.map((x) => `${x.u}x${x.v}`).sort()).toEqual(['1x2', '3x2']);

  await H.setField(page, 'hUnits', 5);
  const after = await H.bins(page);
  expect(after.map((x) => `${x.u}x${x.v}`).sort()).toEqual(['1x2', '3x2']);
  expect(after.every((x) => x.hUnits === 5), 'the shared setting should apply to both').toBe(true);
});

test('merging two bins makes one bin of their combined shape', async ({ page }) => {
  await H.dragCells(page, [0, 0], [2, 1]);        // 3x2
  await H.dragCells(page, [0, 2], [0, 3]);        // 1x2 on its left end
  await H.clickCell(page, 0, 0, ['Control']);
  await page.locator('#mergeBins').click();
  await page.waitForTimeout(300);

  const b = await H.bins(page);
  expect(b).toHaveLength(1);
  expect([b[0].u, b[0].v]).toEqual([3, 4]);
  expect(b[0].carved).toBe(true);
  expect(b[0].cells).toHaveLength(8);
  expect(b[0].outsideBox).toBe(0);
});

/* The plan drew bounding boxes, so an L was shown as a rectangle. */
test('the print plan draws the shape that will actually print', async ({ page }) => {
  await H.dragCells(page, [0, 0], [2, 2]);
  const full = await page.locator('#plateWrap svg rect').count();
  expect(full).toBe(1);

  await H.clickCell(page, 2, 2, ['Alt']);
  await page.waitForTimeout(300);
  expect(await page.locator('#plateWrap svg rect').count()).toBe(8);
});

test('cell coverage counts the cells a bin occupies, not its bounding box', async ({ page }) => {
  await H.dragCells(page, [0, 0], [2, 2]);
  await expect(page.locator('body')).toContainText('9/');
  await H.clickCell(page, 2, 2, ['Alt']);
  await expect(page.locator('body')).toContainText('8/');
});

/* A bin prints in one piece, so a tall one is a hard stop rather than a split. */
test('a bin taller than the printer is called out', async ({ page }) => {
  await H.setField(page, 'bedH', 120);
  await H.dragCells(page, [0, 0], [0, 0]);
  await H.setField(page, 'hUnits', 18);
  await expect(page.locator('#warnings')).toContainText('Z height');
});

/* The layout travels in the URL hash; a carved shape has to survive that like
   anything else, or sharing a link quietly changes what people print. */
test('a carved layout survives a round trip through the url', async ({ page }) => {
  await H.dragCells(page, [0, 0], [2, 2]);
  await H.clickCell(page, 2, 2, ['Alt']);
  const before = await H.bins(page);

  const link = await page.evaluate(() => shareLink());
  await page.goto(link);
  await page.waitForFunction(() => !!document.getElementById('fillmap'));
  await page.waitForTimeout(400);

  expect(await H.bins(page)).toEqual(before);
});
