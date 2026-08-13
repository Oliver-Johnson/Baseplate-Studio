
/* Drawerforge — Gridfinity geometry core.
   Self-contained CSG (BSP) + gridfinity builders + binary STL writer.
   Runs in browser and Node (module.exports guard at bottom). */
'use strict';

const EPS = 1e-5;

// ---------- vectors ----------
const V = {
  sub: (a, b) => [a[0]-b[0], a[1]-b[1], a[2]-b[2]],
  add: (a, b) => [a[0]+b[0], a[1]+b[1], a[2]+b[2]],
  scale: (a, s) => [a[0]*s, a[1]*s, a[2]*s],
  dot: (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2],
  cross: (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]],
  len: (a) => Math.hypot(a[0], a[1], a[2]),
  unit: (a) => { const l = V.len(a); return [a[0]/l, a[1]/l, a[2]/l]; },
  lerp: (a, b, t) => [a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t, a[2]+(b[2]-a[2])*t],
};

// ---------- polygon / plane ----------
function planeFromPoints(a, b, c) {
  const n = V.unit(V.cross(V.sub(b, a), V.sub(c, a)));
  return { n, w: V.dot(n, a) };
}
function makePoly(verts) {
  // pick 3 well-spread verts for a stable plane
  let plane = null;
  for (let i = 2; i < verts.length; i++) {
    const n = V.cross(V.sub(verts[1], verts[0]), V.sub(verts[i], verts[0]));
    if (V.len(n) > 1e-9) { plane = planeFromPoints(verts[0], verts[1], verts[i]); break; }
  }
  if (!plane) return null;
  return { verts, plane };
}
function flipPoly(p) {
  return { verts: p.verts.slice().reverse(), plane: { n: V.scale(p.plane.n, -1), w: -p.plane.w } };
}

// ---------- BSP ----------
const COPLANAR = 0, FRONT = 1, BACK = 2, SPANNING = 3;
function splitPolygon(plane, poly, coplanarFront, coplanarBack, front, back) {
  let polyType = 0;
  const types = [];
  for (const v of poly.verts) {
    const t = V.dot(plane.n, v) - plane.w;
    const type = (t < -EPS) ? BACK : (t > EPS) ? FRONT : COPLANAR;
    polyType |= type; types.push(type);
  }
  switch (polyType) {
    case COPLANAR:
      (V.dot(plane.n, poly.plane.n) > 0 ? coplanarFront : coplanarBack).push(poly); break;
    case FRONT: front.push(poly); break;
    case BACK: back.push(poly); break;
    case SPANNING: {
      const f = [], b = [];
      const n = poly.verts.length;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const ti = types[i], tj = types[j];
        const vi = poly.verts[i], vj = poly.verts[j];
        if (ti !== BACK) f.push(vi);
        if (ti !== FRONT) b.push(vi);
        if ((ti | tj) === SPANNING) {
          const t = (plane.w - V.dot(plane.n, vi)) / V.dot(plane.n, V.sub(vj, vi));
          const v = V.lerp(vi, vj, t);
          f.push(v); b.push(v);
        }
      }
      if (f.length >= 3) { const p = makePoly(f); if (p) { p.plane = poly.plane; front.push(p); } }
      if (b.length >= 3) { const p = makePoly(b); if (p) { p.plane = poly.plane; back.push(p); } }
      break;
    }
  }
}
class Node {
  constructor(polys) { this.plane = null; this.front = null; this.back = null; this.polys = []; if (polys) this.build(polys); }
  invert() {
    const stack = [this];
    while (stack.length) {
      const nd = stack.pop();
      for (let i = 0; i < nd.polys.length; i++) nd.polys[i] = flipPoly(nd.polys[i]);
      if (nd.plane) nd.plane = { n: V.scale(nd.plane.n, -1), w: -nd.plane.w };
      const t = nd.front; nd.front = nd.back; nd.back = t;
      if (nd.front) stack.push(nd.front);
      if (nd.back) stack.push(nd.back);
    }
  }
  clipPolygons(polys) {
    // iterative: worklist of (node, polys)
    let out = [];
    const stack = [[this, polys]];
    while (stack.length) {
      const [nd, ps] = stack.pop();
      if (!nd.plane) { out = out.concat(ps); continue; }
      const front = [], back = [];
      for (const p of ps) splitPolygon(nd.plane, p, front, back, front, back);
      if (nd.front) { if (front.length) stack.push([nd.front, front]); }
      else out = out.concat(front);
      if (nd.back && back.length) stack.push([nd.back, back]);
      // no back child => back polys are inside: dropped
    }
    return out;
  }
  clipTo(bsp) {
    const stack = [this];
    while (stack.length) {
      const nd = stack.pop();
      nd.polys = bsp.clipPolygons(nd.polys);
      if (nd.front) stack.push(nd.front);
      if (nd.back) stack.push(nd.back);
    }
  }
  allPolygons() {
    let ps = [];
    const stack = [this];
    while (stack.length) {
      const nd = stack.pop();
      ps = ps.concat(nd.polys);
      if (nd.front) stack.push(nd.front);
      if (nd.back) stack.push(nd.back);
    }
    return ps;
  }
  build(polys) {
    const stack = [[this, polys]];
    while (stack.length) {
      const [nd, ps] = stack.pop();
      if (!ps.length) continue;
      if (!nd.plane) {
        const mid = ps[ps.length >> 1];
        nd.plane = { n: mid.plane.n.slice(), w: mid.plane.w };
      }
      const front = [], back = [];
      for (const p of ps) splitPolygon(nd.plane, p, nd.polys, nd.polys, front, back);
      if (front.length) { if (!nd.front) nd.front = new Node(); stack.push([nd.front, front]); }
      if (back.length) { if (!nd.back) nd.back = new Node(); stack.push([nd.back, back]); }
    }
  }
}
function csgSubtract(aPolys, bPolys) {
  const a = new Node(aPolys), b = new Node(bPolys);
  a.invert(); a.clipTo(b); b.clipTo(a); b.invert(); b.clipTo(a); b.invert();
  a.build(b.allPolygons()); a.invert();
  return a.allPolygons();
}
function csgUnion(aPolys, bPolys) {
  const a = new Node(aPolys), b = new Node(bPolys);
  a.clipTo(b); b.clipTo(a); b.invert(); b.clipTo(a); b.invert();
  a.build(b.allPolygons());
  return a.allPolygons();
}

// remove all material inside convex 2D polygon `cv` (CCW) above z0 — deterministic
// half-space splitting only; safe through any geometry including cones.
function clipConvexPrismTop(polys, cv, z0) {
  let keep = [], work = polys;
  // peel off parts outside each edge half-plane (those are kept)
  for (let i = 0; i < cv.length; i++) {
    const a = cv[i], b = cv[(i + 1) % cv.length];
    // edge normal pointing OUTWARD (CCW poly): n = (dy, -dx)
    const nx = b[1] - a[1], ny = a[0] - b[0];
    const len = Math.hypot(nx, ny) || 1;
    const plane = { n: [nx/len, ny/len, 0], w: (nx*a[0] + ny*a[1]) / len };
    const front = [], back = [];
    for (const p of work) splitPolygon(plane, p, front, back, front, back);
    keep = keep.concat(front);   // outside this edge -> outside the prism
    work = back;
  }
  // work is now inside the prism in XY: keep only below z0
  const plane = { n: [0, 0, 1], w: z0 };
  const below = [], above = [];
  for (const p of work) splitPolygon(plane, p, above, below, above, below);
  return keep.concat(below);
}

// convex decomposition of a keyed half-shape footprint (grown), piece-local coords
function keyHalfConvexParts(type, edge, e, s, prm, grow) {
  const g = (edge === '+x' || edge === '+y') ? -1 : 1;
  const J = 0.0017, ss = s + J;
  const rect = (d0, d1, w) => {
    if (edge === '+x' || edge === '-x') {
      const x0 = e + g*Math.max(d0, d1)* (g>0?0:1) , dummy=0;
      const xa = e + g*d0, xb = e + g*d1;
      const lo = Math.min(xa, xb), hi = Math.max(xa, xb);
      return [[lo, ss - w], [hi, ss - w], [hi, ss + w], [lo, ss + w]];
    }
    const ya = e + g*d0, yb = e + g*d1;
    const lo = Math.min(ya, yb), hi = Math.max(ya, yb);
    return [[ss - w, lo], [ss - w, hi], [ss + w, hi], [ss + w, lo]];
  };
  if (type === 'bowtie') {
    // one trapezoid (convex): approximate with its bounding rect segments? use exact trapezoid
    const pts = keyHalf('bowtie', edge, e, s, prm, grow);
    return [pts];   // bowtie half is convex already
  }
  if (type === 'puzzlekey') {
    // waist rect + the lobe itself (a convex 16-gon)
    const r = prm.lobeR + grow, cd = prm.len/2 - prm.lobeR;
    const lobe = [];
    for (let k = 0; k < 20; k++) {
      const a = k * 2 * Math.PI / 20;
      const dp = cd + r * Math.cos(a), lt = r * Math.sin(a);
      if (edge === '+x' || edge === '-x') lobe.push([e + g*dp, ss + lt]);
      else lobe.push([ss + lt, e + g*dp]);
    }
    if (g > 0) lobe.reverse();   // keep CCW after mirroring
    return [rect(-0.5, cd, prm.waistW/2 + grow), lobe];
  }
  // snap/hclip dogbone: waist rect + end section (convex part)
  const endStart = prm.len/2 - prm.endLen;
  return [
    rect(-0.5, endStart + 0.1, prm.wMid/2 + grow),
    rect(endStart, prm.len/2 + grow, prm.wEnd/2 + grow),
  ];
}

// clamp a poly soup to the half-space z >= z0 (drops sub-floor cutter leakage)
function clampZ(polys, z0) {
  const plane = { n: [0, 0, 1], w: z0 };
  const out = [], coFront = [], coBack = [], back = [];
  for (const p of polys) splitPolygon(plane, p, coFront, coFront, out, back);
  return out.concat(coFront);
}

// ---------- 2D helpers ----------
function polyArea2D(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    s += pts[i][0]*pts[j][1] - pts[j][0]*pts[i][1];
  }
  return s / 2;
}
// ear clipping; pts = simple polygon (any winding); returns triangles as index triples of the (CCW-normalised) points, plus the points
function earTriangulate(ptsIn) {
  let pts = ptsIn.slice();
  if (polyArea2D(pts) < 0) pts = pts.reverse();
  const n0 = pts.length;
  const idx = Array.from({ length: n0 }, (_, i) => i);
  const tris = [];
  const cross = (o, a, b) => (a[0]-o[0])*(b[1]-o[1]) - (a[1]-o[1])*(b[0]-o[0]);
  const inTri = (p, a, b, c) =>
    cross(a, b, p) >= -1e-9 && cross(b, c, p) >= -1e-9 && cross(c, a, p) >= -1e-9;
  let guard = 0;
  while (idx.length > 3 && guard++ < 20000) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const ia = idx[(i - 1 + idx.length) % idx.length], ib = idx[i], ic = idx[(i + 1) % idx.length];
      const a = pts[ia], b = pts[ib], c = pts[ic];
      if (cross(a, b, c) <= 1e-9) continue;           // reflex or degenerate
      let contains = false;
      for (const k of idx) {
        if (k === ia || k === ib || k === ic) continue;
        if (inTri(pts[k], a, b, c)) { contains = true; break; }
      }
      if (contains) continue;
      tris.push([ia, ib, ic]);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break; // fallback: shouldn't happen for simple polygons
  }
  if (idx.length === 3) tris.push([idx[0], idx[1], idx[2]]);
  return { pts, tris };
}

// extrude a simple 2D polygon (any winding) from z0 to z1 into closed triangle-soup polys
function extrudePoly(pts2d, z0, z1) {
  const { pts, tris } = earTriangulate(pts2d);      // pts is CCW
  const polys = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {                     // sides (outward for CCW)
    const j = (i + 1) % n;
    const a0 = [pts[i][0], pts[i][1], z0], b0 = [pts[j][0], pts[j][1], z0];
    const a1 = [pts[i][0], pts[i][1], z1], b1 = [pts[j][0], pts[j][1], z1];
    const p = makePoly([a0, b0, b1, a1]); if (p) polys.push(p);
  }
  for (const t of tris) {                           // caps
    const top = makePoly([
      [pts[t[0]][0], pts[t[0]][1], z1],
      [pts[t[1]][0], pts[t[1]][1], z1],
      [pts[t[2]][0], pts[t[2]][1], z1]]);
    if (top) polys.push(top);
    const bot = makePoly([
      [pts[t[2]][0], pts[t[2]][1], z0],
      [pts[t[1]][0], pts[t[1]][1], z0],
      [pts[t[0]][0], pts[t[0]][1], z0]]);
    if (bot) polys.push(bot);
  }
  return polys;
}

function roundedSquareRing(cx, cy, half, r, n) {
  n = n || 6;
  r = Math.max(0.3, Math.min(r, half - 0.01));
  const pts = [];
  const cs = [[half-r, half-r, 0], [-half+r, half-r, 90], [-half+r, -half+r, 180], [half-r, -half+r, 270]];
  for (const [ox, oy, a0] of cs) {
    for (let k = 0; k < n; k++) {
      const a = (a0 + 90*k/n) * Math.PI/180;
      pts.push([cx + ox + r*Math.cos(a), cy + oy + r*Math.sin(a)]);
    }
  }
  return pts;
}

// socket cutter: swept rounded-square through the gridfinity profile
function socketCutter(cx, cy, prof, arcSegs) {
  const zs = prof.zs, ds = prof.ds;
  const rings = zs.map((z, i) => {
    const d = ds[i];
    const r = prof.rTop - (d - ds[ds.length-1]);
    return roundedSquareRing(cx, cy, prof.pitchHalf - d, r, arcSegs).map(p => [p[0], p[1], z]);
  });
  const polys = [];
  const n = rings[0].length;
  for (let i = 0; i < rings.length - 1; i++) {
    for (let j = 0; j < n; j++) {
      const k = (j + 1) % n;
      // triangles, not quads: corner-arc faces are conical (non-planar as quads)
      let p = makePoly([rings[i][j], rings[i][k], rings[i+1][k]]); if (p) polys.push(p);
      p = makePoly([rings[i][j], rings[i+1][k], rings[i+1][j]]); if (p) polys.push(p);
    }
  }
  const c0 = [cx, cy, zs[0]], c1 = [cx, cy, zs[zs.length-1]];
  for (let j = 0; j < n; j++) {
    const k = (j + 1) % n;
    let p = makePoly([c0, rings[0][k], rings[0][j]]); if (p) polys.push(p);
    p = makePoly([c1, rings[rings.length-1][j], rings[rings.length-1][k]]); if (p) polys.push(p);
  }
  return polys;
}

function cylinder(cx, cy, r, z0, z1, seg) {
  seg = seg || 14;
  const ring0 = [], ring1 = [];
  for (let i = 0; i < seg; i++) {
    const a = 2*Math.PI*i/seg;
    ring0.push([cx + r*Math.cos(a), cy + r*Math.sin(a), z0]);
    ring1.push([cx + r*Math.cos(a), cy + r*Math.sin(a), z1]);
  }
  const polys = [];
  for (let i = 0; i < seg; i++) {
    const j = (i + 1) % seg;
    let p = makePoly([ring0[i], ring0[j], ring1[j], ring1[i]]); if (p) polys.push(p);
    p = makePoly([[cx, cy, z0], ring0[j], ring0[i]]); if (p) polys.push(p);
    p = makePoly([[cx, cy, z1], ring1[i], ring1[j]]); if (p) polys.push(p);
  }
  return polys;
}

// counterbore: hole cylinder full height + wider recess from chosen face
function screwCutter(cx, cy, holeD, headD, z0, z1, headDepth, fromTop) {
  let polys = cylinder(cx, cy, holeD/2, z0 - 0.5, z1 + 0.5, 12);
  if (headD > holeD) {
    const rec = fromTop
      ? cylinder(cx, cy, headD/2, z1 - headDepth, z1 + 0.5, 14)
      : cylinder(cx, cy, headD/2, z0 - 0.5, z0 + headDepth, 14);
    polys = csgUnion(polys, rec);
  }
  return polys;
}

// dovetail tab footprint (2D); edge: '+x'|'-x'|'+y'|'-y', e = edge coordinate, s = centre along edge
function tabFootprint(edge, e, s, wr, wt, dp, back) {
  let pts;
  if (edge === '+x' || edge === '-x') {
    const g = edge === '+x' ? 1 : -1;
    pts = [[e - g*back, s - wr/2], [e, s - wr/2], [e + g*dp, s - wt/2],
           [e + g*dp, s + wt/2], [e, s + wr/2], [e - g*back, s + wr/2]];
  } else {
    const g = edge === '+y' ? 1 : -1;
    pts = [[s - wr/2, e - g*back], [s - wr/2, e], [s - wt/2, e + g*dp],
           [s + wt/2, e + g*dp], [s + wr/2, e], [s + wr/2, e - g*back]];
  }
  return pts;
}
const OPP = { '+x': '-x', '-x': '+x', '+y': '-y', '-y': '+y' };

// Sutherland–Hodgman: clip any simple polygon to an axis-aligned rect
function clipToRect(pts, x0, y0, x1, y1) {
  const planes = [
    (p) => p[0] >= x0, (p) => p[0] <= x1, (p) => p[1] >= y0, (p) => p[1] <= y1,
  ];
  const inter = [
    (a, b) => [x0, a[1] + (b[1]-a[1]) * (x0-a[0]) / (b[0]-a[0])],
    (a, b) => [x1, a[1] + (b[1]-a[1]) * (x1-a[0]) / (b[0]-a[0])],
    (a, b) => [a[0] + (b[0]-a[0]) * (y0-a[1]) / (b[1]-a[1]), y0],
    (a, b) => [a[0] + (b[0]-a[0]) * (y1-a[1]) / (b[1]-a[1]), y1],
  ];
  let out = pts;
  for (let k = 0; k < 4; k++) {
    const inp = out; out = [];
    if (!inp.length) break;
    for (let i = 0; i < inp.length; i++) {
      const cur = inp[i], prev = inp[(i + inp.length - 1) % inp.length];
      const cIn = planes[k](cur), pIn = planes[k](prev);
      if (cIn) { if (!pIn) out.push(inter[k](prev, cur)); out.push(cur); }
      else if (pIn) out.push(inter[k](prev, cur));
    }
  }
  // drop consecutive duplicates
  const clean = [];
  for (const p of out) {
    const q = clean[clean.length-1];
    if (!q || Math.abs(q[0]-p[0]) > 1e-7 || Math.abs(q[1]-p[1]) > 1e-7) clean.push(p);
  }
  if (clean.length > 2) {
    const a = clean[0], b = clean[clean.length-1];
    if (Math.abs(a[0]-b[0]) < 1e-7 && Math.abs(a[1]-b[1]) < 1e-7) clean.pop();
  }
  return clean.length >= 3 ? clean : null;
}

// ---------- layout ----------
/* General layout: horizontal bands (rowCuts) and per-band column cuts (colCuts[b]).
   splitMode: 'balanced' | 'staggered' | 'manual' (manual uses provided cuts). */
function computeLayout(p) {
  const pitch = p.pitch;
  let nx, ny, mL, mR, mF, mB;
  if (p.marginMode === 'custom') {
    mL = p.mLeft; mR = p.mRight; mF = p.mFront; mB = p.mBack;
    nx = Math.max(1, Math.floor((p.drawerW - mL - mR) / pitch + 1e-6));
    ny = Math.max(1, Math.floor((p.drawerD - mF - mB) / pitch + 1e-6));
    mR = p.drawerW - mL - nx*pitch;
    mB = p.drawerD - mF - ny*pitch;
  } else {
    nx = Math.max(1, Math.floor(p.drawerW / pitch + 1e-6));
    ny = Math.max(1, Math.floor(p.drawerD / pitch + 1e-6));
    const remX = p.drawerW - nx*pitch, remY = p.drawerD - ny*pitch;
    mL = p.alignX === 'start' ? remX : p.alignX === 'end' ? 0 : remX/2;
    mR = remX - mL;
    mF = p.alignY === 'start' ? remY : p.alignY === 'end' ? 0 : remY/2;
    mB = remY - mF;
  }
  const maxCellsX = Math.max(1, Math.floor(p.bedW / pitch));
  const maxCellsY = Math.max(1, Math.floor(p.bedD / pitch));

  function balancedCuts(n, maxCells, m0, m1, bed, extra) {
    // extra: allowance for tab protrusion etc.
    const fits = (counts) => counts.every((c, i) => {
      let w = c*pitch + extra;
      if (i === 0) w += m0;
      if (i === counts.length-1) w += m1;
      return w <= bed + 1e-6;
    });
    for (let k = Math.max(1, Math.ceil(n / maxCells)); k <= n; k++) {
      const base = Math.floor(n / k), ext = n % k;
      const counts = Array.from({ length: k }, (_, i) => base + (i < ext ? 1 : 0));
      if (fits(counts)) {
        const cuts = []; let acc = 0;
        for (let i = 0; i < k - 1; i++) { acc += counts[i]; cuts.push(acc); }
        return cuts;
      }
    }
    return [];
  }
  const extra = p.connector === 'dovetail' ? 2.5 : 0;

  // row bands
  let rowCuts;
  if (p.splitMode === 'plates') {
    const opt = optimizeForPlates(Object.assign({}, p, { splitMode: 'balanced' }));
    if (opt) return computeLayout(Object.assign({}, p, { splitMode: 'manual', rowCuts: opt.rowCuts, colCuts: opt.colCuts }));
    return computeLayout(Object.assign({}, p, { splitMode: 'balanced' }));
  }
  if (p.splitMode === 'manual' && Array.isArray(p.rowCuts)) {
    rowCuts = p.rowCuts.filter(c => c > 0 && c < ny).sort((a, b) => a - b);
  } else {
    rowCuts = balancedCuts(ny, maxCellsY, mF, mB, p.bedD, extra);
  }
  const bandStarts = [0, ...rowCuts];
  const bandEnds = [...rowCuts, ny];
  const nBands = bandStarts.length;

  // per-band column cuts
  const segFits = (cuts) => {
    const segs = cuts.length ? [cuts[0], ...cuts.slice(1).map((c, i) => c - cuts[i]), nx - cuts[cuts.length-1]] : [nx];
    return segs.every((s, i) => {
      let w = s*pitch + extra;
      if (i === 0) w += mL;
      if (i === segs.length-1) w += mR;
      return s >= 1 && w <= p.bedW + 1e-6;
    });
  };
  let colCuts = [];
  for (let b = 0; b < nBands; b++) {
    let cuts;
    if (p.splitMode === 'manual' && p.colCuts && Array.isArray(p.colCuts[b])) {
      cuts = p.colCuts[b].filter(c => c > 0 && c < nx).sort((a, bb) => a - bb);
    } else {
      cuts = balancedCuts(nx, maxCellsX, mL, mR, p.bedW, extra);
      if (p.splitMode === 'staggered' && b % 2 === 1 && cuts.length) {
        const nSeg = cuts.length + 1;
        const halfSeg = Math.max(1, Math.round(nx / nSeg / 2));
        const candidates = [halfSeg, -halfSeg, halfSeg+1, -(halfSeg+1), 1, -1, 2, -2];
        let best = null;
        for (const shift of candidates) {
          const trial = cuts.map(c => c + shift);
          if (trial.some(c => c <= 0 || c >= nx)) continue;
          const sorted = trial.slice().sort((x, y) => x - y);
          if (!segFits(sorted)) continue;
          const segs = [sorted[0], ...sorted.slice(1).map((c, i) => c - sorted[i]), nx - sorted[sorted.length-1]];
          const minSeg = Math.min(...segs);
          if (!best || minSeg > best.minSeg) best = { cuts: sorted, minSeg };
          if (minSeg >= 2) break;
        }
        if (best) cuts = best.cuts;
      }
    }
    colCuts.push(cuts);
  }
  // pieces
  const pieces = [];
  for (let b = 0; b < nBands; b++) {
    const segStarts = [0, ...colCuts[b]];
    const segEnds = [...colCuts[b], nx];
    for (let s = 0; s < segStarts.length; s++) {
      pieces.push({
        id: `${String.fromCharCode(65 + s)}${b + 1}`,
        band: b, seg: s,
        cellX0: segStarts[s], cellY0: bandStarts[b],
        nx: segEnds[s] - segStarts[s], ny: bandEnds[b] - bandStarts[b],
        mL: segStarts[s] === 0 ? mL : 0, mR: segEnds[s] === nx ? mR : 0,
        mF: bandStarts[b] === 0 ? mF : 0, mB: bandEnds[b] === ny ? mB : 0,
      });
    }
  }

  // adjacency -> connector sites (global grid coords, cell units)
  // vertical seams: between horizontally adjacent pieces in same band
  // horizontal seams: between pieces of adjacent bands where x-ranges overlap
  const seams = [];
  for (const a of pieces) for (const c of pieces) {
    if (a === c) continue;
    if (a.band === c.band && a.cellX0 + a.nx === c.cellX0) {
      const y0 = a.cellY0, y1 = a.cellY0 + a.ny;
      const jts = [];
      for (let j = y0 + 1; j < y1; j++) jts.push(j);
      seams.push({ type: 'v', a: a.id, b: c.id, x: c.cellX0, y0, y1, junctions: jts });
    }
    if (a.cellY0 + a.ny === c.cellY0) {
      const x0 = Math.max(a.cellX0, c.cellX0), x1 = Math.min(a.cellX0 + a.nx, c.cellX0 + c.nx);
      if (x1 > x0) {
        const jts = [];
        for (let i = x0 + 1; i < x1; i++) jts.push(i);
        // if the overlap is a single cell wide, use its midpoint so the seam still gets a connector
        if (!jts.length && x1 - x0 === 1) jts.push(x0 + 0.5);
        seams.push({ type: 'h', a: a.id, b: c.id, y: c.cellY0, x0, x1, junctions: jts });
      }
    }
  }
  return { nx, ny, mL, mR, mF, mB, rowCuts, colCuts, pieces, seams,
           bands: nBands, gridW: nx*pitch, gridD: ny*pitch,
           maxCellsX, maxCellsY };
}

/* Per-piece connector lists in piece-local coordinates.
   dovetail: male on left piece (v-seams) / bottom piece (h-seams); notch on the other.
   bowtie: both sides get half-recesses; separate keys are exported. */
function pieceConnectors(cfg, layout, piece) {
  const pitch = cfg.pitch;
  const tabs = [], notches = [], ptabs = [], pnotches = [], keyed = [];
  const t = cfg.connector;
  if (t === 'none') return { tabs, notches, ptabs, pnotches, keyed };
  const W = piece.mL + piece.nx*pitch + piece.mR;
  const D = piece.mF + piece.ny*pitch + piece.mB;
  const lx = (gx) => piece.mL + (gx - piece.cellX0) * pitch;
  const ly = (gy) => piece.mF + (gy - piece.cellY0) * pitch;
  const isTab = t === 'dovetail' || t === 'puzzle';   // everything else keyed (incl. hclip)
  const male = isTab ? { dovetail: tabs, puzzle: ptabs }[t] : null;
  const female = isTab ? { dovetail: notches, puzzle: pnotches }[t] : null;
  for (const s of layout.seams) {
    if (s.type === 'v') {
      if (s.a === piece.id) for (const j of s.junctions)
        (isTab ? male : keyed).push({ edge: '+x', e: W, s: ly(j) });
      else if (s.b === piece.id) for (const j of s.junctions)
        (isTab ? female : keyed).push({ edge: '-x', e: 0, s: ly(j) });
    } else {
      if (s.a === piece.id) for (const j of s.junctions)
        (isTab ? male : keyed).push({ edge: '+y', e: D, s: lx(j) });
      else if (s.b === piece.id) for (const j of s.junctions)
        (isTab ? female : keyed).push({ edge: '-y', e: 0, s: lx(j) });
    }
  }
  return { tabs, notches, ptabs, pnotches, keyed };
}

// bowtie half footprint on an edge (recess opens across the seam)
function bowtieHalf(edge, e, s, bw) {
  // bw: {len, wEnd, wWaist, clr} ; half extends dp = len/2 into this piece
  const dp = bw.len/2 + bw.clr, wE = bw.wEnd + 2*bw.clr, wW = bw.wWaist + 2*bw.clr;
  let pts;
  if (edge === '+x' || edge === '-x') {
    const g = edge === '+x' ? 1 : -1;
    pts = [[e + g*0.5, s - wW/2], [e - g*dp, s - wE/2], [e - g*dp, s + wE/2], [e + g*0.5, s + wW/2]];
  } else {
    const g = edge === '+y' ? 1 : -1;
    pts = [[s - wW/2, e + g*0.5], [s - wE/2, e - g*dp], [s + wE/2, e - g*dp], [s + wW/2, e + g*0.5]];
  }
  return pts;
}

// ---- connector shape library ----
// puzzle male footprint protruding OUT from edge (grow>0 => female cavity, cut INTO the edge)
function puzzleShape(edge, e, s, pz, grow, inward) {
  const nw = pz.neckW/2 + grow, r = pz.lobeR + grow;
  const nl = pz.neckL, cd = pz.neckL + pz.lobeR * 0.55;   // lobe centre depth
  const g0 = (edge === '+x' || edge === '+y') ? 1 : -1;
  const g = inward ? -g0 : g0;
  // half-angle where circle meets neck width
  const th = Math.asin(Math.min(0.95, nw / r));
  const pts = [];
  pts.push([-0.4, -nw]);                                   // start behind edge
  pts.push([nl * 0.55, -nw]);
  for (let k = 0; k <= 18; k++) {                          // lobe arc through the far pole
    const a = -(Math.PI - th) + k * (2 * (Math.PI - th)) / 18;
    pts.push([cd + r * Math.cos(a), r * Math.sin(a)]);
  }
  pts.push([nl * 0.55, nw]);
  pts.push([-0.4, nw]);
  // map (depth, lateral) into world
  return pts.map(([dp, lt]) => {
    if (edge === '+x' || edge === '-x') return [e + g * dp, s + lt];
    return [s + lt, e + g * dp];
  });
}
// generic underside key halves (recess cut into one piece's edge region)
function keyHalf(type, edge, e, s, prm, grow) {
  // returns polygon extending prm depth into the piece, 0.5 past the seam
  let prof;   // list of [depth(from seam, +into piece), halfwidth]
  if (type === 'bowtie') {
    prof = [[-0.5, prm.wWaist/2 + grow], [prm.len/2 + grow, prm.wEnd/2 + grow]];
  } else if (type === 'snap') {
    const endStart = prm.len/2 - prm.endLen, tp = prm.taper !== undefined ? prm.taper : 0.8;
    prof = [[-0.5, prm.wMid/2 + grow], [endStart, prm.wMid/2 + grow],
            [endStart + tp, prm.wEnd/2 + grow], [prm.len/2 + grow, prm.wEnd/2 + grow]];
  } else {    // puzzlekey: waist then lobe (approximated polygonal)
    const r = prm.lobeR + grow, cd = prm.len/2 - prm.lobeR;
    prof = [[-0.5, prm.waistW/2 + grow]];
    const th = Math.asin(Math.min(0.95, (prm.waistW/2 + grow) / r));
    for (let k = 0; k <= 14; k++) {
      const a = -(Math.PI/2 - th) + k * (Math.PI - 2*th) / 14;
      prof.push([cd + r * Math.sin(a + Math.PI/2 - Math.PI/2)*0 + r*Math.cos(a - Math.PI/2 + Math.PI/2)*0, 0]); // placeholder replaced below
    }
    // build lobe explicitly instead
    prof = null;
  }
  let pts;
  if (prof) {
    pts = prof.map(([d, w]) => [d, -w]).concat(prof.slice().reverse().map(([d, w]) => [d, w]));
  } else {
    // puzzle key half: waist to lobe circle
    const r = prm.lobeR + grow, cd = prm.len/2 - prm.lobeR, ww = prm.waistW/2 + grow;
    const th = Math.asin(Math.min(0.95, ww / r));
    pts = [[-0.5, -ww]];
    for (let k = 0; k <= 16; k++) {
      const a = -(Math.PI - th) + k * (2*(Math.PI - th)) / 16;
      pts.push([cd + r * Math.cos(a), r * Math.sin(a)]);
    }
    pts.push([-0.5, ww]);
  }
  const g = (edge === '+x' || edge === '+y') ? -1 : 1;   // recess extends INTO this piece
  return pts.map(([dp, lt]) => {
    if (edge === '+x' || edge === '-x') return [e + g * dp, s + lt];
    return [s + lt, e + g * dp];
  });
}
// prism along an arbitrary horizontal axis from a (u,z) profile — for clip keys
function profilePrism(profile, v0, v1, mapUV) {
  // profile: list of [u, z], normalized to CCW; mapUV(u, v) -> [x, y]
  const ar = profile.reduce((acc, p, i) => { const q = profile[(i+1)%profile.length]; return acc + p[0]*q[1] - q[0]*p[1]; }, 0);
  if (ar < 0) profile = profile.slice().reverse();
  const polys = [];
  const n = profile.length;
  for (let i = 0; i < n; i++) {
    const a = profile[i], b = profile[(i + 1) % n];
    const p = makePoly([
      [...mapUV(a[0], v0), a[1]], [...mapUV(b[0], v0), b[1]],
      [...mapUV(b[0], v1), b[1]], [...mapUV(a[0], v1), a[1]]]);
    if (p) polys.push(p);
  }
  const { pts, tris } = earTriangulate(profile);
  for (const t of tris) {
    let p = makePoly([t[2], t[1], t[0]].map(i => [...mapUV(pts[i][0], v0), pts[i][1]]));
    if (p) polys.push(p);
    p = makePoly(t.map(i => [...mapUV(pts[i][0], v1), pts[i][1]]));
    if (p) polys.push(p);
  }
  return polys;
}

/* Top-snap (click-lock) system, adapted from the Gridfinity Layout Tool sample.
   Per piece: leg slot with barb undercut + bridge rebate, built from box shells.
   prm: { legT:1.0, legLen:1.35(along), legC:1.35(center from seam), barb:0.18,
          bridgeW:1.7, bridgeD:0.85, wall:0.6, clr } */
function snapTopParts(edge, e, s, prm, H) {
  const c = prm.clr;
  const zf = H - 2.35, zLip0 = H - 1.1, zLip1 = H - 0.85, zReb = H - 0.85;
  const legIn = prm.legC - prm.legT/2 - c;          // near flank (toward seam)
  const legOut = prm.legC + prm.legT/2 + c;         // far flank (throat line)
  const cavOut = legOut + prm.barb + 0.05;          // barb cavity far wall
  const hw = prm.legLen/2 + c;                      // slot half-width along seam
  const W = prm.wall;
  const boxes = [];   // each: [d0, d1, s0, s1, z0, z1] in (across-depth, along, z)
  // floor slab under the whole pocket
  boxes.push([legIn - W, cavOut + W, -hw - W, hw + W, zf - 0.6, zf]);
  // near wall (seam side of the leg slot) — stops at the rebate so the bridge seats on it
  boxes.push([legIn - W, legIn, -hw - W, hw + W, zf, zReb]);
  // side walls (along-seam flanks) full height
  boxes.push([legIn - W, cavOut + W, -hw - W, -hw, zf, H]);
  boxes.push([legIn - W, cavOut + W, hw, hw + W, zf, H]);
  // far wall below the lip (cavity outer)
  boxes.push([cavOut, cavOut + W, -hw - W, hw + W, zf, H]);
  // the lip itself: protrudes 0.12 past the throat line so the barb must click past
  const lipIn = legOut - 0.12;
  boxes.push([lipIn, cavOut + W, -hw - W, hw + W, zLip1, H]);
  const wedge = { d0: lipIn, d1: cavOut, z0: zLip0, z1: zLip1, s0: -hw, s1: hw };
  // bridge rebate: opening from the seam to the near wall at the top —
  // realised by NOT rebuilding material there; envelope clip creates it.
  const env = [ -0.5, cavOut + W + 0.02, -hw - W - 0.02, hw + W + 0.02, zf - 0.62 ];
  return { boxes, wedge, env, zf };
}
function snapTopPocket(edge, e, s, prm, H) {
  const { boxes, wedge } = snapTopParts(edge, e, s, prm, H);
  const g = (edge === '+x' || edge === '+y') ? -1 : 1;   // depth direction into the piece
  const J = 0.0017, ss = s + J;
  const map = (d, t) => {
    if (edge === '+x' || edge === '-x') return [e + g*d, ss + t];
    return [ss + t, e + g*d];
  };
  const polys = [];
  const ccw = (pts) => {
    const a = pts.reduce((acc, p, i) => { const q = pts[(i+1)%pts.length]; return acc + p[0]*q[1] - q[0]*p[1]; }, 0);
    return a > 0 ? pts : pts.slice().reverse();
  };
  for (const [d0, d1, s0, s1, z0, z1] of boxes) {
    const pts = ccw([map(d0, s0), map(d1, s0), map(d1, s1), map(d0, s1)]);
    for (const p of extrudePoly(pts, z0, z1)) polys.push(p);
  }
  // barb-lip wedge: 45° underside so it prints without support
  const wpts = (z, d) => [map(d, wedge.s0), map(d, wedge.s1)];
  const [A0, A1] = wpts(0, wedge.d0), [B0, B1] = wpts(0, wedge.d1);
  const tri = [
    [[...A0, wedge.z1], [...B0, wedge.z0], [...B0, wedge.z1]],
    [[...B1, wedge.z1], [...B1, wedge.z0], [...A1, wedge.z1]],
  ];
  for (const t of tri) { const p = makePoly(t); if (p) polys.push(p); }
  // wedge slope + top + back faces
  let p = makePoly([[...A0, wedge.z1], [...A1, wedge.z1], [...B1, wedge.z0], [...B0, wedge.z0]]);
  if (p) polys.push(p);
  p = makePoly([[...B0, wedge.z0], [...B1, wedge.z0], [...B1, wedge.z1], [...B0, wedge.z1]]);
  if (p) polys.push(p);
  p = makePoly([[...A0, wedge.z1], [...B0, wedge.z1], [...B1, wedge.z1], [...A1, wedge.z1]]);
  if (p) polys.push(p);
  return polys;
}
// the printed U-clip: cross-section in (across, z), extruded along the seam
function snapTopClip(prm, H) {
  const t = prm.legT, bd = prm.bridgeD, barb = prm.barb;
  const li = prm.legC - t/2, lo = prm.legC + t/2;
  const bl = lo + 0.15;
  // easier: define with z measured downward then flip
  const legDrop = 1.5;                       // floor 1.9 .. bridge underside 3.4
  const P = [];
  P.push([-bl, 0]); P.push([bl, 0]);                      // top of bridge
  P.push([bl, -bd]); P.push([lo, -bd]);                   // bridge right end, underside
  P.push([lo, -(bd + 0.28)]);                             // leg outer, short shank
  P.push([lo + barb, -(bd + 0.40)]);                      // barb ramp out
  P.push([lo + barb, -(bd + 0.62)]);                      // barb flat (catches lip underside)
  P.push([lo - 0.05, -(bd + 0.92)]);                      // ramp back in (insertion lead)
  P.push([lo - 0.05, -(bd + legDrop - 0.12)]);            // lower shank
  P.push([lo - 0.18, -(bd + legDrop)]);                   // tip chamfer
  P.push([li, -(bd + legDrop)]);                          // tip inner
  P.push([li, -bd]);                                      // leg inner up to bridge
  P.push([-li, -bd]);                                     // across the bridge underside
  P.push([-li, -(bd + legDrop)]);
  P.push([-lo + 0.18, -(bd + legDrop)]);
  P.push([-lo + 0.05, -(bd + legDrop - 0.12)]);
  P.push([-lo + 0.05, -(bd + 0.92)]);
  P.push([-lo - barb, -(bd + 0.62)]);
  P.push([-lo - barb, -(bd + 0.40)]);
  P.push([-lo, -(bd + 0.28)]);
  P.push([-lo, -bd]); P.push([-bl, -bd]);
  const zTopClip = bd + legDrop;
  const prof2 = P.map(([u, z]) => [u, z + zTopClip]);     // shift so bottom = 0
  const w = prm.legLen / 2;
  return profilePrism(prof2, -w, w, (u, v) => [u, v]);
}

// top-insert pocket cup at a keyed site: floor slab + U-shaped walls + rim, direct mesh
function topPocketCup(type, edge, e, s, prm, clr, zf, zTop) {
  const polys = [];
  const inner = keyHalf(type, edge, e, s, prm, clr);
  const outer = keyHalf(type, edge, e, s, prm, clr + 0.6);
  // trim both polylines flush at the seam plane (drop the -0.5 protrusion)
  const axis = (edge === '+x' || edge === '-x') ? 0 : 1;
  const dirOut = (edge === '+x' || edge === '+y') ? 1 : -1;   // direction pointing out of the piece
  const clampP = (pts) => pts.map(p => {
    const q = p.slice();
    if ((q[axis] - e) * dirOut > 1e-9) q[axis] = e;   // clamp only points past the seam
    return q;
  });
  const inn = clampP(inner), out = clampP(outer);
  const n = inn.length;   // same topology (same generator)
  // U-walls between inner & outer (skip the seam-side closing edge: indices 0..n-1 path;
  // generator returns closed polygon whose first & last points sit on the seam)
  for (let i = 0; i < n - 1; i++) {
    let p = makePoly([[inn[i][0], inn[i][1], zf], [inn[i+1][0], inn[i+1][1], zf],
                      [inn[i+1][0], inn[i+1][1], zTop], [inn[i][0], inn[i][1], zTop]]);
    if (p) polys.push(p);   // inner wall (faces pocket)
    p = makePoly([[out[i+1][0], out[i+1][1], zf - 0.6], [out[i][0], out[i][1], zf - 0.6],
                  [out[i][0], out[i][1], zTop], [out[i+1][0], out[i+1][1], zTop]]);
    if (p) polys.push(p);   // outer wall
    // top ring quad
    p = makePoly([[inn[i][0], inn[i][1], zTop], [inn[i+1][0], inn[i+1][1], zTop],
                  [out[i+1][0], out[i+1][1], zTop], [out[i][0], out[i][1], zTop]]);
    if (p) polys.push(p);
  }
  // seam-face end caps (between inner & outer at both ends)
  for (const [ia, ib] of [[0, 0], [n-1, n-1]]) {
    const p = makePoly([[inn[ia][0], inn[ia][1], zf], [out[ib][0], out[ib][1], zf - 0.6],
                        [out[ib][0], out[ib][1], zTop], [inn[ia][0], inn[ia][1], zTop]]);
    if (p) polys.push(p);
  }
  // floor slab: outer outline area, top face at zf (pocket floor), bottom at zf-0.6
  const { pts: fp, tris: ft } = earTriangulate(out);
  for (const t of ft) {
    let p = makePoly(t.map(i => [fp[i][0], fp[i][1], zf]));           // up
    if (p) polys.push(p);
    p = makePoly([t[2], t[1], t[0]].map(i => [fp[i][0], fp[i][1], zf - 0.6]));  // down
    if (p) polys.push(p);
  }
  // seam-face edge of the floor slab
  const pA = makePoly([[inn[0][0], inn[0][1], zf], [inn[n-1][0], inn[n-1][1], zf],
                       [out[n-1][0], out[n-1][1], zf - 0.6], [out[0][0], out[0][1], zf - 0.6]]);
  if (pA) polys.push(pA);
  return polys;
}

// H-clip proportions expressed as a snap (dogbone) profile — proven-clean cut path
function hclipPrm(hc) {
  const endLen = hc.flangeT + 0.25;
  return { len: hc.waistL + 2*endLen, wMid: hc.waistW, wEnd: hc.flangeW,
           endLen, taper: 0.25, depth: 2.15, clr: hc.clr };
}
// (legacy two-rect version, unused)
function hclipHalfRects(edge, e, s, hc, grow) {
  const J = 0.0017;
  const tW = hc.waistW/2 + grow, pW = hc.flangeW/2 + grow;
  const t0 = -0.5, t1 = hc.waistL/2 + grow + 0.05;          // throat span from seam
  const p0 = hc.waistL/2 - 0.05, p1 = hc.waistL/2 + hc.flangeT + grow;  // pocket span
  const g = (edge === '+x' || edge === '+y') ? -1 : 1;      // into the piece
  const mk = (d0, d1, w) => {
    const ss = s + J;
    if (edge === '+x' || edge === '-x')
      return [[e + g*d0, ss - w], [e + g*d1, ss - w], [e + g*d1, ss + w], [e + g*d0, ss + w]];
    return [[ss - w, e + g*d0], [ss - w, e + g*d1], [ss + w, e + g*d1], [ss + w, e + g*d0]];
  };
  return [mk(t0, t1, tW), mk(p0, p1, pW)];
}

// full key outlines (for export)
function keyOutline(type, prm) {
  if (type === 'bowtie')
    return [[-prm.len/2, -prm.wEnd/2], [0, -prm.wWaist/2], [prm.len/2, -prm.wEnd/2],
            [prm.len/2, prm.wEnd/2], [0, prm.wWaist/2], [-prm.len/2, prm.wEnd/2]];
  if (type === 'hclip') {
    const wl = prm.waistL/2, ft = prm.flangeT, fw = prm.flangeW/2, ww = prm.waistW/2;
    return [[-wl-ft, -fw], [-wl, -fw], [-wl, -ww], [wl, -ww], [wl, -fw], [wl+ft, -fw],
            [wl+ft, fw], [wl, fw], [wl, ww], [-wl, ww], [-wl, fw], [-wl-ft, fw]];
  }
  if (type === 'snap') {
    const es = prm.len/2 - prm.endLen, tp = prm.taper !== undefined ? prm.taper : 0.8;
    return [[-prm.len/2, -prm.wEnd/2], [-es - tp, -prm.wEnd/2], [-es, -prm.wMid/2],
            [es, -prm.wMid/2], [es + tp, -prm.wEnd/2], [prm.len/2, -prm.wEnd/2],
            [prm.len/2, prm.wEnd/2], [es + tp, prm.wEnd/2], [es, prm.wMid/2],
            [-es, prm.wMid/2], [-es - tp, prm.wEnd/2], [-prm.len/2, prm.wEnd/2]];
  }
  // puzzlekey: two lobes joined at x = ±0.5 (guaranteed simple polygon)
  const r = prm.lobeR, cd = prm.len/2 - r;
  const aj = Math.acos(Math.max(-0.98, (0.5 - cd) / r));
  const pts = [];
  for (let k = 0; k <= 16; k++) {   // right lobe, CCW from lower junction
    const a = -aj + k * (2*aj) / 16;
    pts.push([cd + r * Math.cos(a), r * Math.sin(a)]);
  }
  for (let k = 0; k <= 16; k++) {   // left lobe
    const a = (Math.PI - aj) + k * (2*aj) / 16;
    pts.push([-cd + r * Math.cos(a), r * Math.sin(a)]);
  }
  return pts;
}
function buildKey(type, prm, height) {
  let polys = extrudePoly(keyOutline(type, prm), 0, height);
  if (type === 'snap') {   // spring slot through the middle
    const sl = prm.len * 0.62, sw = 1.3;
    polys = csgSubtract(polys, extrudePoly(
      [[-sl/2, -sw/2], [sl/2, -sw/2], [sl/2, sw/2], [-sl/2, sw/2]], -0.5, height + 0.5));
  }
  return polys;
}

// full bowtie key (both halves), centred at origin along x
function bowtieKey(bw, height) {
  const dp = bw.len/2, wE = bw.wEnd, wW = bw.wWaist;
  const pts = [[-dp, -wE/2], [0, -wW/2], [dp, -wE/2], [dp, wE/2], [0, wW/2], [-dp, wE/2]];
  return extrudePoly(pts, 0, height);
}

// triangulate an annular region between outer loop (CCW) and inner loop (CCW)
// via keyhole bridging, then ear clipping
function triangulateRing(outer, inner) {
  // bridge from inner's rightmost vertex to a visible outer vertex
  let mi = 0;
  for (let i = 1; i < inner.length; i++) if (inner[i][0] > inner[mi][0]) mi = i;
  const M = inner[mi];
  const segInt = (a, b, c, d) => {
    const d1 = [b[0]-a[0], b[1]-a[1]], d2 = [d[0]-c[0], d[1]-c[1]];
    const den = d1[0]*d2[1] - d1[1]*d2[0];
    if (Math.abs(den) < 1e-12) return false;
    const t = ((c[0]-a[0])*d2[1] - (c[1]-a[1])*d2[0]) / den;
    const u = ((c[0]-a[0])*d1[1] - (c[1]-a[1])*d1[0]) / den;
    return t > 1e-7 && t < 1-1e-7 && u > 1e-7 && u < 1-1e-7;
  };
  const cand = outer.map((p, i) => [i, (p[0]-M[0])**2 + (p[1]-M[1])**2])
                    .sort((a, b) => a[1] - b[1]);
  let oi = cand[0][0];
  for (const [i] of cand) {
    const O = outer[i];
    let blocked = false;
    for (let k = 0; k < outer.length && !blocked; k++) {
      const k2 = (k+1) % outer.length;
      if (k === i || k2 === i) continue;
      if (segInt(M, O, outer[k], outer[k2])) blocked = true;
    }
    for (let k = 0; k < inner.length && !blocked; k++) {
      const k2 = (k+1) % inner.length;
      if (k === mi || k2 === mi) continue;
      if (segInt(M, O, inner[k], inner[k2])) blocked = true;
    }
    if (!blocked) { oi = i; break; }
  }
  // splice: outer[0..oi], M, inner reversed from mi, M, outer[oi..]
  const innerCW = [];
  for (let k = 0; k < inner.length; k++) innerCW.push(inner[(mi - k + inner.length) % inner.length]);
  const merged = [];
  for (let k = 0; k <= oi; k++) merged.push(outer[k]);
  merged.push(...innerCW, inner[mi].slice(), outer[oi].slice());
  for (let k = oi + 1; k < outer.length; k++) merged.push(outer[k]);
  const { pts, tris } = earTriangulate(merged);
  return { pts, tris };
}

// direct watertight mesh for a cell region (no CSG); supports closed floor (pad>0)
function directCellRegion(clipped, prof, cx, cy, H, pad, arcSegs) {
  const polys = [];
  const { pts: oc } = earTriangulate(clipped);
  const n = oc.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const p = makePoly([[oc[i][0], oc[i][1], 0], [oc[j][0], oc[j][1], 0],
                        [oc[j][0], oc[j][1], H], [oc[i][0], oc[i][1], H]]);
    if (p) polys.push(p);
  }
  const zs = prof.zs.slice(1, 5), ds = prof.ds.slice(1, 5);
  const rings = zs.map((z, i) => {
    const d = ds[i];
    const r = prof.rTop - (d - ds[ds.length-1]);
    return roundedSquareRing(cx, cy, prof.pitchHalf - d, r, arcSegs).map(p => [p[0], p[1], z]);
  });
  const rn = rings[0].length;
  for (let i = 0; i < rings.length - 1; i++) {
    for (let j = 0; j < rn; j++) {
      const k = (j + 1) % rn;
      let p = makePoly([rings[i][k], rings[i][j], rings[i+1][k]]); if (p) polys.push(p);
      p = makePoly([rings[i+1][k], rings[i][j], rings[i+1][j]]); if (p) polys.push(p);
    }
  }
  const topR = triangulateRing(oc, rings[rings.length-1].map(v => [v[0], v[1]]));
  for (const t of topR.tris) {
    const p = makePoly(t.map(i => [topR.pts[i][0], topR.pts[i][1], H]));
    if (p) polys.push(p);
  }
  if (pad > 0.01) {
    // full bottom cap + socket floor disc
    const { pts: bp, tris: bt } = earTriangulate(clipped);
    for (const t of bt) {
      const p = makePoly([t[2], t[1], t[0]].map(i => [bp[i][0], bp[i][1], 0]));
      if (p) polys.push(p);
    }
    const fl = rings[0];
    const c = [cx, cy, fl[0][2]];
    for (let j = 0; j < rn; j++) {
      const k = (j + 1) % rn;
      const p = makePoly([c, fl[j], fl[k]]); if (p) polys.push(p);
    }
  } else {
    const botR = triangulateRing(oc, rings[0].map(v => [v[0], v[1]]));
    for (const t of botR.tris) {
      const p = makePoly([t[2], t[1], t[0]].map(i => [botR.pts[i][0], botR.pts[i][1], 0]));
      if (p) polys.push(p);
    }
  }
  return polys;
}

// ---------- plate builder ----------
/* Region-decomposed build: no global CSG. Each piece = margin/corner regions (plain
   extrusions) + one region per cell (extrusion minus its socket cutter and holes).
   Regions are clipped from the global outline (rounded corners, connector bites)
   and bloated 0.05mm so shells overlap; slicers union overlapping shells. */
function buildPiece(cfg, layout, piece, onStatus) {
  const pitch = cfg.pitch, half = pitch/2;
  const solidBase = cfg.baseMode !== 'bosses';
  let pad = ((cfg.magnets || cfg.screws) && solidBase) ? Math.max(cfg.bottomPad, cfg.magnetBase || 2.8) : cfg.bottomPad;
  const isHclip = cfg.connector === 'hclip';
  const topInsert = cfg.keyInsert === 'top';
  const keyedConn = ['bowtie', 'snap', 'puzzlekey'].includes(cfg.connector);
  const wallKeys = (keyedConn && cfg.keyMount === 'wall');
  const keyDims = wallKeys ? cfg.keySlim : cfg.key;
  if (keyedConn && !wallKeys) pad = Math.max(pad, cfg.key.depth + 0.8);
  if (cfg.connector === 'puzzle') pad = Math.max(pad, 2.6);
  const H = pad + cfg.plateHeight;
  const tol = cfg.tolerance === 'tight' ? +0.1 : cfg.tolerance === 'loose' ? -0.1 : 0;
  const dTop = cfg.topCutoff, dMid = 2.15 + tol, dBot = 2.85 + tol;
  const prof = {
    pitchHalf: half, rTop: cfg.socketRadius,
    zs: [pad > 0 ? pad : -1, pad, pad + 0.7, pad + 2.5, H, H + 1.5],
    ds: [dBot, dBot, dMid, dMid, dTop, dTop],
  };

  const W = piece.mL + piece.nx*pitch + piece.mR;
  const D = piece.mF + piece.ny*pitch + piece.mB;
  const gx0 = piece.mL, gy0 = piece.mF;

  // ---- connectors ----
  const conn = pieceConnectors(cfg, layout, piece);
  const tabs = conn.tabs, notches = conn.notches;
  const ptabs = conn.ptabs, pnotches = conn.pnotches, keyed = conn.keyed;
  const t = cfg.tab;
  // ---- global outline: rect + rounded outer corners + notch bites ----
  const rr = cfg.cornerRadii || {};
  const rOf = (k) => Math.max(0, Math.min(rr[k] !== undefined ? rr[k] : cfg.outerRadius, half));
  const NARC = 10;
  const round = {
    ll: piece.col === 0 && piece.row === 0,
    lr: piece.col === layout.cols-1 && piece.row === 0,
    ur: piece.col === layout.cols-1 && piece.row === layout.rows-1,
    ul: piece.col === 0 && piece.row === layout.rows-1,
  };
  function corner(cx, cy, a0, doRound, key) {
    const rc = rOf(key);
    if (!doRound || rc <= 0.01) return [[cx, cy]];
    const ccx = cx + (cx < 1 ? rc : -rc), ccy = cy + (cy < 1 ? rc : -rc);
    const out = [];
    for (let k = 0; k <= NARC; k++) {
      const a = (a0 + 90*k/NARC) * Math.PI/180;
      out.push([ccx + rc*Math.cos(a), ccy + rc*Math.sin(a)]);
    }
    return out;
  }
  const nWr = t.wr + 2*t.clr, nWt = t.wt + 2*t.clr, nDp = t.dp + t.clr;
  const outline = [];
  outline.push(...corner(0, 0, 180, round.ll, 'll'));
  outline.push(...corner(W, 0, 270, round.lr, 'lr'));
  outline.push(...corner(W, D, 0, round.ur, 'ur'));
  outline.push(...corner(0, D, 90, round.ul, 'ul'));
  if (onStatus) onStatus('outline');

  // ---- region grid: x cuts and y cuts ----
  const xs = [0]; if (piece.mL > 0.01) xs.push(piece.mL);
  for (let i = 1; i <= piece.nx; i++) xs.push(gx0 + i*pitch);
  if (piece.mR > 0.01) xs.push(W); else xs[xs.length-1] = W;
  const ys = [0]; if (piece.mF > 0.01) ys.push(piece.mF);
  for (let j = 1; j <= piece.ny; j++) ys.push(gy0 + j*pitch);
  if (piece.mB > 0.01) ys.push(D); else ys[ys.length-1] = D;
  const cellXi = piece.mL > 0.01 ? 1 : 0;         // index offset of first cell column
  const cellYi = piece.mF > 0.01 ? 1 : 0;
  const BLOAT = 0.05;

  let allPolys = [];
  let done = 0;
  for (let ix = 0; ix < xs.length-1; ix++) {
    for (let iy = 0; iy < ys.length-1; iy++) {
      const x0 = Math.max(0, xs[ix] - BLOAT), x1 = Math.min(W, xs[ix+1] + BLOAT);
      const y0 = Math.max(0, ys[iy] - BLOAT), y1 = Math.min(D, ys[iy+1] + BLOAT);
      const clipped = clipToRect(outline, x0, y0, x1, y1);
      if (!clipped) continue;
      const ci = ix - cellXi, cj = iy - cellYi;
      const isCell = ci >= 0 && ci < piece.nx && cj >= 0 && cj < piece.ny;
      if (!isCell) {                                 // margin / corner: plain extrusion
        for (const p of extrudePoly(clipped, 0, H)) allPolys.push(p);
        continue;
      }
      const cx = gx0 + ci*pitch + half, cy = gy0 + cj*pitch + half;
      let region = directCellRegion(clipped, prof, cx, cy, H, pad, cfg.arcSegs || 6);
      // small convex cutters local to this cell
      let small = [];
      const seqCuts = [];
      for (const nb of notches) {
        const near = (nb.edge === '+x' || nb.edge === '-x')
          ? (nb.s > y0 - nWt && nb.s < y1 + nWt &&
             (nb.edge === '+x' ? Math.abs(x1 - W) : Math.abs(x0)) < nDp + 0.2)
          : (nb.s > x0 - nWt && nb.s < x1 + nWt &&
             (nb.edge === '+y' ? Math.abs(y1 - D) : Math.abs(y0)) < nDp + 0.2);
        if (near) {
          // 4-pt taper: no vertex sits exactly on the region side plane; jitter breaks
          // residual coincidences with ring geometry
          const J = 0.0017, BK = 1.0, e = nb.e, s = nb.s + J;
          let pts;
          if (nb.edge === '+x' || nb.edge === '-x') {
            const g = nb.edge === '-x' ? 1 : -1;   // cut extends INTO the piece
            pts = [[e - g*BK, s - nWr/2], [e + g*nDp, s - nWt/2],
                   [e + g*nDp, s + nWt/2], [e - g*BK, s + nWr/2]];
          } else {
            const g = nb.edge === '-y' ? 1 : -1;
            pts = [[s - nWr/2, e - g*BK], [s - nWt/2, e + g*nDp],
                   [s + nWt/2, e + g*nDp], [s + nWr/2, e - g*BK]];
          }
          small = small.concat(extrudePoly(pts, -0.503, Math.min(t.h + 0.2, H - 0.8)));
        }
      }
      for (const bo of keyed) {
        if ((wallKeys || isHclip) && Math.abs(bo.s / pitch - Math.round(bo.s / pitch)) > 0.25 &&
            Math.abs((bo.s - (bo.edge === '+x' || bo.edge === '-x' ? gy0 : gx0)) / pitch -
                     Math.round((bo.s - (bo.edge === '+x' || bo.edge === '-x' ? gy0 : gx0)) / pitch)) > 0.25)
          continue;   // wall mode: keys need a wall junction, skip mid-cell seams
        const halfW = isHclip ? cfg.hclip.flangeW : keyDims.wEnd;
        const reach = isHclip ? hclipPrm(cfg.hclip).len/2 + 1 : keyDims.len/2 + 1;
        const near = (bo.edge === '+x' || bo.edge === '-x')
          ? (bo.s > y0 - halfW && bo.s < y1 + halfW &&
             (bo.edge === '+x' ? Math.abs(x1 - W) : Math.abs(x0)) < reach)
          : (bo.s > x0 - halfW && bo.s < x1 + halfW &&
             (bo.edge === '+y' ? Math.abs(y1 - D) : Math.abs(y0)) < reach);
        if (!near) continue;
        if ((isHclip || wallKeys) && topInsert) {
          continue;   // handled as a post-pass (clip + cup)
        }
        if (isHclip) {
          // bottom-insert H pocket via the snap profile (ceiling below rim geometry)
          small = small.concat(extrudePoly(
            keyHalf('snap', bo.edge, bo.e, bo.s, hclipPrm(cfg.hclip), cfg.hclip.clr),
            -0.5, Math.min(2.3, H - 0.8)));
        } else {
          small = small.concat(
            extrudePoly(keyHalf(cfg.keyType, bo.edge, bo.e, bo.s, keyDims, keyDims.clr),
                        -0.5, wallKeys ? 2.0 : Math.min(cfg.key.depth, pad - 0.6)));
        }
      }
      for (const pn of pnotches) {
        const reach = cfg.puzzle.neckL + cfg.puzzle.lobeR * 1.6 + 1;
        const near = (pn.edge === '+x' || pn.edge === '-x')
          ? (pn.s > y0 - cfg.puzzle.lobeR*2 && pn.s < y1 + cfg.puzzle.lobeR*2 &&
             (pn.edge === '+x' ? Math.abs(x1 - W) : Math.abs(x0)) < reach)
          : (pn.s > x0 - cfg.puzzle.lobeR*2 && pn.s < x1 + cfg.puzzle.lobeR*2 &&
             (pn.edge === '+y' ? Math.abs(y1 - D) : Math.abs(y0)) < reach);
        if (near) small = small.concat(
          extrudePoly(puzzleShape(pn.edge, pn.e, pn.s, cfg.puzzle, cfg.puzzle.clr, true),
                      -0.5, pad - 0.4));
      }
      if ((cfg.magnets || cfg.screws) && solidBase) {
        const off = cfg.holeOffset;
        for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
          const hx = cx + sx*off, hy = cy + sy*off;
          if (cfg.magnets) {
            small = small.concat(cfg.magnetSide === 'top'
              ? cylinder(hx, hy, cfg.magnetD/2 + 0.1, pad - cfg.magnetH, pad + 0.02, 14)
              : cylinder(hx, hy, cfg.magnetD/2 + 0.1, -0.5, cfg.magnetH, 14));
          }
          if (cfg.screws) {
            small = small.concat(cylinder(hx, hy, cfg.screwHoleD/2, -0.5, H + 0.5, 12));
            if (cfg.screwHeadD > cfg.screwHoleD)
              small = small.concat(cylinder(hx, hy, cfg.screwHeadD/2, -0.5, cfg.screwHeadDepth, 14));
          }
        }
      }
      if (small.length) region = csgSubtract(region, small);
      for (const cut of seqCuts) region = csgSubtract(region, cut);
      for (const p of region) allPolys.push(p);
      done++;
      if (onStatus && done % 8 === 0) onStatus(`cells ${done}`);
    }
  }

  // magnet 'top' pockets  // magnet 'top' pockets sit in the socket floor: they need pad and were cut
  // relative to pad above; screw counterbores cut from the bottom face.

  // ---- corner bosses (pocket-style mounting, saves filament) ----
  if ((cfg.magnets || cfg.screws) && !solidBase) {
    const off = cfg.holeOffset;
    const bossW = 12.5, rIn = 3.5;
    const bossH = Math.min(2.6, Math.max(
      cfg.magnets ? cfg.magnetH + 0.8 : 0,
      cfg.screws ? cfg.screwHeadDepth + 1.0 : 0));
    for (let i = 0; i < piece.nx; i++) for (let j = 0; j < piece.ny; j++) {
      const ccx = gx0 + i*pitch + half, ccy = gy0 + j*pitch + half;
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
        const cxr = ccx + sx*half, cyr = ccy + sy*half;    // cell corner
        // quarter boss with rounded inner corner, oriented into the cell
        const pts = [];
        pts.push([0, 0], [bossW, 0], [bossW, bossW - rIn]);
        for (let k = 1; k <= 6; k++) {
          const a = k * (Math.PI/2) / 6;
          pts.push([bossW - rIn + rIn*Math.cos(a), bossW - rIn + rIn*Math.sin(a)]);
        }
        pts.push([0, bossW]);
        const world = pts.map(([u, v]) => [cxr - sx*u, cyr - sy*v]);
        let boss = extrudePoly(world, 0, bossH);
        const hx = ccx + sx*off, hy = ccy + sy*off;
        let cuts = [];
        if (cfg.magnets) cuts = cuts.concat(
          cfg.magnetSide === 'top'
            ? cylinder(hx, hy, cfg.magnetD/2 + 0.1, bossH - cfg.magnetH, bossH + 0.5, 14)
            : cylinder(hx, hy, cfg.magnetD/2 + 0.1, -0.5, cfg.magnetH, 14));
        if (cfg.screws) {
          cuts = cuts.concat(cylinder(hx, hy, cfg.screwHoleD/2, -0.5, bossH + 0.5, 12));
          if (cfg.screwHeadD > cfg.screwHoleD)
            cuts = cuts.concat(cylinder(hx, hy, cfg.screwHeadD/2, -0.5, cfg.screwHeadDepth, 14));
        }
        if (cuts.length) boss = csgSubtract(boss, cuts);
        for (const p of boss) allPolys.push(p);
      }
    }
  }

  // ---- puzzle male tabs (protrude at floor level) ----
  for (const pt of ptabs) {
    const fp = puzzleShape(pt.edge, pt.e, pt.s, cfg.puzzle, 0, false);
    for (const p of extrudePoly(fp, 0, Math.max(1.2, pad - 0.65))) allPolys.push(p);
  }

  // ---- tabs (separate overlapping shells) ----
  for (const tb of tabs) {
    const fp = tabFootprint(tb.edge, tb.e, tb.s, t.wr, t.wt, t.dp, 0.8);
    for (const p of extrudePoly(fp, 0, t.h)) allPolys.push(p);
  }
  // top-insert keyed pockets: BSP-free clip + direct pocket cups
  if (cfg.connector === 'snap' && topInsert) {
    const prm = Object.assign({ legT: 1.0, legLen: 1.35, legC: 1.4, barb: 0.18,
                                bridgeW: 1.7, bridgeD: 0.85, wall: 0.6 },
                              { clr: cfg.key.clr });
    let ps = allPolys;
    for (const bo of keyed) {
      if (Math.abs(bo.s / pitch - Math.round(bo.s / pitch)) > 0.25 &&
          Math.abs((bo.s - (bo.edge === '+x' || bo.edge === '-x' ? gy0 : gx0)) / pitch -
                   Math.round((bo.s - (bo.edge === '+x' || bo.edge === '-x' ? gy0 : gx0)) / pitch)) > 0.25)
        continue;
      const { env } = snapTopParts(bo.edge, bo.e, bo.s, prm, H);
      const g2 = (bo.edge === '+x' || bo.edge === '+y') ? -1 : 1;
      const ss2 = bo.s + 0.0017;
      const rect = (bo.edge === '+x' || bo.edge === '-x')
        ? [[bo.e + g2*env[0], ss2 + env[2]], [bo.e + g2*env[1], ss2 + env[2]],
           [bo.e + g2*env[1], ss2 + env[3]], [bo.e + g2*env[0], ss2 + env[3]]]
        : [[ss2 + env[2], bo.e + g2*env[0]], [ss2 + env[3], bo.e + g2*env[0]],
           [ss2 + env[3], bo.e + g2*env[1]], [ss2 + env[2], bo.e + g2*env[1]]];
      // ensure CCW for the clipper
      const area = rect.reduce((a, p, i) => { const q = rect[(i+1)%4]; return a + p[0]*q[1] - q[0]*p[1]; }, 0);
      ps = clipConvexPrismTop(ps, area > 0 ? rect : rect.slice().reverse(), env[4]);
      for (const p of snapTopPocket(bo.edge, bo.e, bo.s, prm, H)) ps.push(p);
    }
    allPolys = ps;
  } else if ((isHclip || wallKeys) && topInsert) {
    const type = isHclip ? 'snap' : cfg.keyType;
    const prm = isHclip ? hclipPrm(cfg.hclip) : keyDims;
    const clr = isHclip ? cfg.hclip.clr : keyDims.clr;
    const zf = Math.max(1.2, H - 2.25), zTop = H - 0.85;
    let ps = allPolys;
    for (const bo of keyed) {
      if (Math.abs(bo.s / pitch - Math.round(bo.s / pitch)) > 0.25 &&
          Math.abs((bo.s - (bo.edge === '+x' || bo.edge === '-x' ? gy0 : gx0)) / pitch -
                   Math.round((bo.s - (bo.edge === '+x' || bo.edge === '-x' ? gy0 : gx0)) / pitch)) > 0.25)
        continue;
      for (const cv of keyHalfConvexParts(type, bo.edge, bo.e, bo.s, prm, clr + 0.55))
        ps = clipConvexPrismTop(ps, cv, zf - 0.55);
      for (const p of topPocketCup(type, bo.edge, bo.e, bo.s, prm, clr, zf, zTop)) ps.push(p);
    }
    allPolys = ps;
  }
  if (onStatus) onStatus('done');
  const outPolys = clampZ(allPolys, 0);
  const protr = { l: 0, r: 0, f: 0, b: 0 };
  for (const tb of tabs) {
    if (tb.edge === '+x') protr.r = t.dp; else if (tb.edge === '-x') protr.l = t.dp;
    else if (tb.edge === '+y') protr.b = t.dp; else protr.f = t.dp;
  }
  const pzOut = cfg.puzzle.neckL + cfg.puzzle.lobeR * 1.6;
  for (const tb of ptabs) {
    if (tb.edge === '+x') protr.r = pzOut; else if (tb.edge === '-x') protr.l = pzOut;
    else if (tb.edge === '+y') protr.b = pzOut; else protr.f = pzOut;
  }
  return { polys: outPolys, W, D, H, tabs: tabs.length, notches: notches.length,
           bowties: keyed.length, puzzles: ptabs.length + pnotches.length, protrusion: protr };
}

// 1x1 test tile: single-cell plate, no margins/connectors
function buildTestTile(cfg) {
  const layout = { cols: 1, rows: 1 };
  const piece = { id: 'TEST', col: 0, row: 0, cellX0: 0, cellY0: 0, nx: 1, ny: 1, mL: 0, mR: 0, mF: 0, mB: 0 };
  const c2 = Object.assign({}, cfg, { connector: 'none' });
  return buildPiece(c2, layout, piece);
}

// ---------- STL ----------
function polysToTriangles(polys) {
  const tris = [];
  for (const p of polys) {
    for (let i = 2; i < p.verts.length; i++) tris.push([p.verts[0], p.verts[i-1], p.verts[i]]);
  }
  return tris;
}
function stlBinary(polys, name) {
  const tris = polysToTriangles(polys);
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const dv = new DataView(buf);
  const header = (name || 'gridfinity').slice(0, 79);
  for (let i = 0; i < header.length; i++) dv.setUint8(i, header.charCodeAt(i));
  dv.setUint32(80, tris.length, true);
  let o = 84;
  for (const t of tris) {
    const n = V.unit(V.cross(V.sub(t[1], t[0]), V.sub(t[2], t[0])));
    dv.setFloat32(o, n[0], true); dv.setFloat32(o+4, n[1], true); dv.setFloat32(o+8, n[2], true); o += 12;
    for (const v of t) { dv.setFloat32(o, v[0], true); dv.setFloat32(o+4, v[1], true); dv.setFloat32(o+8, v[2], true); o += 12; }
    dv.setUint16(o, 0, true); o += 2;
  }
  return buf;
}

// manifold sanity: every edge shared by exactly 2 triangles (within rounding)
function checkManifold(polys) {
  const tris = polysToTriangles(polys);
  const key = (v) => v.map(x => Math.round(x * 1000) / 1000).join(',');
  const edges = new Map();
  for (const t of tris) {
    for (let i = 0; i < 3; i++) {
      const a = key(t[i]), b = key(t[(i+1)%3]);
      const k = a < b ? a + '|' + b : b + '|' + a;
      edges.set(k, (edges.get(k) || 0) + 1);
    }
  }
  let bad = 0;
  for (const c of edges.values()) if (c !== 2) bad++;
  return { edges: edges.size, bad, tris: tris.length };
}

// ---------- connector fit sample ----------
/* Small test strip: N tile pairs with graduated clearance + one key (keyed types).
   Tiles are plain rounded slabs (fast print) with the joint on the mating edges. */
function buildFitSample(cfg, H) {
  H = H || 4.25;
  const clrs = [-0.05, 0, 0.05, 0.1].map(d => {
    const base = cfg.connector === 'hclip' ? cfg.hclip.clr :
      ['bowtie','puzzlekey','snap'].includes(cfg.connector)
        ? (cfg.keyMount === 'wall' ? cfg.keySlim.clr : cfg.key.clr)
      : cfg.connector === 'puzzle' ? cfg.puzzle.clr : cfg.tab.clr;
    return Math.max(0.02, base + d);
  });
  const tileW = 18, tileD = 8, gapX = 7, seamGap = 1.2;
  const polys = [];
  const rounded = (x0, y0, w, d) => {
    const r = 1.6, pts = [];
    const cs = [[x0+r, y0+r, 180], [x0+w-r, y0+r, 270], [x0+w-r, y0+d-r, 0], [x0+r, y0+d-r, 90]];
    for (const [ccx, ccy, a0] of cs)
      for (let k = 0; k <= 5; k++) {
        const a = (a0 + 90*k/5) * Math.PI/180;
        pts.push([ccx + r*Math.cos(a), ccy + r*Math.sin(a)]);
      }
    return pts;
  };
  clrs.forEach((clr, i) => {
    const x0 = i * (tileW + gapX);
    // pair: tile A below (y<0 side), tile B above; seam at y=0
    for (const side of [-1, 1]) {
      const y0 = side < 0 ? -seamGap/2 - tileD : seamGap/2;
      let tile = extrudePoly(rounded(x0, y0, tileW, tileD), 0, H);
      const edge = side < 0 ? '+y' : '-y';
      const e = side < 0 ? -seamGap/2 : seamGap/2;
      const s = x0 + tileW/2;
      let cuts = [];
      if (cfg.connector === 'snap' && cfg.keyInsert === 'top') {
        const prm = Object.assign({ legT: 1.0, legLen: 1.35, legC: 1.4, barb: 0.18,
                                    bridgeW: 1.7, bridgeD: 0.85, wall: 0.6 }, { clr });
        const { env } = snapTopParts(edge, e, s, prm, H);
        const g2 = (edge === '+x' || edge === '+y') ? -1 : 1;
        const ss2 = s + 0.0017;
        let rect = (edge === '+x' || edge === '-x')
          ? [[e + g2*env[0], ss2 + env[2]], [e + g2*env[1], ss2 + env[2]],
             [e + g2*env[1], ss2 + env[3]], [e + g2*env[0], ss2 + env[3]]]
          : [[ss2 + env[2], e + g2*env[0]], [ss2 + env[3], e + g2*env[0]],
             [ss2 + env[3], e + g2*env[1]], [ss2 + env[2], e + g2*env[1]]];
        const ar = rect.reduce((a2, p, i) => { const q = rect[(i+1)%4]; return a2 + p[0]*q[1] - q[0]*p[1]; }, 0);
        tile = clipConvexPrismTop(tile, ar > 0 ? rect : rect.slice().reverse(), env[4]);
        for (const p of snapTopPocket(edge, e, s, prm, H)) tile.push(p);
        cuts = [];
      } else if (cfg.connector === 'hclip') {
        cuts = cuts.concat(extrudePoly(
          keyHalf('snap', edge, e, s, hclipPrm(cfg.hclip), clr), -0.5, Math.min(2.3, H - 0.8)));
      } else if (['bowtie','puzzlekey','snap'].includes(cfg.connector)) {
        const kd = cfg.keyMount === 'wall' ? cfg.keySlim : cfg.key;
        cuts = cuts.concat(extrudePoly(
          keyHalf(cfg.connector, edge, e, s, kd, clr), -0.5, Math.min(kd.depth, H - 1.2)));
      } else if (cfg.connector === 'puzzle') {
        if (side > 0) cuts = cuts.concat(extrudePoly(
          puzzleShape(edge, e, s, cfg.puzzle, clr, true), -0.5, H - 1.2));
        else for (const p of extrudePoly(
          puzzleShape(edge, e, s, cfg.puzzle, 0, false), 0, Math.min(2.0, H - 1.4))) tile.push(p);
      } else {   // dovetail
        const t = cfg.tab;
        if (side > 0) {
          const nWr = t.wr + 2*clr, nWt = t.wt + 2*clr, nDp = t.dp + clr;
          const g = 1;
          cuts = cuts.concat(extrudePoly(
            [[s - nWr/2, e - 1], [s - nWt/2, e + nDp], [s + nWt/2, e + nDp], [s + nWr/2, e - 1]],
            -0.5, Math.min(t.h + 0.2, H - 0.8)));
        } else {
          for (const p of extrudePoly(tabFootprint('+y', e, s, t.wr, t.wt, t.dp, 0.6), 0, t.h))
            tile.push(p);
        }
      }
      if (cuts.length) tile = csgSubtract(tile, cuts);
      for (const p of clampZ(tile, 0)) polys.push(p);
    }
  });
  // one key alongside (keyed + hclip types)
  if (cfg.connector === 'snap' && cfg.keyInsert === 'top') {
    const prm = Object.assign({ legT: 1.0, legLen: 1.35, legC: 1.4, barb: 0.18,
                                bridgeW: 1.7, bridgeD: 0.85, wall: 0.6 }, { clr: cfg.key.clr });
    const clip = snapTopClip(prm, H);
    const kx = clrs.length * (tileW + gapX) + 4;
    for (const p of clip) polys.push({ verts: p.verts.map(v => [v[0] + kx, v[1], v[2]]), plane: p.plane });
    return { polys, clrs };
  }
  if (cfg.connector === 'hclip' || ['bowtie','puzzlekey','snap'].includes(cfg.connector)) {
    const kd = cfg.connector === 'hclip' ? hclipPrm(cfg.hclip) :
      (cfg.keyMount === 'wall' ? cfg.keySlim : cfg.key);
    const kh = cfg.connector === 'hclip' ? 2.15 : kd.depth - 0.15;
    const key = buildKey(cfg.connector === 'hclip' ? 'snap' : cfg.connector, kd, kh);
    const kx = clrs.length * (tileW + gapX) + 4;
    for (const p of key) polys.push({ verts: p.verts.map(v => [v[0] + kx, v[1], v[2]]), plane: p.plane });
  }
  return { polys, clrs };
}

// ---------- 3MF export ----------
/* items: [{name, polys, tx, ty, tz, rot}] rot in {0,90}. Returns {model, contentTypes, rels} XML strings. */
function build3mfXML(items) {
  let objs = '', builds = '';
  items.forEach((it, idx) => {
    const id = idx + 1;
    const vmap = new Map(); const verts = []; const tris = [];
    const key = (v) => (Math.round(v[0]*1000)/1000) + ',' + (Math.round(v[1]*1000)/1000) + ',' + (Math.round(v[2]*1000)/1000);
    const vidx = (v) => {
      const k = key(v);
      let i = vmap.get(k);
      if (i === undefined) { i = verts.length; vmap.set(k, i); verts.push(v); }
      return i;
    };
    for (const p of it.polys)
      for (let i = 2; i < p.verts.length; i++)
        tris.push([vidx(p.verts[0]), vidx(p.verts[i-1]), vidx(p.verts[i])]);
    objs += `<object id="${id}" type="model" name="${it.name}"><mesh><vertices>` +
      verts.map(v => `<vertex x="${v[0].toFixed(3)}" y="${v[1].toFixed(3)}" z="${v[2].toFixed(3)}"/>`).join('') +
      `</vertices><triangles>` +
      tris.map(t => `<triangle v1="${t[0]}" v2="${t[1]}" v3="${t[2]}"/>`).join('') +
      `</triangles></mesh></object>`;
    // row-major 4x3: rotation about z then translate
    const c = it.rot === 90 ? 0 : 1, s = it.rot === 90 ? 1 : 0;
    const T = `${c} ${s} 0 ${-s} ${c} 0 0 0 1 ${(it.tx||0).toFixed(3)} ${(it.ty||0).toFixed(3)} ${(it.tz||0).toFixed(3)}`;
    builds += `<item objectid="${id}" transform="${T}"/>`;
  });
  const model = `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">` +
    `<resources>${objs}</resources><build>${builds}</build></model>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Target="/3D/3dmodel.model" Id="rel0" ` +
    `Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`;
  return { model, contentTypes, rels };
}

// ---------- print-plate packing ----------
/* items: [{id, w, d, h, qty, stackable}] -> plates: [{items:[{id, x, y, rot, z}], used}]
   Shelf packing with rotation; stackable identical footprints pile up with zGap. */
function packPlates(items, bedW, bedD, gap, opts) {
  opts = opts || {};
  const zGap = opts.zGap || 0.24;
  const bedH = opts.bedH || 1e9;
  const stack = !!opts.stack;
  // expand qty into units
  const units = [];
  for (const it of items) {
    const q = it.qty || 1;
    for (let i = 0; i < q; i++)
      units.push({ id: it.id, w: it.w, d: it.d, h: it.h,
                   ids: it.ids ? [it.ids[Math.min(i, it.ids.length-1)]] : [it.id],
                   stackable: it.stackable !== false });
  }
  units.sort((a, b) => b.w * b.d - a.w * a.d);
  const plates = [];
  function tryShelf(pl, u) {
    for (const rot of [0, 90]) {
      const w = rot ? u.d : u.w, d = rot ? u.w : u.d;
      if (w > bedW || d > bedD || u.h > bedH) continue;
      for (const sh of pl.shelves) {
        if (d <= sh.h + 1e-6 && sh.x + w <= bedW + 1e-6) {
          const t = { id: u.ids[0], x: sh.x, y: sh.y, rot, w, d, z: 0, h: u.h, topW: w, topD: d, topZ: u.h };
          sh.x += w + gap;
          return t;
        }
      }
      const yTop = pl.shelves.length ? pl.shelves[pl.shelves.length-1].y + pl.shelves[pl.shelves.length-1].h + gap : 0;
      if (yTop + d <= bedD + 1e-6) {
        pl.shelves.push({ y: yTop, h: d, x: w + gap });
        return { id: u.ids[0], x: 0, y: yTop, rot, w, d, z: 0, h: u.h, topW: w, topD: d, topZ: u.h };
      }
    }
    return null;
  }
  function tryStack(pl, u) {
    if (!stack || !u.stackable) return null;
    // smallest tower top that still fits the piece (either rotation)
    let best = null;
    for (const base of pl.towers) {
      for (const rot of [0, 90]) {
        const w = rot ? u.d : u.w, d = rot ? u.w : u.d;
        if (w <= base.topW + 1e-6 && d <= base.topD + 1e-6 &&
            base.topZ + zGap + u.h <= bedH + 1e-6) {
          const waste = base.topW * base.topD - w * d;
          if (!best || waste < best.waste) best = { base, rot, w, d, waste };
        }
      }
    }
    if (!best) return null;
    const b = best.base;
    const t = { id: u.ids[0], x: b.x + (b.topW - best.w) / 2, y: b.y + (b.topD - best.d) / 2,
                rot: best.rot, w: best.w, d: best.d, z: b.topZ + zGap, h: u.h };
    b.topW = best.w; b.topD = best.d; b.topZ = t.z + u.h;
    return t;
  }
  for (const u of units) {
    let placed = null, host = null;
    for (const pl of plates) { placed = tryStack(pl, u); if (placed) { host = pl; break; } }
    if (!placed) for (const pl of plates) { placed = tryShelf(pl, u); if (placed) { host = pl; pl.towers.push(placed); break; } }
    if (!placed) {
      const pl = { shelves: [], towers: [], placed: [] };
      placed = tryShelf(pl, u);
      if (placed) { pl.towers.push(placed); plates.push(pl); host = pl; }
      else { plates.push({ shelves: [], towers: [], placed: [], overflow: u.id }); continue; }
    }
    host.placed.push(placed);
  }
  return plates;
}

// ---- split optimizer: choose cuts minimizing print plates ----
function compositions(n, maxPart, maxParts) {
  const out = [];
  function rec(rem, parts) {
    if (parts.length > maxParts) return;
    if (rem === 0) { if (parts.length) out.push(parts.slice()); return; }
    for (let p = Math.min(rem, maxPart); p >= 1; p--) { parts.push(p); rec(rem - p, parts); parts.pop(); }
  }
  rec(n, []);
  return out;
}
function optimizeForPlates(p) {
  // enumerate banded splits, pack each, keep the best
  const probe = computeLayout(Object.assign({}, p, { splitMode: 'balanced' }));
  const { nx, ny, mL, mR, mF, mB } = probe;
  const pitch = p.pitch;
  const extra = p.connector === 'dovetail' ? 2.5 : 0;
  const maxRows = Math.max(1, Math.floor((p.bedD - extra) / pitch));
  const maxCols = Math.max(1, Math.floor((p.bedW - extra) / pitch));
  const kRowMin = Math.ceil(ny / maxRows), kColMin = Math.ceil(nx / maxCols);
  const rowComps = compositions(ny, maxRows, Math.min(kRowMin + 1, 4))
    .filter(c => c.every((v, i) => v*pitch + extra + (i === 0 ? mF : 0) + (i === c.length-1 ? mB : 0) <= p.bedD + 1e-6));
  const colComps = compositions(nx, maxCols, Math.min(kColMin + 1, 4))
    .filter(c => c.every((v, i) => v*pitch + extra + (i === 0 ? mL : 0) + (i === c.length-1 ? mR : 0) <= p.bedW + 1e-6));
  let best = null, tried = 0;
  for (const rc of rowComps) {
    if (tried > 4000) break;
    const rowCuts = []; let acc = 0;
    for (let i = 0; i < rc.length - 1; i++) { acc += rc[i]; rowCuts.push(acc); }
    // per-band col comps: cap combination count
    const perBand = Math.max(1, Math.floor(Math.pow(400, 1 / rc.length)));
    const colSubset = colComps.slice(0, Math.max(perBand, 6));
    const idx = new Array(rc.length).fill(0);
    while (true) {
      tried++;
      if (tried > 4000) break;
      const colCuts = idx.map(i => {
        const cc = colSubset[i]; const cuts = []; let a2 = 0;
        for (let k = 0; k < cc.length - 1; k++) { a2 += cc[k]; cuts.push(a2); }
        return cuts;
      });
      const trial = Object.assign({}, p, { splitMode: 'manual', rowCuts, colCuts });
      const L = computeLayout(trial);
      const items = L.pieces.map(pc => ({
        id: pc.id, w: pc.mL + pc.nx*pitch + pc.mR + extra, d: pc.mF + pc.ny*pitch + pc.mB + extra,
        h: 4.25, qty: 1, stackable: false }));
      const fitsAll = items.every(it =>
        (it.w <= p.bedW && it.d <= p.bedD) || (it.d <= p.bedW && it.w <= p.bedD));
      if (fitsAll) {
        const plates = packPlates(items, p.bedW, p.bedD, 4, {});
        const minDim = Math.min(...L.pieces.map(pc => Math.min(pc.nx, pc.ny)));
        const score = [plates.length, L.pieces.length, -minDim];
        if (!best || score[0] < best.score[0] ||
            (score[0] === best.score[0] && (score[1] < best.score[1] ||
             (score[1] === best.score[1] && score[2] < best.score[2])))) {
          best = { rowCuts: rowCuts.slice(), colCuts: colCuts.map(c => c.slice()), score, plates: plates.length };
        }
      }
      // advance mixed-radix index
      let d = idx.length - 1;
      while (d >= 0) { idx[d]++; if (idx[d] < colSubset.length) break; idx[d] = 0; d--; }
      if (d < 0) break;
    }
  }
  return best;   // {rowCuts, colCuts, plates} or null
}

// transform polys for merged plate export// transform polys for merged plate export
function transformPolys(polys, tx, ty, tz, rot) {
  const c = rot === 90 ? 0 : 1, s = rot === 90 ? 1 : 0;
  return polys.map(p => ({
    verts: p.verts.map(v => [c*v[0] - s*v[1] + tx, s*v[0] + c*v[1] + ty, v[2] + tz]),
    plane: p.plane,
  }));
}

const DEFAULTS = {
  drawerW: 306, drawerD: 380, pitch: 42,
  alignX: 'center', alignY: 'center', marginMode: 'auto',
  mLeft: 0, mRight: 0, mFront: 0, mBack: 0,
  bedW: 256, bedD: 256,
  plateHeight: 4.25, topCutoff: 0.4, bottomPad: 0,
  socketRadius: 4.0, outerRadius: 4.0, tolerance: 'standard',
  connector: 'dovetail',
  splitMode: 'balanced', rowCuts: null, colCuts: null,
  bowtie: { len: 14, wEnd: 8, wWaist: 5, depth: 2.0, clr: 0.15 },
  key: { len: 14, wEnd: 8, wWaist: 5, wMid: 6.5, endLen: 4, waistW: 4.5, lobeR: 4.2, depth: 2.0, clr: 0.15 },
  keySlim: { len: 13, wEnd: 3.8, wWaist: 2.4, wMid: 3.0, endLen: 3.5, waistW: 2.0, lobeR: 1.85, depth: 2.0, clr: 0.12 },
  keyType: 'bowtie', keyMount: 'floor', keyInsert: 'bottom',
  hclip: { waistL: 1.3, waistW: 1.8, flangeT: 0.9, flangeW: 3.8, clr: 0.15 },
  puzzle: { neckW: 6, neckL: 1.6, lobeR: 4.6, clr: 0.2 },
  baseMode: 'solid', cornerRadii: null,
  magnetBase: 2.8,
  tab: { wr: 8, wt: 11, dp: 1.9, h: 2.2, clr: 0.2 },
  magnets: false, magnetD: 6, magnetH: 2, magnetSide: 'bottom',
  screws: false, screwHoleD: 3, screwHeadD: 6, screwHeadDepth: 2,
  holeOffset: 13, arcSegs: 6,
};

if (typeof module !== 'undefined') {
  module.exports = { computeLayout, pieceConnectors, buildPiece, buildTestTile, buildFitSample, bowtieKey, keyOutline, buildKey, puzzleShape, keyHalf, hclipPrm, snapTopClip, snapTopParts, build3mfXML, packPlates, optimizeForPlates, transformPolys, stlBinary, checkManifold, DEFAULTS, csgSubtract, csgUnion, extrudePoly, socketCutter, polysToTriangles,
    // shared mesh primitives — also used by the bins tool
    makePoly, triangulateRing, earTriangulate, roundedSquareRing, clampZ };
}

