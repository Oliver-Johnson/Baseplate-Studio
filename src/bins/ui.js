/* Drawerforge Bins UI. Core geometry and buildBin are in scope from the previous
   script tags (both end with a module.exports guard, so in the browser their
   functions land as globals). */
'use strict';

const $ = (id) => document.getElementById(id);
const SVGNS = 'http://www.w3.org/2000/svg';

const G = {
  makePoly, triangulateRing, extrudePoly, clampZ, profilePrism, polyArea2D,
  polysToTriangles, stlBinary, checkManifold,
};
// In Node the audits pass the whole core module; in the browser this object is
// assembled by hand, so the two surfaces can drift. Fail loudly at load rather
// than at the first bin that happens to need the missing one.
for (const fn of REQUIRED_CORE)
  if (typeof G[fn] !== 'function')
    throw new Error(`bins UI is missing core function ${fn}() — add it to G in src/bins/ui.js`);

const PLA_DENSITY = 1.24;   // g/cm3
const S = 40;               // map cell size, svg units

const state = {};           // drawer + defaults for new bins
let layers = [{ bins: [] }];
let cur = 0;                // layer being edited, 0 = sitting on the baseplate
let selected = -1;          // the primary selection: what resize and move act on
/* Carving was alt-click only, which meant the feature may as well not have existed:
   the sole mention was a line of grey help text, while merge — the other route to the
   same shapes — had a button. This is that button. Alt-click still works. */
let carving = false;
let selExtra = new Set();   // ctrl-clicked companions, edited together with it
let hashExtras = {};
let pendingNotes = null;
const geoCache = new Map();

const B = () => layers[cur].bins;
// every selected index, primary first, filtered to bins that still exist
const selAll = () => (selected < 0 ? []
  : [selected, ...selExtra].filter((v, i, a) => a.indexOf(v) === i && B()[v]));
const clearSel = () => { selected = -1; selExtra.clear(); };
const LIP_H = lipHeight(0.55);

/* ---------- model --------------------------------------------------------- */
function grid() {
  const nx = Math.max(1, Math.floor(state.drawerW / SPEC.pitch));
  const ny = Math.max(1, Math.floor(state.drawerD / SPEC.pitch));
  const avail = state.drawerH - state.plateH;
  return { nx, ny, avail, maxUnits: Math.max(1, Math.floor((avail - LIP_H) / SPEC.unitH)) };
}
const EDGES = ['f', 'b', 'l', 'r'];
const binCfg = (b) => ({ u: b.u, v: b.v, hUnits: b.hUnits, wall: b.wall,
                         floorT: b.floorT, divX: b.divX, divY: b.divY,
                         solid: b.solid, edges: b.edges, base: b.base,
                         scoop: b.scoop, label: b.label, cells: b.cells,
                         arcSegs: state.arcSegs });
const edgeSig = (b) => EDGES.map((k) => (b.edges && b.edges[k] !== undefined ? b.edges[k] : 1)).join(',');
const allFullEdges = (b) => EDGES.every((k) => !b.edges || b.edges[k] === undefined || b.edges[k] >= 1);
const typeKey = (b) => `${b.u}x${b.v}x${b.hUnits}` +
  (b.solid ? '-solid' : `-w${b.wall}-f${b.floorT}` +
   (b.divX || b.divY ? `-d${b.divX}.${b.divY}` : '') +
   (allFullEdges(b) ? '' : `-e${edgeSig(b)}`)) +
  ((b.base && b.base !== 'standard') ? `-${b.base}` : '') +
  (b.scoop ? `-s${b.scoop}` : '') + (b.label ? `-L${b.label}` : '') +
  (b.cells ? `-c${maskBits(b)}` : '');

function occupancyOf(k) {
  const g = grid();
  const occ = Array.from({ length: g.ny }, () => new Array(g.nx).fill(-1));
  (layers[k] ? layers[k].bins : []).forEach((b, i) => {
    for (const [dx, dy] of binCells(b)) {
      const x = b.x + dx, y = b.y + dy;
      if (y >= 0 && y < g.ny && x >= 0 && x < g.nx) occ[y][x] = i;
    }
  });
  return occ;
}
const occupancy = () => occupancyOf(cur);

/* Per-cell top surface available to layer k, and whether the stack below is
   continuous. A bin can only sit where every layer beneath it has one. */
function support(k) {
  const g = grid();
  const top = Array.from({ length: g.ny }, () => new Array(g.nx).fill(0));
  const ok = Array.from({ length: g.ny }, () => new Array(g.nx).fill(true));
  for (let L = 0; L < k; L++) {
    const occ = occupancyOf(L);
    for (let y = 0; y < g.ny; y++)
      for (let x = 0; x < g.nx; x++) {
        const i = occ[y][x];
        if (i === -1) ok[y][x] = false;
        else top[y][x] += layers[L].bins[i].hUnits * SPEC.unitH;
      }
  }
  return { top, ok };
}
// z of a bin's base, and whether its support is sound
function seat(b, k) {
  const s = support(k);
  let z = null, flat = true, solidBelow = true;
  for (let dy = 0; dy < b.v; dy++)
    for (let dx = 0; dx < b.u; dx++) {
      const y = b.y + dy, x = b.x + dx;
      if (!s.ok[y] || !s.ok[y][x]) { solidBelow = false; continue; }
      const t = s.top[y][x];
      if (z === null) z = t; else if (Math.abs(t - z) > 0.001) flat = false;
    }
  return { z: z === null ? 0 : z, flat, solidBelow };
}
function canPlace(x, y, u, v, ignore) {
  const g = grid();
  if (x < 0 || y < 0 || x + u > g.nx || y + v > g.ny) return false;
  const occ = occupancy();
  for (let dy = 0; dy < v; dy++)
    for (let dx = 0; dx < u; dx++) {
      const o = occ[y + dy][x + dx];
      if (o !== -1 && o !== ignore) return false;
    }
  return true;
}
// same test for a bin that may be carved: only its kept cells need to be free
function canPlaceBin(b, x, y, ignore) {
  const g = grid(), occ = occupancy();
  for (const [dx, dy] of binCells(b)) {
    const px = x + dx, py = y + dy;
    if (px < 0 || py < 0 || px >= g.nx || py >= g.ny) return false;
    const o = occ[py][px];
    if (o !== -1 && o !== ignore) return false;
  }
  return true;
}
/* Occupied offsets within a bin's own bounding box. The clip is the invariant that
   holds everything together: a bin can never occupy a cell outside its own box. A
   resize used to leave the old mask in place, and those out-of-box cells drew nothing
   on the map yet still blocked other bins from being dropped there and still built in
   the preview — a bin you could neither see nor get rid of. */
function binCells(b) {
  if (b.cells && b.cells.length) {
    const kept = b.cells.filter(([x, y]) => x >= 0 && y >= 0 && x < b.u && y < b.v);
    if (kept.length) return kept;
  }
  const out = [];
  for (let x = 0; x < b.u; x++) for (let y = 0; y < b.v; y++) out.push([x, y]);
  return out;
}
const isCarved = (b) => binCells(b).length < b.u * b.v;

/* The one way to change a footprint. Resizing a carved bin has to reconcile the mask,
   and what carries across is the HOLES rather than the kept cells: clip the kept cells
   and growing a bin leaves its new column empty, which is not what dragging a grip
   outwards means. Carrying the holes grows and shrinks an L the way you would expect,
   and a shape whose holes swallow the whole new box falls back to a plain rectangle. */
function setFootprint(b, nu, nv) {
  if (b.cells && b.cells.length) {
    const kept = new Set(binCells(b).map((c) => c[0] + ',' + c[1]));
    const holes = new Set();
    for (let x = 0; x < b.u; x++) for (let y = 0; y < b.v; y++)
      if (!kept.has(x + ',' + y)) holes.add(x + ',' + y);
    const next = [];
    for (let x = 0; x < nu; x++) for (let y = 0; y < nv; y++)
      if (!holes.has(x + ',' + y)) next.push([x, y]);
    b.cells = next.length && next.length < nu * nv ? next : null;
  }
  b.u = nu; b.v = nv;
}
const allBins = () => layers.flatMap((L, k) => L.bins.map((b) => ({ b, k })));

/* ---------- geometry + volume --------------------------------------------- */
function geomFor(b) {
  const k = typeKey(b) + '-s' + state.arcSegs;
  if (geoCache.has(k)) return geoCache.get(k);
  const r = buildBin(G, binCfg(b));
  const vv = volumeMm3(b);
  r.vol = vv.filament; r.rawVol = vv.raw;
  geoCache.set(k, r);
  return r;
}
function areaRR(hw, hd, r) { return 4 * hw * hd - (4 - Math.PI) * r * r; }
function perimRR(hw, hd, r) { return 4 * hw + 4 * hd - 8 * r + 2 * Math.PI * r; }

/* Material estimate.
 *
 * Raw mesh volume is NOT what a printer uses. Thin features (walls, floor,
 * dividers, lip) come out solid because they are only a few perimeters wide, but
 * the feet are thick blocks that the slicer shells and then infills — and on a
 * shallow bin the feet dominate. So thin parts are counted at full density and
 * the base block is counted as shell + infill x core.
 *
 * Assumes 2 perimeters (0.8 mm) and 4 solid top/bottom layers (0.8 mm), which is
 * a common default. Geometry is unaffected either way.
 */
const SHELL_T = 0.8, SKIN_T = 0.8;

function footProfileHalf(z) {
  let h = SPEC.prof[SPEC.prof.length - 1][1];
  for (let q = 0; q < SPEC.prof.length - 1; q++) {
    const [z0, h0] = SPEC.prof[q], [z1, h1] = SPEC.prof[q + 1];
    if (z >= z0 && z <= z1) { h = h0 + (h1 - h0) * (z1 > z0 ? (z - z0) / (z1 - z0) : 0); break; }
  }
  return h;
}

// { raw, filament } in mm3
function volumeMm3(c) {
  const C = SPEC.centre;
  const hwO = (c.u - 1) * SPEC.pitch / 2 + SPEC.half;
  const hdO = (c.v - 1) * SPEC.pitch / 2 + SPEC.half;
  const H = c.hUnits * SPEC.unitH, floorZ = SPEC.footH + c.floorT;
  // a carved bin has fewer feet and less floor than its bounding box implies
  const cells = binCells(c).length;
  const infill = Math.max(0, Math.min(1, (state.infill === undefined ? 15 : state.infill) / 100));

  /* base block: the feet plus the solid floor slab above them */
  let footV = 0, footLat = 0;
  const N = 60;
  for (let i = 0; i < N; i++) {
    const h = footProfileHalf(SPEC.footH * (i + 0.5) / N);
    footV += areaRR(h, h, h - C) * (SPEC.footH / N);
    footLat += perimRR(h, h, h - C) * (SPEC.footH / N);
  }
  footV *= cells; footLat *= cells;
  const slabH = (c.solid || floorZ >= H - 0.2) ? (H - SPEC.footH) : c.floorT;
  const baseRaw = footV + areaRR(hwO, hdO, SPEC.r) * slabH;
  const baseLat = footLat + perimRR(hwO, hdO, SPEC.r) * slabH;
  const botA = cells * areaRR(SPEC.prof[0][1], SPEC.prof[0][1], SPEC.prof[0][1] - C);
  const baseShell = baseLat * SHELL_T + (botA + areaRR(hwO, hdO, SPEC.r)) * SKIN_T;
  const baseFil = Math.min(baseRaw, baseShell + infill * Math.max(0, baseRaw - baseShell));

  if (c.solid || floorZ >= H - 0.2) return { raw: baseRaw, filament: baseFil };

  /* thin parts — solid whatever the infill setting */
  const e = (k) => (c.edges && c.edges[k] !== undefined ? Math.max(0, Math.min(1, c.edges[k])) : 1);
  const hwI = hwO - c.wall, hdI = hdO - c.wall;
  const wallsFull = (areaRR(hwO, hdO, SPEC.r) - areaRR(hwI, hdI, Math.max(0.4, SPEC.r - c.wall)))
                    * (H - floorZ);
  const perim = 4 * hwO + 4 * hdO;
  const wallFrac = (e('f') * 2 * hwO + e('b') * 2 * hwO + e('l') * 2 * hdO + e('r') * 2 * hdO) / perim;
  const divs = (c.divX * c.wall * 2 * hdI + c.divY * c.wall * 2 * hwI) * (H - floorZ);
  const lipV = allFullEdges(c) ? areaRR(hwO, hdO, SPEC.r) * 0.35 * LIP_H / 1.9 : 0;
  const thin = wallsFull * wallFrac + divs + lipV;
  return { raw: baseRaw + thin, filament: baseFil + thin };
}

/* ---------- controls ------------------------------------------------------ */
function readControls() {
  const num = (id, d) => { const x = parseFloat($(id).value); return isFinite(x) ? x : d; };
  const int = (id, d) => { const x = parseInt($(id).value, 10); return isFinite(x) ? x : d; };
  state.drawerW = num('drawerW', 306);
  state.drawerD = num('drawerD', 380);
  state.drawerH = num('drawerH', 84);
  state.plateH = num('plateH', 4.25);
  state.arcSegs = int('arcSegs', 12);
  state.infill = num('infill', 15);
  state.bedW = num('bedW', 256);
  state.bedD = num('bedD', 256);
  state.bedH = num('bedH', 256);
  state.gap = num('gap', 3);

  const t = {
    u: Math.max(1, int('u', 1)), v: Math.max(1, int('v', 1)),
    hUnits: Math.max(1, int('hUnits', 3)),
    wall: num('wall', 1.2), floorT: num('floorT', 1.2),
    divX: Math.max(0, int('divX', 0)), divY: Math.max(0, int('divY', 0)),
    solid: $('solid').checked,
    base: $('baseStyle').value,
    scoop: Math.max(0, num('scoop', 0)), label: Math.max(0, num('label', 0)),
    note: $('note').value.slice(0, 28),
    edges: { f: parseFloat($('edgeF').value), b: parseFloat($('edgeB').value),
             l: parseFloat($('edgeL').value), r: parseFloat($('edgeR').value) },
  };
  const sel = selAll();
  if (sel.length) {
    // size only applies to a single bin; several at once would have to overlap
    const b = B()[selected];
    if (sel.length > 1) {
      /* Footprint is per bin and must never be bulk-assigned. Writing the primary's
         size onto the others silently resized every bin in the selection to match it,
         which quietly destroyed their shapes. */
      delete t.u; delete t.v;
      $('u').value = b.u; $('v').value = b.v;
    } else if ((t.u !== b.u || t.v !== b.v) && !canPlace(b.x, b.y, t.u, t.v, selected)) {
      t.u = b.u; t.v = b.v; $('u').value = b.u; $('v').value = b.v;
    }
    /* u and v never ride the bulk assign — a footprint change has to reconcile the
       carve mask, so it goes through setFootprint. */
    const nu = t.u, nv = t.v; delete t.u; delete t.v;
    for (const i of sel) Object.assign(B()[i], t, { edges: Object.assign({}, t.edges) });
    if (sel.length === 1 && nu !== undefined && (nu !== b.u || nv !== b.v))
      setFootprint(b, nu, nv);
  } else {
    Object.assign(state, t);
  }
  $('thickRow').style.display = t.solid ? 'none' : '';
  $('divRow').style.display = t.solid ? 'none' : '';
  $('edgeRowA').style.display = t.solid ? 'none' : '';
  $('edgeRowB').style.display = t.solid ? 'none' : '';
  $('edgeHint').style.display = t.solid ? 'none' : '';
  $('featureRow').style.display = t.solid ? 'none' : '';
  $('featureHint').style.display = t.solid ? 'none' : '';
  $('presetTray').style.display = t.solid ? 'none' : '';
  $('selActions').style.display = selected >= 0 ? '' : 'none';
  $('sizeRow').style.display = selAll().length > 1 ? 'none' : '';
  const one = selAll().length === 1;
  if (!one) carving = false;
  $('carveMode').style.display = one ? '' : 'none';
  $('carveHint').style.display = one && carving ? '' : 'none';
  $('carveMode').classList.toggle('on', carving);
  $('fillmap').classList.toggle('carving', carving);
  $('carveMode').textContent = carving ? 'Done carving' : 'Carve this bin into a shape';
  $('mergeBins').style.display = selAll().length > 1 ? '' : 'none';
  $('mergeHint').style.display = selAll().length > 1 ? '' : 'none';
  const selBin = selected >= 0 ? B()[selected] : null;
  const needsSplit = !!selBin && !fitsBed(selBin.u, selBin.v) && !!splitPlan(selBin.u, selBin.v);
  $('splitFit').style.display = needsSplit ? '' : 'none';
  $('splitHint').style.display = needsSplit ? '' : 'none';
  if (needsSplit) {
    const sp = describeSplit(selBin.u, selBin.v);
    $('splitFit').textContent = `Split into ${sp.text} to fit the bed`;
  }
  const nSel = selAll().length;
  $('binPanelTitle').textContent = nSel > 1 ? `${nSel} bins selected`
    : nSel === 1 ? 'Selected bin' : 'New bins';
  $('fillSize').textContent = `${state.u}×${state.v}`;
  $('delLayer').style.display = layers.length > 1 ? '' : 'none';
}
function writeControls(src) {
  $('u').value = src.u; $('v').value = src.v; $('hUnits').value = src.hUnits;
  $('wall').value = src.wall; $('floorT').value = src.floorT;
  $('divX').value = src.divX; $('divY').value = src.divY;
  $('solid').checked = !!src.solid;
  $('baseStyle').value = src.base || 'standard';
  $('scoop').value = src.scoop || 0; $('label').value = src.label || 0;
  $('note').value = src.note || '';
  for (const [k, id] of [['f', 'edgeF'], ['b', 'edgeB'], ['l', 'edgeL'], ['r', 'edgeR']])
    $(id).value = String(src.edges && src.edges[k] !== undefined ? src.edges[k] : 1);
}

/* ---------- layers -------------------------------------------------------- */
function drawLayerTabs() {
  const bar = $('layerTabs');
  bar.innerHTML = '';
  layers.forEach((L, i) => {
    const b = document.createElement('button');
    b.textContent = `Layer ${i + 1}` + (L.bins.length ? ` · ${L.bins.length}` : '');
    if (i === cur) b.className = 'on';
    b.addEventListener('click', () => {
      cur = i; clearSel(); readControls(); drawLayerTabs(); drawMap(); refresh();
    });
    bar.appendChild(b);
  });
}
$('addLayer').addEventListener('click', () => {
  pushUndo();
  layers.push({ bins: [] });
  cur = layers.length - 1; clearSel();
  readControls(); drawLayerTabs(); drawMap(); refresh();
});
$('delLayer').addEventListener('click', () => {
  if (layers.length < 2) return;
  pushUndo();
  layers.splice(cur, 1);
  cur = Math.min(cur, layers.length - 1); clearSel();
  readControls(); drawLayerTabs(); drawMap(); refresh();
});

/* ---------- the map ------------------------------------------------------- */
let drag = null;
function drawMap() {
  const g = grid(), svg = $('fillmap');
  const W = g.nx * S, H = g.ny * S;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  /* Pair the map with the 3D view only when the grid is portrait or square. A wide
     drawer's map wants the full stage width, and halving it to sit beside the preview
     would make the thing you actually work in smaller — the opposite of the point. */
  const top = document.querySelector('.stagetop');
  const wide = g.nx / g.ny > 1.15;
  if (top) top.classList.toggle('wide', wide);

  /* Size from the STAGE, never from the map's own container. The column width is set
     from the map below, so measuring the container here would make each depend on the
     other — which froze a square grid at its previous size and collapsed a wide one.
     The stage does not depend on the map, so it breaks the loop.

     Cells get a comfortable fixed size rather than filling whatever room exists;
     available space is a ceiling, not a target. */
  const CELL_PX = 52, PREVIEW_MIN = 320;
  const stage = document.querySelector('.stage');
  const stageW = (stage ? stage.clientWidth : 900) - 44;
  const availW = Math.max(180, wide ? stageW : stageW - PREVIEW_MIN - 44);
  const availH = Math.min(720, (window.innerHeight || 900) * 0.66);
  const sc = Math.min(availW / W, availH / H, CELL_PX / S);
  svg.setAttribute('width', Math.round(W * sc));
  svg.setAttribute('height', Math.round(H * sc));
  if (top) top.style.gridTemplateColumns = wide
    ? '' : `${Math.round(W * sc) + 30}px minmax(${PREVIEW_MIN}px, 1fr)`;

  while (svg.firstChild) svg.removeChild(svg.firstChild);
  const el = (n, a) => { const e = document.createElementNS(SVGNS, n);
    for (const k in a) e.setAttribute(k, a[k]); return e; };
  const sy = (y, v) => (g.ny - y - v) * S;

  const occ = occupancy();
  const sup = support(cur);
  for (let y = 0; y < g.ny; y++)
    for (let x = 0; x < g.nx; x++) {
      const free = occ[y][x] === -1;
      const dead = cur > 0 && !sup.ok[y][x];
      const c = el('rect', { class: 'cell' + (free && !dead ? ' free' : '') + (dead ? ' dead' : ''),
        x: x * S, y: sy(y, 1), width: S, height: S });
      svg.appendChild(c);
    }

  // ghost the layer below so you can line bins up with what supports them
  if (cur > 0)
    for (const b of layers[cur - 1].bins)
      svg.appendChild(el('rect', { class: 'ghostbin', x: b.x * S + 3, y: sy(b.y, b.v) + 3,
        width: b.u * S - 6, height: b.v * S - 6, rx: 5 }));

  B().forEach((b, i) => {
    const issues = binIssues(b, cur).filter((x) => typeof x === 'string' || !x.note);
    const cls = 'bin' + (selAll().includes(i) ? ' sel' : '') + (issues.length ? ' clash' : '');
    const cells = binCells(b);
    const held = new Set(cells.map(([dx, dy]) => dx + ',' + dy));
    let r = null;
    if (!isCarved(b)) {
      r = el('rect', { class: cls, x: b.x * S + 2, y: sy(b.y, b.v) + 2,
                       width: b.u * S - 4, height: b.v * S - 4, rx: 5 });
      r.dataset.i = i; svg.appendChild(r);
    } else {
      /* A carved bin is drawn cell by cell with the border on exposed edges only,
         so it reads as one shape rather than a row of tiles. */
      for (const [dx, dy] of cells) {
        const c = el('rect', { class: cls + ' cellpart',
          x: (b.x + dx) * S + 1, y: sy(b.y + dy, 1) - 1, width: S - 2, height: S - 2 });
        c.dataset.i = i; svg.appendChild(c);
        if (!r) r = c;
      }
      for (const [dx, dy] of cells) {
        const px = (b.x + dx) * S, py = sy(b.y + dy, 1);
        const line = (x1, y1, x2, y2) => svg.appendChild(
          el('line', { class: 'binedge', x1, y1, x2, y2 }));
        if (!held.has((dx - 1) + ',' + dy)) line(px + 1, py - 1, px + 1, py + S - 1);
        if (!held.has((dx + 1) + ',' + dy)) line(px + S - 1, py - 1, px + S - 1, py + S - 1);
        if (!held.has(dx + ',' + (dy - 1))) line(px + 1, py + S - 1, px + S - 1, py + S - 1);
        if (!held.has(dx + ',' + (dy + 1))) line(px + 1, py - 1, px + S - 1, py - 1);
      }
    }
    const cx = (b.x + b.u / 2) * S, cy = sy(b.y, b.v) + b.v * S / 2;
    const t1 = el('text', { class: 'blabel', x: cx, y: cy - 2, 'text-anchor': 'middle' });
    t1.textContent = `${b.u}×${b.v}`;
    const t2 = el('text', { class: 'bsub', x: cx, y: cy + 12, 'text-anchor': 'middle' });
    t2.textContent = `${b.hUnits}u · ${b.hUnits * SPEC.unitH}mm`;
    svg.appendChild(t1); svg.appendChild(t2);
    // hovering a bin says what you decided goes in it
    const tip = document.createElementNS(SVGNS, 'title');
    tip.textContent = (b.note ? b.note + ' — ' : '') +
      `${b.u}×${b.v}, ${b.hUnits} units (${b.hUnits * SPEC.unitH} mm)`;
    r.appendChild(tip);
    if (b.note) {
      const t3 = el('text', { class: 'bnote', x: cx, y: cy + 25, 'text-anchor': 'middle' });
      t3.textContent = b.note.length > b.u * 7 ? b.note.slice(0, b.u * 7 - 1) + '…' : b.note;
      svg.appendChild(t3);
    }
    if (issues.length) {
      const warn = el('text', { class: 'bwarn', x: b.x * S + 13, y: sy(b.y, b.v) + 20 });
      warn.textContent = '⚠';
      const tip = document.createElementNS(SVGNS, 'title');
      tip.textContent = issues.join('; ');
      warn.appendChild(tip);
      svg.appendChild(warn);
    }
    if (i === selected && selAll().length === 1)   // grips need one bin, not several
      for (const [hx, hy, key] of [[b.x, b.y, 'lf'], [b.x + b.u, b.y, 'rf'],
                                   [b.x, b.y + b.v, 'lb'], [b.x + b.u, b.y + b.v, 'rb']]) {
        const h = el('rect', { class: 'grip', x: hx * S - 6, y: (g.ny - hy) * S - 6,
                               width: 12, height: 12, rx: 3 });
        h.dataset.handle = key;
        svg.appendChild(h);
      }
  });

  /* Only a create drag has an anchor to rubber-band from. Drawing this for a resize
     or a move read x0/y0 off a drag that never set them, so every attribute came out
     NaN and the browser rejected the rect four times a frame. */
  if (drag && drag.mode === 'create') {
    const x = Math.min(drag.x0, drag.x1), y = Math.min(drag.y0, drag.y1);
    const u = Math.abs(drag.x1 - drag.x0) + 1, v = Math.abs(drag.y1 - drag.y0) + 1;
    svg.appendChild(el('rect', { class: 'drag' + (canPlace(x, y, u, v, -1) ? '' : ' bad'),
      x: x * S + 1, y: sy(y, v) + 1, width: u * S - 2, height: v * S - 2, rx: 5 }));
  }
}
/* Screen point -> grid cell.
   Goes through the SVG's own screen matrix rather than measuring the element box.
   preserveAspectRatio letterboxes the drawing inside that box whenever the element's
   aspect ratio differs from the viewBox's, so box-relative arithmetic is off by the
   dead margin — and the margin changes as the element resizes. getScreenCTM accounts
   for the viewBox, the letterboxing, page zoom and scroll together. */
function cellFromEvent(e) {
  const g = grid(), svg = $('fillmap');
  const m = svg.getScreenCTM && svg.getScreenCTM();
  let vx, vy;
  if (m) {
    const p = svg.createSVGPoint ? svg.createSVGPoint() : new DOMPoint();
    p.x = e.clientX; p.y = e.clientY;
    const loc = p.matrixTransform(m.inverse());
    vx = loc.x; vy = loc.y;
  } else {                                    // detached or display:none
    const r = svg.getBoundingClientRect();
    vx = (e.clientX - r.left) / (r.width || 1) * g.nx * S;
    vy = (e.clientY - r.top) / (r.height || 1) * g.ny * S;
  }
  return { x: Math.max(0, Math.min(g.nx - 1, Math.floor(vx / S))),
           y: Math.max(0, Math.min(g.ny - 1, g.ny - 1 - Math.floor(vy / S))) };
}
function initMap() {
  const svg = $('fillmap');
  svg.addEventListener('pointerdown', (e) => {
    const c = cellFromEvent(e);
    const handle = e.target && e.target.dataset ? e.target.dataset.handle : null;

    /* Grips sit on the bin's corners, which is exactly where you click to carve an
       L. While carving they have to yield, or the one cell you most want to remove
       is the one cell you cannot. */
    if (handle && !e.altKey && !carving && selected >= 0 && B()[selected]) {
      const b = B()[selected];
      pushUndo();
      drag = { mode: 'resize', idx: selected,
               ax: handle[0] === 'l' ? b.x + b.u - 1 : b.x,
               ay: handle[1] === 'f' ? b.y + b.v - 1 : b.y,
               x1: c.x, y1: c.y };
      if (svg.setPointerCapture) svg.setPointerCapture(e.pointerId);
      return;
    }

    /* Alt-click carves. Inside the selected bin it removes a cell; on a cell the bin
       once covered it puts one back, so a carve can be undone by the same gesture. */
    if ((e.altKey || carving) && selected >= 0 && B()[selected]) {
      const b = B()[selected];
      const dx = c.x - b.x, dy = c.y - b.y;
      if (dx >= 0 && dy >= 0 && dx < b.u && dy < b.v) {
        const cells = binCells(b).slice();
        const at = cells.findIndex(([a, o]) => a === dx && o === dy);
        if (at >= 0) {
          if (cells.length > 1) { pushUndo(); cells.splice(at, 1); b.cells = cells; }
        } else if (canPlace(c.x, c.y, 1, 1, selected)) {
          pushUndo(); cells.push([dx, dy]);
          b.cells = cells.length === b.u * b.v ? null : cells;
        }
        readControls(); drawMap(); refresh();
        return;
      }
      /* Outside the bin. Alt is a deliberate modifier, so it swallows the click either
         way; a plain click in carve mode must stay a click, or the mode traps you with
         no way to select anything else. Clicking away simply leaves the mode. */
      if (e.altKey) return;
      carving = false;
    }
    const hit = occupancy()[c.y][c.x];
    if (hit !== -1) {
      if (e.ctrlKey || e.metaKey) {                      // add or remove from the set
        if (hit === selected) {                          // dropping the primary promotes another
          const rest = [...selExtra]; selExtra.delete(rest[0]);
          selected = rest.length ? rest[0] : -1;
        } else if (selExtra.has(hit)) selExtra.delete(hit);
        else if (selected < 0) selected = hit;
        else selExtra.add(hit);
        if (selected >= 0) writeControls(B()[selected]);
        readControls(); drawMap(); refresh();
        return;
      }
      const b = B()[hit];                                // grab to move; a still
      selExtra.clear();                                  // release is just a select
      selected = hit;
      writeControls(b);
      pushUndo();
      drag = { mode: 'move', idx: hit, dx: c.x - b.x, dy: c.y - b.y, moved: false };
      if (svg.setPointerCapture) svg.setPointerCapture(e.pointerId);
      readControls(); drawMap(); refresh();
      return;
    }

    clearSel();                                          // draw a new bin
    drag = { mode: 'create', x0: c.x, y0: c.y, x1: c.x, y1: c.y };
    if (svg.setPointerCapture) svg.setPointerCapture(e.pointerId);
    readControls(); drawMap();
  });

  svg.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const c = cellFromEvent(e);

    if (drag.mode === 'create') {
      if (c.x === drag.x1 && c.y === drag.y1) return;
      drag.x1 = c.x; drag.y1 = c.y; drawMap();
      return;
    }
    const b = B()[drag.idx];
    if (!b) return;

    if (drag.mode === 'move') {
      const nx = c.x - drag.dx, ny = c.y - drag.dy;
      if (nx === b.x && ny === b.y) return;
      if (!canPlace(nx, ny, b.u, b.v, drag.idx)) return;  // refuse, don't snap away
      b.x = nx; b.y = ny; drag.moved = true;
      drawMap();
      return;
    }
    // resize: the opposite corner stays put, this one follows the pointer
    const nx = Math.min(c.x, drag.ax), ny = Math.min(c.y, drag.ay);
    const nu = Math.abs(c.x - drag.ax) + 1, nv = Math.abs(c.y - drag.ay) + 1;
    if (nx === b.x && ny === b.y && nu === b.u && nv === b.v) return;
    if (!canPlace(nx, ny, nu, nv, drag.idx)) return;
    b.x = nx; b.y = ny; setFootprint(b, nu, nv);
    drag.moved = true;
    writeControls(b); drawMap();
  });

  svg.addEventListener('pointerup', () => {
    if (!drag) return;
    if (drag.mode === 'create') {
      const x = Math.min(drag.x0, drag.x1), y = Math.min(drag.y0, drag.y1);
      const u = Math.abs(drag.x1 - drag.x0) + 1, v = Math.abs(drag.y1 - drag.y0) + 1;
      if (canPlace(x, y, u, v, -1)) {
        B().push({ x, y, u, v, hUnits: state.hUnits, wall: state.wall,
                   floorT: state.floorT, divX: state.divX, divY: state.divY,
                   solid: state.solid, base: state.base, scoop: state.scoop, label: state.label,
                   note: '',
                   edges: Object.assign({}, state.edges) });
        selected = B().length - 1;
        writeControls(B()[selected]);
      }
    }
    drag = null;
    readControls(); drawLayerTabs(); drawMap(); refresh();
  });
  svg.addEventListener('pointercancel', () => { drag = null; drawMap(); refresh(); });
}

/* ---------- actions ------------------------------------------------------- */
$('fillRest').addEventListener('click', () => {
  pushUndo();
  const g = grid();
  clearSel(); readControls();
  const sup = support(cur);
  for (let y = 0; y < g.ny; y++)
    for (let x = 0; x < g.nx; x++) {
      if (cur > 0 && !sup.ok[y][x]) continue;
      for (const [u, v] of [[state.u, state.v], [state.v, state.u], [1, 1]]) {
        if (!canPlace(x, y, u, v, -1)) continue;
        // on upper layers, only place where the support underneath is level
        const probe = { x, y, u, v };
        if (cur > 0) { const st = seat(probe, cur); if (!st.flat || !st.solidBelow) continue; }
        B().push({ x, y, u, v, hUnits: state.hUnits, wall: state.wall,
                   floorT: state.floorT, divX: state.divX, divY: state.divY,
                   solid: state.solid, base: state.base, scoop: state.scoop, label: state.label,
                 note: '',
                 edges: Object.assign({}, state.edges) });
        break;
      }
    }
  drawLayerTabs(); drawMap(); refresh();
});
$('clearAll').addEventListener('click', () => {
  pushUndo();
  layers[cur].bins = []; clearSel();
  readControls(); drawLayerTabs(); drawMap(); refresh();
});
$('delBin').addEventListener('click', () => {
  if (selected < 0) return;
  pushUndo();
  for (const i of selAll().sort((a, b) => b - a)) B().splice(i, 1);
  clearSel();
  readControls(); drawLayerTabs(); drawMap(); refresh();
});
$('splitFit').addEventListener('click', () => {
  if (selected < 0) return;
  const b = B()[selected], sp = describeSplit(b.u, b.v);
  if (!sp) return;
  pushUndo();
  const src = Object.assign({}, b);
  B().splice(selected, 1);
  let oy = src.y;
  for (const vv of sp.ys) {
    let ox = src.x;
    for (const uu of sp.xs) {
      B().push(Object.assign({}, src, { x: ox, y: oy, u: uu, v: vv,
                                        edges: Object.assign({}, src.edges) }));
      ox += uu;
    }
    oy += vv;
  }
  clearSel();
  readControls(); drawLayerTabs(); drawMap(); refresh();
});
/* Merge the selection into one bin. Union the cells they cover, take the bounding box
   as the new footprint, and keep only the cells that were actually occupied — which is
   the same mask the carve gesture produces, so the two routes meet in the same place. */
$('carveMode').addEventListener('click', () => {
  carving = !carving;
  readControls(); drawMap();
});

$('mergeBins').addEventListener('click', () => {
  const sel = selAll();
  if (sel.length < 2) return;
  pushUndo();
  const bins = sel.map((i) => B()[i]);
  const abs = new Set();
  for (const b of bins) for (const [dx, dy] of binCells(b)) abs.add((b.x + dx) + ',' + (b.y + dy));
  const pts = [...abs].map((k) => k.split(',').map(Number));
  const x0 = Math.min(...pts.map((p) => p[0])), x1 = Math.max(...pts.map((p) => p[0]));
  const y0 = Math.min(...pts.map((p) => p[1])), y1 = Math.max(...pts.map((p) => p[1]));
  const u = x1 - x0 + 1, v = y1 - y0 + 1;
  const cells = pts.map(([x, y]) => [x - x0, y - y0]);
  const merged = Object.assign({}, bins[0], {   // the primary's settings carry
    x: x0, y: y0, u, v,
    cells: cells.length === u * v ? null : cells,   // a solid rectangle needs no mask
    edges: Object.assign({}, bins[0].edges),
  });
  for (const i of sel.sort((a, b) => b - a)) B().splice(i, 1);
  B().push(merged);
  selected = B().length - 1; selExtra.clear();
  writeControls(merged);
  readControls(); drawLayerTabs(); drawMap(); refresh();
});
$('applyAll').addEventListener('click', () => {
  if (selected < 0) return;
  pushUndo();
  const s = B()[selected];
  for (const b of B()) Object.assign(b, {
    hUnits: s.hUnits, wall: s.wall, floorT: s.floorT,
    divX: s.divX, divY: s.divY, solid: s.solid, base: s.base, scoop: s.scoop, label: s.label,
    edges: Object.assign({}, s.edges) });
  drawMap(); refresh();
});

/* ---------- undo ----------------------------------------------------------
   Snapshots of the layout only — drawer and printer settings are not part of it,
   so undo never surprises you by moving the walls of the room. Pushed before a
   change, not after, and deduplicated so a drag that ends where it started is not
   an undo step. */
const undoStack = [], redoStack = [];
const UNDO_MAX = 60;
const snapshot = () => JSON.stringify({ layers, cur });
function pushUndo() {
  const snap = snapshot();
  if (undoStack.length && undoStack[undoStack.length - 1] === snap) return;
  undoStack.push(snap);
  if (undoStack.length > UNDO_MAX) undoStack.shift();
  redoStack.length = 0;
  updateUndoButtons();
}
function applySnap(snap) {
  const o = JSON.parse(snap);
  layers = o.layers; cur = Math.min(o.cur, layers.length - 1);
  clearSel();
  readControls(); drawLayerTabs(); drawMap(); refresh();
}
function undo() {
  if (!undoStack.length) return;
  redoStack.push(snapshot());
  applySnap(undoStack.pop());
  updateUndoButtons();
}
function redo() {
  if (!redoStack.length) return;
  undoStack.push(snapshot());
  applySnap(redoStack.pop());
  updateUndoButtons();
}
function updateUndoButtons() {
  $('undoBtn').disabled = !undoStack.length;
  $('redoBtn').disabled = !redoStack.length;
}

/* ---------- splitting an oversized bin ------------------------------------
   Rotating on the bed never helps: a rectangle's bounding box is smallest at 0 or
   90 degrees, so anything longer than the bed stays longer than the bed. The only
   answer is fewer cells per piece. */
const footW = (u) => (u - 1) * SPEC.pitch + 2 * SPEC.half;
const fitsBed = (u, v) => {
  const w = footW(u), d = footW(v);
  return (w <= state.bedW && d <= state.bedD) || (d <= state.bedW && w <= state.bedD);
};
// fewest pieces that each fit; ties broken towards squarer pieces
function splitPlan(u, v) {
  let best = null;
  for (let nx = 1; nx <= u; nx++)
    for (let ny = 1; ny <= v; ny++) {
      const pu = Math.ceil(u / nx), pv = Math.ceil(v / ny);
      if (!fitsBed(pu, pv)) continue;
      const n = nx * ny, ar = Math.max(pu, pv) / Math.min(pu, pv);
      if (!best || n < best.n || (n === best.n && ar < best.ar)) best = { nx, ny, n, ar, pu, pv };
    }
  return best;
}
const evenParts = (total, n) => {
  const base = Math.floor(total / n), extra = total % n;
  return Array.from({ length: n }, (_, i) => base + (i < extra ? 1 : 0));
};
function describeSplit(u, v) {
  const p = splitPlan(u, v);
  if (!p) return null;
  const xs = evenParts(u, p.nx), ys = evenParts(v, p.ny);
  const names = [];
  for (const b of ys) for (const a of xs) names.push(`${a}×${b}`);
  return { plan: p, xs, ys, text: names.join(' + ') };
}

/* ---------- per-bin problems ----------------------------------------------
   One place decides what is wrong with a bin, so the badge on the map and the
   text in Checks can never disagree. Nothing here blocks placement — you may be
   about to fill in the thing that fixes it. */
function binIssues(b, k) {
  const g = grid(), out = [];
  if (b.x + b.u > g.nx || b.y + b.v > g.ny) {
    out.push('sits outside the drawer grid');
    return out;
  }
  const st = seat(b, k);
  if (k === 0) {
    if (b.base === 'low')
      out.push('low-profile foot is too short to engage a baseplate socket — it would sit loose');
  } else {
    const occB = occupancyOf(k - 1);
    // Where the bin below reaches each of this bin's four edges. Support does not
    // have to be continuous: a bin bridging a gap between two others is a plank on
    // two beams. What it cannot do is rest on one side only, or on nothing.
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, any = false;
    for (let dy = 0; dy < b.v; dy++)
      for (let dx = 0; dx < b.u; dx++) {
        if (occB[b.y + dy][b.x + dx] === -1) continue;
        any = true;
        x0 = Math.min(x0, dx); x1 = Math.max(x1, dx + 1);
        y0 = Math.min(y0, dy); y1 = Math.max(y1, dy + 1);
      }
    // Tips unless its centre of mass falls strictly inside the supported span. Touching
    // two opposite edges is not enough on its own: a wide bin resting on one narrow bin
    // reaches that bin's front and back rails, but every rail is on one side of it.
    const E = 1e-9;
    const stable = any &&
      b.u / 2 > x0 + E && b.u / 2 < x1 - E &&
      b.v / 2 > y0 + E && b.v / 2 < y1 - E;

    if (!any) {
      out.push('has nothing underneath it at all');
    } else if (!stable) {
      out.push('overhangs its support — the bins below are all to one side of its centre, so it would tip. Bridging a gap is fine; leaning off the end is not');
    } else if (!st.flat) {
      out.push('spans bins of different heights below — it would rock');
    } else {
      // The lip below is four rails around its perimeter, with open cavity between.
      // Spanning a bin across either axis lands you on two of its opposite rails;
      // being inset on BOTH axes leaves you over the hole in the middle.
      const covered = new Set();
      for (let dy = 0; dy < b.v; dy++)
        for (let dx = 0; dx < b.u; dx++) covered.add(occB[b.y + dy][b.x + dx]);
      for (const i of covered) {
        const bb = layers[k - 1].bins[i];
        if (!bb) continue;
        const spansX = b.x <= bb.x && b.x + b.u >= bb.x + bb.u;
        const spansY = b.y <= bb.y && b.y + b.v >= bb.y + bb.v;
        if (!spansX && !spansY)
          out.push(`sits inside the ${bb.u}×${bb.v} bin below on both axes, so it rests over open cavity and would drop in — span its full width or its full depth`);
        if (!allFullEdges(bb))
          out.push('the bin below has a lowered wall, so it has no stacking lip to sit on');
        if (b.base === 'low' && (bb.base || 'standard') === 'standard')
          out.push('low-profile foot cannot enter the full-height lip below — set that bin to Low lip');
      }
    }
  }
  /* Bins print upright, so height is a bed constraint too — and an easy one to miss,
     because a deep drawer will let you ask for a bin far taller than the printer's Z.
     Splitting cannot help here: a bin is one piece, so the only fix is fewer units. */
  const lipUp = (!b.solid && allFullEdges(b)) ? LIP_H : 0;
  const printH = b.hUnits * SPEC.unitH + lipUp;
  if (printH > state.bedH + 0.001)
    out.push(`stands ${printH.toFixed(1)} mm tall, past your printer's ${state.bedH} mm Z height — a bin prints in one piece, so it needs fewer units rather than splitting (max ${Math.max(1, Math.floor((state.bedH - lipUp) / SPEC.unitH))} here)`);

  if (isCarved(b)) {
    const m = maskCheck(maskOf({ u: b.u, v: b.v, cells: b.cells }), b.u, b.v);
    if (!m.ok)
      out.push(`${m.why} — it still prints, but it is not one solid bin` +
        (m.why.indexOf('pieces') >= 0 ? ' and will come out as separate parts' : ''));
    /* A note, not a fault. A carved bin keeps its stacking lip and takes bins on top
       exactly like a rectangle; only the features that need a rectangle to mean
       anything are left off. Flagging the shape itself in red made carving look
       broken the moment you started. */
    out.push({ note: true, t: 'is a carved shape — it keeps its stacking lip and still takes bins on top, but dividers, the scoop and the label shelf need a rectangle, so they are left off' });
  }

  const fw = (b.u - 1) * SPEC.pitch + 2 * SPEC.half, fd = (b.v - 1) * SPEC.pitch + 2 * SPEC.half;
  if (!((fw <= state.bedW && fd <= state.bedD) || (fd <= state.bedW && fw <= state.bedD)))
  {
    const sp = describeSplit(b.u, b.v);
    out.push(`is ${fw.toFixed(0)} × ${fd.toFixed(0)} mm, too big for your ${state.bedW} × ${state.bedD} mm bed in either orientation` +
      (sp ? ` — split it into ${sp.text}` : ''));
  }
  if (st.z + b.hUnits * SPEC.unitH + LIP_H > g.avail + 0.001)
    out.push(`reaches ${(st.z + b.hUnits * SPEC.unitH + LIP_H).toFixed(1)} mm, past the ${g.avail.toFixed(1)} mm available`);
  if (!b.solid && b.wall < 0.8)
    out.push(`${b.wall} mm walls are thinner than two perimeters at a 0.4 mm nozzle`);
  return out;
}

/* ---------- checks -------------------------------------------------------- */
function stackHeight() {
  const g = grid();
  let top = 0;
  for (let y = 0; y < g.ny; y++)
    for (let x = 0; x < g.nx; x++) {
      let h = 0;
      for (let L = 0; L < layers.length; L++) {
        const occ = occupancyOf(L), i = occ[y][x];
        if (i !== -1) h += layers[L].bins[i].hUnits * SPEC.unitH;
      }
      if (h > top) top = h;
    }
  return top ? top + LIP_H : 0;
}
function warnings() {
  const g = grid(), out = [];
  const tot = stackHeight();
  if (tot > g.avail + 0.001)
    out.push({ err: true, t: `The tallest stack is ${tot.toFixed(1)} mm but only ${g.avail.toFixed(1)} mm is available above the baseplate.` });
  else if (tot > 0)
    out.push({ t: `Tallest stack ${tot.toFixed(1)} mm of ${g.avail.toFixed(1)} mm available — ${(g.avail - tot).toFixed(1)} mm spare (includes the ${LIP_H.toFixed(2)} mm top lip).` });

  layers.forEach((L, k) => L.bins.forEach((b) => {
    for (const it of binIssues(b, k)) {
      const x = typeof it === 'string' ? { err: true, t: it } : it;
      out.push({ err: !x.note, note: x.note,
                 t: `Layer ${k + 1}, the ${b.u}×${b.v} bin at column ${b.x + 1} row ${b.y + 1}: ${x.t}.` });
    }
  }));

  if (!allBins().length)
    out.push({ t: 'No bins yet. Drag across the map to place one, or use "Fill the rest".' });
  return out;
}
function drawWarnings() {
  const w = warnings();
  $('warnings').innerHTML = w.length
    ? w.map((x) => `<div class="w${x.err ? ' err' : ''}"><span>${x.t}</span></div>`).join('')
    : '<div class="hint">Layout is sound and everything fits.</div>';
}

/* ---------- types + totals ------------------------------------------------ */
function types() {
  const m = new Map();
  for (const { b } of allBins()) {
    const k = typeKey(b);
    if (!m.has(k)) m.set(k, { key: k, b, qty: 0 });
    m.get(k).qty++;
  }
  return [...m.values()].sort((a, b) => b.qty - a.qty);
}
function refresh() {
  const g = grid();
  // the tallest bin is capped by the drawer OR the printer's Z, whichever bites first
  const zUnits = Math.max(1, Math.floor((state.bedH - LIP_H) / SPEC.unitH));
  const capUnits = Math.min(g.maxUnits, zUnits);
  const capBy = zUnits < g.maxUnits ? 'your printer' : 'the drawer';
  $('gridSummary').textContent =
    `Grid: ${g.nx} × ${g.ny} cells · ${g.avail.toFixed(1)} mm above the baseplate · ` +
    `tallest single bin ${capUnits} units (${capUnits * SPEC.unitH} mm + lip), limited by ${capBy}`;
  const src = selected >= 0 && B()[selected] ? B()[selected] : state;
  $('binSizeHint').textContent =
    `${(src.u * SPEC.pitch - 0.5).toFixed(1)} × ${(src.v * SPEC.pitch - 0.5).toFixed(1)} × ${(src.hUnits * SPEC.unitH).toFixed(1)} mm (+${LIP_H.toFixed(2)} lip)`;

  const used = B().reduce((a, b) => a + binCells(b).length, 0);
  const total = g.nx * g.ny;
  const pct = total ? Math.round(100 * used / total) : 0;
  $('coverage').textContent =
    `Layer ${cur + 1}: ${B().length} bin(s) · ${used}/${total} cells (${pct}%) · ` +
    `${allBins().length} bins over ${layers.length} layer(s) · tallest stack ${stackHeight().toFixed(1)} mm`;
  $('covfill').style.width = pct + '%';

  const ts = types();
  let vol = 0;
  $('typeRows').innerHTML = ts.map((t) => {
    const gm = geomFor(t.b);
    vol += gm.vol * t.qty;
    return `<tr><td class="mono">${t.b.u}×${t.b.v}×${t.b.hUnits}${t.b.solid ? ' solid' : ''}${t.b.divX || t.b.divY ? ` · ${(t.b.divX + 1) * (t.b.divY + 1)} comp` : ''}</td>` +
      `<td class="mono">${gm.meta.W.toFixed(1)} × ${gm.meta.D.toFixed(1)} × ${gm.meta.totalH.toFixed(1)}</td>` +
      `<td class="mono">${t.qty}</td>` +
      `<td class="mono">${(gm.vol * t.qty / 1000 * PLA_DENSITY).toFixed(0)} g</td>` +
      `<td><button data-t="${t.key}">STL</button></td></tr>`;
  }).join('') || '<tr><td colspan="5" class="mono">no bins placed</td></tr>';
  for (const btn of $('typeRows').querySelectorAll('button[data-t]'))
    btn.addEventListener('click', () => {
      const t = types().find((x) => x.key === btn.dataset.t);
      if (t) saveBlob(G.stlBinary(geomFor(t.b).polys, 'bin'), typeName(t) + '.stl');
    });
  $('totals').textContent = allBins().length
    ? `${allBins().length} bins · ${ts.length} distinct type(s) · ≈ ${(vol / 1000 * PLA_DENSITY).toFixed(0)} g PLA at ${state.infill}% infill`
    : '—';

  drawWarnings();
  drawPlan();
  showScene();
}

/* ---------- print plan ----------------------------------------------------
   Reuses packPlates from the shared core: shelf packing with rotation, no
   stacking (bins are open-topped, so nothing can bridge over them). */
let printPlan = null;
function computePlan() {
  const ts = types();
  if (!ts.length) { printPlan = null; return; }
  const items = ts.map((t) => {
    const m = geomFor(t.b).meta;
    return { id: t.key, w: m.W, d: m.D, h: m.totalH, qty: t.qty, ids: [t.key] };
  });
  printPlan = { plates: packPlates(items, state.bedW, state.bedD, state.gap,
                                   { stack: false }), types: ts };
}
function drawPlan() {
  computePlan();
  if (!printPlan) {
    $('plateWrap').innerHTML = '';
    $('plateSummary').textContent = '—';
    return;
  }
  const over = printPlan.plates.filter((p) => p.overflow);
  const good = printPlan.plates.filter((p) => !p.overflow);
  const sc = Math.min(170 / state.bedW, 170 / state.bedD);
  const byKey = new Map(printPlan.types.map((t, i) => [t.key, i]));
  const COLORS = ['#4fc3e8', '#e8b34f', '#7fd8a5', '#e88a8a', '#b18ae8', '#7fb5e8', '#e8d47f'];
  $('plateWrap').innerHTML = good.map((pl, i) => {
    let svg = `<svg width="${state.bedW * sc + 2}" height="${state.bedD * sc + 2}" ` +
              `style="background:var(--panel2);border:1px solid var(--line);border-radius:4px">`;
    for (const p of pl.placed) {
      const c = COLORS[(byKey.get(p.id) || 0) % COLORS.length];
      /* Draw the shape that actually prints. The packer works in bounding boxes, which
         is correct — a carved bin still sweeps its full box — but drawing the box made
         the plan claim an L was a rectangle. Cells are placed the same way the 3D plate
         places the mesh: centre the bin on the origin, rotate, then translate. */
      const t = printPlan.types.find((x) => x.key === p.id);
      const b = t && t.b;
      const cells = b && isCarved(b) ? binCells(b) : null;
      if (!cells) {
        svg += `<rect x="${p.x * sc + 1}" y="${(state.bedD - p.y - p.d) * sc + 1}" ` +
               `width="${p.w * sc}" height="${p.d * sc}" fill="${c}" opacity="0.5" stroke="var(--line)"/>`;
        continue;
      }
      const P = 42, HALF = 20.75;
      const midX = p.x + p.w / 2, midY = p.y + p.d / 2;
      for (const [dx, dy] of cells) {
        let cx = (dx - (b.u - 1) / 2) * P, cy = (dy - (b.v - 1) / 2) * P;
        if (p.rot === 90) { const t2 = cx; cx = -cy; cy = t2; }
        const X = midX + cx, Y = midY + cy;
        svg += `<rect x="${(X - HALF) * sc + 1}" y="${(state.bedD - Y - HALF) * sc + 1}" ` +
               `width="${2 * HALF * sc}" height="${2 * HALF * sc}" fill="${c}" ` +
               `opacity="0.5" stroke="var(--line)"/>`;
      }
    }
    svg += '</svg>';
    return `<div style="display:grid;gap:4px;justify-items:center">${svg}` +
           `<div class="hint">plate ${i + 1} — ${pl.placed.length} bin(s)</div></div>`;
  }).join('');
  const total = good.reduce((a, p) => a + p.placed.length, 0);
  $('plateSummary').textContent =
    `${good.length} plate(s) on a ${state.bedW} × ${state.bedD} mm bed · ${total} bin(s) packed` +
    (over.length ? ` · ${over.length} bin(s) TOO BIG for the bed` : '');
}

/* ---------- three.js preview ---------------------------------------------- */
let scene, camera, renderer, group;
let theta = -0.9, phi = 0.95, dist = 600, dragging = null;
function initThree() {
  const canvas = $('three');
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(38, 1, 1, 8000);
  scene.add(new THREE.AmbientLight(0xffffff, 0.62));
  const d1 = new THREE.DirectionalLight(0xffffff, 0.85); d1.position.set(1, 1.4, 1); scene.add(d1);
  const d2 = new THREE.DirectionalLight(0x88bbff, 0.35); d2.position.set(-1, -0.6, 0.4); scene.add(d2);
  group = new THREE.Group(); scene.add(group);
  canvas.addEventListener('pointerdown', (e) => { dragging = [e.clientX, e.clientY]; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointerup', () => { dragging = null; });
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  canvas.addEventListener('pointermove', (e) => {
    if (dragging) {
      theta -= (e.clientX - dragging[0]) * 0.01;
      phi = Math.min(3.11, Math.max(0.03, phi - (e.clientY - dragging[1]) * 0.01));
      dragging = [e.clientX, e.clientY]; render();
      hideTip();
      return;
    }
    // which bin is under the cursor? the meshes carry their bin on userData
    const r = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1,
            -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects(group.children, false)
                   .find((h) => h.object.userData && h.object.userData.bin);
    if (hit) showTip(e, hit.object.userData.bin, hit.object.userData.layer);
    else hideTip();
  });
  canvas.addEventListener('pointerleave', hideTip);
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    dist = Math.min(4000, Math.max(80, dist * (1 + Math.sign(e.deltaY) * 0.12)));
    render();
  }, { passive: false });
  window.addEventListener('resize', () => { drawMap(); render(); });
}
function geoOf(b) {
  const gm = geomFor(b);
  if (!gm.three) {
    const tris = G.polysToTriangles(gm.polys);
    const pos = new Float32Array(tris.length * 9);
    let i = 0;
    for (const t of tris) for (const v of t) { pos[i++] = v[0]; pos[i++] = v[2]; pos[i++] = -v[1]; }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.computeVertexNormals();
    gm.three = geo;
  }
  return gm.three;
}
const MATS = [0x6fd0e0, 0x8fdc9a, 0xe0c46f, 0xd08fd0, 0xe08f8f];
let matCache = [];
function showScene() {
  if (!renderer) return;
  while (group.children.length) group.remove(group.children[0]);
  const g = grid();
  const gw = g.nx * SPEC.pitch, gd = g.ny * SPEC.pitch;

  const plate = new THREE.Mesh(new THREE.BoxGeometry(gw, state.plateH, gd),
    new THREE.MeshLambertMaterial({ color: 0x2b3947 }));
  plate.position.set(0, -state.plateH / 2, 0);
  group.add(plate);

  layers.forEach((L, k) => {
    if (!matCache[k]) matCache[k] = new THREE.MeshLambertMaterial({
      color: MATS[k % MATS.length], side: THREE.DoubleSide, flatShading: true });
    /* Fade anything stacked above the layer being edited, so it stops hiding the one
       you are working on. Updated every draw: the material is cached per layer, and
       baking this in at creation meant switching layers changed nothing. */
    const above = k > cur;
    matCache[k].transparent = above;
    matCache[k].opacity = above ? 0.28 : 1;
    matCache[k].depthWrite = !above;
    matCache[k].needsUpdate = true;
    for (const b of L.bins) {
      const m = new THREE.Mesh(geoOf(b), matCache[k]);
      m.userData.bin = b; m.userData.layer = k;
      m.position.set((b.x + b.u / 2) * SPEC.pitch - gw / 2, seat(b, k).z,
                     -((b.y + b.v / 2) * SPEC.pitch - gd / 2));
      group.add(m);
    }
  });
  render();
}
function render() {
  if (!renderer) return;
  const wrap = $('threewrap');
  const w = wrap.clientWidth, h = wrap.clientHeight || 380;
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.updateProjectionMatrix();
  camera.position.set(dist * Math.sin(phi) * Math.cos(theta),
                      30 + dist * Math.cos(phi),
                      dist * Math.sin(phi) * Math.sin(theta));
  camera.lookAt(0, 20, 0);
  renderer.render(scene, camera);
}

/* ---------- hover tooltip -------------------------------------------------- */
function showTip(e, b, k) {
  const el = $('tip');
  el.textContent = (b.note ? b.note + ' — ' : '') +
    `${b.u}×${b.v}, ${b.hUnits} units (${b.hUnits * SPEC.unitH} mm)` +
    (k !== undefined && layers.length > 1 ? ` · layer ${k + 1}` : '');
  el.style.display = 'block';
  const pad = 14;
  el.style.left = Math.min(e.clientX + pad, window.innerWidth - el.offsetWidth - 8) + 'px';
  el.style.top = Math.max(8, e.clientY - el.offsetHeight - 10) + 'px';
}
function hideTip() { const el = $('tip'); if (el) el.style.display = 'none'; }

/* ---------- export -------------------------------------------------------- */
function saveBlob(buf, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([buf], { type: 'application/octet-stream' }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
function typeName(t) {
  return `bin-${t.b.u}x${t.b.v}x${t.b.hUnits}${t.b.solid ? '-solid' : ''}` +
         `${t.b.divX || t.b.divY ? `-${t.b.divX}x${t.b.divY}div` : ''}-qty${t.qty}`;
}
function layoutReadme() {
  const g = grid(), ts = types();
  const L = [];
  L.push('GRIDFINITY BINS — generated by Drawerforge');
  L.push('==========================================');
  L.push('https://drawerforge.co.uk');
  L.push('');
  L.push(`Drawer: ${state.drawerW} x ${state.drawerD} mm | Grid: ${g.nx} x ${g.ny} cells @ ${SPEC.pitch} mm`);
  L.push(`Height above the baseplate: ${g.avail.toFixed(1)} mm | tallest stack here: ${stackHeight().toFixed(1)} mm`);
  L.push(`Layers: ${layers.length}`);
  L.push('');
  L.push('BINS TO PRINT:');
  let vol = 0;
  for (const t of ts) {
    const gm = geomFor(t.b);
    vol += gm.vol * t.qty;
    L.push(`  ${String(t.qty).padStart(3)} x  ${t.b.u}x${t.b.v}x${t.b.hUnits}` +
      `  (${gm.meta.W.toFixed(1)} x ${gm.meta.D.toFixed(1)} x ${gm.meta.totalH.toFixed(1)} mm incl. lip)` +
      `${t.b.solid ? '  solid' : ''}${t.b.divX || t.b.divY ? `  ${(t.b.divX + 1) * (t.b.divY + 1)} compartments` : ''}`);
  }
  L.push('');
  L.push(`Total: ${allBins().length} bins, about ${(vol / 1000 * PLA_DENSITY).toFixed(0)} g of PLA.`);
  L.push('');
  layers.forEach((Ly, k) => {
    L.push(`LAYER ${k + 1} (front of the drawer at the bottom):`);
    const occ = occupancyOf(k);
    for (let y = g.ny - 1; y >= 0; y--)
      L.push('  ' + occ[y].map((i) => i === -1 ? ' . ' : String.fromCharCode(65 + (i % 26)) + '  ').join('').trimEnd());
    Ly.bins.forEach((b, i) => {
      const tag = String.fromCharCode(65 + (i % 26));
      L.push(`    ${tag} = ${b.u}x${b.v}x${b.hUnits}` + (b.note ? `  — ${b.note}` : ''));
    });
    L.push('');
  });
  if (printPlan) {
    const good = printPlan.plates.filter((p) => !p.overflow);
    L.push(`PRINT PLATES: ${good.length} on a ${state.bedW} x ${state.bedD} mm bed.`);
    L.push('');
  }
  L.push('ASSEMBLY: lay layer 1 into the baseplate, then drop each higher layer into');
  L.push('the stacking lips of the bins below it.');
  L.push('');
  L.push('PRINTING: flat as oriented, no supports. Print one bin and check it seats');
  L.push('in your baseplate before committing to the whole drawer.');
  L.push('');
  L.push('Layout link: ' + shareLink());
  return L.join('\n');
}
function platePolysAndItems(idx) {
  const pl = printPlan.plates[idx];
  const objs = [];
  for (const p of pl.placed) {
    const t = printPlan.types.find((x) => x.key === p.id);
    if (!t) continue;
    // bins are modelled centred on the origin; packPlates gives a corner
    objs.push({ name: p.id, polys: geomFor(t.b).polys,
                tx: p.x + p.w / 2, ty: p.y + p.d / 2, tz: 0, rot: p.rot });
  }
  return objs;
}
async function plate3mfBytes(idx) {
  const x = build3mfXML(platePolysAndItems(idx).map((o) => ({
    name: o.name, polys: transformPolys(o.polys, 0, 0, 0, o.rot), tx: o.tx, ty: o.ty, tz: o.tz, rot: 0 })));
  const pz = new JSZip();
  pz.file('[Content_Types].xml', x.contentTypes);
  pz.file('_rels/.rels', x.rels);
  pz.file('3D/3dmodel.model', x.model);
  return pz.generateAsync({ type: 'uint8array' });
}
$('dlPlates').addEventListener('click', async () => {
  if (!printPlan) return;
  const good = printPlan.plates.map((p, i) => [p, i]).filter(([p]) => !p.overflow);
  if (!good.length) return;
  if (good.length === 1) { saveBlob(await plate3mfBytes(good[0][1]), 'bin-plates.3mf'); return; }
  const zip = new JSZip();
  for (const [, i] of good) zip.file(`plate-${i + 1}.3mf`, await plate3mfBytes(i));
  const blob = await zip.generateAsync({ type: 'blob' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `drawerforge-bin-plates-x${good.length}.zip`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
});
$('bedPreset').addEventListener('change', () => {
  const v = $('bedPreset').value;
  if (v === 'custom') return;
  const [w, d, h] = v.split(',');
  $('bedW').value = w; $('bedD').value = d; if (h) $('bedH').value = h;
  schedule();
});
$('dlAll').addEventListener('click', async () => {
  if (!allBins().length) return;
  const zip = new JSZip();
  for (const t of types())
    zip.file(typeName(t) + '.stl', G.stlBinary(geomFor(t.b).polys, 'bin'));
  zip.file('README.txt', layoutReadme());
  const blob = await zip.generateAsync({ type: 'blob' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `drawerforge-bins-${grid().nx}x${grid().ny}.zip`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
});

/* ---------- shared project descriptor -------------------------------------- */
const KEYS = { w: 'drawerW', d: 'drawerD', dh: 'drawerH', ph: 'plateH' };
// packing lives in bin.js so it can be tested headlessly
function descriptor() {
  const o = Object.assign({}, hashExtras, { v: 2 });
  for (const [k, id] of Object.entries(KEYS)) o[k] = state[id];
  o.bl = packLayers(layers);
  o.bseg = state.arcSegs;
  const notes = layers.map((L) => L.bins.map((b) => b.note || ''));
  if (notes.some((L) => L.some((n) => n))) o.bnotes = JSON.stringify(notes);
  return o;
}
const encodeDesc = (o) => Object.entries(o).map(([k, x]) => `${k}=${encodeURIComponent(x)}`).join('&');
function shareLink() {
  return location.origin + location.pathname + '#' + encodeDesc(descriptor());
}
function loadFromHash() {
  const h = location.hash.replace(/^#/, '');
  if (!h) return;
  const q = {};
  for (const kv of h.split('&')) {
    const i = kv.indexOf('=');
    if (i > 0) q[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1));
  }
  for (const [k, val] of Object.entries(q)) {
    if (k === 'v') continue;
    if (k === 'bl') { const ls = unpackLayers(val); if (ls.length) layers = ls; continue; }
    if (k === 'bseg') { $('arcSegs').value = val; continue; }
    if (k === 'bnotes') { pendingNotes = val; continue; }
    const id = KEYS[k];
    if (!id) { hashExtras[k] = val; continue; }
    if ($(id)) $(id).value = val;
  }
}
// the guide holds no state, so hand it ours and it can hand it back
$('navGuide').addEventListener('click', (e) => {
  e.preventDefault();
  location.href = '../guide/#' + encodeDesc(descriptor());
});
$('shareBtn').addEventListener('click', () => {
  const link = shareLink();
  navigator.clipboard.writeText(link).then(
    () => { $('shareBtn').textContent = 'Copied ✓'; setTimeout(() => $('shareBtn').textContent = 'Copy layout link', 1600); },
    () => prompt('Copy this link:', link));
});
// the whole bins descriptor travels; baseplates re-emits what it doesn't own
function platesHref() { return '../#' + encodeDesc(descriptor()); }
for (const id of ['toPlates', 'navPlates'])
  $(id).addEventListener('click', (e) => { e.preventDefault(); location.href = platesHref(); });

/* ---------- boot ---------------------------------------------------------- */
let timer = null;
const schedule = () => { clearTimeout(timer); timer = setTimeout(() => {
  readControls(); geoCache.clear(); drawLayerTabs(); drawMap(); refresh(); }, 180); };
for (const id of ['drawerW', 'drawerD', 'drawerH', 'plateH', 'infill', 'bedW', 'bedD', 'bedH', 'gap',
                  'u', 'v', 'hUnits',
                  'wall', 'floorT', 'divX', 'divY', 'solid', 'arcSegs',
                  'edgeF', 'edgeB', 'edgeL', 'edgeR', 'baseStyle', 'scoop', 'label', 'note'])
  $(id).addEventListener('input', schedule);
for (const id of ['edgeF', 'edgeB', 'edgeL', 'edgeR', 'baseStyle'])
  $(id).addEventListener('change', schedule);
$('presetTray').addEventListener('click', () => {
  for (const id of ['edgeF', 'edgeB', 'edgeL', 'edgeR']) $(id).value = '0';
  $('solid').checked = false;
  readControls(); geoCache.clear(); drawMap(); refresh();
});
$('solid').addEventListener('change', schedule);
$('arcSegs').addEventListener('change', schedule);
for (const s of document.querySelectorAll('section.p h2'))
  s.addEventListener('click', () => s.parentElement.classList.toggle('closed'));

$('undoBtn').addEventListener('click', undo);
$('redoBtn').addEventListener('click', redo);
$('dupBtn').addEventListener('click', duplicateSelected);

function duplicateSelected() {
  if (selected < 0) return;
  const src = B()[selected];
  // first free spot scanning right then up from the original
  const g = grid();
  for (let dy = 0; dy < g.ny; dy++)
    for (let dx = 0; dx < g.nx; dx++) {
      const nx = src.x + dx, ny = src.y + dy;
      if (!dx && !dy) continue;
      if (!canPlace(nx, ny, src.u, src.v, -1)) continue;
      pushUndo();
      B().push(Object.assign({}, src, { x: nx, y: ny, edges: Object.assign({}, src.edges) }));
      selected = B().length - 1;
      readControls(); drawLayerTabs(); drawMap(); refresh();
      return;
    }
}

document.addEventListener('keydown', (e) => {
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
  if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateSelected(); return; }
  if (e.key === 'Escape' && carving) { e.preventDefault(); carving = false; readControls(); drawMap(); return; }
  if (selected < 0) return;
  const b = B()[selected];
  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault(); pushUndo();
    for (const i of selAll().sort((x, y) => y - x)) B().splice(i, 1);
    clearSel();
    readControls(); drawLayerTabs(); drawMap(); refresh(); return;
  }
  const nudge = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[e.key];
  if (nudge) {
    e.preventDefault();
    const [dx, dy] = nudge;
    if (e.shiftKey) {                       // shift-arrow grows or shrinks instead
      const nu = Math.max(1, b.u + dx), nv = Math.max(1, b.v + dy);
      if (canPlace(b.x, b.y, nu, nv, selected)) { pushUndo(); setFootprint(b, nu, nv); }
    } else if (canPlace(b.x + dx, b.y + dy, b.u, b.v, selected)) {
      pushUndo(); b.x += dx; b.y += dy;
    }
    writeControls(b); readControls(); drawMap(); refresh();
  }
});

loadFromHash();
if (pendingNotes) {                       // applied after the layout so indices line up
  try {
    JSON.parse(pendingNotes).forEach((ns, k) =>
      ns.forEach((n, i) => { if (layers[k] && layers[k].bins[i]) layers[k].bins[i].note = n; }));
  } catch (err) { /* a mangled link should not stop the tool loading */ }
}
readControls();
initThree();
initMap();
drawLayerTabs();
drawMap();
refresh();
updateUndoButtons();
