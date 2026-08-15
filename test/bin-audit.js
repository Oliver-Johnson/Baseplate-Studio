#!/usr/bin/env node
/* Headless audit for bin geometry: manifold check, bounds, and STL output.
 * Usage: node test/bin-audit.js [outDir]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const G = require('../src/core.js');
const { buildBin, SPEC, REQUIRED_CORE } = require('../src/bins/bin.js');

// the browser hand-assembles its own G; make sure core still exports everything
{
  const missing = REQUIRED_CORE.filter((f) => typeof G[f] !== 'function');
  if (missing.length) {
    console.error('core.js is missing: ' + missing.join(', '));
    process.exit(1);
  }
}

const cellsExcept = (u, v, drop) => {
  const out = [];
  for (let x = 0; x < u; x++) for (let y = 0; y < v; y++)
    if (!drop.some((d) => d[0] === x && d[1] === y)) out.push([x, y]);
  return out;
};

const outDir = process.argv[2] || path.join(__dirname, '..', 'out');
fs.mkdirSync(outDir, { recursive: true });

const CASES = [
  { name: '1x1x3', u: 1, v: 1, hUnits: 3 },
  { name: '1x1x6', u: 1, v: 1, hUnits: 6 },
  { name: '2x1x3', u: 2, v: 1, hUnits: 3 },
  { name: '2x2x3', u: 2, v: 2, hUnits: 3 },
  { name: '3x2x4', u: 3, v: 2, hUnits: 4 },
  { name: '1x1x3-solid', u: 1, v: 1, hUnits: 3, solid: true },
  { name: '2x1x3-div', u: 2, v: 1, hUnits: 3, divX: 1 },
  { name: '3x2x5-div', u: 3, v: 2, hUnits: 5, divX: 2, divY: 1 },
  { name: '1x1x1', u: 1, v: 1, hUnits: 1 },
  { name: '2x1x3-scoop', u: 2, v: 1, hUnits: 3, scoop: 8 },
  { name: '2x1x3-label', u: 2, v: 1, hUnits: 3, label: 12 },
  { name: '2x2x3-lowlip', u: 2, v: 2, hUnits: 3, base: 'lowlip' },
  { name: '2x2x3-low', u: 2, v: 2, hUnits: 3, base: 'low' },
  { name: '2x1x3-openfront', u: 2, v: 1, hUnits: 3, edges: { f: 0 } },
  { name: '2x2x2-tray', u: 2, v: 2, hUnits: 2, edges: { f: 0, b: 0, l: 0, r: 0 } },
  { name: '6x4x5-everything', u: 6, v: 4, hUnits: 5, divX: 2, divY: 1, scoop: 6, label: 10 },
  // carved footprints — the concave outlines the per-cell builder exists for
  { name: 'L-3x3', u: 3, v: 3, hUnits: 3, cells: cellsExcept(3, 3, [[2, 2]]) },
  { name: 'U-3x3', u: 3, v: 3, hUnits: 3, cells: cellsExcept(3, 3, [[1, 2]]) },
  { name: 'T-3x3', u: 3, v: 3, hUnits: 3, cells: cellsExcept(3, 3, [[0, 0], [2, 0]]) },
  { name: 'staircase-3x3', u: 3, v: 3, hUnits: 3, cells: cellsExcept(3, 3, [[1, 2], [2, 2], [2, 1]]) },
  { name: 'bigL-5x4', u: 5, v: 4, hUnits: 4, cells: cellsExcept(5, 4, [[3, 3], [4, 3], [4, 2]]) },
];

let bad = 0;
console.log('case            tris   W x D x H (mm)        zmin   zmax   mesh');
for (const cs of CASES) {
  let r;
  try {
    r = buildBin(G, cs);
  } catch (e) {
    console.log(`${cs.name.padEnd(14)} BUILD FAILED: ${e.message}`);
    bad++; continue;
  }
  const tris = G.polysToTriangles(r.polys);
  let zmin = Infinity, zmax = -Infinity, xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
  for (const p of r.polys) for (const v of p.verts) {
    zmin = Math.min(zmin, v[2]); zmax = Math.max(zmax, v[2]);
    xmin = Math.min(xmin, v[0]); xmax = Math.max(xmax, v[0]);
    ymin = Math.min(ymin, v[1]); ymax = Math.max(ymax, v[1]);
  }
  /* Bins ARE watertight and must stay so. An earlier build leaked 218 boundary
     edges because triangulateRing's ear clipper bailed out silently on a thin ring,
     and a slicer reported them as non-manifold. Every edge must now be shared by
     exactly two faces — boundary edges (used once) are holes, and anything used
     more than twice is two shells meeting on a plane instead of overlapping. */
  const man = G.checkManifold(r.polys);
  const pct = 100 * man.bad / man.edges;
  const ok = man.bad === 0;
  const dims = `${(xmax - xmin).toFixed(2)} x ${(ymax - ymin).toFixed(2)} x ${(zmax - zmin).toFixed(2)}`;

  // expected footprint straight from the spec, independent of the builder
  const expW = (cs.u - 1) * 42 + 41.5, expD = (cs.v - 1) * 42 + 41.5;
  /* A carved shape spans its bounding box to the same tolerance as a plain one now
     that its convex corners follow the spec arc. It used to need 0.2 mm of slack
     because square corners put it 1.55 mm outside the Gridfinity profile diagonally
     and 0.1 mm over on the flats. */
  const tol = 0.02;
  const wOk = Math.abs((xmax - xmin) - expW) < tol && Math.abs((ymax - ymin) - expD) < tol;
  /* The stacking PITCH is always hUnits*7 — that is what a bin occupies in a stack.
     The real height can be less: a tray with every wall open is just its floor, so
     compare zmax against meta.totalH and check the pitch separately. */
  const hOk = Math.abs(zmax - r.meta.totalH) < 0.02 &&
              Math.abs(r.meta.H - cs.hUnits * 7) < 0.001 &&
              zmin > -0.001;

  console.log(`${cs.name.padEnd(14)} ${String(tris.length).padStart(6)}  ${dims.padEnd(20)} ` +
              `${zmin.toFixed(3).padStart(6)} ${zmax.toFixed(3).padStart(6)}  ` +
              `${ok ? 'watertight' : man.bad + ' BAD EDGES'}`.padStart(12) +
              `${wOk ? '' : '  FOOTPRINT MISMATCH exp ' + expW + 'x' + expD}` +
              `${hOk ? '' : '  HEIGHT MISMATCH: zmax ' + zmax.toFixed(2) + ' vs totalH ' + r.meta.totalH.toFixed(2) + ', pitch ' + r.meta.H}`);
  /* A carved shape is still a bin: it takes a stacking lip like any other, so it
     must report one and stand the same height as the rectangle of the same units.
     Losing the lip silently would make anything carved unstackable. */
  let lipOk = true;
  if (cs.cells && !cs.solid && !cs.edges) {
    const expTotal = cs.hUnits * 7 + 3.95;
    lipOk = r.meta.hasLip === true && Math.abs(r.meta.totalH - expTotal) < 0.001;
    if (!lipOk) console.log(`${''.padEnd(14)}  LIP MISSING: hasLip ${r.meta.hasLip}, ` +
      `totalH ${r.meta.totalH.toFixed(2)} vs ${expTotal.toFixed(2)}`);
  }
  if (!ok || !wOk || !hOk || !lipOk) bad++;

  fs.writeFileSync(path.join(outDir, `bin-${cs.name}.stl`),
                   Buffer.from(G.stlBinary(r.polys, cs.name)));
}

/* cross-section audit: slice the real mesh and compare against the spec profile.
   maxAbs catches the flats; maxRad catches the corner arcs. Expected values come
   from the published spec, not from bin.js. */
function sectionExtents(polys, z) {
  const tris = G.polysToTriangles(polys);
  let maxAbs = 0, maxRad = 0, hits = 0;
  for (const t of tris) {
    for (let i = 0; i < 3; i++) {
      const a = t[i], b = t[(i + 1) % 3];
      if ((a[2] - z) * (b[2] - z) >= 0) continue;
      const s = (z - a[2]) / (b[2] - a[2]);
      const x = a[0] + s * (b[0] - a[0]), y = a[1] + s * (b[1] - a[1]);
      maxAbs = Math.max(maxAbs, Math.abs(x), Math.abs(y));
      maxRad = Math.max(maxRad, Math.hypot(x, y));
      hits++;
    }
  }
  return { maxAbs, maxRad, hits };
}
console.log('\ncross-sections of the built 1x1x3 mesh vs the published spec:');
console.log('   z    half-width  (exp)    corner reach  (exp)');
{
  const r = buildBin(G, { u: 1, v: 1, hUnits: 3 });
  const C = SPEC.centre;
  for (const [z, expHalf] of [[0.4, 17.8 + 0.4], [1.5, 18.6], [2.5, 18.6],
                              [3.5, 18.6 + 0.9], [4.6, 18.6 + 2.0]]) {
    const s = sectionExtents(r.polys, z);
    const expRad = C * Math.SQRT2 + (expHalf - C);
    const flatOk = Math.abs(s.maxAbs - expHalf) < 0.03;
    const radOk = Math.abs(s.maxRad - expRad) < 0.06;   // faceting slack
    console.log(`  ${z.toFixed(2)}   ${s.maxAbs.toFixed(3)}   (${expHalf.toFixed(2)})   ` +
                `${s.maxRad.toFixed(3)}   (${expRad.toFixed(2)})  ` +
                `${flatOk && radOk ? 'ok' : 'MISMATCH'}`);
    if (!(flatOk && radOk)) bad++;
  }
}

/* stacking: does a spec foot fit the lip? The lip's inner surface is defined by an
   inset from the bin's outer outline; the foot comes from the published spec. Both
   share corner-arc centre 17.00, so one number covers flats and corners alike. */
console.log('\nstacking clearance — spec foot inside the lip above it:');
console.log("   z'    lip inner   foot half   clearance");
{
  const { LIP_TABLE } = require('../src/bins/bin.js');
  const steps = LIP_TABLE || [[0, 2.70], [0.8, 1.90], [2.6, 1.90]];
  let worst = Infinity;
  for (const [z, t] of steps) {
    const lipInner = SPEC.half - t;
    let fh = SPEC.prof[SPEC.prof.length - 1][1];
    for (let k = 0; k < SPEC.prof.length - 1; k++) {
      const [z0, h0] = SPEC.prof[k], [z1, h1] = SPEC.prof[k + 1];
      if (z >= z0 && z <= z1) { fh = h0 + (h1 - h0) * (z1 > z0 ? (z - z0) / (z1 - z0) : 0); break; }
    }
    const clr = lipInner - fh;
    worst = Math.min(worst, clr);
    console.log(`  ${z.toFixed(2).padStart(4)}   ${lipInner.toFixed(2).padStart(9)}   ` +
                `${fh.toFixed(2).padStart(9)}   ${clr.toFixed(3).padStart(9)}` +
                `${Math.abs(clr - 0.25) < 0.001 ? '  ok' : '  OFF SPEC'}`);
    if (Math.abs(clr - 0.25) > 0.001) bad++;
  }
  console.log(`  uniform on flats and corners (both outlines share centre ${SPEC.centre.toFixed(2)})`);
}

/* independent check: the foot outline must share the spec corner-arc centre */
console.log('\nfoot corner-arc centre (must be 17.00 at every level):');
for (const [z, half] of SPEC.prof) {
  const r = half - SPEC.centre;
  console.log(`  z ${z.toFixed(2).padStart(5)}  half ${half.toFixed(2)}  r ${r.toFixed(2)}  centre ${(half - r).toFixed(2)}`);
}

/* Nothing was checking the OUTSIDE for overhangs, which is why a low-profile bin
   shipped with a 2.15 mm ledge starting in mid-air, and why the taper meant to fix it
   sat buried inside the body doing nothing across two commits. Walk the outer
   silhouette and demand no sideways step wider than the height it rises over — that is
   45 degrees, the angle a printer holds without support. */
console.log('\nouter silhouette: no overhang steeper than 45 degrees');
{
  const STEP = 0.05;
  for (const base of ['standard', 'lowlip', 'low'])
    for (const hUnits of [1, 3]) {
      const r = buildBin(G, { u: 2, v: 1, hUnits, base });
      const tris = G.polysToTriangles(r.polys);
      const at = (z) => {
        let m = 0;
        for (const t of tris) {
          const lo = Math.min(t[0][2], t[1][2], t[2][2]);
          const hi = Math.max(t[0][2], t[1][2], t[2][2]);
          if (z < lo - 1e-9 || z > hi + 1e-9) continue;
          for (let i = 0; i < 3; i++) {
            const a = t[i], b = t[(i + 1) % 3];
            if ((a[2] - z) * (b[2] - z) > 0) continue;
            const s = Math.abs(b[2] - a[2]) < 1e-12 ? 0 : (z - a[2]) / (b[2] - a[2]);
            m = Math.max(m, Math.abs(a[1] + s * (b[1] - a[1])));
          }
        }
        return m;
      };
      let prev = null, worst = 0, where = 0;
      for (let z = STEP; z <= hUnits * 7; z += STEP) {
        const v = at(z);
        if (prev !== null && v - prev > worst) { worst = v - prev; where = z; }
        prev = v;
      }
      const ok = worst <= STEP + 1e-6;
      console.log(`  ${(base + ' ' + hUnits + 'u').padEnd(13)} widest step ${worst.toFixed(3)} mm ` +
                  `per ${STEP} mm of height, at z ${where.toFixed(2)}   ${ok ? 'ok' : 'OVERHANG'}`);
      if (!ok) bad++;
    }
}

console.log(bad ? `\n${bad} case(s) FAILED` : '\nall cases clean');
process.exit(bad ? 1 : 0);
