/* What the bins page says without being asked.
 *
 * Everything here was found by driving the real page rather than reading the code, and
 * every case is something the page already knew and did not show: four correct errors
 * about a bin no printer can make, rendered a thousand pixels below the fold; a drawer
 * carried across from the baseplates tool and confirmed only inside a collapsed panel;
 * a map with a front and a back and nothing on screen saying which end is which.
 *
 * The measurements are deliberate. "The user cannot see it" is a claim about pixels, so
 * these assert against boundingBox and the viewport rather than against the presence of
 * an element that may well be scrolled into the next county.
 */
'use strict';
const { test, expect } = require('@playwright/test');
const H = require('./helpers.js');

test.beforeEach(async ({ page }) => {
  page.__errors = await H.openBins(page);
});
test.afterEach(async ({ page }) => {
  expect(page.__errors, 'the page threw while being driven').toEqual([]);
});

/* A layout the page has to object to, built through the interface rather than pushed
   into the model: a 3×3 bin forty units tall. That is 283.9 mm of bin in 79.8 mm of
   drawer and well past the printer's Z, so it produces three separate errors at once.
   Three by three rather than the whole drawer on purpose — the errors are the point,
   and a 63-cell bin costs seconds of mesh building per edit to say the same thing. */
async function unprintable(page) {
  await H.dragCells(page, [0, 0], [2, 2]);
  await H.setField(page, 'hUnits', 40);
  await page.waitForTimeout(300);
}

const errCount = (page) => page.locator('#warnings .w.err').count();

test('a bin that cannot be printed says so beside the map, not only in a panel',
  async ({ page }) => {
    await unprintable(page);

    const n = await errCount(page);
    expect(n, 'fixture: this layout must produce several errors').toBeGreaterThan(2);

    // the count rides in the panel header, which is legible with the body scrolled past
    await expect(page.locator('#warnBadge')).toBeVisible();
    await expect(page.locator('#warnBadge')).toHaveText(`· ${n} problems`);

    // and the errors themselves are under the map, where the work is happening
    const stage = page.locator('#mapChecks');
    await expect(stage).toBeVisible();
    await expect(stage).toBeInViewport();
    expect(await stage.locator('#mapChecksList > div').count(),
           'every error the panel lists is repeated under the map').toBe(n);
    await expect(stage).toContainText('283.9 mm');

    /* Under the map, not merely somewhere in the document: the whole complaint was that
       the messages lived a long way from the thing they describe. */
    const map = await page.locator('#fillmap').boundingBox();
    const box = await stage.boundingBox();
    expect(box.y).toBeGreaterThan(map.y);
    expect(box.y - (map.y + map.height),
           'the errors sit just below the map, not a screen away').toBeLessThan(120);
  });

/* The other half: a badge that is written once and never cleared is worse than none,
   because it turns every sound layout into a false alarm. */
test('a sound layout carries no badge and nothing under the map', async ({ page }) => {
  await unprintable(page);
  await expect(page.locator('#mapChecks')).toBeVisible();

  await H.setField(page, 'hUnits', 3);
  await page.waitForTimeout(300);
  expect(await errCount(page)).toBe(0);
  await expect(page.locator('#warnBadge')).toBeHidden();
  await expect(page.locator('#mapChecks')).toBeHidden();
  // the panel still has something to say — it is the errors that have gone, not the panel
  await expect(page.locator('#warnings')).toContainText('spare');
});

/* Opening the panel on an edge rather than on every draw. Both halves matter: a panel
   that never opens leaves the errors where they were, and one that reopens on every
   keystroke fights anyone who shut it on purpose. */
test('the checks panel opens itself when something first goes wrong, and stays shut if you shut it',
  async ({ page }) => {
    const panel = page.locator('#s-warn');
    const header = page.locator('#s-warn>h2>button');
    await expect(panel).not.toHaveClass(/closed/);

    await header.click();                       // shut it while the layout is sound
    await expect(panel).toHaveClass(/closed/);

    await unprintable(page);
    await expect(panel, 'a new error has to open the panel').not.toHaveClass(/closed/);
    await expect(header).toHaveAttribute('aria-expanded', 'true');

    await header.click();                       // shut it again, errors still standing
    await expect(panel).toHaveClass(/closed/);
    await H.setField(page, 'hUnits', 41);       // still wrong, and still your decision
    await page.waitForTimeout(300);
    expect(await errCount(page)).toBeGreaterThan(2);
    await expect(panel, 'a panel you closed must stay closed while the same errors stand')
      .toHaveClass(/closed/);
    await expect(header).toHaveAttribute('aria-expanded', 'false');
  });

/* On a phone the first screen was Width, Depth, Height, Wall, Floor and Dividers — for
   a bin nobody had placed — and the drawer map was 1600 px down the page. */
test('the first screen is the drawer, not the settings for a bin nobody has placed',
  async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await H.openBins(page);

    await expect(page.locator('#s-bin')).toHaveClass(/closed/);
    await expect(page.locator('#u')).toBeHidden();

    const map = await page.locator('#fillmap').boundingBox();
    const vh = await page.evaluate(() => window.innerHeight);
    expect(map.y, 'the map has to start above the fold').toBeLessThan(vh);
    expect(Math.min(map.y + map.height, vh) - map.y,
           'and enough of it has to be there to read').toBeGreaterThan(120);
  });

/* Panel 03 ships closed, so something has to open it. Selecting a bin is that moment:
   it is the point at which those fields describe a thing that exists. */
test('selecting a bin opens the panel that describes it', async ({ page }) => {
  await expect(page.locator('#s-bin')).toHaveClass(/closed/);

  await H.dragCells(page, [0, 0], [1, 1]);
  await expect(page.locator('#s-bin')).not.toHaveClass(/closed/);
  await expect(page.locator('#s-bin>h2>button')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#binPanelTitle')).toHaveText('Selected bin');
  await expect(page.locator('#u')).toBeVisible();
});

/* Arriving from the baseplates tool with a 412 × 297 drawer, the only thing on screen
   that mentioned it was inside collapsed panel 01, and the map — unlike the cut map it
   was drawn to match — named neither the drawer nor which end was the front. */
test('the map says which drawer it is showing, and which end is the front',
  async ({ page }) => {
    /* The page is already open, and changing only the hash of the URL it is already on
       is not a navigation — the layout is read once, at load. Reload, or this measures
       the default drawer while claiming to measure the one that carried across. */
    await page.goto(H.BINS_URL + '#w=412&d=297');
    await page.reload();
    await page.waitForFunction(() => !!document.getElementById('fillmap'));
    await page.waitForTimeout(300);

    await expect(page.locator('#coverage'))
      .toHaveText(/0 bins · 0\/63 cells .* 9 × 7 grid in a 412 × 297 mm drawer/);

    const front = page.locator('#s-layout').getByText('front of drawer');
    await expect(front).toBeVisible();
    const map = await page.locator('#fillmap').boundingBox();
    const tag = await front.boundingBox();
    expect(tag.y, 'the marker belongs at the front edge, under the map')
      .toBeGreaterThan(map.y + map.height - 4);
    expect(tag.y - (map.y + map.height)).toBeLessThan(40);
    // and horizontally under the map rather than off beside it
    expect(tag.x + tag.width / 2).toBeGreaterThan(map.x);
    expect(tag.x + tag.width / 2).toBeLessThan(map.x + map.width);

    // the same two facts for anyone who cannot see the picture
    const label = await page.locator('#fillmap').getAttribute('aria-label');
    expect(label).toMatch(/front of the drawer at the bottom/i);
    expect(label).toContain('412 by 297 millimetre drawer');
  });

/* Someone who already owns baseplates knows how many cells they have, not how many
   millimetres, and was left multiplying by 42 before the tool would talk to them. */
test('the grid can be given in cells, and the two ways of saying it agree',
  async ({ page }) => {
    await H.setField(page, 'gridX', 4);
    await H.setField(page, 'gridY', 6);

    expect(await page.evaluate(() => [state.drawerW, state.drawerD])).toEqual([168, 252]);
    expect(await page.evaluate(() => [grid().nx, grid().ny])).toEqual([4, 6]);
    await expect(page.locator('#coverage')).toContainText('4 × 6 grid in a 168 × 252 mm drawer');

    // and it follows the millimetres back, or the two fields can disagree on screen
    await H.setField(page, 'drawerW', 306);
    await expect(page.locator('#gridX')).toHaveValue('7');
    await expect(page.locator('#gridY')).toHaveValue('6');
  });

/* showScene returns early when there is nothing to draw, and the canvas label was
   written after that return — so an empty preview kept the label the markup ships,
   "3D preview of the bins, loading", for ever. Empty is where every visitor starts, so
   a screen reader was told the preview was still loading until the first bin went in.
   The drawer shell draws something real into an empty preview and takes the other path,
   so it is checked too: the two empty states are not the same picture. */
test('the empty preview is labelled with what is on the screen, not with "loading"',
  async ({ page }) => {
    const label = () => page.locator('#three').getAttribute('aria-label');
    const onScreen = (await page.locator('#threeempty').textContent()).trim();
    expect(onScreen, 'fixture: the empty preview must say something').toBeTruthy();

    expect(await label()).not.toMatch(/loading/i);
    expect(await label(), 'the label should quote the message, not paraphrase it')
      .toContain(onScreen);

    await page.evaluate(() => {
      const t = document.getElementById('showDrawer');
      t.checked = true; t.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForTimeout(300);
    expect(await label()).toMatch(/drawer/i);
    expect(await label()).not.toMatch(/loading/i);
  });

/* "1 bin(s) · 6/63 cells · 1 bins over 1 layer(s)" — both forms in one line, and the
   same count three times. The page is read by people. */
test('counts read as English, on the page and in the export dialog', async ({ page }) => {
  await H.dragCells(page, [0, 0], [0, 0]);
  await page.locator('#openExport').click();
  await page.waitForTimeout(400);

  const text = await page.evaluate(() => {
    // collapsed bodies are not on screen, so open everything before reading it
    document.querySelectorAll('section.p.closed').forEach((s) => s.classList.remove('closed'));
    return document.body.innerText + '\n' + document.getElementById('exportDlg').innerText;
  });

  expect(text, 'nothing on the page should be hedging its plural').not.toMatch(/\(s\)/);
  expect(text, 'a plural where one is meant').not.toMatch(/\b1 (bins|layers|plates|types|problems)\b/);
  expect(text, 'a singular where several are meant')
    .not.toMatch(/\b(0|[2-9]\d*) (bin|layer|plate|problem|type)(?!s)/);
  // and it really is saying the singular somewhere, or the assertions above are empty
  expect(text).toMatch(/\b1 bin\b/);
});
