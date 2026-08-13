# Geometry engine — rules before you touch anything

The geometry is a hand-rolled BSP CSG plus direct mesh construction. The CSG is
**numerically fragile in specific, well-mapped ways**. Several features were redesigned
around these constraints after catastrophic mesh corruption; the failure mode is not a
crash but silently broken output that only shows up as a bad print.

These rules were expensive to learn. Trust them.

---

## 1. What is safe

- **Direct mesh construction.** Build each region as an explicit watertight mesh: outline
  side quads, socket ring strips (triangles only), bridged annular faces via
  `triangulateRing`'s keyhole method, closed floors. This is the backbone. CSG never
  builds primary geometry.

- **CSG subtraction of small convex vertical prisms from a directly-built region** — the
  "box-minus-box class". Notch pockets, key recesses, magnet and screw cylinders, boss
  holes. Robust when the cutter intersects **only planar faces**.

- **Overlapping closed shells instead of union.** Regions overlap by `BLOAT = 0.05`. Tabs,
  bosses, pocket cups, bin feet, lips and dividers are separate shells fused by the
  slicer. **Never CSG-union shells together.**

- **`clipConvexPrismTop`** — deterministic sequential half-space splitting, no BSP
  classification at all. Removes material inside a convex 2D polygon above a z-plane, and
  is safe through any geometry including cones. This is the escape hatch when a cut must
  cross curved surfaces.

- **Coincidence-breaking jitter** (`J = 0.0017` on cutter positions), and keeping cutter
  faces off exactly-coplanar planes.

## 2. What destroys meshes

All empirically confirmed, all from real corruption:

- **Any BSP cut that intersects the conical socket surfaces** (bottom chamfer z 0–0.7, top
  rim cone z 2.5–4.25). Symptom: cells progressively lose walls and rims with height;
  slices come back with ~25% open paths. This killed full-height dovetail notches,
  through-slot H-clips (three attempts), and generic top pockets via CSG.
- **Extruding non-planar quads on cones.** Corner-arc faces are conical — a quad spanning
  one is non-planar. **Emit triangles.** The same applies anywhere a face's four corners
  do not share a plane, such as a wall top whose height varies along its length.
- **Complex concave outline extrusions** minus large curved cutters. An L-shaped plate
  outline is exactly this — see the note on reflex corners below.
- **Cutters poking below z = 0** leave inverted fragments. `clampZ(polys, 0)` on
  `buildPiece` output is mandatory and already in place.
- **Wrong outline winding into `extrudePoly`** produces inside-out shells. Normalise CCW.

Two related traps in the supporting code:

- `clipToRect` is textbook Sutherland–Hodgman with **no concave handling**.
- `earTriangulate` fails **silently** on malformed input — it breaks out of its loop and
  returns a partial triangulation rather than throwing.

## 3. The derived design law

> **Every cut is shaped so it stays inside a safe zone.**

The safe zones are: the wall vertical band (lateral ±2.15 from the wall centreline,
z 0.7–2.5), a solid floor pad below all ring geometry, and z ≤ ~2.4 ceilings.

Where a feature must cross the rim, it is built as a clip plus directly-constructed
liners and boxes — never CSG. If you add a joint type, obey this or you will rediscover
the failure modes expensively.

**Corollary for non-rectangular plates:** force a split at every reflex corner so every
*piece* stays a convex rounded rectangle. The concave outline then never gets extruded as
a single shell, and the failure mode is structurally out of reach rather than merely
avoided by care.

## 4. The bins engine

`src/bins/bin.js` contains **no CSG at all**, deliberately. Everything is direct
construction plus overlapping shells, so none of §2 is reachable. Keep it that way:

- Features that look like subtractions can be **added** instead. A scoop is an added
  prism, not a curved cutter. A label tab is an added prism, not a cut.
- If magnet or screw pockets are ever added, they are the proven box-minus-box class —
  but **no cutter's z-range may reach below the top of the feet**, or it will cross the
  foot's chamfer cones.
- Every rounded square in a bin shares the corner-arc centre **17.00 mm**
  (`41.5/2 − 3.75`). That constant is what makes clearance uniform around the perimeter
  instead of binding at the corners. See [socket-clearance.md](socket-clearance.md) for
  what happens when two mating profiles disagree about it.
- All rings in one bin must share a vertex count so the skins stitch. `SSEG` is a
  constant, not a parameter, for exactly this reason.

## 5. Verifying a change

Manifold checks **never read zero** here, because overlapping shells are the deliberate
construction. Judge against baselines, not against zero:

| geometry | bad-edge ratio |
|---|---|
| shipped baseplate piece | 1120 / 5510 ≈ **20%** |
| bins | **3–11%** |

Run the headless audits:

```bash
node test/bin-audit.js
```

```bash
node test/fit-check.js
```

`bin-audit.js` checks footprint and height against the published spec, `zmin ≥ 0`, and
slices the real mesh at five heights to compare flat half-width *and* corner reach.
`fit-check.js` measures bin-to-socket clearance, deriving the bin from the published spec
only — **never from `src/core.js`**. Keep that independence: deriving the reference from
our own geometry would make any shared error invisible.

Other standard audits, from the original development (they need `trimesh`, which is not
currently installed):

- **Socket count** — section at z = 3.5 (or ztop − 0.7 with pad), count closed loops with
  both spans in **36–41.5 mm**. Looser windows false-positive on 42.1 mm cell rectangles.
- **Open-path count** — `sec.to_2D()`, count `not e.closed` across ~10 z levels. Baselines:
  dovetail / puzzle / snap-floor / bowtie-floor **0**; hclip-bottom ~22; wall keys ~36;
  puzzlekey ~46; top-insert cup ~100.
- **Occupancy probes** — matplotlib `Path` even-odd on section loops. Known traps:
  parity **lies** wherever shells intentionally overlap, so probe only single-shell
  locations; `trimesh`'s `discrete` silently drops unclosed loops, so regions near
  intended openings render empty; and never slice exactly on a coincident plane — offset
  by 0.03–0.13.
- Every config: assert `zmin ≥ −0.001` and `zmax ≤ H + 0.05`.

## 6. Things that are not what they look like

- **`arcSegs` is a fit parameter, not a rendering knob.** At 6 segments the inscribed
  polygon's sagitta on r = 4 is ~0.034 mm. Raising it to smooth the preview loosens the
  physical fit against third-party bins. Measured contribution to corner clearance:
  0.014 mm.
- **Raw mesh volume is not filament.** The overlapping-shell construction double-counts,
  and slicers infill anything thick. Estimate analytically from parameters: thin features
  at full density, thick blocks as shell + infill × core.
- **The socket's corner clearance is not uniform.** Known, documented, deliberately not
  fixed — see [socket-clearance.md](socket-clearance.md).
