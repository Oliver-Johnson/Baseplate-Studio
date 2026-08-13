# Baseplate Studio

**Gridfinity baseplates cut to your drawer — measured, split for your printer, joined, and ready to print.**

Baseplate Studio is a free, open, browser-based generator for [Gridfinity](https://gridfinity.xyz/) baseplates that starts from the space you actually have. Enter your drawer's internal dimensions and it works out the grid, splits the plate to fit your print bed, adds printable connectors so the pieces join solidly, and exports everything as STL and 3MF — including pre-arranged print plates that open straight in your slicer.

Everything runs entirely in your browser. Nothing is uploaded, there's no account, and there's no tracking.

**[▶ Use it here](https://YOUR_USERNAME.github.io/YOUR_REPO/)** *(update this link after enabling GitHub Pages)*

---

## Features

- **Drawer-first workflow** — start from internal drawer dimensions; choose how leftover space becomes margins (centred, one-sided, custom per side, or left as a gap)
- **Four split modes** — Balanced, Staggered (brickwork joints so seams never line up), **Fewest plates** (searches split patterns to minimise print-bed loads), and Manual
- **Interactive cut map** — click any grid line to add or remove a cut; vertical lines cut one band, horizontal lines cut the whole plate
- **Seven joint options** — dovetail tabs, puzzle tabs, bowtie keys, puzzle keys, snap clips, H-clips, or none
- **Key housing & insertion choices** — keys in a solid floor (strongest) or inside the grid walls (no extra filament); inserted from beneath (face-down assembly) or **from above** (join the pieces inside the drawer), including **click-locking snap clips**
- **Magnets & screws** — spec-position pockets, openable from above or below, housed in a full solid floor or filament-saving corner bosses
- **Per-corner plate radii** — match rounded drawers, each corner set independently
- **Print plan** — automatic packing of pieces and connector keys onto your bed, plate-count display, optional stacked printing (any piece that fits the footprint below, respecting printer Z height)
- **Exports** — per-piece STL, all-plates 3MF, connector keys STL, bin-fit test tile, **joint fit sample** (four graduated clearances in one small print), and a ZIP with a README and assembly order
- **Share links** — the full configuration encodes into the URL for bookmarking or sharing
- **Live 3D preview** — full 360° orbit including the underside, exploded view

## How to use it

1. **Drawer & grid** — measure your drawer internally at its tightest point, subtract 1–2 mm so the finished assembly slides in, and enter width × depth. Pick how the leftover space is handled; the summary line shows the resulting grid and margins.
2. **Printer** — pick a preset or enter your bed size (width, depth, and Z height — height matters only for stacked printing).
3. **Split** — choose a mode. *Fewest plates* is usually the best starting point: it searches split patterns and often pairs two narrow pieces on one bed. Click grid lines on the cut map to fine-tune; any click switches to Manual and keeps your cuts.
4. **Connectors** — pick a joint. Rough guide:
   | Joint | Extra filament | Assembly | Notes |
   |---|---|---|---|
   | Dovetail tabs | none | lower pieces together, works in-drawer | printed on the pieces, no loose parts |
   | Puzzle tabs | solid floor (~2.6 mm) | lower together | strongest in-plane lock |
   | Bowtie / puzzle keys | floor **or** in-wall (none) | face-down + flip, or drop-in from above | loose printed keys |
   | Snap clips (from beneath) | floor or in-wall | face-down + flip | sprung dogbone keys |
   | **Snap clips (from above)** | none (in-wall) | **in the drawer — press until it clicks** | locks against lifting |
   | H-clips | none | face-down + flip, or drop-in from above | tiny keys, invisible from above |

   Whatever you pick, **print the joint fit sample first** (Export section): four tile pairs at graduated clearances tell you in one five-minute print which fit your printer produces.
5. **Magnets & screws** — optional; choose solid floor or corner-boss housing.
6. **Print plan** — check the plate count and layouts. Toggle stacking if you want to try printing pieces in a pile (experimental — the layer above bridges over open sockets, so test with two first).
7. **Export** — download the ZIP (everything, with a README), or individual pieces/plates/keys as needed. STLs print flat as oriented, no supports.

## Self-hosting

The entire app is one HTML file with no build step.

1. Fork or clone this repository.
2. In the repo settings, enable **GitHub Pages** (deploy from branch, root).
3. Done — the app is live at `https://<username>.github.io/<repo>/`.

The only external dependencies are three.js and JSZip, loaded from cdnjs at runtime. To run fully offline, download those two files and change the two `<script src>` tags.

## How it works (for the curious)

The geometry engine is hand-written JavaScript living in the same file:

- Socket profiles follow the published Gridfinity baseplate spec (42 mm pitch, three-part profile, 4.25 mm plate height) and were cross-verified against reference bins with ~0.24 mm radial clearance.
- Each piece is built by **region decomposition**: every grid cell becomes a directly-constructed watertight mesh, and features (connector pockets, magnet holes) are subtracted as small convex prisms — the one CSG operation that is numerically robust in a hand-rolled BSP.
- Cuts are designed to **never intersect the curved socket surfaces**; where a feature must cross them (top-insert pockets), a deterministic half-space clipper and directly-built pocket liners are used instead of CSG.
- Print-plate packing is shelf-based with rotation and footprint-stacking; the *Fewest plates* mode enumerates banded split patterns and packs each candidate.
- 3MF export writes the OPC container (model XML + content types + relationships) via JSZip.

Some joint pockets intentionally leave a few small uncapped faces where a cut interrupts the top rim (≈20 mm² per piece, all simple planar rectangles). Every mainstream slicer's automatic mesh repair closes these; if you use an unusual toolchain, glance at the slice preview once.

## Attribution

- **Gridfinity** was created by [Zack Freedman](https://www.youtube.com/c/ZackFreedman) (Voidstar Lab) as an open standard. This tool implements the published baseplate profile.
- The H-clip and click-locking snap-clip connector styles were inspired by the connector system in the Gridfinity Layout Tool; the geometry here is an independent implementation adapted to unpadded spec-height plates (parts are **not** interchangeable between the tools).

## Issues, suggestions & support

Found a bug, or want a feature? **[Open an issue](https://github.com/YOUR_USERNAME/YOUR_REPO/issues)** — bug reports with a settings share-link attached are especially easy to act on.

If the tool saved you some time and you'd like to support it, there's a tip jar at **[ko-fi.com/YOUR_KOFI](https://ko-fi.com/YOUR_KOFI)** — entirely optional, always appreciated.

## License

[MIT](LICENSE) — use it, fork it, embed it, sell prints made with it. A link back is appreciated but not required.
