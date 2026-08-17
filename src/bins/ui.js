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

/* Counted things, written the way a person would say them. The page carried eleven
   "bin(s)" and "layer(s)", including one line that managed both "1 bin(s)" and
   "1 bins" in eleven words — a form nobody says out loud, and the clearest sign that
   the text was written for the person who already knew what it meant. Irregulars pass
   their own plural; everything here so far takes an s. */
const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + 's'}`;

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
                         solid: b.solid, edges: b.edges,
                         scoop: b.scoop, label: b.label, cells: b.cells,
                         arcSegs: state.arcSegs });
const edgeSig = (b) => EDGES.map((k) => (b.edges && b.edges[k] !== undefined ? b.edges[k] : 1)).join(',');
const allFullEdges = (b) => EDGES.every((k) => !b.edges || b.edges[k] === undefined || b.edges[k] >= 1);
const typeKey = (b) => `${b.u}x${b.v}x${b.hUnits}` +
  (b.solid ? '-solid' : `-w${b.wall}-f${b.floorT}` +
   (b.divX || b.divY ? `-d${b.divX}.${b.divY}` : '') +
   (allFullEdges(b) ? '' : `-e${edgeSig(b)}`)) +
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
/* Panels are opened from two places now — the header button, and the page deciding
   you need to see something — so both go through here. The class is what actually
   shows the body and aria-expanded is what says so; anything that sets one without
   the other leaves a panel that is open to the eye and shut to a screen reader. */
function setPanel(id, open) {
  const sec = $(id);
  sec.classList.toggle('closed', !open);
  const btn = sec.querySelector(':scope>h2>button');
  if (btn) btn.setAttribute('aria-expanded', String(open));
}
/* Both of these open a panel on an EDGE — when there was nothing to see and now there
   is — rather than on every draw. Re-asserting it on each keystroke would mean a panel
   you closed on purpose sprang open again the next time you typed, which is a worse
   interface than the one this is fixing. */
let hadSelection = false;
let hadErrors = false;

function readControls() {
  const num = (id, d) => { const x = parseFloat($(id).value); return isFinite(x) ? x : d; };
  const int = (id, d) => { const x = parseInt($(id).value, 10); return isFinite(x) ? x : d; };
  state.drawerW = num('drawerW', 306);
  state.drawerD = num('drawerD', 380);
  state.drawerH = num('drawerH', 84);
  state.plateH = num('plateH', 4.25);
  state.showDrawer = $('showDrawer').checked;
  state.drawerFrontH = num('drawerFrontH', 0);
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
    scoop: Math.max(0, num('scoop', 0)), label: Math.max(0, num('label', 0)),
    note: $('note').value.slice(0, 28),
    edges: { f: parseFloat($('edgeF').value), b: parseFloat($('edgeB').value),
             l: parseFloat($('edgeL').value), r: parseFloat($('edgeR').value) },
  };
  /* Deliberately not part of `t`. Whether a bin has been printed is a fact about the
     world, not a design setting, and `t` is the settings object — bulk-assigned to the
     selection and then copied into `state`, the template for the next bin drawn.

     Being honest about how much that buys today: new bins are built from an explicit
     field list further down, so `done` could not leak through `state` even if it were
     in `t`. Keeping it out matters the day that construction becomes a spread of
     `state`, which is a very ordinary tidy-up to make — and then a flag in `t` would
     have every bin drawn after a mark born already printed. print-queue.spec.js fails
     on exactly that pair of changes. */
  const sel = selAll();
  $('doneRow').style.display = sel.length ? '' : 'none';
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
  // the front measurement is only worth asking for once the drawer is being drawn
  $('drawerFrontRow').style.display = state.showDrawer ? '' : 'none';
  $('drawerViewHint').style.display = state.showDrawer ? '' : 'none';
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
  $('binPanelTitle').textContent = nSel > 1 ? `${plural(nSel, 'bin')} selected`
    : nSel === 1 ? 'Selected bin' : 'New bins';
  /* The panel ships closed, so selecting a bin has to open it or its settings are
     behind a click that nothing asks you to make. */
  if (nSel && !hadSelection) setPanel('s-bin', true);
  hadSelection = nSel > 0;
  $('fillSize').textContent = `${state.u}×${state.v}`;
  $('delLayer').style.display = layers.length > 1 ? '' : 'none';
  /* The cell fields are a second way to say the drawer size, so they follow it —
     except while they are being typed into, where rewriting the value under the
     caret turns "12" into "1". */
  const g = grid();
  if (document.activeElement !== $('gridX')) $('gridX').value = g.nx;
  if (document.activeElement !== $('gridY')) $('gridY').value = g.ny;
}
function writeControls(src) {
  $('u').value = src.u; $('v').value = src.v; $('hUnits').value = src.hUnits;
  $('wall').value = src.wall; $('floorT').value = src.floorT;
  $('divX').value = src.divX; $('divY').value = src.divY;
  $('solid').checked = !!src.solid;
  $('scoop').value = src.scoop || 0; $('label').value = src.label || 0;
  $('done').checked = !!src.done;
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
  /* Sizing the two columns from the map is only meaningful where there ARE two
     columns. The stylesheet collapses .stagetop to one column below 1280 px, and an
     inline style beats a media query — so on a phone this pinned a 320 px preview
     beside the map and hung the whole card off the right edge of the screen.
     Clearing the inline style and asking the element how many tracks it ended up with
     keeps that breakpoint in one place, the stylesheet, instead of repeating the
     number here where the two could drift apart. */
  if (top) {
    top.style.gridTemplateColumns = '';
    const twoCol = !wide &&
      getComputedStyle(top).gridTemplateColumns.trim().split(/\s+/).length > 1;
    if (twoCol)
      top.style.gridTemplateColumns = `${Math.round(W * sc) + 30}px minmax(${PREVIEW_MIN}px, 1fr)`;
  }

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
    const cls = 'bin' + (selAll().includes(i) ? ' sel' : '') + (issues.length ? ' clash' : '')
                      + (b.done ? ' done' : '');
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

  /* To anything that cannot see it, the map is one image with no alt text — the whole
     working surface of the tool, unreadable. The label is rebuilt here, on every draw,
     rather than written once in the markup: a fixed string would describe an empty
     drawer forever, which is worse than silence because it is confidently wrong.
     Long layouts are summarised rather than enumerated. Reading out seventy bins is
     not useful, and the piece table below already lists every one of them as real
     text a screen reader can navigate. */
  const listed = B().slice(0, 12).map((b) =>
    `${b.u} by ${b.v}${isCarved(b) ? ' carved' : ''} at column ${b.x + 1}, row ${b.y + 1}`);
  const more = B().length - listed.length;
  svg.setAttribute('aria-label',
    `Drawer layout map, front of the drawer at the bottom. ` +
    `Layer ${cur + 1} of ${layers.length}, grid ${g.nx} by ${g.ny} cells ` +
    `in a ${state.drawerW} by ${state.drawerD} millimetre drawer. ` +
    (B().length
      ? `${plural(B().length, 'bin')} on this layer: ` +
        listed.join('; ') + (more > 0 ? `; and ${more} more` : '') + '.'
      : 'No bins on this layer.'));
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
                   solid: state.solid, scoop: state.scoop, label: state.label,
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
                   solid: state.solid, scoop: state.scoop, label: state.label,
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
    divX: s.divX, divY: s.divY, solid: s.solid, scoop: s.scoop, label: s.label,
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
  // layer 0 sits on the baseplate, which every bin fits; the rest sit on other bins
  if (k > 0) {
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
/* Where the checks are said, and how loudly.
 *
 * They were said in exactly one place: the body of panel 04, which on a 1440 px screen
 * starts around 1240 px down a rail that scrolls on its own, and on a phone is a
 * thousand pixels below the fold. A 7×9 bin 40 units tall produced four correct,
 * well-written errors and nothing on screen said so — the only signal was a ⚠ glyph in
 * the corner of the map, and nothing at all stopped you downloading a 283.9 mm bin that
 * no printer will make.
 *
 * So three signals, each for a different way of looking at the page: a count in the
 * panel header, which is visible whether or not the body is; the errors repeated under
 * the map, where the baseplates page has always put them and where your eye already is;
 * and the panel opening itself the moment a sound layout stops being one.
 */
function drawWarnings() {
  const w = warnings();
  const errs = w.filter((x) => x.err);
  $('warnings').innerHTML = w.length
    ? w.map((x) => `<div class="w${x.err ? ' err' : ''}"><span>${x.t}</span></div>`).join('')
    : '<div class="hint">Layout is sound and everything fits.</div>';

  // errors only in the stage: the panel keeps the notes and the all-clear, and a
  // second copy of "this is a carved shape" beside the map would be noise
  $('mapChecks').style.display = errs.length ? '' : 'none';
  $('mapChecksList').innerHTML = errs.map((x) => `<div>${x.t}</div>`).join('');

  $('warnBadge').textContent = errs.length ? `· ${plural(errs.length, 'problem')}` : '';
  $('warnBadge').style.display = errs.length ? '' : 'none';
  if (errs.length && !hadErrors) setPanel('s-warn', true);
  hadErrors = errs.length > 0;
}

/* ---------- types + totals ------------------------------------------------ */
/* The bins still to print, grouped by shape.
 *
 * Everything you could print comes through here — the plates, the per-type STLs, the
 * ZIP, the filament estimate — so marking a bin printed here removes it from all of
 * them at once rather than from whichever ones someone remembered to filter. The bin
 * stays in the layout: it is in the drawer, it just is not in the queue.
 */
/* How a type reads in a list: its shape, and what you said goes in it. Distinct from
   typeName further down, which builds the STL FILENAME and must stay stable and
   filesystem-safe — a note with a slash in it has no business in a filename. */
const typeLabel = (t) => `${t.b.u}×${t.b.v}×${t.b.hUnits}` +
  (t.b.solid ? ' solid' : '') + (t.qty > 1 ? ` × ${t.qty}` : '') +
  (t.notes && t.notes.length ? ` — ${t.notes.join(', ')}` : '');

function types() {
  const m = new Map();
  for (const { b } of allBins()) {
    if (b.done) continue;
    const k = typeKey(b);
    if (!m.has(k)) m.set(k, { key: k, b, qty: 0, notes: [] });
    const t = m.get(k);
    t.qty++;
    /* What you wrote in the bin travels with its type, because "1x1x3 x 2" is the one
       thing a row of the download table cannot tell you: which of the four identical
       shapes on the plate is the one for drill bits. Notes are NOT part of typeKey — two
       bins the same shape share one STL whatever they are for — so a type can carry
       several, and all of them are worth showing. */
    const n = (b.note || '').trim();
    if (n && !t.notes.includes(n)) t.notes.push(n);
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
  /* The drawer is named here because nothing else on the stage names it. Arriving from
     the baseplates page with a 412 × 297 drawer, the only confirmation that it carried
     across sat inside collapsed panel 01, and this line said "0/63 cells" — true, and
     no help at all in telling whether the tool was working on your drawer or its own
     default one. The totals across layers only appear once there is more than one
     layer; on a single-layer design they repeated the same count in the same line. */
  $('coverage').textContent =
    `Layer ${cur + 1}: ${plural(B().length, 'bin')} · ${used}/${total} cells (${pct}%) · ` +
    `${g.nx} × ${g.ny} grid in a ${state.drawerW} × ${state.drawerD} mm drawer` +
    (layers.length > 1
      ? ` · ${plural(allBins().length, 'bin')} over ${plural(layers.length, 'layer')}`
      : '') +
    ` · tallest stack ${stackHeight().toFixed(1)} mm`;
  $('covfill').style.width = pct + '%';

  const ts = types();
  let vol = 0;
  $('typeRows').innerHTML = ts.map((t) => {
    const gm = geomFor(t.b);
    vol += gm.vol * t.qty;
    return `<tr><td class="mono">${t.b.u}×${t.b.v}×${t.b.hUnits}${t.b.solid ? ' solid' : ''}${t.b.divX || t.b.divY ? ` · ${(t.b.divX + 1) * (t.b.divY + 1)} comp` : ''}` +
      /* what it is for, beside what it is — the row is how you tell four identical
         shapes apart when they come off the plate */
      `${t.notes && t.notes.length ? `<span class="tnote">${t.notes.join(', ')}</span>` : ''}</td>` +
      `<td class="mono">${gm.meta.W.toFixed(1)} × ${gm.meta.D.toFixed(1)} × ${gm.meta.totalH.toFixed(1)}</td>` +
      `<td class="mono">${t.qty}</td>` +
      `<td class="mono">${(gm.vol * t.qty / 1000 * PLA_DENSITY).toFixed(0)} g</td>` +
      `<td><button data-t="${t.key}">STL</button></td></tr>`;
  }).join('') || '<tr><td colspan="5" class="mono">no bins placed</td></tr>';
  for (const btn of $('typeRows').querySelectorAll('button[data-t]'))
    btn.addEventListener('click', () => {
      const t = types().find((x) => x.key === btn.dataset.t);
      if (t) downloadType(t);
    });
  /* Two counts once anything is marked: what is in the drawer, and what is still to
     come off the printer. Reporting only the second would make the drawer look
     half-designed; only the first would quote filament for bins already sitting in it. */
  const doneN = allBins().filter(({ b }) => b.done).length;
  $('totals').textContent = allBins().length
    ? `${plural(allBins().length, 'bin')}` +
      (doneN ? ` · ${plural(allBins().length - doneN, 'bin')} still to print` : '') +
      ` · ${plural(ts.length, 'distinct type')} · ` +
      `≈ ${(vol / 1000 * PLA_DENSITY).toFixed(0)} g PLA at ${state.infill}% infill` +
      (doneN ? ' for those' : '')
    : '—';

  drawWarnings();
  drawPlan();
  updateExportTail();
  showScene();
  rememberState();
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
           `<div class="hint">plate ${i + 1} — ${plural(pl.placed.length, 'bin')}</div></div>`;
  }).join('');
  const total = good.reduce((a, p) => a + p.placed.length, 0);
  $('plateSummary').textContent =
    `${plural(good.length, 'plate')} on a ${state.bedW} × ${state.bedD} mm bed · ` +
    `${plural(total, 'bin')} packed` +
    (over.length ? ` · ${plural(over.length, 'bin')} TOO BIG for the bed` : '');
}

/* ---------- three.js preview ---------------------------------------------- */
let scene, camera, renderer, group, drawerGroup;
/* +theta puts the camera on the front side. It was -0.9, which sat the camera
   behind the drawer: the front row of the map rendered furthest away and the whole
   layout read mirrored against the map you had just drawn it on. Nothing pointed
   that out until the drawer shell arrived and its tall front panel appeared at the
   back. Same elevation and distance, same view, just from the side you open. */
let theta = 0.9, phi = 0.95, dist = 600, dragging = null;
/* Where the camera is looking, on the drawer floor. Orbit alone always swung about the
   middle of the grid, so a bin in a far corner of a nine-cell drawer could not be
   brought to the middle of the view to be looked at — you could only get further away.
   Middle-drag or shift-drag moves this; the baseplates tool has panned on shift-drag
   from the start and now takes the middle button too, so the two previews answer to the
   same hands. */
let panX = 0, panZ = 0, panning = false;
function initThree() {
  const canvas = $('three');
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(38, 1, 1, 8000);
  scene.add(new THREE.AmbientLight(0xffffff, 0.62));
  const d1 = new THREE.DirectionalLight(0xffffff, 0.85); d1.position.set(1, 1.4, 1); scene.add(d1);
  const d2 = new THREE.DirectionalLight(0x88bbff, 0.35); d2.position.set(-1, -0.6, 0.4); scene.add(d2);
  group = new THREE.Group(); scene.add(group);
  /* The drawer shell is a sibling of the bins, not a child, and that placement is
     load-bearing twice over. The hover raycast walks group.children, so a wall in
     there would be a hit to filter out on every mouse move — and a tooltip to lose
     the day somebody forgets the filter. And showScene() empties group on every
     edit, so a wall in there would be torn down and rebuilt because a bin moved. */
  drawerGroup = new THREE.Group(); scene.add(drawerGroup);
  /* Two-finger pinch to zoom. A touch screen has no wheel, and the expanded preview
     takes touch-action away from the canvas so a drag rotates instead of scrolling —
     which left no way to zoom at all on a phone. One finger rotates as before. */
  const pts = new Map();
  const gap = () => {
    const [a, b] = [...pts.values()];
    return Math.hypot(a[0] - b[0], a[1] - b[1]);
  };
  let pinch = null;
  canvas.addEventListener('pointerdown', (e) => {
    pts.set(e.pointerId, [e.clientX, e.clientY]);
    dragging = [e.clientX, e.clientY];
    /* Middle button, or shift with the left. preventDefault stops the browser's
       middle-click autoscroll, which otherwise takes over the drag entirely. */
    panning = e.button === 1 || e.shiftKey;
    if (e.button === 1) e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    if (pts.size === 2) { pinch = gap(); dragging = null; hideTip(); }
  });
  // the autoscroll cursor appears on the click that FOLLOWS the drag without this
  canvas.addEventListener('auxclick', (e) => { if (e.button === 1) e.preventDefault(); });
  const lift = (e) => {
    pts.delete(e.pointerId);
    if (pts.size === 0) panning = false;
    if (pts.size < 2) pinch = null;
    // re-seat on the finger still down, or the model jumps when the other lifts
    dragging = pts.size === 1 ? [...pts.values()][0].slice() : null;
  };
  canvas.addEventListener('pointerup', lift);
  canvas.addEventListener('pointercancel', lift);
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  canvas.addEventListener('pointermove', (e) => {
    if (pts.has(e.pointerId)) pts.set(e.pointerId, [e.clientX, e.clientY]);
    if (pts.size >= 2) {
      const g = gap();
      if (pinch > 0 && g > 0) {
        dist = Math.min(4000, Math.max(80, dist * (pinch / g)));
        render();
      }
      pinch = g;
      return;
    }
    if (dragging) {
      const dx = e.clientX - dragging[0], dy = e.clientY - dragging[1];
      if (panning) {
        /* Move the look-at point across the drawer floor, in the plane of the screen:
           dragging right carries the model right, so the target goes left. Scaled by
           distance so the model keeps up with the cursor at any zoom. */
        const k = dist * 0.0011;
        panX -= (dx * Math.sin(theta) + dy * Math.cos(theta)) * k;
        panZ += (dx * Math.cos(theta) - dy * Math.sin(theta)) * k;
      } else {
        theta -= dx * 0.01;
        phi = Math.min(3.11, Math.max(0.03, phi - dy * 0.01));
      }
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

/* ---------- the drawer around the bins ------------------------------------
   An open-topped box drawn around the design so you can judge whether the bins
   suit the drawer you actually own. It is a view and nothing else: no export, no
   print plan and no fit check reads any of it.

   Two decisions worth stating.

   The sides stand at `drawerH`, the usable height already on the page, rather than
   at a side measurement of their own. That number is measured from the same datum
   — the drawer floor — and it is what the "tallest stack vs available" check
   compares against, so drawing the walls anywhere else would let the picture and
   the check disagree: bins over the rim while Checks says it fits, or the reverse.
   The front is genuinely a second measurement, because a drawer front is routinely
   taller or lower than the sides it is screwed to, and that is the panel you reach
   over. Nothing else here is a new number.

   The walls sit at the drawer's inside dimensions, not the grid's. grid() floors
   the drawer to whole 42 mm cells, and the remainder it throws away is exactly the
   thing this feature exists to show — draw the walls on the grid and the margin
   vanishes, which is the one measurement you cannot get from the map. */
const DRAWER_T = 8;        // drawn wall thickness, mm — a drawer, not a sheet of foil
const DRAWER_FLOOR_T = 3;
/* The floor is dropped a hair below the baseplate rather than left touching it.
   Physically the plate sits on the drawer bottom, so the two faces are coincident,
   and coincident faces are the one thing that reliably flickers. Nobody can see
   0.4 mm at this scale; everybody can see z-fighting. */
const DRAWER_FLOOR_GAP = 0.4;
let drawerMat = null, drawerEdgeMat = null, drawerKey = '';

function drawerBox() {
  const g = grid();
  /* grid() forces at least one cell even in a drawer too small to hold one, so on
     that input the grid is bigger than the drawer. Clamp, or the walls close inside
     the bins and the picture is a lie in the other direction. */
  const W = Math.max(state.drawerW, g.nx * SPEC.pitch);
  const D = Math.max(state.drawerD, g.ny * SPEC.pitch);
  const side = Math.max(0, state.drawerH);
  return { W, D, side,
           // 0 means "same as the sides" — one fewer number to keep in step
           front: state.drawerFrontH > 0 ? state.drawerFrontH : side,
           floor: -state.plateH };   // y = 0 is the top of the baseplate
}

function syncDrawer() {
  const b = drawerBox();
  const key = state.showDrawer ? [b.W, b.D, b.side, b.front, b.floor].join('/') : '';
  // Built when its inputs change and never otherwise: render() runs on every drag
  // frame and every pinch, and showScene() runs on every edit to a bin.
  if (key === drawerKey) return;
  drawerKey = key;
  while (drawerGroup.children.length) drawerGroup.children.pop().geometry.dispose();
  if (!key) return;

  if (!drawerMat) {
    /* depthWrite off is what keeps this a window rather than a lid. The shell is
       drawn after the opaque bins and still depth-TESTED against them, so a wall
       behind a bin is hidden and a wall in front of one tints it instead of
       replacing it. It also settles the case where the drawer is an exact multiple
       of 42 mm: the wall's inner face then lands on the baseplate's edge, and two
       surfaces at the same depth only fight when both are writing. */
    drawerMat = new THREE.MeshLambertMaterial({
      color: 0x9fb4c6, transparent: true, opacity: 0.16,
      side: THREE.DoubleSide, depthWrite: false });
    drawerEdgeMat = new THREE.LineBasicMaterial({
      color: 0xcfe2f0, transparent: true, opacity: 0.45, depthWrite: false });
  }

  /* A box plus its own outline. At 16% opacity four flat panels read as haze; the
     edges are what make them read as a drawer. */
  const panel = (w, h, d, x, yBase, z) => {
    if (h <= 0) return;
    const geo = new THREE.BoxGeometry(w, h, d);
    const m = new THREE.Mesh(geo, drawerMat);
    m.position.set(x, yBase + h / 2, z);
    drawerGroup.add(m);
    const e = new THREE.LineSegments(new THREE.EdgesGeometry(geo), drawerEdgeMat);
    e.position.copy(m.position);
    drawerGroup.add(e);
  };

  const T = DRAWER_T, hw = b.W / 2, hd = b.D / 2;
  panel(b.W, DRAWER_FLOOR_T, b.D, 0,
        b.floor - DRAWER_FLOOR_GAP - DRAWER_FLOOR_T, 0);
  /* Side walls run the full outer depth and the front and back stop at the inside
     width, so the four abut instead of overlapping. Overlapping translucent panels
     double their tint, and the result is four dark posts at the corners of an
     otherwise even box. */
  panel(T, b.side, b.D + 2 * T, -(hw + T / 2), b.floor, 0);
  panel(T, b.side, b.D + 2 * T, hw + T / 2, b.floor, 0);
  panel(b.W, b.side, T, 0, b.floor, -(hd + T / 2));         // back
  // Front of the drawer is the bottom of the map, which is +z here — the same
  // convention seat/showScene use when they negate the grid's y.
  panel(b.W, b.front, T, 0, b.floor, hd + T / 2);
}

function showScene() {
  if (!renderer) return;
  while (group.children.length) group.remove(group.children[0]);
  const g = grid();
  const gw = g.nx * SPEC.pitch, gd = g.ny * SPEC.pitch;

  /* With nothing placed, the baseplate on its own is a featureless slab overflowing the
     panel in every direction — it looks like the renderer has failed rather than like an
     empty drawer. Say so instead. The drawer shell is exempt: if you have turned it on
     you have asked to look at the drawer, and an empty one is a real answer. */
  const empty = allBins().length === 0;
  const shell = !!state.showDrawer;
  /* The canvas stays visible and simply has nothing in it. Hiding it seemed tidier
     and broke the touch gestures: a hidden canvas takes no pointer events, so pinch
     and rotate had nothing to act on before the first bin was placed. */
  $('threeempty').style.display = empty && !shell ? '' : 'none';
  $('threehint').style.display = empty && !shell ? 'none' : '';
  /* Everything the tail of this function is responsible for has to happen before the
     return as well, and twice now it has not. syncDrawer is what tears the shell down
     when the toggle goes off, and skipping it left the drawer standing in an empty
     preview. The label is the third: written after the return, it never ran on an empty
     drawer, so the canvas kept the markup's "loading" text — and empty is where every
     visitor starts, so a screen reader was told the preview was still loading until the
     first bin went in. render() rather than a bare renderer.render for the same reason:
     it is what sizes the drawing buffer to the canvas and points the camera. */
  $('three').setAttribute('aria-label', sceneLabel(empty, shell, g));
  if (empty && !shell) { syncDrawer(); render(); return; }

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
  syncDrawer();
  render();
}
/* Same reasoning as the map's label: a <canvas> is a blank rectangle to anything that
   cannot see it, and this one carries the answer to "did that do what I meant". A
   summary, not a scene description — the shape of a bin is in the piece table.
   The empty case quotes #threeempty rather than paraphrasing it, so the sentence a
   screen reader gets and the sentence on the screen cannot drift apart. */
function sceneLabel(empty, shell, g) {
  if (empty && !shell)
    return `3D preview: empty. ${$('threeempty').textContent.trim()}`;
  if (empty)
    return `3D preview: the drawer, empty, around a ${g.nx} by ${g.ny} cell baseplate.`;
  return `3D preview: ${plural(allBins().length, 'bin')} over ${plural(layers.length, 'layer')} ` +
         `on a ${g.nx} by ${g.ny} cell baseplate, ` +
         `tallest stack ${stackHeight().toFixed(1)} millimetres.`;
}
function render() {
  if (!renderer) return;
  const wrap = $('threewrap');
  const w = wrap.clientWidth, h = wrap.clientHeight || 380;
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.updateProjectionMatrix();
  camera.position.set(panX + dist * Math.sin(phi) * Math.cos(theta),
                      30 + dist * Math.cos(phi),
                      panZ + dist * Math.sin(phi) * Math.sin(theta));
  camera.lookAt(panX, 20, panZ);
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
/* One bin type as an STL. Two places offer this — the row in "Bins to print" and the
   row in the download dialog — and they are the one pair that could give you two
   differently named files for the same click. */
function downloadType(t) {
  saveBlob(G.stlBinary(geomFor(t.b).polys, 'bin'), typeName(t) + '.stl');
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
      `${t.b.solid ? '  solid' : ''}${t.b.divX || t.b.divY ? `  ${(t.b.divX + 1) * (t.b.divY + 1)} compartments` : ''}` +
      // the README is read beside a pile of printed parts, which is exactly when
      // "1x1x3" stops being enough to tell them apart
      `${t.notes && t.notes.length ? `  — ${t.notes.join(', ')}` : ''}`);
  }
  L.push('');
  L.push(`Total: ${plural(allBins().length, 'bin')}, about ${(vol / 1000 * PLA_DENSITY).toFixed(0)} g of PLA.`);
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
  L.push('Layout link: ' + designLink());
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
const goodPlates = () =>
  printPlan ? printPlan.plates.map((p, i) => [p, i]).filter(([p]) => !p.overflow) : [];

/* Plates are numbered by position among the ones that fit, not by index in the raw
   list — everywhere. A bin too big for the bed gets a plate of its own that is never
   exported, and numbering around those produced a zip holding plate-1 and plate-3
   while the print plan on the page, and the per-plate downloads, both counted 1, 2, 3.
   The name is shared with the standalone download so the same plate arrives under the
   same name whichever row you clicked. */
const plateName = (k) => `bin-plate-${k + 1}.3mf`;
async function downloadPlate(k) {
  const good = goodPlates();
  if (!good[k]) return;
  saveBlob(await plate3mfBytes(good[k][1]), plateName(k));
}
async function downloadAllPlates() {
  const good = goodPlates();
  if (!good.length) return;
  if (good.length === 1) return downloadPlate(0);
  const zip = new JSZip();
  for (let k = 0; k < good.length; k++) zip.file(plateName(k), await plate3mfBytes(good[k][1]));
  saveBlobAsync(await zip.generateAsync({ type: 'blob' }),
                `drawerforge-bin-plates-x${good.length}.zip`);
}
async function downloadBinZip() {
  if (!allBins().length) return;
  const zip = new JSZip();
  for (const t of types())
    zip.file(typeName(t) + '.stl', G.stlBinary(geomFor(t.b).polys, 'bin'));
  zip.file('README.txt', layoutReadme());
  saveBlobAsync(await zip.generateAsync({ type: 'blob' }),
                `drawerforge-bins-${grid().nx}x${grid().ny}.zip`);
}
function saveBlobAsync(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
/* Cells in, millimetres out. The drawer size stays the one measurement the tool and
   the shared link are built on — a second stored dimension could disagree with the
   first — so these write it and then let everything recompute from there. A drawer of
   exactly n × 42 mm grids to n cells, which is what someone who owns an n-cell
   baseplate is telling us they have. */
for (const [id, field] of [['gridX', 'drawerW'], ['gridY', 'drawerD']])
  $(id).addEventListener('input', () => {
    const n = parseInt($(id).value, 10);
    if (!isFinite(n) || n < 1) return;      // mid-edit: an empty box is not a request
    $(field).value = (n * SPEC.pitch).toFixed(1).replace(/\.0$/, '');
    schedule();
  });
$('bedPreset').addEventListener('change', () => {
  const v = $('bedPreset').value;
  if (v === 'custom') return;
  const [w, d, h] = v.split(',');
  $('bedW').value = w; $('bedD').value = d; if (h) $('bedH').value = h;
  schedule();
});

/* ---------- the download dialog -------------------------------------------
   Built fresh every time it opens. A column of buttons tells you nothing about what
   comes out of them, so the dialog states what the design is, whether it fits the
   printer you configured, and then names every file with its size or its count. The
   row and group widgets are shared with the baseplates tool, in widgets.js.
   Nothing here needs the live re-render the baseplates dialog has: everything on this
   page is computed synchronously, and a modal makes the page behind it inert, so the
   layout cannot change while the dialog is open. */
const exGroup = (text) => DF.group($('exFiles'), text);
const exRow = (name, meta, label, onClick, attrs) =>
  DF.row($('exFiles'), { name, meta, label, onClick, attrs });

function bedFitText() {
  const bed = `${state.bedW} × ${state.bedD} mm bed`;
  const bins = allBins().map(({ b }) => b);
  if (!bins.length) return { cls: 'wait', t: 'No bins placed yet — drag across the drawer map to place one.' };
  const wide = bins.filter((b) => !fitsBed(b.u, b.v));
  const tall = bins.filter((b) => {
    const lip = (!b.solid && allFullEdges(b)) ? LIP_H : 0;
    return b.hUnits * SPEC.unitH + lip > state.bedH + 0.001;
  });
  if (!wide.length && !tall.length) {
    const w = Math.max(...bins.map((b) => footW(b.u))), d = Math.max(...bins.map((b) => footW(b.v)));
    const h = Math.max(...bins.map((b) => b.hUnits * SPEC.unitH +
      ((!b.solid && allFullEdges(b)) ? LIP_H : 0)));
    return { cls: 'ok', t: `Everything fits your ${bed}. The largest bin is ` +
      `${Math.max(w, d).toFixed(0)} × ${Math.min(w, d).toFixed(0)} mm and the tallest ` +
      `stands ${h.toFixed(1)} mm, inside your ${state.bedH} mm Z height.` };
  }
  const parts = [];
  if (wide.length) parts.push(`${plural(wide.length, 'bin')} ${wide.length > 1 ? 'are' : 'is'} too big for your ${bed}`);
  if (tall.length) parts.push(`${plural(tall.length, 'bin')} ${tall.length > 1 ? 'stand' : 'stands'} taller than your ${state.bedH} mm Z height`);
  return { cls: 'bad', t: parts.join(', and ') +
    '. Those are left off the print plates — Checks says what to do with each of them.' };
}

function renderExport() {
  const g = grid(), ts = types(), n = allBins().length;
  let vol = 0;
  for (const t of ts) vol += geomFor(t.b).vol * t.qty;
  $('exDesign').textContent = n
    ? `${g.nx} × ${g.ny} cell grid in a ${state.drawerW} × ${state.drawerD} mm drawer\n` +
      `${plural(n, 'bin')} of ${plural(ts.length, 'distinct type')} over ${plural(layers.length, 'layer')}\n` +
      `about ${(vol / 1000 * PLA_DENSITY).toFixed(0)} g of PLA at ${state.infill}% infill`
    : `${g.nx} × ${g.ny} cell grid in a ${state.drawerW} × ${state.drawerD} mm drawer — no bins in it yet`;
  const fit = bedFitText();
  $('exFit').className = 'exfit ' + fit.cls;
  $('exFit').textContent = fit.t;

  $('exFiles').innerHTML = '';
  const good = goodPlates();
  if (good.length) {
    exGroup('Pre-arranged print plates');
    exRow('Every plate', `${plural(good.length, 'plate')} · 3MF` + (good.length > 1 ? ' in a ZIP' : ''),
          'Download', downloadAllPlates, { 'data-ex': 'allplates' });
    /* Per-plate downloads. The combined export already builds each plate on its own
       and zips them, so one plate at a time is the same call with the zip left off —
       and it is what you want when a print fails, or when you are only doing one
       plate's worth this evening. */
    good.forEach(([pl], k) => exRow(`Plate ${k + 1}`,
      `${plural(pl.placed.length, 'bin')} on a ${state.bedW} × ${state.bedD} mm bed · 3MF`, 'Download',
      () => downloadPlate(k), { 'data-ex': 'plate' }));
  }
  if (ts.length) {
    exGroup('Meshes');
    exRow('Every bin type, with a README', `${plural(ts.length, 'STL file')} + README.txt · ZIP`,
          'Download', downloadBinZip, { 'data-ex': 'zip' });
    for (const t of ts)
      exRow(typeLabel(t),
            `${DF.bytes(DF.stlBytes(geomFor(t.b).polys))} · STL`, 'STL',
            () => downloadType(t), { 'data-ex': 'stl' });
  }
}
function updateExportTail() {
  const n = allBins().length, p = goodPlates().length;
  $('exportTail').textContent = n
    ? plural(n, 'bin') + (p ? ` · ${plural(p, 'plate')}` : '')
    : '';
}
$('openExport').addEventListener('click', () => {
  renderExport();
  const dlg = $('exportDlg');
  // showModal is the whole point — the fallback is for a browser old enough not to
  // have it, where an in-flow panel that closes is still better than a dead button
  if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
});
$('exportClose').addEventListener('click', () => $('exportDlg').close());
/* Click to dismiss, from the backdrop only. A click reports the common ancestor of its
   two ends, so selecting text in the summary and releasing outside the box reported the
   dialog itself and shut it — losing the selection and the dialog together. Both ends
   have to be the backdrop. */
let downOnBackdrop = false;
$('exportDlg').addEventListener('mousedown', (e) => { downOnBackdrop = e.target === $('exportDlg'); });
$('exportDlg').addEventListener('click', (e) => {
  if (downOnBackdrop && e.target === $('exportDlg')) $('exportDlg').close();
  downOnBackdrop = false;
});

/* ---------- shared project descriptor -------------------------------------- */
const KEYS = { w: 'drawerW', d: 'drawerD', dh: 'drawerH', ph: 'plateH',
               dfh: 'drawerFrontH' };
/* Keys that describe how the design is being LOOKED at rather than what it is. They
   travel in a shared link, because a link that does not reproduce what the sender saw
   is not much of a share — but they are struck out of the link the README carries.
   The README ships inside the download, so anything that reaches it turns a view
   toggle into a changed exported byte, and the drawer shell is not allowed to change
   one. See designLink(). */
const VIEW_KEYS = ['dv', 'dfh'];
// packing lives in bin.js so it can be tested headlessly
function descriptor() {
  const o = Object.assign({}, hashExtras, { v: 2 });
  for (const [k, id] of Object.entries(KEYS)) o[k] = state[id];
  o.dv = state.showDrawer ? 1 : 0;
  o.bl = packLayers(layers);
  o.bseg = state.arcSegs;
  const notes = layers.map((L) => L.bins.map((b) => b.note || ''));
  if (notes.some((L) => L.some((n) => n))) o.bnotes = JSON.stringify(notes);
  return o;
}
const encodeDesc = (o) => Object.entries(o).map(([k, x]) => `${k}=${encodeURIComponent(x)}`).join('&');
/* Keep the address bar holding the current design, so a reload does not throw it away.
 *
 * The tool has no accounts and no server, which is the point of it — but it also meant
 * a refresh, a crashed tab or a mistyped URL lost a drawer someone had spent twenty
 * minutes laying out, with a "Copy settings link" button they had to have known to
 * press first. The state was already serialisable: this writes the same string that
 * button copies, so persistence and sharing cannot drift apart.
 *
 * replaceState rather than pushState: the design is not a sequence of pages, and a
 * history entry per edit would turn the back button into an undo nobody asked for and
 * make leaving the page take fifty presses. It does not fire hashchange, so nothing
 * here can feed back into loadFromHash.
 *
 * The hashReady guard is honest belt-and-braces, and worth saying so plainly: as the
 * init order stands, nothing CAN write before loadFromHash has run — the only callers
 * are recomputeLayout/refresh, both of which run after it, and the write is debounced
 * behind them anyway. Removing the guard breaks no test, because there is no test that
 * can distinguish it. It stays because the failure it prevents is silent and expensive:
 * a save landing before the load would replace a link someone had just followed with
 * this page's defaults, and neither they nor the person who sent it would ever know
 * they were looking at a different drawer. If you reorder init, this is the line that
 * stops that being your problem.
 */
let hashSaveT = 0, hashReady = false;
/* Kept on this browser, so the work survives arriving without a link.
 *
 * The address bar already carries the design and a refresh already restores it. What it
 * cannot do is help someone who types the domain, or opens a bookmark of the bare site:
 * no hash, nothing to read, and the drawer they spent twenty minutes on is gone. This
 * covers that, and only that.
 *
 * It saves the SAME string the link carries, so there is one serialisation to keep
 * right rather than two that can disagree — the format is already round-tripped by
 * test/hash-roundtrip.js.
 *
 * A link always wins. Someone following a shared layout must see the sender's drawer and
 * not their own, and the person who sent it would never know if they did not.
 *
 * Saved automatically rather than behind a Save button. A button you have to remember to
 * press does not protect you from the case this exists for, which is closing a tab
 * without thinking about it. The cost is that a restore could be a surprise, so it says
 * when it has done one and offers a way back.
 */
const SAVE_KEY = 'drawerforge:bins:v1';
const saveLocal = (h) => {
  try { localStorage.setItem(SAVE_KEY, h); }
  catch (err) { /* private mode, or the quota is full — losing the save is not worth
                   an exception that stops the page working */ }
};
const readLocal = () => { try { return localStorage.getItem(SAVE_KEY) || ''; } catch (err) { return ''; } };
function startFresh() {
  try { localStorage.removeItem(SAVE_KEY); } catch (err) { /* nothing to clear */ }
  location.href = location.origin + location.pathname;   // drop the hash and reload clean
}

function rememberState() {
  if (!hashReady) return;
  clearTimeout(hashSaveT);
  hashSaveT = setTimeout(() => {
    const h = encodeDesc(descriptor());
    try { history.replaceState(null, '', '#' + h); }
    catch (err) { /* some browsers refuse replaceState on file:// — a lost URL is not
                     worth an exception that stops the rest of the page working */ }
    saveLocal(h);   // outside the try: a refused URL is no reason to lose the save too
  }, 400);
}
function shareLink() {
  return location.origin + location.pathname + '#' + encodeDesc(descriptor());
}
// the same layout with the view stripped, so the README's bytes depend on the design
function designLink() {
  const o = descriptor();
  for (const k of VIEW_KEYS) delete o[k];
  return location.origin + location.pathname + '#' + encodeDesc(o);
}
function loadFromHash(src) {
  const h = (src !== undefined ? src : location.hash || '').replace(/^#/, '');
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
    // a checkbox, so it cannot ride the generic .value path below
    if (k === 'dv') { $('showDrawer').checked = val === '1'; continue; }
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
                  'edgeF', 'edgeB', 'edgeL', 'edgeR', 'scoop', 'label', 'note'])
  $(id).addEventListener('input', schedule);
for (const id of ['edgeF', 'edgeB', 'edgeL', 'edgeR'])
  $(id).addEventListener('change', schedule);
$('presetTray').addEventListener('click', () => {
  for (const id of ['edgeF', 'edgeB', 'edgeL', 'edgeR']) $(id).value = '0';
  $('solid').checked = false;
  readControls(); geoCache.clear(); drawMap(); refresh();
});
$('solid').addEventListener('change', schedule);
$('arcSegs').addEventListener('change', schedule);
/* The drawer shell deliberately does not go through schedule(). That path clears the
   geometry cache and rebuilds every bin mesh, which is the right thing for anything
   that changes what gets printed and pure waste for something that changes only what
   is drawn around it. */
const drawerViewChanged = () => { readControls(); showScene(); };
for (const id of ['showDrawer', 'drawerFrontH']) {
  $(id).addEventListener('input', drawerViewChanged);
  $(id).addEventListener('change', drawerViewChanged);
}
/* The handler is on the <button> inside the header, not on the <h2>.
   A bare heading with a click listener is only a control for a mouse, and because a
   closed panel's body is display:none there was nothing focusable inside it either —
   so panels 01 and 02, which load closed, put the drawer size and the printer bed
   beyond a keyboard entirely. There was no route to them at all, not a slow one.
   aria-expanded is written from the class rather than kept alongside it, so the two
   cannot drift: the class is what actually shows the panel. */
for (const btn of document.querySelectorAll('section.p>h2>button')) {
  const sec = btn.closest('section.p');
  btn.addEventListener('click', () => {
    btn.setAttribute('aria-expanded', String(!sec.classList.toggle('closed')));
  });
}

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

/* A link beats a saved layout, always. Reading the hash first and only falling back
   means a shared drawer is never quietly replaced by the recipient's own. */
const incomingHash = (location.hash || '').replace(/^#/, '');
if (incomingHash.length > 2) loadFromHash();
else {
  const saved = readLocal();
  if (saved.length > 2) { loadFromHash(saved); $('restored').style.display = ''; }
}
if (pendingNotes) {                       // applied after the layout so indices line up
  try {
    JSON.parse(pendingNotes).forEach((ns, k) =>
      ns.forEach((n, i) => { if (layers[k] && layers[k].bins[i]) layers[k].bins[i].note = n; }));
  } catch (err) { /* a mangled link should not stop the tool loading */ }
}
readControls();
hashReady = true;                         // loadFromHash has had its say; ours may start
initThree();
initMap();
drawLayerTabs();
drawMap();
refresh();
updateUndoButtons();

/* Applied straight to the selection rather than through readControls, for the reason
   given where doneRow is hidden: readControls also writes `state`, the template for the
   next bin you draw. */
$('done').addEventListener('change', () => {
  for (const i of selAll()) B()[i].done = $('done').checked;
  pushUndo(); drawMap(); refresh();
});
const markAll = (v) => () => {
  for (const L of layers) for (const b of L.bins) b.done = v;
  pushUndo(); drawMap(); refresh();
};
$('markAllDone').addEventListener('click', markAll(true));
$('markNoneDone').addEventListener('click', markAll(false));

if ($('startFresh')) $('startFresh').addEventListener('click', startFresh);

/* A hash this page did not write means someone navigated to a link — pasted a share URL
   into the address bar, or picked a bookmark — and changing only the fragment is a
   same-document navigation, so nothing re-reads it and the drawer on screen stays put.
   Before local saving that was merely confusing; now it means a shared layout loses to
   whatever this browser had stored, which is the one case that must never happen.
   Reloading applies the link. replaceState does not fire this event, so the saves this
   page makes every few seconds cannot trigger it. */
addEventListener('hashchange', () => location.reload());

