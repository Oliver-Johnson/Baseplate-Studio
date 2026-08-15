#!/usr/bin/env node
/* Drawerforge build — splices sources into one self-contained HTML file per tool.
 *
 * The single self-contained HTML file is a deliberate product feature (offline use,
 * trivial hosting), so the sources live apart and the shipped artifacts are generated.
 *
 * Checks that must pass before anything is written (each has caught a shipped bug):
 *   1. syntax  — node --check on every JS source
 *   2. id      — every $('id') referenced in a tool's ui.js exists in its template
 *   3. display — every id hidden with style="display:none" in a template is
 *                un-hidden somewhere in that tool's ui.js, or it is dead UI
 *
 * Usage:  node build.js            build every tool
 *         node build.js --check    verify outputs are up to date, write nothing
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = __dirname;
const checkOnly = process.argv.includes('--check');

/* Each tool: a template with /*__MARKER__* / comments, and a file per marker.
   CORE and the CSS are shared — one source, both tools, no drift. */
const TOOLS = [
  {
    name: 'baseplates',
    template: 'src/template.html',
    out: 'index.html',
    changefreq: 'weekly', priority: '1.0',
    parts: { CSS: 'src/shared-ui/style.css', CHROME: 'src/shared-ui/chrome.js',
             CORE: 'src/core.js', UI: 'src/ui.js' },
    uiPart: 'UI',
  },
  {
    name: 'bins',
    template: 'src/bins/template.html',
    out: 'bins/index.html',
    changefreq: 'weekly', priority: '0.9',
    parts: { CSS: 'src/shared-ui/style.css', CHROME: 'src/shared-ui/chrome.js',
             CORE: 'src/core.js', BIN: 'src/bins/bin.js', UI: 'src/bins/ui.js' },
    uiPart: 'UI',
  },
  {
    // A prose page: shared stylesheet, no scripts. The id and display audits are
    // trivially satisfied because there is no UI source to check against.
    name: 'guide',
    template: 'src/guide/template.html',
    out: 'guide/index.html',
    changefreq: 'monthly', priority: '0.8',
    parts: { CSS: 'src/shared-ui/style.css', CHROME: 'src/shared-ui/chrome.js' },
  },
  { name: 'guide-split', template: 'src/guide/split.html',
    out: 'guide/split/index.html',
    changefreq: 'monthly', priority: '0.7',
    parts: { CSS: 'src/shared-ui/style.css', CHROME: 'src/shared-ui/chrome.js' } },
  { name: 'guide-sizes', template: 'src/guide/drawer-sizes.html',
    out: 'guide/drawer-sizes/index.html',
    changefreq: 'monthly', priority: '0.7',
    parts: { CSS: 'src/shared-ui/style.css', CHROME: 'src/shared-ui/chrome.js' } },
];

const seo = require('./tools/seo.js');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const fail = (msg, detail) => {
  console.error('\n  BUILD FAILED: ' + msg);
  if (detail) for (const d of detail) console.error('    - ' + d);
  console.error('');
  process.exit(1);
};

/* ---- 1. syntax ---------------------------------------------------------- */
const syntaxChecked = new Set();
function syntaxCheck(rel, source) {
  if (syntaxChecked.has(rel)) return;
  syntaxChecked.add(rel);
  const tmp = path.join(os.tmpdir(), `drawerforge-${process.pid}-${rel.replace(/[\\/]/g, '_')}`);
  fs.writeFileSync(tmp, source);
  try {
    execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
  } catch (e) {
    fail(`syntax error in ${rel}`, String(e.stderr || e.message).trim().split('\n'));
  } finally {
    fs.unlinkSync(tmp);
  }
}

const MARK = (name) => new RegExp(`[ \\t]*\\r?\\n?/\\*__${name}__\\*/[ \\t]*\\r?\\n?`);
let stale = 0;

for (const tool of TOOLS) {
  const template = read(tool.template);
  const sources = {};
  for (const [marker, rel] of Object.entries(tool.parts)) {
    sources[marker] = read(rel);
    if (rel.endsWith('.js')) syntaxCheck(rel, sources[marker]);
    if (!MARK(marker).test(template))
      fail(`${tool.template} is missing the /*__${marker}__*/ marker`);
  }

  /* ---- 2. id audit ------------------------------------------------------ */
  const ui = sources[tool.uiPart] || '';
  const templateIds = new Set();
  for (const m of template.matchAll(/\bid\s*=\s*["']([^"']+)["']/g)) templateIds.add(m[1]);
  const referenced = new Map();
  for (const m of ui.matchAll(/\$\(\s*['"]([^'"]+)['"]\s*\)/g))
    referenced.set(m[1], (referenced.get(m[1]) || 0) + 1);
  const missing = [...referenced.keys()].filter((id) => !templateIds.has(id));
  if (missing.length)
    fail(`[${tool.name}] ui references ${missing.length} id(s) absent from ${tool.template}`,
         missing.map((id) => `$('${id}')  — referenced ${referenced.get(id)}x`));

  /* ---- 3. display-reachability audit ------------------------------------ */
  const hidden = [];
  for (const m of template.matchAll(/<[^>]*\bid\s*=\s*["']([^"']+)["'][^>]*>/g))
    if (/style\s*=\s*["'][^"']*display\s*:\s*none/i.test(m[0])) hidden.push(m[1]);
  const unreachable = hidden.filter((id) => {
    const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return !new RegExp(`['"]${esc}['"][^\\n]*\\)\\s*\\.style\\.display`).test(ui);
  });
  if (unreachable.length)
    fail(`[${tool.name}] ${unreachable.length} element(s) are display:none and never un-hidden`,
         unreachable.map((id) => `#${id} — unreachable in the UI; un-hide it or remove it`));

  /* ---- splice ----------------------------------------------------------- */
  let out = template;
  for (const marker of Object.keys(tool.parts))
    out = out.replace(MARK(marker), () => sources[marker]);
  out = seo.inject(out);   // FAQ markup generated from the page's own questions

  const outPath = path.join(ROOT, tool.out);
  if (checkOnly) {
    const current = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : '';
    if (current !== out) {
      console.error(`  STALE: ${tool.out} does not match src/ — run \`node build.js\``);
      stale++;
    } else {
      console.log(`  ${tool.out} up to date (${out.length} bytes)`);
    }
    continue;
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, out);
  console.log(`  built ${tool.out.padEnd(16)} ${String(out.length).padStart(7)} bytes` +
              `   ids: ${referenced.size} referenced / ${templateIds.size} present`);
}

/* The sitemap is generated, not maintained. A page added and not listed may never be
   crawled, and a lastmod that lies teaches the crawler to stop trusting lastmod. Dates
   come from the commit that last touched each page; if git is unavailable the entry
   simply carries no date rather than a made-up one. */
{
  const lastmodFor = (t) => {
    try {
      const out = execFileSync('git', ['log', '-1', '--format=%cI', '--', t.out],
                               { cwd: ROOT, encoding: 'utf8' }).trim();
      return out ? out.slice(0, 10) : null;
    } catch (e) { return null; }
  };
  const xml = seo.sitemap(TOOLS, lastmodFor);
  const smPath = path.join(ROOT, 'sitemap.xml');
  const current = fs.existsSync(smPath) ? fs.readFileSync(smPath, 'utf8') : '';
  if (checkOnly) {
    if (current !== xml) {
      console.error('  STALE: sitemap.xml does not match the built pages — run `node build.js`');
      stale++;
    } else {
      console.log(`  sitemap.xml up to date (${TOOLS.length} urls)`);
    }
  } else if (current !== xml) {
    fs.writeFileSync(smPath, xml);
    console.log(`  wrote sitemap.xml    ${TOOLS.length} urls`);
  }
}

if (checkOnly && stale) {
  fail(`${stale} output(s) out of date with src/ — run \`node build.js\` and commit the result`);
}
