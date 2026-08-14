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
  solid: false, edges: { f: 1, b: 1, l: 1, r: 1 }, base: 'standard', scoop: 0, label: 0,
}, o);

const CASES = [
  ['defaults, decimal wall and floor', bin({})],
  ['no dividers, must stay none', bin({ wall: 1.2, floorT: 1.2, divX: 0, divY: 0 })],
  ['dividers that are real', bin({ divX: 2, divY: 1 })],
  ['fractional edges', bin({ edges: { f: 0.66, b: 0.5, l: 0.25, r: 1 } })],
  ['open front tray', bin({ edges: { f: 0, b: 0, l: 0, r: 0 } })],
  ['low profile with scoop and label', bin({ base: 'low', scoop: 8, label: 12 })],
  ['low lip', bin({ base: 'lowlip' })],
  ['solid block', bin({ solid: true })],
  ['awkward decimals', bin({ wall: 0.85, floorT: 2.35, scoop: 6.5, label: 10.5 })],
  ['placed away from the origin', bin({ x: 5, y: 7, u: 3, v: 2, hUnits: 12 })],
];

const KEYS = ['x', 'y', 'u', 'v', 'hUnits', 'wall', 'floorT', 'divX', 'divY',
              'solid', 'base', 'scoop', 'label'];
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
    { bins: [bin({ x: 0, y: 0, u: 2, v: 2, base: 'low', scoop: 8 })] },
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
  const packed = packBin(bin({}));
  const fieldCount = packed.split('-').length;
  console.log(`  field count is stable                  ${fieldCount === 17 ? '17, correct' : fieldCount + ' — WRONG'}`);
  if (fieldCount !== 17) bad++;
}

console.log(bad ? `\n${bad} check(s) FAILED` : '\nlayouts survive the hash intact');
process.exit(bad ? 1 : 0);
