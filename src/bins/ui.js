/* Drawerforge Bins UI. Core geometry and buildBin are in scope from the previous
   script tags (both end with a module.exports guard, so in the browser their
   functions land as globals). */
'use strict';

const $ = (id) => document.getElementById(id);
const SVGNS = 'http://www.w3.org/2000/svg';

const G = {
  makePoly, triangulateRing, extrudePoly, clampZ,
  polysToTriangles, stlBinary, checkManifold,
};

const PLA_DENSITY = 1.24;   // g/cm3
const S = 40;               // map cell size, svg units

const state = {};           // drawer + defaults for new bins
let layers = [{ bins: [] }];
let cur = 0;                // layer being edited, 0 = sitting on the baseplate
let selected = -1;
let hashExtras = {};
const geoCache = new Map();

const B = () => layers[cur].bins;
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
                         solid: b.solid, edges: b.edges, arcSegs: state.arcSegs });
const edgeSig = (b) => EDGES.map((k) => (b.edges && b.edges[k] !== undefined ? b.edges[k] : 1)).join(',');
const allFullEdges = (b) => EDGES.every((k) => !b.edges || b.edges[k] === undefined || b.edges[k] >= 1);
const typeKey = (b) => `${b.u}x${b.v}x${b.hUnits}` +
  (b.solid ? '-solid' : `-w${b.wall}-f${b.floorT}` +
   (b.divX || b.divY ? `-d${b.divX}.${b.divY}` : '') +
   (allFullEdges(b) ? '' : `-e${edgeSig(b)}`));

function occupancyOf(k) {
  const g = grid();
  const occ = Array.from({ length: g.ny }, () => new Array(g.nx).fill(-1));
  (layers[k] ? layers[k].bins : []).forEach((b, i) => {
    for (let dy = 0; dy < b.v; dy++)
      for (let dx = 0; dx < b.u; dx++) {
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
const allBins = () => layers.flatMap((L, k) => L.bins.map((b) => ({ b, k })));

/* ---------- geometry + volume --------------------------------------------- */
function geomFor(b) {
  const k = typeKey(b) + '-s' + state.arcSegs;
  if (geoCache.has(k)) return geoCache.get(k);
  const r = buildBin(G, binCfg(b));
  r.vol = volumeMm3(b);
  geoCache.set(k, r);
  return r;
}
function areaRR(hw, hd, r) { return 4 * hw * hd - (4 - Math.PI) * r * r; }
function volumeMm3(c) {
  const half = SPEC.half, C = SPEC.centre;
  const hwO = (c.u - 1) * SPEC.pitch / 2 + half;
  const hdO = (c.v - 1) * SPEC.pitch / 2 + half;
  const H = c.hUnits * SPEC.unitH, floorZ = SPEC.footH + c.floorT;
  let footV = 0;
  const N = 60;
  for (let i = 0; i < N; i++) {
    const z = SPEC.footH * (i + 0.5) / N;
    let h = SPEC.prof[SPEC.prof.length - 1][1];
    for (let q = 0; q < SPEC.prof.length - 1; q++) {
      const [z0, h0] = SPEC.prof[q], [z1, h1] = SPEC.prof[q + 1];
      if (z >= z0 && z <= z1) { h = h0 + (h1 - h0) * (z1 > z0 ? (z - z0) / (z1 - z0) : 0); break; }
    }
    footV += areaRR(h, h, h - C) * (SPEC.footH / N);
  }
  footV *= c.u * c.v;
  const lipV = areaRR(hwO, hdO, SPEC.r) * 0.35 * LIP_H / 1.9;   // thin tapering rim
  if (c.solid || floorZ >= H - 0.2)
    return footV + areaRR(hwO, hdO, SPEC.r) * (H - SPEC.footH) + lipV;
  const slab = areaRR(hwO, hdO, SPEC.r) * c.floorT;
  const hwI = hwO - c.wall, hdI = hdO - c.wall;
  const walls = (areaRR(hwO, hdO, SPEC.r) - areaRR(hwI, hdI, Math.max(0.4, SPEC.r - c.wall)))
                * (H - floorZ);
  const e = (k) => (c.edges && c.edges[k] !== undefined ? Math.max(0, Math.min(1, c.edges[k])) : 1);
  const perim = 4 * hwO + 4 * hdO;
  const wallFrac = (e('f') * 2 * hwO + e('b') * 2 * hwO + e('l') * 2 * hdO + e('r') * 2 * hdO) / perim;
  const divs = (c.divX * c.wall * 2 * hdI + c.divY * c.wall * 2 * hwI) * (H - floorZ);
  return footV + slab + walls * wallFrac + divs + (allFullEdges(c) ? lipV : 0);
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

  const t = {
    u: Math.max(1, int('u', 1)), v: Math.max(1, int('v', 1)),
    hUnits: Math.max(1, int('hUnits', 3)),
    wall: num('wall', 1.2), floorT: num('floorT', 1.2),
    divX: Math.max(0, int('divX', 0)), divY: Math.max(0, int('divY', 0)),
    solid: $('solid').checked,
    edges: { f: parseFloat($('edgeF').value), b: parseFloat($('edgeB').value),
             l: parseFloat($('edgeL').value), r: parseFloat($('edgeR').value) },
  };
  if (selected >= 0 && B()[selected]) {
    const b = B()[selected];
    if ((t.u !== b.u || t.v !== b.v) && !canPlace(b.x, b.y, t.u, t.v, selected)) {
      t.u = b.u; t.v = b.v; $('u').value = b.u; $('v').value = b.v;
    }
    Object.assign(b, t);
  } else {
    Object.assign(state, t);
  }
  $('thickRow').style.display = t.solid ? 'none' : '';
  $('divRow').style.display = t.solid ? 'none' : '';
  $('edgeRowA').style.display = t.solid ? 'none' : '';
  $('edgeRowB').style.display = t.solid ? 'none' : '';
  $('edgeHint').style.display = t.solid ? 'none' : '';
  $('presetTray').style.display = t.solid ? 'none' : '';
  $('selActions').style.display = selected >= 0 ? '' : 'none';
  $('binPanelTitle').textContent = selected >= 0 ? 'Selected bin' : 'New bins';
  $('fillSize').textContent = `${state.u}×${state.v}`;
  $('delLayer').style.display = layers.length > 1 ? '' : 'none';
}
function writeControls(src) {
  $('u').value = src.u; $('v').value = src.v; $('hUnits').value = src.hUnits;
  $('wall').value = src.wall; $('floorT').value = src.floorT;
  $('divX').value = src.divX; $('divY').value = src.divY;
  $('solid').checked = !!src.solid;
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
      cur = i; selected = -1; readControls(); drawLayerTabs(); drawMap(); refresh();
    });
    bar.appendChild(b);
  });
}
$('addLayer').addEventListener('click', () => {
  layers.push({ bins: [] });
  cur = layers.length - 1; selected = -1;
  readControls(); drawLayerTabs(); drawMap(); refresh();
});
$('delLayer').addEventListener('click', () => {
  if (layers.length < 2) return;
  layers.splice(cur, 1);
  cur = Math.min(cur, layers.length - 1); selected = -1;
  readControls(); drawLayerTabs(); drawMap(); refresh();
});

/* ---------- the map ------------------------------------------------------- */
let drag = null;
function drawMap() {
  const g = grid(), svg = $('fillmap');
  const W = g.nx * S, H = g.ny * S;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
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
    const st = seat(b, cur);
    const bad = !st.solidBelow || !st.flat ||
      st.z + b.hUnits * SPEC.unitH + LIP_H > g.avail + 0.001;
    const r = el('rect', { class: 'bin' + (i === selected ? ' sel' : '') + (bad ? ' clash' : ''),
      x: b.x * S + 2, y: sy(b.y, b.v) + 2, width: b.u * S - 4, height: b.v * S - 4, rx: 5 });
    r.dataset.i = i;
    svg.appendChild(r);
    const cx = (b.x + b.u / 2) * S, cy = sy(b.y, b.v) + b.v * S / 2;
    const t1 = el('text', { class: 'blabel', x: cx, y: cy - 2, 'text-anchor': 'middle' });
    t1.textContent = `${b.u}×${b.v}`;
    const t2 = el('text', { class: 'bsub', x: cx, y: cy + 12, 'text-anchor': 'middle' });
    t2.textContent = `${b.hUnits}u · ${b.hUnits * SPEC.unitH}mm`;
    svg.appendChild(t1); svg.appendChild(t2);
  });

  if (drag) {
    const x = Math.min(drag.x0, drag.x1), y = Math.min(drag.y0, drag.y1);
    const u = Math.abs(drag.x1 - drag.x0) + 1, v = Math.abs(drag.y1 - drag.y0) + 1;
    svg.appendChild(el('rect', { class: 'drag' + (canPlace(x, y, u, v, -1) ? '' : ' bad'),
      x: x * S + 1, y: sy(y, v) + 1, width: u * S - 2, height: v * S - 2, rx: 5 }));
  }
}
function cellFromEvent(e) {
  const g = grid(), r = $('fillmap').getBoundingClientRect();
  const x = Math.floor((e.clientX - r.left) / r.width * g.nx);
  const yTop = Math.floor((e.clientY - r.top) / r.height * g.ny);
  return { x: Math.max(0, Math.min(g.nx - 1, x)),
           y: Math.max(0, Math.min(g.ny - 1, g.ny - 1 - yTop)) };
}
function initMap() {
  const svg = $('fillmap');
  svg.addEventListener('pointerdown', (e) => {
    const c = cellFromEvent(e), occ = occupancy();
    const hit = occ[c.y][c.x];
    if (hit !== -1) {
      selected = hit; writeControls(B()[hit]);
      readControls(); drawMap(); refresh();
      return;
    }
    selected = -1;
    drag = { x0: c.x, y0: c.y, x1: c.x, y1: c.y };
    if (svg.setPointerCapture) svg.setPointerCapture(e.pointerId);
    readControls(); drawMap();
  });
  svg.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const c = cellFromEvent(e);
    if (c.x === drag.x1 && c.y === drag.y1) return;
    drag.x1 = c.x; drag.y1 = c.y; drawMap();
  });
  svg.addEventListener('pointerup', () => {
    if (!drag) return;
    const x = Math.min(drag.x0, drag.x1), y = Math.min(drag.y0, drag.y1);
    const u = Math.abs(drag.x1 - drag.x0) + 1, v = Math.abs(drag.y1 - drag.y0) + 1;
    if (canPlace(x, y, u, v, -1)) {
      B().push({ x, y, u, v, hUnits: state.hUnits, wall: state.wall,
                 floorT: state.floorT, divX: state.divX, divY: state.divY,
                 solid: state.solid, edges: Object.assign({}, state.edges) });
      selected = B().length - 1;
      writeControls(B()[selected]);
    }
    drag = null;
    readControls(); drawLayerTabs(); drawMap(); refresh();
  });
}

/* ---------- actions ------------------------------------------------------- */
$('fillRest').addEventListener('click', () => {
  const g = grid();
  selected = -1; readControls();
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
                   solid: state.solid, edges: Object.assign({}, state.edges) });
        break;
      }
    }
  drawLayerTabs(); drawMap(); refresh();
});
$('clearAll').addEventListener('click', () => {
  layers[cur].bins = []; selected = -1;
  readControls(); drawLayerTabs(); drawMap(); refresh();
});
$('delBin').addEventListener('click', () => {
  if (selected < 0) return;
  B().splice(selected, 1); selected = -1;
  readControls(); drawLayerTabs(); drawMap(); refresh();
});
$('applyAll').addEventListener('click', () => {
  if (selected < 0) return;
  const s = B()[selected];
  for (const b of B()) Object.assign(b, {
    hUnits: s.hUnits, wall: s.wall, floorT: s.floorT,
    divX: s.divX, divY: s.divY, solid: s.solid,
    edges: Object.assign({}, s.edges) });
  drawMap(); refresh();
});

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
    out.push({ err: true, t: `The tallest stack is ${tot.toFixed(1)} mm but only ${g.avail.toFixed(1)} mm is available above the baseplate. Reduce a layer's height or remove a layer.` });
  else if (tot > 0)
    out.push({ t: `Tallest stack ${tot.toFixed(1)} mm of ${g.avail.toFixed(1)} mm available — ${(g.avail - tot).toFixed(1)} mm spare (includes the ${LIP_H.toFixed(2)} mm top lip).` });

  for (let k = 1; k < layers.length; k++)
    for (const b of layers[k].bins) {
      const st = seat(b, k);
      if (!st.solidBelow)
        out.push({ err: true, t: `Layer ${k + 1}: a ${b.u}×${b.v} bin overhangs a cell with nothing under it. Bins can only sit on a continuous stack.` });
      else if (!st.flat)
        out.push({ err: true, t: `Layer ${k + 1}: a ${b.u}×${b.v} bin spans bins of different heights below, so it would rock. Level the layer beneath it.` });
      else {
        const occB = occupancyOf(k - 1);
        const below = new Set();
        for (let dy = 0; dy < b.v; dy++)
          for (let dx = 0; dx < b.u; dx++) below.add(occB[b.y + dy][b.x + dx]);
        const noLip = [...below].map((i) => layers[k - 1].bins[i])
                                .filter((bb) => bb && !allFullEdges(bb));
        if (noLip.length)
          out.push({ err: true, t: `Layer ${k + 1}: a ${b.u}×${b.v} bin sits on a bin with a lowered or open wall. That bin has no stacking lip, so there is nothing to hold this one — it would sit on bare wall tops.` });
        if (below.size === 1) {
          const bb = layers[k - 1].bins[[...below][0]];
          if (bb && (bb.u !== b.u || bb.v !== b.v || bb.x !== b.x || bb.y !== b.y))
            out.push({ t: `Layer ${k + 1}: a ${b.u}×${b.v} bin sits on a ${bb.u}×${bb.v}. It will seat but only the matching edges are located by the lip — it can slide along the rest.` });
        } else if (below.size > 1) {
          out.push({ t: `Layer ${k + 1}: a ${b.u}×${b.v} bin spans ${below.size} bins below. It rests level but nothing locates it sideways.` });
        }
      }
    }

  const thin = allBins().filter(({ b }) => !b.solid && b.wall < 0.8);
  if (thin.length)
    out.push({ t: `${thin.length} bin(s) have walls under 0.8 mm — thinner than two perimeters at a 0.4 mm nozzle.` });
  const oob = allBins().filter(({ b }) => b.x + b.u > g.nx || b.y + b.v > g.ny);
  if (oob.length)
    out.push({ err: true, t: `${oob.length} bin(s) now fall outside the grid — the drawer got smaller. Delete them or clear the layout.` });
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
  $('gridSummary').textContent =
    `Grid: ${g.nx} × ${g.ny} cells · ${g.avail.toFixed(1)} mm above the baseplate · tallest single bin ${g.maxUnits} units (${g.maxUnits * SPEC.unitH} mm + lip)`;
  const src = selected >= 0 && B()[selected] ? B()[selected] : state;
  $('binSizeHint').textContent =
    `${(src.u * SPEC.pitch - 0.5).toFixed(1)} × ${(src.v * SPEC.pitch - 0.5).toFixed(1)} × ${(src.hUnits * SPEC.unitH).toFixed(1)} mm (+${LIP_H.toFixed(2)} lip)`;

  const used = B().reduce((a, b) => a + b.u * b.v, 0);
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
    ? `${allBins().length} bins · ${ts.length} distinct type(s) · ${(vol / 1000).toFixed(0)} cm³ ≈ ${(vol / 1000 * PLA_DENSITY).toFixed(0)} g PLA`
    : '—';

  drawWarnings();
  showScene();
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
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    theta -= (e.clientX - dragging[0]) * 0.01;
    phi = Math.min(3.11, Math.max(0.03, phi - (e.clientY - dragging[1]) * 0.01));
    dragging = [e.clientX, e.clientY]; render();
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    dist = Math.min(4000, Math.max(80, dist * (1 + Math.sign(e.deltaY) * 0.12)));
    render();
  }, { passive: false });
  window.addEventListener('resize', render);
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
      color: MATS[k % MATS.length], side: THREE.DoubleSide, flatShading: true,
      transparent: k > cur, opacity: k > cur ? 0.55 : 1 });
    for (const b of L.bins) {
      const m = new THREE.Mesh(geoOf(b), matCache[k]);
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
    L.push('');
  });
  L.push('ASSEMBLY: lay layer 1 into the baseplate, then drop each higher layer into');
  L.push('the stacking lips of the bins below it.');
  L.push('');
  L.push('PRINTING: flat as oriented, no supports. Print one bin and check it seats');
  L.push('in your baseplate before committing to the whole drawer.');
  L.push('');
  L.push('Layout link: ' + shareLink());
  return L.join('\n');
}
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
const packLayer = (L) => L.bins.map((b) =>
  [b.x, b.y, b.u, b.v, b.hUnits, b.wall, b.floorT, b.divX, b.divY, b.solid ? 1 : 0]
    .concat(EDGES.map((k) => (b.edges && b.edges[k] !== undefined ? b.edges[k] : 1))).join('.')).join('_');
const packAll = () => layers.map(packLayer).join('~');
function unpackAll(s) {
  return (s || '').split('~').map((ls) => ({
    bins: ls.split('_').filter(Boolean).map((t) => {
      const p = t.split('.').map(Number);
      const ed = {};
      EDGES.forEach((k, i) => { ed[k] = p.length > 10 + i && isFinite(p[10 + i]) ? p[10 + i] : 1; });
      return { x: p[0], y: p[1], u: p[2], v: p[3], hUnits: p[4],
               wall: p[5], floorT: p[6], divX: p[7], divY: p[8], solid: !!p[9], edges: ed };
    }),
  }));
}
function shareLink() {
  const o = Object.assign({}, hashExtras, { v: 2 });
  for (const [k, id] of Object.entries(KEYS)) o[k] = state[id];
  o.bl = packAll();
  o.bseg = state.arcSegs;
  return location.origin + location.pathname + '#' +
    Object.entries(o).map(([k, x]) => `${k}=${encodeURIComponent(x)}`).join('&');
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
    if (k === 'bl') { const ls = unpackAll(val); if (ls.length) layers = ls; continue; }
    if (k === 'bseg') { $('arcSegs').value = val; continue; }
    const id = KEYS[k];
    if (!id) { hashExtras[k] = val; continue; }
    if ($(id)) $(id).value = val;
  }
}
$('shareBtn').addEventListener('click', () => {
  const link = shareLink();
  navigator.clipboard.writeText(link).then(
    () => { $('shareBtn').textContent = 'Copied ✓'; setTimeout(() => $('shareBtn').textContent = 'Copy layout link', 1600); },
    () => prompt('Copy this link:', link));
});
$('toPlates').addEventListener('click', (e) => {
  e.preventDefault();
  const o = Object.assign({}, hashExtras, { v: 2, w: state.drawerW, d: state.drawerD,
                                            dh: state.drawerH, ph: state.plateH });
  location.href = '../#' + Object.entries(o).map(([k, x]) => `${k}=${encodeURIComponent(x)}`).join('&');
});

/* ---------- boot ---------------------------------------------------------- */
let timer = null;
const schedule = () => { clearTimeout(timer); timer = setTimeout(() => {
  readControls(); geoCache.clear(); drawLayerTabs(); drawMap(); refresh(); }, 180); };
for (const id of ['drawerW', 'drawerD', 'drawerH', 'plateH', 'u', 'v', 'hUnits',
                  'wall', 'floorT', 'divX', 'divY', 'solid', 'arcSegs',
                  'edgeF', 'edgeB', 'edgeL', 'edgeR'])
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
for (const s of document.querySelectorAll('section.p h2'))
  s.addEventListener('click', () => s.parentElement.classList.toggle('closed'));

loadFromHash();
readControls();
initThree();
initMap();
drawLayerTabs();
drawMap();
refresh();
