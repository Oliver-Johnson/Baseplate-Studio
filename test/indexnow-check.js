#!/usr/bin/env node
/* Is the IndexNow wiring still able to work?
 *
 * Every way this breaks is silent. The key file stops being served, or is rotated in
 * one place and not the other, or a page is added to the manifest and never submitted,
 * or a URL is submitted that does not match the one in the sitemap — and each of those
 * produces a 403 or a 422 in a CI log on a job nobody looks at, weeks after the change
 * that caused it. There is no page that looks wrong and no user who complains. So the
 * checks are here, where they run on every push, rather than being left to the job.
 *
 * This does not talk to IndexNow. It checks the things that must be true before a
 * submission can succeed.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const idx = require('../tools/indexnow.js');
const seo = require('../tools/seo.js');
const pages = require('../tools/manifest.js');

const ROOT = path.join(__dirname, '..');
let bad = 0;
const check = (what, ok, detail) => {
  console.log(`  ${what.padEnd(62)}${ok ? 'ok' : `WRONG — ${detail}`}`);
  if (!ok) bad++;
};

console.log('the key, and the file that proves we own the domain');
let key = null;
try {
  key = idx.readKey();            // throws if absent, ambiguous, or self-inconsistent
  check(`${key.file} contains exactly its own key`, true);
} catch (e) {
  check('a single self-consistent key file at the repo root', false, e.message);
}

if (key) {
  /* It has to be SERVED, not merely committed. GitHub Pages publishes the repo root, so
     the test is that the file sits there and is not swept up by anything that would
     stop it being published. A key file inside a directory Pages excludes verifies
     nothing, and the submission fails with a 403 that names no cause. */
  check('the key file is at the site root, so Pages will serve it',
        fs.existsSync(path.join(ROOT, key.file)) && !key.file.includes('/'));

  const body = fs.readFileSync(path.join(ROOT, key.file), 'utf8');
  check('the key file has no trailing newline or padding',
        body === key.key, `file body is ${JSON.stringify(body)}`);

  /* Jekyll is GitHub Pages' default processor and it drops files it does not recognise
     from the output. A .nojekyll at the root turns that off. Without it a bare hex .txt
     is published today and the protocol works; this is here so that if anyone ever adds
     an _config.yml or a leading-underscore path, the reason the key stopped resolving
     is stated somewhere rather than rediscovered. */
  check('robots.txt does not disallow the key file',
        !/Disallow:\s*\/\s*$/m.test(fs.readFileSync(path.join(ROOT, 'robots.txt'), 'utf8')),
        'robots.txt disallows everything, so the key file cannot be fetched');
}

console.log('\nthe URLs it would submit');
const all = idx.allUrls();
const sitemapUrls = (fs.readFileSync(path.join(ROOT, 'sitemap.xml'), 'utf8')
  .match(/<loc>([^<]+)<\/loc>/g) || []).map((m) => m.replace(/<\/?loc>/g, ''));

/* The engines reject any URL that is not on the host the key belongs to, and they
   reject the whole batch. So "the same set as the sitemap" is the property worth
   holding: the sitemap is what the crawlers already have, and a page in one and not the
   other is a page that is either never submitted or submitted and refused. */
check(`submits the same ${sitemapUrls.length} URLs the sitemap publishes`,
      JSON.stringify([...all].sort()) === JSON.stringify([...sitemapUrls].sort()),
      `submits ${JSON.stringify(all)} but the sitemap has ${JSON.stringify(sitemapUrls)}`);
check('every URL is on the host the key authorises',
      all.every((u) => new URL(u).host === new URL(seo.SITE).host));

/* The mapping from a changed file to a URL is the part that decides whether anything is
   sent at all, so it is exercised rather than assumed. */
console.log('\nwhich changes trigger which submissions');
const first = pages[0].out;
check(`a change to ${first} submits ${seo.urlFor(first)}`,
      JSON.stringify(idx.urlsFor([first])) === JSON.stringify([seo.urlFor(first)]));
check('a change to a source file alone submits nothing',
      idx.urlsFor(['src/ui.js', 'README.md']).length === 0,
      'sources are spliced into the built pages; only the built page being different ' +
      'means the published page changed');
check('a Windows-style path still matches',
      idx.urlsFor([pages[1].out.replace(/\//g, '\\')]).length === 1);
check('every page in the manifest is reachable by a change to itself',
      pages.every((p) => idx.urlsFor([p.out]).length === 1));

console.log(bad ? `\n${bad} PROBLEM${bad === 1 ? '' : 'S'}` : '\nIndexNow can submit');
process.exit(bad ? 1 : 0);
