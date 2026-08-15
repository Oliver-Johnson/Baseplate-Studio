
'use strict';
/* Drawerforge UI. Core geometry functions are in scope from the previous script tag. */
const $ = (id) => document.getElementById(id);

// ---------- state ----------
const state = Object.assign({}, DEFAULTS, {
  marginMode: 'auto', splitMode: 'balanced', rowCuts: null, colCuts: null,
});
let layout = null;
let builds = {};            // pieceId -> {polys, meta}
let buildToken = 0;
const PIECE_COLORS = ['#4fc3e8','#e8b34f','#7fd8a5','#e88a8a','#b18ae8','#7fb5e8','#e8d47f','#8ae8d4'];

// ---------- read/write controls ----------
const numIds = ['drawerW','drawerD','bedW','bedD','bedH','mLeft','mRight','mFront','mBack',
  'pitch','outerRadius','bottomPad','topCutoff','magnetD','magnetH',
  'screwHoleD','screwHeadD','screwHeadDepth'];
function readControls() {
  for (const id of numIds) state[id] = parseFloat($(id).value) || 0;
  state.alignX = $('alignX').value; state.alignY = $('alignY').value;
  const mm = $('marginMode').value;
  state.marginMode = mm === 'custom' ? 'custom' : 'auto';
  state.noMargin = mm === 'none';
  if (state.noMargin) { state.marginMode = 'custom'; state.mLeft = state.mRight = state.mFront = state.mBack = 0; }
  state.connector = $('connector').value;
  state.keyType = ['bowtie','puzzlekey','snap'].includes(state.connector) ? state.connector : 'bowtie';
  state.keyMount = $('keyMount').value;
  state.keyInsert = $('keyInsert').value;
  state.baseMode = $('baseMode').value;
  state.plateStyle = $('plateStyle').value;
  if ($('perCorner').checked) {
    state.cornerRadii = { ll: parseFloat($('rFL').value)||0, lr: parseFloat($('rFR').value)||0,
                          ul: parseFloat($('rBL').value)||0, ur: parseFloat($('rBR').value)||0 };
  } else state.cornerRadii = null;
  state.tolerance = $('tolerance').value;
  state.magnets = $('magnets').checked;
  state.screws = $('screws').checked;
  state.magnetSide = $('magnetSide').value;
  const clr = parseFloat($('connClr').value) || 0.2;
  state.tab = Object.assign({}, DEFAULTS.tab, { clr });
  state.bowtie = Object.assign({}, DEFAULTS.bowtie, { clr: Math.max(0.1, clr - 0.05) });
  state.key = Object.assign({}, DEFAULTS.key, { clr: Math.max(0.1, clr - 0.05) });
  state.hclip = Object.assign({}, DEFAULTS.hclip, { clr: Math.max(0.08, clr - 0.05) });
  state.puzzle = Object.assign({}, DEFAULTS.puzzle, { clr });
  $('alignRow').style.display = mm === 'auto' ? '' : 'none';
  $('customMargins').style.display = mm === 'custom' ? '' : 'none';
  $('magRow').style.display = state.magnets ? '' : 'none';
  $('screwRow').style.display = state.screws ? '' : 'none';
  $('connHintDove').style.display = state.connector === 'dovetail' ? '' : 'none';
  $('connHintPuzzle').style.display = state.connector === 'puzzle' ? '' : 'none';
  $('connHintBow').style.display = (state.connector === 'bowtie' || state.connector === 'puzzlekey') ? '' : 'none';
  $('connHintSnap').style.display = state.connector === 'snap' ? '' : 'none';
  $('connHintHclip').style.display = state.connector === 'hclip' ? '' : 'none';
  const hasKeys = ['bowtie','puzzlekey','snap'].includes(state.connector);
  $('keyMountRow').style.display = hasKeys ? '' : 'none';
  $('keyMountHint').style.display = hasKeys ? '' : 'none';
  // top-insert applies exactly where the key lives in the wall (see activeKeyDims)
  const wallish = (hasKeys && state.keyMount === 'wall') || state.connector === 'hclip';
  $('keyInsertRow').style.display = wallish ? '' : 'none';
  $('keyInsertHint').style.display = wallish ? '' : 'none';
  $('baseModeRow').style.display = (state.magnets || state.screws) ? '' : 'none';
  $('cornerRow').style.display = $('perCorner').checked ? '' : 'none';
  $('cornerHint').style.display = $('perCorner').checked ? '' : 'none';
}

// ---------- layout & validation ----------
function recomputeLayout() {
  readControls();
  layout = computeLayout(state);
  // clamp stored manual cuts to the current grid
  if (state.splitMode === 'manual') {
    state.rowCuts = layout.rowCuts.slice();
    state.colCuts = layout.colCuts.map(c => c.slice());
  }
  drawMap();
  drawWarnings();
  drawPieceTable();
  scheduleBuild();
}

/* The bed room a piece actually needs: its plate, plus the dovetail tabs that stick
   out past it. One function, because the export dialog reports the largest piece and
   has to be quoting the same number the fit test used — otherwise it can call a piece
   174 mm wide and reject it against a 256 mm bed in the same breath. */
function pieceExtent(pc) {
  const pitch = state.pitch;
  const ext = state.connector === 'dovetail' ? state.tab.dp + 0.4 : 0;
  return [pc.mL + pc.nx*pitch + pc.mR + ext, pc.mF + pc.ny*pitch + pc.mB + ext];
}
function pieceFits(pc) {
  const [w, d] = pieceExtent(pc);
  return w <= state.bedW + 1e-6 && d <= state.bedD + 1e-6;
}

function warningsList() {
  const out = [];
  if (layout.nx < 1 || layout.ny < 1 || state.drawerW < state.pitch || state.drawerD < state.pitch)
    out.push({ err: true, t: `Drawer smaller than one ${state.pitch} mm cell — nothing to generate.` });
  for (const pc of layout.pieces) if (!pieceFits(pc))
    out.push({ err: true, t: `Piece ${pc.id} (${(pc.mL+pc.nx*state.pitch+pc.mR).toFixed(0)} × ${(pc.mF+pc.ny*state.pitch+pc.mB).toFixed(0)} mm) exceeds the ${state.bedW} × ${state.bedD} bed — add a cut through it.` });
  if (layout.pieces.some(pc => pc.nx*pc.ny === 1))
    out.push({ t: 'A piece is a single cell — printable, but consider moving a cut for a sturdier layout.' });
  const remX = state.drawerW - layout.nx*state.pitch, remY = state.drawerD - layout.ny*state.pitch;
  if (remX > state.pitch * 0.75 || remY > state.pitch * 0.75)
    out.push({ t: `Leftover space is large (${remX.toFixed(0)} × ${remY.toFixed(0)} mm) — nearly another cell. Double-check the drawer measurement.` });
  const keyedC = ['bowtie','puzzlekey','snap'].includes(state.connector);
  const wallishC = (keyedC && state.keyMount === 'wall') || state.connector === 'hclip';
  if ((keyedC && state.keyMount === 'floor' || state.connector === 'puzzle') && layout.pieces.length > 1) {
    const padV = state.connector === 'puzzle' ? 2.6 : state.key.depth + 0.8;
    const what = state.connector === 'puzzle' ? 'the jigsaw lobes' :
      state.connector === 'snap' ? 'the snap clips' : 'the keys';
    out.push({ t: `This joint adds a ${Math.max(state.bottomPad, padV).toFixed(1)} mm solid floor to house ${what}. Prefer no floor? Pick a keyed joint and set Key housing to "Inside the walls".` });
  }
  if (wallishC &&
      layout.seams.some(s => s.junctions.some(j => Math.abs(j - Math.round(j)) > 0.25)))
    out.push({ t: 'One seam overlaps by a single cell — wall-housed keys need a wall junction, so that seam gets no connector. The neighbouring joints still hold the assembly.' });
  if (state.plateStyle === 'skeleton') {
    if (state.magnets || state.screws)
      out.push({ t: 'Skeleton is off while magnets or screws are on — their pockets and bosses need the material a skeleton removes. Turn them off, or use Solid.' });
    else if (state.connector !== 'none')
      out.push({ t: 'Skeleton is applied to the inner cells only. Cells along each piece edge stay solid because that is where the joints cut in — pick "None" for joints to skeletonise the whole plate.' });
  }
  if (state.noMargin && (remX > 0.5 || remY > 0.5))
    out.push({ t: 'No margin selected: the plate will sit loose by the leftover amount. The drawer walls still contain it.' });
  return out;
}
function drawWarnings() {
  const el = $('warnings');
  el.innerHTML = warningsList().map(w => `<div class="w${w.err ? ' err' : ''}">${w.t}</div>`).join('');
}

// ---------- interactive cut map ----------
function drawMap() {
  const svg = $('cutmap');
  const pitch = state.pitch;
  const Wmm = state.drawerW, Dmm = state.drawerD;
  const availW = Math.min(680, ($('mapwrap').clientWidth || 680) - 10);
  const sc = Math.min(availW / (Wmm + 90), 460 / (Dmm + 90));
  const ox = 58, oy = 26;
  const X = (mm) => ox + mm * sc;
  const Y = (mm) => oy + (Dmm - mm) * sc;     // front of drawer at the bottom
  const w = ox + Wmm * sc + 34, h = oy + Dmm * sc + 56;
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('width', w); svg.setAttribute('height', h);
  let s = '';
  const gx0 = layout.mL, gy0 = layout.mF;

  // piece fills
  layout.pieces.forEach((pc, i) => {
    const x0 = pc.cellX0 === 0 ? 0 : gx0 + pc.cellX0 * pitch;
    const x1 = pc.cellX0 + pc.nx === layout.nx ? Wmm : gx0 + (pc.cellX0 + pc.nx) * pitch;
    const y0 = pc.cellY0 === 0 ? 0 : gy0 + pc.cellY0 * pitch;
    const y1 = pc.cellY0 + pc.ny === layout.ny ? Dmm : gy0 + (pc.cellY0 + pc.ny) * pitch;
    const col = PIECE_COLORS[i % PIECE_COLORS.length];
    const bad = !pieceFits(pc);
    s += `<rect x="${X(x0)}" y="${Y(y1)}" width="${(x1-x0)*sc}" height="${(y1-y0)*sc}" fill="${col}" opacity="${bad?0.28:0.16}"/>`;
    s += `<text class="plabel${bad?' bad':''}" x="${X((x0+x1)/2)}" y="${Y((y0+y1)/2)-2}" text-anchor="middle">${pc.id}</text>`;
    s += `<text class="psub" x="${X((x0+x1)/2)}" y="${Y((y0+y1)/2)+11}" text-anchor="middle">${pc.nx}×${pc.ny}</text>`;
  });

  // grid lines + hit targets
  for (let i = 1; i < layout.nx; i++) {
    const xm = gx0 + i * pitch;
    s += `<line class="gridline" x1="${X(xm)}" y1="${Y(gy0)}" x2="${X(xm)}" y2="${Y(gy0 + layout.ny*pitch)}"/>`;
  }
  for (let j = 1; j < layout.ny; j++) {
    const ym = gy0 + j * pitch;
    s += `<line class="gridline" x1="${X(gx0)}" y1="${Y(ym)}" x2="${X(gx0 + layout.nx*pitch)}" y2="${Y(ym)}"/>`;
  }
  // active cuts: rows
  const bandStarts = [0, ...layout.rowCuts];
  for (const rc of layout.rowCuts) {
    const ym = gy0 + rc * pitch;
    s += `<line class="cutline" x1="${X(0)}" y1="${Y(ym)}" x2="${X(Wmm)}" y2="${Y(ym)}"/>`;
  }
  // active cuts: columns per band
  layout.colCuts.forEach((cuts, b) => {
    const yA = gy0 + bandStarts[b] * pitch;
    const yB = b + 1 < bandStarts.length ? gy0 + bandStarts[b+1] * pitch
                                         : gy0 + layout.ny * pitch;
    const y0 = b === 0 ? 0 : yA;
    const y1 = b + 1 < bandStarts.length ? yB : Dmm;
    for (const c of cuts)
      s += `<line class="cutline" x1="${X(gx0 + c*pitch)}" y1="${Y(y0)}" x2="${X(gx0 + c*pitch)}" y2="${Y(y1)}"/>`;
  });
  // hit targets — horizontal (whole-plate row cuts)
  for (let j = 1; j < layout.ny; j++) {
    const ym = gy0 + j * pitch;
    s += `<line class="hitline" data-row="${j}" x1="${X(0)}" y1="${Y(ym)}" x2="${X(Wmm)}" y2="${Y(ym)}"/>`;
  }
  // hit targets — vertical, per band segment
  layout.colCuts.forEach((cuts, b) => {
    const yA = bandStarts[b], yB = b + 1 < bandStarts.length ? bandStarts[b+1] : layout.ny;
    for (let i = 1; i < layout.nx; i++) {
      const xm = gx0 + i * pitch;
      s += `<line class="hitline" data-band="${b}" data-col="${i}" x1="${X(xm)}" y1="${Y(gy0 + yA*pitch)}" x2="${X(xm)}" y2="${Y(gy0 + yB*pitch)}"/>`;
    }
  });

  // outline + dimension lines
  s += `<rect x="${X(0)}" y="${Y(Dmm)}" width="${Wmm*sc}" height="${Dmm*sc}" fill="none" stroke="var(--ink)" stroke-width="1.4"/>`;
  const dy = Y(0) + 22;
  s += `<line class="dim" x1="${X(0)}" y1="${dy}" x2="${X(Wmm)}" y2="${dy}"/>`
     + `<line class="dim" x1="${X(0)}" y1="${dy-4}" x2="${X(0)}" y2="${dy+4}"/>`
     + `<line class="dim" x1="${X(Wmm)}" y1="${dy-4}" x2="${X(Wmm)}" y2="${dy+4}"/>`
     + `<text x="${X(Wmm/2)}" y="${dy+14}" text-anchor="middle" font-size="11">${Wmm} mm</text>`;
  const dx = X(0) - 20;
  s += `<line class="dim" x1="${dx}" y1="${Y(0)}" x2="${dx}" y2="${Y(Dmm)}"/>`
     + `<line class="dim" x1="${dx-4}" y1="${Y(0)}" x2="${dx+4}" y2="${Y(0)}"/>`
     + `<line class="dim" x1="${dx-4}" y1="${Y(Dmm)}" x2="${dx+4}" y2="${Y(Dmm)}"/>`
     + `<text x="${dx-6}" y="${Y(Dmm/2)}" text-anchor="middle" font-size="11" transform="rotate(-90 ${dx-6} ${Y(Dmm/2)})">${Dmm} mm</text>`;
  s += `<text x="${X(Wmm/2)}" y="${h-6}" text-anchor="middle" font-size="10">▾ front of drawer</text>`;
  svg.innerHTML = s;
  $('mapTail').textContent = `${layout.nx} × ${layout.ny} cells · ${layout.pieces.length} piece${layout.pieces.length>1?'s':''}`;
  $('gridSummary').innerHTML = `Grid: <span class="klabel">${layout.nx} × ${layout.ny}</span> cells (${(layout.nx*state.pitch).toFixed(0)} × ${(layout.ny*state.pitch).toFixed(0)} mm) · margins L ${layout.mL.toFixed(1)} / R ${layout.mR.toFixed(1)} / F ${layout.mF.toFixed(1)} / B ${layout.mB.toFixed(1)} mm`;

  svg.querySelectorAll('.hitline').forEach(el => el.addEventListener('click', onMapClick));
}

function onMapClick(ev) {
  const el = ev.currentTarget;
  // seed manual state from the current layout
  if (state.splitMode !== 'manual') {
    state.splitMode = 'manual';
    state.rowCuts = layout.rowCuts.slice();
    state.colCuts = layout.colCuts.map(c => c.slice());
    setSplitSeg('manual');
  }
  if (el.dataset.row !== undefined) {
    const j = parseInt(el.dataset.row);
    const i = state.rowCuts.indexOf(j);
    const oldStarts = [0, ...state.rowCuts];
    if (i >= 0) state.rowCuts.splice(i, 1); else { state.rowCuts.push(j); state.rowCuts.sort((a,b)=>a-b); }
    // remap per-band col cuts onto the new bands by band start position
    const newStarts = [0, ...state.rowCuts];
    const byStart = {};
    oldStarts.forEach((st, k) => byStart[st] = state.colCuts[k] || []);
    state.colCuts = newStarts.map(st => {
      if (byStart[st]) return byStart[st].slice();
      // new band from a split: inherit the cuts of the band it came from
      const src = oldStarts.filter(s0 => s0 < st).pop();
      return (byStart[src] || []).slice();
    });
  } else {
    const b = parseInt(el.dataset.band), c = parseInt(el.dataset.col);
    if (!state.colCuts[b]) state.colCuts[b] = [];
    const i = state.colCuts[b].indexOf(c);
    if (i >= 0) state.colCuts[b].splice(i, 1); else { state.colCuts[b].push(c); state.colCuts[b].sort((a,bb)=>a-bb); }
  }
  recomputeLayout();
}

function setSplitSeg(v) {
  document.querySelectorAll('#splitSeg button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
}

// ---------- piece table ----------
function drawPieceTable() {
  const tb = $('pieceRows');
  const pitch = state.pitch;
  tb.innerHTML = layout.pieces.map((pc, i) => {
    const w = pc.mL + pc.nx*pitch + pc.mR, d = pc.mF + pc.ny*pitch + pc.mB;
    const fit = pieceFits(pc);
    const built = builds[pc.id];
    let joints = '…';
    if (built) {
      const m = built.meta, parts = [];
      if (m.tabs) parts.push(`${m.tabs} tab`);
      if (m.notches) parts.push(`${m.notches} pocket`);
      if (m.puzzles) parts.push(`${m.puzzles} puzzle`);
      if (m.bowties) parts.push(`${m.bowties} key`);
      joints = parts.join(' + ') || '—';
    }
    return `<tr>
      <td><span class="sw" style="background:${PIECE_COLORS[i%PIECE_COLORS.length]}"></span><b>${pc.id}</b></td>
      <td class="mono">${pc.nx} × ${pc.ny}</td>
      <td class="mono">${w.toFixed(1)} × ${d.toFixed(1)}</td>
      <td class="mono">${joints || '—'}</td>
      <td class="${fit?'':'bad'}">${fit ? 'fits' : 'TOO BIG'}</td>
      <td><button class="ghost" data-dl="${pc.id}" ${built?'':'disabled'}>STL</button></td>
    </tr>`;
  }).join('');
  tb.querySelectorAll('button[data-dl]').forEach(b => b.addEventListener('click', () => downloadPiece(b.dataset.dl)));
  const tot = layout.pieces.length;
  const okc = Object.keys(builds).length;
  $('pieceTail').textContent = okc < tot ? `building ${okc}/${tot}…` : `${tot} ready`;
  // this runs once per piece as the build proceeds, which is exactly the cadence an
  // open dialog needs to keep its readiness line and its file list honest
  syncExportDialog();
}

// ---------- async build ----------
let buildTimer = null;
function scheduleBuild() {
  clearTimeout(buildTimer);
  buildTimer = setTimeout(runBuild, 260);
}
async function runBuild() {
  const token = ++buildToken;
  builds = {};
  printPlan = null; renderPrintPlan();
  drawPieceTable();
  clearThree();
  const errs = warningsList().some(w => w.err);
  if (errs) { $('status').textContent = 'resolve the errors above to generate'; return; }
  for (const pc of layout.pieces) {
    $('status').textContent = `building ${pc.id}…`;
    await new Promise(r => setTimeout(r, 0));
    if (token !== buildToken) return;
    try {
      const res = buildPiece(state, layout, pc);
      builds[pc.id] = { polys: res.polys, meta: res };
      addPieceToThree(pc, res);
    } catch (e) {
      console.error('build failed for', pc.id, e);
      $('status').textContent = `piece ${pc.id} failed — try different cuts`;
      return;
    }
    drawPieceTable();
  }
  $('status').textContent = '';
  computePrintPlan();
  fitThree();
}

// ---------- three.js ----------
let scene, camera, renderer, root, sph = { theta: -0.7, phi: 1.05, r: 420, cx: 0, cy: 0 };
function initThree() {
  const canvas = $('three');
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(42, 2, 1, 5000);
  scene.add(new THREE.HemisphereLight(0xcfe8f4, 0x1a2027, 0.95));
  const d = new THREE.DirectionalLight(0xffffff, 0.75); d.position.set(0.6, -1, 1.4); scene.add(d);
  root = new THREE.Group(); scene.add(root);
  const onResize = () => {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
  };
  new ResizeObserver(onResize).observe(canvas); onResize();
  // controls
  let drag = null;
  canvas.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY, pan: e.shiftKey }; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointermove', e => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (drag.pan) { sph.cx -= dx * sph.r * 0.0011; sph.cy += dy * sph.r * 0.0011; }
    else { sph.theta -= dx * 0.0065; sph.phi = Math.max(0.03, Math.min(3.11, sph.phi - dy * 0.0065)); }
    drag.x = e.clientX; drag.y = e.clientY;
  });
  canvas.addEventListener('pointerup', () => drag = null);
  canvas.addEventListener('wheel', e => { e.preventDefault(); sph.r = Math.max(60, Math.min(2200, sph.r * (1 + e.deltaY * 0.0011))); }, { passive: false });
  (function loop() {
    requestAnimationFrame(loop);
    camera.position.set(
      sph.cx + sph.r * Math.sin(sph.phi) * Math.sin(sph.theta),
      sph.cy - sph.r * Math.sin(sph.phi) * Math.cos(sph.theta),
      sph.r * Math.cos(sph.phi));
    camera.up.set(0, 0, 1);
    camera.lookAt(sph.cx, sph.cy, 0);
    renderer.render(scene, camera);
  })();
}
function clearThree() {
  while (root.children.length) {
    const m = root.children.pop();
    m.geometry.dispose(); m.material.dispose();
  }
}
function piecePlacement(pc) {
  const pitch = state.pitch, gap = $('explode').checked ? 14 : 0.6;
  const gx = pc.cellX0 === 0 ? 0 : layout.mL + pc.cellX0 * pitch;
  const gy = pc.cellY0 === 0 ? 0 : layout.mF + pc.cellY0 * pitch;
  return [gx + pc.seg * gap, gy + pc.band * gap];
}
function addPieceToThree(pc, res) {
  const tris = polysToTriangles(res.polys);
  const pos = new Float32Array(tris.length * 9);
  let o = 0;
  for (const t of tris) for (const v of t) { pos[o++] = v[0]; pos[o++] = v[1]; pos[o++] = v[2]; }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.computeVertexNormals();
  const i = layout.pieces.indexOf(pc);
  const mat = new THREE.MeshStandardMaterial({
    color: PIECE_COLORS[i % PIECE_COLORS.length], flatShading: true,
    metalness: 0.05, roughness: 0.75 });
  const mesh = new THREE.Mesh(g, mat);
  const [px, py] = piecePlacement(pc);
  mesh.position.set(px, py, 0);
  mesh.userData.pieceId = pc.id;
  root.add(mesh);
}
function fitThree() {
  sph.cx = state.drawerW / 2; sph.cy = state.drawerD / 2;
  sph.r = Math.max(state.drawerW, state.drawerD) * 1.5;
}
$('explode').addEventListener('change', () => {
  for (const mesh of root.children) {
    const pc = layout.pieces.find(p => p.id === mesh.userData.pieceId);
    if (pc) { const [px, py] = piecePlacement(pc); mesh.position.set(px, py, 0); }
  }
});


// ---------- print plan ----------
let printPlan = null;
function computePrintPlan() {
  if (!layout || Object.keys(builds).length < layout.pieces.length) { printPlan = null; renderPrintPlan(); return; }
  const gap = parseFloat($('plateGap').value) || 4;
  const stack = $('stackToggle').checked;
  const zGap = parseFloat($('stackGap').value) || 0.24;
  $('stackHint').style.display = stack ? '' : 'none';
  const items = layout.pieces.map(pc => {
    const m = builds[pc.id].meta;
    return { id: pc.id, w: m.W + m.protrusion.l + m.protrusion.r,
             d: m.D + m.protrusion.f + m.protrusion.b, h: m.H, qty: 1, stackable: true };
  });
  if (KEYED.includes(state.connector)) {
    const kd = activeKeyDims();
    const nKeys = layout.seams.reduce((a, s) => a + s.junctions.length, 0);
    if (nKeys) items.push({ id: 'key', w: kd.len, d: kd.wEnd,
                            h: kd.depth - 0.15, qty: nKeys, stackable: false });
  }
  printPlan = { plates: packPlates(items, state.bedW, state.bedD, gap,
    { stack, zGap, bedH: state.bedH || 1e9 }), merged: items, zGap };
  renderPrintPlan();
}
function renderPrintPlan() {
  const row = $('platesRow');
  updateExportTail();
  if (!printPlan) { row.innerHTML = '<div class="hint">Print plan appears when all pieces are built.</div>'; $('planTail').textContent = ''; return; }
  const plates = printPlan.plates;
  const stacked = plates.some(pl => pl.placed.some(p => p.z > 0.01));
  $('planTail').textContent = `${plates.length} print plate${plates.length > 1 ? 's' : ''}` + (stacked ? ' · stacked' : '');
  const sc = 116 / Math.max(state.bedW, state.bedD);
  row.innerHTML = plates.map((pl, i) => {
    let svg = `<svg width="${state.bedW*sc+2}" height="${state.bedD*sc+2}" style="background:var(--panel2);border:1px solid var(--line);border-radius:5px">`;
    for (const p of pl.placed) {
      const ci = p.id === 'key' ? 7 : layout.pieces.findIndex(pc => pc.id === p.id);
      const lvl = Math.round(p.z / (4.5 + printPlan.zGap));
      svg += `<rect x="${p.x*sc+1}" y="${(state.bedD-p.y-p.d)*sc+1}" width="${p.w*sc}" height="${p.d*sc}" fill="${PIECE_COLORS[(ci<0?0:ci)%PIECE_COLORS.length]}" opacity="${p.z>0.01?0.35:0.55}" stroke="var(--line)"/>`;
      if (p.id !== 'key')
        svg += `<text x="${(p.x+p.w/2)*sc+1}" y="${(state.bedD-p.y-p.d/2)*sc+4+(lvl*10)}" text-anchor="middle" font-size="10" fill="var(--ink)">${p.id}${p.z>0.01?' ↥':''}</text>`;
    }
    svg += '</svg>';
    return `<div style="display:grid;gap:4px;justify-items:center">${svg}<div class="hint">plate ${i+1}</div></div>`;
  }).join('');
}
function platePolysAndItems(idx) {
  const pl = printPlan.plates[idx];
  const objs = [];
  for (const p of pl.placed) {
    let polys;
    if (p.id === 'key') { const kd = activeKeyDims(); polys = buildKey(activeKeyShape(), kd, kd.depth - 0.15); }
    else {
      const b = builds[p.id];
      if (!b) continue;
      polys = transformPolys(b.polys, b.meta.protrusion.l, b.meta.protrusion.f, 0, 0);
    }
    objs.push({ name: p.id + (p.z > 0.01 ? `@${p.z.toFixed(2)}` : ''), polys, tx: p.x, ty: p.y, tz: p.z, rot: p.rot });
  }
  return objs;
}
async function plate3mfBytes(idx) {
  const x = build3mfXML(platePolysAndItems(idx));
  const pz = new JSZip();
  pz.file('[Content_Types].xml', x.contentTypes);
  pz.file('_rels/.rels', x.rels);
  pz.file('3D/3dmodel.model', x.model);
  return pz.generateAsync({ type: 'uint8array' });
}
async function downloadAllPlates() {
  if (!printPlan) return;
  const n = printPlan.plates.length;
  if (n === 1) { saveBlob(await plate3mfBytes(0), 'print-plates.3mf'); return; }
  const zip = new JSZip();
  for (let i = 0; i < n; i++) zip.file(`plate-${i+1}.3mf`, await plate3mfBytes(i));
  saveBlobAsync(await zip.generateAsync({ type: 'blob' }), `print-plates-x${n}.zip`);
}
$('plateGap').addEventListener('input', computePrintPlan);
$('stackToggle').addEventListener('change', computePrintPlan);
$('stackGap').addEventListener('input', computePrintPlan);

// ---------- downloads ----------
function saveBlob(buf, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([buf], { type: 'application/octet-stream' }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
function saveBlobAsync(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
function downloadPiece(id) {
  const b = builds[id];
  if (b) saveBlob(stlBinary(b.polys, `baseplate-${id}`), `baseplate-${id}.stl`);
}
function testTilePolys() {
  return buildTestTile(Object.assign({}, state, { drawerW: state.pitch, drawerD: state.pitch,
    marginMode: 'custom', mLeft: 0, mRight: 0, mFront: 0, mBack: 0 })).polys;
}
function activeKeyDims() {
  const d = state.connector === 'hclip' ? Object.assign(hclipPrm(state.hclip), { depth: 2.3 })
    : state.keyMount === 'wall' ? Object.assign({}, DEFAULTS.keySlim) : Object.assign({}, state.key);
  if (state.keyInsert === 'top' &&
      (state.connector === 'hclip' || state.keyMount === 'wall')) d.depth = 2.0;
  return d;
}
function activeKeyShape() {
  return state.connector === 'hclip' ? 'snap' : state.keyType;
}
function keysArray() {
  const kd = activeKeyDims();
  const wallish = state.keyMount === 'wall' || state.connector === 'hclip';
  const nKeys = layout.seams.reduce((a, s) => a + s.junctions.filter(j =>
    !wallish || Math.abs(j - Math.round(j)) <= 0.25).length, 0) || 1;
  let polys = [];
  const cols = Math.ceil(Math.sqrt(nKeys));
  for (let k = 0; k < nKeys; k++) {
    const key = buildKey(activeKeyShape(), kd, kd.depth - 0.15);
    const dx = (k % cols) * (kd.len + 6), dy = Math.floor(k / cols) * (kd.wEnd + 6);
    for (const p of key) polys.push({ verts: p.verts.map(v => [v[0]+dx, v[1]+dy, v[2]]), plane: p.plane });
  }
  return { polys, nKeys, kd };
}
function downloadFitSample() {
  const H = layout && builds[layout.pieces[0].id] ? builds[layout.pieces[0].id].meta.H : 4.25;
  const fsam = buildFitSample(state, H);
  saveBlob(stlBinary(fsam.polys, 'fit-sample'),
    `${state.connector}-fit-sample-clr-${fsam.clrs.map(c=>c.toFixed(2)).join('-')}.stl`);
}
/* Every connector that needs loose parts, in one list. The ZIP used to carry its own
   shorter copy of it that left out H-clips, so an hclip download arrived with a
   README telling the reader to press a clip into each junction and no clip in the
   file. One list, and one function that decides what is in the STL. */
const KEYED = ['bowtie', 'puzzlekey', 'snap', 'hclip'];
function keysStl() {
  if (state.connector === 'snap' && state.keyInsert === 'top') {
    const prm = Object.assign({ legT: 1.0, legLen: 1.35, legC: 1.4, barb: 0.18,
                                bridgeW: 1.7, bridgeD: 0.85, wall: 0.6 }, { clr: state.key.clr });
    const H = layout && builds[layout.pieces[0].id] ? builds[layout.pieces[0].id].meta.H : 4.25;
    const one = snapTopClip(prm, H);
    const nKeys = keysNeeded();
    let polys = [];
    const cols = Math.ceil(Math.sqrt(nKeys));
    for (let k = 0; k < nKeys; k++) {
      const dx = (k % cols) * 7, dy = Math.floor(k / cols) * 4;
      for (const p of one) polys.push({ verts: p.verts.map(v => [v[0]+dx, v[1]+dy, v[2]]), plane: p.plane });
    }
    return { polys, mesh: 'snap-clips', name: `snap-clips-x${nKeys}.stl` };
  }
  const { polys, nKeys } = keysArray();
  return { polys, mesh: 'connector-keys', name: `${state.connector}-keys-x${nKeys}.stl` };
}
function downloadKeys() {
  const k = keysStl();
  saveBlob(stlBinary(k.polys, k.mesh), k.name);
}
/* How many keys the assembly needs, counted the same way the key STL lays them out —
   anything housed in a wall skips a seam that overlaps by a single cell, because there
   is no wall junction there to sink one into. Top-inserted snap clips force that count
   whatever the housing says, since they enter through the wall by definition. */
function keyCount(wallOnly) {
  const wallish = wallOnly || state.keyMount === 'wall' || state.connector === 'hclip';
  return layout.seams.reduce((a, s) => a + s.junctions.filter(j =>
    !wallish || Math.abs(j - Math.round(j)) <= 0.25).length, 0);
}
const topClips = () => state.connector === 'snap' && state.keyInsert === 'top';
const keysNeeded = () => keyCount(topClips()) || 1;
async function downloadEverythingZip() {
  if (Object.keys(builds).length < layout.pieces.length) return;
  const zip = new JSZip();
  for (const pc of layout.pieces)
    zip.file(`baseplate-${pc.id}.stl`, stlBinary(builds[pc.id].polys, pc.id));
  if (KEYED.includes(state.connector)) {
    const k = keysStl();
    zip.file(k.name, stlBinary(k.polys, k.mesh));
  }
  if (printPlan) {
    for (let i = 0; i < printPlan.plates.length; i++)
      zip.file(`print-plates/plate-${i+1}.3mf`, await plate3mfBytes(i));
  }
  zip.file('README.txt', readmeText());
  saveBlobAsync(await zip.generateAsync({ type: 'blob' }),
                `gridfinity-baseplate-${layout.nx}x${layout.ny}.zip`);
}
function readmeText() {
  const rows = [...new Set(layout.pieces.map(p => p.band))].length;
  const lines = [];
  lines.push('GRIDFINITY BASEPLATE — generated by Drawerforge');
  lines.push('===============================================');
  lines.push('https://drawerforge.co.uk');
  lines.push('');
  lines.push(`Drawer: ${state.drawerW} x ${state.drawerD} mm | Grid: ${layout.nx} x ${layout.ny} cells @ ${state.pitch} mm`);
  lines.push(`Margins: L ${layout.mL.toFixed(1)} R ${layout.mR.toFixed(1)} F ${layout.mF.toFixed(1)} B ${layout.mB.toFixed(1)} mm`);
  lines.push(`Split: ${state.splitMode} | Pieces: ${layout.pieces.length} in ${rows} row band(s)`);
  lines.push(`Connectors: ${state.connector}` + (state.connector === 'dovetail' ? ` (clearance ${state.tab.clr} mm/side)` : ''));
  if (state.magnets) lines.push(`Magnets: ${state.magnetD} x ${state.magnetH} mm, from ${state.magnetSide}`);
  if (state.screws) lines.push(`Screws: ${state.screwHoleD} mm holes, ${state.screwHeadD} mm counterbore`);
  lines.push('');
  lines.push('LAYOUT (front of drawer at the bottom):');
  const bandIds = {};
  for (const pc of layout.pieces) (bandIds[pc.band] = bandIds[pc.band] || []).push(pc.id);
  Object.keys(bandIds).sort((a, b) => b - a).forEach(b => lines.push('  ' + bandIds[b].join(' | ')));
  lines.push('');
  lines.push('PRINTING: flat as oriented, no supports needed. Print the test tile first');
  lines.push('and check a bin fits before committing to the full plates.');
  lines.push('');
  if (printPlan) lines.push(`PRINT PLATES: ${printPlan.plates.length} — pre-arranged 3MF files in print-plates/ open directly in your slicer.`);
  lines.push('');
  if (state.connector === 'puzzle') {
    lines.push('ASSEMBLY: lower the pieces together on a flat surface so each jigsaw lobe');
    lines.push('drops into its cavity, then lift the assembled plate into the drawer.');
  } else if (state.connector === 'hclip' || ((state.connector === 'puzzlekey' || state.connector === 'snap' || state.connector === 'bowtie') && state.keyMount === 'wall')) {
    if (state.keyInsert === 'top' && state.connector === 'snap') {
      lines.push('ASSEMBLY: lay the pieces in the drawer edge to edge, then press a U-clip');
      lines.push('into each junction from above until it clicks. The bridge sits flush.');
      lines.push('Print clips flat as oriented with a 0.4 mm nozzle and 2+ walls.');
    } else if (state.keyInsert === 'top') {
      lines.push('ASSEMBLY: lay the pieces in the drawer edge to edge, then drop a key into');
      lines.push('each junction opening from above and press flush.');
    } else {
      lines.push('ASSEMBLY: place pieces face-down edge to edge, press a key into each pair');
      lines.push('of wall pockets, then flip and lower into the drawer.');
    }
  } else if (state.connector === 'puzzlekey' || state.connector === 'snap') {
    lines.push('ASSEMBLY: place pieces face-down edge to edge, press a key into each pair');
    lines.push('of recesses' + (state.connector === 'snap' ? ' until it clicks' : '') + ', then flip and lower into the drawer.');
  } else if (state.connector === 'dovetail') {
    lines.push('ASSEMBLY: on a flat surface, lay the piece with tabs down first, then lower');
    lines.push('each neighbour so its pockets drop over the tabs. Lift the assembled plate');
    lines.push('into the drawer. Tight joints: a light scrape on the tab flanks.');
  } else if (state.connector === 'bowtie') {
    lines.push('ASSEMBLY: place pieces face-down edge to edge, press a bowtie key into each');
    lines.push('pair of recesses, then flip the assembly and lower it into the drawer.');
  }
  lines.push('');
  lines.push('Settings link: ' + shareLink());
  lines.push('');
  lines.push('-----------------------------------------------');
  lines.push('Made with Drawerforge — https://drawerforge.co.uk');
  lines.push('Free and open source (MIT). Runs entirely in your browser.');
  lines.push('');
  lines.push('Bugs & feature requests:');
  lines.push('  https://github.com/Oliver-Johnson/Baseplate-Studio/issues');
  lines.push('  (attaching the settings link above makes reports much easier to act on)');
  lines.push('');
  lines.push('If it saved you some time, there is a tip jar:');
  lines.push('  https://ko-fi.com/oliver_johnson');
  lines.push('');
  lines.push('Gridfinity was created by Zack Freedman (Voidstar Lab) as an open standard.');
  return lines.join('\n');
}

/* ---------- the download dialog -------------------------------------------
   Export was panel 07: five buttons in the settings rail, present the whole time you
   were designing, three of them named after things you would have to download to
   identify. It is a dialog now, and it states what the design is and whether it fits
   your bed before it lists a single file. The row and group widgets are shared with
   the bins tool, in widgets.js. */
const exGroup = (text) => DF.group($('exFiles'), text);
const exRow = (name, meta, label, onClick, attrs) =>
  DF.row($('exFiles'), { name, meta, label, onClick, attrs });

const CONNECTOR_NAMES = { dovetail: 'dovetail tabs', puzzle: 'puzzle tabs', bowtie: 'bowtie keys',
  puzzlekey: 'puzzle keys', snap: 'snap clips', hclip: 'H-clips', none: 'no connectors' };

/* What goes wrong is tested before whether the build has finished, not after. Anything
   the checks call an error stops runBuild, so the pieces never finish and never will —
   and answering "this piece does not fit your bed" with "still building" is true and
   useless. warningsList is the same predicate runBuild gates on, so the dialog and the
   build cannot disagree about whether there is a problem. */
function bedFitText() {
  const bed = `${state.bedW} × ${state.bedD} mm bed`;
  // guard, so the "largest piece" arithmetic below never reasons about an empty list
  if (!layout.pieces.length)
    return { cls: 'bad', t: 'There is nothing to generate yet — see the checks under the cut map.' };
  const bad = layout.pieces.filter((pc) => !pieceFits(pc));
  if (bad.length)
    return { cls: 'bad', t: `${bad.length} piece(s) — ${bad.map((pc) => pc.id).join(', ')} — ` +
      `will not fit your ${bed}. Add a cut through them on the cut map, or pick a split mode ` +
      'that makes smaller pieces; the files below would print oversized as they stand.' };
  const err = warningsList().find((w) => w.err);
  if (err) return { cls: 'bad', t: err.t + ' Nothing can be exported until that is fixed.' };
  const ready = Object.keys(builds).length;
  if (ready < layout.pieces.length)
    return { cls: 'wait', t: `Still building — ${ready} of ${layout.pieces.length} piece(s) ready. ` +
      'The meshes below appear as they finish.' };
  // quoting pieceExtent, so the number shown is the number the test above used
  const big = layout.pieces.map(pieceExtent).sort((a, b) => b[0] * b[1] - a[0] * a[1])[0];
  return { cls: 'ok', t: `All ${layout.pieces.length} piece(s) fit your ${bed} — the largest ` +
    `needs ${big[0].toFixed(0)} × ${big[1].toFixed(0)} mm.` };
}

function renderExportSummary() {
  const pitch = state.pitch;
  $('exDesign').textContent =
    `${layout.nx} × ${layout.ny} cell grid (${(layout.nx * pitch).toFixed(0)} × ${(layout.ny * pitch).toFixed(0)} mm) ` +
    `in a ${state.drawerW} × ${state.drawerD} mm drawer\n` +
    `${layout.pieces.length} piece(s), ${state.splitMode} split, joined with ${CONNECTOR_NAMES[state.connector] || state.connector}\n` +
    `margins L ${layout.mL.toFixed(1)} / R ${layout.mR.toFixed(1)} / F ${layout.mF.toFixed(1)} / B ${layout.mB.toFixed(1)} mm`;
  const fit = bedFitText();
  $('exFit').className = 'exfit ' + fit.cls;
  $('exFit').textContent = fit.t;
}

function renderExportFiles() {
  $('exFiles').innerHTML = '';
  const ready = Object.keys(builds).length >= layout.pieces.length;
  if (printPlan) {
    const n = printPlan.plates.length;
    exGroup('Pre-arranged print plates');
    exRow('Every plate', `${n} plate(s) · 3MF` + (n > 1 ? ' in a ZIP' : ''),
          'Download', downloadAllPlates, { 'data-ex': 'allplates' });
    /* Per-plate downloads. The combined export already builds each plate on its own
       before zipping them, so one plate at a time is the same call with the zip left
       off — and it is what you want when one print failed, or when tonight's print is
       only this plate. */
    printPlan.plates.forEach((pl, i) => exRow(`Plate ${i + 1}`,
      `${pl.placed.length} part(s) on a ${state.bedW} × ${state.bedD} mm bed · 3MF`, 'Download',
      async () => saveBlob(await plate3mfBytes(i), `plate-${i + 1}.3mf`),
      { 'data-ex': 'plate' }));
  }

  exGroup('Meshes');
  exRow('Everything, with a README', 'every piece' +
        (printPlan ? ', the print plates' : '') + ' and the assembly order · ZIP',
        'Download', downloadEverythingZip, { 'data-ex': 'zip' });
  for (const pc of layout.pieces) {
    const b = builds[pc.id];
    const btn = exRow(`Piece ${pc.id}`,
          `${pc.nx} × ${pc.ny} cells · ` + (b ? `${DF.bytes(DF.stlBytes(b.polys))} · STL` : 'not built yet'),
          'STL', () => downloadPiece(pc.id), { 'data-ex': 'piece' });
    btn.disabled = !b;   // downloadPiece would otherwise fail silently
  }
  if (KEYED.includes(state.connector)) {
    exRow(state.connector === 'snap' ? 'Snap clips' : 'Connector keys',
          `${keysNeeded()} needed, laid out on one plate · STL`, 'STL', downloadKeys,
          { 'data-ex': 'keys' });
  }

  exGroup('Print these first');
  /* No byte size on this row. It is the one file nothing has built yet, and building a
     tile purely to measure it would be work done on every open for a number nobody
     needs — the point of the row is that it is small and quick. */
  exRow('Bin fit test tile', 'one 1 × 1 cell of the plate · STL',
        'STL', () => saveBlob(stlBinary(testTilePolys(), 'test-tile'),
                              'baseplate-test-tile-1x1.stl'), { 'data-ex': 'tile' });
  if (state.connector !== 'none')
    exRow('Joint fit sample', 'four tile pairs at graduated clearances · STL',
          'STL', downloadFitSample, { 'data-ex': 'fit' });
  if (!ready)
    for (const btn of $('exFiles').querySelectorAll('button[data-ex="zip"],button[data-ex="allplates"],button[data-ex="plate"]'))
      btn.disabled = true;
}

/* The dialog was a snapshot, and said so in a sentence that was not true: "the meshes
   below appear as they finish", from a render with exactly one call site — the open
   handler. Open it mid-build and it kept the same half-built list and the same disabled
   ZIP for good, and you had to close and reopen. The build is asynchronous and the page
   rebuilds behind a 260 ms debounce on every control change, so "change a setting, hit
   Download" lands there routinely on a slow machine.
   Rebuilding the list is the only honest option — the plate rows do not merely change,
   they do not exist until the plan does — so it is rebuilt, except while the keyboard
   is inside it, where a rebuild would throw the focus away mid-tab. That case retries
   as soon as focus leaves. */
let exportDeferred = false;
function syncExportDialog() {
  if (!$('exportDlg').open || !layout) return;
  renderExportSummary();
  if ($('exFiles').contains(document.activeElement)) { exportDeferred = true; return; }
  exportDeferred = false;
  renderExportFiles();
}
function updateExportTail() {
  if (!layout) return;
  const n = layout.pieces.length;
  $('exportTail').textContent = `${n} piece${n > 1 ? 's' : ''}` +
    (printPlan ? ` · ${printPlan.plates.length} plate${printPlan.plates.length > 1 ? 's' : ''}` : '');
  syncExportDialog();
}
function openExportDialog() {
  renderExportSummary();
  renderExportFiles();
  const dlg = $('exportDlg');
  // showModal is the whole point — the fallback is for a browser old enough not to
  // have it, where an in-flow panel that closes is still better than a dead button
  if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
}
$('openExport').addEventListener('click', openExportDialog);
$('exportClose').addEventListener('click', () => $('exportDlg').close());
$('exportDlg').addEventListener('focusout', () => {
  // the new focus is not settled until after the event, hence the deferral
  if (exportDeferred) setTimeout(syncExportDialog, 0);
});
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

// ---------- share link ----------
// Descriptor keys owned by the bins tool (or any future tool). We never interpret
// them, but we carry them so a round trip through here is lossless.
let hashExtras = {};
const OWNED = new Set(['w','d','mm','ax','ay','ml','mr','mf','mb','bw','bd','bh','sp','km','ki',
  'rc','cc','cn','cl','to','mg','md','mh','ms','sc','sh','sd','se','pi','or','bp','tc','bm','pc',
  'r1','r2','r3','r4','v','ph','ps']);

function descriptor() {
  const o = {
    w: state.drawerW, d: state.drawerD, mm: $('marginMode').value,
    ax: state.alignX, ay: state.alignY,
    ml: state.mLeft, mr: state.mRight, mf: state.mFront, mb: state.mBack,
    bw: state.bedW, bd: state.bedD, bh: state.bedH, sp: state.splitMode, km: state.keyMount, ki: state.keyInsert,
    rc: state.rowCuts || '', cc: state.colCuts ? state.colCuts.map(c => c.join('.')).join('_') : '',
    cn: state.connector, cl: state.tab.clr, to: state.tolerance,
    mg: state.magnets ? 1 : 0, md: state.magnetD, mh: state.magnetH, ms: state.magnetSide,
    sc: state.screws ? 1 : 0, sh: state.screwHoleD, sd: state.screwHeadD, se: state.screwHeadDepth,
    pi: state.pitch, or: state.outerRadius, bp: state.bottomPad, tc: state.topCutoff,
    bm: state.baseMode, ps: state.plateStyle, pc: $('perCorner').checked ? 1 : 0,
    r1: $('rFL').value, r2: $('rFR').value, r3: $('rBL').value, r4: $('rBR').value,
  };
  return Object.assign({}, hashExtras, o, { v: 2 });
}
const encodeDesc = (o) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
function shareLink() {
  return location.origin + location.pathname + '#' + encodeDesc(descriptor());
}
// Hand the drawer across to the bins tool. Only the shared keys travel; the bins
// tool re-emits anything it doesn't recognise, so a round trip is lossless.
function binsHref() {
  const built = layout && layout.pieces.length && builds[layout.pieces[0].id];
  const H = built ? built.meta.H : state.plateHeight;
  // full baseplate state plus the plate height bins needs; extras ride along
  return 'bins/#' + encodeDesc(Object.assign(descriptor(), { ph: (+H).toFixed(2) }));
}
for (const id of ['toBins', 'navBins'])
  $(id).addEventListener('click', (e) => { e.preventDefault(); location.href = binsHref(); });
// the guide holds no state, so hand it ours and it can hand it back
$('navGuide').addEventListener('click', (e) => {
  e.preventDefault();
  location.href = 'guide/#' + encodeDesc(descriptor());
});
$('shareBtn').addEventListener('click', () => {
  const link = shareLink();
  navigator.clipboard.writeText(link).then(
    () => { $('shareBtn').textContent = 'Copied ✓'; setTimeout(() => $('shareBtn').textContent = 'Copy settings link', 1600); },
    () => prompt('Copy this link:', link));
});
function loadFromHash() {
  if (!location.hash || location.hash.length < 3) return;
  const q = Object.fromEntries(location.hash.slice(1).split('&').map(kv => kv.split('=').map(decodeURIComponent)));
  for (const [k, v] of Object.entries(q)) if (!OWNED.has(k)) hashExtras[k] = v;
  const set = (id, v) => { if (v !== undefined && $(id)) $(id).value = v; };
  set('drawerW', q.w); set('drawerD', q.d); set('marginMode', q.mm);
  set('alignX', q.ax); set('alignY', q.ay);
  set('mLeft', q.ml); set('mRight', q.mr); set('mFront', q.mf); set('mBack', q.mb);
  set('bedW', q.bw); set('bedD', q.bd); set('bedH', q.bh); set('keyMount', q.km); set('keyInsert', q.ki);
  set('connector', q.cn); set('connClr', q.cl); set('tolerance', q.to);
  if (q.mg !== undefined) $('magnets').checked = q.mg === '1';
  set('magnetD', q.md); set('magnetH', q.mh); set('magnetSide', q.ms);
  if (q.sc !== undefined) $('screws').checked = q.sc === '1';
  set('screwHoleD', q.sh); set('screwHeadD', q.sd); set('screwHeadDepth', q.se);
  set('pitch', q.pi); set('outerRadius', q.or); set('bottomPad', q.bp); set('topCutoff', q.tc);
  set('baseMode', q.bm); set('plateStyle', q.ps);
  if (q.pc !== undefined) $('perCorner').checked = q.pc === '1';
  set('rFL', q.r1); set('rFR', q.r2); set('rBL', q.r3); set('rBR', q.r4);
  if (q.sp) {
    state.splitMode = q.sp; setSplitSeg(q.sp);
    if (q.sp === 'manual') {
      state.rowCuts = q.rc ? q.rc.split(',').map(Number).filter(n => !isNaN(n)) : [];
      state.colCuts = q.cc ? q.cc.split('_').map(s => s ? s.split('.').map(Number) : []) : [];
    }
  }
}

// ---------- wiring ----------
document.querySelectorAll('section.p>h2').forEach(h =>
  h.addEventListener('click', () => h.parentElement.classList.toggle('closed')));
document.querySelectorAll('#splitSeg button').forEach(b => b.addEventListener('click', () => {
  state.splitMode = b.dataset.v;
  if (b.dataset.v !== 'manual') { state.rowCuts = null; state.colCuts = null; }
  setSplitSeg(b.dataset.v);
  recomputeLayout();
}));
$('bedPreset').addEventListener('change', () => {
  const v = $('bedPreset').value;
  if (v !== 'custom') { const [w, d, h] = v.split(','); $('bedW').value = w; $('bedD').value = d; $('bedH').value = h; }
  recomputeLayout();
});
for (const id of [...numIds, 'alignX', 'alignY', 'marginMode', 'connector', 'connClr',
  'tolerance', 'magnetSide', 'magnets', 'screws', 'baseMode', 'perCorner', 'rFL', 'rFR', 'rBL', 'rBR', 'keyMount', 'keyInsert', 'plateStyle']) {
  $(id).addEventListener('input', recomputeLayout);
  $(id).addEventListener('change', recomputeLayout);
}
window.addEventListener('resize', () => { if (layout) drawMap(); });

initThree();
loadFromHash();
recomputeLayout();
fitThree();

