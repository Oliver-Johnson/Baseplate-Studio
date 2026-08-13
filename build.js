#!/usr/bin/env node
/* Drawerforge build — splices src/template.html + src/core.js + src/ui.js into index.html.
 *
 * The single self-contained HTML file is a deliberate product feature (offline use,
 * trivial hosting), so the sources live apart and the shipped artifact is generated.
 *
 * Checks that must pass before anything is written (both have caught shipped bugs):
 *   1. syntax  — node --check on each script source
 *   2. id      — every $('id') referenced in ui.js exists as id="..." in the template
 *   3. display — every id hidden with style="display:none" in the template is un-hidden
 *                somewhere in ui.js, or it is unreachable in the UI
 *
 * Usage:  node build.js            build
 *         node build.js --check    verify index.html is up to date, write nothing
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = __dirname;
const SRC = path.join(ROOT, 'src');
const OUT = path.join(ROOT, 'index.html');
const checkOnly = process.argv.includes('--check');

const read = (p) => fs.readFileSync(p, 'utf8');
const fail = (msg, detail) => {
  console.error('\n  BUILD FAILED: ' + msg);
  if (detail) for (const d of detail) console.error('    - ' + d);
  console.error('');
  process.exit(1);
};

const template = read(path.join(SRC, 'template.html'));
const core = read(path.join(SRC, 'core.js'));
const ui = read(path.join(SRC, 'ui.js'));

/* ---- 1. syntax ---------------------------------------------------------- */
// node --check on a temp file; ui.js references core's globals, so check them
// separately rather than concatenated (undeclared globals are not syntax errors).
function syntaxCheck(name, source) {
  const tmp = path.join(os.tmpdir(), `drawerforge-check-${process.pid}-${name}`);
  fs.writeFileSync(tmp, source);
  try {
    execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
  } catch (e) {
    fail(`syntax error in src/${name}`, String(e.stderr || e.message).trim().split('\n'));
  } finally {
    fs.unlinkSync(tmp);
  }
}
syntaxCheck('core.js', core);
syntaxCheck('ui.js', ui);

/* ---- 2. id audit -------------------------------------------------------- */
// A silent template-patch miss once shipped a null-deref crash to a user.
const templateIds = new Set();
for (const m of template.matchAll(/\bid\s*=\s*["']([^"']+)["']/g)) templateIds.add(m[1]);

const referenced = new Map(); // id -> count
for (const m of ui.matchAll(/\$\(\s*['"]([^'"]+)['"]\s*\)/g)) {
  referenced.set(m[1], (referenced.get(m[1]) || 0) + 1);
}
const missing = [...referenced.keys()].filter((id) => !templateIds.has(id));
if (missing.length) {
  fail(
    `ui.js references ${missing.length} id(s) that do not exist in src/template.html`,
    missing.map((id) => `$('${id}')  — referenced ${referenced.get(id)}x`)
  );
}

/* ---- 3. display-reachability audit -------------------------------------- */
// An element hidden inline in the template and never un-hidden by script is dead UI.
// This is how the entire top-insert connector family became unreachable.
const hiddenIds = [];
for (const m of template.matchAll(/<[^>]*\bid\s*=\s*["']([^"']+)["'][^>]*>/g)) {
  if (/style\s*=\s*["'][^"']*display\s*:\s*none/i.test(m[0])) hiddenIds.push(m[1]);
}
const unreachable = hiddenIds.filter((id) => {
  // look for any assignment to this element's display, via $('id').style.display,
  // a captured variable, or a classList toggle keyed on the id
  const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return !new RegExp(`['"]${esc}['"]`).test(ui) ||
    !new RegExp(`['"]${esc}['"][^\\n]*\\)\\s*\\.style\\.display|${esc}[^\\n]*display`).test(ui);
});
if (unreachable.length) {
  fail(
    `${unreachable.length} element(s) are display:none in the template and never un-hidden by ui.js`,
    unreachable.map((id) => `#${id} — unreachable in the UI; un-hide it or remove it`)
  );
}

/* ---- splice ------------------------------------------------------------- */
const MARK = (name) => new RegExp(`[ \\t]*\\r?\\n?/\\*__${name}__\\*/[ \\t]*\\r?\\n?`);
for (const name of ['CORE', 'UI']) {
  if (!MARK(name).test(template)) fail(`src/template.html is missing the /*__${name}__*/ marker`);
}
const out = template.replace(MARK('CORE'), () => core).replace(MARK('UI'), () => ui);

if (checkOnly) {
  const current = fs.existsSync(OUT) ? read(OUT) : '';
  if (current !== out) {
    fail('index.html is out of date with src/ — run `node build.js` and commit the result');
  }
  console.log('  index.html is up to date (' + out.length + ' bytes)');
  process.exit(0);
}

fs.writeFileSync(OUT, out);
console.log(`  built index.html  ${out.length} bytes`);
console.log(`    core.js  ${core.length}  ui.js  ${ui.length}  template  ${template.length}`);
console.log(`    ids checked: ${referenced.size} referenced, ${templateIds.size} in template`);
