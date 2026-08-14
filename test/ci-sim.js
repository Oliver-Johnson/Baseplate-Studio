/* Simulate CI: splice the COMMITTED sources and compare to the COMMITTED outputs.
   Uses git's stored bytes, so working-tree line endings can't mask a real failure. */
const { execSync } = require('child_process');
const seo = require('../tools/seo.js');
const g = (p) => execSync(`git show HEAD:${p}`, { encoding: 'utf8', maxBuffer: 1e8 });
const MARK = (name) => new RegExp(`[ \\t]*\\r?\\n?/\\*__${name}__\\*/[ \\t]*\\r?\\n?`);

/* Must mirror build.js's TOOLS exactly. It drifted once already: chrome.js and the
   three guide pages were added to the build and not to here, so this reported a
   false failure on every page while the build itself was correct. */
const CHROME = 'src/shared-ui/chrome.js', CSS = 'src/shared-ui/style.css';
const tools = [
  { out: 'index.html', tpl: 'src/template.html',
    parts: { CSS, CHROME, CORE: 'src/core.js', UI: 'src/ui.js' } },
  { out: 'bins/index.html', tpl: 'src/bins/template.html',
    parts: { CSS, CHROME, CORE: 'src/core.js',
             BIN: 'src/bins/bin.js', UI: 'src/bins/ui.js' } },
  { out: 'guide/index.html', tpl: 'src/guide/template.html', parts: { CSS, CHROME } },
  { out: 'guide/split/index.html', tpl: 'src/guide/split.html', parts: { CSS, CHROME } },
  { out: 'guide/drawer-sizes/index.html', tpl: 'src/guide/drawer-sizes.html',
    parts: { CSS, CHROME } },
];

let ok = true;
for (const t of tools) {
  let s = g(t.tpl);
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
