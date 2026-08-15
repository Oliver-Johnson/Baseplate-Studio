# Spice jar baseplate

**Status:** first design, geometry frozen, unprinted. Recorded 2026-08-15.
**Build it:** `node tools/spice-plate.js`

A hex-packed socket plate for Sainsbury's own-brand spice jars, sized to one specific
drawer. Not Gridfinity — it shares Drawerforge's habits (drawer-first, split for the bed,
verified watertight headlessly) and none of its 42 mm geometry.

## The jar

Measured with calipers, 2026-08-15.

| | mm | |
|---|---|---|
| lid Ø | **48.85** | widest part of the jar — from a 2-jar touching span of 97.7 |
| body Ø | 46.80 | glass barrel |
| base Ø | 44.00 | at the floor, reaching full body Ø over the first 3 mm |
| height | 83.70 | |

**The lid is 2.05 mm wider than the body, and that governs everything.** Two jars cannot
stand closer than 48.85 apart no matter how narrow the glass is. The bodies look like they
have room; they don't. Every pitch here is a lid dimension, and only the bore is a body one.

Do not trust published figures for this jar. The widely-surfaced "44 mm" is a National Trust
museum record (object 1513945) of a Sainsbury's cinnamon jar dated **1990–2006** with a
plastic flip cap — a different generation. Figures of 47.5 and 49 mm are the *bores* of
third-party printed racks with someone else's clearance baked in.

## The drawer, and why it is measured indirectly

Direct measurement of a 218 mm span with a 157 mm caliper is worse than the trick:

- **Width** — push 4 jars hard against one side, measure the gap left at the other. `22.5 mm`.
  So `W = 4 × 48.85 + 22.5 = 217.90`.
- **Depth** — compress all 32 jars to one end, measure the excess. `11.6 mm`.

Both readings are small, so caliper error stays small. The width one has a second virtue:
writing `W = 4Ø + gap` makes the lid diameter **cancel out** of the offset,

```
q = (4Ø + gap) − Ø − 3(Ø + c) = gap − 3c
```

so an error in Ø moves the drawer width and the jar width together and the layout does not
notice. Across a ±0.5 mm band of lid diameter the depth consumed moves by 0.15 mm.

## Why the offset is not half a jar

A true half-offset of two rows of four needs `4.5 × 48.85 = 219.83 mm`. The drawer is
217.90 — short by **1.93 mm**. It is geometrically impossible, and the "tiny squeeze" felt
when pushing a fourth jar into a half-offset row of three *is* that 1.93 mm: the array
relaxes to `q = 22.50` and then spans exactly 217.90, wall to wall.

Nesting does not require a half offset. It requires only that adjacent-row neighbours stay
`p` apart, so

```
p = Ø + c            in-row pitch
q = gap − 3c         row offset, straight off the width
r = √(p² − q²)       row spacing — forced, never chosen
```

### The lever

Width spends clearance three times (three gaps across a row of four); depth then pays for it
seven times (seven row gaps). The exchange rate is **1.67 mm of drawer depth per 0.10 mm of
clearance between jars**. At `c = 0.40` the design consumes 9.4 mm of the 11.6 mm excess.
At `c = 0.60` the eighth row is gone and with it four jars.

Note that the budget is checked as *depth used over the compressed nest*, never against an
absolute drawer depth — the excess is measured, the depth is not. Assuming the nest was
compressed perfectly is the pessimistic direction, so the real margin is ≥ 2.2 mm.

### What the lid overhang costs the plate

Independently of `c`, the plate's own budget is fixed:

```
bore clearance + 2 × outer skin + 2 × fit clearance ≤ 2.55 mm
```

because the 2.05 mm lid overhang has already eaten the rest. Hence 0.60 / 0.60 / 0.375 —
there is no room for a conventional 1.6 mm perimeter wall, and none is needed: the drawer
wall retains the outer jars.

## How the mesh is built — no CSG

The plate is a **prism over a 2D region**. Region decomposition, as in `core.js`, but the
cells are Voronoi rather than grid:

1. Every jar owns its Voronoi cell — the plate rectangle clipped by the perpendicular
   bisector to every other jar. Convex, by construction.
2. The cell is clipped again to a **collar** of `bore/2 + 1.85`. Without this the cells fill
   every interstice and the plate is a solid slab with holes — 218 g instead of 80 g. Where
   two collars overlap the bisector binds first (24.63 < 25.55), so the shared wall stays a
   straight welded edge; where they do not reach — the 52.93 mm diagonal — the arc binds and
   a lightening hole opens.
3. The material in a cell is the ring between the cell polygon and the bore. Both loops are
   star-shaped about the jar centre, so a two-pointer angular merge triangulates it exactly.
4. Cells tile, so their triangulations weld into one manifold top surface. **Side walls are
   then extruded from whichever directed edges have no reverse** — that finds the outer
   boundary and all 32 bores without ever being told where they are.

`core.js`'s `triangulateRing` is *not* used: it bridges from the inner loop to the outer, which
needs the rounded-square rim shapes it was written for, and returns an empty triangle list on
a convex-polygon/circle pair. `ringStrip` in the generator covers that case instead.

Coordinates are quantised to 1e-4 mm so that a shared cell edge computed from two different
clipping orders welds rather than cracking.

Output is checked two ways: `checkManifold` for edge pairing, and a divergence-theorem volume,
which catches an open mesh that happens to pair its edges.

## The split

Rows are 44.64 mm apart but the bore is 47.40 mm across, so **no straight cut can miss the
sockets** — consecutive rows always overlap in y. The plate is therefore split by assigning
whole cells to pieces, which puts the seam on the Voronoi boundary. It zigzags between the
sockets, and the two halves interlock.

The pieces butt together with no connector. They are captive in the drawer and cannot separate.

### Reusing the fit strip as piece 1

The strip is a whole two rows of the real plate, so it can stay in the drawer and only
rows 3–8 need printing — 60 g instead of 80. One catch, and it is not obvious.

The strip was generated as its **own** 2-row lattice, so its rows were bounded by its own
outline rather than by the bisector with row 3. Its collars therefore reach `0.98 mm`
further than the same rows would in a one-piece plate:

| | mm from the strip's jar centres |
|---|---|
| bisector with row 3, where a one-piece plate would stop | 24.625 |
| collar as printed (`bore/2 + collar`, ÷cos(π/48) for the tangent-clipped polygon) | 25.605 |

So rows 3–8 must be cut back off it. The clip plane goes at `collar + seamGap` from each
strip jar, which is nearer than the bisector and shaves **0.105 mm** off the bottom of the
four row-3 bores. They carry 0.30 mm of radial clearance, so 0.195 mm survives — snug at four
points, and nowhere near tight enough to stop a jar going in. `buildPiece` reports the worst
bite and refuses outright if a bore is ever cut to within 0.10 mm of the real glass.

Note the collar clip **circumscribes** its circle rather than inscribing it, which is where
0.055 of that 0.105 comes from. Left as-is deliberately: correcting it now would make the
generator disagree with a part already on the drawer floor, for 55 microns.

Assembled extent is unchanged at 217.15 × 361.50 — the strip's extra material fills space
that would otherwise be a lightening hole.

## Numbers as built

| | |
|---|---|
| pitch p / offset q / row spacing r | 49.25 / 20.80 / 44.64 |
| bore | 47.40 (0.30 mm radial on the body) |
| shared wall | 1.85 |
| web height | 8.00, no floor |
| plate | 217.15 × 361.50 in a 217.90 drawer — 0.38 mm per side |
| pieces | 2 × (217.15 × 183.98), 40 g each |
| fit strip | 217.15 × 93.64, 20 g |

The web has no floor, so the jars sit on the drawer bottom and the plate costs none of the
10.8 mm of headroom. It only has to stop jars **sliding** — packed shoulder to shoulder at
83.7 mm tall, they cannot tip.

## Outcome: seven rows, not eight

**The drawer is 352.62 mm deep**, measured floor to floor with the printed strip and 2of3
seated (they span 228.62 and left a 124 mm gap). Rigid parts, no jar diameter in the
arithmetic. Every earlier depth figure was wrong, including the one this plate was built to.

The **11.6 mm excess was the bad datum**. A hand-compressed array of 32 jars is not a nest;
it implied a 363.97 mm drawer and the truth is 11 mm less. Two prints were committed before
that showed up. The jar-line method that caught it was itself only good to a few mm, because
loose jars in a wide drawer both gap (reads long) and stagger (reads short) and two readings
cannot separate the two effects.

What the numbers then say:

| | mm |
|---|---|
| 32 jars loose, at the tightest the width allows | 352.37 |
| drawer | **352.62** |
| 8-row plate, rows 1–5 as printed | 358.50 |
| 8-row plate, clean sheet at zero clearance | 352.42 |
| 7-row plate | **316.85** |

So the drawer was already **99.93 % full** with 32 loose jars. Any baseplate at all costs a
jar row, because a plate cannot nest tighter than bare jars: its rows sit 0.26 mm further
apart even at zero clearance, and seven gaps of that outweigh the 0.85 mm it saves at the
ends by having a bore narrower than a lid. A clean-sheet 8-row plate clears by 0.19 mm,
which is not a margin.

Seven rows is therefore the answer: **28 jars, 35.77 mm to spare**, and the last four live
outside the drawer. `spice-plate-3of3-28jar` finishes the plate from the strip and 2of3 that
are already printed. It is generated from a 7-row lattice, not by truncating the 8-row one,
so the back row is closed by the plate outline rather than cut short by the bisector with an
eighth row that does not exist.

## Open

- **Unprinted.** The fit strip exists to be printed first: it is full drawer width, so it
  tests whether 217.15 really slides in, and whether four jars sit on pitch across it.
- The bore assumes the jar's own 3 mm base taper is enough of a lead-in. No chamfer is cut.
- Jar-to-jar variation in lid diameter is unmeasured. It is not a failure mode — two fat lids
  touching just rub, since the sockets hold the bodies — but it would eat the 2.2 mm margin
  if it were systematic rather than random.
