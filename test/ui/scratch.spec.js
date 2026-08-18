/* Designing one bin with no drawer around it.
 *
 * The thing that can go wrong here is not a mesh — it is the bin leaking into the
 * drawer, or the drawer's rules being applied to a bin that is not in it. Each case was
 * run against its own fix removed, and fails there.
 */
'use strict';
const { test, expect } = require('@playwright/test');
const { openBins, dragCells, clickCell, bins, setField } = require('./helpers');

const start = async (page) => {
  await page.locator('#scratchBinMap').click();
  await page.waitForTimeout(250);
};
const mode = (page) => page.evaluate(() => ({
  focus: document.body.classList.contains('binfocus'),
  loose: document.body.classList.contains('binscratch'),
  scratch: scratch ? { u: scratch.u, v: scratch.v, hUnits: scratch.hUnits } : null,
}));

test('a loose bin opens with no drawer, and is in no layer', async ({ page }) => {
  const errors = await openBins(page);
  await start(page);

  const m = await mode(page);
  expect(m.focus).toBe(true);
  expect(m.loose).toBe(true);
  expect(m.scratch).not.toBeNull();
  // it is not in the drawer, and the drawer is still empty
  expect(await bins(page)).toEqual([]);

  for (const sel of ['#s-drawer', '#s-layout', '#focusExit', '#doneRow', '#applyAll'])
    await expect(page.locator(sel)).toBeHidden();
  await expect(page.locator('#scratchAdd')).toBeVisible();
  await expect(page.locator('#scratchDrop')).toBeVisible();
  await expect(page.locator('#hUnits')).toBeVisible();
  expect(errors).toEqual([]);
});

test('editing a loose bin edits the loose bin, not the template for the next one',
  async ({ page }) => {
    await openBins(page);
    await start(page);
    await setField(page, 'hUnits', 7);
    await setField(page, 'u', 3);
    await setField(page, 'scoop', 9);

    const m = await mode(page);
    expect(m.scratch).toEqual({ u: 3, v: 1, hUnits: 7 });
    expect(await page.evaluate(() => scratch.scoop)).toBe(9);
    // the piece table is that bin and only that bin
    expect(await page.locator('#typeRows button[data-t]').count()).toBe(1);
    expect(await page.evaluate(() => document.getElementById('typeRows').textContent))
      .toContain('3×1×7');
  });

/* The drawer's questions have no answer for a bin that is not in it. A 10-wide bin is
 * fine loose and would be "outside the drawer grid" placed — but the printer's limits
 * still apply, because they are about the bin, not about where it sits. */
test('the checks drop the drawer rules and keep the printer ones', async ({ page }) => {
  await openBins(page);
  await start(page);
  await setField(page, 'u', 10);              // wider than the 7-cell default grid
  await page.waitForTimeout(250);

  const checks = () => page.evaluate(() => document.getElementById('warnings').textContent);
  expect(await checks()).not.toContain('outside the drawer grid');
  expect(await checks()).not.toContain('available');
  // 10 cells is 41.5 + 9x42 = 419.5 mm, past a 256 mm bed in either orientation
  expect(await checks()).toContain('too big for your');

  await setField(page, 'u', 2);
  await setField(page, 'hUnits', 40);         // 280 mm, past the 256 mm Z
  expect(await checks()).toContain('Z height');

  // and with nothing wrong, the all-clear is about the bin — "layout" is the drawer's
  // word, and a loose bin has no layout at all to be sound
  await setField(page, 'hUnits', 3);
  await page.waitForTimeout(250);
  expect(await checks()).toContain('This bin is sound');
  expect(await checks()).not.toContain('Layout is sound');
});

test('Add to the drawer places it, and says where before you press', async ({ page }) => {
  await openBins(page);
  await dragCells(page, [0, 0], [1, 1]);      // a 2x2 already in the front-left corner
  await start(page);
  await setField(page, 'u', 2);
  await setField(page, 'v', 2);
  await page.waitForTimeout(250);

  // the corner is taken, so it must name a spot past it rather than 1,1
  const why = await page.locator('#scratchWhy').textContent();
  expect(why).toMatch(/goes in at column \d+, row \d+/);
  expect(why).not.toContain('column 1, row 1');

  await page.locator('#scratchAdd').click();
  await page.waitForTimeout(300);

  const m = await mode(page);
  expect(m.loose).toBe(false);
  expect(m.focus).toBe(false);                 // back to the whole drawer
  const all = await bins(page);
  expect(all.length).toBe(2);
  // it landed somewhere free, not on top of the bin already there
  const placed = all[1];
  expect(placed.u).toBe(2);
  expect(placed.v).toBe(2);
  expect(placed.x === 0 && placed.y === 0).toBe(false);
  await expect(page.locator('#s-layout')).toBeVisible();
});

test('with nowhere for it to go, the button says so instead of failing on the press',
  async ({ page }) => {
    await openBins(page);
    await start(page);
    await setField(page, 'u', 10);            // wider than the grid itself
    await page.waitForTimeout(250);

    await expect(page.locator('#scratchAdd')).toBeDisabled();
    expect(await page.locator('#scratchWhy').textContent()).toContain('does not fit');
    expect(await bins(page)).toEqual([]);

    // fill the drawer instead: the reason changes to the other one
    await setField(page, 'u', 1);
    await page.waitForTimeout(200);
    await expect(page.locator('#scratchAdd')).toBeEnabled();
    await page.evaluate(() => { scratch = null; focused = false; readControls(); drawMap(); refresh(); });
    await page.locator('#fillRest').click();
    await page.waitForTimeout(400);
    await start(page);
    await page.waitForTimeout(250);
    await expect(page.locator('#scratchAdd')).toBeDisabled();
    expect(await page.locator('#scratchWhy').textContent()).toContain('no free');
  });

test('Discard throws it away and leaves the drawer exactly as it was', async ({ page }) => {
  await openBins(page);
  await dragCells(page, [0, 0], [0, 0]);
  const before = await bins(page);
  await start(page);
  await setField(page, 'hUnits', 9);

  await page.locator('#scratchDrop').click();
  await page.waitForTimeout(300);
  const m = await mode(page);
  expect(m.loose).toBe(false);
  expect(m.scratch).toBeNull();
  expect(await bins(page)).toEqual(before);
  await expect(page.locator('#s-layout')).toBeVisible();
});

/* One shared stack would mean an undo taken inside the loose bin restoring a drawer
 * that knows nothing about it, and an undo taken later in the drawer wiping a bin that
 * was never in the drawer to be restored to. */
test('the loose bin has its own history, and the drawer keeps its own', async ({ page }) => {
  await openBins(page);
  await dragCells(page, [0, 0], [0, 0]);
  await dragCells(page, [2, 0], [2, 0]);
  /* Fill the rest, because THAT is an action the drawer files on its undo stack —
     dragging a bin into being is not one, which is a gap in the tool rather than in
     this feature, and using it here would test nothing. */
  await page.locator('#fillRest').click();
  await page.waitForTimeout(400);
  const filled = (await bins(page)).length;
  expect(filled).toBeGreaterThan(2);

  /* Park a redo on the drawer's stack before opening the loose bin. This is the part
     that separates the two histories from one shared one: a single stack passes the
     undo checks below by luck of ordering, but the loose bin's first pushUndo clears
     the redo stack it is sharing — and the drawer's parked redo is gone for good. */
  await page.locator('#undoBtn').click();
  await page.waitForTimeout(400);
  expect((await bins(page)).length).toBe(2);
  await expect(page.locator('#redoBtn')).toBeEnabled();

  await start(page);
  await setField(page, 'u', 2);
  await setField(page, 'v', 2);
  await page.locator('#carveMode').click();
  await page.waitForTimeout(250);
  await page.locator('#focusmap rect').first().click();
  await page.waitForTimeout(250);
  expect(await page.evaluate(() => !!(scratch.cells && scratch.cells.length < 4))).toBe(true);

  // undo inside the loose bin puts the cell back and leaves the drawer alone
  await page.locator('#focusUndo').click();
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => !!(scratch.cells && scratch.cells.length < 4))).toBe(false);
  expect((await bins(page)).length).toBe(2);        // the drawer never moved
  expect(await page.evaluate(() => document.body.classList.contains('binscratch'))).toBe(true);

  /* And the drawer's own history came through untouched — including the redo parked on
     it before the loose bin was ever opened, which is the half a shared stack loses. */
  await page.locator('#scratchDrop').click();
  await page.waitForTimeout(300);
  await expect(page.locator('#redoBtn')).toBeEnabled();
  await page.locator('#redoBtn').click();
  await page.waitForTimeout(400);
  expect((await bins(page)).length).toBe(filled);
});

/* A loose bin has no drawer, so every cell can always come back — asking canPlace would
 * consult the grid at 0,0 and refuse cells a bin in the corner happens to own. */
test('carving a loose bin can always put a cell back', async ({ page }) => {
  await openBins(page);
  await dragCells(page, [0, 0], [1, 1]);     // a 2x2 sitting exactly where 0,0 is
  await start(page);
  await setField(page, 'u', 2);
  await setField(page, 'v', 2);
  await page.locator('#carveMode').click();
  await page.waitForTimeout(250);
  expect(await page.locator('#focusmap rect.blocked').count()).toBe(0);

  const cell = page.locator('#focusmap rect').first();
  await cell.click();
  await page.waitForTimeout(250);
  expect(await page.evaluate(() => scratch.cells.length)).toBe(3);
  await page.locator('#focusmap rect').first().click();   // and back again
  await page.waitForTimeout(250);
  expect(await page.evaluate(() => scratch.cells)).toBeNull();
});

test('a loose bin survives a reload, and does not become a drawer bin', async ({ page }) => {
  await openBins(page);
  await start(page);
  await setField(page, 'u', 3);
  await setField(page, 'hUnits', 4);
  await page.waitForTimeout(800);              // the hash write is debounced
  expect(page.url()).toContain('bs=');

  await page.reload();
  await page.waitForTimeout(800);
  const m = await mode(page);
  expect(m.loose).toBe(true);
  expect(m.scratch).toEqual({ u: 3, v: 1, hUnits: 4 });
  expect(await bins(page)).toEqual([]);        // still in no layer
});

/* A loose bin has nowhere to go "back" to, so Escape must not be a third, silent exit
 * that has to guess between placing it and throwing it away. */
test('Escape leaves carving but will not throw a loose bin away', async ({ page }) => {
  await openBins(page);
  await start(page);
  await setField(page, 'u', 2);
  await setField(page, 'v', 2);
  await page.locator('#carveMode').click();
  await page.waitForTimeout(200);
  await expect(page.locator('#s-focuscarve')).toBeVisible();

  await page.evaluate(() => document.activeElement.blur());
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  await expect(page.locator('#s-focuscarve')).toBeHidden();
  expect((await mode(page)).loose).toBe(true);

  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  expect((await mode(page)).loose).toBe(true);   // still here, still yours
});
