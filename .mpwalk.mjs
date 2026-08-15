import { chromium } from 'playwright';
const SP='/tmp/claude-0/-home-user-mysite/987d5845-3ac1-59a4-a888-9ee28764019b/scratchpad';
const BASE='http://127.0.0.1:'+(process.env.PORT||'8141');
const log=(...a)=>console.log(...a);
let failures=0;
const check=(n,c,d='')=>{ log(`${c?'  PASS':'  FAIL'}  ${n}${d?' — '+d:''}`); if(!c) failures++; };
const near=(a,b,tol)=>Math.abs(a-b)<=tol;

const browser=await chromium.launch({executablePath:'/opt/pw-browsers/chromium'});
const ctx=await browser.newContext({viewport:{width:1500,height:1050}});
const page=await ctx.newPage();
page.on('console', m=>{ if(m.type()==='error') log('   [console.error]', m.text()); });
page.on('pageerror', e=>{ log('   [pageerror]', e.message); failures++; });
const dialogs=[];
page.on('dialog', d=>{ dialogs.push(d.message()); d.accept(); });

await page.goto(BASE+'/login');
await page.fill('input[type=email]','test@pjllandservices.com');
await page.fill('input[type=password]','TestPassw0rd123');
await Promise.all([page.waitForNavigation({waitUntil:'domcontentloaded'}).catch(()=>{}), page.click('button[type=submit]')]);
await page.waitForTimeout(600);
check('logged in', !page.url().includes('/login'), page.url());

const proj = await page.evaluate(async ()=>{
  const r=await fetch('/api/projects',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({name:'Master plan layer 2 walk', address:'2 Main Rd'})});
  return (await r.json()).project;
});
log('  project:', proj.id);

await page.goto(`${BASE}/admin/sitebuilder?project=${proj.id}`);
await page.waitForFunction(()=>typeof appReady!=='undefined' && appReady===true, {timeout:20000});

// ---- upload + calibrate a sheet through the real UI ----
await page.click('#spUploadBtn');
await page.setInputFiles('#spFile', SP+'/testsheet.pdf');
await page.waitForSelector('.sp-thumb', {timeout:30000});
await page.click('.sp-thumb');
await page.click('#spAddBtn');
await page.waitForFunction(()=>typeof sitePlan!=='undefined' && sitePlan && sitePlan.pages && sitePlan.pages.length===1, {timeout:60000});
const pg = await page.evaluate(()=>sitePlan.pages[0]);
const s = pg.renderScale;
const R = { x1:100*s, y1:100*s, x2:460*s, y2:316*s };
async function calClick(rx, ry){
  const pt=await page.evaluate(([rx,ry])=>{ const r=document.getElementById('calSvg').getBoundingClientRect();
    return {x:r.left+(rx*cal.ppf+cal.panX), y:r.top+(ry*cal.ppf+cal.panY)}; }, [rx,ry]);
  await page.mouse.move(pt.x,pt.y); await page.mouse.down(); await page.mouse.up(); await page.waitForTimeout(50);
}
await page.evaluate(id=>calOpen(id), pg.id);
await page.waitForSelector('#calSvg'); await page.waitForTimeout(400);
await calClick(R.x1,R.y1); await calClick(R.x2,R.y1);
await page.fill('#calKnown','100');
const MIDX=(R.x1+R.x2)/2;
await calClick(MIDX,R.y1); await calClick(MIDX,R.y2);
await page.fill('#calExpected','60');
await page.waitForTimeout(200);
await page.click('#calSaveBtn');
await page.waitForFunction(()=>document.getElementById('calOverlay').hidden===true, {timeout:15000});
const ftPerPx = await page.evaluate(id=>spPage(id).calibration.ftPerPx, pg.id);
check('sheet calibrated', ftPerPx>0, ftPerPx.toFixed(5)+' ft/px');

// ---- seed three traced areas at KNOWN sheet-feet positions ----
// Lawn A  square 0..40 in x, 0..40 in y      -> centroid (20,20)
// Lawn B  square 200..240 x, 0..40 y         -> centroid (220,20)
// Bed C   square 0..40 x, 200..240 y         -> centroid (20,220)
await page.evaluate((pageId)=>{
  const sq=(x0,y0,w,h)=>[{x:x0,y:y0},{x:x0+w,y:y0},{x:x0+w,y:y0+h},{x:x0,y:y0+h}];
  areas=[
    {name:'Lawn A', mode:'custom', poly:sq(0,0,40,40), family:'spray', sprayBody:'b4', spraySeries:'s12',
     planRef:{pageId}, layout:'manual', manualHeads:[
       {x:5,y:5,arc:90,dir:0.785,noz:'s12',zone:0},{x:35,y:5,arc:90,dir:2.356,noz:'s12',zone:0},
       {x:5,y:35,arc:90,dir:-0.785,noz:'s12',zone:0},{x:35,y:35,arc:90,dir:3.927,noz:'s12',zone:0}]},
    {name:'Lawn B', mode:'custom', poly:sq(200,0,40,40), family:'spray', sprayBody:'b4', spraySeries:'s12',
     planRef:{pageId}, layout:'manual', manualHeads:[
       {x:205,y:5,arc:90,dir:0.785,noz:'s12',zone:0},{x:235,y:35,arc:90,dir:3.927,noz:'s12',zone:0}]},
    {name:'Bed C', mode:'custom', poly:sq(0,200,40,40), family:'drip', dripRowIn:18, planRef:{pageId}}
  ];
  render();
}, pg.id);
await page.waitForTimeout(400);

await page.evaluate(id=>openMasterPlan(id), pg.id);
await page.waitForSelector('#mpSvg'); await page.waitForTimeout(300);
check('master plan opened', await page.evaluate(()=>!document.getElementById('mpOverlay').hidden));
check('tool defaults to Move', await page.evaluate(()=>mp.tool==='pan' && document.getElementById('mpToolpan').classList.contains('on')));
check('readout invites a POC', /Point of connection/.test(await page.evaluate(()=>document.getElementById('mpRoute').textContent)));

// ---- place routing directly in sheet feet, then verify the MEASURED numbers ----
// POC at (0,-60). Bends (0,20) and (220,20). Manifolds at (20,30) and (220,50).
await page.evaluate(()=>{
  const r=routingFor(mp.pageId);
  r.poc={x:0,y:-60}; r.main=[{x:0,y:20},{x:220,y:20}];
  r.manifolds=[{x:20,y:30},{x:220,y:50}];
  mpDraw();
});
const st = await page.evaluate(()=>mpRouteStats());
// legs: (0,-60)->(0,20) = 80 ; (0,20)->(220,20) = 220  => 300
check('mainline length measured off the sheet', near(st.mainFt,300,0.001), st.mainFt.toFixed(3)+' ft (expected 300)');
check('leg count', st.segs.length===2, JSON.stringify(st.segs.map(x=>Math.round(x.ft))));
// tee 1: (20,30) -> nearest point on the y=20 leg is (20,20) => 10 ft
// tee 2: (220,50) -> nearest point is the end vertex (220,20)  => 30 ft
check('tee 1 is the perpendicular drop, not a run to the start', near(st.tees[0].dist,10,0.001), st.tees[0].dist.toFixed(3)+' ft');
check('tee 2 clamps to the segment end', near(st.tees[1].dist,30,0.001), st.tees[1].dist.toFixed(3)+' ft');
check('tee total', near(st.teeFt,40,0.001), st.teeFt.toFixed(3));

// ---- manifold assignment: nearest manifold wins ----
const asg = await page.evaluate(()=>{
  const a=mpManifoldAssign();
  return {byManifold:a.byManifold, unplaced:a.unplaced,
          names:a.byManifold.map(list=>list.map(zi=>LAST_ZONES[zi].name))};
});
log('  manifold assignment:', JSON.stringify(asg.names), 'unplaced', asg.unplaced.length);
// Lawn A centroid (20,20) & Bed C centroid (20,220) are nearest M1 (20,30);
// Lawn B centroid (220,20) is nearest M2 (220,50).
check('Lawn A -> M1', asg.names[0].includes('Lawn A'));
check('Bed C -> M1', asg.names[0].includes('Bed C'));
check('Lawn B -> M2', asg.names[1].includes('Lawn B') && !asg.names[0].includes('Lawn B'));
check('every valve is assigned', asg.unplaced.length===0);
const totalAssigned = asg.byManifold.reduce((n,l)=>n+l.length,0);
const totalZones = await page.evaluate(()=>LAST_ZONES.length);
check('no valve counted twice or lost', totalAssigned===totalZones, `${totalAssigned}/${totalZones}`);

// ---- readout ----
const readout = await page.evaluate(()=>document.getElementById('mpRoute').textContent);
log('  readout:', readout);
check('readout shows measured length', /300 ft measured/.test(readout));
check('readout shows tee footage', /40 ft of tees/.test(readout));
check('readout names the pipe size', /Mainline\s+\S+/.test(readout));
check('readout says the BOM is untouched', /on-site figure in the BOM/.test(readout));

// pipe size must track peak zone flow, not total
const sizing = await page.evaluate(()=>{
  const peak=Math.max(...LAST_ZONES.map(z=>z.gpm));
  return {peak, size:pipeForGPM(peak)};
});
check('mainline sized on peak single-zone GPM', readout.includes(sizing.size),
      `peak ${sizing.peak.toFixed(1)} GPM -> ${sizing.size}`);

// ---- the geometry actually renders and is hit-testable ----
const svg = await page.evaluate(()=>({
  poc:document.querySelectorAll('[data-mph="poc"]').length,
  bends:document.querySelectorAll('[data-mph^="b"]').length,
  mans:document.querySelectorAll('[data-mph^="m"]').length,
  labels:(document.getElementById('mpSvg').textContent.match(/M\d · \d valve/g)||[]).length
}));
check('POC handle drawn', svg.poc===1);
check('bend handles drawn', svg.bends===2, String(svg.bends));
check('manifold handles drawn', svg.mans===2, String(svg.mans));
check('manifolds labelled with their valve count', svg.labels===2, String(svg.labels));

// ---- Fit must frame the POC even though it sits off the traced areas ----
await page.evaluate(()=>mpFit());
const pocOnScreen = await page.evaluate(()=>{
  const X=pzSX(mp, routingRO(mp.pageId).poc.x), Y=pzSY(mp, routingRO(mp.pageId).poc.y);
  return {X, Y, w:mp._w, h:mp._h};
});
check('Fit keeps the POC on canvas', pocOnScreen.X>=0 && pocOnScreen.X<=pocOnScreen.w &&
      pocOnScreen.Y>=0 && pocOnScreen.Y<=pocOnScreen.h,
      `(${pocOnScreen.X.toFixed(0)},${pocOnScreen.Y.toFixed(0)}) in ${pocOnScreen.w}x${pocOnScreen.h}`);

// ---- auto-route chains nearest-first from the POC ----
await page.evaluate(()=>{ const r=routingFor(mp.pageId); r.main=[]; mpAutoRoute(); });
const auto = await page.evaluate(()=>({main:routingRO(mp.pageId).main, st:mpRouteStats()}));
// POC (0,-60): nearest manifold is (20,30) [d=91.1] then (220,50)
check('auto-route visits the nearest manifold first', auto.main[0].x===20 && auto.main[0].y===30, JSON.stringify(auto.main));
check('auto-route reaches every manifold', auto.main.length===2);
check('auto-route leaves no tee footage', near(auto.st.teeFt,0,1e-9), auto.st.teeFt.toFixed(4));

// ---- serialize round trip at version 5 ----
const blob = await page.evaluate(()=>serializeState());
check('blob is version 5', blob.version===5, String(blob.version));
check('routing is in the blob', !!blob.routing[Object.keys(blob.routing)[0]].poc);
const rt = await page.evaluate(b=>{
  routing={};
  restoreRouting(b.routing);
  return JSON.parse(JSON.stringify(routing));
}, blob);
check('routing round-trips', JSON.stringify(rt)===JSON.stringify(blob.routing));

// ---- a design with no routing must not grow an empty husk ----
const empty = await page.evaluate(()=>{ routing={}; routingFor(mp.pageId); return serializeState().routing; });
check('an untouched sheet serializes to nothing', Object.keys(empty).length===0, JSON.stringify(empty));

// ---- an old version-4 blob still loads ----
const v4ok = await page.evaluate(b=>{
  const old=JSON.parse(JSON.stringify(b)); old.version=4; delete old.routing;
  routing={'spp_xxxxxxxx':{poc:{x:1,y:1},main:[],manifolds:[]}};
  const ok=restoreState(old);
  return {ok, routingKeys:Object.keys(routing)};
}, blob);
check('a version-4 blob still restores', v4ok.ok===true);
check('a version-4 blob clears stale routing rather than keeping it', v4ok.routingKeys.length===0, JSON.stringify(v4ok.routingKeys));

// ---- save to the server and reload the page ----
await page.evaluate(b=>{ restoreRouting(b.routing); }, blob);
await page.evaluate(async b=>{
  const st=serializeState();
  await fetch('/api/projects/'+PROJECT_ID,{method:'PATCH',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({systemDesign:st})});
}, blob);
await page.goto(`${BASE}/admin/sitebuilder?project=${proj.id}`);
await page.waitForFunction(()=>typeof appReady!=='undefined' && appReady===true, {timeout:20000});
await page.waitForTimeout(500);
const after = await page.evaluate(()=>JSON.parse(JSON.stringify(routing)));
check('routing survives a save + reload', JSON.stringify(after)===JSON.stringify(blob.routing),
      JSON.stringify(after).slice(0,140));

// ---- delete semantics ----
await page.evaluate(id=>openMasterPlan(id), pg.id);
await page.waitForSelector('#mpSvg'); await page.waitForTimeout(200);
const del = await page.evaluate(()=>{
  const r=routingFor(mp.pageId);
  const before=r.manifolds.length;
  mp.sel='m0'; mpDeleteSel();
  const afterMan=r.manifolds.length;
  mp.sel='poc'; mpDeleteSel();
  return {before, afterMan, poc:r.poc, main:r.main.length};
});
check('deleting a manifold removes exactly one', del.before-del.afterMan===1, `${del.before}->${del.afterMan}`);
check('deleting the POC drops the bends that hang off it', del.poc===null && del.main===0);
const noPoc = await page.evaluate(()=>({st:mpRouteStats(), txt:document.getElementById('mpRoute').textContent}));
check('no POC -> zero measured mainline', noPoc.st.mainFt===0);
check('no POC is called out, not silently zero', /No point of connection/.test(noPoc.txt), noPoc.txt);

// ---- the BOM must be untouched by any of this ----
const bomBefore = await page.evaluate(()=>document.getElementById('bomTable').textContent.replace(/\s+/g,' '));
await page.evaluate(()=>{ const r=routingFor(mp.pageId); r.poc={x:0,y:-500}; r.main=[{x:0,y:0},{x:900,y:0}]; mpDraw(); });
await page.waitForTimeout(300);
const bomAfter = await page.evaluate(()=>document.getElementById('bomTable').textContent.replace(/\s+/g,' '));
check('a 1,400 ft main does NOT move the material list', bomBefore===bomAfter);

// ---- the same thing again, but driven by real clicks on the canvas ----
await page.evaluate(()=>{ routing={}; mp.tool='pan'; mp.sel=null; mpPaintTools(); mpFit(); });
async function mpClick(fx, fy){
  const pt=await page.evaluate(([fx,fy])=>{ const r=document.getElementById('mpSvg').getBoundingClientRect();
    return {x:r.left+pzSX(mp,fx), y:r.top+pzSY(mp,fy)}; }, [fx,fy]);
  await page.mouse.move(pt.x,pt.y); await page.mouse.down(); await page.mouse.up(); await page.waitForTimeout(80);
  return pt;
}
await page.click('#mpToolpoc');
check('POC tool arms', await page.evaluate(()=>mp.tool==='poc' && document.getElementById('mpToolpoc').classList.contains('on')));
await mpClick(10,10);
const clickedPoc = await page.evaluate(()=>routingRO(mp.pageId).poc);
check('clicking the canvas places the POC', clickedPoc && near(clickedPoc.x,10,0.6) && near(clickedPoc.y,10,0.6), JSON.stringify(clickedPoc));
await page.click('#mpToolmanifold');
await mpClick(120,10);
const clickedMan = await page.evaluate(()=>routingRO(mp.pageId).manifolds);
check('clicking the canvas places a manifold', clickedMan.length===1 && near(clickedMan[0].x,120,0.6), JSON.stringify(clickedMan));
await page.click('#mpToolbend');
await mpClick(60,60);
const bends = await page.evaluate(()=>routingRO(mp.pageId).main);
check('clicking the canvas adds a mainline bend', bends.length===1 && near(bends[0].x,60,0.6), JSON.stringify(bends));

await page.click('#mpToolpan');
const from = await mpClick(120,10);
check('clicking a marker with Move selects it, does not duplicate it',
      await page.evaluate(()=>mp.sel==='m0' && routingRO(mp.pageId).manifolds.length===1),
      await page.evaluate(()=>mp.sel));
const to = await page.evaluate(([fx,fy])=>{ const r=document.getElementById('mpSvg').getBoundingClientRect();
  return {x:r.left+pzSX(mp,fx), y:r.top+pzSY(mp,fy)}; }, [150,90]);
await page.mouse.move(from.x, from.y); await page.mouse.down();
await page.mouse.move((from.x+to.x)/2, (from.y+to.y)/2); await page.mouse.move(to.x, to.y);
await page.mouse.up(); await page.waitForTimeout(120);
const dragged = await page.evaluate(()=>routingRO(mp.pageId).manifolds[0]);
check('dragging a manifold moves it in sheet feet', near(dragged.x,150,0.8) && near(dragged.y,90,0.8), JSON.stringify(dragged));
check('a drag marks the design unsaved', await page.evaluate(()=>dirty===true));

await page.evaluate(()=>{ routing={}; mp.tool='bend'; });
dialogs.length=0;
await mpClick(30,30);
await page.waitForTimeout(200);
check('a bend without a POC is refused with a reason',
      dialogs.some(m=>/point of connection/i.test(m)) && await page.evaluate(()=>routingRO(mp.pageId).main.length===0),
      JSON.stringify(dialogs));

// ═══════════ layer 3: laterals ═══════════
await page.evaluate(()=>{ routing={}; const r=routingFor(mp.pageId);
  r.poc={x:0,y:-60}; r.main=[{x:0,y:20}]; r.manifolds=[{x:0,y:20}];
  mp.tool='pan'; mp.sel=null; mp.laterals=true; mpPaintTools(); mpDraw(); });

// Lawn A is a 40x40 square with 4 hand-placed heads at (5,5) (35,5) (5,35) (35,35),
// all on one valve. Rooted at the single manifold (0,20) the cheapest tree is
// M->(5,5)=15.81, (5,5)->(5,35)=30, (5,5)->(35,5)=30, (35,5)->(35,35)=30.
const lat = await page.evaluate(()=>{
  const plan=mpLateralPlan();
  const zA=LAST_ZONES.findIndex(z=>z.name==='Lawn A');
  const run=plan.runs.find(r=>r.zi===zA);
  return {total:plan.totalFt, bySize:plan.bySize, runs:plan.runs.length,
          lawnA: run ? {ft:run.ft, n:run.nodes, edges:run.edges.map(e=>({ft:+e.ft.toFixed(3), gpm:+e.gpm.toFixed(2)}))} : null};
});
check('every valve on the sheet gets a lateral run', lat.runs===await page.evaluate(()=>LAST_ZONES.length), `${lat.runs} runs`);
check('Lawn A reaches all 4 of its heads', lat.lawnA && lat.lawnA.n===4, JSON.stringify(lat.lawnA && lat.lawnA.n));
// Manifold (0,20) to heads (5,5)(35,5)(5,35)(35,35): the minimum tree is
// two 15.811 ft drops to the near corners plus two 30 ft runs across = 91.623.
// A pipe per head would be 107.781, so this also proves it branches.
check('Lawn A lateral is the minimum spanning tree, not a pipe per head',
      near(lat.lawnA.ft, 91.623, 0.01), lat.lawnA.ft.toFixed(3)+' ft (MST 91.623, one-pipe-per-head would be 107.781)');
const zoneGpm = await page.evaluate(()=>LAST_ZONES[LAST_ZONES.findIndex(z=>z.name==='Lawn A')].gpm);
// Two branches leave this manifold, so no single segment carries the zone —
// what must hold is that the segments leaving the root sum to it, and that
// nothing anywhere carries more than the valve delivers.
const rootFlow = await page.evaluate(()=>{
  const zA=LAST_ZONES.findIndex(z=>z.name==='Lawn A');
  const run=mpLateralPlan().runs.find(r=>r.zi===zA);
  const root=routingRO(mp.pageId).manifolds[0];
  const atRoot=run.edges.filter(e=>Math.hypot(e.a.x-root.x,e.a.y-root.y)<1e-9);
  return {sum:atRoot.reduce((t,e)=>t+e.gpm,0), n:atRoot.length, max:Math.max(...run.edges.map(e=>e.gpm))};
});
check('the segments leaving the manifold sum to the whole zone flow',
      near(rootFlow.sum, zoneGpm, 0.01), `${rootFlow.n} branches summing ${rootFlow.sum.toFixed(2)} vs zone ${zoneGpm.toFixed(2)}`);
check('no segment is asked to carry more than the valve delivers', rootFlow.max <= zoneGpm + 0.01, `max ${rootFlow.max.toFixed(2)} GPM`);
const leaf = lat.lawnA.edges[lat.lawnA.edges.length-1];
check('the last hop carries one head, not the zone', leaf.gpm < zoneGpm - 0.01, `${leaf.gpm} GPM`);
check('lateral sizes never drop below the pipe actually stocked',
      !Object.keys(lat.bySize).includes('1/2\"'), JSON.stringify(lat.bySize));

// drip beds tap the point on the outline NEAREST the manifold
const tap = await page.evaluate(()=>{
  const zi=LAST_ZONES.findIndex(z=>z.name==='Bed C');
  return mpZoneNodes(zi, {x:0,y:20})[0];
});
// Bed C is the square 0..40 x, 200..240 y. Nearest boundary point to (0,20) is (0,200).
check('a drip bed taps its nearest outline point, not its centre',
      tap && tap.kind==='bed' && near(tap.x,0,0.01) && near(tap.y,200,0.01), JSON.stringify(tap));

const latTxt = await page.evaluate(()=>document.getElementById('mpRoute').textContent);
log('  readout:', latTxt);
check('readout reports lateral footage', /Laterals\s+\d+\s*ft/.test(latTxt), latTxt);
check('laterals render', await page.evaluate(()=>{ const n=document.getElementById('mpSvg').querySelectorAll('line').length; return n>10; }));
await page.click('#mpToolLat');
check('the Laterals toggle turns them off', await page.evaluate(()=>mp.laterals===false) &&
      !/Laterals/.test(await page.evaluate(()=>document.getElementById('mpRoute').textContent)));
await page.click('#mpToolLat');

// ---- heads are coloured by the valve packZones actually gave them ----
const zoneColours = await page.evaluate(()=>{
  // force Lawn A onto 3 valves by dropping the GPM ceiling
  const prev=document.getElementById('ceiling').value;
  document.getElementById('ceiling').value='1.0';
  document.getElementById('ceiling').dispatchEvent(new Event('input',{bubbles:true}));
  compute(); mpDraw();
  const i=areas.findIndex(a=>a.name==='Lawn A');
  const zs=new Set(mpHeadsOf(areas[i], mpPlanFor(areas[i])).map(h=>zoneIndexOf(i,h.zone||0)));
  document.getElementById('ceiling').value=prev;
  document.getElementById('ceiling').dispatchEvent(new Event('input',{bubbles:true}));
  compute(); mpDraw();
  return {distinct:zs.size, zones:[...zs]};
});
check('a lawn split across several valves draws several colours, not one',
      zoneColours.distinct>1, JSON.stringify(zoneColours));

// ---- an auto-laid-out traced area draws its heads too ----
const autoHeads = await page.evaluate(()=>{
  const i=areas.findIndex(a=>a.name==='Lawn B');
  delete areas[i].layout; delete areas[i].manualHeads;   // back to auto layout
  compute(); mpDraw();
  const n=mpHeadsOf(areas[i], mpPlanFor(areas[i])).length;
  return {n, drawnCircles:document.getElementById('mpSvg').querySelectorAll('circle').length};
});
check('an auto-laid-out traced area places its heads on the master plan', autoHeads.n>0, JSON.stringify(autoHeads));

// ---- overfull valve box is called out, not silently allowed ----
const overfull = await page.evaluate(()=>{
  const r=routingFor(mp.pageId); r.manifolds=[{x:20,y:20}];   // one box for everything
  mpDraw();
  const a=mpManifoldAssign();
  return {n:a.byManifold[0].length, cap:MANIFOLD_PER_BOX,
          txt:document.getElementById('mpRoute').textContent,
          red:document.getElementById('mpSvg').innerHTML.includes('#c62828')};
});
if(overfull.n>overfull.cap){
  check('an overfull box is named in the readout', /house limit is 4/.test(overfull.txt), overfull.txt);
  check('an overfull box is drawn in red', overfull.red);
} else {
  check('overfull-box check had enough valves to exercise', false, `only ${overfull.n} valves in the box`);
}

// ---- still no effect on the money ----
const bom2 = await page.evaluate(()=>document.getElementById('bomTable').textContent.replace(/\s+/g,' '));
await page.evaluate(()=>{ const r=routingFor(mp.pageId); r.manifolds=[{x:-300,y:-300},{x:400,y:400}]; mpDraw(); });
await page.waitForTimeout(250);
const bom3 = await page.evaluate(()=>document.getElementById('bomTable').textContent.replace(/\s+/g,' '));
check('moving manifolds 700 ft apart does NOT move the material list', bom2===bom3);

// ---- a bed split across several valves must not draw as one pipe ----
const split = await page.evaluate(()=>{
  const r=routingFor(mp.pageId); r.poc={x:0,y:-60}; r.main=[{x:0,y:20}]; r.manifolds=[{x:0,y:20}];
  const prev=document.getElementById('ceiling').value;
  document.getElementById('ceiling').value='2.5';        // force Bed C onto several valves
  document.getElementById('ceiling').dispatchEvent(new Event('input',{bubbles:true}));
  compute(); mpDraw();
  const bedIdx=areas.findIndex(a=>a.name==='Bed C');
  const runs=mpLateralPlan().runs.filter(run=>(LAST_ZONES[run.zi].parts||[]).some(pt=>pt.areaIdx===bedIdx));
  // only the coloured lateral strokes — grid, drip runs and the white
  // casing under each lateral would all muddy a plain <line> count
  const lines=[...document.getElementById('mpSvg').querySelectorAll('line.mp-lat')]
    .map(l=>l.getAttribute('x1')+','+l.getAttribute('y1')+','+l.getAttribute('x2')+','+l.getAttribute('y2'));
  const distinct=new Set(lines).size;
  const txt=document.getElementById('mpRoute').textContent;
  document.getElementById('ceiling').value=prev;
  document.getElementById('ceiling').dispatchEvent(new Event('input',{bubbles:true}));
  compute(); mpDraw();
  return {valves:runs.length, ftEach:runs.map(r2=>+r2.ft.toFixed(1)), distinct, lines:lines.length, txt};
});
check('a bed over the ceiling really does get one supply per valve', split.valves>1, JSON.stringify(split.ftEach));
check('those supplies draw as separate paths, not one line on top of another',
      split.distinct===split.lines, `${split.distinct} distinct of ${split.lines} drawn`);
check('the readout names the bed that several valves supply',
      /supplied by several valves:/.test(split.txt) && /Bed C\s*×\s*\d+/.test(split.txt), split.txt);

log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
await browser.close();
process.exit(failures?1:0);
