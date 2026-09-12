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
        poly: [{ x: 70, y: 90 }, { x: 100, y: 90 }, { x: 100, y: 100 }, { x: 70, y: 100 }] },
      // A tree row with NO bed outline — trees are the only thing on it.
      { aid: 'a_trees', name: 'Boulevard trees', family: 'trees', mode: 'custom', planRef: { pageId: PAGE },
        poly: [{ x: 120, y: 20 }, { x: 124, y: 20 }, { x: 124, y: 24 }, { x: 120, y: 24 }],
        trees: [{ x: 130, y: 30, type: 'rws' }, { x: 130, y: 50, type: 'rws' }, { x: 130, y: 70, type: 'rws' }] }
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

// --- one size per zone, on the valve's full flow -------------------------
const sizing = await page.evaluate(() => mpLateralPlan().runs.map(run => {
  const z = LAST_ZONES[run.zi];
  return { name: z.name, gpm: +z.gpm.toFixed(1), size: run.size,
           sizes: [...new Set(run.edges.map(e => e.size))],
           want: lateralSizeForGPM(z.gpm) };
}));
console.log('sizing:', JSON.stringify(sizing));
check(sizing.every(r => r.sizes.length <= 2), 'a zone runs at most two sizes — trunk and branches');
check(sizing.every(r => r.size === r.want), "the trunk size comes off the valve's full flow, not the flow past each piece");
const lawnRun = sizing.find(r => /Front lawn/.test(r.name));
check(lawnRun && lawnRun.gpm > 8 && lawnRun.size === '1"', 'a ' + (lawnRun ? lawnRun.gpm : '?') + ' GPM zone trunks at 1", not 3/4"');
const totals = await page.evaluate(() => mpLateralPlan().bySize);
check(Object.keys(totals).every(k => sizing.some(r => r.size === k)), 'pipe-by-size totals only list sizes a zone actually runs (' + Object.keys(totals).join(', ') + ')');

// --- the BOM orders the measured footage in the right sizes --------------
const bom = await page.evaluate(() => {
  const m = measuredLateralsBySize();
  const b = buildBOM(PARTS_MAP || {});
  const rolls = {};
  b.lines.forEach(l => { if (/^POPO/.test(l.sku)) rolls[l.sku] = l.qty; });
  return { measured: m.measured, totalFt: Math.round(m.totalFt), bySize: m.bySize,
           bomFt: b.lateralFt, bomMeasured: b.lateralMeasured, bomBySize: b.lateralBySize, rolls };
});
console.log('bom:', JSON.stringify(bom));
check(bom.measured && bom.bomMeasured, 'the BOM uses the measured lateral footage once the plan is routed');
check(bom.bomFt === Math.ceil(bom.totalFt) || Math.abs(bom.bomFt - bom.totalFt) <= 1, 'BOM footage matches what the plan measured (' + bom.bomFt + ' ft)');
const want34 = Math.ceil((bom.bySize['3/4"'] || 0) / 400), want1 = Math.ceil((bom.bySize['1"'] || 0) / 300);
check((bom.rolls['POPO75400'] || 0) === want34, '3/4" ordered as ' + want34 + ' x 400 ft roll(s)');
check((bom.rolls['POPO100300'] || 0) === want1, '1" ordered as ' + want1 + ' x 300 ft roll(s) — not as 3/4"');
check(want1 > 0, 'the 1" zone actually put 1" pipe on the order');

// --- with nothing routed it falls back to the old 3/4" estimate ----------
const fallback = await page.evaluate(() => {
  const keep = JSON.parse(JSON.stringify(routing));
  routing = {};
  const b = buildBOM(PARTS_MAP || {});
  const rolls = {}; b.lines.forEach(l => { if (/^POPO/.test(l.sku)) rolls[l.sku] = l.qty; });
  routing = keep;
  return { measured: b.lateralMeasured, rolls };
});
check(!fallback.measured && (fallback.rolls['POPO75400'] || 0) > 0 && !fallback.rolls['POPO100300'],
      'an unrouted design still falls back to the old 3/4" estimate');

// --- trees are points the lateral runs to, and tees ----------------------
const treeZi = await page.evaluate(() => LAST_ZONES.findIndex(z => (z.parts || []).some(pt => areas[pt.areaIdx] && areas[pt.areaIdx].aid === 'a_trees')));
check(treeZi >= 0, 'the tree row computed a valve of its own');
const treeRun = await page.evaluate(zi => {
  mpSelectZone(zi);
  const z = LAST_ZONES[zi];
  const run = mpLateralPlan().runs.find(r => r.zi === zi);
  const trees = mpZoneTrees(z);
  const drawn = (el('mpBody').innerHTML.match(/data-mph="t\d+_\d+"/g) || []).length;
  // every tree should be an endpoint of some lateral segment
  const fed = trees.filter(t => run && run.edges.some(e =>
    (Math.abs(e.b.x - t.x) < 0.01 && Math.abs(e.b.y - t.y) < 0.01) ||
    (Math.abs(e.a.x - t.x) < 0.01 && Math.abs(e.a.y - t.y) < 0.01))).length;
  return { trees: trees.length, fed, ft: run ? Math.round(run.ft) : 0, gpm: +z.gpm.toFixed(2), drawnHandles: drawn };
}, treeZi);
console.log('trees:', JSON.stringify(treeRun));
check(treeRun.trees === 3, 'all three trees are on the plan');
check(treeRun.fed === 3, 'the lateral runs to every tree individually (' + treeRun.fed + '/3)');
check(treeRun.ft > 0, 'the tree run measures real pipe (' + treeRun.ft + ' ft)');

// place a fourth tree from the master plan, then delete it
const placed = await page.evaluate(zi => {
  window.alert = () => {};
  if (mp.zoneSel !== zi) mpSelectZone(zi);
  mpSetTool('tree');
  const armed = mp.tool;
  mpTap(130, 90);
  const key = LAST_ZONES[mp.zoneSel] ? LAST_ZONES[mp.zoneSel].key : null;
  const after = areas.find(a => a.aid === 'a_trees').trees.length;
  const fedNow = mpZoneTrees(LAST_ZONES[mp.zoneSel]).length;
  return { armed, after, fedNow, key, sel: mp.zoneSel, name: LAST_ZONES[mp.zoneSel] && LAST_ZONES[mp.zoneSel].name };
}, treeZi);
console.log('placed:', JSON.stringify(placed));
check(placed.armed === 'tree' && placed.after === 4 && placed.fedNow === 4, 'the Tree tool drops a tree the lateral then feeds');
const removed = await page.evaluate(() => {
  const a = areas.find(x => x.aid === 'a_trees');
  mp.sel = 't' + areas.indexOf(a) + '_3';
  mpDeleteSel();
  return areas.find(x => x.aid === 'a_trees').trees.length;
});
check(removed === 3, 'Delete removes a tree again');

// --- trunk + branch sizing, and the manual override ----------------------
const sizing2 = await page.evaluate(() => {
  const zi = LAST_ZONES.findIndex(z => /Front lawn/.test(z.name));
  const run = mpLateralPlan().runs.find(r => r.zi === zi);
  const z = LAST_ZONES[zi];
  const trunk = run.edges.filter(e => e.kind !== 'spur');
  const spurs = run.edges.filter(e => e.kind === 'spur');
  const atRoot = run.edges.slice().sort((a, b) => b.gpm - a.gpm)[0];
  return { zi, gpm: +z.gpm.toFixed(1), trunkSize: zoneTrunkSize(z), atRoot: atRoot && atRoot.size,
           trunkSizes: [...new Set(trunk.map(e => e.size))],
           spurSizes: [...new Set(spurs.map(e => e.size))],
           all: [...new Set(run.edges.map(e => e.size))] };
});
console.log('sizing2:', JSON.stringify(sizing2));
check(sizing2.atRoot === sizing2.trunkSize, 'the pipe leaving the box is the trunk size (' + sizing2.atRoot + ')');
check(sizing2.trunkSizes.every(s => s === sizing2.trunkSize || s === '3/4"'), 'the run reduces to 3/4" once the flow drops, and never to anything else (' + sizing2.trunkSizes.join(', ') + ')');
check(sizing2.spurSizes.every(s => s === '3/4"'), 'branches drop to 3/4" (' + sizing2.spurSizes.join(', ') + ')');
check(sizing2.all.length <= 2, 'never more than two sizes on one zone (' + sizing2.all.join(', ') + ')');
const forced = await page.evaluate(({ zi, pageId }) => {
  mpSetZoneSize(zi, '1-1/4"');
  const run = mpLateralPlan().runs.find(r => r.zi === zi);
  const sizes = [...new Set(run.edges.map(e => e.size))];
  const saved = serializeState().routing[pageId].latSize;
  mpSetZoneSize(zi, '');
  const back = [...new Set(mpLateralPlan().runs.find(r => r.zi === zi).edges.map(e => e.size))];
  return { sizes, saved, back };
}, { zi: sizing2.zi, pageId: PAGE });
check(forced.sizes.length === 1 && forced.sizes[0] === '1-1/4"', 'forcing a size puts the whole zone on it');
check(forced.saved && Object.values(forced.saved)[0] === '1-1/4"', 'the forced size is saved with the design');
check(forced.back.length <= 2 && forced.back.includes('3/4"'), 'clearing the override goes back to trunk + branches');

// --- hand-drawn laterals -----------------------------------------------------
const hand = await page.evaluate(zi => {
  const auto = mpLateralPlan().runs.find(r => r.zi === zi);
  const autoFt = auto.ft, autoHeads = auto.nodes;
  mpEditLaterals(zi);
  const nodes = mpLateralNodes(zi);
  const adopted = nodes ? nodes.length : 0;
  const run1 = mpLateralPlan().runs.find(r => r.zi === zi);
  // Click ON an existing piece of pipe: it must BEND that run, not throw a
  // new branch across the site. Midpoint of the first trunk segment.
  const root0 = mpLateralRoot(zi);
  const e0 = mpTreeEdges(root0, nodes)[0];
  const midX = (e0.a.x + e0.b.x) / 2, midY = (e0.a.y + e0.b.y) / 2;
  const childBefore = nodes[e0.bi] ? nodes[e0.bi].p : null;
  const ftBeforeInsert = mpLateralPlan().runs.find(r => r.zi === zi).ft;
  mp.sel = null;
  mpTap(midX, midY + 0.2); mpDraw();
  const insert = { n: nodes.length, newIdx: nodes.length - 1, newParent: nodes[nodes.length - 1].p,
                   childNow: nodes[e0.bi] ? nodes[e0.bi].p : null, childBefore,
                   ft: mpLateralPlan().runs.find(r => r.zi === zi).ft, ftBefore: ftBeforeInsert };
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
  return { insert, autoFt, autoHeads, adopted, custom1: !!run1.custom, ft1: run1.ft, heads1: run1.nodes,
           nAfterAdd, ft2: run2.ft, moved, nAfterDel: nodes.length, ft3: run3.ft, heads3: run3.nodes,
           trunkSized, trunkGpmMax, zoneGpm: LAST_ZONES[zi].gpm, spurs, handles, tool: mp.tool };
}, lawnZi);
console.log('hand:', JSON.stringify(hand));
if (process.env.SHOT2) { await page.evaluate(() => mpDraw()); await page.screenshot({ path: process.env.SHOT2 }); }
check(hand.adopted >= 2, 'edit laterals adopts the auto route as bends (' + hand.adopted + ')');
check(hand.custom1 && hand.heads1 === hand.autoHeads, 'adopted route still feeds every head (' + hand.heads1 + '/' + hand.autoHeads + ')');
check(Math.abs(hand.ft1 - hand.autoFt) / hand.autoFt < 0.25, 'adopted route measures about the same as the auto route (' + Math.round(hand.ft1) + ' vs ' + Math.round(hand.autoFt) + ' ft)');
check(hand.tool === 'lat', 'Lateral bend tool is armed');
check(hand.insert.newParent === -1 || Number.isInteger(hand.insert.newParent), 'clicking on the pipe adds a bend');
check(hand.insert.childNow === hand.insert.newIdx, 'the rest of the run reattaches to the new bend — the pipe bends, it does not branch away');
check(Math.abs(hand.insert.ft - hand.insert.ftBefore) < 2, 'inserting a bend barely changes the length (' + Math.round(hand.insert.ftBefore) + ' -> ' + Math.round(hand.insert.ft) + ' ft)');
check(hand.nAfterAdd === hand.adopted + 2 && hand.ft2 > hand.ft1, 'clicking off the pipe with a bend selected tees a branch out');
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
