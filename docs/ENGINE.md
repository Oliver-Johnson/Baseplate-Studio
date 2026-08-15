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
  holes. This class is now genuinely safe rather than safe-by-reputation; see §2a for
  what was actually wrong with it and what the two standing rules are.

- **One cutter solid per subtraction.** A poly soup handed to `csgSubtract` must be a
  single non-self-overlapping solid. Two shells that overlap ask the tree whether a point
  inside both is in or out, and it has no answer.

- **Overlapping closed shells instead of union.** Regions overlap by `BLOAT = 0.05`. Tabs,
  bosses, pocket cups, bin feet, lips and dividers are separate shells fused by the
  slicer. **Never CSG-union shells together.**

- **`clipConvexPrismTop`** — deterministic sequential half-space splitting, no BSP
  classification at all. Removes material inside a convex 2D polygon above a z-plane, and
  is safe through any geometry including cones. This is the escape hatch when a cut must
  cross curved surfaces.

- **Coincidence-breaking jitter** (`J = 0.0017` on cutter positions), and keeping cutter
  faces off exactly-coplanar planes.

## 2a. What was actually wrong with the CSG

Read this before you believe anything in §2 about cones. For most of the project's life
`csgSubtract` was lossy for **every** cutter shape — a watertight box minus a watertight
prism came back with boundary edges for an interior hole, a blind pocket, an edge notch
and a corner bite alike. Four things were wrong. They are listed **in order of how much
they actually mattered**, which is not the order they were found in, and the ordering is
from ablation rather than from the story that felt right at the time: each fix was
reverted on its own and `test/plate-audit.js` re-run against it.

1. **T-junctions and micron slivers — the decisive one.** A split plane halves every
   polygon it crosses but passes a polygon it only grazes straight through, leaving a
   vertex in the middle of a neighbour's edge. Geometrically sealed, combinatorially
   open, and a slicer counts edges rather than area. Separately, where two cutter planes
   cross a face at a shallow angle they carve the same corner twice a couple of microns
   apart. `healCsgSeams` repairs both on the way out of every `csgSubtract` and
   `csgUnion`. **Disable it and everything else in this list stops mattering:** magnets
   3207 bad edges, screws 8389, dovetail 671, and all four minimum CSG cases fail. It is
   not optional decoration; a change that bypasses it puts the holes straight back.

2. **Overlapping cutters in one soup.** The screw shank runs up the middle of its own
   counterbore and shares its bottom cap; the counterbore in turn sits inside the magnet
   pocket. Concatenated into one "solid" that was 14304 bad edges on a 3x3 plate — and,
   worse than an edge count, the shank wall stood *inside* the counterbore cavity as real
   material: 486 mm³ of it on a 3x3 plate, exactly 13.5 mm³ × 36 sites, 13.5 being the
   12-gon shank over the 2 mm counterbore depth. Union them into one solid first
   (`fastenerCutter`) or batch them so no two shells in a call overlap. Reverting just
   this leaves screws at 740 bad edges with the repair still in place. Unioning
   **cutters** is fine; the ban in §1 is on unioning parts of the model.

3. **The rim cap was inside out — real, but minor for watertightness.** `annulusStrip`
   pairs a 4-corner cell outline against a `4*arcSegs` socket ring by sweeping angle.
   With four outer vertices the sweep parks on one corner and fans across a quarter of
   the ring, and a fan from a point outside a convex loop only stays inside the annulus
   as far as that point's **tangent** to the loop. Past the tangent the triangle turns
   over. **21% of every cell rim faced downwards at the shipped arcSegs 6, rising to 33%
   at 24.** Watertightness cannot see it, and neither can enclosed volume.

   Be careful about what this cost. It is tempting — I did it — to call this the root
   cause on the grounds that `csgSubtract` builds its BSP from these very planes, so a
   wrong-facing plane makes the tree answer "outside" for solid material millimetres
   away. Measured, it is worth 6–17%: applying only this fix to the old code takes
   magnets 7480 → 6947, screws 14304 → 13483, dovetail 4338 → 3605. Reverting only this
   fix from the current code leaves dovetail at 118 and magnets+screws at 8, everything
   else watertight — and the quarantined puzzle case slightly *better*, at 62 not 78. Fix
   it because an inside-out triangle is wrong on its own terms, not because it was the
   bug.

4. **The result was read out of the solid's own tree — an optimisation, and untested.**
   Textbook csg.js returns `a.allPolygons()`, but `a`'s tree was built by splitting `a`'s
   polygons against each other. A cell region carries ~300 socket-surface triangles whose
   planes graze the top annulus at thousandths of a degree, and partitioning the annulus
   by all of them shreds it: `csgSubtract(region, [])` — subtracting *nothing* — took a
   region from 394 polygons to 1524 and opened 481 bad edges. `csgSubtract` now keeps the
   original `a` polygons and puts them through `b`'s tree only.

   **This buys no watertightness at all.** Restore the textbook version with
   `healCsgSeams` still in place and every case in the audit still passes; the only
   difference is polygon count, 45332 → 29242 on the 3x3 screws case, a 35% saving. Treat
   it as a performance change. **Nothing in the audit would catch its reversion**, so if
   you are debugging something and want the textbook form back, you may have it — but
   check the polygon count before you decide the change was free.

## 2. What destroys meshes

All empirically confirmed, all from real corruption:

- **Any BSP cut that intersects the conical socket surfaces** (bottom chamfer z 0–0.7, top
  rim cone z 2.5–4.25). Symptom: cells progressively lose walls and rims with height;
  slices come back with ~25% open paths. This killed full-height dovetail notches,
  through-slot H-clips (three attempts), and generic top pockets via CSG.
  **Caveat:** see §2a. Every one of those failures happened while `csgSubtract` was
  leaving T-junctions in everything it touched and the rim above the cones carried
  inverted triangles, and the cell region now survives cuts through the cone band
  cleanly. The rule is kept because it is cheap to obey and nobody has retested the three
  features it was written for — not because the mechanism is still understood.
- **Extruding non-planar quads on cones.** Corner-arc faces are conical — a quad spanning
  one is non-planar. **Emit triangles.** The same applies anywhere a face's four corners
  do not share a plane, such as a wall top whose height varies along its length.
- **Complex concave outline extrusions** minus large curved cutters. An L-shaped plate
  outline is exactly this — see the note on reflex corners below.
- **Cutters poking below z = 0** leave inverted fragments. `clampZ(polys, 0)` on
  `buildPiece` output is mandatory and already in place.
- **Wrong outline winding into `extrudePoly`** produces inside-out shells. Normalise CCW.

Three related traps in the supporting code:

- `clipToRect` is textbook Sutherland–Hodgman with **no concave handling**.
- `earTriangulate` fails **silently** on malformed input — it breaks out of its loop and
  returns a partial triangulation rather than throwing.
- **A polygon whose vertices have drifted off its stored plane will hang `Node.build`.**
  The build takes its splitting plane from one of the polygons it is sorting; if that
  polygon's own vertices no longer classify as coplanar, nothing lands in the node, every
  polygon goes to the same child, and the child makes the same choice forever. It grows a
  tree until the heap dies.

  `splitPolygon` now treats a polygon carrying that exact plane as coplanar whatever its
  vertices say, which makes progress unconditional. That guard is not belt-and-braces:
  **`healCsgSeams` deliberately breaks the plane/vertex agreement**, because a repaired
  polygon keeps its parent's plane while its vertices may have moved by up to `VTOL`, and
  the sub-triangles of a centroid fan inherit that plane rather than deriving one from
  three nearly-collinear points. So drift is a normal condition here, not a bug, and the
  shortcut is what makes it survivable.

  Everywhere else, keep planes and vertices together. `transformPolys` does **not**: it
  is for export, where nothing reads a plane. Use `movePolys` for anything a BSP sees.

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

Manifold checks read **zero** for everything the audit does not name. The old advice here
— judge against a ~20% bad-edge baseline, because overlapping shells are the deliberate
construction — was wrong twice over. Overlapping shells do not produce bad edges: each
shell is closed on its own, so every edge is still used exactly twice. The 20% was holes,
and treating it as normal is what let them stay for the life of the project.

Three configurations still leak, and they are **quarantined by name in
`test/plate-audit.js` rather than excused here**, so the summary line cannot say
"watertight" over them. Do not generalise from them to a new tolerance for nonzero
counts; the whole point of naming them is that the number for everything else is zero.

Read the edge-use histogram the audit prints before deciding what a leak is, because two
very different bugs both show up as "bad edges":

| use count | meaning |
|---|---|
| **1 or any odd** | open boundary — a hole, always a real defect |
| **4, 6, even** | two or three shells meeting face to face — no hole |

`baseMode: 'bosses'` is entirely the second kind: corner bosses of adjacent cells abut on
the cell boundary instead of overlapping by `BLOAT`, so every shared face is counted
twice, and no edge is ever used once. Bloating the bosses would fix it, at the cost of
changing their footprint. `connector: 'puzzle'` is the first kind and is a genuine hole —
30 edges used once on a 9x9 plate. Both are far better than they were (2964 and 5033),
neither is fixed.

Run the headless audits:

```bash
node test/plate-audit.js
```

```bash
node test/bin-audit.js
```

```bash
node test/fit-check.js
```

`plate-audit.js` builds **every piece** of a split plate, not just the first — an earlier
version checked `pieces[0]` and passed while measuring a piece that had no notches at
all. It also asserts **enclosed volume** on the minimum CSG and union cases, and that
matters more than it looks: `healCsgSeams` optimises connectivity directly, so
"watertight" is a metric it can satisfy by construction. Volume is the independent one,
and it is what showed that the screw counterbore had never really been cut.

A warning about writing checks for this file. The rim-cap check originally asserted two
things and claimed they were complementary: no triangle inverted, and the signed areas
summing to outline minus ring. The second cannot fail. For **any** complete pairing of
the two loops the interior spokes cancel and the sum telescopes to that value by Green's
theorem, whatever the orientations — it passed at 1e-13 on the fully broken code at every
smoothness. A check that cannot fail on the bug its own comment describes is worse than
none, because it stops anyone looking. It is now a triangle count instead. This project
has shipped three tests that passed while measuring nothing; do not make it four.

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
