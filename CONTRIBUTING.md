# Contributing

Thanks for looking. Issues and pull requests are both welcome, and so is simply
telling me something printed badly — that is harder to find out than it sounds.

## The one thing that will trip you up

**`index.html` and `bins/index.html` are generated. Do not edit them.**

Each page is one self-contained file with no external requests, which is what makes
the tools work offline and load instantly. That file is built by splicing the sources
in `src/` into a template:

```bash
node build.js
```

Edit the files in `src/`, run the build, and commit **both** the source and the
regenerated page. `node build.js --check` fails if they are out of step, and CI runs
it, so a change to only one of them will not merge.

## Running the checks

```bash
npm ci && npx playwright install chromium
```

Then:

```bash
npm run test:all
```

That covers:

| | |
|---|---|
| `build.js --check` | pages match `src/`, scripts parse, every `$('id')` exists, no unreachable `display:none` element |
| `test/bin-audit.js` | bin geometry against the published spec, and **every mesh watertight** |
| `test/fit-check.js` | a spec bin fits the socket the baseplate ships |
| `test/hash-roundtrip.js` | a layout survives the URL round trip byte for byte |
| `test/seo-check.js` | structured data parses and matches the visible prose |
| `test/ui/` | Playwright: place, carve, merge, resize, share |
| `test/ci-sim.js` | what CI will see, from git's bytes rather than your working tree — useful on Windows, where line endings can hide a stale file |

## Geometry, before you change any of it

Read [`docs/ENGINE.md`](docs/ENGINE.md) first. It is short, and it is a list of things
that have already broken this mesh once. The two that catch people:

- **Never cut near a conical surface.** The CSG is hand-rolled and BSP-based; it will
  produce a mesh that looks fine and slices wrong. Build overlapping closed shells
  instead of subtracting.
- **`earTriangulate` fails silently.** It returns a partial triangulation rather than
  throwing. That shipped bins with 218 boundary edges and a slicer rejected them as
  non-manifold. If you add a surface, the audit must show `watertight` — a low
  proportion of bad edges is not "close enough", it is a hole.

`test/bin-audit.js` is the arbiter. If it does not say `all cases clean`, the change
is not finished, whatever the preview looks like.

## Scope

The tools implement the published Gridfinity standard, so output has to stay
compatible with anyone else's baseplates and bins. Changes to the 42 mm pitch, the
7 mm height unit or the foot profile are out of scope.

Everything runs locally in the browser. There is no server, no account and no
analytics, and that is a deliberate constraint rather than an unfinished state.

## Style

Match the surrounding code. Comments explain *why* — particularly why something is
done the awkward way — because most of the awkward code here is awkward for a reason
that cost time to find.
