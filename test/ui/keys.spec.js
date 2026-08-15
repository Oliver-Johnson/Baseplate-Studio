/* How many connector keys the design needs, asked three times and answered once.
 *
 * The print plan reserved bed space by counting every seam junction; the key STL laid
 * out the junctions a key can actually be housed at. Those are the same number for most
 * layouts, which is why this survived — but a wall-housed key skips a seam whose overlap
 * is a single cell, because there is no wall junction there to sink one into, and a
 * staggered split makes exactly that kind of seam. Then the plan showed clips the STL
 * did not contain, and the 3MF plate carried the phantom ones as real geometry.
 *
 * So the fixture below is not "a plate with keys". It is specifically a layout where the
 * two counts differ, asserted as a precondition: on a layout where they agree this file
 * would pass against the bug it was written for, and this project has shipped four tests
 * that measured nothing.
 */
'use strict';
const { test, expect } = require('@playwright/test');
const H = require('./helpers.js');

const ready = (page) => page.waitForFunction(
  () => /ready/.test(document.getElementById('pieceTail').textContent), null, { timeout: 30000 });

/* Everything the page believes about keys, read out of its own model and its own export
   path rather than scraped from the DOM — the numbers on screen are downstream of these,
   so they cannot also be the evidence. */
const keyFacts = (page) => page.evaluate(() => {
  // the page's own answer to "which part", not a second copy of the decision — see
  // connector-part.spec.js, which is where that answer is held to the plate's
  const perKey = connectorPart().polys.length;
  const stl = keysStl();
  return {
    junctions: layout.seams.reduce((a, s) => a + s.junctions.length, 0),
    needed: keysNeeded(),
    // the mesh itself, counted by its own polygon budget rather than by the filename
    inStl: stl.polys.length / perKey,
    named: Number(/-x(\d+)\.stl$/.exec(stl.name)[1]),
    // what the 3MF plates will actually be built from, one item per placed unit
    onPlates: printPlan.plates.reduce(
      (a, pl) => a + pl.placed.filter((p) => p.id === 'key').length, 0),
  };
});

/* 268 mm square, staggered, bowtie keys in the wall. The stagger offsets the second
   band's cuts, which leaves a horizontal seam overlapping by one cell; computeLayout
   gives that seam a mid-cell junction at x + 0.5, and a wall-housed key cannot go
   there. Eight junctions, seven keys. */
async function stagger(page, mount) {
  await H.setField(page, 'drawerW', 268);
  await H.setField(page, 'drawerD', 268);
  await page.locator('#splitSeg button[data-v="staggered"]').click();
  await H.setField(page, 'connector', 'bowtie');
  await H.setField(page, 'keyMount', mount);
  await ready(page);
}

test('the print plan reserves exactly the keys the download contains', async ({ page }) => {
  const errors = await H.openPlates(page);
  await stagger(page, 'wall');

  const k = await keyFacts(page);
  expect(k.junctions,
    'fixture: this layout must have a junction no wall-housed key can use, or the ' +
    'test cannot tell the two counts apart').toBeGreaterThan(k.needed);
  expect(k.needed).toBeGreaterThan(0);

  expect(k.inStl, 'the STL must hold one key per key the page says is needed').toBe(k.needed);
  expect(k.named, 'the filename must say the same').toBe(k.needed);
  expect(k.onPlates, 'the print plan must reserve one unit per key, not one per junction')
    .toBe(k.needed);

  expect(errors, 'the page threw while being driven').toEqual([]);
});

/* The control. A floor-housed key uses every junction, so here the counts coincide —
   which proves the assertion above is holding the two together rather than simply
   asserting that keys are always filtered. */
test('a floor-housed key is planned at every junction', async ({ page }) => {
  const errors = await H.openPlates(page);
  await stagger(page, 'floor');

  const k = await keyFacts(page);
  expect(k.needed).toBe(k.junctions);
  expect(k.inStl).toBe(k.junctions);
  expect(k.onPlates).toBe(k.junctions);

  expect(errors, 'the page threw while being driven').toEqual([]);
});
