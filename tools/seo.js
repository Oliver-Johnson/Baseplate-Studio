/* Structured data, generated from the page rather than written alongside it.
 *
 * Search engines require FAQ markup to match the answers a visitor actually sees,
 * and hand-maintained JSON-LD drifts from the prose the first time someone edits a
 * sentence. So the markup is derived from the page's own "Common questions" section
 * at build time: edit the wording and the markup follows, or it does not exist.
 *
 * build.js and test/ci-sim.js both call inject(), so the committed pages and the
 * CI reconstruction cannot disagree — which is the failure ci-sim already had once
 * when it was left behind by a change to the build.
 */
'use strict';

const ENTITIES = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  mdash: '—', ndash: '–', times: '×', deg: '°',
  hellip: '…', rarr: '→', frac12: '½',
};

/* Prose to plain text: markup out, entities decoded, whitespace collapsed. The
   answers carry links and emphasis that must not reach the JSON. */
function plain(html) {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (m, name) =>
      Object.prototype.hasOwnProperty.call(ENTITIES, name) ? ENTITIES[name] : m)
    .replace(/\s+/g, ' ')
    .trim();
}

/* Every <h3> question in the FAQ section, with the prose that follows it up to the
   next heading. Returns [] when the page has no such section. */
function questions(html) {
  const start = html.search(/<h2[^>]*\bid\s*=\s*["']faq["'][^>]*>/i);
  if (start < 0) return [];
  const rest = html.slice(start);
  // take to the next h2 after the FAQ heading, or the end of the article
  const body = (() => {
    const afterHeading = rest.slice(rest.indexOf('>') + 1);
    const nextH2 = afterHeading.search(/<h2[\s>]/i);
    const closeArt = afterHeading.search(/<\/article>/i);
    const cuts = [nextH2, closeArt].filter((i) => i >= 0);
    return cuts.length ? afterHeading.slice(0, Math.min(...cuts)) : afterHeading;
  })();

  const out = [];
  const re = /<h3[^>]*>([\s\S]*?)<\/h3>([\s\S]*?)(?=<h3[\s>]|$)/gi;
  let m;
  while ((m = re.exec(body))) {
    const q = plain(m[1]);
    const a = plain(m[2].replace(/<p class="cta"[\s\S]*$/i, ''));
    if (q && a) out.push({ q, a });
  }
  return out;
}

function faqJsonLd(html) {
  const qs = questions(html);
  if (!qs.length) return null;
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: qs.map((x) => ({
      '@type': 'Question',
      name: x.q,
      acceptedAnswer: { '@type': 'Answer', text: x.a },
    })),
  });
}

/* Insert generated blocks just before </head>. A page that already carries its own
   FAQPage is left alone, so a hand-written one always wins. */
function inject(html) {
  if (/"@type"\s*:\s*"FAQPage"/.test(html)) return html;
  const ld = faqJsonLd(html);
  if (!ld) return html;
  const tag = `<script type="application/ld+json">\n${ld}\n</script>\n`;
  return html.replace(/<\/head>/i, tag + '</head>');
}

module.exports = { inject, faqJsonLd, questions, plain };
