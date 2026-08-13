/* Drawerforge Bins UI. Core geometry and buildBin are in scope from the previous
   script tags (both end with a module.exports guard, so in the browser their
   functions land as globals). */
'use strict';

const $ = (id) => document.getElementById(id);
const SVGNS = 'http://www.w3.org/2000/svg';

// the shared-core surface buildBin needs, gathered from the globals core.js defines
const G = {
  makePoly, triangulateRing, extrudePoly, clampZ,
  polysToTriangles, stlBinary, checkManifold,
};

const PLA_DENSITY = 1.24;   // g/cm3
const S = 40;               // map cell size, svg units

const state = {};           // drawer + defaults for new bins
let bins = [];              // [{x,y,u,v,hUnits,wall,floorT,divX,divY,solid}]
let selected = -1;
let hashExtras = {};        // descriptor keys we don't own — re-emitted untouched
const geoCache = new Map(); // typeKey -> { polys, meta, vol }

/* ---------- model --------------------------------------------------------- */
function grid() {
  const nx = Math.max(1, Math.floor(state.drawerW / SPEC.pitch));
  const ny = Math.max(1, Math.floor(state.drawerD / SPEC.pitch));
  const avail = state.drawerH - state.plateH;
  return { nx, ny, avail, maxUnits: Math.max(1, Math.floor(avail / SPEC.unitH)) };
}
const binCfg = (b) => ({ u: b.u, v: b.v, hUnits: b.hUnits, wall: b.wall,
                         floorT: b.floorT, divX: b.divX, divY: b.divY,
                         solid: b.solid, arcSegs: state.arcSegs });
const typeKey = (b) => `${b.u}x${b.v}x${b.hUnits}` +
  (b.solid ? '-solid' : `-w${b.wall}-f${b.floorT}` +
   (b.divX || b.divY ? `-d${b.divX}.${b.divY}` : ''));

function occupancy() {
  const g = grid();
  const occ = Array.from({ length: g.ny }, () => new Array(g.nx).fill(-1));
  bins.forEach((b, i) => {
    for (let dy = 0; dy < b.v; dy++)
      for (let dx = 0; dx < b.u; dx++) {
        const x = b.x + dx, y = b.y + dy;
        if (y >= 0 && y < g.ny && x >= 0 && x < g.nx) occ[y][x] = i;
      }
  });
  return occ;
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

/* ---------- geometry cache ------------------------------------------------ */
function geomFor(b) {
  const k = typeKey(b) + '-s' + state.arcSegs;
  if (geoCache.has(k)) return geoCache.get(k);
  const r = buildBin(G, binCfg(b));
  r.vol = volumeMm3(b);
  geoCache.set(k, r);
  return r;
}

/* ---------- analytic volume ----------------------------------------------
   From the parameters, never from mesh volume: the geometry is deliberately
   overlapping shells, so summing tetrahedra double-counts. */
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
    for (let k = 0; k < SPEC.prof.length - 1; k++) {
      const [z0, h0] = SPEC.prof[k], [z1, h1] = SPEC.prof[k + 1];
      if (z >= z0 && z <= z1) { h = h0 + (h1 - h0) * (z1 > z0 ? (z - z0) / (z1 - z0) : 0); break; }
    }
    footV += areaRR(h, h, h - C) * (SPEC.footH / N);
  }
  footV *= c.u * c.v;
  if (c.solid || floorZ >= H - 0.2)
    return footV + areaRR(hwO, hdO, SPEC.r) * (H - SPEC.footH);
  const slab = areaRR(hwO, hdO, SPEC.r) * c.floorT;
  const hwI = hwO - c.wall, hdI = hdO - c.wall;
  const walls = (areaRR(hwO, hdO, SPEC.r) - areaRR(hwI, hdI, Math.max(0.4, SPEC.r - c.wall)))
                * (H - floorZ);
  const divs = (c.divX * c.wall * 2 * hdI + c.divY * c.wall * 2 * hwI) * (H - floorZ);
  return footV + slab + walls + divs;
}

/* ---------- controls ------------------------------------------------------ */
function readControls() {
  const num = (id, d) => { const x = parseFloat($(id).value); return isFinite(x) ? x : d; };
  const int = (id, d) => { const x = parseInt($(id).value, 10); return isFinite(x) ? x : d; };
  state.drawerW = num('drawerW', 306);
  state.drawerD = num('drawerD', 380);
  state.drawerH = num('drawerH', 93.9);
  state.plateH = num('plateH', 4.25);
  state.arcSegs = int('arcSegs', 12);

  const t = {
    u: Math.max(1, int('u', 1)), v: Math.max(1, int('v', 1)),
    hUnits: Math.max(1, int('hUnits', 3)),
    wall: num('wall', 1.2), floorT: num('floorT', 1.2),
    divX: Math.max(0, int('divX', 0)), divY: Math.max(0, int('divY', 0)),
    solid: $('solid').checked,
  };
  if (selected >= 0 && bins[selected]) {
    const b = bins[selected];
    // resizing a placed bin only takes if it still fits
    if ((t.u !== b.u || t.v !== b.v) && !canPlace(b.x, b.y, t.u, t.v, selected)) {
      t.u = b.u; t.v = b.v;
      $('u').value = b.u; $('v').value = b.v;
    }
    Object.assign(b, t);
  } else {
    Object.assign(state, t);
  }
  $('thickRow').style.display = t.solid ? 'none' : '';
  $('divRow').style.display = t.solid ? 'none' : '';
  $('selActions').style.display = selected >= 0 ? '' : 'none';
  $('sizeRow').style.display = '';
  $('binPanelTitle').textContent = selected >= 0 ? `Selected bin` : 'New bins';
  $('fillSize').textContent = `${state.u}×${state.v}`;
}
function writeControls(src) {
  $('u').value = src.u; $('v').value = src.v; $('hUnits').value = src.hUnits;
  $('wall').value = src.wall; $('floorT').value = src.floorT;
  $('divX').value = src.divX; $('divY').value = src.divY;
  $('solid').checked = !!src.solid;
}

/* ---------- the map ------------------------------------------------------- */
let drag = null;   // {x0,y0,x1,y1}
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
  for (let y = 0; y < g.ny; y++)
    for (let x = 0; x < g.nx; x++)
      svg.appendChild(el('rect', { class: 'cell' + (occ[y][x] === -1 ? ' free' : ''),
        x: x * S, y: sy(y, 1), width: S, height: S }));

  bins.forEach((b, i) => {
    const cls = 'bin' + (i === selected ? ' sel' : '') +
      (b.hUnits * SPEC.unitH > g.avail + 0.001 ? ' clash' : '');
    const r = el('rect', { class: cls, x: b.x * S + 2, y: sy(b.y, b.v) + 2,
      width: b.u * S - 4, height: b.v * S - 4, rx: 5 });
    r.dataset.i = i;
    svg.appendChild(r);
    const cx = (b.x + b.u / 2) * S, cy = sy(b.y, b.v) + b.v * S / 2;
    const t1 = el('text', { class: 'blabel', x: cx, y: cy - 2, 'text-anchor': 'middle' });
    t1.textContent = `${b.u}×${b.v}`;
    const t2 = el('text', { class: 'bsub', x: cx, y: cy + 12, 'text-anchor': 'middle' });
    t2.textContent = `${b.hUnits}u · ${(b.hUnits * SPEC.unitH)}mm`;
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
    if (hit !== -1) {                       // select an existing bin
      selected = hit;
      writeControls(bins[hit]);
      readControls(); drawMap(); refresh();
      return;
    }
    selected = -1;
    drag = { x0: c.x, y0: c.y, x1: c.x, y1: c.y };
    svg.setPointerCapture(e.pointerId);
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
      bins.push({ x, y, u, v, hUnits: state.hUnits, wall: state.wall,
                  floorT: state.floorT, divX: state.divX, divY: state.divY,
                  solid: state.solid });
      selected = bins.length - 1;
      writeControls(bins[selected]);
    }
    drag = null;
    readControls(); drawMap(); refresh();
  });
}

/* ---------- actions ------------------------------------------------------- */
$('fillRest').addEventListener('click', () => {
  const g = grid();
  selected = -1; readControls();
  for (let y = 0; y < g.ny; y++)
    for (let x = 0; x < g.nx; x++) {
      for (const [u, v] of [[state.u, state.v], [state.v, state.u], [1, 1]])
        if (canPlace(x, y, u, v, -1)) {
          bins.push({ x, y, u, v, hUnits: state.hUnits, wall: state.wall,
                      floorT: state.floorT, divX: state.divX, divY: state.divY,
                      solid: state.solid });
          break;
        }
    }
  drawMap(); refresh();
});
$('clearAll').addEventListener('click', () => {
  bins = []; selected = -1; readControls(); drawMap(); refresh();
});
$('delBin').addEventListener('click', () => {
  if (selected < 0) return;
  bins.splice(selected, 1); selected = -1;
  readControls(); drawMap(); refresh();
});
$('applyAll').addEventListener('click', () => {
  if (selected < 0) return;
  const s = bins[selected];
  for (const b of bins) Object.assign(b, {
    hUnits: s.hUnits, wall: s.wall, floorT: s.floorT,
    divX: s.divX, divY: s.divY, solid: s.solid });
  drawMap(); refresh();
});

/* ---------- checks -------------------------------------------------------- */
function warnings() {
  const g = grid(), out = [];
  const tall = bins.filter((b) => b.hUnits * SPEC.unitH > g.avail + 0.001);
  if (tall.length)
    out.push({ err: true, t: `${tall.length} bin(s) are taller than the ${g.avail.toFixed(1)} mm above the baseplate. The tallest that clears is ${g.maxUnits} units (${g.maxUnits * SPEC.unitH} mm).` });
  const thin = bins.filter((b) => !b.solid && b.wall < 0.8);
  if (thin.length)
    out.push({ t: `${thin.length} bin(s) have walls under 0.8 mm — thinner than two perimeters at a 0.4 mm nozzle.` });
  const oob = bins.filter((b) => b.x + b.u > g.nx || b.y + b.v > g.ny);
  if (oob.length)
    out.push({ err: true, t: `${oob.length} bin(s) now fall outside the grid — the drawer got smaller. Delete them or clear the layout.` });
  if (!bins.length)
    out.push({ t: 'No bins placed yet. Drag across the map to place one, or use "Fill the rest".' });
  const g2 = grid();
  const used = bins.reduce((a, b) => a + b.u * b.v, 0);
  if (bins.length && used < g2.nx * g2.ny)
    out.push({ t: `${g2.nx * g2.ny - used} cell(s) still empty — they will just be open baseplate.` });
  return out;
}
function drawWarnings() {
  const w = warnings();
  $('warnings').innerHTML = w.length
    ? w.map((x) => `<div class="w${x.err ? ' err' : ''}"><span>${x.t}</span></div>`).join('')
    : '<div class="hint">Layout is sound and everything fits.</div>';
}

/* ---------- types table + totals ------------------------------------------ */
function types() {
  const m = new Map();
  for (const b of bins) {
    const k = typeKey(b);
    if (!m.has(k)) m.set(k, { key: k, b, qty: 0 });
    m.get(k).qty++;
  }
  return [...m.values()].sort((a, b) => b.qty - a.qty);
}
function refresh() {
  const g = grid();
  $('gridSummary').textContent =
    `Grid: ${g.nx} × ${g.ny} cells · ${g.avail.toFixed(1)} mm above the baseplate · tallest bin ${g.maxUnits} units (${g.maxUnits * SPEC.unitH} mm)`;
  const src = selected >= 0 && bins[selected] ? bins[selected] : state;
  $('binSizeHint').textContent =
    `${(src.u * SPEC.pitch - 0.5).toFixed(1)} × ${(src.v * SPEC.pitch - 0.5).toFixed(1)} × ${(src.hUnits * SPEC.unitH).toFixed(1)} mm`;

  const used = bins.reduce((a, b) => a + b.u * b.v, 0);
  const total = g.nx * g.ny;
  const pct = total ? Math.round(100 * used / total) : 0;
  $('coverage').textContent = `${bins.length} bin(s) · ${used}/${total} cells filled (${pct}%)`;
  $('covfill').style.width = pct + '%';

  const ts = types();
  let vol = 0;
  $('typeRows').innerHTML = ts.map((t) => {
    const gm = geomFor(t.b);
    vol += gm.vol * t.qty;
    return `<tr><td class="mono">${t.b.u}×${t.b.v}×${t.b.hUnits}${t.b.solid ? ' solid' : ''}${t.b.divX || t.b.divY ? ` · ${(t.b.divX + 1) * (t.b.divY + 1)} comp` : ''}</td>` +
      `<td class="mono">${gm.meta.W.toFixed(1)} × ${gm.meta.D.toFixed(1)} × ${gm.meta.H.toFixed(0)}</td>` +
      `<td class="mono">${t.qty}</td>` +
      `<td class="mono">${(gm.vol * t.qty / 1000 * PLA_DENSITY).toFixed(0)} g</td>` +
      `<td><button data-t="${t.key}">STL</button></td></tr>`;
  }).join('') || '<tr><td colspan="5" class="mono">no bins placed</td></tr>';
  for (const btn of $('typeRows').querySelectorAll('button[data-t]'))
    btn.addEventListener('click', () => {
      const t = types().find((x) => x.key === btn.dataset.t);
      if (t) downloadType(t);
    });
  $('totals').textContent = bins.length
    ? `${bins.length} bins · ${ts.length} distinct type(s) · ${(vol / 1000).toFixed(0)} cm³ ≈ ${(vol / 1000 * PLA_DENSITY).toFixed(0)} g PLA`
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
const MAT = () => new THREE.MeshLambertMaterial({ color: 0x6fd0e0, side: THREE.DoubleSide, flatShading: true });
let mat = null;
function showScene() {
  if (!renderer) return;
  while (group.children.length) group.remove(group.children[0]);
  if (!mat) mat = MAT();
  const g = grid();
  const gw = g.nx * SPEC.pitch, gd = g.ny * SPEC.pitch;

  const plate = new THREE.Mesh(
    new THREE.BoxGeometry(gw, state.plateH, gd),
    new THREE.MeshLambertMaterial({ color: 0x2b3947 }));
  plate.position.set(0, -state.plateH / 2, 0);
  group.add(plate);

  for (const b of bins) {
    const m = new THREE.Mesh(geoOf(b), mat);
    m.position.set((b.x + b.u / 2) * SPEC.pitch - gw / 2, 0,
                   -((b.y + b.v / 2) * SPEC.pitch - gd / 2));
    group.add(m);
  }
  dist = Math.max(dist, 0);
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
  L.push(`Height available above the baseplate: ${g.avail.toFixed(1)} mm (${g.maxUnits} units)`);
  L.push('');
  L.push('BINS TO PRINT:');
  let vol = 0;
  for (const t of ts) {
    const gm = geomFor(t.b);
    vol += gm.vol * t.qty;
    L.push(`  ${String(t.qty).padStart(3)} x  ${t.b.u}x${t.b.v}x${t.b.hUnits}` +
      `  (${gm.meta.W.toFixed(1)} x ${gm.meta.D.toFixed(1)} x ${gm.meta.H.toFixed(0)} mm)` +
      `${t.b.solid ? '  solid' : ''}${t.b.divX || t.b.divY ? `  ${(t.b.divX + 1) * (t.b.divY + 1)} compartments` : ''}`);
  }
  L.push('');
  L.push(`Total: ${bins.length} bins, about ${(vol / 1000 * PLA_DENSITY).toFixed(0)} g of PLA.`);
  L.push('');
  L.push('LAYOUT (front of the drawer at the bottom):');
  const occ = occupancy();
  for (let y = g.ny - 1; y >= 0; y--)
    L.push('  ' + occ[y].map((i) => i === -1 ? ' . ' : String.fromCharCode(65 + (i % 26)) + '  ').join('').trimEnd());
  L.push('');
  L.push('PRINTING: flat as oriented, no supports. Print one bin and check it seats');
  L.push('in your baseplate before committing to the whole drawer.');
  L.push('');
  L.push('Layout link: ' + shareLink());
  return L.join('\n');
}
$('dlAll').addEventListener('click', async () => {
  if (!bins.length) return;
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

/* ---------- shared project descriptor -------------------------------------
   One descriptor in the hash, shared with the baseplates tool. Keys we do not
   recognise are re-emitted untouched, so a round trip through either tool is
   lossless and neither has to know the other's schema. */
const KEYS = { w: 'drawerW', d: 'drawerD', dh: 'drawerH', ph: 'plateH' };
const packBins = () => bins.map((b) =>
  [b.x, b.y, b.u, b.v, b.hUnits, b.wall, b.floorT, b.divX, b.divY, b.solid ? 1 : 0].join('.')).join('_');
function unpackBins(s) {
  if (!s) return [];
  return s.split('_').filter(Boolean).map((t) => {
    const p = t.split('.').map(Number);
    return { x: p[0], y: p[1], u: p[2], v: p[3], hUnits: p[4],
             wall: p[5], floorT: p[6], divX: p[7], divY: p[8], solid: !!p[9] };
  });
}
function shareLink() {
  const o = Object.assign({}, hashExtras, { v: 2 });
  for (const [k, id] of Object.entries(KEYS)) o[k] = state[id];
  o.bl = packBins();
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
    if (k === 'bl') { bins = unpackBins(val); continue; }
    if (k === 'bseg') { $('arcSegs').value = val; continue; }
    const id = KEYS[k];
    if (!id) { hashExtras[k] = val; continue; }   // someone else's key — keep it
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
  readControls(); geoCache.clear(); drawMap(); refresh(); }, 180); };

for (const id of ['drawerW', 'drawerD', 'drawerH', 'plateH', 'u', 'v', 'hUnits',
                  'wall', 'floorT', 'divX', 'divY', 'solid', 'arcSegs'])
  $(id).addEventListener('input', schedule);
$('solid').addEventListener('change', schedule);
$('arcSegs').addEventListener('change', schedule);
for (const s of document.querySelectorAll('section.p h2'))
  s.addEventListener('click', () => s.parentElement.classList.toggle('closed'));

loadFromHash();
readControls();
initThree();
initMap();
drawMap();
refresh();
