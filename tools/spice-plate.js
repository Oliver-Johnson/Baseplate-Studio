#!/usr/bin/env node
/*
  Spice jar baseplate generator — hex-packed sockets for Sainsbury's spice jars.

  Not Gridfinity. Shares Drawerforge's philosophy (drawer-first, split for the bed,
  verified watertight headlessly) but none of its 42 mm geometry.

  NO CSG. The plate is a prism over a 2D region, built by region decomposition:
  every jar owns its Voronoi cell, and the material in that cell is the ring between
  the cell polygon and the socket bore. Cells tile exactly, so their triangulations
  weld into one manifold top surface; side walls are then extruded from whichever
  edges appear only once. See docs/SPICE.md.

  Usage:  node tools/spice-plate.js [--out DIR]
*/
'use strict';
const fs = require('fs');
const path = require('path');
const { stlBinary, checkManifold } = require('../src/core.js');

/* ---------------- measured inputs ---------------- */
/* Oliver's calipers, 2026-08-15. The lid is the widest part of the jar and is what
   sets the packing pitch; the bore grips the body, which is 2.05 mm narrower. */
const JAR = {
  lid:   48.85,   // widest point, from a 2-jar touching span of 97.7
  body:  46.80,   // glass barrel
  base:  44.00,   // at the floor, tapering to full body over the first 3 mm
  taper:  3.00,
  height:83.70,
};
const DRAWER = {
  width:  217.90, // = 4 x lid + the 22.5 mm gap left by 4 jars pushed to one side
  excess:  11.60, // depth left over with all 32 jars compressed to a nest
  head:    10.80, // above the jar tops
};

/* ---------------- derived lattice ----------------
   q = gap - 3c falls straight out of the width; r is then forced by p and q.
   Recomputed here rather than hard-coded so changing the clearance stays honest. */
const CLEAR = 0.40;                                   // between adjacent lids
const p = JAR.lid + CLEAR;                            // 49.25  in-row pitch
const q = (DRAWER.width - 4 * JAR.lid) - 0.5 - 3 * CLEAR;  // 20.80  row offset
const r = Math.sqrt(p * p - q * q);                   // 44.64  row spacing

const CFG = {
  p, q, r,
  bore:  JAR.body + 0.60,   // 47.40 — 0.30 mm radial; the jar's 3 mm base taper is the lead-in
  collar: 1.85,             // material beyond the bore. Without this the Voronoi cells fill
                            // every interstice and the plate is a solid slab with holes (218 g).
  collarSeg: 48,
  h:      8.00,             // web height: enough to stop sliding. Packed jars cannot tip.
  skinW:  0.60,             // outer skin across the width — all the drawer can spare
  skinD:  0.80,             // outer skin front/back, where there is more room
  rows:   8, cols: 4,
  seg:   72,                // bore facets
  bed:  256,
};

/* ---------------- 2D helpers ---------------- */
const SNAP = 1e-4;                        // quantise so shared cell edges weld exactly
const sn = v => Math.round(v / SNAP) * SNAP;
const key2 = pt => sn(pt[0]) + ',' + sn(pt[1]);

function area2(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    s += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1];
  }
  return s / 2;
}

// Sutherland-Hodgman: keep the half-plane nx*x + ny*y <= d
function clipHalf(poly, nx, ny, d) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const A = poly[i], B = poly[(i + 1) % poly.length];
    const fa = nx * A[0] + ny * A[1] - d;
    const fb = nx * B[0] + ny * B[1] - d;
    if (fa <= 0) out.push(A);
    if ((fa < 0 && fb > 0) || (fa > 0 && fb < 0)) {
      const t = fa / (fa - fb);
      out.push([A[0] + t * (B[0] - A[0]), A[1] + t * (B[1] - A[1])]);
    }
  }
  // drop duplicates introduced by clipping exactly through a vertex
  const clean = [];
  for (const pt of out) {
    const last = clean[clean.length - 1];
    if (!last || Math.abs(last[0] - pt[0]) > 1e-9 || Math.abs(last[1] - pt[1]) > 1e-9) clean.push(pt);
  }
  if (clean.length > 1) {
    const f = clean[0], l = clean[clean.length - 1];
    if (Math.abs(f[0] - l[0]) < 1e-9 && Math.abs(f[1] - l[1]) < 1e-9) clean.pop();
  }
  return clean;
}

/* Ring between a convex outer polygon and a circle strictly inside it.
   Both loops are star-shaped about the centre, so a two-pointer angular merge is
   exact and always yields outer.length + inner.length triangles. This is the part
   core.js's triangulateRing does not cover — it bridges, which needs the rim shapes
   it was written for. */
function ringStrip(outer, inner, cx, cy) {
  const ang = pt => {
    let a = Math.atan2(pt[1] - cy, pt[0] - cx);
    return a < 0 ? a + 2 * Math.PI : a;
  };
  const rot = (list) => {
    // rotate so index 0 has the smallest angle -> both loops sweep CCW from there
    let m = 0;
    for (let i = 1; i < list.length; i++) if (ang(list[i]) < ang(list[m])) m = i;
    return list.slice(m).concat(list.slice(0, m));
  };
  const O = rot(outer.slice()), I = rot(inner.slice());
  const aO = O.map(ang), aI = I.map(ang);

  const tris = [];
  let i = 0, j = 0;
  const nI = I.length, nO = O.length;
  // align: start the outer pointer at the last outer vertex not ahead of inner[0]
  while (j + 1 < nO && aO[j + 1] <= aI[0]) j++;

  let usedI = 0, usedO = 0;
  while (usedI < nI || usedO < nO) {
    const nextI = usedI < nI ? (aI[(i + 1) % nI] + (i + 1 >= nI ? 2 * Math.PI : 0)) : Infinity;
    const nextO = usedO < nO ? (aO[(j + 1) % nO] + (j + 1 >= nO ? 2 * Math.PI : 0)) : Infinity;
    if (usedI < nI && (nextI <= nextO || usedO >= nO)) {
      const i2 = (i + 1) % nI;
      tris.push([O[j], I[i2], I[i]]);       // inner traversed CW -> CCW triangle
      i = i2; usedI++;
    } else {
      const j2 = (j + 1) % nO;
      tris.push([O[j], O[j2], I[i]]);
      j = j2; usedO++;
    }
  }
  return tris;
}

/* ---------------- build ---------------- */
function centresFor(rows, cols) {
  const out = [];
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++)
      out.push({ x: (j % 2) * CFG.q + i * CFG.p, y: j * CFG.r, row: j, col: i });
  return out;
}

function boreCircle(cx, cy) {
  // circumscribe so the flats are tangent to the nominal bore, not chords inside it
  const R = (CFG.bore / 2) / Math.cos(Math.PI / CFG.seg);
  const pts = [];
  for (let k = 0; k < CFG.seg; k++) {
    const a = 2 * Math.PI * k / CFG.seg;
    pts.push([sn(cx + R * Math.cos(a)), sn(cy + R * Math.sin(a))]);
  }
  return pts;                                   // CCW
}

/*
  all      – every jar in the lattice (Voronoi neighbours come from here, so a piece
             never over-clips at a seam it shares with the other piece)
  members  – indices belonging to this piece
  rect     – plate outline {x0,y0,x1,y1}
*/
function buildPiece(all, members, rect) {
  const topTris = [];
  for (const idx of members) {
    const c = all[idx];
    let cell = [[rect.x0, rect.y0], [rect.x1, rect.y0], [rect.x1, rect.y1], [rect.x0, rect.y1]];
    for (let k = 0; k < all.length && cell.length >= 3; k++) {
      if (k === idx) continue;
      const dx = all[k].x - c.x, dy = all[k].y - c.y;
      cell = clipHalf(cell, dx, dy, dx * c.x + dy * c.y + (dx * dx + dy * dy) / 2);
    }
    /* Clip to the collar. Where two collars overlap the Voronoi bisector binds first
       (24.63 < 25.55) so the shared wall stays a straight welded edge; where they do
       not reach — the 52.93 mm diagonal — the arc binds and a lightening hole opens.
       Convex ∩ convex, so the cell stays convex and ringStrip still applies. */
    const Rc = CFG.bore / 2 + CFG.collar;
    for (let k = 0; k < CFG.collarSeg && cell.length >= 3; k++) {
      const a = 2 * Math.PI * k / CFG.collarSeg, nx = Math.cos(a), ny = Math.sin(a);
      cell = clipHalf(cell, nx, ny, nx * c.x + ny * c.y + Rc);
    }
    if (cell.length < 3) throw new Error(`cell ${idx} collapsed`);
    cell = cell.map(pt => [sn(pt[0]), sn(pt[1])]);
    if (area2(cell) < 0) cell.reverse();

    // the bore must sit strictly inside its cell or the ring is not a ring
    const R = CFG.bore / 2;
    for (let i = 0; i < cell.length; i++) {
      const A = cell[i], B = cell[(i + 1) % cell.length];
      const ex = B[0] - A[0], ey = B[1] - A[1], L = Math.hypot(ex, ey);
      if (L < 1e-9) continue;
      const dist = (ex * (c.y - A[1]) - ey * (c.x - A[0])) / L;   // +ve = left = inside, cell is CCW
      if (dist < R + 1e-6) throw new Error(`bore ${idx} breaks its cell (${dist.toFixed(3)} < ${R})`);
    }
    for (const t of ringStrip(cell, boreCircle(c.x, c.y), c.x, c.y)) topTris.push(t);
  }

  // boundary = any directed edge whose reverse never appears
  const seen = new Map();
  for (const t of topTris)
    for (let i = 0; i < 3; i++)
      seen.set(key2(t[i]) + '>' + key2(t[(i + 1) % 3]), [t[i], t[(i + 1) % 3]]);
  const boundary = [];
  for (const [k, e] of seen) {
    const [a, b] = k.split('>');
    if (!seen.has(b + '>' + a)) boundary.push(e);
  }

  const H = CFG.h, polys = [];
  for (const t of topTris) {
    polys.push({ verts: t.map(v => [v[0], v[1], H]) });                       // top, up
    polys.push({ verts: [...t].reverse().map(v => [v[0], v[1], 0]) });        // bottom, down
  }
  for (const [a, b] of boundary)                                             // wall, outward
    polys.push({ verts: [[a[0], a[1], H], [a[0], a[1], 0], [b[0], b[1], 0], [b[0], b[1], H]] });

  return polys;
}

function bbox(polys) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of polys) for (const v of p.verts) for (let i = 0; i < 3; i++) {
    if (v[i] < lo[i]) lo[i] = v[i];
    if (v[i] > hi[i]) hi[i] = v[i];
  }
  return { lo, hi, size: hi.map((h, i) => h - lo[i]) };
}
const translate = (polys, d) =>
  polys.map(p => ({ verts: p.verts.map(v => [v[0] + d[0], v[1] + d[1], v[2] + d[2]]) }));

// signed volume via the divergence theorem — also a second opinion on watertightness,
// since an open mesh gives a nonsense answer where checkManifold only counts edges
function volumeMM3(polys) {
  let v = 0;
  for (const p of polys)
    for (let i = 2; i < p.verts.length; i++) {
      const [a, b, c] = [p.verts[0], p.verts[i - 1], p.verts[i]];
      v += (a[0] * (b[1] * c[2] - b[2] * c[1])
          - a[1] * (b[0] * c[2] - b[2] * c[0])
          + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
    }
  return v;
}

function emit(outDir, name, polys, note) {
  const b = bbox(polys);
  const placed = translate(polys, [-b.lo[0], -b.lo[1], -b.lo[2]]);
  const man = checkManifold(placed);
  const fits = b.size[0] <= CFG.bed && b.size[1] <= CFG.bed;
  const vol = volumeMM3(placed);
  // walls this thin print solid, so volume is the material — 1.24 g/cm3 for PLA
  const grams = vol / 1000 * 1.24;
  fs.writeFileSync(path.join(outDir, name + '.stl'), Buffer.from(stlBinary(placed, name)));
  console.log(
    `  ${name.padEnd(22)} ${b.size[0].toFixed(2)} x ${b.size[1].toFixed(2)} x ${b.size[2].toFixed(2)} mm` +
    `  ${String(man.tris).padStart(6)} tris  ${grams.toFixed(0).padStart(3)} g  ` +
    (man.bad === 0 && vol > 0 ? 'watertight' : `NON-MANIFOLD (${man.bad} bad edges)`) +
    (fits ? '' : '  *** EXCEEDS BED ***') + (note ? `  — ${note}` : '')
  );
  return man.bad === 0 && vol > 0 && fits;
}

function main() {
  const argOut = process.argv.indexOf('--out');
  const outDir = argOut > -1 ? process.argv[argOut + 1] : path.join(__dirname, '..', 'out');
  fs.mkdirSync(outDir, { recursive: true });

  const R = CFG.bore / 2;
  console.log('\nSpice baseplate — Sainsbury\'s jar, 8 rows of 4\n');
  console.log(`  lid ${JAR.lid}  body ${JAR.body}  clearance ${CLEAR.toFixed(2)}`);
  console.log(`  pitch p ${p.toFixed(2)}   offset q ${q.toFixed(2)}   row spacing r ${r.toFixed(2)}`);
  console.log(`  bore ${CFG.bore.toFixed(2)}   shared wall ${(p - CFG.bore).toFixed(2)}   web height ${CFG.h}\n`);

  // ---- full lattice + plate outline
  const all = centresFor(CFG.rows, CFG.cols);
  const xs = all.map(c => c.x), ys = all.map(c => c.y);
  const rect = {
    x0: Math.min(...xs) - R - CFG.skinW, x1: Math.max(...xs) + R + CFG.skinW,
    y0: Math.min(...ys) - R - CFG.skinD, y1: Math.max(...ys) + R + CFG.skinD,
  };
  const plateW = rect.x1 - rect.x0, plateD = rect.y1 - rect.y0;
  const lidEnv = 3 * p + q + JAR.lid;
  console.log(`  plate ${plateW.toFixed(2)} x ${plateD.toFixed(2)}   ` +
              `fit clearance ${((DRAWER.width - plateW) / 2).toFixed(2)} per side`);
  console.log(`  lid envelope ${lidEnv.toFixed(2)} in a ${DRAWER.width} drawer\n`);

  let ok = true;
  console.log('print first —');
  // ---- fit strip: two full-width rows, its own tight outline
  const strip = centresFor(2, CFG.cols);
  const sxs = strip.map(c => c.x), sys = strip.map(c => c.y);
  ok &= emit(outDir, 'spice-fit-strip', buildPiece(strip, strip.map((_, i) => i), {
    x0: Math.min(...sxs) - R - CFG.skinW, x1: Math.max(...sxs) + R + CFG.skinW,
    y0: Math.min(...sys) - R - CFG.skinD, y1: Math.max(...sys) + R + CFG.skinD,
  }), 'full drawer width, 8 jars');

  console.log('\nthen —');
  // ---- the plate, split by whole cells so the seam zigzags between sockets.
  // A straight cut cannot miss them: rows are 44.64 apart but the bore is 47.40.
  const half = Math.floor(CFG.rows / 2);
  ok &= emit(outDir, 'spice-plate-1of2',
    buildPiece(all, all.map((c, i) => [c, i]).filter(([c]) => c.row < half).map(([, i]) => i), rect),
    `rows 1-${half}`);
  ok &= emit(outDir, 'spice-plate-2of2',
    buildPiece(all, all.map((c, i) => [c, i]).filter(([c]) => c.row >= half).map(([, i]) => i), rect),
    `rows ${half + 1}-${CFG.rows}`);

  console.log(`\n  ${outDir}\n`);
  if (!ok) { console.error('FAILED: see above\n'); process.exit(1); }
}

if (require.main === module) main();
module.exports = { CFG, JAR, DRAWER, buildPiece, centresFor, ringStrip, clipHalf };
