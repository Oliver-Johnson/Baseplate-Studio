/* Drawerforge Bins UI. Core geometry and buildBin are in scope from the previous
   script tags (both files end with a module.exports guard, so in the browser their
   functions land as globals). */
'use strict';

const $ = (id) => document.getElementById(id);

// the shared-core surface buildBin needs, gathered from the globals core.js defines
const G = {
  makePoly, triangulateRing, extrudePoly, clampZ,
  polysToTriangles, stlBinary, checkManifold,
};

const PLA_DENSITY = 1.24;      // g/cm3
const state = {};
let current = null;            // { polys, meta }
let hashExtras = {};           // descriptor keys we don't own — re-emitted untouched

/* ---------- controls ------------------------------------------------------ */
function readControls() {
  const num = (id, d) => { const v = parseFloat($(id).value); return isFinite(v) ? v : d; };
  const int = (id, d) => { const v = parseInt($(id).value, 10); return isFinite(v) ? v : d; };
  state.drawerW = num('drawerW', 306);
  state.drawerD = num('drawerD', 380);
  state.drawerH = num('drawerH', 93.9);
  state.plateH = num('plateH', 4.25);
  state.u = Math.max(1, int('u', 1));
  state.v = Math.max(1, int('v', 1));
  state.hUnits = Math.max(1, int('hUnits', 3));
  state.wall = num('wall', 1.2);
  state.floorT = num('floorT', 1.2);
  state.divX = Math.max(0, int('divX', 0));
  state.divY = Math.max(0, int('divY', 0));
  state.solid = $('solid').checked;
  state.arcSegs = int('arcSegs', 12);

  $('thickRow').style.display = state.solid ? 'none' : '';
  $('divRow').style.display = state.solid ? 'none' : '';
}

function grid() {
  const nx = Math.floor(state.drawerW / SPEC.pitch);
  const ny = Math.floor(state.drawerD / SPEC.pitch);
  const avail = state.drawerH - state.plateH;
  return { nx, ny, avail, maxUnits: Math.floor(avail / SPEC.unitH) };
}

/* ---------- analytic volume ----------------------------------------------
   Computed from the parameters, never from mesh volume: the geometry is a set of
   deliberately overlapping shells, so summing tetrahedra double-counts. */
function areaRR(hw, hd, r) { return 4 * hw * hd - (4 - Math.PI) * r * r; }

function volumeMm3() {
  const c = state, half = SPEC.half, C = SPEC.centre;
  const hwO = (c.u - 1) * SPEC.pitch / 2 + half;
  const hdO = (c.v - 1) * SPEC.pitch / 2 + half;
  const H = c.hUnits * SPEC.unitH, floorZ = SPEC.footH + c.floorT;

  // feet: integrate the profile, one foot per cell
  let footV = 0;
  const N = 80;
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

/* ---------- checks -------------------------------------------------------- */
function warnings() {
  const g = grid(), out = [];
  const H = state.hUnits * SPEC.unitH;
  if (state.u > g.nx || state.v > g.ny)
    out.push({ err: true, t: `This bin is ${state.u} × ${state.v} cells but the drawer grid is only ${g.nx} × ${g.ny}. It will not go in.` });
  if (H > g.avail + 0.001)
    out.push({ err: true, t: `At ${H} mm this bin is taller than the ${g.avail.toFixed(1)} mm above the baseplate. The tallest that clears is ${g.maxUnits} units (${g.maxUnits * SPEC.unitH} mm).` });
  else if (H > g.avail - SPEC.unitH)
    out.push({ t: `${H} mm uses nearly all of the ${g.avail.toFixed(1)} mm available — ${(g.avail - H).toFixed(1)} mm spare.` });
  if (!state.solid && state.wall < 0.8)
    out.push({ t: `${state.wall} mm walls are thinner than two perimeters at a 0.4 mm nozzle. 0.8 mm or more prints more reliably.` });
  if (!state.solid && state.floorT < 0.8)
    out.push({ t: `A ${state.floorT} mm floor is thin — 1.2 mm or more resists punch-through.` });
  if (state.solid)
    out.push({ t: 'Solid block: no cavity at all. This is a spacer, not a container, and it uses a lot of filament.' });
  return out;
}

function drawWarnings() {
  const w = warnings();
  $('warnings').innerHTML = w.length
    ? w.map((x) => `<div class="w${x.err ? ' err' : ''}"><span>${x.t}</span></div>`).join('')
    : '<div class="hint">No problems — this bin fits the drawer and prints cleanly.</div>';
}

/* ---------- rebuild ------------------------------------------------------- */
let timer = null;
function scheduleRebuild() { clearTimeout(timer); timer = setTimeout(rebuild, 180); }

function rebuild() {
  readControls();
  const g = grid();
  $('gridSummary').textContent =
    `Grid: ${g.nx} × ${g.ny} cells · ${g.avail.toFixed(1)} mm above the baseplate · tallest bin ${g.maxUnits} units (${g.maxUnits * SPEC.unitH} mm)`;
  $('binSizeHint').textContent =
    `${(state.u * SPEC.pitch - 0.5).toFixed(1)} × ${(state.v * SPEC.pitch - 0.5).toFixed(1)} × ${(state.hUnits * SPEC.unitH).toFixed(1)} mm`;

  try {
    current = buildBin(G, state);
  } catch (e) {
    current = null;
    $('status').textContent = e.message;
    drawWarnings();
    return;
  }
  $('status').textContent = '';
  drawWarnings();

  const vol = volumeMm3();
  const m = current.meta;
  const rows = [
    ['Footprint', `${m.W.toFixed(2)} × ${m.D.toFixed(2)} mm  (${m.u} × ${m.v} cells)`],
    ['Height', `${m.H.toFixed(1)} mm  (${m.hUnits} units)`],
    ['Cavity floor', state.solid ? 'solid' : `${m.floorZ.toFixed(2)} mm from the bottom`],
    ['Compartments', state.solid ? '—' : `${(state.divX + 1) * (state.divY + 1)}`],
    ['Material', `${(vol / 1000).toFixed(1)} cm³ ≈ ${(vol / 1000 * PLA_DENSITY).toFixed(0)} g PLA`],
    ['Triangles', `${G.polysToTriangles(current.polys).length}`],
  ];
  $('specRows').innerHTML = rows.map(([k, v]) =>
    `<tr><td class="klabel">${k}</td><td>${v}</td></tr>`).join('');

  showMesh(current.polys);
}

/* ---------- three.js preview ---------------------------------------------- */
let scene, camera, renderer, mesh, wire;
let theta = -0.7, phi = 1.05, dist = 160, dragging = null;

function initThree() {
  const canvas = $('three');
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(38, 1, 1, 4000);
  scene.add(new THREE.AmbientLight(0xffffff, 0.62));
  const d1 = new THREE.DirectionalLight(0xffffff, 0.85); d1.position.set(1, 1.4, 1); scene.add(d1);
  const d2 = new THREE.DirectionalLight(0x88bbff, 0.35); d2.position.set(-1, -0.6, 0.4); scene.add(d2);

  canvas.addEventListener('pointerdown', (e) => { dragging = [e.clientX, e.clientY]; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointerup', () => { dragging = null; });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    theta -= (e.clientX - dragging[0]) * 0.01;
    phi = Math.min(3.11, Math.max(0.03, phi - (e.clientY - dragging[1]) * 0.01));
    dragging = [e.clientX, e.clientY];
    render();
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    dist = Math.min(1200, Math.max(45, dist * (1 + Math.sign(e.deltaY) * 0.12)));
    render();
  }, { passive: false });
  window.addEventListener('resize', render);
}

function showMesh(polys) {
  if (mesh) { scene.remove(mesh); mesh.geometry.dispose(); }
  if (wire) { scene.remove(wire); wire.geometry.dispose(); }
  const tris = G.polysToTriangles(polys);
  const pos = new Float32Array(tris.length * 9);
  let i = 0;
  for (const t of tris) for (const v of t) { pos[i++] = v[0]; pos[i++] = v[2]; pos[i++] = -v[1]; }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({
    color: 0x6fd0e0, side: THREE.DoubleSide, flatShading: true }));
  scene.add(mesh);
  const m = current.meta;
  dist = Math.max(m.W, m.D, m.H) * 2.6;
  render();
}

function render() {
  if (!renderer || !current) return;
  const wrap = $('threewrap');
  const w = wrap.clientWidth, h = wrap.clientHeight || 380;
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.updateProjectionMatrix();
  const cy = current.meta.H / 2;
  camera.position.set(
    dist * Math.sin(phi) * Math.cos(theta),
    cy + dist * Math.cos(phi),
    dist * Math.sin(phi) * Math.sin(theta));
  camera.lookAt(0, cy, 0);
  renderer.render(scene, camera);
}

/* ---------- export -------------------------------------------------------- */
function saveBlob(buf, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([buf], { type: 'application/octet-stream' }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
$('dlStl').addEventListener('click', () => {
  if (!current) return;
  const m = current.meta;
  saveBlob(G.stlBinary(current.polys, 'bin'),
           `gridfinity-bin-${m.u}x${m.v}x${m.hUnits}.stl`);
});

/* ---------- shared project descriptor -------------------------------------
   One descriptor in the hash, shared with the baseplates tool. Keys we do not
   recognise are re-emitted untouched, so a round trip through either tool is
   lossless and neither has to know the other's schema. */
const KEYS = { w: 'drawerW', d: 'drawerD', dh: 'drawerH', ph: 'plateH',
               bu: 'u', bv: 'v', bh: 'hUnits', bw: 'wall', bf: 'floorT',
               bdx: 'divX', bdy: 'divY', bs: 'solid', bseg: 'arcSegs' };

function shareLink() {
  const o = Object.assign({}, hashExtras, { v: 2 });
  for (const [k, id] of Object.entries(KEYS))
    o[k] = typeof state[id] === 'boolean' ? (state[id] ? 1 : 0) : state[id];
  return location.origin + location.pathname + '#' +
    Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
}
function loadFromHash() {
  const h = location.hash.replace(/^#/, '');
  if (!h) return;
  const q = {};
  for (const kv of h.split('&')) {
    const i = kv.indexOf('=');
    if (i > 0) q[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1));
  }
  for (const [k, v] of Object.entries(q)) {
    if (k === 'v') continue;
    const id = KEYS[k];
    if (!id) { hashExtras[k] = v; continue; }   // someone else's key — keep it
    const el = $(id === 'u' ? 'u' : id);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = v === '1' || v === 'true';
    else el.value = v;
  }
}
$('shareBtn').addEventListener('click', () => {
  const link = shareLink();
  navigator.clipboard.writeText(link).then(
    () => { $('shareBtn').textContent = 'Copied ✓'; setTimeout(() => $('shareBtn').textContent = 'Copy settings link', 1600); },
    () => prompt('Copy this link:', link));
});
$('toPlates').addEventListener('click', (e) => {
  e.preventDefault();
  const o = Object.assign({}, hashExtras, { v: 2, w: state.drawerW, d: state.drawerD,
                                            dh: state.drawerH, ph: state.plateH });
  location.href = '../#' + Object.entries(o).map(([k, x]) => `${k}=${encodeURIComponent(x)}`).join('&');
});

/* ---------- boot ---------------------------------------------------------- */
for (const id of ['drawerW', 'drawerD', 'drawerH', 'plateH', 'u', 'v', 'hUnits',
                  'wall', 'floorT', 'divX', 'divY', 'solid', 'arcSegs'])
  $(id).addEventListener('input', scheduleRebuild);
$('solid').addEventListener('change', scheduleRebuild);
$('arcSegs').addEventListener('change', scheduleRebuild);

for (const s of document.querySelectorAll('section.p h2'))
  s.addEventListener('click', () => s.parentElement.classList.toggle('closed'));

loadFromHash();
initThree();
rebuild();
