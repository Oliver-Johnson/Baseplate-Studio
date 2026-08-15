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
 * The caps are fixed, so a plate that prints in one piece is watertight.
 *
 * csgSubtract used to be lossy whatever it was handed — a watertight box minus a
 * watertight cutter came back with boundary edges for an interior hole, a blind pocket,
 * an edge notch and a corner bite alike — so magnets, screws and every split piece
 * carrying a notch inherited it. Three cases were quarantined by name for that, and all
 * three now pass.
 *
 * Others were quarantined in their place. They are not regressions — every one of them
 * is one to two orders of magnitude better than it was — but they leak, and a summary
 * line reading "all plates watertight" over a configuration a user can select from a
 * dropdown is the kind of reassurance this file exists to stop. The puzzle notch has
 * since come off that list; the two boss cases have not.
 *
 * `quarantine: '<reason>'` makes the audit fail BOTH if a healthy case regresses AND if
 * a quarantined one starts passing and nobody took it off the list. Red forever teaches
 * people to ignore a check; silent teaches them it never mattered.
 */
'use strict';
const G = require('../src/core.js');

const CASES = [
  { name: '1x1 solid', drawerW: 42, drawerD: 42 },
  { name: '2x2 solid', drawerW: 84, drawerD: 84 },
  { name: '3x3 solid', drawerW: 126, drawerD: 126 },
  { name: '3x3 skeleton', drawerW: 126, drawerD: 126, plateStyle: 'skeleton' },
  { name: '3x3 coarse arcs', drawerW: 126, drawerD: 126, arcSegs: 6 },
  { name: '3x3 magnets', drawerW: 126, drawerD: 126, magnets: true },
  /* Screws are the case that proved the cutters must not be thrown into one soup: the
     shank runs up the middle of its own counterbore, and a BSP cannot classify a point
     that is inside two shells of one "solid". */
  { name: '3x3 screws', drawerW: 126, drawerD: 126, screws: true },
  /* Must be big enough to split, or there are no seams and no connector is built --
     the first version of this case quietly measured a plain plate and "passed". */
  { name: '9x9 dovetail', drawerW: 400, drawerD: 400, connector: 'dovetail' },
  { name: '9x9 no joint', drawerW: 400, drawerD: 400, connector: 'none' },
  { name: '5x4 solid', drawerW: 210, drawerD: 168 },
  { name: '3x3 with margin', drawerW: 140, drawerD: 140, marginMode: 'auto' },
  /* Every remaining connector, because all of them are dropdown options and only
     dovetail was ever covered. They have to be big enough to split, as above. */
  { name: '9x9 bowtie', drawerW: 400, drawerD: 400, connector: 'bowtie' },
  { name: '9x9 puzzlekey', drawerW: 400, drawerD: 400, connector: 'puzzlekey' },
  { name: '9x9 snap', drawerW: 400, drawerD: 400, connector: 'snap' },
  { name: '9x9 hclip', drawerW: 400, drawerD: 400, connector: 'hclip' },
  { name: '3x3 magnets above', drawerW: 126, drawerD: 126, magnets: true, magnetSide: 'top' },
  { name: '3x3 magnets+screws', drawerW: 126, drawerD: 126, magnets: true, screws: true },
  /* Quarantined for most of this file's life, at 78 bad edges and then 5033 before that:
     30 used once and 40 used three times, a genuine open boundary on 3 of the 4 pieces.
     The reason on file was that the notch presents a reflex outline to the cutter. It
     does, and that was not the problem — a cell region minus this cutter is watertight
     with the reflex corner untouched. The outline was NON-SIMPLE: the neck flank ran a
     third of a millimetre past the point where the lobe circle crosses it and came back
     along itself, so extrudePoly gave the cutter two coincident side quads facing
     opposite ways and the BSP was being asked about points inside a shell twice. See
     puzzleShape. */
  { name: '9x9 puzzle', drawerW: 400, drawerD: 400, connector: 'puzzle' },

  /* --- quarantined: real, measured, not regressions, still leaking --- */

  /* The same joint at the smoothness the tool actually ships, which is the case above
     minus its luck — except that it is not luck, it is deterministic. One edge per
     notch, always used 4, never once: the lobe's far pole points at the seam, the
     boundary between two cell regions is on that same line, and both regions cut the
     same notch, so both carry the apex vertex and the vertical edge either side of it.
     Two closed shells sharing an edge, exactly like the bosses below.

     It is here rather than fixed because every fix costs joint geometry. Sliding the
     joint 0.09 mm along the seam to get the apex out of the overlap band does clear it
     — and lands the lobe on the socket's flat wall at x = 2.15 instead, which opens
     five REAL boundary edges. Reshaping the lobe so no vertex sits at the pole moves the
     notch's reach. Measured across 6/8/12/24 at six drawer sizes: 6 and 8 carry one such
     edge per notch, 12 and 24 carry none, with no size dependence either way. */
  { name: '9x9 puzzle @6', drawerW: 400, drawerD: 400, connector: 'puzzle', arcSegs: 6,
    quarantine: 'lobe apex sits on a region boundary' },
  /* Benign, but it has to be named rather than waved through: corner bosses of adjacent
     cells ABUT face to face on the cell boundary instead of overlapping by BLOAT, so
     every shared face is counted twice. All counts are 4 and 6, never 1 — no boundary
     edge, no hole. The fix is to bloat the bosses; it changes their footprint, so it is
     not a change to make while chasing something else. Was 2964 and 8332. */
  { name: '3x3 bosses+magnets', drawerW: 126, drawerD: 126, magnets: true,
    baseMode: 'bosses', quarantine: 'bosses abut, not overlap' },
  { name: '3x3 bosses+screws', drawerW: 126, drawerD: 126, screws: true,
    baseMode: 'bosses', quarantine: 'bosses abut, not overlap' },
];

let bad = 0;
console.log('case              grid    polys   W x D x H (mm)          mesh');
for (const cs of CASES) {
  const cfg = Object.assign({}, G.DEFAULTS, {
    marginMode: 'custom', mLeft: 0, mRight: 0, mFront: 0, mBack: 0,
    magnets: false, screws: false, arcSegs: 12,
  }, cs);
  /* EVERY piece, not just the first. Checking pieces[0] alone reported a split
     dovetail plate as watertight: that piece carries 8 tabs and no notches, so it
     never subtracts, while the three pieces holding the notches leaked 3000+ edges
     each. A case that does not build the geometry it names is worse than no case. */
  let L, pieces;
  try {
    L = G.computeLayout(cfg);
    pieces = L.pieces.map((pc) => {
      const r = G.buildPiece(cfg, L, pc);
      return r.polys || r;
    });
  } catch (e) {
    console.log(`${cs.name.padEnd(17)} BUILD FAILED: ${e.message}`);
    bad++; continue;
  }

  const mans = pieces.map((p) => G.checkManifold(p));
  const man = mans.reduce((a, b) => (b.bad > a.bad ? b : a));
  const leaking = mans.filter((m) => m.bad).length;
  const polys = pieces[0];
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
  const many = pieces.length > 1 ? ` [${leaking}/${pieces.length} pieces leak]` : '';
  /* An edge used once is a hole; an edge used four times is two shells touching. Both
     count as "bad" and they need completely different fixes, so say which. */
  const shape = ok ? '' : '  ' + boundaryShare(pieces);
  console.log(`${cs.name.padEnd(19)} ${(L.nx + 'x' + L.ny).padEnd(6)} ${String(polys.length).padStart(6)}  ` +
              `${dims.padEnd(22)} ${ok ? 'watertight' : man.bad + ' BAD EDGES' + many}` +
              `${capBottom ? '' : '  NO BOTTOM FACE'}${capTop ? '' : '  NO TOP FACE'}${shape}${note}`);
  if (cs.quarantine ? ok : !ok) bad++;
}

/* How many of the bad edges are actually open boundary, and how many are shells meeting
   face to face. Reported as a histogram of edge use, because "120 bad edges, all of them
   used 4 times" and "120 bad edges, 30 of them used once" are different bugs. */
function boundaryShare(pieces) {
  const hist = new Map();
  for (const polys of pieces) {
    const key = (v) => v.map((x) => Math.round(x * 1000) / 1000).join(',');
    const edges = new Map();
    for (const t of G.polysToTriangles(polys))
      for (let i = 0; i < 3; i++) {
        const a = key(t[i]), b = key(t[(i + 1) % 3]);
        const k = a < b ? a + '|' + b : b + '|' + a;
        edges.set(k, (edges.get(k) || 0) + 1);
      }
    for (const c of edges.values()) if (c !== 2) hist.set(c, (hist.get(c) || 0) + 1);
  }
  const open = [...hist.entries()].filter(([c]) => c % 2 === 1).reduce((s, [, n]) => s + n, 0);
  return `[${[...hist.entries()].sort((a, b) => a[0] - b[0]).map(([c, n]) => `${n}x used ${c}`).join(', ')}` +
         `${open ? ' — OPEN BOUNDARY' : ' — shells touching, no hole'}]`;
}

/* Enclosed volume by the divergence theorem. Every triangle contributes its tetrahedron
   with the origin, so a mesh with a hole in it, a doubled face or an inside-out triangle
   all get the wrong answer — and unlike the edge count, this is a number healCsgSeams
   cannot reach. It repairs connectivity, so "watertight" is a metric it optimises
   directly; volume is the independent one, and it is what caught the screw counterbore
   never being cut at all. */
function volume(polys) {
  let v = 0;
  for (const t of G.polysToTriangles(polys)) {
    const [a, b, c] = t;
    v += (a[0]*(b[1]*c[2] - c[1]*b[2]) - a[1]*(b[0]*c[2] - c[0]*b[2]) + a[2]*(b[0]*c[1] - c[0]*b[1])) / 6;
  }
  return v;
}

/* The CSG at its smallest, in the four shapes a cut can take. A closed box minus a
   closed prism must be a closed solid of exactly the arithmetic volume. All four used to
   come back with boundary edges, which is where healCsgSeams was written from; keep them,
   so the next person to touch the BSP finds out here rather than on a 30k-polygon plate.
   The expected volumes are 20x20x5 = 2000 minus the cut: 4x4x5, 4x4x3, 6x4x5 clipped to
   the box, 6x6x5 clipped to the box. */
console.log('\nthe CSG itself, minimum cases:');
{
  const box = () => G.extrudePoly([[0, 0], [20, 0], [20, 20], [0, 20]], 0, 5);
  const CUTS = [
    ['through the middle, out both faces', [[8, 8], [12, 8], [12, 12], [8, 12]], -1, 6, 1920],
    ['blind pocket from the top', [[8, 8], [12, 8], [12, 12], [8, 12]], 2, 6, 1952],
    ['notch from an edge', [[-1, 8], [6, 8], [6, 12], [-1, 12]], -1, 6, 1880],
    ['bite from a corner', [[-1, -1], [6, -1], [6, 6], [-1, 6]], -1, 6, 1820],
  ];
  for (const [label, pts, z0, z1, want] of CUTS) {
    const cut = G.extrudePoly(pts, z0, z1);
    const before = G.checkManifold(cut);
    const res = G.csgSubtract(box(), cut);
    const m = G.checkManifold(res);
    const v = volume(res);
    const vOk = Math.abs(v - want) < 1e-6;
    console.log(`  ${label.padEnd(36)} cutter ${before.bad ? 'BAD' : 'ok'}   ` +
                `result ${(m.bad ? m.bad + ' bad of ' + m.edges : 'watertight').padEnd(11)}` +
                `  volume ${v.toFixed(6)} of ${want}${vOk ? '' : '  WRONG'}`);
    if (before.bad || m.bad || !vOk) bad++;
  }
}

/* csgUnion had no test at all, and fastenerCutter now depends on it for every magnet and
   screw pocket. These are the two unions it actually performs. Both were broken before
   the repair pass existed — 74 and 71 bad edges — which nothing would have told us. */
console.log('\ncsgUnion, the cases fastenerCutter relies on:');
{
  const cyl = (r, z0, z1, seg) => G.extrudePoly(
    Array.from({ length: seg }, (_, i) => {
      const a = 2 * Math.PI * i / seg;
      return [r * Math.cos(a), r * Math.sin(a)];
    }), z0, z1);
  const area = (r, n) => 0.5 * n * r * r * Math.sin(2 * Math.PI / n);
  const CASES2 = [
    ['counterbore over shank', cyl(3, -0.5, 2, 14), cyl(1.5, -0.5, 7.55, 12),
     area(3, 14) * 2.5 + area(1.5, 12) * 5.55],
    ['magnet pocket over counterbore', cyl(3.1, -0.5, 2, 14), cyl(3, -0.5, 2, 14),
     area(3.1, 14) * 2.5],
  ];
  for (const [label, a, b, want] of CASES2) {
    const u = G.csgUnion(a, b);
    const m = G.checkManifold(u);
    const v = volume(u);
    const vOk = Math.abs(v - want) < 1e-6;
    console.log(`  ${label.padEnd(36)} ${(m.bad ? m.bad + ' bad of ' + m.edges : 'watertight').padEnd(11)}` +
                `  volume ${v.toFixed(6)} of ${want.toFixed(6)}${vOk ? '' : '  WRONG'}`);
    if (m.bad || !vOk) bad++;
  }
}

/* The rim cap has to be a VALID tiling, not merely a closed one.
 *
 * Watertightness cannot see a triangle that is inside out, and for most of this
 * project's life 21% of every cell rim was at the shipped smoothness, rising to 33% at
 * arcSegs 24. The cap pairs a 4-corner outline against a 4*arcSegs socket ring by
 * sweeping angle, and a fan from one outline corner turns over once it passes that
 * corner's tangent to the ring.
 *
 * Two independent things are asserted, and it is worth being precise about what each one
 * can and cannot catch, because the first draft of this check got it wrong:
 *
 *   - No triangle has negative area. This is the one that catches the inversion.
 *   - The strip emits exactly outline + ring triangles, which catches a dropped or
 *     duplicated one.
 *
 * There was a third — the signed areas summing to outline minus ring — presented as
 * complementary. It is not: for ANY complete pairing of the two loops the interior
 * spokes cancel and the sum telescopes to that value by Green's theorem, whatever the
 * orientations. It passed at 1e-13 on the fully broken version, for every smoothness. A
 * check that cannot fail on the bug its own comment describes is worse than no check,
 * so it is gone rather than kept as decoration. */
console.log('\nrim cap tiling, at each smoothness:');
for (const n of [6, 8, 12, 24]) {
  const H = 4.25;
  const prof = { pitchHalf: 21, rTop: 4.0, zs: [-1, 0, 0.7, 2.5, H, H + 1.5],
                 ds: [2.85, 2.85, 2.15, 2.15, 0.4, 0.4] };
  const cell = [[-0.05, -0.05], [42.05, -0.05], [42.05, 42.05], [-0.05, 42.05]];
  const polys = G.directCellRegion(cell, prof, 21, 21, H, 0, n);
  const top = polys.filter((p) => p.verts.every((v) => Math.abs(v[2] - H) < 1e-9));
  let flipped = 0;
  for (const p of top) if (G.polyArea2D(p.verts.map((v) => [v[0], v[1]])) < -1e-12) flipped++;
  const wantTris = cell.length + 4 * n;
  const ok = flipped === 0 && top.length === wantTris;
  console.log(`  arcSegs ${String(n).padStart(2)}   ${String(top.length).padStart(3)} of ${wantTris} tris   ` +
              (flipped ? `${flipped} INSIDE OUT (${(100 * flipped / top.length).toFixed(0)}%)` : 'all outward'));
  if (!ok) bad++;
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

/* The puzzle joint, measured off the BUILT MESH.
 *
 * Watertightness was bought by changing the notch outline, and a change to a cutter's
 * outline is one edit away from a change to the fit. Nothing above would notice: a
 * jigsaw joint 0.3 mm slacker in the throat is exactly as watertight and prints exactly
 * as well, right up to the point where the pieces will not hold together.
 *
 * So the numbers come out of the finished triangle soup rather than out of puzzleShape,
 * and they are read off two surfaces that cannot be confused with anything else near
 * them: the notch cavity is the only thing with a downward-facing horizontal face at the
 * cut height, and the male tab the only thing with an upward-facing one at the tab
 * height. Everything else at that height is a side wall, a socket or a cell floor.
 *
 * What is asserted is the FIT — throat, reach and lobe of the cavity against the same
 * three on the tab — because that is the thing a user feels. The absolute sizes are
 * asserted too, against the parameters rather than against remembered numbers, so this
 * still means something if cfg.puzzle is ever retuned. */
console.log('\nthe puzzle joint, off the built mesh:');
{
  const cfg = Object.assign({}, G.DEFAULTS, {
    drawerW: 400, drawerD: 400, marginMode: 'custom',
    mLeft: 0, mRight: 0, mFront: 0, mBack: 0,
    magnets: false, screws: false, arcSegs: 12, connector: 'puzzle',
  });
  const L = G.computeLayout(cfg);
  const built = {};
  for (const pc of L.pieces) built[pc.id] = G.buildPiece(cfg, L, pc);

  // every vertex of every horizontal triangle at height z facing the given way
  const faceAt = (polys, z, up) => {
    const out = [];
    for (const t of G.polysToTriangles(polys)) {
      if (!t.every((v) => Math.abs(v[2] - z) < 1e-6)) continue;
      const nz = (t[1][0]-t[0][0])*(t[2][1]-t[0][1]) - (t[1][1]-t[0][1])*(t[2][0]-t[0][0]);
      if (Math.abs(nz) > 1e-12 && (nz > 0) === up) out.push(...t.map((v) => [v[0], v[1]]));
    }
    return out;
  };
  /* Reduced to (depth into the piece, offset along the seam) about one joint site, and
     windowed to that site so a neighbouring one 42 mm away cannot contribute. */
  const shape = (pts, dep, lat) => {
    const P = pts.map((q) => [dep(q), lat(q)])
                 .filter((p) => p[0] > -1 && p[0] < 14 && Math.abs(p[1]) < 8);
    if (P.length < 3) return null;
    const reach = Math.max(...P.map((p) => p[0]));
    const lobe = Math.max(...P.map((p) => Math.abs(p[1])));
    // the straight neck runs from behind the seam to the lobe junction, ~0.55 deep
    const throat = 2 * Math.max(...P.filter((p) => p[0] < 0.5).map((p) => Math.abs(p[1])));
    return { throat, reach, lobe };
  };

  const pz = cfg.puzzle;
  const zCut = Math.max(cfg.bottomPad, 2.6) - 0.4;         // notch ceiling
  const zTab = Math.max(1.2, Math.max(cfg.bottomPad, 2.6) - 0.65);
  const notch = shape(faceAt(built.A2.polys, zCut, false), (q) => q[1], (q) => q[0] - 42);
  const tab = shape(faceAt(built.A1.polys, zTab, true),
                    (q) => q[1] - built.A1.D, (q) => q[0] - 42);
  if (!notch || !tab) {
    console.log('  NO JOINT SURFACE FOUND — the measurement, not the joint, is broken');
    bad++;
  } else {
    /* The tab's flank and far pole are both sampled points on its outline, so these are
       exact; the widest point of the lobe need not be sampled, so that one is compared
       within the sagitta of a 19-point arc on r ≈ 4.6, which is 0.02 mm. */
    const want = [
      ['throat  (neckW + 2 grow)', notch.throat, pz.neckW + 2*pz.clr, tab.throat, pz.neckW, 2*pz.clr, 1e-9],
      ['reach   (neck + lobe)   ', notch.reach, pz.neckL + pz.lobeR*1.55 + pz.clr,
                                   tab.reach, pz.neckL + pz.lobeR*1.55, pz.clr, 1e-9],
      ['lobe    (radius)        ', notch.lobe, pz.lobeR + pz.clr, tab.lobe, pz.lobeR, pz.clr, 0.021],
    ];
    for (const [label, nv, nWant, tv, tWant, gap, tol] of want) {
      const ok = Math.abs(nv - nWant) <= tol && Math.abs(tv - tWant) <= tol &&
                 Math.abs((nv - tv) - gap) <= 2 * tol;
      console.log(`  ${label}  notch ${nv.toFixed(4)} of ${nWant.toFixed(4)}` +
                  `   tab ${tv.toFixed(4)} of ${tWant.toFixed(4)}` +
                  `   clearance ${(nv - tv).toFixed(4)} of ${gap.toFixed(4)}` +
                  `${ok ? '' : '   FIT CHANGED'}`);
      if (!ok) bad++;
    }
  }
}

console.log(bad ? `\n${bad} case(s) FAILED` : '\nall plates watertight');
process.exit(bad ? 1 : 0);
