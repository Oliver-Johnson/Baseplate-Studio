/* Which loose part the download contains, asked twice and answered once.
 *
 * The 3MF print plate and the connector STL are two files describing the same physical
 * part, produced by two functions. keysStl knew that a top-inserted snap takes the
 * U-clip you press in from above; platePolysAndItems built every key unit on the plate
 * with buildKey, the flat bottom-insert key. Download the plate and you printed a slab
 * that will not go into the pocket; download the STL and you printed the clip; nothing
 * anywhere said the two files disagreed.
 *
 * So this compares the exported geometry and not the call. It parses the triangles back
 * out of the real STL bytes and out of the real 3MF XML, and compares triangle count,
 * bounding box and signed volume. Asserting that both routes ran, or that both produced
 * a file, would have passed against the bug throughout its life.
 */
'use strict';
const { test, expect } = require('@playwright/test');
const H = require('./helpers.js');

/* Two cells by two, cut down the middle by hand: one vertical seam two cells long, so
   computeLayout gives it exactly one junction and the design needs exactly one loose
   part. One copy is what makes the two files directly comparable — the STL tiles its
   copies across a plate and the 3MF places each separately — so with a single copy the
   only thing left to differ is the part.

   The cut is manual rather than a bed the pieces overflow, because a bed narrow enough
   to force a split is also narrow enough for a dovetail's tabs to overflow it, and an
   oversized piece is an error that stops the build outright. The four cells are worth
   keeping small: the run builds this design 28 times and exports the 3MF each time.
   Quantity is checked separately below, on a layout that needs several. */
const ONE = '#w=84&d=84&mm=auto&bw=256&bd=256&sp=manual&rc=&cc=1';

const CONNECTORS = ['none', 'dovetail', 'puzzle', 'bowtie', 'puzzlekey', 'snap', 'hclip'];
const MOUNTS = ['floor', 'wall'];
const INSERTS = ['bottom', 'top'];

/* Rebuild and wait for it, rather than sleeping past the 260 ms debounce. Nulling the
   plan first means the wait cannot be satisfied by the plan left over from the previous
   configuration, which is the trap: state.connector updates synchronously on the input
   event while printPlan does not, so "the page agrees with me about the connector" is
   true a quarter of a second before the plan is that connector's. */
const settle = async (page) => {
  await page.evaluate(() => { printPlan = null; recomputeLayout(); });
  await page.waitForFunction(
    'printPlan && layout && Object.keys(builds).length === layout.pieces.length',
    null, { timeout: 40000 });
};

async function configure(page, cn, km, ki) {
  await page.evaluate(({ cn, km, ki }) => {
    for (const [id, v] of [['connector', cn], ['keyMount', km], ['keyInsert', ki]])
      document.getElementById(id).value = v;
  }, { cn, km, ki });
  await settle(page);
}

/* Everything below runs in the page, over bytes the download buttons would have saved:
   stlBinary's output parsed back as binary STL, and build3mfXML's output parsed back as
   XML. Nothing is read off the polygon arrays the two routes were handed. */
/* Wait for the plan before reading it. The baseplate build is asynchronous and
   yields between pieces, so on a slow or busy machine printPlan is still null when
   the test asks — which is how this failed in CI, on two workers, while passing
   locally where the build finished first. A race in the test, not the page. */
const facts = async (page) => {
  await page.waitForFunction(
    () => typeof printPlan !== 'undefined' && printPlan && printPlan.plates,
    null, { timeout: 60_000 });
  return page.evaluate(() => {
  const measure = (T) => {
    if (!T.length) return null;
    let vol = 0;
    const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
    for (const t of T) {
      vol += (t[0][0] * (t[1][1]*t[2][2] - t[2][1]*t[1][2])
            - t[0][1] * (t[1][0]*t[2][2] - t[2][0]*t[1][2])
            + t[0][2] * (t[1][0]*t[2][1] - t[2][0]*t[1][1])) / 6;
      for (const v of t) for (let k = 0; k < 3; k++) {
        if (v[k] < lo[k]) lo[k] = v[k];
        if (v[k] > hi[k]) hi[k] = v[k];
      }
    }
    return { n: T.length, vol, box: [hi[0]-lo[0], hi[1]-lo[1], hi[2]-lo[2]] };
  };
  const fromStl = (buf) => {
    const dv = new DataView(buf), n = dv.getUint32(80, true), out = [];
    for (let i = 0; i < n; i++) {
      const o = 84 + i*50 + 12, t = [];
      for (let j = 0; j < 3; j++)
        t.push([dv.getFloat32(o + j*12, true), dv.getFloat32(o + j*12 + 4, true),
                dv.getFloat32(o + j*12 + 8, true)]);
      out.push(t);
    }
    return out;
  };
  /* Split first, match second. A whole baseplate piece is a megabyte of one <object>,
     and a lazy regex walked across all of them for every configuration — minutes of the
     run spent backtracking past meshes this file does not care about. */
  const fromModel = (xml) => {
    const out = [];
    for (const chunk of xml.split('<object ').slice(1)) {
      const nm = /^[^>]*name="([^"]*)"/.exec(chunk);
      if (!nm || !/^key/.test(nm[1])) continue;
      const verts = [...chunk.matchAll(/x="([-\d.]+)" y="([-\d.]+)" z="([-\d.]+)"/g)]
        .map((a) => [+a[1], +a[2], +a[3]]);
      const tris = [...chunk.matchAll(/v1="(\d+)" v2="(\d+)" v3="(\d+)"/g)]
        .map((a) => [verts[+a[1]], verts[+a[2]], verts[+a[3]]]);
      out.push({ name: nm[1], tris });
    }
    return out;
  };

  const keyed = KEYED.includes(state.connector);
  const stl = keyed ? keysStl() : null;
  const plateKeys = [];
  for (let i = 0; i < printPlan.plates.length; i++)
    for (const o of fromModel(build3mfXML(platePolysAndItems(i)).model))
      plateKeys.push(measure(o.tris));
  return {
    keyed, needed: keysNeeded(),
    name: stl ? stl.name : null,
    stl: stl ? measure(fromStl(stlBinary(stl.polys, stl.mesh))) : null,
    plateKeys,
  };
  });
};

/* 3MF writes vertices at three decimal places, so a coordinate can move by 5e-4 on the
   way through the file and the two meshes can never be byte-identical. The window is
   the format's rounding and nothing else: measured across the matrix the worst box
   disagreement is 6e-4 mm and the worst volume disagreement 3e-5 of the part. A wrong
   part misses by a factor, not by a micron — the U-clip against the flat key is 84
   triangles against 182 and 4.2 mm across against 14. */
function expectSamePart(a, b, why) {
  expect(a, why).not.toBeNull();
  expect(b, why).not.toBeNull();
  expect(a.n, `${why}: triangle count`).toBe(b.n);
  for (let k = 0; k < 3; k++)
    expect(a.box[k], `${why}: bounding box axis ${k}`).toBeCloseTo(b.box[k], 2);
  expect(Math.abs(a.vol - b.vol) / Math.max(1e-6, Math.abs(b.vol)),
         `${why}: enclosed volume`).toBeLessThan(1e-3);
}

test('the print plate and the loose STL hold the same part, in every configuration',
  async ({ page }) => {
  test.setTimeout(180_000);   // 28 configurations, each a full rebuild and a full export
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(H.PLATES_URL + ONE);
  await page.waitForFunction('printPlan && Object.keys(builds).length === layout.pieces.length',
                             null, { timeout: 40000 });

  const seen = new Map();   // "cn/km/ki" -> triangle count of the one part, or 0
  for (const cn of CONNECTORS) for (const km of MOUNTS) for (const ki of INSERTS) {
    const at = `${cn}/${km}/${ki}`;
    await configure(page, cn, km, ki);
    const f = await facts(page);
    expect(f.needed, `${at}: the fixture must need exactly one part`).toBe(1);

    if (!f.keyed) {
      // a tabbed or unjoined design ships no loose part; the plate must carry none either
      expect(f.plateKeys, `${at}: nothing keyed, so the plate must carry no key`).toEqual([]);
      seen.set(at, 0);
      continue;
    }
    expect(f.plateKeys.length, `${at}: the plate must carry the one part the STL ships`).toBe(1);
    expectSamePart(f.stl, f.plateKeys[0], at);
    seen.set(at, f.stl.n);
  }

  /* The precondition. Every assertion above is an equality, and equalities hold
     trivially if the matrix only ever produces one part — so the matrix has to be shown
     to contain the case the bug lived in. A top-inserted snap must come out as a
     different mesh from the same connector inserted from beneath, in both housings,
     or this file is comparing a thing against itself 28 times. */
  for (const km of MOUNTS)
    expect(seen.get(`snap/${km}/top`),
      `fixture: snap/${km}/top must be a different part from snap/${km}/bottom, or the ` +
      'comparison above cannot tell the U-clip from the flat key')
      .not.toBe(seen.get(`snap/${km}/bottom`));
  expect(new Set([...seen.values()]).size,
    'fixture: the matrix must span several distinct parts').toBeGreaterThan(3);

  expect(errors, 'the page threw while being driven').toEqual([]);
});

/* Quantity, on a layout that needs more than one. The count and the part are separate
   questions and have gone wrong separately: keysNeeded was the fix for the count last
   week, and the plate was still holding the wrong part while counting it correctly.
   Driven at the top-inserted snap because that is where the two used to disagree — the
   STL tiles clips and the plate placed keys, so "one unit per key" was true of two
   different parts. */
test('the plate carries one of the right part per key, not one per junction',
  async ({ page }) => {
  test.setTimeout(120_000);
  const errors = await H.openPlates(page);
  await H.setField(page, 'drawerW', 268);
  await H.setField(page, 'drawerD', 268);
  await page.locator('#splitSeg button[data-v="staggered"]').click();
  await configure(page, 'snap', 'wall', 'top');

  const f = await facts(page);
  const junctions = await page.evaluate(
    () => layout.seams.reduce((a, s) => a + s.junctions.length, 0));
  expect(junctions,
    'fixture: this layout must have a junction no wall-housed part can use, or the ' +
    'count cannot be told from the junction count').toBeGreaterThan(f.needed);
  expect(f.needed).toBeGreaterThan(1);

  expect(f.plateKeys.length, 'one plate unit per part needed').toBe(f.needed);
  expect(Number(/-x(\d+)\.stl$/.exec(f.name)[1]), 'the filename must say the same')
    .toBe(f.needed);
  // the STL is the same part, tiled: its triangles must divide exactly by the plate's
  expect(f.stl.n, 'the STL must hold that many copies of the plate part')
    .toBe(f.plateKeys[0].n * f.needed);
  expect(f.stl.vol / f.needed, 'and the same part, not merely the same count')
    .toBeCloseTo(f.plateKeys[0].vol, 2);
  for (const k of f.plateKeys) expect(k.n, 'every unit on the plate is that part').toBe(f.plateKeys[0].n);
  /* And that the part is the clip. Without this the four assertions above would still
     hold if both routes went back to the flat key together — they only compare the two
     files with each other. The U-clip is about 4 mm across the legs; the key it was
     confused with is 13. */
  expect(f.plateKeys[0].box[0], 'a top-inserted snap ships the U-clip, not the flat key')
    .toBeLessThan(6);

  expect(errors, 'the page threw while being driven').toEqual([]);
});
