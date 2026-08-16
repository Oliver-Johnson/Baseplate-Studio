/* Does a reload keep the work?
 *
 * The tool has no accounts and no server, and until now that also meant a refresh, a
 * crashed tab or a stray Ctrl+R lost a drawer someone had spent twenty minutes laying
 * out — unless they had known to press "Copy settings link" first. The state was always
 * serialisable; nothing was writing it down.
 *
 * These reload the real page rather than inspecting location.hash, because the hash
 * being right is not the claim. The claim is that the design comes back, and only a
 * round trip through loadFromHash can say that. A test that asserted the URL contained
 * the right characters would have passed against a hash the page could not read.
 */
'use strict';
const { test, expect } = require('@playwright/test');
const H = require('./helpers.js');

const settle = (page) => page.waitForTimeout(900);   // past the 400 ms debounce

test('the baseplates page comes back the way you left it', async ({ page }) => {
  await H.openPlates(page);
  await H.setField(page, 'drawerW', '512');
  await page.selectOption('#connector', 'hclip');
  await settle(page);

  await page.reload();
  await page.waitForFunction(() => typeof THREE !== 'undefined');
  await settle(page);

  expect(await page.inputValue('#drawerW')).toBe('512');
  expect(await page.inputValue('#connector')).toBe('hclip');
  // and the page believes it too, rather than just showing the value
  expect(await page.$$eval('.connfig',
    (els) => els.filter((e) => e.style.display !== 'none').map((e) => e.dataset.joint)))
    .toEqual(['hclip']);
});

test('the bins page comes back with the bins still in it', async ({ page }) => {
  await H.openBins(page);
  await H.dragCells(page, [0, 0], [1, 1]);
  await H.dragCells(page, [3, 3], [3, 3]);
  await settle(page);
  const before = await H.bins(page);
  expect(before.length).toBe(2);

  await page.reload();
  await page.waitForFunction(() => typeof THREE !== 'undefined');
  await settle(page);

  const after = await H.bins(page);
  expect(after.length).toBe(2);
  expect(after.map((b) => [b.x, b.y, b.u, b.v]).sort())
    .toEqual(before.map((b) => [b.x, b.y, b.u, b.v]).sort());
});

/* A link someone followed must win over anything the page would have written. The guard
   exists because an init-time save would otherwise overwrite the incoming design with
   the defaults the page had not finished loading yet — and the person who sent the link
   would never know their recipient saw a different drawer. */
test('following a shared link does not overwrite it with the defaults', async ({ page }) => {
  await H.openPlates(page);
  await H.setField(page, 'drawerW', '378');
  await settle(page);
  const shared = await page.evaluate(() => location.href);
  expect(shared).toContain('#');

  await page.goto('about:blank');
  await page.goto(shared);
  await page.waitForFunction(() => typeof THREE !== 'undefined');
  await settle(page);
  expect(await page.inputValue('#drawerW')).toBe('378');
});

/* Saving must not cost you the back button.
 *
 * replaceState and pushState both keep the design across a reload, so every test above
 * passes with either — which is exactly why this one exists. pushState would file a
 * history entry per settled edit, turning Back into an undo nobody asked for and making
 * "leave this page" take one press per change you made. Twenty minutes of layout would
 * trap you on the tool.
 */
test('editing does not fill the history with entries', async ({ page }) => {
  await H.openPlates(page);
  const start = await page.evaluate(() => history.length);
  for (const w of ['400', '450', '500', '550']) {
    await H.setField(page, 'drawerW', w);
    await settle(page);
  }
  expect(await page.evaluate(() => history.length)).toBe(start);
});
