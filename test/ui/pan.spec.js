/* Getting a corner of the drawer into the middle of the view.
 *
 * The bins preview only ever orbited the centre of the grid, so a bin in the far corner
 * of a nine-cell drawer could not be brought to the middle to be looked at — the only
 * way to see it better was to move further away, which makes it smaller. The baseplates
 * preview has panned on shift-drag from the start; the two now answer to the same hands,
 * middle button included.
 *
 * Driven through real mouse buttons rather than by calling the handler, because the
 * thing most likely to break this is the browser's own middle-click autoscroll stealing
 * the drag — which no unit-level test would see.
 */
'use strict';
const { test, expect } = require('@playwright/test');
const H = require('./helpers.js');

const view = (page) => page.evaluate(() => ({ panX, panZ, theta, phi }));

async function ready(page) {
  await H.openBins(page);
  await H.dragCells(page, [0, 0], [1, 1]);
  await page.waitForTimeout(600);
  /* The preview sits below the map, so at the default viewport its bounding box can be
     off screen entirely and every mouse event lands somewhere else. */
  await page.locator('#three').scrollIntoViewIfNeeded();
  await page.waitForTimeout(150);
  const box = await page.locator('#three').boundingBox();
  return [box.x + box.width / 2, box.y + box.height / 2];
}

test('middle-drag pans the bins preview', async ({ page }) => {
  const [cx, cy] = await ready(page);
  const before = await view(page);
  await page.mouse.move(cx, cy);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(cx + 150, cy, { steps: 8 });
  await page.mouse.up({ button: 'middle' });
  await page.waitForTimeout(150);
  const after = await view(page);
  expect(Math.hypot(after.panX - before.panX, after.panZ - before.panZ),
    'the look-at point should have moved across the floor').toBeGreaterThan(20);
  expect(after.theta, 'panning is not rotating').toBeCloseTo(before.theta, 5);
});

test('shift-drag pans, plain drag still rotates', async ({ page }) => {
  const [cx, cy] = await ready(page);
  const start = await view(page);

  await page.keyboard.down('Shift');
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx, cy + 120, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await page.waitForTimeout(150);
  const panned = await view(page);
  expect(Math.hypot(panned.panX - start.panX, panned.panZ - start.panZ)).toBeGreaterThan(20);

  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 100, cy, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(150);
  const rotated = await view(page);
  expect(rotated.theta, 'a plain drag rotates').not.toBeCloseTo(panned.theta, 3);
  expect(rotated.panX, 'and leaves the pan alone').toBeCloseTo(panned.panX, 5);
});

test('the baseplates preview takes the middle button too', async ({ page }) => {
  await H.openPlates(page);
  await page.waitForTimeout(900);
  await page.locator('#three').scrollIntoViewIfNeeded();
  await page.waitForTimeout(150);
  const box = await page.locator('#three').boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  const at = () => page.evaluate(() => [camera.position.x, camera.position.y]);
  const before = await at();
  await page.mouse.move(cx, cy);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(cx + 140, cy + 60, { steps: 8 });
  await page.mouse.up({ button: 'middle' });
  await page.waitForTimeout(300);
  const after = await at();
  expect(Math.hypot(after[0] - before[0], after[1] - before[1])).toBeGreaterThan(20);
});
