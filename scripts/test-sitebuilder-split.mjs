// Sprinkler System Builder — "split zone" walk (one station, two valves).
//
// Loads server/sitebuilder.html in headless Chromium with every /api call
// mocked, opens the master plan on a calibrated sheet holding one traced
// rotor lawn and two valve boxes, then drives the split the way Patrick
// would: pick the zone, pick Split zone, click two points across the
// "driveway", and check what falls out —
//
//   - LAST_ZONES carries two entries (A and B) sharing one station
//   - the halves anchor on their own heads, so each lands in its own box
//   - the quote wants ONE zone line; the BOM wants one MORE valve
//   - the split survives save → reload byte-for-byte
//   - removing the split puts everything back exactly as it was
//
// Run:  npm run test:sitebuilder   (needs `npx playwright install chromium` once)
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, '..', 'server', 'sitebuilder.html'), 'utf8');

const PAGE = 'spp_testpage';
const project = () => ({
  id: 'PROJ-TEST-0001', name: 'Split walk', customerName: 'Test',
  sitePlan: { pages: [{ id: PAGE, label: 'Sheet 1', rasterWidthPx: 3000, rasterHeightPx: 2000,
    calibration: { state: 'calibrated', ftPerPx: 0.1, verify: { state: 'passed', residualPct: 0.1 } } }] },
  systemDesign: {
    version: 7, inputs: { availGPM: '18', psi: '60', ceiling: '17.5' }, waterSupply: {}, bomOverrides: { edits: {}, removed: {}, custom: [] },
    linkedQuoteId: null, wcRunOverrides: {},
    // A 120 × 40 ft rotor lawn traced on the sheet at (20,20).
    areas: [{ aid: 'a_lawn', name: 'Front lawn', family: 'rotor', mode: 'custom', planRef: { pageId: PAGE },
              poly: [{ x: 20, y: 20 }, { x: 140, y: 20 }, { x: 140, y: 60 }, { x: 20, y: 60 }] }],
    // Two boxes: one west of the lawn, one east — the "driveway" runs down
    // the middle at x = 80.
    routing: { [PAGE]: { poc: { x: 80, y: 90 }, main: [], manifolds: [{ x: 10, y: 70, id: 'm_west' }, { x: 150, y: 70, id: 'm_east' }], pins: {} } }
  }
});

let saved = null;               // what the builder PATCHes back
// PW_CHROMIUM points at a system Chromium when Playwright's own download is
// not available (the cloud sandbox); on a normal machine `npx playwright
// install chromium` once is enough.
const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
await page.route('**/*', route => {
  const url = new URL(route.request().url());
  const m = route.request().method();
  if (url.pathname === '/admin/sitebuilder') return route.fulfill({ contentType: 'text/html', body: html });
  if (url.pathname === '/api/projects/PROJ-TEST-0001' && m === 'GET') {
    const p = project(); if (saved) p.systemDesign = saved;
    return route.fulfill({ json: { ok: true, project: p } });
  }
  if (url.pathname === '/api/projects/PROJ-TEST-0001' && m === 'PATCH') {
    saved = route.request().postDataJSON().systemDesign;
    return route.fulfill({ json: { ok: true, project: { id: 'PROJ-TEST-0001', systemDesign: saved } } });
  }
  if (url.pathname === '/api/parts') return route.fulfill({ json: { ok: true, parts: [] } });
  if (url.pathname === '/api/projects') return route.fulfill({ json: { ok: true, projects: [] } });
  if (url.pathname.endsWith('/raster')) return route.fulfill({ status: 404, body: '' });
  if (url.pathname.endsWith('town-water-rates.json')) return route.fulfill({ json: { towns: [] } });
  return route.fulfill({ status: 404, body: '' });
});

let fails = 0;
const check = (ok, msg) => { console.log((ok ? '  ok   ' : '  FAIL ') + msg); if (!ok) fails++; };

await page.goto('http://pjl.test/admin/sitebuilder?project=PROJ-TEST-0001');
await page.waitForFunction(() => appReady === true);

// --- baseline ---------------------------------------------------------
const base = await page.evaluate(() => ({
  zones: LAST_ZONES.map(z => ({ key: z.key, name: z.name, station: z.station, heads: z.headCount, gpm: +z.gpm.toFixed(2) })),
  stations: stationCount(), quoteLines: desiredQuoteLines().N
}));
console.log('baseline zones:', JSON.stringify(base.zones));
check(base.zones.length >= 1, 'lawn computed at least one zone');
check(base.stations === base.zones.length, 'no split: stations == valves');

// --- open the master plan, select the first zone, split it -----------
await page.evaluate(id => openMasterPlan(id), PAGE);
await page.waitForSelector('#mpOverlay:not([hidden])');
const pick = await page.evaluate(() => {
  // pick the zone with the most heads, and find where its heads span
  let best = 0; LAST_ZONES.forEach((z, i) => { if (z.headCount > LAST_ZONES[best].headCount) best = i; });
  const z = LAST_ZONES[best], pt = z.parts[0], a = areas[pt.areaIdx];
  const hs = mpZoneHeads(z, pt, a, mpPlanFor(a));
  const xs = hs.map(h => h.x).sort((p, q) => p - q);
  return { zi: best, key: z.key, n: hs.length, minX: xs[0], maxX: xs[xs.length - 1], midX: xs[Math.floor(xs.length / 2)] };
});
console.log('splitting', JSON.stringify(pick));
check(pick.n >= 2, 'chosen zone has at least two heads to split');
const splitX = (pick.minX + pick.maxX) / 2;
// Park the two boxes just past each end of THIS zone's heads, so "nearest
// box" has an unambiguous answer for each half.
await page.evaluate(({ w, e }) => { const r = routing[mp.pageId]; r.manifolds[0].x = w; r.manifolds[1].x = e; mpDraw(); },
                    { w: pick.minX - 5, e: pick.maxX + 5 });

// Simulate the two clicks the way mpTap receives them (sheet feet).
const after = await page.evaluate(({ zi, x }) => {
  mpSelectZone(zi);
  mpSetTool('split');
  const t0 = mp.tool;
  mpTap(x, 0);   mpDraw();        // first end
  mpTap(x, 100); mpDraw();        // second end
  const r = routing[mp.pageId];
  const asg = mpManifoldAssign();
  const lat = mpLateralPlan();
  return {
    toolAfterSelect: t0, toolNow: mp.tool,
    splits: JSON.parse(JSON.stringify(r.splits)),
    zones: LAST_ZONES.map(z => ({ key: z.key, name: z.name, half: z.half || null, station: z.station, heads: z.headCount, gpm: +z.gpm.toFixed(2) })),
    stations: stationCount(), valves: LAST_ZONES.length,
    quote: desiredQuoteLines().desired.filter(l => l.kind === 'zone').map(l => l.label + ' — ' + l.description),
    byBox: asg.byManifold.map(l => l.map(zi => LAST_ZONES[zi].key)),
    runs: lat.runs.map(run => ({ key: LAST_ZONES[run.zi].key, root: run.rootKey, ft: Math.round(run.ft) })),
    peak: +peakStationGPM().toFixed(2),
    zoneSelKey: mp.zoneSel != null ? LAST_ZONES[mp.zoneSel].key : null,
    svgHasSplit: /data-mph="sa\d+"/.test(el('mpBody').innerHTML) && /data-mph="sb\d+"/.test(el('mpBody').innerHTML)
  };
}, { zi: pick.zi, x: splitX });
console.log('after split:', JSON.stringify(after, null, 1));
if (process.env.SHOT) { await page.evaluate(() => mpFit()); await page.screenshot({ path: process.env.SHOT }); }
check(after.toolAfterSelect === 'split', 'Split zone tool armed once a zone is selected');
check(after.toolNow === 'pan', 'tool drops back to Move after the second click');
check(Object.keys(after.splits).length === 1 && after.splits[pick.key], 'one split line stored under the zone key');
const halves = after.zones.filter(z => z.key === pick.key || z.key === pick.key + '#B');
check(halves.length === 2 && halves[0].half === 'A' && halves[1].half === 'B', 'zone became an A half and a B half');
check(halves[0].station === halves[1].station, 'both halves share one station');
check(halves[0].heads + halves[1].heads === pick.n, 'every head landed on exactly one half (' + halves[0].heads + ' + ' + halves[1].heads + ')');
check(after.valves === base.zones.length + 1, 'one more valve than before');
check(after.stations === base.stations, 'same number of stations as before');
check(after.quote.length === base.quoteLines && after.quote.some(l => /2 valves wired as one zone/.test(l)), 'quote still has one line per station, noting the two valves');
const boxOfA = after.byBox.findIndex(l => l.includes(pick.key)), boxOfB = after.byBox.findIndex(l => l.includes(pick.key + '#B'));
check(boxOfA === 0 && boxOfB === 1, 'A half fell to the west box, B half to the east box (' + boxOfA + ',' + boxOfB + ')');
check(after.runs.some(r => r.key === pick.key && r.root === 'm0') && after.runs.some(r => r.key === pick.key + '#B' && r.root === 'm1'), 'each half gets its own lateral run from its own box');
check(after.zoneSelKey === pick.key, 'selection stays on the split zone (A half)');
check(after.svgHasSplit, 'split line drawn with two draggable ends');
check(after.peak >= Math.max(...halves.map(h => h.gpm)) - 1e-6, 'peak station flow counts both halves opening together');

// --- pin B by hand, then save → reload ----------------------------------
await page.evaluate(k => { const zi = LAST_ZONES.findIndex(z => z.key === k + '#B'); mpPinZone(zi, 1); }, pick.key);
const blob = await page.evaluate(() => serializeState());
check(blob.version === 8, 'design saves as version 8');
check(blob.routing[PAGE] && blob.routing[PAGE].splits && blob.routing[PAGE].splits[pick.key], 'split line is in the saved blob');
check(blob.routing[PAGE].pins[pick.key + '#B'] === 'm_east', 'pin on the B half is saved under its own key');
saved = blob;
await page.reload();
await page.waitForFunction(() => appReady === true);
const reloaded = await page.evaluate(() => ({
  zones: LAST_ZONES.map(z => ({ key: z.key, half: z.half || null, station: z.station, heads: z.headCount })),
  blob: serializeState()
}));
check(JSON.stringify(reloaded.zones.filter(z => z.key.startsWith(pick.key))) ===
      JSON.stringify(halves.map(h => ({ key: h.key, half: h.half, station: h.station, heads: h.heads }))), 'halves come back identical after reload');
const strip = b => { const c = JSON.parse(JSON.stringify(b)); delete c.savedAt; return JSON.stringify(c); };
check(strip(reloaded.blob) === strip(blob), 'save → reload → save round-trips byte-for-byte');

// --- an old (version 7) blob with no splits is untouched ----------------
saved = null; await page.reload(); await page.waitForFunction(() => appReady === true);
const v7 = await page.evaluate(() => ({ n: LAST_ZONES.length, st: stationCount(), v: serializeState().version, hasSplits: !!(serializeState().routing.spp_testpage || {}).splits }));
check(v7.n === base.zones.length && v7.st === base.stations, 'version-7 blob: every zone is still one valve');

// --- remove the split ------------------------------------------------------
saved = blob; await page.reload(); await page.waitForFunction(() => appReady === true);
const removed = await page.evaluate((k) => {
  openMasterPlan(mp.pageId || Object.keys(routing)[0]);
  window.confirm = () => true;
  const zi = LAST_ZONES.findIndex(z => z.key === k);
  mpRemoveSplit(zi);
  const r = routing[mp.pageId];
  return { zones: LAST_ZONES.map(z => ({ key: z.key, station: z.station, heads: z.headCount })), splits: Object.keys(r.splits), pinsB: r.pins[k + '#B'] || null, st: stationCount() };
}, pick.key);
check(removed.splits.length === 0 && removed.pinsB === null, 'remove split drops the line and the B pin');
check(removed.zones.length === base.zones.length && removed.st === base.stations, 'zone is back to one valve');

// --- a line that misses every head is refused -----------------------------
const refused = await page.evaluate(({ zi, x }) => {
  window.alert = () => {};
  mpSelectZone(zi); mpSetTool('split');
  mpTap(x, 0); mpTap(x, 100);
  return { splits: Object.keys(routing[mp.pageId].splits).length, zones: LAST_ZONES.length };
}, { zi: pick.zi, x: pick.maxX + 500 });
check(refused.splits === 0 && refused.zones === base.zones.length, 'a line with every head on one side is refused');

check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close();
if (fails) { console.log(`\n${fails} check(s) failed`); process.exit(1); }
console.log('\nsplit walk: all checks passed');
