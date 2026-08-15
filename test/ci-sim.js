/* Simulate CI: splice the COMMITTED sources and compare to the COMMITTED outputs.
   Reading git's stored bytes answers the question `build.js --check` cannot — whether
   what you are about to push holds together, rather than what happens to be on disk.
   A page rebuilt but never staged passes there and fails here, which is the case CI
   sees. (This used to warn that working-tree line endings could hide a stale file on
   Windows; .gitattributes checks every text file out as LF now, so the working tree
   and git's bytes no longer disagree.) */
const { execSync } = require('child_process');
const seo = require('../tools/seo.js');
const g = (p) => execSync(`git show HEAD:${p}`, { encoding: 'utf8', maxBuffer: 1e8 });
const MARK = (name) => new RegExp(`[ \\t]*\\r?\\n?/\\*__${name}__\\*/[ \\t]*\\r?\\n?`);

/* The same manifest build.js splices from. This used to be a hand-kept copy that
   "must mirror build.js's TOOLS exactly", and it drifted twice — once when chrome.js
   and the three guide pages were added to the build and not to here, and again when
   the download-dialog widgets were. Both times it reported a failure against a build
   that was correct, which is the worst kind of check to have. */
const tools = require('../tools/manifest.js');

let ok = true;
for (const t of tools) {
  let s = g(t.template);
  for (const [m, f] of Object.entries(t.parts)) {
    if (!MARK(m).test(s)) { console.log(`${t.out}: marker ${m} NOT FOUND`); ok = false; }
    s = s.replace(MARK(m), () => g(f));
  }
  s = seo.inject(s);
  const committed = g(t.out);
  const match = s === committed;
  if (!match) ok = false;
  console.log(`${t.out.padEnd(16)} ${match ? 'matches committed output' : `DIFFERS (${s.length} vs ${committed.length})`}`);
}
console.log(ok ? '\nCI will pass.' : '\nCI WOULD FAIL.');
process.exit(ok ? 0 : 1);
