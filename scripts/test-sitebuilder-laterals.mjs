// Sprinkler System Builder — lateral layout walk.
//
// Headless Chromium, every /api call mocked. One traced rotor lawn and two
// traced drip beds (with pavement between them, so they are put on ONE
// station but a valve each), two valve boxes. Walks:
//
//   - shared drip group in 'station' mode → one valve per bed, one station
//   - picking a valve from the legend zooms to it and hides the others' pipe
//   - "draw laterals by hand" adopts the auto route as bends, a bend can be
//     added / moved / deleted, heads re-attach to the nearest pipe, every
//     trunk piece is sized on what flows past it
//   - hand-drawn laterals survive save → reload; reset restores the auto route
//   - the per-zone print sheet renders with sizes, lengths and head captions
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
  id: 'PROJ-TEST-0002', name: 'Lateral walk', customerName: 'Test', address: '1 Test Rd',
  sitePlan: { pages: [{ id: PAGE, label: 'Sheet 1', rasterWidthPx: 3000, rasterHeightPx: 2000,
    calibration: { state: 'calibrated', ftPerPx: 0.1, verify: { state: 'passed', residualPct: 0.1 } } }] },
  systemDesign: {
    version: 7, inputs: { availGPM: '18', psi: '60', ceiling: '17.5' }, waterSupply: {}, bomOverrides: { edits: {}, removed: {}, custom: [] },
    linkedQuoteId: null, wcRunOverrides: {},
    areas: [
      { aid: 'a_lawn', name: 'Front lawn', family: 'rotor', mode: 'custom', planRef: { pageId: PAGE },
        poly: [{ x: 20, y: 20 }, { x: 100, y: 20 }, { x: 100, y: 60 }, { x: 20, y: 60 }] },
      // two small beds either side of a 20 ft walk, on one shared valve group
      { aid: 'a_bedw', name: 'West bed', family: 'drip', mode: 'custom', planRef: { pageId: PAGE }, valveGroup: 'Front drip',
        poly: [{ x: 20, y: 90 }, { x: 50, y: 90 }, { x: 50, y: 100 }, { x: 20, y: 100 }] },
      { aid: 'a_bede', name: 'East bed', family: 'drip', mode: 'custom', planRef: { pageId: PAGE }, valveGroup: 'Front drip',
        poly: [{ x: 70, y: 90 }, { x: 100, y: 90 }, { x: 100, y: 100 }, { x: 70, y: 100 }] }
    ],
    routing: { [PAGE]: { poc: { x: 60, y: 130 }, main: [], manifolds: [{ x: 10, y: 110, id: 'm_west' }, { x: 110, y: 110, id: 'm_east' }], pins: {} } }
  }
});

let saved = null;
const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
await page.route('**/*', route => {
  const url = new URL(route.request().url());
  const m = route.request().method();
  if (url.pathname === '/admin/sitebuilder') return route.fulfill({ contentType: 'text/html', body: html });
  if (url.pathname === '/api/projects/PROJ-TEST-0002' && m === 'GET') {
    const p = project(); if (saved) p.systemDesign = saved;
    return route.fulfill({ json: { ok: true, project: p } });
  }
  if (url.pathname === '/api/projects/PROJ-TEST-0002' && m === 'PATCH') {
    saved = route.request().postDataJSON().systemDesign;
    return route.fulfill({ json: { ok: true, project: { id: 'PROJ-TEST-0002', systemDesign: saved } } });
  }
  if (url.pathname === '/api/parts') return route.fulfill({ json: { ok: true, parts: [] } });
  if (url.pathname === '/api/projects') return route.fulfill({ json: { ok: true, projects: [] } });
  if (url.pathname.endsWith('/raster')) return route.fulfill({ status: 404, body: '' });
  if (url.pathname.endsWith('town-water-rates.json')) return route.fulfill({ json: { towns: [] } });
  return route.fulfill({ status: 404, body: '' });
});

let fails = 0;
const check = (ok, msg) => { console.log((ok ? '  ok   ' : '  FAIL ') + msg); if (!ok) fails++; };
const load = async () => { await page.goto('http://pjl.test/admin/sitebuilder?project=PROJ-TEST-0002'); await page.waitForFunction(() => appReady === true); };
await load();

// --- shared drip group: one valve vs one valve per bed ------------------
const grp0 = await page.evaluate(() => ({
  zones: LAST_ZONES.map(z => ({ key: z.key, name: z.name, station: z.station, grouped: !!z.grouped })),
  stations: stationCount(), valves: LAST_ZONES.length
}));
const dripShared = grp0.zones.filter(z => z.grouped);
check(dripShared.length === 1, 'default: the two beds share ONE valve (' + dripShared.map(z => z.key).join(',') + ')');
const grp1 = await page.evaluate(() => {
  setValveGroupMode('Front drip', 'station');
  return { zones: LAST_ZONES.map(z => ({ key: z.key, name: z.name, station: z.station, grouped: !!z.grouped, gpm: +z.gpm.toFixed(2) })),
           stations: stationCount(), valves: LAST_ZONES.length,
           quote: desiredQuoteLines().desired.filter(l => l.kind === 'zone').map(l => l.label + ' — ' + l.description),
           blob: serializeState().valveGroupModes };
});
const dripSt = grp1.zones.filter(z => z.grouped);
check(dripSt.length === 2 && dripSt[0].station === dripSt[1].station, 'station mode: two valves, one station (' + dripSt.map(z => z.key).join(', ') + ')');
check(grp1.stations === grp0.stations && grp1.valves === grp0.valves + 1, 'station count unchanged, one more valve');
check(grp1.quote.some(l => /2 valves wired as one zone/.test(l) && /West bed/.test(l) && /East bed/.test(l)), 'quote: one line naming both beds on 2 valves');
check(grp1.blob && grp1.blob['Front drip'] === 'station', 'mode saved in the design blob');

// --- the Split zone button on a shared group offers per-bed valves -------
await page.evaluate(() => setValveGroupMode('Front drip', ''));
await page.evaluate(id => openMasterPlan(id), PAGE);
await page.waitForSelector('#mpOverlay:not([hidden])');
const offer = await page.evaluate(() => {
  const zi = LAST_ZONES.findIndex(z => z.grouped);
  const before = LAST_ZONES.length;
  window.confirm = () => true;
  mp.zoneSel = zi; mpSetTool('split');
  return { before, after: LAST_ZONES.length, mode: valveGroupMode('Front drip'), sel: mp.zoneSel != null ? LAST_ZONES[mp.zoneSel].key : null, tool: mp.tool };
});
check(offer.mode === 'station' && offer.after === offer.before + 1, 'Split zone on a shared drip group switches it to one valve per bed');
check(offer.sel && offer.sel.startsWith('g:Front drip:0:') && offer.tool === 'pan', 'and lands on the first bed\'s valve (' + offer.sel + ')');
const boxes = await page.evaluate(() => {
  const asg = mpManifoldAssign();
  return asg.byManifold.map(l => l.map(zi => LAST_ZONES[zi].key));
});
check(boxes[0].some(k => k.endsWith(':a_bedw')) && boxes[1].some(k => k.endsWith(':a_bede')), 'west bed valve in M1, east bed valve in M2 (' + JSON.stringify(boxes) + ')');

// --- zoom + hide-others on legend pick ------------------------------------
const lawnZi = await page.evaluate(() => LAST_ZONES.findIndex(z => z.key.startsWith('z:a_lawn')));
await page.evaluate(() => mpClearZoneSel());
const zoom = await page.evaluate(zi => {
  const before = { ppf: mp.ppf, lat: (el('mpBody').innerHTML.match(/class="mp-lat"/g) || []).length };
  mpSelectZone(zi);
  const bb = mpZoneBBox(zi);
  const inView = pzSX(mp, bb.minX) >= 0 && pzSY(mp, bb.minY) >= 0 && pzSX(mp, bb.maxX) <= mp._w && pzSY(mp, bb.maxY) <= mp._h;
  const after = { ppf: mp.ppf, lat: (el('mpBody').innerHTML.match(/class="mp-lat"/g) || []).length, sel: mp.zoneSel, inView,
                  labels: (el('mpBody').innerHTML.match(/3\/4" · \d+ ft|1" · \d+ ft/g) || []).length };
  return { before, after };
}, lawnZi);
check(zoom.after.sel === lawnZi, 'legend pick selects the valve');
check(zoom.after.inView, 'legend pick frames the valve — box, pipe and heads all in view (' + zoom.before.ppf.toFixed(2) + ' → ' + zoom.after.ppf.toFixed(2) + ' px/ft)');
check(zoom.after.lat < zoom.before.lat, 'other valves\' pipe is hidden while working on one (' + zoom.before.lat + ' → ' + zoom.after.lat + ' segments)');
check(zoom.after.labels > 0, 'lateral pieces carry size · length labels (' + zoom.after.labels + ')');

// --- hand-drawn laterals -----------------------------------------------------
const hand = await page.evaluate(zi => {
  const auto = mpLateralPlan().runs.find(r => r.zi === zi);
  const autoFt = auto.ft, autoHeads = auto.nodes;
  mpEditLaterals(zi);
  const nodes = mpLateralNodes(zi);
  const adopted = nodes ? nodes.length : 0;
  const run1 = mpLateralPlan().runs.find(r => r.zi === zi);
  // add a bend well away from the pipe, hanging off the last node
  mp.sel = 'l' + (nodes.length - 1);
  mpTap(60, 75); mpDraw();
  const run2 = mpLateralPlan().runs.find(r => r.zi === zi);
  const nAfterAdd = nodes.length;
  // drag it
  mpMoveHandle('l' + (nodes.length - 1), 60, 80);
  const moved = nodes[nodes.length - 1];
  // delete a middle bend and make sure the chain is spliced, not cut
  const mid = Math.floor(nodes.length / 2);
  mp.sel = 'l' + mid; mpDeleteSel();
  const run3 = mpLateralPlan().runs.find(r => r.zi === zi);
  const trunkSized = run3.edges.filter(e => e.kind === 'trunk').every(e => Number.isFinite(e.gpm));
  const trunkGpmMax = Math.max(...run3.edges.filter(e => e.kind === 'trunk').map(e => e.gpm));
  const spurs = run3.edges.filter(e => e.kind === 'spur').length;
  const handles = (el('mpBody').innerHTML.match(/data-mph="l\d+"/g) || []).length;
  return { autoFt, autoHeads, adopted, custom1: !!run1.custom, ft1: run1.ft, heads1: run1.nodes,
           nAfterAdd, ft2: run2.ft, moved, nAfterDel: nodes.length, ft3: run3.ft, heads3: run3.nodes,
           trunkSized, trunkGpmMax, zoneGpm: LAST_ZONES[zi].gpm, spurs, handles, tool: mp.tool };
}, lawnZi);
console.log('hand:', JSON.stringify(hand));
if (process.env.SHOT2) { await page.evaluate(() => mpDraw()); await page.screenshot({ path: process.env.SHOT2 }); }
check(hand.adopted >= 2, 'edit laterals adopts the auto route as bends (' + hand.adopted + ')');
check(hand.custom1 && hand.heads1 === hand.autoHeads, 'adopted route still feeds every head (' + hand.heads1 + '/' + hand.autoHeads + ')');
check(Math.abs(hand.ft1 - hand.autoFt) / hand.autoFt < 0.25, 'adopted route measures about the same as the auto route (' + Math.round(hand.ft1) + ' vs ' + Math.round(hand.autoFt) + ' ft)');
check(hand.tool === 'lat', 'Lateral bend tool is armed');
check(hand.nAfterAdd === hand.adopted + 1 && hand.ft2 > hand.ft1, 'a click adds a bend and the run gets longer');
check(hand.moved.x === 60 && hand.moved.y === 80, 'a bend can be dragged');
check(hand.nAfterDel === hand.nAfterAdd - 1 && hand.heads3 === hand.autoHeads, 'deleting a bend splices the run — every head still fed');
check(hand.trunkSized && Math.abs(hand.trunkGpmMax - hand.zoneGpm) < 0.01, 'trunk at the box carries the whole zone (' + hand.trunkGpmMax + ' of ' + hand.zoneGpm + ' GPM)');
check(hand.spurs === hand.autoHeads || hand.spurs === hand.autoHeads - 1, 'every head has a spur to the pipe');
check(hand.handles === hand.nAfterDel, 'bends are drawn as draggable handles');

// --- persistence + reset ---------------------------------------------------
const blob = await page.evaluate(() => serializeState());
const lawnKey = await page.evaluate(zi => LAST_ZONES[zi].key, lawnZi);
check(blob.routing[PAGE].laterals && Array.isArray(blob.routing[PAGE].laterals[lawnKey]) && blob.routing[PAGE].laterals[lawnKey].length === hand.nAfterDel, 'hand-drawn bends are in the saved blob');
saved = blob; await load();
const back = await page.evaluate(({ PAGE, key }) => { openMasterPlan(PAGE); const zi = LAST_ZONES.findIndex(z => z.key === key);
  const run = mpLateralPlan().runs.find(r => r.zi === zi); return { custom: !!(run && run.custom), ft: run ? run.ft : 0, blob: serializeState() }; }, { PAGE, key: lawnKey });
check(back.custom && Math.abs(back.ft - hand.ft3) < 0.01, 'after reload the hand-drawn run is back, same length');
const strip = b => { const c = JSON.parse(JSON.stringify(b)); delete c.savedAt; return JSON.stringify(c); };
check(strip(back.blob) === strip(blob), 'save → reload → save round-trips byte-for-byte');
const reset = await page.evaluate(key => { window.confirm = () => true; const zi = LAST_ZONES.findIndex(z => z.key === key); mpResetLaterals(zi);
  const run = mpLateralPlan().runs.find(r => r.zi === zi); return { custom: !!run.custom, ft: run.ft }; }, lawnKey);
check(!reset.custom && Math.abs(reset.ft - hand.autoFt) < 0.01, 'back to auto route restores the original run exactly');

// --- print sheet -------------------------------------------------------------
const sheet = await page.evaluate(key => {
  const zi = LAST_ZONES.findIndex(z => z.key === key);
  mpSelectZone(zi); lpOpen(zi);
  const h = el('lpSheet').innerHTML;
  return { open: !el('lpOverlay').hidden && document.body.classList.contains('lp-open'),
           title: /Lateral layout — Front lawn/.test(h), box: /M\d · valve box/.test(h),
           labels: (h.match(/3\/4" · \d+ ft|1" · \d+ ft/g) || []).length,
           captions: (h.match(/\d+\. PGP[^<]*· \d+° · \d+ ft/g) || []).length,
           sizes: /Pipe by size/.test(h) && /poly — \d+ ft/.test(h),
           noMain: !/POC/.test(h.replace(/no box placed/, '')) };
}, lawnKey);
console.log('sheet:', JSON.stringify(sheet));
check(sheet.open && sheet.title, 'print sheet opens for the selected valve');
check(sheet.box, 'sheet shows the valve box');
check(sheet.labels > 0, 'sheet labels pipe with size · length (' + sheet.labels + ')');
check(sheet.captions > 0, 'sheet captions every head with model · arc · throw (' + sheet.captions + ')');
check(sheet.sizes, 'sheet totals pipe by size');
if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT, fullPage: false });
await page.evaluate(() => lpClose());
// a drip valve sheet too
const dripSheet = await page.evaluate(() => { const zi = LAST_ZONES.findIndex(z => z.key.endsWith(':a_bedw')); lpOpen(zi); const h = el('lpSheet').innerHTML; lpClose();
  return { bed: /West bed/.test(h), station: /one of 2 valves on this station/.test(h), drip: /ft dripline/.test(h) }; });
check(dripSheet.bed && dripSheet.station && dripSheet.drip, 'a bed valve on a shared station prints with its station note');

check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close();
if (fails) { console.log(`\n${fails} check(s) failed`); process.exit(1); }
console.log('\nlateral walk: all checks passed');
