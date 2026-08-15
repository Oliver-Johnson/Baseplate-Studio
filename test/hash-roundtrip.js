#!/usr/bin/env node
/* A bin layout travels in the URL hash, so it must survive being packed and unpacked
 * byte for byte. It did not: the field separator was '.', wall thickness 1.2 split
 * into "1" and "2", every later field shifted, and a bin came back from a round trip
 * carrying dividers nobody asked for.
 *
 * The values that break this are the ones with decimals, so those are exactly what
 * this exercises. Usage: node test/hash-roundtrip.js
 */
'use strict';
const { packBin, unpackBin, packLayers, unpackLayers, BIN_DEFAULTS } = require('../src/bins/bin.js');

const bin = (o) => Object.assign({
  x: 0, y: 0, u: 1, v: 1, hUnits: 3, wall: 1.2, floorT: 1.2, divX: 0, divY: 0,
  solid: false, edges: { f: 1, b: 1, l: 1, r: 1 }, scoop: 0, label: 0,
}, o);

const CASES = [
  ['defaults, decimal wall and floor', bin({})],
  ['no dividers, must stay none', bin({ wall: 1.2, floorT: 1.2, divX: 0, divY: 0 })],
  ['dividers that are real', bin({ divX: 2, divY: 1 })],
  ['fractional edges', bin({ edges: { f: 0.66, b: 0.5, l: 0.25, r: 1 } })],
  ['open front tray', bin({ edges: { f: 0, b: 0, l: 0, r: 0 } })],
  ['scoop and label', bin({ scoop: 8, label: 12 })],
  ['solid block', bin({ solid: true })],
  ['awkward decimals', bin({ wall: 0.85, floorT: 2.35, scoop: 6.5, label: 10.5 })],
  ['placed away from the origin', bin({ x: 5, y: 7, u: 3, v: 2, hUnits: 12 })],
];

const KEYS = ['x', 'y', 'u', 'v', 'hUnits', 'wall', 'floorT', 'divX', 'divY',
              'solid', 'scoop', 'label'];
let bad = 0;

console.log('single bins');
for (const [name, b] of CASES) {
  const back = unpackBin(packBin(b));
  const diffs = [];
  for (const k of KEYS) if (back[k] !== b[k]) diffs.push(`${k}: ${b[k]} -> ${back[k]}`);
  for (const k of ['f', 'b', 'l', 'r'])
    if (back.edges[k] !== b.edges[k]) diffs.push(`edge ${k}: ${b.edges[k]} -> ${back.edges[k]}`);
  console.log(`  ${name.padEnd(36)}${diffs.length ? 'CORRUPTED: ' + diffs.join(', ') : 'intact'}`);
  if (diffs.length) bad++;
}

console.log('\nmulti-bin, multi-layer');
{
  const layers = [
    { bins: [bin({ x: 0, y: 0, u: 2, v: 2 }), bin({ x: 3, y: 0, u: 1, v: 4, divY: 2 })] },
    { bins: [bin({ x: 0, y: 0, u: 2, v: 2, scoop: 8 })] },
    { bins: [] },
  ];
  const back = unpackLayers(packLayers(layers));
  const shapeOk = back.length === layers.length &&
    back.every((L, i) => L.bins.length === layers[i].bins.length);
  console.log(`  layer and bin counts survive          ${shapeOk ? 'intact' : 'CORRUPTED'}`);
  if (!shapeOk) bad++;
  const deep = JSON.stringify(back) === JSON.stringify(layers.map(
    (L) => ({ bins: L.bins.map((b) => unpackBin(packBin(b))) })));
  console.log(`  every bin identical after a trip      ${deep ? 'intact' : 'CORRUPTED'}`);
  if (!deep) bad++;
}

console.log('\nseparators cannot appear inside a value');
{
  // the guard should refuse rather than silently emit something unparseable
  let threw = false;
  try { packBin(bin({ wall: -1 })); } catch (e) { threw = true; }
  console.log(`  a negative field is rejected           ${threw ? 'guarded' : 'NOT GUARDED'}`);
  if (!threw) bad++;
  /* 17 since the base-style field went with the base styles: position IS the format,
     so this number is deliberate and changing it changes what every link means. It
     was safe to change once, before the site had been advertised and while no link
     existed to break. Update it on purpose or not at all. */
  const packed = packBin(bin({}));
  const fieldCount = packed.split('-').length;
  console.log(`  field count is stable                  ${fieldCount === 17 ? '17, correct' : fieldCount + ' — WRONG'}`);
  if (fieldCount !== 17) bad++;
}

/* A hash is in the address bar, so it gets hand-edited, truncated by a chat client and
   pasted back short. None of that may throw, and none of it may produce a bin the
   geometry cannot build — a white screen over a typo loses the whole layout, while a
   bin that falls back to its defaults loses one field. */
console.log('\nmalformed hashes fall back instead of throwing');
{
  const G = require('../src/core.js');
  const { buildBin } = require('../src/bins/bin.js');
  const JUNK = [
    ['empty string', ''],
    ['not a bin at all', 'hello world'],
    ['truncated after three fields', '0-0-2'],
    ['a field that is not a number', '0-0-two-2-3-1.2-1.2-0-0-0-1-1-1-1-0-0-0'],
    ['more fields than the format has', '0-0-2-2-3-1.2-1.2-0-0-0-1-1-1-1-2-8-12-0'],
    ['negative footprint', '0-0--2--2-3-1.2-1.2-0-0-0-1-1-1-1-0-0-0'],
    ['a mask that does not fit its footprint', '0-0-2-2-3-1.2-1.2-0-0-0-1-1-1-1-0-0-111111111'],
  ];
  for (const [name, s] of JUNK) {
    let why = '';
    try {
      const b = unpackBin(s);
      if (!(b.u >= 1 && b.v >= 1 && b.hUnits >= 1)) why = `footprint ${b.u}x${b.v}x${b.hUnits}`;
      else if (!isFinite(b.wall) || !isFinite(b.floorT)) why = 'wall or floor is NaN';
      else {
        const r = buildBin(G, { u: b.u, v: b.v, hUnits: b.hUnits, wall: b.wall,
                                floorT: b.floorT, divX: b.divX, divY: b.divY,
                                solid: b.solid, edges: b.edges, scoop: b.scoop,
                                label: b.label, cells: b.cells });
        if (!r.polys.length) why = 'built an empty mesh';
      }
    } catch (e) { why = 'THREW: ' + e.message; }
    console.log(`  ${name.padEnd(42)}${why ? 'FAILED — ' + why : 'loads'}`);
    if (why) bad++;
  }
  let threw = false;
  try { unpackLayers('~~junk_more junk~'); } catch (e) { threw = true; }
  console.log(`  ${'a hash of nothing but separators'.padEnd(42)}${threw ? 'FAILED — threw' : 'loads'}`);
  if (threw) bad++;
}

/* Carved footprints ride in the last field as an occupancy bitmap. A rectangle
   must stay a rectangle through the trip — the failure that matters here is a
   full bin coming back carved, which is what would put phantom holes in a shape
   the user never touched. */
console.log('\ncarved footprints');
{
  const shapes = [
    ['L, one corner gone', 3, 3, [[2, 2]]],
    ['U, two reflex corners', 3, 3, [[1, 2]]],
    ['staircase', 3, 3, [[1, 2], [2, 2], [2, 1]]],
    ['single cell left of a 4x4', 4, 4, (() => {
      const d = []; for (let x = 0; x < 4; x++) for (let y = 0; y < 4; y++)
        if (x || y) d.push([x, y]); return d;
    })()],
  ];
  for (const [name, u, v, drop] of shapes) {
    const cells = [];
    for (let x = 0; x < u; x++) for (let y = 0; y < v; y++)
      if (!drop.some((d) => d[0] === x && d[1] === y)) cells.push([x, y]);
    const b = bin({ u, v, cells });
    const back = unpackBin(packBin(b));
    const key = (c) => c.map((p) => p.join(',')).sort().join(' ');
    const ok = back.u === u && back.v === v && back.cells && key(back.cells) === key(cells);
    console.log(`  ${name.padEnd(36)}${ok ? 'intact' : 'CORRUPTED: ' + JSON.stringify(back.cells)}`);
    if (!ok) bad++;
  }
  // and the inverse: a full rectangle must never come back as a carved shape
  const plain = unpackBin(packBin(bin({ u: 3, v: 2 })));
  const plainOk = !plain.cells;
  console.log(`  ${'a full rectangle stays uncarved'.padEnd(36)}${plainOk ? 'intact' : 'CORRUPTED: gained a mask'}`);
  if (!plainOk) bad++;
}

console.log(bad ? `\n${bad} check(s) FAILED` : '\nlayouts survive the hash intact');
process.exit(bad ? 1 : 0);
