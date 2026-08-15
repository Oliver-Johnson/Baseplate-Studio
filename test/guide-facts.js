#!/usr/bin/env node
/* Do the guides still tell the truth?
 *
 * The prose quotes real numbers — the 42 mm pitch, the 41.5 mm footprint, the 4.25 mm
 * baseplate, the 7 mm unit, how many cells fit a 306 mm drawer. Those came from the
 * code once and then stopped being connected to it. Nothing has ever checked them, so
 * a change to SPEC or to the layout arithmetic would leave three pages quietly lying,
 * and prose is the one part of this project a test has never read.
 *
 * This does not check writing. It checks arithmetic that appears in writing.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const G = require('../src/core.js');
const { SPEC } = require('../src/bins/bin.js');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/&nbsp;/g, ' ');
const PAGES = ['guide/index.html', 'guide/split/index.html', 'guide/drawer-sizes/index.html'];
const prose = PAGES.map((p) => [p, read(p)]);

let bad = 0;
const check = (what, want, found) => {
  const ok = found === true || (found !== false && Math.abs(found - want) < 1e-9);
  console.log(`  ${what.padEnd(56)}${ok ? 'ok' : `WRONG — code says ${want}`}`);
  if (!ok) bad++;
};
const saysIn = (page, re) => prose.find(([p]) => p === page)[1].match(re);
const saysAnywhere = (re) => prose.some(([, s]) => re.test(s));

console.log('constants the prose quotes, against the code');
check(`pitch is ${SPEC.pitch} mm`, SPEC.pitch, saysAnywhere(/\b42 mm\b/) && SPEC.pitch === 42);
check(`bin footprint is ${(SPEC.half * 2).toFixed(1)} mm`, 41.5,
      saysAnywhere(/\b41\.5 mm\b/) && SPEC.half * 2 === 41.5);
check(`height unit is ${SPEC.unitH} mm`, 7, saysAnywhere(/\b7 mm\b/) && SPEC.unitH === 7);
check(`baseplate is ${G.DEFAULTS.plateHeight} mm`, 4.25,
      saysAnywhere(/\b4\.25 mm\b/) && G.DEFAULTS.plateHeight === 4.25);
check('the gap between neighbouring bins is 0.5 mm', 0.5,
      Number(((SPEC.pitch - SPEC.half * 2)).toFixed(3)));

/* The tables in drawer-sizes.html are pure arithmetic: floor(size / pitch) and the
   remainder. Every row is checkable, and a wrong row is the kind of thing someone
   plans a purchase around. */
console.log('\nevery row of the metric and inch tables');
{
  const html = read('guide/drawer-sizes/index.html');
  const rows = [...html.matchAll(/<tr><td>([\d.]+)(?:")?\s*(mm)?<\/td><td>([\d.]+) mm<\/td><td>(\d+)<\/td><td>([\d.]+) mm<\/td><\/tr>/g)];
  const metric = [...html.matchAll(/<tr><td>(\d+) mm<\/td><td>(\d+)<\/td><td>(\d+) mm<\/td><td>(\d+) mm<\/td><\/tr>/g)];
  let n = 0;
  for (const m of metric) {
    const size = +m[1], cells = +m[2], grid = +m[3], left = +m[4];
    const wantCells = Math.floor(size / SPEC.pitch);
    const wantGrid = wantCells * SPEC.pitch;
    const ok = cells === wantCells && grid === wantGrid && left === size - wantGrid;
    if (!ok) {
      console.log(`  ${size} mm: says ${cells} cells / ${grid} mm / ${left} left — ` +
                  `should be ${wantCells} / ${wantGrid} / ${size - wantGrid}`);
      bad++;
    }
    n++;
  }
  for (const m of rows) {
    const inches = +m[1], mm = +m[3], cells = +m[4], left = +m[5];
    const wantMm = Math.round(inches * 25.4 * 10) / 10;
    const wantCells = Math.floor(wantMm / SPEC.pitch);
    const wantLeft = Math.round((wantMm - wantCells * SPEC.pitch) * 10) / 10;
    const ok = Math.abs(mm - wantMm) < 0.05 && cells === wantCells &&
               Math.abs(left - wantLeft) < 0.05;
    if (!ok) {
      console.log(`  ${inches}": says ${mm} mm / ${cells} cells / ${left} left — ` +
                  `should be ${wantMm} / ${wantCells} / ${wantLeft}`);
      bad++;
    }
    n++;
  }
  console.log(`  ${n} rows checked${bad ? '' : ', every one correct'}`);
  if (n < 15) { console.log('  TOO FEW ROWS MATCHED — the parser has drifted from the markup'); bad++; }
}

/* Worked examples in the prose. These are the sentences a reader trusts most, because
   they are specific. */
console.log('\nworked examples');
{
  const g = read('guide/index.html');
  // "An 84 mm drawer gives 79.75 mm above the plate"
  const m = read('guide/drawer-sizes/index.html')
    .match(/An (\d+)&?n?b?s?p?;? ?mm drawer gives ([\d.]+) mm above the plate/);
  if (m) check(`${m[1]} mm drawer leaves ${m[2]} mm above a plate`,
               +m[1] - G.DEFAULTS.plateHeight, +m[2]);
  else {
    console.log('  the "NN mm drawer gives NN.NN mm above the plate" example is gone ' +
                'or reworded — reword this check with it, do not delete it');
    bad++;
  }

  /* Every claim below MUST be found. A regex that stops matching because someone
     reworded a sentence would otherwise turn this file into a check that silently
     passes on prose it never read -- which is the exact failure this project has
     shipped several times. Not finding the sentence is itself a failure. */
  const words = { four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  const split = read('guide/split/index.html');
  const bed = split.match(/A (\d+) mm bed takes (\w+) cells, because (\w+) would need (\d+) mm/);
  if (!bed) {
    console.log('  the "a NNN mm bed takes N cells" example is gone or reworded — ' +
                'reword this check with it, do not delete it');
    bad++;
  } else {
    check(`a ${bed[1]} mm bed takes ${bed[2]} cells`,
          Math.floor(+bed[1] / SPEC.pitch), words[bed[2]] ?? -1);
    check(`and ${bed[3]} cells would need ${bed[4]} mm`,
          (words[bed[3]] ?? -1) * SPEC.pitch, +bed[4]);
  }
}

/* Nothing in the prose may describe a feature that no longer exists. Low-profile bins
   and low lips were removed; the guides mentioned both. */
console.log('\nno prose describing features that were removed');
for (const [p, s] of prose) {
  const ghosts = [/low[- ]profile/i, /low lip/i, /shallow foot/i].filter((re) => re.test(s));
  console.log(`  ${p.padEnd(56)}${ghosts.length ? 'MENTIONS A REMOVED FEATURE' : 'clean'}`);
  if (ghosts.length) bad++;
}

console.log(bad ? `\n${bad} claim(s) in the guides are WRONG` : '\nthe guides still tell the truth');
process.exit(bad ? 1 : 0);
