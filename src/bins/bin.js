/* Drawerforge — Gridfinity bin geometry.
 *
 * Built entirely by direct mesh construction and overlapping closed shells.
 * There is NO CSG in this file: see docs/ENGINE rules — the hand-rolled BSP is
 * fragile around the conical foot surfaces, and every feature here can be made
 * additively instead. Shells overlap by BLOAT and the slicer fuses them.
 *
 * Spec (42 mm pitch), from the published Gridfinity specification:
 *   footprint 41.5 mm square at its widest, corner fillet r = 3.75 mm
 *   foot profile from the bottom: 35.6 -> 0.8 mm @45deg -> 37.2,
 *                                 1.8 mm vertical,
 *                                 2.15 mm @45deg -> 41.5
 *   total foot height 4.75 mm; heights quantise to 7 mm units
 *
 * Every rounded square here shares one corner-arc centre at 17.00 mm
 * (= 41.5/2 - 3.75). Keeping that constant is what makes clearance uniform
 * around the perimeter — see docs/socket-clearance.md for why that matters.
 *
 * Runs in the browser and headless in Node (module.exports guard at the bottom).
 */
'use strict';

const SPEC = {
  pitch: 42,
  footH: 4.75,          // total height of the base
  half: 41.5 / 2,       // 20.75 — half-width at the widest point
  r: 3.75,              // corner fillet at the widest point
  centre: 41.5 / 2 - 3.75, // 17.00 — corner-arc centre, constant at every height
  unitH: 7,             // height quantum
  // [z, half-width] — corner radius at each level is always (half - centre)
  prof: [[0, 35.6 / 2], [0.8, 37.2 / 2], [2.6, 37.2 / 2], [4.75, 41.5 / 2]],
};

const BLOAT = 0.05;     // shell overlap; never rely on coincident faces

const BIN_DEFAULTS = {
  u: 1, v: 1,           // footprint in grid cells
  hUnits: 3,            // height in 7 mm units (total, base included)
  wall: 1.2,            // side wall thickness
  floorT: 1.2,          // floor thickness above the top of the base
  divX: 0, divY: 0,     // interior dividers (cuts, not compartments)
  solid: false,         // no cavity at all
  arcSegs: 12,          // corner-arc segments; only affects the bin's own smoothness
  shrink: 0,            // extra clearance per side, on top of the spec's 0.25
};

/* ---------- 2D outlines --------------------------------------------------- */

// Rounded rectangle centred on origin, CCW, sharing SPEC.centre where possible.
function roundRect(hw, hd, r, n) {
  r = Math.max(0.2, Math.min(r, Math.min(hw, hd) - 0.01));
  const pts = [];
  const cs = [[hw - r, hd - r, 0], [-hw + r, hd - r, 90],
              [-hw + r, -hd + r, 180], [hw - r, -hd + r, 270]];
  for (const [ox, oy, a0] of cs)
    for (let k = 0; k <= n; k++) {
      const a = (a0 + 90 * k / n) * Math.PI / 180;
      pts.push([ox + r * Math.cos(a), oy + r * Math.sin(a)]);
    }
  return pts;
}

// The bin's outer outline at a given foot half-width, for a u x v footprint.
// Extra cells extend the straight sections; the corners keep the spec radius.
function outlineAt(u, v, half, shrink, n) {
  const hw = (u - 1) * SPEC.pitch / 2 + half - shrink;
  const hd = (v - 1) * SPEC.pitch / 2 + half - shrink;
  return roundRect(hw, hd, half - SPEC.centre, n);
}

/* ---------- mesh helpers -------------------------------------------------- */

function sweep(mk, rings, zs) {
  // side faces between consecutive rings, as TRIANGLES — corner-arc faces are
  // conical and a quad across them is non-planar (a confirmed mesh-destroyer).
  const polys = [];
  const n = rings[0].length;
  for (let i = 0; i < rings.length - 1; i++)
    for (let j = 0; j < n; j++) {
      const k = (j + 1) % n;
      const a0 = [rings[i][j][0], rings[i][j][1], zs[i]];
      const b0 = [rings[i][k][0], rings[i][k][1], zs[i]];
      const a1 = [rings[i + 1][j][0], rings[i + 1][j][1], zs[i + 1]];
      const b1 = [rings[i + 1][k][0], rings[i + 1][k][1], zs[i + 1]];
      let p = mk([a0, b0, b1]); if (p) polys.push(p);
      p = mk([a0, b1, a1]); if (p) polys.push(p);
    }
  return polys;
}

function fanCap(mk, ring, z, up, cx, cy) {
  const polys = [];
  const c = [cx, cy, z];
  const n = ring.length;
  for (let j = 0; j < n; j++) {
    const k = (j + 1) % n;
    const a = [ring[j][0], ring[j][1], z], b = [ring[k][0], ring[k][1], z];
    const p = mk(up ? [c, a, b] : [c, b, a]);
    if (p) polys.push(p);
  }
  return polys;
}

// Closed annular wall between two CCW loops, from z0 to z1.
function wallRing(G, outer, inner, z0, z1) {
  const mk = G.makePoly, polys = [];
  const n = outer.length;
  for (let i = 0; i < n; i++) {            // outer skin, normals outward
    const j = (i + 1) % n;
    const p = mk([[outer[i][0], outer[i][1], z0], [outer[j][0], outer[j][1], z0],
                  [outer[j][0], outer[j][1], z1], [outer[i][0], outer[i][1], z1]]);
    if (p) polys.push(p);
  }
  const m = inner.length;
  for (let i = 0; i < m; i++) {            // inner skin, normals into the cavity
    const j = (i + 1) % m;
    const p = mk([[inner[j][0], inner[j][1], z0], [inner[i][0], inner[i][1], z0],
                  [inner[i][0], inner[i][1], z1], [inner[j][0], inner[j][1], z1]]);
    if (p) polys.push(p);
  }
  for (const [z, up] of [[z1, true], [z0, false]]) {
    const { pts, tris } = G.triangulateRing(outer, inner);
    for (const t of tris) {
      const vs = [[pts[t[0]][0], pts[t[0]][1], z],
                  [pts[t[1]][0], pts[t[1]][1], z],
                  [pts[t[2]][0], pts[t[2]][1], z]];
      const p = mk(up ? vs : [vs[2], vs[1], vs[0]]);
      if (p) polys.push(p);
    }
  }
  return polys;
}

/* ---------- the bin ------------------------------------------------------- */

function buildBin(G, cfg) {
  const c = Object.assign({}, BIN_DEFAULTS, cfg || {});
  const n = c.arcSegs;
  const H = c.hUnits * SPEC.unitH;
  if (H <= SPEC.footH + 0.5)
    throw new Error(`hUnits ${c.hUnits} gives ${H} mm, which is not taller than the ${SPEC.footH} mm base`);

  const polys = [];

  /* feet — one closed shell per grid cell, overlapping the body above */
  const zs = SPEC.prof.map((p) => p[0]).concat([SPEC.footH + BLOAT]);
  for (let i = 0; i < c.u; i++)
    for (let j = 0; j < c.v; j++) {
      const cx = (i - (c.u - 1) / 2) * SPEC.pitch;
      const cy = (j - (c.v - 1) / 2) * SPEC.pitch;
      const rings = SPEC.prof.map(([, half]) => {
        const h = half - c.shrink;
        return roundRect(h, h, h - SPEC.centre, n).map((p) => [p[0] + cx, p[1] + cy]);
      });
      rings.push(rings[rings.length - 1]);      // BLOAT extension into the body
      polys.push(...sweep(G.makePoly, rings, zs));
      polys.push(...fanCap(G.makePoly, rings[0], zs[0], false, cx, cy));
      polys.push(...fanCap(G.makePoly, rings[rings.length - 1], SPEC.footH + BLOAT, true, cx, cy));
    }

  /* body */
  const outer = outlineAt(c.u, c.v, SPEC.half, c.shrink, n);
  const floorZ = SPEC.footH + c.floorT;

  if (c.solid || floorZ >= H - 0.2) {
    polys.push(...G.extrudePoly(outer, SPEC.footH, H));
  } else {
    // solid slab from the top of the feet to the cavity floor
    polys.push(...G.extrudePoly(outer, SPEC.footH, floorZ + BLOAT));
    // wall ring above it
    const hw = (c.u - 1) * SPEC.pitch / 2 + SPEC.half - c.shrink;
    const hd = (c.v - 1) * SPEC.pitch / 2 + SPEC.half - c.shrink;
    const inner = roundRect(hw - c.wall, hd - c.wall,
                            Math.max(0.4, SPEC.r - c.wall), n);
    polys.push(...wallRing(G, outer, inner, floorZ, H));

    /* dividers — separate overlapping shells, never unioned */
    const iw = hw - c.wall, id = hd - c.wall;
    const t = c.wall / 2;
    for (let k = 1; k <= c.divX; k++) {
      const x = -iw + (2 * iw) * k / (c.divX + 1);
      polys.push(...G.extrudePoly(
        [[x - t, -id - BLOAT], [x + t, -id - BLOAT], [x + t, id + BLOAT], [x - t, id + BLOAT]],
        floorZ - BLOAT, H));
    }
    for (let k = 1; k <= c.divY; k++) {
      const y = -id + (2 * id) * k / (c.divY + 1);
      polys.push(...G.extrudePoly(
        [[-iw - BLOAT, y - t], [iw + BLOAT, y - t], [iw + BLOAT, y + t], [-iw - BLOAT, y + t]],
        floorZ - BLOAT, H));
    }
  }

  const meta = {
    u: c.u, v: c.v, hUnits: c.hUnits, H,
    W: (c.u - 1) * SPEC.pitch + 2 * (SPEC.half - c.shrink),
    D: (c.v - 1) * SPEC.pitch + 2 * (SPEC.half - c.shrink),
    footH: SPEC.footH, floorZ, cells: c.u * c.v,
  };
  return { polys: G.clampZ(polys, 0), meta };
}

if (typeof module !== 'undefined') {
  module.exports = { buildBin, roundRect, outlineAt, SPEC, BIN_DEFAULTS };
}
