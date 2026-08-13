# Socket corner clearance — known deviation from spec

**Status:** known, deliberately not fixed. Recorded 2026-08-13.
**Measure it yourself:** `node test/fit-check.js`

## Summary

A Gridfinity baseplate socket should be the spec bin foot offset outward by a uniform
0.25 mm. Ours is offset correctly along the flats but not in the corners, so corner
clearance is about a third of the intended value.

| socket config | worst flat gap | worst corner gap |
|---|---|---|
| **as shipped** (`socketRadius 4.0`) | 0.196 mm | **0.070 mm** |
| centres matched (`socketRadius 3.6`) | 0.248 mm | 0.188 mm |
| centres matched, ideal arcs | 0.250 mm | 0.250 mm |

The bottom row falls out to exactly `(42 − 41.5) / 2 = 0.25` on both flats and corners,
which is the nominal Gridfinity tolerance. That is what the geometry is meant to be.

## Cause

Both the socket and the bin foot are rounded squares. A rounded square is fully described
at a given height by its half-width and corner radius, and its corner-arc **centre** sits
at `half − r`. When two rounded squares share a centre, the gap between them is uniform all
the way round. When they do not, the corners bind first.

The radius law in `src/core.js` (`buildPiece`, the `prof` object) anchors the radius at the
rim rather than at full pitch:

```js
const r = prof.rTop - (d - ds[ds.length-1]);   // ds[last] is topCutoff = 0.4
```

That places our corner-arc centre at **16.60 mm**. The spec bin's is at
`41.5/2 − 3.75 = ` **17.00 mm**. The 0.4 mm discrepancy is exactly `topCutoff`, and it
costs 0.18 mm of corner clearance.

`socketRadius = 4.0` is itself correct — it is the bin's 3.75 fillet plus the 0.25
tolerance. It is simply anchored 0.4 mm too high up the profile.

## Fix, when we take it

Either of these produces identical geometry today:

1. **Preferred** — change the law to `r = prof.rTop - d`. `socketRadius` then means
   "corner radius at full pitch", stays equal to 4.0, and remains correct if anyone
   changes `topCutoff`.
2. Leave the law and set the `socketRadius` default to `3.6`. Correct now, silently wrong
   if `topCutoff` ever changes.

No CSG, no restructuring — one arithmetic change in a constant.

## Why it is not fixed

The current profile is **field-proven**: plates printed from it accept real bins, and the
owner's measured ~0.21–0.24 mm matches the predicted flat clearance of 0.196–0.21 mm.
Corner clearance of 0.070 mm is small but positive, so bins seat; they are simply snug at
the corners with almost no margin for over-extrusion or elephant's foot.

Changing it would loosen corners by 0.118 mm and flats by 0.05 mm. That is more
spec-conformant, but it alters a physically validated design, so it wants a printed
comparison first — the joint fit sample export is the cheap way to do that.

## Notes for whoever picks this up

- **Bins we generate must follow the published spec** (corner-arc centre 17.00 mm), never
  our socket's 16.60 mm. Matching our own socket would produce bins that fit only our
  plates and no one else's.
- **Faceting is a minor term.** `arcSegs 6` costs 0.014 mm at the corners, not the ~0.034 mm
  that was estimated before measurement. It is still a fit parameter rather than a
  rendering knob — raising it loosens the fit slightly against third-party bins — but it is
  not the reason corner clearance is tight.
- `test/fit-check.js` derives the bin foot from the published spec only and never reads
  `src/core.js`. Keep that independence; deriving the bin from our own socket would make any
  shared error invisible.
