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
const REQUIRED_CORE = ['makePoly', 'triangulateRing', 'extrudePoly', 'clampZ', 'profilePrism',
                       'polyArea2D'];

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
  cells: null,          // occupied [x,y] offsets; null means the whole u x v rectangle
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
  /* A truncated foot must still reach full width at 45 degrees. Cutting the spec
     profile at 2.0 mm removes its 2.60 -> 4.75 taper entirely, so the body jumped
     from 18.60 to 20.75 with nothing under it: a 2.15 mm flat overhang all the way
     round, which is exactly where the low-profile test print failed. The taper is
     above the part that mates with a lip, so seating is unchanged -- contact is on
     the chamfer below 0.80, not on this ledge. */
  const top = out[out.length - 1];
  if (SPEC.half - top[1] > 1e-9)
    out.push([top[0] + (SPEC.half - top[1]), SPEC.half]);
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
  /* Chamfer the underside of the lip instead of dropping it straight down.
     The wall is 1.2 mm and the lip base is 2.70, so the lip used to begin with
     1.50 mm of material starting in mid-air over the cavity. Every printed bin
     failed in the same place just below the internal lip, whatever its base style,
     because the ledge is identical on all of them. Running the inner surface down
     to the wall thickness at 45 degrees makes it self-supporting.

     Clamped to the wall height available: a 1-unit bin has only 1.05 mm of wall
     below the lip, so it gets a steeper chamfer rather than one that starts below
     the floor. Steeper still beats a flat overhang. */
  const drop = Math.min(Math.max(0, steps[0][1] - c.wall),
                        Math.max(BLOAT, H - (SPEC.footH + c.floorT) - 0.3));
  inner.unshift(ring(c.wall)); zsI.unshift(H - drop);

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
    const p = G.makePoly([[outer[j][0], outer[j][1], H - drop], [outer[k][0], outer[k][1], H - drop],
                          [outer[k][0], outer[k][1], H + lipH], [outer[j][0], outer[j][1], H + lipH]]);
    if (p) polys.push(p);
  }
  // caps: bottom (down) and the flat top rim (up) — index-paired strips, not the
  // keyhole triangulator, which silently leaves a thin ring half covered
  /* The bottom cap sits where the chamfer starts, not at H - BLOAT: the inner
     surface now runs down to meet the wall thickness, and a cap at the old height
     would leave the two skins ending at different z with nothing joining them. */
  polys.push(...ringStrip(G.makePoly, outer, inner[0], H - drop, false));
  polys.push(...ringStrip(G.makePoly, outer, inner[inner.length - 1], H + lipH, true));
  return polys;
}

/* ---------- carved footprints ----------------------------------------------
 * A bin may occupy any subset of its u x v bounding box, so L, U, T and notched
 * shapes are possible. The mask is a Set of "x,y" keys.
 *
 * These shapes are built cell by cell rather than by extruding their outline.
 * Extruding a concave outline is what docs/ENGINE.md names as the confirmed
 * mesh-destroyer, and the inset an outline would need for the walls does not
 * correspond to it vertex for vertex — which is precisely the condition ringStrip
 * relies on, and precisely how the non-manifold bins happened. Per-cell boxes that
 * overlap and fuse sidestep both.
 */
const cellKey = (x, y) => x + ',' + y;
const maskOf = (c) => {
  if (!c.cells || !c.cells.length) {
    const all = new Set();
    for (let x = 0; x < c.u; x++) for (let y = 0; y < c.v; y++) all.add(cellKey(x, y));
    return all;
  }
  return new Set(c.cells.map(([x, y]) => cellKey(x, y)));
};
const isFullRect = (c) => maskOf(c).size === c.u * c.v;

/* Advisory, not a gate. Both odd carves turn out to build watertight — the per-cell
   builder walls a hole just as readily as an outer edge — so they are reported and
   still made. A severed shape is simply two objects in one file; a hole is a frame,
   which is a legitimate thing to want. */
function maskCheck(mask, u, v) {
  if (!mask.size) return { ok: false, why: 'no cells left' };
  const start = [...mask][0].split(',').map(Number);
  const seen = new Set([cellKey(start[0], start[1])]), queue = [start];
  while (queue.length) {
    const [x, y] = queue.pop();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const k = cellKey(x + dx, y + dy);
      if (mask.has(k) && !seen.has(k)) { seen.add(k); queue.push([x + dx, y + dy]); }
    }
  }
  if (seen.size !== mask.size) return { ok: false, why: 'the shape is in separate pieces' };
  // flood the empty cells from outside the bounding box; anything unreached is a hole
  const out = new Set(), q2 = [];
  for (let x = -1; x <= u; x++) for (const y of [-1, v]) q2.push([x, y]);
  for (let y = -1; y <= v; y++) for (const x of [-1, u]) q2.push([x, y]);
  for (const [x, y] of q2) out.add(cellKey(x, y));
  while (q2.length) {
    const [x, y] = q2.pop();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy, k = cellKey(nx, ny);
      if (nx < -1 || ny < -1 || nx > u || ny > v) continue;
      if (mask.has(k) || out.has(k)) continue;
      out.add(k); q2.push([nx, ny]);
    }
  }
  let holes = 0;
  for (let x = 0; x < u; x++) for (let y = 0; y < v; y++)
    if (!mask.has(cellKey(x, y)) && !out.has(cellKey(x, y))) holes++;
  if (holes) return { ok: false, why: 'the shape encloses a hole' };
  return { ok: true };
}

/* Carved body: a slab per cell and a wall panel per exposed edge, all overlapping.
   A cell's slab reaches the bin's outer face where an edge is exposed and past the
   cell boundary where it is not, so neighbours fuse. */
function carvedBody(G, c, mask, H, floorZ, zTop, lipSteps) {
  const polys = [], P = SPEC.pitch, half = SPEC.half;
  const ox = (c.u - 1) * P / 2, oy = (c.v - 1) * P / 2;   // mask cell -> bin coords
  const has = (x, y) => mask.has(cellKey(x, y));
  const wall = c.wall;

  /* An exposed edge is one shell from the floor to the top of its stacking lip.
     The lip was tried as its own shell first and it cost 12 bad edges a shape: its
     base ring landed on the wall's top cap with the same corner coordinates, so
     four faces met on one edge. Carrying the profile up through the same sweep
     removes the interface rather than papering over it — there is nothing left to
     coincide. Widths are insets from the outer face, so the ledge where the 1.2 mm
     wall becomes the 2.70 mm lip base falls out of the profile for free. */
  const wallProfile = (top) => {
    /* The step from wall thickness to lip base gets BLOAT of height rather than
       being exactly horizontal. Both rings share the outer-face vertices, so at
       equal z that quad has zero area, makePoly drops it, and each panel loses two
       triangles — 72 boundary edges across an L. A 0.05 mm rise costs nothing and
       keeps every face real. */
    /* Same 45 degree chamfer under the lip that lipRing gets, for the same reason:
       the lip base is 2.70 against a 1.20 wall, and that 1.50 mm used to start in
       mid-air over the cavity. Clamped to the wall height available. */
    const drop = lipSteps
      ? Math.min(Math.max(BLOAT, lipSteps[0][1] - wall), Math.max(BLOAT, top - floorZ - 0.3))
      : 0;
    const st = [[floorZ - BLOAT, wall], [top - drop, wall]];
    if (lipSteps) for (const [dz, t] of lipSteps) st.push([H + dz, t]);
    return st;
  };
  const sweptPanel = (steps, rect) => {
    const rings = steps.map(([, t]) => rect(t));
    const zs = steps.map(([z]) => z);
    polys.push(...sweep(G.makePoly, rings, zs));
    /* Centroid, not the midpoint of two opposite corners. fanCap radiates from this
       point, so it only closes the ring if the ring is star-shaped about it — true of
       a rectangle either way, but the corner pieces are sectors, and the two-corner
       midpoint fell outside them and produced inverted triangles. */
    const mid = (r) => [r.reduce((t, p) => t + p[0], 0) / r.length,
                        r.reduce((t, p) => t + p[1], 0) / r.length];
    const a = mid(rings[0]), b = mid(rings[rings.length - 1]);
    polys.push(...fanCap(G.makePoly, rings[0], zs[0], false, a[0], a[1]));
    polys.push(...fanCap(G.makePoly, rings[rings.length - 1], zs[zs.length - 1], true, b[0], b[1]));
  };

  /* Convex corners follow the spec arc, exactly like a rectangular bin's.
     A carved bin was built from plain rectangles, so every convex corner came out
     square and reached 1.55 mm further than the Gridfinity profile allows — visibly
     sharp beside an uncarved bin, and outside the standard.

     The corner is an annular sector: outer radius CR about the spec arc centre, inner
     radius CR - t so the wall keeps its thickness and the lip keeps its step. It gets
     its own sweep because an annular sector is star-shaped about no point at all, so
     fanCap cannot close it — the outer and inner arcs are index-paired instead, which
     is the same reasoning that made ringStrip necessary for the bins in the first
     place. */
  const NARC = 8;                       // arc segments per 90 degrees of corner
  /* Shells must interpenetrate, never meet on a plane: two faces that touch share
     their edges, and a shared edge is used four times instead of twice. Cutting the
     panels off exactly at the arc's tangent point did precisely that and cost 160
     bad edges. Running them OVER past it costs 5 microns of bulge where the flat
     face crosses the arc, which is four orders of magnitude below a nozzle. */
  const OVER = 4 * BLOAT;
  const CC = SPEC.centre, CR = half - SPEC.centre;
  const arcPts = (ccx, ccy, rad, a0) => {
    const out = [];
    for (let k = 0; k <= NARC; k++) {
      const a = (a0 + 90 * k / NARC) * Math.PI / 180;
      out.push([ccx + rad * Math.cos(a), ccy + rad * Math.sin(a)]);
    }
    return out;
  };
  /* radii(t) -> [rOuter, rInner]. A convex corner puts the material INSIDE the arc,
     so its inner radius shrinks with wall thickness; a concave one puts the material
     outside, so its inner radius grows. Same band, opposite sense. */
  const sweptSector = (steps, ccx, ccy, a0, radii) => {
    const zs = steps.map(([z]) => z);
    const rings = steps.map(([, t]) => {
      const [ro, ri] = radii(t);
      return { outer: arcPts(ccx, ccy, ro, a0), inner: arcPts(ccx, ccy, ri, a0) };
    });
    const loop = (r) => r.outer.concat(r.inner.slice().reverse());
    polys.push(...sweep(G.makePoly, rings.map(loop), zs));
    // caps: index-paired band between the two arcs, never a fan
    const cap = (r, z, up) => {
      for (let i = 0; i < r.outer.length - 1; i++) {
        const a = [r.outer[i][0], r.outer[i][1], z], b = [r.outer[i + 1][0], r.outer[i + 1][1], z];
        const c2 = [r.inner[i + 1][0], r.inner[i + 1][1], z], d = [r.inner[i][0], r.inner[i][1], z];
        for (const tri of up ? [[a, b, c2], [a, c2, d]] : [[c2, b, a], [d, c2, a]]) {
          const pp = G.makePoly(tri); if (pp) polys.push(pp);
        }
      }
    };
    cap(rings[0], zs[0], false);
    cap(rings[rings.length - 1], zs[zs.length - 1], true);
  };

  for (const key of mask) {
    const [x, y] = key.split(',').map(Number);
    const cx = x * P - ox, cy = y * P - oy;
    const e = { l: !has(x - 1, y), r: !has(x + 1, y), f: !has(x, y - 1), b: !has(x, y + 1) };
    // slab: outer face on exposed sides, over the boundary on shared ones
    const x0 = cx - (e.l ? half : P / 2 + BLOAT), x1 = cx + (e.r ? half : P / 2 + BLOAT);
    const y0 = cy - (e.f ? half : P / 2 + BLOAT), y1 = cy + (e.b ? half : P / 2 + BLOAT);
    // a corner is convex only where two adjacent edges of this cell are both exposed
    const cvx = { fl: e.f && e.l, fr: e.f && e.r, bl: e.b && e.l, br: e.b && e.r };
    const outline = [];
    const push = (pts) => outline.push(...pts);
    if (cvx.fl) push(arcPts(cx - CC, cy - CC, CR, 180)); else outline.push([x0, y0]);
    if (cvx.fr) push(arcPts(cx + CC, cy - CC, CR, 270)); else outline.push([x1, y0]);
    if (cvx.br) push(arcPts(cx + CC, cy + CC, CR, 0));   else outline.push([x1, y1]);
    if (cvx.bl) push(arcPts(cx - CC, cy + CC, CR, 90));  else outline.push([x0, y1]);
    polys.push(...G.extrudePoly(outline, SPEC.footH - BLOAT, floorZ + BLOAT));
    if (zTop <= floorZ + 0.01) continue;
    /* Panels stop at the arc's tangent point where a convex corner takes over, and
       otherwise run long so they meet at the boundary. Running them full length past
       a rounded corner is what left the square corner sticking out. */
    const L = x0 - BLOAT, R = x1 + BLOAT, F = y0 - BLOAT, Bk = y1 + BLOAT;
    const yF = cvx.fl || cvx.fr ? cy - CC : null, yB = cvx.bl || cvx.br ? cy + CC : null;
    const steps = wallProfile(zTop);
    if (e.l) sweptPanel(steps, (t) => {
      const a = cvx.fl ? cy - CC - OVER : F, b = cvx.bl ? cy + CC + OVER : Bk;
      return [[x0, a], [x0 + t, a], [x0 + t, b], [x0, b]];
    });
    if (e.r) sweptPanel(steps, (t) => {
      const a = cvx.fr ? cy - CC - OVER : F, b = cvx.br ? cy + CC + OVER : Bk;
      return [[x1 - t, a], [x1, a], [x1, b], [x1 - t, b]];
    });
    if (e.f) sweptPanel(steps, (t) => {
      const a = cvx.fl ? cx - CC - OVER : L, b = cvx.fr ? cx + CC + OVER : R;
      return [[a, y0], [b, y0], [b, y0 + t], [a, y0 + t]];
    });
    if (e.b) sweptPanel(steps, (t) => {
      const a = cvx.bl ? cx - CC - OVER : L, b = cvx.br ? cx + CC + OVER : R;
      return [[a, y1 - t], [b, y1 - t], [b, y1], [a, y1]];
    });
    // clamped, so a wall thicker than the corner radius cannot fold the arc inside out
    const cvxR = (t) => [CR, Math.max(0.2, CR - t)];
    if (cvx.fl) sweptSector(steps, cx - CC, cy - CC, 180, cvxR);
    if (cvx.fr) sweptSector(steps, cx + CC, cy - CC, 270, cvxR);
    if (cvx.br) sweptSector(steps, cx + CC, cy + CC, 0, cvxR);
    if (cvx.bl) sweptSector(steps, cx - CC, cy + CC, 90, cvxR);
  }

  /* Reflex corners.
   *
   * Every exposed face sits at `half` (20.75) from its cell centre while the cell
   * boundary is at pitch/2 (21). That 0.25 mm is the clearance between neighbouring
   * bins and is right on an outside edge. At a reflex corner, though, the two faces
   * meeting there are perpendicular and belong to DIFFERENT cells, so both are inset
   * and each panel runs only BLOAT past its own cell. The walls never touched: an L
   * had a 0.25 mm slot at the inside corner and both walls simply stopped, with no
   * corner geometry between them at all.
   *
   * One quarter disc closes it. Centred on the notch corner with a radius equal to
   * the inset, it is tangent to both faces by construction, so the inside surface
   * sweeps from one wall to the other at constant thickness — a pipe bend rather
   * than a mitre — and there is no crease to leave a crack. It rides the same
   * profile as the panels, so the stacking lip carries round the corner instead of
   * stopping short of it.
   */
  /* Reflex corners are built from three overlapping convex pieces rather than one
     wrapping band. The band was the right SHAPE — the containment was correct — but
     it has a reflex vertex at the notch corner, and a single fan cap cannot close a
     ring that is not star-shaped about one point. Three convex pieces each cap
     cleanly, and overlapping shells is what the rest of this file already does.

       sector  the quarter between the notch corner and an arc of radius t, which is
               tangent to both wall faces, so the wall keeps constant thickness round
               the turn and the inside reads as one sweep rather than a mitre
       laps    a short rectangle along each wall, running past the corner far enough
               to overlap real panel material

     The laps must reach INTO the sector, not merely touch it: two shells meeting on
     a plane share edges and stop being two shells. They overlap by OVER, which makes
     the wall 0.02 mm proud at the transition — below a nozzle width, and the price of
     never relying on a coincident face. */
  const lap = (P / 2 - half) + 2 * BLOAT;
  const sector = (fx, fy, dx, dy) => (t) => {
    const base = dx > 0 ? (dy > 0 ? 0 : -Math.PI / 2) : (dy > 0 ? Math.PI / 2 : Math.PI);
    const pts = [[fx, fy]];
    for (let k = 0; k <= NARC; k++) {
      const a = base + (Math.PI / 2) * k / NARC;
      pts.push([fx + t * Math.cos(a), fy + t * Math.sin(a)]);
    }
    return G.polyArea2D(pts) < 0 ? pts.reverse() : pts;
  };
  const box = (ax, ay, bx, by) => {
    const pts = [[ax, ay], [bx, ay], [bx, by], [ax, by]];
    return G.polyArea2D(pts) < 0 ? pts.reverse() : pts;
  };

  /* A grid vertex with exactly one empty cell around it is a reflex corner. Three
     empties is a convex corner, which the panels already cover by overlapping; two
     is a straight run or a pinch point, and neither has a corner to fill. */
  for (let vx = 0; vx <= c.u; vx++)
    for (let vy = 0; vy <= c.v; vy++) {
      const around = [[vx - 1, vy - 1], [vx, vy - 1], [vx - 1, vy], [vx, vy]];
      if (around.some(([i, j]) => i < 0 || j < 0 || i >= c.u || j >= c.v)) continue;
      const empty = around.filter(([i, j]) => !has(i, j));
      if (empty.length !== 1) continue;
      const [ex, ey] = empty[0];
      const vX = vx * P - ox - P / 2, vY = vy * P - oy - P / 2;
      // into the material, away from the empty cell, on each axis
      const dx = (ex * P - ox) < vX ? 1 : -1;
      const dy = (ey * P - oy) < vY ? 1 : -1;
      /* The notch corner, where the two exposed faces meet. Each face is inset from
         the grid boundary by (pitch/2 - half) TOWARDS the material, so the corner is
         that much inside the vertex — not outside it. Getting this sign backwards put
         the corner 0.5 mm into the notch, which filled the gap but left the bin proud
         exactly where a neighbouring bin sits. */
      const fx = vX + dx * (P / 2 - half);
      const fy = vY + dy * (P / 2 - half);
      const steps = wallProfile(zTop);
      /* Fill the junction first: the two walls arrive from different cells and do not
         otherwise touch. */
      sweptPanel(steps, sector(fx, fy, dx, dy));
      sweptPanel(steps, (t) => box(fx + dx * t, fy + dy * OVER, fx, fy - dy * lap));
      sweptPanel(steps, (t) => box(fx + dx * OVER, fy + dy * t, fx - dx * lap, fy));

      /* Then round the outside of it to the same radius the convex corners use.
         The arc centre sits in the notch, so the fillet ADDS material there — which
         is exactly right, because the bin that goes in the notch has a convex corner
         of the same radius, and the two are complements. Its corner nests into this
         one with the standard clearance instead of facing a square hole. Leaving it
         sharp, which is what happened first, is the only version that does not match
         a neighbouring bin. */
      const ox2 = fx - dx * CR, oy2 = fy - dy * CR;
      const base = dx > 0 ? (dy > 0 ? 0 : 270) : (dy > 0 ? 90 : 180);
      sweptSector(steps, ox2, oy2, base, (t) => [CR, CR + t + OVER]);
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
  const mask = maskOf(c), full = isFullRect(c);

  /* feet — one closed shell per occupied cell, overlapping the body above */
  const st = baseStyle(c);
  const prof = footProfile(st.footH);
  const zs = prof.map((p) => p[0]).concat([st.footH + BLOAT]);
  for (let i = 0; i < c.u; i++)
    for (let j = 0; j < c.v; j++) {
      if (!mask.has(cellKey(i, j))) continue;
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

  /* Whether there is a lip has to be known before the body: a carved bin's wall
     panels carry their own lip, so the decision cannot wait until after. A lip over
     a lowered edge would have nothing under it and nothing could seat on it. */
  const allFull = !c.edges || ['f', 'b', 'l', 'r'].every((k) =>
    c.edges[k] === undefined || c.edges[k] >= 1);
  const hasLip = c.lip && allFull && !c.solid;
  const lipH = hasLip ? (st.lipH !== null ? st.lipH : lipHeight(c.lipMin)) : 0;
  const lipSteps = hasLip
    ? st.lip.concat([[lipH, st.rim !== null ? st.rim : c.lipMin]]) : null;

  if (!full) {
    /* Carved shapes are built cell by cell. Dividers, scoop and the label shelf still
       assume a rectangle and are left off rather than guessed at. The stacking lip is
       not one of them: it rides on the wall panels, so a carved bin still stacks. */
    const zTop = (c.solid || floorZ >= H - 0.2) ? H : H;
    polys.push(...carvedBody(G, c, mask, H, c.solid ? H - 0.01 : floorZ, zTop,
                             c.solid ? null : lipSteps));
  } else if (c.solid || floorZ >= H - 0.2) {
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

  /* A rectangle's lip is still its own swept ring around the rounded outline. */
  const hwO = (c.u - 1) * SPEC.pitch / 2 + SPEC.half - c.shrink;
  const hdO = (c.v - 1) * SPEC.pitch / 2 + SPEC.half - c.shrink;
  if (hasLip && full) polys.push(...lipRing(G, c, hwO, hdO, H, n));

  // H stays the stacking pitch whatever the walls do; topZ is how tall it really is,
  // which for an all-open tray is just the floor.
  const maxFrac = c.solid ? 1 : Math.max(...['f', 'b', 'l', 'r'].map((k) =>
    (!c.edges || c.edges[k] === undefined) ? 1 : Math.max(0, Math.min(1, c.edges[k]))));
  const topZ = (c.solid || floorZ >= H - 0.2) ? H
    : floorZ + BLOAT + maxFrac * (H - floorZ - BLOAT);

  const meta = {
    u: c.u, v: c.v, hUnits: c.hUnits, H, hasLip, openEdges: !allFull,
    carved: !full,
    lipH, totalH: topZ + lipH,       // H is the stacking pitch; totalH is what it occupies
    W: (c.u - 1) * SPEC.pitch + 2 * (SPEC.half - c.shrink),
    D: (c.v - 1) * SPEC.pitch + 2 * (SPEC.half - c.shrink),
    footH: st.footH, base: c.base || 'standard', floorZ, cells: mask.size,
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

function maskBits(b) {
  if (!b.cells || !b.cells.length) return '';
  const set = new Set(b.cells.map(([x, y]) => cellKey(x, y)));
  if (set.size === b.u * b.v) return '';
  let out = '';
  for (let x = 0; x < b.u; x++) for (let y = 0; y < b.v; y++)
    out += set.has(cellKey(x, y)) ? '1' : '0';
  return out;
}
function bitsToCells(bits, u, v) {
  if (!bits) return null;
  const out = [];
  let i = 0;
  for (let x = 0; x < u; x++) for (let y = 0; y < v; y++, i++)
    if (bits[i] === '1') out.push([x, y]);
  return out.length ? out : null;
}
function packBin(b) {
  const f = [b.x, b.y, b.u, b.v, b.hUnits, b.wall, b.floorT, b.divX, b.divY,
             b.solid ? 1 : 0]
    .concat(PACK_EDGES.map((k) => (b.edges && b.edges[k] !== undefined ? b.edges[k] : 1)))
    .concat([Math.max(0, BASES.indexOf(b.base || 'standard')), b.scoop || 0, b.label || 0,
             maskBits(b) || 0]);
  for (const v of f)
    if (String(v).includes(SEP.field) || String(v).includes(SEP.bin) || String(v).includes(SEP.layer))
      throw new Error(`bin field ${v} contains a separator — packing would corrupt it`);
  return f.join(SEP.field);
}
function unpackBin(t) {
  const raw = t.split(SEP.field);
  const p = raw.map(Number);
  const edges = {};
  PACK_EDGES.forEach((k, i) => { edges[k] = isFinite(p[10 + i]) ? p[10 + i] : 1; });
  return { x: p[0], y: p[1], u: p[2], v: p[3], hUnits: p[4],
           wall: p[5], floorT: p[6], divX: p[7], divY: p[8], solid: !!p[9],
           edges, base: BASES[p[14]] || 'standard',
           scoop: isFinite(p[15]) ? p[15] : 0, label: isFinite(p[16]) ? p[16] : 0,
           cells: bitsToCells(raw[17] && raw[17] !== '0' ? raw[17] : '', p[2], p[3]) };
}
const packLayers = (layers) =>
  layers.map((L) => L.bins.map(packBin).join(SEP.bin)).join(SEP.layer);
const unpackLayers = (s) => (s || '').split(SEP.layer)
  .map((ls) => ({ bins: ls.split(SEP.bin).filter(Boolean).map(unpackBin) }));

if (typeof module !== 'undefined') {
  module.exports = { buildBin, roundRect, outlineAt, SPEC, BIN_DEFAULTS, LIP_TABLE: LIP,
    lipHeight, BASE_STYLES, footProfile, STUB_H, REQUIRED_CORE,
    maskOf, maskCheck, isFullRect, cellKey, maskBits, bitsToCells,
    packBin, unpackBin, packLayers, unpackLayers };
}
