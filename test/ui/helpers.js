/* Shared driving for the bins page.
 *
 * Every one of these helpers exists because the map is an SVG with a viewBox and
 * preserveAspectRatio, so its internal coordinates are NOT its CSS pixels: the
 * element letterboxes, and measuring across getBoundingClientRect once produced a
 * ~190 px dead margin and a pointer offset that felt like the map was ignoring
 * clicks. getScreenCTM is the only mapping that accounts for it.
 */
'use strict';
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..', '..');
const BINS_URL = pathToFileURL(path.join(ROOT, 'bins', 'index.html')).href;
const PLATES_URL = pathToFileURL(path.join(ROOT, 'index.html')).href;
const CELL = 40;   // the map's own viewBox units per grid cell

async function openBins(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(BINS_URL);
  await page.waitForFunction(() => !!document.getElementById('fillmap'));
  await page.waitForTimeout(200);
  return errors;
}

/* Viewport coordinates of the centre of grid cell (gx, gy). Front of the drawer is
   the bottom of the map, so grid y counts up from there while SVG y counts down. */
async function cellPoint(page, gx, gy) {
  /* Scroll first, then measure. page.mouse works in viewport coordinates, and the
     map sits well down a long page — measuring before scrolling gives coordinates
     that are off-screen, so the drag lands nowhere and the test sees an empty
     drawer rather than the bug it was written for. */
  await page.evaluate(() =>
    document.getElementById('fillmap').scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(80);
  return page.evaluate(({ gx, gy, CELL }) => {
    const svg = document.getElementById('fillmap');
    const ny = svg.getAttribute('viewBox').split(' ').map(Number)[3] / CELL;
    const p = svg.createSVGPoint();
    p.x = (gx + 0.5) * CELL;
    p.y = (ny - 1 - gy + 0.5) * CELL;
    const q = p.matrixTransform(svg.getScreenCTM());
    return { x: q.x, y: q.y };
  }, { gx, gy, CELL });
}

async function dragCells(page, from, to) {
  const a = await cellPoint(page, from[0], from[1]);
  const b = await cellPoint(page, to[0], to[1]);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(150);
}

/* page.mouse.click takes no `modifiers` option -- that only exists on locator and
   page click. Passing one there is accepted and ignored, so an alt-click silently
   became a plain click and the test failed against working code. Hold the key. */
async function clickCell(page, gx, gy, modifiers = []) {
  const p = await cellPoint(page, gx, gy);
  for (const m of modifiers) await page.keyboard.down(m);
  try {
    await page.mouse.click(p.x, p.y);
  } finally {
    for (const m of [...modifiers].reverse()) await page.keyboard.up(m);
  }
  await page.waitForTimeout(150);
}

/* The layout, read out of the page's own model rather than scraped from the DOM —
   the DOM is what we are testing, so it cannot also be the source of truth. */
async function bins(page) {
  return page.evaluate(() => B().map((b) => ({
    x: b.x, y: b.y, u: b.u, v: b.v, hUnits: b.hUnits,
    cells: binCells(b).map((c) => c.join(',')).sort(),
    carved: isCarved(b),
    outsideBox: (b.cells || []).filter(([x, y]) => x >= b.u || y >= b.v || x < 0 || y < 0).length,
  })));
}

const setField = async (page, id, value) => {
  await page.evaluate(({ id, value }) => {
    const e = document.getElementById(id);
    e.value = value;
    e.dispatchEvent(new Event('input', { bubbles: true }));
    e.dispatchEvent(new Event('change', { bubbles: true }));
  }, { id, value: String(value) });
  await page.waitForTimeout(250);
};

module.exports = { openBins, cellPoint, dragCells, clickCell, bins, setField,
                   BINS_URL, PLATES_URL, CELL, ROOT };
