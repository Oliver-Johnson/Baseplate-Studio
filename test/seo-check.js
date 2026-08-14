#!/usr/bin/env node
/* Structured data has to be valid JSON, has to describe the page it sits on, and
 * FAQ answers have to match the visible prose — search engines drop markup that
 * does not, and a page can look perfectly fine while shipping broken JSON-LD.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const seo = require('../tools/seo.js');

const ROOT = path.join(__dirname, '..');
const PAGES = ['index.html', 'bins/index.html', 'guide/index.html',
               'guide/split/index.html', 'guide/drawer-sizes/index.html'];
const SITE = 'https://drawerforge.co.uk';

let bad = 0;
const say = (name, ok, detail) => {
  console.log(`  ${name.padEnd(42)}${ok ? 'ok' : 'FAILED — ' + detail}`);
  if (!ok) bad++;
};

console.log('structured data');
const seen = new Map();
for (const rel of PAGES) {
  const html = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .map((m) => m[1]);
  if (!blocks.length) { say(rel, false, 'no structured data at all'); continue; }

  const types = [];
  for (const b of blocks) {
    let obj;
    try { obj = JSON.parse(b); } catch (e) { say(rel, false, 'invalid JSON: ' + e.message); obj = null; }
    if (!obj) continue;
    if (obj['@context'] !== 'https://schema.org') { say(rel, false, 'wrong @context'); continue; }
    types.push(obj['@type']);
    seen.set(rel, (seen.get(rel) || []).concat([obj]));
  }
  say(`${rel}  [${types.join(', ')}]`, types.length > 0, 'nothing parsed');
}

/* Every FAQ answer must be the answer the reader sees. Regenerating from the page
   and comparing catches a hand-edit to one and not the other. */
console.log('\nFAQ markup matches the visible questions');
for (const rel of ['guide/index.html', 'guide/split/index.html', 'guide/drawer-sizes/index.html']) {
  const html = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const visible = seo.questions(html);
  const block = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .map((m) => { try { return JSON.parse(m[1]); } catch (e) { return null; } })
    .find((o) => o && o['@type'] === 'FAQPage');
  if (!block) { say(rel, false, 'page has questions but no FAQPage'); continue; }
  const marked = block.mainEntity.map((q) => ({ q: q.name, a: q.acceptedAnswer.text }));
  const same = visible.length === marked.length &&
    visible.every((v, i) => v.q === marked[i].q && v.a === marked[i].a);
  say(`${rel}  ${marked.length} question(s)`, same && visible.length > 0,
      `visible ${visible.length} vs marked ${marked.length}`);
}

/* A URL in the markup that 404s is worse than no markup. */
console.log('\nevery url in the markup points at a page that exists');
const urls = new Set();
for (const objs of seen.values())
  JSON.stringify(objs).replace(/"(https:\/\/drawerforge\.co\.uk[^"]*)"/g,
    (m, u) => { urls.add(u.split('#')[0]); return m; });
for (const u of [...urls].sort()) {
  const rel = u.slice(SITE.length).replace(/^\//, '');
  const file = rel === '' ? 'index.html' : path.join(rel, 'index.html');
  say(u, fs.existsSync(path.join(ROOT, file)), 'no such page: ' + file);
}

/* llms.txt is only useful if what it points at is real. */
console.log('\nllms.txt');
{
  const p = path.join(ROOT, 'llms.txt');
  if (!fs.existsSync(p)) { say('llms.txt exists', false, 'missing'); }
  else {
    const txt = fs.readFileSync(p, 'utf8');
    say('llms.txt exists', true);
    const links = [...txt.matchAll(/\((https:\/\/drawerforge\.co\.uk[^)]*)\)/g)].map((m) => m[1]);
    say('has links', links.length > 0, 'no links at all');
    for (const u of links) {
      const rel = u.slice(SITE.length).replace(/^\//, '');
      const file = rel === '' ? 'index.html'
        : (/\.(txt|xml|md)$/.test(rel) ? rel : path.join(rel, 'index.html'));
      say('  ' + u, fs.existsSync(path.join(ROOT, file)), 'no such page: ' + file);
    }
  }
}

/* The sitemap is what a crawler follows; a page missing from it may never be found. */
console.log('\nsitemap covers every page');
{
  const sm = fs.readFileSync(path.join(ROOT, 'sitemap.xml'), 'utf8');
  for (const rel of PAGES) {
    const u = SITE + '/' + rel.replace(/index\.html$/, '');
    say(u, sm.includes('<loc>' + u + '</loc>'), 'not in sitemap.xml');
  }
}

console.log(bad ? `\n${bad} check(s) FAILED` : '\nstructured data is sound');
process.exit(bad ? 1 : 0);
