/* The drawer shell in the bins preview.
 *
 * The feature draws the real drawer around the design so you can judge whether the
 * bins suit the drawer you own. That makes almost every claim about it geometric —
 * where the walls stand, which one is the front, how tall each is — so these cases
 * measure the built meshes rather than looking for a checkbox and calling it wired.
 *
 * Two of them are guard rails rather than features: the shell must never cost an
 * exported byte, and it must never be rebuilt because the camera moved.
 */
'use strict';
const fs = require('fs');
const crypto = require('crypto');
const { test, expect } = require('@playwright/test');
const H = require('./helpers.js');
const JSZip = require('../../vendor/jszip.min.js');

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

test.beforeEach(async ({ page }) => {
  page.__errors = await H.openBins(page);
});
test.afterEach(async ({ page }) => {
  expect(page.__errors, 'the page threw while being driven').toEqual([]);
});

const setDrawer = async (page, on) => {
  await page.evaluate((v) => {
    const e = document.getElementById('showDrawer');
    e.checked = v;
    e.dispatchEvent(new Event('change', { bubbles: true }));
  }, on);
  await page.waitForTimeout(250);
};

/* Every panel of the shell in world millimetres. The meshes are boxes whose geometry
   is centred on the origin and moved into place, so the bounds have to be read
   through the position — a bounding box straight off the geometry says every wall is
   in the middle of the drawer. */
const panels = (page) => page.evaluate(() => {
  const out = [];
  for (const o of drawerGroup.children) {
    if (o.type !== 'Mesh') continue;
    o.geometry.computeBoundingBox();
    const b = o.geometry.boundingBox;
    out.push({
      x0: b.min.x + o.position.x, x1: b.max.x + o.position.x,
      y0: b.min.y + o.position.y, y1: b.max.y + o.position.y,
      z0: b.min.z + o.position.z, z1: b.max.z + o.position.z,
      transparent: o.material.transparent, opacity: o.material.opacity,
      depthWrite: o.material.depthWrite,
    });
  }
  return out;
});
// the floor sits below the baseplate; everything that rises above it is a wall
const walls = (ps) => ps.filter((p) => p.y1 > 0);

/* The preview sits well down a long page and page.mouse works in viewport
   coordinates, so the box has to be measured after scrolling to it — the same trap
   cellPoint documents for the map. Unscrolled, every gesture below lands on nothing
   and the assertions pass by measuring an idle canvas. */
async function previewBox(page) {
  await page.evaluate(() =>
    document.getElementById('threewrap').scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(120);
  return page.locator('#three').boundingBox();
}

test('the drawer is off until you ask for it, and the toggle builds it', async ({ page }) => {
  expect(await page.evaluate(() => drawerGroup.children.length)).toBe(0);
  await expect(page.locator('#drawerFrontRow')).toBeHidden();

  await page.locator('#s-drawer h2').click();      // the panel ships collapsed
  await page.locator('#showDrawer').click();       // the real control, a real click
  await page.waitForTimeout(250);
  await expect(page.locator('#drawerFrontRow')).toBeVisible();
  const on = await panels(page);
  expect(walls(on), 'four walls and a floor').toHaveLength(4);
  expect(on).toHaveLength(5);

  await page.locator('#showDrawer').click();
  await page.waitForTimeout(250);
  expect(await page.evaluate(() => drawerGroup.children.length)).toBe(0);
  await expect(page.locator('#drawerFrontRow')).toBeHidden();
});

/* The whole point of the shell is the space the grid cannot reach, so walls drawn on
   the grid instead of on the drawer would show nothing at all. The default drawer is
   306 x 380 and the grid it yields is 7 x 9 cells, i.e. 294 x 378 — a 12 mm and a
   2 mm margin. The margins are asserted as a precondition, because on a drawer that
   happens to be a whole number of cells this test could not tell the two apart. */
test('the walls stand at the drawer inside size, not at the grid', async ({ page }) => {
  await setDrawer(page, true);
  const g = await page.evaluate(() => ({
    W: grid().nx * SPEC.pitch, D: grid().ny * SPEC.pitch,
    drawerW: state.drawerW, drawerD: state.drawerD }));
  expect(g.drawerW - g.W, 'fixture: the drawer must be wider than its grid').toBeCloseTo(12, 6);
  expect(g.drawerD - g.D, 'fixture: the drawer must be deeper than its grid').toBeCloseTo(2, 6);

  const w = walls(await panels(page));
  const left = Math.max(...w.map((p) => p.x1).filter((v) => v < 0));
  const right = Math.min(...w.map((p) => p.x0).filter((v) => v > 0));
  const back = Math.max(...w.map((p) => p.z1).filter((v) => v < 0));
  const front = Math.min(...w.map((p) => p.z0).filter((v) => v > 0));
  expect(right - left, 'inside width').toBeCloseTo(g.drawerW, 3);
  expect(front - back, 'inside depth').toBeCloseTo(g.drawerD, 3);
});

/* Front of the drawer is the bottom of the map, everywhere else in this tool. The
   panel is anchored to a bin actually placed on the front row rather than to a sign
   this test picked itself, so putting the tall panel on the back would fail here even
   if the convention were re-read the wrong way in both places. */
test('the front panel faces the front of the map and carries its own height', async ({ page }) => {
  await H.dragCells(page, [0, 0], [0, 0]);                  // front-left corner
  const ny = await page.evaluate(() => grid().ny);
  await H.dragCells(page, [0, ny - 1], [0, ny - 1]);        // back-left corner
  await setDrawer(page, true);
  await H.setField(page, 'drawerFrontH', 120);

  const binZ = await page.evaluate(() => group.children
    .filter((o) => o.userData.bin)
    .map((o) => ({ row: o.userData.bin.y, z: o.position.z }))
    .sort((a, b) => a.row - b.row)
    .map((o) => o.z));
  expect(binZ).toHaveLength(2);
  expect(binZ[0], 'fixture: the front row must sit at positive z').toBeGreaterThan(binZ[1]);

  const w = walls(await panels(page));
  const floorY = -4.25;                                     // the default baseplate
  const tall = w.filter((p) => p.y1 > floorY + 100);
  expect(tall, 'exactly one panel takes the front height').toHaveLength(1);
  expect(tall[0].y1 - floorY, 'front panel height').toBeCloseTo(120, 3);
  expect(tall[0].z0, 'the tall panel is on the same side as the front row')
    .toBeGreaterThan(0);
  for (const p of w.filter((p) => p !== tall[0]))
    expect(p.y1 - floorY, 'the other three stand at the side height').toBeCloseTo(84, 3);
});

/* The sides are the usable height already on the page rather than a measurement of
   their own, so that the picture and the "tallest stack vs available" check can never
   disagree. Changing the one number has to move the walls, or they are a constant. */
test('the sides follow the usable height the page already has', async ({ page }) => {
  await setDrawer(page, true);
  const topAt = async () => Math.max(...walls(await panels(page)).map((p) => p.y1));
  expect(await topAt()).toBeCloseTo(-4.25 + 84, 3);

  await H.setField(page, 'drawerH', 60);
  expect(await topAt()).toBeCloseTo(-4.25 + 60, 3);
  await H.setField(page, 'plateH', 10);
  expect(await topAt(), 'measured from the drawer floor, not the baseplate top')
    .toBeCloseTo(-10 + 60, 3);
});

/* You have to be able to see the bins through it, and hovering one through a wall has
   to still name the bin. The hover raycast walks group.children, so the assertion
   that matters is that no shell panel is in that set — checked with a ray that
   demonstrably does pass through one, or it would prove nothing. */
test('the shell is see-through and never steals a hover', async ({ page }) => {
  await page.locator('#fillRest').click();
  await page.waitForTimeout(500);
  await setDrawer(page, true);

  for (const p of await panels(page)) {
    expect(p.transparent).toBe(true);
    expect(p.opacity).toBeLessThan(0.4);
    expect(p.depthWrite, 'a shell that writes depth hides what is behind it').toBe(false);
  }

  const probe = await page.evaluate(() => {
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(0, 0), camera);
    const hits = ray.intersectObjects(group.children, false);
    const everything = ray.intersectObjects(scene.children, true);
    const inShell = (o) => drawerGroup.children.indexOf(o) >= 0;
    return {
      throughShell: everything.some((h) => inShell(h.object)),
      hits: hits.length,
      firstIsBin: !!(hits[0] && hits[0].object.userData.bin),
      anyShell: hits.some((h) => inShell(h.object)),
    };
  });
  expect(probe.throughShell, 'fixture: the ray must actually cross a wall').toBe(true);
  expect(probe.hits, 'fixture: the ray must actually reach the bins').toBeGreaterThan(0);
  expect(probe.anyShell).toBe(false);
  expect(probe.firstIsBin).toBe(true);

  const box = await previewBox(page);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.move(box.x + box.width / 2 + 1, box.y + box.height / 2);
  await expect(page.locator('#tip')).toBeVisible();
  await expect(page.locator('#tip')).toContainText('units');
});

/* The preview re-renders on every drag frame and every pinch, and showScene() rebuilds
   every bin mesh on every edit. The shell must survive both untouched and come back
   only when one of its own inputs moves. */
test('the shell is built when its inputs change, not per frame', async ({ page }) => {
  await H.dragCells(page, [0, 0], [1, 1]);
  await setDrawer(page, true);
  const ids = () => page.evaluate(() => drawerGroup.children.map((o) => o.uuid));
  const before = await ids();
  expect(before.length).toBeGreaterThan(0);

  const box = await previewBox(page);
  const angle = () => page.evaluate(() => [theta, phi]);
  const aim = await angle();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  for (let i = 0; i < 8; i++)
    await page.mouse.move(box.x + box.width / 2 + i * 6, box.y + box.height / 2 + i * 3);
  await page.mouse.up();
  expect(await angle(), 'fixture: the drag must really have rotated the preview')
    .not.toEqual(aim);

  const binsBefore = await page.evaluate(() => group.children.length);
  await H.dragCells(page, [4, 4], [5, 5]);
  const binsAfter = await page.evaluate(() => group.children.length);
  expect(binsAfter, 'fixture: the bin meshes must really have been rebuilt')
    .toBeGreaterThan(binsBefore);
  expect(await ids(), 'the shell survived a rotate and an edit').toEqual(before);

  await H.setField(page, 'drawerFrontH', 130);
  expect(await ids(), 'and is rebuilt when one of its own numbers moves')
    .not.toEqual(before);
});

/* The shell is a view. Not one byte of anything you download may depend on it — which
   includes the README inside the ZIP, whose layout link is why the drawer's own keys
   are struck out of the link that goes in there. */
test('not one exported byte depends on the drawer being drawn', async ({ page }) => {
  await H.setField(page, 'drawerW', 180);
  await H.setField(page, 'drawerD', 180);
  await page.locator('#fillRest').click();
  await page.waitForTimeout(600);

  async function fingerprint() {
    await page.locator('#openExport').click();
    const out = {};
    const [zipDl] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('#exFiles [data-ex="zip"]').click(),
    ]);
    const zip = await JSZip.loadAsync(fs.readFileSync(await zipDl.path()));
    for (const name of Object.keys(zip.files).sort())
      out['zip:' + name] = sha(await zip.files[name].async('nodebuffer'));
    const [plateDl] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('#exFiles [data-ex="plate"]').first().click(),
    ]);
    const p3mf = await JSZip.loadAsync(fs.readFileSync(await plateDl.path()));
    for (const name of Object.keys(p3mf.files).sort())
      out['3mf:' + name] = sha(await p3mf.files[name].async('nodebuffer'));
    await page.locator('#exportClose').click();
    Object.assign(out, await page.evaluate(() => ({
      'page:plan': document.getElementById('plateSummary').textContent,
      'page:checks': document.getElementById('warnings').textContent,
      'page:types': document.getElementById('typeRows').textContent,
    })));
    return out;
  }

  const off = await fingerprint();
  // the fingerprint has to be worth comparing before the comparison means anything
  expect(Object.keys(off).filter((k) => /\.stl$/.test(k)).length).toBeGreaterThan(0);
  expect(off['zip:README.txt']).toBeTruthy();
  expect(off['3mf:3D/3dmodel.model']).toBeTruthy();

  await setDrawer(page, true);
  await H.setField(page, 'drawerFrontH', 150);
  expect(await page.evaluate(() => drawerGroup.children.length),
         'fixture: the drawer must actually be drawn for this to prove anything')
    .toBeGreaterThan(0);

  expect(await fingerprint()).toEqual(off);
});

/* A copied link should reproduce what the sender was looking at, drawer included. */
test('the toggle and the front height ride in the shared link', async ({ page }) => {
  await setDrawer(page, true);
  await H.setField(page, 'drawerFrontH', 118);
  const link = await page.evaluate(() => shareLink());
  expect(link).toContain('dv=1');

  await page.goto(link);
  await page.waitForFunction(() => !!document.getElementById('fillmap'));
  await page.waitForTimeout(400);

  expect(await page.evaluate(() => document.getElementById('showDrawer').checked)).toBe(true);
  expect(await page.evaluate(() => state.drawerFrontH)).toBe(118);
  const w = walls(await panels(page));
  expect(w).toHaveLength(4);
  expect(Math.max(...w.map((p) => p.y1))).toBeCloseTo(-4.25 + 118, 3);

  // and the README's link is the design without the view, or the ZIP would move
  const readme = await page.evaluate(() => layoutReadme());
  expect(readme).not.toContain('dv=');
  expect(readme).not.toContain('dfh=');
});
