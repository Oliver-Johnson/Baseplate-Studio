/* Right-click a bin.
 *
 * The actions on a bin were scattered: delete and duplicate are buttons in the rail,
 * the printed mark is a checkbox two panels away, and moving a bin between layers could
 * not be done at all — you deleted it and drew it again on the other tab. All of it is
 * now on the thing itself, on the map and in the preview.
 *
 * The preview matters as much as the map here, because the map shows one layer at a
 * time and the preview is where you SEE that a bin is on the wrong one.
 */
'use strict';
const { test, expect } = require('@playwright/test');
const H = require('./helpers.js');

const settle = (page) => page.waitForTimeout(600);
const items = (page) => page.$$eval('#ctxmenu button',
  (els) => els.map((e) => e.textContent + (e.disabled ? ' [disabled]' : '')));

/* A point on the canvas that is over a bin AND not covered by anything.
 * The preview is tall and narrow at test width, so the default framing can leave a
 * corner bin off screen entirely — hence backing off until it is in view rather than
 * assuming the middle of the canvas will do. */
async function binPointInPreview(page) {
  await page.locator('#three').scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  return page.evaluate(() => {
    const cv = document.getElementById('three');
    const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
    for (let tries = 0; tries < 8; tries++) {
      render();
      const c = cv.getBoundingClientRect();
      for (let fy = 0.08; fy < 0.95; fy += 0.03)
        for (let fx = 0.08; fx < 0.95; fx += 0.03) {
          const x = c.left + c.width * fx, y = c.top + c.height * fy;
          if (document.elementFromPoint(x, y) !== cv) continue;
          ndc.set(fx * 2 - 1, -(fy * 2 - 1));
          ray.setFromCamera(ndc, camera);
          if (ray.intersectObjects(group.children, false)
                 .some((h) => h.object.userData && h.object.userData.bin))
            return { x: Math.round(c.width * fx), y: Math.round(c.height * fy) };
        }
      dist = Math.min(4000, dist * 1.6);      // back off and look again
    }
    return null;
  });
}

test('right-click on the map offers the actions for that bin', async ({ page }) => {
  await H.openBins(page);
  await H.dragCells(page, [0, 0], [1, 1]);
  await settle(page);
  const pt = await H.cellPoint(page, 0, 0);
  await page.mouse.click(pt.x, pt.y, { button: 'right' });
  await settle(page);

  await expect(page.locator('#ctxmenu')).toBeVisible();
  await expect(page.locator('#ctxmenu .head')).toHaveText('2×2×3');
  const list = await items(page);
  expect(list).toContain('Mark as printed');
  expect(list).toContain('Rename…');
  expect(list).toContain('Duplicate');
  expect(list).toContain('Delete');
  // with one layer there is nowhere to move it, and the entry says so rather than lying
  expect(list.join('|')).toMatch(/Move to layer….*\[disabled\]|Move to a new layer on top/);
});

test('the menu marks printed, and closes after acting', async ({ page }) => {
  await H.openBins(page);
  await H.dragCells(page, [0, 0], [0, 0]);
  await settle(page);
  const pt = await H.cellPoint(page, 0, 0);
  await page.mouse.click(pt.x, pt.y, { button: 'right' });
  await settle(page);
  await page.click('#ctxmenu button:has-text("Mark as printed")');
  await settle(page);
  expect(await page.evaluate(() => B().filter((b) => b.done).length)).toBe(1);
  await expect(page.locator('#ctxmenu')).toBeHidden();

  // and it offers the reverse next time, rather than the same entry twice
  await page.mouse.click(pt.x, pt.y, { button: 'right' });
  await settle(page);
  expect(await items(page)).toContain('Mark as not printed');
});

test('a bin can be moved to another layer, which was impossible before', async ({ page }) => {
  await H.openBins(page);
  await H.dragCells(page, [0, 0], [0, 0]);
  await settle(page);
  await page.click('#addLayer');
  await settle(page);
  await page.evaluate(() => { cur = 0; drawLayerTabs(); drawMap(); refresh(); });
  await settle(page);

  const pt = await H.cellPoint(page, 0, 0);
  await page.mouse.click(pt.x, pt.y, { button: 'right' });
  await settle(page);
  await page.click('#ctxmenu button:has-text("Move to layer 2")');
  await settle(page);

  expect(await page.evaluate(() => layers[0].bins.length), 'left the first layer').toBe(0);
  expect(await page.evaluate(() => layers[1].bins.length), 'arrived on the second').toBe(1);
  expect(await page.evaluate(() => cur), 'and follows it there').toBe(1);
});

test('a layer that would overlap is offered but refused, not silently allowed', async ({ page }) => {
  await H.openBins(page);
  await H.dragCells(page, [0, 0], [0, 0]);
  await settle(page);
  await page.click('#addLayer');
  await settle(page);
  await H.dragCells(page, [0, 0], [0, 0]);          // same cell on layer 2
  await settle(page);
  await page.evaluate(() => { cur = 0; drawLayerTabs(); drawMap(); refresh(); });
  await settle(page);

  const pt = await H.cellPoint(page, 0, 0);
  await page.mouse.click(pt.x, pt.y, { button: 'right' });
  await settle(page);
  const list = await items(page);
  expect(list.find((t) => t.startsWith('Move to layer 2')),
    'the cell is taken up there, so the move must be refused up front')
    .toMatch(/\(occupied\).*\[disabled\]/);
});

test('right-click in the preview opens the menu for the bin under the cursor', async ({ page }) => {
  await H.openBins(page);
  await H.dragCells(page, [0, 0], [1, 1]);
  await settle(page);
  const pos = await binPointInPreview(page);
  expect(pos, 'could not find the bin on screen to click').not.toBeNull();

  await page.locator('#three').click({ button: 'right', position: pos });
  await settle(page);
  await expect(page.locator('#ctxmenu')).toBeVisible();
  await page.click('#ctxmenu button:has-text("Mark as printed")');
  await settle(page);
  expect(await page.evaluate(() => B().filter((b) => b.done).length)).toBe(1);
});

test('Escape closes the menu, and clicking away closes it', async ({ page }) => {
  await H.openBins(page);
  await H.dragCells(page, [0, 0], [0, 0]);
  await settle(page);
  const pt = await H.cellPoint(page, 0, 0);

  await page.mouse.click(pt.x, pt.y, { button: 'right' });
  await settle(page);
  await page.keyboard.press('Escape');
  await expect(page.locator('#ctxmenu')).toBeHidden();

  await page.mouse.click(pt.x, pt.y, { button: 'right' });
  await settle(page);
  await page.mouse.click(pt.x + 200, pt.y);
  await expect(page.locator('#ctxmenu')).toBeHidden();
});
