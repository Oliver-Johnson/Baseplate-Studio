#!/usr/bin/env node
/* Watertightness audit for baseplates, matching the one the bins have had from the
 * start. Its absence is why this went unnoticed: fit-check.js proves a bin fits the
 * socket, and nothing ever asked whether the plate around that socket was closed.
 *
 * It is not. Every plate is generated without a top or bottom face — four outer
 * walls and the socket funnel surfaces, with neither annulus capping the ends. The
 * count is exactly 8 * arcSegs + 8 per cell: 4 outer-wall edges and 4*arcSegs socket
 * edges left unmatched at z=0, and the same again at the top.
 *
 * Capping a face that has holes in it is the one job earTriangulate fails at without
 * saying so — the same silent failure that shipped bins with 218 boundary edges.
 *
 * The caps are fixed. What still leaks all goes through csgSubtract, which is lossy
 * on its own — a watertight box minus a watertight cutter comes back with boundary
 * edges — so magnets, screws and every connector inherit it. Those cases are
 * quarantined by name rather than dropped, and the audit fails if a healthy case
 * regresses OR if a quarantined one starts passing and nobody removed it from the
 * list. Red forever teaches people to ignore a check; silent teaches them it never
 * mattered.
 */
'use strict';
const G = require('../src/core.js');

const CASES = [
  { name: '1x1 solid', drawerW: 42, drawerD: 42 },
  { name: '2x2 solid', drawerW: 84, drawerD: 84 },
  { name: '3x3 solid', drawerW: 126, drawerD: 126 },
  { name: '3x3 skeleton', drawerW: 126, drawerD: 126, plateStyle: 'skeleton' },
  { name: '3x3 coarse arcs', drawerW: 126, drawerD: 126, arcSegs: 6 },
  { name: '3x3 magnets', drawerW: 126, drawerD: 126, magnets: true, quarantine: 'csgSubtract' },
  { name: '3x3 screws', drawerW: 126, drawerD: 126, screws: true, quarantine: 'csgSubtract' },
  /* Must be big enough to split, or there are no seams and no connector is built --
     the first version of this case quietly measured a plain plate and "passed". */
  /* Connectors go through the same csgSubtract that leaks for magnets, and come out
     clean, so the CSG is not lossy in general — only for the pocket cutters. Worth
     keeping as a case precisely because it proves that. */
  { name: '9x9 dovetail', drawerW: 400, drawerD: 400, connector: 'dovetail' },
  { name: '9x9 no joint', drawerW: 400, drawerD: 400, connector: 'none' },
  { name: '5x4 solid', drawerW: 210, drawerD: 168 },
  { name: '3x3 with margin', drawerW: 140, drawerD: 140, marginMode: 'auto' },
];

let bad = 0;
console.log('case              grid    polys   W x D x H (mm)          mesh');
for (const cs of CASES) {
  const cfg = Object.assign({}, G.DEFAULTS, {
    marginMode: 'custom', mLeft: 0, mRight: 0, mFront: 0, mBack: 0,
    magnets: false, screws: false, arcSegs: 12,
  }, cs);
  let L, polys;
  try {
    L = G.computeLayout(cfg);
    const r = G.buildPiece(cfg, L, L.pieces[0]);
    polys = r.polys || r;
  } catch (e) {
    console.log(`${cs.name.padEnd(17)} BUILD FAILED: ${e.message}`);
    bad++; continue;
  }

  const man = G.checkManifold(polys);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const p of polys) for (const v of p.verts) {
    x0 = Math.min(x0, v[0]); x1 = Math.max(x1, v[0]);
    y0 = Math.min(y0, v[1]); y1 = Math.max(y1, v[1]);
    z0 = Math.min(z0, v[2]); z1 = Math.max(z1, v[2]);
  }
  /* A closed solid has a horizontal face at each end. Reporting this separately from
     the edge count says WHAT is missing rather than only how much. */
  const flatAt = (z) => polys.filter((p) => p.verts.every((v) => Math.abs(v[2] - z) < 1e-6)).length;
  const capBottom = flatAt(z0), capTop = flatAt(z1);
  const dims = `${(x1 - x0).toFixed(2)} x ${(y1 - y0).toFixed(2)} x ${(z1 - z0).toFixed(2)}`;
  const ok = man.bad === 0;

  const note = cs.quarantine
    ? (ok ? '  NOW PASSES — take it out of quarantine' : `  known: ${cs.quarantine}`)
    : '';
  console.log(`${cs.name.padEnd(17)} ${(L.nx + 'x' + L.ny).padEnd(6)} ${String(polys.length).padStart(6)}  ` +
              `${dims.padEnd(22)} ${ok ? 'watertight' : man.bad + ' BAD EDGES'}` +
              `${capBottom ? '' : '  NO BOTTOM FACE'}${capTop ? '' : '  NO TOP FACE'}${note}`);
  if (cs.quarantine ? ok : !ok) bad++;
}

/* The remaining leak, at its smallest. A closed box minus a closed cutter should be a
   closed solid. It is not, and that one fact explains every quarantined case above. */
console.log('\nthe CSG itself, minimum case:');
{
  const box = G.extrudePoly([[0, 0], [20, 0], [20, 20], [0, 20]], 0, 5);
  const cut = G.extrudePoly([[8, 8], [12, 8], [12, 12], [8, 12]], -1, 6);
  for (const [label, ps] of [['box', box], ['cutter', cut],
                             ['box minus cutter', G.csgSubtract(box, cut)]]) {
    const m = G.checkManifold(ps);
    console.log(`  ${label.padEnd(18)} ${m.bad ? m.bad + ' bad of ' + m.edges : 'watertight'}`);
  }
}

/* Caps used to leak 8*arcSegs + 8 per cell. Asserting zero at every smoothness stops a
   future change reintroducing a partial cap that only shows up at fine arcs. */
console.log('\nboundary edges per cell, at each smoothness:');
for (const n of [6, 8, 12, 24]) {
  const cfg = Object.assign({}, G.DEFAULTS, {
    drawerW: 42, drawerD: 42, marginMode: 'custom',
    mLeft: 0, mRight: 0, mFront: 0, mBack: 0,
    magnets: false, screws: false, arcSegs: n,
  });
  const L = G.computeLayout(cfg);
  const r = G.buildPiece(cfg, L, L.pieces[0]);
  const man = G.checkManifold(r.polys || r);
  console.log(`  arcSegs ${String(n).padStart(2)}   ${man.bad ? String(man.bad).padStart(4) + ' BAD EDGES' : 'watertight'}`);
  if (man.bad) bad++;
}

console.log(bad ? `\n${bad} case(s) FAILED`
                : '\nall plates watertight, bar the quarantined CSG cases');
process.exit(bad ? 1 : 0);
