/* Drawerforge — Gridfinity bin geometry.
 *
 * Built entirely by direct mesh construction and overlapping closed shells.
 * There is NO CSG in this file: see docs/ENGINE.md — the hand-rolled BSP is
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

// Everything buildBin reaches for through G. The bins UI checks itself against this
// at load; keep it in step when a new primitive is used.
const REQUIRED_CORE = ['makePoly', 'triangulateRing', 'extrudePoly', 'clampZ', 'profilePrism'];

const BIN_DEFAULTS = {
  u: 1, v: 1,           // footprint in grid cells
  hUnits: 3,            // height in 7 mm units (total, base included)
  wall: 1.2,            // side wall thickness
  floorT: 1.2,          // floor thickness above the top of the base
  divX: 0, divY: 0,     // interior dividers (cuts, not compartments)
  solid: false,         // no cavity at all
  arcSegs: 12,          // corner-arc segments; only affects the bin's own smoothness
  shrink: 0,            // extra clearance per side, on top of the spec's 0.25
  lip: true,            // stacking lip on top (only when every edge is full height)
  edges: null,          // {f,b,l,r} wall heights as a fraction; 0 = open, 1 = full
  base: 'standard',     // 'standard' | 'lowlip' | 'low' — see BASE_STYLES
  lipMin: 0.55,         // flat width of the lip's top rim
  scoop: 0,             // radius of the front scoop fillet, 0 = none
  label: 0,             // depth of the label shelf at the back, 0 = none
  labelT: 1.2,          // thickness of the label shelf
};

/* Scoop and label shelf.
 *
 * Both are ADDED prisms, never cutters. ENGINE.md's rule is that anything which
 * looks like a subtraction here can be built additively instead, which keeps the
 * bins engine free of CSG entirely.
 *
 * The scoop fills the internal corner between the cavity floor and the front wall
 * with a quarter-round, so contents can be swept up and out.
 *
 * The label shelf projects inward from the top of the back wall. Its underside runs
 * at 45 degrees back to the wall so every layer overhangs the one below it by its
 * own height — printable without support.
 */
function scoopPrism(G, hwI, hdI, floorZ, r, segs) {
  const y0 = -hdI, prof = [[y0, floorZ], [y0 + r, floorZ]];
  for (let k = 1; k <= segs; k++) {                 // arc from floor up to the wall
    const a = (k / segs) * Math.PI / 2;
    prof.push([y0 + r - r * Math.sin(a), floorZ + r - r * Math.cos(a)]);
  }
  prof.push([y0 - BLOAT, floorZ + r], [y0 - BLOAT, floorZ - BLOAT], [y0, floorZ - BLOAT]);
  return G.profilePrism(prof, -hwI - BLOAT, hwI + BLOAT, (u, v) => [v, u]);
}
function labelPrism(G, hwI, hdI, H, depth, t) {
  const yb = hdI;
  const prof = [
    [yb + BLOAT, H - t - depth], [yb + BLOAT, H], [yb - depth, H],
    [yb - depth, H - t],
  ];
  return G.profilePrism(prof, -hwI - BLOAT, hwI + BLOAT, (u, v) => [v, u]);
}

/* Stacking lip.
 *
 * The lip's inner surface is a baseplate socket: a bin stacks on a bin exactly as
 * a bin sits on a baseplate, which is what makes it interoperable. Insets from the
 * bin's outer outline, at the same corner-arc centre so clearance stays uniform:
 *   floor  2.70  (= 20.75 - 18.05, i.e. the spec foot's 17.80 plus 0.25 clearance)
 *   +0.8   1.90  after the foot's bottom chamfer
 *   +2.6   1.90  after the foot's vertical section
 *   top    lipMin
 *
 * Spec says the lip adds 4.4 mm. A true 4.4 mm lip tapers to a ~0.1 mm knife edge,
 * so like every other generator we stop it early to leave a printable rim; that
 * costs (lipMin - 0.1) mm of height and sits inside the spec's 0.5 mm tolerance.
 * It does not affect stacking, which is governed by the inner transition only.
 */
const LIP = [[0, 2.70], [0.8, 1.90], [2.6, 1.90]];
const lipHeight = (lipMin) => 2.6 + (1.90 - lipMin);   // 3.95 at the default

/* Base styles.
 *
 * A spec foot is 4.75 mm, which eats the interior: a 1-unit bin is left with
 * 1.05 mm of cavity. Truncating the foot at 2.0 mm keeps its bottom chamfer plus
 * 1.2 mm of vertical — enough taper to self-centre — and hands back 2.75 mm.
 *
 * A short foot cannot enter a full lip: 2 mm up, the lip's opening is 18.85 while
 * the body above the foot is 20.75, so it would perch on top. The two must be a
 * matched pair, hence the low lip, which stops at 2.0 with a 1.90 mm flat rim that
 * the upper bin's shoulder rests on.
 *
 * A low lip also accepts a *spec* foot — the foot simply drops to the lip floor —
 * so the three styles below are the only combinations worth having, and each is
 * valid by construction:
 *   standard  spec foot + spec lip     interoperable, stacks with anyone's bins
 *   lowlip    spec foot + low lip      seats in a baseplate, takes low bins above
 *   low       short foot + low lip     more depth; only onto another low lip
 */
const STUB_H = 2.0;
const LIP_LOW = [[0, 2.70], [0.8, 1.90]];
const BASE_STYLES = {
  standard: { footH: SPEC.footH, lip: LIP,     lipH: null, rim: null },
  lowlip:   { footH: SPEC.footH, lip: LIP_LOW, lipH: STUB_H, rim: 1.90 },
  low:      { footH: STUB_H,     lip: LIP_LOW, lipH: STUB_H, rim: 1.90 },
};
const baseStyle = (c) => BASE_STYLES[c && c.base] || BASE_STYLES.standard;

// foot profile truncated to a given height, keeping the spec shape
function footProfile(footH) {
  const out = [];
  for (const [z, h] of SPEC.prof) {
    if (z < footH - 1e-9) out.push([z, h]);
    else break;
  }
  const last = out[out.length - 1];
  let h = SPEC.prof[SPEC.prof.length - 1][1];
  for (let i = 0; i < SPEC.prof.length - 1; i++) {
    const [z0, h0] = SPEC.prof[i], [z1, h1] = SPEC.prof[i + 1];
    if (footH >= z0 && footH <= z1) { h = h0 + (h1 - h0) * (z1 > z0 ? (footH - z0) / (z1 - z0) : 0); break; }
  }
  if (!last || Math.abs(last[0] - footH) > 1e-9) out.push([footH, h]);
  return out;
}

/* ---------- 2D outlines --------------------------------------------------- */

// Straight-run subdivisions. The straights need their own vertices so a wall can
// change height along a side; without them an edge's height would be dictated by
// the corner arcs. Fixed, not a parameter: every ring in a bin must share a vertex
// count so the skins stitch, and one constant is harder to get wrong than a
// threaded argument.
const SSEG = 4;

// Rounded rectangle centred on origin, CCW, sharing SPEC.centre where possible.
function roundRect(hw, hd, r, n) {
  r = Math.max(0.2, Math.min(r, Math.min(hw, hd) - 0.01));
  const cs = [[hw - r, hd - r, 0], [-hw + r, hd - r, 90],
              [-hw + r, -hd + r, 180], [hw - r, -hd + r, 270]];
  const arcs = cs.map(([ox, oy, a0]) => {
    const out = [];
    for (let k = 0; k <= n; k++) {
      const a = (a0 + 90 * k / n) * Math.PI / 180;
      out.push([ox + r * Math.cos(a), oy + r * Math.sin(a)]);
    }
    return out;
  });
  const pts = [];
  for (let c = 0; c < 4; c++) {
    pts.push(...arcs[c]);
    // arc ends are tangent, so the gap to the next arc is exactly the straight edge
    const a = arcs[c][arcs[c].length - 1], b = arcs[(c + 1) % 4][0];
    for (let k = 1; k < SSEG; k++)
      pts.push([a[0] + (b[0] - a[0]) * k / SSEG, a[1] + (b[1] - a[1]) * k / SSEG]);
  }
  return pts;
}

/* Which edge each outline vertex belongs to. Straights are classified by position;
   corner-arc vertices take the taller of their two neighbours, so an open front
   still leaves the side walls running the full length with a corner post. */
function edgeHeights(outline, hw, hd, r, edges, zLow, zHigh) {
  const E = 1e-6;
  const frac = (k) => Math.max(0, Math.min(1, edges && edges[k] !== undefined ? edges[k] : 1));
  return outline.map(([x, y]) => {
    let f;
    if (Math.abs(y) <= hd - r + E) f = x > 0 ? frac('r') : frac('l');
    else if (Math.abs(x) <= hw - r + E) f = y > 0 ? frac('b') : frac('f');
    else f = Math.max(x > 0 ? frac('r') : frac('l'), y > 0 ? frac('b') : frac('f'));
    return zLow + f * (zHigh - zLow);
  });
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

/* Band between two CCW loops that correspond index-for-index.
 *
 * Every loop in a bin comes from roundRect with the same segment count, so the two
 * rims pair up vertex for vertex and a direct strip is exact. This deliberately
 * avoids triangulateRing's keyhole + ear-clipping path, which bails out SILENTLY on
 * a thin ring: on a 1.2 mm wall it returned 57 of the 128 triangles needed, covering
 * 119.5 of 187.0 mm2 and leaving the rest as holes. That is where the slicer's
 * non-manifold edges were coming from.
 */
function ringStrip(mk, outer, inner, z, up) {
  const polys = [], n = outer.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const o0 = [outer[i][0], outer[i][1], z], o1 = [outer[j][0], outer[j][1], z];
    const i0 = [inner[i][0], inner[i][1], z], i1 = [inner[j][0], inner[j][1], z];
    let p = mk(up ? [o0, o1, i1] : [i1, o1, o0]); if (p) polys.push(p);
    p = mk(up ? [o0, i1, i0] : [i0, i1, o0]); if (p) polys.push(p);
  }
  return polys;
}

// Closed annular wall between two CCW loops, from z0 up to a per-vertex top.
// zTop may be a number or an array — an array lets one side stand full height
// while another drops to the floor, which is how an open-fronted bin is made.
function wallRing(G, outer, inner, z0, zTop) {
  const mk = G.makePoly, polys = [];
  const n = outer.length;
  const zt = (i) => (Array.isArray(zTop) ? zTop[i] : zTop);
  for (let i = 0; i < n; i++) {            // outer skin, normals outward
    const j = (i + 1) % n;
    const p = mk([[outer[i][0], outer[i][1], z0], [outer[j][0], outer[j][1], z0],
                  [outer[j][0], outer[j][1], zt(j)], [outer[i][0], outer[i][1], zt(i)]]);
    if (p) polys.push(p);                  // planar: all four lie in one vertical plane
  }
  for (let i = 0; i < n; i++) {            // inner skin, normals into the cavity
    const j = (i + 1) % n;
    const p = mk([[inner[j][0], inner[j][1], z0], [inner[i][0], inner[i][1], z0],
                  [inner[i][0], inner[i][1], zt(i)], [inner[j][0], inner[j][1], zt(j)]]);
    if (p) polys.push(p);
  }
  for (let i = 0; i < n; i++) {            // top ribbon — TRIANGLES: a varying top
    const j = (i + 1) % n;                 // makes the quad non-planar
    const oi = [outer[i][0], outer[i][1], zt(i)], oj = [outer[j][0], outer[j][1], zt(j)];
    const ii = [inner[i][0], inner[i][1], zt(i)], ij = [inner[j][0], inner[j][1], zt(j)];
    let p = mk([oi, oj, ij]); if (p) polys.push(p);
    p = mk([oi, ij, ii]); if (p) polys.push(p);
  }
  polys.push(...ringStrip(mk, outer, inner, z0, false));   // bottom annulus
  return polys;
}

// Closed lip ring: a socket-profiled rim standing on top of the bin walls.
// A separate overlapping shell, so it works whether the wall is thinner or
// thicker than the lip's inward reach — no special-casing either way.
function lipRing(G, c, hwO, hdO, H, n) {
  const st = baseStyle(c);
  const lipH = st.lipH !== null ? st.lipH : lipHeight(c.lipMin);
  const rim = st.rim !== null ? st.rim : c.lipMin;
  const ring = (t) => roundRect(hwO - t, hdO - t, SPEC.r - t, n);
  const steps = st.lip.concat([[lipH, rim]]);
  const inner = steps.map(([, t]) => ring(t));
  const zsI = steps.map(([z]) => H + z);
  // extend the inner surface down past the floor so the shell closes below the bin top
  inner.unshift(inner[0]); zsI.unshift(H - BLOAT);

  const outer = ring(0);
  const polys = [];
  // inner skin (socket), normals pointing into the recess
  for (let i = 0; i < inner.length - 1; i++)
    for (let j = 0; j < outer.length; j++) {
      const k = (j + 1) % outer.length;
      const a0 = [inner[i][j][0], inner[i][j][1], zsI[i]];
      const b0 = [inner[i][k][0], inner[i][k][1], zsI[i]];
      const a1 = [inner[i + 1][j][0], inner[i + 1][j][1], zsI[i + 1]];
      const b1 = [inner[i + 1][k][0], inner[i + 1][k][1], zsI[i + 1]];
      let p = G.makePoly([a0, b1, b0]); if (p) polys.push(p);
      p = G.makePoly([a0, a1, b1]); if (p) polys.push(p);
    }
  // outer skin, normals outward
  for (let j = 0; j < outer.length; j++) {
    const k = (j + 1) % outer.length;
    const p = G.makePoly([[outer[j][0], outer[j][1], H - BLOAT], [outer[k][0], outer[k][1], H - BLOAT],
                          [outer[k][0], outer[k][1], H + lipH], [outer[j][0], outer[j][1], H + lipH]]);
    if (p) polys.push(p);
  }
  // caps: bottom (down) and the flat top rim (up) — index-paired strips, not the
  // keyhole triangulator, which silently leaves a thin ring half covered
  polys.push(...ringStrip(G.makePoly, outer, inner[0], H - BLOAT, false));
  polys.push(...ringStrip(G.makePoly, outer, inner[inner.length - 1], H + lipH, true));
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
  const st = baseStyle(c);
  const prof = footProfile(st.footH);
  const zs = prof.map((p) => p[0]).concat([st.footH + BLOAT]);
  for (let i = 0; i < c.u; i++)
    for (let j = 0; j < c.v; j++) {
      const cx = (i - (c.u - 1) / 2) * SPEC.pitch;
      const cy = (j - (c.v - 1) / 2) * SPEC.pitch;
      const rings = prof.map(([, half]) => {
        const h = half - c.shrink;
        return roundRect(h, h, h - SPEC.centre, n).map((p) => [p[0] + cx, p[1] + cy]);
      });
      rings.push(rings[rings.length - 1]);      // BLOAT extension into the body
      polys.push(...sweep(G.makePoly, rings, zs));
      polys.push(...fanCap(G.makePoly, rings[0], zs[0], false, cx, cy));
      polys.push(...fanCap(G.makePoly, rings[rings.length - 1], st.footH + BLOAT, true, cx, cy));
    }

  /* body */
  const outer = outlineAt(c.u, c.v, SPEC.half, c.shrink, n);
  const floorZ = st.footH + c.floorT;

  if (c.solid || floorZ >= H - 0.2) {
    polys.push(...G.extrudePoly(outer, st.footH - BLOAT, H));
  } else {
    // solid slab from the top of the feet to the cavity floor
    polys.push(...G.extrudePoly(outer, st.footH - BLOAT, floorZ + BLOAT));
    // wall ring above it
    const hw = (c.u - 1) * SPEC.pitch / 2 + SPEC.half - c.shrink;
    const hd = (c.v - 1) * SPEC.pitch / 2 + SPEC.half - c.shrink;
    const inner = roundRect(hw - c.wall, hd - c.wall,
                            Math.max(0.4, SPEC.r - c.wall), n);
    // Start the ring below the cavity floor, buried in the slab. An "open" edge
    // then has its top at floorZ and the ring is still a real volume there rather
    // than a zero-height sliver — the degenerate case simply hides inside the slab.
    const zBase = floorZ - Math.min(1.0, Math.max(0.2, c.floorT));
    const zTop = edgeHeights(outer, hw, hd, SPEC.r, c.edges, floorZ, H);
    polys.push(...wallRing(G, outer, inner, zBase, zTop));

    /* scoop and label shelf — added shells, and only where there is a wall to
       attach them to (an open front has no corner to fill). */
    const eF = c.edges && c.edges.f !== undefined ? c.edges.f : 1;
    const eB = c.edges && c.edges.b !== undefined ? c.edges.b : 1;
    const iw = hw - c.wall, id = hd - c.wall;
    if (c.scoop > 0.05 && eF > 0) {
      const r = Math.min(c.scoop, id * 0.9, (H - floorZ) * 0.9);
      if (r > 0.05) polys.push(...scoopPrism(G, iw, id, floorZ, r, Math.max(4, n)));
    }
    if (c.label > 0.05 && eB > 0.99) {
      const d = Math.min(c.label, id * 0.8);
      if (d > 0.05) polys.push(...labelPrism(G, iw, id, H, d, c.labelT));
    }

    /* dividers — separate overlapping shells, never unioned */
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

  /* stacking lip — only on a bin whose walls all reach full height. A lip over a
     lowered edge would have nothing under it, and nothing could seat on it anyway. */
  const hwO = (c.u - 1) * SPEC.pitch / 2 + SPEC.half - c.shrink;
  const hdO = (c.v - 1) * SPEC.pitch / 2 + SPEC.half - c.shrink;
  const allFull = !c.edges || ['f', 'b', 'l', 'r'].every((k) =>
    c.edges[k] === undefined || c.edges[k] >= 1);
  const hasLip = c.lip && allFull && !c.solid;
  const lipH = hasLip ? (st.lipH !== null ? st.lipH : lipHeight(c.lipMin)) : 0;
  if (hasLip) polys.push(...lipRing(G, c, hwO, hdO, H, n));

  // H stays the stacking pitch whatever the walls do; topZ is how tall it really is,
  // which for an all-open tray is just the floor.
  const maxFrac = c.solid ? 1 : Math.max(...['f', 'b', 'l', 'r'].map((k) =>
    (!c.edges || c.edges[k] === undefined) ? 1 : Math.max(0, Math.min(1, c.edges[k]))));
  const topZ = (c.solid || floorZ >= H - 0.2) ? H
    : floorZ + BLOAT + maxFrac * (H - floorZ - BLOAT);

  const meta = {
    u: c.u, v: c.v, hUnits: c.hUnits, H, hasLip, openEdges: !allFull,
    lipH, totalH: topZ + lipH,       // H is the stacking pitch; totalH is what it occupies
    W: (c.u - 1) * SPEC.pitch + 2 * (SPEC.half - c.shrink),
    D: (c.v - 1) * SPEC.pitch + 2 * (SPEC.half - c.shrink),
    footH: st.footH, base: c.base || 'standard', floorZ, cells: c.u * c.v,
    cavity: Math.max(0, H - floorZ),
  };
  return { polys: G.clampZ(polys, 0), meta };
}

/* ---------- layout packing -------------------------------------------------
 * Bins travel in the URL hash, so the encoding has to be compact. It also has to
 * survive the values it carries: the original separator was '.', and wall
 * thickness 1.2 split into "1" and "2", shifting every later field so a bin came
 * back with dividers it never had. Separators are now characters that cannot
 * occur in a non-negative number, and packBin refuses to emit one that could.
 *
 * Pure functions living here rather than in the UI so they can be tested headlessly.
 */
const SEP = { field: '-', bin: '_', layer: '~' };
const BASES = ['standard', 'lowlip', 'low'];
const PACK_EDGES = ['f', 'b', 'l', 'r'];

function packBin(b) {
  const f = [b.x, b.y, b.u, b.v, b.hUnits, b.wall, b.floorT, b.divX, b.divY,
             b.solid ? 1 : 0]
    .concat(PACK_EDGES.map((k) => (b.edges && b.edges[k] !== undefined ? b.edges[k] : 1)))
    .concat([Math.max(0, BASES.indexOf(b.base || 'standard')), b.scoop || 0, b.label || 0]);
  for (const v of f)
    if (String(v).includes(SEP.field) || String(v).includes(SEP.bin) || String(v).includes(SEP.layer))
      throw new Error(`bin field ${v} contains a separator — packing would corrupt it`);
  return f.join(SEP.field);
}
function unpackBin(t) {
  const p = t.split(SEP.field).map(Number);
  const edges = {};
  PACK_EDGES.forEach((k, i) => { edges[k] = isFinite(p[10 + i]) ? p[10 + i] : 1; });
  return { x: p[0], y: p[1], u: p[2], v: p[3], hUnits: p[4],
           wall: p[5], floorT: p[6], divX: p[7], divY: p[8], solid: !!p[9],
           edges, base: BASES[p[14]] || 'standard',
           scoop: isFinite(p[15]) ? p[15] : 0, label: isFinite(p[16]) ? p[16] : 0 };
}
const packLayers = (layers) =>
  layers.map((L) => L.bins.map(packBin).join(SEP.bin)).join(SEP.layer);
const unpackLayers = (s) => (s || '').split(SEP.layer)
  .map((ls) => ({ bins: ls.split(SEP.bin).filter(Boolean).map(unpackBin) }));

if (typeof module !== 'undefined') {
  module.exports = { buildBin, roundRect, outlineAt, SPEC, BIN_DEFAULTS, LIP_TABLE: LIP,
    lipHeight, BASE_STYLES, footProfile, STUB_H, REQUIRED_CORE,
    packBin, unpackBin, packLayers, unpackLayers };
}
