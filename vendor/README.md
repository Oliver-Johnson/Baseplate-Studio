# Vendored libraries

Third-party code, committed rather than fetched from a CDN. Both files are the
official minified builds, unmodified, with their licence banners intact.

| File | Version | Licence | Upstream |
|---|---|---|---|
| `three.min.js` | r128 | MIT — © 2010‑2021 Three.js Authors | https://threejs.org |
| `jszip.min.js` | 3.10.1 | MIT or GPLv3 — © 2009‑2016 Stuart Knightley | https://stuk.github.io/jszip/ |

```
three.min.js   603445 bytes   sha256 9274bbcec8d96168…
jszip.min.js    97630 bytes   sha256 acc7e41455a80765…
```

## Why they are here rather than on a CDN

Every page states that nothing is uploaded and nothing is tracked. That was true of
our own code and not quite true of the page, because two requests to `cdnjs.cloudflare.com`
fired on load and a third party saw every visitor's IP address. Serving them ourselves
closes that gap, and means the tools keep working on a network that blocks the CDN or
on a day the CDN is down.

It is a genuine trade rather than a free win. GitHub Pages sends
`Cache-Control: max-age=600` on everything and that cannot be configured, where cdnjs
sends a year with `immutable`. So a visitor returning after ten minutes re-fetches
about 172 KB gzipped that the CDN would have served from cache. Against that: the
first visit is faster, because there is no second origin to resolve and shake hands
with, and browser cache partitioning means the CDN copy was never shared with other
sites anyway.

Most people use this to lay out a drawer once, so first visits dominate.

## Updating

Replace the file, update the version, size and hash above, and check the licence
banner survived minification. `build.js` fails if any page references an external
script or stylesheet, so a CDN URL cannot creep back in unnoticed.

Only 16 `THREE.*` symbols are used, so most of three.js is dead weight — but removing
it needs a bundler, and this project has no build step beyond splicing text together.
Not worth the machinery.
