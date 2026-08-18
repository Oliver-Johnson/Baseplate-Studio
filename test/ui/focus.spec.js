/* Single-bin focus mode.
 *
 * The feature is a VIEW: no geometry changes, so nothing here checks a mesh. What it
 * can get wrong is the mode itself — hiding something and not putting it back, editing
 * a bin that has stopped existing, or narrowing a list and forgetting to widen it. Each
 * case below was run against its own fix removed, and fails there.
 */
'use strict';
const { test, expect } = require('@playwright/test');
const { openBins, dragCells, clickCell, bins, setField } = require('./helpers');

/* Place one bin and open it on its own. Selection comes from a real click on the map,
 * so the route the test takes is the route a person takes. */
async function focusOne(page, from = [0, 0], to = [0, 0]) {
  await dragCells(page, from, to);
  await clickCell(page, from[0], from[1]);
  await page.locator('#focusBin').click();
  await page.waitForTimeout(250);
}
const isFocused = (page) => page.evaluate(() => document.body.classList.contains('binfocus'));

test('focus hides the drawer surfaces, and leaving puts every one of them back', async ({ page }) => {
  const errors = await openBins(page);
  await focusOne(page);

  expect(await isFocused(page)).toBe(true);
  await expect(page.locator('#focusbar')).toBeVisible();
  for (const sel of ['#s-drawer', '#s-layout', '#layerTabs', '#fillwrap', '#applyAll'])
    await expect(page.locator(sel)).toBeHidden();
  // the settings are the point of the mode, so they had better still be there
  await expect(page.locator('#hUnits')).toBeVisible();
  await expect(page.locator('#s-printer')).toBeVisible();

  await page.locator('#focusExit').click();
  await page.waitForTimeout(250);
  expect(await isFocused(page)).toBe(false);
  await expect(page.locator('#focusbar')).toBeHidden();
  for (const sel of ['#s-drawer', '#s-layout', '#layerTabs', '#fillwrap'])
    await expect(page.locator(sel)).toBeVisible();
  expect(errors).toEqual([]);
});

/* drawMap() writes an inline grid-template-columns on .stagetop sized to the map. An
 * inline style beats the class rule, so without applyFocus() clearing it the preview
 * stays pinned to a column shaped like a map that is no longer on the page.
 *
 * The explicit viewport is what makes this bite. The suite otherwise runs at 1280 —
 * devices['Desktop Chrome'] in the project's `use` overrides the 1440 set above it —
 * and at exactly 1280 the stylesheet's max-width:1280px rule has ALREADY collapsed the
 * grid to one column, so drawMap never writes the inline style and there is nothing for
 * the bug to leave behind. Two columns have to genuinely exist first. */
test.describe('wide enough for two columns', () => {
  test.use({ viewport: { width: 1600, height: 1000 } });

  test('the preview takes the whole stage once the map card is gone', async ({ page }) => {
    await openBins(page);
    await page.waitForTimeout(200);
    const grid = () => page.evaluate(() => {
      const t = document.querySelector('.stagetop');
      return { inline: t.style.gridTemplateColumns,
               tracks: getComputedStyle(t).gridTemplateColumns.trim().split(/\s+/).length };
    });
    // the drawer view really is two columns here, and really did measure itself
    expect((await grid()).tracks).toBe(2);
    expect((await grid()).inline).not.toBe('');

    await focusOne(page);
    const inFocus = await grid();
    expect(inFocus.inline).toBe('');       // the measurement went with the map
    expect(inFocus.tracks).toBe(1);

    await page.locator('#focusExit').click();
    await page.waitForTimeout(300);
    expect((await grid()).tracks).toBe(2); // and both come back together
  });

  /* applyFocus clears the inline columns on every pass, which is right for the default
     focus view because there is no map in it. The carve grid then has to state its own,
     or the `auto` track grows to half the stage and six cells sit adrift in an empty
     card. */
  test('the carve grid gets a column its own size, not half the stage', async ({ page }) => {
    await openBins(page);
    await focusOne(page, [0, 0], [1, 2]);          // a 2x3
    await page.locator('#carveMode').click();
    await page.waitForTimeout(300);

    const m = await page.evaluate(() => {
      const t = document.querySelector('.stagetop');
      const svg = document.getElementById('focusmap');
      return { first: parseFloat(getComputedStyle(t).gridTemplateColumns.split(' ')[0]),
               map: svg.getBoundingClientRect().width,
               tracks: getComputedStyle(t).gridTemplateColumns.trim().split(/\s+/).length };
    });
    expect(m.tracks).toBe(2);
    // the column is the map plus a margin, not an expanded auto track
    expect(m.first).toBeGreaterThan(m.map);
    expect(m.first).toBeLessThan(m.map + 60);
  });
});

test('an edit made in focus is an edit to that bin, and survives leaving', async ({ page }) => {
  await openBins(page);
  await focusOne(page);
  await setField(page, 'hUnits', 6);
  await setField(page, 'scoop', 8);
  await page.locator('#focusExit').click();
  await page.waitForTimeout(250);
  const [b] = await bins(page);
  expect(b.hUnits).toBe(6);
  expect(await page.evaluate(() => B()[0].scoop)).toBe(8);
});

test('the piece table narrows to the focused bin and widens again after', async ({ page }) => {
  await openBins(page);
  await dragCells(page, [0, 0], [0, 0]);
  await dragCells(page, [2, 0], [3, 1]);     // a second, differently shaped bin
  const rows = () => page.locator('#typeRows tr').count();
  expect(await rows()).toBe(2);

  await clickCell(page, 0, 0);
  await page.locator('#focusBin').click();
  await page.waitForTimeout(250);
  expect(await rows()).toBe(1);
  expect(await page.evaluate(() => document.getElementById('typeRows').textContent)).toContain('1×1');

  await page.locator('#focusExit').click();
  await page.waitForTimeout(250);
  expect(await rows()).toBe(2);
});

/* types() drops printed bins, which is right for a print queue and wrong when you are
 * looking at one bin and asking for its STL — that answers with an empty table and no
 * download at all. */
test('a bin marked printed still has a download while it is the one in focus', async ({ page }) => {
  await openBins(page);
  await dragCells(page, [0, 0], [0, 0]);
  await clickCell(page, 0, 0);
  await page.locator('#done').check();
  await page.waitForTimeout(250);
  expect(await page.evaluate(() => document.getElementById('typeRows').textContent))
    .toContain('no bins placed');

  await page.locator('#focusBin').click();
  await page.waitForTimeout(250);
  expect(await page.evaluate(() => document.getElementById('typeRows').textContent))
    .not.toContain('no bins placed');
  expect(await page.locator('#typeRows button[data-t]').count()).toBe(1);
});

test('there is no map until Carve asks for one, and it is this bin only', async ({ page }) => {
  await openBins(page);
  await focusOne(page, [0, 0], [1, 1]);            // a 2x2, so a cell can be spared
  await expect(page.locator('#s-focuscarve')).toBeHidden();

  await page.locator('#carveMode').click();
  await page.waitForTimeout(250);
  await expect(page.locator('#s-focuscarve')).toBeVisible();
  expect(await page.locator('#focusmap rect').count()).toBe(4);

  await page.locator('#carveMode').click();        // "Done carving"
  await page.waitForTimeout(250);
  await expect(page.locator('#s-focuscarve')).toBeHidden();
});

test('clicking a cell of the focus map carves that cell, front at the bottom', async ({ page }) => {
  await openBins(page);
  await focusOne(page, [0, 0], [1, 1]);
  await page.locator('#carveMode').click();
  await page.waitForTimeout(250);

  /* The bottom-left rect must be the bin's FRONT-left cell, 0,0 — the drawer map flips
     its rows the same way and both carry a "front" marker beneath them. Picking the
     rect by geometry rather than by index is what makes this catch a flipped axis: by
     index it would pass whichever way round the rows had been drawn. */
  const target = await page.evaluate(() => {
    const rs = [...document.querySelectorAll('#focusmap rect')];
    const maxY = Math.max(...rs.map((r) => +r.getAttribute('y')));
    const minX = Math.min(...rs.map((r) => +r.getAttribute('x')));
    const r = rs.find((q) => +q.getAttribute('y') === maxY && +q.getAttribute('x') === minX);
    const b = r.getBoundingClientRect();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  });
  await page.mouse.click(target.x, target.y);
  await page.waitForTimeout(250);

  const [b] = await bins(page);
  expect(b.carved).toBe(true);
  expect(b.cells).toEqual(['0,1', '1,0', '1,1']);   // 0,0 is the one that went
});

test('Escape leaves carving first and focus second', async ({ page }) => {
  await openBins(page);
  await focusOne(page, [0, 0], [1, 1]);
  await page.locator('#carveMode').click();
  await page.waitForTimeout(200);
  await expect(page.locator('#s-focuscarve')).toBeVisible();

  await page.evaluate(() => document.activeElement.blur());
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  await expect(page.locator('#s-focuscarve')).toBeHidden();
  expect(await isFocused(page)).toBe(true);        // still in the mode, just not carving

  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  expect(await isFocused(page)).toBe(false);
});

/* Delete, an undo, a layer removed and a split can all take the focused bin away. They
 * all end in readControls(), which is why the mode is re-validated there rather than at
 * each of those four call sites. */
test('deleting the focused bin drops back to the drawer instead of stranding the page', async ({ page }) => {
  const errors = await openBins(page);
  await focusOne(page);
  await page.evaluate(() => document.activeElement.blur());
  await page.keyboard.press('Delete');
  await page.waitForTimeout(300);

  expect(await isFocused(page)).toBe(false);
  expect(await bins(page)).toEqual([]);
  await expect(page.locator('#s-layout')).toBeVisible();
  await expect(page.locator('#fillwrap')).toBeVisible();
  expect(errors).toEqual([]);
});

/* Focus is defined by the selection and applySnap clears it, so an undone carve used to
 * end the mode the carve was performed in — which is where undo gets used most. */
test('undoing a carve keeps you in focus', async ({ page }) => {
  await openBins(page);
  await focusOne(page, [0, 0], [1, 1]);
  await page.locator('#carveMode').click();
  await page.waitForTimeout(200);
  await page.locator('#focusmap rect').first().click();
  await page.waitForTimeout(250);
  expect((await bins(page))[0].carved).toBe(true);

  await page.locator('#focusUndo').click();
  await page.waitForTimeout(300);
  expect((await bins(page))[0].carved).toBe(false);
  expect(await isFocused(page)).toBe(true);
});

test('a reload comes back to the bin you were focused on', async ({ page }) => {
  await openBins(page);
  await focusOne(page, [1, 0], [1, 0]);
  await setField(page, 'hUnits', 5);
  await page.waitForTimeout(800);                  // the hash write is debounced
  expect(page.url()).toContain('bf=');

  await page.reload();
  await page.waitForTimeout(800);
  expect(await isFocused(page)).toBe(true);
  expect(await page.evaluate(() => B()[selected].hUnits)).toBe(5);
  await expect(page.locator('#s-layout')).toBeHidden();
});

/* The toggle's value has to survive the mode, so the shell is suppressed rather than
 * switched off — and showScene and syncDrawer have to agree about that. */
test('the drawer shell is not drawn around a single bin', async ({ page }) => {
  await openBins(page);
  await dragCells(page, [0, 0], [0, 0]);
  await page.locator('#showDrawer').check();
  await page.waitForTimeout(400);
  const walls = () => page.evaluate(() => drawerGroup.children.length);
  expect(await walls()).toBeGreaterThan(0);

  await clickCell(page, 0, 0);
  await page.locator('#focusBin').click();
  await page.waitForTimeout(400);
  expect(await walls()).toBe(0);
  // and it is still ticked, so leaving gives it back
  await page.locator('#focusExit').click();
  await page.waitForTimeout(400);
  expect(await page.locator('#showDrawer').isChecked()).toBe(true);
  expect(await walls()).toBeGreaterThan(0);
});
