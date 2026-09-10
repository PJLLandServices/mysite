// The SEO agent's data layer (scripts/seo-lib.mjs + the JWT builder in
// scripts/seo-gsc-pull.mjs).
//
// Worth pinning because every bug here is an invisible wrong recommendation:
// a query bucketed into the gap zone by an unweighted position, a "climbed"
// that was really a drop, or a page reported as having zero inbound links
// because the nav was stripped wrong (or reported as well-linked because it
// was not stripped at all). None of that throws — it just produces a
// confident, wrong report on Monday morning.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {
  parseDotEnv, flattenGscRow, aggregateByQuery, gapZone, movement, topicKey, clusters,
  stripPartials, inventoryFromHtml, withInboundLinks, findPage, slugify, mdTable, titleCore,
} = await import(`file://${path.join(ROOT, 'scripts/seo-lib.mjs')}`);
const { buildJwt } = await import(`file://${path.join(ROOT, 'scripts/seo-gsc-pull.mjs')}`);
const { buildInventory } = await import(`file://${path.join(ROOT, 'scripts/seo-site-inventory.mjs')}`);

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); pass++; }
  catch (err) { fail++; console.log(`  FAIL: ${name}\n    ${err.message.split('\n')[0]}`); }
};

// ------------------------------------------------------------------- dotenv
check('parseDotEnv matches the server loader: comments, quotes, = in values', () => {
  const env = parseDotEnv('# c\nA=1\nB="two words"\nC=\'x\'\nD=a=b\n\nnoeq\n');
  assert.deepEqual(env, { A: '1', B: 'two words', C: 'x', D: 'a=b' });
});

// ------------------------------------------------------------- aggregation
const rows = [
  { keys: ['sprinkler repair newmarket', 'https://www.pjllandservices.com/sprinkler-repair.html'], clicks: 10, impressions: 100, ctr: 0.1, position: 3 },
  { keys: ['sprinkler repair newmarket', 'https://www.pjllandservices.com/'], clicks: 0, impressions: 900, ctr: 0, position: 15 },
  { keys: ['fall sprinkler closing aurora', 'https://www.pjllandservices.com/sprinkler-fall-winterization.html'], clicks: 2, impressions: 50, ctr: 0.04, position: 8 },
].map(flattenGscRow);

check('aggregateByQuery weights position by impressions, not by row count', () => {
  const q = aggregateByQuery(rows).find((r) => r.query === 'sprinkler repair newmarket');
  // (3*100 + 15*900) / 1000 = 13.8 — the unweighted mean (9) would put this
  // query in a different bucket and point at the wrong landing page.
  assert.equal(q.position, 13.8);
  assert.equal(q.impressions, 1000);
  assert.equal(q.clicks, 10);
  assert.equal(q.page, 'https://www.pjllandservices.com/', 'landing page is the one with the most impressions');
  assert.equal(q.pageCount, 2);
});

// ---------------------------------------------------------------- gap zone
check('gapZone keeps 5–20 inclusive, sorted by impressions', () => {
  const qs = [
    { query: 'a', position: 4.9, impressions: 999 },
    { query: 'b', position: 5, impressions: 10 },
    { query: 'c', position: 20, impressions: 40 },
    { query: 'd', position: 20.1, impressions: 999 },
    { query: 'e', position: 12, impressions: 40 },
  ];
  // Ties on impressions break toward the lower position (closer to page 1).
  assert.deepEqual(gapZone(qs).map((q) => q.query), ['e', 'c', 'b']);
  assert.deepEqual(gapZone(qs, { limit: 1 }).map((q) => q.query), ['e']);
});

// ---------------------------------------------------------------- movement
check('movement: positive delta means climbed toward #1, threshold is inclusive', () => {
  const cur = [
    { query: 'climbed', position: 6, impressions: 10, page: 'p' },
    { query: 'dropped', position: 14, impressions: 10, page: 'p' },
    { query: 'flat', position: 9.5, impressions: 10, page: 'p' },
    { query: 'new', position: 3, impressions: 10, page: 'p' },
  ];
  const prev = [
    { query: 'climbed', position: 9, impressions: 10 },
    { query: 'dropped', position: 10, impressions: 10 },
    { query: 'flat', position: 10, impressions: 10 },
  ];
  const m = movement(cur, prev);
  assert.deepEqual(m.map((x) => [x.query, x.delta]), [['dropped', -4], ['climbed', 3]]);
});

// ---------------------------------------------------------------- clusters
check('topicKey strips town names so town variants cluster together', () => {
  assert.equal(topicKey('sprinkler winterization aurora'), topicKey('sprinkler winterization in Vaughan'));
  assert.equal(topicKey('sprinkler winterization aurora'), topicKey('winterizing sprinklers Richmond Hill'));
  assert.notEqual(topicKey('sprinkler winterization aurora'), topicKey('sprinkler installation aurora'));
});

check('clusters reports families of 3+ and how many landing pages they spread over', () => {
  const qs = [
    { query: 'sprinkler winterization aurora', impressions: 10, page: 'A' },
    { query: 'sprinkler winterization vaughan', impressions: 10, page: 'B' },
    { query: 'sprinkler winterization markham', impressions: 10, page: '' },
    { query: 'drip irrigation', impressions: 99, page: 'C' },
  ];
  const c = clusters(qs);
  assert.equal(c.length, 1);
  assert.equal(c[0].queries.length, 3);
  assert.equal(c[0].landingPageSpread, 2);
});

// -------------------------------------------------------------- inventory
const page = (file, body, head = '') => `<!doctype html><html><head><meta charset="UTF-8"><title>T ${file}</title>
<meta name="description" content="Desc for ${file}">${head}</head><body>
<!-- @@PJL:nav-START {"loc":"x"} --><nav><a href="sprinkler-repair.html">Repair</a><a href="about.html">About</a></nav><!-- @@PJL:nav-END -->
<h1>Heading &amp; more</h1>${body}
<!-- @@PJL:footer-START --><footer><a href="privacy-policy.html">P</a></footer><!-- @@PJL:footer-END -->
</body></html>`;

check('stripPartials removes nav/footer/analytics blocks and nothing else', () => {
  const html = page('x.html', '<p>keep <a href="faq.html">faq</a></p>');
  const out = stripPartials(html);
  assert.ok(!out.includes('sprinkler-repair.html'), 'nav link gone');
  assert.ok(!out.includes('privacy-policy.html'), 'footer link gone');
  assert.ok(out.includes('faq.html'), 'body link kept');
});

check('inventoryFromHtml: title/description/h1 unescaped, body links only, self + external dropped', () => {
  const html = page('blog-a.html',
    '<p><a href="faq.html">faq</a> <a href="./sprinkler-repair.html#top">r</a> <a href="https://www.pjllandservices.com/about.html?x=1">a</a> ' +
    '<a href="https://example.com/x.html">ext</a> <a href="blog-a.html">self</a> <a href="tel:1">t</a> <a href="/">home</a></p>',
    '<script type="application/ld+json">{"@type":"BlogPosting","datePublished":"2026-09-09"}</script>');
  const p = inventoryFromHtml('blog-a.html', html);
  assert.equal(p.title, 'T blog-a.html');
  assert.equal(p.description, 'Desc for blog-a.html');
  assert.equal(p.h1, 'Heading & more');
  assert.equal(p.h1Count, 1);
  assert.equal(p.type, 'blog');
  assert.equal(p.datePublished, '2026-09-09');
  assert.deepEqual(p.links, ['about.html', 'faq.html', 'index.html', 'sprinkler-repair.html']);
  assert.equal(p.url, 'https://www.pjllandservices.com/blog-a.html');
  assert.equal(inventoryFromHtml('index.html', html).url, 'https://www.pjllandservices.com/');
});

check('commented-out markup is not on the page: a retired hero in a comment is not a second h1', () => {
  // The bug this pins: reviews.html keeps its original hero inside an HTML
  // comment and was reported as having two <h1>s.
  const html = page('reviews.html', '<!-- old hero\n<h1>Old</h1> <a href="faq.html">x</a> -->\n<p>live</p>');
  const p = inventoryFromHtml('reviews.html', html);
  assert.equal(p.h1Count, 1);
  assert.equal(p.h1, 'Heading & more');
  assert.deepEqual(p.links, [], 'a link inside a comment is not an internal link');
});

check('titleCore measures the title the way sync-seasonal-meta does: before the brand affix', () => {
  assert.equal(titleCore('Sprinkler Service Acton — Fall Closing from $90 | PJL Land Services'), 'Sprinkler Service Acton — Fall Closing from $90');
  assert.equal(titleCore('Hydrawise Controller Offline? How to Fix It | PJL Land'), 'Hydrawise Controller Offline? How to Fix It');
  assert.equal(titleCore('Blog | Tips — PJL Land Services'), 'Blog | Tips');
  assert.equal(titleCore('PJL Land Services | Sprinklers & Lighting, Newmarket & GTA'), 'Sprinklers & Lighting, Newmarket & GTA');
  assert.equal(titleCore('No brand here'), 'No brand here');
});

check('withInboundLinks counts body links from other pages, never nav links', () => {
  const pages = [
    inventoryFromHtml('a.html', page('a.html', '<a href="b.html">b</a>')),
    inventoryFromHtml('b.html', page('b.html', '<a href="a.html">a</a> <a href="c.html">c</a>')),
    inventoryFromHtml('c.html', page('c.html', '<a href="b.html">b</a>')),
    inventoryFromHtml('sprinkler-repair.html', page('sprinkler-repair.html', '')),
  ];
  const inb = Object.fromEntries(withInboundLinks(pages).map((p) => [p.file, p.inboundBodyLinks]));
  assert.deepEqual(inb, { 'a.html': 1, 'b.html': 2, 'c.html': 1, 'sprinkler-repair.html': 0 });
});

check('findPage maps GSC URLs back to files, homepage included', () => {
  const pages = [{ file: 'index.html' }, { file: 'faq.html' }];
  assert.equal(findPage(pages, 'https://www.pjllandservices.com/'), pages[0]);
  assert.equal(findPage(pages, 'https://www.pjllandservices.com/faq.html?utm=1'), pages[1]);
  assert.equal(findPage(pages, 'https://www.pjllandservices.com/nope.html'), null);
  assert.equal(findPage(pages, ''), null);
});

check('the live repo inventory is sane: >50 indexable pages, every one has a title, noindex pages flagged', () => {
  const pages = buildInventory();
  const indexable = pages.filter((p) => !p.noindex);
  assert.ok(indexable.length > 50, `got ${indexable.length}`);
  for (const p of indexable) assert.ok(p.title, `${p.file} has no <title>`);
  assert.ok(pages.some((p) => p.noindex), 'noindex pages are detected, not silently listed as targets');
  assert.ok(!pages.some((p) => p.file === 'quote-legacy.html' || p.file === '404.html'));
  // The nav links to every service page; with partials stripped, a real
  // count must still be able to reach zero for a genuinely unlinked page.
  assert.ok(pages.some((p) => p.inboundBodyLinks === 0), 'body-only inbound counts can reach zero');
});

// ------------------------------------------------------------------- misc
check('slugify + mdTable', () => {
  assert.equal(slugify('Fall Sprinkler Closing: Aurora & Newmarket!'), 'fall-sprinkler-closing-aurora-and-newmarket');
  assert.equal(mdTable(['a', 'b'], [['x|y', 'z']]), '| a | b |\n| --- | --- |\n| x\\|y | z |');
});

// --------------------------------------------------------------------- JWT
check('buildJwt signs an RS256 assertion Google will accept the shape of', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const jwt = buildJwt({ client_email: 'seo@proj.iam.gserviceaccount.com', private_key: pem },
    { scope: 'https://www.googleapis.com/auth/webmasters.readonly', now: 1_700_000_000 });
  const [h, c, s] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'RS256', typ: 'JWT' });
  const claims = JSON.parse(Buffer.from(c, 'base64url'));
  assert.equal(claims.iss, 'seo@proj.iam.gserviceaccount.com');
  assert.equal(claims.aud, 'https://oauth2.googleapis.com/token');
  assert.equal(claims.exp - claims.iat, 3600);
  assert.ok(crypto.verify('RSA-SHA256', Buffer.from(`${h}.${c}`), publicKey, Buffer.from(s, 'base64url')));
});

console.log(`\nseo-tools: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
