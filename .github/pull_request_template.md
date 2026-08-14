<!-- Thanks for the patch. Please skim CONTRIBUTING.md if you have not already. -->

## What this changes

<!-- and why -->

## Checks

- [ ] I edited the sources in `src/`, not the generated `index.html` / `bins/index.html`
- [ ] I ran `node build.js` and committed the regenerated pages alongside the sources
- [ ] `npm run test:all` passes

## If this touches geometry

- [ ] `node test/bin-audit.js` reports **`all cases clean`** — every mesh watertight
- [ ] I added a case covering the new shape

<!-- A screenshot of the preview is welcome, but it is not evidence: a mesh with holes
     renders perfectly and still fails in a slicer. The audit is the evidence. -->
